import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PostflightValidationError,
  parseCanonicalJsonDocument,
  validatePostflightDocument,
} from "./validate-lightsail-postflight.mjs";

const repository = resolve(import.meta.dirname, "..");
const schema = JSON.parse(
  readFileSync(
    join(repository, "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"),
    "utf8",
  ),
);
const nonce = "a".repeat(64);
const revision = execFileSync(
  "git",
  ["--no-replace-objects", "-C", repository, "rev-parse", "--verify", "HEAD^{commit}"],
  { encoding: "utf8" },
).trim();
const composeBytes = execFileSync(
  "git",
  ["--no-replace-objects", "-C", repository, "show", `${revision}:deploy/lightsail/compose.yml`],
  { encoding: null },
);
const digest = createHash("sha256").update(composeBytes).digest("hex");
const startedAt = "2026-08-08T10:00:00Z";
const completedAt = "2026-08-08T10:00:02Z";

function container(service, index) {
  const core = new Set(["postgres", "verifier", "web"]);
  const imageDigit = service === "caddy" ? 7 : (index + 5) % 10;
  return {
    service,
    presentCount: 1,
    containerId: `${index}`.repeat(64),
    imageId: `sha256:${`${imageDigit}`.repeat(64)}`,
    expectedImageId: `sha256:${`${imageDigit}`.repeat(64)}`,
    imageReferenceMatches: true,
    noPublishedPorts: true,
    effectiveGlobalLiveDisabled: new Set(["worker", "web"]).has(service) ? true : null,
    effectiveLiveWebhookDisabled: service === "web" ? true : null,
    status: core.has(service) ? "RUNNING" : "EXITED",
    health: core.has(service) ? "HEALTHY" : "NONE",
    projectLabelMatches: true,
    serviceLabelMatches: true,
    revisionLabel: revision,
  };
}

function capture(capturedAt) {
  return {
    capturedAt,
    identity: {
      activeRevision: revision,
      currentRevision: revision,
      sourceRevision: revision,
      releaseEnvironmentRevision: revision,
      manifestRevision: revision,
      composeSha256: digest,
      installedManifestSha256: digest,
      manifestSchemaValid: true,
    },
    containers: [
      container("postgres", 1),
      container("verifier", 2),
      container("worker", 3),
      container("web", 4),
      container("caddy", 5),
    ],
    control: {
      operatorLockShared: true,
      transitionJournalPresent: false,
      transitionCommitMarkerValid: true,
      runtimeQuiesceJournalPresent: false,
      backupJournalPresent: false,
      legacyAppIdJournalPresent: false,
      managedTransitionInFlightPresent: false,
      managedTransitionCompletion: "VALID_PASS_CONTAINED",
      activeReleaseUnitCount: 0,
      activeFenceUnitCount: 0,
      releaseRuntimeMarkerCount: 0,
      dockerInventoryAvailable: true,
      expectedImagesAvailable: true,
      sensitiveModesSafe: true,
    },
    surface: {
      platformLiveDisabled: true,
      workerLiveDisabled: true,
      liveWebhookDisabled: true,
      backupTimerActive: false,
      retentionTimerActive: false,
      backupServiceActive: false,
      retentionServiceActive: false,
      quiesceRecoveryActive: false,
      tcp80Listening: false,
      tcp443Listening: false,
      udp80Listening: false,
      udp443Listening: false,
      systemdInventoryAvailable: true,
      listenerInventoryAvailable: true,
      liveInterlocksAvailable: true,
      runtimeLiveInterlocksAvailable: true,
      unexpectedRunningContainerCount: 0,
    },
    database: {
      snapshotAvailable: true,
      systemIdentifier: "123456789012345678",
      activeWorkflows: 0,
      unreleasedPaymentGuards: 0,
      activeFinancialJobs: 0,
      liveTenants: 0,
      liveInstallations: 0,
      preparedTransactions: 0,
      refundRequests: 2,
      auditEvents: 9,
    },
  };
}

function passDocument() {
  return {
    schemaVersion: 1,
    kind: "refunddesk.lightsail.host-postflight",
    nonce,
    startedAt,
    completedAt,
    exitCode: 0,
    result: "PASS",
    code: "PASS_CONTAINED",
    posture: "COHERENT_CONTAINED",
    diagnostics: [],
    captures: {
      a: capture("2026-08-08T10:00:01Z"),
      b: capture("2026-08-08T10:00:02Z"),
    },
    containment: {
      liveDisabled: true,
      workerStopped: true,
      caddyStopped: true,
      maintenanceStopped: true,
      publicListenersClosed: true,
      journalsClosed: true,
      fenceClosed: true,
      sensitiveModesSafe: true,
    },
    availability: {
      capturesStable: true,
      metadataCoherent: true,
      containersCoherent: true,
      coreHealthy: true,
      recoverableRuntimeStopped: false,
    },
    financial: {
      snapshotAvailable: true,
      stable: true,
      quiescent: true,
    },
    redaction: {
      rawSecretPresent: false,
      rawApiKeyPresent: false,
      rawSignaturePresent: false,
      rawPayloadPresent: false,
      customerDataPresent: false,
      arbitraryPathPresent: false,
      stderrPresent: false,
    },
  };
}

function bytes(document) {
  return Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
}

function fixtureOptions(overrides = {}) {
  return {
    schema,
    expectedNonce: nonce,
    processExitCode: 0,
    notBefore: "2026-08-08T09:59:59Z",
    notAfter: "2026-08-08T10:00:03Z",
    repository,
    fixtureOnly: true,
    ...overrides,
  };
}

function setWorkerRunning(document) {
  for (const captureValue of [document.captures.a, document.captures.b]) {
    const worker = captureValue.containers.find(({ service }) => service === "worker");
    worker.status = "RUNNING";
    worker.health = "HEALTHY";
  }
  document.containment.workerStopped = false;
}

function setDatabaseUnavailable(document) {
  for (const captureValue of [document.captures.a, document.captures.b]) {
    Object.assign(captureValue.database, {
      snapshotAvailable: false,
      systemIdentifier: null,
      activeWorkflows: null,
      unreleasedPaymentGuards: null,
      activeFinancialJobs: null,
      liveTenants: null,
      liveInstallations: null,
      preparedTransactions: null,
      refundRequests: null,
      auditEvents: null,
    });
  }
  Object.assign(document.financial, {
    snapshotAvailable: false,
    stable: true,
    quiescent: false,
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof PostflightValidationError, true);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("sk_"), false);
    return true;
  });
}

test("accepts one canonical, schema-exact, nonce-bound contained observation", () => {
  const validation = validatePostflightDocument(bytes(passDocument()), fixtureOptions());

  assert.equal(validation.result, "PASS");
  assert.equal(validation.posture, "COHERENT_CONTAINED");
  assert.equal(validation.remote.nonce, nonce);
  assert.equal(validation.provenance.revisionComposeVerified, true);
  assert.match(validation.provenance.observer.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(validation.provenance.observer.gitObject, null);
  assert.match(validation.provenance.wrapper.sha256, /^[0-9a-f]{64}$/u);
});

test("rejects BOM, CR, NUL, missing final LF, extra JSON, and non-canonical whitespace", () => {
  const valid = bytes(passDocument());
  const cases = [
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), "DOCUMENT_BOM_FORBIDDEN"],
    [Buffer.from(valid.toString("utf8").replace("\n", "\r\n")), "DOCUMENT_CR_FORBIDDEN"],
    [Buffer.concat([valid.subarray(0, -1), Buffer.from([0x00, 0x0a])]), "DOCUMENT_NUL_FORBIDDEN"],
    [valid.subarray(0, -1), "DOCUMENT_FINAL_LF_REQUIRED"],
    [Buffer.concat([valid, valid]), "DOCUMENT_SINGLE_LINE_REQUIRED"],
    [Buffer.from(` ${valid.toString("utf8")}`), "DOCUMENT_TRAILING_DATA_FORBIDDEN"],
  ];

  for (const [input, code] of cases) {
    expectCode(() => parseCanonicalJsonDocument(input), code);
  }
});

test("rejects duplicate keys through canonical reserialization", () => {
  const duplicate = Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n', "utf8");
  expectCode(() => parseCanonicalJsonDocument(duplicate), "DOCUMENT_CANONICAL_JSON_REQUIRED");
});

test("rejects an extra property and a secret canary without echoing its value", () => {
  const extra = passDocument();
  extra.unexpected = false;
  expectCode(
    () => validatePostflightDocument(bytes(extra), fixtureOptions()),
    "SCHEMA_ROOT_ADDITIONAL_PROPERTY",
  );

  const secret = passDocument();
  secret.unexpected = ["sk", "test", "Z".repeat(24)].join("_");
  expectCode(
    () => validatePostflightDocument(bytes(secret), fixtureOptions()),
    "DOCUMENT_SECRET_CANARY_PRESENT",
  );
});

test("binds the nonce, process exit code, timestamp order, and local capture window", () => {
  expectCode(
    () =>
      validatePostflightDocument(
        bytes({ ...passDocument(), nonce: "d".repeat(64) }),
        fixtureOptions(),
      ),
    "NONCE_MISMATCH",
  );
  expectCode(
    () =>
      validatePostflightDocument(bytes(passDocument()), fixtureOptions({ processExitCode: 20 })),
    "EXIT_CODE_MISMATCH",
  );

  const reversed = passDocument();
  reversed.captures.b.capturedAt = "2026-08-08T09:59:58Z";
  expectCode(
    () => validatePostflightDocument(bytes(reversed), fixtureOptions()),
    "TIMESTAMP_ORDER_INVALID",
  );

  expectCode(
    () =>
      validatePostflightDocument(
        bytes(passDocument()),
        fixtureOptions({
          notBefore: "2026-08-08T10:10:00Z",
          notAfter: "2026-08-08T10:10:01Z",
        }),
      ),
    "TIMESTAMP_LOCAL_BOUND_INVALID",
  );
});

test("enforces PASS, FAIL, and INCOMPLETE priority semantics", () => {
  const invalidPass = passDocument();
  setWorkerRunning(invalidPass);
  expectCode(
    () => validatePostflightDocument(bytes(invalidPass), fixtureOptions()),
    "RESULT_PASS_CONTAINMENT_INVALID",
  );

  const failDocument = passDocument();
  Object.assign(failDocument, {
    exitCode: 20,
    result: "FAIL",
    code: "WORKER_RUNNING",
    posture: "DIVERGENT",
    diagnostics: ["WORKER_RUNNING"],
  });
  setWorkerRunning(failDocument);
  const failValidation = validatePostflightDocument(
    bytes(failDocument),
    fixtureOptions({ processExitCode: 20 }),
  );
  assert.equal(failValidation.result, "FAIL");

  const incomplete = passDocument();
  Object.assign(incomplete, {
    exitCode: 21,
    result: "INCOMPLETE",
    code: "DATABASE_SNAPSHOT_UNREADABLE",
    posture: "UNKNOWN",
    diagnostics: ["DATABASE_SNAPSHOT_UNREADABLE"],
  });
  setDatabaseUnavailable(incomplete);
  const incompleteValidation = validatePostflightDocument(
    bytes(incomplete),
    fixtureOptions({ processExitCode: 21 }),
  );
  assert.equal(incompleteValidation.result, "INCOMPLETE");

  const priorityViolation = JSON.parse(JSON.stringify(incomplete));
  priorityViolation.diagnostics.push("WORKER_RUNNING");
  priorityViolation.containment.workerStopped = false;
  for (const captureValue of [priorityViolation.captures.a, priorityViolation.captures.b]) {
    const worker = captureValue.containers.find(({ service }) => service === "worker");
    worker.status = "RUNNING";
    worker.health = "HEALTHY";
  }
  expectCode(
    () =>
      validatePostflightDocument(bytes(priorityViolation), fixtureOptions({ processExitCode: 21 })),
    "RESULT_INCOMPLETE_PRIORITY_INVALID",
  );
});

test("accepts only the exact recoverable stopped core posture", () => {
  const recoverable = passDocument();
  Object.assign(recoverable, {
    code: "PASS_RECOVERABLE_RUNTIME_STOPPED",
    posture: "RECOVERABLE_RUNTIME_STOPPED",
  });
  for (const captureValue of [recoverable.captures.a, recoverable.captures.b]) {
    for (const service of ["verifier", "web"]) {
      const value = captureValue.containers.find(
        (containerValue) => containerValue.service === service,
      );
      value.status = "EXITED";
      value.health = "NONE";
    }
  }
  recoverable.availability.coreHealthy = false;
  recoverable.availability.recoverableRuntimeStopped = true;
  assert.equal(
    validatePostflightDocument(bytes(recoverable), fixtureOptions()).posture,
    "RECOVERABLE_RUNTIME_STOPPED",
  );

  for (const invalidStatus of ["RUNNING", "RESTARTING", "PAUSED", "DEAD"]) {
    const invalid = JSON.parse(JSON.stringify(recoverable));
    for (const captureValue of [invalid.captures.a, invalid.captures.b]) {
      const verifier = captureValue.containers.find(({ service }) => service === "verifier");
      verifier.status = invalidStatus;
      verifier.health = invalidStatus === "RUNNING" ? "UNHEALTHY" : "NONE";
    }
    invalid.availability.recoverableRuntimeStopped = false;
    expectCode(
      () => validatePostflightDocument(bytes(invalid), fixtureOptions()),
      "RESULT_PASS_HEALTH_INVALID",
    );
  }
});

test("requires exact expected images and no published core ports", () => {
  const imageMismatch = passDocument();
  for (const captureValue of [imageMismatch.captures.a, imageMismatch.captures.b]) {
    captureValue.containers.find(({ service }) => service === "postgres").expectedImageId =
      `sha256:${"f".repeat(64)}`;
  }
  expectCode(
    () => validatePostflightDocument(bytes(imageMismatch), fixtureOptions()),
    "SUMMARY_AVAILABILITY_MISMATCH",
  );

  const published = passDocument();
  for (const captureValue of [published.captures.a, published.captures.b]) {
    captureValue.containers.find(({ service }) => service === "web").noPublishedPorts = false;
  }
  expectCode(
    () => validatePostflightDocument(bytes(published), fixtureOptions()),
    "SUMMARY_AVAILABILITY_MISMATCH",
  );
});

test("reports incomplete revision-to-compose provenance as false", () => {
  for (const missing of ["activeRevision", "composeSha256"]) {
    const incomplete = passDocument();
    Object.assign(incomplete, {
      exitCode: 21,
      result: "INCOMPLETE",
      code:
        missing === "activeRevision" ? "ACTIVE_REVISION_UNREADABLE" : "COMPOSE_SOURCE_UNREADABLE",
      posture: "UNKNOWN",
      diagnostics: [
        missing === "activeRevision" ? "ACTIVE_REVISION_UNREADABLE" : "COMPOSE_SOURCE_UNREADABLE",
      ],
    });
    for (const captureValue of [incomplete.captures.a, incomplete.captures.b]) {
      captureValue.identity[missing] = null;
    }
    incomplete.availability.metadataCoherent = false;
    if (missing === "activeRevision") {
      incomplete.availability.containersCoherent = false;
    }
    const validation = validatePostflightDocument(
      bytes(incomplete),
      fixtureOptions({ processExitCode: 21 }),
    );
    assert.equal(validation.provenance.revisionComposeVerified, false);
  }
});

test("rejects a stable summary when the two captures differ", () => {
  const changed = passDocument();
  changed.captures.b.database.auditEvents += 1;
  expectCode(
    () => validatePostflightDocument(bytes(changed), fixtureOptions()),
    "SUMMARY_AVAILABILITY_MISMATCH",
  );
});

test("derives source digests from index objects and the observed revision tree", () => {
  const temporaryRepository = mkdtempSync(join(tmpdir(), "refunddesk-postflight-validator-"));
  try {
    for (const path of [
      "deploy/lightsail/scripts",
      "deploy/lightsail",
      "docs/schemas",
      "scripts",
    ]) {
      mkdirSync(join(temporaryRepository, path), { recursive: true });
    }
    const compose = Buffer.from(
      [
        "services:",
        "  postgres:",
        "    image: postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296",
        "  verifier:",
        "    image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
        "  caddy:",
        "    image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(temporaryRepository, "deploy/lightsail/compose.yml"), compose);
    writeFileSync(
      join(temporaryRepository, "deploy/lightsail/scripts/observe-host-postflight.sh"),
      "#!/bin/sh\n",
    );
    writeFileSync(
      join(temporaryRepository, "scripts/validate-lightsail-postflight.mjs"),
      "export {};\n",
    );
    writeFileSync(join(temporaryRepository, "scripts/invoke-lightsail-postflight.ps1"), "exit 0\n");
    writeFileSync(
      join(temporaryRepository, "docs/schemas/refunddesk-lightsail-postflight-v1.schema.json"),
      `${JSON.stringify(schema)}\n`,
    );
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRepository });
    execFileSync("git", ["config", "user.name", "RefundDesk Test"], { cwd: temporaryRepository });
    execFileSync("git", ["config", "user.email", "test@refunddesk.invalid"], {
      cwd: temporaryRepository,
    });
    execFileSync("git", ["add", "--all"], { cwd: temporaryRepository });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: temporaryRepository });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temporaryRepository,
      encoding: "utf8",
    }).trim();
    const document = passDocument();
    const composeDigest = createHash("sha256").update(compose).digest("hex");
    for (const captureValue of [document.captures.a, document.captures.b]) {
      for (const key of [
        "activeRevision",
        "currentRevision",
        "sourceRevision",
        "releaseEnvironmentRevision",
        "manifestRevision",
      ]) {
        captureValue.identity[key] = commit;
      }
      captureValue.identity.composeSha256 = composeDigest;
      for (const containerValue of captureValue.containers) {
        containerValue.revisionLabel = commit;
      }
    }

    const validation = validatePostflightDocument(bytes(document), {
      ...fixtureOptions(),
      repository: temporaryRepository,
      fixtureOnly: false,
    });
    assert.equal(validation.provenance.revisionComposeVerified, true);
    assert.equal(validation.provenance.repositoryHead, commit);
    assert.match(validation.provenance.validator.gitObject, /^[0-9a-f]{40}$/u);

    const unknownRevision = JSON.parse(JSON.stringify(document));
    for (const captureValue of [unknownRevision.captures.a, unknownRevision.captures.b]) {
      for (const key of [
        "activeRevision",
        "currentRevision",
        "sourceRevision",
        "releaseEnvironmentRevision",
        "manifestRevision",
      ]) {
        captureValue.identity[key] = "d".repeat(40);
      }
      for (const containerValue of captureValue.containers) {
        if (containerValue.service !== "postgres") {
          containerValue.revisionLabel = "d".repeat(40);
        }
      }
    }
    expectCode(
      () =>
        validatePostflightDocument(bytes(unknownRevision), {
          ...fixtureOptions(),
          repository: temporaryRepository,
          fixtureOnly: false,
        }),
      "PROVENANCE_GIT_COMMAND_FAILED",
    );

    const unpinnedCompose = Buffer.from(
      compose
        .toString("utf8")
        .replace(
          "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296",
          `postgres:18.4-bookworm@sha256:${"0".repeat(64)}`,
        ),
      "utf8",
    );
    writeFileSync(join(temporaryRepository, "deploy/lightsail/compose.yml"), unpinnedCompose);
    execFileSync("git", ["add", "deploy/lightsail/compose.yml"], { cwd: temporaryRepository });
    execFileSync("git", ["commit", "--quiet", "-m", "unpinned compose fixture"], {
      cwd: temporaryRepository,
    });
    const unpinnedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temporaryRepository,
      encoding: "utf8",
    }).trim();
    const unpinnedDocument = JSON.parse(JSON.stringify(document));
    const unpinnedDigest = createHash("sha256").update(unpinnedCompose).digest("hex");
    for (const captureValue of [unpinnedDocument.captures.a, unpinnedDocument.captures.b]) {
      for (const key of [
        "activeRevision",
        "currentRevision",
        "sourceRevision",
        "releaseEnvironmentRevision",
        "manifestRevision",
      ]) {
        captureValue.identity[key] = unpinnedCommit;
      }
      captureValue.identity.composeSha256 = unpinnedDigest;
      for (const containerValue of captureValue.containers) {
        containerValue.revisionLabel = unpinnedCommit;
      }
    }
    expectCode(
      () =>
        validatePostflightDocument(bytes(unpinnedDocument), {
          ...fixtureOptions(),
          repository: temporaryRepository,
          fixtureOnly: false,
        }),
      "PROVENANCE_REVISION_COMPOSE_IMAGE_INVALID",
    );

    writeFileSync(
      join(temporaryRepository, "scripts/validate-lightsail-postflight.mjs"),
      "export const changed = true;\n",
    );
    expectCode(
      () =>
        validatePostflightDocument(bytes(document), {
          ...fixtureOptions(),
          repository: temporaryRepository,
          fixtureOnly: false,
        }),
      "PROVENANCE_WORKTREE_DIFFERS_FROM_INDEX",
    );

    execFileSync("git", ["add", "scripts/validate-lightsail-postflight.mjs"], {
      cwd: temporaryRepository,
    });
    expectCode(
      () =>
        validatePostflightDocument(bytes(document), {
          ...fixtureOptions(),
          repository: temporaryRepository,
          fixtureOnly: false,
        }),
      "PROVENANCE_HEAD_DIFFERS_FROM_INDEX",
    );
  } finally {
    rmSync(temporaryRepository, { recursive: true, force: true });
  }
});

test("rejects a mismatched pinned Git executable digest before Git use", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "refunddesk-postflight-git-pin-"));
  try {
    const fakeGit = join(temporaryDirectory, "git.exe");
    writeFileSync(fakeGit, "not an executable\n");
    expectCode(
      () =>
        validatePostflightDocument(bytes(passDocument()), {
          ...fixtureOptions(),
          gitExecutable: fakeGit,
          expectedGitSha256: "0".repeat(64),
        }),
      "PROVENANCE_GIT_EXECUTABLE_DIGEST_MISMATCH",
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
