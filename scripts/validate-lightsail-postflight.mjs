import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_GIT_BYTES = 1024 * 1024;
const OBSERVER_PATH = "deploy/lightsail/scripts/observe-host-postflight.sh";
const SCHEMA_PATH = "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json";
const VALIDATOR_PATH = "scripts/validate-lightsail-postflight.mjs";
const WRAPPER_PATH = "scripts/invoke-lightsail-postflight.ps1";
const EXPECTED_COMPOSE_IMAGES = Object.freeze({
  postgres:
    "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296",
  verifier:
    "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
  caddy:
    "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
});
const RESULT_PRIORITY = Object.freeze({ PASS: 0, INCOMPLETE: 1, FAIL: 2 });
const INCOMPLETE_CODES = new Set([
  "TOOL_UNAVAILABLE",
  "OPERATOR_LOCK_UNAVAILABLE",
  "ACTIVE_REVISION_UNREADABLE",
  "CURRENT_SOURCE_UNREADABLE",
  "SOURCE_MARKER_UNREADABLE",
  "RELEASE_ENV_UNREADABLE",
  "COMPOSE_SOURCE_UNREADABLE",
  "MANIFEST_UNREADABLE",
  "CONTAINER_INVENTORY_UNREADABLE",
  "EXPECTED_IMAGE_UNREADABLE",
  "SYSTEMD_INVENTORY_UNREADABLE",
  "LISTENER_INVENTORY_UNREADABLE",
  "LIVE_INTERLOCK_UNREADABLE",
  "DATABASE_SNAPSHOT_UNREADABLE",
]);
const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/u,
  /\bwhsec_[A-Za-z0-9]{12,}\b/u,
  /\babsec_[A-Za-z0-9_]{12,}\b/u,
  /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
]);

export class PostflightValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostflightValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostflightValidationError(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
        if (!(error instanceof PostflightValidationError)) {
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
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      !schema.enum.some((candidate) => deepEqual(value, candidate))
    ) {
      fail(`SCHEMA_${location}_ENUM_INVALID`);
    }
  }
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    fail(`SCHEMA_${location}_TYPE_INVALID`);
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
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
      if (!Array.isArray(schema.prefixItems)) {
        fail("SCHEMA_PREFIX_ITEMS_INVALID");
      }
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
    } else if (schema.items === false && value.length > 0) {
      fail(`SCHEMA_${location}_ITEMS_FORBIDDEN`);
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) {
        fail("SCHEMA_REQUIRED_INVALID");
      }
      for (const required of schema.required) {
        if (!Object.hasOwn(value, required)) {
          fail(`SCHEMA_${location}_REQUIRED_MISSING`);
        }
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

export function parseCanonicalJsonDocument(bytes, { maxBytes = MAX_DOCUMENT_BYTES } = {}) {
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
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail("DOCUMENT_JSON_INVALID");
  }
  if (JSON.stringify(parsed) !== body) {
    fail("DOCUMENT_CANONICAL_JSON_REQUIRED");
  }
  return parsed;
}

function assertNoSecretCanary(value) {
  const serialized = JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      fail("DOCUMENT_SECRET_CANARY_PRESENT");
    }
  }
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

function withoutCapturedAt(capture) {
  const stable = { ...capture };
  delete stable.capturedAt;
  return stable;
}

function deriveSummaries(document) {
  const captureA = document.captures.a;
  const captureB = document.captures.b;
  const byService = new Map(captureB.containers.map((container) => [container.service, container]));
  const stopped = (service) => new Set(["CREATED", "EXITED"]).has(byService.get(service).status);
  const healthy = (service) => {
    const container = byService.get(service);
    return container.status === "RUNNING" && container.health === "HEALTHY";
  };
  const identity = captureB.identity;
  const metadataComplete =
    identity.activeRevision !== null &&
    identity.currentRevision !== null &&
    identity.sourceRevision !== null &&
    identity.releaseEnvironmentRevision !== null &&
    identity.releaseEnvironmentWorkerRuntimeMode !== null &&
    identity.manifestRevision !== null &&
    identity.composeSha256 !== null &&
    identity.installedManifestSha256 !== null &&
    identity.manifestSchemaValid === true;
  const metadataCoherent =
    metadataComplete &&
    [
      identity.currentRevision,
      identity.sourceRevision,
      identity.releaseEnvironmentRevision,
      identity.manifestRevision,
    ].every((revision) => revision === identity.activeRevision);
  const containersCoherent =
    captureB.control.dockerInventoryAvailable === true &&
    captureB.containers.every(
      (container) =>
        container.presentCount === 1 &&
        container.containerId !== null &&
        container.imageId !== null &&
        container.projectLabelMatches === true &&
        container.serviceLabelMatches === true,
    ) &&
    captureB.containers
      .filter((container) => container.service !== "postgres")
      .every((container) => container.revisionLabel === identity.activeRevision) &&
    captureB.control.expectedImagesAvailable === true &&
    captureB.containers.every(
      (container) =>
        container.expectedImageId !== null &&
        container.imageId === container.expectedImageId &&
        container.imageReferenceMatches === true,
    ) &&
    captureB.containers
      .filter((container) => container.service !== "caddy")
      .every((container) => container.noPublishedPorts === true) &&
    byService.get("worker").effectiveWorkerRuntimeMode ===
      identity.releaseEnvironmentWorkerRuntimeMode;
  const surface = captureB.surface;
  const control = captureB.control;
  const database = captureB.database;
  const liveDisabled =
    surface.liveInterlocksAvailable === true &&
    surface.runtimeLiveInterlocksAvailable === true &&
    surface.platformLiveDisabled === true &&
    surface.workerLiveDisabled === true &&
    surface.liveWebhookDisabled === true &&
    byService.get("web").effectiveGlobalLiveDisabled === true &&
    byService.get("worker").effectiveGlobalLiveDisabled === true &&
    byService.get("web").effectiveLiveWebhookDisabled === true;
  const maintenanceStopped =
    surface.systemdInventoryAvailable === true &&
    surface.backupTimerActive === false &&
    surface.retentionTimerActive === false &&
    surface.backupServiceActive === false &&
    surface.retentionServiceActive === false &&
    surface.quiesceRecoveryActive === false;
  const publicListenersClosed =
    surface.listenerInventoryAvailable === true &&
    surface.tcp80Listening === false &&
    surface.tcp443Listening === false &&
    surface.udp80Listening === false &&
    surface.udp443Listening === false;
  const journalsClosed =
    control.transitionJournalPresent === false &&
    control.runtimeQuiesceJournalPresent === false &&
    control.backupJournalPresent === false &&
    control.legacyAppIdJournalPresent === false &&
    control.managedTransitionInFlightPresent === false;
  const fenceClosed =
    surface.systemdInventoryAvailable === true &&
    control.activeReleaseUnitCount === 0 &&
    control.activeFenceUnitCount === 0 &&
    control.releaseRuntimeMarkerCount === 0;
  const financialQuiescent =
    database.snapshotAvailable === true &&
    database.activeWorkflows === 0 &&
    database.unreleasedPaymentGuards === 0 &&
    database.activeFinancialJobs === 0 &&
    database.liveTenants === 0 &&
    database.liveInstallations === 0 &&
    database.preparedTransactions === 0;

  return Object.freeze({
    containment: Object.freeze({
      liveDisabled,
      workerStopped: stopped("worker"),
      caddyStopped: stopped("caddy"),
      maintenanceStopped,
      publicListenersClosed,
      journalsClosed,
      fenceClosed,
      sensitiveModesSafe: control.sensitiveModesSafe,
    }),
    availability: Object.freeze({
      capturesStable: deepEqual(withoutCapturedAt(captureA), withoutCapturedAt(captureB)),
      metadataCoherent,
      containersCoherent,
      coreHealthy: healthy("postgres") && healthy("verifier") && healthy("web"),
      recoverableRuntimeStopped: healthy("postgres") && stopped("verifier") && stopped("web"),
    }),
    financial: Object.freeze({
      snapshotAvailable: database.snapshotAvailable,
      stable: deepEqual(captureA.database, captureB.database),
      quiescent: financialQuiescent,
    }),
  });
}

function assertDerivedSummaries(document) {
  const derived = deriveSummaries(document);
  if (!deepEqual(document.containment, derived.containment)) {
    fail("SUMMARY_CONTAINMENT_MISMATCH");
  }
  if (!deepEqual(document.availability, derived.availability)) {
    fail("SUMMARY_AVAILABILITY_MISMATCH");
  }
  if (!deepEqual(document.financial, derived.financial)) {
    fail("SUMMARY_FINANCIAL_MISMATCH");
  }
  if (document.result === "PASS") {
    const capture = document.captures.b;
    if (
      capture.control.operatorLockShared !== true ||
      capture.control.transitionCommitMarkerValid !== true ||
      capture.control.managedTransitionCompletion === "INVALID" ||
      capture.surface.unexpectedRunningContainerCount !== 0
    ) {
      fail("RESULT_PASS_CAPTURE_INVALID");
    }
  }
}

function assertResultSemantics(document) {
  const passCodes = new Set(["PASS_CONTAINED", "PASS_RECOVERABLE_RUNTIME_STOPPED"]);
  if (!deepEqual(document.diagnostics, [...document.diagnostics].sort())) {
    fail("RESULT_DIAGNOSTIC_ORDER_INVALID");
  }
  if (document.result === "PASS") {
    if (
      document.exitCode !== 0 ||
      !passCodes.has(document.code) ||
      document.diagnostics.length !== 0
    ) {
      fail("RESULT_PASS_INCONSISTENT");
    }
    if (!new Set(["COHERENT_CONTAINED", "RECOVERABLE_RUNTIME_STOPPED"]).has(document.posture)) {
      fail("RESULT_PASS_POSTURE_INVALID");
    }
    if (Object.values(document.containment).some((value) => value !== true)) {
      fail("RESULT_PASS_CONTAINMENT_INVALID");
    }
    if (
      document.availability.capturesStable !== true ||
      document.availability.metadataCoherent !== true ||
      document.availability.containersCoherent !== true
    ) {
      fail("RESULT_PASS_AVAILABILITY_INVALID");
    }
    if (Object.values(document.financial).some((value) => value !== true)) {
      fail("RESULT_PASS_FINANCIAL_INVALID");
    }
    const contained =
      document.posture === "COHERENT_CONTAINED" &&
      document.code === "PASS_CONTAINED" &&
      document.availability.coreHealthy === true &&
      document.availability.recoverableRuntimeStopped === false;
    const recoverable =
      document.posture === "RECOVERABLE_RUNTIME_STOPPED" &&
      document.code === "PASS_RECOVERABLE_RUNTIME_STOPPED" &&
      document.availability.coreHealthy === false &&
      document.availability.recoverableRuntimeStopped === true;
    if (!contained && !recoverable) {
      fail("RESULT_PASS_HEALTH_INVALID");
    }
  } else if (document.result === "FAIL") {
    if (
      document.exitCode !== 20 ||
      passCodes.has(document.code) ||
      document.diagnostics.length === 0
    ) {
      fail("RESULT_FAIL_INCONSISTENT");
    }
    if (document.posture !== "DIVERGENT" && document.posture !== "COHERENT_RUNNING") {
      fail("RESULT_FAIL_POSTURE_INVALID");
    }
    if (document.code !== document.diagnostics[0]) {
      fail("RESULT_FAIL_CODE_NOT_DIAGNOSTIC");
    }
    if (document.diagnostics.every((code) => INCOMPLETE_CODES.has(code))) {
      fail("RESULT_FAIL_PRIORITY_INVALID");
    }
  } else if (document.result === "INCOMPLETE") {
    if (
      document.exitCode !== 21 ||
      passCodes.has(document.code) ||
      document.diagnostics.length === 0 ||
      document.posture !== "UNKNOWN"
    ) {
      fail("RESULT_INCOMPLETE_INCONSISTENT");
    }
    if (document.code !== document.diagnostics[0]) {
      fail("RESULT_INCOMPLETE_CODE_NOT_DIAGNOSTIC");
    }
    if (document.diagnostics.some((code) => !INCOMPLETE_CODES.has(code))) {
      fail("RESULT_INCOMPLETE_PRIORITY_INVALID");
    }
  } else {
    fail("RESULT_UNKNOWN");
  }

  if (document.availability.capturesStable === true) {
    if (
      !deepEqual(withoutCapturedAt(document.captures.a), withoutCapturedAt(document.captures.b))
    ) {
      fail("CAPTURE_STABILITY_MISMATCH");
    }
  } else if (
    document.result !== "INCOMPLETE" &&
    !document.diagnostics.includes("CAPTURE_CHANGED")
  ) {
    fail("CAPTURE_CHANGE_DIAGNOSTIC_REQUIRED");
  }
}

function assertTimestampSemantics(document, notBefore, notAfter) {
  const before = Date.parse(notBefore);
  const after = Date.parse(notAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before > after) {
    fail("LOCAL_TIME_BOUND_INVALID");
  }
  const started = parseUtcTimestamp(document.startedAt, "STARTED");
  const captureA = parseUtcTimestamp(document.captures.a.capturedAt, "CAPTURE_A");
  const captureB = parseUtcTimestamp(document.captures.b.capturedAt, "CAPTURE_B");
  const completed = parseUtcTimestamp(document.completedAt, "COMPLETED");
  if (!(started <= captureA && captureA <= captureB && captureB <= completed)) {
    fail("TIMESTAMP_ORDER_INVALID");
  }
  if (completed - started > 180_000) {
    fail("TIMESTAMP_DURATION_INVALID");
  }
  const clockSkewMilliseconds = 120_000;
  if (started < before - clockSkewMilliseconds || completed > after + clockSkewMilliseconds) {
    fail("TIMESTAMP_LOCAL_BOUND_INVALID");
  }
}

function normalizeRepositoryPath(repository, path) {
  const absolute = resolve(repository, path);
  const relativePath = relative(resolve(repository), absolute);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes("\0")
  ) {
    fail("PROVENANCE_PATH_INVALID");
  }
  return { absolute, gitPath: relativePath.split(sep).join("/") };
}

function gitBytes(gitExecutable, repository, args, maxBuffer = MAX_GIT_BYTES) {
  try {
    return execFileSync(gitExecutable, ["--no-replace-objects", "-C", repository, ...args], {
      encoding: null,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    fail("PROVENANCE_GIT_COMMAND_FAILED");
  }
}

function readRepositoryHead(gitExecutable, repository) {
  const output = gitBytes(
    gitExecutable,
    repository,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    1024,
  )
    .toString("utf8")
    .trimEnd();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(output)) {
    fail("PROVENANCE_HEAD_INVALID");
  }
  return output;
}

function readTreeBlob({ gitExecutable, repository, revision, gitPath, failureCode }) {
  const treeLine = gitBytes(gitExecutable, repository, ["ls-tree", revision, "--", gitPath])
    .toString("utf8")
    .trimEnd();
  const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(treeLine);
  if (!match || match[3] !== gitPath) {
    fail(failureCode);
  }
  return Object.freeze({
    object: match[2],
    bytes: gitBytes(gitExecutable, repository, ["cat-file", "blob", match[2]]),
  });
}

function readIndexedSource({ gitExecutable, repository, repositoryHead, path, fixtureOnly }) {
  const { absolute, gitPath } = normalizeRepositoryPath(repository, path);
  const worktreeBytes = readFileSync(absolute);
  if (fixtureOnly) {
    return Object.freeze({ gitObject: null, sha256: sha256(worktreeBytes) });
  }
  const index = gitBytes(gitExecutable, repository, [
    "ls-files",
    "--stage",
    "--",
    gitPath,
  ]).toString("utf8");
  const lines = index.trimEnd().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    fail("PROVENANCE_INDEX_ENTRY_INVALID");
  }
  const match = /^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t(.+)$/u.exec(lines[0]);
  if (!match || match[3] !== gitPath) {
    fail("PROVENANCE_INDEX_ENTRY_INVALID");
  }
  const indexedBytes = gitBytes(gitExecutable, repository, ["cat-file", "blob", match[2]]);
  if (!indexedBytes.equals(worktreeBytes)) {
    fail("PROVENANCE_WORKTREE_DIFFERS_FROM_INDEX");
  }
  const headBlob = readTreeBlob({
    gitExecutable,
    repository,
    revision: repositoryHead,
    gitPath,
    failureCode: "PROVENANCE_HEAD_ENTRY_INVALID",
  });
  if (headBlob.object !== match[2] || !headBlob.bytes.equals(indexedBytes)) {
    fail("PROVENANCE_HEAD_DIFFERS_FROM_INDEX");
  }
  return Object.freeze({ gitObject: headBlob.object, sha256: sha256(headBlob.bytes) });
}

function assertPinnedComposeImages(composeBytes) {
  if (
    composeBytes.includes(0x00) ||
    composeBytes.includes(0x0d) ||
    (composeBytes.length >= 3 &&
      composeBytes[0] === 0xef &&
      composeBytes[1] === 0xbb &&
      composeBytes[2] === 0xbf)
  ) {
    fail("PROVENANCE_REVISION_COMPOSE_FORMAT_INVALID");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(composeBytes);
  } catch {
    fail("PROVENANCE_REVISION_COMPOSE_FORMAT_INVALID");
  }
  const observed = new Map(
    Object.keys(EXPECTED_COMPOSE_IMAGES).map((service) => [
      service,
      { declarations: 0, images: [] },
    ]),
  );
  let servicesSections = 0;
  let inServices = false;
  let currentService = null;
  for (const line of text.split("\n")) {
    if (line === "services:") {
      servicesSections += 1;
      inServices = true;
      currentService = null;
      continue;
    }
    if (inServices && /^[^ #]/u.test(line)) {
      inServices = false;
      currentService = null;
    }
    if (!inServices) {
      continue;
    }
    const serviceMatch = /^ {2}([a-z][a-z0-9-]*):$/u.exec(line);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      if (observed.has(currentService)) {
        observed.get(currentService).declarations += 1;
      }
      continue;
    }
    const imageMatch = /^ {4}image: (\S+)$/u.exec(line);
    if (imageMatch && observed.has(currentService)) {
      observed.get(currentService).images.push(imageMatch[1]);
    }
  }
  if (servicesSections !== 1) {
    fail("PROVENANCE_REVISION_COMPOSE_IMAGE_INVALID");
  }
  for (const [service, expectedImage] of Object.entries(EXPECTED_COMPOSE_IMAGES)) {
    const value = observed.get(service);
    if (
      value.declarations !== 1 ||
      value.images.length !== 1 ||
      value.images[0] !== expectedImage
    ) {
      fail("PROVENANCE_REVISION_COMPOSE_IMAGE_INVALID");
    }
  }
  const workerModeDeclaration =
    "      REFUNDDESK_WORKER_RUNTIME_MODE: ${REFUNDDESK_WORKER_RUNTIME_MODE:-normal}";
  const workerModeOccurrences = text
    .split("\n")
    .filter((line) => line.includes("REFUNDDESK_WORKER_RUNTIME_MODE"));
  if (workerModeOccurrences.length === 0) {
    return "LEGACY_NORMAL";
  }
  if (workerModeOccurrences.length !== 1 || workerModeOccurrences[0] !== workerModeDeclaration) {
    fail("PROVENANCE_REVISION_COMPOSE_WORKER_MODE_INVALID");
  }
  return "EXPLICIT";
}

function assertRevisionComposeDigest({ document, gitExecutable, repository }) {
  const observations = [document.captures.a.identity, document.captures.b.identity];
  const revisionFields = [
    "activeRevision",
    "currentRevision",
    "sourceRevision",
    "releaseEnvironmentRevision",
    "manifestRevision",
  ];
  const revisions = new Set(
    observations.flatMap((identity) =>
      revisionFields.map((field) => identity[field]).filter((value) => value !== null),
    ),
  );
  for (const revision of revisions) {
    gitBytes(gitExecutable, repository, ["cat-file", "-e", `${revision}^{commit}`], 1024);
  }
  let complete = true;
  for (const identity of observations) {
    if (identity.activeRevision === null || identity.composeSha256 === null) {
      complete = false;
      continue;
    }
    const gitPath = "deploy/lightsail/compose.yml";
    const composeBlob = readTreeBlob({
      gitExecutable,
      repository,
      revision: identity.activeRevision,
      gitPath,
      failureCode: "PROVENANCE_REVISION_COMPOSE_OBJECT_MISSING",
    });
    const composeBytes = composeBlob.bytes;
    if (sha256(composeBytes) !== identity.composeSha256) {
      fail("PROVENANCE_REVISION_COMPOSE_DIGEST_MISMATCH");
    }
    const workerModeContract = assertPinnedComposeImages(composeBytes);
    const observedWorkerMode = identity.releaseEnvironmentWorkerRuntimeMode;
    if (
      observedWorkerMode !== null &&
      ((observedWorkerMode === "LEGACY_NORMAL" && workerModeContract !== "LEGACY_NORMAL") ||
        (observedWorkerMode !== "LEGACY_NORMAL" && workerModeContract !== "EXPLICIT"))
    ) {
      fail("PROVENANCE_REVISION_COMPOSE_WORKER_MODE_MISMATCH");
    }
  }
  return complete;
}

function assertAttestedWorkspaceComposeDigest({ document, repository, expectedRevision }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedRevision)) {
    fail("PROVENANCE_EXPECTED_REVISION_INVALID");
  }
  let composeBytes;
  try {
    composeBytes = readFileSync(resolve(repository, "deploy/lightsail/compose.yml"));
  } catch {
    fail("PROVENANCE_REVISION_COMPOSE_OBJECT_MISSING");
  }
  const composeSha256 = sha256(composeBytes);
  const workerModeContract = assertPinnedComposeImages(composeBytes);
  const revisionFields = [
    "activeRevision",
    "currentRevision",
    "sourceRevision",
    "releaseEnvironmentRevision",
    "manifestRevision",
  ];
  for (const identity of [document.captures.a.identity, document.captures.b.identity]) {
    if (
      revisionFields.some(
        (field) => identity[field] !== null && identity[field] !== expectedRevision,
      )
    ) {
      fail("PROVENANCE_EXPECTED_REVISION_MISMATCH");
    }
    if (identity.activeRevision !== expectedRevision || identity.composeSha256 !== composeSha256) {
      fail("PROVENANCE_REVISION_COMPOSE_DIGEST_MISMATCH");
    }
    const observedWorkerMode = identity.releaseEnvironmentWorkerRuntimeMode;
    if (
      observedWorkerMode !== null &&
      ((observedWorkerMode === "LEGACY_NORMAL" && workerModeContract !== "LEGACY_NORMAL") ||
        (observedWorkerMode !== "LEGACY_NORMAL" && workerModeContract !== "EXPLICIT"))
    ) {
      fail("PROVENANCE_REVISION_COMPOSE_WORKER_MODE_MISMATCH");
    }
  }
  return true;
}

function assertExecutableSha256(path, expectedSha256) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    fail("PROVENANCE_GIT_EXECUTABLE_DIGEST_INVALID");
  }
  let executableBytes;
  try {
    executableBytes = readFileSync(path);
  } catch {
    fail("PROVENANCE_GIT_EXECUTABLE_UNREADABLE");
  }
  if (sha256(executableBytes) !== expectedSha256) {
    fail("PROVENANCE_GIT_EXECUTABLE_DIGEST_MISMATCH");
  }
}

export function validatePostflightDocument(
  bytes,
  {
    schema,
    expectedNonce,
    processExitCode,
    notBefore,
    notAfter,
    repository,
    gitExecutable = "git",
    expectedGitSha256,
    observerPath = OBSERVER_PATH,
    schemaPath = SCHEMA_PATH,
    validatorPath = VALIDATOR_PATH,
    wrapperPath = WRAPPER_PATH,
    fixtureOnly = false,
    attestedWorkspace = false,
    expectedRevision,
  },
) {
  if (!/^[0-9a-f]{64}$/u.test(expectedNonce)) {
    fail("EXPECTED_NONCE_INVALID");
  }
  if (!Number.isSafeInteger(processExitCode) || processExitCode < 0 || processExitCode > 255) {
    fail("PROCESS_EXIT_CODE_INVALID");
  }
  const document = parseCanonicalJsonDocument(bytes);
  assertNoSecretCanary(document);
  validateSchemaNode(document, schema, schema);
  if (document.nonce !== expectedNonce) {
    fail("NONCE_MISMATCH");
  }
  if (document.exitCode !== processExitCode) {
    fail("EXIT_CODE_MISMATCH");
  }
  assertTimestampSemantics(document, notBefore, notAfter);
  assertDerivedSummaries(document);
  assertResultSemantics(document);

  if (expectedGitSha256 !== undefined) {
    assertExecutableSha256(gitExecutable, expectedGitSha256);
  }
  if (fixtureOnly && attestedWorkspace) {
    fail("PROVENANCE_MODE_INVALID");
  }
  const repositoryHead = fixtureOnly
    ? null
    : attestedWorkspace
      ? expectedRevision
      : readRepositoryHead(gitExecutable, repository);
  const directWorkspaceSources = fixtureOnly || attestedWorkspace;

  const observer = readIndexedSource({
    gitExecutable,
    repository,
    repositoryHead,
    path: observerPath,
    fixtureOnly: directWorkspaceSources,
  });
  const validator = readIndexedSource({
    gitExecutable,
    repository,
    repositoryHead,
    path: validatorPath,
    fixtureOnly: directWorkspaceSources,
  });
  const schemaSource = readIndexedSource({
    gitExecutable,
    repository,
    repositoryHead,
    path: schemaPath,
    fixtureOnly: directWorkspaceSources,
  });
  const wrapper = readIndexedSource({
    gitExecutable,
    repository,
    repositoryHead,
    path: wrapperPath,
    fixtureOnly: directWorkspaceSources,
  });
  const revisionComposeVerified = attestedWorkspace
    ? assertAttestedWorkspaceComposeDigest({ document, repository, expectedRevision })
    : assertRevisionComposeDigest({ document, gitExecutable, repository });

  return Object.freeze({
    schemaVersion: 1,
    kind: "refunddesk.lightsail.host-postflight.validation",
    result: document.result,
    posture: document.posture,
    remote: document,
    provenance: Object.freeze({
      observer: Object.freeze(observer),
      validator: Object.freeze(validator),
      wrapper: Object.freeze(wrapper),
      schema: Object.freeze(schemaSource),
      repositoryHead,
      revisionComposeVerified,
    }),
    redaction: Object.freeze({
      rawSecretPresent: false,
      arbitraryPathPresent: false,
      stderrPresent: false,
    }),
  });
}

function parseArguments(argv) {
  const allowed = new Set([
    "--expected-nonce",
    "--process-exit-code",
    "--not-before",
    "--not-after",
    "--repository",
    "--git-executable",
    "--expected-git-sha256",
    "--fixture-only",
    "--attested-workspace",
    "--expected-revision",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.has(name) || values.has(name)) {
      fail("ARGUMENT_INVALID");
    }
    if (name === "--fixture-only" || name === "--attested-workspace") {
      values.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("ARGUMENT_VALUE_MISSING");
    }
    values.set(name, value);
    index += 1;
  }
  for (const required of [
    "--expected-nonce",
    "--process-exit-code",
    "--not-before",
    "--not-after",
    "--repository",
    "--git-executable",
    "--expected-git-sha256",
  ]) {
    if (!values.has(required)) {
      fail("ARGUMENT_REQUIRED_MISSING");
    }
  }
  if (values.get("--attested-workspace") === true && !values.has("--expected-revision")) {
    fail("ARGUMENT_REQUIRED_MISSING");
  }
  if (values.get("--attested-workspace") !== true && values.has("--expected-revision")) {
    fail("ARGUMENT_INVALID");
  }
  if (values.get("--attested-workspace") === true && values.get("--fixture-only") === true) {
    fail("ARGUMENT_INVALID");
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

export async function runCli({ argv = process.argv.slice(2) } = {}) {
  try {
    const args = parseArguments(argv);
    const repository = resolve(args.get("--repository"));
    const fixtureOnly = args.get("--fixture-only") === true;
    const attestedWorkspace = args.get("--attested-workspace") === true;
    const schemaBytes = readFileSync(resolve(repository, SCHEMA_PATH));
    let schema;
    try {
      if (schemaBytes.includes(0x00)) {
        fail("SCHEMA_SOURCE_INVALID");
      }
      schema = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(schemaBytes));
    } catch (error) {
      if (error instanceof PostflightValidationError) {
        throw error;
      }
      fail("SCHEMA_SOURCE_INVALID");
    }
    const input = await readBoundedStdin();
    const validation = validatePostflightDocument(input, {
      schema,
      expectedNonce: args.get("--expected-nonce"),
      processExitCode: Number(args.get("--process-exit-code")),
      notBefore: args.get("--not-before"),
      notAfter: args.get("--not-after"),
      repository,
      gitExecutable: args.get("--git-executable"),
      expectedGitSha256: args.get("--expected-git-sha256"),
      fixtureOnly,
      attestedWorkspace,
      expectedRevision: args.get("--expected-revision"),
    });
    process.stdout.write(`${JSON.stringify(validation)}\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof PostflightValidationError ? error.code : "VALIDATION_INTERNAL_ERROR";
    process.stderr.write(`postflight-validation-error:${code}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli();
}

export const postflightContract = Object.freeze({
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  observerPath: OBSERVER_PATH,
  schemaPath: SCHEMA_PATH,
  validatorPath: VALIDATOR_PATH,
  wrapperPath: WRAPPER_PATH,
  resultPriority: RESULT_PRIORITY,
  modulePath: fileURLToPath(import.meta.url),
});
