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
for command in bash find git sha256sum tar zstd; do
  require_command "${command}"
done
acquire_operator_lock

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a full lowercase Git SHA"
[[ "${EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]] ||
  die "expected source archive SHA-256 must be lowercase hex"
[[ -n "${ARCHIVE}" ]] || die "--archive is required"
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
  deploy/lightsail/scripts/release.sh \
  deploy/lightsail/scripts/verify-deployment.sh \
  deploy/lightsail/scripts/backup.sh; do
  assert_regular_file "${TEMP_SOURCE}/${required_path}"
done

bash -n "${TEMP_SOURCE}"/deploy/lightsail/scripts/*.sh
chown -R root:root "${TEMP_SOURCE}"
chmod -R go-w "${TEMP_SOURCE}"
printf '%s\n' "${REVISION}" >"${TEMP_SOURCE}/.refunddesk-revision"
printf '%s\n' "${EXPECTED_SHA256}" >"${TEMP_SOURCE}/.refunddesk-source-sha256"
chmod 0600 \
  "${TEMP_SOURCE}/.refunddesk-revision" \
  "${TEMP_SOURCE}/.refunddesk-source-sha256"

mv --no-target-directory -- "${TEMP_SOURCE}" "${FINAL_SOURCE}"
TEMP_SOURCE=""
log "exact source revision ${REVISION} installed without promotion"
