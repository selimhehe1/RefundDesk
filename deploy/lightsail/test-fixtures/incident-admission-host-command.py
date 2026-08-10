#!/usr/bin/env python3
"""Deterministic fake host for the ADR 0036 shell contract.

This program never contacts Stripe, AWS, Docker, systemd or a database.  It is
accepted only when the shell runner is explicitly in fixture mode.  Its state
file lets the contract exercise crash-safe ambiguity and exact-operation resume.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_ACTIONS = {"preflight", "prepare-state", "start-worker", "proof", "stop-worker", "postflight"}
ALLOWED_MODES = {
    "pass",
    "binding-mismatch",
    "legacy-key",
    "platform-effect-key-in-web",
    "platform-read-key-in-worker",
    "previous-signing-secret",
    "runtime-env-mismatch",
    "runtime-env-extra",
    "env-duplicate",
    "env-malformed",
    "aws-secret-extra",
    "sandbox-effect-key-in-web",
    "sandbox-read-key-in-worker",
    "financial-work",
    "foreign-job",
    "webhook-job",
    "webhook-recovery-job",
    "public-listener",
    "live-enabled",
    "wrong-revision",
    "read-create-allowed",
    "requester-approver-same",
    "two-workflows",
    "two-refunds",
    "changed-idempotency",
    "client-swap-attempt",
    "ambiguous-once",
    "ambiguous-always",
    "crash-before-call-once",
    "crash-after-stripe-before-link",
    "crash-after-link-once",
    "crash-terminal-once",
    "delay-proof",
    "delay-prepare",
    "delay-start",
    "delay-stop",
    "worker-start-fail",
    "worker-stop-fail",
    "postflight-drift",
    "postflight-baseline-mismatch",
    "malformed",
    "oversized",
    "secret-canary",
    "docker-unavailable",
    "duplicate-worker",
    "foreign-container",
    "missing-worker",
    "ss-unavailable",
    "systemd-unavailable",
    "wrong-config",
    "wrong-image",
    "sentinel-mutated",
    "sentinel-image-id-mismatch",
    "stale-watchdog-command",
}


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def emit(value: Any, status: int = 0) -> None:
    sys.stdout.buffer.write(canonical(value))
    raise SystemExit(status)


def usage() -> None:
    raise SystemExit(64)


def default_state() -> dict[str, Any]:
    return {
        "ambiguityObserved": False,
        "idempotencyKey": None,
        "hostStatePrepared": False,
        "operation": None,
        "jobRequeues": 0,
        "postflightCalls": 0,
        "prepareCalls": 0,
        "proofCalls": 0,
        "refunds": 0,
        "refundLinked": False,
        "startCalls": 0,
        "stopCalls": 0,
        "workerRunning": False,
        "workerStarts": 0,
        "workerStops": 0,
        "workflows": 0,
    }


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return default_state()
    if path.is_symlink() or not path.is_file():
        usage()
    raw = path.read_bytes()
    try:
        state = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        usage()
    expected = set(default_state())
    if not isinstance(state, dict) or set(state) != expected:
        usage()
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(canonical(state))
            stream.flush()
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def common_observation(revision_exact: bool = True) -> dict[str, Any]:
    return {
        "accountBindingsExact": True,
        "caddyStopped": True,
        "coreStable": True,
        "financialQuiescent": True,
        "firewallClosed": True,
        "liveDisabled": True,
        "maintenanceStopped": True,
        "managedSandboxEffectMatches": True,
        "managedSandboxReadMatches": True,
        "publicListenersClosed": True,
        "revisionExact": revision_exact,
        "sourceExact": True,
        "stripeAppSigningMatches": True,
        "workerStopped": True,
    }


def post_incident_baseline() -> dict[str, Any]:
    counts = {
        "activeFinancialJobs": 0,
        "auditEvents": 12,
        "mutationReceipts": 4,
        "refundExecutionAttempts": 2,
        "refundExecutions": 2,
        "refundRequests": 3,
        "unreleasedPaymentGuards": 0,
        "webhookReceipts": 0,
    }
    projection = json.dumps(counts, sort_keys=True, separators=(",", ":")).encode("ascii")
    return {**counts, "snapshotSha256": hashlib.sha256(projection).hexdigest()}


def main() -> None:
    if len(sys.argv) != 7:
        usage()
    action, revision, operation, idempotency_key, dashboard_authority, fixture_hash = sys.argv[1:]
    if action not in ALLOWED_ACTIONS:
        usage()
    if not HEX40.fullmatch(revision):
        usage()
    for value in (operation, idempotency_key, dashboard_authority, fixture_hash):
        if not HEX64.fullmatch(value):
            usage()
    mode = os.environ.get("REFUNDDESK_INCIDENT_FAKE_MODE", "pass")
    if mode not in ALLOWED_MODES:
        usage()
    state_name = os.environ.get("REFUNDDESK_INCIDENT_FAKE_STATE", "")
    if not state_name:
        usage()
    state_path = Path(state_name).resolve()
    temporary_root = Path(os.environ.get("REFUNDDESK_INCIDENT_FAKE_ROOT", "")).resolve()
    if not str(state_path).startswith(str(temporary_root) + os.sep):
        usage()
    state = load_state(state_path)

    if mode == "malformed":
        sys.stdout.write("not-json\n")
        raise SystemExit(0)
    if mode == "oversized":
        sys.stdout.write("x" * 140000 + "\n")
        raise SystemExit(0)
    if mode == "secret-canary":
        synthetic_canary = "".join(("s", "k", "_test_", "abcdefghijkl", "mnopqrstuvwxyz"))
        emit({"secret": synthetic_canary})

    if action == "preflight":
        observation = common_observation(mode != "wrong-revision")
        if mode in {
            "binding-mismatch",
            "legacy-key",
            "platform-effect-key-in-web",
            "platform-read-key-in-worker",
            "previous-signing-secret",
            "runtime-env-mismatch",
            "runtime-env-extra",
            "env-duplicate",
            "env-malformed",
            "aws-secret-extra",
            "sandbox-effect-key-in-web",
            "sandbox-read-key-in-worker",
        }:
            observation["managedSandboxEffectMatches"] = False
        if mode in {"financial-work", "foreign-job", "webhook-job", "webhook-recovery-job"}:
            observation["financialQuiescent"] = False
        if mode == "public-listener":
            observation["publicListenersClosed"] = False
        if mode == "live-enabled":
            observation["liveDisabled"] = False
        if mode in {
            "docker-unavailable",
            "duplicate-worker",
            "foreign-container",
            "missing-worker",
            "wrong-config",
            "wrong-image",
            "sentinel-mutated",
            "sentinel-image-id-mismatch",
        }:
            observation["caddyStopped"] = False
            observation["coreStable"] = False
            observation["workerStopped"] = False
        if mode == "systemd-unavailable":
            observation["maintenanceStopped"] = False
        if mode == "ss-unavailable":
            observation["publicListenersClosed"] = False
        emit(observation)

    if action == "prepare-state":
        state["prepareCalls"] += 1
        resumed = state["hostStatePrepared"]
        if state["operation"] not in (None, operation) or state["idempotencyKey"] not in (
            None,
            idempotency_key,
        ):
            save_state(state_path, state)
            emit({"prepared": False, "resumed": resumed}, 20)
        state["hostStatePrepared"] = True
        state["operation"] = operation
        state["idempotencyKey"] = idempotency_key
        save_state(state_path, state)
        if mode == "delay-prepare":
            time.sleep(2)
        emit({"prepared": True, "resumed": resumed})

    if action == "start-worker":
        state["startCalls"] += 1
        save_state(state_path, state)
        if mode in {"stale-watchdog-command", "worker-start-fail"}:
            emit({"started": False}, 20)
        if state["workerRunning"] or not state["hostStatePrepared"]:
            emit({"started": False}, 20)
        if mode == "crash-after-stripe-before-link" and state["ambiguityObserved"] and not state["refundLinked"]:
            state["jobRequeues"] += 1
        state["workerRunning"] = True
        state["workerStarts"] += 1
        state["operation"] = operation
        state["idempotencyKey"] = idempotency_key
        save_state(state_path, state)
        if mode == "delay-start":
            time.sleep(2)
        emit({"started": True})

    if action == "proof":
        state["proofCalls"] += 1
        save_state(state_path, state)
        same_operation = state["operation"] in (None, operation)
        same_key = state["idempotencyKey"] in (None, idempotency_key)
        if not state["workerRunning"] or not same_operation:
            emit({"complete": False, "sameIdempotencyKey": same_key}, 20)
        if mode == "client-swap-attempt":
            emit({"complete": False, "sameIdempotencyKey": same_key}, 20)
        if mode == "changed-idempotency":
            same_key = False
        if mode == "crash-before-call-once" and not state["ambiguityObserved"]:
            state["ambiguityObserved"] = True
            save_state(state_path, state)
            emit({"ambiguous": True, "sameIdempotencyKey": same_key}, 75)
        if state["workflows"] == 0:
            state["workflows"] = 2 if mode == "two-workflows" else 1
        if state["refunds"] == 0:
            state["refunds"] = 2 if mode == "two-refunds" else 1
        if mode == "crash-after-stripe-before-link" and not state["ambiguityObserved"]:
            state["ambiguityObserved"] = True
            save_state(state_path, state)
            emit({"ambiguous": True, "sameIdempotencyKey": same_key}, 75)
        if mode in {"ambiguous-once", "ambiguous-always", "crash-after-link-once", "crash-terminal-once"} and (
            mode == "ambiguous-always" or not state["ambiguityObserved"]
        ):
            state["refundLinked"] = True
            state["ambiguityObserved"] = True
            save_state(state_path, state)
            emit({"ambiguous": True, "sameIdempotencyKey": same_key}, 75)
        state["refundLinked"] = True
        save_state(state_path, state)
        if mode == "delay-proof":
            time.sleep(2)
        emit(
            {
                "ambiguousResumeSameKey": state["ambiguityObserved"] and same_key,
                "appSigningAccepted": True,
                "complete": True,
                "deterministicIdempotency": same_key,
                "guardReleased": True,
                "readChargeSucceeded": True,
                "readPaymentIntentSucceeded": True,
                "readRefundCreateDenied": mode != "read-create-allowed",
                "refundCount": state["refunds"],
                "refundIdSha256": hashlib.sha256(b"re_synthetic_incident_admission").hexdigest(),
                "denialRefundSetUnchanged": mode != "read-create-allowed",
                "requesterApproverDistinct": mode != "requester-approver-same",
                "terminalReconciled": True,
                "unrelatedSigningRejected": True,
                "workflowCount": state["workflows"],
            }
        )

    if action == "stop-worker":
        state["stopCalls"] += 1
        save_state(state_path, state)
        if mode == "worker-stop-fail":
            emit({"stopped": False}, 20)
        if state["workerRunning"]:
            state["workerRunning"] = False
            state["workerStops"] += 1
            save_state(state_path, state)
        if mode == "delay-stop":
            time.sleep(2)
        emit({"stopped": True})

    if action == "postflight":
        state["postflightCalls"] += 1
        save_state(state_path, state)
        observation = common_observation()
        baseline = post_incident_baseline()
        if mode == "postflight-baseline-mismatch":
            baseline["auditEvents"] += 1
        observation.update(
            {
                "financialDeltaExact": state["workflows"] == 1 and state["refunds"] == 1 and state["refundLinked"],
                "postIncidentBaseline": baseline,
                "refundCount": state["refunds"],
                "workerStarts": state["workerStarts"],
                "workerStops": state["workerStops"],
                "workflowCount": state["workflows"],
            }
        )
        if mode == "postflight-drift":
            observation["caddyStopped"] = False
        emit(observation)


if __name__ == "__main__":
    main()
