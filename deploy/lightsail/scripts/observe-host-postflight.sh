#!/usr/bin/env bash

# Emits one bounded, redacted, read-only observation of the RefundDesk sandbox
# host. The program is designed to be streamed to `sudo bash -s`; it does not
# source the installed control plane and never creates, changes, or removes a
# host object. A shared lock prevents an operator mutation during captures A/B.

set -uo pipefail
set +x
set +a
umask 077
export LC_ALL=C

# Nothing below may leak a command diagnostic. Stable allowlisted codes belong
# in the JSON document; stderr is deliberately closed for the whole process.
exec 2>/dev/null

readonly EXIT_INCOMPLETE=21
readonly EXIT_USAGE=64
readonly MAX_OUTPUT_BYTES=262144
readonly EXACT_E4_REVISION="e4cec06068d71afb5c2ac9fc04175bfdfd6756c2"
readonly POSTGRES_IMAGE_REFERENCE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
readonly CADDY_IMAGE_REFERENCE="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"

if (( $# != 2 )) || [[ "$1" != "--nonce" ]] ||
  [[ ! "$2" =~ ^[0-9a-f]{64}$ ]]; then
  exit "${EXIT_USAGE}"
fi
readonly NONCE="$2"

if [[ "${REFUNDDESK_POSTFLIGHT_TEST_MODE:-}" == "1" ]]; then
  (( EUID != 0 )) || exit "${EXIT_USAGE}"
  [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" &&
    ! -L "${BASH_SOURCE[0]}" &&
    "${BASH_SOURCE[0]##*/}" == "observe-host-postflight.sh" ]] ||
    exit "${EXIT_USAGE}"
  ROOT="${REFUNDDESK_POSTFLIGHT_ROOT:-}"
  CONFIG_ROOT="${REFUNDDESK_POSTFLIGHT_CONFIG_ROOT:-}"
  CONTROL_ROOT="${REFUNDDESK_POSTFLIGHT_CONTROL_ROOT:-}"
  OPERATOR_LOCK="${REFUNDDESK_POSTFLIGHT_OPERATOR_LOCK:-}"
  RUNTIME_ROOT="${REFUNDDESK_POSTFLIGHT_RUNTIME_ROOT:-}"
  [[ "${ROOT}" == /tmp/refunddesk-postflight-test-* &&
    "${CONFIG_ROOT}" == /tmp/refunddesk-postflight-test-* &&
    "${CONTROL_ROOT}" == /tmp/refunddesk-postflight-test-* &&
    "${OPERATOR_LOCK}" == /tmp/refunddesk-postflight-test-* &&
    "${RUNTIME_ROOT}" == /tmp/refunddesk-postflight-test-* ]] ||
    exit "${EXIT_USAGE}"
  EXPECTED_UID="$(id -u)"
  EXPECTED_GID="$(id -g)"
else
  [[ -z "${REFUNDDESK_POSTFLIGHT_ROOT:-}" &&
    -z "${REFUNDDESK_POSTFLIGHT_CONFIG_ROOT:-}" &&
    -z "${REFUNDDESK_POSTFLIGHT_CONTROL_ROOT:-}" &&
    -z "${REFUNDDESK_POSTFLIGHT_OPERATOR_LOCK:-}" &&
    -z "${REFUNDDESK_POSTFLIGHT_RUNTIME_ROOT:-}" ]] ||
    exit "${EXIT_USAGE}"
  (( EUID == 0 )) || exit "${EXIT_USAGE}"
  ROOT="/opt/refunddesk"
  CONFIG_ROOT="/etc/refunddesk"
  CONTROL_ROOT="/var/lib/refunddesk/control"
  OPERATOR_LOCK="/run/refunddesk/operator.lock"
  RUNTIME_ROOT="/run"
  EXPECTED_UID=0
  EXPECTED_GID=0
fi
readonly ROOT CONFIG_ROOT CONTROL_ROOT OPERATOR_LOCK RUNTIME_ROOT EXPECTED_UID EXPECTED_GID

readonly RELEASE_ENV="${CONFIG_ROOT}/release.env"
readonly PLATFORM_ENV="${CONFIG_ROOT}/platform.env"
readonly WORKER_ENV="${CONFIG_ROOT}/worker.env"
readonly TRANSITION_JOURNAL="${CONFIG_ROOT}/application-key-transition-in-progress.json"
readonly TRANSITION_COMMIT_MARKER="${CONFIG_ROOT}/application-key-transition-committed.json"
readonly LEGACY_APP_ID_JOURNAL="${CONFIG_ROOT}/stripe-app-id-transition-in-progress.json"
readonly QUIESCE_JOURNAL="${CONTROL_ROOT}/runtime-quiesce-in-progress.json"
readonly BACKUP_JOURNAL="${CONTROL_ROOT}/backup-upload-in-progress.json"
readonly MANAGED_TRANSITION_MARKER="${CONFIG_ROOT}/managed-sandbox-three-binding-transition-in-progress.json"
readonly MANAGED_COMPLETION_MARKER="${CONTROL_ROOT}/managed-sandbox-three-binding-transition-completed.json"

timestamp_now() {
  date --utc '+%Y-%m-%dT%H:%M:%SZ'
}

bounded_capture() {
  local limit="$1" output
  shift
  output="$(
    set +o pipefail
    "$@" | head --bytes "$((limit + 1))"
    pipeline_status=("${PIPESTATUS[@]}")
    (( pipeline_status[0] == 0 && pipeline_status[1] == 0 )) || exit 1
  )" || return 1
  (( ${#output} <= limit )) || return 1
  printf '%s' "${output}"
}

file_has_metadata() {
  local path="$1" expected_mode="$2" metadata
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}" 2>/dev/null)" || return 1
  [[ "${metadata}" == "${EXPECTED_UID}:${EXPECTED_GID}:${expected_mode}" ]]
}

file_has_public_metadata() {
  local path="$1" metadata mode
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}" 2>/dev/null)" || return 1
  [[ "${metadata}" =~ ^${EXPECTED_UID}:${EXPECTED_GID}:([0-7]{3,4})$ ]] || return 1
  mode="${BASH_REMATCH[1]}"
  [[ "${mode}" =~ ^0?(400|440|444|600|640|644)$ ]]
}

directory_has_metadata() {
  local path="$1" expected_mode="$2" metadata
  [[ -d "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}" 2>/dev/null)" || return 1
  [[ "${metadata}" == "${EXPECTED_UID}:${EXPECTED_GID}:${expected_mode}" ]]
}

read_revision_file() {
  local path="$1" mode="$2" line
  local -a lines
  file_has_metadata "${path}" "${mode}" || return 1
  mapfile -t lines <"${path}" || return 1
  (( ${#lines[@]} == 1 )) || return 1
  line="${lines[0]}"
  [[ "${line}" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "${line}"
}

binding_state() {
  local path="$1" name="$2" disabled_value="$3" enabled_value="$4" count
  file_has_metadata "${path}" 600 || {
    printf 'UNAVAILABLE'
    return 0
  }
  count="$(grep --count --extended-regexp "^${name}=" "${path}" 2>/dev/null)" || true
  [[ "${count}" == "1" ]] || {
    printf 'UNAVAILABLE'
    return 0
  }
  if grep --quiet --fixed-strings --line-regexp \
    "${name}=${disabled_value}" "${path}"; then
    printf 'DISABLED'
  elif [[ -n "${enabled_value}" ]] &&
    grep --quiet --fixed-strings --line-regexp \
      "${name}=${enabled_value}" "${path}"; then
    printf 'ENABLED'
  else
    # The value is intentionally not read: it may itself be a credential.
    printf 'UNAVAILABLE'
  fi
}

release_environment_identity() {
  local line mode
  local -a lines
  file_has_metadata "${RELEASE_ENV}" 600 || return 1
  mapfile -t lines <"${RELEASE_ENV}" || return 1
  (( ${#lines[@]} == 2 || ${#lines[@]} == 3 )) || return 1
  [[ "${lines[0]}" =~ ^REFUNDDESK_IMAGE_TAG=sandbox-([0-9a-f]{40})$ ]] || return 1
  local image_revision="${BASH_REMATCH[1]}"
  [[ "${lines[1]}" =~ ^REFUNDDESK_REVISION=([0-9a-f]{40})$ ]] || return 1
  line="${BASH_REMATCH[1]}"
  [[ "${image_revision}" == "${line}" ]] || return 1
  if (( ${#lines[@]} == 2 )); then
    mode=LEGACY_NORMAL
  elif [[ "${lines[2]}" == "REFUNDDESK_WORKER_RUNTIME_MODE=normal" ]]; then
    mode=NORMAL
  elif [[ "${lines[2]}" == "REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission" ]]; then
    mode=INCIDENT_ADMISSION
  else
    return 1
  fi
  if [[ "${mode}" == LEGACY_NORMAL ]]; then
    cmp --silent \
      <(printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\n' \
        "${image_revision}" "${image_revision}") \
      "${RELEASE_ENV}" || return 1
  else
    cmp --silent \
      <(printf 'REFUNDDESK_IMAGE_TAG=sandbox-%s\nREFUNDDESK_REVISION=%s\nREFUNDDESK_WORKER_RUNTIME_MODE=%s\n' \
        "${image_revision}" "${image_revision}" "${lines[2]#*=}") \
      "${RELEASE_ENV}" || return 1
  fi
  printf '%s|%s' "${image_revision}" "${mode}"
}

manifest_is_valid() {
  local path="$1" revision="$2"
  file_has_metadata "${path}" 644 || return 1
  jq --exit-status --arg revision "${revision}" '
    type == "object"
    and keys == ["bundle","createdAt","images","platform","revision","schemaVersion","source"]
    and .schemaVersion == 1
    and .revision == $revision
    and .platform == "linux/amd64"
    and .source == "https://github.com/selimhehe1/RefundDesk"
    and (.createdAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.bundle | type == "object"
      and keys == ["file","sha256"]
      and .file == ("refunddesk-sandbox-" + $revision + ".images.tar.zst")
      and (.sha256 | type == "string" and test("^[0-9a-f]{64}$")))
    and (.images | type == "array" and length == 3)
    and ([.images[].role] | sort == ["migrate","web","worker"])
    and all(.images[];
      type == "object"
      and keys == ["expectedUser","imageId","reference","role"]
      and .expectedUser == "node"
      and (.imageId | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      and .reference == ("refunddesk-" + .role + ":sandbox-" + $revision))
  ' "${path}" >/dev/null
}

transition_commit_marker_is_valid() {
  local path="$1" revision="$2"
  file_has_metadata "${path}" 600 || return 1
  jq --exit-status --arg revision "${revision}" '
    def fingerprint:
      . == null or (type == "string" and test("^sha256:[0-9a-f]{64}$"));
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
        . == null or . == "legacy" or . == "staged" or . == "active"
        or . == "rollback" or . == "retired");
    def side:
      type == "object"
      and keys == ["fingerprints","recorded","revision","states"]
      and (.recorded | type == "boolean")
      and (.revision == null or (.revision | type == "string" and test("^[0-9a-f]{40}$")))
      and (.fingerprints | fingerprints)
      and (.states | states);
    type == "object"
    and keys == ["from","schemaVersion","status","to"]
    and .schemaVersion == 1
    and .status == "committed"
    and (.from | side)
    and (.to | side)
    and .to.recorded == true
    and .to.revision == $revision
  ' "${path}" >/dev/null
}

managed_completion_state() {
  local path="${MANAGED_COMPLETION_MARKER}"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    printf 'ABSENT'
    return 0
  fi
  file_has_metadata "${path}" 600 || {
    printf 'INVALID'
    return 0
  }
  if jq --exit-status --arg revision "${EXACT_E4_REVISION}" '
    def sha: type == "string" and test("^sha256:[0-9a-f]{64}$");
    type == "object"
    and keys == [
      "candidateFingerprints","cleanupVerified","committingAt","completedAt",
      "dashboardProofSha256","gate","liveEnabled","maintenanceTimersRestored",
      "newCredentialProofSha256","oldCredentialsRetested","publicIngressRestored",
      "rawSecretsPresentInMarker","result","revision","runtimeComposeConfigSha256",
      "runtimeImageIdentitySha256","schemaVersion","staticContractSha256","status",
      "transitionJournalSha256"
    ]
    and .schemaVersion == 2
    and .gate == "exact_e4_contained_three_binding_transition"
    and .revision == $revision
    and .status == "complete"
    and .result == "PASS_CONTAINED"
    and (.committingAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and (.completedAt | type == "string" and test("^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and .completedAt >= .committingAt
    and (.transitionJournalSha256 | sha)
    and (.dashboardProofSha256 | sha)
    and (.newCredentialProofSha256 | sha)
    and (.candidateFingerprints | type == "object"
      and keys == ["managedSandboxEffect","managedSandboxRead","stripeAppSigning"]
      and all(.[]; sha))
    and (.staticContractSha256 | type == "object"
      and keys == [
        "artifactManifest","bundle","caddyPublic","caddyVerifier","commonScript",
        "composeFile","installedManifest","releaseEnvironment","releaseLauncher",
        "releaseScript","sourceRevisionMarker","transitionHelper"
      ] and all(.[]; sha))
    and (.runtimeImageIdentitySha256 | type == "object"
      and keys == ["caddy","verifier","web","worker"] and all(.[]; sha))
    and (.runtimeComposeConfigSha256 | type == "object"
      and keys == ["caddy","verifier","web","worker"] and all(.[]; sha))
    and .cleanupVerified == true
    and .oldCredentialsRetested == false
    and .publicIngressRestored == false
    and .maintenanceTimersRestored == false
    and .liveEnabled == false
    and .rawSecretsPresentInMarker == false
  ' "${path}" >/dev/null; then
    printf 'VALID_PASS_CONTAINED'
  else
    printf 'INVALID'
  fi
}

sensitive_modes_are_safe() {
  local entry
  local -a required_files=(
    "${CONFIG_ROOT}/release.env"
    "${CONFIG_ROOT}/platform.env"
    "${CONFIG_ROOT}/worker.env"
    "${CONFIG_ROOT}/migration.env"
    "${CONFIG_ROOT}/maintenance.env"
    "${CONFIG_ROOT}/postgres.env"
    "${CONFIG_ROOT}/caddy.env"
    "${CONFIG_ROOT}/backup.env"
    "${CONFIG_ROOT}/aws/config"
    "${CONFIG_ROOT}/public-origin"
    "${CONFIG_ROOT}/application-key-rotation-state.json"
    "${CONFIG_ROOT}/secrets/postgres-owner-password"
    "${CONFIG_ROOT}/secrets/postgres-web-password"
    "${CONFIG_ROOT}/secrets/postgres-worker-password"
    "${CONFIG_ROOT}/secrets/postgres-queue-password"
    "${CONFIG_ROOT}/secrets/postgres-maintenance-password"
  )
  directory_has_metadata "${CONFIG_ROOT}" 700 || return 1
  directory_has_metadata "${CONFIG_ROOT}/secrets" 700 || return 1
  directory_has_metadata "${CONFIG_ROOT}/aws" 700 || return 1
  for entry in "${required_files[@]}"; do
    file_has_metadata "${entry}" 600 || return 1
  done
  shopt -s nullglob dotglob
  for entry in "${CONFIG_ROOT}/secrets/"*; do
    file_has_metadata "${entry}" 600 || {
      shopt -u nullglob dotglob
      return 1
    }
  done
  shopt -u nullglob dotglob
  for entry in \
    "${TRANSITION_JOURNAL}" \
    "${TRANSITION_COMMIT_MARKER}" \
    "${LEGACY_APP_ID_JOURNAL}" \
    "${QUIESCE_JOURNAL}" \
    "${BACKUP_JOURNAL}" \
    "${MANAGED_TRANSITION_MARKER}" \
    "${MANAGED_COMPLETION_MARKER}"; do
    if [[ -e "${entry}" || -L "${entry}" ]]; then
      file_has_metadata "${entry}" 600 || return 1
    fi
  done
}

container_observation() {
  local service="$1" revision="$2" expected_image="$3" expected_reference="$4"
  local ids_output present_count id inspect_line
  local actual_id image_id reference_match state health project_match service_match revision_label
  local -a ids

  if ! ids_output="$(
    bounded_capture 65536 timeout 15 docker container ls --all --no-trunc --quiet \
      --filter "label=com.docker.compose.project=refunddesk" \
      --filter "label=com.docker.compose.service=${service}"
  )"; then
    jq --null-input --compact-output --arg service "${service}" '{
      service: $service, presentCount: 0, containerId: null, imageId: null,
      expectedImageId: null, imageReferenceMatches: false,
      noPublishedPorts: false,
      effectiveGlobalLiveDisabled: null, effectiveLiveWebhookDisabled: null,
      effectiveWorkerRuntimeMode: null,
      status: "UNKNOWN", health: "UNKNOWN", projectLabelMatches: false,
      serviceLabelMatches: false, revisionLabel: null
    }'
    return 0
  fi
  ids=()
  if [[ -n "${ids_output}" ]]; then
    mapfile -t ids <<<"${ids_output}"
  fi
  present_count="${#ids[@]}"
  if (( present_count == 0 )); then
    jq --null-input --compact-output --arg service "${service}" '{
      service: $service, presentCount: 0, containerId: null, imageId: null,
      expectedImageId: null, imageReferenceMatches: false,
      noPublishedPorts: false,
      effectiveGlobalLiveDisabled: null, effectiveLiveWebhookDisabled: null,
      effectiveWorkerRuntimeMode: null,
      status: "MISSING", health: "MISSING", projectLabelMatches: false,
      serviceLabelMatches: false, revisionLabel: null
    }'
    return 0
  fi
  if (( present_count != 1 )) || [[ ! "${ids[0]}" =~ ^[0-9a-f]{64}$ ]]; then
    jq --null-input --compact-output \
      --arg service "${service}" --argjson count "${present_count}" '{
        service: $service, presentCount: $count, containerId: null, imageId: null,
        expectedImageId: null, imageReferenceMatches: false,
        noPublishedPorts: false,
        effectiveGlobalLiveDisabled: null, effectiveLiveWebhookDisabled: null,
        effectiveWorkerRuntimeMode: null,
        status: "UNKNOWN", health: "UNKNOWN", projectLabelMatches: false,
        serviceLabelMatches: false, revisionLabel: null
      }'
    return 0
  fi
  id="${ids[0]}"
  if ! inspect_line="$(bounded_capture 2048 timeout 15 docker inspect --format \
    '{{.Id}}|{{.Image}}|{{eq .Config.Image "'"${expected_reference}"'"}}|{{eq (len .HostConfig.PortBindings) 0}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{eq (index .Config.Labels "com.docker.compose.project") "refunddesk"}}|{{eq (index .Config.Labels "com.docker.compose.service") "'"${service}"'"}}|{{index .Config.Labels "com.refunddesk.revision"}}|{{range .Config.Env}}{{if eq . "REFUNDDESK_GLOBAL_LIVE_ENABLED=false"}}global-disabled{{else if eq (index (split . "=") 0) "REFUNDDESK_GLOBAL_LIVE_ENABLED"}}global-other{{end}}{{end}}|{{range .Config.Env}}{{if eq . "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled"}}webhook-disabled{{else if eq (index (split . "=") 0) "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET"}}webhook-other{{end}}{{end}}|{{range .Config.Env}}{{if eq . "REFUNDDESK_WORKER_RUNTIME_MODE=normal"}}worker-normal{{else if eq . "REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission"}}worker-incident{{else if eq (index (split . "=") 0) "REFUNDDESK_WORKER_RUNTIME_MODE"}}worker-other{{end}}{{end}}' \
    "${id}")"; then
    jq --null-input --compact-output \
      --arg service "${service}" --argjson count "${present_count}" '{
        service: $service, presentCount: $count, containerId: null, imageId: null,
        expectedImageId: null, imageReferenceMatches: false,
        noPublishedPorts: false,
        effectiveGlobalLiveDisabled: null, effectiveLiveWebhookDisabled: null,
        effectiveWorkerRuntimeMode: null,
        status: "UNKNOWN", health: "UNKNOWN", projectLabelMatches: false,
        serviceLabelMatches: false, revisionLabel: null
      }'
    return 0
  fi
  local ports_empty global_token webhook_token worker_mode_token
  local global_disabled_json=null webhook_disabled_json=null worker_mode_json=""
  IFS='|' read -r actual_id image_id reference_match ports_empty state health project_match service_match revision_label global_token webhook_token worker_mode_token \
    <<<"${inspect_line}"
  [[ "${actual_id}" =~ ^[0-9a-f]{64}$ ]] || actual_id=""
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || image_id=""
  case "${state}" in
    created|running|restarting|removing|paused|exited|dead) state="${state^^}" ;;
    *) state=UNKNOWN ;;
  esac
  case "${health}" in
    none|starting|healthy|unhealthy) health="${health^^}" ;;
    *) health=UNKNOWN ;;
  esac
  [[ "${project_match}" == "true" ]] || project_match=false
  [[ "${service_match}" == "true" ]] || service_match=false
  [[ "${reference_match}" == "true" ]] || reference_match=false
  [[ "${ports_empty}" == "true" ]] || ports_empty=false
  [[ "${revision_label}" =~ ^[0-9a-f]{40}$ ]] || revision_label=""
  if [[ "${service}" == "web" || "${service}" == "worker" ]]; then
    if [[ "${global_token}" == "global-disabled" ]]; then
      global_disabled_json=true
    else
      global_disabled_json=false
    fi
  fi
  if [[ "${service}" == "web" ]]; then
    if [[ "${webhook_token}" == "webhook-disabled" ]]; then
      webhook_disabled_json=true
    else
      webhook_disabled_json=false
    fi
  fi
  if [[ "${service}" == "worker" ]]; then
    case "${worker_mode_token}" in
      "") worker_mode_json=LEGACY_NORMAL ;;
      worker-normal) worker_mode_json=NORMAL ;;
      worker-incident) worker_mode_json=INCIDENT_ADMISSION ;;
      *) worker_mode_json=INVALID ;;
    esac
  fi
  jq --null-input --compact-output \
    --arg service "${service}" \
    --argjson count "${present_count}" \
    --arg id "${actual_id}" \
    --arg image "${image_id}" \
    --arg expected_image "${expected_image}" \
    --argjson reference_match "${reference_match}" \
    --argjson ports_empty "${ports_empty}" \
    --argjson global_disabled "${global_disabled_json}" \
    --argjson webhook_disabled "${webhook_disabled_json}" \
    --arg worker_mode "${worker_mode_json}" \
    --arg status "${state}" \
    --arg health "${health}" \
    --argjson project "${project_match}" \
    --argjson service_match "${service_match}" \
    --arg revision "${revision_label}" '{
      service: $service,
      presentCount: $count,
      containerId: (if $id == "" then null else $id end),
      imageId: (if $image == "" then null else $image end),
      expectedImageId: (if $expected_image == "" then null else $expected_image end),
      imageReferenceMatches: $reference_match,
      noPublishedPorts: $ports_empty,
      effectiveGlobalLiveDisabled: $global_disabled,
      effectiveLiveWebhookDisabled: $webhook_disabled,
      effectiveWorkerRuntimeMode: (if $worker_mode == "" then null else $worker_mode end),
      status: $status,
      health: $health,
      projectLabelMatches: $project,
      serviceLabelMatches: $service_match,
      revisionLabel: (if $revision == "" then null else $revision end)
    }'
}

expected_image_id() {
  local reference="$1" image_id
  image_id="$(bounded_capture 256 timeout 15 docker image inspect --format '{{.Id}}' -- "${reference}")" ||
    return 1
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${image_id}"
}

systemd_observation() {
  local systemd_ok=true value release_output release_count=0 fence_count=0
  local backup_timer=false retention_timer=false backup_service=false
  local retention_service=false quiesce_service=false line unit

  for unit in \
    refunddesk-backup.timer \
    refunddesk-retention.timer \
    refunddesk-backup.service \
    refunddesk-retention.service \
    refunddesk-quiesce-recovery.service; do
    value="$(bounded_capture 128 timeout 10 systemctl show "${unit}" --property=ActiveState --value)" || {
      systemd_ok=false
      value=unknown
    }
    case "${value}" in
      active|activating|reloading|deactivating)
        case "${unit}" in
          refunddesk-backup.timer) backup_timer=true ;;
          refunddesk-retention.timer) retention_timer=true ;;
          refunddesk-backup.service) backup_service=true ;;
          refunddesk-retention.service) retention_service=true ;;
          refunddesk-quiesce-recovery.service) quiesce_service=true ;;
        esac
        ;;
      inactive|failed) ;;
      *) systemd_ok=false ;;
    esac
  done

  release_output="$(bounded_capture 65536 timeout 10 systemctl list-units --type=service \
    --state=activating,active,reloading,deactivating \
    --plain --no-legend 'refunddesk-release-*.service')" || {
    systemd_ok=false
    release_output=""
  }
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    unit="${line%% *}"
    if [[ "${unit}" =~ ^refunddesk-release-fence-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]]; then
      fence_count=$((fence_count + 1))
    elif [[ "${unit}" =~ ^refunddesk-release-[0-9a-f]{12}-[1-9][0-9]*\.service$ ]]; then
      release_count=$((release_count + 1))
    else
      systemd_ok=false
    fi
  done <<<"${release_output}"

  jq --null-input --compact-output \
    --argjson available "${systemd_ok}" \
    --argjson backup_timer "${backup_timer}" \
    --argjson retention_timer "${retention_timer}" \
    --argjson backup_service "${backup_service}" \
    --argjson retention_service "${retention_service}" \
    --argjson quiesce_service "${quiesce_service}" \
    --argjson release_count "${release_count}" \
    --argjson fence_count "${fence_count}" '{
      available: $available,
      backupTimerActive: $backup_timer,
      retentionTimerActive: $retention_timer,
      backupServiceActive: $backup_service,
      retentionServiceActive: $retention_service,
      quiesceRecoveryActive: $quiesce_service,
      activeReleaseUnitCount: $release_count,
      activeFenceUnitCount: $fence_count
    }'
}

listener_observation() {
  local available=true tcp80=false tcp443=false udp80=false udp443=false output
  local protocol port
  for protocol in tcp udp; do
    for port in 80 443; do
      if [[ "${protocol}" == "tcp" ]]; then
        output="$(bounded_capture 65536 timeout 10 ss -H -ltn "( sport = :${port} )")" || {
          available=false
          output=""
        }
      else
        output="$(bounded_capture 65536 timeout 10 ss -H -lun "( sport = :${port} )")" || {
          available=false
          output=""
        }
      fi
      if [[ -n "${output}" ]]; then
        if [[ "${protocol}:${port}" == "tcp:80" ]]; then tcp80=true; fi
        if [[ "${protocol}:${port}" == "tcp:443" ]]; then tcp443=true; fi
        if [[ "${protocol}:${port}" == "udp:80" ]]; then udp80=true; fi
        if [[ "${protocol}:${port}" == "udp:443" ]]; then udp443=true; fi
      fi
    done
  done
  jq --null-input --compact-output \
    --argjson available "${available}" \
    --argjson tcp80 "${tcp80}" --argjson tcp443 "${tcp443}" \
    --argjson udp80 "${udp80}" --argjson udp443 "${udp443}" '{
      available: $available,
      tcp80Listening: $tcp80,
      tcp443Listening: $tcp443,
      udp80Listening: $udp80,
      udp443Listening: $udp443
    }'
}

database_observation() {
  local postgres_id="$1" postgres_status="$2" postgres_health="$3" output compact
  local system_identifier active_workflows unreleased_guards active_jobs
  local live_tenants live_installations prepared requests executions attempts receipts mutations audits
  if [[ ! "${postgres_id}" =~ ^[0-9a-f]{64}$ ||
    "${postgres_status}" != "RUNNING" || "${postgres_health}" != "HEALTHY" ]]; then
    jq --null-input --compact-output '{
      snapshotAvailable: false, systemIdentifier: null, activeWorkflows: null,
      unreleasedPaymentGuards: null, activeFinancialJobs: null, liveTenants: null,
      liveInstallations: null, preparedTransactions: null, refundRequests: null,
      refundExecutions: null, refundExecutionAttempts: null,
      webhookReceipts: null, apiMutationReceipts: null,
      auditEvents: null
    }'
    return 0
  fi
  output="$(bounded_capture 4096 timeout 25 docker exec \
    --env PSQL_HISTORY=/dev/null \
    "${postgres_id}" \
    psql \
      --host=/var/run/postgresql \
      --username=refunddesk_owner \
      --dbname=refunddesk \
      --no-password \
      --no-psqlrc \
      --set=ON_ERROR_STOP=1 \
      --quiet \
      --tuples-only \
      --no-align \
      --command="
        BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET LOCAL statement_timeout = '15s';
        SET LOCAL lock_timeout = '5s';
        SET LOCAL transaction_read_only = on;
        SELECT concat_ws('|',
          (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
          (SELECT count(*) FROM public.refund_requests WHERE workflow_status IN
            ('pending_approval','approved','executing','reconciliation_required')),
          (SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL),
          (SELECT count(*) FROM pgboss.job WHERE name = 'refunddesk_refund_execute'
            AND state::text IN ('created','retry','active')),
          (SELECT count(*) FROM public.tenants WHERE live_enabled),
          (SELECT count(*) FROM public.stripe_installations WHERE environment = 'live'),
          (SELECT count(*) FROM pg_catalog.pg_prepared_xacts),
          (SELECT count(*) FROM public.refund_requests),
          (SELECT count(*) FROM public.refund_executions),
          (SELECT count(*) FROM public.refund_execution_attempts),
          (SELECT count(*) FROM public.webhook_receipts),
          (SELECT count(*) FROM public.api_mutation_receipts),
          (SELECT count(*) FROM public.audit_events));
        ROLLBACK;
      ")" || output=""
  compact="$(printf '%s' "${output}" | tr -d '[:space:]')"
  if [[ ! "${compact}" =~ ^([1-9][0-9]{17,19})(\|[0-9]+){12}$ ]]; then
    jq --null-input --compact-output '{
      snapshotAvailable: false, systemIdentifier: null, activeWorkflows: null,
      unreleasedPaymentGuards: null, activeFinancialJobs: null, liveTenants: null,
      liveInstallations: null, preparedTransactions: null, refundRequests: null,
      refundExecutions: null, refundExecutionAttempts: null,
      webhookReceipts: null, apiMutationReceipts: null,
      auditEvents: null
    }'
    return 0
  fi
  IFS='|' read -r system_identifier active_workflows unreleased_guards active_jobs \
    live_tenants live_installations prepared requests executions attempts receipts mutations audits <<<"${compact}"
  jq --null-input --compact-output \
    --arg system_identifier "${system_identifier}" \
    --argjson active_workflows "${active_workflows}" \
    --argjson unreleased_guards "${unreleased_guards}" \
    --argjson active_jobs "${active_jobs}" \
    --argjson live_tenants "${live_tenants}" \
    --argjson live_installations "${live_installations}" \
    --argjson prepared "${prepared}" \
    --argjson requests "${requests}" \
    --argjson executions "${executions}" \
    --argjson attempts "${attempts}" \
    --argjson receipts "${receipts}" \
    --argjson mutations "${mutations}" \
    --argjson audits "${audits}" '{
      snapshotAvailable: true,
      systemIdentifier: $system_identifier,
      activeWorkflows: $active_workflows,
      unreleasedPaymentGuards: $unreleased_guards,
      activeFinancialJobs: $active_jobs,
      liveTenants: $live_tenants,
      liveInstallations: $live_installations,
      preparedTransactions: $prepared,
      refundRequests: $requests,
      refundExecutions: $executions,
      refundExecutionAttempts: $attempts,
      webhookReceipts: $receipts,
      apiMutationReceipts: $mutations,
      auditEvents: $audits
    }'
}

capture_host() {
  local captured_at active_revision="" current_revision="" source_revision=""
  local release_identity="" release_revision="" release_worker_mode=""
  local manifest_revision="" compose_sha="" manifest_sha=""
  local manifest_valid=false expected_images_available=false
  local expected_postgres_image="" expected_caddy_image=""
  local expected_web_image="" expected_worker_image=""
  local current_path source_root compose_file installed_manifest
  local platform_state worker_state webhook_state live_available=true runtime_live_available=false
  local platform_disabled=false worker_disabled=false webhook_disabled=false
  local sensitive_safe=false commit_marker_valid=false managed_completion
  local release_runtime_marker_count=0 runtime_marker
  local docker_available=true all_running_output="" unexpected_running_json=null
  local containers_json postgres_id postgres_status postgres_health
  local allowed_postgres allowed_verifier allowed_web running_id allowed
  local systemd_json listener_json database_json
  local transition_present=false quiesce_present=false backup_present=false
  local legacy_present=false managed_inflight=false
  local -a containers running_ids

  captured_at="$(timestamp_now)"
  active_revision="$(read_revision_file "${ROOT}/ACTIVE_REVISION" 644)" || active_revision=""
  current_path="$(readlink --canonicalize-existing -- "${ROOT}/current")" || current_path=""
  if [[ -n "${current_path}" && "${current_path}" == "${ROOT}/releases/"*/source ]]; then
    current_revision="${current_path#"${ROOT}/releases/"}"
    current_revision="${current_revision%/source}"
    [[ "${current_revision}" =~ ^[0-9a-f]{40}$ ]] || current_revision=""
  fi
  if [[ -n "${active_revision}" ]]; then
    source_root="${ROOT}/releases/${active_revision}/source"
    compose_file="${source_root}/deploy/lightsail/compose.yml"
    installed_manifest="${ROOT}/releases/${active_revision}/manifest.json"
    source_revision="$(read_revision_file "${source_root}/.refunddesk-revision" 600)" || source_revision=""
    if file_has_public_metadata "${compose_file}"; then
      compose_sha="$(sha256sum -- "${compose_file}" | cut -d ' ' -f 1)" || compose_sha=""
      [[ "${compose_sha}" =~ ^[0-9a-f]{64}$ ]] || compose_sha=""
    fi
    if manifest_is_valid "${installed_manifest}" "${active_revision}"; then
      manifest_valid=true
      manifest_revision="$(jq --raw-output '.revision' "${installed_manifest}")"
      manifest_sha="$(sha256sum -- "${installed_manifest}" | cut -d ' ' -f 1)" || manifest_sha=""
      expected_web_image="$(jq --raw-output '.images[] | select(.role == "web") | .imageId' "${installed_manifest}")"
      expected_worker_image="$(jq --raw-output '.images[] | select(.role == "worker") | .imageId' "${installed_manifest}")"
    fi
  fi
  release_identity="$(release_environment_identity)" || release_identity=""
  if [[ -n "${release_identity}" ]]; then
    release_revision="${release_identity%%|*}"
    release_worker_mode="${release_identity#*|}"
  fi

  expected_postgres_image="$(expected_image_id "${POSTGRES_IMAGE_REFERENCE}")" ||
    expected_postgres_image=""
  expected_caddy_image="$(expected_image_id "${CADDY_IMAGE_REFERENCE}")" ||
    expected_caddy_image=""
  if "${manifest_valid}" && [[ -n "${expected_postgres_image}" &&
    -n "${expected_caddy_image}" && -n "${expected_web_image}" &&
    -n "${expected_worker_image}" ]]; then
    expected_images_available=true
  fi

  containers=()
  containers+=("$(container_observation postgres "${active_revision}" "${expected_postgres_image}" "${POSTGRES_IMAGE_REFERENCE}")")
  containers+=("$(container_observation verifier "${active_revision}" "${expected_caddy_image}" "${CADDY_IMAGE_REFERENCE}")")
  containers+=("$(container_observation worker "${active_revision}" "${expected_worker_image}" "refunddesk-worker:sandbox-${active_revision}")")
  containers+=("$(container_observation web "${active_revision}" "${expected_web_image}" "refunddesk-web:sandbox-${active_revision}")")
  containers+=("$(container_observation caddy "${active_revision}" "${expected_caddy_image}" "${CADDY_IMAGE_REFERENCE}")")
  containers_json="$(printf '%s\n' "${containers[@]}" | jq --slurp --compact-output '.')"
  if jq --exit-status '
    (.[] | select(.service == "web")
      | .effectiveGlobalLiveDisabled != null and .effectiveLiveWebhookDisabled != null)
    and (.[] | select(.service == "worker")
      | .effectiveGlobalLiveDisabled != null)
  ' <<<"${containers_json}" >/dev/null; then
    runtime_live_available=true
  fi
  if jq --exit-status 'any(.[]; .status == "UNKNOWN") | not' <<<"${containers_json}" >/dev/null; then
    docker_available=true
  else
    docker_available=false
  fi

  if "${docker_available}"; then
    all_running_output="$(bounded_capture 65536 timeout 15 docker container ls --no-trunc --quiet)" || {
      docker_available=false
      all_running_output=""
    }
  fi
  if "${docker_available}"; then
    allowed_postgres="$(jq --raw-output '.[] | select(.service == "postgres") | .containerId // ""' <<<"${containers_json}")"
    allowed_verifier="$(jq --raw-output '.[] | select(.service == "verifier") | .containerId // ""' <<<"${containers_json}")"
    allowed_web="$(jq --raw-output '.[] | select(.service == "web") | .containerId // ""' <<<"${containers_json}")"
    running_ids=()
    if [[ -n "${all_running_output}" ]]; then mapfile -t running_ids <<<"${all_running_output}"; fi
    local unexpected=0
    for running_id in "${running_ids[@]}"; do
      [[ "${running_id}" =~ ^[0-9a-f]{64}$ ]] || {
        docker_available=false
        break
      }
      allowed=false
      for allowed in "${allowed_postgres}" "${allowed_verifier}" "${allowed_web}"; do
        [[ -n "${allowed}" && "${running_id}" == "${allowed}" ]] && {
          allowed=true
          break
        }
      done
      [[ "${allowed}" == "true" ]] || unexpected=$((unexpected + 1))
    done
    if "${docker_available}"; then unexpected_running_json="${unexpected}"; fi
  fi

  platform_state="$(binding_state "${PLATFORM_ENV}" REFUNDDESK_GLOBAL_LIVE_ENABLED false true)"
  worker_state="$(binding_state "${WORKER_ENV}" REFUNDDESK_GLOBAL_LIVE_ENABLED false true)"
  webhook_state="$(binding_state "${PLATFORM_ENV}" STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET disabled enabled)"
  [[ "${platform_state}" == "DISABLED" ]] && platform_disabled=true
  [[ "${worker_state}" == "DISABLED" ]] && worker_disabled=true
  [[ "${webhook_state}" == "DISABLED" ]] && webhook_disabled=true
  if [[ "${platform_state}" == "UNAVAILABLE" || "${worker_state}" == "UNAVAILABLE" ||
    "${webhook_state}" == "UNAVAILABLE" ]]; then live_available=false; fi

  sensitive_modes_are_safe && sensitive_safe=true
  if [[ -n "${active_revision}" ]] &&
    transition_commit_marker_is_valid "${TRANSITION_COMMIT_MARKER}" "${active_revision}"; then
    commit_marker_valid=true
  fi
  managed_completion="$(managed_completion_state)"
  shopt -s nullglob
  for runtime_marker in \
    "${RUNTIME_ROOT}"/refunddesk-release-fence-*.ready \
    "${RUNTIME_ROOT}"/refunddesk-release-candidate-*.admit; do
    [[ -e "${runtime_marker}" || -L "${runtime_marker}" ]] || continue
    release_runtime_marker_count=$((release_runtime_marker_count + 1))
  done
  shopt -u nullglob
  [[ -e "${TRANSITION_JOURNAL}" || -L "${TRANSITION_JOURNAL}" ]] && transition_present=true
  [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]] && quiesce_present=true
  [[ -e "${BACKUP_JOURNAL}" || -L "${BACKUP_JOURNAL}" ]] && backup_present=true
  [[ -e "${LEGACY_APP_ID_JOURNAL}" || -L "${LEGACY_APP_ID_JOURNAL}" ]] && legacy_present=true
  [[ -e "${MANAGED_TRANSITION_MARKER}" || -L "${MANAGED_TRANSITION_MARKER}" ]] && managed_inflight=true

  systemd_json="$(systemd_observation)"
  listener_json="$(listener_observation)"
  postgres_id="$(jq --raw-output '.[] | select(.service == "postgres") | .containerId // ""' <<<"${containers_json}")"
  postgres_status="$(jq --raw-output '.[] | select(.service == "postgres") | .status' <<<"${containers_json}")"
  postgres_health="$(jq --raw-output '.[] | select(.service == "postgres") | .health' <<<"${containers_json}")"
  database_json="$(database_observation "${postgres_id}" "${postgres_status}" "${postgres_health}")"

  jq --null-input --compact-output \
    --arg captured_at "${captured_at}" \
    --arg active "${active_revision}" --arg current "${current_revision}" \
    --arg source "${source_revision}" --arg release "${release_revision}" \
    --arg release_worker_mode "${release_worker_mode}" \
    --arg manifest_revision "${manifest_revision}" --arg compose_sha "${compose_sha}" \
    --arg manifest_sha "${manifest_sha}" --argjson manifest_valid "${manifest_valid}" \
    --argjson containers "${containers_json}" \
    --argjson docker_available "${docker_available}" \
    --argjson expected_images_available "${expected_images_available}" \
    --argjson unexpected "${unexpected_running_json}" \
    --argjson platform_disabled "${platform_disabled}" \
    --argjson worker_disabled "${worker_disabled}" \
    --argjson webhook_disabled "${webhook_disabled}" \
    --argjson live_available "${live_available}" \
    --argjson runtime_live_available "${runtime_live_available}" \
    --argjson sensitive_safe "${sensitive_safe}" \
    --argjson commit_valid "${commit_marker_valid}" \
    --arg managed_completion "${managed_completion}" \
    --argjson transition_present "${transition_present}" \
    --argjson quiesce_present "${quiesce_present}" \
    --argjson backup_present "${backup_present}" \
    --argjson legacy_present "${legacy_present}" \
    --argjson managed_inflight "${managed_inflight}" \
    --argjson runtime_marker_count "${release_runtime_marker_count}" \
    --argjson systemd "${systemd_json}" --argjson listeners "${listener_json}" \
    --argjson database "${database_json}" '
      def nullable($value): if $value == "" then null else $value end;
      {
        capturedAt: $captured_at,
        identity: {
          activeRevision: nullable($active),
          currentRevision: nullable($current),
          sourceRevision: nullable($source),
          releaseEnvironmentRevision: nullable($release),
          releaseEnvironmentWorkerRuntimeMode: nullable($release_worker_mode),
          manifestRevision: nullable($manifest_revision),
          composeSha256: nullable($compose_sha),
          installedManifestSha256: nullable($manifest_sha),
          manifestSchemaValid: $manifest_valid
        },
        containers: $containers,
        control: {
          operatorLockShared: true,
          transitionJournalPresent: $transition_present,
          transitionCommitMarkerValid: $commit_valid,
          runtimeQuiesceJournalPresent: $quiesce_present,
          backupJournalPresent: $backup_present,
          legacyAppIdJournalPresent: $legacy_present,
          managedTransitionInFlightPresent: $managed_inflight,
          managedTransitionCompletion: $managed_completion,
          activeReleaseUnitCount: (if $systemd.available then $systemd.activeReleaseUnitCount else null end),
          activeFenceUnitCount: (if $systemd.available then $systemd.activeFenceUnitCount else null end),
          releaseRuntimeMarkerCount: $runtime_marker_count,
          dockerInventoryAvailable: $docker_available,
          expectedImagesAvailable: $expected_images_available,
          sensitiveModesSafe: $sensitive_safe
        },
        surface: {
          platformLiveDisabled: $platform_disabled,
          workerLiveDisabled: $worker_disabled,
          liveWebhookDisabled: $webhook_disabled,
          backupTimerActive: $systemd.backupTimerActive,
          retentionTimerActive: $systemd.retentionTimerActive,
          backupServiceActive: $systemd.backupServiceActive,
          retentionServiceActive: $systemd.retentionServiceActive,
          quiesceRecoveryActive: $systemd.quiesceRecoveryActive,
          tcp80Listening: $listeners.tcp80Listening,
          tcp443Listening: $listeners.tcp443Listening,
          udp80Listening: $listeners.udp80Listening,
          udp443Listening: $listeners.udp443Listening,
          systemdInventoryAvailable: $systemd.available,
          listenerInventoryAvailable: $listeners.available,
          liveInterlocksAvailable: $live_available,
          runtimeLiveInterlocksAvailable: $runtime_live_available,
          unexpectedRunningContainerCount: $unexpected
        },
        database: $database
      }
    '
}

empty_capture() {
  local captured_at
  captured_at="$(timestamp_now)"
  jq --null-input --compact-output --arg captured_at "${captured_at}" '{
    capturedAt: $captured_at,
    identity: {
      activeRevision: null, currentRevision: null, sourceRevision: null,
      releaseEnvironmentRevision: null, releaseEnvironmentWorkerRuntimeMode: null,
      manifestRevision: null, composeSha256: null,
      installedManifestSha256: null, manifestSchemaValid: false
    },
    containers: ["postgres","verifier","worker","web","caddy"] | map({
      service: ., presentCount: 0, containerId: null, imageId: null,
      expectedImageId: null, imageReferenceMatches: false,
      noPublishedPorts: false,
      effectiveGlobalLiveDisabled: null, effectiveLiveWebhookDisabled: null,
      effectiveWorkerRuntimeMode: null,
      status: "UNKNOWN", health: "UNKNOWN", projectLabelMatches: false,
      serviceLabelMatches: false, revisionLabel: null
    }),
    control: {
      operatorLockShared: false, transitionJournalPresent: false,
      transitionCommitMarkerValid: false, runtimeQuiesceJournalPresent: false,
      backupJournalPresent: false, legacyAppIdJournalPresent: false,
      managedTransitionInFlightPresent: false, managedTransitionCompletion: "ABSENT",
      activeReleaseUnitCount: null, activeFenceUnitCount: null,
      releaseRuntimeMarkerCount: null,
      dockerInventoryAvailable: false, expectedImagesAvailable: false,
      sensitiveModesSafe: false
    },
    surface: {
      platformLiveDisabled: false, workerLiveDisabled: false, liveWebhookDisabled: false,
      backupTimerActive: false, retentionTimerActive: false, backupServiceActive: false,
      retentionServiceActive: false, quiesceRecoveryActive: false,
      tcp80Listening: false, tcp443Listening: false, udp80Listening: false,
      udp443Listening: false, systemdInventoryAvailable: false,
      listenerInventoryAvailable: false, liveInterlocksAvailable: false,
      runtimeLiveInterlocksAvailable: false,
      unexpectedRunningContainerCount: null
    },
    database: {
      snapshotAvailable: false, systemIdentifier: null, activeWorkflows: null,
      unreleasedPaymentGuards: null, activeFinancialJobs: null, liveTenants: null,
      liveInstallations: null, preparedTransactions: null, refundRequests: null,
      refundExecutions: null, refundExecutionAttempts: null,
      webhookReceipts: null, apiMutationReceipts: null,
      auditEvents: null
    }
  }'
}

emit_document() {
  local started_at="$1" capture_a="$2" capture_b="$3" forced_code="${4:-}"
  local completed_at document exit_code
  completed_at="$(timestamp_now)"
  document="$(jq --null-input --compact-output \
    --arg nonce "${NONCE}" --arg started_at "${started_at}" --arg completed_at "${completed_at}" \
    --arg forced_code "${forced_code}" --argjson a "${capture_a}" --argjson b "${capture_b}" '
      def container($capture; $service):
        $capture.containers[] | select(.service == $service);
      def same_capture:
        ($a | del(.capturedAt)) == ($b | del(.capturedAt));
      def metadata_complete($capture):
        ($capture.identity.activeRevision != null)
        and ($capture.identity.currentRevision != null)
        and ($capture.identity.sourceRevision != null)
        and ($capture.identity.releaseEnvironmentRevision != null)
        and ($capture.identity.releaseEnvironmentWorkerRuntimeMode != null)
        and ($capture.identity.manifestRevision != null)
        and ($capture.identity.composeSha256 != null)
        and ($capture.identity.installedManifestSha256 != null)
        and $capture.identity.manifestSchemaValid;
      def metadata_coherent($capture):
        metadata_complete($capture)
        and ([
          $capture.identity.currentRevision,
          $capture.identity.sourceRevision,
          $capture.identity.releaseEnvironmentRevision,
          $capture.identity.manifestRevision
        ] | all(. == $capture.identity.activeRevision));
      def containers_coherent($capture):
        $capture.control.dockerInventoryAvailable
        and (all($capture.containers[];
          .presentCount == 1
          and .containerId != null
          and .imageId != null
          and .projectLabelMatches
          and .serviceLabelMatches))
        and (all($capture.containers[] | select(.service != "postgres");
          .revisionLabel == $capture.identity.activeRevision))
        and $capture.control.expectedImagesAvailable
        and (all($capture.containers[];
          .expectedImageId != null
          and .imageId == .expectedImageId
          and .imageReferenceMatches))
        and (all($capture.containers[] | select(.service != "caddy");
          .noPublishedPorts))
        and (container($capture; "worker").effectiveWorkerRuntimeMode
          == $capture.identity.releaseEnvironmentWorkerRuntimeMode);
      def stopped($capture; $service):
        (container($capture; $service).status
          | . == "CREATED" or . == "EXITED");
      def healthy($capture; $service):
        container($capture; $service).status == "RUNNING"
        and container($capture; $service).health == "HEALTHY";
      def recoverable_runtime_stopped($capture):
        healthy($capture; "postgres")
        and stopped($capture; "verifier")
        and stopped($capture; "web");
      def journals_closed($capture):
        ($capture.control.transitionJournalPresent | not)
        and ($capture.control.runtimeQuiesceJournalPresent | not)
        and ($capture.control.backupJournalPresent | not)
        and ($capture.control.legacyAppIdJournalPresent | not)
        and ($capture.control.managedTransitionInFlightPresent | not);
      def fence_closed($capture):
        $capture.surface.systemdInventoryAvailable
        and $capture.control.activeReleaseUnitCount == 0
        and $capture.control.activeFenceUnitCount == 0
        and $capture.control.releaseRuntimeMarkerCount == 0;
      def live_disabled($capture):
        $capture.surface.liveInterlocksAvailable
        and $capture.surface.runtimeLiveInterlocksAvailable
        and $capture.surface.platformLiveDisabled
        and $capture.surface.workerLiveDisabled
        and $capture.surface.liveWebhookDisabled
        and (container($capture; "web").effectiveGlobalLiveDisabled == true)
        and (container($capture; "worker").effectiveGlobalLiveDisabled == true)
        and (container($capture; "web").effectiveLiveWebhookDisabled == true);
      def maintenance_stopped($capture):
        $capture.surface.systemdInventoryAvailable
        and ($capture.surface.backupTimerActive | not)
        and ($capture.surface.retentionTimerActive | not)
        and ($capture.surface.backupServiceActive | not)
        and ($capture.surface.retentionServiceActive | not)
        and ($capture.surface.quiesceRecoveryActive | not);
      def listeners_closed($capture):
        $capture.surface.listenerInventoryAvailable
        and ($capture.surface.tcp80Listening | not)
        and ($capture.surface.tcp443Listening | not)
        and ($capture.surface.udp80Listening | not)
        and ($capture.surface.udp443Listening | not);
      def financial_quiescent($capture):
        $capture.database.snapshotAvailable
        and $capture.database.activeWorkflows == 0
        and $capture.database.unreleasedPaymentGuards == 0
        and $capture.database.activeFinancialJobs == 0
        and $capture.database.liveTenants == 0
        and $capture.database.liveInstallations == 0
        and $capture.database.preparedTransactions == 0;
      def database_stable:
        $a.database == $b.database;
      def add($array; $condition; $code):
        if $condition then $array + [$code] else $array end;
      def diagnostics:
        []
        | add(.; ($forced_code == "TOOL_UNAVAILABLE"); "TOOL_UNAVAILABLE")
        | add(.; ($forced_code == "OPERATOR_LOCK_UNAVAILABLE"); "OPERATOR_LOCK_UNAVAILABLE")
        | add(.; ($forced_code == "" and $b.identity.activeRevision == null); "ACTIVE_REVISION_UNREADABLE")
        | add(.; ($forced_code == "" and $b.identity.currentRevision == null); "CURRENT_SOURCE_UNREADABLE")
        | add(.; ($forced_code == "" and $b.identity.sourceRevision == null); "SOURCE_MARKER_UNREADABLE")
        | add(.; ($forced_code == "" and $b.identity.releaseEnvironmentRevision == null); "RELEASE_ENV_UNREADABLE")
        | add(.; ($forced_code == "" and $b.identity.composeSha256 == null); "COMPOSE_SOURCE_UNREADABLE")
        | add(.; ($forced_code == "" and ($b.identity.manifestSchemaValid | not)); "MANIFEST_UNREADABLE")
        | add(.; ($forced_code == "" and ($b.control.dockerInventoryAvailable | not)); "CONTAINER_INVENTORY_UNREADABLE")
        | add(.; ($forced_code == "" and ($b.control.expectedImagesAvailable | not)); "EXPECTED_IMAGE_UNREADABLE")
        | add(.; ($forced_code == "" and ($b.surface.systemdInventoryAvailable | not)); "SYSTEMD_INVENTORY_UNREADABLE")
        | add(.; ($forced_code == "" and ($b.surface.listenerInventoryAvailable | not)); "LISTENER_INVENTORY_UNREADABLE")
        | add(.; ($forced_code == "" and (
          ($b.surface.liveInterlocksAvailable | not)
          or ($b.surface.runtimeLiveInterlocksAvailable | not))); "LIVE_INTERLOCK_UNREADABLE")
        | add(.; ($forced_code == "" and ($b.database.snapshotAvailable | not)); "DATABASE_SNAPSHOT_UNREADABLE")
        | add(.; ($forced_code == "" and metadata_complete($b) and (metadata_coherent($b) | not)); "METADATA_MISMATCH")
        | add(.; ($forced_code == "" and $b.control.dockerInventoryAvailable
          and $b.control.expectedImagesAvailable and metadata_complete($b)
          and (containers_coherent($b) | not)); "CONTAINER_IDENTITY_MISMATCH")
        | add(.; ($forced_code == "" and ($b.surface.unexpectedRunningContainerCount // 0) > 0); "UNEXPECTED_RUNNING_CONTAINER")
        | add(.; ($forced_code == "" and (journals_closed($b) | not)); "UNRESOLVED_JOURNAL")
        | add(.; ($forced_code == "" and (
          ($b.surface.systemdInventoryAvailable and (
            ($b.control.activeReleaseUnitCount > 0)
            or ($b.control.activeFenceUnitCount > 0)))
          or (($b.control.releaseRuntimeMarkerCount // 0) > 0))); "RELEASE_FENCE_ACTIVE")
        | add(.; ($forced_code == "" and ($b.control.sensitiveModesSafe | not)); "SENSITIVE_FILE_MODE_INVALID")
        | add(.; ($forced_code == "" and ($b.control.transitionCommitMarkerValid | not)); "TRANSITION_COMMIT_MARKER_INVALID")
        | add(.; ($forced_code == "" and $b.control.managedTransitionCompletion == "INVALID"); "COMPLETION_MARKER_INVALID")
        | add(.; ($forced_code == "" and $b.surface.liveInterlocksAvailable
          and $b.surface.runtimeLiveInterlocksAvailable
          and (live_disabled($b) | not)); "LIVE_INTERLOCK_ENABLED")
        | add(.; ($forced_code == "" and $b.control.dockerInventoryAvailable
          and ((healthy($b; "postgres") and healthy($b; "verifier") and healthy($b; "web")) | not)
          and (recoverable_runtime_stopped($b) | not)); "CORE_RUNTIME_INVALID")
        | add(.; ($forced_code == "" and (stopped($b; "worker") | not)); "WORKER_RUNNING")
        | add(.; ($forced_code == "" and (stopped($b; "caddy") | not)); "CADDY_RUNNING")
        | add(.; ($forced_code == "" and $b.surface.systemdInventoryAvailable and (maintenance_stopped($b) | not)); "MAINTENANCE_ACTIVE")
        | add(.; ($forced_code == "" and $b.surface.listenerInventoryAvailable and (listeners_closed($b) | not)); "PUBLIC_LISTENER_ACTIVE")
        | add(.; ($forced_code == "" and $b.database.snapshotAvailable and (financial_quiescent($b) | not)); "FINANCIAL_WORK_ACTIVE")
        | add(.; ($forced_code == "" and (same_capture | not)); "CAPTURE_CHANGED")
        | unique;
      def incomplete_code($code):
        $code == "TOOL_UNAVAILABLE"
        or $code == "OPERATOR_LOCK_UNAVAILABLE"
        or $code == "ACTIVE_REVISION_UNREADABLE"
        or $code == "CURRENT_SOURCE_UNREADABLE"
        or $code == "SOURCE_MARKER_UNREADABLE"
        or $code == "RELEASE_ENV_UNREADABLE"
        or $code == "COMPOSE_SOURCE_UNREADABLE"
        or $code == "MANIFEST_UNREADABLE"
        or $code == "CONTAINER_INVENTORY_UNREADABLE"
        or $code == "EXPECTED_IMAGE_UNREADABLE"
        or $code == "SYSTEMD_INVENTORY_UNREADABLE"
        or $code == "LISTENER_INVENTORY_UNREADABLE"
        or $code == "LIVE_INTERLOCK_UNREADABLE"
        or $code == "DATABASE_SNAPSHOT_UNREADABLE";
      (diagnostics) as $diagnostics
      | ($diagnostics | any(incomplete_code(.))) as $incomplete
      | ($diagnostics | map(select(incomplete_code(.) | not)) | length > 0) as $failed
      | (metadata_coherent($b)) as $metadata_coherent
      | (containers_coherent($b)) as $containers_coherent
      | (same_capture) as $captures_stable
      | (healthy($b; "postgres") and healthy($b; "verifier") and healthy($b; "web")) as $core_healthy
      | (recoverable_runtime_stopped($b)) as $recoverable_runtime_stopped
      | (live_disabled($b)) as $live_disabled
      | (stopped($b; "worker")) as $worker_stopped
      | (stopped($b; "caddy")) as $caddy_stopped
      | (maintenance_stopped($b)) as $maintenance_stopped
      | (listeners_closed($b)) as $listeners_closed
      | (journals_closed($b)) as $journals_closed
      | (fence_closed($b)) as $fence_closed
      | (database_stable) as $financial_stable
      | (financial_quiescent($b)) as $financial_quiescent
      | (
          if $failed then "FAIL"
          elif $incomplete then "INCOMPLETE"
          elif $metadata_coherent and $containers_coherent and $captures_stable
            and $live_disabled and $worker_stopped and $caddy_stopped
            and $maintenance_stopped and $listeners_closed and $journals_closed
            and $fence_closed and $b.control.sensitiveModesSafe
            and $b.control.transitionCommitMarkerValid
            and ($core_healthy or $recoverable_runtime_stopped)
            and $financial_stable and $financial_quiescent
            then "PASS"
          else "FAIL"
          end
        ) as $result
      | (
          if $result == "PASS" and $core_healthy then "COHERENT_CONTAINED"
          elif $result == "PASS" then "RECOVERABLE_RUNTIME_STOPPED"
          elif $incomplete and ($failed | not) then "UNKNOWN"
          elif $metadata_coherent and $containers_coherent
            and healthy($b; "postgres") and healthy($b; "verifier")
            and healthy($b; "worker") and healthy($b; "web") and healthy($b; "caddy")
            then "COHERENT_RUNNING"
          else "DIVERGENT"
          end
        ) as $posture
      | (
          if $result == "PASS" and $posture == "COHERENT_CONTAINED" then "PASS_CONTAINED"
          elif $result == "PASS" then "PASS_RECOVERABLE_RUNTIME_STOPPED"
          else $diagnostics[0]
          end
        ) as $code
      | (
          if $result == "PASS" then 0
          elif $result == "FAIL" then 20
          else 21
          end
        ) as $exit_code
      | {
          schemaVersion: 1,
          kind: "refunddesk.lightsail.host-postflight",
          nonce: $nonce,
          startedAt: $started_at,
          completedAt: $completed_at,
          exitCode: $exit_code,
          result: $result,
          code: $code,
          posture: $posture,
          diagnostics: $diagnostics,
          captures: {a: $a, b: $b},
          containment: {
            liveDisabled: $live_disabled,
            workerStopped: $worker_stopped,
            caddyStopped: $caddy_stopped,
            maintenanceStopped: $maintenance_stopped,
            publicListenersClosed: $listeners_closed,
            journalsClosed: $journals_closed,
            fenceClosed: $fence_closed,
            sensitiveModesSafe: $b.control.sensitiveModesSafe
          },
          availability: {
            capturesStable: $captures_stable,
            metadataCoherent: $metadata_coherent,
            containersCoherent: $containers_coherent,
            coreHealthy: $core_healthy,
            recoverableRuntimeStopped: $recoverable_runtime_stopped
          },
          financial: {
            snapshotAvailable: $b.database.snapshotAvailable,
            stable: $financial_stable,
            quiescent: $financial_quiescent
          },
          redaction: {
            rawSecretPresent: false,
            rawApiKeyPresent: false,
            rawSignaturePresent: false,
            rawPayloadPresent: false,
            customerDataPresent: false,
            arbitraryPathPresent: false,
            stderrPresent: false
          }
        }
    ')" || exit "${EXIT_INCOMPLETE}"
  # Reserve one byte for the single LF emitted below; the complete stdout
  # stream, not merely the JSON token, is capped at 256 KiB.
  (( ${#document} > 0 && ${#document} < MAX_OUTPUT_BYTES )) || exit "${EXIT_INCOMPLETE}"
  exit_code="$(jq --raw-output '.exitCode' <<<"${document}")" || exit "${EXIT_INCOMPLETE}"
  printf '%s\n' "${document}"
  exit "${exit_code}"
}

started_at="$(timestamp_now)" || exit "${EXIT_INCOMPLETE}"

for required_command in cmp cut date docker flock grep head id jq readlink sha256sum ss stat systemctl timeout tr; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
    emit_document "${started_at}" "${empty}" "${empty}" TOOL_UNAVAILABLE
  fi
done

if ! file_has_metadata "${OPERATOR_LOCK}" 600; then
  empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
  emit_document "${started_at}" "${empty}" "${empty}" OPERATOR_LOCK_UNAVAILABLE
fi
lock_identity="$(stat --format='%d:%i' -- "${OPERATOR_LOCK}")" || {
  empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
  emit_document "${started_at}" "${empty}" "${empty}" OPERATOR_LOCK_UNAVAILABLE
}
exec 9<"${OPERATOR_LOCK}" || {
  empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
  emit_document "${started_at}" "${empty}" "${empty}" OPERATOR_LOCK_UNAVAILABLE
}
if [[ "$(stat --format='%d:%i' -- "${OPERATOR_LOCK}")" != "${lock_identity}" ]] ||
  [[ "$(stat --dereference --format='%d:%i' -- /proc/self/fd/9)" != "${lock_identity}" ]] ||
  ! flock --shared --timeout 30 9; then
  empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
  emit_document "${started_at}" "${empty}" "${empty}" OPERATOR_LOCK_UNAVAILABLE
fi

capture_a="$(capture_host)" || {
  empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
  emit_document "${started_at}" "${empty}" "${empty}" TOOL_UNAVAILABLE
}
capture_b="$(capture_host)" || {
  empty="$(empty_capture)" || exit "${EXIT_INCOMPLETE}"
  emit_document "${started_at}" "${capture_a}" "${empty}" TOOL_UNAVAILABLE
}
emit_document "${started_at}" "${capture_a}" "${capture_b}"
