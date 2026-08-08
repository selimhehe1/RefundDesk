import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_DURATION_MILLISECONDS = 15 * 60 * 1000;
const CLOCK_SKEW_MILLISECONDS = 2 * 60 * 1000;
const EXPECTED_REVISION = "8da280b78a9d1475c7bd79063e72c5af77121e8d";
const EXPECTED_SOURCE_DIGESTS = Object.freeze({
  manifestSha256: "e72319926d184db8e696c7d4d032d3f9e44cbabbde9b36e64c473da96ef241ca",
  composeSha256: "92a96553a38b226505957e717e2844960794256dceb5a5284fde0c00d22b4610",
  commonSha256: "e3582a5ccbac7be03731c1773cb3527c9ee6613796a131762b19041fa6918da6",
  helperSha256: "76fba53c93c450c202788a9fd12754e409e713a7b8407084723c440f01f7a6e6",
});
const EXPECTED_IMAGE_IDS = Object.freeze({
  postgres: "sha256:0a314d409a9633cff4f89dc18482262625c0ee78cb1aa2ff8e47bc6da0251e1b",
  verifier: "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe",
  worker: "sha256:e3ead31f6c3084b69731e095a250b8d0a4e3e9d6e8d239dccf077e6b90d53f64",
  web: "sha256:c1d13b7db80e019e8a0ea24717c2a2028052b5959e1aaf65746336073606601f",
  caddy: "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe",
});
const SCHEMA_PATH = "docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json";
const VALIDATOR_PATH = "scripts/validate-lightsail-containment-reconciliation.mjs";
const PASS_CODE = "PASS_CONTAINED_JOURNAL_CLEARED";
const INCOMPLETE_CODES = new Set([
  "TOOL_UNAVAILABLE",
  "OPERATOR_LOCK_UNAVAILABLE",
  "SOURCE_IDENTITY_UNAVAILABLE",
  "JOURNAL_UNAVAILABLE",
  "CONTROL_STATE_UNAVAILABLE",
  "CONTAINER_INVENTORY_UNAVAILABLE",
  "SYSTEMD_INVENTORY_UNAVAILABLE",
  "LISTENER_INVENTORY_UNAVAILABLE",
  "LIVE_INTERLOCK_UNAVAILABLE",
  "DATABASE_SNAPSHOT_UNAVAILABLE",
]);
const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/u,
  /\bwhsec_[A-Za-z0-9]{12,}\b/u,
  /\babsec_[A-Za-z0-9_]{12,}\b/u,
  /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
]);
const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "nonce",
  "expectedRevision",
  "operation",
  "startedAt",
  "completedAt",
  "exitCode",
  "result",
  "code",
  "diagnostics",
  "marker",
  "captures",
  "containment",
  "mutations",
  "redaction",
]);
const MARKER_KEYS = Object.freeze([
  "state",
  "resumedFromState",
  "journalPresentAtInvocationStart",
  "revision",
  "operation",
  "runnerSha256",
  "journalSha256",
  "admissionInvariantSha256",
  "containedStateSha256",
]);
const CAPTURE_KEYS = Object.freeze([
  "capturedAt",
  "identity",
  "journal",
  "control",
  "containers",
  "surface",
  "database",
]);
const IDENTITY_KEYS = Object.freeze([
  "activeRevision",
  "currentRevision",
  "sourceRevision",
  "releaseEnvironmentRevision",
  "manifestSha256",
  "composeSha256",
  "commonSha256",
  "helperSha256",
]);
const JOURNAL_KEYS = Object.freeze(["present", "operation", "revision", "status", "sha256"]);
const CONTROL_KEYS = Object.freeze([
  "activeReleaseUnitCount",
  "activeFenceUnitCount",
  "releaseRuntimeMarkerCount",
  "transitionPresent",
  "backupUploadJournalPresent",
  "managedTransitionPresent",
  "reservationValid",
  "knownOneShotsPresentCount",
  "knownOneShotsRunningCount",
  "unexpectedRunningContainerCount",
]);
const CONTAINER_KEYS = Object.freeze([
  "service",
  "presentCount",
  "containerId",
  "imageId",
  "expectedImageId",
  "imageReferenceMatches",
  "status",
  "health",
  "restartPolicy",
  "projectLabelMatches",
  "serviceLabelMatches",
  "revisionLabelMatches",
]);
const SURFACE_KEYS = Object.freeze([
  "systemdInventoryAvailable",
  "listenerInventoryAvailable",
  "liveInterlocksAvailable",
  "platformLiveDisabled",
  "workerLiveDisabled",
  "liveWebhookDisabled",
  "webEffectiveLiveDisabled",
  "workerEffectiveLiveDisabled",
  "backupTimerActive",
  "retentionTimerActive",
  "backupServiceActive",
  "retentionServiceActive",
  "quiesceRecoveryActive",
  "tcp80Listening",
  "tcp443Listening",
  "udp80Listening",
  "udp443Listening",
]);
const DATABASE_KEYS = Object.freeze([
  "snapshotAvailable",
  "systemIdentifier",
  "activeWorkflows",
  "unreleasedPaymentGuards",
  "activeFinancialJobs",
  "liveTenants",
  "liveInstallations",
  "preparedTransactions",
  "refundRequests",
  "auditEvents",
]);
const CONTAINMENT_KEYS = Object.freeze([
  "sourceExact",
  "liveDisabled",
  "financialStable",
  "financialQuiescent",
  "coreHealthy",
  "coreContainerIdentitiesStable",
  "workerStopped",
  "caddyStopped",
  "oneShotsStopped",
  "maintenanceStopped",
  "publicListenersClosed",
  "releaseFenceAbsent",
  "reservationValid",
  "journalCleared",
  "markerComplete",
]);
const MUTATION_KEYS = Object.freeze([
  "unitsStopRequested",
  "containersRestartFenced",
  "containersStopped",
  "reservationReconciled",
  "journalCleared",
  "markerTransitions",
]);
const REDACTION_KEYS = Object.freeze([
  "rawSecretPresent",
  "rawApiKeyPresent",
  "rawSignaturePresent",
  "rawPayloadPresent",
  "customerDataPresent",
  "arbitraryPathPresent",
  "ipAddressPresent",
  "stderrPresent",
  "keyDigestPresent",
]);

export class ContainmentReconciliationValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContainmentReconciliationValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ContainmentReconciliationValidationError(code);
}

function deepEqual(left, right) {
  return JSON.stringify(sortJsonKeys(left)) === JSON.stringify(sortJsonKeys(right));
}

function assertExactKeys(value, expected, location) {
  if (!deepEqual(Object.keys(value), [...expected].sort())) {
    fail(`KEYS_${location}_INVALID`);
  }
}

function sortJsonKeys(value) {
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

function containedStateSha256(capture) {
  const projection = Object.fromEntries(
    Object.entries(capture).filter(([key]) => key !== "capturedAt" && key !== "journal"),
  );
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(projection)), "utf8")
    .digest("hex");
}

function admissionInvariantSha256(capture) {
  const projection = {
    identity: capture.identity,
    containers: capture.containers.map(
      ({
        service,
        presentCount,
        containerId,
        imageId,
        expectedImageId,
        imageReferenceMatches,
      }) => ({
        service,
        presentCount,
        containerId,
        imageId,
        expectedImageId,
        imageReferenceMatches,
      }),
    ),
    database: capture.database,
    live: {
      liveInterlocksAvailable: capture.surface.liveInterlocksAvailable,
      platformLiveDisabled: capture.surface.platformLiveDisabled,
      workerLiveDisabled: capture.surface.workerLiveDisabled,
      liveWebhookDisabled: capture.surface.liveWebhookDisabled,
      webEffectiveLiveDisabled: capture.surface.webEffectiveLiveDisabled,
      workerEffectiveLiveDisabled: capture.surface.workerEffectiveLiveDisabled,
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(projection)), "utf8")
    .digest("hex");
}

function decodePointerPart(part) {
  return part.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveReference(rootSchema, reference) {
  if (!reference.startsWith("#/")) {
    fail("SCHEMA_EXTERNAL_REFERENCE_FORBIDDEN");
  }
  let current = rootSchema;
  for (const rawPart of reference.slice(2).split("/")) {
    const part = decodePointerPart(rawPart);
    if (current === null || typeof current !== "object" || !(part in current)) {
      fail("SCHEMA_REFERENCE_INVALID");
    }
    current = current[part];
  }
  return current;
}

function typeMatches(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value);
    case "null":
      return value === null;
    default:
      fail("SCHEMA_TYPE_UNSUPPORTED");
  }
}

function validateSchemaNode(value, schema, rootSchema, location = "ROOT") {
  if (schema === false) {
    fail(`SCHEMA_${location}_FORBIDDEN`);
  }
  if (schema === true) {
    return;
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    fail("SCHEMA_DEFINITION_INVALID");
  }
  if (schema.$ref !== undefined) {
    validateSchemaNode(value, resolveReference(rootSchema, schema.$ref), rootSchema, location);
  }
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
      fail("SCHEMA_ALLOF_INVALID");
    }
    for (const member of schema.allOf) {
      validateSchemaNode(value, member, rootSchema, location);
    }
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      fail("SCHEMA_ONEOF_INVALID");
    }
    let matches = 0;
    for (const member of schema.oneOf) {
      try {
        validateSchemaNode(value, member, rootSchema, location);
        matches += 1;
      } catch (error) {
        if (!(error instanceof ContainmentReconciliationValidationError)) {
          throw error;
        }
      }
    }
    if (matches !== 1) {
      fail(`SCHEMA_${location}_ONEOF_INVALID`);
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    fail(`SCHEMA_${location}_CONST_INVALID`);
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.some((candidate) => deepEqual(value, candidate)))
  ) {
    fail(`SCHEMA_${location}_ENUM_INVALID`);
  }
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    fail(`SCHEMA_${location}_TYPE_INVALID`);
  }
  if (typeof value === "string" && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern, "u").test(value)) {
      fail(`SCHEMA_${location}_PATTERN_INVALID`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`SCHEMA_${location}_MINIMUM_INVALID`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(`SCHEMA_${location}_MAXIMUM_INVALID`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`SCHEMA_${location}_MIN_ITEMS_INVALID`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`SCHEMA_${location}_MAX_ITEMS_INVALID`);
    }
    if (schema.uniqueItems === true) {
      const serialized = value.map((entry) => JSON.stringify(entry));
      if (new Set(serialized).size !== serialized.length) {
        fail(`SCHEMA_${location}_UNIQUE_ITEMS_INVALID`);
      }
    }
    if (schema.prefixItems !== undefined) {
      for (let index = 0; index < Math.min(value.length, schema.prefixItems.length); index += 1) {
        validateSchemaNode(
          value[index],
          schema.prefixItems[index],
          rootSchema,
          `${location}_${index}`,
        );
      }
      if (schema.items === false && value.length > schema.prefixItems.length) {
        fail(`SCHEMA_${location}_EXTRA_ITEMS_INVALID`);
      }
    } else if (schema.items !== undefined && schema.items !== false) {
      for (let index = 0; index < value.length; index += 1) {
        validateSchemaNode(value[index], schema.items, rootSchema, `${location}_${index}`);
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        fail(`SCHEMA_${location}_REQUIRED_MISSING`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          fail(`SCHEMA_${location}_ADDITIONAL_PROPERTY`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateSchemaNode(value[key], propertySchema, rootSchema, `${location}_${key}`);
      }
    }
  }
}

export function parseCanonicalContainmentDocument(bytes, { maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes)) {
    fail("DOCUMENT_BUFFER_REQUIRED");
  }
  if (bytes.length === 0 || bytes.length > maxBytes) {
    fail("DOCUMENT_SIZE_INVALID");
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("DOCUMENT_BOM_FORBIDDEN");
  }
  if (bytes.includes(0x00)) {
    fail("DOCUMENT_NUL_FORBIDDEN");
  }
  if (bytes.includes(0x0d)) {
    fail("DOCUMENT_CR_FORBIDDEN");
  }
  if (bytes.at(-1) !== 0x0a) {
    fail("DOCUMENT_FINAL_LF_REQUIRED");
  }
  const bodyBytes = bytes.subarray(0, bytes.length - 1);
  if (bodyBytes.includes(0x0a)) {
    fail("DOCUMENT_SINGLE_LINE_REQUIRED");
  }
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    fail("DOCUMENT_UTF8_INVALID");
  }
  if (body.length === 0 || body.trim() !== body) {
    fail("DOCUMENT_TRAILING_DATA_FORBIDDEN");
  }
  let document;
  try {
    document = JSON.parse(body);
  } catch {
    fail("DOCUMENT_JSON_INVALID");
  }
  if (JSON.stringify(sortJsonKeys(document)) !== body) {
    fail("DOCUMENT_CANONICAL_JSON_REQUIRED");
  }
  return document;
}

function walkStrings(value, callback) {
  if (typeof value === "string") {
    callback(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const member of value) {
      walkStrings(member, callback);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) {
      walkStrings(member, callback);
    }
  }
}

function assertNoForbiddenMaterial(document) {
  const serialized = JSON.stringify(document);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      fail("DOCUMENT_SECRET_CANARY_PRESENT");
    }
  }
  walkStrings(document, (value) => {
    if (isIP(value) !== 0) {
      fail("DOCUMENT_IP_ADDRESS_PRESENT");
    }
    if (
      value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(value) ||
      value.startsWith("\\\\") ||
      value.startsWith("file:") ||
      value.includes("\\")
    ) {
      fail("DOCUMENT_PATH_PRESENT");
    }
  });
}

function parseUtcTimestamp(value, location) {
  if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u.test(value)) {
    fail(`TIMESTAMP_${location}_INVALID`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    fail(`TIMESTAMP_${location}_INVALID`);
  }
  return parsed;
}

function assertTimestampSemantics(document, notBefore, notAfter) {
  const lower = parseUtcTimestamp(notBefore, "LOCAL_NOT_BEFORE");
  const upper = parseUtcTimestamp(notAfter, "LOCAL_NOT_AFTER");
  if (lower > upper || upper - lower > MAX_DURATION_MILLISECONDS) {
    fail("LOCAL_TIME_BOUND_INVALID");
  }
  const started = parseUtcTimestamp(document.startedAt, "STARTED");
  const captureAdmission = parseUtcTimestamp(document.captures.admission.capturedAt, "ADMISSION");
  const captureA = parseUtcTimestamp(document.captures.before.a.capturedAt, "BEFORE_A");
  const captureB = parseUtcTimestamp(document.captures.before.b.capturedAt, "BEFORE_B");
  const captureAfter = parseUtcTimestamp(document.captures.after.capturedAt, "AFTER");
  const completed = parseUtcTimestamp(document.completedAt, "COMPLETED");
  if (!(
    started <= captureAdmission &&
    captureAdmission <= captureA &&
    captureA <= captureB &&
    captureB <= captureAfter &&
    captureAfter <= completed
  )) {
    fail("TIMESTAMP_ORDER_INVALID");
  }
  if (completed - started > MAX_DURATION_MILLISECONDS) {
    fail("TIMESTAMP_DURATION_INVALID");
  }
  if (started < lower - CLOCK_SKEW_MILLISECONDS || completed > upper + CLOCK_SKEW_MILLISECONDS) {
    fail("TIMESTAMP_LOCAL_BOUND_INVALID");
  }
}

function assertKeyContracts(document) {
  assertExactKeys(document, TOP_LEVEL_KEYS, "ROOT");
  assertExactKeys(document.marker, MARKER_KEYS, "MARKER");
  assertExactKeys(document.captures, ["admission", "before", "after"], "CAPTURES");
  assertExactKeys(document.captures.before, ["a", "b"], "CAPTURES_BEFORE");
  for (const [name, capture] of [
    ["ADMISSION", document.captures.admission],
    ["BEFORE_A", document.captures.before.a],
    ["BEFORE_B", document.captures.before.b],
    ["AFTER", document.captures.after],
  ]) {
    assertExactKeys(capture, CAPTURE_KEYS, `CAPTURE_${name}`);
    assertExactKeys(capture.identity, IDENTITY_KEYS, `IDENTITY_${name}`);
    assertExactKeys(capture.journal, JOURNAL_KEYS, `JOURNAL_${name}`);
    assertExactKeys(capture.control, CONTROL_KEYS, `CONTROL_${name}`);
    for (const container of capture.containers) {
      assertExactKeys(container, CONTAINER_KEYS, `CONTAINER_${name}_${container.service}`);
    }
    assertExactKeys(capture.surface, SURFACE_KEYS, `SURFACE_${name}`);
    assertExactKeys(capture.database, DATABASE_KEYS, `DATABASE_${name}`);
  }
  assertExactKeys(document.containment, CONTAINMENT_KEYS, "CONTAINMENT");
  assertExactKeys(document.mutations, MUTATION_KEYS, "MUTATIONS");
  assertExactKeys(document.redaction, REDACTION_KEYS, "REDACTION");
}

function containerByService(capture, service) {
  return capture.containers.find((container) => container.service === service);
}

function sourceIsExact(capture) {
  const identity = capture.identity;
  return (
    identity.activeRevision === EXPECTED_REVISION &&
    identity.currentRevision === EXPECTED_REVISION &&
    identity.sourceRevision === EXPECTED_REVISION &&
    identity.releaseEnvironmentRevision === EXPECTED_REVISION &&
    identity.manifestSha256 === EXPECTED_SOURCE_DIGESTS.manifestSha256 &&
    identity.composeSha256 === EXPECTED_SOURCE_DIGESTS.composeSha256 &&
    identity.commonSha256 === EXPECTED_SOURCE_DIGESTS.commonSha256 &&
    identity.helperSha256 === EXPECTED_SOURCE_DIGESTS.helperSha256
  );
}

function presentContainerIdentityIsExact(container) {
  return (
    container.presentCount === 1 &&
    container.containerId !== null &&
    container.imageId === EXPECTED_IMAGE_IDS[container.service] &&
    container.expectedImageId === EXPECTED_IMAGE_IDS[container.service] &&
    container.imageReferenceMatches === true
  );
}

function missingContainerIdentityIsCoherent(container) {
  return (
    container.presentCount === 0 &&
    container.containerId === null &&
    container.imageId === null &&
    container.expectedImageId === null &&
    container.imageReferenceMatches === false &&
    container.status === "MISSING" &&
    container.health === "MISSING" &&
    container.restartPolicy === null &&
    container.projectLabelMatches === false &&
    container.serviceLabelMatches === false &&
    container.revisionLabelMatches === false
  );
}

function coreIsHealthy(capture) {
  return ["postgres", "verifier", "web"].every((service) => {
    const container = containerByService(capture, service);
    return (
      container.presentCount === 1 &&
      presentContainerIdentityIsExact(container) &&
      container.status === "RUNNING" &&
      container.health === "HEALTHY" &&
      container.projectLabelMatches === true &&
      container.serviceLabelMatches === true &&
      container.revisionLabelMatches === true
    );
  });
}

function stoppedTargetIsSafe(capture, service) {
  const container = containerByService(capture, service);
  if (container.presentCount === 0) {
    return missingContainerIdentityIsCoherent(container);
  }
  return (
    presentContainerIdentityIsExact(container) &&
    new Set(["CREATED", "EXITED"]).has(container.status) &&
    container.restartPolicy === "no" &&
    container.projectLabelMatches === true &&
    container.serviceLabelMatches === true &&
    container.revisionLabelMatches === true
  );
}

function liveIsDisabled(capture) {
  const surface = capture.surface;
  return (
    surface.liveInterlocksAvailable === true &&
    surface.platformLiveDisabled === true &&
    surface.workerLiveDisabled === true &&
    surface.liveWebhookDisabled === true &&
    surface.webEffectiveLiveDisabled === true &&
    surface.workerEffectiveLiveDisabled === true
  );
}

function maintenanceIsStopped(capture) {
  const surface = capture.surface;
  return (
    surface.systemdInventoryAvailable === true &&
    surface.backupTimerActive === false &&
    surface.retentionTimerActive === false &&
    surface.backupServiceActive === false &&
    surface.retentionServiceActive === false &&
    surface.quiesceRecoveryActive === false
  );
}

function listenersAreClosed(capture) {
  const surface = capture.surface;
  return (
    surface.listenerInventoryAvailable === true &&
    surface.tcp80Listening === false &&
    surface.tcp443Listening === false &&
    surface.udp80Listening === false &&
    surface.udp443Listening === false
  );
}

function releaseFenceIsAbsent(capture) {
  const control = capture.control;
  return (
    control.activeReleaseUnitCount === 0 &&
    control.activeFenceUnitCount === 0 &&
    control.releaseRuntimeMarkerCount === 0 &&
    control.transitionPresent === false &&
    control.backupUploadJournalPresent === false &&
    control.managedTransitionPresent === false
  );
}

function databaseIsQuiescent(database) {
  return (
    database.snapshotAvailable === true &&
    database.systemIdentifier !== null &&
    database.activeWorkflows === 0 &&
    database.unreleasedPaymentGuards === 0 &&
    database.activeFinancialJobs === 0 &&
    database.liveTenants === 0 &&
    database.liveInstallations === 0 &&
    database.preparedTransactions === 0 &&
    database.refundRequests !== null &&
    database.auditEvents !== null
  );
}

function admissionIsExact(capture) {
  return (
    sourceIsExact(capture) &&
    liveIsDisabled(capture) &&
    databaseIsQuiescent(capture.database) &&
    capture.surface.systemdInventoryAvailable === true &&
    capture.surface.listenerInventoryAvailable === true &&
    capture.control.reservationValid === true &&
    capture.control.knownOneShotsPresentCount === 0 &&
    capture.control.knownOneShotsRunningCount === 0 &&
    capture.control.unexpectedRunningContainerCount === 0 &&
    releaseFenceIsAbsent(capture) &&
    ["postgres", "verifier", "worker", "web", "caddy"].every((service) => {
      const container = containerByService(capture, service);
      return (
        presentContainerIdentityIsExact(container) &&
        container.projectLabelMatches === true &&
        container.serviceLabelMatches === true &&
        container.revisionLabelMatches === true
      );
    })
  );
}

function captureIsContained(capture) {
  return (
    sourceIsExact(capture) &&
    liveIsDisabled(capture) &&
    databaseIsQuiescent(capture.database) &&
    coreIsHealthy(capture) &&
    stoppedTargetIsSafe(capture, "worker") &&
    stoppedTargetIsSafe(capture, "caddy") &&
    capture.control.reservationValid === true &&
    capture.control.knownOneShotsPresentCount === 0 &&
    capture.control.knownOneShotsRunningCount === 0 &&
    capture.control.unexpectedRunningContainerCount === 0 &&
    maintenanceIsStopped(capture) &&
    listenersAreClosed(capture) &&
    releaseFenceIsAbsent(capture)
  );
}

function coreIdentitySnapshot(capture) {
  return ["postgres", "verifier", "web"].map((service) => {
    const container = containerByService(capture, service);
    return {
      service,
      containerId: container.containerId,
      imageId: container.imageId,
      expectedImageId: container.expectedImageId,
      imageReferenceMatches: container.imageReferenceMatches,
    };
  });
}

function derivedContainment(document, originalJournalKnown) {
  const captures = [
    document.captures.before.a,
    document.captures.before.b,
    document.captures.after,
  ];
  const beforeA = document.captures.before.a;
  const beforeB = document.captures.before.b;
  const after = document.captures.after;
  const financialStable =
    captures.every((capture) => capture.database.snapshotAvailable === true) &&
    deepEqual(beforeA.database, beforeB.database) &&
    deepEqual(beforeB.database, after.database);
  const sourceExact =
    captures.every(sourceIsExact) &&
    deepEqual(beforeA.identity, beforeB.identity) &&
    deepEqual(beforeB.identity, after.identity);
  const coreStable =
    captures.every((capture) =>
      ["postgres", "verifier", "web"].every((service) =>
        presentContainerIdentityIsExact(containerByService(capture, service)),
      ),
    ) &&
    deepEqual(coreIdentitySnapshot(beforeA), coreIdentitySnapshot(beforeB)) &&
    deepEqual(coreIdentitySnapshot(beforeB), coreIdentitySnapshot(after));
  return Object.freeze({
    sourceExact,
    liveDisabled: captures.every(liveIsDisabled),
    financialStable,
    financialQuiescent: captures.every((capture) => databaseIsQuiescent(capture.database)),
    coreHealthy: captures.every(coreIsHealthy),
    coreContainerIdentitiesStable: coreStable,
    workerStopped: captures.every((capture) => stoppedTargetIsSafe(capture, "worker")),
    caddyStopped: captures.every((capture) => stoppedTargetIsSafe(capture, "caddy")),
    oneShotsStopped: captures.every(
      (capture) =>
        capture.control.knownOneShotsPresentCount === 0 &&
        capture.control.knownOneShotsRunningCount === 0 &&
        capture.control.unexpectedRunningContainerCount === 0,
    ),
    maintenanceStopped: captures.every(maintenanceIsStopped),
    publicListenersClosed: captures.every(listenersAreClosed),
    releaseFenceAbsent: captures.every(releaseFenceIsAbsent),
    reservationValid: captures.every((capture) => capture.control.reservationValid === true),
    journalCleared:
      originalJournalKnown &&
      after.journal.present === false &&
      after.journal.operation === null &&
      after.journal.revision === null &&
      after.journal.status === null &&
      after.journal.sha256 === null,
    markerComplete: document.marker.state === "complete",
  });
}

function journalIsAbsent(journal) {
  return (
    journal.present === false &&
    journal.operation === null &&
    journal.revision === null &&
    journal.status === null &&
    journal.sha256 === null
  );
}

function markerBindingIsExact(marker, operation, expectedRunnerSha256, journalSha256) {
  return (
    operation !== null &&
    journalSha256 !== null &&
    marker.revision === EXPECTED_REVISION &&
    marker.operation === operation &&
    marker.runnerSha256 === expectedRunnerSha256 &&
    marker.journalSha256 === journalSha256
  );
}

function isExactPreEffectContainedStateDrift(document, currentContainedStateDigests) {
  const marker = document.marker;
  const captures = [
    document.captures.admission,
    document.captures.before.a,
    document.captures.before.b,
    document.captures.after,
  ];
  const journals = [...captures.map((capture) => capture.journal)];
  const journal = journals[0];
  return (
    document.result === "FAIL" &&
    document.exitCode === 20 &&
    document.code === "CAPTURE_CHANGED" &&
    deepEqual(document.diagnostics, ["CAPTURE_CHANGED"]) &&
    marker.state === "contained_verified" &&
    marker.resumedFromState === "contained_verified" &&
    marker.journalPresentAtInvocationStart === true &&
    journal.present === true &&
    journal.operation === document.operation &&
    journal.revision === EXPECTED_REVISION &&
    journal.status === "in_progress" &&
    journal.sha256 === marker.journalSha256 &&
    journals.every((candidate) => deepEqual(candidate, journal)) &&
    captures.every(captureIsContained) &&
    document.mutations.unitsStopRequested === 0 &&
    document.mutations.containersRestartFenced === 0 &&
    document.mutations.containersStopped === 0 &&
    document.mutations.reservationReconciled === 0 &&
    document.mutations.journalCleared === 0 &&
    document.mutations.markerTransitions === 2 &&
    currentContainedStateDigests.every((digest) => digest === currentContainedStateDigests[0]) &&
    currentContainedStateDigests[0] !== marker.containedStateSha256
  );
}

function assertJournalAndMarkerSemantics(document, expectedRunnerSha256) {
  const admissionJournal = document.captures.admission.journal;
  const journalA = document.captures.before.a.journal;
  const journalB = document.captures.before.b.journal;
  const afterJournal = document.captures.after.journal;
  const marker = document.marker;
  let containedStateDriftObserved = false;
  const establishedStates = new Set([
    "prepared",
    "contained_verified",
    "quiesce_cleared",
    "complete",
  ]);
  const postClearResumeStates = new Set(["contained_verified", "quiesce_cleared", "complete"]);
  const stateRanks = new Map([
    ["absent", 0],
    ["prepared", 1],
    ["contained_verified", 2],
    ["quiesce_cleared", 3],
    ["complete", 4],
  ]);

  if (!deepEqual(admissionJournal, journalA) || !deepEqual(journalA, journalB)) {
    fail("JOURNAL_BEFORE_CHANGED");
  }

  const beforeJournalPresent = journalA.present === true;
  if (beforeJournalPresent) {
    if (
      document.operation === null ||
      journalA.operation !== document.operation ||
      journalA.revision !== EXPECTED_REVISION ||
      journalA.status !== "in_progress" ||
      journalA.sha256 === null ||
      marker.journalPresentAtInvocationStart !== true
    ) {
      fail("JOURNAL_BEFORE_INVALID");
    }
  } else if (!journalIsAbsent(journalA)) {
    fail("JOURNAL_BEFORE_INVALID");
  }

  const validPostClearResume =
    !beforeJournalPresent &&
    marker.journalPresentAtInvocationStart === false &&
    postClearResumeStates.has(marker.resumedFromState) &&
    markerBindingIsExact(marker, document.operation, expectedRunnerSha256, marker.journalSha256);
  const originalJournalKnown = beforeJournalPresent || validPostClearResume;

  if (!beforeJournalPresent && marker.journalPresentAtInvocationStart === true) {
    fail("JOURNAL_START_PRESENCE_INVALID");
  }
  if (
    beforeJournalPresent &&
    !new Set(["absent", "prepared", "contained_verified"]).has(marker.resumedFromState)
  ) {
    fail("JOURNAL_RESUME_STATE_INVALID");
  }
  if (
    marker.journalPresentAtInvocationStart === false &&
    !postClearResumeStates.has(marker.resumedFromState)
  ) {
    fail("JOURNAL_RESUME_STATE_INVALID");
  }
  if (
    marker.journalPresentAtInvocationStart === null &&
    (document.result === "PASS" || establishedStates.has(marker.state))
  ) {
    fail("JOURNAL_START_PRESENCE_INVALID");
  }

  if (establishedStates.has(marker.state)) {
    if (!stateRanks.has(marker.resumedFromState)) {
      fail("MARKER_RESUME_STATE_INVALID");
    }
    const journalSha256 = beforeJournalPresent ? journalA.sha256 : marker.journalSha256;
    if (!markerBindingIsExact(marker, document.operation, expectedRunnerSha256, journalSha256)) {
      fail("MARKER_BINDING_INVALID");
    }
  } else if (marker.state === "absent") {
    if (
      marker.revision !== null ||
      marker.operation !== null ||
      marker.runnerSha256 !== null ||
      marker.journalSha256 !== null ||
      marker.admissionInvariantSha256 !== null ||
      marker.containedStateSha256 !== null
    ) {
      fail("MARKER_ABSENT_BINDING_INVALID");
    }
  }

  if (marker.resumedFromState !== null && marker.resumedFromState !== "invalid") {
    if (!stateRanks.has(marker.resumedFromState) || !stateRanks.has(marker.state)) {
      fail("MARKER_RESUME_STATE_INVALID");
    }
    if (stateRanks.get(marker.resumedFromState) > stateRanks.get(marker.state)) {
      fail("MARKER_STATE_REGRESSION");
    }
  }

  const admissionCaptureValues = [
    document.captures.admission,
    document.captures.before.a,
    document.captures.before.b,
    document.captures.after,
  ];
  if (establishedStates.has(marker.state)) {
    if (!admissionIsExact(document.captures.admission)) {
      fail("ADMISSION_CAPTURE_INVALID");
    }
    const expectedAdmissionInvariantSha256 = admissionInvariantSha256(admissionCaptureValues[0]);
    if (
      marker.admissionInvariantSha256 !== expectedAdmissionInvariantSha256 ||
      admissionCaptureValues.some(
        (capture) => admissionInvariantSha256(capture) !== expectedAdmissionInvariantSha256,
      )
    ) {
      fail("ADMISSION_INVARIANT_DIGEST_INVALID");
    }
  } else if (marker.admissionInvariantSha256 !== null) {
    fail("ADMISSION_INVARIANT_DIGEST_INVALID");
  }

  const containedStates = new Set(["contained_verified", "quiesce_cleared", "complete"]);
  const containedCaptureValues = [
    document.captures.before.a,
    document.captures.before.b,
    document.captures.after,
  ];
  if (establishedStates.has(marker.state)) {
    if (containedStates.has(marker.state)) {
      const expectedContainedStateSha256 = containedStateSha256(containedCaptureValues[0]);
      const currentContainedStateDigests = containedCaptureValues.map(containedStateSha256);
      const containedStateDigestMatches =
        marker.containedStateSha256 === expectedContainedStateSha256 &&
        currentContainedStateDigests.every((digest) => digest === expectedContainedStateSha256);
      if (!containedStateDigestMatches) {
        if (!isExactPreEffectContainedStateDrift(document, currentContainedStateDigests)) {
          fail("CONTAINED_STATE_DIGEST_INVALID");
        }
        containedStateDriftObserved = true;
      }
    } else if (marker.containedStateSha256 !== null) {
      fail("CONTAINED_STATE_DIGEST_INVALID");
    }
  } else if (marker.containedStateSha256 !== null) {
    fail("CONTAINED_STATE_DIGEST_INVALID");
  }

  const afterJournalAbsent = journalIsAbsent(afterJournal);
  if (!afterJournalAbsent && (!beforeJournalPresent || !deepEqual(afterJournal, journalA))) {
    fail("JOURNAL_AFTER_INVALID");
  }
  if (new Set(["quiesce_cleared", "complete"]).has(marker.state) && !afterJournalAbsent) {
    fail("MARKER_POST_CLEAR_STATE_INVALID");
  }
  if (
    new Set(["absent", "prepared", "invalid"]).has(marker.state) &&
    originalJournalKnown &&
    afterJournalAbsent
  ) {
    fail("MARKER_PRE_CLEAR_STATE_INVALID");
  }
  const expectedJournalCleared = originalJournalKnown && afterJournalAbsent ? 1 : 0;
  if (document.mutations.journalCleared !== expectedJournalCleared) {
    fail("JOURNAL_CLEAR_COUNT_INVALID");
  }

  if (document.result === "PASS") {
    if (
      document.operation === null ||
      marker.state !== "complete" ||
      !originalJournalKnown ||
      !afterJournalAbsent ||
      !markerBindingIsExact(
        marker,
        document.operation,
        expectedRunnerSha256,
        beforeJournalPresent ? journalA.sha256 : marker.journalSha256,
      )
    ) {
      fail("RESULT_PASS_MARKER_INVALID");
    }
  } else if (
    document.operation === null &&
    (establishedStates.has(marker.state) || establishedStates.has(marker.resumedFromState))
  ) {
    fail("OPERATION_REQUIRED_FOR_MARKER");
  } else if (
    document.operation !== null &&
    !beforeJournalPresent &&
    !establishedStates.has(marker.state) &&
    !establishedStates.has(marker.resumedFromState)
  ) {
    fail("OPERATION_WITHOUT_DURABLE_SOURCE");
  }

  return Object.freeze({ originalJournalKnown, containedStateDriftObserved });
}

function assertMutationSemantics(document) {
  const mutations = document.mutations;
  const markerTransitionCounts = new Map([
    ["absent", 0],
    ["prepared", 1],
    ["contained_verified", 2],
    ["quiesce_cleared", 3],
    ["complete", 4],
  ]);
  if (mutations.containersStopped > mutations.containersRestartFenced) {
    fail("MUTATION_COUNT_INCONSISTENT");
  }
  if (
    markerTransitionCounts.has(document.marker.state) &&
    mutations.markerTransitions !== markerTransitionCounts.get(document.marker.state)
  ) {
    fail("MARKER_TRANSITION_COUNT_INVALID");
  }
  if (document.marker.state === "invalid" && mutations.markerTransitions !== 0) {
    fail("MARKER_TRANSITION_COUNT_INVALID");
  }
  const expectedReservationReconciled = 0;
  if (mutations.reservationReconciled !== expectedReservationReconciled) {
    fail("RESERVATION_RECONCILIATION_COUNT_INVALID");
  }
  if (document.result === "PASS") {
    if (
      mutations.unitsStopRequested !== 5 ||
      mutations.reservationReconciled !== expectedReservationReconciled ||
      mutations.journalCleared !== 1 ||
      mutations.markerTransitions !== 4
    ) {
      fail("RESULT_PASS_MUTATION_INVALID");
    }
  }
}

function assertResultSemantics(document, containedStateDriftObserved) {
  const sortedDiagnostics = [...document.diagnostics].sort();
  if (!deepEqual(document.diagnostics, sortedDiagnostics)) {
    fail("RESULT_DIAGNOSTIC_ORDER_INVALID");
  }
  if (document.result === "PASS") {
    if (
      document.exitCode !== 0 ||
      document.code !== PASS_CODE ||
      document.diagnostics.length !== 0 ||
      Object.values(document.containment).some((value) => value !== true)
    ) {
      fail("RESULT_PASS_INCONSISTENT");
    }
  } else if (document.result === "FAIL") {
    if (
      document.exitCode !== 20 ||
      document.code === PASS_CODE ||
      document.diagnostics.length === 0 ||
      document.code !== document.diagnostics[0] ||
      document.diagnostics.every((code) => INCOMPLETE_CODES.has(code)) ||
      Object.values(document.containment).every((value) => value === true)
    ) {
      fail("RESULT_FAIL_INCONSISTENT");
    }
    if (document.code === "CAPTURE_CHANGED" && !containedStateDriftObserved) {
      fail("RESULT_CAPTURE_CHANGED_UNPROVEN");
    }
  } else if (document.result === "INCOMPLETE") {
    if (
      document.exitCode !== 21 ||
      document.code === PASS_CODE ||
      document.diagnostics.length === 0 ||
      document.code !== document.diagnostics[0] ||
      document.diagnostics.some((code) => !INCOMPLETE_CODES.has(code)) ||
      Object.values(document.containment).every((value) => value === true)
    ) {
      fail("RESULT_INCOMPLETE_INCONSISTENT");
    }
  } else {
    fail("RESULT_UNKNOWN");
  }
}

export function validateContainmentReconciliationDocument(
  bytes,
  { schema, expectedNonce, expectedRunnerSha256, processExitCode, notBefore, notAfter },
) {
  if (!/^[0-9a-f]{64}$/u.test(expectedNonce)) {
    fail("EXPECTED_NONCE_INVALID");
  }
  if (!/^[0-9a-f]{64}$/u.test(expectedRunnerSha256)) {
    fail("EXPECTED_RUNNER_SHA256_INVALID");
  }
  if (!new Set([0, 20, 21]).has(processExitCode)) {
    fail("PROCESS_EXIT_CODE_INVALID");
  }
  const document = parseCanonicalContainmentDocument(bytes);
  assertNoForbiddenMaterial(document);
  validateSchemaNode(document, schema, schema);
  assertKeyContracts(document);
  if (document.nonce !== expectedNonce) {
    fail("NONCE_MISMATCH");
  }
  if (document.exitCode !== processExitCode) {
    fail("EXIT_CODE_MISMATCH");
  }
  assertTimestampSemantics(document, notBefore, notAfter);
  const journalSemantics = assertJournalAndMarkerSemantics(document, expectedRunnerSha256);
  const derived = derivedContainment(document, journalSemantics.originalJournalKnown);
  if (!deepEqual(document.containment, derived)) {
    fail("SUMMARY_CONTAINMENT_MISMATCH");
  }
  assertMutationSemantics(document);
  assertResultSemantics(document, journalSemantics.containedStateDriftObserved);
  return Object.freeze({
    schemaVersion: 1,
    kind: "refunddesk.lightsail.containment-reconciliation.validation",
    result: document.result,
    code: document.code,
    operation: document.operation,
    remote: document,
    redaction: Object.freeze(Object.fromEntries(REDACTION_KEYS.map((key) => [key, false]))),
  });
}

function parseArguments(argv) {
  const allowed = new Set([
    "--expected-nonce",
    "--expected-runner-sha256",
    "--process-exit-code",
    "--not-before",
    "--not-after",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.has(name) || values.has(name)) {
      fail("ARGUMENT_INVALID");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("ARGUMENT_VALUE_MISSING");
    }
    values.set(name, value);
    index += 1;
  }
  for (const required of allowed) {
    if (!values.has(required)) {
      fail("ARGUMENT_REQUIRED_MISSING");
    }
  }
  return values;
}

async function readBoundedStdin(maxBytes = MAX_DOCUMENT_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > maxBytes) {
      fail("DOCUMENT_SIZE_INVALID");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function loadSchema() {
  const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let bytes;
  try {
    bytes = readFileSync(resolve(repository, SCHEMA_PATH));
    if (bytes.includes(0x00)) {
      fail("SCHEMA_SOURCE_INVALID");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ContainmentReconciliationValidationError) {
      throw error;
    }
    fail("SCHEMA_SOURCE_INVALID");
  }
}

export async function runCli({ argv = process.argv.slice(2) } = {}) {
  try {
    const args = parseArguments(argv);
    const processExitCodeText = args.get("--process-exit-code");
    if (!/^(?:0|20|21)$/u.test(processExitCodeText)) {
      fail("PROCESS_EXIT_CODE_INVALID");
    }
    const input = await readBoundedStdin();
    const validation = validateContainmentReconciliationDocument(input, {
      schema: loadSchema(),
      expectedNonce: args.get("--expected-nonce"),
      expectedRunnerSha256: args.get("--expected-runner-sha256"),
      processExitCode: Number(processExitCodeText),
      notBefore: args.get("--not-before"),
      notAfter: args.get("--not-after"),
    });
    process.stdout.write(`${JSON.stringify(sortJsonKeys(validation))}\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof ContainmentReconciliationValidationError
        ? error.code
        : "VALIDATION_INTERNAL_ERROR";
    process.stderr.write(`containment-reconciliation-validation-error:${code}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli();
}

export const containmentReconciliationContract = Object.freeze({
  expectedRevision: EXPECTED_REVISION,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxDurationMilliseconds: MAX_DURATION_MILLISECONDS,
  passCode: PASS_CODE,
  schemaPath: SCHEMA_PATH,
  validatorPath: VALIDATOR_PATH,
  modulePath: fileURLToPath(import.meta.url),
});
