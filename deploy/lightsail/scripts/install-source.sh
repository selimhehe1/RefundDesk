#!/usr/bin/env bash

# Installs one exact, operator-verified deploy/lightsail source archive under
# /opt/refunddesk/releases/<revision>/source. It deliberately does not update
# /opt/refunddesk/current; release.sh promotes that symlink only after runtime
# verification succeeds.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

ARCHIVE=""
REVISION=""
EXPECTED_SHA256=""
TEMP_SOURCE=""
CONTROL_PLANE_DURABILITY_HELPER=""
readonly RELEASE_CONTRACT_VERSION="2"
readonly STABLE_RELEASE_LAUNCHER="/usr/local/sbin/refunddesk-release"
readonly STABLE_RELEASE_FENCE="/usr/local/sbin/refunddesk-release-fence"
readonly STABLE_BACKUP_LAUNCHER="/usr/local/sbin/refunddesk-backup"
readonly STABLE_RETENTION_LAUNCHER="/usr/local/sbin/refunddesk-retention"
readonly STABLE_RECOVERY_LAUNCHER="/usr/local/sbin/refunddesk-quiesce-recovery"
readonly TRANSITION_JOURNAL="${REFUNDDESK_CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly QUIESCE_JOURNAL="${REFUNDDESK_CONTROL_ROOT}/runtime-quiesce-in-progress.json"

assert_transition_allows_revision() {
  if [[ ! -e "${TRANSITION_JOURNAL}" && ! -L "${TRANSITION_JOURNAL}" ]]; then
    return 0
  fi

  assert_root_secret_file "${TRANSITION_JOURNAL}"
  jq --exit-status --arg revision "${REVISION}" '
    def fingerprint:
      . == null
      or (type == "string" and test("^sha256:[0-9a-f]{64}$"));
    def fingerprints:
      type == "object"
      and keys == ["approvalAttestation","field","proof"]
      and all(.[];
        type == "object"
        and keys == ["v1","v2"]
        and all(.[]; fingerprint));
    def states:
      type == "object"
      and keys == ["approvalAttestation","field","proof"]
      and all(.[];
        . == null
        or (. == "legacy" or . == "staged" or . == "active"
          or . == "rollback" or . == "retired"));
    def side:
      type == "object"
      and keys == ["fingerprints","recorded","revision","states"]
      and (.recorded | type == "boolean")
      and (.revision == null
        or (.revision | type == "string" and test("^[0-9a-f]{40}$")))
      and (.fingerprints | fingerprints)
      and (.states | states);
    type == "object"
    and keys == ["from","schemaVersion","status","to"]
    and .schemaVersion == 1
    and .status == "in_progress"
    and (.from | side)
    and (.to | side)
    and .to.recorded == true
    and .to.revision == $revision
  ' "${TRANSITION_JOURNAL}" >/dev/null ||
    die "unfinished release transition permits installing only its exact target revision"
}

install_stable_control_plane() {
  local source_root="$1"
  local bridge_release_fence bridge_release_launcher contract_marker control_plane_source
  local effective_source expected_link generation_parent legacy_final legacy_staging
  local mapping mode relative_path stable_path target_file
  local -a contract_lines
  local -a control_plane_mappings=(
    "scripts/release-launcher.sh|${STABLE_RELEASE_LAUNCHER}|0755"
    "scripts/release-fence.sh|${STABLE_RELEASE_FENCE}|0755"
    "scripts/backup-launcher.sh|${STABLE_BACKUP_LAUNCHER}|0755"
    "scripts/retention-launcher.sh|${STABLE_RETENTION_LAUNCHER}|0755"
    "scripts/quiesce-recovery-launcher.sh|${STABLE_RECOVERY_LAUNCHER}|0755"
    "systemd/refunddesk-backup.service|/etc/systemd/system/refunddesk-backup.service|0644"
    "systemd/refunddesk-backup.timer|/etc/systemd/system/refunddesk-backup.timer|0644"
    "systemd/refunddesk-retention.service|/etc/systemd/system/refunddesk-retention.service|0644"
    "systemd/refunddesk-retention.timer|/etc/systemd/system/refunddesk-retention.timer|0644"
    "systemd/refunddesk-quiesce-recovery.service|/etc/systemd/system/refunddesk-quiesce-recovery.service|0644"
  )
  local requires_legacy_snapshot=false

  contract_marker="${source_root}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
  control_plane_source="${source_root}/deploy/lightsail"
  generation_parent="${REFUNDDESK_ROOT}/control-plane-generations"
  CONTROL_PLANE_DURABILITY_HELPER="${source_root}/deploy/lightsail/scripts/release-transition-journal.py"
  assert_root_control_file "${contract_marker}"
  assert_root_control_file "${CONTROL_PLANE_DURABILITY_HELPER}"
  for mapping in "${control_plane_mappings[@]}"; do
    relative_path="${mapping%%|*}"
    target_file="${control_plane_source}/${relative_path}"
    assert_root_control_file "${target_file}"
  done
  mapfile -t contract_lines <"${contract_marker}"
  (( ${#contract_lines[@]} == 1 )) &&
    [[ "${contract_lines[0]}" == "${RELEASE_CONTRACT_VERSION}" ]] ||
    die "source does not implement release contract ${RELEASE_CONTRACT_VERSION}"

  assert_transition_allows_revision
  assert_safe_directory /usr/local/sbin
  assert_safe_directory /etc/systemd/system
  install -d -o root -g root -m 0755 "${generation_parent}"
  assert_safe_directory "${generation_parent}"

  if [[ ! -L "${REFUNDDESK_CONTROL_PLANE_LINK}" ]]; then
    requires_legacy_snapshot=true
  else
    for mapping in "${control_plane_mappings[@]}"; do
      relative_path="${mapping%%|*}"
      stable_path="${mapping#*|}"
      stable_path="${stable_path%%|*}"
      expected_link="${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
      if [[ ! -L "${stable_path}" ]] ||
        [[ "$(readlink -- "${stable_path}")" != "${expected_link}" ]]; then
        requires_legacy_snapshot=true
        break
      fi
    done
  fi

  if [[ "${requires_legacy_snapshot}" == "true" ]]; then
    legacy_staging="$(mktemp --directory "${generation_parent}/.legacy.XXXXXX")"
    install -d -o root -g root -m 0755 \
      "${legacy_staging}/scripts" \
      "${legacy_staging}/systemd"
    for mapping in "${control_plane_mappings[@]}"; do
      relative_path="${mapping%%|*}"
      stable_path="${mapping#*|}"
      stable_path="${stable_path%%|*}"
      mode="${mapping##*|}"
      expected_link="${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
      target_file="${control_plane_source}/${relative_path}"
      effective_source="${target_file}"
      if [[ -L "${stable_path}" ]]; then
        [[ "$(readlink -- "${stable_path}")" == "${expected_link}" ]] ||
          die "refusing an unexpected stable control-plane symlink: ${stable_path}"
        effective_source="$(readlink --canonicalize-existing -- "${stable_path}")" ||
          die "existing stable control-plane symlink cannot be resolved: ${stable_path}"
        assert_root_control_file "${effective_source}"
      elif [[ -e "${stable_path}" ]]; then
        assert_root_control_file "${stable_path}"
        effective_source="${stable_path}"
      fi
      case "${relative_path}" in
        scripts/release-launcher.sh|\
          scripts/release-fence.sh|\
          scripts/backup-launcher.sh|\
          scripts/retention-launcher.sh|\
          scripts/quiesce-recovery-launcher.sh)
          effective_source="${target_file}"
          ;;
      esac
      install -o root -g root -m "${mode}" \
        "${effective_source}" "${legacy_staging}/${relative_path}"
    done
    python3 "${CONTROL_PLANE_DURABILITY_HELPER}" fsync-tree \
      --path "${legacy_staging}" >/dev/null ||
      die "legacy control-plane generation could not be synchronized"
    legacy_final="${generation_parent}/legacy-$(date --utc '+%Y%m%dT%H%M%SZ')-$$"
    mv --no-target-directory -- "${legacy_staging}" "${legacy_final}"
    python3 "${CONTROL_PLANE_DURABILITY_HELPER}" fsync-directory \
      --path "${generation_parent}" >/dev/null ||
      die "legacy control-plane generation parent could not be synchronized"
    python3 "${CONTROL_PLANE_DURABILITY_HELPER}" durable-symlink \
      --target "${REFUNDDESK_CONTROL_PLANE_LINK}" \
      --value "${legacy_final}" >/dev/null ||
      die "legacy control-plane generation could not be activated"

    for mapping in "${control_plane_mappings[@]}"; do
      relative_path="${mapping%%|*}"
      stable_path="${mapping#*|}"
      stable_path="${stable_path%%|*}"
      expected_link="${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
      python3 "${CONTROL_PLANE_DURABILITY_HELPER}" durable-symlink \
        --target "${stable_path}" \
        --value "${expected_link}" >/dev/null ||
        die "stable control-plane path could not join the generation: ${stable_path}"
      [[ -L "${stable_path}" && "$(readlink -- "${stable_path}")" == "${expected_link}" ]] ||
        die "stable control-plane path differs after generation conversion: ${stable_path}"
    done
  fi

  for mapping in "${control_plane_mappings[@]}"; do
    relative_path="${mapping%%|*}"
    stable_path="${mapping#*|}"
    stable_path="${stable_path%%|*}"
    expected_link="${REFUNDDESK_CONTROL_PLANE_LINK}/${relative_path}"
    assert_root_control_symlink "${stable_path}" "${expected_link}"
  done
  bridge_release_launcher="$(
    readlink --canonicalize-existing -- "${STABLE_RELEASE_LAUNCHER}"
  )" || die "release bridge launcher cannot be resolved"
  bridge_release_fence="$(
    readlink --canonicalize-existing -- "${STABLE_RELEASE_FENCE}"
  )" || die "release bridge fence cannot be resolved"
  assert_root_control_file "${bridge_release_launcher}"
  assert_root_control_file "${bridge_release_fence}"
  grep --fixed-strings --line-regexp \
    'readonly RELEASE_CONTRACT_VERSION="2"' "${bridge_release_launcher}" >/dev/null &&
    grep --fixed-strings 'CONTROL_PLANE_LINK=' "${bridge_release_launcher}" >/dev/null &&
    grep --fixed-strings 'exec systemd-run' "${bridge_release_launcher}" >/dev/null ||
    die "active release bridge cannot invoke release-contract-2 targets"
  grep --fixed-strings 'CONTROL_PLANE_LINK=' "${bridge_release_fence}" >/dev/null &&
    grep --fixed-strings 'enforce_runtime_admission_once' "${bridge_release_fence}" >/dev/null &&
    grep --fixed-strings 'application-key-transition.lock' "${bridge_release_fence}" >/dev/null ||
    die "active release-fence bridge cannot protect a contract-2 transition"
  systemctl daemon-reload ||
    die "systemd could not reload the stable RefundDesk control plane"
  systemctl enable refunddesk-quiesce-recovery.service ||
    die "runtime-quiescence boot recovery could not be enabled"
  systemctl is-enabled --quiet refunddesk-quiesce-recovery.service ||
    die "runtime-quiescence boot recovery is not enabled"
}

usage() {
  printf '%s\n' \
    'Usage: sudo bash install-source.sh --archive FILE --revision FULL_SHA --expected-sha256 SHA256'
}

while (( $# > 0 )); do
  case "$1" in
    --archive)
      (( $# >= 2 )) || die "--archive requires a value"
      ARCHIVE="$2"
      shift 2
      ;;
    --revision)
      (( $# >= 2 )) || die "--revision requires a value"
      REVISION="$2"
      shift 2
      ;;
    --expected-sha256)
      (( $# >= 2 )) || die "--expected-sha256 requires a value"
      EXPECTED_SHA256="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_root
for command in bash cmp find git grep jq python3 sha256sum systemctl tar zstd; do
  require_command "${command}"
done
acquire_operator_lock
if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]; then
  assert_root_control_entry \
    "${STABLE_RECOVERY_LAUNCHER}" \
    "${REFUNDDESK_CONTROL_PLANE_LINK}/scripts/quiesce-recovery-launcher.sh"
  REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true \
    "${STABLE_RECOVERY_LAUNCHER}" ||
    die "unfinished runtime quiescence could not be recovered before source installation"
fi
[[ ! -e "${QUIESCE_JOURNAL}" && ! -L "${QUIESCE_JOURNAL}" ]] ||
  die "runtime quiescence remained after source-install preflight recovery"

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a full lowercase Git SHA"
[[ "${EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
  die "expected source archive SHA-256 must be lowercase hex"
[[ -n "${ARCHIVE}" ]] || die "--archive is required"
assert_transition_allows_revision
ARCHIVE="$(readlink --canonicalize-existing -- "${ARCHIVE}")"
[[ "${ARCHIVE##*/}" == "refunddesk-source-${REVISION}.tar.zst" ]] ||
  die "source archive filename does not match its requested revision"
assert_root_control_file "${ARCHIVE}"
[[ "$(sha256sum -- "${ARCHIVE}" | awk '{print $1}')" == "${EXPECTED_SHA256}" ]] ||
  die "source archive SHA-256 differs from the out-of-band operator value"
zstd --test --quiet -- "${ARCHIVE}" || die "source archive zstd integrity validation failed"
archive_revision="$(
  # get-tar-commit-id intentionally stops after the Git PAX header, so the
  # already-integrity-tested decompressor is expected to receive SIGPIPE.
  set +o pipefail
  zstd --decompress --stdout -- "${ARCHIVE}" |
    git get-tar-commit-id
)" || die "source archive has no authenticated Git commit marker"
[[ "${archive_revision}" == "${REVISION}" ]] ||
  die "source archive Git commit differs from its requested revision"
unset archive_revision

RELEASE_PARENT="${REFUNDDESK_ROOT}/releases/${REVISION}"
FINAL_SOURCE="${RELEASE_PARENT}/source"
if [[ -e "${FINAL_SOURCE}" || -L "${FINAL_SOURCE}" ]]; then
  assert_safe_directory "${FINAL_SOURCE}"
  assert_root_secret_file "${FINAL_SOURCE}/.refunddesk-revision"
  assert_root_secret_file "${FINAL_SOURCE}/.refunddesk-source-sha256"
  [[ "$(<"${FINAL_SOURCE}/.refunddesk-revision")" == "${REVISION}" ]] ||
    die "existing source revision marker differs"
  [[ "$(<"${FINAL_SOURCE}/.refunddesk-source-sha256")" == "${EXPECTED_SHA256}" ]] ||
    die "existing source archive marker differs"
  DURABILITY_HELPER="${FINAL_SOURCE}/deploy/lightsail/scripts/release-transition-journal.py"
  assert_root_control_file "${DURABILITY_HELPER}"
  python3 "${DURABILITY_HELPER}" fsync-tree --path "${FINAL_SOURCE}" >/dev/null ||
    die "existing source tree could not be synchronized durably"
  for durable_directory in \
    "${RELEASE_PARENT}" \
    "${REFUNDDESK_ROOT}/releases" \
    "${REFUNDDESK_ROOT}"; do
    python3 "${DURABILITY_HELPER}" fsync-directory --path "${durable_directory}" >/dev/null ||
      die "existing source parent could not be synchronized durably"
  done
  install_stable_control_plane "${FINAL_SOURCE}"
  log "exact source revision ${REVISION} is already installed"
  exit 0
fi

install -d -o root -g root -m 0755 "${REFUNDDESK_ROOT}/releases" "${RELEASE_PARENT}"
TEMP_SOURCE="$(mktemp --directory "${RELEASE_PARENT}/.source.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${TEMP_SOURCE}" && -d "${TEMP_SOURCE}" ]]; then
    resolved_temp="$(readlink --canonicalize-existing -- "${TEMP_SOURCE}")"
    [[ "$(dirname -- "${resolved_temp}")" == "${RELEASE_PARENT}" ]] ||
      die "temporary source path escaped its release directory"
    [[ "$(basename -- "${resolved_temp}")" == .source.* ]] ||
      die "temporary source path has an unexpected name"
    find "${resolved_temp}" -xdev -depth -delete
  fi
  exit "${status}"
}
trap cleanup EXIT

mapfile -t archive_entries < <(zstd --decompress --stdout -- "${ARCHIVE}" | tar --list --file=-)
(( ${#archive_entries[@]} > 0 )) || die "source archive is empty"
for entry in "${archive_entries[@]}"; do
  [[ "${entry}" == "deploy/" ||
    "${entry}" == "deploy/lightsail/" ||
    "${entry}" == deploy/lightsail/* ]] ||
    die "source archive contains a path outside deploy/lightsail"
  [[ "${entry}" != /* && "${entry}" != *'..'* && "${entry}" != *\\* ]] ||
    die "source archive contains an unsafe path"
  [[ "${entry}" != *.md ]] || die "source archive contains a forbidden Markdown file"
done

zstd --decompress --stdout -- "${ARCHIVE}" |
  tar \
    --extract \
    --file=- \
    --directory="${TEMP_SOURCE}" \
    --no-same-owner \
    --no-same-permissions

if find "${TEMP_SOURCE}" -xdev \
  \( -type l -o -type b -o -type c -o -type p -o -type s \) \
  -print -quit |
  grep -q .; then
  die "source archive contains a link or special file"
fi

for required_path in \
  deploy/lightsail/compose.yml \
  deploy/lightsail/Caddyfile.public \
  deploy/lightsail/Caddyfile.verifier \
  deploy/lightsail/RELEASE_CONTRACT_VERSION \
  deploy/lightsail/pg_hba.conf \
  deploy/lightsail/scripts/backup-launcher.sh \
  deploy/lightsail/scripts/release-launcher.sh \
  deploy/lightsail/scripts/release-fence.sh \
  deploy/lightsail/scripts/release.sh \
  deploy/lightsail/scripts/release-transition-journal.py \
  deploy/lightsail/scripts/prepare-postgres-root-mount.sh \
  deploy/lightsail/scripts/quiesce-recovery-launcher.sh \
  deploy/lightsail/scripts/recover-quiesced-runtime.sh \
  deploy/lightsail/scripts/retention-launcher.sh \
  deploy/lightsail/scripts/verify-deployment.sh \
  deploy/lightsail/scripts/backup.sh \
  deploy/lightsail/scripts/run-retention.sh \
  deploy/lightsail/systemd/refunddesk-backup.service \
  deploy/lightsail/systemd/refunddesk-backup.timer \
  deploy/lightsail/systemd/refunddesk-retention.service \
  deploy/lightsail/systemd/refunddesk-retention.timer \
  deploy/lightsail/systemd/refunddesk-quiesce-recovery.service; do
  assert_regular_file "${TEMP_SOURCE}/${required_path}"
done

bash -n "${TEMP_SOURCE}"/deploy/lightsail/scripts/*.sh
chown -R root:root "${TEMP_SOURCE}"
chmod -R go-w "${TEMP_SOURCE}"
chmod 0444 \
  "${TEMP_SOURCE}/deploy/lightsail/Caddyfile.public" \
  "${TEMP_SOURCE}/deploy/lightsail/Caddyfile.verifier" \
  "${TEMP_SOURCE}/deploy/lightsail/pg_hba.conf"
printf '%s\n' "${REVISION}" >"${TEMP_SOURCE}/.refunddesk-revision"
printf '%s\n' "${EXPECTED_SHA256}" >"${TEMP_SOURCE}/.refunddesk-source-sha256"
chmod 0600 \
  "${TEMP_SOURCE}/.refunddesk-revision" \
  "${TEMP_SOURCE}/.refunddesk-source-sha256"
mapfile -t contract_lines <"${TEMP_SOURCE}/deploy/lightsail/RELEASE_CONTRACT_VERSION"
(( ${#contract_lines[@]} == 1 )) &&
  [[ "${contract_lines[0]}" == "${RELEASE_CONTRACT_VERSION}" ]] ||
  die "source does not implement release contract ${RELEASE_CONTRACT_VERSION}"

TEMP_DURABILITY_HELPER="${TEMP_SOURCE}/deploy/lightsail/scripts/release-transition-journal.py"
assert_root_control_file "${TEMP_DURABILITY_HELPER}"
python3 "${TEMP_DURABILITY_HELPER}" fsync-tree --path "${TEMP_SOURCE}" >/dev/null ||
  die "source tree could not be synchronized before activation"
mv --no-target-directory -- "${TEMP_SOURCE}" "${FINAL_SOURCE}"
TEMP_SOURCE=""
FINAL_DURABILITY_HELPER="${FINAL_SOURCE}/deploy/lightsail/scripts/release-transition-journal.py"
for durable_directory in \
  "${RELEASE_PARENT}" \
  "${REFUNDDESK_ROOT}/releases" \
  "${REFUNDDESK_ROOT}"; do
  python3 "${FINAL_DURABILITY_HELPER}" fsync-directory --path "${durable_directory}" >/dev/null ||
    die "source parent could not be synchronized after activation"
done
install_stable_control_plane "${FINAL_SOURCE}"
log "exact source revision ${REVISION} staged behind a verified release-contract-2 bridge"
