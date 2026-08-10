#!/usr/bin/env bash

# ADR 0036 one-operation admission.  Public ingress, Caddy, timers and live mode
# are never enabled by this runner.  All diagnostics leaving stdout are codes.

set -uo pipefail
set +x
set +a
umask 077
export LC_ALL=C

readonly EXIT_FAIL=20
readonly EXIT_INCOMPLETE=21
readonly EXIT_USAGE=64
readonly MAX_INPUT_BYTES=131072
readonly MAX_HOST_BYTES=32768

if (( $# != 34 )) ||
  [[ "$1" != "--nonce" || "$3" != "--expected-revision" || "$5" != "--repository-head" ||
    "$7" != "--runner-sha256" || "$9" != "--promotion-sha256" ||
    "${11}" != "--postflight-sha256" || "${13}" != "--dashboard-sha256" ||
    "${15}" != "--fixture-sha256" || "${17}" != "--validator-path" ||
    "${19}" != "--validator-sha256" || "${21}" != "--host-command-path" ||
    "${23}" != "--host-command-sha256" || "${25}" != "--proof-client-path" ||
    "${27}" != "--proof-client-sha256" || "${29}" != "--compose-sha256" ||
    "${31}" != "--promotion-validator-path" || "${33}" != "--promotion-validator-sha256" ||
    ! "$2" =~ ^[0-9a-f]{64}$ ||
    ! "$4" =~ ^[0-9a-f]{40}$ || ! "$6" =~ ^[0-9a-f]{40}$ ||
    ! "$8" =~ ^[0-9a-f]{64}$ || ! "${10}" =~ ^[0-9a-f]{64}$ ||
    ! "${12}" =~ ^[0-9a-f]{64}$ || ! "${14}" =~ ^[0-9a-f]{64}$ ||
    ! "${16}" =~ ^[0-9a-f]{64}$ || -z "${18}" || ! "${20}" =~ ^[0-9a-f]{64}$ ||
    -z "${22}" || ! "${24}" =~ ^[0-9a-f]{64}$ || -z "${26}" ||
    ! "${28}" =~ ^[0-9a-f]{64}$ || ! "${30}" =~ ^[0-9a-f]{64}$ ||
    -z "${32}" || ! "${34}" =~ ^[0-9a-f]{64}$ ]]; then
  exit "${EXIT_USAGE}"
fi

readonly NONCE="$2"
readonly EXPECTED_REVISION="$4"
readonly REPOSITORY_HEAD="$6"
readonly RUNNER_SHA256="$8"
readonly PROMOTION_SHA256="${10}"
readonly POSTFLIGHT_SHA256="${12}"
readonly DASHBOARD_SHA256="${14}"
readonly FIXTURE_SHA256="${16}"
readonly VALIDATOR="${18}"
readonly VALIDATOR_SHA256="${20}"
readonly HOST_COMMAND="${22}"
readonly HOST_COMMAND_SHA256="${24}"
readonly PROOF_CLIENT="${26}"
readonly PROOF_CLIENT_SHA256="${28}"
readonly COMPOSE_SHA256="${30}"
readonly PROMOTION_VALIDATOR="${32}"
readonly PROMOTION_VALIDATOR_SHA256="${34}"

# Raw command failures can contain paths, identifiers or secret-bearing output.
exec 2>/dev/null

TEST_MODE=false
if [[ "${REFUNDDESK_INCIDENT_ADMISSION_TEST_MODE:-}" == "1" ]]; then
  TEST_MODE=true
  (( EUID != 0 )) || exit "${EXIT_USAGE}"
  ROOT="${REFUNDDESK_INCIDENT_ADMISSION_ROOT:-}"
  CONTROL_ROOT="${REFUNDDESK_INCIDENT_ADMISSION_CONTROL_ROOT:-}"
  OPERATOR_LOCK="${REFUNDDESK_INCIDENT_ADMISSION_OPERATOR_LOCK:-}"
  [[ "${ROOT}" == /tmp/refunddesk-incident-admission-test-* &&
    "${CONTROL_ROOT}" == /tmp/refunddesk-incident-admission-test-* &&
    "${OPERATOR_LOCK}" == /tmp/refunddesk-incident-admission-test-* &&
    "${HOST_COMMAND}" == /tmp/refunddesk-incident-admission-test-* &&
    -f "${HOST_COMMAND}" && ! -L "${HOST_COMMAND}" &&
    "${VALIDATOR}" == /tmp/refunddesk-incident-admission-test-* &&
    -f "${VALIDATOR}" && ! -L "${VALIDATOR}" &&
    "${PROOF_CLIENT}" == /tmp/refunddesk-incident-admission-test-* &&
    -f "${PROOF_CLIENT}" && ! -L "${PROOF_CLIENT}" &&
    "${PROMOTION_VALIDATOR}" == /tmp/refunddesk-incident-admission-test-* &&
    -f "${PROMOTION_VALIDATOR}" && ! -L "${PROMOTION_VALIDATOR}" ]] || exit "${EXIT_USAGE}"
  EXPECTED_UID="$(id -u)"
  EXPECTED_GID="$(id -g)"
else
  [[ -z "${REFUNDDESK_INCIDENT_ADMISSION_ROOT:-}" &&
    -z "${REFUNDDESK_INCIDENT_ADMISSION_CONTROL_ROOT:-}" &&
    -z "${REFUNDDESK_INCIDENT_ADMISSION_OPERATOR_LOCK:-}" &&
    -z "${REFUNDDESK_INCIDENT_FAKE_MODE:-}" &&
    -z "${REFUNDDESK_INCIDENT_FAKE_STATE:-}" &&
    -z "${REFUNDDESK_INCIDENT_FAKE_ROOT:-}" ]] || exit "${EXIT_USAGE}"
  (( EUID == 0 )) || exit "${EXIT_USAGE}"
  ROOT="/opt/refunddesk"
  CONTROL_ROOT="/var/lib/refunddesk/control"
  OPERATOR_LOCK="/run/refunddesk/operator.lock"
  [[ "${VALIDATOR}" == /run/refunddesk/incident-admission-* &&
    "${HOST_COMMAND}" == /run/refunddesk/incident-admission-* &&
    "${PROOF_CLIENT}" == /run/refunddesk/incident-admission-* &&
    "${PROMOTION_VALIDATOR}" == /run/refunddesk/incident-admission-* ]] || exit "${EXIT_USAGE}"
  EXPECTED_UID=0
  EXPECTED_GID=0
fi
readonly TEST_MODE ROOT CONTROL_ROOT OPERATOR_LOCK EXPECTED_UID EXPECTED_GID
readonly MARKER_PATH="${CONTROL_ROOT}/current-stripe-binding-incident-admission.json"

STARTED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
TEMPORARY_ROOT=""
MARKER_STATE="absent"
MARKER_TRANSITIONS=0
RESUMED=false
WORKER_STARTED=false
WORKER_STOPPED=false
OUTPUT_EMITTED=false
OPERATION=""
IDEMPOTENCY_KEY=""
DASHBOARD_AUTHORITY=""
PROMOTION_BUNDLE="$(printf '0%.0s' {1..64})"
PROMOTION_MANIFEST="${PROMOTION_BUNDLE}"
PROMOTION_SOURCE="${PROMOTION_BUNDLE}"
PROMOTION_PROVENANCE="${PROMOTION_BUNDLE}"
PROOF_FILE=""
POSTFLIGHT_FILE=""
POSTFLIGHT_FIREWALL_CLOSED=false
INPUTS_MODE_SAFE=false
CURRENT_INPUTS_BOUND=false
FIXTURE_LOCK_DIR=""

timestamp_now() {
  date --utc '+%Y-%m-%dT%H:%M:%SZ'
}

sha256_file() {
  sha256sum -- "$1" | cut -d ' ' -f 1
}

file_mode_owner_safe() {
  local path="$1" metadata
  [[ -f "${path}" && ! -L "${path}" ]] || return 1
  metadata="$(stat --format='%u:%g:%a' -- "${path}")" || return 1
  [[ "${metadata}" == "${EXPECTED_UID}:${EXPECTED_GID}:600" ]]
}

canonical_host_document() {
  local path="$1"
  python3 - "${path}" "${MAX_HOST_BYTES}" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); limit=int(sys.argv[2]); raw=p.read_bytes()
if not raw or len(raw)>limit or raw.endswith(b"\n") is False or raw.count(b"\n")!=1 or b"\r" in raw or b"\0" in raw or raw.startswith(b"\xef\xbb\xbf"):
    raise SystemExit(1)
try: value=json.loads(raw[:-1].decode("utf-8"))
except Exception: raise SystemExit(1)
if not isinstance(value,dict): raise SystemExit(1)
expected=(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
text=raw.decode("utf-8",errors="strict")
for needle in ("sk_test_","sk_live_","rk_test_","rk_live_","whsec_","absec_","pi_","ch_","re_","usr_","acct_","-----BEGIN"):
    if needle in text: raise SystemExit(1)
raise SystemExit(0 if expected==raw else 1)
PY
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8"))
for key in sys.argv[2].split("."):
    v=v[key]
if isinstance(v,bool): print("true" if v else "false")
elif isinstance(v,(str,int)): print(v)
else: raise SystemExit(1)
PY
}

post_incident_baseline_exact() {
  python3 - "$1" <<'PY'
import hashlib,json,sys
value=json.load(open(sys.argv[1],encoding="utf-8")).get("postIncidentBaseline")
keys=["activeFinancialJobs","auditEvents","mutationReceipts","refundExecutionAttempts","refundExecutions","refundRequests","snapshotSha256","unreleasedPaymentGuards","webhookReceipts"]
if not isinstance(value,dict) or sorted(value)!=keys: raise SystemExit(1)
counts={key:value[key] for key in keys if key!="snapshotSha256"}
if any(isinstance(item,bool) or not isinstance(item,int) or item<0 for item in counts.values()): raise SystemExit(1)
canonical=json.dumps(counts,sort_keys=True,separators=(",",":"))
expected=hashlib.sha256(canonical.encode("ascii")).hexdigest()
raise SystemExit(0 if value.get("snapshotSha256")==expected else 1)
PY
}

marker_transition() {
  local target="$1"
  local proof_path="${2:-}"
  python3 - "${MARKER_PATH}" "${target}" "${OPERATION}" "${EXPECTED_REVISION}" \
    "${REPOSITORY_HEAD}" "${RUNNER_SHA256}" "${PROMOTION_SHA256}" "${POSTFLIGHT_SHA256}" \
    "${DASHBOARD_AUTHORITY}" "${FIXTURE_SHA256}" "${IDEMPOTENCY_KEY}" "${VALIDATOR_SHA256}" \
    "${HOST_COMMAND_SHA256}" "${PROOF_CLIENT_SHA256}" "${COMPOSE_SHA256}" \
    "${PROMOTION_VALIDATOR_SHA256}" "${proof_path}" "${EXPECTED_UID}" "${EXPECTED_GID}" "${TEST_MODE}" <<'PY'
import hashlib,json,os,pathlib,re,sys,tempfile
(name,target,operation,revision,head,runner,promotion,current_postflight,dashboard,fixture,key,validator,host_command,proof_client,compose,promotion_validator,proof_path,uid,gid,test_mode)=sys.argv[1:]
path=pathlib.Path(name); order=["prepared","proof_started","proof_observed","contained_verified","complete"]
if target not in order: raise SystemExit(1)
proof=None; proof_sha=None
if proof_path:
    raw_proof=pathlib.Path(proof_path).read_bytes()
    try: proof=json.loads(raw_proof.decode("utf-8"))
    except Exception: raise SystemExit(1)
    keys={"ambiguousResumeSameKey","appSigningAccepted","complete","denialRefundSetUnchanged","deterministicIdempotency","guardReleased","readChargeSucceeded","readPaymentIntentSucceeded","readRefundCreateDenied","refundCount","refundIdSha256","requesterApproverDistinct","terminalReconciled","unrelatedSigningRejected","workflowCount"}
    if set(proof)!=keys or proof["complete"] is not True or proof["refundCount"]!=1 or proof["workflowCount"]!=1 or re.fullmatch(r"[0-9a-f]{64}",str(proof["refundIdSha256"])) is None: raise SystemExit(1)
    if not isinstance(proof["ambiguousResumeSameKey"],bool) or any(proof[k] is not True for k in keys-{"ambiguousResumeSameKey","complete","refundCount","refundIdSha256","workflowCount"}): raise SystemExit(1)
    if (json.dumps(proof,sort_keys=True,separators=(",",":"))+"\n").encode()!=raw_proof: raise SystemExit(1)
    proof_sha=hashlib.sha256(raw_proof).hexdigest()
if path.exists():
    if path.is_symlink() or not path.is_file(): raise SystemExit(1)
    st=path.stat()
    if test_mode!="true" and (st.st_uid!=int(uid) or st.st_gid!=int(gid) or (st.st_mode & 0o777)!=0o600): raise SystemExit(1)
    raw=path.read_bytes()
    try: current=json.loads(raw.decode())
    except Exception: raise SystemExit(1)
    expected={"composeSha256","dashboardAuthoritySha256","expectedRevision","fixtureSha256","hostCommandSha256","idempotencyKey","initialPostflightSha256","kind","markerTransitions","operation","promotionSha256","promotionValidatorSha256","proof","proofClientSha256","proofSha256","repositoryHead","runnerSha256","schemaVersion","state","validatorSha256"}
    if set(current)!=expected or current["schemaVersion"]!=1 or current["kind"]!="refunddesk.current-stripe-binding-incident-admission.marker": raise SystemExit(1)
    bindings={"composeSha256":compose,"operation":operation,"expectedRevision":revision,"repositoryHead":head,"runnerSha256":runner,"promotionSha256":promotion,"dashboardAuthoritySha256":dashboard,"fixtureSha256":fixture,"idempotencyKey":key,"validatorSha256":validator,"hostCommandSha256":host_command,"proofClientSha256":proof_client,"promotionValidatorSha256":promotion_validator}
    if any(current[k]!=v for k,v in bindings.items()): raise SystemExit(1)
    initial_postflight=current["initialPostflightSha256"]
    if not isinstance(initial_postflight,str) or len(initial_postflight)!=64 or any(c not in "0123456789abcdef" for c in initial_postflight): raise SystemExit(1)
    current_index=order.index(current["state"]); target_index=order.index(target)
    if target_index<current_index or target_index>current_index+1: raise SystemExit(1)
    if target_index==current_index: raise SystemExit(0)
    transitions=current["markerTransitions"]+1
    if target=="proof_observed":
        if proof is None: raise SystemExit(1)
    else:
        if proof is not None and current["proofSha256"] not in (None,proof_sha): raise SystemExit(1)
        proof=current["proof"]; proof_sha=current["proofSha256"]
else:
    if target!="prepared": raise SystemExit(1)
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    transitions=1; proof=None; proof_sha=None; initial_postflight=current_postflight
if target in {"proof_observed","contained_verified","complete"} and (proof is None or proof_sha is None): raise SystemExit(1)
value={"composeSha256":compose,"dashboardAuthoritySha256":dashboard,"expectedRevision":revision,"fixtureSha256":fixture,"hostCommandSha256":host_command,"idempotencyKey":key,"initialPostflightSha256":initial_postflight,"kind":"refunddesk.current-stripe-binding-incident-admission.marker","markerTransitions":transitions,"operation":operation,"promotionSha256":promotion,"promotionValidatorSha256":promotion_validator,"proof":proof,"proofClientSha256":proof_client,"proofSha256":proof_sha,"repositoryHead":head,"runnerSha256":runner,"schemaVersion":1,"state":target,"validatorSha256":validator}
raw=(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
fd,name=tempfile.mkstemp(prefix=path.name+".tmp-",dir=path.parent); temporary=pathlib.Path(name)
try:
    with os.fdopen(fd,"wb") as stream:
        stream.write(raw); stream.flush()
        if test_mode!="true": os.fsync(stream.fileno())
    os.replace(temporary,path)
    if test_mode!="true":
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
finally:
    try: temporary.unlink()
    except FileNotFoundError: pass
PY
}

materialize_marker_proof() {
  local destination="$1"
  python3 - "${MARKER_PATH}" "${destination}" <<'PY'
import hashlib,json,os,pathlib,re,sys
marker=pathlib.Path(sys.argv[1]); destination=pathlib.Path(sys.argv[2]); value=json.loads(marker.read_text(encoding="utf-8"))
proof=value.get("proof"); expected=value.get("proofSha256")
keys={"ambiguousResumeSameKey","appSigningAccepted","complete","denialRefundSetUnchanged","deterministicIdempotency","guardReleased","readChargeSucceeded","readPaymentIntentSucceeded","readRefundCreateDenied","refundCount","refundIdSha256","requesterApproverDistinct","terminalReconciled","unrelatedSigningRejected","workflowCount"}
if not isinstance(proof,dict) or set(proof)!=keys or proof.get("complete") is not True or proof.get("refundCount")!=1 or proof.get("workflowCount")!=1 or re.fullmatch(r"[0-9a-f]{64}",str(proof.get("refundIdSha256"))) is None or not isinstance(proof.get("ambiguousResumeSameKey"),bool) or any(proof.get(key) is not True for key in keys-{"ambiguousResumeSameKey","complete","refundCount","refundIdSha256","workflowCount"}) or not isinstance(expected,str) or re.fullmatch(r"[0-9a-f]{64}",expected) is None: raise SystemExit(1)
raw=(json.dumps(proof,sort_keys=True,separators=(",",":"))+"\n").encode()
if hashlib.sha256(raw).hexdigest()!=expected: raise SystemExit(1)
fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"wb") as stream: stream.write(raw)
PY
}

load_marker() {
  local projection
  [[ -e "${MARKER_PATH}" ]] || return 0
  file_mode_owner_safe "${MARKER_PATH}" || return 1
  projection="$(python3 - "${MARKER_PATH}" <<'PY'
import json,pathlib,re,sys
path=pathlib.Path(sys.argv[1]); raw=path.read_bytes()
if not raw.endswith(b"\n") or raw.count(b"\n")!=1 or b"\r" in raw or b"\0" in raw or raw.startswith(b"\xef\xbb\xbf"): raise SystemExit(1)
try: value=json.loads(raw[:-1].decode("utf-8"))
except Exception: raise SystemExit(1)
keys={"composeSha256","dashboardAuthoritySha256","expectedRevision","fixtureSha256","hostCommandSha256","idempotencyKey","initialPostflightSha256","kind","markerTransitions","operation","promotionSha256","promotionValidatorSha256","proof","proofClientSha256","proofSha256","repositoryHead","runnerSha256","schemaVersion","state","validatorSha256"}
if not isinstance(value,dict) or set(value)!=keys or value.get("schemaVersion")!=1 or value.get("kind")!="refunddesk.current-stripe-binding-incident-admission.marker" or (json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()!=raw: raise SystemExit(1)
mapping={"prepared":1,"proof_started":2,"proof_observed":3,"contained_verified":4,"complete":5}
state=value.get("state")
if state not in mapping or value.get("markerTransitions")!=mapping[state]: raise SystemExit(1)
for name in ("composeSha256","dashboardAuthoritySha256","fixtureSha256","hostCommandSha256","idempotencyKey","initialPostflightSha256","operation","promotionSha256","promotionValidatorSha256","proofClientSha256","proofSha256","runnerSha256","validatorSha256"):
    item=value.get(name)
    if name=="proofSha256" and state in {"prepared","proof_started"}:
        if item is not None: raise SystemExit(1)
    elif not isinstance(item,str) or re.fullmatch(r"[0-9a-f]{64}",item) is None: raise SystemExit(1)
for name in ("expectedRevision","repositoryHead"):
    if not isinstance(value.get(name),str) or re.fullmatch(r"[0-9a-f]{40}",value[name]) is None: raise SystemExit(1)
proof=value.get("proof")
if state in {"prepared","proof_started"}:
    if proof is not None: raise SystemExit(1)
else:
    proof_keys={"ambiguousResumeSameKey","appSigningAccepted","complete","denialRefundSetUnchanged","deterministicIdempotency","guardReleased","readChargeSucceeded","readPaymentIntentSucceeded","readRefundCreateDenied","refundCount","refundIdSha256","requesterApproverDistinct","terminalReconciled","unrelatedSigningRejected","workflowCount"}
    if not isinstance(proof,dict) or set(proof)!=proof_keys or proof.get("refundCount")!=1 or proof.get("workflowCount")!=1 or re.fullmatch(r"[0-9a-f]{64}",str(proof.get("refundIdSha256"))) is None or not isinstance(proof.get("ambiguousResumeSameKey"),bool) or any(proof.get(name) is not True for name in proof_keys-{"ambiguousResumeSameKey","refundCount","refundIdSha256","workflowCount"}): raise SystemExit(1)
print(state+"|"+str(mapping[state]))
PY
)" || return 1
  IFS='|' read -r MARKER_STATE MARKER_TRANSITIONS <<<"${projection}"
  RESUMED=true
}

run_host() {
  local action="$1" destination="$2" status
  if env REFUNDDESK_INCIDENT_DASHBOARD_PATH="${DASHBOARD_INPUT:-}" \
    REFUNDDESK_INCIDENT_FIXTURE_PATH="${FIXTURE_INPUT:-}" \
    REFUNDDESK_INCIDENT_PROMOTION_PATH="${PROMOTION_INPUT:-}" \
    REFUNDDESK_INCIDENT_EXPECTED_COMPOSE_SHA256="${COMPOSE_SHA256}" \
    REFUNDDESK_INCIDENT_PROOF_CLIENT_PATH="${PROOF_CLIENT}" \
    REFUNDDESK_INCIDENT_PROOF_CLIENT_SHA256="${PROOF_CLIENT_SHA256}" \
    REFUNDDESK_INCIDENT_SOURCE_ROOT="${ROOT}/releases/${EXPECTED_REVISION}/source" \
    REFUNDDESK_INCIDENT_CONTROL_ROOT="${CONTROL_ROOT}" \
    REFUNDDESK_INCIDENT_DEADLINE="${POSTFLIGHT_VALID_UNTIL:-}" \
    REFUNDDESK_INCIDENT_HOST_COMMAND_SHA256="${HOST_COMMAND_SHA256}" \
    REFUNDDESK_INCIDENT_RESUME="${RESUMED}" \
    "${HOST_COMMAND}" "${action}" "${EXPECTED_REVISION}" "${OPERATION}" "${IDEMPOTENCY_KEY}" \
    "${DASHBOARD_AUTHORITY}" "${FIXTURE_SHA256}" >"${destination}"; then
    status=0
  else
    status=$?
  fi
  (( $(stat --format='%s' -- "${destination}" 2>/dev/null || printf '%s' 999999) <= MAX_HOST_BYTES )) || return 98
  canonical_host_document "${destination}" || return 98
  return "${status}"
}

emit_document() {
  local code="$1" exit_code="$2" result diagnostic completed
  completed="$(timestamp_now)"
  case "${exit_code}" in
    0) result=PASS; diagnostic="" ;;
    20) result=FAIL; diagnostic="${code}" ;;
    21) result=INCOMPLETE; diagnostic="${code}" ;;
    *) return 1 ;;
  esac
  python3 - "${NONCE}" "${EXPECTED_REVISION}" "${REPOSITORY_HEAD}" "${STARTED_AT}" "${completed}" \
    "${exit_code}" "${result}" "${code}" "${diagnostic}" "${MARKER_STATE}" "${RESUMED}" \
    "${MARKER_TRANSITIONS}" "${PROMOTION_SHA256}" "${PROMOTION_BUNDLE}" "${PROMOTION_MANIFEST}" \
    "${PROMOTION_SOURCE}" "${PROMOTION_PROVENANCE}" "${PROOF_FILE}" "${POSTFLIGHT_FILE}" \
    "${WORKER_STARTED}" "${WORKER_STOPPED}" "${POSTFLIGHT_FIREWALL_CLOSED}" "${INPUTS_MODE_SAFE}" <<'PY'
import json,re,sys
(nonce,revision,head,started,completed,exit_code,result,code,diagnostic,state,resumed,transitions,promotion_evidence,bundle,manifest,source,provenance,proof_name,post_name,worker_started,worker_stopped,firewall_closed,inputs_mode_safe)=sys.argv[1:]
def flag(value): return value=="true"
proof={"ambiguousResumeSameKey":False,"appSigningAccepted":False,"complete":False,"denialRefundSetUnchanged":False,"deterministicIdempotency":False,"guardReleased":False,"readChargeSucceeded":False,"readPaymentIntentSucceeded":False,"readRefundCreateDenied":False,"refundCount":0,"refundIdSha256":None,"requesterApproverDistinct":False,"terminalReconciled":False,"unrelatedSigningRejected":False,"workflowCount":0}
if proof_name:
    try:
        candidate=json.load(open(proof_name,encoding="utf-8"))
        for key in proof:
            if key in candidate: proof[key]=candidate[key]
    except Exception: pass
post={}
if post_name:
    try: post=json.load(open(post_name,encoding="utf-8"))
    except Exception: pass
success=int(exit_code)==0
bindings={"accountBindingsExact":bool(post.get("accountBindingsExact",False)),"filesMode0600":flag(inputs_mode_safe),"managedSandboxEffectMatches":bool(post.get("managedSandboxEffectMatches",False)),"managedSandboxReadMatches":bool(post.get("managedSandboxReadMatches",False)),"predecessorBytesRetested":False,"stripeAppSigningMatches":bool(post.get("stripeAppSigningMatches",False))}
proof_bound=state in {"proof_observed","contained_verified","complete"} and proof["complete"] is True and int(proof["workflowCount"])==1 and int(proof["refundCount"])==1
post_worker_stopped=bool(post.get("workerStopped",False))
operation_started=state in {"proof_started","proof_observed","contained_verified","complete"} or flag(worker_started)
operation_stopped=flag(worker_stopped) or (proof_bound and post_worker_stopped)
proof_out={"ambiguousResumeSameKey":flag(resumed),"appSigningAccepted":bool(proof["appSigningAccepted"]),"denialRefundSetUnchanged":bool(proof["denialRefundSetUnchanged"]),"deterministicIdempotency":bool(proof["deterministicIdempotency"]),"guardReleased":bool(proof["guardReleased"]),"readChargeSucceeded":bool(proof["readChargeSucceeded"]),"readPaymentIntentSucceeded":bool(proof["readPaymentIntentSucceeded"]),"readRefundCreateDenied":bool(proof["readRefundCreateDenied"]),"refundCount":int(proof["refundCount"]),"requesterApproverDistinct":bool(proof["requesterApproverDistinct"]),"terminalReconciled":bool(proof["terminalReconciled"]),"unrelatedSigningRejected":bool(proof["unrelatedSigningRejected"]),"workerStartedPrivately":proof_bound,"workerStoppedAfter":proof_bound and post_worker_stopped,"workflowCount":int(proof["workflowCount"])}
containment={"caddyStopped":bool(post.get("caddyStopped",False)),"coreStable":bool(post.get("coreStable",False)),"financialBaselineQuiescent":bool(post.get("financialQuiescent",False)),"financialDeltaExact":bool(post.get("financialDeltaExact",False)),"firewallClosed":flag(firewall_closed),"liveDisabled":bool(post.get("liveDisabled",False)),"maintenanceStopped":bool(post.get("maintenanceStopped",False)),"markerComplete":state=="complete","publicListenersClosed":bool(post.get("publicListenersClosed",False)),"sourceExact":bool(post.get("sourceExact",False)),"workerStopped":bool(post.get("workerStopped",False))}
post_incident_baseline=post.get("postIncidentBaseline") if isinstance(post.get("postIncidentBaseline"),dict) else None
document={"bindings":bindings,"code":code,"completedAt":completed,"containment":containment,"diagnostics":([] if not diagnostic else [diagnostic]),"exitCode":int(exit_code),"expectedRevision":revision,"kind":"refunddesk.lightsail.incident-admission","marker":{"complete":state=="complete","markerTransitions":int(transitions),"operationBound":state!="absent","resumed":flag(resumed),"sameIdempotencyKey":bool(proof_out["ambiguousResumeSameKey"]) or state in {"prepared","proof_started","proof_observed","contained_verified","complete"},"state":state},"mutations":{"markerTransitions":int(transitions),"refundsCreated":int(proof_out["refundCount"]),"workerStarts":1 if operation_started else 0,"workerStops":1 if operation_stopped else 0,"workflowsCreated":int(proof_out["workflowCount"])},"nonce":nonce,"postIncidentBaseline":post_incident_baseline,"proof":proof_out,"promotion":{"bundleSha256":bundle,"candidateRevision":revision,"contained":True,"evidenceSha256":promotion_evidence,"manifestSha256":manifest,"postflightAfterPromotion":True,"provenanceSha256":provenance,"sourceSha256":source},"redaction":{"arbitraryPathPresent":False,"customerDataPresent":False,"ipAddressPresent":False,"keyDigestPresent":False,"rawApiKeyPresent":False,"rawPayloadPresent":False,"rawSecretPresent":False,"rawSignaturePresent":False,"stderrPresent":False,"stripeIdentifierPresent":False},"repositoryHead":head,"result":result,"schemaVersion":1,"startedAt":started}
sys.stdout.buffer.write((json.dumps(document,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8"))
PY
  OUTPUT_EMITTED=true
}

safe_stop_worker() {
  [[ "${WORKER_STARTED}" == true ]] || return 0
  local stop_file="${TEMPORARY_ROOT}/stop.json"
  if run_host stop-worker "${stop_file}" && [[ "$(json_field "${stop_file}" stopped)" == true ]]; then
    WORKER_STOPPED=true
    return 0
  fi
  return 1
}

cleanup() {
  if [[ "${WORKER_STARTED}" == true && "${WORKER_STOPPED}" != true ]]; then
    safe_stop_worker || true
  elif [[ "${CURRENT_INPUTS_BOUND}" == true && "${MARKER_STATE}" =~ ^(prepared|proof_started)$ && "${WORKER_STOPPED}" != true && -n "${TEMPORARY_ROOT}" && -d "${TEMPORARY_ROOT}" ]]; then
    local recovery_file="${TEMPORARY_ROOT}/cleanup-stop.json"
    run_host stop-worker "${recovery_file}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TEMPORARY_ROOT}" &&
    ( "${TEMPORARY_ROOT}" == /tmp/refunddesk-incident-admission-test-input-* ||
      "${TEMPORARY_ROOT}" == /run/refunddesk/incident-admission-input-* ) &&
    -d "${TEMPORARY_ROOT}" ]]; then
    if [[ "${TEST_MODE}" == true ]]; then
      find "${TEMPORARY_ROOT}" -mindepth 1 -depth -delete 2>/dev/null || true
    else
      find "${TEMPORARY_ROOT}" -type f -exec shred -u -- {} + 2>/dev/null || true
    fi
    rmdir "${TEMPORARY_ROOT}" 2>/dev/null || true
  fi
  if [[ -n "${FIXTURE_LOCK_DIR}" && "${FIXTURE_LOCK_DIR}" == /tmp/refunddesk-incident-admission-test-* && -d "${FIXTURE_LOCK_DIR}" ]]; then
    rmdir "${FIXTURE_LOCK_DIR}" 2>/dev/null || true
  fi
}

remove_input_root_strict() {
  local root="$1" entries name kind path metadata
  [[ -d "${root}" && ! -L "${root}" ]] || return 1
  if [[ "${TEST_MODE}" == true ]]; then
    [[ "${root}" == /tmp/refunddesk-incident-admission-test-input-* ]] || return 1
  else
    [[ "${root}" == /run/refunddesk/incident-admission-input-* &&
      "$(stat --file-system --format='%T' -- "${root}")" == tmpfs ]] || return 1
  fi
  [[ "$(stat --format='%u:%g:%a' -- "${root}")" == "${EXPECTED_UID}:${EXPECTED_GID}:700" ]] || return 1
  if [[ "${TEST_MODE}" == true && "${REFUNDDESK_INCIDENT_ADMISSION_TEST_CLEANUP_FAILURE:-}" == find ]]; then return 1; fi
  entries="$(find "${root}" -xdev -mindepth 1 -maxdepth 1 -printf '%f|%y\n')" || return 1
  while IFS='|' read -r name kind; do
    [[ -z "${name}" && -z "${kind}" ]] && continue
    [[ "${name}" =~ ^[a-z0-9.-]{1,96}$ && "${kind}" == f ]] || return 1
    path="${root}/${name}"
    [[ -f "${path}" && ! -L "${path}" ]] || return 1
    metadata="$(stat --format='%u:%g:%a:%h' -- "${path}")" || return 1
    [[ "${metadata}" == "${EXPECTED_UID}:${EXPECTED_GID}:600:1" ]] || return 1
  done <<<"${entries}"
  if [[ "${TEST_MODE}" == true && "${REFUNDDESK_INCIDENT_ADMISSION_TEST_CLEANUP_FAILURE:-}" == shred ]]; then return 1; fi
  while IFS='|' read -r name kind; do
    [[ -z "${name}" && -z "${kind}" ]] && continue
    shred --iterations=1 --zero --remove -- "${root}/${name}" || return 1
  done <<<"${entries}"
  if [[ "${TEST_MODE}" == true && "${REFUNDDESK_INCIDENT_ADMISSION_TEST_CLEANUP_FAILURE:-}" == residue ]]; then
    mkdir -- "${root}/unexpected-residue" || return 1
  fi
  [[ -z "$(find "${root}" -xdev -mindepth 1 -maxdepth 1 -print -quit)" ]] || return 1
  if [[ "${TEST_MODE}" == true && "${REFUNDDESK_INCIDENT_ADMISSION_TEST_CLEANUP_FAILURE:-}" == rmdir ]]; then return 1; fi
  rmdir -- "${root}" || return 1
  [[ ! -e "${root}" && ! -L "${root}" ]]
}

cleanup_stale_input_roots() {
  local roots root
  [[ "${TEST_MODE}" != true ]] || return 0
  [[ -d /run/refunddesk && ! -L /run/refunddesk &&
    "$(stat --file-system --format='%T' -- /run/refunddesk)" == tmpfs &&
    "$(stat --format='%u:%g:%a' -- /run/refunddesk)" == "${EXPECTED_UID}:${EXPECTED_GID}:700" ]] || return 1
  roots="$(find /run/refunddesk -xdev -mindepth 1 -maxdepth 1 -type d -name 'incident-admission-input-*' -printf '%p\n')" || return 1
  while IFS= read -r root; do
    [[ -z "${root}" ]] && continue
    [[ "${root}" =~ ^/run/refunddesk/incident-admission-input-[A-Za-z0-9]{8}$ ]] || return 1
    remove_input_root_strict "${root}" || return 1
  done <<<"${roots}"
}

cleanup_inputs_strict() {
  [[ -n "${TEMPORARY_ROOT}" ]] || return 1
  remove_input_root_strict "${TEMPORARY_ROOT}" || return 1
  TEMPORARY_ROOT=""
  if [[ "${TEST_MODE}" == true && -n "${FIXTURE_LOCK_DIR}" ]]; then
    [[ "${FIXTURE_LOCK_DIR}" == /tmp/refunddesk-incident-admission-test-*.fixture-lock &&
      -d "${FIXTURE_LOCK_DIR}" && ! -L "${FIXTURE_LOCK_DIR}" ]] || return 1
    rmdir -- "${FIXTURE_LOCK_DIR}" || return 1
    FIXTURE_LOCK_DIR=""
  fi
}

handle_signal() {
  trap '' HUP INT TERM
  if [[ "${WORKER_STARTED}" == true && "${WORKER_STOPPED}" != true ]]; then
    safe_stop_worker || true
  elif [[ "${MARKER_STATE}" =~ ^(prepared|proof_started)$ && -n "${TEMPORARY_ROOT}" && -d "${TEMPORARY_ROOT}" ]]; then
    local signal_stop_file="${TEMPORARY_ROOT}/signal-stop.json"
    run_host stop-worker "${signal_stop_file}" >/dev/null 2>&1 || true
  fi
  if [[ "${OUTPUT_EMITTED}" != true ]]; then
    emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}" || true
  fi
  trap - EXIT HUP INT TERM
  cleanup
  exit "${EXIT_INCOMPLETE}"
}

trap cleanup EXIT
trap handle_signal HUP INT TERM

for tool in python3 node sha256sum stat date head wc find shred rmdir; do
  command -v "${tool}" >/dev/null 2>&1 || {
    MARKER_STATE=absent
    emit_document TOOL_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
done
if [[ "${TEST_MODE}" != true ]]; then
  command -v flock >/dev/null 2>&1 || {
    emit_document TOOL_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
fi
[[ -f "${HOST_COMMAND}" && ! -L "${HOST_COMMAND}" && -x "${HOST_COMMAND}" &&
  -f "${VALIDATOR}" && ! -L "${VALIDATOR}" &&
  -f "${PROOF_CLIENT}" && ! -L "${PROOF_CLIENT}" &&
  -f "${PROMOTION_VALIDATOR}" && ! -L "${PROMOTION_VALIDATOR}" ]] || {
  emit_document TOOL_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
[[ "$(sha256_file "${VALIDATOR}")" == "${VALIDATOR_SHA256}" &&
  "$(sha256_file "${HOST_COMMAND}")" == "${HOST_COMMAND_SHA256}" &&
  "$(sha256_file "${PROOF_CLIENT}")" == "${PROOF_CLIENT_SHA256}" &&
  "$(sha256_file "${PROMOTION_VALIDATOR}")" == "${PROMOTION_VALIDATOR_SHA256}" ]] || {
  emit_document SOURCE_IDENTITY_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
[[ "$(sha256_file "$0")" == "${RUNNER_SHA256}" ]] || {
  emit_document SOURCE_IDENTITY_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}

mkdir -p -- "$(dirname -- "${OPERATOR_LOCK}")" "${CONTROL_ROOT}" || {
  emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
if [[ "${TEST_MODE}" == true ]]; then
  FIXTURE_LOCK_DIR="${OPERATOR_LOCK}.fixture-lock"
  mkdir -- "${FIXTURE_LOCK_DIR}" 2>/dev/null || {
    emit_document OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
else
  exec 9>"${OPERATOR_LOCK}" || {
    emit_document OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  flock --exclusive --nonblock 9 || {
    emit_document OPERATOR_LOCK_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
fi

cleanup_stale_input_roots || {
  emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}

if [[ "${TEST_MODE}" == true ]]; then
  TEMPORARY_ROOT="$(mktemp --directory /tmp/refunddesk-incident-admission-test-input-XXXXXXXX)" || true
else
  mkdir -p /run/refunddesk || true
  chmod 700 /run/refunddesk || true
  TEMPORARY_ROOT="$(mktemp --directory /run/refunddesk/incident-admission-input-XXXXXXXX)" || true
fi
[[ -n "${TEMPORARY_ROOT}" ]] || {
  emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
chmod 700 "${TEMPORARY_ROOT}"
readonly COMBINED_INPUT="${TEMPORARY_ROOT}/combined.json"
head --bytes "$((MAX_INPUT_BYTES + 1))" >"${COMBINED_INPUT}"
(( $(stat --format='%s' -- "${COMBINED_INPUT}") <= MAX_INPUT_BYTES )) || {
  emit_document INPUT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
python3 - "${COMBINED_INPUT}" "${TEMPORARY_ROOT}" "${TEST_MODE}" <<'PY' || {
import hashlib,json,os,pathlib,sys
source=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); test_mode=sys.argv[3]=="true"; raw=source.read_bytes()
if not raw.endswith(b"\n") or raw.count(b"\n")!=1 or b"\r" in raw or b"\0" in raw or raw.startswith(b"\xef\xbb\xbf"): raise SystemExit(1)
try: value=json.loads(raw[:-1].decode("utf-8"))
except Exception: raise SystemExit(1)
if not isinstance(value,dict) or set(value)!={"dashboardAttestation","fixture","postflight","promotionEvidence"}: raise SystemExit(1)
if (json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()!=raw: raise SystemExit(1)
import datetime,re
stamp=re.compile(r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
postflight_object=value["postflight"]
if not isinstance(postflight_object,dict) or set(postflight_object)!={"capturedAt","firewallClosed","revision","validUntil"} or postflight_object["firewallClosed"] is not True: raise SystemExit(1)
postflight=postflight_object["capturedAt"]
if postflight_object["revision"]!=value["promotionEvidence"].get("revision"): raise SystemExit(1)
dashboard=value["dashboardAttestation"]
if not isinstance(dashboard,dict) or dashboard.get("containmentCapturedAt")!=postflight_object["capturedAt"] or dashboard.get("containmentValidUntil")!=postflight_object["validUntil"]: raise SystemExit(1)
promotion_completed=value["promotionEvidence"].get("completedAt") if isinstance(value["promotionEvidence"],dict) else None
if not isinstance(postflight,str) or not isinstance(postflight_object["validUntil"],str) or not isinstance(promotion_completed,str) or not stamp.fullmatch(postflight) or not stamp.fullmatch(postflight_object["validUntil"]) or not stamp.fullmatch(promotion_completed): raise SystemExit(1)
parse=lambda text: datetime.datetime.strptime(text,"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
if parse(postflight)<parse(promotion_completed): raise SystemExit(1)
for key,name in [("dashboardAttestation","dashboard.json"),("fixture","fixture.json"),("promotionEvidence","promotion.json")]:
    data=(json.dumps(value[key],sort_keys=True,separators=(",",":"))+"\n").encode()
    fd=os.open(target/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"wb") as stream:
        stream.write(data); stream.flush()
        if not test_mode: os.fsync(stream.fileno())
projection={key:value["dashboardAttestation"][key] for key in ["accountFingerprints","candidateFingerprints","containment","credentialRecords","exposedFingerprints","replacementRows","revocation","sourceEvidence"]}
projection["activityReview"]={"apiRequestsReviewed":True,"dashboardActivityReviewed":True,"unexpectedActivity":False}
(target/"authority.txt").write_text(hashlib.sha256((json.dumps(projection,sort_keys=True,separators=(",",":"))+"\n").encode()).hexdigest(),encoding="ascii")
(target/"postflight-control.json").write_text(json.dumps(postflight_object,sort_keys=True,separators=(",",":"))+"\n",encoding="ascii",newline="\n")
PY
  emit_document INPUT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
readonly DASHBOARD_INPUT="${TEMPORARY_ROOT}/dashboard.json"
readonly FIXTURE_INPUT="${TEMPORARY_ROOT}/fixture.json"
readonly PROMOTION_INPUT="${TEMPORARY_ROOT}/promotion.json"
readonly POSTFLIGHT_CONTROL="${TEMPORARY_ROOT}/postflight-control.json"
[[ "$(sha256_file "${DASHBOARD_INPUT}")" == "${DASHBOARD_SHA256}" &&
  "$(sha256_file "${FIXTURE_INPUT}")" == "${FIXTURE_SHA256}" &&
  "$(sha256_file "${PROMOTION_INPUT}")" == "${PROMOTION_SHA256}" ]] || {
  emit_document INPUT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
node "${VALIDATOR}" --kind dashboard <"${DASHBOARD_INPUT}" >/dev/null || {
  emit_document INPUT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
node "${VALIDATOR}" --kind fixture <"${FIXTURE_INPUT}" >/dev/null || {
  emit_document INPUT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
node "${PROMOTION_VALIDATOR}" --evidence "${PROMOTION_INPUT}" \
  --expected-revision "${EXPECTED_REVISION}" \
  --expected-nonce "$(json_field "${PROMOTION_INPUT}" nonce)" \
  --expected-bundle-sha256 "$(json_field "${PROMOTION_INPUT}" inputs.bundleSha256)" \
  --expected-manifest-sha256 "$(json_field "${PROMOTION_INPUT}" inputs.manifestSha256)" \
  --expected-provenance-sha256 "$(json_field "${PROMOTION_INPUT}" inputs.provenanceSha256)" \
  --expected-source-sha256 "$(json_field "${PROMOTION_INPUT}" inputs.sourceSha256)" >/dev/null || {
  emit_document PROMOTION_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
node "${VALIDATOR}" --kind promotion --expected-revision "${EXPECTED_REVISION}" <"${PROMOTION_INPUT}" >/dev/null || {
  emit_document PROMOTION_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
POSTFLIGHT_FIREWALL_CLOSED="$(json_field "${POSTFLIGHT_CONTROL}" firewallClosed)"
POSTFLIGHT_VALID_UNTIL="$(json_field "${POSTFLIGHT_CONTROL}" validUntil)"
[[ "${POSTFLIGHT_FIREWALL_CLOSED}" == true && "$(json_field "${POSTFLIGHT_CONTROL}" revision)" == "${EXPECTED_REVISION}" ]] || {
  emit_document INPUT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
INPUTS_MODE_SAFE=true
DASHBOARD_AUTHORITY="$(<"${TEMPORARY_ROOT}/authority.txt")"
PROMOTION_BUNDLE="$(json_field "${PROMOTION_INPUT}" inputs.bundleSha256)"
PROMOTION_MANIFEST="$(json_field "${PROMOTION_INPUT}" inputs.manifestSha256)"
PROMOTION_SOURCE="$(json_field "${PROMOTION_INPUT}" inputs.sourceSha256)"
PROMOTION_PROVENANCE="$(json_field "${PROMOTION_INPUT}" inputs.provenanceSha256)"
OPERATION="$(printf '%s' "${EXPECTED_REVISION}|${REPOSITORY_HEAD}|${PROMOTION_SHA256}|${DASHBOARD_AUTHORITY}|${FIXTURE_SHA256}|${VALIDATOR_SHA256}|${HOST_COMMAND_SHA256}|${PROOF_CLIENT_SHA256}|${COMPOSE_SHA256}|${PROMOTION_VALIDATOR_SHA256}" | sha256sum | cut -d ' ' -f 1)"
IDEMPOTENCY_KEY="$(printf '%s' "refunddesk:incident-admission:${OPERATION}" | sha256sum | cut -d ' ' -f 1)"

load_marker || {
  MARKER_STATE=invalid
  emit_document MARKER_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
if [[ "${MARKER_STATE}" != absent ]]; then
  for binding in operation expectedRevision repositoryHead runnerSha256 promotionSha256 dashboardAuthoritySha256 fixtureSha256 idempotencyKey validatorSha256 hostCommandSha256 proofClientSha256 composeSha256 promotionValidatorSha256; do
    expected=""
    case "${binding}" in
      operation) expected="${OPERATION}" ;;
      expectedRevision) expected="${EXPECTED_REVISION}" ;;
      repositoryHead) expected="${REPOSITORY_HEAD}" ;;
      runnerSha256) expected="${RUNNER_SHA256}" ;;
      promotionSha256) expected="${PROMOTION_SHA256}" ;;
      dashboardAuthoritySha256) expected="${DASHBOARD_AUTHORITY}" ;;
      fixtureSha256) expected="${FIXTURE_SHA256}" ;;
      idempotencyKey) expected="${IDEMPOTENCY_KEY}" ;;
      validatorSha256) expected="${VALIDATOR_SHA256}" ;;
      hostCommandSha256) expected="${HOST_COMMAND_SHA256}" ;;
      proofClientSha256) expected="${PROOF_CLIENT_SHA256}" ;;
      composeSha256) expected="${COMPOSE_SHA256}" ;;
      promotionValidatorSha256) expected="${PROMOTION_VALIDATOR_SHA256}" ;;
    esac
    [[ "$(json_field "${MARKER_PATH}" "${binding}")" == "${expected}" ]] || {
      emit_document DASHBOARD_AUTHORITY_CHANGED "${EXIT_FAIL}"
      exit "${EXIT_FAIL}"
    }
  done
fi
CURRENT_INPUTS_BOUND=true

if [[ "${MARKER_STATE}" =~ ^(prepared|proof_started)$ ]]; then
  RECOVERY_FILE="${TEMPORARY_ROOT}/resume-containment.json"
  if ! run_host stop-worker "${RECOVERY_FILE}" || [[ "$(json_field "${RECOVERY_FILE}" stopped)" != true ]]; then
    emit_document WORKER_STOP_FAILED "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  fi
fi

PRE_FILE="${TEMPORARY_ROOT}/preflight.json"
run_host preflight "${PRE_FILE}" || {
  emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
for key in revisionExact sourceExact accountBindingsExact managedSandboxReadMatches managedSandboxEffectMatches stripeAppSigningMatches caddyStopped workerStopped maintenanceStopped publicListenersClosed liveDisabled coreStable financialQuiescent; do
  value="$(json_field "${PRE_FILE}" "${key}")" || {
    emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  if [[ "${value}" != true ]]; then
    case "${key}" in
      managedSandboxReadMatches|managedSandboxEffectMatches|stripeAppSigningMatches) code=NEW_ROTATION_REQUIRED ;;
      financialQuiescent) code=FINANCIAL_WORK_ACTIVE ;;
      revisionExact|sourceExact) code=SOURCE_IDENTITY_INVALID ;;
      *) code=CONTAINMENT_INVALID ;;
    esac
    emit_document "${code}" "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  fi
done

if [[ "${MARKER_STATE}" =~ ^(absent|prepared|proof_started)$ ]]; then
  PREPARE_FILE="${TEMPORARY_ROOT}/prepare-state.json"
  if ! run_host prepare-state "${PREPARE_FILE}" || [[ "$(json_field "${PREPARE_FILE}" prepared)" != true ]]; then
    emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  fi
  if [[ "$(json_field "${PREPARE_FILE}" resumed)" == true ]]; then RESUMED=true; fi
fi

if [[ "${MARKER_STATE}" == absent ]]; then
  marker_transition prepared || {
    emit_document MARKER_TRANSITION_FAILED "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  MARKER_STATE=prepared
  MARKER_TRANSITIONS=1
fi

PROOF_FILE="${TEMPORARY_ROOT}/proof.json"
if [[ "${MARKER_STATE}" == prepared || "${MARKER_STATE}" == proof_started ]]; then
  START_FILE="${TEMPORARY_ROOT}/start.json"
  if ! run_host start-worker "${START_FILE}" || [[ "$(json_field "${START_FILE}" started)" != true ]]; then
    emit_document WORKER_START_FAILED "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  fi
  WORKER_STARTED=true
  if [[ "${MARKER_STATE}" == prepared ]]; then
    marker_transition proof_started || {
      safe_stop_worker || true
      emit_document MARKER_TRANSITION_FAILED "${EXIT_INCOMPLETE}"
      exit "${EXIT_INCOMPLETE}"
    }
    MARKER_STATE=proof_started
    MARKER_TRANSITIONS=2
  fi
  if run_host proof "${PROOF_FILE}"; then
    PROOF_STATUS=0
  else
    PROOF_STATUS=$?
  fi
  if (( PROOF_STATUS == 75 )); then
    safe_stop_worker || {
      emit_document WORKER_STOP_FAILED "${EXIT_INCOMPLETE}"
      exit "${EXIT_INCOMPLETE}"
    }
    emit_document WORKER_PROOF_AMBIGUOUS "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  fi
  if (( PROOF_STATUS != 0 )); then
    safe_stop_worker || true
    emit_document WORKER_PROOF_FAILED "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  fi
  for key in complete readPaymentIntentSucceeded readChargeSucceeded readRefundCreateDenied denialRefundSetUnchanged appSigningAccepted unrelatedSigningRejected requesterApproverDistinct deterministicIdempotency terminalReconciled guardReleased; do
    [[ "$(json_field "${PROOF_FILE}" "${key}")" == true ]] || {
      safe_stop_worker || true
      emit_document WORKER_PROOF_FAILED "${EXIT_FAIL}"
      exit "${EXIT_FAIL}"
    }
  done
  [[ "$(json_field "${PROOF_FILE}" ambiguousResumeSameKey)" =~ ^(true|false)$ ]] || {
    safe_stop_worker || true
    emit_document WORKER_PROOF_FAILED "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  }
  [[ "$(json_field "${PROOF_FILE}" workflowCount)" == 1 && "$(json_field "${PROOF_FILE}" refundCount)" == 1 ]] || {
    safe_stop_worker || true
    emit_document WORKER_PROOF_FAILED "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  }
  [[ "$(json_field "${PROOF_FILE}" refundIdSha256)" =~ ^[0-9a-f]{64}$ ]] || {
    safe_stop_worker || true
    emit_document WORKER_PROOF_FAILED "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  }
  marker_transition proof_observed "${PROOF_FILE}" || {
    safe_stop_worker || true
    emit_document MARKER_TRANSITION_FAILED "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  MARKER_STATE=proof_observed
  MARKER_TRANSITIONS=3
  safe_stop_worker || {
    emit_document WORKER_STOP_FAILED "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
else
  materialize_marker_proof "${PROOF_FILE}" || {
    emit_document MARKER_INVALID "${EXIT_FAIL}"
    exit "${EXIT_FAIL}"
  }
fi

POSTFLIGHT_FILE="${TEMPORARY_ROOT}/postflight.json"
run_host postflight "${POSTFLIGHT_FILE}" || {
  emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
post_incident_baseline_exact "${POSTFLIGHT_FILE}" || {
  emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
for key in revisionExact sourceExact accountBindingsExact managedSandboxReadMatches managedSandboxEffectMatches stripeAppSigningMatches caddyStopped workerStopped maintenanceStopped publicListenersClosed liveDisabled coreStable financialQuiescent financialDeltaExact; do
  [[ "$(json_field "${POSTFLIGHT_FILE}" "${key}")" == true ]] || {
    emit_document CONTAINMENT_INVALID "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
done
[[ "$(json_field "${POSTFLIGHT_FILE}" workflowCount)" == 1 && "$(json_field "${POSTFLIGHT_FILE}" refundCount)" == 1 ]] || {
  emit_document CONTAINMENT_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
if [[ "${MARKER_STATE}" == proof_observed ]]; then
  marker_transition contained_verified "${PROOF_FILE}" || {
    emit_document MARKER_TRANSITION_FAILED "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  MARKER_STATE=contained_verified
  MARKER_TRANSITIONS=4
fi
if [[ "${MARKER_STATE}" == contained_verified ]]; then
  marker_transition complete "${PROOF_FILE}" || {
    emit_document MARKER_TRANSITION_FAILED "${EXIT_INCOMPLETE}"
    exit "${EXIT_INCOMPLETE}"
  }
  MARKER_STATE=complete
  MARKER_TRANSITIONS=5
fi
[[ "${MARKER_STATE}" == complete ]] || {
  emit_document MARKER_INVALID "${EXIT_FAIL}"
  exit "${EXIT_FAIL}"
}
python3 - "${POSTFLIGHT_VALID_UNTIL}" <<'PY' || {
import datetime,sys
try: deadline=datetime.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except Exception: raise SystemExit(1)
raise SystemExit(0 if datetime.datetime.now(datetime.timezone.utc) < deadline else 1)
PY
  emit_document ADMISSION_AUTHORITY_EXPIRED "${EXIT_INCOMPLETE}"
  exit "${EXIT_INCOMPLETE}"
}
PASS_DOCUMENT="$(emit_document PASS_INCIDENT_ADMITTED_CONTAINED 0)" || exit "${EXIT_INCOMPLETE}"
INCOMPLETE_CLEANUP_DOCUMENT="$(emit_document CONTROL_STATE_UNAVAILABLE "${EXIT_INCOMPLETE}")" || exit "${EXIT_INCOMPLETE}"
if ! cleanup_inputs_strict; then
  printf '%s\n' "${INCOMPLETE_CLEANUP_DOCUMENT}"
  OUTPUT_EMITTED=true
  exit "${EXIT_INCOMPLETE}"
fi
printf '%s\n' "${PASS_DOCUMENT}"
OUTPUT_EMITTED=true
exit 0
