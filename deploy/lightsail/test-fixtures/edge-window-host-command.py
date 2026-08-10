#!/usr/bin/env python3

"""Stateful offline command surface for the ADR 0037 edge-window contracts."""

from __future__ import annotations

import json
import hashlib
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


STATE_PATH = Path(os.environ["REFUNDDESK_EDGE_WINDOW_FAKE_STATE"])
ZERO = "0" * 64


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def load_state() -> dict[str, Any]:
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    temporary = STATE_PATH.with_name(f".{STATE_PATH.name}.{os.getpid()}")
    temporary.write_text(canonical(state) + "\n", encoding="utf-8")
    os.replace(temporary, STATE_PATH)


def emit(value: dict[str, Any]) -> int:
    sys.stdout.write(canonical(value) + "\n")
    return 0


def record(state: dict[str, Any], operation: str) -> None:
    state.setdefault("operations", []).append(operation)


def refresh_watchdog_receipt() -> None:
    control_root = Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"])
    marker_path = control_root / "edge-window-watchdog.json"
    receipt_path = control_root / "edge-window-watchdog-preflight.json"
    marker_raw = marker_path.read_bytes()
    marker = json.loads(marker_raw.decode("ascii"))
    receipt = {
        "bootIdSha256": hashlib.sha256(marker["bootId"].encode("ascii")).hexdigest(),
        "caddyContainerId": marker["caddyContainerId"],
        "expectedRevision": marker["expectedRevision"],
        "kind": "refunddesk.edge-window-watchdog-preflight",
        "markerSha256": hashlib.sha256(marker_raw).hexdigest(),
        "nonce": marker["nonce"],
        "observedAtEpoch": marker["deadlineEpoch"] - 60,
        "observedBoottimeMilliseconds": marker["armedBoottimeMilliseconds"] + 1000,
        "schemaVersion": 1,
        "workerContainerId": marker["workerContainerId"],
    }
    receipt_path.write_text(canonical(receipt) + "\n", encoding="utf-8")


def snapshot(state: dict[str, Any]) -> dict[str, int]:
    return dict(
        state.get(
            "counts",
            {
                "activeFinancialJobs": 0,
                "auditEvents": 2088,
                "mutationReceipts": 34,
                "refundExecutionAttempts": 34,
                "refundExecutions": 34,
                "refundRequests": 34,
                "unreleasedPaymentGuards": 0,
                "webhookReceipts": 41,
            },
        )
    )


def transport_digest(name: str) -> str:
    transport = json.loads(
        Path(os.environ["REFUNDDESK_EDGE_WINDOW_TRANSPORT_FILE"]).read_text(encoding="utf-8")
    )
    value = transport.get(name)
    if not isinstance(value, str):
        raise ValueError(f"missing transport string: {name}")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def timestamp(state: dict[str, Any]) -> int:
    timestamps = state.setdefault(
        "timestamps",
        [
            "2026-08-08T12:00:00Z",
            "2026-08-08T12:00:20Z",
            "2026-08-08T12:00:30Z",
            "2026-08-08T12:01:30Z",
            "2026-08-08T12:01:40Z",
        ],
    )
    index = int(state.get("timestampIndex", 0))
    if state.get("scenario") == "checkpoint-timeout" and index >= 3:
        value = "2026-08-08T12:05:01Z"
    else:
        value = timestamps[min(index, len(timestamps) - 1)]
    state["timestampIndex"] = index + 1
    state["lastTimestamp"] = value
    save_state(state)
    sys.stdout.write(value + "\n")
    return 0


def operation_clock(state: dict[str, Any]) -> int:
    value = state.get("operationClockEpoch")
    if value is None:
        observed = state.get("lastTimestamp", "2026-08-08T12:00:00Z")
        value = int(datetime.strptime(observed, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return 1
    sys.stdout.write(f"{value}\n")
    return 0


def prefix_patch(state: dict[str, Any]) -> dict[str, Any]:
    scenario = state.get("scenario", "pass")
    if scenario == "malformed-prefix":
        return {"error": "PREFIX_MALFORMED"}
    if scenario == "oversize":
        return {"padding": "x" * 40000}
    return {
        "prefixes": {
            "allowlistSha256": "7" * 64,
            "canonical": True,
            "createDate": "2026-08-08T11:58:00Z",
            "documentSha256": "8" * 64,
            "exactService": True,
            "fetchedAt": state.get("prefixFetchedAt", "2026-08-08T12:00:05Z"),
            "firewallMatched": False,
            "fresh": scenario != "stale-prefix",
            "ipv4Count": 12,
            "ipv6Count": 4,
            "service": "CLOUDFRONT_ORIGIN_FACING",
            "source": "AWS_PUBLIC_IP_RANGES",
            "syncToken": "1754654280",
        }
    }


def origin_bind_patch(state: dict[str, Any]) -> dict[str, Any]:
    scenario = state.get("scenario", "pass")
    if scenario in {
        "cloudfront-prebind-default-route-drift",
        "cloudfront-prebind-ordered-route-drift",
        "cloudfront-prebind-edge-association",
        "cloudfront-prebind-custom-error-response",
        "cloudfront-prebind-continuous-deployment",
        "cloudfront-prebind-web-acl",
    }:
        return {"error": "TOPOLOGY_INVALID"}
    if scenario == "origin-caddy-temp-crash" and not state.get("caddyTempEffectObserved"):
        state["caddyTempEffectObserved"] = True
        state["caddyTempResidue"] = True
        state["caddyTokenState"] = "transient"
        state["hostTokenRewriteCount"] = state.get("hostTokenRewriteCount", 0) + 1
        return {"error": "TOOL_UNAVAILABLE"}
    if scenario == "etag-race":
        return {"error": "ETAG_RACE"}
    if scenario == "never-deployed":
        return {"error": "NEVER_DEPLOYED"}
    state["originBound"] = True
    state["originProviderState"] = "bound"
    state["caddyTokenState"] = "transient"
    state["hostTokenRewriteCount"] = state.get("hostTokenRewriteCount", 0) + 1
    state["originProviderUpdateCount"] = state.get("originProviderUpdateCount", 0) + 1
    if scenario == "origin-bind-lost-ack" and not state.get("bindAckLost"):
        state["bindAckLost"] = True
        return {"error": "ETAG_RACE"}
    state["preparedCaddyContainerId"] = "c" * 64
    return {
        "intents": {"preparedCaddyContainerId": "c" * 64},
        "mutations": {"originUpdates": 1},
        "origin": {
            "bound": True,
            "boundDeployed": True,
            "distributionIdSha256": transport_digest("distributionId"),
            "etagBindMatched": True,
            "originIdSha256": transport_digest("originId"),
            "originMatched": True,
            "secretMaterialEmitted": False,
            "tokenGenerated": True,
            "tokenLengthBytes": 32,
            "tokenWrittenRootOnly": True,
            "updateAttempts": 1,
        }
    }


def firewall_open_patch(state: dict[str, Any]) -> dict[str, Any]:
    scenario = state.get("scenario", "pass")
    state["firewallOpen"] = True
    state["listeners"] = {"tcp80": False, "tcp443": True, "udp80": False, "udp443": False}
    return {
        "firewall": {
            "beforeSha256": "9" * 64,
            "exactPrefixSet": True,
            "openObserved": True,
            "openedSha256": "d" * 64,
            "port80Closed": scenario != "port80",
            "sshUnchanged": scenario != "ssh-drift",
            "tcp443Only": scenario not in {"port80", "udp", "wildcard"},
            "udpClosed": scenario != "udp",
            "wildcardAbsent": scenario != "wildcard",
        },
        "prefixes": {"firewallMatched": True},
    }


def publish_checkpoint(state: dict[str, Any], arguments: list[str]) -> dict[str, Any]:
    if state.get("scenario") in {"checkpoint-timeout", "crash-before-checkpoint"}:
        return {}
    path, request_path, nonce, revision, fingerprint, opened_at, deadline_at = arguments
    captured_at = state.get("workbenchCapturedAt", "2026-08-08T12:01:00Z")
    if state.get("scenario") == "checkpoint-before-open":
        captured_at = "2026-08-08T12:00:29Z"
    if state.get("scenario") == "checkpoint-after-deadline":
        captured_at = "2026-08-08T12:05:01Z"
    document = {
        "capturedAt": captured_at,
        "cliUsed": state.get("scenario") == "checkpoint-cli",
        "duplicate": state.get("scenario") != "checkpoint-not-duplicate",
        "eventFingerprintSha256": fingerprint,
        "expectedRevision": revision,
        "httpStatus": 200,
        "kind": "refunddesk.operator-workbench-replay",
        "nonce": nonce,
        "receiver": "REFUNDDESK_CREATE_NEW_V1",
        "requestSha256": __import__("hashlib").sha256(Path(request_path).read_bytes()).hexdigest(),
        "schemaVersion": 1,
        "source": "OPERATOR_WORKBENCH",
    }
    checkpoint = Path(path)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if state.get("scenario") == "checkpoint-race":
        descriptor = os.open(checkpoint, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(canonical({"kind": "raced"}) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    descriptor = os.open(checkpoint, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(canonical(document) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    if state.get("scenario") == "checkpoint-overwrite-race":
        raced = {**document, "httpStatus": 201}
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import os,sys,time; time.sleep(0.05); "
                    "fd=os.open(sys.argv[1],os.O_WRONLY|os.O_TRUNC); "
                    "data=sys.argv[2].encode('utf-8'); os.write(fd,data); os.fsync(fd); os.close(fd)"
                ),
                str(checkpoint),
                canonical(raced) + "\n",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    state["workbenchPublished"] = True
    return {}


def runner_operation(state: dict[str, Any], operation: str, arguments: list[str]) -> dict[str, Any]:
    scenario = state.get("scenario", "pass")
    if (
        scenario == "runner-adapter-ignore-term"
        and operation == "prefix-fetch"
        and not state.get("runnerAdapterTermIgnored")
    ):
        state["runnerAdapterTermIgnored"] = True
        record(state, "runner:adapter-term-ignored:prefix-fetch")
        save_state(state)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(60)
        return {"error": "TOOL_UNAVAILABLE"}
    if operation == "aws-baseline":
        if scenario in {
            "cloudfront-default-route-mismatch",
            "cloudfront-ordered-route-mismatch",
            "cloudfront-edge-association",
            "cloudfront-custom-error-response",
            "cloudfront-continuous-deployment",
            "cloudfront-web-acl",
            "maintenance-timer-enabled",
            "residual-watchdog-marker",
            "watchdog-timer-enabled-inactive",
        }:
            return {"error": "TOPOLOGY_INVALID"}
        transport = json.loads(
            Path(os.environ["REFUNDDESK_EDGE_WINDOW_TRANSPORT_FILE"]).read_text(encoding="utf-8")
        )
        digest = lambda value: __import__("hashlib").sha256(value.encode("utf-8")).hexdigest()
        topology = {
            "accountMatched": True,
            "aliasMatched": True,
            "awsAccountIdSha256": digest(transport["awsAccountId"]),
            "awsRegionSha256": digest(transport["awsRegion"]),
            "distributionDeployed": True,
            "distributionEnabled": True,
            "hostRevisionMatched": True,
            "hostSourcesMatched": True,
            "instanceMatched": True,
            "instanceRunning": True,
            "originDomainMatched": True,
            "runtimeContainersMatched": True,
            "sshCidrSha256": digest(transport["expectedSshCidr"]),
            "sshInstanceMatched": True,
        }
        if scenario == "topology-instance-mismatch":
            topology["sshInstanceMatched"] = False
        if scenario == "topology-origin-mismatch":
            topology["originDomainMatched"] = False
        if scenario == "topology-runtime-mismatch":
            topology["runtimeContainersMatched"] = False
        return {"topology": topology}
    database_invariants = {
        "activeWorkflows": 0,
        "liveInstallations": 0,
        "liveTenants": 0,
        "preparedTransactions": 0,
        "systemIdentifierSha256": "6" * 64,
    }
    if operation == "counts-before":
        return {"counts": {"before": snapshot(state)}, "database": {"before": database_invariants}}
    if operation == "counts-during":
        value = snapshot(state)
        if scenario == "counts-changed":
            value["refundExecutionAttempts"] += 1
        return {"counts": {"during": value}, "database": {"during": database_invariants}}
    if operation == "counts-after":
        return {"counts": {"after": snapshot(state)}, "database": {"after": database_invariants}}
    if operation == "prefix-fetch":
        if scenario == "operation-deadline-crossing":
            record(state, "runner:slow-prefix-crossed-operation-deadline")
            time.sleep(2)
            state["operationClockEpoch"] = int(
                datetime(2026, 8, 8, 12, 35, 1, tzinfo=timezone.utc).timestamp()
            )
        return prefix_patch(state)
    if operation == "firewall-baseline":
        return {"firewall": {"beforeSha256": "9" * 64}}
    if operation == "host-lease-acquire":
        if state.get("authorizationLease") == "complete":
            return {"error": "LOCK_UNAVAILABLE"}
        if state.get("authorizationLease") not in {None, "held"}:
            return {"error": "LOCK_UNAVAILABLE"}
        if state.get("hostLease") not in {None, "held"}:
            return {"error": "LOCK_UNAVAILABLE"}
        state["hostLease"] = "held"
        state["authorizationLease"] = "held"
        state["hostLeaseAcquireCount"] = state.get("hostLeaseAcquireCount", 0) + 1
        if scenario == "host-lease-acquire-lost-ack" and not state.get(
            "hostLeaseAcquireAckLost"
        ):
            state["hostLeaseAcquireAckLost"] = True
            return {"error": "LOCK_UNAVAILABLE"}
        return {
            "hostLease": {
                "authorizationMarkerState": "held",
                "held": True,
                "holderActive": True,
                "hostLeaseMarkerState": "held",
            }
        }
    if operation == "host-lease-status":
        if state.get("hostLease") == "held" and state.get("authorizationLease") == "held":
            return {
                "hostLease": {
                    "authorizationMarkerState": "held",
                    "held": True,
                    "holderActive": True,
                    "hostLeaseMarkerState": "held",
                }
            }
        return {"error": "LOCK_UNAVAILABLE"}
    if operation == "host-lease-complete":
        enforce_boot = not arguments or arguments[0] != "false"
        if enforce_boot:
            state["hostLeasePassCompletionCount"] = state.get(
                "hostLeasePassCompletionCount", 0
            ) + 1
        else:
            state["hostLeaseCleanupCompletionCount"] = state.get(
                "hostLeaseCleanupCompletionCount", 0
            ) + 1
        require_completion_started = len(arguments) > 1 and arguments[1] == "true"
        if require_completion_started:
            state["hostLeaseRepairOnlyObserved"] = True
        if enforce_boot and (
            state.get("rebootedAfterFinalPostflight") is True
            or state.get("rebootedAfterWatchdogDisarm") is True
        ):
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        if enforce_boot and scenario == "pass-completion-crosses-validity":
            state["completionRejectedAfterValidity"] = True
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        if state.get("hostLease") not in {"held", "complete"}:
            return {"error": "LOCK_UNAVAILABLE"}
        if state.get("authorizationLease") not in {"held", "complete"}:
            return {"error": "LOCK_UNAVAILABLE"}
        if require_completion_started and state.get("hostLease") != "complete":
            return {"error": "LOCK_UNAVAILABLE"}
        if scenario == "host-lease-partial-complete-lost-ack" and not state.get(
            "hostLeasePartialCompleteAckLost"
        ):
            state["hostLease"] = "complete"
            state["hostLeasePartialCompleteAckLost"] = True
            return {"error": "LOCK_UNAVAILABLE"}
        state["hostLease"] = "complete"
        state["authorizationLease"] = "complete"
        if scenario == "host-lease-complete-lost-ack" and not state.get("hostLeaseCompleteAckLost"):
            state["hostLeaseCompleteAckLost"] = True
            return {"error": "LOCK_UNAVAILABLE"}
        return {
            "hostLease": {
                "authorizationMarkerState": "complete",
                "held": True,
                "holderActive": True,
                "hostLeaseMarkerState": "complete",
            }
        }
    if operation == "host-lease-cleanup-status":
        if (
            state.get("hostLease") == "complete"
            and state.get("authorizationLease") == "complete"
            and state.get("hostLeaseReleased") is True
        ):
            return {
                "hostLease": {
                    "authorizationMarkerState": "complete",
                    "held": True,
                    "holderActive": False,
                    "hostLeaseMarkerState": "complete",
                }
            }
        return {"error": "LOCK_UNAVAILABLE"}
    if operation == "host-lease-finalization-status":
        enforce_boot = len(arguments) < 2 or arguments[1] != "false"
        if enforce_boot and (
            state.get("rebootedAfterFinalPostflight") is True
            or state.get("rebootedAfterWatchdogDisarm") is True
        ):
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        if enforce_boot and scenario == "pass-validity-crosses-after-finalization":
            state["timestampIndex"] = 0
            state["timestamps"] = ["2026-08-08T13:00:00Z"]
        if enforce_boot and scenario == "pass-validity-crosses-after-main-validator":
            state["timestampIndex"] = 0
            state["timestamps"] = ["2026-08-08T12:01:40Z", "2026-08-08T13:00:00Z"]
        if (
            state.get("hostLease") == "complete"
            and state.get("authorizationLease") == "complete"
            and state.get("hostLeaseReleased") is True
        ):
            return {
                "hostLease": {
                    "authorizationMarkerState": "complete",
                    "held": True,
                    "holderActive": False,
                    "hostLeaseMarkerState": "complete",
                }
            }
        return {"error": "LOCK_UNAVAILABLE"}
    if operation == "host-lease-release":
        enforce_boot = not arguments or arguments[0] != "false"
        if enforce_boot and (
            state.get("rebootedAfterFinalPostflight") is True
            or state.get("rebootedAfterWatchdogDisarm") is True
        ):
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        if state.get("hostLease") != "complete" or state.get("authorizationLease") != "complete":
            return {"error": "LOCK_UNAVAILABLE"}
        state["hostLeaseReleased"] = True
        if scenario == "host-lease-release-lost-ack" and not state.get("hostLeaseReleaseAckLost"):
            state["hostLeaseReleaseAckLost"] = True
            return {"error": "LOCK_UNAVAILABLE"}
        return {
            "hostLease": {
                "authorizationMarkerState": "complete",
                "held": True,
                "holderActive": False,
                "hostLeaseMarkerState": "complete",
            }
        }
    if operation == "origin-bind":
        return origin_bind_patch(state)
    if operation == "watchdog-arm":
        if scenario in {"watchdog-effective-unit-drift", "watchdog-effective-unit-argv-drift"}:
            return {"error": "WATCHDOG_INVALID"}
        state["watchdogArmed"] = True
        refresh_watchdog_receipt()
        return {
            "mutations": {"watchdogArms": 1},
            "watchdog": {
                "activeBeforeIngress": True,
                "armedBoottimeMilliseconds": 100000,
                "armedBeforeIngress": True,
                "bootIdSha256": "b" * 64,
                "deadlineBoottimeMilliseconds": 370000,
            },
        }
    if operation == "caddy-start":
        marker_path = Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"]) / "edge-window-watchdog.json"
        if not marker_path.is_file():
            return {"error": "WATCHDOG_INVALID"}
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"error": "WATCHDOG_INVALID"}
        if (
            marker.get("state") != "armed"
            or marker.get("startDeadlineBoottimeMilliseconds") is not None
            or marker.get("caddyContainerId") != state.get("preparedCaddyContainerId", "c" * 64)
        ):
            return {"error": "WATCHDOG_INVALID"}
        marker["state"] = "armed_running"
        marker["startDeadlineBoottimeMilliseconds"] = None
        marker_path.write_text(canonical(marker) + "\n", encoding="utf-8")
        refresh_watchdog_receipt()
        state["caddyRunning"] = True
        state["caddyRestart"] = "no"
        state["listeners"] = {"tcp80": True, "tcp443": True, "udp80": False, "udp443": False}
        return {"mutations": {"caddyStarts": 1}}
    if operation == "local-probe":
        return {
            "origin": {"tokenMatched": True},
            "probes": {
                "localCaddy": {
                    "backendStripStatus": 401,
                    "correctTokenStatus": 200,
                    "missingTokenStatus": 404,
                    "tokenStripped": True,
                    "wrongTokenStatus": 404,
                }
            },
        }
    if operation == "firewall-open":
        if scenario == "firewall-open-lost-ack":
            firewall_open_patch(state)
            return {"error": "FIREWALL_INVALID"}
        patch = firewall_open_patch(state)
        if scenario == "watchdog-contained-during-firewall-open":
            marker_path = Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"]) / "edge-window-watchdog.json"
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["state"] = "contained"
            marker["triggered"] = True
            marker_path.write_text(canonical(marker) + "\n", encoding="utf-8")
            return {"error": "FIREWALL_INVALID"}
        return patch
    if operation == "public-health":
        if scenario == "public-health-body-overflow":
            return {"error": "PUBLIC_HEALTH_INVALID"}
        return {
            "probes": {
                "publicHealth": {
                    "cloudFrontObserved": True,
                    "noStore": True,
                    "revisionMatches": True,
                    "status": 200,
                }
            }
        }
    if operation == "checkpoint-publish":
        return publish_checkpoint(state, arguments)
    if operation == "firewall-close":
        if scenario == "close-ambiguous":
            return {"error": "CLOSE_AMBIGUOUS"}
        if scenario == "external-preclosed":
            state["firewallOpen"] = False
        extra_observed = scenario in {
            "firewall-extra-after-open-port80-udp",
            "firewall-extra-after-open-wildcard",
        }
        changed = state.get("firewallOpen", False)
        state["firewallOpen"] = False
        state["firewallExtraRuleClosed"] = extra_observed
        state["firewallCloseCount"] = state.get("firewallCloseCount", 0) + (1 if changed else 0) + (1 if extra_observed else 0)
        return {
            "containment": {"awsIngressClosed": True},
            "firewall": {
                "afterSha256": "9" * 64,
                "beforeSha256": "9" * 64,
                "closeAmbiguous": scenario == "firewall-close-proof-ambiguous-safe" or extra_observed,
                "closeAttemptedFirst": True,
                "closeObserved": True,
                "finalClosed": True,
            },
            "mutations": {"firewallCloses": state["firewallCloseCount"]},
        }
    if operation == "window-clock-stop":
        if scenario == "reboot-after-deadline":
            return {"error": "WINDOW_MONOTONIC_INVALID"}
        if scenario == "reboot-before-final-postflight":
            # The close observation belongs to the armed boot.  Model a reboot
            # immediately after its successful return, before the final
            # postflight request is created.
            state["rebootedAfterWindowClockStop"] = True
            state["bootId"] = "87654321-4321-4321-8321-cba987654321"
        return {
            "watchdog": {
                "closedBoottimeMilliseconds": 250000,
                "monotonicBounded": True,
                "monotonicDurationMilliseconds": 150000,
            }
        }
    if operation == "window-clock-open-guard":
        if scenario == "deadline-before-open":
            return {"error": "WINDOW_MONOTONIC_INVALID"}
        return {}
    if operation == "window-boot-guard":
        if (
            state.get("rebootedAfterFinalPostflight") is True
            or state.get("rebootedAfterWatchdogDisarm") is True
            or state.get("rebootedAfterWindowClockStop") is True
        ):
            return {"error": "WINDOW_MONOTONIC_INVALID"}
        return {}
    if operation == "origin-unbind":
        if scenario == "origin-unbind-fail":
            return {"error": "ETAG_RACE"}
        if scenario == "origin-unbind-lost-ack" and not state.get("unbindAckLost"):
            state["originBound"] = False
            state["originProviderState"] = "original"
            state["caddyTokenState"] = "restored"
            state["originUnbindCount"] = state.get("originUnbindCount", 0) + 1
            state["originProviderUpdateCount"] = state.get("originProviderUpdateCount", 0) + 1
            state["caddyRecreateCount"] = state.get("caddyRecreateCount", 0) + 1
            state["unbindAckLost"] = True
            return {"error": "ETAG_RACE"}
        was_bound = state.get("originBound") is True or state.get("caddyTokenState") == "transient"
        state["originBound"] = False
        state["originProviderState"] = "original"
        state["caddyTokenState"] = "restored"
        state["caddyTempResidue"] = False
        final_caddy_id = "d" * 64
        state["currentCaddyContainerId"] = final_caddy_id
        marker_path = Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"]) / "edge-window-watchdog.json"
        receipt_path = (
            Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"])
            / "edge-window-watchdog-preflight.json"
        )
        if marker_path.exists():
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["caddyContainerId"] = final_caddy_id
            marker_raw = (canonical(marker) + "\n").encode("ascii")
            marker_path.write_bytes(marker_raw)
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                receipt["caddyContainerId"] = final_caddy_id
                receipt["markerSha256"] = hashlib.sha256(marker_raw).hexdigest()
                receipt_path.write_text(canonical(receipt) + "\n", encoding="utf-8")
        if was_bound:
            state["originUnbindCount"] = state.get("originUnbindCount", 0) + 1
            state["originProviderUpdateCount"] = state.get("originProviderUpdateCount", 0) + 1
            state["caddyRecreateCount"] = state.get("caddyRecreateCount", 0) + 1
        return {
            "containment": {"originHeaderRemoved": True},
            "mutations": {"originUpdates": 2 if was_bound else 0},
            "origin": {
                "etagBindMatched": state.get("originProviderUpdateCount", 0) > 0
                and scenario != "origin-bind-lost-ack",
                "etagUnbindMatched": scenario != "origin-unbind-lost-ack",
                "headerRemoved": True,
                "unboundDeployed": True,
                "updateAttempts": 2
                if was_bound or scenario in {"origin-bind-lost-ack", "origin-unbind-lost-ack"}
                else 0,
            },
            "topology": {
                "finalCaddyContainerIdSha256": hashlib.sha256(final_caddy_id.encode("ascii")).hexdigest()
            },
        }
    if operation == "origin-status":
        if state.get("originGcCount", 0) > 0 and state.get("originStatusReceipt") is not True:
            return {"error": "ETAG_RACE"}
        if state.get("originProviderState", "original") != "original":
            return {"error": "ETAG_RACE"}
        if state.get("originBound") is True:
            return {"error": "ETAG_RACE"}
        if state.get("caddyTokenState", "restored") != "restored":
            return {"error": "ETAG_RACE"}
        state["originStatusReceipt"] = True
        boot_stable = not (
            state.get("rebootedAfterFinalPostflight") is True
            or state.get("rebootedAfterWatchdogDisarm") is True
            or state.get("rebootedAfterWindowClockStop") is True
        )
        return {
            "containment": {"originHeaderRemoved": True},
            "origin": {
                "etagBindMatched": state.get("originProviderUpdateCount", 0) > 0
                and scenario != "origin-bind-lost-ack",
                "etagUnbindMatched": scenario != "origin-unbind-lost-ack",
                "headerRemoved": True,
                "unboundDeployed": True,
            },
            "topology": {
                "finalCaddyContainerIdSha256": hashlib.sha256(
                    state.get("currentCaddyContainerId", "d" * 64).encode("ascii")
                ).hexdigest()
            },
            "watchdog": {"failSafeContained": boot_stable},
        }
    if operation == "origin-secret-scan":
        if state.get("caddyTempResidue") is True or state.get("originSecretCanary") is True:
            return {"error": "TOOL_UNAVAILABLE"}
        return {"intents": {"originGcScanPassed": True}}
    if operation == "origin-gc":
        if scenario == "origin-gc-fail":
            return {"error": "TOOL_UNAVAILABLE"}
        if state.get("originStatusReceipt") is not True:
            return {"error": "TOOL_UNAVAILABLE"}
        state["originGcCount"] = state.get("originGcCount", 0) + 1
        return {
            "containment": {"tokenRemoved": True},
            "origin": {"tokenFileRemoved": True},
        }
    if operation == "host-contain":
        if scenario == "host-contain-fail-after-open":
            return {"error": "REMOTE_STATE_UNAVAILABLE"}
        state["caddyRunning"] = False
        state["workerRunning"] = False
        state["caddyRestart"] = "no"
        state["workerRestart"] = "no"
        state["listeners"] = {"tcp80": False, "tcp443": False, "udp80": False, "udp443": False}
        control_root = Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"])
        runtime_root = Path(os.environ["REFUNDDESK_EDGE_WINDOW_RUNTIME_ROOT"])
        marker_path = control_root / "edge-window-watchdog.json"
        receipt_path = control_root / "edge-window-watchdog-preflight.json"
        trigger_paths = [
            control_root / "edge-window-watchdog-triggered",
            runtime_root / "edge-window-watchdog-triggered",
        ]
        marker_required = (
            scenario == "watchdog-marker-written-crash"
            or state.get("watchdogArmed", False)
            or "watchdog-arm" in state.get("operations", [])
        )
        previously_disarmed = state.get("watchdogDisarmed") is True
        continuity_valid = (
            scenario != "watchdog-marker-written-crash"
            and (marker_path.exists() or not marker_required or previously_disarmed)
        )
        marker_was_contained = False
        marker_was_triggered = any(path.exists() for path in trigger_paths)
        if marker_path.exists():
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker_was_contained = marker.get("state") == "contained"
            marker_was_triggered = marker_was_triggered or marker.get("triggered") is True
            marker["state"] = "contained"
            marker["startDeadlineBoottimeMilliseconds"] = None
            marker["triggered"] = marker_was_triggered or (
                marker_was_contained and state.get("hostContainCount", 0) == 0
            )
            marker["metrics"] = {
                "containersRestartFenced": 2,
                "containersStopped": 2,
                "unitsStopRequested": 5,
            }
            marker_raw = (canonical(marker) + "\n").encode("ascii")
            marker_path.write_bytes(marker_raw)
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                receipt["caddyContainerId"] = marker["caddyContainerId"]
                receipt["workerContainerId"] = marker["workerContainerId"]
                receipt["markerSha256"] = hashlib.sha256(marker_raw).hexdigest()
                receipt_path.write_text(canonical(receipt) + "\n", encoding="utf-8")
        previously_contained = state.get("hostContainCount", 0) > 0
        state["hostContainCount"] = state.get("hostContainCount", 0) + 1
        return {
            "containment": {
                "caddyStopped": True,
                "maintenanceStopped": True,
                "publicListenersClosed": True,
                "workerStopped": True,
            },
            "mutations": {
                "containersRestartFenced": 2,
                "containersStopped": 2,
                "unitsStopRequested": 5,
            },
            "watchdog": {
                "caddyFenced": True,
                "failSafeContained": continuity_valid,
                "maintenanceStopped": True,
                "publicListenersClosed": True,
                "triggered": marker_was_triggered or (
                    marker_was_contained and not previously_contained
                ),
                "workerFenced": True,
            },
        }
    if operation == "watchdog-disarm":
        enforce_boot = not arguments or arguments[0] != "false"
        if enforce_boot and state.get("rebootedAfterFinalPostflight") is True:
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        control_root = Path(os.environ["REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT"])
        runtime_root = Path(os.environ["REFUNDDESK_EDGE_WINDOW_RUNTIME_ROOT"])
        marker_path = control_root / "edge-window-watchdog.json"
        receipt_path = control_root / "edge-window-watchdog-preflight.json"
        marker_required = (
            scenario == "watchdog-marker-written-crash"
            or state.get("watchdogArmed", False)
            or "watchdog-arm" in state.get("operations", [])
        )
        continuity_valid = (
            scenario not in {"watchdog-disabled-after-arm", "watchdog-marker-written-crash"}
            and (
                not marker_required
                or marker_path.exists()
                or state.get("watchdogDisarmed") is True
            )
        )
        state["watchdogArmed"] = False
        state["watchdogDisarmed"] = True
        marker_path.unlink(missing_ok=True)
        receipt_path.unlink(missing_ok=True)
        (control_root / "edge-window-watchdog-triggered").unlink(missing_ok=True)
        (runtime_root / "edge-window-watchdog-triggered").unlink(missing_ok=True)
        if scenario == "reboot-after-watchdog-disarm":
            state["rebootedAfterWatchdogDisarm"] = True
            state["bootId"] = "87654321-4321-4321-8321-cba987654321"
        if scenario == "provider-rebound-after-watchdog-disarm":
            state["originProviderState"] = "bound"
            state["originBound"] = True
        return {
            "containment": {"markerComplete": True, "watchdogDisarmed": True},
            "watchdog": {
                "disarmed": True,
                "failSafeContained": continuity_valid,
                "markerComplete": True,
            },
        }
    if operation == "final-postflight":
        if scenario == "reboot-after-deadline":
            state["finalPostflightRejectedOldBoot"] = True
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        if state.get("rebootedAfterWindowClockStop") is True:
            return {"error": "FINAL_CONTAINMENT_INVALID"}
        if scenario in {"final-postflight-fail", "final-postflight-baseline-drift"}:
            return {"containment": {"finalPostflightPass": False}}
        if scenario == "provider-rebound-during-final-postflight":
            state["originProviderState"] = "bound"
            state["originBound"] = True
        if scenario == "secret-resurrected-during-final-postflight":
            state["originSecretCanary"] = True
        if scenario == "reboot-after-final-postflight":
            state["rebootedAfterFinalPostflight"] = True
            state["bootId"] = "87654321-4321-4321-8321-cba987654321"
        captured_at = state.get("finalPostflightCapturedAt", state.get("lastTimestamp", "2026-08-08T12:01:35Z"))
        valid_until = (
            datetime.strptime(captured_at, "%Y-%m-%dT%H:%M:%SZ") + timedelta(minutes=15)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {
            "containment": {
                "coreHealthy": True,
                "finalPostflightContained": True,
                "finalPostflightPass": True,
                "financialQuiescent": True,
                "financialStable": True,
                "liveDisabled": True,
            },
            "probes": {
                "finalPostflight": {
                    "capturedAt": captured_at,
                    "contained": True,
                    "evidenceSha256": "1" * 64,
                    "officialValidator": True,
                    "revisionMatches": True,
                    "validationSha256": "2" * 64,
                    "validUntil": valid_until,
                }
            },
        }
    return {"error": "TOOL_UNAVAILABLE"}


def watchdog_operation(state: dict[str, Any], operation: str, arguments: list[str]) -> int:
    if (
        state.get("scenario")
        in {
            "watchdog-worker-hard-fence-budget",
            "watchdog-contained-after-broad-fence",
        }
        and state.get("dockerSocketActive") is False
        and operation
        in {
            "list-container",
            "fence-containers",
            "stop-containers",
            "kill-containers",
            "containers-state",
        }
    ):
        # A Docker API call after the socket fence would socket-activate a new
        # daemon and may recreate docker-proxy/public listeners. The product
        # must make this branch unreachable once broad containment begins.
        state["dockerSocketActive"] = True
        state["caddyRunning"] = True
        state["listeners"] = {
            "tcp80": True,
            "tcp443": True,
            "udp80": True,
            "udp443": True,
        }
        record(state, f"watchdog:docker-api-after-socket:{operation}")
        save_state(state)
    if operation == "unit-contract":
        if state.get("scenario") == "watchdog-effective-unit-hang":
            record(state, "watchdog:unit-contract-hang")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        if state.get("scenario") in {
            "watchdog-effective-unit-drift",
            "watchdog-effective-unit-argv-drift",
        }:
            record(state, "watchdog:unit-contract-drift")
            save_state(state)
            return 1
        return 0
    if operation == "trigger-sync":
        record(state, "watchdog:trigger-sync")
        if state.get("scenario") == "watchdog-trigger-sync-hang" and not state.get(
            "triggerSyncTimedOut"
        ):
            state["triggerSyncTimedOut"] = True
            record(state, "watchdog:trigger-sync-term-ignored")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        save_state(state)
        return 0
    if operation == "receipt-publish-sync":
        record(state, "watchdog:receipt-publish-sync")
        if not state.get("receiptPublishTimedOut"):
            state["receiptPublishTimedOut"] = True
            record(state, "watchdog:receipt-publish-term-ignored")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        save_state(state)
        return 0
    if operation == "docker-socket-fenced":
        safe = state.get("dockerSocketMasked") is True and state.get(
            "dockerSocketActive"
        ) is False and state.get("dockerDaemonActive") is False
        sys.stdout.write(("true" if safe else "false") + "\n")
        return 0
    if operation == "now-epoch":
        if state.get("scenario") == "watchdog-clock-error-now":
            return 1
        if state.get("scenario") == "watchdog-clock-malformed-now":
            sys.stdout.write("not-a-time\n")
            return 0
        sys.stdout.write(str(state.get("nowEpoch", 1786190730)) + "\n")
        return 0
    if operation == "boot-id":
        if state.get("scenario") == "watchdog-clock-error-boot":
            return 1
        sys.stdout.write(state.get("bootId", "12345678-1234-4123-8123-123456789abc") + "\n")
        return 0
    if operation == "boottime-ms":
        if state.get("scenario") == "watchdog-clock-error-boottime":
            return 1
        sys.stdout.write(str(state.get("boottimeMilliseconds", 100000)) + "\n")
        return 0
    if operation == "stop-unit":
        unit = arguments[0]
        if state.get("scenario") == "watchdog-ignore-term" and not state.get("termIgnored"):
            state["termIgnored"] = True
            record(state, f"watchdog:stop-unit-term-ignored:{unit}")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        if state.get("scenario") == "watchdog-stop-unit-timeout" and not state.get("stopUnitFailed"):
            state["stopUnitFailed"] = True
            record(state, f"watchdog:stop-unit-timeout:{unit}")
            save_state(state)
            return 1
        if unit in state.get("releaseUnits", []):
            state["releaseUnits"].remove(unit)
        state.setdefault("unitStates", {})[unit] = "inactive"
        record(state, f"watchdog:stop-unit:{arguments[0]}")
        save_state(state)
        return 0
    if operation == "disable-unit":
        unit = arguments[0]
        state.setdefault("unitStates", {})[unit] = "inactive"
        state.setdefault("unitEnabled", {})[unit] = "disabled"
        record(state, f"watchdog:disable-unit:{unit}")
        save_state(state)
        return 0
    if operation == "unit-state":
        sys.stdout.write(state.get("unitStates", {}).get(arguments[0], "inactive") + "\n")
        return 0
    if operation == "unit-enabled":
        sys.stdout.write(state.get("unitEnabled", {}).get(arguments[0], "disabled") + "\n")
        return 0
    if operation == "list-release-units":
        if state.get("scenario") == "watchdog-release-list-fail":
            return 1
        for unit in state.get("releaseUnits", []):
            sys.stdout.write(unit + "\n")
        return 0
    if operation == "list-active-release-units":
        for unit in state.get("releaseUnits", []):
            if state.get("unitStates", {}).get(unit, "inactive") != "inactive":
                sys.stdout.write(unit + "\n")
        return 0
    if operation == "stop-release-surface":
        record(state, "watchdog:stop-release-surface")
        for unit in state.get("releaseUnits", []):
            state.setdefault("unitStates", {})[unit] = "inactive"
            record(state, f"watchdog:stop-unit:{unit}")
        state["releaseUnits"] = []
        save_state(state)
        return 0
    if operation == "list-container":
        if state.get("scenario") == "watchdog-docker-unavailable":
            record(state, f"watchdog:docker-unavailable:{operation}:{arguments[0]}")
            save_state(state)
            return 1
        service = arguments[0]
        if state.get("scenario") == "watchdog-container-inventory-overflow" and service == "caddy":
            record(state, "watchdog:container-inventory-overflow")
            save_state(state)
            for _ in range(300):
                sys.stdout.write("a" * 64 + "\n")
            return 0
        if state.get("scenario") == "watchdog-duplicate-caddy" and service == "caddy":
            sys.stdout.write("c" * 64 + "\n" + "e" * 64 + "\n")
            return 0
        sys.stdout.write(
            (state.get("currentCaddyContainerId", "c" * 64) if service == "caddy" else "3" * 64)
            + "\n"
        )
        return 0
    if operation == "fence-containers":
        if state.get("scenario") == "watchdog-docker-unavailable":
            record(state, f"watchdog:docker-unavailable:{operation}")
            save_state(state)
            return 1
        for identifier in arguments:
            prefix = identifier[0]
            state["caddyRestart" if prefix in {"c", "d", "e"} else "workerRestart"] = "no"
            record(state, f"watchdog:fence:{prefix}")
        save_state(state)
        return 0
    if operation == "stop-containers":
        if state.get("scenario") == "watchdog-docker-unavailable":
            record(state, f"watchdog:docker-unavailable:{operation}")
            save_state(state)
            return 1
        if state.get("scenario") == "watchdog-duplicate-caddy" and not state.get("bulkStopTimedOut"):
            state["bulkStopTimedOut"] = True
            record(state, "watchdog:bulk-stop-term-ignored")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        for identifier in arguments:
            prefix = identifier[0]
            if prefix in {"c", "d", "e"}:
                state["caddyRunning"] = False
            if prefix == "3":
                state["workerRunning"] = False
            record(state, f"watchdog:stop:{prefix}")
        state["listeners"] = {"tcp80": False, "tcp443": False, "udp80": False, "udp443": False}
        save_state(state)
        return 0
    if operation == "kill-containers":
        for identifier in arguments:
            prefix = identifier[0]
            if prefix in {"c", "d", "e"}:
                state["caddyRunning"] = False
            if prefix == "3":
                state["workerRunning"] = False
            record(state, f"watchdog:kill:{prefix}")
        state["listeners"] = {"tcp80": False, "tcp443": False, "udp80": False, "udp443": False}
        save_state(state)
        return 0
    if operation == "kill-container-scope":
        if len(arguments) != 1 or re.fullmatch(r"[0-9a-f]{64}", arguments[0]) is None:
            return 64
        identifier = arguments[0]
        prefix = identifier[0]
        if state.get("scenario") == "watchdog-deadline-hard-fence-budget" and not state.get(
            "deadlineExactScopeTimedOut"
        ):
            state["deadlineExactScopeTimedOut"] = True
            record(state, f"watchdog:deadline-scope-timeout:{prefix}")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        if (
            state.get("scenario") == "watchdog-worker-hard-fence-budget"
            and prefix == "3"
            and not state.get("deadlineWorkerScopeTimedOut")
        ):
            state["deadlineWorkerScopeTimedOut"] = True
            record(state, "watchdog:deadline-worker-scope-timeout:3")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        if prefix in {"c", "d", "e"}:
            state["caddyRunning"] = False
        if prefix == "3":
            state["workerRunning"] = False
        record(state, f"watchdog:scope-kill:{prefix}")
        if state.get("scenario") not in {
            "watchdog-docker-unavailable",
            "watchdog-listener-drift",
            "watchdog-listener-persists",
            "watchdog-listener-before-slow-worker",
        }:
            state["listeners"] = {
                "tcp80": False,
                "tcp443": False,
                "udp80": False,
                "udp443": False,
            }
        save_state(state)
        return 0
    if operation == "stop-docker-socket":
        state["dockerSocketActive"] = False
        state["dockerSocketMasked"] = True
        record(state, "watchdog:docker-socket-stopped")
        if state.get("scenario") == "watchdog-deadline-hard-fence-budget" and not state.get(
            "deadlineDockerSocketTimedOut"
        ):
            state["deadlineDockerSocketTimedOut"] = True
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        save_state(state)
        return 0
    if operation == "kill-all-container-scopes":
        state["caddyRunning"] = False
        state["workerRunning"] = False
        state["unknownDockerScopeRunning"] = False
        record(state, "watchdog:all-container-scopes-killed")
        if state.get("scenario") == "watchdog-deadline-hard-fence-budget" and not state.get(
            "deadlineAllScopesTimedOut"
        ):
            state["deadlineAllScopesTimedOut"] = True
            state["listeners"] = {
                "tcp80": False,
                "tcp443": False,
                "udp80": False,
                "udp443": False,
            }
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        if state.get("scenario") not in {
            "watchdog-docker-unavailable",
            "watchdog-listener-persists",
        }:
            state["listeners"] = {
                "tcp80": False,
                "tcp443": False,
                "udp80": False,
                "udp443": False,
            }
        save_state(state)
        return 0
    if operation == "kill-docker-daemon":
        state["dockerProxyRunning"] = False
        state["dockerDaemonActive"] = False
        state["dockerDaemonKilledAtBoottimeMilliseconds"] = state.get(
            "boottimeMilliseconds", 100000
        )
        if (
            state.get("unknownDockerScopeRunning") is not True
            and state.get("scenario") != "watchdog-listener-persists"
        ):
            state["listeners"] = {
                "tcp80": False,
                "tcp443": False,
                "udp80": False,
                "udp443": False,
            }
        record(state, "watchdog:docker-daemon-killed")
        if state.get("scenario") == "watchdog-deadline-hard-fence-budget" and not state.get(
            "deadlineDockerDaemonTimedOut"
        ):
            state["deadlineDockerDaemonTimedOut"] = True
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        save_state(state)
        return 0
    if operation == "containers-state":
        if state.get("scenario") == "watchdog-docker-unavailable":
            record(state, f"watchdog:docker-unavailable:{operation}")
            save_state(state)
            return 1
        if (
            state.get("scenario") == "watchdog-listener-before-slow-worker"
            and arguments
            and arguments[0].startswith("3")
            and not state.get("slowWorkerObserved")
        ):
            state["slowWorkerObserved"] = True
            state["boottimeMilliseconds"] = state.get("boottimeMilliseconds", 100000) + 10000
            record(state, "watchdog:slow-worker-after-listener-fence")
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        for identifier in arguments:
            prefix = identifier[0]
            is_caddy = prefix in {"c", "d", "e"}
            running = state.get("caddyRunning" if is_caddy else "workerRunning", False)
            restart = state.get("caddyRestart" if is_caddy else "workerRestart", "no")
            sys.stdout.write(f"{identifier}:{restart}:{str(running).lower()}\n")
        return 0
    if operation == "listener":
        protocol, port = arguments
        if state.get("scenario") in {
            "watchdog-docker-unavailable",
            "watchdog-listener-drift",
            "watchdog-listener-persists",
        }:
            record(state, f"watchdog:listener-check:{protocol}:{port}")
            save_state(state)
        if state.get("listeners", {}).get(f"{protocol}{port}", False):
            if state.get("scenario") == "watchdog-listener-before-slow-worker":
                sys.stdout.write("L" * 1048576)
                return 0
            sys.stdout.write("fixture-listener\n")
        return 0
    if operation == "public-listeners":
        record(state, "watchdog:public-listeners")
        if state.get("scenario") == "watchdog-deadline-hard-fence-budget" and not state.get(
            "deadlineListenerTimedOut"
        ):
            state["deadlineListenerTimedOut"] = True
            save_state(state)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(10)
            return 1
        save_state(state)
        if any(state.get("listeners", {}).values()):
            sys.stdout.write("fixture-listener\n")
        return 0
    return 64


def main() -> int:
    if len(sys.argv) < 2:
        return 64
    state = load_state()
    operation = sys.argv[1]
    arguments = sys.argv[2:]
    if operation == "official-validator-gate":
        record(state, "official-validator-gate")
        if not state.get("officialValidatorRejectedOnce"):
            state["officialValidatorRejectedOnce"] = True
            save_state(state)
            return 1
        save_state(state)
        return 0
    if operation == "terminal-timestamp-gate":
        record(state, "terminal-timestamp-gate")
        if not state.get("terminalTimestampRejectedOnce"):
            state["terminalTimestampRejectedOnce"] = True
            save_state(state)
            return 1
        save_state(state)
        return 0
    if operation == "terminal-temporal-gate":
        record(state, "terminal-temporal-gate")
        if not state.get("terminalTemporalRejectedOnce"):
            state["terminalTemporalRejectedOnce"] = True
            save_state(state)
            return 1
        save_state(state)
        return 0
    if operation == "evidence-substitute-after-validator":
        record(state, "evidence-substitute-after-validator")
        if not state.get("evidenceSubstitutedAfterValidator"):
            if len(arguments) != 1:
                return 64
            evidence_path = Path(arguments[0])
            document = json.loads(evidence_path.read_text(encoding="utf-8"))
            document["watchdog"]["triggered"] = True
            replacement = evidence_path.with_name(
                f".{evidence_path.name}.substitute-{os.getpid()}"
            )
            replacement.write_text(canonical(document) + "\n", encoding="utf-8")
            replacement.chmod(0o600)
            os.replace(replacement, evidence_path)
            state["evidenceSubstitutedAfterValidator"] = True
        save_state(state)
        return 0
    if operation == "evidence-substitute-before-output":
        record(state, "evidence-substitute-before-output")
        if not state.get("evidenceSubstitutedBeforeOutput"):
            if len(arguments) != 1:
                return 64
            evidence_path = Path(arguments[0])
            document = json.loads(evidence_path.read_text(encoding="utf-8"))
            document["watchdog"]["triggered"] = not document["watchdog"]["triggered"]
            replacement = evidence_path.with_name(
                f".{evidence_path.name}.output-substitute-{os.getpid()}"
            )
            replacement.write_text(canonical(document) + "\n", encoding="utf-8")
            replacement.chmod(0o600)
            os.replace(replacement, evidence_path)
            state["evidenceSubstitutedBeforeOutput"] = True
        save_state(state)
        return 0
    if operation == "timestamp":
        return timestamp(state)
    if operation == "operation-clock":
        return operation_clock(state)
    if operation in {
        "now-epoch",
        "boot-id",
        "boottime-ms",
        "disable-unit",
        "stop-unit",
        "list-release-units",
        "list-active-release-units",
        "stop-release-surface",
        "list-container",
        "fence-containers",
        "stop-containers",
        "kill-containers",
        "kill-container-scope",
        "stop-docker-socket",
        "kill-all-container-scopes",
        "kill-docker-daemon",
        "containers-state",
        "unit-state",
        "unit-enabled",
        "unit-contract",
        "listener",
        "public-listeners",
        "trigger-sync",
        "docker-socket-fenced",
        "receipt-publish-sync",
    }:
        return watchdog_operation(state, operation, arguments)
    record(state, operation)
    result = runner_operation(state, operation, arguments)
    save_state(state)
    return emit(result)


if __name__ == "__main__":
    raise SystemExit(main())
