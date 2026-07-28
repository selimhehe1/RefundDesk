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
readonly LOCK_FILE="/run/lock/refunddesk-internal-pki.lock"

PRIVATE_WORK_DIRECTORY=""
STAGING_DIRECTORY=""
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

remove_private_work_directory() {
  [[ -n "${PRIVATE_WORK_DIRECTORY}" ]] || return 0
  [[ "${PRIVATE_WORK_DIRECTORY}" == /run/refunddesk-internal-pki.* ]] ||
    die "refusing to remove an unexpected private work directory"
  [[ -d "${PRIVATE_WORK_DIRECTORY}" && ! -L "${PRIVATE_WORK_DIRECTORY}" ]] || return 0

  rm -f -- \
    "${PRIVATE_WORK_DIRECTORY}/postgres-ca.key" \
    "${PRIVATE_WORK_DIRECTORY}/postgres-ca.crt" \
    "${PRIVATE_WORK_DIRECTORY}/postgres-server.key" \
    "${PRIVATE_WORK_DIRECTORY}/postgres-server.csr" \
    "${PRIVATE_WORK_DIRECTORY}/postgres-server.ext" \
    "${PRIVATE_WORK_DIRECTORY}/postgres-key.pub" \
    "${PRIVATE_WORK_DIRECTORY}/postgres-cert.pub" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-ca.key" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-ca.crt" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-server.key" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-server.csr" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-server.ext" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-key.pub" \
    "${PRIVATE_WORK_DIRECTORY}/verifier-cert.pub"
  rmdir -- "${PRIVATE_WORK_DIRECTORY}"
  PRIVATE_WORK_DIRECTORY=""
}

remove_staging_directory() {
  local name

  [[ -n "${STAGING_DIRECTORY}" ]] || return 0
  [[ "${STAGING_DIRECTORY}" == "${TLS_ROOT}"/.pki-stage.* ]] ||
    die "refusing to remove an unexpected PKI staging directory"
  [[ -d "${STAGING_DIRECTORY}" && ! -L "${STAGING_DIRECTORY}" ]] || return 0

  rm -f -- \
    "${STAGING_DIRECTORY}/postgres/ca.crt" \
    "${STAGING_DIRECTORY}/postgres/server.crt" \
    "${STAGING_DIRECTORY}/postgres/server.key" \
    "${STAGING_DIRECTORY}/verifier/ca.crt" \
    "${STAGING_DIRECTORY}/verifier/server.crt" \
    "${STAGING_DIRECTORY}/verifier/server.key" \
    "${STAGING_DIRECTORY}/client/refunddesk-ca-bundle.crt"
  for name in postgres verifier client; do
    [[ ! -d "${STAGING_DIRECTORY}/${name}" ]] ||
      rmdir -- "${STAGING_DIRECTORY}/${name}"
  done
  rmdir -- "${STAGING_DIRECTORY}"
  STAGING_DIRECTORY=""
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
for command in chmod chown cmp find findmnt flock grep install mktemp mv openssl rmdir stat tail tr; do
  require_command "${command}"
done
[[ "${TLS_ROOT}" == /* && "${TLS_ROOT}" != "/" ]] || die "TLS root must be an absolute safe path"
[[ "$(findmnt --noheadings --output FSTYPE --target /run | tr -d '[:space:]')" == "tmpfs" ]] ||
  die "/run must be tmpfs so CA private keys never reach persistent storage"

install -d -o root -g root -m 0755 /run/lock
exec 9>"${LOCK_FILE}"
flock --exclusive --nonblock 9 || die "another internal PKI provisioning process holds the lock"

if [[ -e "${TLS_ROOT}" || -L "${TLS_ROOT}" ]]; then
  [[ -d "${TLS_ROOT}" && ! -L "${TLS_ROOT}" ]] || die "TLS root must be a non-symlink directory"
else
  install -d -o root -g root -m 0755 "${TLS_ROOT}"
fi
install -d -o root -g root -m 0755 "${TLS_ROOT}"

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
STAGING_DIRECTORY="$(mktemp --directory "${TLS_ROOT}/.pki-stage.XXXXXX")"
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
} >"${STAGING_DIRECTORY}/client/refunddesk-ca-bundle.crt"
chown root:root "${STAGING_DIRECTORY}/client/refunddesk-ca-bundle.crt"
chmod 0444 "${STAGING_DIRECTORY}/client/refunddesk-ca-bundle.crt"

validate_installed_material "${STAGING_DIRECTORY}"

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
