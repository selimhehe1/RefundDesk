import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PromotionEvidenceError,
  canonicalPromotionBytes,
  validatePromotionEvidence,
} from "./validate-lightsail-contained-promotion.mjs";

const revision = "a".repeat(40);
const fromRevision = "b".repeat(40);
const nonce = "9".repeat(64);
const databaseLine = "123456789012345678|0|0|0|0|0|0|7|3|4|5|6|9";
const snapshotSha256 = createHash("sha256").update(databaseLine).digest("hex");
const expected = {
  bundleSha256: "1".repeat(64),
  manifestSha256: "2".repeat(64),
  nonce,
  provenanceSha256: "3".repeat(64),
  revision,
  sourceSha256: "4".repeat(64),
};

function evidence() {
  return {
    code: "PASS_CONTAINED_CANDIDATE_PROMOTED",
    completedAt: "2026-08-08T20:01:00Z",
    containment: {
      caddyStopped: true,
      liveDisabled: true,
      maintenanceDisabled: true,
      maintenanceStopped: true,
      publicListenersAbsent: true,
      timersDisabled: true,
      verifierHealthy: true,
      webHealthy: true,
      workerStopped: true,
    },
    database: {
      activeFinancialJobs: 0,
      activeWorkflows: 0,
      apiMutationReceipts: 6,
      auditEvents: 9,
      liveInstallations: 0,
      liveTenants: 0,
      preparedTransactions: 0,
      refundExecutionAttempts: 4,
      refundExecutions: 3,
      refundRequests: 7,
      snapshotSha256,
      stable: true,
      systemIdentifier: "123456789012345678",
      unreleasedPaymentGuards: 0,
      webhookReceipts: 5,
    },
    fromRevision,
    inputs: {
      bundleSha256: expected.bundleSha256,
      manifestSha256: expected.manifestSha256,
      provenanceSha256: expected.provenanceSha256,
      sourceSha256: expected.sourceSha256,
    },
    kind: "refunddesk-contained-promotion",
    nonce,
    operationStartedAt: "2026-08-08T20:00:00Z",
    phase: "complete",
    redaction: {
      customerDataPresent: false,
      rawApiKeyPresent: false,
      rawPayloadPresent: false,
      rawSecretPresent: false,
      rawSignaturePresent: false,
      stderrPresent: false,
    },
    result: "PASS",
    resumed: false,
    revision,
    runtime: {
      caddyContainerId: "5".repeat(64),
      postgresContainerId: "6".repeat(64),
      verifierContainerId: "7".repeat(64),
      webContainerId: "8".repeat(64),
      workerContainerId: "9".repeat(64),
      workerRuntimeMode: "incident_admission",
    },
    schemaVersion: 1,
    startedAt: "2026-08-08T20:00:00Z",
  };
}

function nonPassEvidence(result = "FAIL") {
  return {
    code:
      result === "FAIL"
        ? "FAIL_CONTAINED_PROMOTION_PRE_COMMIT"
        : "INCOMPLETE_CONTAINED_PROMOTION_POST_COMMIT",
    completedAt: "2026-08-08T20:01:00Z",
    effects: {
      caddyStarted: false,
      commitReached: result === "INCOMPLETE",
      containmentReasserted: true,
      databaseMigrationAttempted: true,
      edgeChanged: false,
      financialEffectAttempted: false,
      publicServicesStarted: false,
      remotePromotionPassed: false,
      sourceInstalled: true,
      workerStarted: false,
    },
    fromRevision,
    inputs: { ...evidence().inputs },
    kind: "refunddesk-contained-promotion",
    nonce,
    operationStartedAt: "2026-08-08T20:00:00Z",
    phase: result === "FAIL" ? "database_prepared" : "committing",
    redaction: { ...evidence().redaction },
    result,
    revision,
    schemaVersion: 1,
    startedAt: "2026-08-08T20:00:00Z",
  };
}

test("accepts the exact canonical PASS contract", () => {
  const value = evidence();
  assert.equal(validatePromotionEvidence(value, expected), value);
  assert.equal(canonicalPromotionBytes(value).at(-1), 10);
});

test("accepts an immediate same-second terminal outcome", () => {
  const value = nonPassEvidence("FAIL");
  value.completedAt = value.startedAt;
  assert.equal(validatePromotionEvidence(value, expected), value);
});

test("accepts a durable resume after the global operation exceeds fifteen minutes", () => {
  const value = evidence();
  value.operationStartedAt = "2026-08-08T19:00:00Z";
  value.completedAt = "2026-08-08T20:15:00Z";
  value.resumed = true;
  assert.equal(validatePromotionEvidence(value, expected), value);
});

test("accepts the exact pre-journal failure phase", () => {
  const value = nonPassEvidence("FAIL");
  value.phase = "pre_journal";
  value.effects.databaseMigrationAttempted = false;
  assert.equal(validatePromotionEvidence(value, expected), value);
});

for (const result of ["FAIL", "INCOMPLETE"]) {
  test(`accepts the exact canonical ${result} recovery contract`, () => {
    const value = nonPassEvidence(result);
    assert.equal(validatePromotionEvidence(value, expected), value);
    assert.equal(canonicalPromotionBytes(value).at(-1), 10);
  });
}

for (const [name, mutate] of [
  ["extra top-level key", (value) => (value.extra = true)],
  ["wrong result", (value) => (value.result = "FAIL")],
  ["wrong expected binding", (_value, bindings) => (bindings.revision = fromRevision)],
  ["unordered timestamps", (value) => (value.completedAt = "2026-08-08T19:59:59Z")],
  ["invocation over 900 seconds", (value) => (value.completedAt = "2026-08-08T20:15:01Z")],
  ["operation after invocation", (value) => (value.operationStartedAt = "2026-08-08T20:00:01Z")],
  ["non-resumed operation drift", (value) => (value.operationStartedAt = "2026-08-08T19:59:59Z")],
  ["pre-commit phase after commit", (value) => (value.phase = "committing")],
  ["nonquiescent workflow", (value) => (value.database.activeWorkflows = 1)],
  ["incoherent snapshot", (value) => (value.database.snapshotSha256 = "f".repeat(64))],
  [
    "duplicate runtime IDs",
    (value) => (value.runtime.workerContainerId = value.runtime.caddyContainerId),
  ],
  ["wrong worker runtime mode", (value) => (value.runtime.workerRuntimeMode = "normal")],
  ["redaction assertion", (value) => (value.redaction.rawSecretPresent = true)],
  ["containment assertion", (value) => (value.containment.caddyStopped = false)],
]) {
  test(`rejects ${name}`, () => {
    const value = evidence();
    const bindings = { ...expected };
    mutate(value, bindings);
    assert.throws(() => validatePromotionEvidence(value, bindings), PromotionEvidenceError);
  });
}
