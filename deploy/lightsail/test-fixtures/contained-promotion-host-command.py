#!/usr/bin/env python3

"""Stateful high-level host surface for contained-promotion contract tests.

The production runner exposes the override only when its root is a disposable
/tmp namespace and explicit test mode is enabled.  This fixture deliberately
has no subprocess or network capability.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


STATE_PATH = Path(os.environ["REFUNDDESK_CONTAINED_PROMOTION_FAKE_STATE"])


def load_state() -> dict[str, Any]:
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    temporary = STATE_PATH.with_name(f".{STATE_PATH.name}.{os.getpid()}")
    temporary.write_text(
        json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, STATE_PATH)


def record(state: dict[str, Any], operation: str) -> None:
    state.setdefault("operations", []).append(operation)
    counts = state.setdefault("operationCounts", {})
    counts[operation] = counts.get(operation, 0) + 1


def should_fail(state: dict[str, Any], operation: str) -> bool:
    if state.get("failOperation") != operation:
        return False
    expected_count = state.get("failOperationCount", 1)
    return state["operationCounts"][operation] == expected_count


def snapshot(state: dict[str, Any]) -> str:
    line = state["databaseLine"]
    if state.get("databaseDriftAfterMigrate") and state.get("migrationCount", 0) >= 1:
        fields = line.split("|")
        fields[-1] = str(int(fields[-1]) + 1)
        line = "|".join(fields)
    postgres = state["postgresContainerId"]
    if state.get("postgresRecreatedAfterMigrate") and state.get("migrationCount", 0) >= 1:
        postgres = "f" * 64
    return f"{postgres}|{line}"


def local_verification(state: dict[str, Any], arguments: list[str]) -> dict[str, Any]:
    if len(arguments) != 3:
        raise ValueError("verify-local argument count")
    _, expected_postgres, expected_database = arguments
    database_line = state["databaseLine"]
    observed_hash = hashlib.sha256(database_line.encode("ascii")).hexdigest()
    if expected_postgres != state["postgresContainerId"] or expected_database != observed_hash:
        raise ValueError("verify-local binding")
    fields = database_line.split("|")
    result: dict[str, Any] = {
        "database": {
            "activeFinancialJobs": int(fields[3]),
            "activeWorkflows": int(fields[1]),
            "apiMutationReceipts": int(fields[11]),
            "auditEvents": int(fields[12]),
            "liveInstallations": int(fields[5]),
            "liveTenants": int(fields[4]),
            "preparedTransactions": int(fields[6]),
            "refundExecutionAttempts": int(fields[9]),
            "refundExecutions": int(fields[8]),
            "refundRequests": int(fields[7]),
            "snapshotSha256": observed_hash,
            "stable": True,
            "systemIdentifier": fields[0],
            "unreleasedPaymentGuards": int(fields[2]),
            "webhookReceipts": int(fields[10]),
        },
        "kind": "refunddesk-contained-local-verification",
        "revision": state["revision"],
        "runtime": {
            "caddyContainerId": state["containers"]["caddy"],
            "postgresContainerId": state["postgresContainerId"],
            "verifierContainerId": state["containers"]["verifier"],
            "webContainerId": state["containers"]["web"],
            "workerContainerId": state["containers"]["worker"],
            "workerRuntimeMode": state.get("workerRuntimeMode", "incident_admission"),
        },
        "schemaVersion": 1,
    }
    if state.get("invalidVerification"):
        result["database"]["stable"] = False
    return result


def main() -> int:
    if len(sys.argv) < 2:
        return 64
    operation = sys.argv[1]
    arguments = sys.argv[2:]
    state = load_state()
    record(state, operation)
    if should_fail(state, operation):
        save_state(state)
        return 1
    if operation == "assert-inventory":
        expected_revision = arguments[0] if arguments else ""
        if expected_revision not in {state["revision"], state["fromRevision"]}:
            save_state(state)
            return 1
        if state.get("foreignContainer") or state.get("missingRuntimeContainer"):
            save_state(state)
            return 1
    elif operation == "assert-owner-reservation":
        if state.get("invalidOwnerReservation"):
            save_state(state)
            return 1
    elif operation == "assert-completed-state":
        if len(arguments) != 6:
            save_state(state)
            return 1
        expected_ids = [
            state["postgresContainerId"],
            state["containers"]["verifier"],
            state["containers"]["web"],
            state["containers"]["worker"],
            state["containers"]["caddy"],
        ]
        if (
            arguments[0] != state["revision"]
            or arguments[1:] != expected_ids
            or not state.get("webRunning")
            or not state.get("verifierRunning")
            or state.get("workerRunning")
            or state.get("caddyRunning")
            or state.get("timersEnabled")
            or state.get("maintenanceRunning")
            or state.get("listenersOpen")
            or state.get("foreignContainer")
            or state.get("missingRuntimeContainer")
            or state.get("invalidOwnerReservation")
            or state.get("workerRuntimeMode", "incident_admission") != "incident_admission"
        ):
            save_state(state)
            return 1
    elif operation == "contain":
        state["workerRunning"] = False
        state["caddyRunning"] = False
        state["webRunning"] = False
        state["verifierRunning"] = False
        state["timersEnabled"] = False
        state["maintenanceRunning"] = False
        state["listenersOpen"] = False
    elif operation == "snapshot":
        sys.stdout.write(snapshot(state) + "\n")
    elif operation in {"load-images", "validate-config"}:
        pass
    elif operation == "migrate":
        state["migrationCount"] = state.get("migrationCount", 0) + 1
    elif operation == "recreate":
        state["workerRunning"] = False
        state["caddyRunning"] = False
        state["webRunning"] = False
        state["verifierRunning"] = False
    elif operation == "start-core":
        state["webRunning"] = True
        state["verifierRunning"] = True
        if state.get("unsafeStartEffectServices"):
            state["workerRunning"] = True
            state["caddyRunning"] = True
    elif operation == "verify-local":
        if (
            not state.get("webRunning")
            or not state.get("verifierRunning")
            or state.get("workerRunning")
            or state.get("caddyRunning")
            or state.get("timersEnabled")
            or state.get("maintenanceRunning")
            or state.get("listenersOpen")
            or state.get("workerRuntimeMode", "incident_admission") != "incident_admission"
        ):
            save_state(state)
            return 1
        try:
            result = local_verification(state, arguments)
        except ValueError:
            save_state(state)
            return 1
        sys.stdout.write(json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n")
    else:
        save_state(state)
        return 64
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
