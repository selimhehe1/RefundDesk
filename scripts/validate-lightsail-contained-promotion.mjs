#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const exactPassTopLevelKeys = [
  "code",
  "completedAt",
  "containment",
  "database",
  "fromRevision",
  "inputs",
  "kind",
  "nonce",
  "operationStartedAt",
  "phase",
  "redaction",
  "result",
  "resumed",
  "revision",
  "runtime",
  "schemaVersion",
  "startedAt",
];
const exactNonPassTopLevelKeys = [
  "code",
  "completedAt",
  "effects",
  "fromRevision",
  "inputs",
  "kind",
  "nonce",
  "operationStartedAt",
  "phase",
  "redaction",
  "result",
  "revision",
  "schemaVersion",
  "startedAt",
];
const exactEffectKeys = [
  "caddyStarted",
  "commitReached",
  "containmentReasserted",
  "databaseMigrationAttempted",
  "edgeChanged",
  "financialEffectAttempted",
  "publicServicesStarted",
  "remotePromotionPassed",
  "sourceInstalled",
  "workerStarted",
];
const exactContainmentKeys = [
  "caddyStopped",
  "liveDisabled",
  "maintenanceDisabled",
  "maintenanceStopped",
  "publicListenersAbsent",
  "timersDisabled",
  "verifierHealthy",
  "webHealthy",
  "workerStopped",
];
const exactDatabaseKeys = [
  "activeFinancialJobs",
  "activeWorkflows",
  "apiMutationReceipts",
  "auditEvents",
  "liveInstallations",
  "liveTenants",
  "preparedTransactions",
  "refundExecutionAttempts",
  "refundExecutions",
  "refundRequests",
  "snapshotSha256",
  "stable",
  "systemIdentifier",
  "unreleasedPaymentGuards",
  "webhookReceipts",
];
const exactInputKeys = ["bundleSha256", "manifestSha256", "provenanceSha256", "sourceSha256"];
const exactRedactionKeys = [
  "customerDataPresent",
  "rawApiKeyPresent",
  "rawPayloadPresent",
  "rawSecretPresent",
  "rawSignaturePresent",
  "stderrPresent",
];
const exactRuntimeKeys = [
  "caddyContainerId",
  "postgresContainerId",
  "verifierContainerId",
  "webContainerId",
  "workerContainerId",
  "workerRuntimeMode",
];
const runtimeContainerIdKeys = exactRuntimeKeys.filter((key) => key.endsWith("ContainerId"));
const revisionPattern = /^[0-9a-f]{40}$/u;
const shaPattern = /^[0-9a-f]{64}$/u;
const systemIdentifierPattern = /^[1-9][0-9]{17,19}$/u;

export class PromotionEvidenceError extends Error {}

function fail(message) {
  throw new PromotionEvidenceError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactObject(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) fail(`${label} has unexpected keys`);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !shaPattern.test(value))
    fail(`${label} is not lowercase SHA-256`);
}

function assertCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`${label} is not a safe non-negative integer`);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortDeep(value[key])]),
  );
}

export function canonicalPromotionBytes(value) {
  return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8");
}

export function validatePromotionEvidence(value, expected) {
  if (!isPlainObject(value)) fail("evidence must be an object");
  const pass = value.result === "PASS";
  assertExactObject(value, pass ? exactPassTopLevelKeys : exactNonPassTopLevelKeys, "evidence");
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (value.kind !== "refunddesk-contained-promotion") fail("kind is invalid");
  const operationStartedAt = Date.parse(value.operationStartedAt);
  const startedAt = Date.parse(value.startedAt);
  const completedAt = Date.parse(value.completedAt);
  const timestampPattern = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
  if (
    typeof value.operationStartedAt !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !timestampPattern.test(value.operationStartedAt) ||
    !timestampPattern.test(value.startedAt) ||
    !timestampPattern.test(value.completedAt) ||
    !Number.isFinite(operationStartedAt) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    operationStartedAt > startedAt ||
    completedAt < startedAt ||
    completedAt - startedAt > 900_000
  )
    fail("promotion timestamps are invalid or unordered");
  if (!revisionPattern.test(value.revision)) fail("revision is invalid");
  if (!revisionPattern.test(value.fromRevision) || value.fromRevision === value.revision)
    fail("fromRevision is invalid");
  assertDigest(value.nonce, "nonce");

  assertExactObject(value.inputs, exactInputKeys, "inputs");
  for (const key of exactInputKeys) assertDigest(value.inputs[key], `inputs.${key}`);

  assertExactObject(value.redaction, exactRedactionKeys, "redaction");
  for (const key of exactRedactionKeys) {
    if (value.redaction[key] !== false) fail(`redaction.${key} is not false`);
  }

  if (!pass) {
    const mappings = new Map([
      ["FAIL_CONTAINED_PROMOTION_PRE_COMMIT", "FAIL"],
      ["FAIL_POSTFLIGHT_REJECTED_CONTAINED_PROMOTION", "FAIL"],
      ["INCOMPLETE_CONTAINED_PROMOTION_POST_COMMIT", "INCOMPLETE"],
      ["INCOMPLETE_POSTFLIGHT_FOR_CONTAINED_PROMOTION", "INCOMPLETE"],
    ]);
    if (mappings.get(value.code) !== value.result) fail("non-PASS code/result mapping is invalid");
    if (
      ![
        "pre_journal",
        "prepared",
        "contained",
        "images_loaded",
        "database_prepared",
        "candidate_inert",
        "candidate_verified",
        "committing",
        "metadata_committed",
        "complete",
        "postflight",
      ].includes(value.phase)
    )
      fail("non-PASS phase is invalid");
    assertExactObject(value.effects, exactEffectKeys, "effects");
    for (const key of exactEffectKeys) {
      if (typeof value.effects[key] !== "boolean") fail(`effects.${key} must be boolean`);
    }
    for (const key of [
      "caddyStarted",
      "edgeChanged",
      "financialEffectAttempted",
      "publicServicesStarted",
      "workerStarted",
    ]) {
      if (value.effects[key] !== false) fail(`effects.${key} violates containment`);
    }
    if (value.effects.sourceInstalled !== true) fail("effects.sourceInstalled must be true");
    if (
      value.code === "FAIL_CONTAINED_PROMOTION_PRE_COMMIT" &&
      (value.effects.commitReached ||
        value.effects.remotePromotionPassed ||
        ["committing", "metadata_committed", "complete", "postflight"].includes(value.phase))
    )
      fail("pre-commit failure effects are incoherent");
    if (
      value.code === "INCOMPLETE_CONTAINED_PROMOTION_POST_COMMIT" &&
      (!value.effects.commitReached ||
        value.effects.remotePromotionPassed ||
        !["committing", "metadata_committed", "complete"].includes(value.phase))
    )
      fail("post-commit incomplete effects are incoherent");
    if (
      [
        "FAIL_POSTFLIGHT_REJECTED_CONTAINED_PROMOTION",
        "INCOMPLETE_POSTFLIGHT_FOR_CONTAINED_PROMOTION",
      ].includes(value.code) &&
      (value.phase !== "postflight" ||
        !value.effects.commitReached ||
        !value.effects.remotePromotionPassed)
    )
      fail("postflight effects are incoherent");
  } else {
    if (value.code !== "PASS_CONTAINED_CANDIDATE_PROMOTED") fail("code is invalid");
    if (value.phase !== "complete") fail("phase is not complete");
    if (typeof value.resumed !== "boolean") fail("resumed must be boolean");
    if (value.resumed === false && value.operationStartedAt !== value.startedAt)
      fail("non-resumed promotion timestamps differ");

    assertExactObject(value.containment, exactContainmentKeys, "containment");
    for (const key of exactContainmentKeys) {
      if (value.containment[key] !== true) fail(`containment.${key} is not true`);
    }

    assertExactObject(value.runtime, exactRuntimeKeys, "runtime");
    const containerIds = runtimeContainerIdKeys.map((key) => {
      const identifier = value.runtime[key];
      assertDigest(identifier, `runtime.${key}`);
      return identifier;
    });
    if (new Set(containerIds).size !== containerIds.length)
      fail("runtime container IDs are not unique");
    if (value.runtime.workerRuntimeMode !== "incident_admission")
      fail("runtime.workerRuntimeMode is invalid");

    assertExactObject(value.database, exactDatabaseKeys, "database");
    for (const key of [
      "activeFinancialJobs",
      "activeWorkflows",
      "apiMutationReceipts",
      "auditEvents",
      "liveInstallations",
      "liveTenants",
      "preparedTransactions",
      "refundExecutionAttempts",
      "refundExecutions",
      "refundRequests",
      "unreleasedPaymentGuards",
      "webhookReceipts",
    ]) {
      assertCount(value.database[key], `database.${key}`);
    }
    if (value.database.stable !== true) fail("database.stable is not true");
    if (!systemIdentifierPattern.test(value.database.systemIdentifier))
      fail("database system identifier is invalid");
    assertDigest(value.database.snapshotSha256, "database.snapshotSha256");
    for (const key of [
      "activeFinancialJobs",
      "activeWorkflows",
      "liveInstallations",
      "liveTenants",
      "preparedTransactions",
      "unreleasedPaymentGuards",
    ]) {
      if (value.database[key] !== 0) fail(`database.${key} is not quiescent`);
    }
    const snapshotLine = [
      value.database.systemIdentifier,
      value.database.activeWorkflows,
      value.database.unreleasedPaymentGuards,
      value.database.activeFinancialJobs,
      value.database.liveTenants,
      value.database.liveInstallations,
      value.database.preparedTransactions,
      value.database.refundRequests,
      value.database.refundExecutions,
      value.database.refundExecutionAttempts,
      value.database.webhookReceipts,
      value.database.apiMutationReceipts,
      value.database.auditEvents,
    ].join("|");
    const snapshotSha256 = createHash("sha256").update(snapshotLine).digest("hex");
    if (snapshotSha256 !== value.database.snapshotSha256)
      fail("database snapshot digest is incoherent");
  }

  const bindings = {
    revision: value.revision,
    nonce: value.nonce,
    bundleSha256: value.inputs.bundleSha256,
    manifestSha256: value.inputs.manifestSha256,
    provenanceSha256: value.inputs.provenanceSha256,
    sourceSha256: value.inputs.sourceSha256,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && bindings[key] !== expectedValue)
      fail(`${key} differs from the expected operator binding`);
  }
  return value;
}

function parseArguments(arguments_) {
  const options = {};
  const names = new Map([
    ["--evidence", "evidence"],
    ["--expected-revision", "revision"],
    ["--expected-nonce", "nonce"],
    ["--expected-bundle-sha256", "bundleSha256"],
    ["--expected-manifest-sha256", "manifestSha256"],
    ["--expected-provenance-sha256", "provenanceSha256"],
    ["--expected-source-sha256", "sourceSha256"],
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const property = names.get(arguments_[index]);
    const value = arguments_[index + 1];
    if (!property || value === undefined || Object.hasOwn(options, property))
      fail("invalid validator arguments");
    options[property] = value;
  }
  for (const property of names.values()) {
    if (!Object.hasOwn(options, property)) fail(`missing validator argument: ${property}`);
  }
  if (!revisionPattern.test(options.revision)) fail("expected revision is invalid");
  for (const property of [
    "nonce",
    "bundleSha256",
    "manifestSha256",
    "provenanceSha256",
    "sourceSha256",
  ])
    assertDigest(options[property], `expected ${property}`);
  return options;
}

export async function validatePromotionEvidenceFile(path, expected) {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > 65_536) fail("evidence size is invalid");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    fail("evidence must not contain a BOM");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("evidence is not valid UTF-8 JSON");
  }
  validatePromotionEvidence(value, expected);
  if (!bytes.equals(canonicalPromotionBytes(value))) fail("evidence is not canonical JSON");
  return {
    evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
    value,
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { evidence, ...expected } = options;
    const { evidenceSha256, value } = await validatePromotionEvidenceFile(evidence, expected);
    process.stdout.write(
      `${JSON.stringify({
        code: value.code,
        evidenceSha256,
        kind: value.kind,
        nonce: value.nonce,
        result: value.result,
        revision: value.revision,
        schemaVersion: value.schemaVersion,
      })}\n`,
    );
    if (value.result === "FAIL") process.exitCode = 20;
    if (value.result === "INCOMPLETE") process.exitCode = 21;
  } catch (error) {
    const message =
      error instanceof PromotionEvidenceError ? error.message : "evidence could not be read";
    process.stderr.write(`contained promotion evidence rejected: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
