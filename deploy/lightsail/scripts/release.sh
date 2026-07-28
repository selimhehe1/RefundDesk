#!/usr/bin/env bash

# Release contract:
# - The artifact directory contains three sibling files produced by CI:
#   refunddesk-sandbox-<40hex>.images.tar.zst, its .sha256 file, and
#   refunddesk-sandbox-<40hex>.manifest.json.
# - The manifest schema is version 1 and names exactly web/worker/migrate images.
# - Compose and operator scripts come from the immutable source directory whose
#   revision is promoted only after the deployment verifies successfully.
# - Root-only platform.env, worker.env and migration.env already exist.
# - Database preparation is deliberately executed twice under one host flock to
#   prove idempotence. A failed promotion stops every public/effect process.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
export REFUNDDESK_COMPOSE_FILE="${SOURCE_ROOT}/deploy/lightsail/compose.yml"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

ARTIFACT_DIR=""
REVISION=""
PUBLIC_ORIGIN=""
EXPECTED_BUNDLE_SHA256=""
PROMOTION_STARTED=false
PROMOTION_COMPLETE=false
RELEASE_ENV_CHANGED=false
PREVIOUS_RELEASE_ENV_PRESENT=false
PREVIOUS_RELEASE_ENV_BACKUP=""
RELEASE_ENV_TMP=""
CURRENT_LINK_CHANGED=false
PREVIOUS_CURRENT_PRESENT=false
PREVIOUS_CURRENT_TARGET=""
CURRENT_LINK_TMP=""
ACTIVE_REVISION_CHANGED=false
PREVIOUS_ACTIVE_REVISION_PRESENT=false
PREVIOUS_ACTIVE_REVISION_BACKUP=""
ACTIVE_REVISION_TMP=""

usage() {
  cat <<'EOF'
Usage: sudo bash release.sh --artifact-dir DIR --expected-sha256 SHA256 [--revision FULL_SHA] [--origin HTTPS_ORIGIN]

If --revision is omitted, DIR must contain exactly one schema-v1 manifest.
If --origin is omitted, /etc/refunddesk/public-origin must contain one HTTPS origin.
SHA256 must come from the authenticated operator workstation, not the adjacent checksum file.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --artifact-dir)
      (( $# >= 2 )) || die "--artifact-dir requires a value"
      ARTIFACT_DIR="$2"
      shift 2
      ;;
    --revision)
      (( $# >= 2 )) || die "--revision requires a value"
      REVISION="$2"
      shift 2
      ;;
    --origin)
      (( $# >= 2 )) || die "--origin requires a value"
      PUBLIC_ORIGIN="$2"
      shift 2
      ;;
    --expected-sha256)
      (( $# >= 2 )) || die "--expected-sha256 requires a value"
      EXPECTED_BUNDLE_SHA256="$2"
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
require_command docker
require_command jq
require_command sha256sum
require_command zstd
acquire_operator_lock

[[ -n "${ARTIFACT_DIR}" ]] || die "--artifact-dir is required"
[[ "${EXPECTED_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
  die "--expected-sha256 must be a lowercase SHA-256 supplied out of band"
ARTIFACT_DIR="$(readlink --canonicalize-existing -- "${ARTIFACT_DIR}")"
assert_safe_directory "${ARTIFACT_DIR}"

if [[ -z "${REVISION}" ]]; then
  mapfile -t manifests < <(
    find "${ARTIFACT_DIR}" -maxdepth 1 -type f \
      -name 'refunddesk-sandbox-*.manifest.json' -printf '%f\n'
  )
  (( ${#manifests[@]} == 1 )) ||
    die "artifact directory must contain exactly one manifest when --revision is omitted"
  REVISION="${manifests[0]#refunddesk-sandbox-}"
  REVISION="${REVISION%.manifest.json}"
fi
[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a full lowercase 40-hex Git SHA"

EXPECTED_SOURCE_ROOT="${REFUNDDESK_ROOT}/releases/${REVISION}/source"
[[ "${SOURCE_ROOT}" == "${EXPECTED_SOURCE_ROOT}" ]] ||
  die "release script is not running from the revision-scoped source directory"
SOURCE_REVISION_FILE="${SOURCE_ROOT}/.refunddesk-revision"
assert_root_secret_file "${SOURCE_REVISION_FILE}"
mapfile -t source_revision_lines <"${SOURCE_REVISION_FILE}"
(( ${#source_revision_lines[@]} == 1 )) ||
  die "current deployment source revision marker must contain exactly one line"
[[ "${source_revision_lines[0]}" == "${REVISION}" ]] ||
  die "deployment source and image bundle revisions differ"

BUNDLE_NAME="refunddesk-sandbox-${REVISION}.images.tar.zst"
MANIFEST_NAME="refunddesk-sandbox-${REVISION}.manifest.json"
BUNDLE_PATH="${ARTIFACT_DIR}/${BUNDLE_NAME}"
MANIFEST_PATH="${ARTIFACT_DIR}/${MANIFEST_NAME}"
CHECKSUM_PATH="${BUNDLE_PATH}.sha256"

assert_regular_file "${BUNDLE_PATH}"
assert_regular_file "${MANIFEST_PATH}"
assert_regular_file "${CHECKSUM_PATH}"
for artifact_path in "${ARTIFACT_DIR}" "${BUNDLE_PATH}" "${MANIFEST_PATH}" "${CHECKSUM_PATH}"; do
  [[ "$(stat --format='%u' -- "${artifact_path}")" == "0" ]] ||
    die "release artifacts and their directory must be owned by root: ${artifact_path}"
  artifact_mode="$(stat --format='%a' -- "${artifact_path}")"
  (( (8#${artifact_mode} & 022) == 0 )) ||
    die "release artifacts must not be group/world writable: ${artifact_path}"
done

read -r checksum_file_hash checksum_file_name checksum_extra <"${CHECKSUM_PATH}"
checksum_file_name="${checksum_file_name#\\*}"
[[ "${checksum_file_hash}" =~ ^[0-9a-f]{64}$ &&
  "${checksum_file_hash}" == "${EXPECTED_BUNDLE_SHA256}" &&
  "${checksum_file_name}" == "${BUNDLE_NAME}" &&
  -z "${checksum_extra:-}" ]] ||
  die "checksum file has an unexpected shape or filename"
(
  cd -- "${ARTIFACT_DIR}"
  sha256sum --check --strict --status -- "${BUNDLE_NAME}.sha256"
) || die "bundle checksum verification failed"
zstd --test --quiet -- "${BUNDLE_PATH}" || die "bundle zstd integrity verification failed"

jq --exit-status \
  --arg revision "${REVISION}" \
  --arg bundle "${BUNDLE_NAME}" \
  --arg sha256 "${checksum_file_hash}" '
    type == "object"
    and keys == ["bundle","createdAt","images","platform","revision","schemaVersion","source"]
    and .schemaVersion == 1
    and .revision == $revision
    and .platform == "linux/amd64"
    and .source == "https://github.com/selimhehe1/RefundDesk"
    and (.createdAt | type == "string")
    and (.bundle | type == "object"
      and keys == ["file","sha256"]
      and .file == $bundle
      and .sha256 == $sha256)
    and (.images | type == "array" and length == 3)
    and ([.images[].role] | sort == ["migrate","web","worker"])
    and (all(.images[];
      type == "object"
      and keys == ["expectedUser","imageId","reference","role"]
      and .expectedUser == "node"
      and (.imageId | test("^sha256:[0-9a-f]{64}$"))
      and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision)))
  ' "${MANIFEST_PATH}" >/dev/null ||
  die "manifest validation failed"

manifest_source="$(jq --raw-output '.source' "${MANIFEST_PATH}")"
date --date="$(jq --raw-output '.createdAt' "${MANIFEST_PATH}")" >/dev/null ||
  die "manifest createdAt is not a valid timestamp"

log "loading verified OCI bundle for revision ${REVISION}"
zstd --decompress --stdout -- "${BUNDLE_PATH}" | docker image load >/dev/null

for role in web worker migrate; do
  reference="refunddesk-${role}:sandbox-${REVISION}"
  expected_id="$(jq --raw-output --arg role "${role}" '.images[] | select(.role == $role) | .imageId' "${MANIFEST_PATH}")"
  inspect_json="$(docker image inspect "${reference}")"
  jq --exit-status \
    --arg id "${expected_id}" \
    --arg revision "${REVISION}" \
    --arg source "${manifest_source}" '
      length == 1
      and .[0].Id == $id
      and .[0].Os == "linux"
      and .[0].Architecture == "amd64"
      and .[0].Config.User == "node"
      and .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
      and .[0].Config.Labels["org.opencontainers.image.source"] == $source
    ' <<<"${inspect_json}" >/dev/null ||
    die "loaded ${role} image does not match its manifest contract"
done

PLATFORM_ENV="${REFUNDDESK_CONFIG_ROOT}/platform.env"
WORKER_ENV="${REFUNDDESK_CONFIG_ROOT}/worker.env"
MIGRATION_ENV="${REFUNDDESK_CONFIG_ROOT}/migration.env"
CADDY_ENV="${REFUNDDESK_CONFIG_ROOT}/caddy.env"
ORIGIN_FILE="${REFUNDDESK_CONFIG_ROOT}/public-origin"
for environment_file in \
  "${PLATFORM_ENV}" \
  "${WORKER_ENV}" \
  "${MIGRATION_ENV}" \
  "${CADDY_ENV}" \
  "${ORIGIN_FILE}"; do
  assert_root_secret_file "${environment_file}"
done

IFS= read -r CONFIGURED_PUBLIC_ORIGIN <"${ORIGIN_FILE}"
[[ "${CONFIGURED_PUBLIC_ORIGIN}" =~ ^https://[A-Za-z0-9.-]+$ ]] ||
  die "root-owned public origin must be HTTPS without port, path, query or credentials"
if [[ -n "${PUBLIC_ORIGIN}" && "${PUBLIC_ORIGIN}" != "${CONFIGURED_PUBLIC_ORIGIN}" ]]; then
  die "supplied public origin differs from the root-owned origin file"
fi
PUBLIC_ORIGIN="${CONFIGURED_PUBLIC_ORIGIN}"

MIGRATE_IMAGE="refunddesk-migrate:sandbox-${REVISION}"
docker run --rm \
  --network none \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 384m \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  --mount "type=bind,source=${PLATFORM_ENV},target=/run/refunddesk/platform.env,readonly" \
  --mount "type=bind,source=${WORKER_ENV},target=/run/refunddesk/worker.env,readonly" \
  --mount "type=bind,source=${MIGRATION_ENV},target=/run/refunddesk/migration.env,readonly" \
  --mount "type=bind,source=${CADDY_ENV},target=/run/refunddesk/caddy.env,readonly" \
  --mount "type=bind,source=${ORIGIN_FILE},target=/run/refunddesk/public-origin,readonly" \
  "${MIGRATE_IMAGE}" \
  node packages/config/dist/check-release.js \
    /run/refunddesk/platform.env \
    /run/refunddesk/worker.env \
    /run/refunddesk/migration.env \
    /run/refunddesk/caddy.env \
    /run/refunddesk/public-origin

fail_closed() {
  local status=$?
  trap - EXIT

  [[ -z "${RELEASE_ENV_TMP}" ]] || rm -f -- "${RELEASE_ENV_TMP}"
  [[ -z "${CURRENT_LINK_TMP}" ]] || rm -f -- "${CURRENT_LINK_TMP}"
  [[ -z "${ACTIVE_REVISION_TMP}" ]] || rm -f -- "${ACTIVE_REVISION_TMP}"

  if (( status != 0 )) && [[ "${CURRENT_LINK_CHANGED}" == "true" ]]; then
    log "restoring the previously active operator source"
    if [[ "${PREVIOUS_CURRENT_PRESENT}" == "true" ]]; then
      rollback_link="${REFUNDDESK_ROOT}/.current.rollback.$$"
      rm -f -- "${rollback_link}"
      ln -s -- "${PREVIOUS_CURRENT_TARGET}" "${rollback_link}" &&
        mv --force --no-target-directory -- "${rollback_link}" "${REFUNDDESK_ROOT}/current" ||
        status=1
      rm -f -- "${rollback_link}"
    else
      rm -f -- "${REFUNDDESK_ROOT}/current" || status=1
    fi
  fi

  if (( status != 0 )) && [[ "${ACTIVE_REVISION_CHANGED}" == "true" ]]; then
    if [[ "${PREVIOUS_ACTIVE_REVISION_PRESENT}" == "true" ]]; then
      install -o root -g root -m 0644 \
        "${PREVIOUS_ACTIVE_REVISION_BACKUP}" "${REFUNDDESK_ROOT}/ACTIVE_REVISION" || status=1
    else
      rm -f -- "${REFUNDDESK_ROOT}/ACTIVE_REVISION" || status=1
    fi
  fi

  if (( status != 0 )) && [[ "${RELEASE_ENV_CHANGED}" == "true" ]]; then
    log "restoring the previously active image selection"
    if [[ "${PREVIOUS_RELEASE_ENV_PRESENT}" == "true" ]]; then
      install -o root -g root -m 0600 \
        "${PREVIOUS_RELEASE_ENV_BACKUP}" "${REFUNDDESK_RELEASE_ENV}" || status=1
    else
      rm -f -- "${REFUNDDESK_RELEASE_ENV}" || status=1
    fi
  fi

  if (( status != 0 )) &&
    [[ "${PROMOTION_STARTED}" == "true" && "${PROMOTION_COMPLETE}" != "true" ]]; then
    log "release validation failed; stopping public and effect-capable services"
    refunddesk_compose stop --timeout 45 caddy web verifier worker >/dev/null 2>&1 || true
  fi

  [[ -z "${PREVIOUS_RELEASE_ENV_BACKUP}" ]] ||
    rm -f -- "${PREVIOUS_RELEASE_ENV_BACKUP}"
  [[ -z "${PREVIOUS_ACTIVE_REVISION_BACKUP}" ]] ||
    rm -f -- "${PREVIOUS_ACTIVE_REVISION_BACKUP}"
  exit "${status}"
}
trap fail_closed EXIT

if [[ -e "${REFUNDDESK_RELEASE_ENV}" || -L "${REFUNDDESK_RELEASE_ENV}" ]]; then
  assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"
  PREVIOUS_RELEASE_ENV_BACKUP="$(
    mktemp "${REFUNDDESK_CONFIG_ROOT}/.release.env.previous.XXXXXX"
  )"
  install -o root -g root -m 0600 \
    "${REFUNDDESK_RELEASE_ENV}" "${PREVIOUS_RELEASE_ENV_BACKUP}"
  PREVIOUS_RELEASE_ENV_PRESENT=true
fi

RELEASE_ENV_TMP="$(mktemp "${REFUNDDESK_CONFIG_ROOT}/.release.env.XXXXXX")"
printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\n' \
  "${REVISION}" "${REVISION}" >"${RELEASE_ENV_TMP}"
RELEASE_ENV_CHANGED=true
install -o root -g root -m 0600 "${RELEASE_ENV_TMP}" "${REFUNDDESK_RELEASE_ENV}"
rm -f -- "${RELEASE_ENV_TMP}"
RELEASE_ENV_TMP=""
export REFUNDDESK_IMAGE_TAG="sandbox-${REVISION}"
export REFUNDDESK_REVISION="${REVISION}"

refunddesk_compose config --quiet
refunddesk_compose up --detach --no-build postgres
wait_for_container_health postgres 120 || die "PostgreSQL container is not healthy"

PROMOTION_STARTED=true
refunddesk_compose stop --timeout 45 caddy worker web verifier >/dev/null 2>&1 || true

log "repairing the three restricted PostgreSQL runtime logins"
refunddesk_compose --profile release run --rm --no-deps --pull never bootstrap

log "running serialized canonical database preparation (pass 1/2)"
refunddesk_compose --profile release run --rm --no-deps --pull never migrate
log "running serialized canonical database preparation (pass 2/2)"
refunddesk_compose --profile release run --rm --no-deps --pull never migrate

refunddesk_compose up --detach --no-deps --no-build verifier worker web
wait_for_container_health verifier 90 || die "private verifier proxy is not healthy"
wait_for_container_health worker 180 || die "worker is not healthy"
wait_for_container_health web 120 || die "web is not healthy"
refunddesk_compose up --detach --no-deps --no-build caddy
wait_for_container_health caddy 120 || die "public proxy is not healthy"

bash "${SCRIPT_DIR}/verify-deployment.sh" --origin "${PUBLIC_ORIGIN}"

RELEASE_DIR="${REFUNDDESK_ROOT}/releases/${REVISION}"
install -d -o root -g root -m 0755 "${RELEASE_DIR}"
install -o root -g root -m 0644 "${MANIFEST_PATH}" "${RELEASE_DIR}/manifest.json"

if [[ -L "${REFUNDDESK_ROOT}/current" ]]; then
  [[ "$(stat --format='%u' -- "${REFUNDDESK_ROOT}/current")" == "0" ]] ||
    die "current source symlink must be owned by root"
  PREVIOUS_CURRENT_TARGET="$(readlink -- "${REFUNDDESK_ROOT}/current")"
  PREVIOUS_CURRENT_PRESENT=true
elif [[ -e "${REFUNDDESK_ROOT}/current" ]]; then
  die "current source path must be absent or a symlink"
fi

if [[ -e "${REFUNDDESK_ROOT}/ACTIVE_REVISION" ||
  -L "${REFUNDDESK_ROOT}/ACTIVE_REVISION" ]]; then
  assert_root_control_file "${REFUNDDESK_ROOT}/ACTIVE_REVISION"
  PREVIOUS_ACTIVE_REVISION_BACKUP="$(
    mktemp "${REFUNDDESK_ROOT}/.active-revision.previous.XXXXXX"
  )"
  install -o root -g root -m 0600 \
    "${REFUNDDESK_ROOT}/ACTIVE_REVISION" "${PREVIOUS_ACTIVE_REVISION_BACKUP}"
  PREVIOUS_ACTIVE_REVISION_PRESENT=true
fi

ACTIVE_REVISION_TMP="$(mktemp "${REFUNDDESK_ROOT}/.active-revision.XXXXXX")"
printf '%s\n' "${REVISION}" >"${ACTIVE_REVISION_TMP}"
ACTIVE_REVISION_CHANGED=true
install -o root -g root -m 0644 \
  "${ACTIVE_REVISION_TMP}" "${REFUNDDESK_ROOT}/ACTIVE_REVISION"
rm -f -- "${ACTIVE_REVISION_TMP}"
ACTIVE_REVISION_TMP=""

CURRENT_LINK_TMP="${REFUNDDESK_ROOT}/.current.${REVISION}.$$"
rm -f -- "${CURRENT_LINK_TMP}"
ln -s -- "${SOURCE_ROOT}" "${CURRENT_LINK_TMP}"
CURRENT_LINK_CHANGED=true
mv --force --no-target-directory -- "${CURRENT_LINK_TMP}" "${REFUNDDESK_ROOT}/current"
CURRENT_LINK_TMP=""

PROMOTION_COMPLETE=true
log "sandbox release ${REVISION} is active and verified"
