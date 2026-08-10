#!/usr/bin/env bash

# Real host-side action adapter for ADR 0036. Sensitive inputs are accepted only
# through root-controlled paths in the environment. Stdout is one canonical,
# redacted JSON document; stderr is always closed.

set -uo pipefail
set +x
set +a
umask 077
export LC_ALL=C
exec 2>/dev/null

readonly MAX_CAPTURE_BYTES=32768
readonly HOST_STATE_NAME="current-stripe-binding-incident-admission-host-state.json"

if (( $# == 6 )) && [[ "$1" == watchdog-fence && "$2" =~ ^[0-9a-f]{40}$ &&
  "$3" =~ ^[0-9a-f]{64}$ && "$4" =~ ^[0-9a-f]{64}$ && "$5" =~ ^[0-9a-f]{64}$ &&
  "$6" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  exec 1>/dev/null 2>/dev/null
  readonly FENCE_REVISION="$2" FENCE_OPERATION="$3" FENCE_WORKER_ID="$4"
  readonly FENCE_HELPER_SHA256="$5" FENCE_DEADLINE="$6"
  readonly FENCE_SOURCE="/opt/refunddesk/releases/${FENCE_REVISION}/source/deploy/lightsail/scripts/incident-admission-host-command.sh"
  readonly FENCE_MARKER="/var/lib/refunddesk/control/incident-admission-watchdog-${FENCE_OPERATION:0:16}.json"
  watchdog_transition() {
    python3 - "${FENCE_MARKER}" "${FENCE_REVISION}" "${FENCE_OPERATION}" "${FENCE_WORKER_ID}" \
      "${FENCE_DEADLINE}" "$1" <<'PY'
import hashlib,json,os,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]); revision,operation,worker,deadline,target=sys.argv[2:]
expected={"armCount","deadline","expectedRevision","kind","operation","state","workerIdSha256"}
try: current=json.loads(path.read_text(encoding="utf-8"))
except Exception: raise SystemExit(1)
if set(current)!=expected or not isinstance(current.get("armCount"),int) or current["armCount"]<1 or current.get("kind")!="refunddesk.incident-admission.watchdog" or current.get("expectedRevision")!=revision or current.get("operation")!=operation or current.get("deadline")!=deadline or current.get("workerIdSha256")!=hashlib.sha256(worker.encode()).hexdigest(): raise SystemExit(1)
allowed={"fencing":{"armed"},"failed":{"armed","fencing"},"fenced":{"fencing"}}
if current.get("state") not in allowed.get(target,set()): raise SystemExit(1)
current["state"]=target; raw=(json.dumps(current,sort_keys=True,separators=(",",":"))+"\n").encode(); temporary=None
try:
    fd,name=tempfile.mkstemp(prefix=path.name+".tmp-",dir=path.parent); temporary=pathlib.Path(name)
    with os.fdopen(fd,"wb") as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path); directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    if temporary is not None:
        try: temporary.unlink()
        except FileNotFoundError: pass
PY
  }
  watchdog_fail() {
    watchdog_transition failed || true
    exit 20
  }
  (( EUID == 0 )) || exit 64
  [[ "$0" == "${FENCE_SOURCE}" && -f "$0" && ! -L "$0" &&
    "$(stat --format='%u:%g:%a' -- "$0")" =~ ^0:0:([0-7]{3,4})$ &&
    "$(sha256sum -- "$0" | cut -d ' ' -f 1)" == "${FENCE_HELPER_SHA256}" ]] || exit 64
  watchdog_transition fencing || exit 20
  fence_ids="$(docker container ls --all --quiet --no-trunc \
    --filter 'label=com.docker.compose.project=refunddesk' \
    --filter 'label=com.docker.compose.service=worker')" || watchdog_fail
  [[ "${fence_ids}" == "${FENCE_WORKER_ID}" ]] || watchdog_fail
  fence_inspection="$(docker inspect "${FENCE_WORKER_ID}")" || watchdog_fail
  python3 - "${FENCE_REVISION}" "${FENCE_WORKER_ID}" 3<<<"${fence_inspection}" <<'PY' || watchdog_fail
import json,os,sys
revision,identifier=sys.argv[1:]; value=json.load(os.fdopen(3))
if not isinstance(value,list) or len(value)!=1: raise SystemExit(1)
c=value[0]; labels=(c.get("Config") or {}).get("Labels") or {}; host=c.get("HostConfig") or {}
ok=c.get("Id")==identifier and labels.get("com.docker.compose.project")=="refunddesk" and labels.get("com.docker.compose.service")=="worker" and labels.get("com.refunddesk.revision")==revision and host.get("RestartPolicy",{}).get("Name")=="no"
raise SystemExit(0 if ok else 1)
PY
  docker update --restart=no "${FENCE_WORKER_ID}" >/dev/null || watchdog_fail
  if [[ "$(docker inspect --format '{{.State.Running}}' "${FENCE_WORKER_ID}")" == true ]]; then
    if ! timeout 55 docker stop --time 45 "${FENCE_WORKER_ID}" >/dev/null; then
      timeout 15 docker kill "${FENCE_WORKER_ID}" >/dev/null || watchdog_fail
    fi
  fi
  docker update --restart=no "${FENCE_WORKER_ID}" >/dev/null || watchdog_fail
  [[ "$(docker inspect --format '{{.Id}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "${FENCE_WORKER_ID}")" == "${FENCE_WORKER_ID}|false|no" ]] || watchdog_fail
  watchdog_transition fenced || watchdog_fail
  exit 0
fi

if (( $# != 6 )) ||
  [[ ! "$1" =~ ^(preflight|prepare-state|start-worker|proof|stop-worker|postflight)$ ||
    ! "$2" =~ ^[0-9a-f]{40}$ || ! "$3" =~ ^[0-9a-f]{64}$ ||
    ! "$4" =~ ^[0-9a-f]{64}$ || ! "$5" =~ ^[0-9a-f]{64}$ || ! "$6" =~ ^[0-9a-f]{64}$ ]]; then
  exit 64
fi
readonly ACTION="$1" EXPECTED_REVISION="$2" OPERATION="$3" IDEMPOTENCY_DIGEST="$4"
readonly DASHBOARD_AUTHORITY="$5" FIXTURE_SHA256="$6"

readonly DASHBOARD_PATH="${REFUNDDESK_INCIDENT_DASHBOARD_PATH:-}"
readonly FIXTURE_PATH="${REFUNDDESK_INCIDENT_FIXTURE_PATH:-}"
readonly PROMOTION_PATH="${REFUNDDESK_INCIDENT_PROMOTION_PATH:-}"
readonly EXPECTED_COMPOSE_SHA256="${REFUNDDESK_INCIDENT_EXPECTED_COMPOSE_SHA256:-}"
readonly PROOF_CLIENT_PATH="${REFUNDDESK_INCIDENT_PROOF_CLIENT_PATH:-}"
readonly PROOF_CLIENT_SHA256="${REFUNDDESK_INCIDENT_PROOF_CLIENT_SHA256:-}"
readonly SOURCE_ROOT="${REFUNDDESK_INCIDENT_SOURCE_ROOT:-}"
readonly DEADLINE="${REFUNDDESK_INCIDENT_DEADLINE:-}"
readonly EXPECTED_HOST_COMMAND_SHA256="${REFUNDDESK_INCIDENT_HOST_COMMAND_SHA256:-}"
readonly CONTROL_ROOT="${REFUNDDESK_INCIDENT_CONTROL_ROOT:-/var/lib/refunddesk/control}"
WATCHDOG_DEADLINE_DIGEST="$(printf '%s' "${DEADLINE}" | sha256sum | cut -c1-12)" || exit 64
[[ "${WATCHDOG_DEADLINE_DIGEST}" =~ ^[0-9a-f]{12}$ ]] || exit 64
readonly WATCHDOG_DEADLINE_DIGEST
readonly WATCHDOG_UNIT="refunddesk-incident-admission-${OPERATION:0:12}-${WATCHDOG_DEADLINE_DIGEST}-watchdog"
readonly HOST_STATE="${CONTROL_ROOT}/${HOST_STATE_NAME}"
readonly WATCHDOG_MARKER="${CONTROL_ROOT}/incident-admission-watchdog-${OPERATION:0:16}.json"
readonly PLATFORM_ENV="/etc/refunddesk/platform.env"
readonly WORKER_ENV="/etc/refunddesk/worker.env"
readonly RELEASE_ENV="/etc/refunddesk/release.env"
readonly COMPOSE_FILE="${SOURCE_ROOT}/deploy/lightsail/compose.yml"
readonly SOURCE_REVISION_FILE="${SOURCE_ROOT}/.refunddesk-revision"
readonly SOURCE_DIGEST_FILE="${SOURCE_ROOT}/.refunddesk-source-sha256"
readonly ACTIVE_REVISION_FILE="/opt/refunddesk/ACTIVE_REVISION"
readonly CURRENT_LINK="/opt/refunddesk/current"
readonly INSTALLED_MANIFEST="/opt/refunddesk/releases/${EXPECTED_REVISION}/manifest.json"
readonly SOURCE_HOST_COMMAND="${SOURCE_ROOT}/deploy/lightsail/scripts/incident-admission-host-command.sh"
readonly COMPOSE_PROJECT="refunddesk"
POST_INCIDENT_BASELINE_JSON=""

emit() {
  python3 - "$1" <<'PY'
import json,sys
value=json.loads(sys.argv[1])
sys.stdout.write(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n")
PY
}

fail_closed() {
  case "${ACTION}" in
    prepare-state) emit '{"prepared":false,"resumed":false}' ;;
    start-worker) emit '{"started":false}' ;;
    stop-worker) emit '{"stopped":false}' ;;
    proof) emit '{"complete":false,"sameIdempotencyKey":true}' ;;
    *) emit '{"accountBindingsExact":false,"caddyStopped":false,"coreStable":false,"financialQuiescent":false,"liveDisabled":false,"maintenanceStopped":false,"managedSandboxEffectMatches":false,"managedSandboxReadMatches":false,"publicListenersClosed":false,"revisionExact":false,"sourceExact":false,"stripeAppSigningMatches":false,"workerStopped":false}' ;;
  esac
  exit 20
}

controlled_secret_file() {
  local path="$1"
  [[ -f "${path}" && ! -L "${path}" && "$(stat --format='%u:%g:%a' -- "${path}")" == "0:0:600" ]]
}

controlled_source_file() {
  local path="$1" metadata mode
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}")" || return 1
  [[ "${metadata}" =~ ^0:0:([0-7]{3,4})$ ]] || return 1
  mode="${BASH_REMATCH[1]}"
  (( (8#${mode} & 022) == 0 ))
}

hash_file() {
  sha256sum -- "$1" | cut -d ' ' -f 1
}

compose() {
  env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C \
    docker compose --project-directory "$(dirname -- "${COMPOSE_FILE}")" \
      --env-file "${RELEASE_ENV}" --file "${COMPOSE_FILE}" "$@"
}

service_container_id() {
  local service="$1" output
  output="$(docker container ls --all --quiet --no-trunc \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=${service}")" || return 1
  [[ "${output}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${output}"
}

promotion_field() {
  python3 - "${PROMOTION_PATH}" "$1" <<'PY'
import json,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
for key in sys.argv[2].split("."): value=value[key]
if not isinstance(value,(str,int)): raise SystemExit(1)
print(value)
PY
}

database_scalar() {
  local sql="$1" postgres_id output
  postgres_id="$(service_container_id postgres)" || return 1
  [[ "${postgres_id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  output="$(timeout 25 docker exec --env PSQL_HISTORY=/dev/null "${postgres_id}" \
    psql --host=/var/run/postgresql --username=refunddesk_owner --dbname=refunddesk \
      --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
      --command="BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; ${sql}; ROLLBACK;")" || return 1
  printf '%s' "${output}" | tr -d '[:space:]'
}

database_mutation_scalar() {
  local sql="$1" postgres_id output
  postgres_id="$(service_container_id postgres)" || return 1
  [[ "${postgres_id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  output="$(timeout 25 docker exec --env PSQL_HISTORY=/dev/null "${postgres_id}" \
    psql --host=/var/run/postgresql --username=refunddesk_owner --dbname=refunddesk \
      --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
      --command="BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; ${sql}; COMMIT;")" || return 1
  printf '%s' "${output}" | tr -d '[:space:]'
}

database_quiescent() {
  local value
  value="$(database_scalar "SELECT concat_ws('|',(SELECT count(*) FROM public.refund_requests WHERE workflow_status IN ('pending_approval','approved','executing','reconciliation_required')),(SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL),(SELECT count(*) FROM pgboss.job WHERE name !~ '^__pgboss__' AND state::text IN ('created','retry','active')),(SELECT count(*) FROM pg_catalog.pg_prepared_xacts),(SELECT count(*) FROM public.tenants WHERE live_enabled),(SELECT count(*) FROM public.stripe_installations WHERE environment='live'))")" || return 1
  [[ "${value}" == "0|0|0|0|0|0" ]]
}

listeners_closed() {
  local output line
  output="$(ss --tcp --udp --listening --numeric --no-header)" || return 1
  while IFS= read -r line; do
    [[ "${line}" =~ :80([[:space:]]|$)|:443([[:space:]]|$) ]] && return 1
  done <<<"${output}"
  return 0
}

units_stopped() {
  local unit state enabled
  for unit in refunddesk-caddy.service refunddesk-worker.service refunddesk-backup.service \
    refunddesk-retention.service refunddesk-quiesce-recovery.service refunddesk-backup.timer \
    refunddesk-retention.timer; do
    state="$(systemctl show --property=LoadState --property=ActiveState --value "${unit}")" || return 1
    [[ "${state}" == $'loaded\ninactive' ]] || return 1
    if [[ "${unit}" == *.timer ]]; then
      enabled="$(systemctl is-enabled "${unit}")" || [[ $? == 1 ]] || return 1
      [[ "${enabled}" == disabled ]] || return 1
    fi
  done
  return 0
}

source_exact() {
  local revision source_digest manifest_digest current_target
  [[ "${SOURCE_ROOT}" == "/opt/refunddesk/releases/${EXPECTED_REVISION}/source" &&
    -d "${SOURCE_ROOT}" && ! -L "${SOURCE_ROOT}" &&
    -f "${COMPOSE_FILE}" && ! -L "${COMPOSE_FILE}" &&
    -L "${CURRENT_LINK}" && ! -e "${CURRENT_LINK}/.refunddesk-source-sha256.tmp" ]] || return 1
  current_target="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")" || return 1
  [[ "${current_target}" == "${SOURCE_ROOT}" ]] || return 1
  for path in "${ACTIVE_REVISION_FILE}" "${SOURCE_REVISION_FILE}"; do
    [[ -f "${path}" && ! -L "${path}" ]] || return 1
    IFS= read -r revision <"${path}" || return 1
    [[ "${revision}" == "${EXPECTED_REVISION}" ]] || return 1
  done
  controlled_secret_file "${SOURCE_DIGEST_FILE}" || return 1
  IFS= read -r source_digest <"${SOURCE_DIGEST_FILE}" || return 1
  [[ "${source_digest}" == "$(promotion_field inputs.sourceSha256)" ]] || return 1
  controlled_source_file "${INSTALLED_MANIFEST}" || return 1
  manifest_digest="$(hash_file "${INSTALLED_MANIFEST}")" || return 1
  [[ "${manifest_digest}" == "$(promotion_field inputs.manifestSha256)" &&
    "$(hash_file "${COMPOSE_FILE}")" == "${EXPECTED_COMPOSE_SHA256}" ]] || return 1
}

runtime_inventory_exact() {
  local worker_running="$1" ids all_ids reservation_id reservation_image_id service id expected_id inspection
  local -a project_ids=() global_ids=()
  ids="$(docker container ls --all --quiet --no-trunc --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}")" || return 1
  [[ -z "${ids}" ]] || mapfile -t project_ids <<<"${ids}"
  (( ${#project_ids[@]} == 6 )) || return 1
  (( $(printf '%s\n' "${project_ids[@]}" | sort --unique | wc --lines) == 6 )) || return 1
  all_ids="$(docker container ls --all --quiet --no-trunc)" || return 1
  [[ -z "${all_ids}" ]] || mapfile -t global_ids <<<"${all_ids}"
  (( ${#global_ids[@]} == 6 )) || return 1
  [[ "$(printf '%s\n' "${project_ids[@]}" | sort)" == "$(printf '%s\n' "${global_ids[@]}" | sort)" ]] || return 1
  reservation_id="$(service_container_id database-owner-reservation)" || return 1
  reservation_image_id="$(docker image inspect --format '{{.Id}}' -- 'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296')" || return 1
  [[ "${reservation_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  inspection="$(docker inspect "${reservation_id}")" || return 1
  python3 - "${EXPECTED_REVISION}" "${reservation_id}" "${reservation_image_id}" 3<<<"${inspection}" <<'PY' || return 1
import json,os,re,sys
revision,identifier,image_id=sys.argv[1:]
value=json.load(os.fdopen(3))
if not isinstance(value,list) or len(value)!=1: raise SystemExit(1)
c=value[0]; config=c.get("Config") or {}; labels=config.get("Labels") or {}; host=c.get("HostConfig") or {}; state=c.get("State") or {}
expected_labels={"com.docker.compose.project":"refunddesk","com.docker.compose.service":"database-owner-reservation","com.refunddesk.database-owner-reservation":"true","com.refunddesk.revision":revision}
expected_env={"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin","GOSU_VERSION=1.19","LANG=en_US.utf8","PG_MAJOR=18","PG_VERSION=18.4-1.pgdg12+1","PGDATA=/var/lib/postgresql/18/docker"}
ok=(c.get("Id")==identifier and c.get("Name")=="/refunddesk-database-owner" and c.get("Args")==[] and c.get("Image")==image_id and config.get("Image")=="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296" and config.get("Entrypoint")==["/bin/true"] and config.get("Cmd") is None and config.get("AttachStdin") is False and config.get("AttachStdout") is True and config.get("AttachStderr") is True and config.get("Tty") is False and config.get("OpenStdin") is False and config.get("StdinOnce") is False and config.get("User")=="" and set(config.get("Env") or [])==expected_env and len(config.get("Env") or [])==len(expected_env) and labels==expected_labels and state.get("Running") is False and state.get("Status")=="created" and host.get("RestartPolicy",{})=={"MaximumRetryCount":0,"Name":"no"} and host.get("NetworkMode")=="none" and host.get("ReadonlyRootfs") is True and host.get("Privileged") is False and host.get("CapAdd") in (None,[]) and host.get("CapDrop")==["ALL"] and host.get("SecurityOpt")==["no-new-privileges:true"] and host.get("PidsLimit")==8 and host.get("Memory")==16777216 and host.get("PortBindings") in (None,{}) and host.get("PublishAllPorts") is False and host.get("Binds") in (None,[]) and (c.get("Mounts") or [])==[] and host.get("Tmpfs")=={"/var/lib/postgresql":"rw,nosuid,nodev,noexec,size=65536"})
raise SystemExit(0 if ok else 1)
PY
  for service in postgres verifier worker web caddy; do
    id="$(service_container_id "${service}")" || return 1
    expected_id="$(promotion_field "runtime.${service}ContainerId")" || return 1
    [[ "${id}" == "${expected_id}" && "${id}" =~ ^[0-9a-f]{64}$ ]] || return 1
    inspection="$(docker inspect "${id}")" || return 1
    python3 - "${service}" "${EXPECTED_REVISION}" "${id}" "${worker_running}" "${INSTALLED_MANIFEST}" 3<<<"${inspection}" <<'PY' || return 1
import json,os,re,sys
service,revision,identifier,worker_running,manifest_path=sys.argv[1:]
value=json.load(os.fdopen(3))
if not isinstance(value,list) or len(value)!=1: raise SystemExit(1)
c=value[0]; config=c.get("Config") or {}; labels=config.get("Labels") or {}; host=c.get("HostConfig") or {}; state=c.get("State") or {}
expected_running={"postgres":True,"verifier":True,"web":True,"caddy":False,"worker":worker_running=="true"}[service]
ok=(c.get("Id")==identifier and labels.get("com.docker.compose.project")=="refunddesk" and labels.get("com.docker.compose.service")==service and re.fullmatch(r"[0-9a-f]{64}",labels.get("com.docker.compose.config-hash", "")) is not None and re.fullmatch(r"sha256:[0-9a-f]{64}",c.get("Image", "")) is not None and isinstance(config.get("Image"),str) and len(config["Image"])>0 and state.get("Running") is expected_running and (host.get("PortBindings") or {})=={} and all(v in (None,[]) for v in (c.get("NetworkSettings",{}).get("Ports") or {}).values()))
if service!="postgres": ok=ok and labels.get("com.refunddesk.revision")==revision and host.get("RestartPolicy",{}).get("Name")=="no"
if expected_running: ok=ok and (state.get("Health") or {}).get("Status")=="healthy"
if service in {"web","worker"}:
    manifest=json.load(open(manifest_path,encoding="utf-8")); rows=[row for row in manifest.get("images",[]) if row.get("role")==service]
    ok=ok and len(rows)==1 and rows[0].get("imageId")==c.get("Image") and config.get("Image")==f"refunddesk-{service}:sandbox-{revision}"
raise SystemExit(0 if ok else 1)
PY
  done
}

container_stopped() {
  runtime_inventory_exact false
}

core_healthy() {
  runtime_inventory_exact false
}

binding_observation() {
  local worker_id web_id worker_inspection web_inspection worker_image web_image
  worker_id="$(service_container_id worker)" || return 1
  web_id="$(service_container_id web)" || return 1
  worker_inspection="$(docker inspect "${worker_id}")" || return 1
  web_inspection="$(docker inspect "${web_id}")" || return 1
  worker_image="$(docker image inspect -- "refunddesk-worker:sandbox-${EXPECTED_REVISION}")" || return 1
  web_image="$(docker image inspect -- "refunddesk-web:sandbox-${EXPECTED_REVISION}")" || return 1
  python3 - "${DASHBOARD_PATH}" "${PLATFORM_ENV}" "${WORKER_ENV}" \
    3<<<"${worker_inspection}" 4<<<"${web_inspection}" 5<<<"${worker_image}" 6<<<"${web_image}" <<'PY'
import hashlib,json,os,pathlib,re,sys
dashboard,platform,worker=map(pathlib.Path,sys.argv[1:])
def env(path):
    raw=path.read_bytes()
    if not raw.endswith(b"\n") or b"\r" in raw or b"\0" in raw or raw.startswith(b"\xef\xbb\xbf"): raise SystemExit(1)
    result={}
    try: lines=raw[:-1].decode("utf-8").split("\n")
    except UnicodeDecodeError: raise SystemExit(1)
    if not lines or any(not line or re.fullmatch(r"[A-Z][A-Z0-9_]*=[^\n\r]+",line) is None for line in lines): raise SystemExit(1)
    for line in lines:
        key,value=line.split("=",1)
        if key in result: raise SystemExit(1)
        result[key]=value
    return result
d=json.loads(dashboard.read_text(encoding="utf-8")); p=env(platform); w=env(worker)
def container_env(fd):
    value=json.load(os.fdopen(fd))
    if not isinstance(value,list) or len(value)!=1: raise SystemExit(1)
    rows=value[0].get("Config",{}).get("Env")
    if not isinstance(rows,list): raise SystemExit(1)
    result={}
    for row in rows:
        if not isinstance(row,str) or "=" not in row: raise SystemExit(1)
        key,item=row.split("=",1)
        if key in result: raise SystemExit(1)
        result[key]=item
    return result
cw=container_env(3); cp=container_env(4)
def image_env(fd):
    value=json.load(os.fdopen(fd))
    if not isinstance(value,list) or len(value)!=1: raise SystemExit(1)
    rows=(value[0].get("Config") or {}).get("Env")
    if not isinstance(rows,list): raise SystemExit(1)
    result={}
    for row in rows:
        if not isinstance(row,str) or re.fullmatch(r"[A-Z][A-Z0-9_]*=[^\n\r]+",row) is None: raise SystemExit(1)
        key,item=row.split("=",1)
        if key in result: raise SystemExit(1)
        result[key]=item
    return result
iw=image_env(5); ip=image_env(6)
def material_keys(values,prefix,active_name,state_name):
    active=values.get(active_name); state=values.get(state_name)
    table={"legacy":("v1",{"v1"}),"staged":("v1",{"v1","v2"}),"active":("v2",{"v1","v2"}),"rollback":("v1",{"v1","v2"}),"retired":("v2",{"v2"})}
    if state not in table or (active,{key.removeprefix(prefix).lower() for key in values if key.startswith(prefix)})!=table[state]: raise SystemExit(1)
platform_base={"NODE_ENV","LOG_LEVEL","APP_BASE_URL","DATABASE_URL","STRIPE_API_VERSION","STRIPE_APP_ID","STRIPE_PLATFORM_TEST_READ_KEY","STRIPE_MANAGED_SANDBOX_READ_KEY","STRIPE_PLATFORM_TEST_ACCOUNT_ID","STRIPE_MANAGED_SANDBOX_ACCOUNT_ID","STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET","STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET","STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET","REFUNDDESK_GLOBAL_LIVE_ENABLED","REFUNDDESK_EXPORT_SIGNING_KEY_V1","REFUNDDESK_ACTIVE_FIELD_KEY_VERSION","REFUNDDESK_FIELD_KEY_ROTATION_STATE","REFUNDDESK_SIGNED_REQUEST_VERIFIER_URL","REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN"}
worker_base={"NODE_ENV","LOG_LEVEL","WORKER_DATABASE_URL","PGBOSS_DATABASE_URL","STRIPE_API_VERSION","STRIPE_APP_SIGNING_SECRET","STRIPE_PLATFORM_TEST_EFFECT_KEY","STRIPE_MANAGED_SANDBOX_EFFECT_KEY","STRIPE_PLATFORM_TEST_ACCOUNT_ID","STRIPE_MANAGED_SANDBOX_ACCOUNT_ID","REFUNDDESK_GLOBAL_LIVE_ENABLED","REFUNDDESK_ACTIVE_PROOF_KEY_VERSION","REFUNDDESK_PROOF_KEY_ROTATION_STATE","REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION","REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE","REFUNDDESK_SIGNED_REQUEST_VERIFIER_TOKEN","WORKER_HEALTH_HOST","WORKER_HEALTH_PORT"}
platform_material={key for key in p if key.startswith("REFUNDDESK_FIELD_ENCRYPTION_KEY_V")}
worker_material={key for key in w if key.startswith("REFUNDDESK_PROOF_HMAC_KEY_V") or key.startswith("REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V")}
if set(p)!=platform_base|platform_material or set(w)!=worker_base|worker_material: raise SystemExit(1)
material_keys(p,"REFUNDDESK_FIELD_ENCRYPTION_KEY_","REFUNDDESK_ACTIVE_FIELD_KEY_VERSION","REFUNDDESK_FIELD_KEY_ROTATION_STATE")
material_keys(w,"REFUNDDESK_PROOF_HMAC_KEY_","REFUNDDESK_ACTIVE_PROOF_KEY_VERSION","REFUNDDESK_PROOF_KEY_ROTATION_STATE")
material_keys(w,"REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_","REFUNDDESK_ACTIVE_APPROVAL_ATTESTATION_KEY_VERSION","REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE")
expected_platform={**ip,**p,"HOSTNAME":"0.0.0.0","NODE_EXTRA_CA_CERTS":"/run/refunddesk/client-ca-bundle.crt","NODE_OPTIONS":"--max-old-space-size=192"}
expected_worker={**iw,**w,"NODE_EXTRA_CA_CERTS":"/run/refunddesk/postgres-ca.crt","NODE_OPTIONS":"--max-old-space-size=144","REFUNDDESK_WORKER_RUNTIME_MODE":"incident_admission","WORKER_HEALTH_HOST":"0.0.0.0","WORKER_HEALTH_PORT":"3101"}
if cp!=expected_platform or cw!=expected_worker: raise SystemExit(1)
worker_keys=["STRIPE_APP_SIGNING_SECRET","STRIPE_MANAGED_SANDBOX_EFFECT_KEY","STRIPE_MANAGED_SANDBOX_ACCOUNT_ID","STRIPE_PLATFORM_TEST_ACCOUNT_ID","REFUNDDESK_GLOBAL_LIVE_ENABLED"]
platform_keys=["STRIPE_MANAGED_SANDBOX_READ_KEY","STRIPE_MANAGED_SANDBOX_ACCOUNT_ID","STRIPE_PLATFORM_TEST_ACCOUNT_ID","REFUNDDESK_GLOBAL_LIVE_ENABLED"]
forbidden={"STRIPE_APP_SIGNING_SECRET_PREVIOUS","STRIPE_MANAGED_SANDBOX_KEY","STRIPE_PLATFORM_TEST_KEY"}
if any(key in source for source in (p,w,cp,cw) for key in forbidden): raise SystemExit(1)
worker_forbidden={"STRIPE_MANAGED_SANDBOX_READ_KEY","STRIPE_PLATFORM_TEST_READ_KEY"}
platform_forbidden={"STRIPE_MANAGED_SANDBOX_EFFECT_KEY","STRIPE_PLATFORM_TEST_EFFECT_KEY"}
if any(key in source for source in (w,cw) for key in worker_forbidden): raise SystemExit(1)
if any(key in source for source in (p,cp) for key in platform_forbidden): raise SystemExit(1)
if any(key not in w or key not in cw or w[key]!=cw[key] for key in worker_keys): raise SystemExit(1)
if any(key not in p or key not in cp or p[key]!=cp[key] for key in platform_keys): raise SystemExit(1)
if cw.get("REFUNDDESK_WORKER_RUNTIME_MODE")!="incident_admission": raise SystemExit(1)
h=lambda value:"sha256:"+hashlib.sha256(value.encode()).hexdigest()
account=(h(cp["STRIPE_MANAGED_SANDBOX_ACCOUNT_ID"])==d["accountFingerprints"]["managedSandbox"] and h(cp["STRIPE_PLATFORM_TEST_ACCOUNT_ID"])==d["accountFingerprints"]["platformTest"] and cp["STRIPE_MANAGED_SANDBOX_ACCOUNT_ID"]==cw["STRIPE_MANAGED_SANDBOX_ACCOUNT_ID"] and cp["STRIPE_PLATFORM_TEST_ACCOUNT_ID"]==cw["STRIPE_PLATFORM_TEST_ACCOUNT_ID"])
value={"accountBindingsExact":account,"liveDisabled":cp.get("REFUNDDESK_GLOBAL_LIVE_ENABLED")=="false" and cw.get("REFUNDDESK_GLOBAL_LIVE_ENABLED")=="false","managedSandboxEffectMatches":h(cw["STRIPE_MANAGED_SANDBOX_EFFECT_KEY"])==d["candidateFingerprints"]["managedSandboxEffect"],"managedSandboxReadMatches":h(cp["STRIPE_MANAGED_SANDBOX_READ_KEY"])==d["candidateFingerprints"]["managedSandboxRead"],"stripeAppSigningMatches":h(cw["STRIPE_APP_SIGNING_SECRET"])==d["candidateFingerprints"]["stripeAppSigning"]}
sys.stdout.write(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n")
PY
}

bindings_exact() {
  local observation
  observation="$(binding_observation)" || return 1
  python3 - "${observation}" <<'PY'
import json,sys
value=json.loads(sys.argv[1]); expected={"accountBindingsExact","liveDisabled","managedSandboxEffectMatches","managedSandboxReadMatches","stripeAppSigningMatches"}
raise SystemExit(0 if set(value)==expected and all(item is True for item in value.values()) else 1)
PY
}

write_host_state() {
  local counts timestamp
  counts="$(database_scalar "SELECT concat_ws('|',(SELECT count(*) FROM public.refund_requests),(SELECT count(*) FROM public.audit_events),(SELECT count(*) FROM public.refund_executions),(SELECT count(*) FROM public.refund_execution_attempts),(SELECT count(*) FROM public.approval_decisions),(SELECT count(*) FROM public.approval_attestations),(SELECT count(*) FROM public.api_mutation_receipts),(SELECT count(*) FROM public.webhook_receipts),(SELECT count(*) FROM public.refund_correlation_candidates),(SELECT count(*) FROM public.external_refund_alerts))")" || return 1
  [[ "${counts}" =~ ^([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)$ ]] || return 1
  timestamp="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  python3 - "${HOST_STATE}" "${OPERATION}" "${EXPECTED_REVISION}" "${DASHBOARD_AUTHORITY}" \
    "${FIXTURE_SHA256}" "${IDEMPOTENCY_DIGEST}" "${counts}" "${timestamp}" "${PROMOTION_PATH}" <<'PY'
import hashlib,json,os,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]); path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
names=["refundRequestsBefore","auditEventsBefore","refundExecutionsBefore","refundAttemptsBefore","approvalDecisionsBefore","approvalAttestationsBefore","mutationReceiptsBefore","webhookReceiptsBefore","correlationCandidatesBefore","externalAlertsBefore"]
parts=sys.argv[7].split("|")
if len(parts)!=len(names) or any(not part.isdigit() for part in parts): raise SystemExit(1)
promotion=json.load(open(sys.argv[9],encoding="utf-8")); database=promotion["database"]
expected=[database["refundRequests"],database["auditEvents"],database["refundExecutions"],database["refundExecutionAttempts"],database["apiMutationReceipts"],database["webhookReceipts"]]
observed=[int(parts[index]) for index in (0,1,2,3,6,7)]
if observed!=expected: raise SystemExit(1)
value={"baselineSha256":hashlib.sha256((sys.argv[7]+"\n").encode()).hexdigest(),"capturedAt":sys.argv[8],"dashboardAuthoritySha256":sys.argv[4],"expectedRevision":sys.argv[3],"fixtureSha256":sys.argv[5],"idempotencyDigest":sys.argv[6],"kind":"refunddesk.incident-admission.host-state","operation":sys.argv[2],"promotionSnapshotSha256":database["snapshotSha256"],"stripeBaseline":None,**{name:int(part) for name,part in zip(names,parts)}}
raw=(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
fd,name=tempfile.mkstemp(prefix=path.name+".tmp-",dir=path.parent); temporary=pathlib.Path(name)
try:
    with os.fdopen(fd,"wb") as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path); directory=os.open(path.parent,os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    try: temporary.unlink()
    except FileNotFoundError: pass
PY
}

host_state_bound() {
  controlled_secret_file "${HOST_STATE}" || return 1
  python3 - "${HOST_STATE}" "${OPERATION}" "${EXPECTED_REVISION}" "${DASHBOARD_AUTHORITY}" "${FIXTURE_SHA256}" "${IDEMPOTENCY_DIGEST}" "${PROMOTION_PATH}" <<'PY'
import hashlib,json,re,sys
v=json.load(open(sys.argv[1],encoding="utf-8"))
names=["refundRequestsBefore","auditEventsBefore","refundExecutionsBefore","refundAttemptsBefore","approvalDecisionsBefore","approvalAttestationsBefore","mutationReceiptsBefore","webhookReceiptsBefore","correlationCandidatesBefore","externalAlertsBefore"]
expected={"baselineSha256","capturedAt","dashboardAuthoritySha256","expectedRevision","fixtureSha256","idempotencyDigest","kind","operation","promotionSnapshotSha256","stripeBaseline",*names}
counts="|".join(str(v.get(name)) for name in names)+"\n"
promotion=json.load(open(sys.argv[7],encoding="utf-8"))
stripe=v.get("stripeBaseline")
stripe_ok=stripe is None or (isinstance(stripe,dict) and set(stripe)=={"denialRefundCount","denialRefundSetSha256","refundableRefundCount","refundableRefundSetSha256"} and all(isinstance(stripe[k],int) and stripe[k]>=0 for k in ("denialRefundCount","refundableRefundCount")) and all(isinstance(stripe[k],str) and re.fullmatch(r"[0-9a-f]{64}",stripe[k]) for k in ("denialRefundSetSha256","refundableRefundSetSha256")))
ok=set(v)==expected and stripe_ok and v.get("promotionSnapshotSha256")==promotion.get("database",{}).get("snapshotSha256") and re.fullmatch(r"[0-9a-f]{64}",str(v.get("promotionSnapshotSha256",""))) is not None and v.get("kind")=="refunddesk.incident-admission.host-state" and v.get("baselineSha256")==hashlib.sha256(counts.encode()).hexdigest() and v.get("operation")==sys.argv[2] and v.get("expectedRevision")==sys.argv[3] and v.get("dashboardAuthoritySha256")==sys.argv[4] and v.get("fixtureSha256")==sys.argv[5] and v.get("idempotencyDigest")==sys.argv[6]
raise SystemExit(0 if ok else 1)
PY
}

capture_resume_state() {
  local destination="$1" baseline baseline_time fixture_values refundable_pi requester approver nonces create_nonce approve_nonce sql current
  host_state_bound || return 1
  baseline="$(python3 - "${HOST_STATE}" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8")); names=["refundRequestsBefore","auditEventsBefore","refundExecutionsBefore","refundAttemptsBefore","approvalDecisionsBefore","approvalAttestationsBefore","mutationReceiptsBefore","webhookReceiptsBefore","correlationCandidatesBefore","externalAlertsBefore"]
print("|".join(str(v[name]) for name in names))
PY
)" || return 1
  baseline_time="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["capturedAt"])' "${HOST_STATE}")" || return 1
  fixture_values="$(python3 - "${FIXTURE_PATH}" <<'PY'
import json,re,sys
v=json.load(open(sys.argv[1],encoding="utf-8")); values=[v.get("refundablePaymentIntentId"),v.get("requesterUserId"),v.get("approverUserId")]
patterns=[r"pi_[A-Za-z0-9]{6,64}",r"usr_[A-Za-z0-9]{6,64}",r"usr_[A-Za-z0-9]{6,64}"]
if any(not isinstance(value,str) or re.fullmatch(pattern,value) is None for value,pattern in zip(values,patterns)) or values[1]==values[2]: raise SystemExit(1)
print("|".join(values))
PY
)" || return 1
  IFS='|' read -r refundable_pi requester approver <<<"${fixture_values}"
  nonces="$(python3 - "${OPERATION}" <<'PY'
import hashlib,hmac,sys
def value(label):
    digest=hmac.new(sys.argv[1].encode(),label.encode(),hashlib.sha256).hexdigest()
    return f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-8{digest[17:20]}-{digest[20:32]}"
print(value("create")+"|"+value("approve"))
PY
)" || return 1
  IFS='|' read -r create_nonce approve_nonce <<<"${nonces}"
  [[ "${baseline}" =~ ^([0-9]+\|){9}[0-9]+$ &&
    "${baseline_time}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
    "${create_nonce}" =~ ^[0-9a-f-]{36}$ && "${approve_nonce}" =~ ^[0-9a-f-]{36}$ ]] || return 1
  sql="WITH exact_request AS (SELECT r.* FROM public.refund_requests r JOIN public.tenant_users u ON u.id=r.requester_user_id AND u.tenant_id=r.tenant_id WHERE r.payment_intent_id='${refundable_pi}' AND r.amount_minor=1 AND r.currency='eur' AND r.environment='sandbox' AND u.stripe_user_id='${requester}'), exact_execution AS (SELECT e.* FROM public.refund_executions e JOIN exact_request r ON r.id=e.request_id AND r.tenant_id=e.tenant_id WHERE e.idempotency_key='refunddesk:refund-request:'||r.id::text||':v1' AND e.amount_minor=1 AND e.currency='eur') SELECT concat_ws('|',(SELECT count(*) FROM public.refund_requests),(SELECT count(*) FROM public.audit_events),(SELECT count(*) FROM public.refund_executions),(SELECT count(*) FROM public.refund_execution_attempts),(SELECT count(*) FROM public.approval_decisions),(SELECT count(*) FROM public.approval_attestations),(SELECT count(*) FROM public.api_mutation_receipts),(SELECT count(*) FROM public.webhook_receipts),(SELECT count(*) FROM public.refund_correlation_candidates),(SELECT count(*) FROM public.external_refund_alerts),(SELECT count(*) FROM exact_request),(SELECT count(*) FROM exact_request WHERE workflow_status='succeeded' AND payment_guard_released_at IS NOT NULL AND terminal_at IS NOT NULL),(SELECT count(*) FROM exact_execution),(SELECT count(*) FROM exact_execution WHERE stripe_refund_id IS NOT NULL AND stripe_refund_status='succeeded' AND reconciled_at IS NOT NULL),(SELECT count(*) FROM public.refund_execution_attempts a JOIN exact_execution e ON e.id=a.execution_id AND e.tenant_id=a.tenant_id),(SELECT count(*) FROM public.refund_execution_attempts a JOIN exact_execution e ON e.id=a.execution_id AND e.tenant_id=a.tenant_id WHERE a.state='completed' AND a.finished_at IS NOT NULL),(SELECT count(*) FROM public.approval_decisions d JOIN exact_request r ON r.id=d.request_id AND r.tenant_id=d.tenant_id JOIN public.tenant_users u ON u.id=d.approver_user_id AND u.tenant_id=d.tenant_id WHERE u.stripe_user_id='${approver}' AND d.decision='approve' AND d.approval_attestation_id IS NOT NULL),(SELECT count(*) FROM public.approval_attestations a JOIN exact_request r ON r.id=a.request_id AND r.tenant_id=a.tenant_id JOIN public.tenant_users u ON u.id=a.approver_user_id AND u.tenant_id=a.tenant_id WHERE u.stripe_user_id='${approver}' AND a.environment='sandbox' AND a.resource_type='payment_intent' AND a.resource_id='${refundable_pi}'),(SELECT count(*) FROM public.api_mutation_receipts m WHERE (m.request_nonce='${create_nonce}'::uuid AND m.operation='refund_request.create' AND m.actor_id='${requester}') OR (m.request_nonce='${approve_nonce}'::uuid AND m.operation='refund_request.decide' AND m.actor_id='${approver}')),(SELECT count(*) FROM public.refund_requests r WHERE r.workflow_status IN ('pending_approval','approved','executing','reconciliation_required') AND NOT EXISTS (SELECT 1 FROM exact_request x WHERE x.id=r.id AND x.tenant_id=r.tenant_id)),(SELECT count(*) FROM pgboss.job j JOIN exact_request r ON j.data->>'request_id'=r.id::text WHERE j.name='refunddesk_refund_execute' AND j.state::text IN ('created','retry','active')),(SELECT count(*) FROM pgboss.job j WHERE j.name !~ '^__pgboss__' AND j.state::text IN ('created','retry','active') AND NOT (j.name='refunddesk_refund_execute' AND EXISTS (SELECT 1 FROM exact_request r WHERE j.data->>'request_id'=r.id::text))),(SELECT count(*) FROM pg_catalog.pg_prepared_xacts),(SELECT count(*) FROM public.audit_events a WHERE a.occurred_at >= '${baseline_time}'::timestamptz AND NOT ((a.action IN ('refund_request.created','refund_request.approved') AND a.entity_id IN (SELECT r.id::text FROM exact_request r)) OR (a.action IN ('refund.observed','refund.linked_status_refreshed') AND a.entity_id IN (SELECT e.stripe_refund_id FROM exact_execution e WHERE e.stripe_refund_id IS NOT NULL)))),(SELECT count(*) FROM exact_request WHERE payment_guard_released_at IS NULL),(SELECT count(*) FROM public.refund_requests r WHERE r.payment_guard_released_at IS NULL AND NOT EXISTS (SELECT 1 FROM exact_request x WHERE x.id=r.id AND x.tenant_id=r.tenant_id)),COALESCE((SELECT encode(digest(stripe_refund_id,'sha256'),'hex') FROM exact_execution WHERE stripe_refund_id IS NOT NULL),'-'))"
  current="$(database_scalar "${sql}")" || return 1
  python3 - "${baseline}" "${current}" "${destination}" <<'PY'
import hashlib,json,pathlib,sys
before=list(map(int,sys.argv[1].split("|"))); parts=sys.argv[2].split("|")
if len(before)!=10 or len(parts)!=27: raise SystemExit(1)
current=list(map(int,parts[:26])); refund_hash=parts[26]
after=current[:10]; links=current[10:]
deltas=[value-before[index] for index,value in enumerate(after)]
if any(value<0 for value in deltas): raise SystemExit(1)
linked=refund_hash!="-"
pristine=deltas==[0]*10 and links==[0]*16 and not linked
progressed=(deltas[0]==1 and 1<=deltas[1]<=4 and deltas[2] in (0,1) and deltas[3] in (0,1) and deltas[4] in (0,1) and deltas[5] in (0,1) and deltas[4]==deltas[5] and deltas[6] in (1,2) and deltas[7:]==[0,0,0] and links[0]==1 and links[1] in (0,1) and links[2]==deltas[2] and links[3] in range(links[2]+1) and links[4]==deltas[3] and links[5] in range(links[4]+1) and links[6]==deltas[4] and links[7]==deltas[5] and links[8]==deltas[6] and links[9]==0 and links[10] in (0,1) and links[11]==0 and links[12]==0 and links[13]==0 and links[14] in (0,1) and links[15]==0)
if not (pristine or progressed): raise SystemExit(1)
terminal=(deltas[0]==1 and 2<=deltas[1]<=4 and deltas[2:]==[1,1,1,1,2,0,0,0] and links==[1,1,1,1,1,1,1,1,2,0,0,0,0,0,0,0])
if linked:
    if links[2]!=1 or len(refund_hash)!=64 or any(character not in "0123456789abcdef" for character in refund_hash): raise SystemExit(1)
elif terminal or refund_hash!="-": raise SystemExit(1)
projection={"bounded":True,"databaseProjectionSha256":hashlib.sha256((sys.argv[2]+"\n").encode()).hexdigest(),"pristine":pristine,"refundIdSha256":refund_hash if linked else None,"refundLinked":linked,"terminalExact":terminal}
path=pathlib.Path(sys.argv[3]); path.write_bytes((json.dumps(projection,sort_keys=True,separators=(",",":"))+"\n").encode())
PY
}

recover_exact_job_for_resume() {
  local capture fixture_pi projection status exact_jobs ready_jobs active_jobs foreign_jobs prepared changed
  [[ "${REFUNDDESK_INCIDENT_RESUME:-false}" == true ]] || return 0
  capture="$(mktemp /run/refunddesk/incident-admission-job-resume-XXXXXXXX.json)" || return 1
  chmod 600 "${capture}" || { rm -f -- "${capture}"; return 1; }
  if ! capture_resume_state "${capture}"; then
    shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
    return 1
  fi
  if [[ "$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1]))["pristine"]).lower())' "${capture}")" == true ||
    "$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1]))["terminalExact"]).lower())' "${capture}")" == true ]]; then
    shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
    return 0
  fi
  shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
  fixture_pi="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["refundablePaymentIntentId"])' "${FIXTURE_PATH}")" || return 1
  [[ "${fixture_pi}" =~ ^pi_[A-Za-z0-9]{6,64}$ ]] || return 1
  projection="$(database_scalar "WITH exact_request AS (SELECT id,tenant_id,workflow_status FROM public.refund_requests WHERE payment_intent_id='${fixture_pi}' AND amount_minor=1 AND currency='eur' AND environment='sandbox'), exact_jobs AS (SELECT j.* FROM pgboss.job j JOIN exact_request r ON j.name='refunddesk_refund_execute' AND j.data->>'request_id'=r.id::text) SELECT concat_ws('|',(SELECT count(*) FROM exact_request),COALESCE((SELECT workflow_status::text FROM exact_request),'-'),(SELECT count(*) FROM exact_jobs),(SELECT count(*) FROM exact_jobs WHERE state::text IN ('created','retry')),(SELECT count(*) FROM exact_jobs WHERE state::text='active'),(SELECT count(*) FROM pgboss.job j WHERE j.name !~ '^__pgboss__' AND j.state::text IN ('created','retry','active') AND NOT EXISTS (SELECT 1 FROM exact_request r WHERE j.name='refunddesk_refund_execute' AND j.data->>'request_id'=r.id::text)),(SELECT count(*) FROM pg_catalog.pg_prepared_xacts))")" || return 1
  IFS='|' read -r _request_count status exact_jobs ready_jobs active_jobs foreign_jobs prepared <<<"${projection}"
  [[ "${_request_count}" == 1 && "${exact_jobs}" =~ ^[0-9]+$ && "${ready_jobs}" =~ ^[0-9]+$ &&
    "${active_jobs}" =~ ^[0-9]+$ && "${foreign_jobs}" == 0 && "${prepared}" == 0 ]] || return 1
  if [[ "${status}" == pending_approval && "${exact_jobs}" == 0 && "${ready_jobs}" == 0 && "${active_jobs}" == 0 ]]; then
    return 0
  fi
  [[ "${status}" =~ ^(approved|executing|reconciliation_required|succeeded)$ && "${exact_jobs}" == 1 ]] || return 1
  if [[ "${ready_jobs}" == 1 && "${active_jobs}" == 0 ]]; then
    return 0
  fi
  [[ "${ready_jobs}" == 0 && "${active_jobs}" == 1 ]] || return 1
  changed="$(database_mutation_scalar "WITH exact_request AS (SELECT id FROM public.refund_requests WHERE payment_intent_id='${fixture_pi}' AND amount_minor=1 AND currency='eur' AND environment='sandbox'), eligible AS (SELECT j.id FROM pgboss.job j JOIN exact_request r ON j.name='refunddesk_refund_execute' AND j.data->>'request_id'=r.id::text WHERE j.state::text='active' AND j.retry_count<j.retry_limit FOR UPDATE), changed AS (UPDATE pgboss.job j SET state='retry',start_after=now(),completed_on=NULL,heartbeat_on=NULL FROM eligible e WHERE j.id=e.id AND (SELECT count(*) FROM exact_request)=1 AND (SELECT count(*) FROM eligible)=1 AND NOT EXISTS (SELECT 1 FROM pgboss.job other WHERE other.name !~ '^__pgboss__' AND other.state::text IN ('created','retry','active') AND other.id<>e.id) RETURNING j.id) SELECT count(*) FROM changed")" || return 1
  [[ "${changed}" == 1 ]] || return 1
  projection="$(database_scalar "WITH exact_request AS (SELECT id FROM public.refund_requests WHERE payment_intent_id='${fixture_pi}' AND amount_minor=1 AND currency='eur' AND environment='sandbox') SELECT concat_ws('|',(SELECT count(*) FROM pgboss.job j JOIN exact_request r ON j.name='refunddesk_refund_execute' AND j.data->>'request_id'=r.id::text AND j.state::text='retry'),(SELECT count(*) FROM pgboss.job j WHERE j.name !~ '^__pgboss__' AND j.state::text IN ('created','retry','active') AND NOT EXISTS (SELECT 1 FROM exact_request r WHERE j.name='refunddesk_refund_execute' AND j.data->>'request_id'=r.id::text)))")" || return 1
  [[ "${projection}" == "1|0" ]]
}

resume_database_safe() {
  local capture
  capture="$(mktemp /run/refunddesk/incident-admission-resume-check-XXXXXXXX.json)" || return 1
  chmod 600 "${capture}" || { rm -f -- "${capture}"; return 1; }
  if capture_resume_state "${capture}"; then
    shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
    return 0
  fi
  shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
  return 1
}

database_state_pristine() {
  local capture pristine
  capture="$(mktemp /run/refunddesk/incident-admission-pristine-check-XXXXXXXX.json)" || return 1
  chmod 600 "${capture}" || { rm -f -- "${capture}"; return 1; }
  if ! capture_resume_state "${capture}"; then
    shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
    return 1
  fi
  pristine="$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1]))["pristine"]).lower())' "${capture}")" || {
    shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
    return 1
  }
  shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
  [[ "${pristine}" == true ]]
}

watchdog_marker_action() {
  local worker_id="$1" action="$2"
  python3 - "${WATCHDOG_MARKER}" "${EXPECTED_REVISION}" "${OPERATION}" "${worker_id}" \
    "${DEADLINE}" "${action}" <<'PY'
import hashlib,json,os,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]); revision,operation,worker,deadline,action=sys.argv[2:]
worker_hash=hashlib.sha256(worker.encode()).hexdigest(); expected={"armCount","deadline","expectedRevision","kind","operation","state","workerIdSha256"}
current=None
if path.exists():
    try: current=json.loads(path.read_text(encoding="utf-8"))
    except Exception: raise SystemExit(1)
    if set(current)!=expected or not isinstance(current.get("armCount"),int) or current["armCount"]<1 or current.get("kind")!="refunddesk.incident-admission.watchdog" or current.get("expectedRevision")!=revision or current.get("operation")!=operation or current.get("workerIdSha256")!=worker_hash or not isinstance(current.get("deadline"),str): raise SystemExit(1)
if action=="arm":
    if current is None: current={"armCount":1,"deadline":deadline,"expectedRevision":revision,"kind":"refunddesk.incident-admission.watchdog","operation":operation,"state":"armed","workerIdSha256":worker_hash}
    elif current["state"]=="armed" and current["deadline"]==deadline: pass
    elif current["state"] in {"armed","cancelled_contained","fenced","failed"}: current={**current,"armCount":current["armCount"]+1,"deadline":deadline,"state":"armed"}
    else: raise SystemExit(1)
elif action=="cancel":
    if current is None or current["state"] not in {"armed","fenced","failed","cancelled_contained"}: raise SystemExit(1)
    current={**current,"state":"cancelled_contained"}
elif action=="state":
    if current is None: raise SystemExit(1)
    print(current["state"]); raise SystemExit(0)
elif action=="describe":
    if current is None: raise SystemExit(1)
    print(current["state"]+"|"+current["deadline"]); raise SystemExit(0)
else: raise SystemExit(1)
raw=(json.dumps(current,sort_keys=True,separators=(",",":"))+"\n").encode(); temporary=None
path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
    fd,name=tempfile.mkstemp(prefix=path.name+".tmp-",dir=path.parent); temporary=pathlib.Path(name)
    with os.fdopen(fd,"wb") as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path); directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    if temporary is not None:
        try: temporary.unlink()
        except FileNotFoundError: pass
PY
}

watchdog_remove_units() {
  local base="$1" unit load active removed
  [[ "${base}" =~ ^refunddesk-incident-admission-[0-9a-f]{12}-[0-9a-f]{12}-watchdog$ ]] || return 1
  for unit in "${base}.timer" "${base}.service"; do
    load="$(systemctl show --property=LoadState --value "${unit}")" || return 1
    if [[ "${load}" == loaded ]]; then
      systemctl stop "${unit}" >/dev/null || return 1
      active="$(systemctl show --property=ActiveState --value "${unit}")" || return 1
      [[ "${active}" == inactive ]] || return 1
    elif [[ "${load}" != not-found ]]; then
      return 1
    fi
  done
  systemctl reset-failed "${base}.timer" "${base}.service" >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null || return 1
  for _ in {1..20}; do
    removed=true
    for unit in "${base}.timer" "${base}.service"; do
      load="$(systemctl show --property=LoadState --value "${unit}")" || return 1
      [[ "${load}" == not-found ]] || removed=false
    done
    [[ "${removed}" == true ]] && return 0
    sleep 0.1
  done
  return 1
}

watchdog_units_exact() {
  local timer service
  timer="$(systemctl show --property=AccuracyUSec --property=ActiveState --property=FragmentPath \
    --property=LoadState --property=NextElapseUSecRealtime --property=Unit "${WATCHDOG_UNIT}.timer")" || return 1
  service="$(systemctl show --property=ActiveState --property=ExecStart --property=FragmentPath \
    --property=Group --property=LoadState --property=Type --property=User "${WATCHDOG_UNIT}.service")" || return 1
  python3 - "${WATCHDOG_UNIT}" "${DEADLINE}" "${SOURCE_HOST_COMMAND}" "${EXPECTED_REVISION}" \
    "${OPERATION}" "$1" "${EXPECTED_HOST_COMMAND_SHA256}" 3<<<"${timer}" 4<<<"${service}" <<'PY'
import datetime,os,re,sys
base,deadline,source,revision,operation,worker,helper_sha=sys.argv[1:]
def values(fd,keys):
    result={}
    for line in os.fdopen(fd).read().splitlines():
        if "=" not in line: raise SystemExit(1)
        key,value=line.split("=",1)
        if key in result: raise SystemExit(1)
        result[key]=value
    if set(result)!=set(keys): raise SystemExit(1)
    return result
timer=values(3,{"AccuracyUSec","ActiveState","FragmentPath","LoadState","NextElapseUSecRealtime","Unit"})
service=values(4,{"ActiveState","ExecStart","FragmentPath","Group","LoadState","Type","User"})
try: expected=datetime.datetime.strptime(deadline,"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except Exception: raise SystemExit(1)
calendar_match=re.search(r"(20[0-9]{2}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) UTC$",timer["NextElapseUSecRealtime"])
if calendar_match is None or datetime.datetime.strptime("T".join(calendar_match.groups())+"Z","%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)!=expected: raise SystemExit(1)
expected_argv=" ".join(["/usr/bin/env","-i","HOME=/root","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","LC_ALL=C",source,"watchdog-fence",revision,operation,worker,helper_sha,deadline])
argv=re.search(r"argv\[\]=(.+?) ; ignore_errors=",service["ExecStart"])
ok=(timer["LoadState"]=="loaded" and timer["ActiveState"]=="active" and timer["Unit"]==base+".service" and timer["AccuracyUSec"] in {"1s","1000000"} and timer["FragmentPath"]=="/run/systemd/transient/"+base+".timer" and service["LoadState"]=="loaded" and service["ActiveState"]=="inactive" and service["Type"]=="oneshot" and service["User"] in {"","root"} and service["Group"] in {"","root"} and service["FragmentPath"]=="/run/systemd/transient/"+base+".service" and argv is not None and argv.group(1)==expected_argv)
raise SystemExit(0 if ok else 1)
PY
}

watchdog_start() {
  local worker_id="$1" marker_state description old_state old_deadline old_unit
  [[ "${worker_id}" =~ ^[0-9a-f]{64}$ && -f "${SOURCE_HOST_COMMAND}" && ! -L "${SOURCE_HOST_COMMAND}" &&
    "$(hash_file "${SOURCE_HOST_COMMAND}")" == "${EXPECTED_HOST_COMMAND_SHA256}" ]] || return 1
  python3 - "${DEADLINE}" <<'PY' || return 1
import datetime,sys
try: deadline=datetime.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except Exception: raise SystemExit(1)
remaining=(deadline-datetime.datetime.now(datetime.timezone.utc)).total_seconds()
raise SystemExit(0 if 30 <= remaining <= 900 else 1)
PY
  if [[ -e "${WATCHDOG_MARKER}" ]]; then
    description="$(watchdog_marker_action "${worker_id}" describe)" || return 1
    IFS='|' read -r old_state old_deadline <<<"${description}"
    [[ "${old_state}" =~ ^(armed|fenced|failed|cancelled_contained)$ &&
      "${old_deadline}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
    if [[ "${old_deadline}" != "${DEADLINE}" ]]; then
      old_unit="refunddesk-incident-admission-${OPERATION:0:12}-$(printf '%s' "${old_deadline}" | sha256sum | cut -c1-12)-watchdog"
      watchdog_remove_units "${old_unit}" || return 1
    fi
  fi
  watchdog_remove_units "${WATCHDOG_UNIT}" || return 1
  watchdog_marker_action "${worker_id}" arm || return 1
  marker_state="$(watchdog_marker_action "${worker_id}" state)" || return 1
  [[ "${marker_state}" == armed ]] || return 1
  systemd-run --quiet --unit="${WATCHDOG_UNIT}" --on-calendar="${DEADLINE}" \
    --timer-property=AccuracySec=1s /usr/bin/env -i HOME=/root \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C \
    "${SOURCE_HOST_COMMAND}" watchdog-fence "${EXPECTED_REVISION}" "${OPERATION}" \
      "${worker_id}" "${EXPECTED_HOST_COMMAND_SHA256}" "${DEADLINE}" >/dev/null || return 1
  watchdog_units_exact "${worker_id}"
}

watchdog_stop() {
  local worker_id="$1" marker_state unit load active
  marker_state="$(watchdog_marker_action "${worker_id}" state)" || return 1
  [[ "${marker_state}" =~ ^(armed|fenced|failed|cancelled_contained)$ ]] || return 1
  [[ "$(docker inspect --format '{{.Id}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "${worker_id}")" == "${worker_id}|false|no" ]] || return 1
  for unit in "${WATCHDOG_UNIT}.timer" "${WATCHDOG_UNIT}.service"; do
    load="$(systemctl show --property=LoadState --value "${unit}")" || return 1
    if [[ "${load}" == loaded ]]; then
      systemctl stop "${unit}" >/dev/null || return 1
      active="$(systemctl show --property=ActiveState --value "${unit}")" || return 1
      [[ "${active}" == inactive ]] || return 1
    elif [[ "${load}" != not-found ]]; then
      return 1
    fi
  done
  [[ "$(docker inspect --format '{{.Id}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "${worker_id}")" == "${worker_id}|false|no" ]] || return 1
  watchdog_marker_action "${worker_id}" cancel
}

stop_worker() {
  local id unit load active
  id="$(service_container_id worker)" || return 1
  [[ "${id}" == "$(promotion_field runtime.workerContainerId)" ]] || return 1
  docker update --restart=no "${id}" >/dev/null || return 1
  if [[ "$(docker inspect --format '{{.State.Running}}' "${id}")" == true ]]; then
    docker stop --time 45 "${id}" >/dev/null || return 1
  fi
  if [[ -e "${WATCHDOG_MARKER}" ]]; then
    watchdog_stop "${id}" || return 1
  else
    for unit in "${WATCHDOG_UNIT}.timer" "${WATCHDOG_UNIT}.service"; do
      load="$(systemctl show --property=LoadState --value "${unit}")" || return 1
      if [[ "${load}" == loaded ]]; then
        systemctl stop "${unit}" >/dev/null || return 1
        active="$(systemctl show --property=ActiveState --value "${unit}")" || return 1
        [[ "${active}" == inactive ]] || return 1
      elif [[ "${load}" != not-found ]]; then
        return 1
      fi
    done
    [[ "$(docker inspect --format '{{.Id}}|{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}' "${id}")" == "${id}|false|no" ]] || return 1
  fi
  runtime_inventory_exact false
}

proof_input_json() {
  local phase="$1" resume_state_path="$2"
  python3 - "${FIXTURE_PATH}" "${PLATFORM_ENV}" "${WORKER_ENV}" \
    "${OPERATION}" "${phase}" "${HOST_STATE}" "${resume_state_path}" <<'PY'
import json,os,pathlib,sys
fixture,platform,worker,operation,phase,state_path,resume_state_path=sys.argv[1:]
def env(path):
    result={}
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key,value=line.split("=",1)
            if key in result: raise SystemExit(1)
            result[key]=value
    return result
f=json.loads(pathlib.Path(fixture).read_text(encoding="utf-8")); p=env(platform); w=env(worker); state=json.loads(pathlib.Path(state_path).read_text(encoding="utf-8")); resume_state=json.loads(pathlib.Path(resume_state_path).read_text(encoding="utf-8"))
baseline=state["stripeBaseline"] if phase=="effect" else None
if phase not in {"baseline","effect"} or (phase=="effect" and not isinstance(baseline,dict)) or set(resume_state)!={"bounded","databaseProjectionSha256","pristine","refundIdSha256","refundLinked","terminalExact"} or resume_state["bounded"] is not True: raise SystemExit(1)
value={"accountId":p["STRIPE_MANAGED_SANDBOX_ACCOUNT_ID"],"amountMinor":f["amountMinor"],"approverUserId":f["approverUserId"],"appSigningSecret":w["STRIPE_APP_SIGNING_SECRET"],"currency":f["currency"],"deadline":os.environ["REFUNDDESK_INCIDENT_DEADLINE"],"denialPaymentIntentId":f["denialPaymentIntentId"],"operation":operation,"phase":phase,"readKey":p["STRIPE_MANAGED_SANDBOX_READ_KEY"],"refundablePaymentIntentId":f["refundablePaymentIntentId"],"requesterUserId":f["requesterUserId"],"resume":os.environ.get("REFUNDDESK_INCIDENT_RESUME")=="true","resumeState":resume_state,"stripeBaseline":baseline}
sys.stdout.write(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n")
PY
}

stripe_baseline_present() {
  python3 - "${HOST_STATE}" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8"))
raise SystemExit(0 if isinstance(v.get("stripeBaseline"),dict) else 1)
PY
}

persist_stripe_baseline() {
  local capture="$1"
  python3 - "${HOST_STATE}" "${capture}" <<'PY'
import json,os,pathlib,re,sys,tempfile
path=pathlib.Path(sys.argv[1]); capture=pathlib.Path(sys.argv[2])
state=json.loads(path.read_text(encoding="utf-8")); proof=json.loads(capture.read_text(encoding="utf-8"))
expected={"accountExact","complete","denialRefundCount","denialRefundSetSha256","readChargeSucceeded","readPaymentIntentSucceeded","readRefundCreateDenied","refundableRefundCount","refundableRefundSetSha256"}
if set(proof)!=expected or any(proof[k] is not True for k in ("accountExact","complete","readChargeSucceeded","readPaymentIntentSucceeded","readRefundCreateDenied")): raise SystemExit(1)
baseline={k:proof[k] for k in ("denialRefundCount","denialRefundSetSha256","refundableRefundCount","refundableRefundSetSha256")}
if any(not isinstance(baseline[k],int) or baseline[k]<0 for k in ("denialRefundCount","refundableRefundCount")) or baseline["denialRefundCount"]<1 or any(not isinstance(baseline[k],str) or re.fullmatch(r"[0-9a-f]{64}",baseline[k]) is None for k in ("denialRefundSetSha256","refundableRefundSetSha256")): raise SystemExit(1)
if state.get("stripeBaseline") not in (None,baseline): raise SystemExit(1)
if state.get("stripeBaseline")==baseline: raise SystemExit(0)
state["stripeBaseline"]=baseline; raw=(json.dumps(state,sort_keys=True,separators=(",",":"))+"\n").encode()
fd,name=tempfile.mkstemp(prefix=path.name+".tmp-",dir=path.parent); temporary=pathlib.Path(name)
try:
    with os.fdopen(fd,"wb") as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path); directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    try: temporary.unlink()
    except FileNotFoundError: pass
PY
}

terminate_proof_client() {
  local web_id="$1" target="$2" signal remaining
  [[ "${web_id}" =~ ^[0-9a-f]{64}$ &&
    "${target}" == "/tmp/refunddesk-incident-admission-${OPERATION:0:16}/proof-client.mjs" ]] || return 1
  for signal in TERM KILL; do
    docker exec --user 0 "${web_id}" node -e '
      const { basename } = require("node:path");
      const { readdirSync, readFileSync } = require("node:fs");
      const target = process.argv[1];
      const signal = process.argv[2];
      for (const entry of readdirSync("/proc")) {
        if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue;
        let fields;
        try { fields = readFileSync(`/proc/${entry}/cmdline`).toString("utf8").split("\0").filter(Boolean); } catch { continue; }
        if (fields.length >= 2 && basename(fields[0]) === "node" && fields[1] === target) {
          try { process.kill(Number(entry), signal); } catch (error) { if (error.code !== "ESRCH") process.exit(1); }
        }
      }
    ' "${target}" "${signal}" >/dev/null || return 1
    for _ in {1..10}; do
      remaining="$(docker exec --user 0 "${web_id}" node -e '
        const { basename } = require("node:path");
        const { readdirSync, readFileSync } = require("node:fs");
        const target = process.argv[1]; let count = 0;
        for (const entry of readdirSync("/proc")) {
          if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue;
          let fields;
          try { fields = readFileSync(`/proc/${entry}/cmdline`).toString("utf8").split("\0").filter(Boolean); } catch { continue; }
          if (fields.length >= 2 && basename(fields[0]) === "node" && fields[1] === target) count += 1;
        }
        process.stdout.write(String(count));
      ' "${target}")" || return 1
      [[ "${remaining}" =~ ^[0-9]+$ ]] || return 1
      (( remaining == 0 )) && return 0
      sleep 1
    done
  done
  return 1
}

terminal_refund_binding_exact() {
  local proof_path="$1" capture
  capture="$(mktemp /run/refunddesk/incident-admission-terminal-binding-XXXXXXXX.json)" || return 1
  chmod 600 "${capture}" || { rm -f -- "${capture}"; return 1; }
  if ! capture_resume_state "${capture}" ||
    ! python3 - "${proof_path}" "${capture}" <<'PY'
import json,re,sys
proof=json.load(open(sys.argv[1],encoding="utf-8")); state=json.load(open(sys.argv[2],encoding="utf-8"))
digest=proof.get("refundIdSha256")
ok=(isinstance(digest,str) and re.fullmatch(r"[0-9a-f]{64}",digest) is not None and
    state.get("bounded") is True and state.get("refundLinked") is True and
    state.get("terminalExact") is True and state.get("refundIdSha256")==digest)
raise SystemExit(0 if ok else 1)
PY
  then
    shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
    return 1
  fi
  shred -u -- "${capture}" 2>/dev/null || rm -f -- "${capture}"
}

run_proof_client() {
  local phase="$1" destination="$2" resume_state_path="$3" web_id target target_dir timeout_seconds cleanup_status proof_client_size
  local -a statuses
  web_id="$(service_container_id web)" || return 98
  [[ "${web_id}" == "$(promotion_field runtime.webContainerId)" ]] || return 98
  target_dir="/tmp/refunddesk-incident-admission-${OPERATION:0:16}"
  target="${target_dir}/proof-client.mjs"
  timeout_seconds="$(python3 - "${DEADLINE}" "${phase}" <<'PY'
import datetime,sys
try: deadline=datetime.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except Exception: raise SystemExit(1)
remaining=int((deadline-datetime.datetime.now(datetime.timezone.utc)).total_seconds())-45
cap=420 if sys.argv[2]=="effect" else 120 if sys.argv[2]=="baseline" else 0
if remaining<1 or cap<1: raise SystemExit(1)
print(min(remaining,cap))
PY
)" || return 98
  [[ "${timeout_seconds}" =~ ^[1-9][0-9]{0,2}$ && "${timeout_seconds}" -le 420 ]] || return 98
  if docker exec --user 0 "${web_id}" test -e "${target_dir}"; then
    [[ "$(docker exec --user 0 "${web_id}" stat --format='%u:%g:%a:%F' -- "${target_dir}")" == "0:0:700:directory" ]] || return 98
    docker exec --user 0 "${web_id}" test ! -L "${target_dir}" || return 98
    if docker exec --user 0 "${web_id}" test -e "${target}"; then
      [[ "$(docker exec --user 0 "${web_id}" stat --format='%u:%g:%a:%F' -- "${target}")" == "0:0:400:regular file" ]] || return 98
      docker exec --user 0 "${web_id}" test ! -L "${target}" || return 98
      docker exec --user 0 "${web_id}" rm -f -- "${target}" >/dev/null || return 98
    fi
    docker exec --user 0 "${web_id}" rmdir -- "${target_dir}" >/dev/null || return 98
  fi
  docker exec --user 0 "${web_id}" mkdir --mode=700 -- "${target_dir}" >/dev/null || return 98
  [[ "$(docker exec --user 0 "${web_id}" stat --format='%u:%g:%a:%F' -- "${target_dir}")" == "0:0:700:directory" ]] || return 98
  docker exec --user 0 "${web_id}" test ! -L "${target_dir}" || return 98
  proof_client_size="$(stat --format='%s' -- "${PROOF_CLIENT_PATH}")" || return 98
  [[ "${proof_client_size}" =~ ^[1-9][0-9]{0,5}$ && "${proof_client_size}" -le 131072 ]] || return 98
  if ! timeout --signal=TERM --kill-after=5 30 docker exec --interactive --user 0 "${web_id}" node -e '
    const {createHash}=require("node:crypto"),{closeSync,constants,fstatSync,fsyncSync,openSync,unlinkSync,writeSync}=require("node:fs");
    const path=process.argv[1],expected=process.argv[2],expectedSize=Number(process.argv[3]); let fd,created=false,count=0; const hash=createHash("sha256");
    (async()=>{try {
      if (!Number.isSafeInteger(expectedSize)||expectedSize<1||expectedSize>131072||!/^[0-9a-f]{64}$/.test(expected)) process.exit(98);
      fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400); created=true;
      for await (const chunk of process.stdin) { count+=chunk.length; if(count>expectedSize) throw new Error(); hash.update(chunk); let offset=0; while(offset<chunk.length) offset+=writeSync(fd,chunk,offset,chunk.length-offset); }
      fsyncSync(fd); const stat=fstatSync(fd); if(count!==expectedSize||hash.digest("hex")!==expected||!stat.isFile()||stat.uid!==0||stat.gid!==0||(stat.mode&0o777)!==0o400||stat.size!==expectedSize) throw new Error();
      closeSync(fd); fd=undefined; process.exit(0);
    } catch { if(fd!==undefined){try{closeSync(fd)}catch{}} if(created){try{unlinkSync(path)}catch{}} process.exit(98); }})();
  ' "${target}" "${PROOF_CLIENT_SHA256}" "${proof_client_size}" <"${PROOF_CLIENT_PATH}" >/dev/null; then
    docker exec --user 0 "${web_id}" rm -f -- "${target}" >/dev/null || return 98
    docker exec --user 0 "${web_id}" rmdir -- "${target_dir}" >/dev/null || return 98
    docker exec "${web_id}" test ! -e "${target}" || return 98
    return 98
  fi
  cleanup_status=0
  if [[ "$(docker exec --user 0 "${web_id}" stat --format='%u:%g:%a:%s:%F' -- "${target}")" != "0:0:400:${proof_client_size}:regular file" ]] ||
    ! docker exec --user 0 "${web_id}" test ! -L "${target}"; then
    statuses=(98 98)
  else
    proof_input_json "${phase}" "${resume_state_path}" |
      timeout --signal=TERM --kill-after=5 "${timeout_seconds}" docker exec --interactive --user 0 "${web_id}" node -e '
        const {createHash}=require("node:crypto"),{closeSync,constants,fstatSync,openSync,readSync}=require("node:fs"),{spawnSync}=require("node:child_process");
        const path=process.argv[1],expected=process.argv[2]; let fd;
        try {
          fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW); const stat=fstatSync(fd);
          if (!stat.isFile() || stat.uid!==0 || stat.gid!==0 || (stat.mode&0o777)!==0o400) process.exit(98);
          const hash=createHash("sha256"),buffer=Buffer.alloc(16384); let count;
          while ((count=readSync(fd,buffer,0,buffer.length,null))>0) hash.update(buffer.subarray(0,count));
          if (hash.digest("hex")!==expected) process.exit(98);
        } catch { process.exit(98); } finally { if (fd!==undefined) closeSync(fd); }
        const child=spawnSync(process.execPath,[path],{stdio:["inherit","inherit","inherit"]});
        if (child.error) process.exit(98); if (child.signal) process.kill(process.pid,child.signal); process.exit(child.status??98);
      ' "${target}" "${PROOF_CLIENT_SHA256}" >"${destination}"
    statuses=("${PIPESTATUS[@]}")
  fi
  terminate_proof_client "${web_id}" "${target}" || cleanup_status=98
  docker exec --user 0 "${web_id}" rm -f -- "${target}" >/dev/null || cleanup_status=98
  docker exec --user 0 "${web_id}" rmdir -- "${target_dir}" >/dev/null || cleanup_status=98
  docker exec "${web_id}" test ! -e "${target}" || cleanup_status=98
  docker exec "${web_id}" test ! -e "${target_dir}" || cleanup_status=98
  (( cleanup_status == 0 )) || return 98
  (( statuses[0] == 0 )) || return 98
  if [[ "${statuses[1]}" =~ ^(124|137|143)$ ]]; then return 75; fi
  return "${statuses[1]}"
}

canonical_capture() {
  python3 - "$1" <<'PY'
import json,pathlib,sys
raw=pathlib.Path(sys.argv[1]).read_bytes()
if not raw.endswith(b"\n") or raw.count(b"\n")!=1 or b"\r" in raw or b"\0" in raw or raw.startswith(b"\xef\xbb\xbf"): raise SystemExit(1)
value=json.loads(raw[:-1].decode()); expected=(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
if raw!=expected or any(x in raw for x in (b"sk_test_",b"rk_test_",b"absec_",b"pi_",b"ch_",b"re_",b"usr_",b"acct_")): raise SystemExit(1)
PY
}

postflight_financial_exact() {
  host_state_bound || return 1
  local baseline baseline_time fixture_pi value sql resume_capture
  resume_capture="$(mktemp /run/refunddesk/incident-admission-postflight-resume-XXXXXXXX.json)" || return 1
  chmod 600 "${resume_capture}" || { rm -f -- "${resume_capture}"; return 1; }
  if ! capture_resume_state "${resume_capture}" ||
    [[ "$(python3 -c 'import json,sys;print(str(json.load(open(sys.argv[1]))["terminalExact"]).lower())' "${resume_capture}")" != true ]]; then
    shred -u -- "${resume_capture}" 2>/dev/null || rm -f -- "${resume_capture}"
    return 1
  fi
  shred -u -- "${resume_capture}" 2>/dev/null || rm -f -- "${resume_capture}"
  baseline="$(python3 - "${HOST_STATE}" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8")); names=["refundRequestsBefore","auditEventsBefore","refundExecutionsBefore","refundAttemptsBefore","approvalDecisionsBefore","approvalAttestationsBefore","mutationReceiptsBefore","webhookReceiptsBefore","correlationCandidatesBefore","externalAlertsBefore"]
print("|".join(str(v[name]) for name in names))
PY
)" || return 1
  [[ "${baseline}" =~ ^([0-9]+\|){9}[0-9]+$ ]] || return 1
  baseline_time="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["capturedAt"])' "${HOST_STATE}")" || return 1
  [[ "${baseline_time}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  fixture_pi="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["refundablePaymentIntentId"])' "${FIXTURE_PATH}")" || return 1
  [[ "${fixture_pi}" =~ ^pi_[A-Za-z0-9]{6,64}$ ]] || return 1
  sql="SELECT concat_ws('|',(SELECT count(*) FROM public.refund_requests),(SELECT count(*) FROM public.audit_events),(SELECT count(*) FROM public.refund_executions),(SELECT count(*) FROM public.refund_execution_attempts),(SELECT count(*) FROM public.approval_decisions),(SELECT count(*) FROM public.approval_attestations),(SELECT count(*) FROM public.api_mutation_receipts),(SELECT count(*) FROM public.webhook_receipts),(SELECT count(*) FROM public.refund_correlation_candidates),(SELECT count(*) FROM public.external_refund_alerts),(SELECT count(*) FROM public.refund_requests WHERE payment_intent_id='${fixture_pi}' AND workflow_status='succeeded' AND payment_guard_released_at IS NOT NULL),(SELECT count(*) FROM public.refund_executions e JOIN public.refund_requests r ON r.id=e.request_id AND r.tenant_id=e.tenant_id WHERE r.payment_intent_id='${fixture_pi}' AND e.idempotency_key='refunddesk:refund-request:'||r.id::text||':v1' AND e.stripe_refund_id IS NOT NULL AND e.stripe_refund_status='succeeded' AND e.reconciled_at IS NOT NULL),(SELECT count(*) FROM public.refund_execution_attempts a JOIN public.refund_executions e ON e.id=a.execution_id AND e.tenant_id=a.tenant_id JOIN public.refund_requests r ON r.id=e.request_id AND r.tenant_id=e.tenant_id WHERE r.payment_intent_id='${fixture_pi}' AND a.state='completed'),(SELECT count(*) FROM pgboss.job WHERE name !~ '^__pgboss__' AND state::text IN ('created','retry','active')),(SELECT count(*) FROM pg_catalog.pg_prepared_xacts),(SELECT count(*) FROM public.audit_events a WHERE a.occurred_at >= '${baseline_time}'::timestamptz AND NOT ((a.action IN ('refund_request.created','refund_request.approved') AND a.entity_id IN (SELECT r.id::text FROM public.refund_requests r WHERE r.payment_intent_id='${fixture_pi}')) OR (a.action IN ('refund.observed','refund.linked_status_refreshed') AND a.entity_id IN (SELECT e.stripe_refund_id FROM public.refund_executions e JOIN public.refund_requests r ON r.id=e.request_id AND r.tenant_id=e.tenant_id WHERE r.payment_intent_id='${fixture_pi}')))),(SELECT count(*) FROM public.refund_requests WHERE payment_guard_released_at IS NULL))"
  value="$(database_scalar "${sql}")" || return 1
  POST_INCIDENT_BASELINE_JSON="$(python3 - "${baseline}" "${value}" <<'PY'
import hashlib,json,sys
before=list(map(int,sys.argv[1].split("|"))); after=list(map(int,sys.argv[2].split("|")))
if len(before)!=10 or len(after)!=17: raise SystemExit(1)
# One request, execution, attempt, decision and attestation; exactly two durable
# API mutation receipts; no webhook/correlation/alert or foreign concurrent row.
expected=[1,None,1,1,1,1,2,0,0,0]
for index,delta in enumerate(expected):
    if delta is not None and after[index]-before[index]!=delta: raise SystemExit(1)
if after[1]-before[1] < 2 or after[1]-before[1] > 4: raise SystemExit(1)
if after[10:16] != [1,1,1,0,0,0] or after[16] != 0: raise SystemExit(1)
counts={"activeFinancialJobs":after[13],"auditEvents":after[1],"mutationReceipts":after[6],"refundExecutionAttempts":after[3],"refundExecutions":after[2],"refundRequests":after[0],"unreleasedPaymentGuards":after[16],"webhookReceipts":after[7]}
canonical=json.dumps(counts,sort_keys=True,separators=(",",":"))
counts["snapshotSha256"]=hashlib.sha256(canonical.encode("ascii")).hexdigest()
print(json.dumps(counts,sort_keys=True,separators=(",",":")))
PY
  )" || return 1
  [[ "${POST_INCIDENT_BASELINE_JSON}" =~ ^\{.*\}$ ]] || return 1
}

promotion_document_bound() {
  python3 - "${PROMOTION_PATH}" "${EXPECTED_REVISION}" <<'PY'
import json,re,sys
v=json.load(open(sys.argv[1],encoding="utf-8")); revision=sys.argv[2]
runtime=v.get("runtime") if isinstance(v,dict) else None; inputs=v.get("inputs") if isinstance(v,dict) else None
runtime_keys={"caddyContainerId","postgresContainerId","verifierContainerId","webContainerId","workerContainerId","workerRuntimeMode"}
input_keys={"bundleSha256","manifestSha256","provenanceSha256","sourceSha256"}
ids=[runtime.get(key) for key in ("caddyContainerId","postgresContainerId","verifierContainerId","webContainerId","workerContainerId")] if isinstance(runtime,dict) else []
ok=(v.get("schemaVersion")==1 and v.get("kind")=="refunddesk-contained-promotion" and v.get("result")=="PASS" and v.get("code")=="PASS_CONTAINED_CANDIDATE_PROMOTED" and v.get("phase")=="complete" and v.get("revision")==revision and isinstance(runtime,dict) and set(runtime)==runtime_keys and runtime.get("workerRuntimeMode")=="incident_admission" and len(set(ids))==5 and all(isinstance(x,str) and re.fullmatch(r"[0-9a-f]{64}",x) for x in ids) and isinstance(inputs,dict) and set(inputs)==input_keys and all(isinstance(x,str) and re.fullmatch(r"[0-9a-f]{64}",x) for x in inputs.values()))
raise SystemExit(0 if ok else 1)
PY
}

for tool in python3 sha256sum stat docker systemctl systemd-run ss timeout sort wc readlink mktemp shred sleep cut date; do
  command -v "${tool}" >/dev/null 2>&1 || fail_closed
done
[[ "${DASHBOARD_PATH}" == /run/refunddesk/incident-admission-* &&
  "${FIXTURE_PATH}" == /run/refunddesk/incident-admission-* &&
  "${PROMOTION_PATH}" == /run/refunddesk/incident-admission-* &&
  "${PROOF_CLIENT_PATH}" == /run/refunddesk/incident-admission-* &&
  "${PROOF_CLIENT_SHA256}" =~ ^[0-9a-f]{64}$ &&
  "${EXPECTED_HOST_COMMAND_SHA256}" =~ ^[0-9a-f]{64}$ &&
  "${DEADLINE}" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
  "${EXPECTED_COMPOSE_SHA256}" =~ ^[0-9a-f]{64}$ &&
  "${SOURCE_ROOT}" == "/opt/refunddesk/releases/${EXPECTED_REVISION}/source" ]] || fail_closed
controlled_secret_file "${DASHBOARD_PATH}" || fail_closed
controlled_secret_file "${FIXTURE_PATH}" || fail_closed
controlled_secret_file "${PROMOTION_PATH}" || fail_closed
controlled_source_file "${PROOF_CLIENT_PATH}" || fail_closed
controlled_source_file "${SOURCE_HOST_COMMAND}" || fail_closed
controlled_secret_file "${PLATFORM_ENV}" || fail_closed
controlled_secret_file "${WORKER_ENV}" || fail_closed
controlled_secret_file "${RELEASE_ENV}" || fail_closed
[[ "$(hash_file "${PROOF_CLIENT_PATH}")" == "${PROOF_CLIENT_SHA256}" ]] || fail_closed
[[ "$(hash_file "${SOURCE_HOST_COMMAND}")" == "${EXPECTED_HOST_COMMAND_SHA256}" ]] || fail_closed
promotion_document_bound || fail_closed

case "${ACTION}" in
  preflight)
    binding="$(binding_observation)" || fail_closed
    source_ok=false; revision_ok=false; caddy_ok=false; worker_ok=false; units_ok=false
    listeners_ok=false; live_ok=false; core_ok=false; financial_ok=false
    if source_exact; then source_ok=true; revision_ok=true; fi
    if container_stopped caddy; then caddy_ok=true; fi
    if container_stopped worker; then worker_ok=true; fi
    if units_stopped; then units_ok=true; fi
    if listeners_closed; then listeners_ok=true; fi
    if [[ "$(python3 -c 'import json,sys;print(str(json.load(sys.stdin)["liveDisabled"]).lower())' <<<"${binding}")" == true ]]; then live_ok=true; fi
    if core_healthy; then core_ok=true; fi
    if [[ "${REFUNDDESK_INCIDENT_RESUME:-false}" == true ]]; then
      if resume_database_safe; then financial_ok=true; fi
    elif database_quiescent; then financial_ok=true; fi
    python3 - "${binding}" "${source_ok}" "${revision_ok}" "${caddy_ok}" "${worker_ok}" \
      "${units_ok}" "${listeners_ok}" "${live_ok}" "${core_ok}" "${financial_ok}" <<'PY'
import json,sys
b=json.loads(sys.argv[1]); f=lambda n:sys.argv[n]=="true"
b.update({"caddyStopped":f(4),"coreStable":f(9),"financialQuiescent":f(10),"liveDisabled":f(8),"maintenanceStopped":f(6),"publicListenersClosed":f(7),"revisionExact":f(3),"sourceExact":f(2),"workerStopped":f(5)})
sys.stdout.write(json.dumps(b,sort_keys=True,separators=(",",":"))+"\n")
PY
    ;;
  prepare-state)
    adopted=false
    bindings_exact || fail_closed
    source_exact || fail_closed
    runtime_inventory_exact false || fail_closed
    units_stopped || fail_closed
    listeners_closed || fail_closed
    if [[ -e "${HOST_STATE}" ]]; then
      adopted=true
      host_state_bound || fail_closed
      if [[ "${REFUNDDESK_INCIDENT_RESUME:-false}" == true ]]; then
        resume_database_safe || fail_closed
      else
        database_state_pristine || fail_closed
      fi
    else
      [[ "${REFUNDDESK_INCIDENT_RESUME:-false}" != true ]] || fail_closed
      database_quiescent || fail_closed
      write_host_state || fail_closed
      host_state_bound || fail_closed
      database_state_pristine || fail_closed
    fi
    if [[ "${adopted}" == true ]]; then
      emit '{"prepared":true,"resumed":true}'
    else
      emit '{"prepared":true,"resumed":false}'
    fi
    ;;
  start-worker)
    bindings_exact || fail_closed
    source_exact || fail_closed
    runtime_inventory_exact false || fail_closed
    units_stopped || fail_closed
    listeners_closed || fail_closed
    host_state_bound || fail_closed
    resume_database_safe || fail_closed
    recover_exact_job_for_resume || fail_closed
    resume_database_safe || fail_closed
    worker_id="$(service_container_id worker)" || fail_closed
    [[ "${worker_id}" == "$(promotion_field runtime.workerContainerId)" ]] || fail_closed
    docker update --restart=no "${worker_id}" >/dev/null || fail_closed
    runtime_inventory_exact false || fail_closed
    watchdog_start "${worker_id}" || fail_closed
    docker start "${worker_id}" >/dev/null || {
      stop_worker || true
      fail_closed
    }
    [[ "$(service_container_id worker)" == "${worker_id}" ]] || fail_closed
    docker update --restart=no "${worker_id}" >/dev/null || fail_closed
    ready=false
    for _ in {1..60}; do
      [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${worker_id}")" == healthy ]] && { ready=true; break; }
      sleep 1
    done
    [[ "${ready}" == true && "$(systemctl show --property=ActiveState --value "${WATCHDOG_UNIT}.timer")" == active ]] || fail_closed
    runtime_inventory_exact true || fail_closed
    units_stopped || fail_closed
    listeners_closed || fail_closed
    emit '{"started":true}'
    ;;
  proof)
    host_state_bound || fail_closed
    bindings_exact || fail_closed
    source_exact || fail_closed
    runtime_inventory_exact true || fail_closed
    worker_id="$(service_container_id worker)" || fail_closed
    [[ "${worker_id}" == "$(promotion_field runtime.workerContainerId)" ]] || fail_closed
    resume_state="$(mktemp /run/refunddesk/incident-admission-resume-XXXXXXXX.json)" || fail_closed
    chmod 600 "${resume_state}" || fail_closed
    trap 'shred -u -- "${resume_state}" 2>/dev/null || rm -f -- "${resume_state}"' EXIT
    capture_resume_state "${resume_state}" || fail_closed
    if ! stripe_baseline_present; then
      baseline_output="$(mktemp /run/refunddesk/incident-admission-baseline-XXXXXXXX.json)" || fail_closed
      chmod 600 "${baseline_output}" || fail_closed
      trap 'shred -u -- "${baseline_output}" "${resume_state}" 2>/dev/null || rm -f -- "${baseline_output}" "${resume_state}"' EXIT
      run_proof_client baseline "${baseline_output}" "${resume_state}" || fail_closed
      [[ $(stat --format='%s' -- "${baseline_output}") -le MAX_CAPTURE_BYTES ]] || fail_closed
      canonical_capture "${baseline_output}" || fail_closed
      persist_stripe_baseline "${baseline_output}" || fail_closed
      shred -u -- "${baseline_output}" 2>/dev/null || rm -f -- "${baseline_output}"
      trap 'shred -u -- "${resume_state}" 2>/dev/null || rm -f -- "${resume_state}"' EXIT
    fi
    host_state_bound || fail_closed
    capture_resume_state "${resume_state}" || fail_closed
    proof_output="$(mktemp /run/refunddesk/incident-admission-result-XXXXXXXX.json)" || fail_closed
    chmod 600 "${proof_output}"
    trap 'shred -u -- "${proof_output}" "${resume_state}" 2>/dev/null || rm -f -- "${proof_output}" "${resume_state}"' EXIT
    if run_proof_client effect "${proof_output}" "${resume_state}"; then status=0; else status=$?; fi
    [[ $(stat --format='%s' -- "${proof_output}") -le MAX_CAPTURE_BYTES ]] || fail_closed
    canonical_capture "${proof_output}" || fail_closed
    if (( status == 0 )); then
      terminal_refund_binding_exact "${proof_output}" || fail_closed
    fi
    cat -- "${proof_output}"
    exit "${status}"
    ;;
  stop-worker)
    if stop_worker; then emit '{"stopped":true}'; else fail_closed; fi
    ;;
  postflight)
    binding="$(binding_observation)" || fail_closed
    financial_delta=false
    if postflight_financial_exact; then financial_delta=true; fi
    source_ok=false; caddy_ok=false; worker_ok=false; units_ok=false; listeners_ok=false; core_ok=false; financial_ok=false
    if source_exact; then source_ok=true; fi
    if container_stopped caddy; then caddy_ok=true; fi
    if container_stopped worker; then worker_ok=true; fi
    if units_stopped; then units_ok=true; fi
    if listeners_closed; then listeners_ok=true; fi
    if core_healthy; then core_ok=true; fi
    if database_quiescent; then financial_ok=true; fi
    python3 - "${binding}" "${source_ok}" "${caddy_ok}" "${worker_ok}" "${units_ok}" \
      "${listeners_ok}" "${core_ok}" "${financial_ok}" "${financial_delta}" \
      "${POST_INCIDENT_BASELINE_JSON:-null}" <<'PY'
import json,sys
b=json.loads(sys.argv[1]); f=lambda n:sys.argv[n]=="true"
b.update({"caddyStopped":f(3),"coreStable":f(7),"financialDeltaExact":f(9),"financialQuiescent":f(8),"maintenanceStopped":f(5),"postIncidentBaseline":json.loads(sys.argv[10]),"publicListenersClosed":f(6),"refundCount":1 if f(9) else 0,"revisionExact":f(2),"sourceExact":f(2),"workerStarts":1,"workerStops":1,"workerStopped":f(4),"workflowCount":1 if f(9) else 0})
sys.stdout.write(json.dumps(b,sort_keys=True,separators=(",",":"))+"\n")
PY
    ;;
esac
