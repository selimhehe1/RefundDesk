import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const INCIDENT_ADMISSION_MAX_BYTES = 128 * 1024;
export const DASHBOARD_ATTESTATION_MAX_BYTES = 32 * 1024;
export const FIXTURE_INPUT_MAX_BYTES = 16 * 1024;
export const MIN_REMAINING_SECONDS = 720;
export const MAX_WINDOW_SECONDS = 900;
export const MAX_FUTURE_SECONDS = 120;
export const PASS_CODE = "PASS_INCIDENT_ADMITTED_CONTAINED";

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const DIAGNOSTIC = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/u,
  /\b(?:whsec|absec)_[A-Za-z0-9_]{12,}\b/u,
  /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
]);
const STRIPE_IDENTIFIER =
  /\b(?:acct|ch|evt|pi|re|req|seti|src|tok|cus|pm|in|sub|price|prod)_[A-Za-z0-9_]{6,}\b/u;
const USER_IDENTIFIER = /\busr_[A-Za-z0-9_]{6,}\b/u;
const IP_ADDRESS =
  /(?:^|[^0-9])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?:[^0-9]|$)/u;
const PATH_VALUE = /"(?:[A-Za-z]:\\|\\\\|\/(?:etc|home|opt|run|tmp|var)\/)/u;

const HISTORICAL_HASHES = Object.freeze({
  appSigningExposure: "sha256:ab29955376fea135f14646c7b7dcdd512449d1abbd3645c9befaea9246b7395b",
  apiKeyExposure: "sha256:791c2832500e59b5147e09add7d429e1c871f92e06f73432559156c0d22f9d2f",
  candidatePreflight: "sha256:ec07ef8b14fee601f7339bf8a3837dee0ba3817601fa8330486e758eab10e606",
  cliAuthentication: "sha256:d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7",
  independentReview: "sha256:613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2",
});
const EXPOSED_FINGERPRINTS = Object.freeze({
  managedSandboxEffect: "sha256:25ce0da57b94ad8b1ad76cf0b4e7a6bdd76151cd0ca007dca68e17063d6d1bcf",
  managedSandboxRead: "sha256:ebfdf77852f715252845466e2c24a791670cb6a5443e8b9c052dde6950dc7626",
  stripeAppSigning: "sha256:b4e042f041ff39315b1378a386817af405788f82ac27b962c2876e508ea09156",
});

const FAILURE_CODES = new Set([
  "ADMISSION_AUTHORITY_EXPIRED",
  "TOOL_UNAVAILABLE",
  "OPERATOR_LOCK_UNAVAILABLE",
  "SOURCE_IDENTITY_UNAVAILABLE",
  "SOURCE_IDENTITY_INVALID",
  "INPUT_INVALID",
  "DASHBOARD_AUTHORITY_CHANGED",
  "BINDING_UNAVAILABLE",
  "NEW_ROTATION_REQUIRED",
  "CONTROL_STATE_UNAVAILABLE",
  "MARKER_INVALID",
  "MARKER_TRANSITION_FAILED",
  "CONTAINMENT_INVALID",
  "FINANCIAL_WORK_ACTIVE",
  "WORKER_START_FAILED",
  "WORKER_PROOF_FAILED",
  "WORKER_PROOF_AMBIGUOUS",
  "WORKER_STOP_FAILED",
  "CAPTURE_CHANGED",
  "PROMOTION_INVALID",
  "PROMOTION_REVISION_MISMATCH",
]);

const TOP_KEYS = [
  "schemaVersion",
  "kind",
  "nonce",
  "expectedRevision",
  "repositoryHead",
  "startedAt",
  "completedAt",
  "exitCode",
  "result",
  "code",
  "diagnostics",
  "promotion",
  "marker",
  "bindings",
  "proof",
  "containment",
  "mutations",
  "postIncidentBaseline",
  "redaction",
];
const PROMOTION_KEYS = [
  "candidateRevision",
  "evidenceSha256",
  "bundleSha256",
  "manifestSha256",
  "sourceSha256",
  "provenanceSha256",
  "postflightAfterPromotion",
  "contained",
];
const MARKER_KEYS = [
  "state",
  "resumed",
  "markerTransitions",
  "operationBound",
  "sameIdempotencyKey",
  "complete",
];
const BINDING_KEYS = [
  "filesMode0600",
  "accountBindingsExact",
  "managedSandboxReadMatches",
  "managedSandboxEffectMatches",
  "stripeAppSigningMatches",
  "predecessorBytesRetested",
];
const PROOF_KEYS = [
  "workerStartedPrivately",
  "readPaymentIntentSucceeded",
  "readChargeSucceeded",
  "readRefundCreateDenied",
  "denialRefundSetUnchanged",
  "appSigningAccepted",
  "unrelatedSigningRejected",
  "requesterApproverDistinct",
  "workflowCount",
  "refundCount",
  "deterministicIdempotency",
  "ambiguousResumeSameKey",
  "terminalReconciled",
  "guardReleased",
  "workerStoppedAfter",
];
const CONTAINMENT_KEYS = [
  "sourceExact",
  "liveDisabled",
  "financialBaselineQuiescent",
  "financialDeltaExact",
  "coreStable",
  "caddyStopped",
  "workerStopped",
  "maintenanceStopped",
  "publicListenersClosed",
  "firewallClosed",
  "markerComplete",
];
const MUTATION_KEYS = [
  "workerStarts",
  "workerStops",
  "markerTransitions",
  "workflowsCreated",
  "refundsCreated",
];
const POST_INCIDENT_BASELINE_COUNT_KEYS = Object.freeze([
  "activeFinancialJobs",
  "auditEvents",
  "mutationReceipts",
  "refundExecutionAttempts",
  "refundExecutions",
  "refundRequests",
  "unreleasedPaymentGuards",
  "webhookReceipts",
]);
const POST_INCIDENT_BASELINE_KEYS = Object.freeze([
  ...POST_INCIDENT_BASELINE_COUNT_KEYS,
  "snapshotSha256",
]);
const REDACTION_KEYS = [
  "rawSecretPresent",
  "rawApiKeyPresent",
  "rawSignaturePresent",
  "rawPayloadPresent",
  "customerDataPresent",
  "stripeIdentifierPresent",
  "arbitraryPathPresent",
  "ipAddressPresent",
  "stderrPresent",
  "keyDigestPresent",
];

export class IncidentAdmissionValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "IncidentAdmissionValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new IncidentAdmissionValidationError(code);
}

export function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonKeys(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortJsonKeys(value))}\n`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, location) {
  if (!isPlainObject(value)) fail(`${location}_TYPE_INVALID`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${location}_KEYS_INVALID`);
}

function booleanObject(value, keys, location, expected = undefined) {
  exactKeys(value, keys, location);
  for (const key of keys) {
    if (typeof value[key] !== "boolean") fail(`${location}_${key}_INVALID`);
    if (expected !== undefined && value[key] !== expected) fail(`${location}_${key}_INVALID`);
  }
}

function assertString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
}

function assertInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function validatePostIncidentBaseline(value, location) {
  exactKeys(value, POST_INCIDENT_BASELINE_KEYS, location);
  const counts = {};
  for (const key of POST_INCIDENT_BASELINE_COUNT_KEYS) {
    assertInteger(value[key], 0, Number.MAX_SAFE_INTEGER, `${location}_COUNT_INVALID`);
    counts[key] = value[key];
  }
  assertString(value.snapshotSha256, HEX64, `${location}_SHA_INVALID`);
  const canonical = JSON.stringify(sortJsonKeys(counts));
  const expected = createHash("sha256").update(canonical, "ascii").digest("hex");
  if (value.snapshotSha256 !== expected) fail(`${location}_SHA_MISMATCH`);
  return value;
}

function parseTimestamp(value, code) {
  assertString(value, TIMESTAMP, code);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value.replace("Z", ".000Z")
  ) {
    fail(code);
  }
  return milliseconds;
}

function toBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === "string") return Buffer.from(input, "utf8");
  fail("DOCUMENT_TYPE_INVALID");
}

export function parseSingleJsonDocument(
  input,
  { maximumBytes = INCIDENT_ADMISSION_MAX_BYTES, requireCanonical = true } = {},
) {
  const bytes = toBytes(input);
  if (bytes.length === 0 || bytes.length > maximumBytes) fail("DOCUMENT_SIZE_INVALID");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("DOCUMENT_BOM_INVALID");
  if (bytes.includes(0x00) || bytes.includes(0x0d)) fail("DOCUMENT_CONTROL_INVALID");
  if (bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a))
    fail("DOCUMENT_FRAMING_INVALID");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("DOCUMENT_UTF8_INVALID");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail("DOCUMENT_JSON_INVALID");
  }
  if (!isPlainObject(value)) fail("DOCUMENT_ROOT_INVALID");
  if (requireCanonical && canonicalJson(value) !== text) fail("DOCUMENT_CANONICAL_INVALID");
  return value;
}

function assertNoSensitiveOutput(document) {
  const text = JSON.stringify(document);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) fail("SECRET_CANARY_PRESENT");
  if (STRIPE_IDENTIFIER.test(text) || USER_IDENTIFIER.test(text)) fail("IDENTIFIER_CANARY_PRESENT");
  if (IP_ADDRESS.test(text)) fail("IP_CANARY_PRESENT");
  if (PATH_VALUE.test(text)) fail("PATH_CANARY_PRESENT");
}

function validateRedaction(redaction, location = "REDACTION") {
  booleanObject(redaction, REDACTION_KEYS, location, false);
}

export function validateDashboardAttestation(
  document,
  { now = Date.now(), minimumRemainingSeconds = MIN_REMAINING_SECONDS } = {},
) {
  const top = [
    "schemaVersion",
    "kind",
    "containmentCapturedAt",
    "containmentValidUntil",
    "accountFingerprints",
    "sourceEvidence",
    "exposedFingerprints",
    "credentialRecords",
    "candidateFingerprints",
    "revocation",
    "activityReview",
    "replacementRows",
    "containment",
    "redaction",
  ];
  exactKeys(document, top, "DASHBOARD");
  if (
    document.schemaVersion !== 1 ||
    document.kind !== "refunddesk.stripe.dashboard-incident-attestation"
  ) {
    fail("DASHBOARD_IDENTITY_INVALID");
  }
  const captured = parseTimestamp(document.containmentCapturedAt, "DASHBOARD_CAPTURE_INVALID");
  const validUntil = parseTimestamp(document.containmentValidUntil, "DASHBOARD_EXPIRY_INVALID");
  if (validUntil <= captured || validUntil - captured > MAX_WINDOW_SECONDS * 1000)
    fail("DASHBOARD_WINDOW_INVALID");
  if (captured - now > MAX_FUTURE_SECONDS * 1000) fail("DASHBOARD_FUTURE_INVALID");
  if (validUntil - now < minimumRemainingSeconds * 1000) fail("DASHBOARD_REMAINING_INVALID");

  exactKeys(document.accountFingerprints, ["managedSandbox", "platformTest"], "DASHBOARD_ACCOUNTS");
  for (const value of Object.values(document.accountFingerprints))
    assertString(value, SHA256, "DASHBOARD_ACCOUNT_INVALID");
  if (document.accountFingerprints.managedSandbox === document.accountFingerprints.platformTest) {
    fail("DASHBOARD_ACCOUNTS_NOT_DISTINCT");
  }
  exactKeys(
    document.exposedFingerprints,
    Object.keys(EXPOSED_FINGERPRINTS),
    "DASHBOARD_EXPOSED_FINGERPRINTS",
  );
  for (const [name, expected] of Object.entries(EXPOSED_FINGERPRINTS)) {
    if (document.exposedFingerprints[name] !== expected)
      fail("DASHBOARD_EXPOSED_FINGERPRINT_INVALID");
  }
  exactKeys(
    document.credentialRecords,
    [
      "exposedFullAccessTest",
      "managedSandboxEffect",
      "managedSandboxRead",
      "stripeAppSigning",
      "unintendedPlatformLiveCli",
      "unintendedPlatformTestCli",
    ],
    "DASHBOARD_CREDENTIAL_RECORDS",
  );
  const recordDigests = [];
  for (const [name, expectedState] of [
    ["exposedFullAccessTest", "revoked"],
    ["managedSandboxEffect", "revoked"],
    ["managedSandboxRead", "revoked"],
    ["stripeAppSigning", "revoked"],
    ["unintendedPlatformLiveCli", "deleted"],
    ["unintendedPlatformTestCli", "deleted"],
  ]) {
    const record = document.credentialRecords[name];
    exactKeys(record, ["recordSha256", "state"], `DASHBOARD_CREDENTIAL_RECORD_${name}`);
    assertString(record.recordSha256, SHA256, `DASHBOARD_CREDENTIAL_RECORD_${name}_INVALID`);
    if (record.state !== expectedState) fail(`DASHBOARD_CREDENTIAL_RECORD_${name}_STATE_INVALID`);
    recordDigests.push(record.recordSha256);
  }
  if (new Set(recordDigests).size !== recordDigests.length)
    fail("DASHBOARD_CREDENTIAL_RECORDS_NOT_DISTINCT");
  exactKeys(document.sourceEvidence, Object.keys(HISTORICAL_HASHES), "DASHBOARD_SOURCES");
  for (const [key, expected] of Object.entries(HISTORICAL_HASHES)) {
    if (document.sourceEvidence[key] !== expected) fail("DASHBOARD_HISTORICAL_HASH_INVALID");
  }
  exactKeys(
    document.candidateFingerprints,
    ["managedSandboxRead", "managedSandboxEffect", "stripeAppSigning"],
    "DASHBOARD_CANDIDATES",
  );
  const candidates = Object.values(document.candidateFingerprints);
  for (const value of candidates) assertString(value, SHA256, "DASHBOARD_CANDIDATE_INVALID");
  if (new Set(candidates).size !== candidates.length) fail("DASHBOARD_CANDIDATES_NOT_DISTINCT");
  for (const name of Object.keys(EXPOSED_FINGERPRINTS)) {
    if (document.candidateFingerprints[name] === document.exposedFingerprints[name]) {
      fail(`DASHBOARD_CANDIDATE_${name}_STILL_EXPOSED`);
    }
  }

  booleanObject(
    document.revocation,
    [
      "exposedManagedSandboxRead",
      "exposedManagedSandboxEffect",
      "exposedFullAccessTest",
      "exposedStripeAppSigning",
      "unintendedPlatformTestCliDeleted",
      "unintendedPlatformLiveCliDeleted",
    ],
    "DASHBOARD_REVOCATION",
    true,
  );
  exactKeys(
    document.activityReview,
    ["apiRequestsReviewed", "dashboardActivityReviewed", "unexpectedActivity", "reviewedThrough"],
    "DASHBOARD_ACTIVITY",
  );
  if (
    document.activityReview.apiRequestsReviewed !== true ||
    document.activityReview.dashboardActivityReviewed !== true
  ) {
    fail("DASHBOARD_ACTIVITY_INVALID");
  }
  if (document.activityReview.unexpectedActivity !== false) fail("DASHBOARD_UNEXPECTED_ACTIVITY");
  const reviewedThrough = parseTimestamp(
    document.activityReview.reviewedThrough,
    "DASHBOARD_REVIEW_TIME_INVALID",
  );
  if (reviewedThrough < captured || reviewedThrough - now > MAX_FUTURE_SECONDS * 1000) {
    fail("DASHBOARD_REVIEW_TIME_INVALID");
  }
  exactKeys(
    document.replacementRows,
    ["managedSandboxRead", "managedSandboxEffect", "stripeAppSigning"],
    "DASHBOARD_REPLACEMENTS",
  );
  const permissionKeys = [
    "active",
    "restricted",
    "fullAccess",
    "paymentIntentsRead",
    "chargesRead",
    "refundsRead",
    "refundsCreate",
    "customersRead",
    "unrelatedPermissionCount",
  ];
  for (const [name, refundsCreate] of [
    ["managedSandboxRead", false],
    ["managedSandboxEffect", true],
  ]) {
    const row = document.replacementRows[name];
    exactKeys(row, permissionKeys, `DASHBOARD_REPLACEMENT_${name}`);
    for (const key of permissionKeys.filter((key) => key !== "unrelatedPermissionCount")) {
      if (typeof row[key] !== "boolean") fail(`DASHBOARD_REPLACEMENT_${name}_${key}_INVALID`);
    }
    if (
      row.active !== true ||
      row.restricted !== true ||
      row.fullAccess !== false ||
      row.paymentIntentsRead !== true ||
      row.chargesRead !== true ||
      row.refundsRead !== true ||
      row.refundsCreate !== refundsCreate ||
      row.customersRead !== false ||
      row.unrelatedPermissionCount !== 0
    ) {
      fail(`DASHBOARD_REPLACEMENT_${name}_SCOPE_INVALID`);
    }
  }
  booleanObject(
    document.replacementRows.stripeAppSigning,
    ["active", "current", "predecessorDisabled"],
    "DASHBOARD_REPLACEMENT_SIGNING",
    true,
  );
  booleanObject(
    document.containment,
    ["caddyStopped", "workerStopped", "maintenanceStopped", "portsClosed", "liveDisabled"],
    "DASHBOARD_CONTAINMENT",
    true,
  );
  validateRedaction(document.redaction, "DASHBOARD_REDACTION");
  const authorityProjection = {
    accountFingerprints: document.accountFingerprints,
    activityReview: {
      apiRequestsReviewed: true,
      dashboardActivityReviewed: true,
      unexpectedActivity: false,
    },
    candidateFingerprints: document.candidateFingerprints,
    containment: document.containment,
    replacementRows: document.replacementRows,
    revocation: document.revocation,
    sourceEvidence: document.sourceEvidence,
  };
  return {
    authoritySha256: createHash("sha256").update(canonicalJson(authorityProjection)).digest("hex"),
    capturedAt: document.containmentCapturedAt,
    validUntil: document.containmentValidUntil,
  };
}

export function validateFixtureInput(document) {
  exactKeys(
    document,
    [
      "schemaVersion",
      "kind",
      "environment",
      "denialPaymentIntentId",
      "refundablePaymentIntentId",
      "requesterUserId",
      "approverUserId",
      "amountMinor",
      "currency",
    ],
    "FIXTURE",
  );
  if (
    document.schemaVersion !== 1 ||
    document.kind !== "refunddesk.stripe.incident-admission-fixture"
  ) {
    fail("FIXTURE_IDENTITY_INVALID");
  }
  if (document.environment !== "managed_sandbox") fail("FIXTURE_ENVIRONMENT_INVALID");
  assertString(
    document.denialPaymentIntentId,
    /^pi_[A-Za-z0-9]{6,64}$/u,
    "FIXTURE_DENIAL_ID_INVALID",
  );
  assertString(
    document.refundablePaymentIntentId,
    /^pi_[A-Za-z0-9]{6,64}$/u,
    "FIXTURE_REFUNDABLE_ID_INVALID",
  );
  if (document.denialPaymentIntentId === document.refundablePaymentIntentId)
    fail("FIXTURE_TARGETS_NOT_DISTINCT");
  assertString(document.requesterUserId, /^usr_[A-Za-z0-9]{6,64}$/u, "FIXTURE_REQUESTER_INVALID");
  assertString(document.approverUserId, /^usr_[A-Za-z0-9]{6,64}$/u, "FIXTURE_APPROVER_INVALID");
  if (document.requesterUserId === document.approverUserId) fail("FIXTURE_USERS_NOT_DISTINCT");
  if (document.amountMinor !== "1") fail("FIXTURE_AMOUNT_INVALID");
  if (document.currency !== "eur") fail("FIXTURE_CURRENCY_INVALID");
  return true;
}

const PROMOTION_TOP_KEYS = [
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

export function validatePromotionEvidence(document, { expectedRevision, now = Date.now() } = {}) {
  exactKeys(document, PROMOTION_TOP_KEYS, "PROMOTION");
  if (
    document.schemaVersion !== 1 ||
    document.kind !== "refunddesk-contained-promotion" ||
    document.result !== "PASS" ||
    document.code !== "PASS_CONTAINED_CANDIDATE_PROMOTED" ||
    document.phase !== "complete"
  ) {
    fail("PROMOTION_IDENTITY_INVALID");
  }
  assertString(document.nonce, HEX64, "PROMOTION_NONCE_INVALID");
  const operationStarted = parseTimestamp(
    document.operationStartedAt,
    "PROMOTION_OPERATION_STARTED_AT_INVALID",
  );
  const started = parseTimestamp(document.startedAt, "PROMOTION_STARTED_AT_INVALID");
  const completed = parseTimestamp(document.completedAt, "PROMOTION_COMPLETED_AT_INVALID");
  if (
    operationStarted > started ||
    completed < started ||
    completed - started > MAX_WINDOW_SECONDS * 1000
  ) {
    fail("PROMOTION_WINDOW_INVALID");
  }
  if (completed - now > MAX_FUTURE_SECONDS * 1000) fail("PROMOTION_FUTURE_INVALID");
  assertString(document.fromRevision, HEX40, "PROMOTION_FROM_REVISION_INVALID");
  assertString(document.revision, HEX40, "PROMOTION_REVISION_INVALID");
  if (expectedRevision !== undefined && document.revision !== expectedRevision)
    fail("PROMOTION_REVISION_MISMATCH");
  if (document.fromRevision === document.revision) fail("PROMOTION_FROM_REVISION_INVALID");
  if (typeof document.resumed !== "boolean") fail("PROMOTION_RESUMED_INVALID");
  if (!document.resumed && document.operationStartedAt !== document.startedAt) {
    fail("PROMOTION_OPERATION_START_INVALID");
  }
  exactKeys(
    document.inputs,
    ["bundleSha256", "manifestSha256", "provenanceSha256", "sourceSha256"],
    "PROMOTION_INPUTS",
  );
  for (const value of Object.values(document.inputs))
    assertString(value, HEX64, "PROMOTION_INPUT_HASH_INVALID");
  exactKeys(
    document.database,
    [
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
    ],
    "PROMOTION_DATABASE",
  );
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
    assertInteger(
      document.database[key],
      0,
      Number.MAX_SAFE_INTEGER,
      `PROMOTION_DATABASE_${key}_INVALID`,
    );
  }
  for (const key of [
    "activeFinancialJobs",
    "activeWorkflows",
    "liveInstallations",
    "liveTenants",
    "preparedTransactions",
    "unreleasedPaymentGuards",
  ]) {
    if (document.database[key] !== 0) fail("PROMOTION_DATABASE_NOT_QUIESCENT");
  }
  assertString(document.database.snapshotSha256, HEX64, "PROMOTION_SNAPSHOT_INVALID");
  assertString(
    document.database.systemIdentifier,
    /^[0-9]{10,32}$/u,
    "PROMOTION_SYSTEM_IDENTIFIER_INVALID",
  );
  if (document.database.stable !== true) fail("PROMOTION_DATABASE_UNSTABLE");
  exactKeys(
    document.runtime,
    [
      "caddyContainerId",
      "postgresContainerId",
      "verifierContainerId",
      "webContainerId",
      "workerContainerId",
      "workerRuntimeMode",
    ],
    "PROMOTION_RUNTIME",
  );
  const runtimeIds = [
    document.runtime.caddyContainerId,
    document.runtime.postgresContainerId,
    document.runtime.verifierContainerId,
    document.runtime.webContainerId,
    document.runtime.workerContainerId,
  ];
  for (const value of runtimeIds) assertString(value, HEX64, "PROMOTION_RUNTIME_INVALID");
  if (new Set(runtimeIds).size !== runtimeIds.length) fail("PROMOTION_RUNTIME_NOT_DISTINCT");
  if (document.runtime.workerRuntimeMode !== "incident_admission")
    fail("PROMOTION_RUNTIME_MODE_INVALID");
  booleanObject(
    document.containment,
    [
      "caddyStopped",
      "liveDisabled",
      "maintenanceDisabled",
      "maintenanceStopped",
      "publicListenersAbsent",
      "timersDisabled",
      "verifierHealthy",
      "webHealthy",
      "workerStopped",
    ],
    "PROMOTION_CONTAINMENT",
    true,
  );
  booleanObject(
    document.redaction,
    [
      "customerDataPresent",
      "rawApiKeyPresent",
      "rawPayloadPresent",
      "rawSecretPresent",
      "rawSignaturePresent",
      "stderrPresent",
    ],
    "PROMOTION_REDACTION",
    false,
  );
  return {
    bundleSha256: document.inputs.bundleSha256,
    candidateRevision: document.revision,
    manifestSha256: document.inputs.manifestSha256,
    provenanceSha256: document.inputs.provenanceSha256,
    sourceSha256: document.inputs.sourceSha256,
  };
}

export function validatePostflightEvidence(
  document,
  {
    expectedRevision,
    now = Date.now(),
    minimumRemainingSeconds = MIN_REMAINING_SECONDS,
    fixtureOnly = false,
  } = {},
) {
  exactKeys(
    document,
    [
      "schemaVersion",
      "kind",
      "result",
      "admission",
      "posture",
      "capturedAt",
      "validUntil",
      "remote",
      "awsControlPlane",
      "provenance",
      "redaction",
    ],
    "POSTFLIGHT",
  );
  if (
    document.schemaVersion !== 1 ||
    document.kind !== "refunddesk.lightsail.host-postflight.capture" ||
    document.result !== "PASS" ||
    document.posture !== "COHERENT_CONTAINED" ||
    document.admission !== (fixtureOnly ? "FIXTURE_ONLY" : "ADMISSIBLE_READ_ONLY")
  ) {
    fail("POSTFLIGHT_IDENTITY_INVALID");
  }
  const captured = parseTimestamp(document.capturedAt, "POSTFLIGHT_CAPTURE_INVALID");
  const validUntil = parseTimestamp(document.validUntil, "POSTFLIGHT_EXPIRY_INVALID");
  if (validUntil <= captured || validUntil - captured > MAX_WINDOW_SECONDS * 1000)
    fail("POSTFLIGHT_WINDOW_INVALID");
  if (captured - now > MAX_FUTURE_SECONDS * 1000) fail("POSTFLIGHT_FUTURE_INVALID");
  if (validUntil - now < minimumRemainingSeconds * 1000) fail("POSTFLIGHT_REMAINING_INVALID");
  if (
    !isPlainObject(document.remote) ||
    document.remote.code !== "PASS_CONTAINED" ||
    document.remote.result !== "PASS"
  ) {
    fail("POSTFLIGHT_REMOTE_INVALID");
  }
  if (document.remote.posture !== "COHERENT_CONTAINED") fail("POSTFLIGHT_REMOTE_INVALID");
  booleanObject(
    document.remote.containment,
    [
      "liveDisabled",
      "workerStopped",
      "caddyStopped",
      "maintenanceStopped",
      "publicListenersClosed",
      "journalsClosed",
      "fenceClosed",
      "sensitiveModesSafe",
    ],
    "POSTFLIGHT_CONTAINMENT",
    true,
  );
  booleanObject(
    document.remote.financial,
    ["snapshotAvailable", "stable", "quiescent"],
    "POSTFLIGHT_FINANCIAL",
    true,
  );
  exactKeys(
    document.awsControlPlane,
    [
      "targetId",
      "accountMatches",
      "regionMatches",
      "instanceMatches",
      "instanceRunning",
      "firewallClosedBefore",
      "firewallClosedAfter",
      "firewallUnchanged",
    ],
    "POSTFLIGHT_AWS",
  );
  for (const key of [
    "accountMatches",
    "regionMatches",
    "instanceMatches",
    "instanceRunning",
    "firewallClosedBefore",
    "firewallClosedAfter",
    "firewallUnchanged",
  ]) {
    if (document.awsControlPlane[key] !== true) fail("POSTFLIGHT_AWS_INVALID");
  }
  if (
    typeof document.awsControlPlane.targetId !== "string" ||
    document.awsControlPlane.targetId.length > 128
  ) {
    fail("POSTFLIGHT_AWS_INVALID");
  }
  if (!isPlainObject(document.remote.captures)) fail("POSTFLIGHT_CAPTURES_INVALID");
  for (const captureName of ["a", "b"]) {
    const capture = document.remote.captures[captureName];
    const identity = capture?.identity;
    if (!isPlainObject(identity)) fail("POSTFLIGHT_REVISION_INVALID");
    for (const key of [
      "activeRevision",
      "currentRevision",
      "sourceRevision",
      "releaseEnvironmentRevision",
    ]) {
      if (identity[key] !== expectedRevision) fail("POSTFLIGHT_REVISION_INVALID");
    }
    if (identity.releaseEnvironmentWorkerRuntimeMode !== "INCIDENT_ADMISSION") {
      fail("POSTFLIGHT_WORKER_RUNTIME_MODE_INVALID");
    }
    if (!Array.isArray(capture.containers)) fail("POSTFLIGHT_WORKER_RUNTIME_MODE_INVALID");
    const workers = capture.containers.filter((container) => container?.service === "worker");
    if (workers.length !== 1 || workers[0].effectiveWorkerRuntimeMode !== "INCIDENT_ADMISSION") {
      fail("POSTFLIGHT_WORKER_RUNTIME_MODE_INVALID");
    }
  }
  if (!isPlainObject(document.provenance) || document.provenance.fixtureOnly !== fixtureOnly)
    fail("POSTFLIGHT_PROVENANCE_INVALID");
  if (
    document.provenance.transportInputsPinned !== true ||
    document.provenance.revisionComposeVerified !== true
  ) {
    fail("POSTFLIGHT_PROVENANCE_INVALID");
  }
  for (const key of ["remoteDocumentSha256"])
    assertString(document.provenance[key], HEX64, "POSTFLIGHT_PROVENANCE_INVALID");
  for (const sourceName of ["observer", "validator", "wrapper", "schema"]) {
    const source = document.provenance[sourceName];
    exactKeys(source, ["gitObject", "sha256"], "POSTFLIGHT_PROVENANCE");
    if (
      !isPlainObject(source) ||
      !HEX64.test(source.sha256) ||
      (fixtureOnly ? source.gitObject !== null : !HEX40.test(source.gitObject))
    ) {
      fail("POSTFLIGHT_PROVENANCE_INVALID");
    }
  }
  const legacyRedactionKeys = [
    "rawSecretPresent",
    "rawApiKeyPresent",
    "rawSignaturePresent",
    "rawPayloadPresent",
    "customerDataPresent",
    "arbitraryPathPresent",
    "ipAddressPresent",
    "stderrPresent",
    "keyDigestPresent",
  ];
  booleanObject(document.redaction, legacyRedactionKeys, "POSTFLIGHT_REDACTION", false);
  return { capturedAt: document.capturedAt, validUntil: document.validUntil };
}

export function composeIncidentAdmissionInput({
  dashboardAttestation,
  fixture,
  postflightEvidence,
  promotionEvidence,
  expectedRevision,
  now = Date.now(),
  fixtureOnly = false,
}) {
  validateDashboardAttestation(dashboardAttestation, { now });
  validateFixtureInput(fixture);
  validatePromotionEvidence(promotionEvidence, { expectedRevision, now });
  validatePostflightEvidence(postflightEvidence, { expectedRevision, now, fixtureOnly });
  if (
    dashboardAttestation.containmentCapturedAt !== postflightEvidence.capturedAt ||
    dashboardAttestation.containmentValidUntil !== postflightEvidence.validUntil
  ) {
    fail("DASHBOARD_POSTFLIGHT_TIME_MISMATCH");
  }
  if (Date.parse(postflightEvidence.capturedAt) < Date.parse(promotionEvidence.completedAt)) {
    fail("POSTFLIGHT_PRECEDES_PROMOTION");
  }
  return {
    dashboardAttestation,
    fixture,
    postflight: {
      capturedAt: postflightEvidence.capturedAt,
      firewallClosed: true,
      revision: expectedRevision,
      validUntil: postflightEvidence.validUntil,
    },
    promotionEvidence,
  };
}

export function validateIncidentAdmissionDocument(
  document,
  {
    expectedRevision,
    repositoryHead,
    now = Date.now(),
    maximumWindowSeconds = MAX_WINDOW_SECONDS,
  } = {},
) {
  exactKeys(document, TOP_KEYS, "DOCUMENT");
  if (document.schemaVersion !== 1 || document.kind !== "refunddesk.lightsail.incident-admission") {
    fail("DOCUMENT_IDENTITY_INVALID");
  }
  assertString(document.nonce, HEX64, "NONCE_INVALID");
  assertString(document.expectedRevision, HEX40, "EXPECTED_REVISION_INVALID");
  assertString(document.repositoryHead, HEX40, "REPOSITORY_HEAD_INVALID");
  if (expectedRevision !== undefined && document.expectedRevision !== expectedRevision)
    fail("EXPECTED_REVISION_MISMATCH");
  if (repositoryHead !== undefined && document.repositoryHead !== repositoryHead)
    fail("REPOSITORY_HEAD_MISMATCH");
  const started = parseTimestamp(document.startedAt, "STARTED_AT_INVALID");
  const completed = parseTimestamp(document.completedAt, "COMPLETED_AT_INVALID");
  if (
    completed < started ||
    completed - started > maximumWindowSeconds * 1000 ||
    completed - now > MAX_FUTURE_SECONDS * 1000
  ) {
    fail("CAPTURE_WINDOW_INVALID");
  }
  if (![0, 20, 21].includes(document.exitCode)) fail("EXIT_CODE_INVALID");
  if (!["PASS", "FAIL", "INCOMPLETE"].includes(document.result)) fail("RESULT_INVALID");
  if (document.code !== PASS_CODE && !FAILURE_CODES.has(document.code)) fail("CODE_INVALID");
  if (!Array.isArray(document.diagnostics) || document.diagnostics.length > 16)
    fail("DIAGNOSTICS_INVALID");
  if (
    document.diagnostics.some(
      (item) => typeof item !== "string" || !DIAGNOSTIC.test(item) || !FAILURE_CODES.has(item),
    ) ||
    new Set(document.diagnostics).size !== document.diagnostics.length ||
    JSON.stringify(document.diagnostics) !== JSON.stringify([...document.diagnostics].sort())
  ) {
    fail("DIAGNOSTICS_INVALID");
  }
  exactKeys(document.promotion, PROMOTION_KEYS, "PROMOTION_BINDING");
  assertString(document.promotion.candidateRevision, HEX40, "PROMOTION_BINDING_INVALID");
  if (document.promotion.candidateRevision !== document.expectedRevision)
    fail("PROMOTION_REVISION_MISMATCH");
  for (const key of [
    "evidenceSha256",
    "bundleSha256",
    "manifestSha256",
    "sourceSha256",
    "provenanceSha256",
  ]) {
    assertString(document.promotion[key], HEX64, "PROMOTION_BINDING_INVALID");
  }
  for (const key of ["postflightAfterPromotion", "contained"]) {
    if (typeof document.promotion[key] !== "boolean") fail("PROMOTION_BINDING_INVALID");
  }
  exactKeys(document.marker, MARKER_KEYS, "MARKER");
  if (
    !new Set([
      "absent",
      "prepared",
      "proof_started",
      "proof_observed",
      "contained_verified",
      "complete",
      "invalid",
    ]).has(document.marker.state)
  ) {
    fail("MARKER_STATE_INVALID");
  }
  if (typeof document.marker.resumed !== "boolean") fail("MARKER_RESUMED_INVALID");
  assertInteger(document.marker.markerTransitions, 0, 5, "MARKER_TRANSITIONS_INVALID");
  for (const key of ["operationBound", "sameIdempotencyKey", "complete"]) {
    if (typeof document.marker[key] !== "boolean") fail("MARKER_INVALID");
  }
  booleanObject(document.bindings, BINDING_KEYS, "BINDINGS");
  if (document.bindings.predecessorBytesRetested !== false) fail("PREDECESSOR_RETEST_INVALID");
  exactKeys(document.proof, PROOF_KEYS, "PROOF");
  for (const key of PROOF_KEYS.filter((key) => !["workflowCount", "refundCount"].includes(key))) {
    if (typeof document.proof[key] !== "boolean") fail("PROOF_INVALID");
  }
  assertInteger(document.proof.workflowCount, 0, 1, "PROOF_WORKFLOW_COUNT_INVALID");
  assertInteger(document.proof.refundCount, 0, 1, "PROOF_REFUND_COUNT_INVALID");
  if (document.proof.ambiguousResumeSameKey !== document.marker.resumed) {
    fail("PROOF_RESUME_BINDING_INVALID");
  }
  booleanObject(document.containment, CONTAINMENT_KEYS, "CONTAINMENT");
  exactKeys(document.mutations, MUTATION_KEYS, "MUTATIONS");
  for (const key of MUTATION_KEYS)
    assertInteger(
      document.mutations[key],
      0,
      key === "markerTransitions" ? 5 : 1,
      "MUTATIONS_INVALID",
    );
  if (document.mutations.markerTransitions !== document.marker.markerTransitions)
    fail("MARKER_MUTATION_MISMATCH");
  if (document.postIncidentBaseline !== null) {
    validatePostIncidentBaseline(document.postIncidentBaseline, "POST_INCIDENT_BASELINE");
  }
  validateRedaction(document.redaction);
  assertNoSensitiveOutput(document);

  if (document.exitCode === 0) {
    if (
      document.result !== "PASS" ||
      document.code !== PASS_CODE ||
      document.diagnostics.length !== 0
    )
      fail("PASS_ENVELOPE_INVALID");
    if (
      document.promotion.contained !== true ||
      document.promotion.postflightAfterPromotion !== true
    ) {
      fail("PASS_PROMOTION_INVALID");
    }
    if (document.postIncidentBaseline === null) fail("PASS_POST_INCIDENT_BASELINE_MISSING");
    if (
      document.marker.state !== "complete" ||
      document.marker.complete !== true ||
      document.marker.operationBound !== true ||
      document.marker.sameIdempotencyKey !== true ||
      document.marker.markerTransitions !== 5
    ) {
      fail("PASS_MARKER_INVALID");
    }
    for (const [key, value] of Object.entries(document.bindings)) {
      if (key === "predecessorBytesRetested" ? value !== false : value !== true)
        fail("PASS_BINDINGS_INVALID");
    }
    for (const [key, value] of Object.entries(document.proof)) {
      if (["workflowCount", "refundCount"].includes(key)) {
        if (value !== 1) fail("PASS_PROOF_INVALID");
      } else if (key === "ambiguousResumeSameKey") {
        if (typeof value !== "boolean") fail("PASS_PROOF_INVALID");
      } else if (value !== true) {
        fail("PASS_PROOF_INVALID");
      }
    }
    if (Object.values(document.containment).some((value) => value !== true))
      fail("PASS_CONTAINMENT_INVALID");
    const expectedMutations = {
      markerTransitions: 5,
      refundsCreated: 1,
      workerStarts: 1,
      workerStops: 1,
      workflowsCreated: 1,
    };
    for (const [key, value] of Object.entries(expectedMutations)) {
      if (document.mutations[key] !== value) fail("PASS_MUTATIONS_INVALID");
    }
  } else {
    const expectedResult = document.exitCode === 20 ? "FAIL" : "INCOMPLETE";
    if (
      document.result !== expectedResult ||
      document.code === PASS_CODE ||
      document.diagnostics.length === 0
    ) {
      fail("FAILURE_ENVELOPE_INVALID");
    }
    if (!document.diagnostics.includes(document.code)) fail("FAILURE_DIAGNOSTIC_INVALID");
  }
  return document;
}

const CAPTURE_KEYS = [
  "admission",
  "awsControlPlane",
  "capturedAt",
  "code",
  "exitCode",
  "finalPostflight",
  "kind",
  "postIncidentBaseline",
  "provenance",
  "redaction",
  "remote",
  "remoteDocument",
  "result",
  "schemaVersion",
  "validUntil",
];
const CAPTURE_SOURCE_NAMES = Object.freeze([
  "admissionAdr",
  "admissionRunner",
  "admissionSchema",
  "admissionValidator",
  "admissionWrapper",
  "compose",
  "hostCommand",
  "postflightObserver",
  "postflightSchema",
  "postflightValidator",
  "postflightWrapper",
  "promotionRunner",
  "promotionSchema",
  "promotionValidator",
  "proofClient",
]);

function validatePostflightSourceRecord(source, { fixtureOnly, location }) {
  exactKeys(source, ["gitObject", "sha256"], location);
  assertString(source.sha256, HEX64, `${location}_SHA_INVALID`);
  if (fixtureOnly ? source.gitObject !== null : !HEX40.test(source.gitObject))
    fail(`${location}_OID_INVALID`);
}

export function validateIncidentAdmissionCapture(
  document,
  { expectedPromotion, expectedRevision, now = Date.now(), fixtureOnly = false } = {},
) {
  assertString(expectedRevision, HEX40, "CAPTURE_EXPECTED_REVISION_INVALID");
  exactKeys(document, CAPTURE_KEYS, "CAPTURE");
  if (
    document.schemaVersion !== 1 ||
    document.kind !== "refunddesk.lightsail.incident-admission.capture"
  ) {
    fail("CAPTURE_IDENTITY_INVALID");
  }
  const captured = parseTimestamp(document.capturedAt, "CAPTURE_TIME_INVALID");
  const validUntil = parseTimestamp(document.validUntil, "CAPTURE_EXPIRY_INVALID");
  if (validUntil <= captured || validUntil - captured > MAX_WINDOW_SECONDS * 1000)
    fail("CAPTURE_WINDOW_INVALID");
  if (
    captured - now > MAX_FUTURE_SECONDS * 1000 ||
    validUntil - now < MIN_REMAINING_SECONDS * 1000
  ) {
    fail("CAPTURE_FRESHNESS_INVALID");
  }
  if (!new Set(["PASS", "FAIL", "INCOMPLETE"]).has(document.result)) fail("CAPTURE_RESULT_INVALID");
  assertString(document.code, DIAGNOSTIC, "CAPTURE_CODE_INVALID");
  assertInteger(document.exitCode, 0, 21, "CAPTURE_EXIT_INVALID");
  if (![0, 20, 21].includes(document.exitCode)) fail("CAPTURE_EXIT_INVALID");
  exactKeys(
    document.awsControlPlane,
    [
      "accountMatches",
      "firewallClosedAfter",
      "firewallClosedBefore",
      "firewallUnchanged",
      "instanceMatches",
      "regionMatches",
      "targetId",
    ],
    "CAPTURE_AWS",
  );
  for (const key of [
    "accountMatches",
    "firewallClosedAfter",
    "firewallClosedBefore",
    "firewallUnchanged",
    "instanceMatches",
    "regionMatches",
  ]) {
    if (document.awsControlPlane[key] !== true) fail("CAPTURE_AWS_INVALID");
  }
  if (document.awsControlPlane.targetId !== "refunddesk-sandbox-paris@eu-west-3")
    fail("CAPTURE_AWS_TARGET_INVALID");

  exactKeys(document.remoteDocument, ["exitCode", "sha256"], "CAPTURE_REMOTE_DOCUMENT");
  assertInteger(document.remoteDocument.exitCode, 0, 21, "CAPTURE_REMOTE_EXIT_INVALID");
  if (![0, 20, 21].includes(document.remoteDocument.exitCode)) fail("CAPTURE_REMOTE_EXIT_INVALID");
  assertString(document.remoteDocument.sha256, HEX64, "CAPTURE_REMOTE_SHA_INVALID");
  const remote = validateIncidentAdmissionDocument(document.remote, {
    expectedRevision,
    now,
    repositoryHead: document.provenance?.repositoryHead,
  });
  if (
    document.remoteDocument.exitCode !== remote.exitCode ||
    document.remoteDocument.sha256 !==
      createHash("sha256").update(canonicalJson(remote)).digest("hex")
  ) {
    fail("CAPTURE_REMOTE_BINDING_INVALID");
  }

  exactKeys(
    document.provenance,
    [
      "dashboardAttestationSha256",
      "fixtureInputSha256",
      "fixtureOnly",
      "postflightBeforeSha256",
      "promotionEvidenceSha256",
      "repositoryHead",
      "sources",
      "transportInputsPinned",
    ],
    "CAPTURE_PROVENANCE",
  );
  if (
    document.provenance.fixtureOnly !== fixtureOnly ||
    document.provenance.transportInputsPinned !== true ||
    !HEX40.test(document.provenance.repositoryHead)
  ) {
    fail("CAPTURE_PROVENANCE_INVALID");
  }
  for (const name of [
    "dashboardAttestationSha256",
    "fixtureInputSha256",
    "postflightBeforeSha256",
    "promotionEvidenceSha256",
  ]) {
    assertString(document.provenance[name], HEX64, "CAPTURE_PROVENANCE_INVALID");
  }
  if (document.provenance.promotionEvidenceSha256 !== remote.promotion.evidenceSha256) {
    fail("CAPTURE_PROMOTION_BINDING_INVALID");
  }
  if (expectedPromotion !== undefined) {
    exactKeys(
      expectedPromotion,
      ["bundleSha256", "evidenceSha256", "manifestSha256", "provenanceSha256", "sourceSha256"],
      "CAPTURE_EXPECTED_PROMOTION",
    );
    for (const name of Object.keys(expectedPromotion)) {
      assertString(expectedPromotion[name], HEX64, "CAPTURE_EXPECTED_PROMOTION_INVALID");
      if (remote.promotion[name] !== expectedPromotion[name])
        fail("CAPTURE_EXPECTED_PROMOTION_MISMATCH");
    }
  }
  exactKeys(document.provenance.sources, CAPTURE_SOURCE_NAMES, "CAPTURE_SOURCES");
  for (const name of CAPTURE_SOURCE_NAMES) {
    validatePostflightSourceRecord(document.provenance.sources[name], {
      fixtureOnly,
      location: `CAPTURE_SOURCE_${name}`,
    });
  }

  exactKeys(
    document.finalPostflight,
    [
      "awsControlPlane",
      "candidateBinding",
      "capturedAt",
      "firewallClosed",
      "officialValidation",
      "posture",
      "postIncidentBaselineSha256",
      "provenance",
      "revision",
      "sha256",
      "validUntil",
      "workerRuntimeMode",
    ],
    "CAPTURE_FINAL_POSTFLIGHT",
  );
  const finalCaptured = parseTimestamp(
    document.finalPostflight.capturedAt,
    "CAPTURE_FINAL_TIME_INVALID",
  );
  exactKeys(
    document.finalPostflight.candidateBinding,
    [
      "caddyContainerIdSha256",
      "postgresContainerIdSha256",
      "systemIdentifierSha256",
      "verifierContainerIdSha256",
      "webContainerIdSha256",
      "workerContainerIdSha256",
    ],
    "CAPTURE_FINAL_CANDIDATE_BINDING",
  );
  for (const value of Object.values(document.finalPostflight.candidateBinding)) {
    assertString(value, HEX64, "CAPTURE_FINAL_CANDIDATE_BINDING_INVALID");
  }
  const finalUntil = parseTimestamp(
    document.finalPostflight.validUntil,
    "CAPTURE_FINAL_EXPIRY_INVALID",
  );
  if (
    finalCaptured < Date.parse(remote.completedAt) ||
    finalCaptured - now > MAX_FUTURE_SECONDS * 1000 ||
    finalUntil - now < MIN_REMAINING_SECONDS * 1000 ||
    finalUntil <= finalCaptured ||
    finalUntil - finalCaptured > MAX_WINDOW_SECONDS * 1000 ||
    document.finalPostflight.firewallClosed !== true ||
    document.finalPostflight.officialValidation !== true ||
    document.finalPostflight.posture !== "COHERENT_CONTAINED" ||
    document.finalPostflight.revision !== expectedRevision ||
    document.finalPostflight.workerRuntimeMode !== "incident_admission"
  ) {
    fail("CAPTURE_FINAL_POSTFLIGHT_INVALID");
  }
  assertString(document.finalPostflight.sha256, HEX64, "CAPTURE_FINAL_POSTFLIGHT_INVALID");
  assertString(
    document.finalPostflight.postIncidentBaselineSha256,
    HEX64,
    "CAPTURE_FINAL_POST_INCIDENT_BASELINE_INVALID",
  );
  validatePostIncidentBaseline(document.postIncidentBaseline, "CAPTURE_POST_INCIDENT_BASELINE");
  if (
    document.finalPostflight.postIncidentBaselineSha256 !==
    document.postIncidentBaseline.snapshotSha256
  ) {
    fail("CAPTURE_FINAL_POST_INCIDENT_BASELINE_MISMATCH");
  }
  if (
    remote.postIncidentBaseline !== null &&
    JSON.stringify(sortJsonKeys(remote.postIncidentBaseline)) !==
      JSON.stringify(sortJsonKeys(document.postIncidentBaseline))
  ) {
    fail("CAPTURE_REMOTE_POST_INCIDENT_BASELINE_MISMATCH");
  }
  if (remote.exitCode === 0 && remote.postIncidentBaseline === null) {
    fail("CAPTURE_REMOTE_POST_INCIDENT_BASELINE_MISSING");
  }
  const finalAws = document.finalPostflight.awsControlPlane;
  exactKeys(
    finalAws,
    [
      "accountMatches",
      "firewallClosedAfter",
      "firewallClosedBefore",
      "firewallUnchanged",
      "instanceMatches",
      "instanceRunning",
      "regionMatches",
      "targetId",
    ],
    "CAPTURE_FINAL_AWS",
  );
  for (const [name, value] of Object.entries(finalAws)) {
    if (name !== "targetId" && value !== true) fail("CAPTURE_FINAL_AWS_INVALID");
  }
  if (
    finalAws.targetId !== "refunddesk-sandbox-paris@eu-west-3" ||
    finalAws.targetId !== document.awsControlPlane.targetId
  ) {
    fail("CAPTURE_FINAL_AWS_INVALID");
  }
  const finalProvenance = document.finalPostflight.provenance;
  exactKeys(
    finalProvenance,
    [
      "fixtureOnly",
      "observer",
      "remoteDocumentSha256",
      "repositoryHead",
      "revisionComposeVerified",
      "schema",
      "transportInputsPinned",
      "validator",
      "wrapper",
    ],
    "CAPTURE_FINAL_PROVENANCE",
  );
  if (
    finalProvenance.fixtureOnly !== fixtureOnly ||
    finalProvenance.revisionComposeVerified !== true ||
    finalProvenance.transportInputsPinned !== true ||
    (fixtureOnly
      ? finalProvenance.repositoryHead !== null
      : !HEX40.test(finalProvenance.repositoryHead))
  ) {
    fail("CAPTURE_FINAL_PROVENANCE_INVALID");
  }
  assertString(finalProvenance.remoteDocumentSha256, HEX64, "CAPTURE_FINAL_PROVENANCE_INVALID");
  for (const name of ["observer", "schema", "validator", "wrapper"]) {
    validatePostflightSourceRecord(finalProvenance[name], {
      fixtureOnly,
      location: "CAPTURE_FINAL_SOURCE",
    });
  }
  validateRedaction(document.redaction, "CAPTURE_REDACTION");
  assertNoSensitiveOutput(document);

  const expectedAdmission = fixtureOnly
    ? "FIXTURE_ONLY"
    : document.exitCode === 0
      ? "ADMISSIBLE_CURRENT_STRIPE_BINDING_INCIDENT"
      : "NOT_ADMITTED";
  if (document.admission !== expectedAdmission) fail("CAPTURE_ADMISSION_INVALID");
  if (document.exitCode === remote.exitCode) {
    if (document.result !== remote.result || document.code !== remote.code)
      fail("CAPTURE_LOCAL_MAPPING_INVALID");
  } else if (
    document.exitCode !== 21 ||
    remote.exitCode !== 0 ||
    document.result !== "INCOMPLETE" ||
    document.code !== "LOCAL_EVIDENCE_LIFETIME_INVALID" ||
    (!fixtureOnly && document.admission !== "NOT_ADMITTED")
  ) {
    fail("CAPTURE_LOCAL_MAPPING_INVALID");
  }
  return document;
}

export function parseCanonicalIncidentAdmissionCapture(input, options = {}) {
  const document = parseSingleJsonDocument(input, {
    maximumBytes: INCIDENT_ADMISSION_MAX_BYTES,
    requireCanonical: true,
  });
  return validateIncidentAdmissionCapture(document, options);
}

export function parseCanonicalIncidentAdmissionDocument(input, options = {}) {
  const document = parseSingleJsonDocument(input, {
    maximumBytes: INCIDENT_ADMISSION_MAX_BYTES,
    requireCanonical: true,
  });
  return validateIncidentAdmissionDocument(document, options);
}

function usage() {
  return canonicalJson({ code: "USAGE", result: "FAIL" });
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("USAGE");
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) fail("USAGE");
    options[name] = value;
  }
  if (
    !new Set([
      "admission",
      "bundle",
      "capture",
      "dashboard",
      "fixture",
      "promotion",
      "postflight",
    ]).has(options.kind)
  )
    fail("USAGE");
  if (options["expected-revision"] !== undefined)
    assertString(options["expected-revision"], HEX40, "USAGE");
  if (options.now !== undefined && !Number.isFinite(Date.parse(options.now))) fail("USAGE");
  const allowedByKind = {
    admission: ["expected-revision", "kind", "now", "repository-head"],
    bundle: [
      "dashboard-path",
      "expected-revision",
      "fixture-only",
      "fixture-path",
      "kind",
      "now",
      "postflight-path",
      "promotion-path",
    ],
    capture: [
      "expected-promotion-bundle-sha256",
      "expected-promotion-evidence-sha256",
      "expected-promotion-manifest-sha256",
      "expected-promotion-provenance-sha256",
      "expected-promotion-source-sha256",
      "expected-revision",
      "fixture-only",
      "kind",
      "now",
    ],
    dashboard: ["kind", "now"],
    fixture: ["kind"],
    postflight: ["expected-revision", "fixture-only", "kind", "now"],
    promotion: ["expected-revision", "kind", "now"],
  };
  if (Object.keys(options).some((name) => !allowedByKind[options.kind].includes(name)))
    fail("USAGE");
  if (options.kind === "bundle") {
    for (const name of [
      "dashboard-path",
      "expected-revision",
      "fixture-path",
      "postflight-path",
      "promotion-path",
    ]) {
      if (typeof options[name] !== "string" || options[name].length === 0) fail("USAGE");
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseCliArguments(process.argv.slice(2));
  } catch {
    process.stdout.write(usage());
    process.exitCode = 64;
    return;
  }
  if (options.kind === "bundle") {
    try {
      const now = options.now === undefined ? Date.now() : Date.parse(options.now);
      const read = (name, maximumBytes, requireCanonical) =>
        parseSingleJsonDocument(readFileSync(options[name]), { maximumBytes, requireCanonical });
      const document = composeIncidentAdmissionInput({
        dashboardAttestation: read("dashboard-path", DASHBOARD_ATTESTATION_MAX_BYTES, true),
        expectedRevision: options["expected-revision"],
        fixture: read("fixture-path", FIXTURE_INPUT_MAX_BYTES, true),
        fixtureOnly: options["fixture-only"] === "true",
        now,
        postflightEvidence: read("postflight-path", INCIDENT_ADMISSION_MAX_BYTES, false),
        promotionEvidence: read("promotion-path", INCIDENT_ADMISSION_MAX_BYTES, true),
      });
      process.stdout.write(canonicalJson(document));
      process.exitCode = 0;
    } catch (error) {
      const code =
        error instanceof IncidentAdmissionValidationError
          ? error.code
          : "VALIDATION_INTERNAL_ERROR";
      process.stdout.write(canonicalJson({ code, result: "FAIL" }));
      process.exitCode = 64;
    }
    return;
  }
  let input;
  try {
    input = readFileSync(0);
  } catch {
    process.stdout.write(canonicalJson({ code: "INPUT_INVALID", result: "FAIL" }));
    process.exitCode = 64;
    return;
  }
  try {
    const now = options.now === undefined ? Date.now() : Date.parse(options.now);
    const expectedRevision = options["expected-revision"];
    if (options.kind === "admission") {
      const document = parseCanonicalIncidentAdmissionDocument(input, { expectedRevision, now });
      process.stdout.write(canonicalJson(document));
      process.exitCode = document.exitCode;
      return;
    }
    if (options.kind === "capture") {
      const document = parseSingleJsonDocument(input, {
        maximumBytes: INCIDENT_ADMISSION_MAX_BYTES,
        requireCanonical: true,
      });
      const promotionOptionNames = [
        "expected-promotion-bundle-sha256",
        "expected-promotion-evidence-sha256",
        "expected-promotion-manifest-sha256",
        "expected-promotion-provenance-sha256",
        "expected-promotion-source-sha256",
      ];
      const promotionOptionCount = promotionOptionNames.filter(
        (name) => options[name] !== undefined,
      ).length;
      if (![0, promotionOptionNames.length].includes(promotionOptionCount)) fail("USAGE");
      validateIncidentAdmissionCapture(document, {
        ...(promotionOptionCount === promotionOptionNames.length
          ? {
              expectedPromotion: {
                bundleSha256: options["expected-promotion-bundle-sha256"],
                evidenceSha256: options["expected-promotion-evidence-sha256"],
                manifestSha256: options["expected-promotion-manifest-sha256"],
                provenanceSha256: options["expected-promotion-provenance-sha256"],
                sourceSha256: options["expected-promotion-source-sha256"],
              },
            }
          : {}),
        expectedRevision,
        fixtureOnly: options["fixture-only"] === "true",
        now,
      });
      process.stdout.write(canonicalJson(document));
      process.exitCode = document.exitCode;
      return;
    }
    const canonical = options.kind !== "postflight";
    const maximumBytes =
      options.kind === "fixture"
        ? FIXTURE_INPUT_MAX_BYTES
        : options.kind === "dashboard"
          ? DASHBOARD_ATTESTATION_MAX_BYTES
          : INCIDENT_ADMISSION_MAX_BYTES;
    const document = parseSingleJsonDocument(input, { maximumBytes, requireCanonical: canonical });
    let code;
    if (options.kind === "dashboard") {
      validateDashboardAttestation(document, { now });
      code = "PASS_DASHBOARD_VALID";
    } else if (options.kind === "fixture") {
      validateFixtureInput(document);
      code = "PASS_FIXTURE_VALID";
    } else if (options.kind === "promotion") {
      validatePromotionEvidence(document, { expectedRevision, now });
      code = "PASS_PROMOTION_VALID";
    } else {
      validatePostflightEvidence(document, {
        expectedRevision,
        now,
        fixtureOnly: options["fixture-only"] === "true",
      });
      code = "PASS_POSTFLIGHT_VALID";
    }
    process.stdout.write(canonicalJson({ code, result: "PASS" }));
    process.exitCode = 0;
  } catch (error) {
    const code =
      error instanceof IncidentAdmissionValidationError ? error.code : "VALIDATION_INTERNAL_ERROR";
    process.stdout.write(canonicalJson({ code, result: "FAIL" }));
    process.exitCode = 64;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
