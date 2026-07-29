#!/usr/bin/env bash

# Initial-only internal PKI provisioning for the dedicated RefundDesk sandbox host.
# The two CA private keys exist only below /run while certificates are issued.
# Complete per-service directories are validated in a same-filesystem staging
# directory before rename-based publication. Existing TLS material is never
# replaced or rotated by this script.

set -Eeuo pipefail
umask 077

readonly POSTGRES_DNS_NAME="postgres.refunddesk.internal"
readonly VERIFIER_DNS_NAME="verifier.refunddesk.internal"
readonly SERVER_VALID_DAYS=365
readonly CA_VALID_DAYS=366
readonly TLS_ROOT="${REFUNDDESK_TLS_ROOT:-${REFUNDDESK_CONFIG_ROOT:-/etc/refunddesk}/tls}"
readonly LOCK_DIRECTORY="/run/refunddesk"
readonly LOCK_FILE="${LOCK_DIRECTORY}/internal-pki.lock"
readonly PRIVATE_WORK_PARENT="/run"
readonly PRIVATE_WORK_PREFIX="refunddesk-internal-pki."
readonly STAGING_PREFIX=".pki-stage."
readonly GENERATION_MANIFEST_NAME=".pki-generation.sha256"
readonly GENERATION_MARKER_PREFIX=".pki-generation."
readonly TEMPORARY_SUFFIX_PATTERN='^[A-Za-z0-9]{6}$'

PRIVATE_WORK_DIRECTORY=""
STAGING_DIRECTORY=""
GENERATION_MARKER=""
RECOVERED_COMMITTED_GENERATION=false
PUBLICATION_STARTED=false
COMMITTED=false

log() {
  printf '%s %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

assert_directory_metadata() {
  local path="$1"
  local expected_uid="$2"
  local expected_gid="$3"
  local expected_mode="$4"

  [[ -d "${path}" && ! -L "${path}" ]] || die "unsafe TLS directory: ${path}"
  [[ "$(stat --format='%u' -- "${path}")" == "${expected_uid}" ]] ||
    die "unexpected TLS directory owner: ${path}"
  [[ "$(stat --format='%g' -- "${path}")" == "${expected_gid}" ]] ||
    die "unexpected TLS directory group: ${path}"
  [[ "$(stat --format='%a' -- "${path}")" == "${expected_mode}" ]] ||
    die "unexpected TLS directory mode: ${path}"
}

assert_file_metadata() {
  local path="$1"
  local expected_uid="$2"
  local expected_gid="$3"
  local expected_mode="$4"

  [[ -f "${path}" && ! -L "${path}" ]] || die "unsafe TLS file: ${path}"
  [[ "$(stat --format='%u' -- "${path}")" == "${expected_uid}" ]] ||
    die "unexpected TLS file owner: ${path}"
  [[ "$(stat --format='%g' -- "${path}")" == "${expected_gid}" ]] ||
    die "unexpected TLS file group: ${path}"
  [[ "$(stat --format='%a' -- "${path}")" == "${expected_mode}" ]] ||
    die "unexpected TLS file mode: ${path}"
}

mode_is_one_of() {
  local actual_mode="$1"
  shift
  local expected_mode

  for expected_mode in "$@"; do
    [[ "${actual_mode}" != "${expected_mode}" ]] || return 0
  done
  return 1
}

assert_cleanup_directory_state() {
  local path="$1"
  local expected_parent="$2"
  shift 2
  local actual_state
  local parent_mount
  local path_mount

  [[ "${path%/*}" == "${expected_parent}" ]] ||
    die "temporary PKI directory escaped its expected parent"
  [[ -d "${path}" && ! -L "${path}" ]] ||
    die "temporary PKI entry is not a real directory: ${path}"
  [[ "$(readlink --canonicalize-existing -- "${path}")" == "${path}" ]] ||
    die "temporary PKI directory is not canonical: ${path}"
  actual_state="$(stat --format='%u:%g:%a' -- "${path}")"
  mode_is_one_of "${actual_state}" "$@" ||
    die "temporary PKI directory metadata is unsafe: ${path}"
  [[ "$(stat --format='%d' -- "${path}")" == "$(stat --format='%d' -- "${expected_parent}")" ]] ||
    die "temporary PKI directory crossed a filesystem boundary: ${path}"
  parent_mount="$(
    findmnt --noheadings --raw --output TARGET --target "${expected_parent}"
  )"
  path_mount="$(findmnt --noheadings --raw --output TARGET --target "${path}")"
  [[ -n "${parent_mount}" && "${path_mount}" == "${parent_mount}" ]] ||
    die "temporary PKI directory is a mount boundary: ${path}"
}

assert_cleanup_directory() {
  local path="$1"
  local expected_parent="$2"
  local expected_uid="$3"
  local expected_gid="$4"
  shift 4
  local mode
  local -a states=()

  for mode in "$@"; do
    states+=("${expected_uid}:${expected_gid}:${mode}")
  done
  assert_cleanup_directory_state "${path}" "${expected_parent}" "${states[@]}"
}

assert_cleanup_file_state() {
  local path="$1"
  local expected_parent="$2"
  shift 2
  local actual_state
  local parent_mount
  local path_mount

  [[ "${path%/*}" == "${expected_parent}" ]] ||
    die "temporary PKI file escaped its expected directory"
  [[ -f "${path}" && ! -L "${path}" ]] ||
    die "temporary PKI entry is not a regular file: ${path}"
  actual_state="$(stat --format='%u:%g:%a' -- "${path}")"
  mode_is_one_of "${actual_state}" "$@" ||
    die "temporary PKI file metadata is unsafe: ${path}"
  [[ "$(stat --format='%h' -- "${path}")" == "1" ]] ||
    die "temporary PKI file has an unsafe hard-link count: ${path}"
  [[ "$(stat --format='%d' -- "${path}")" == "$(stat --format='%d' -- "${expected_parent}")" ]] ||
    die "temporary PKI file crossed a filesystem boundary: ${path}"
  parent_mount="$(
    findmnt --noheadings --raw --output TARGET --target "${expected_parent}"
  )"
  path_mount="$(findmnt --noheadings --raw --output TARGET --target "${path}")"
  [[ -n "${parent_mount}" && "${path_mount}" == "${parent_mount}" ]] ||
    die "temporary PKI file is a mount boundary: ${path}"
}

assert_cleanup_file() {
  local path="$1"
  local expected_parent="$2"
  local expected_uid="$3"
  local expected_gid="$4"
  shift 4
  local mode
  local -a states=()

  for mode in "$@"; do
    states+=("${expected_uid}:${expected_gid}:${mode}")
  done
  assert_cleanup_file_state "${path}" "${expected_parent}" "${states[@]}"
}

assert_private_work_directory() {
  local path="$1"
  local basename="${path##*/}"
  local suffix="${basename#"${PRIVATE_WORK_PREFIX}"}"
  local entry

  [[ "${basename}" == "${PRIVATE_WORK_PREFIX}"* &&
    "${suffix}" =~ ${TEMPORARY_SUFFIX_PATTERN} ]] ||
    die "private PKI work directory name is unsafe: ${path}"
  assert_cleanup_directory "${path}" "${PRIVATE_WORK_PARENT}" 0 0 700

  while IFS= read -r -d '' entry; do
    case "${entry##*/}" in
      postgres-ca.key|postgres-ca.crt|postgres-server.key|postgres-server.csr|\
        postgres-server.ext|postgres-server.crt|postgres-key.pub|postgres-cert.pub|\
        verifier-ca.key|verifier-ca.crt|verifier-server.key|verifier-server.csr|\
        verifier-server.ext|verifier-server.crt|verifier-key.pub|verifier-cert.pub|\
        client-ca-bundle.crt)
        ;;
      *)
        die "private PKI work directory contains an unexpected entry: ${path}"
        ;;
    esac
    assert_cleanup_file "${entry}" "${path}" 0 0 600
  done < <(find "${path}" -xdev -mindepth 1 -maxdepth 1 -print0)
}

remove_private_work_directory_path() {
  local path="$1"
  local entry

  assert_private_work_directory "${path}"
  while IFS= read -r -d '' entry; do
    assert_cleanup_file "${entry}" "${path}" 0 0 600
    rm -- "${entry}"
  done < <(find "${path}" -xdev -mindepth 1 -maxdepth 1 -print0)
  rmdir -- "${path}"
}

remove_private_work_directory() {
  [[ -n "${PRIVATE_WORK_DIRECTORY}" ]] || return 0
  remove_private_work_directory_path "${PRIVATE_WORK_DIRECTORY}"
  PRIVATE_WORK_DIRECTORY=""
}

assert_staging_file() {
  local service_directory="$1"
  local service="$2"
  local entry="$3"

  case "${service}:${entry##*/}" in
    postgres:ca.crt|postgres:server.crt|verifier:ca.crt|verifier:server.crt)
      assert_cleanup_file_state \
        "${entry}" \
        "${service_directory}" \
        "0:0:600" \
        "0:0:444"
      ;;
    postgres:server.key)
      assert_cleanup_file_state \
        "${entry}" \
        "${service_directory}" \
        "0:0:600" \
        "0:999:600" \
        "0:999:400" \
        "999:999:600" \
        "999:999:400"
      ;;
    verifier:server.key)
      assert_cleanup_file_state \
        "${entry}" \
        "${service_directory}" \
        "0:0:600" \
        "0:1000:600" \
        "0:1000:400" \
        "1000:1000:600" \
        "1000:1000:400"
      ;;
    client:refunddesk-ca-bundle.crt)
      # A SIGKILL between bundle creation and chmod may leave the initial
      # umask-protected 0600 file. No other mode is accepted.
      assert_cleanup_file_state \
        "${entry}" \
        "${service_directory}" \
        "0:0:600" \
        "0:0:444"
      ;;
    *)
      die "PKI staging directory contains an unexpected entry"
      ;;
  esac
}

assert_staging_service_directory() {
  local staging_root="$1"
  local service="$2"
  local path="${staging_root}/${service}"
  local entry

  [[ -e "${path}" || -L "${path}" ]] || return 0
  case "${service}" in
    postgres)
      assert_cleanup_directory_state \
        "${path}" \
        "${staging_root}" \
        "0:0:700" \
        "0:0:755" \
        "0:0:2750" \
        "0:999:700" \
        "0:999:750" \
        "0:999:2750"
      ;;
    verifier)
      assert_cleanup_directory_state \
        "${path}" \
        "${staging_root}" \
        "0:0:700" \
        "0:0:755" \
        "0:0:2750" \
        "0:1000:700" \
        "0:1000:750" \
        "0:1000:2750"
      ;;
    client)
      assert_cleanup_directory_state \
        "${path}" \
        "${staging_root}" \
        "0:0:700" \
        "0:0:755"
      ;;
    *)
      die "unknown PKI staging service"
      ;;
  esac

  while IFS= read -r -d '' entry; do
    assert_staging_file "${path}" "${service}" "${entry}"
  done < <(find "${path}" -xdev -mindepth 1 -maxdepth 1 -print0)
}

assert_staging_directory() {
  local path="$1"
  local basename="${path##*/}"
  local suffix="${basename#"${STAGING_PREFIX}"}"
  local entry

  [[ "${basename}" == "${STAGING_PREFIX}"* &&
    "${suffix}" =~ ${TEMPORARY_SUFFIX_PATTERN} ]] ||
    die "PKI staging directory name is unsafe: ${path}"
  # mktemp creates 0700 before install normalizes the staging root to 0755.
  assert_cleanup_directory "${path}" "${TLS_ROOT}" 0 0 700 755
  while IFS= read -r -d '' entry; do
    case "${entry##*/}" in
      postgres|verifier|client)
        [[ -d "${entry}" && ! -L "${entry}" ]] ||
          die "PKI staging service entry is unsafe: ${entry}"
        ;;
      "${GENERATION_MANIFEST_NAME}")
        assert_cleanup_file "${entry}" "${path}" 0 0 600
        ;;
      *)
        die "PKI staging directory contains an unexpected entry: ${path}"
        ;;
    esac
  done < <(find "${path}" -xdev -mindepth 1 -maxdepth 1 -print0)
  assert_staging_service_directory "${path}" postgres
  assert_staging_service_directory "${path}" verifier
  assert_staging_service_directory "${path}" client
}

remove_staging_directory_path() {
  local path="$1"
  local service
  local entry

  assert_staging_directory "${path}"
  for service in postgres verifier client; do
    [[ -d "${path}/${service}" && ! -L "${path}/${service}" ]] || continue
    while IFS= read -r -d '' entry; do
      assert_staging_file "${path}/${service}" "${service}" "${entry}"
      rm -- "${entry}"
    done < <(find "${path}/${service}" -xdev -mindepth 1 -maxdepth 1 -print0)
    rmdir -- "${path}/${service}"
  done
  if [[ -e "${path}/${GENERATION_MANIFEST_NAME}" ||
    -L "${path}/${GENERATION_MANIFEST_NAME}" ]]; then
    assert_cleanup_file "${path}/${GENERATION_MANIFEST_NAME}" "${path}" 0 0 600
    rm -- "${path}/${GENERATION_MANIFEST_NAME}"
  fi
  rmdir -- "${path}"
}

remove_staging_directory() {
  [[ -n "${STAGING_DIRECTORY}" ]] || return 0
  remove_staging_directory_path "${STAGING_DIRECTORY}"
  STAGING_DIRECTORY=""
}

private_source_path() {
  local private_root="$1"
  local service="$2"
  local filename="$3"

  case "${service}:${filename}" in
    postgres:ca.crt)
      printf '%s\n' "${private_root}/postgres-ca.crt"
      ;;
    postgres:server.crt)
      printf '%s\n' "${private_root}/postgres-server.crt"
      ;;
    postgres:server.key)
      printf '%s\n' "${private_root}/postgres-server.key"
      ;;
    verifier:ca.crt)
      printf '%s\n' "${private_root}/verifier-ca.crt"
      ;;
    verifier:server.crt)
      printf '%s\n' "${private_root}/verifier-server.crt"
      ;;
    verifier:server.key)
      printf '%s\n' "${private_root}/verifier-server.key"
      ;;
    client:refunddesk-ca-bundle.crt)
      printf '%s\n' "${private_root}/client-ca-bundle.crt"
      ;;
    *)
      die "unknown PKI publication file"
      ;;
  esac
}

generation_relative_paths() {
  printf '%s\n' \
    "client/refunddesk-ca-bundle.crt" \
    "postgres/ca.crt" \
    "postgres/server.crt" \
    "postgres/server.key" \
    "verifier/ca.crt" \
    "verifier/server.crt" \
    "verifier/server.key"
}

assert_generation_manifest() {
  local manifest="$1"
  local hash
  local relative
  local extra
  local index=0
  local -a expected_paths=(
    "client/refunddesk-ca-bundle.crt"
    "postgres/ca.crt"
    "postgres/server.crt"
    "postgres/server.key"
    "verifier/ca.crt"
    "verifier/server.crt"
    "verifier/server.key"
  )

  while IFS=$'\t' read -r hash relative extra; do
    (( index < ${#expected_paths[@]} )) ||
      die "PKI generation manifest has too many entries"
    [[ "${hash}" =~ ^[0-9a-f]{64}$ &&
      "${relative}" == "${expected_paths[index]}" &&
      -z "${extra}" ]] ||
      die "PKI generation manifest is invalid"
    index=$((index + 1))
  done <"${manifest}"
  (( index == ${#expected_paths[@]} )) ||
    die "PKI generation manifest is incomplete"
}

write_generation_manifest() {
  local staging_root="$1"
  local manifest="${staging_root}/${GENERATION_MANIFEST_NAME}"
  local relative
  local digest_line
  local digest

  : >"${manifest}"
  chmod 0600 "${manifest}"
  while IFS= read -r relative; do
    digest_line="$(sha256sum -- "${staging_root}/${relative}")"
    digest="${digest_line%% *}"
    [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] ||
      die "PKI generation digest is invalid"
    printf '%s\t%s\n' "${digest}" "${relative}" >>"${manifest}"
  done < <(generation_relative_paths)
  assert_cleanup_file "${manifest}" "${staging_root}" 0 0 600
  assert_generation_manifest "${manifest}"
}

manifest_digest_for_path() {
  local manifest="$1"
  local requested_relative="$2"
  local hash
  local relative
  local extra

  while IFS=$'\t' read -r hash relative extra; do
    if [[ "${relative}" == "${requested_relative}" ]]; then
      [[ "${hash}" =~ ^[0-9a-f]{64}$ && -z "${extra}" ]] ||
        die "PKI generation manifest entry is invalid"
      printf '%s\n' "${hash}"
      return 0
    fi
  done <"${manifest}"
  die "PKI generation manifest path is absent"
}

assert_file_matches_generation_manifest() {
  local manifest="$1"
  local relative="$2"
  local file="$3"
  local expected_digest
  local digest_line
  local actual_digest

  [[ -f "${file}" && ! -L "${file}" ]] ||
    die "PKI generation manifest target is not a regular file"
  expected_digest="$(manifest_digest_for_path "${manifest}" "${relative}")"
  digest_line="$(sha256sum -- "${file}")"
  actual_digest="${digest_line%% *}"
  [[ "${actual_digest}" == "${expected_digest}" ]] ||
    die "PKI generation manifest digest mismatch"
}

assert_generation_marker() {
  local marker="$1"
  local basename="${marker##*/}"
  local suffix="${basename#"${GENERATION_MARKER_PREFIX}"}"

  suffix="${suffix%.sha256}"
  [[ "${basename}" == "${GENERATION_MARKER_PREFIX}${suffix}.sha256" &&
    "${suffix}" =~ ${TEMPORARY_SUFFIX_PATTERN} ]] ||
    die "PKI generation marker name is unsafe"
  assert_cleanup_file "${marker}" "${TLS_ROOT}" 0 0 600
  assert_generation_manifest "${marker}"
}

remove_generation_marker_path() {
  local marker="$1"

  assert_generation_marker "${marker}"
  rm -- "${marker}"
}

remove_generation_marker() {
  [[ -n "${GENERATION_MARKER}" && "${COMMITTED}" != "true" ]] || return 0
  remove_generation_marker_path "${GENERATION_MARKER}"
  GENERATION_MARKER=""
}

assert_manifest_matches_installed_targets() {
  local marker="$1"
  local relative

  assert_generation_marker "${marker}"
  while IFS= read -r relative; do
    assert_file_matches_generation_manifest \
      "${marker}" \
      "${relative}" \
      "${TLS_ROOT}/${relative}"
  done < <(generation_relative_paths)
}

assert_manifest_matches_available_fragments() {
  local marker="$1"
  local staging_root="$2"
  local private_root="$3"
  local relative
  local service
  local filename
  local private_source

  assert_generation_marker "${marker}"
  while IFS= read -r relative; do
    service="${relative%%/*}"
    filename="${relative##*/}"
    if [[ -n "${staging_root}" &&
      -f "${staging_root}/${relative}" &&
      ! -L "${staging_root}/${relative}" ]]; then
      assert_file_matches_generation_manifest \
        "${marker}" \
        "${relative}" \
        "${staging_root}/${relative}"
    fi
    if [[ -n "${private_root}" ]]; then
      private_source="$(private_source_path "${private_root}" "${service}" "${filename}")"
      if [[ -f "${private_source}" && ! -L "${private_source}" ]]; then
        assert_file_matches_generation_manifest \
          "${marker}" \
          "${relative}" \
          "${private_source}"
      fi
    fi
    if [[ -f "${TLS_ROOT}/${relative}" && ! -L "${TLS_ROOT}/${relative}" ]]; then
      assert_file_matches_generation_manifest \
        "${marker}" \
        "${relative}" \
        "${TLS_ROOT}/${relative}"
    fi
  done < <(generation_relative_paths)
}

assert_file_matches_private_generation() {
  local private_root="$1"
  local service="$2"
  local file="$3"
  local source_file

  source_file="$(private_source_path "${private_root}" "${service}" "${file##*/}")"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] ||
    die "interrupted PKI generation is missing its private source"
  cmp --silent "${source_file}" "${file}" ||
    die "published PKI fragment does not match its interrupted generation"
}

assert_staging_matches_private_generation() {
  local staging_root="$1"
  local private_root="$2"
  local service
  local entry

  for service in postgres verifier client; do
    [[ -d "${staging_root}/${service}" && ! -L "${staging_root}/${service}" ]] || continue
    while IFS= read -r -d '' entry; do
      assert_file_matches_private_generation "${private_root}" "${service}" "${entry}"
    done < <(
      find "${staging_root}/${service}" \
        -xdev \
        -mindepth 1 \
        -maxdepth 1 \
        -print0
    )
  done
}

assert_target_service_directory() {
  local service="$1"
  local path="${TLS_ROOT}/${service}"

  case "${service}" in
    postgres)
      assert_cleanup_directory_state \
        "${path}" \
        "${TLS_ROOT}" \
        "0:999:750" \
        "0:999:2750"
      ;;
    verifier)
      assert_cleanup_directory_state \
        "${path}" \
        "${TLS_ROOT}" \
        "0:1000:750" \
        "0:1000:2750"
      ;;
    client)
      assert_cleanup_directory_state "${path}" "${TLS_ROOT}" "0:0:755"
      ;;
    *)
      die "unknown PKI target service"
      ;;
  esac
}

target_service_is_empty_or_absent() {
  local service="$1"
  local path="${TLS_ROOT}/${service}"
  local first_entry

  [[ -e "${path}" || -L "${path}" ]] || return 0
  assert_target_service_directory "${service}"
  first_entry="$(
    find "${path}" \
      -xdev \
      -mindepth 1 \
      -maxdepth 1 \
      -print \
      -quit
  )"
  [[ -z "${first_entry}" ]]
}

assert_published_service_matches_private_generation() {
  local private_root="$1"
  local service="$2"
  local path="${TLS_ROOT}/${service}"
  local entry
  local expected_file
  local -a expected_files=()

  assert_target_service_directory "${service}"
  case "${service}" in
    postgres|verifier)
      [[ "$(stat --format='%a' -- "${path}")" == "2750" ]] ||
        die "published PKI service directory mode is incomplete"
      expected_files=(ca.crt server.crt server.key)
      ;;
    client)
      expected_files=(refunddesk-ca-bundle.crt)
      ;;
    *)
      die "unknown PKI target service"
      ;;
  esac

  while IFS= read -r -d '' entry; do
    case "${service}:${entry##*/}" in
      postgres:ca.crt|postgres:server.crt)
        assert_cleanup_file_state "${entry}" "${path}" "0:0:444"
        ;;
      postgres:server.key)
        assert_cleanup_file_state "${entry}" "${path}" "999:999:400"
        ;;
      verifier:ca.crt|verifier:server.crt)
        assert_cleanup_file_state "${entry}" "${path}" "0:0:444"
        ;;
      verifier:server.key)
        assert_cleanup_file_state "${entry}" "${path}" "1000:1000:400"
        ;;
      client:refunddesk-ca-bundle.crt)
        assert_cleanup_file_state "${entry}" "${path}" "0:0:444"
        ;;
      *)
        die "published PKI service contains an unexpected entry"
        ;;
    esac
    assert_file_matches_private_generation "${private_root}" "${service}" "${entry}"
  done < <(find "${path}" -xdev -mindepth 1 -maxdepth 1 -print0)

  for expected_file in "${expected_files[@]}"; do
    [[ -f "${path}/${expected_file}" && ! -L "${path}/${expected_file}" ]] ||
      die "published PKI service is incomplete"
  done
}

remove_published_service_generation() {
  local private_root="$1"
  local service="$2"
  local path="${TLS_ROOT}/${service}"
  local entry

  assert_published_service_matches_private_generation "${private_root}" "${service}"
  while IFS= read -r -d '' entry; do
    assert_file_matches_private_generation "${private_root}" "${service}" "${entry}"
    rm -- "${entry}"
  done < <(find "${path}" -xdev -mindepth 1 -maxdepth 1 -print0)
  rmdir -- "${path}"
}

recover_interrupted_pki_generation() {
  local orphan
  local private_orphan=""
  local private_suffix=""
  local stage_orphan=""
  local stage_suffix=""
  local marker_orphan=""
  local marker_suffix=""
  local service
  local populated_targets=0
  local -a private_orphans=()
  local -a stage_orphans=()
  local -a marker_orphans=()
  local -a published_services=()

  while IFS= read -r -d '' orphan; do
    private_orphans+=("${orphan}")
  done < <(
    find "${PRIVATE_WORK_PARENT}" \
      -xdev \
      -mindepth 1 \
      -maxdepth 1 \
      -name "${PRIVATE_WORK_PREFIX}*" \
      -print0
  )
  while IFS= read -r -d '' orphan; do
    stage_orphans+=("${orphan}")
  done < <(
    find "${TLS_ROOT}" \
      -xdev \
      -mindepth 1 \
      -maxdepth 1 \
      -name "${STAGING_PREFIX}*" \
      -print0
  )
  while IFS= read -r -d '' orphan; do
    marker_orphans+=("${orphan}")
  done < <(
    find "${TLS_ROOT}" \
      -xdev \
      -mindepth 1 \
      -maxdepth 1 \
      -name "${GENERATION_MARKER_PREFIX}*.sha256" \
      -print0
  )

  (( ${#private_orphans[@]} <= 1 &&
    ${#stage_orphans[@]} <= 1 &&
    ${#marker_orphans[@]} <= 1 )) ||
    die "multiple interrupted PKI generations require manual review"
  if (( ${#private_orphans[@]} == 0 &&
    ${#stage_orphans[@]} == 0 &&
    ${#marker_orphans[@]} == 0 )); then
    return 0
  fi
  if (( ${#private_orphans[@]} == 1 )); then
    private_orphan="${private_orphans[0]}"
    assert_private_work_directory "${private_orphan}"
    private_suffix="${private_orphan##*${PRIVATE_WORK_PREFIX}}"
  fi
  if (( ${#stage_orphans[@]} == 1 )); then
    stage_orphan="${stage_orphans[0]}"
    assert_staging_directory "${stage_orphan}"
    stage_suffix="${stage_orphan##*${STAGING_PREFIX}}"
  fi
  if (( ${#marker_orphans[@]} == 1 )); then
    marker_orphan="${marker_orphans[0]}"
    assert_generation_marker "${marker_orphan}"
    marker_suffix="${marker_orphan##*${GENERATION_MARKER_PREFIX}}"
    marker_suffix="${marker_suffix%.sha256}"
  fi
  if [[ -n "${private_orphan}" && -n "${stage_orphan}" ]]; then
    [[ "${private_suffix}" == "${stage_suffix}" ]] ||
      die "interrupted PKI work and staging generations do not match"
    assert_staging_matches_private_generation "${stage_orphan}" "${private_orphan}"
  fi
  if [[ -n "${marker_orphan}" ]]; then
    if [[ -n "${private_orphan}" ]]; then
      [[ "${marker_suffix}" == "${private_suffix}" ]] ||
        die "PKI marker and private generation do not match"
    fi
    if [[ -n "${stage_orphan}" ]]; then
      [[ "${marker_suffix}" == "${stage_suffix}" ]] ||
        die "PKI marker and stage generation do not match"
    fi
    assert_manifest_matches_available_fragments \
      "${marker_orphan}" \
      "${stage_orphan}" \
      "${private_orphan}"
  fi

  # The final normal operation removes the /run generation only after every
  # service directory has been published and verified. A SIGKILL during that
  # bounded cleanup can therefore leave a partial private directory beside a
  # complete durable publication. The marker proves every installed byte; keep
  # the publication and finish removing only the strictly validated /run files.
  if [[ -n "${marker_orphan}" && -z "${stage_orphan}" ]]; then
    for service in client postgres verifier; do
      if target_service_is_empty_or_absent "${service}"; then
        continue
      fi
      populated_targets=$((populated_targets + 1))
    done
    if (( populated_targets == 3 )); then
      validate_installed_material "${TLS_ROOT}"
      [[ ! -e "${TLS_ROOT}/postgres/ca.key" && ! -e "${TLS_ROOT}/verifier/ca.key" ]] ||
        die "a CA private key reached persistent storage"
      assert_manifest_matches_installed_targets "${marker_orphan}"
      if [[ -n "${private_orphan}" ]]; then
        log "finishing interrupted private PKI cleanup"
        remove_private_work_directory_path "${private_orphan}"
      fi
      GENERATION_MARKER="${marker_orphan}"
      RECOVERED_COMMITTED_GENERATION=true
      return 0
    fi
    (( populated_targets == 0 )) ||
      die "PKI generation marker has a partial publication"
  fi

  if [[ -z "${private_orphan}" && -z "${stage_orphan}" ]]; then
    for service in client postgres verifier; do
      if target_service_is_empty_or_absent "${service}"; then
        continue
      fi
      populated_targets=$((populated_targets + 1))
    done
    if (( populated_targets == 0 )); then
      log "removing interrupted PKI generation marker"
      remove_generation_marker_path "${marker_orphan}"
      return 0
    fi
    (( populated_targets == 3 )) ||
      die "PKI generation marker has a partial publication"
    validate_installed_material "${TLS_ROOT}"
    [[ ! -e "${TLS_ROOT}/postgres/ca.key" && ! -e "${TLS_ROOT}/verifier/ca.key" ]] ||
      die "a CA private key reached persistent storage"
    assert_manifest_matches_installed_targets "${marker_orphan}"
    GENERATION_MARKER="${marker_orphan}"
    RECOVERED_COMMITTED_GENERATION=true
    return 0
  fi

  if [[ -n "${stage_orphan}" ]]; then
    for service in client postgres verifier; do
      if [[ -d "${stage_orphan}/${service}" && ! -L "${stage_orphan}/${service}" ]]; then
        target_service_is_empty_or_absent "${service}" ||
          die "PKI target conflicts with its staged generation"
      elif target_service_is_empty_or_absent "${service}"; then
        # The process may have died while creating the stage, before publication.
        continue
      else
        [[ -n "${private_orphan}" ]] ||
          die "published PKI fragment has no correlated private generation"
        assert_published_service_matches_private_generation "${private_orphan}" "${service}"
        published_services+=("${service}")
      fi
    done
    for service in "${published_services[@]}"; do
      log "removing interrupted published PKI service"
      remove_published_service_generation "${private_orphan}" "${service}"
    done
    log "removing interrupted PKI staging directory"
    remove_staging_directory_path "${stage_orphan}"
    if [[ -n "${private_orphan}" ]]; then
      log "removing interrupted private PKI work directory"
      remove_private_work_directory_path "${private_orphan}"
    fi
    if [[ -n "${marker_orphan}" ]]; then
      log "removing interrupted PKI generation marker"
      remove_generation_marker_path "${marker_orphan}"
    fi
    return 0
  fi

  # A SIGKILL after the final stage rename but before private cleanup leaves
  # only the /run generation. Accept either all-empty targets or one complete,
  # byte-for-byte correlated publication; partial/foreign states fail closed.
  for service in client postgres verifier; do
    if target_service_is_empty_or_absent "${service}"; then
      continue
    fi
    assert_published_service_matches_private_generation "${private_orphan}" "${service}"
    published_services+=("${service}")
    populated_targets=$((populated_targets + 1))
  done
  (( populated_targets == 0 || populated_targets == 3 )) ||
    die "private PKI orphan has a partial publication without its stage"
  for service in "${published_services[@]}"; do
    log "removing interrupted published PKI service"
    remove_published_service_generation "${private_orphan}" "${service}"
  done
  log "removing interrupted private PKI work directory"
  remove_private_work_directory_path "${private_orphan}"
  if [[ -n "${marker_orphan}" ]]; then
    log "removing interrupted PKI generation marker"
    remove_generation_marker_path "${marker_orphan}"
  fi
}

remove_published_material() {
  local name

  [[ "${PUBLICATION_STARTED}" == "true" && "${COMMITTED}" != "true" ]] || return 0
  for name in postgres verifier client; do
    [[ -d "${TLS_ROOT}/${name}" && ! -L "${TLS_ROOT}/${name}" ]] || continue
    case "${name}" in
      postgres|verifier)
        rm -f -- \
          "${TLS_ROOT}/${name}/ca.crt" \
          "${TLS_ROOT}/${name}/server.crt" \
          "${TLS_ROOT}/${name}/server.key"
        ;;
      client)
        rm -f -- "${TLS_ROOT}/${name}/refunddesk-ca-bundle.crt"
        ;;
    esac
    rmdir -- "${TLS_ROOT}/${name}" || true
  done

  install -d -o root -g 999 -m 2750 "${TLS_ROOT}/postgres"
  install -d -o root -g 1000 -m 2750 "${TLS_ROOT}/verifier"
  install -d -o root -g root -m 0755 "${TLS_ROOT}/client"
}

cleanup() {
  local status=$?
  trap - EXIT

  remove_published_material || status=1
  remove_staging_directory || status=1
  remove_private_work_directory || status=1
  remove_generation_marker || status=1
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

generate_authority() {
  local name="$1"
  local common_name="$2"

  openssl genpkey \
    -algorithm RSA \
    -pkeyopt rsa_keygen_bits:3072 \
    -out "${PRIVATE_WORK_DIRECTORY}/${name}-ca.key" >/dev/null 2>&1
  openssl req \
    -new \
    -x509 \
    -key "${PRIVATE_WORK_DIRECTORY}/${name}-ca.key" \
    -sha256 \
    -days "${CA_VALID_DAYS}" \
    -subj "/CN=${common_name}" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "${PRIVATE_WORK_DIRECTORY}/${name}-ca.crt" >/dev/null 2>&1
}

generate_server_certificate() {
  local name="$1"
  local dns_name="$2"
  local extension_file="${PRIVATE_WORK_DIRECTORY}/${name}-server.ext"

  openssl genpkey \
    -algorithm RSA \
    -pkeyopt rsa_keygen_bits:3072 \
    -out "${PRIVATE_WORK_DIRECTORY}/${name}-server.key" >/dev/null 2>&1
  openssl req \
    -new \
    -sha256 \
    -key "${PRIVATE_WORK_DIRECTORY}/${name}-server.key" \
    -subj "/CN=${dns_name}" \
    -out "${PRIVATE_WORK_DIRECTORY}/${name}-server.csr" >/dev/null 2>&1
  printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:${dns_name}" \
    "subjectKeyIdentifier=hash" \
    "authorityKeyIdentifier=keyid,issuer" >"${extension_file}"
  openssl x509 \
    -req \
    -in "${PRIVATE_WORK_DIRECTORY}/${name}-server.csr" \
    -CA "${PRIVATE_WORK_DIRECTORY}/${name}-ca.crt" \
    -CAkey "${PRIVATE_WORK_DIRECTORY}/${name}-ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -sha256 \
    -days "${SERVER_VALID_DAYS}" \
    -extfile "${extension_file}" \
    -out "${PRIVATE_WORK_DIRECTORY}/${name}-server.crt" >/dev/null 2>&1
}

normalized_certificate_extension() {
  local certificate="$1"
  local extension="$2"

  openssl x509 -in "${certificate}" -noout -ext "${extension}" |
    tail -n +2 |
    tr -d '[:space:]'
}

validate_authority() {
  local certificate="$1"
  local certificate_text

  openssl verify -CAfile "${certificate}" -check_ss_sig "${certificate}" >/dev/null
  certificate_text="$(openssl x509 -in "${certificate}" -noout -text)"
  grep -Fq "Public-Key: (3072 bit)" <<<"${certificate_text}" ||
    die "internal CA is not RSA 3072"
  grep -Fq "Signature Algorithm: sha256WithRSAEncryption" <<<"${certificate_text}" ||
    die "internal CA is not signed with SHA-256"
  [[ "$(normalized_certificate_extension "${certificate}" basicConstraints)" == "CA:TRUE,pathlen:0" ]] ||
    die "internal CA constraints are invalid"
}

validate_server_certificate() {
  local name="$1"
  local dns_name="$2"
  local ca_certificate="${PRIVATE_WORK_DIRECTORY}/${name}-ca.crt"
  local certificate="${PRIVATE_WORK_DIRECTORY}/${name}-server.crt"
  local private_key="${PRIVATE_WORK_DIRECTORY}/${name}-server.key"
  local certificate_text

  openssl pkey -in "${private_key}" -check -noout >/dev/null 2>&1
  openssl pkey -in "${private_key}" -pubout \
    -out "${PRIVATE_WORK_DIRECTORY}/${name}-key.pub" >/dev/null 2>&1
  openssl x509 -in "${certificate}" -pubkey -noout \
    >"${PRIVATE_WORK_DIRECTORY}/${name}-cert.pub"
  cmp --silent \
    "${PRIVATE_WORK_DIRECTORY}/${name}-key.pub" \
    "${PRIVATE_WORK_DIRECTORY}/${name}-cert.pub" ||
    die "server certificate and private key do not match for ${dns_name}"

  openssl verify \
    -CAfile "${ca_certificate}" \
    -purpose sslserver \
    -verify_hostname "${dns_name}" \
    "${certificate}" >/dev/null
  [[ "$(normalized_certificate_extension "${certificate}" subjectAltName)" == "DNS:${dns_name}" ]] ||
    die "server certificate SAN is not exact for ${dns_name}"
  [[ "$(normalized_certificate_extension "${certificate}" extendedKeyUsage)" == "TLSWebServerAuthentication" ]] ||
    die "server certificate EKU is not exactly serverAuth for ${dns_name}"

  certificate_text="$(openssl x509 -in "${certificate}" -noout -text)"
  grep -Fq "Public-Key: (3072 bit)" <<<"${certificate_text}" ||
    die "server certificate is not RSA 3072 for ${dns_name}"
  grep -Fq "Signature Algorithm: sha256WithRSAEncryption" <<<"${certificate_text}" ||
    die "server certificate is not signed with SHA-256 for ${dns_name}"
  openssl x509 -in "${certificate}" -checkend "$((364 * 24 * 60 * 60))" -noout >/dev/null ||
    die "server certificate validity is shorter than expected for ${dns_name}"
  if openssl x509 -in "${certificate}" -checkend "$((366 * 24 * 60 * 60))" -noout >/dev/null; then
    die "server certificate validity is longer than expected for ${dns_name}"
  fi
}

validate_installed_material() {
  local root="$1"

  assert_directory_metadata "${root}" 0 0 755
  assert_directory_metadata "${root}/postgres" 0 999 2750
  assert_directory_metadata "${root}/verifier" 0 1000 2750
  assert_directory_metadata "${root}/client" 0 0 755

  assert_file_metadata "${root}/postgres/ca.crt" 0 0 444
  assert_file_metadata "${root}/postgres/server.crt" 0 0 444
  assert_file_metadata "${root}/postgres/server.key" 999 999 400
  assert_file_metadata "${root}/verifier/ca.crt" 0 0 444
  assert_file_metadata "${root}/verifier/server.crt" 0 0 444
  assert_file_metadata "${root}/verifier/server.key" 1000 1000 400
  assert_file_metadata "${root}/client/refunddesk-ca-bundle.crt" 0 0 444

  openssl verify \
    -CAfile "${root}/postgres/ca.crt" \
    -purpose sslserver \
    -verify_hostname "${POSTGRES_DNS_NAME}" \
    "${root}/postgres/server.crt" >/dev/null
  openssl verify \
    -CAfile "${root}/verifier/ca.crt" \
    -purpose sslserver \
    -verify_hostname "${VERIFIER_DNS_NAME}" \
    "${root}/verifier/server.crt" >/dev/null
  openssl verify \
    -CAfile "${root}/client/refunddesk-ca-bundle.crt" \
    -purpose sslserver \
    -verify_hostname "${POSTGRES_DNS_NAME}" \
    "${root}/postgres/server.crt" >/dev/null
  openssl verify \
    -CAfile "${root}/client/refunddesk-ca-bundle.crt" \
    -purpose sslserver \
    -verify_hostname "${VERIFIER_DNS_NAME}" \
    "${root}/verifier/server.crt" >/dev/null
}

[[ "${EUID}" -eq 0 ]] || die "this command must run as root"
for command in chmod chown cmp find findmnt flock grep install mkdir mktemp mv openssl readlink rm rmdir sha256sum stat tail tr; do
  require_command "${command}"
done
[[ "${TLS_ROOT}" == /* && "${TLS_ROOT}" != "/" ]] || die "TLS root must be an absolute safe path"
[[ "$(findmnt --noheadings --output FSTYPE --target /run | tr -d '[:space:]')" == "tmpfs" ]] ||
  die "/run must be tmpfs so CA private keys never reach persistent storage"

[[ -d /run && ! -L /run &&
  "$(readlink --canonicalize-existing -- /run)" == "/run" &&
  "$(stat --format='%u:%g' -- /run)" == "0:0" ]] ||
  die "/run must be a canonical root-owned directory"
run_mode="$(stat --format='%a' -- /run)"
(( (8#${run_mode} & 022) == 0 )) ||
  die "/run must not be group/world writable"
if [[ ! -e "${LOCK_DIRECTORY}" && ! -L "${LOCK_DIRECTORY}" ]]; then
  install -d -o root -g root -m 0700 "${LOCK_DIRECTORY}"
fi
[[ -d "${LOCK_DIRECTORY}" && ! -L "${LOCK_DIRECTORY}" &&
  "$(readlink --canonicalize-existing -- "${LOCK_DIRECTORY}")" == "${LOCK_DIRECTORY}" &&
  "$(stat --format='%u:%g:%a' -- "${LOCK_DIRECTORY}")" == "0:0:700" ]] ||
  die "internal PKI lock directory is unsafe"
if [[ -e "${LOCK_FILE}" || -L "${LOCK_FILE}" ]]; then
  [[ -f "${LOCK_FILE}" && ! -L "${LOCK_FILE}" ]] ||
    die "internal PKI lock must be a regular non-symlink file"
else
  (
    set -o noclobber
    : >"${LOCK_FILE}"
  ) 2>/dev/null || die "internal PKI lock could not be created safely"
fi
[[ "$(stat --format='%u:%g:%a' -- "${LOCK_FILE}")" == "0:0:600" ]] ||
  die "internal PKI lock must be root-owned mode 0600"
exec 9<>"${LOCK_FILE}"
[[ "$(stat --format='%d:%i' -- "${LOCK_FILE}")" == \
  "$(stat --dereference --format='%d:%i' -- /proc/self/fd/9)" ]] ||
  die "internal PKI lock descriptor changed during secure open"
flock --exclusive --nonblock 9 || die "another internal PKI provisioning process holds the lock"

if [[ -e "${TLS_ROOT}" || -L "${TLS_ROOT}" ]]; then
  [[ -d "${TLS_ROOT}" && ! -L "${TLS_ROOT}" ]] || die "TLS root must be a non-symlink directory"
else
  install -d -o root -g root -m 0755 "${TLS_ROOT}"
fi
install -d -o root -g root -m 0755 "${TLS_ROOT}"
[[ "$(readlink --canonicalize-existing -- "${TLS_ROOT}")" == "${TLS_ROOT}" ]] ||
  die "TLS root must be canonical"
assert_directory_metadata "${TLS_ROOT}" 0 0 755

# SIGKILL cannot run the EXIT trap. Once the exclusive lock is held, validate
# every exact temporary artifact before removing only the allowlisted files.
# Any foreign type, name, owner, mode, hard link or mount boundary fails closed.
recover_interrupted_pki_generation
if [[ "${RECOVERED_COMMITTED_GENERATION}" == "true" ]]; then
  COMMITTED=true
  log "existing correlated internal PKI generation validated; no replacement performed"
  exit 0
fi

while IFS= read -r -d '' existing_entry; do
  case "${existing_entry##*/}" in
    postgres|verifier|client)
      ;;
    *)
      die "unexpected entry in TLS root; refusing initial provisioning"
      ;;
  esac
done < <(find "${TLS_ROOT}" -mindepth 1 -maxdepth 1 -print0)

for name in postgres verifier client; do
  if [[ -e "${TLS_ROOT}/${name}" || -L "${TLS_ROOT}/${name}" ]]; then
    [[ -d "${TLS_ROOT}/${name}" && ! -L "${TLS_ROOT}/${name}" ]] ||
      die "TLS target must be a non-symlink directory: ${TLS_ROOT}/${name}"
    [[ -z "$(find "${TLS_ROOT}/${name}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
      die "refusing to overwrite existing TLS material in ${TLS_ROOT}/${name}"
  fi
done
install -d -o root -g 999 -m 2750 "${TLS_ROOT}/postgres"
install -d -o root -g 1000 -m 2750 "${TLS_ROOT}/verifier"
install -d -o root -g root -m 0755 "${TLS_ROOT}/client"

PRIVATE_WORK_DIRECTORY="$(mktemp --directory /run/refunddesk-internal-pki.XXXXXX)"
STAGING_DIRECTORY="${TLS_ROOT}/${STAGING_PREFIX}${PRIVATE_WORK_DIRECTORY##*${PRIVATE_WORK_PREFIX}}"
mkdir --mode=0700 -- "${STAGING_DIRECTORY}" ||
  die "correlated PKI staging directory could not be created safely"
install -d -o root -g root -m 0755 "${STAGING_DIRECTORY}"
install -d -o root -g 999 -m 2750 "${STAGING_DIRECTORY}/postgres"
install -d -o root -g 1000 -m 2750 "${STAGING_DIRECTORY}/verifier"
install -d -o root -g root -m 0755 "${STAGING_DIRECTORY}/client"

generate_authority postgres "RefundDesk PostgreSQL Internal CA"
generate_authority verifier "RefundDesk Verifier Internal CA"
generate_server_certificate postgres "${POSTGRES_DNS_NAME}"
generate_server_certificate verifier "${VERIFIER_DNS_NAME}"

validate_authority "${PRIVATE_WORK_DIRECTORY}/postgres-ca.crt"
validate_authority "${PRIVATE_WORK_DIRECTORY}/verifier-ca.crt"
validate_server_certificate postgres "${POSTGRES_DNS_NAME}"
validate_server_certificate verifier "${VERIFIER_DNS_NAME}"

install -o root -g root -m 0444 \
  "${PRIVATE_WORK_DIRECTORY}/postgres-ca.crt" \
  "${STAGING_DIRECTORY}/postgres/ca.crt"
install -o root -g root -m 0444 \
  "${PRIVATE_WORK_DIRECTORY}/postgres-server.crt" \
  "${STAGING_DIRECTORY}/postgres/server.crt"
install -o 999 -g 999 -m 0400 \
  "${PRIVATE_WORK_DIRECTORY}/postgres-server.key" \
  "${STAGING_DIRECTORY}/postgres/server.key"
install -o root -g root -m 0444 \
  "${PRIVATE_WORK_DIRECTORY}/verifier-ca.crt" \
  "${STAGING_DIRECTORY}/verifier/ca.crt"
install -o root -g root -m 0444 \
  "${PRIVATE_WORK_DIRECTORY}/verifier-server.crt" \
  "${STAGING_DIRECTORY}/verifier/server.crt"
install -o 1000 -g 1000 -m 0400 \
  "${PRIVATE_WORK_DIRECTORY}/verifier-server.key" \
  "${STAGING_DIRECTORY}/verifier/server.key"
{
  openssl x509 -in "${PRIVATE_WORK_DIRECTORY}/postgres-ca.crt"
  openssl x509 -in "${PRIVATE_WORK_DIRECTORY}/verifier-ca.crt"
} >"${PRIVATE_WORK_DIRECTORY}/client-ca-bundle.crt"
install -o root -g root -m 0444 \
  "${PRIVATE_WORK_DIRECTORY}/client-ca-bundle.crt" \
  "${STAGING_DIRECTORY}/client/refunddesk-ca-bundle.crt"

validate_installed_material "${STAGING_DIRECTORY}"
write_generation_manifest "${STAGING_DIRECTORY}"
generation_marker_candidate="${TLS_ROOT}/${GENERATION_MARKER_PREFIX}${PRIVATE_WORK_DIRECTORY##*${PRIVATE_WORK_PREFIX}}.sha256"
[[ ! -e "${generation_marker_candidate}" && ! -L "${generation_marker_candidate}" ]] ||
  die "PKI generation marker already exists"
mv -- "${STAGING_DIRECTORY}/${GENERATION_MANIFEST_NAME}" "${generation_marker_candidate}"
GENERATION_MARKER="${generation_marker_candidate}"
assert_generation_marker "${GENERATION_MARKER}"

PUBLICATION_STARTED=true
for name in client postgres verifier; do
  rmdir -- "${TLS_ROOT}/${name}"
  mv -- "${STAGING_DIRECTORY}/${name}" "${TLS_ROOT}/${name}"
done
rmdir -- "${STAGING_DIRECTORY}"
STAGING_DIRECTORY=""

validate_installed_material "${TLS_ROOT}"
[[ ! -e "${TLS_ROOT}/postgres/ca.key" && ! -e "${TLS_ROOT}/verifier/ca.key" ]] ||
  die "a CA private key reached persistent storage"

remove_private_work_directory
COMMITTED=true
log "internal PostgreSQL and verifier TLS material provisioned and validated"
