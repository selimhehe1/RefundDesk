import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  EdgeWindowValidationError,
  MAX_EDGE_WINDOW_DOCUMENT_BYTES,
  parseCanonicalEdgeWindowDocument,
  parseCanonicalWorkbenchCheckpoint,
  sortJsonKeys,
  validateEdgeWindowDocument,
  validateWorkbenchCheckpointDocument,
} from "./validate-lightsail-edge-window.mjs";

const repository = resolve(import.meta.dirname, "..");
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const schemaPath = join(repository, "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json");
const validatorPath = join(repository, "scripts/validate-lightsail-edge-window.mjs");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const nonce = "a".repeat(64);
const revision = "b".repeat(40);
const fingerprint = "c".repeat(64);
const digest = (character) => character.repeat(64);
const sourcePaths = [
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
];

function canonicalBytes(document) {
  return Buffer.from(`${JSON.stringify(sortJsonKeys(document))}\n`, "utf8");
}

function canonicalSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(value)), "utf8")
    .digest("hex");
}

function snapshot() {
  return {
    activeFinancialJobs: 0,
    auditEvents: 2088,
    mutationReceipts: 34,
    refundExecutionAttempts: 34,
    refundExecutions: 34,
    refundRequests: 34,
    unreleasedPaymentGuards: 0,
    webhookReceipts: 41,
  };
}

function validDocument() {
  const document = {
    schemaVersion: 1,
    kind: "refunddesk.lightsail.edge-window",
    nonce,
    expectedRevision: revision,
    operationStartedAt: "2026-08-08T12:00:00Z",
    startedAt: "2026-08-08T12:00:00Z",
    window: {
      closedAt: "2026-08-08T12:01:30Z",
      deadlineAt: "2026-08-08T12:04:50Z",
      durationSeconds: 300,
      openedAt: "2026-08-08T12:00:30Z",
      retryAuthorized: false,
      state: "complete",
    },
    completedAt: "2026-08-08T12:01:40Z",
    exitCode: 0,
    result: "PASS",
    code: "PASS_EDGE_WINDOW_RECONTAINED",
    diagnostics: [],
    interlocksAtCapture: {
      authorizationMarkerState: "held",
      holderActive: true,
      hostLeaseMarkerState: "held",
      watchdogMarkerState: "complete",
    },
    admission: {
      authorizationAccepted: true,
      authorizationEvidenceSha256: digest("1"),
      authorizationMaxWindowSeconds: 300,
      authorizationValidFrom: "2026-08-08T11:50:00Z",
      authorizationValidUntil: "2026-08-08T12:45:00Z",
      authorizedAwsAccountIdSha256: digest("5"),
      authorizedAwsRegionSha256: digest("8"),
      authorizedDistributionIdSha256: digest("a"),
      authorizedInstanceNameSha256: digest("b"),
      authorizedOriginIdSha256: digest("c"),
      authorizedPublicBaseUrlSha256: digest("d"),
      authorizedSshCidrSha256: digest("9"),
      authorizedSshHostSha256: digest("0"),
      incidentAccepted: true,
      incidentCapturedAt: "2026-08-08T11:59:30Z",
      incidentEvidenceSha256: digest("2"),
      incidentRemainingSecondsAtStart: 899,
      incidentValidUntil: "2026-08-08T12:14:59Z",
      postflightAccepted: true,
      postflightCapturedAt: "2026-08-08T11:59:00Z",
      postflightEvidenceSha256: digest("3"),
      postflightRemainingSecondsAtStart: 900,
      postflightValidUntil: "2026-08-08T12:15:00Z",
      promotionAccepted: true,
      promotionCaddyContainerIdSha256: digest("e"),
      promotionDatabaseSystemIdentifierSha256: digest("6"),
      promotionEvidenceSha256: digest("4"),
      promotionPostgresContainerIdSha256: digest("f"),
      promotionVerifierContainerIdSha256: digest("1"),
      promotionWebContainerIdSha256: digest("2"),
      promotionWorkerContainerIdSha256: digest("3"),
      promotionWorkerRuntimeMode: "incident_admission",
      promotionRevision: revision,
    },
    origin: {
      bound: true,
      boundDeployed: true,
      distributionIdSha256: digest("a"),
      etagBindMatched: true,
      etagUnbindMatched: true,
      headerName: "X-RefundDesk-Origin-Token",
      headerRemoved: true,
      originIdSha256: digest("c"),
      originMatched: true,
      secretMaterialEmitted: false,
      tokenFileRemoved: true,
      tokenGenerated: true,
      tokenLengthBytes: 32,
      tokenMatched: true,
      tokenWrittenRootOnly: true,
      unboundDeployed: true,
      updateAttempts: 2,
    },
    prefixes: {
      allowlistSha256: digest("7"),
      canonical: true,
      createDate: "2026-08-08T11:58:00Z",
      documentSha256: digest("8"),
      exactService: true,
      fetchedAt: "2026-08-08T12:00:05Z",
      firewallMatched: true,
      fresh: true,
      ipv4Count: 12,
      ipv6Count: 4,
      service: "CLOUDFRONT_ORIGIN_FACING",
      source: "AWS_PUBLIC_IP_RANGES",
      syncToken: "1754654280",
    },
    firewall: {
      afterSha256: digest("9"),
      beforeSha256: digest("9"),
      closeAmbiguous: false,
      closeAttemptedFirst: true,
      closeObserved: true,
      exactPrefixSet: true,
      finalClosed: true,
      openObserved: true,
      openedSha256: digest("d"),
      port80Closed: true,
      sshUnchanged: true,
      tcp443Only: true,
      udpClosed: true,
      wildcardAbsent: true,
    },
    watchdog: {
      activeBeforeIngress: true,
      armedAt: "2026-08-08T12:00:20Z",
      armedBeforeIngress: true,
      armedBoottimeMilliseconds: 100_000,
      bootIdSha256: digest("b"),
      caddyFenced: true,
      closedBoottimeMilliseconds: 180_000,
      deadlineAt: "2026-08-08T12:04:50Z",
      deadlineBoottimeMilliseconds: 370_000,
      disarmed: true,
      failSafeContained: true,
      maintenanceStopped: true,
      markerComplete: true,
      monotonicBounded: true,
      monotonicDurationMilliseconds: 80_000,
      publicListenersClosed: true,
      timer: "refunddesk-edge-window-watchdog.timer",
      triggered: false,
      unit: "refunddesk-edge-window-watchdog.service",
      workerFenced: true,
    },
    probes: {
      finalPostflight: {
        capturedAt: "2026-08-08T12:01:35Z",
        contained: true,
        evidenceSha256: digest("1"),
        officialValidator: true,
        revisionMatches: true,
        validationSha256: digest("2"),
        validUntil: "2026-08-08T12:16:35Z",
      },
      localCaddy: {
        backendStripStatus: 401,
        correctTokenStatus: 200,
        missingTokenStatus: 404,
        tokenStripped: true,
        wrongTokenStatus: 404,
      },
      publicHealth: {
        cloudFrontObserved: true,
        noStore: true,
        revisionMatches: true,
        status: 200,
      },
      workbench: {
        attestationSha256: digest("e"),
        capturedAt: "2026-08-08T12:01:00Z",
        cliUsed: false,
        createNewObserved: true,
        createdAfterOpen: true,
        createdBeforeDeadline: true,
        duplicate: true,
        eventFingerprintSha256: fingerprint,
        httpStatus: 200,
        nonceMatches: true,
        revisionMatches: true,
        source: "OPERATOR_WORKBENCH",
      },
    },
    counts: {
      after: snapshot(),
      before: snapshot(),
      during: snapshot(),
      quiescent: true,
      unchanged: true,
    },
    database: {
      after: {
        activeWorkflows: 0,
        liveInstallations: 0,
        liveTenants: 0,
        preparedTransactions: 0,
        systemIdentifierSha256: digest("6"),
      },
      before: {
        activeWorkflows: 0,
        liveInstallations: 0,
        liveTenants: 0,
        preparedTransactions: 0,
        systemIdentifierSha256: digest("6"),
      },
      during: {
        activeWorkflows: 0,
        liveInstallations: 0,
        liveTenants: 0,
        preparedTransactions: 0,
        systemIdentifierSha256: digest("6"),
      },
      quiescent: true,
      stable: true,
    },
    containment: {
      awsIngressClosed: true,
      caddyStopped: true,
      coreHealthy: true,
      finalPostflightContained: true,
      finalPostflightPass: true,
      financialQuiescent: true,
      financialStable: true,
      liveDisabled: true,
      maintenanceStopped: true,
      markerComplete: true,
      originHeaderRemoved: true,
      publicListenersClosed: true,
      tokenRemoved: true,
      watchdogDisarmed: true,
      workerStopped: true,
    },
    mutations: {
      caddyStarts: 1,
      containersRestartFenced: 2,
      containersStopped: 2,
      firewallCloses: 1,
      firewallOpens: 1,
      markerTransitions: 8,
      originUpdates: 2,
      unitsStopRequested: 5,
      watchdogArms: 1,
    },
    topology: {
      accountMatched: true,
      aliasMatched: true,
      awsAccountIdSha256: digest("5"),
      awsRegionSha256: digest("8"),
      distributionDeployed: true,
      distributionEnabled: true,
      finalCaddyContainerIdSha256: digest("7"),
      hostRevisionMatched: true,
      hostSourcesMatched: true,
      instanceMatched: true,
      instanceRunning: true,
      originDomainMatched: true,
      runtimeContainersMatched: true,
      sshCidrSha256: digest("9"),
      sshInstanceMatched: true,
    },
    provenance: {
      fixtureOnly: true,
      operationRemainingSecondsAtRunnerStart: 1860,
      operatorBootIdentifierSha256: digest("d"),
      operatorControlCalculatedMonotonicMilliseconds: 1_000_000,
      operatorDeadlineMonotonicMilliseconds: 3_100_000,
      operatorLockHeld: true,
      operatorStartedMonotonicMilliseconds: 1_000_000,
      repositoryHead: revision,
      repositoryIndexSha256: digest("f"),
      runnerBootIdentifierSha256: digest("e"),
      runnerDeadlineBoottimeMilliseconds: 2_360_000,
      runnerStartedBoottimeMilliseconds: 500_000,
      sourceBundleSha256: digest("0"),
      sources: sourcePaths.map((path, index) => {
        const sourceSha256 = canonicalSha256({ path, index });
        return { headSha256: sourceSha256, indexSha256: sourceSha256, path, sourceSha256 };
      }),
      sourcesExact: true,
      transportInputsSha256: digest("a"),
      transportInputsPinned: true,
      toolImageIdSha256: digest("b"),
      workflowRunId: 31269550192,
      workflowRunObservationSha256: digest("c"),
    },
    redaction: {
      arbitraryPathPresent: false,
      customerDataPresent: false,
      ipAddressPresent: false,
      keyDigestPresent: false,
      rawApiKeyPresent: false,
      rawPayloadPresent: false,
      rawSecretPresent: false,
      rawSignaturePresent: false,
      stderrPresent: false,
      stripeIdentifierPresent: false,
    },
  };
  document.provenance.repositoryIndexSha256 = canonicalSha256(
    document.provenance.sources.map(({ indexSha256, path }) => ({ indexSha256, path })),
  );
  document.provenance.sourceBundleSha256 = canonicalSha256(document.provenance.sources);
  return document;
}

if (process.argv[2] === "--write-contract-fixtures") {
  const outputDirectory = process.argv[3];
  if (!outputDirectory) {
    throw new Error("contract fixture output directory is required");
  }
  const fixtures = [
    ["pass", nonce, 0, "PASS", "PASS_EDGE_WINDOW_RECONTAINED"],
    ["fail", "d".repeat(64), 20, "FAIL", "LOCAL_PROBE_FAILED"],
    ["incomplete", "e".repeat(64), 21, "INCOMPLETE", "CONTROL_PLANE_UNAVAILABLE"],
    ["effect-ambiguous", "f".repeat(64), 21, "INCOMPLETE", "CONTROL_PLANE_UNAVAILABLE"],
  ];
  for (const [name, fixtureNonce, exitCode, result, code] of fixtures) {
    const document = validDocument();
    document.nonce = fixtureNonce;
    document.exitCode = exitCode;
    document.result = result;
    document.code = code;
    document.diagnostics = exitCode === 0 ? [] : [code];
    document.window.state = exitCode === 0 ? "complete" : "failed_closed";
    if (name === "effect-ambiguous") {
      document.firewall.finalClosed = false;
      document.firewall.closeAmbiguous = true;
      document.firewall.closeObserved = false;
      document.containment.awsIngressClosed = false;
      document.containment.originHeaderRemoved = false;
      document.containment.tokenRemoved = false;
      document.containment.watchdogDisarmed = false;
      document.origin.bound = false;
      document.origin.headerRemoved = false;
      document.origin.tokenFileRemoved = false;
      document.origin.tokenGenerated = false;
      document.watchdog.disarmed = false;
      document.mutations.firewallOpens = 0;
      document.mutations.originUpdates = 0;
      document.mutations.watchdogArms = 0;
    }
    writeFileSync(join(outputDirectory, `${name}.json`), canonicalBytes(document), {
      flag: "wx",
    });
  }
  process.stdout.write("PASS_EDGE_WINDOW_CONTRACT_FIXTURES_WRITTEN\n");
  process.exit(0);
}

const options = {
  allowFixture: true,
  expectedNonce: nonce,
  expectedRevision: revision,
  notAfter: "2026-08-08T12:02:00Z",
  notBefore: "2026-08-08T11:59:59Z",
  processExitCode: 0,
  schema,
};

function assertInvalid(document, code, optionOverrides = {}) {
  assert.throws(
    () => validateEdgeWindowDocument(document, { ...options, ...optionOverrides }),
    (error) =>
      error instanceof EdgeWindowValidationError &&
      (code === undefined || error.code.includes(code)),
  );
}

test("accepts the strict canonical PASS edge-window document", () => {
  const document = validDocument();
  const parsed = parseCanonicalEdgeWindowDocument(canonicalBytes(document));
  assert.equal(validateEdgeWindowDocument(parsed, options), parsed);
});

test("binds the operator monotonic clock and conservative runner handoff grant", () => {
  const overGrant = validDocument();
  overGrant.provenance.operationRemainingSecondsAtRunnerStart = 1861;
  assertInvalid(overGrant);

  const shiftedDeadline = validDocument();
  shiftedDeadline.provenance.operatorDeadlineMonotonicMilliseconds += 1;
  assertInvalid(shiftedDeadline, "OPERATOR_CLOCK_PROVENANCE_INVALID");

  const unsafeInteger = validDocument();
  unsafeInteger.provenance.operatorStartedMonotonicMilliseconds = Number.MAX_SAFE_INTEGER + 1;
  unsafeInteger.provenance.operatorDeadlineMonotonicMilliseconds =
    unsafeInteger.provenance.operatorStartedMonotonicMilliseconds + 2_100_000;
  assertInvalid(unsafeInteger);
});

test("admits a separately bounded 35-minute orchestration but rejects one second more", () => {
  const atLimit = validDocument();
  atLimit.startedAt = "2026-08-08T12:20:00Z";
  atLimit.completedAt = "2026-08-08T12:35:00Z";
  atLimit.window.openedAt = "2026-08-08T12:20:30Z";
  atLimit.window.closedAt = "2026-08-08T12:21:30Z";
  atLimit.window.deadlineAt = "2026-08-08T12:24:50Z";
  atLimit.watchdog.armedAt = "2026-08-08T12:20:20Z";
  atLimit.watchdog.deadlineAt = "2026-08-08T12:24:50Z";
  atLimit.prefixes.fetchedAt = "2026-08-08T12:20:05Z";
  atLimit.probes.workbench.capturedAt = "2026-08-08T12:21:00Z";
  atLimit.probes.finalPostflight.capturedAt = "2026-08-08T12:34:55Z";
  atLimit.probes.finalPostflight.validUntil = "2026-08-08T12:36:00Z";
  assert.doesNotThrow(() =>
    validateEdgeWindowDocument(atLimit, { ...options, notAfter: "2026-08-08T12:36:00Z" }),
  );

  const overLimit = cloneJson(atLimit);
  overLimit.completedAt = "2026-08-08T12:35:01Z";
  assert.throws(
    () => validateEdgeWindowDocument(overLimit, { ...options, notAfter: "2026-08-08T12:36:00Z" }),
    (error) =>
      error instanceof EdgeWindowValidationError && error.code === "EXECUTION_DURATION_INVALID",
  );
});

test("admits 12-to-15-minute point-in-time inputs and requires authorization across the operation", () => {
  const overstatedFreshness = validDocument();
  overstatedFreshness.admission.postflightRemainingSecondsAtStart = 900;
  overstatedFreshness.admission.postflightValidUntil = "2026-08-08T12:05:00Z";
  assertInvalid(overstatedFreshness, "ADMISSION_INVALID");

  const authorizationStartsLate = validDocument();
  authorizationStartsLate.operationStartedAt = "2026-08-08T11:49:00Z";
  authorizationStartsLate.admission.authorizationValidFrom = "2026-08-08T11:50:00Z";
  assertInvalid(authorizationStartsLate, "ADMISSION_INVALID");

  const windowExceedsAuthorization = validDocument();
  windowExceedsAuthorization.admission.authorizationMaxWindowSeconds = 299;
  assertInvalid(windowExceedsAuthorization, "ADMISSION_INVALID");

  const authorizationExpiresDuringCleanup = validDocument();
  authorizationExpiresDuringCleanup.completedAt = "2026-08-08T12:31:00Z";
  authorizationExpiresDuringCleanup.admission.authorizationValidUntil = "2026-08-08T12:30:00Z";
  authorizationExpiresDuringCleanup.probes.finalPostflight.validUntil = "2026-08-08T12:32:00Z";
  assertInvalid(authorizationExpiresDuringCleanup, "ADMISSION_INVALID", {
    notAfter: "2026-08-08T12:32:00Z",
  });

  const authorizationExpiresBeforeArmedDeadline = validDocument();
  authorizationExpiresBeforeArmedDeadline.admission.authorizationValidUntil =
    "2026-08-08T12:03:00Z";
  assertInvalid(authorizationExpiresBeforeArmedDeadline, "ADMISSION_INVALID");

  const authorizationDoesNotCoverOperationBudget = validDocument();
  authorizationDoesNotCoverOperationBudget.admission.authorizationValidUntil =
    "2026-08-08T12:20:00Z";
  assertInvalid(authorizationDoesNotCoverOperationBudget, "ADMISSION_INVALID");

  const postflightAfterStart = validDocument();
  postflightAfterStart.admission.postflightCapturedAt = "2026-08-08T12:00:01Z";
  assertInvalid(postflightAfterStart, "ADMISSION_INVALID");

  const postflightAfterIncident = validDocument();
  postflightAfterIncident.admission.postflightCapturedAt = "2026-08-08T11:59:31Z";
  assertInvalid(postflightAfterIncident, "ADMISSION_INVALID");

  const productionFaithfulOrder = validDocument();
  productionFaithfulOrder.admission.postflightCapturedAt = "2026-08-08T11:59:00Z";
  productionFaithfulOrder.admission.incidentCapturedAt = "2026-08-08T11:59:30Z";
  assert.doesNotThrow(() => validateEdgeWindowDocument(productionFaithfulOrder, options));

  const pointInTimeInputsExpireBeforeCompletion = validDocument();
  pointInTimeInputsExpireBeforeCompletion.completedAt = "2026-08-08T12:16:00Z";
  pointInTimeInputsExpireBeforeCompletion.probes.finalPostflight.capturedAt =
    "2026-08-08T12:15:30Z";
  pointInTimeInputsExpireBeforeCompletion.probes.finalPostflight.validUntil =
    "2026-08-08T12:20:00Z";
  assert.doesNotThrow(() =>
    validateEdgeWindowDocument(pointInTimeInputsExpireBeforeCompletion, {
      ...options,
      notAfter: "2026-08-08T12:16:00Z",
    }),
  );

  for (const [field, seconds] of [
    ["incidentValidUntil", 719],
    ["incidentValidUntil", 901],
    ["postflightValidUntil", 719],
    ["postflightValidUntil", 901],
  ]) {
    const outsideAdmissionRange = validDocument();
    outsideAdmissionRange.admission[field] =
      `2026-08-08T12:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}Z`;
    assertInvalid(outsideAdmissionRange, "ADMISSION_INVALID");
  }
});

test("completedAt cannot precede AWS close or the official final postflight", () => {
  const beforeClose = validDocument();
  beforeClose.completedAt = "2026-08-08T12:01:29Z";
  assertInvalid(beforeClose, "WINDOW_ORDER_INVALID");

  const beforePostflight = validDocument();
  beforePostflight.completedAt = "2026-08-08T12:01:34Z";
  assertInvalid(beforePostflight, "FUNCTIONAL_PROOF_INVALID");
});

test("rejects non-canonical bytes, unknown keys, secrets, IP addresses and oversize output", () => {
  const document = validDocument();
  assert.throws(() =>
    parseCanonicalEdgeWindowDocument(Buffer.from(`${JSON.stringify(document)}\n`)),
  );
  assert.throws(() =>
    parseCanonicalEdgeWindowDocument(Buffer.from(`${JSON.stringify(sortJsonKeys(document))}\r\n`)),
  );
  const unknown = cloneJson(document);
  unknown.extra = true;
  assertInvalid(unknown, "ADDITIONAL_PROPERTY");
  const secret = cloneJson(document);
  secret.code = "sk_test_abcdefghijklmnop";
  assert.throws(() => parseCanonicalEdgeWindowDocument(canonicalBytes(secret)), /SECRET/u);
  const ip = cloneJson(document);
  ip.code = "ADDRESS_203.0.113.4";
  assert.throws(() => parseCanonicalEdgeWindowDocument(canonicalBytes(ip)), /IP_ADDRESS/u);
  assert.throws(() =>
    parseCanonicalEdgeWindowDocument(Buffer.alloc(MAX_EDGE_WINDOW_DOCUMENT_BYTES + 1, 0x20)),
  );
});

test("rejects an ETag race and a distribution that never becomes Deployed", () => {
  const race = validDocument();
  race.origin.etagBindMatched = false;
  assertInvalid(race, "ORIGIN_PROOF");

  const neverDeployed = validDocument();
  neverDeployed.origin.boundDeployed = false;
  assertInvalid(neverDeployed, "ORIGIN_PROOF");
});

test("joins the observed distribution and origin digests to the exact authorization", () => {
  const distributionDrift = validDocument();
  distributionDrift.origin.distributionIdSha256 = digest("5");
  assertInvalid(distributionDrift, "ORIGIN_PROOF");

  const originDrift = validDocument();
  originDrift.origin.originIdSha256 = digest("6");
  assertInvalid(originDrift, "ORIGIN_PROOF");

  const missingFinalCaddy = validDocument();
  missingFinalCaddy.topology.finalCaddyContainerIdSha256 = "0".repeat(64);
  assertInvalid(missingFinalCaddy, "TOPOLOGY_PROOF");

  const duplicatePromotionRuntime = validDocument();
  duplicatePromotionRuntime.admission.promotionWorkerContainerIdSha256 =
    duplicatePromotionRuntime.admission.promotionWebContainerIdSha256;
  assertInvalid(duplicatePromotionRuntime, "ADMISSION_INVALID");

  const finalCaddyAliasesPostgres = validDocument();
  finalCaddyAliasesPostgres.topology.finalCaddyContainerIdSha256 =
    finalCaddyAliasesPostgres.admission.promotionPostgresContainerIdSha256;
  assertInvalid(finalCaddyAliasesPostgres, "TOPOLOGY_PROOF");

  const accountProjectionDrift = validDocument();
  accountProjectionDrift.topology.awsAccountIdSha256 = digest("4");
  assertInvalid(accountProjectionDrift, "TOPOLOGY_PROOF");

  const regionProjectionDrift = validDocument();
  regionProjectionDrift.topology.awsRegionSha256 = digest("4");
  assertInvalid(regionProjectionDrift, "TOPOLOGY_PROOF");

  const sshCidrProjectionDrift = validDocument();
  sshCidrProjectionDrift.topology.sshCidrSha256 = digest("4");
  assertInvalid(sshCidrProjectionDrift, "TOPOLOGY_PROOF");
});

test("rejects stale or malformed CloudFront origin-facing prefix material", () => {
  const stale = validDocument();
  stale.prefixes.fresh = false;
  assertInvalid(stale, "PREFIX_PROOF");

  const malformed = validDocument();
  malformed.prefixes.syncToken = "not-a-token";
  assertInvalid(malformed, "PATTERN");

  const empty = validDocument();
  empty.prefixes.ipv6Count = 0;
  assertInvalid(empty, "PREFIX_PROOF");

  const oldDocument = validDocument();
  oldDocument.prefixes.createDate = "2026-07-01T00:00:00Z";
  assertInvalid(oldDocument, "PREFIX_PROOF");

  const futureDocument = validDocument();
  futureDocument.prefixes.createDate = "2026-08-08T12:03:01Z";
  assertInvalid(futureDocument, "PREFIX_PROOF");

  const malformedDate = validDocument();
  malformedDate.prefixes.createDate = "2026-08-08-11-58-00";
  assertInvalid(malformedDate, "SCHEMA_ROOT_prefixes_createDate_TIMESTAMP_INVALID");
});

test("rejects wildcard, port 80, UDP and SSH drift in the open firewall snapshot", () => {
  for (const key of ["wildcardAbsent", "port80Closed", "udpClosed", "sshUnchanged"]) {
    const document = validDocument();
    document.firewall[key] = false;
    assertInvalid(document, "FIREWALL_PROOF");
  }
});

test("represents close ambiguity as non-PASS and rejects an uncontained PASS", () => {
  const ambiguity = validDocument();
  ambiguity.result = "INCOMPLETE";
  ambiguity.code = "FIREWALL_CLOSE_AMBIGUOUS";
  ambiguity.exitCode = 21;
  ambiguity.diagnostics = [ambiguity.code];
  ambiguity.window.state = "failed_closed";
  ambiguity.firewall.closeAmbiguous = true;
  ambiguity.firewall.finalClosed = false;
  ambiguity.containment.awsIngressClosed = false;
  const falselyReleasedAmbiguity = cloneJson(ambiguity);
  assertInvalid(falselyReleasedAmbiguity, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 21,
  });
  ambiguity.watchdog.disarmed = false;
  ambiguity.watchdog.markerComplete = false;
  ambiguity.containment.watchdogDisarmed = false;
  ambiguity.containment.markerComplete = false;
  assert.equal(
    validateEdgeWindowDocument(ambiguity, { ...options, processExitCode: 21 }),
    ambiguity,
  );

  const falseTerminalFailure = cloneJson(ambiguity);
  falseTerminalFailure.result = "FAIL";
  falseTerminalFailure.exitCode = 20;
  assertInvalid(falseTerminalFailure, "FAIL_IDENTITY_INVALID", { processExitCode: 20 });

  const notContained = validDocument();
  notContained.containment.caddyStopped = false;
  assertInvalid(notContained, "FINAL_CONTAINMENT");
});

test("admits only a retained INCOMPLETE host-containment failure after AWS closure", () => {
  const retained = validDocument();
  retained.result = "INCOMPLETE";
  retained.code = "FINAL_CONTAINMENT_FAILED";
  retained.exitCode = 21;
  retained.diagnostics = [retained.code];
  retained.window.state = "failed_closed";
  retained.containment.caddyStopped = false;
  retained.containment.publicListenersClosed = false;
  retained.containment.markerComplete = false;
  retained.containment.tokenRemoved = false;
  retained.containment.watchdogDisarmed = false;
  retained.origin.tokenFileRemoved = false;
  retained.watchdog.disarmed = false;
  retained.watchdog.markerComplete = false;
  assert.equal(validateEdgeWindowDocument(retained, { ...options, processExitCode: 21 }), retained);

  const falseFail = cloneJson(retained);
  falseFail.result = "FAIL";
  falseFail.exitCode = 20;
  assertInvalid(falseFail, "OPENED_WINDOW_NOT_RECONTAINED", { processExitCode: 20 });

  const awsUncertain = cloneJson(retained);
  awsUncertain.firewall.finalClosed = false;
  awsUncertain.containment.awsIngressClosed = false;
  assertInvalid(awsUncertain, "INCOMPLETE_CONTAINMENT_IDENTITY_INVALID", {
    processExitCode: 21,
  });

  const falselyReleased = cloneJson(retained);
  falselyReleased.watchdog.disarmed = true;
  falselyReleased.watchdog.markerComplete = true;
  falselyReleased.containment.watchdogDisarmed = true;
  falselyReleased.containment.markerComplete = true;
  assertInvalid(falselyReleased, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 21,
  });

  const retainedPostflight = validDocument();
  retainedPostflight.result = "INCOMPLETE";
  retainedPostflight.code = "FINAL_CONTAINMENT_FAILED";
  retainedPostflight.exitCode = 21;
  retainedPostflight.diagnostics = [retainedPostflight.code];
  retainedPostflight.window.state = "failed_closed";
  retainedPostflight.watchdog.disarmed = false;
  retainedPostflight.watchdog.markerComplete = false;
  retainedPostflight.containment.watchdogDisarmed = false;
  retainedPostflight.containment.markerComplete = false;
  retainedPostflight.containment.finalPostflightContained = false;
  retainedPostflight.containment.finalPostflightPass = false;
  retainedPostflight.probes.finalPostflight.contained = false;
  retainedPostflight.probes.finalPostflight.officialValidator = false;
  retainedPostflight.probes.finalPostflight.revisionMatches = false;
  assert.equal(
    validateEdgeWindowDocument(retainedPostflight, { ...options, processExitCode: 21 }),
    retainedPostflight,
  );

  const retainedSecretGc = cloneJson(retainedPostflight);
  retainedSecretGc.containment.finalPostflightContained = true;
  retainedSecretGc.containment.finalPostflightPass = true;
  retainedSecretGc.probes.finalPostflight.contained = true;
  retainedSecretGc.probes.finalPostflight.officialValidator = true;
  retainedSecretGc.probes.finalPostflight.revisionMatches = true;
  retainedSecretGc.origin.tokenFileRemoved = false;
  retainedSecretGc.containment.tokenRemoved = false;
  assert.equal(
    validateEdgeWindowDocument(retainedSecretGc, { ...options, processExitCode: 21 }),
    retainedSecretGc,
  );

  const falselyReleasedProvider = cloneJson(retainedPostflight);
  falselyReleasedProvider.watchdog.disarmed = true;
  falselyReleasedProvider.watchdog.markerComplete = true;
  falselyReleasedProvider.containment.watchdogDisarmed = true;
  falselyReleasedProvider.containment.markerComplete = true;
  falselyReleasedProvider.origin.headerRemoved = false;
  falselyReleasedProvider.origin.unboundDeployed = false;
  falselyReleasedProvider.containment.originHeaderRemoved = false;
  assertInvalid(falselyReleasedProvider, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 21,
  });

  const convergedTemporal = validDocument();
  convergedTemporal.result = "INCOMPLETE";
  convergedTemporal.code = "FINAL_CONTAINMENT_FAILED";
  convergedTemporal.exitCode = 21;
  convergedTemporal.diagnostics = [convergedTemporal.code];
  convergedTemporal.window.state = "failed_closed";
  convergedTemporal.watchdog.monotonicBounded = false;
  assert.equal(
    validateEdgeWindowDocument(convergedTemporal, { ...options, processExitCode: 21 }),
    convergedTemporal,
  );

  const convergedLostAttribution = cloneJson(convergedTemporal);
  convergedLostAttribution.watchdog.monotonicBounded = true;
  convergedLostAttribution.origin.etagUnbindMatched = false;
  assert.equal(
    validateEdgeWindowDocument(convergedLostAttribution, { ...options, processExitCode: 21 }),
    convergedLostAttribution,
  );

  const labelOnly = validDocument();
  labelOnly.result = "INCOMPLETE";
  labelOnly.code = "FINAL_CONTAINMENT_FAILED";
  labelOnly.exitCode = 21;
  labelOnly.diagnostics = [labelOnly.code];
  labelOnly.window.state = "failed_closed";
  assertInvalid(labelOnly, "INCOMPLETE_CONTAINMENT_IDENTITY_INVALID", {
    processExitCode: 21,
  });

  const releasedProviderDrift = cloneJson(convergedTemporal);
  releasedProviderDrift.watchdog.monotonicBounded = true;
  releasedProviderDrift.containment.originHeaderRemoved = false;
  releasedProviderDrift.origin.headerRemoved = false;
  releasedProviderDrift.origin.unboundDeployed = false;
  assert.equal(
    validateEdgeWindowDocument(releasedProviderDrift, { ...options, processExitCode: 21 }),
    releasedProviderDrift,
  );

  const providerDriftWithFalselyReleasedLease = cloneJson(releasedProviderDrift);
  providerDriftWithFalselyReleasedLease.interlocksAtCapture.authorizationMarkerState = "complete";
  providerDriftWithFalselyReleasedLease.interlocksAtCapture.hostLeaseMarkerState = "complete";
  providerDriftWithFalselyReleasedLease.interlocksAtCapture.holderActive = false;
  assertInvalid(providerDriftWithFalselyReleasedLease, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 21,
  });

  const convergedButUnsafe = cloneJson(convergedTemporal);
  convergedButUnsafe.containment.caddyStopped = false;
  assertInvalid(convergedButUnsafe, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 21,
  });
});

test("failure identities are allowlisted, diagnostic-bound and failed-closed", () => {
  const validFailure = validDocument();
  validFailure.result = "FAIL";
  validFailure.code = "FINAL_CONTAINMENT_FAILED";
  validFailure.exitCode = 20;
  validFailure.diagnostics = [validFailure.code];
  validFailure.window.state = "failed_closed";
  assert.equal(
    validateEdgeWindowDocument(validFailure, { ...options, processExitCode: 20 }),
    validFailure,
  );

  const unknown = cloneJson(validFailure);
  unknown.code = "ARBITRARY_FAKE";
  unknown.diagnostics = [unknown.code];
  assertInvalid(unknown, undefined, { processExitCode: 20 });

  const mismatched = cloneJson(validFailure);
  mismatched.diagnostics = ["TOPOLOGY_BINDING_INVALID"];
  assertInvalid(mismatched, "FAIL_IDENTITY_INVALID", { processExitCode: 20 });

  const falselyComplete = cloneJson(validFailure);
  falselyComplete.window.state = "complete";
  assertInvalid(falselyComplete, "FAIL_IDENTITY_INVALID", { processExitCode: 20 });

  const originStillBound = cloneJson(validFailure);
  originStillBound.origin.etagUnbindMatched = false;
  originStillBound.origin.headerRemoved = false;
  originStillBound.origin.unboundDeployed = false;
  originStillBound.containment.originHeaderRemoved = false;
  assertInvalid(originStillBound, "INTERLOCK_PROFILE_INVALID", { processExitCode: 20 });

  const tokenStillRetained = cloneJson(validFailure);
  tokenStillRetained.origin.tokenFileRemoved = false;
  tokenStillRetained.containment.tokenRemoved = false;
  assertInvalid(tokenStillRetained, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 20,
  });

  const watchdogStillArmed = cloneJson(validFailure);
  watchdogStillArmed.watchdog.disarmed = false;
  watchdogStillArmed.watchdog.markerComplete = false;
  watchdogStillArmed.containment.watchdogDisarmed = false;
  watchdogStillArmed.containment.markerComplete = false;
  assertInvalid(watchdogStillArmed, "OPENED_WINDOW_NOT_RECONTAINED", {
    processExitCode: 20,
  });

  const preIngressOriginEffect = cloneJson(originStillBound);
  preIngressOriginEffect.window.openedAt = null;
  preIngressOriginEffect.window.closedAt = null;
  preIngressOriginEffect.firewall.openObserved = false;
  preIngressOriginEffect.firewall.openedSha256 = null;
  preIngressOriginEffect.mutations.firewallOpens = 0;
  assertInvalid(preIngressOriginEffect, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 20,
  });

  const unattributedFirewallOpen = cloneJson(validFailure);
  unattributedFirewallOpen.window.openedAt = null;
  unattributedFirewallOpen.window.closedAt = null;
  assertInvalid(unattributedFirewallOpen, "WINDOW_EFFECT_ORDER_INVALID", {
    processExitCode: 20,
  });

  const validIncomplete = cloneJson(validFailure);
  validIncomplete.result = "INCOMPLETE";
  validIncomplete.code = "CONTROL_PLANE_UNAVAILABLE";
  validIncomplete.exitCode = 21;
  validIncomplete.diagnostics = [validIncomplete.code];
  assert.equal(
    validateEdgeWindowDocument(validIncomplete, { ...options, processExitCode: 21 }),
    validIncomplete,
  );

  const controlUnavailableButReleasedUnsafe = cloneJson(validIncomplete);
  controlUnavailableButReleasedUnsafe.firewall.finalClosed = false;
  controlUnavailableButReleasedUnsafe.containment.awsIngressClosed = false;
  assertInvalid(controlUnavailableButReleasedUnsafe, "INTERLOCK_PROFILE_INVALID", {
    processExitCode: 21,
  });
});

test("rejects duration overflow, pre-open Workbench evidence and changed durable counts", () => {
  const overflow = validDocument();
  overflow.window.durationSeconds = 301;
  overflow.window.deadlineAt = "2026-08-08T12:05:01Z";
  overflow.watchdog.deadlineAt = overflow.window.deadlineAt;
  assertInvalid(overflow);

  const early = validDocument();
  early.probes.workbench.capturedAt = "2026-08-08T12:00:29Z";
  assertInvalid(early, "FUNCTIONAL_PROOF");

  const afterClose = validDocument();
  afterClose.probes.workbench.capturedAt = "2026-08-08T12:02:00Z";
  assertInvalid(afterClose, "FUNCTIONAL_PROOF");

  const changed = validDocument();
  changed.counts.during.refundExecutionAttempts += 1;
  assertInvalid(changed, "DURABLE_COUNTS");
});

test("the final 30 seconds are a containment reserve, never public-window budget", () => {
  const delayedRemoteArm = validDocument();
  delayedRemoteArm.watchdog.deadlineBoottimeMilliseconds = 300_000;
  assert.doesNotThrow(() => validateEdgeWindowDocument(delayedRemoteArm, options));

  const tooLittleRemaining = validDocument();
  tooLittleRemaining.watchdog.deadlineBoottimeMilliseconds = 129_000;
  assertInvalid(tooLittleRemaining, "WATCHDOG_PROOF_INVALID");

  const noReserve = validDocument();
  noReserve.window.deadlineAt = "2026-08-08T12:05:20Z";
  noReserve.watchdog.deadlineAt = noReserve.window.deadlineAt;
  noReserve.watchdog.deadlineBoottimeMilliseconds = 400_000;
  assertInvalid(noReserve, "WATCHDOG_PROOF_INVALID");

  const closeInsideReserve = validDocument();
  closeInsideReserve.watchdog.closedBoottimeMilliseconds = 375_000;
  closeInsideReserve.watchdog.monotonicDurationMilliseconds = 275_000;
  assertInvalid(closeInsideReserve, "WATCHDOG_PROOF_INVALID");

  const armedBeforeInvocation = validDocument();
  armedBeforeInvocation.watchdog.armedAt = "2026-08-08T11:59:59Z";
  armedBeforeInvocation.window.deadlineAt = "2026-08-08T12:04:29Z";
  armedBeforeInvocation.watchdog.deadlineAt = armedBeforeInvocation.window.deadlineAt;
  assertInvalid(armedBeforeInvocation, "WATCHDOG_PROOF_INVALID");

  const failSafeTriggered = validDocument();
  failSafeTriggered.watchdog.triggered = true;
  assertInvalid(failSafeTriggered, "WATCHDOG_PROOF_INVALID");
});

test("Workbench checkpoint is exact, canonical, post-open and never CLI-derived", () => {
  const checkpoint = {
    capturedAt: "2026-08-08T12:01:00Z",
    cliUsed: false,
    duplicate: true,
    eventFingerprintSha256: fingerprint,
    expectedRevision: revision,
    httpStatus: 200,
    kind: "refunddesk.operator-workbench-replay",
    nonce,
    receiver: "REFUNDDESK_CREATE_NEW_V1",
    requestSha256: digest("9"),
    schemaVersion: 1,
    source: "OPERATOR_WORKBENCH",
  };
  const parsed = parseCanonicalWorkbenchCheckpoint(canonicalBytes(checkpoint));
  assert.equal(
    validateWorkbenchCheckpointDocument(parsed, {
      deadlineAt: "2026-08-08T12:05:00Z",
      expectedEventFingerprintSha256: fingerprint,
      expectedNonce: nonce,
      expectedRevision: revision,
      openedAt: "2026-08-08T12:00:30Z",
    }),
    parsed,
  );
  const before = cloneJson(checkpoint);
  before.capturedAt = "2026-08-08T12:00:29Z";
  assert.throws(() =>
    validateWorkbenchCheckpointDocument(before, { openedAt: "2026-08-08T12:00:30Z" }),
  );
  const cli = cloneJson(checkpoint);
  cli.cliUsed = true;
  assert.throws(() => validateWorkbenchCheckpointDocument(cli));
});

test("CLI validates matching fixture evidence and preserves exit 64 for usage", () => {
  const document = validDocument();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "refunddesk-edge-validator-"));
  const temporaryPath = join(temporaryDirectory, "evidence.json");
  writeFileSync(temporaryPath, canonicalBytes(document), { flag: "wx" });
  try {
    const result = spawnSync(
      process.execPath,
      [
        validatorPath,
        temporaryPath,
        schemaPath,
        nonce,
        revision,
        "0",
        "2026-08-08T11:59:59Z",
        "2026-08-08T12:02:00Z",
        "fixture",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "PASS_EDGE_WINDOW_RECONTAINED\n");

    const stdinResult = spawnSync(
      process.execPath,
      [
        validatorPath,
        "-",
        schemaPath,
        nonce,
        revision,
        "0",
        "2026-08-08T11:59:59Z",
        "2026-08-08T12:02:00Z",
        "fixture",
      ],
      { encoding: "utf8", input: canonicalBytes(document) },
    );
    assert.equal(stdinResult.status, 0, stdinResult.stderr);
    assert.equal(stdinResult.stdout, "PASS_EDGE_WINDOW_RECONTAINED\n");

    const oversizedStdin = spawnSync(
      process.execPath,
      [
        validatorPath,
        "-",
        schemaPath,
        nonce,
        revision,
        "0",
        "2026-08-08T11:59:59Z",
        "2026-08-08T12:02:00Z",
        "fixture",
      ],
      { encoding: "utf8", input: Buffer.alloc(MAX_EDGE_WINDOW_DOCUMENT_BYTES + 1, 0x20) },
    );
    assert.equal(oversizedStdin.status, 20);
    assert.equal(oversizedStdin.stderr, "DOCUMENT_SIZE_INVALID\n");
    assert.equal(spawnSync(process.execPath, [validatorPath], { encoding: "utf8" }).status, 64);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
