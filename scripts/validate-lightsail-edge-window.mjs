import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fileConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const MAX_EDGE_WINDOW_DOCUMENT_BYTES = 256 * 1024;
export const MAX_WORKBENCH_CHECKPOINT_BYTES = 16 * 1024;
export const PASS_EDGE_WINDOW_CODE = "PASS_EDGE_WINDOW_RECONTAINED";

// The provider bind and unbind waits are distinct from the public-ingress
// budget.  Thirty-five minutes admits both bounded CloudFront deployments,
// the at-most-five-minute edge window and a fresh official postflight.
const EXECUTION_MAX_MILLISECONDS = 35 * 60 * 1000;
const OPERATOR_HANDOFF_RESERVE_SECONDS = 240;
const MIN_POSTFLIGHT_REMAINING_SECONDS = 720;
const MAX_ADMISSION_REMAINING_SECONDS = 900;
const WATCHDOG_CONTAINMENT_RESERVE_SECONDS = 30;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/u,
  /\bwhsec_[A-Za-z0-9]{12,}\b/u,
  /\babsec_[A-Za-z0-9_]{12,}\b/u,
  /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
]);
const IP_ADDRESS_PATTERNS = Object.freeze([
  /(?:^|[^0-9])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/\d{1,2})?(?:$|[^0-9])/u,
  /(?:^|[\s"'])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]{0,39}(?:\/\d{1,3})?(?:$|[\s"'])/iu,
]);
const EXPECTED_SOURCE_PATHS = Object.freeze([
  ".dockerignore",
  ".github/workflows/sandbox-images.yml",
  "deploy/lightsail/Caddyfile.public",
  "deploy/lightsail/compose.yml",
  "deploy/lightsail/edge-operator.Dockerfile",
  "deploy/lightsail/edge-operator.Dockerfile.dockerignore",
  "deploy/lightsail/scripts/_common.sh",
  "deploy/lightsail/scripts/observe-host-postflight.sh",
  "deploy/lightsail/scripts/prove-bounded-edge-window.sh",
  "deploy/lightsail/scripts/recover-quiesced-runtime.sh",
  "deploy/lightsail/scripts/release.sh",
  "deploy/lightsail/scripts/refunddesk-edge-operator.sh",
  "deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh",
  "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service",
  "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer",
  "docs/adr/0037-bounded-cloudfront-origin-window.md",
  "docs/schemas/refunddesk-edge-operator-image-v1.schema.json",
  "docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json",
  "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json",
  "docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json",
  "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json",
  "scripts/check-sandbox-images-workflow.mjs",
  "scripts/invoke-lightsail-edge-window.ps1",
  "scripts/invoke-lightsail-postflight.ps1",
  "scripts/submit-lightsail-edge-window-checkpoint.ps1",
  "scripts/validate-edge-operator-image.mjs",
  "scripts/validate-lightsail-contained-promotion.mjs",
  "scripts/validate-lightsail-edge-window.mjs",
  "scripts/validate-lightsail-incident-admission.mjs",
  "scripts/validate-lightsail-postflight.mjs",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "activeFinancialJobs",
  "auditEvents",
  "mutationReceipts",
  "refundExecutionAttempts",
  "refundExecutions",
  "refundRequests",
  "unreleasedPaymentGuards",
  "webhookReceipts",
]);
const REDACTION_KEYS = Object.freeze([
  "arbitraryPathPresent",
  "customerDataPresent",
  "ipAddressPresent",
  "keyDigestPresent",
  "rawApiKeyPresent",
  "rawPayloadPresent",
  "rawSecretPresent",
  "rawSignaturePresent",
  "stderrPresent",
  "stripeIdentifierPresent",
]);
const INCOMPLETE_CODES = new Set([
  "CLOSE_STATE_UNAVAILABLE",
  "CONTROL_PLANE_UNAVAILABLE",
  "FINAL_CONTAINMENT_FAILED",
  "FIREWALL_CLOSE_AMBIGUOUS",
  "LOCK_UNAVAILABLE",
  "REMOTE_STATE_UNAVAILABLE",
  "TOOL_UNAVAILABLE",
]);
const FAIL_CODES = new Set([
  "ADMISSION_EVIDENCE_INVALID",
  "DURABLE_COUNTS_CHANGED",
  "FINAL_CONTAINMENT_FAILED",
  "FIREWALL_OPEN_INVALID",
  "LOCAL_PROBE_FAILED",
  "ORIGIN_CONFIGURATION_AMBIGUOUS",
  "ORIGIN_DEPLOYMENT_TIMEOUT",
  "PREFIX_DOCUMENT_INVALID",
  "PREFIX_DOCUMENT_STALE",
  "PUBLIC_HEALTH_FAILED",
  "SOURCE_PROVENANCE_INVALID",
  "TOPOLOGY_BINDING_INVALID",
  "WATCHDOG_ARM_FAILED",
  "WORKBENCH_CHECKPOINT_INVALID",
  "WORKBENCH_CHECKPOINT_TIMEOUT",
]);

export class EdgeWindowValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "EdgeWindowValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new EdgeWindowValidationError(code);
}

export function sortJsonKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonKeys(value[key])]),
    );
  }
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(sortJsonKeys(left)) === JSON.stringify(sortJsonKeys(right));
}

function canonicalSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(value)), "utf8")
    .digest("hex");
}

function assertExactKeys(value, expected, location) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !deepEqual(Object.keys(value), [...expected].sort())
  ) {
    fail(`KEYS_${location}_INVALID`);
  }
}

function timestampMilliseconds(value, location) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    fail(`${location}_TIMESTAMP_INVALID`);
  }
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString().replace(".000Z", "Z")
    : "";
  if (!Number.isFinite(milliseconds) || canonical !== value) {
    fail(`${location}_TIMESTAMP_INVALID`);
  }
  return milliseconds;
}

function optionalTimestampMilliseconds(value, location) {
  return value === null ? null : timestampMilliseconds(value, location);
}

function assertDigest(value, location) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${location}_DIGEST_INVALID`);
  }
}

function assertRevision(value, location) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    fail(`${location}_REVISION_INVALID`);
  }
}

function resolveSchemaReference(rootSchema, reference) {
  if (!reference.startsWith("#/$defs/")) {
    fail("SCHEMA_REFERENCE_INVALID");
  }
  const name = reference.slice("#/$defs/".length);
  const definition = rootSchema.$defs?.[name];
  if (definition === undefined) {
    fail("SCHEMA_REFERENCE_INVALID");
  }
  return definition;
}

function validateSchemaValue(value, rule, rootSchema, location) {
  if (rule.$ref !== undefined) {
    validateSchemaValue(value, resolveSchemaReference(rootSchema, rule.$ref), rootSchema, location);
    return;
  }
  if (rule.oneOf !== undefined) {
    let matches = 0;
    for (const candidate of rule.oneOf) {
      try {
        validateSchemaValue(value, candidate, rootSchema, location);
        matches += 1;
      } catch (error) {
        if (!(error instanceof EdgeWindowValidationError)) {
          throw error;
        }
      }
    }
    if (matches !== 1) {
      fail(`SCHEMA_${location}_ONE_OF_INVALID`);
    }
    return;
  }
  if (Object.hasOwn(rule, "const") && !deepEqual(value, rule.const)) {
    fail(`SCHEMA_${location}_CONST_INVALID`);
  }
  if (rule.enum !== undefined && !rule.enum.some((candidate) => deepEqual(value, candidate))) {
    fail(`SCHEMA_${location}_ENUM_INVALID`);
  }
  if (rule.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`SCHEMA_${location}_TYPE_INVALID`);
    }
    const required = rule.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        fail(`SCHEMA_${location}_REQUIRED_INVALID`);
      }
    }
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(rule.properties ?? {}, key)) {
          fail(`SCHEMA_${location}_ADDITIONAL_PROPERTY`);
        }
      }
    }
    for (const [key, child] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchemaValue(value[key], child, rootSchema, `${location}_${key}`);
      }
    }
  } else if (rule.type === "array") {
    if (!Array.isArray(value)) {
      fail(`SCHEMA_${location}_TYPE_INVALID`);
    }
    if (rule.minItems !== undefined && value.length < rule.minItems) {
      fail(`SCHEMA_${location}_LENGTH_INVALID`);
    }
    if (rule.maxItems !== undefined && value.length > rule.maxItems) {
      fail(`SCHEMA_${location}_LENGTH_INVALID`);
    }
    if (rule.uniqueItems === true) {
      const canonical = value.map((item) => JSON.stringify(sortJsonKeys(item)));
      if (new Set(canonical).size !== canonical.length) {
        fail(`SCHEMA_${location}_UNIQUE_INVALID`);
      }
    }
    if (rule.items !== undefined) {
      value.forEach((item, index) =>
        validateSchemaValue(item, rule.items, rootSchema, `${location}_${index}`),
      );
    }
  } else if (rule.type === "string") {
    if (typeof value !== "string") {
      fail(`SCHEMA_${location}_TYPE_INVALID`);
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, "u").test(value)) {
      fail(`SCHEMA_${location}_PATTERN_INVALID`);
    }
    if (rule.format === "date-time") {
      timestampMilliseconds(value, `SCHEMA_${location}`);
    }
  } else if (rule.type === "integer") {
    if (!Number.isSafeInteger(value)) {
      fail(`SCHEMA_${location}_TYPE_INVALID`);
    }
    if (rule.minimum !== undefined && value < rule.minimum) {
      fail(`SCHEMA_${location}_MINIMUM_INVALID`);
    }
    if (rule.maximum !== undefined && value > rule.maximum) {
      fail(`SCHEMA_${location}_MAXIMUM_INVALID`);
    }
  } else if (rule.type === "boolean" && typeof value !== "boolean") {
    fail(`SCHEMA_${location}_TYPE_INVALID`);
  } else if (rule.type === "null" && value !== null) {
    fail(`SCHEMA_${location}_TYPE_INVALID`);
  }
}

function decodeCanonicalJson(bytes, maximumBytes, kind) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail(`${kind}_BYTES_INVALID`);
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0 || buffer.length > maximumBytes) {
    fail(`${kind}_SIZE_INVALID`);
  }
  if (buffer[buffer.length - 1] !== 0x0a || buffer.subarray(0, -1).includes(0x0a)) {
    fail(`${kind}_LINE_INVALID`);
  }
  if (buffer.includes(0x00) || buffer.includes(0x0d)) {
    fail(`${kind}_ENCODING_INVALID`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, -1));
  } catch {
    fail(`${kind}_ENCODING_INVALID`);
  }
  if (text.startsWith("\uFEFF")) {
    fail(`${kind}_ENCODING_INVALID`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    fail(`${kind}_JSON_INVALID`);
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    JSON.stringify(sortJsonKeys(document)) !== text
  ) {
    fail(`${kind}_CANONICAL_INVALID`);
  }
  return { document, text };
}

function assertNoSecretMaterial(text) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("SECRET_MATERIAL_PRESENT");
  }
  if (IP_ADDRESS_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("IP_ADDRESS_PRESENT");
  }
}

export function parseCanonicalEdgeWindowDocument(bytes) {
  const decoded = decodeCanonicalJson(bytes, MAX_EDGE_WINDOW_DOCUMENT_BYTES, "DOCUMENT");
  assertNoSecretMaterial(decoded.text);
  return decoded.document;
}

export function parseCanonicalWorkbenchCheckpoint(bytes) {
  const { document, text } = decodeCanonicalJson(
    bytes,
    MAX_WORKBENCH_CHECKPOINT_BYTES,
    "WORKBENCH_CHECKPOINT",
  );
  assertNoSecretMaterial(text);
  return document;
}

export function validateWorkbenchCheckpointDocument(document, options = {}) {
  assertExactKeys(
    document,
    [
      "capturedAt",
      "cliUsed",
      "duplicate",
      "eventFingerprintSha256",
      "expectedRevision",
      "httpStatus",
      "kind",
      "nonce",
      "receiver",
      "requestSha256",
      "schemaVersion",
      "source",
    ],
    "WORKBENCH_CHECKPOINT",
  );
  if (
    document.schemaVersion !== 1 ||
    document.kind !== "refunddesk.operator-workbench-replay" ||
    document.source !== "OPERATOR_WORKBENCH" ||
    document.receiver !== "REFUNDDESK_CREATE_NEW_V1" ||
    document.httpStatus !== 200 ||
    document.duplicate !== true ||
    document.cliUsed !== false
  ) {
    fail("WORKBENCH_CHECKPOINT_SEMANTICS_INVALID");
  }
  assertDigest(document.nonce, "WORKBENCH_NONCE");
  assertRevision(document.expectedRevision, "WORKBENCH_EXPECTED");
  assertDigest(document.eventFingerprintSha256, "WORKBENCH_EVENT_FINGERPRINT");
  assertDigest(document.requestSha256, "WORKBENCH_REQUEST");
  const capturedAt = timestampMilliseconds(document.capturedAt, "WORKBENCH_CAPTURED_AT");
  if (options.expectedNonce !== undefined && document.nonce !== options.expectedNonce) {
    fail("WORKBENCH_NONCE_MISMATCH");
  }
  if (
    options.expectedRequestSha256 !== undefined &&
    document.requestSha256 !== options.expectedRequestSha256
  ) {
    fail("WORKBENCH_REQUEST_MISMATCH");
  }
  if (
    options.expectedRevision !== undefined &&
    document.expectedRevision !== options.expectedRevision
  ) {
    fail("WORKBENCH_REVISION_MISMATCH");
  }
  if (
    options.expectedEventFingerprintSha256 !== undefined &&
    document.eventFingerprintSha256 !== options.expectedEventFingerprintSha256
  ) {
    fail("WORKBENCH_EVENT_FINGERPRINT_MISMATCH");
  }
  if (
    options.openedAt !== undefined &&
    capturedAt < timestampMilliseconds(options.openedAt, "EXPECTED_OPENED_AT")
  ) {
    fail("WORKBENCH_BEFORE_OPEN");
  }
  if (
    options.deadlineAt !== undefined &&
    capturedAt > timestampMilliseconds(options.deadlineAt, "EXPECTED_DEADLINE_AT")
  ) {
    fail("WORKBENCH_AFTER_DEADLINE");
  }
  return document;
}

function assertPassSemantics(document, times, options) {
  if (
    document.result !== "PASS" ||
    document.code !== PASS_EDGE_WINDOW_CODE ||
    document.exitCode !== 0 ||
    document.diagnostics.length !== 0 ||
    document.window.state !== "complete" ||
    document.window.retryAuthorized !== false ||
    times.openedAt === null ||
    times.closedAt === null
  ) {
    fail("PASS_IDENTITY_INVALID");
  }
  if (
    times.openedAt < times.startedAt ||
    times.closedAt < times.openedAt ||
    times.closedAt > times.deadlineAt
  ) {
    fail("PASS_WINDOW_ORDER_INVALID");
  }

  const admission = document.admission;
  const authorizationValidFrom = timestampMilliseconds(
    admission.authorizationValidFrom,
    "AUTHORIZATION_VALID_FROM",
  );
  const authorizationValidUntil = timestampMilliseconds(
    admission.authorizationValidUntil,
    "AUTHORIZATION_VALID_UNTIL",
  );
  const postflightValidUntil = timestampMilliseconds(
    admission.postflightValidUntil,
    "POSTFLIGHT_VALID_UNTIL",
  );
  const incidentValidUntil = timestampMilliseconds(
    admission.incidentValidUntil,
    "INCIDENT_VALID_UNTIL",
  );
  const incidentCapturedAt = timestampMilliseconds(
    admission.incidentCapturedAt,
    "INCIDENT_CAPTURED_AT",
  );
  const postflightCapturedAt = timestampMilliseconds(
    admission.postflightCapturedAt,
    "POSTFLIGHT_CAPTURED_AT",
  );
  const promotionContainerDigests = [
    admission.promotionCaddyContainerIdSha256,
    admission.promotionPostgresContainerIdSha256,
    admission.promotionVerifierContainerIdSha256,
    admission.promotionWebContainerIdSha256,
    admission.promotionWorkerContainerIdSha256,
  ];
  const derivedPostflightRemainingSeconds = Math.floor(
    (postflightValidUntil - times.operationStartedAt) / 1000,
  );
  const derivedIncidentRemainingSeconds = Math.floor(
    (incidentValidUntil - times.operationStartedAt) / 1000,
  );
  if (
    admission.incidentAccepted !== true ||
    admission.promotionAccepted !== true ||
    admission.postflightAccepted !== true ||
    admission.authorizationAccepted !== true ||
    admission.promotionRevision !== document.expectedRevision ||
    admission.promotionWorkerRuntimeMode !== "incident_admission" ||
    admission.incidentRemainingSecondsAtStart < MIN_POSTFLIGHT_REMAINING_SECONDS ||
    admission.incidentRemainingSecondsAtStart > MAX_ADMISSION_REMAINING_SECONDS ||
    admission.postflightRemainingSecondsAtStart < MIN_POSTFLIGHT_REMAINING_SECONDS ||
    admission.postflightRemainingSecondsAtStart > MAX_ADMISSION_REMAINING_SECONDS ||
    derivedPostflightRemainingSeconds < MIN_POSTFLIGHT_REMAINING_SECONDS ||
    derivedPostflightRemainingSeconds > MAX_ADMISSION_REMAINING_SECONDS ||
    derivedIncidentRemainingSeconds < MIN_POSTFLIGHT_REMAINING_SECONDS ||
    derivedIncidentRemainingSeconds > MAX_ADMISSION_REMAINING_SECONDS ||
    admission.incidentRemainingSecondsAtStart !== derivedIncidentRemainingSeconds ||
    admission.postflightRemainingSecondsAtStart !== derivedPostflightRemainingSeconds ||
    document.window.durationSeconds > admission.authorizationMaxWindowSeconds ||
    postflightCapturedAt > incidentCapturedAt ||
    incidentCapturedAt > times.operationStartedAt ||
    authorizationValidFrom > times.operationStartedAt ||
    authorizationValidUntil < times.completedAt ||
    authorizationValidUntil < times.deadlineAt ||
    authorizationValidUntil < times.operationStartedAt + EXECUTION_MAX_MILLISECONDS ||
    authorizationValidUntil - authorizationValidFrom > 2 * 60 * 60 * 1000 ||
    new Set(promotionContainerDigests).size !== promotionContainerDigests.length
  ) {
    fail("ADMISSION_INVALID");
  }
  const topology = document.topology;
  if (
    topology.accountMatched !== true ||
    topology.aliasMatched !== true ||
    topology.awsAccountIdSha256 !== admission.authorizedAwsAccountIdSha256 ||
    topology.awsRegionSha256 !== admission.authorizedAwsRegionSha256 ||
    topology.distributionDeployed !== true ||
    topology.distributionEnabled !== true ||
    topology.hostRevisionMatched !== true ||
    topology.hostSourcesMatched !== true ||
    topology.instanceMatched !== true ||
    topology.instanceRunning !== true ||
    topology.originDomainMatched !== true ||
    topology.runtimeContainersMatched !== true ||
    topology.sshCidrSha256 !== admission.authorizedSshCidrSha256 ||
    topology.sshInstanceMatched !== true ||
    topology.finalCaddyContainerIdSha256 === "0".repeat(64) ||
    [
      admission.promotionPostgresContainerIdSha256,
      admission.promotionVerifierContainerIdSha256,
      admission.promotionWebContainerIdSha256,
      admission.promotionWorkerContainerIdSha256,
    ].includes(topology.finalCaddyContainerIdSha256)
  ) {
    fail("TOPOLOGY_PROOF_INVALID");
  }

  const origin = document.origin;
  if (
    origin.bound !== true ||
    origin.boundDeployed !== true ||
    origin.distributionIdSha256 !== admission.authorizedDistributionIdSha256 ||
    origin.etagBindMatched !== true ||
    origin.etagUnbindMatched !== true ||
    origin.headerName !== "X-RefundDesk-Origin-Token" ||
    origin.headerRemoved !== true ||
    origin.originMatched !== true ||
    origin.originIdSha256 !== admission.authorizedOriginIdSha256 ||
    origin.secretMaterialEmitted !== false ||
    origin.tokenFileRemoved !== true ||
    origin.tokenGenerated !== true ||
    origin.tokenLengthBytes !== 32 ||
    origin.tokenMatched !== true ||
    origin.tokenWrittenRootOnly !== true ||
    origin.unboundDeployed !== true ||
    origin.updateAttempts !== 2
  ) {
    fail("ORIGIN_PROOF_INVALID");
  }

  const prefixes = document.prefixes;
  const fetchedAt = timestampMilliseconds(prefixes.fetchedAt, "PREFIX_FETCHED_AT");
  const prefixCreateDate = timestampMilliseconds(prefixes.createDate, "PREFIX_CREATE_DATE");
  if (
    prefixes.source !== "AWS_PUBLIC_IP_RANGES" ||
    prefixes.service !== "CLOUDFRONT_ORIGIN_FACING" ||
    prefixes.canonical !== true ||
    prefixes.exactService !== true ||
    prefixes.fresh !== true ||
    prefixes.firewallMatched !== true ||
    prefixes.ipv4Count < 1 ||
    prefixes.ipv6Count < 1 ||
    prefixCreateDate - fetchedAt > 2 * 60 * 1000 ||
    fetchedAt - prefixCreateDate > 30 * 24 * 60 * 60 * 1000 ||
    fetchedAt < times.startedAt ||
    fetchedAt > times.openedAt
  ) {
    fail("PREFIX_PROOF_INVALID");
  }

  const firewall = document.firewall;
  if (
    firewall.openObserved !== true ||
    firewall.closeAttemptedFirst !== true ||
    firewall.closeObserved !== true ||
    firewall.closeAmbiguous !== false ||
    firewall.exactPrefixSet !== true ||
    firewall.finalClosed !== true ||
    firewall.port80Closed !== true ||
    firewall.sshUnchanged !== true ||
    firewall.tcp443Only !== true ||
    firewall.udpClosed !== true ||
    firewall.wildcardAbsent !== true ||
    firewall.openedSha256 === null ||
    firewall.beforeSha256 !== firewall.afterSha256 ||
    firewall.beforeSha256 === firewall.openedSha256
  ) {
    fail("FIREWALL_PROOF_INVALID");
  }

  const watchdog = document.watchdog;
  const armedAt = optionalTimestampMilliseconds(watchdog.armedAt, "WATCHDOG_ARMED_AT");
  const effectiveWindowMilliseconds =
    (document.window.durationSeconds - WATCHDOG_CONTAINMENT_RESERVE_SECONDS) * 1000;
  const watchdogMonotonicBudgetMilliseconds =
    watchdog.deadlineBoottimeMilliseconds - watchdog.armedBoottimeMilliseconds;
  if (
    armedAt === null ||
    effectiveWindowMilliseconds <= 0 ||
    !Number.isSafeInteger(watchdog.armedBoottimeMilliseconds) ||
    !Number.isSafeInteger(watchdog.deadlineBoottimeMilliseconds) ||
    !Number.isSafeInteger(watchdog.closedBoottimeMilliseconds) ||
    !Number.isSafeInteger(watchdog.monotonicDurationMilliseconds) ||
    !DIGEST_PATTERN.test(watchdog.bootIdSha256) ||
    watchdog.deadlineBoottimeMilliseconds <= watchdog.armedBoottimeMilliseconds ||
    watchdogMonotonicBudgetMilliseconds < 30 * 1000 ||
    watchdogMonotonicBudgetMilliseconds > effectiveWindowMilliseconds ||
    watchdog.closedBoottimeMilliseconds < watchdog.armedBoottimeMilliseconds ||
    watchdog.monotonicDurationMilliseconds !==
      watchdog.closedBoottimeMilliseconds - watchdog.armedBoottimeMilliseconds ||
    watchdog.monotonicDurationMilliseconds > watchdogMonotonicBudgetMilliseconds ||
    watchdog.monotonicBounded !== true ||
    armedAt < times.startedAt ||
    armedAt > times.openedAt ||
    times.deadlineAt - armedAt !== effectiveWindowMilliseconds ||
    times.deadlineAt - times.openedAt > effectiveWindowMilliseconds ||
    watchdog.deadlineAt !== document.window.deadlineAt ||
    watchdog.armedBeforeIngress !== true ||
    watchdog.activeBeforeIngress !== true ||
    watchdog.caddyFenced !== true ||
    watchdog.workerFenced !== true ||
    watchdog.maintenanceStopped !== true ||
    watchdog.publicListenersClosed !== true ||
    watchdog.failSafeContained !== true ||
    watchdog.triggered !== false ||
    watchdog.disarmed !== true ||
    watchdog.markerComplete !== true
  ) {
    fail("WATCHDOG_PROOF_INVALID");
  }

  const local = document.probes.localCaddy;
  const health = document.probes.publicHealth;
  const finalPostflight = document.probes.finalPostflight;
  const finalPostflightCapturedAt = optionalTimestampMilliseconds(
    finalPostflight.capturedAt,
    "FINAL_POSTFLIGHT_CAPTURED_AT",
  );
  const finalPostflightValidUntil = optionalTimestampMilliseconds(
    finalPostflight.validUntil,
    "FINAL_POSTFLIGHT_VALID_UNTIL",
  );
  const workbench = document.probes.workbench;
  const workbenchCapturedAt = optionalTimestampMilliseconds(
    workbench.capturedAt,
    "WORKBENCH_CAPTURED_AT",
  );
  if (
    local.missingTokenStatus !== 404 ||
    local.wrongTokenStatus !== 404 ||
    local.correctTokenStatus !== 200 ||
    local.backendStripStatus !== 401 ||
    local.tokenStripped !== true ||
    health.status !== 200 ||
    health.cloudFrontObserved !== true ||
    health.revisionMatches !== true ||
    health.noStore !== true ||
    finalPostflight.contained !== true ||
    finalPostflight.officialValidator !== true ||
    finalPostflight.revisionMatches !== true ||
    finalPostflightCapturedAt === null ||
    finalPostflightValidUntil === null ||
    finalPostflightCapturedAt < times.closedAt ||
    finalPostflightCapturedAt > times.completedAt ||
    finalPostflightValidUntil < times.completedAt ||
    workbench.attestationSha256 === null ||
    workbenchCapturedAt === null ||
    workbenchCapturedAt < times.openedAt ||
    workbenchCapturedAt > times.closedAt ||
    workbenchCapturedAt > times.deadlineAt ||
    workbench.source !== "OPERATOR_WORKBENCH" ||
    workbench.httpStatus !== 200 ||
    workbench.duplicate !== true ||
    workbench.cliUsed !== false ||
    workbench.createNewObserved !== true ||
    workbench.createdAfterOpen !== true ||
    workbench.createdBeforeDeadline !== true ||
    workbench.nonceMatches !== true ||
    workbench.revisionMatches !== true
  ) {
    fail("FUNCTIONAL_PROOF_INVALID");
  }

  if (
    !deepEqual(document.counts.before, document.counts.during) ||
    !deepEqual(document.counts.before, document.counts.after) ||
    document.counts.unchanged !== true ||
    document.counts.quiescent !== true ||
    document.counts.after.unreleasedPaymentGuards !== 0 ||
    document.counts.after.activeFinancialJobs !== 0
  ) {
    fail("DURABLE_COUNTS_INVALID");
  }
  const database = document.database;
  if (
    !deepEqual(database.before, database.during) ||
    !deepEqual(database.before, database.after) ||
    database.stable !== true ||
    database.quiescent !== true ||
    database.after.systemIdentifierSha256 !== admission.promotionDatabaseSystemIdentifierSha256 ||
    database.after.activeWorkflows !== 0 ||
    database.after.liveInstallations !== 0 ||
    database.after.liveTenants !== 0 ||
    database.after.preparedTransactions !== 0
  ) {
    fail("DATABASE_INVARIANTS_INVALID");
  }
  if (!Object.values(document.containment).every((value) => value === true)) {
    fail("FINAL_CONTAINMENT_INVALID");
  }
  if (
    document.mutations.originUpdates !== 2 ||
    document.mutations.watchdogArms !== 1 ||
    document.mutations.firewallOpens !== 1 ||
    document.mutations.firewallCloses < 1 ||
    document.mutations.caddyStarts !== 1
  ) {
    fail("MUTATION_CARDINALITY_INVALID");
  }
  if (
    document.provenance.operatorLockHeld !== true ||
    document.provenance.sourcesExact !== true ||
    document.provenance.transportInputsPinned !== true ||
    (document.provenance.fixtureOnly === true && options.allowFixture !== true)
  ) {
    fail("PROVENANCE_INVALID");
  }
  const leaseCapture = leaseInterlockProfile(document);
  if (!leaseCapture.held || document.interlocksAtCapture.watchdogMarkerState !== "complete") {
    fail("INTERLOCK_CAPTURE_INVALID");
  }
}

function isAdmissibleFinalContainmentIncomplete(document, times) {
  if (
    document.result !== "INCOMPLETE" ||
    document.exitCode !== 21 ||
    document.code !== "FINAL_CONTAINMENT_FAILED" ||
    document.window.state !== "failed_closed" ||
    document.firewall.finalClosed !== true ||
    document.firewall.closeAmbiguous !== false ||
    document.firewall.closeObserved !== true ||
    document.firewall.afterSha256 !== document.firewall.beforeSha256 ||
    document.containment.awsIngressClosed !== true ||
    document.provenance.operatorLockHeld !== true
  ) {
    return false;
  }

  const watchdogRetained =
    document.watchdog.disarmed === false &&
    document.watchdog.markerComplete === false &&
    document.containment.watchdogDisarmed === false &&
    document.containment.markerComplete === false;
  const watchdogReleased =
    document.watchdog.disarmed === true &&
    document.watchdog.markerComplete === true &&
    document.containment.watchdogDisarmed === true &&
    document.containment.markerComplete === true;
  if (!watchdogRetained && !watchdogReleased) {
    return false;
  }

  const hostCleanupComplete =
    document.containment.caddyStopped === true &&
    document.containment.workerStopped === true &&
    document.containment.maintenanceStopped === true &&
    document.containment.publicListenersClosed === true;
  const tokenCleanupComplete =
    document.origin.tokenFileRemoved === true && document.containment.tokenRemoved === true;
  if (watchdogReleased && (!hostCleanupComplete || !tokenCleanupComplete)) {
    return false;
  }

  const temporalProofInvalid =
    (times.openedAt !== null && times.openedAt < times.startedAt) ||
    (times.openedAt !== null && times.closedAt === null) ||
    (times.openedAt !== null && times.closedAt !== null && times.closedAt < times.openedAt) ||
    (times.closedAt !== null && times.completedAt < times.closedAt);

  // FINAL_CONTAINMENT_FAILED is used by several exact recovery phases.  It may
  // retain the watchdog/lease while physical cleanup is incomplete, or it may
  // release them after AWS/host/token containment when only provider identity,
  // temporal, attribution, database or official-postflight proof failed. A
  // provider drift may leave the origin assertions false while the exact host
  // lease remains held; this is safe only because AWS ingress is proven closed.
  // In either profile at least
  // one concrete terminal assertion must remain false; changing a PASS label
  // alone is never an admissible INCOMPLETE artifact.
  return (
    [
      document.containment.caddyStopped,
      document.containment.workerStopped,
      document.containment.maintenanceStopped,
      document.containment.publicListenersClosed,
      document.containment.originHeaderRemoved,
      document.containment.tokenRemoved,
      document.containment.coreHealthy,
      document.containment.finalPostflightContained,
      document.containment.finalPostflightPass,
      document.containment.financialQuiescent,
      document.containment.financialStable,
      document.containment.liveDisabled,
      document.origin.headerRemoved,
      document.origin.unboundDeployed,
      document.origin.tokenFileRemoved,
      document.origin.etagBindMatched,
      document.origin.etagUnbindMatched,
      document.watchdog.failSafeContained,
      document.watchdog.monotonicBounded,
      document.probes.finalPostflight.contained,
      document.probes.finalPostflight.officialValidator,
      document.probes.finalPostflight.revisionMatches,
      document.counts.unchanged,
      document.counts.quiescent,
      document.database.stable,
      document.database.quiescent,
    ].some((value) => value === false) || temporalProofInvalid
  );
}

function watchdogInterlockProfile(document) {
  const retained =
    document.watchdog.disarmed === false &&
    document.watchdog.markerComplete === false &&
    document.containment.watchdogDisarmed === false &&
    document.containment.markerComplete === false;
  const released =
    document.watchdog.disarmed === true &&
    document.watchdog.markerComplete === true &&
    document.containment.watchdogDisarmed === true &&
    document.containment.markerComplete === true;
  return { released, retained };
}

function leaseInterlockProfile(document) {
  const capture = document.interlocksAtCapture;
  const absent =
    capture.authorizationMarkerState === "absent" &&
    capture.hostLeaseMarkerState === "absent" &&
    capture.holderActive === false;
  const held =
    capture.authorizationMarkerState === "held" &&
    capture.hostLeaseMarkerState === "held" &&
    capture.holderActive === true;
  const released =
    capture.authorizationMarkerState === "complete" &&
    capture.hostLeaseMarkerState === "complete" &&
    capture.holderActive === false;
  return { absent, held, released };
}

function isAdmissiblePostDisarmProviderDrift(document) {
  const capture = leaseInterlockProfile(document);
  return (
    document.result === "INCOMPLETE" &&
    document.exitCode === 21 &&
    document.code === "FINAL_CONTAINMENT_FAILED" &&
    document.window.state === "failed_closed" &&
    document.firewall.finalClosed === true &&
    document.firewall.closeAmbiguous === false &&
    document.firewall.closeObserved === true &&
    document.firewall.afterSha256 === document.firewall.beforeSha256 &&
    document.containment.awsIngressClosed === true &&
    document.containment.caddyStopped === true &&
    document.containment.workerStopped === true &&
    document.containment.maintenanceStopped === true &&
    document.containment.publicListenersClosed === true &&
    document.containment.originHeaderRemoved === false &&
    document.containment.tokenRemoved === true &&
    document.containment.coreHealthy === true &&
    document.containment.finalPostflightContained === true &&
    document.containment.finalPostflightPass === true &&
    document.containment.financialQuiescent === true &&
    document.containment.financialStable === true &&
    document.containment.liveDisabled === true &&
    document.watchdog.disarmed === true &&
    document.watchdog.markerComplete === true &&
    document.watchdog.failSafeContained === true &&
    document.watchdog.monotonicBounded === true &&
    document.watchdog.triggered === false &&
    document.containment.watchdogDisarmed === true &&
    document.containment.markerComplete === true &&
    document.origin.bound === true &&
    document.origin.boundDeployed === true &&
    document.origin.etagBindMatched === true &&
    document.origin.etagUnbindMatched === true &&
    document.origin.headerRemoved === false &&
    document.origin.unboundDeployed === false &&
    document.origin.tokenFileRemoved === true &&
    document.origin.updateAttempts === 2 &&
    document.mutations.originUpdates === 2 &&
    document.probes.finalPostflight.contained === true &&
    document.probes.finalPostflight.officialValidator === true &&
    document.probes.finalPostflight.revisionMatches === true &&
    document.counts.unchanged === true &&
    document.counts.quiescent === true &&
    document.database.stable === true &&
    document.database.quiescent === true &&
    document.provenance.operatorLockHeld === true &&
    capture.held &&
    document.interlocksAtCapture.watchdogMarkerState === "complete"
  );
}

function physicalCleanupAllowsInterlockRelease(document) {
  return (
    document.firewall.finalClosed === true &&
    document.firewall.closeObserved === true &&
    document.firewall.afterSha256 === document.firewall.beforeSha256 &&
    document.containment.awsIngressClosed === true &&
    document.containment.caddyStopped === true &&
    document.containment.workerStopped === true &&
    document.containment.maintenanceStopped === true &&
    document.containment.publicListenersClosed === true &&
    document.origin.headerRemoved === true &&
    document.origin.unboundDeployed === true &&
    document.origin.tokenFileRemoved === true &&
    document.containment.originHeaderRemoved === true &&
    document.containment.tokenRemoved === true
  );
}

export function validateEdgeWindowDocument(document, options = {}) {
  const schema =
    options.schema ??
    JSON.parse(
      readFileSync(resolve("docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json"), "utf8"),
    );
  validateSchemaValue(document, schema, schema, "ROOT");

  assertDigest(document.nonce, "NONCE");
  assertRevision(document.expectedRevision, "EXPECTED");
  if (options.expectedNonce !== undefined && document.nonce !== options.expectedNonce) {
    fail("NONCE_MISMATCH");
  }
  if (
    options.expectedRevision !== undefined &&
    document.expectedRevision !== options.expectedRevision
  ) {
    fail("REVISION_MISMATCH");
  }
  if (options.processExitCode !== undefined && document.exitCode !== options.processExitCode) {
    fail("PROCESS_EXIT_CODE_MISMATCH");
  }

  for (const [name, value] of Object.entries(document.admission)) {
    if (name.endsWith("Sha256")) {
      assertDigest(value, `ADMISSION_${name.toUpperCase()}`);
    }
  }
  for (const name of ["distributionIdSha256", "originIdSha256"]) {
    assertDigest(document.origin[name], `ORIGIN_${name.toUpperCase()}`);
  }
  assertDigest(document.topology.finalCaddyContainerIdSha256, "FINAL_CADDY_CONTAINER_ID");
  for (const name of ["allowlistSha256", "documentSha256"]) {
    assertDigest(document.prefixes[name], `PREFIX_${name.toUpperCase()}`);
  }
  for (const name of ["beforeSha256", "afterSha256"]) {
    assertDigest(document.firewall[name], `FIREWALL_${name.toUpperCase()}`);
  }
  if (document.firewall.openedSha256 !== null) {
    assertDigest(document.firewall.openedSha256, "FIREWALL_OPENED");
  }
  assertDigest(document.probes.workbench.eventFingerprintSha256, "EVENT_FINGERPRINT");
  assertDigest(document.probes.finalPostflight.evidenceSha256, "FINAL_POSTFLIGHT_EVIDENCE");
  assertDigest(document.probes.finalPostflight.validationSha256, "FINAL_POSTFLIGHT_VALIDATION");
  if (document.probes.workbench.attestationSha256 !== null) {
    assertDigest(document.probes.workbench.attestationSha256, "WORKBENCH_ATTESTATION");
  }

  for (const snapshot of [document.counts.before, document.counts.during, document.counts.after]) {
    assertExactKeys(snapshot, SNAPSHOT_KEYS, "COUNT_SNAPSHOT");
  }
  assertExactKeys(document.redaction, REDACTION_KEYS, "REDACTION");
  if (!Object.values(document.redaction).every((value) => value === false)) {
    fail("REDACTION_INVALID");
  }

  if (!deepEqual(document.diagnostics, [...document.diagnostics].sort())) {
    fail("DIAGNOSTICS_ORDER_INVALID");
  }

  const sourcePaths = document.provenance.sources.map((source) => source.path);
  if (!deepEqual(sourcePaths, EXPECTED_SOURCE_PATHS)) {
    fail("SOURCE_SET_INVALID");
  }
  for (const source of document.provenance.sources) {
    assertDigest(source.sourceSha256, "SOURCE_SHA256");
    assertDigest(source.indexSha256, "SOURCE_INDEX_SHA256");
    assertDigest(source.headSha256, "SOURCE_HEAD_SHA256");
    if (source.sourceSha256 !== source.indexSha256 || source.sourceSha256 !== source.headSha256) {
      fail("SOURCE_INDEX_HEAD_MISMATCH");
    }
    const expected = options.expectedSourceDigests?.[source.path];
    if (expected !== undefined && source.sourceSha256 !== expected) {
      fail("SOURCE_DIGEST_MISMATCH");
    }
  }
  assertRevision(document.provenance.repositoryHead, "REPOSITORY_HEAD");
  if (document.provenance.repositoryHead !== document.expectedRevision) {
    fail("REPOSITORY_HEAD_MISMATCH");
  }
  assertDigest(document.provenance.repositoryIndexSha256, "REPOSITORY_INDEX");
  assertDigest(document.provenance.sourceBundleSha256, "SOURCE_BUNDLE");
  assertDigest(document.provenance.transportInputsSha256, "TRANSPORT_INPUTS");
  assertDigest(document.provenance.toolImageIdSha256, "TOOL_IMAGE_ID");
  assertDigest(document.provenance.workflowRunObservationSha256, "WORKFLOW_RUN_OBSERVATION");
  assertDigest(document.provenance.operatorBootIdentifierSha256, "OPERATOR_BOOT_IDENTIFIER");
  if (
    !Number.isSafeInteger(document.provenance.operatorStartedMonotonicMilliseconds) ||
    document.provenance.operatorStartedMonotonicMilliseconds < 0 ||
    !Number.isSafeInteger(document.provenance.operatorDeadlineMonotonicMilliseconds) ||
    document.provenance.operatorDeadlineMonotonicMilliseconds -
      document.provenance.operatorStartedMonotonicMilliseconds !==
      EXECUTION_MAX_MILLISECONDS ||
    !Number.isSafeInteger(document.provenance.operationRemainingSecondsAtRunnerStart) ||
    document.provenance.operationRemainingSecondsAtRunnerStart < 0 ||
    document.provenance.operationRemainingSecondsAtRunnerStart >
      EXECUTION_MAX_MILLISECONDS / 1000 - OPERATOR_HANDOFF_RESERVE_SECONDS
  ) {
    fail("OPERATOR_CLOCK_PROVENANCE_INVALID");
  }
  // The operator may never hand the runner more budget than it still held when
  // it calculated the grant, less the handoff reserve.  The runner enforces the
  // same rule from the control document; this is the independent second check.
  // Mirror the runner's truncating integer division so the bound stays equal.
  if (
    !Number.isSafeInteger(document.provenance.operatorControlCalculatedMonotonicMilliseconds) ||
    document.provenance.operatorControlCalculatedMonotonicMilliseconds <
      document.provenance.operatorStartedMonotonicMilliseconds ||
    document.provenance.operatorControlCalculatedMonotonicMilliseconds >=
      document.provenance.operatorDeadlineMonotonicMilliseconds ||
    document.provenance.operationRemainingSecondsAtRunnerStart >
      Math.floor(
        (document.provenance.operatorDeadlineMonotonicMilliseconds -
          document.provenance.operatorControlCalculatedMonotonicMilliseconds) /
          1000,
      ) -
        OPERATOR_HANDOFF_RESERVE_SECONDS
  ) {
    fail("OPERATOR_CONTROL_GRANT_INVALID");
  }
  // The runner expresses its own deadline on CLOCK_BOOTTIME, which restarts at
  // zero on reboot, so a rebooted or wall-clock-shifted host cannot inherit the
  // window.  Its span never exceeds the grant the operator handed over.
  assertDigest(document.provenance.runnerBootIdentifierSha256, "RUNNER_BOOT_IDENTIFIER");
  if (
    !Number.isSafeInteger(document.provenance.runnerStartedBoottimeMilliseconds) ||
    document.provenance.runnerStartedBoottimeMilliseconds < 0 ||
    !Number.isSafeInteger(document.provenance.runnerDeadlineBoottimeMilliseconds) ||
    document.provenance.runnerDeadlineBoottimeMilliseconds <
      document.provenance.runnerStartedBoottimeMilliseconds ||
    document.provenance.runnerDeadlineBoottimeMilliseconds -
      document.provenance.runnerStartedBoottimeMilliseconds >
      document.provenance.operationRemainingSecondsAtRunnerStart * 1000
  ) {
    fail("RUNNER_CLOCK_PROVENANCE_INVALID");
  }
  if (
    !Number.isSafeInteger(document.provenance.workflowRunId) ||
    document.provenance.workflowRunId < 1
  ) {
    fail("WORKFLOW_RUN_ID_INVALID");
  }
  if (
    document.provenance.repositoryIndexSha256 !==
      canonicalSha256(
        document.provenance.sources.map(({ indexSha256, path }) => ({ indexSha256, path })),
      ) ||
    document.provenance.sourceBundleSha256 !== canonicalSha256(document.provenance.sources)
  ) {
    fail("SOURCE_BUNDLE_DIGEST_MISMATCH");
  }

  const times = {
    operationStartedAt: timestampMilliseconds(document.operationStartedAt, "OPERATION_STARTED_AT"),
    startedAt: timestampMilliseconds(document.startedAt, "STARTED_AT"),
    openedAt: optionalTimestampMilliseconds(document.window.openedAt, "OPENED_AT"),
    deadlineAt: timestampMilliseconds(document.window.deadlineAt, "DEADLINE_AT"),
    closedAt: optionalTimestampMilliseconds(document.window.closedAt, "CLOSED_AT"),
    completedAt: timestampMilliseconds(document.completedAt, "COMPLETED_AT"),
  };
  if (
    times.startedAt < times.operationStartedAt ||
    times.completedAt < times.startedAt ||
    (times.openedAt !== null && times.openedAt > times.deadlineAt) ||
    (times.closedAt !== null && times.closedAt < (times.openedAt ?? times.startedAt)) ||
    (times.closedAt !== null && times.completedAt < times.closedAt)
  ) {
    fail("WINDOW_ORDER_INVALID");
  }
  if (document.window.durationSeconds > 300) {
    fail("WINDOW_DURATION_INVALID");
  }
  if (
    (document.firewall.openObserved === true ||
      document.firewall.openedSha256 !== null ||
      document.mutations.firewallOpens > 0) &&
    times.openedAt === null
  ) {
    fail("WINDOW_EFFECT_ORDER_INVALID");
  }
  if (
    options.notBefore !== undefined &&
    times.startedAt < timestampMilliseconds(options.notBefore, "NOT_BEFORE")
  ) {
    fail("CAPTURE_BEFORE_BOUND");
  }
  if (
    options.notAfter !== undefined &&
    times.completedAt > timestampMilliseconds(options.notAfter, "NOT_AFTER")
  ) {
    fail("CAPTURE_AFTER_BOUND");
  }

  if (document.result === "PASS") {
    if (times.completedAt - times.operationStartedAt > EXECUTION_MAX_MILLISECONDS) {
      fail("EXECUTION_DURATION_INVALID");
    }
    assertPassSemantics(document, times, options);
  } else if (document.result === "FAIL") {
    if (
      document.exitCode !== 20 ||
      !FAIL_CODES.has(document.code) ||
      document.window.state !== "failed_closed" ||
      !deepEqual(document.diagnostics, [document.code])
    ) {
      fail("FAIL_IDENTITY_INVALID");
    }
  } else if (document.result === "INCOMPLETE") {
    if (
      document.exitCode !== 21 ||
      !INCOMPLETE_CODES.has(document.code) ||
      document.window.state !== "failed_closed" ||
      !deepEqual(document.diagnostics, [document.code])
    ) {
      fail("INCOMPLETE_IDENTITY_INVALID");
    }
  }

  // The durable timer/marker is an all-or-nothing recovery interlock in every
  // terminal profile, not only FINAL_CONTAINMENT_FAILED. It may be released
  // only after exact physical cleanup, except for the narrowly modeled
  // post-disarm provider drift whose held host/authorization leases remain the
  // recovery interlock. Ambiguity or an unobservable control plane retains it.
  const interlock = watchdogInterlockProfile(document);
  const leaseCapture = leaseInterlockProfile(document);
  const admissiblePostDisarmProviderDrift = isAdmissiblePostDisarmProviderDrift(document);
  if (
    (!leaseCapture.absent && !leaseCapture.held && !leaseCapture.released) ||
    (!interlock.retained && !interlock.released) ||
    (interlock.released &&
      !physicalCleanupAllowsInterlockRelease(document) &&
      !admissiblePostDisarmProviderDrift) ||
    (document.code === "FIREWALL_CLOSE_AMBIGUOUS" &&
      document.firewall.finalClosed !== true &&
      !interlock.retained)
  ) {
    fail("INTERLOCK_PROFILE_INVALID");
  }

  const admissibleFinalContainmentIncomplete = isAdmissibleFinalContainmentIncomplete(
    document,
    times,
  );
  const originEffectProjected =
    document.origin.bound === true ||
    document.origin.tokenGenerated === true ||
    document.origin.updateAttempts > 0 ||
    document.mutations.originUpdates > 0;
  if (
    document.result === "FAIL" &&
    (times.openedAt !== null || originEffectProjected) &&
    (document.firewall.finalClosed !== true ||
      document.containment.awsIngressClosed !== true ||
      document.containment.caddyStopped !== true ||
      document.containment.workerStopped !== true ||
      document.containment.maintenanceStopped !== true ||
      document.containment.publicListenersClosed !== true ||
      document.origin.etagUnbindMatched !== true ||
      document.origin.headerRemoved !== true ||
      document.origin.unboundDeployed !== true ||
      document.origin.tokenFileRemoved !== true ||
      document.containment.originHeaderRemoved !== true ||
      document.containment.tokenRemoved !== true ||
      document.watchdog.disarmed !== true ||
      document.watchdog.markerComplete !== true ||
      document.containment.watchdogDisarmed !== true ||
      document.containment.markerComplete !== true)
  ) {
    fail("OPENED_WINDOW_NOT_RECONTAINED");
  }
  if (document.code === "FINAL_CONTAINMENT_FAILED" && times.openedAt !== null) {
    if (document.result === "INCOMPLETE" && !admissibleFinalContainmentIncomplete) {
      fail("INCOMPLETE_CONTAINMENT_IDENTITY_INVALID");
    }
  }
  if (
    times.openedAt !== null &&
    !admissibleFinalContainmentIncomplete &&
    !new Set(["FIREWALL_CLOSE_AMBIGUOUS", "CONTROL_PLANE_UNAVAILABLE"]).has(document.code)
  ) {
    if (
      document.firewall.finalClosed !== true ||
      document.containment.awsIngressClosed !== true ||
      document.containment.caddyStopped !== true ||
      document.containment.workerStopped !== true ||
      document.containment.maintenanceStopped !== true ||
      document.containment.publicListenersClosed !== true
    ) {
      fail("OPENED_WINDOW_NOT_RECONTAINED");
    }
  }
  if (
    document.firewall.closeAmbiguous === true &&
    !new Set(["FIREWALL_CLOSE_AMBIGUOUS", "CONTROL_PLANE_UNAVAILABLE"]).has(document.code)
  ) {
    fail("CLOSE_AMBIGUITY_IDENTITY_INVALID");
  }
  return document;
}

export function validateEdgeWindowBytes(bytes, options = {}) {
  return validateEdgeWindowDocument(parseCanonicalEdgeWindowDocument(bytes), options);
}

function readBoundedDescriptor(descriptor, maximumBytes, kind) {
  const chunks = [];
  let total = 0;
  try {
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
  } catch {
    fail(`${kind}_READ_INVALID`);
  }
  if (total > maximumBytes) {
    fail(`${kind}_SIZE_INVALID`);
  }
  return Buffer.concat(chunks, total);
}

function readBoundedPath(path, maximumBytes, kind) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0) | (fileConstants.O_CLOEXEC ?? 0),
    );
  } catch {
    fail(`${kind}_READ_INVALID`);
  }
  try {
    const information = fstatSync(descriptor);
    if (!information.isFile()) {
      fail(`${kind}_READ_INVALID`);
    }
    if (information.size > maximumBytes) {
      fail(`${kind}_SIZE_INVALID`);
    }
    return readBoundedDescriptor(descriptor, maximumBytes, kind);
  } finally {
    closeSync(descriptor);
  }
}

function main(arguments_) {
  if (arguments_[0] === "--workbench") {
    if (arguments_.length !== 7) {
      process.stderr.write(
        "usage: validate-lightsail-edge-window.mjs --workbench DOCUMENT NONCE REVISION EVENT_FINGERPRINT OPENED_AT DEADLINE_AT\n",
      );
      return 64;
    }
    const [
      ,
      documentPath,
      expectedNonce,
      expectedRevision,
      expectedFingerprint,
      openedAt,
      deadlineAt,
    ] = arguments_;
    try {
      validateWorkbenchCheckpointDocument(
        parseCanonicalWorkbenchCheckpoint(
          readBoundedPath(documentPath, MAX_WORKBENCH_CHECKPOINT_BYTES, "WORKBENCH_CHECKPOINT"),
        ),
        {
          deadlineAt,
          expectedEventFingerprintSha256: expectedFingerprint,
          expectedNonce,
          expectedRevision,
          openedAt,
        },
      );
      process.stdout.write("PASS_WORKBENCH_CHECKPOINT\n");
      return 0;
    } catch (error) {
      if (error instanceof EdgeWindowValidationError) {
        process.stderr.write(`${error.code}\n`);
        return 20;
      }
      throw error;
    }
  }
  if (arguments_.length < 7 || arguments_.length > 8) {
    process.stderr.write(
      "usage: validate-lightsail-edge-window.mjs DOCUMENT SCHEMA NONCE REVISION EXIT_CODE NOT_BEFORE NOT_AFTER [ALLOW_FIXTURE]\n",
    );
    return 64;
  }
  const [documentPath, schemaPath, nonce, revision, exitCodeText, notBefore, notAfter, fixture] =
    arguments_;
  if (!/^(?:0|20|21)$/u.test(exitCodeText) || (fixture !== undefined && fixture !== "fixture")) {
    return 64;
  }
  try {
    // `-` is the runner's immutable-candidate boundary: the exact bytes are
    // supplied once on stdin, so a pathname rename cannot change the document
    // between local joins and the public validator.
    const documentBytes =
      documentPath === "-"
        ? readBoundedDescriptor(0, MAX_EDGE_WINDOW_DOCUMENT_BYTES, "DOCUMENT")
        : readBoundedPath(documentPath, MAX_EDGE_WINDOW_DOCUMENT_BYTES, "DOCUMENT");
    validateEdgeWindowBytes(documentBytes, {
      schema: JSON.parse(readFileSync(schemaPath, "utf8")),
      expectedNonce: nonce,
      expectedRevision: revision,
      processExitCode: Number(exitCodeText),
      notBefore,
      notAfter,
      allowFixture: fixture === "fixture",
    });
    process.stdout.write(`${PASS_EDGE_WINDOW_CODE}\n`);
    return 0;
  } catch (error) {
    if (error instanceof EdgeWindowValidationError) {
      process.stderr.write(`${error.code}\n`);
      return 20;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
