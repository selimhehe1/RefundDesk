import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  IncidentAdmissionValidationError,
  canonicalJson,
  composeIncidentAdmissionInput,
  parseCanonicalIncidentAdmissionCapture,
  parseCanonicalIncidentAdmissionDocument,
  parseSingleJsonDocument,
  validateDashboardAttestation,
  validateFixtureInput,
  validateIncidentAdmissionCapture,
  validateIncidentAdmissionDocument,
  validatePostflightEvidence,
  validatePromotionEvidence,
} from "./validate-lightsail-incident-admission.mjs";

const REVISION = "1".repeat(40);
const HEAD = "2".repeat(40);
const HEX = Object.freeze({
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
});
const NOW = Date.parse("2026-08-08T20:00:00Z");

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
const CAPTURE_SOURCE_NAMES = [
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
];

function expectCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof IncidentAdmissionValidationError && error.code === code,
  );
}

function dashboard() {
  return {
    accountFingerprints: { managedSandbox: `sha256:${HEX.a}`, platformTest: `sha256:${HEX.b}` },
    activityReview: {
      apiRequestsReviewed: true,
      dashboardActivityReviewed: true,
      reviewedThrough: "2026-08-08T20:00:00Z",
      unexpectedActivity: false,
    },
    candidateFingerprints: {
      managedSandboxEffect: `sha256:${HEX.d}`,
      managedSandboxRead: `sha256:${HEX.c}`,
      stripeAppSigning: `sha256:${HEX.e}`,
    },
    containment: {
      caddyStopped: true,
      liveDisabled: true,
      maintenanceStopped: true,
      portsClosed: true,
      workerStopped: true,
    },
    containmentCapturedAt: "2026-08-08T20:00:00Z",
    containmentValidUntil: "2026-08-08T20:15:00Z",
    credentialRecords: {
      exposedFullAccessTest: { recordSha256: `sha256:${"1".repeat(64)}`, state: "revoked" },
      managedSandboxEffect: { recordSha256: `sha256:${"2".repeat(64)}`, state: "revoked" },
      managedSandboxRead: { recordSha256: `sha256:${"3".repeat(64)}`, state: "revoked" },
      stripeAppSigning: { recordSha256: `sha256:${"4".repeat(64)}`, state: "revoked" },
      unintendedPlatformLiveCli: { recordSha256: `sha256:${"5".repeat(64)}`, state: "deleted" },
      unintendedPlatformTestCli: { recordSha256: `sha256:${"6".repeat(64)}`, state: "deleted" },
    },
    exposedFingerprints: {
      managedSandboxEffect:
        "sha256:25ce0da57b94ad8b1ad76cf0b4e7a6bdd76151cd0ca007dca68e17063d6d1bcf",
      managedSandboxRead: "sha256:ebfdf77852f715252845466e2c24a791670cb6a5443e8b9c052dde6950dc7626",
      stripeAppSigning: "sha256:b4e042f041ff39315b1378a386817af405788f82ac27b962c2876e508ea09156",
    },
    kind: "refunddesk.stripe.dashboard-incident-attestation",
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
    replacementRows: {
      managedSandboxEffect: {
        active: true,
        chargesRead: true,
        customersRead: false,
        fullAccess: false,
        paymentIntentsRead: true,
        refundsCreate: true,
        refundsRead: true,
        restricted: true,
        unrelatedPermissionCount: 0,
      },
      managedSandboxRead: {
        active: true,
        chargesRead: true,
        customersRead: false,
        fullAccess: false,
        paymentIntentsRead: true,
        refundsCreate: false,
        refundsRead: true,
        restricted: true,
        unrelatedPermissionCount: 0,
      },
      stripeAppSigning: { active: true, current: true, predecessorDisabled: true },
    },
    revocation: {
      exposedFullAccessTest: true,
      exposedManagedSandboxEffect: true,
      exposedManagedSandboxRead: true,
      exposedStripeAppSigning: true,
      unintendedPlatformLiveCliDeleted: true,
      unintendedPlatformTestCliDeleted: true,
    },
    schemaVersion: 1,
    sourceEvidence: {
      apiKeyExposure: "sha256:791c2832500e59b5147e09add7d429e1c871f92e06f73432559156c0d22f9d2f",
      appSigningExposure: "sha256:ab29955376fea135f14646c7b7dcdd512449d1abbd3645c9befaea9246b7395b",
      candidatePreflight: "sha256:ec07ef8b14fee601f7339bf8a3837dee0ba3817601fa8330486e758eab10e606",
      cliAuthentication: "sha256:d51f557fd8f76af871d4a5019eac8e00e4ed465ed487afd05ac6750877ac9da7",
      independentReview: "sha256:613f868c80e52b834b7fe33594f590fea1990c52b155eef9dfcbaf9fc7b9fba2",
    },
  };
}

function fixture() {
  return {
    amountMinor: "1",
    approverUserId: "usr_Approver01",
    currency: "eur",
    denialPaymentIntentId: "pi_Denial001",
    environment: "managed_sandbox",
    kind: "refunddesk.stripe.incident-admission-fixture",
    refundablePaymentIntentId: "pi_Refundable001",
    requesterUserId: "usr_Requester01",
    schemaVersion: 1,
  };
}

function postIncidentBaseline() {
  const counts = {
    activeFinancialJobs: 0,
    auditEvents: 12,
    mutationReceipts: 4,
    refundExecutionAttempts: 2,
    refundExecutions: 2,
    refundRequests: 3,
    unreleasedPaymentGuards: 0,
    webhookReceipts: 0,
  };
  return {
    ...counts,
    snapshotSha256: createHash("sha256").update(JSON.stringify(counts), "ascii").digest("hex"),
  };
}

function postIncidentDatabase() {
  const baseline = postIncidentBaseline();
  return {
    activeFinancialJobs: baseline.activeFinancialJobs,
    activeWorkflows: 0,
    apiMutationReceipts: baseline.mutationReceipts,
    auditEvents: baseline.auditEvents,
    liveInstallations: 0,
    liveTenants: 0,
    preparedTransactions: 0,
    refundExecutionAttempts: baseline.refundExecutionAttempts,
    refundExecutions: baseline.refundExecutions,
    refundRequests: baseline.refundRequests,
    snapshotAvailable: true,
    systemIdentifier: "123456789012345678",
    unreleasedPaymentGuards: baseline.unreleasedPaymentGuards,
    webhookReceipts: baseline.webhookReceipts,
  };
}

function finalCandidateBinding() {
  const digest = (value) => createHash("sha256").update(value, "ascii").digest("hex");
  return {
    caddyContainerIdSha256: digest(HEX.a),
    postgresContainerIdSha256: digest(HEX.b),
    systemIdentifierSha256: digest("123456789012345678"),
    verifierContainerIdSha256: digest(HEX.c),
    webContainerIdSha256: digest(HEX.d),
    workerContainerIdSha256: digest(HEX.e),
  };
}

function promotion() {
  return {
    code: "PASS_CONTAINED_CANDIDATE_PROMOTED",
    completedAt: "2026-08-08T19:59:30Z",
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
      apiMutationReceipts: 2,
      auditEvents: 9,
      liveInstallations: 0,
      liveTenants: 0,
      preparedTransactions: 0,
      refundExecutionAttempts: 1,
      refundExecutions: 1,
      refundRequests: 2,
      snapshotSha256: "d4bfa0dcf30dcf089eedd822c8abcf3493445414e844f771ad8caf6a33400c41",
      stable: true,
      systemIdentifier: "123456789012345678",
      unreleasedPaymentGuards: 0,
      webhookReceipts: 0,
    },
    fromRevision: "0".repeat(40),
    inputs: {
      bundleSha256: HEX.b,
      manifestSha256: HEX.c,
      provenanceSha256: HEX.d,
      sourceSha256: HEX.e,
    },
    kind: "refunddesk-contained-promotion",
    nonce: HEX.f,
    operationStartedAt: "2026-08-08T19:58:30Z",
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
    revision: REVISION,
    runtime: {
      caddyContainerId: HEX.a,
      postgresContainerId: HEX.b,
      verifierContainerId: HEX.c,
      webContainerId: HEX.d,
      workerContainerId: HEX.e,
      workerRuntimeMode: "incident_admission",
    },
    schemaVersion: 1,
    startedAt: "2026-08-08T19:58:30Z",
  };
}

function source() {
  return { gitObject: "3".repeat(40), sha256: HEX.a };
}

function postflight() {
  const identity = {
    activeRevision: REVISION,
    currentRevision: REVISION,
    releaseEnvironmentRevision: REVISION,
    releaseEnvironmentWorkerRuntimeMode: "INCIDENT_ADMISSION",
    sourceRevision: REVISION,
  };
  const containers = [
    { containerId: HEX.b, effectiveWorkerRuntimeMode: null, service: "postgres" },
    { containerId: HEX.c, effectiveWorkerRuntimeMode: null, service: "verifier" },
    { containerId: HEX.e, effectiveWorkerRuntimeMode: "INCIDENT_ADMISSION", service: "worker" },
    { containerId: HEX.d, effectiveWorkerRuntimeMode: null, service: "web" },
    { containerId: HEX.a, effectiveWorkerRuntimeMode: null, service: "caddy" },
  ];
  return {
    admission: "ADMISSIBLE_READ_ONLY",
    awsControlPlane: {
      accountMatches: true,
      firewallClosedAfter: true,
      firewallClosedBefore: true,
      firewallUnchanged: true,
      instanceMatches: true,
      instanceRunning: true,
      regionMatches: true,
      targetId: "documentation-target",
    },
    capturedAt: "2026-08-08T20:00:00Z",
    kind: "refunddesk.lightsail.host-postflight.capture",
    posture: "COHERENT_CONTAINED",
    provenance: {
      fixtureOnly: false,
      observer: source(),
      remoteDocumentSha256: HEX.f,
      repositoryHead: HEAD,
      revisionComposeVerified: true,
      schema: source(),
      transportInputsPinned: true,
      validator: source(),
      wrapper: source(),
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
    },
    remote: {
      captures: {
        a: { containers, identity },
        b: { containers, database: postIncidentDatabase(), identity },
      },
      code: "PASS_CONTAINED",
      containment: {
        caddyStopped: true,
        fenceClosed: true,
        journalsClosed: true,
        liveDisabled: true,
        maintenanceStopped: true,
        publicListenersClosed: true,
        sensitiveModesSafe: true,
        workerStopped: true,
      },
      financial: { quiescent: true, snapshotAvailable: true, stable: true },
      posture: "COHERENT_CONTAINED",
      result: "PASS",
    },
    result: "PASS",
    schemaVersion: 1,
    validUntil: "2026-08-08T20:15:00Z",
  };
}

function admission({ exitCode = 0, code = "PASS_INCIDENT_ADMITTED_CONTAINED" } = {}) {
  const success = exitCode === 0;
  return {
    bindings: {
      accountBindingsExact: success,
      filesMode0600: success,
      managedSandboxEffectMatches: success,
      managedSandboxReadMatches: success,
      predecessorBytesRetested: false,
      stripeAppSigningMatches: success,
    },
    code,
    completedAt: "2026-08-08T20:00:05Z",
    containment: {
      caddyStopped: success,
      coreStable: success,
      financialBaselineQuiescent: success,
      financialDeltaExact: success,
      firewallClosed: success,
      liveDisabled: success,
      maintenanceStopped: success,
      markerComplete: success,
      publicListenersClosed: success,
      sourceExact: success,
      workerStopped: success,
    },
    diagnostics: success ? [] : [code],
    exitCode,
    expectedRevision: REVISION,
    kind: "refunddesk.lightsail.incident-admission",
    marker: {
      complete: success,
      markerTransitions: success ? 5 : 0,
      operationBound: success,
      resumed: false,
      sameIdempotencyKey: success,
      state: success ? "complete" : "absent",
    },
    mutations: {
      markerTransitions: success ? 5 : 0,
      refundsCreated: success ? 1 : 0,
      workerStarts: success ? 1 : 0,
      workerStops: success ? 1 : 0,
      workflowsCreated: success ? 1 : 0,
    },
    nonce: HEX.a,
    postIncidentBaseline: success ? postIncidentBaseline() : null,
    proof: {
      ambiguousResumeSameKey: false,
      appSigningAccepted: success,
      deterministicIdempotency: success,
      guardReleased: success,
      readChargeSucceeded: success,
      readPaymentIntentSucceeded: success,
      readRefundCreateDenied: success,
      refundCount: success ? 1 : 0,
      denialRefundSetUnchanged: success,
      requesterApproverDistinct: success,
      terminalReconciled: success,
      unrelatedSigningRejected: success,
      workerStartedPrivately: success,
      workerStoppedAfter: success,
      workflowCount: success ? 1 : 0,
    },
    promotion: {
      bundleSha256: HEX.b,
      candidateRevision: REVISION,
      contained: success,
      evidenceSha256: HEX.a,
      manifestSha256: HEX.c,
      postflightAfterPromotion: success,
      provenanceSha256: HEX.d,
      sourceSha256: HEX.e,
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
    repositoryHead: HEAD,
    result: success ? "PASS" : exitCode === 20 ? "FAIL" : "INCOMPLETE",
    schemaVersion: 1,
    startedAt: "2026-08-08T20:00:00Z",
  };
}

function capture({
  exitCode = 0,
  code = "PASS_INCIDENT_ADMITTED_CONTAINED",
  fixtureOnly = false,
} = {}) {
  const remote = admission({ exitCode, code });
  const postflightSource = fixtureOnly ? { gitObject: null, sha256: HEX.a } : source();
  const sources = Object.fromEntries(
    CAPTURE_SOURCE_NAMES.map((name, index) => [
      name,
      {
        gitObject: fixtureOnly ? null : `${((index % 9) + 1).toString()}`.repeat(40),
        sha256: `${((index % 6) + 1).toString()}`.repeat(64),
      },
    ]),
  );
  return {
    admission: fixtureOnly
      ? "FIXTURE_ONLY"
      : exitCode === 0
        ? "ADMISSIBLE_CURRENT_STRIPE_BINDING_INCIDENT"
        : "NOT_ADMITTED",
    awsControlPlane: {
      accountMatches: true,
      firewallClosedAfter: true,
      firewallClosedBefore: true,
      firewallUnchanged: true,
      instanceMatches: true,
      regionMatches: true,
      targetId: "refunddesk-sandbox-paris@eu-west-3",
    },
    capturedAt: "2026-08-08T20:00:07Z",
    code: remote.code,
    exitCode,
    finalPostflight: {
      awsControlPlane: {
        accountMatches: true,
        firewallClosedAfter: true,
        firewallClosedBefore: true,
        firewallUnchanged: true,
        instanceMatches: true,
        instanceRunning: true,
        regionMatches: true,
        targetId: "refunddesk-sandbox-paris@eu-west-3",
      },
      candidateBinding: finalCandidateBinding(),
      capturedAt: "2026-08-08T20:00:06Z",
      firewallClosed: true,
      officialValidation: true,
      posture: "COHERENT_CONTAINED",
      postIncidentBaselineSha256: postIncidentBaseline().snapshotSha256,
      provenance: {
        fixtureOnly,
        observer: postflightSource,
        remoteDocumentSha256: HEX.f,
        repositoryHead: fixtureOnly ? null : HEAD,
        revisionComposeVerified: true,
        schema: postflightSource,
        transportInputsPinned: true,
        validator: postflightSource,
        wrapper: postflightSource,
      },
      revision: REVISION,
      sha256: HEX.e,
      validUntil: "2026-08-08T20:15:00Z",
      workerRuntimeMode: "incident_admission",
    },
    kind: "refunddesk.lightsail.incident-admission.capture",
    postIncidentBaseline: postIncidentBaseline(),
    provenance: {
      dashboardAttestationSha256: HEX.a,
      fixtureInputSha256: HEX.b,
      fixtureOnly,
      postflightBeforeSha256: HEX.c,
      promotionEvidenceSha256: HEX.a,
      repositoryHead: HEAD,
      sources,
      transportInputsPinned: true,
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
    remote,
    remoteDocument: {
      exitCode,
      sha256: createHash("sha256").update(canonicalJson(remote)).digest("hex"),
    },
    result: remote.result,
    schemaVersion: 1,
    validUntil: "2026-08-08T20:15:00Z",
  };
}

describe("canonical framing", () => {
  it("accepts one recursively sorted compact object and one LF", () => {
    assert.deepEqual(parseSingleJsonDocument(canonicalJson({ a: { b: true }, z: 1 })), {
      a: { b: true },
      z: 1,
    });
  });

  for (const [name, mutate, code] of [
    ["missing LF", (bytes) => bytes.subarray(0, -1), "DOCUMENT_FRAMING_INVALID"],
    [
      "CRLF",
      (bytes) => Buffer.from(bytes.toString().replace("\n", "\r\n")),
      "DOCUMENT_CONTROL_INVALID",
    ],
    [
      "BOM",
      (bytes) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      "DOCUMENT_BOM_INVALID",
    ],
    [
      "NUL",
      (bytes) => Buffer.concat([bytes.subarray(0, 1), Buffer.from([0]), bytes.subarray(1)]),
      "DOCUMENT_CONTROL_INVALID",
    ],
    ["second document", (bytes) => Buffer.concat([bytes, bytes]), "DOCUMENT_FRAMING_INVALID"],
    ["unsorted", () => Buffer.from('{"z":1,"a":2}\n'), "DOCUMENT_CANONICAL_INVALID"],
  ]) {
    it(`rejects ${name}`, () =>
      expectCode(() => parseSingleJsonDocument(mutate(Buffer.from('{"a":1}\n'))), code));
  }

  it("rejects oversized input", () =>
    expectCode(() => parseSingleJsonDocument(Buffer.alloc(131073, 0x61)), "DOCUMENT_SIZE_INVALID"));
});

describe("Dashboard and fixture inputs", () => {
  it("accepts the exact fresh Dashboard authority and returns only its digest", () => {
    const result = validateDashboardAttestation(dashboard(), { now: NOW });
    assert.match(result.authoritySha256, /^[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(result).includes("pi_"), false);
  });

  it("rejects 719 seconds remaining", () => {
    const value = dashboard();
    value.containmentValidUntil = "2026-08-08T20:11:59Z";
    expectCode(
      () => validateDashboardAttestation(value, { now: NOW }),
      "DASHBOARD_REMAINING_INVALID",
    );
  });

  it("rejects future and over-15-minute windows", () => {
    const future = dashboard();
    future.containmentCapturedAt = "2026-08-08T20:02:01Z";
    future.activityReview.reviewedThrough = future.containmentCapturedAt;
    future.containmentValidUntil = "2026-08-08T20:15:00Z";
    expectCode(
      () => validateDashboardAttestation(future, { now: NOW }),
      "DASHBOARD_FUTURE_INVALID",
    );
    const long = dashboard();
    long.containmentValidUntil = "2026-08-08T20:15:01Z";
    expectCode(() => validateDashboardAttestation(long, { now: NOW }), "DASHBOARD_WINDOW_INVALID");
  });

  it("rejects a wrong historical hash, false revocation and extra key", () => {
    const wrongHash = dashboard();
    wrongHash.sourceEvidence.cliAuthentication = `sha256:${HEX.a}`;
    expectCode(
      () => validateDashboardAttestation(wrongHash, { now: NOW }),
      "DASHBOARD_HISTORICAL_HASH_INVALID",
    );
    const falseRevocation = dashboard();
    falseRevocation.revocation.exposedFullAccessTest = false;
    expectCode(
      () => validateDashboardAttestation(falseRevocation, { now: NOW }),
      "DASHBOARD_REVOCATION_exposedFullAccessTest_INVALID",
    );
    const extra = dashboard();
    extra.accountId = "forbidden";
    expectCode(() => validateDashboardAttestation(extra, { now: NOW }), "DASHBOARD_KEYS_INVALID");
  });

  it("rejects missing redaction and unexpected activity", () => {
    const missing = dashboard();
    delete missing.redaction.stripeIdentifierPresent;
    expectCode(
      () => validateDashboardAttestation(missing, { now: NOW }),
      "DASHBOARD_REDACTION_KEYS_INVALID",
    );
    const activity = dashboard();
    activity.activityReview.unexpectedActivity = true;
    expectCode(
      () => validateDashboardAttestation(activity, { now: NOW }),
      "DASHBOARD_UNEXPECTED_ACTIVITY",
    );
  });

  it("rejects a broad or full-access key merely labelled restricted", () => {
    const broad = dashboard();
    broad.replacementRows.managedSandboxRead.fullAccess = true;
    expectCode(
      () => validateDashboardAttestation(broad, { now: NOW }),
      "DASHBOARD_REPLACEMENT_managedSandboxRead_SCOPE_INVALID",
    );
    const unrelated = dashboard();
    unrelated.replacementRows.managedSandboxEffect.unrelatedPermissionCount = 1;
    expectCode(
      () => validateDashboardAttestation(unrelated, { now: NOW }),
      "DASHBOARD_REPLACEMENT_managedSandboxEffect_SCOPE_INVALID",
    );
  });

  it("binds exact exposed fingerprints and distinct revoked/deleted Dashboard records", () => {
    const reused = dashboard();
    reused.candidateFingerprints.managedSandboxRead = reused.exposedFingerprints.managedSandboxRead;
    expectCode(
      () => validateDashboardAttestation(reused, { now: NOW }),
      "DASHBOARD_CANDIDATE_managedSandboxRead_STILL_EXPOSED",
    );
    const wrongHistorical = dashboard();
    wrongHistorical.exposedFingerprints.stripeAppSigning = `sha256:${HEX.f}`;
    expectCode(
      () => validateDashboardAttestation(wrongHistorical, { now: NOW }),
      "DASHBOARD_EXPOSED_FINGERPRINT_INVALID",
    );
    const scheduled = dashboard();
    scheduled.credentialRecords.managedSandboxEffect.state = "scheduled";
    expectCode(
      () => validateDashboardAttestation(scheduled, { now: NOW }),
      "DASHBOARD_CREDENTIAL_RECORD_managedSandboxEffect_STATE_INVALID",
    );
    const duplicateRecord = dashboard();
    duplicateRecord.credentialRecords.unintendedPlatformLiveCli.recordSha256 =
      duplicateRecord.credentialRecords.unintendedPlatformTestCli.recordSha256;
    expectCode(
      () => validateDashboardAttestation(duplicateRecord, { now: NOW }),
      "DASHBOARD_CREDENTIAL_RECORDS_NOT_DISTINCT",
    );
  });

  it("accepts only distinct synthetic fixture targets and users", () => {
    assert.equal(validateFixtureInput(fixture()), true);
    const sameUser = fixture();
    sameUser.approverUserId = sameUser.requesterUserId;
    expectCode(() => validateFixtureInput(sameUser), "FIXTURE_USERS_NOT_DISTINCT");
    const sameTarget = fixture();
    sameTarget.refundablePaymentIntentId = sameTarget.denialPaymentIntentId;
    expectCode(() => validateFixtureInput(sameTarget), "FIXTURE_TARGETS_NOT_DISTINCT");
    const amount = fixture();
    amount.amountMinor = "2";
    expectCode(() => validateFixtureInput(amount), "FIXTURE_AMOUNT_INVALID");
    const currency = fixture();
    currency.currency = "usd";
    expectCode(() => validateFixtureInput(currency), "FIXTURE_CURRENCY_INVALID");
  });
});

describe("promotion and post-promotion postflight", () => {
  it("accepts the exact contained promotion and exact-R postflight", () => {
    assert.equal(
      validatePromotionEvidence(promotion(), { expectedRevision: REVISION, now: NOW })
        .candidateRevision,
      REVISION,
    );
    assert.equal(
      validatePostflightEvidence(postflight(), { expectedRevision: REVISION, now: NOW }).capturedAt,
      "2026-08-08T20:00:00Z",
    );
  });

  it("rejects another promoted revision and non-contained promotion", () => {
    expectCode(
      () => validatePromotionEvidence(promotion(), { expectedRevision: "9".repeat(40), now: NOW }),
      "PROMOTION_REVISION_MISMATCH",
    );
    const open = promotion();
    open.containment.workerStopped = false;
    expectCode(
      () => validatePromotionEvidence(open, { expectedRevision: REVISION, now: NOW }),
      "PROMOTION_CONTAINMENT_workerStopped_INVALID",
    );
  });

  it("accepts a delayed resumed operation but bounds only its terminal invocation", () => {
    const resumed = promotion();
    resumed.resumed = true;
    resumed.operationStartedAt = "2026-08-08T18:00:00Z";
    assert.equal(
      validatePromotionEvidence(resumed, { expectedRevision: REVISION, now: NOW })
        .candidateRevision,
      REVISION,
    );

    const operationAfterInvocation = promotion();
    operationAfterInvocation.operationStartedAt = "2026-08-08T19:58:31Z";
    expectCode(
      () =>
        validatePromotionEvidence(operationAfterInvocation, {
          expectedRevision: REVISION,
          now: NOW,
        }),
      "PROMOTION_WINDOW_INVALID",
    );

    const nonResumedDrift = promotion();
    nonResumedDrift.operationStartedAt = "2026-08-08T18:00:00Z";
    expectCode(
      () => validatePromotionEvidence(nonResumedDrift, { expectedRevision: REVISION, now: NOW }),
      "PROMOTION_OPERATION_START_INVALID",
    );

    const longTerminalInvocation = promotion();
    longTerminalInvocation.startedAt = "2026-08-08T19:44:29Z";
    longTerminalInvocation.operationStartedAt = longTerminalInvocation.startedAt;
    expectCode(
      () =>
        validatePromotionEvidence(longTerminalInvocation, { expectedRevision: REVISION, now: NOW }),
      "PROMOTION_WINDOW_INVALID",
    );
  });

  it("rejects a postflight still attached to the previous revision", () => {
    const old = postflight();
    old.remote.captures.b.identity.activeRevision = "0".repeat(40);
    expectCode(
      () => validatePostflightEvidence(old, { expectedRevision: REVISION, now: NOW }),
      "POSTFLIGHT_REVISION_INVALID",
    );
  });

  it("requires the contained incident-admission worker mode in both stable captures", () => {
    const normalRelease = postflight();
    normalRelease.remote.captures.b.identity.releaseEnvironmentWorkerRuntimeMode = "NORMAL";
    expectCode(
      () => validatePostflightEvidence(normalRelease, { expectedRevision: REVISION, now: NOW }),
      "POSTFLIGHT_WORKER_RUNTIME_MODE_INVALID",
    );
    const normalWorker = postflight();
    normalWorker.remote.captures.b.containers[2].effectiveWorkerRuntimeMode = "NORMAL";
    expectCode(
      () => validatePostflightEvidence(normalWorker, { expectedRevision: REVISION, now: NOW }),
      "POSTFLIGHT_WORKER_RUNTIME_MODE_INVALID",
    );
  });

  it("rejects a 719-second or reopened postflight", () => {
    const stale = postflight();
    stale.validUntil = "2026-08-08T20:11:59Z";
    expectCode(
      () => validatePostflightEvidence(stale, { expectedRevision: REVISION, now: NOW }),
      "POSTFLIGHT_REMAINING_INVALID",
    );
    const reopened = postflight();
    reopened.remote.containment.publicListenersClosed = false;
    expectCode(
      () => validatePostflightEvidence(reopened, { expectedRevision: REVISION, now: NOW }),
      "POSTFLIGHT_CONTAINMENT_publicListenersClosed_INVALID",
    );
  });

  it("composes only the exact post-promotion Dashboard-bound runner input", () => {
    const composed = composeIncidentAdmissionInput({
      dashboardAttestation: dashboard(),
      expectedRevision: REVISION,
      fixture: fixture(),
      now: NOW,
      postflightEvidence: postflight(),
      promotionEvidence: promotion(),
    });
    assert.deepEqual(Object.keys(composed), [
      "dashboardAttestation",
      "fixture",
      "postflight",
      "promotionEvidence",
    ]);
    assert.deepEqual(composed.postflight, {
      capturedAt: "2026-08-08T20:00:00Z",
      firewallClosed: true,
      revision: REVISION,
      validUntil: "2026-08-08T20:15:00Z",
    });

    const mismatched = dashboard();
    mismatched.containmentCapturedAt = "2026-08-08T20:00:01Z";
    mismatched.activityReview.reviewedThrough = mismatched.containmentCapturedAt;
    expectCode(
      () =>
        composeIncidentAdmissionInput({
          dashboardAttestation: mismatched,
          expectedRevision: REVISION,
          fixture: fixture(),
          now: NOW,
          postflightEvidence: postflight(),
          promotionEvidence: promotion(),
        }),
      "DASHBOARD_POSTFLIGHT_TIME_MISMATCH",
    );

    const beforePromotion = postflight();
    beforePromotion.capturedAt = "2026-08-08T19:58:59Z";
    beforePromotion.validUntil = "2026-08-08T20:13:59Z";
    const boundDashboard = dashboard();
    boundDashboard.containmentCapturedAt = beforePromotion.capturedAt;
    boundDashboard.containmentValidUntil = beforePromotion.validUntil;
    boundDashboard.activityReview.reviewedThrough = beforePromotion.capturedAt;
    expectCode(
      () =>
        composeIncidentAdmissionInput({
          dashboardAttestation: boundDashboard,
          expectedRevision: REVISION,
          fixture: fixture(),
          now: NOW,
          postflightEvidence: beforePromotion,
          promotionEvidence: promotion(),
        }),
      "POSTFLIGHT_PRECEDES_PROMOTION",
    );
  });
});

describe("remote incident-admission document", () => {
  it("accepts exact PASS and exact fail/incomplete envelopes", () => {
    assert.equal(
      parseCanonicalIncidentAdmissionDocument(canonicalJson(admission()), {
        expectedRevision: REVISION,
        now: NOW,
      }).code,
      "PASS_INCIDENT_ADMITTED_CONTAINED",
    );
    assert.equal(
      validateIncidentAdmissionDocument(
        admission({ exitCode: 20, code: "NEW_ROTATION_REQUIRED" }),
        { now: NOW },
      ).result,
      "FAIL",
    );
    assert.equal(
      validateIncidentAdmissionDocument(
        admission({ exitCode: 21, code: "WORKER_PROOF_AMBIGUOUS" }),
        { now: NOW },
      ).result,
      "INCOMPLETE",
    );
  });

  it("rejects a PASS with two workflows or changed promotion revision", () => {
    const two = admission();
    two.proof.workflowCount = 2;
    expectCode(
      () => validateIncidentAdmissionDocument(two, { now: NOW }),
      "PROOF_WORKFLOW_COUNT_INVALID",
    );
    const wrong = admission();
    wrong.promotion.candidateRevision = "9".repeat(40);
    expectCode(
      () => validateIncidentAdmissionDocument(wrong, { now: NOW }),
      "PROMOTION_REVISION_MISMATCH",
    );
  });

  it("requires an exact self-consistent post-incident financial baseline for PASS", () => {
    const missing = admission();
    missing.postIncidentBaseline = null;
    expectCode(
      () => validateIncidentAdmissionDocument(missing, { now: NOW }),
      "PASS_POST_INCIDENT_BASELINE_MISSING",
    );

    const changedDigest = admission();
    changedDigest.postIncidentBaseline.snapshotSha256 = HEX.f;
    expectCode(
      () => validateIncidentAdmissionDocument(changedDigest, { now: NOW }),
      "POST_INCIDENT_BASELINE_SHA_MISMATCH",
    );

    const injected = admission();
    injected.postIncidentBaseline.customerCount = 0;
    expectCode(
      () => validateIncidentAdmissionDocument(injected, { now: NOW }),
      "POST_INCIDENT_BASELINE_KEYS_INVALID",
    );
  });

  it("rejects injected diagnostics, secrets, IDs, paths and addresses", () => {
    const injected = admission({ exitCode: 20, code: "NEW_ROTATION_REQUIRED" });
    injected.diagnostics = ["NEW_ROTATION_REQUIRED\nEVIL"];
    expectCode(
      () => validateIncidentAdmissionDocument(injected, { now: NOW }),
      "DIAGNOSTICS_INVALID",
    );
    for (const [field, value, code] of [
      ["repositoryHead", "not-a-commit-oid", "REPOSITORY_HEAD_INVALID"],
      ["code", "pi_Identifier001", "CODE_INVALID"],
    ]) {
      const candidate = admission();
      candidate[field] = value;
      expectCode(() => validateIncidentAdmissionDocument(candidate, { now: NOW }), code);
    }
    const pathCanary = admission();
    pathCanary.diagnostics = ["TOOL_UNAVAILABLE"];
    pathCanary.code = "TOOL_UNAVAILABLE";
    pathCanary.exitCode = 20;
    pathCanary.result = "FAIL";
    pathCanary.marker.state = "/etc/refunddesk";
    expectCode(
      () => validateIncidentAdmissionDocument(pathCanary, { now: NOW }),
      "MARKER_STATE_INVALID",
    );
  });

  it("keeps the published schema parseable and closed", () => {
    const schema = JSON.parse(
      readFileSync("docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json", "utf8"),
    );
    assert.deepEqual(schema.oneOf, [{ $ref: "#/$defs/capture" }, { $ref: "#/$defs/remote" }]);
    assert.equal(schema.$defs.remote.additionalProperties, false);
    assert.equal(schema.$defs.capture.additionalProperties, false);
    assert.ok(schema.$defs.remote.required.includes("promotion"));
    assert.ok(schema.$defs.remote.required.includes("postIncidentBaseline"));
    assert.ok(schema.$defs.capture.required.includes("finalPostflight"));
    assert.ok(schema.$defs.capture.required.includes("postIncidentBaseline"));
    assert.ok(schema.$defs.finalPostflight.required.includes("candidateBinding"));
    assert.equal(
      schema.$defs.remote.properties.kind.const,
      "refunddesk.lightsail.incident-admission",
    );
    assert.equal(
      schema.$defs.capture.properties.kind.const,
      "refunddesk.lightsail.incident-admission.capture",
    );
    assert.deepEqual(
      [...schema.$defs.captureSources.required].sort(),
      [...CAPTURE_SOURCE_NAMES].sort(),
    );
  });
});

describe("local incident-admission capture", () => {
  it("accepts strict PASS, FAIL and INCOMPLETE captures with exact exit mapping", () => {
    for (const value of [
      capture(),
      capture({ exitCode: 20, code: "NEW_ROTATION_REQUIRED" }),
      capture({ exitCode: 21, code: "WORKER_PROOF_AMBIGUOUS" }),
    ]) {
      assert.equal(
        parseCanonicalIncidentAdmissionCapture(canonicalJson(value), {
          expectedRevision: REVISION,
          now: NOW,
        }).remoteDocument.exitCode,
        value.remote.exitCode,
      );
      const processResult = spawnSync(
        process.execPath,
        [
          "scripts/validate-lightsail-incident-admission.mjs",
          "--kind",
          "capture",
          "--expected-revision",
          REVISION,
          "--now",
          "2026-08-08T20:00:00Z",
        ],
        { encoding: "utf8", input: canonicalJson(value) },
      );
      assert.equal(processResult.status, value.exitCode);
      assert.equal(processResult.stderr, "");
      assert.equal(processResult.stdout, canonicalJson(value).toString("utf8"));
    }
  });

  it("rejects a non-canonical local capture at the CLI boundary", () => {
    const value = capture();
    const nonCanonical = `${JSON.stringify(value)}\n`;
    assert.notEqual(nonCanonical, canonicalJson(value));
    const processResult = spawnSync(
      process.execPath,
      [
        "scripts/validate-lightsail-incident-admission.mjs",
        "--kind",
        "capture",
        "--expected-revision",
        REVISION,
        "--now",
        "2026-08-08T20:00:00Z",
      ],
      { encoding: "utf8", input: nonCanonical },
    );
    assert.equal(processResult.status, 64);
    assert.equal(processResult.stderr, "");
  });

  it("retains a terminal remote PASS as local exit 21 when a fresh authority replay is required", () => {
    const value = capture();
    value.exitCode = 21;
    value.result = "INCOMPLETE";
    value.code = "LOCAL_EVIDENCE_LIFETIME_INVALID";
    value.admission = "NOT_ADMITTED";
    assert.equal(
      validateIncidentAdmissionCapture(value, { expectedRevision: REVISION, now: NOW }).exitCode,
      21,
    );
    const mixed = cloneJson(value);
    mixed.result = "PASS";
    expectCode(
      () => validateIncidentAdmissionCapture(mixed, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_LOCAL_MAPPING_INVALID",
    );
  });

  it("accepts fixture capture only with null source OIDs and fixture admission", () => {
    const value = capture({ fixtureOnly: true });
    assert.equal(
      validateIncidentAdmissionCapture(value, {
        expectedRevision: REVISION,
        fixtureOnly: true,
        now: NOW,
      }).admission,
      "FIXTURE_ONLY",
    );
    value.provenance.sources.admissionRunner.gitObject = HEAD;
    expectCode(
      () =>
        validateIncidentAdmissionCapture(value, {
          expectedRevision: REVISION,
          fixtureOnly: true,
          now: NOW,
        }),
      "CAPTURE_SOURCE_admissionRunner_OID_INVALID",
    );
  });

  it("rejects remote substitution, exit remapping and stale final postflight", () => {
    const changedRemote = capture();
    changedRemote.remoteDocument.sha256 = HEX.f;
    expectCode(
      () =>
        validateIncidentAdmissionCapture(changedRemote, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_REMOTE_BINDING_INVALID",
    );
    const remapped = capture();
    remapped.remoteDocument.exitCode = 20;
    expectCode(
      () => validateIncidentAdmissionCapture(remapped, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_REMOTE_BINDING_INVALID",
    );
    const stale = capture();
    stale.finalPostflight.validUntil = "2026-08-08T20:11:59Z";
    expectCode(
      () => validateIncidentAdmissionCapture(stale, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_POSTFLIGHT_INVALID",
    );
  });

  it("rejects every post-incident baseline mix-and-match", () => {
    const mixedRemote = capture();
    mixedRemote.postIncidentBaseline.auditEvents += 1;
    const { snapshotSha256: previousSnapshotSha256, ...counts } = mixedRemote.postIncidentBaseline;
    mixedRemote.postIncidentBaseline.snapshotSha256 = createHash("sha256")
      .update(JSON.stringify(counts), "ascii")
      .digest("hex");
    assert.notEqual(mixedRemote.postIncidentBaseline.snapshotSha256, previousSnapshotSha256);
    mixedRemote.finalPostflight.postIncidentBaselineSha256 =
      mixedRemote.postIncidentBaseline.snapshotSha256;
    expectCode(
      () => validateIncidentAdmissionCapture(mixedRemote, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_REMOTE_POST_INCIDENT_BASELINE_MISMATCH",
    );

    const mixedFinal = capture();
    mixedFinal.finalPostflight.postIncidentBaselineSha256 = HEX.f;
    expectCode(
      () => validateIncidentAdmissionCapture(mixedFinal, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_POST_INCIDENT_BASELINE_MISMATCH",
    );

    const malformed = capture();
    malformed.postIncidentBaseline.refundRequests = -1;
    expectCode(
      () => validateIncidentAdmissionCapture(malformed, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_POST_INCIDENT_BASELINE_COUNT_INVALID",
    );
  });

  it("requires the complete redacted final candidate binding", () => {
    const invalid = capture();
    invalid.finalPostflight.candidateBinding.workerContainerIdSha256 = "f";
    expectCode(
      () => validateIncidentAdmissionCapture(invalid, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_CANDIDATE_BINDING_INVALID",
    );
    const missing = capture();
    delete missing.finalPostflight.candidateBinding.systemIdentifierSha256;
    expectCode(
      () => validateIncidentAdmissionCapture(missing, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_CANDIDATE_BINDING_KEYS_INVALID",
    );
  });

  it("binds the local capture to the exact promotion evidence and all five expected hashes", () => {
    const value = capture();
    const expectedPromotion = {
      bundleSha256: HEX.b,
      evidenceSha256: HEX.a,
      manifestSha256: HEX.c,
      provenanceSha256: HEX.d,
      sourceSha256: HEX.e,
    };
    assert.equal(
      validateIncidentAdmissionCapture(value, {
        expectedPromotion,
        expectedRevision: REVISION,
        now: NOW,
      }),
      value,
    );
    const mixedCapture = cloneJson(value);
    mixedCapture.provenance.promotionEvidenceSha256 = HEX.f;
    expectCode(
      () =>
        validateIncidentAdmissionCapture(mixedCapture, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_PROMOTION_BINDING_INVALID",
    );
    expectCode(
      () =>
        validateIncidentAdmissionCapture(value, {
          expectedPromotion: { ...expectedPromotion, evidenceSha256: HEX.f },
          expectedRevision: REVISION,
          now: NOW,
        }),
      "CAPTURE_EXPECTED_PROMOTION_MISMATCH",
    );
  });

  it("rejects a pre-effect final capture, reopened AWS edge and wrong revision", () => {
    const beforeRemote = capture();
    beforeRemote.finalPostflight.capturedAt = "2026-08-08T20:00:04Z";
    expectCode(
      () =>
        validateIncidentAdmissionCapture(beforeRemote, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_POSTFLIGHT_INVALID",
    );
    const open = capture();
    open.finalPostflight.awsControlPlane.firewallClosedAfter = false;
    expectCode(
      () => validateIncidentAdmissionCapture(open, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_AWS_INVALID",
    );
    const otherRevision = capture();
    otherRevision.finalPostflight.revision = "9".repeat(40);
    expectCode(
      () =>
        validateIncidentAdmissionCapture(otherRevision, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_FINAL_POSTFLIGHT_INVALID",
    );
  });

  it("rejects any missing, extra or substituted critical source alias", () => {
    const missing = capture();
    delete missing.provenance.sources.promotionValidator;
    expectCode(
      () => validateIncidentAdmissionCapture(missing, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_SOURCES_KEYS_INVALID",
    );
    const extra = capture();
    extra.provenance.sources.arbitraryReplacement = source();
    expectCode(
      () => validateIncidentAdmissionCapture(extra, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_SOURCES_KEYS_INVALID",
    );
    const substituted = capture();
    substituted.provenance.sources.admissionValidator =
      substituted.provenance.sources.promotionValidator;
    delete substituted.provenance.sources.promotionValidator;
    substituted.provenance.sources.looksValid = source();
    expectCode(
      () => validateIncidentAdmissionCapture(substituted, { expectedRevision: REVISION, now: NOW }),
      "CAPTURE_SOURCES_KEYS_INVALID",
    );
  });
});
