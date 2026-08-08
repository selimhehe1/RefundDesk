import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ContainmentReconciliationValidationError,
  parseCanonicalContainmentDocument,
  validateContainmentReconciliationDocument,
} from "./validate-lightsail-containment-reconciliation.mjs";

const repository = resolve(import.meta.dirname, "..");
const validatorPath = join(repository, "scripts/validate-lightsail-containment-reconciliation.mjs");
const schema = JSON.parse(
  readFileSync(
    join(repository, "docs/schemas/refunddesk-lightsail-containment-reconciliation-v1.schema.json"),
    "utf8",
  ),
);
const revision = "8da280b78a9d1475c7bd79063e72c5af77121e8d";
const nonce = "a".repeat(64);
const runnerSha256 = "b".repeat(64);
const journalSha256 = "c".repeat(64);
const sourceDigests = Object.freeze({
  manifestSha256: "e72319926d184db8e696c7d4d032d3f9e44cbabbde9b36e64c473da96ef241ca",
  composeSha256: "92a96553a38b226505957e717e2844960794256dceb5a5284fde0c00d22b4610",
  commonSha256: "e3582a5ccbac7be03731c1773cb3527c9ee6613796a131762b19041fa6918da6",
  helperSha256: "76fba53c93c450c202788a9fd12754e409e713a7b8407084723c440f01f7a6e6",
});
const imageIds = Object.freeze({
  postgres: "sha256:0a314d409a9633cff4f89dc18482262625c0ee78cb1aa2ff8e47bc6da0251e1b",
  verifier: "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe",
  worker: "sha256:e3ead31f6c3084b69731e095a250b8d0a4e3e9d6e8d239dccf077e6b90d53f64",
  web: "sha256:c1d13b7db80e019e8a0ea24717c2a2028052b5959e1aaf65746336073606601f",
  caddy: "sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe",
});
const serviceContainerIds = Object.freeze({
  postgres: "1".repeat(64),
  verifier: "2".repeat(64),
  worker: "3".repeat(64),
  web: "4".repeat(64),
  caddy: "5".repeat(64),
});
const validationOptions = Object.freeze({
  schema,
  expectedNonce: nonce,
  expectedRunnerSha256: runnerSha256,
  processExitCode: 0,
  notBefore: "2026-08-08T11:59:59Z",
  notAfter: "2026-08-08T12:00:41Z",
});

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

function canonicalBytes(document) {
  return Buffer.from(`${JSON.stringify(sortJsonKeys(document))}\n`, "utf8");
}

function containedStateSha256(captureValue) {
  const projection = Object.fromEntries(
    Object.entries(captureValue).filter(([key]) => key !== "capturedAt" && key !== "journal"),
  );
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(projection)), "utf8")
    .digest("hex");
}

function admissionInvariantSha256(captureValue) {
  const projection = {
    identity: captureValue.identity,
    containers: captureValue.containers.map(
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
    database: captureValue.database,
    live: {
      liveInterlocksAvailable: captureValue.surface.liveInterlocksAvailable,
      platformLiveDisabled: captureValue.surface.platformLiveDisabled,
      workerLiveDisabled: captureValue.surface.workerLiveDisabled,
      liveWebhookDisabled: captureValue.surface.liveWebhookDisabled,
      webEffectiveLiveDisabled: captureValue.surface.webEffectiveLiveDisabled,
      workerEffectiveLiveDisabled: captureValue.surface.workerEffectiveLiveDisabled,
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(projection)), "utf8")
    .digest("hex");
}

function journalPresent(operation) {
  return {
    present: true,
    operation,
    revision,
    status: "in_progress",
    sha256: journalSha256,
  };
}

function journalAbsent() {
  return {
    present: false,
    operation: null,
    revision: null,
    status: null,
    sha256: null,
  };
}

function container(service) {
  const core = new Set(["postgres", "verifier", "web"]);
  return {
    service,
    presentCount: 1,
    containerId: serviceContainerIds[service],
    imageId: imageIds[service],
    expectedImageId: imageIds[service],
    imageReferenceMatches: true,
    status: core.has(service) ? "RUNNING" : "EXITED",
    health: core.has(service) ? "HEALTHY" : "NONE",
    restartPolicy: core.has(service) ? "unless-stopped" : "no",
    projectLabelMatches: true,
    serviceLabelMatches: true,
    revisionLabelMatches: true,
  };
}

function capture(capturedAt, operation, journal) {
  return {
    capturedAt,
    identity: {
      activeRevision: revision,
      currentRevision: revision,
      sourceRevision: revision,
      releaseEnvironmentRevision: revision,
      manifestSha256: sourceDigests.manifestSha256,
      composeSha256: sourceDigests.composeSha256,
      commonSha256: sourceDigests.commonSha256,
      helperSha256: sourceDigests.helperSha256,
    },
    journal: journal ?? journalPresent(operation),
    control: {
      activeReleaseUnitCount: 0,
      activeFenceUnitCount: 0,
      releaseRuntimeMarkerCount: 0,
      transitionPresent: false,
      backupUploadJournalPresent: false,
      managedTransitionPresent: false,
      reservationValid: true,
      knownOneShotsPresentCount: 0,
      knownOneShotsRunningCount: 0,
      unexpectedRunningContainerCount: 0,
    },
    containers: [
      container("postgres"),
      container("verifier"),
      container("worker"),
      container("web"),
      container("caddy"),
    ],
    surface: {
      systemdInventoryAvailable: true,
      listenerInventoryAvailable: true,
      liveInterlocksAvailable: true,
      platformLiveDisabled: true,
      workerLiveDisabled: true,
      liveWebhookDisabled: true,
      webEffectiveLiveDisabled: true,
      workerEffectiveLiveDisabled: true,
      backupTimerActive: false,
      retentionTimerActive: false,
      backupServiceActive: false,
      retentionServiceActive: false,
      quiesceRecoveryActive: false,
      tcp80Listening: false,
      tcp443Listening: false,
      udp80Listening: false,
      udp443Listening: false,
    },
    database: {
      snapshotAvailable: true,
      systemIdentifier: "7667530739792687140",
      activeWorkflows: 0,
      unreleasedPaymentGuards: 0,
      activeFinancialJobs: 0,
      liveTenants: 0,
      liveInstallations: 0,
      preparedTransactions: 0,
      refundRequests: 6,
      auditEvents: 2088,
    },
  };
}

function admissionCapture(capturedAt, operation) {
  const result = capture(capturedAt, operation);
  for (const service of ["worker", "caddy"]) {
    const observation = result.containers.find((entry) => entry.service === service);
    observation.status = "RUNNING";
    observation.health = "HEALTHY";
    observation.restartPolicy = "unless-stopped";
  }
  result.surface.backupTimerActive = true;
  result.surface.retentionTimerActive = true;
  result.surface.tcp80Listening = true;
  result.surface.tcp443Listening = true;
  return result;
}

export function passContainmentDocument(operation = "backup") {
  const captures = {
    admission: admissionCapture("2026-08-08T12:00:05Z", operation),
    before: {
      a: capture("2026-08-08T12:00:10Z", operation),
      b: capture("2026-08-08T12:00:20Z", operation),
    },
    after: capture("2026-08-08T12:00:30Z", operation, journalAbsent()),
  };
  return {
    schemaVersion: 1,
    kind: "refunddesk.lightsail.containment-reconciliation",
    nonce,
    expectedRevision: revision,
    operation,
    startedAt: "2026-08-08T12:00:00Z",
    completedAt: "2026-08-08T12:00:40Z",
    exitCode: 0,
    result: "PASS",
    code: "PASS_CONTAINED_JOURNAL_CLEARED",
    diagnostics: [],
    marker: {
      state: "complete",
      resumedFromState: "absent",
      journalPresentAtInvocationStart: true,
      revision,
      operation,
      runnerSha256,
      journalSha256,
      admissionInvariantSha256: admissionInvariantSha256(captures.admission),
      containedStateSha256: containedStateSha256(captures.before.a),
    },
    captures,
    containment: {
      sourceExact: true,
      liveDisabled: true,
      financialStable: true,
      financialQuiescent: true,
      coreHealthy: true,
      coreContainerIdentitiesStable: true,
      workerStopped: true,
      caddyStopped: true,
      oneShotsStopped: true,
      maintenanceStopped: true,
      publicListenersClosed: true,
      releaseFenceAbsent: true,
      reservationValid: true,
      journalCleared: true,
      markerComplete: true,
    },
    mutations: {
      unitsStopRequested: 5,
      containersRestartFenced: 2,
      containersStopped: 2,
      reservationReconciled: 0,
      journalCleared: 1,
      markerTransitions: 4,
    },
    redaction: {
      rawSecretPresent: false,
      rawApiKeyPresent: false,
      rawSignaturePresent: false,
      rawPayloadPresent: false,
      customerDataPresent: false,
      arbitraryPathPresent: false,
      ipAddressPresent: false,
      stderrPresent: false,
      keyDigestPresent: false,
    },
  };
}

function containedStateDriftFailureDocument() {
  const document = passContainmentDocument();
  document.exitCode = 20;
  document.result = "FAIL";
  document.code = "CAPTURE_CHANGED";
  document.diagnostics = ["CAPTURE_CHANGED"];
  document.marker.state = "contained_verified";
  document.marker.resumedFromState = "contained_verified";
  document.marker.journalPresentAtInvocationStart = true;
  document.captures.admission = JSON.parse(JSON.stringify(document.captures.before.a));
  document.captures.admission.capturedAt = "2026-08-08T12:00:05Z";
  for (const captureValue of [
    document.captures.admission,
    document.captures.before.a,
    document.captures.before.b,
    document.captures.after,
  ]) {
    captureValue.containers.find((entry) => entry.service === "worker").status = "CREATED";
  }
  document.captures.after.journal = journalPresent("backup");
  document.mutations = {
    unitsStopRequested: 0,
    containersRestartFenced: 0,
    containersStopped: 0,
    reservationReconciled: 0,
    journalCleared: 0,
    markerTransitions: 2,
  };
  document.containment.journalCleared = false;
  document.containment.markerComplete = false;
  return document;
}

function validate(document, overrides = {}) {
  return validateContainmentReconciliationDocument(canonicalBytes(document), {
    ...validationOptions,
    ...overrides,
  });
}

function expectValidationError(document, expectedCode, overrides = {}) {
  assert.throws(
    () => validate(document, overrides),
    (error) => {
      assert.ok(error instanceof ContainmentReconciliationValidationError);
      if (expectedCode !== undefined) {
        assert.equal(error.code, expectedCode);
      }
      return true;
    },
  );
}

test("accepts exact backup PASS and produces a bounded validation envelope", () => {
  const document = passContainmentDocument();
  const result = validate(document);
  assert.equal(result.result, "PASS");
  assert.equal(result.code, "PASS_CONTAINED_JOURNAL_CLEARED");
  assert.equal(result.operation, "backup");
  assert.deepEqual(result.remote, document);
  assert.ok(Object.values(result.redaction).every((value) => value === false));
});

test("accepts exact retention PASS with validation-only reservation handling", () => {
  assert.equal(validate(passContainmentDocument("retention")).result, "PASS");
});

test("accepts a PASS resumed after durable journal unlink", () => {
  const document = passContainmentDocument();
  document.marker.resumedFromState = "contained_verified";
  document.marker.journalPresentAtInvocationStart = false;
  document.captures.admission.journal = journalAbsent();
  document.captures.before.a.journal = journalAbsent();
  document.captures.before.b.journal = journalAbsent();
  document.mutations.containersStopped = 0;
  assert.equal(validate(document).result, "PASS");
});

test("accepts honest pre-journal INCOMPLETE with nullable operation", () => {
  const document = passContainmentDocument();
  document.operation = null;
  document.exitCode = 21;
  document.result = "INCOMPLETE";
  document.code = "JOURNAL_UNAVAILABLE";
  document.diagnostics = ["JOURNAL_UNAVAILABLE"];
  document.marker = {
    state: "absent",
    resumedFromState: null,
    journalPresentAtInvocationStart: null,
    revision: null,
    operation: null,
    runnerSha256: null,
    journalSha256: null,
    admissionInvariantSha256: null,
    containedStateSha256: null,
  };
  document.captures.admission.journal = journalAbsent();
  document.captures.before.a.journal = journalAbsent();
  document.captures.before.b.journal = journalAbsent();
  document.mutations = {
    unitsStopRequested: 0,
    containersRestartFenced: 0,
    containersStopped: 0,
    reservationReconciled: 0,
    journalCleared: 0,
    markerTransitions: 0,
  };
  document.containment.journalCleared = false;
  document.containment.markerComplete = false;
  assert.equal(validate(document, { processExitCode: 21 }).result, "INCOMPLETE");
});

test("accepts pre-effect inventory INCOMPLETE with the validated journal preserved", () => {
  const document = passContainmentDocument();
  document.exitCode = 21;
  document.result = "INCOMPLETE";
  document.code = "SYSTEMD_INVENTORY_UNAVAILABLE";
  document.diagnostics = ["SYSTEMD_INVENTORY_UNAVAILABLE"];
  document.marker = {
    state: "absent",
    resumedFromState: "absent",
    journalPresentAtInvocationStart: true,
    revision: null,
    operation: null,
    runnerSha256: null,
    journalSha256: null,
    admissionInvariantSha256: null,
    containedStateSha256: null,
  };
  document.captures.after.journal = journalPresent("backup");
  document.mutations = {
    unitsStopRequested: 0,
    containersRestartFenced: 0,
    containersStopped: 0,
    reservationReconciled: 0,
    journalCleared: 0,
    markerTransitions: 0,
  };
  document.containment.journalCleared = false;
  document.containment.markerComplete = false;
  assert.equal(validate(document, { processExitCode: 21 }).result, "INCOMPLETE");
});

test("rejects an operation invented before any durable journal or marker binding", () => {
  const document = passContainmentDocument();
  document.exitCode = 20;
  document.result = "FAIL";
  document.code = "JOURNAL_INVALID";
  document.diagnostics = ["JOURNAL_INVALID"];
  document.marker = {
    state: "absent",
    resumedFromState: null,
    journalPresentAtInvocationStart: null,
    revision: null,
    operation: null,
    runnerSha256: null,
    journalSha256: null,
    admissionInvariantSha256: null,
    containedStateSha256: null,
  };
  document.captures.admission.journal = journalAbsent();
  document.captures.before.a.journal = journalAbsent();
  document.captures.before.b.journal = journalAbsent();
  document.mutations = {
    unitsStopRequested: 0,
    containersRestartFenced: 0,
    containersStopped: 0,
    reservationReconciled: 0,
    journalCleared: 0,
    markerTransitions: 0,
  };
  document.containment.journalCleared = false;
  document.containment.markerComplete = false;
  expectValidationError(document, "OPERATION_WITHOUT_DURABLE_SOURCE", { processExitCode: 20 });
});

test("accepts fail-closed state before journal retirement", () => {
  const document = passContainmentDocument();
  document.exitCode = 20;
  document.result = "FAIL";
  document.code = "MUTATION_FAILED";
  document.diagnostics = ["MUTATION_FAILED"];
  document.marker.state = "contained_verified";
  document.captures.after.journal = journalPresent("backup");
  document.mutations.journalCleared = 0;
  document.mutations.markerTransitions = 2;
  document.containment.journalCleared = false;
  document.containment.markerComplete = false;
  assert.equal(validate(document, { processExitCode: 20 }).result, "FAIL");
});

test("accepts a contained resume failure before this invocation issues stop effects", () => {
  const document = passContainmentDocument();
  document.exitCode = 20;
  document.result = "FAIL";
  document.code = "MUTATION_FAILED";
  document.diagnostics = ["MUTATION_FAILED"];
  document.marker.resumedFromState = "contained_verified";
  document.mutations.unitsStopRequested = 0;
  document.mutations.containersRestartFenced = 0;
  document.mutations.containersStopped = 0;
  document.containment.markerComplete = false;
  document.marker.state = "contained_verified";
  document.captures.after.journal = journalPresent("backup");
  document.mutations.journalCleared = 0;
  document.containment.journalCleared = false;
  document.mutations.markerTransitions = 2;
  assert.equal(validate(document, { processExitCode: 20 }).result, "FAIL");
});

test("accepts only the exact pre-effect contained-state drift failure", () => {
  assert.equal(
    validate(containedStateDriftFailureDocument(), { processExitCode: 20 }).result,
    "FAIL",
  );
});

test("rejects contained-state digest drift for PASS, another code, or any invocation effect", () => {
  const pass = containedStateDriftFailureDocument();
  pass.exitCode = 0;
  pass.result = "PASS";
  pass.code = "PASS_CONTAINED_JOURNAL_CLEARED";
  pass.diagnostics = [];
  expectValidationError(pass, "CONTAINED_STATE_DIGEST_INVALID");

  const anotherCode = containedStateDriftFailureDocument();
  anotherCode.code = "MUTATION_FAILED";
  anotherCode.diagnostics = ["MUTATION_FAILED"];
  expectValidationError(anotherCode, "CONTAINED_STATE_DIGEST_INVALID", {
    processExitCode: 20,
  });

  for (const mutate of [
    (document) => {
      document.mutations.unitsStopRequested = 1;
    },
    (document) => {
      document.mutations.containersRestartFenced = 1;
    },
    (document) => {
      document.mutations.containersRestartFenced = 1;
      document.mutations.containersStopped = 1;
    },
    (document) => {
      document.mutations.journalCleared = 1;
    },
  ]) {
    const document = containedStateDriftFailureDocument();
    mutate(document);
    expectValidationError(document, "CONTAINED_STATE_DIGEST_INVALID", {
      processExitCode: 20,
    });
  }

  const reservation = containedStateDriftFailureDocument();
  reservation.mutations.reservationReconciled = 1;
  expectValidationError(reservation, "SCHEMA_ROOT_mutations_reservationReconciled_CONST_INVALID", {
    processExitCode: 20,
  });
});

test("rejects divergent drift captures and CAPTURE_CHANGED without a digest mismatch", () => {
  const divergent = containedStateDriftFailureDocument();
  divergent.captures.after.containers.find((entry) => entry.service === "worker").status = "EXITED";
  expectValidationError(divergent, "CONTAINED_STATE_DIGEST_INVALID", {
    processExitCode: 20,
  });

  const noDrift = passContainmentDocument();
  noDrift.exitCode = 20;
  noDrift.result = "FAIL";
  noDrift.code = "CAPTURE_CHANGED";
  noDrift.diagnostics = ["CAPTURE_CHANGED"];
  noDrift.marker.state = "contained_verified";
  noDrift.marker.resumedFromState = "contained_verified";
  noDrift.captures.after.journal = journalPresent("backup");
  noDrift.mutations = {
    unitsStopRequested: 0,
    containersRestartFenced: 0,
    containersStopped: 0,
    reservationReconciled: 0,
    journalCleared: 0,
    markerTransitions: 2,
  };
  noDrift.containment.journalCleared = false;
  noDrift.containment.markerComplete = false;
  expectValidationError(noDrift, "RESULT_CAPTURE_CHANGED_UNPROVEN", {
    processExitCode: 20,
  });

  const unsafeDrift = containedStateDriftFailureDocument();
  for (const captureValue of [
    unsafeDrift.captures.admission,
    unsafeDrift.captures.before.a,
    unsafeDrift.captures.before.b,
    unsafeDrift.captures.after,
  ]) {
    captureValue.containers.find((entry) => entry.service === "worker").status = "RUNNING";
  }
  expectValidationError(unsafeDrift, "CONTAINED_STATE_DIGEST_INVALID", {
    processExitCode: 20,
  });
});

test("accepts prepared only with its stable admission invariant", () => {
  const document = passContainmentDocument();
  document.exitCode = 20;
  document.result = "FAIL";
  document.code = "MUTATION_FAILED";
  document.diagnostics = ["MUTATION_FAILED"];
  document.marker.state = "prepared";
  document.marker.containedStateSha256 = null;
  document.captures.after.journal = journalPresent("backup");
  document.mutations.journalCleared = 0;
  document.mutations.markerTransitions = 1;
  document.containment.journalCleared = false;
  document.containment.markerComplete = false;
  assert.equal(validate(document, { processExitCode: 20 }).result, "FAIL");

  document.captures.after.database.auditEvents += 1;
  expectValidationError(document, "ADMISSION_INVARIANT_DIGEST_INVALID", {
    processExitCode: 20,
  });
});

test("accepts fail-closed crash window after unlink and before marker advancement", () => {
  const document = passContainmentDocument();
  document.exitCode = 20;
  document.result = "FAIL";
  document.code = "MARKER_TRANSITION_FAILED";
  document.diagnostics = ["MARKER_TRANSITION_FAILED"];
  document.marker.state = "contained_verified";
  document.mutations.markerTransitions = 2;
  document.containment.markerComplete = false;
  assert.equal(validate(document, { processExitCode: 20 }).result, "FAIL");
});

test("rejects stopped-target deletion against the prepared admission invariant", () => {
  const document = passContainmentDocument();
  for (const captureValue of [
    document.captures.before.a,
    document.captures.before.b,
    document.captures.after,
  ]) {
    for (const service of ["worker", "caddy"]) {
      const observation = captureValue.containers.find((entry) => entry.service === service);
      Object.assign(observation, {
        presentCount: 0,
        containerId: null,
        imageId: null,
        expectedImageId: null,
        imageReferenceMatches: false,
        status: "MISSING",
        health: "MISSING",
        restartPolicy: null,
        projectLabelMatches: false,
        serviceLabelMatches: false,
        revisionLabelMatches: false,
      });
    }
  }
  document.mutations.containersRestartFenced = 0;
  document.mutations.containersStopped = 0;
  expectValidationError(document, "ADMISSION_INVARIANT_DIGEST_INVALID");
});

test("CLI accepts exact runner provenance and emits one canonical validation line", () => {
  const execution = spawnSync(
    process.execPath,
    [
      validatorPath,
      "--expected-nonce",
      nonce,
      "--expected-runner-sha256",
      runnerSha256,
      "--process-exit-code",
      "0",
      "--not-before",
      validationOptions.notBefore,
      "--not-after",
      validationOptions.notAfter,
    ],
    { input: canonicalBytes(passContainmentDocument()), encoding: "utf8" },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, "");
  assert.ok(execution.stdout.endsWith("\n"));
  assert.equal(execution.stdout.slice(0, -1).includes("\n"), false);
  assert.equal(JSON.parse(execution.stdout).result, "PASS");
});

test("CLI rejects non-canonical process exit arguments", () => {
  const execution = spawnSync(
    process.execPath,
    [
      validatorPath,
      "--expected-nonce",
      nonce,
      "--expected-runner-sha256",
      runnerSha256,
      "--process-exit-code",
      "00",
      "--not-before",
      validationOptions.notBefore,
      "--not-after",
      validationOptions.notAfter,
    ],
    { input: canonicalBytes(passContainmentDocument()), encoding: "utf8" },
  );
  assert.equal(execution.status, 1);
  assert.equal(execution.stdout, "");
  assert.equal(
    execution.stderr,
    "containment-reconciliation-validation-error:PROCESS_EXIT_CODE_INVALID\n",
  );
});

test("canonical parser rejects formatting, extra lines, and invalid bounds", () => {
  const document = passContainmentDocument();
  assert.throws(
    () => parseCanonicalContainmentDocument(Buffer.from(JSON.stringify(document), "utf8")),
    (error) => error.code === "DOCUMENT_FINAL_LF_REQUIRED",
  );
  assert.throws(
    () =>
      parseCanonicalContainmentDocument(
        Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"),
      ),
    (error) => error.code === "DOCUMENT_SINGLE_LINE_REQUIRED",
  );
  assert.throws(
    () =>
      parseCanonicalContainmentDocument(
        Buffer.from(`${JSON.stringify(document)}\n${JSON.stringify(document)}\n`, "utf8"),
      ),
    (error) => error.code === "DOCUMENT_SINGLE_LINE_REQUIRED",
  );
  assert.throws(
    () => parseCanonicalContainmentDocument(Buffer.alloc(128 * 1024 + 1, 0x61)),
    (error) => error.code === "DOCUMENT_SIZE_INVALID",
  );
});

test("rejects non-sorted or additional exact-schema keys", () => {
  const document = passContainmentDocument();
  const reordered = { kind: document.kind, schemaVersion: document.schemaVersion };
  for (const [key, value] of Object.entries(document)) {
    if (!Object.hasOwn(reordered, key)) {
      reordered[key] = value;
    }
  }
  assert.throws(
    () =>
      validateContainmentReconciliationDocument(
        Buffer.from(`${JSON.stringify(reordered)}\n`, "utf8"),
        validationOptions,
      ),
    (error) => error.code === "DOCUMENT_CANONICAL_JSON_REQUIRED",
  );

  const extra = passContainmentDocument();
  extra.marker.extra = false;
  expectValidationError(extra, "SCHEMA_ROOT_marker_ADDITIONAL_PROPERTY");
});

test("rejects secret, path, and IP material before schema interpretation", () => {
  for (const [leak, code] of [
    ["sk_test_abcdefghijklmnop", "DOCUMENT_SECRET_CANARY_PRESENT"],
    ["/var/lib/refunddesk/runtime", "DOCUMENT_PATH_PRESENT"],
    ["192.0.2.7", "DOCUMENT_IP_ADDRESS_PRESENT"],
  ]) {
    const document = passContainmentDocument();
    document.leak = leak;
    expectValidationError(document, code);
  }
});

test("rejects nonce, runner digest, and process exit mismatches", () => {
  expectValidationError(passContainmentDocument(), "NONCE_MISMATCH", {
    expectedNonce: "d".repeat(64),
  });
  expectValidationError(passContainmentDocument(), "MARKER_BINDING_INVALID", {
    expectedRunnerSha256: "d".repeat(64),
  });
  expectValidationError(passContainmentDocument(), "EXIT_CODE_MISMATCH", {
    processExitCode: 20,
  });
});

test("rejects wrong exact revision and source digests", () => {
  const wrongRevision = passContainmentDocument();
  wrongRevision.expectedRevision = "d".repeat(40);
  expectValidationError(wrongRevision, "SCHEMA_ROOT_expectedRevision_CONST_INVALID");

  const wrongSource = passContainmentDocument();
  wrongSource.captures.after.identity.commonSha256 = "d".repeat(64);
  expectValidationError(wrongSource, "ADMISSION_INVARIANT_DIGEST_INVALID");
});

test("rejects unproven image identity and unstable core container identity", () => {
  const wrongImage = passContainmentDocument();
  wrongImage.captures.after.containers[0].imageId = `sha256:${"d".repeat(64)}`;
  expectValidationError(wrongImage, "ADMISSION_INVARIANT_DIGEST_INVALID");

  const changedCore = passContainmentDocument();
  changedCore.captures.after.containers[3].containerId = "d".repeat(64);
  expectValidationError(changedCore, "ADMISSION_INVARIANT_DIGEST_INVALID");

  const forgedDigest = passContainmentDocument();
  forgedDigest.marker.containedStateSha256 = "d".repeat(64);
  expectValidationError(forgedDigest, "CONTAINED_STATE_DIGEST_INVALID");

  const forgedAdmission = passContainmentDocument();
  forgedAdmission.marker.admissionInvariantSha256 = "d".repeat(64);
  expectValidationError(forgedAdmission, "ADMISSION_INVARIANT_DIGEST_INVALID");
});

test("rejects changed or active financial state", () => {
  const changed = passContainmentDocument();
  changed.captures.before.b.database.auditEvents += 1;
  expectValidationError(changed, "ADMISSION_INVARIANT_DIGEST_INVALID");

  const active = passContainmentDocument();
  active.captures.after.database.activeWorkflows = 1;
  expectValidationError(active, "ADMISSION_INVARIANT_DIGEST_INVALID");
});

test("rejects running or incoherently missing stopped targets", () => {
  const running = passContainmentDocument();
  running.captures.after.containers[2].status = "RUNNING";
  expectValidationError(running, "CONTAINED_STATE_DIGEST_INVALID");

  const missing = passContainmentDocument();
  Object.assign(missing.captures.after.containers[4], {
    presentCount: 0,
    containerId: null,
    imageId: null,
    expectedImageId: null,
    imageReferenceMatches: false,
    status: "MISSING",
    health: "MISSING",
    restartPolicy: null,
  });
  expectValidationError(missing, "ADMISSION_INVARIANT_DIGEST_INVALID");
});

test("rejects every incomplete containment surface", () => {
  const mutations = [
    [
      (document) => {
        document.captures.admission.control.knownOneShotsPresentCount = 1;
      },
      "ADMISSION_CAPTURE_INVALID",
    ],
    [
      (document) => {
        document.captures.after.surface.platformLiveDisabled = false;
      },
      "ADMISSION_INVARIANT_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.before.a.surface.backupTimerActive = true;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.surface.tcp443Listening = true;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.control.activeReleaseUnitCount = 1;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.control.knownOneShotsPresentCount = 1;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.control.knownOneShotsRunningCount = 1;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.control.unexpectedRunningContainerCount = 1;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.control.reservationValid = false;
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
    [
      (document) => {
        document.captures.after.containers[0].health = "UNHEALTHY";
      },
      "CONTAINED_STATE_DIGEST_INVALID",
    ],
  ];
  for (const [mutate, expectedCode] of mutations) {
    const document = passContainmentDocument();
    mutate(document);
    expectValidationError(document, expectedCode);
  }
});

test("rejects result, code, exit, and redaction contradictions", () => {
  const badCode = passContainmentDocument();
  badCode.code = "MUTATION_FAILED";
  expectValidationError(badCode, "RESULT_PASS_INCONSISTENT");

  const nullOperation = passContainmentDocument();
  nullOperation.operation = null;
  expectValidationError(nullOperation, "JOURNAL_BEFORE_INVALID");

  const redaction = passContainmentDocument();
  redaction.redaction.keyDigestPresent = true;
  expectValidationError(redaction, "SCHEMA_ROOT_redaction_keyDigestPresent_CONST_INVALID");

  const falseFailure = passContainmentDocument();
  falseFailure.exitCode = 20;
  falseFailure.result = "FAIL";
  falseFailure.code = "MUTATION_FAILED";
  falseFailure.diagnostics = ["MUTATION_FAILED"];
  expectValidationError(falseFailure, "RESULT_FAIL_INCONSISTENT", { processExitCode: 20 });
});

test("rejects original journal divergence and unsupported journal retirement", () => {
  const changed = passContainmentDocument();
  changed.captures.before.b.journal.sha256 = "d".repeat(64);
  expectValidationError(changed, "JOURNAL_BEFORE_CHANGED");

  const stillPresent = passContainmentDocument();
  stillPresent.captures.after.journal = journalPresent("backup");
  expectValidationError(stillPresent, "MARKER_POST_CLEAR_STATE_INVALID");

  const fabricatedResume = passContainmentDocument();
  fabricatedResume.marker.resumedFromState = "absent";
  fabricatedResume.marker.journalPresentAtInvocationStart = false;
  fabricatedResume.captures.admission.journal = journalAbsent();
  fabricatedResume.captures.before.a.journal = journalAbsent();
  fabricatedResume.captures.before.b.journal = journalAbsent();
  expectValidationError(fabricatedResume, "JOURNAL_RESUME_STATE_INVALID");

  const invalidMarkerResume = passContainmentDocument();
  invalidMarkerResume.marker.resumedFromState = "invalid";
  expectValidationError(invalidMarkerResume, "JOURNAL_RESUME_STATE_INVALID");
});

test("rejects out-of-bounds or contradictory mutation counters", () => {
  const tooMany = passContainmentDocument();
  tooMany.mutations.containersStopped = 6;
  expectValidationError(tooMany, "SCHEMA_ROOT_mutations_containersStopped_MAXIMUM_INVALID");

  const inconsistent = passContainmentDocument();
  inconsistent.mutations.containersRestartFenced = 1;
  expectValidationError(inconsistent, "MUTATION_COUNT_INCONSISTENT");

  const wrongUnits = passContainmentDocument();
  wrongUnits.mutations.unitsStopRequested = 4;
  expectValidationError(wrongUnits, "RESULT_PASS_MUTATION_INVALID");

  const wrongTransitions = passContainmentDocument();
  wrongTransitions.mutations.markerTransitions = 3;
  expectValidationError(wrongTransitions, "MARKER_TRANSITION_COUNT_INVALID");

  const retention = passContainmentDocument("retention");
  retention.mutations.reservationReconciled = 1;
  expectValidationError(retention, "SCHEMA_ROOT_mutations_reservationReconciled_CONST_INVALID");
});

test("rejects timestamps outside the ordered fifteen-minute freshness window", () => {
  const tooLong = passContainmentDocument();
  tooLong.completedAt = "2026-08-08T12:16:00Z";
  expectValidationError(tooLong, "TIMESTAMP_DURATION_INVALID", {
    notBefore: "2026-08-08T12:01:00Z",
    notAfter: "2026-08-08T12:16:00Z",
  });

  const reordered = passContainmentDocument();
  reordered.captures.before.b.capturedAt = "2026-08-08T12:00:05Z";
  expectValidationError(reordered, "TIMESTAMP_ORDER_INVALID");

  const stale = passContainmentDocument();
  expectValidationError(stale, "TIMESTAMP_LOCAL_BOUND_INVALID", {
    notBefore: "2026-08-08T12:05:00Z",
    notAfter: "2026-08-08T12:05:10Z",
  });
});
