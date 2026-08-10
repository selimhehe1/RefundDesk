import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import {
  canonicalJson,
  parseCanonicalIncidentAdmissionDocument,
} from "../../scripts/validate-lightsail-incident-admission.mjs";

const REVISION = "1".repeat(40);
const HEAD = "2".repeat(40);
const HEX = ["a", "b", "c", "d", "e", "f"].map((value) => value.repeat(64));
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const cleanupRoots = [];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestamp(date) {
  return date.toISOString().replace(".000Z", "Z");
}

function dashboard(capturedAt, validUntil) {
  return {
    accountFingerprints: { managedSandbox: `sha256:${HEX[0]}`, platformTest: `sha256:${HEX[1]}` },
    activityReview: {
      apiRequestsReviewed: true,
      dashboardActivityReviewed: true,
      reviewedThrough: capturedAt,
      unexpectedActivity: false,
    },
    candidateFingerprints: {
      managedSandboxEffect: `sha256:${HEX[3]}`,
      managedSandboxRead: `sha256:${HEX[2]}`,
      stripeAppSigning: `sha256:${HEX[4]}`,
    },
    containment: {
      caddyStopped: true,
      liveDisabled: true,
      maintenanceStopped: true,
      portsClosed: true,
      workerStopped: true,
    },
    containmentCapturedAt: capturedAt,
    containmentValidUntil: validUntil,
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

function promotion(startedAt, completedAt) {
  return {
    code: "PASS_CONTAINED_CANDIDATE_PROMOTED",
    completedAt,
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
      bundleSha256: HEX[1],
      manifestSha256: HEX[2],
      provenanceSha256: HEX[3],
      sourceSha256: HEX[4],
    },
    kind: "refunddesk-contained-promotion",
    nonce: HEX[5],
    operationStartedAt: startedAt,
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
      caddyContainerId: HEX[0],
      postgresContainerId: HEX[1],
      verifierContainerId: HEX[2],
      webContainerId: HEX[3],
      workerContainerId: HEX[4],
      workerRuntimeMode: "incident_admission",
    },
    schemaVersion: 1,
    startedAt,
  };
}

function toPosix(path) {
  if (process.platform !== "win32") return path;
  const result = spawnSync(bash, ["-lc", 'cygpath -u "$1"', "--", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createTestRoot() {
  const result = spawnSync(
    bash,
    ["-lc", "mktemp -d /tmp/refunddesk-incident-admission-test-contract-XXXXXXXX"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const posixRoot = result.stdout.trim();
  if (process.platform !== "win32") return { posixRoot, windowsRoot: posixRoot };
  const converted = spawnSync(bash, ["-lc", 'cygpath -w "$1"', "--", posixRoot], {
    encoding: "utf8",
  });
  assert.equal(converted.status, 0, converted.stderr);
  return { posixRoot, windowsRoot: converted.stdout.trim() };
}

function setup(mode, mutateInput = undefined) {
  const { posixRoot, windowsRoot } = createTestRoot();
  cleanupRoots.push(windowsRoot);
  const paths = {
    control: join(windowsRoot, "control"),
    host: join(windowsRoot, "host.py"),
    operatorLock: join(windowsRoot, "operator.lock"),
    proof: join(windowsRoot, "proof.mjs"),
    promotionValidator: join(windowsRoot, "promotion-validator.mjs"),
    runner: join(windowsRoot, "runner.sh"),
    state: join(windowsRoot, "fake-state.json"),
    validator: join(windowsRoot, "validator.mjs"),
  };
  copyFileSync(resolve("deploy/lightsail/scripts/admit-current-stripe-bindings.sh"), paths.runner);
  copyFileSync(
    resolve("deploy/lightsail/test-fixtures/incident-admission-host-command.py"),
    paths.host,
  );
  copyFileSync(
    resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"),
    paths.proof,
  );
  copyFileSync(
    resolve("scripts/validate-lightsail-contained-promotion.mjs"),
    paths.promotionValidator,
  );
  copyFileSync(resolve("scripts/validate-lightsail-incident-admission.mjs"), paths.validator);
  chmodSync(paths.runner, 0o700);
  chmodSync(paths.host, 0o700);
  chmodSync(paths.proof, 0o600);
  chmodSync(paths.promotionValidator, 0o600);
  chmodSync(paths.validator, 0o600);

  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const capturedAt = timestamp(now);
  const validUntil = timestamp(new Date(now.getTime() + 900_000));
  const promotedAt = timestamp(new Date(now.getTime() - 30_000));
  const promotedFrom = timestamp(new Date(now.getTime() - 90_000));
  const values = {
    dashboardAttestation: dashboard(capturedAt, validUntil),
    fixture: fixture(),
    postflight: { capturedAt, firewallClosed: true, revision: REVISION, validUntil },
    promotionEvidence: promotion(promotedFrom, promotedAt),
  };
  mutateInput?.(values);
  const dashboardBytes = Buffer.from(canonicalJson(values.dashboardAttestation));
  const fixtureBytes = Buffer.from(canonicalJson(values.fixture));
  const promotionBytes = Buffer.from(canonicalJson(values.promotionEvidence));
  const input = Buffer.from(canonicalJson(values));
  const args = [
    toPosix(paths.runner),
    "--nonce",
    HEX[0],
    "--expected-revision",
    REVISION,
    "--repository-head",
    HEAD,
    "--runner-sha256",
    hash(readFileSync(paths.runner)),
    "--promotion-sha256",
    hash(promotionBytes),
    "--postflight-sha256",
    HEX[5],
    "--dashboard-sha256",
    hash(dashboardBytes),
    "--fixture-sha256",
    hash(fixtureBytes),
    "--validator-path",
    toPosix(paths.validator),
    "--validator-sha256",
    hash(readFileSync(paths.validator)),
    "--host-command-path",
    toPosix(paths.host),
    "--host-command-sha256",
    hash(readFileSync(paths.host)),
    "--proof-client-path",
    toPosix(paths.proof),
    "--proof-client-sha256",
    hash(readFileSync(paths.proof)),
    "--compose-sha256",
    HEX[3],
    "--promotion-validator-path",
    toPosix(paths.promotionValidator),
    "--promotion-validator-sha256",
    hash(readFileSync(paths.promotionValidator)),
  ];
  const environment = {
    ...process.env,
    REFUNDDESK_INCIDENT_ADMISSION_CONTROL_ROOT: `${posixRoot}/control`,
    REFUNDDESK_INCIDENT_ADMISSION_OPERATOR_LOCK: `${posixRoot}/operator.lock`,
    REFUNDDESK_INCIDENT_ADMISSION_ROOT: posixRoot,
    REFUNDDESK_INCIDENT_ADMISSION_TEST_MODE: "1",
    REFUNDDESK_INCIDENT_FAKE_MODE: mode,
    REFUNDDESK_INCIDENT_FAKE_ROOT: posixRoot,
    REFUNDDESK_INCIDENT_FAKE_STATE: `${posixRoot}/fake-state.json`,
  };
  return { args, environment, input, paths, values };
}

function setArgument(context, name, value) {
  const index = context.args.indexOf(name);
  assert.notEqual(index, -1, `missing argument ${name}`);
  context.args[index + 1] = value;
}

function refreshTemporalEvidence(context) {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const capturedAt = timestamp(now);
  const validUntil = timestamp(new Date(now.getTime() + 900_000));
  context.values.postflight = { capturedAt, firewallClosed: true, revision: REVISION, validUntil };
  context.values.dashboardAttestation.containmentCapturedAt = capturedAt;
  context.values.dashboardAttestation.containmentValidUntil = validUntil;
  context.values.dashboardAttestation.activityReview.reviewedThrough = capturedAt;
  const dashboardBytes = Buffer.from(canonicalJson(context.values.dashboardAttestation));
  setArgument(context, "--dashboard-sha256", hash(dashboardBytes));
  setArgument(context, "--postflight-sha256", "9".repeat(64));
  context.input = Buffer.from(canonicalJson(context.values));
}

function invoke(context) {
  const result = spawnSync(bash, context.args, {
    encoding: null,
    env: context.environment,
    input: context.input,
    maxBuffer: 256 * 1024,
    timeout: 120_000,
  });
  return {
    ...result,
    document: result.stdout.length === 0 ? null : JSON.parse(result.stdout.toString("utf8")),
  };
}

async function invokeAndTerminateAt(context, reachedBoundary, signal = "SIGTERM") {
  const child = spawn(bash, context.args, {
    env: context.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(context.input);
  const limit = Date.now() + 120_000;
  while (Date.now() < limit) {
    if (existsSync(context.paths.state)) {
      const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
      if (reachedBoundary(state)) break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.ok(Date.now() < limit, "signal boundary was not reached");
  child.kill(signal);
  const status = await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectClose(new Error("signal contract timed out"));
    }, 30_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveClose(code);
    });
  });
  return {
    document: stdout.length === 0 ? null : JSON.parse(Buffer.concat(stdout).toString("utf8")),
    status,
    stderr: Buffer.concat(stderr),
  };
}

after(() => {
  for (const root of cleanupRoots) {
    const resolved = resolve(root);
    assert.ok(resolved.startsWith(resolve(tmpdir())));
    rmSync(resolved, { force: true, recursive: true });
  }
});

describe("ADR 0036 fake-host contract", { concurrency: 4 }, () => {
  it("pins the production helper to the promoted container IDs and fail-closed inventories", () => {
    const helper = readFileSync(
      resolve("deploy/lightsail/scripts/incident-admission-host-command.sh"),
      "utf8",
    );
    assert.match(helper, /runtime\.workerContainerId/u);
    assert.match(helper, /docker start "\$\{worker_id\}"/u);
    assert.doesNotMatch(helper, /compose up/u);
    assert.match(helper, /ids="\$\(docker container ls --all --quiet --no-trunc/u);
    assert.match(helper, /all_ids="\$\(docker container ls --all --quiet --no-trunc\)"/u);
    assert.match(
      helper,
      /output="\$\(ss --tcp --udp --listening --numeric --no-header\)" \|\| return 1/u,
    );
    assert.match(helper, /systemctl show --property=LoadState --property=ActiveState/u);
    assert.match(helper, /EXPECTED_COMPOSE_SHA256/u);
    assert.match(helper, /promotionSnapshotSha256/u);
    assert.match(helper, /worker_forbidden=.*STRIPE_MANAGED_SANDBOX_READ_KEY/u);
    assert.match(helper, /platform_forbidden=.*STRIPE_MANAGED_SANDBOX_EFFECT_KEY/u);
    assert.match(helper, /STRIPE_APP_SIGNING_SECRET_PREVIOUS/u);
    assert.match(helper, /REFUNDDESK_WORKER_RUNTIME_MODE/u);
    assert.match(helper, /cp!=expected_platform or cw!=expected_worker/u);
    assert.match(
      helper,
      /docker image inspect --format '\{\{\.Id\}\}' -- 'postgres:18\.4-bookworm/u,
    );
    assert.match(helper, /terminate_proof_client/u);
    assert.match(helper, /readdirSync\("\/proc"\)/u);
    assert.match(helper, /timeout --signal=TERM --kill-after=5/u);
    assert.match(
      helper,
      /current\["state"\] in \{"armed","cancelled_contained","fenced","failed"\}/u,
    );
    assert.match(helper, /"armCount":current\["armCount"\]\+1,"deadline":deadline/u);
    assert.match(helper, /\^\(armed\|fenced\|failed\|cancelled_contained\)\$/u);
    const runner = readFileSync(
      resolve("deploy/lightsail/scripts/admit-current-stripe-bindings.sh"),
      "utf8",
    );
    assert.match(runner, /node "\$\{PROMOTION_VALIDATOR\}" --evidence/u);
    assert.match(runner, /promotionValidatorSha256/u);
  });

  it("persists the original Stripe Refund baseline before the deterministic workflow", () => {
    const helper = readFileSync(
      resolve("deploy/lightsail/scripts/incident-admission-host-command.sh"),
      "utf8",
    );
    const client = readFileSync(
      resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"),
      "utf8",
    );
    assert.match(helper, /persist_stripe_baseline/u);
    assert.ok(
      helper.indexOf("persist_stripe_baseline") < helper.lastIndexOf("run_proof_client effect"),
    );
    assert.match(client, /\/v1\/account/u);
    assert.match(client, /input\.stripeBaseline\.refundableRefundCount \+ 1/u);
    assert.doesNotMatch(client, /input\.resume \? 0 : 1/u);
    assert.match(client, /operation: "settings\.get"/u);
    assert.match(helper, /capture_resume_state/u);
    assert.match(helper, /recover_exact_job_for_resume/u);
    assert.match(helper, /UPDATE pgboss\.job j SET state='retry'/u);
    assert.ok(
      helper.lastIndexOf("recover_exact_job_for_resume") <
        helper.indexOf('docker start "${worker_id}"'),
    );
    assert.match(client, /input\.resumeState\.terminalExact/u);
    assert.match(client, /input\.resumeState\.refundLinked/u);
    assert.match(helper, /proof_input_json/u);
    assert.match(helper, /O_WRONLY\|constants\.O_CREAT\|constants\.O_EXCL\|constants\.O_NOFOLLOW/u);
    assert.doesNotMatch(helper, /docker cp/u);
    assert.match(helper, /\/tmp\/refunddesk-incident-admission-\$\{OPERATION:0:16\}/u);
    assert.match(helper, /stat --format='%u:%g:%a:%F'/u);
    assert.match(helper, /constants\.O_RDONLY\|constants\.O_NOFOLLOW/u);
    assert.match(helper, /docker exec --interactive --user 0/u);
    assert.doesNotMatch(helper, /chown 1000:1000/u);
    assert.match(helper, /PIPESTATUS/u);
    assert.doesNotMatch(helper, /incident-admission-proof-XXXXXXXX\.mjs/u);
    assert.doesNotMatch(client, /__REFUNDDESK_INCIDENT_INPUT/u);
    assert.match(client, /authorityStopAt/u);
    assert.match(client, /boundedNetworkSignal/u);
    assert.match(client, /identifyPersistedRefund/u);
    assert.match(helper, /terminal_refund_binding_exact/u);
    assert.match(helper, /POST_INCIDENT_BASELINE_JSON/u);
    assert.match(helper, /"mutationReceipts":after\[6\]/u);
    for (const surface of [
      "approval_attestations",
      "approval_decisions",
      "api_mutation_receipts",
      "external_refund_alerts",
      "refund_correlation_candidates",
      "refund_execution_attempts",
      "refund_executions",
      "refund_requests",
      "webhook_receipts",
    ]) {
      assert.ok(helper.includes(surface), `missing bounded financial surface ${surface}`);
    }
  });

  for (const [mode, expectedCode] of [
    ["client-swap-attempt", "WORKER_PROOF_FAILED"],
    ["stale-watchdog-command", "WORKER_START_FAILED"],
  ]) {
    it(`rejects ${mode} without a financial effect`, () => {
      const context = setup(mode);
      const result = invoke(context);
      assert.equal(result.status, 20);
      assert.equal(result.document.code, expectedCode);
      const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.equal(state.workflows, 0);
      assert.equal(state.refunds, 0);
      assert.equal(state.refundLinked, false);
    });
  }

  it("replaces any same-name watchdog and validates its exact timer and ExecStart before worker start", () => {
    const helper = readFileSync(
      resolve("deploy/lightsail/scripts/incident-admission-host-command.sh"),
      "utf8",
    );
    assert.match(helper, /watchdog_remove_units "\$\{WATCHDOG_UNIT\}"/u);
    assert.ok(
      helper.indexOf('watchdog_remove_units "${WATCHDOG_UNIT}"') <
        helper.indexOf('docker start "${worker_id}"'),
    );
    assert.match(helper, /watchdog_units_exact "\$\{worker_id\}"/u);
    assert.match(helper, /NextElapseUSecRealtime/u);
    assert.match(helper, /argv\\\[\\\]=\(\.\+\?\) ; ignore_errors=/u);
    assert.match(helper, /FragmentPath/u);
  });

  it("validates the exact HEAD settings authority including observed_users", () => {
    const moduleUrl = pathToFileURL(
      resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"),
    ).href;
    const base = {
      approver_user_ids: ["usr_Approver01"],
      expiration_days: 7,
      onboarding_completed: true,
      observed_users: [
        {
          approver_enabled: true,
          display_name: "Synthetic Approver",
          last_seen_at: "2026-08-08T20:00:00.000Z",
          stripe_user_id: "usr_Approver01",
        },
        {
          approver_enabled: false,
          display_name: null,
          last_seen_at: "2026-08-08T19:59:00.000Z",
          stripe_user_id: "usr_Requester01",
        },
      ],
    };
    const validate = (value) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import {validateSettingsAuthority} from ${JSON.stringify(moduleUrl)};process.exit(validateSettingsAuthority(JSON.parse(process.argv[1]),"usr_Approver01")?0:1)`,
          JSON.stringify(value),
        ],
        {
          env: { ...process.env, REFUNDDESK_INCIDENT_PROOF_CLIENT_UNIT_TEST: "1" },
          stdio: "ignore",
        },
      ).status;
    assert.equal(validate(base), 0);
    assert.notEqual(validate({ ...base, extra: true }), 0);
    assert.notEqual(
      validate({ ...base, observed_users: [{ ...base.observed_users[0], display_name: {} }] }),
      0,
    );
    assert.notEqual(
      validate({ ...base, observed_users: [base.observed_users[0], base.observed_users[0]] }),
      0,
    );
    assert.notEqual(
      validate({
        ...base,
        observed_users: [{ ...base.observed_users[0], approver_enabled: false }],
      }),
      0,
    );
  });

  it("identifies only the one post-baseline Refund that can be safely replayed", () => {
    const moduleUrl = pathToFileURL(
      resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"),
    ).href;
    const baseline = [
      {
        amount: 5,
        currency: "eur",
        id: "re_Preexisting01",
        object: "refund",
        payment_intent: "pi_Refundable001",
        status: "succeeded",
      },
    ];
    const added = {
      amount: 1,
      currency: "eur",
      id: "re_Incident01",
      object: "refund",
      payment_intent: "pi_Refundable001",
      status: "succeeded",
    };
    const baselineDigest = hash(Buffer.from(JSON.stringify(baseline)));
    const linkedDigest = hash(Buffer.from(added.id));
    const identify = (projection, digest = null) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import {identifyPersistedRefund} from ${JSON.stringify(moduleUrl)};const p=JSON.parse(process.argv[1]);const value=identifyPersistedRefund(p,process.argv[2],process.argv[3]==="null"?null:process.argv[3]);process.exit(value?.id==="re_Incident01"?0:1)`,
          JSON.stringify(projection),
          baselineDigest,
          digest ?? "null",
        ],
        {
          env: { ...process.env, REFUNDDESK_INCIDENT_PROOF_CLIENT_UNIT_TEST: "1" },
          stdio: "ignore",
        },
      ).status;
    assert.equal(identify([...baseline, added]), 0);
    assert.equal(identify([...baseline, added], linkedDigest), 0);
    assert.notEqual(identify([...baseline, added], HEX[0]), 0);
    assert.notEqual(identify([...baseline, { ...added, amount: 2 }]), 0);
  });

  it("bounds every HTTP JSON body, forbids compression, and derives one denial idempotency key", () => {
    const moduleUrl = pathToFileURL(
      resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"),
    ).href;
    const script = `
      import {denialIdempotencyKey,readBoundedJsonResponse} from ${JSON.stringify(moduleUrl)};
      const operation="a".repeat(64);
      if (denialIdempotencyKey(operation)!==denialIdempotencyKey(operation) || denialIdempotencyKey(operation).length>255) process.exit(1);
      const good=await readBoundedJsonResponse(new Response('{"ok":true}',{headers:{"content-length":"11"}}));
      if (good.ok!==true) process.exit(2);
      const expectReject=async (response) => { try { await readBoundedJsonResponse(response); return false; } catch { return true; } };
      if (!await expectReject(new Response('{}',{headers:{"content-encoding":"gzip"}}))) process.exit(3);
      if (!await expectReject(new Response('{}',{headers:{"content-length":"131073"}}))) process.exit(4);
      const chunk=new Uint8Array(70000); const stream=new ReadableStream({start(controller){controller.enqueue(chunk);controller.enqueue(chunk);controller.close();}});
      if (!await expectReject(new Response(stream))) process.exit(5);
      if (!await expectReject(new Response('{}',{headers:{"content-length":"3"}}))) process.exit(6);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, REFUNDDESK_INCIDENT_PROOF_CLIENT_UNIT_TEST: "1" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const source = readFileSync(
      resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"),
      "utf8",
    );
    assert.equal((source.match(/"Accept-Encoding": "identity"/gu) ?? []).length, 2);
    assert.match(source, /"Idempotency-Key": denialIdempotencyKey\(input\.operation\)/u);
    assert.doesNotMatch(source, /response\.json\(\)/u);
  });

  it(
    "uses the web read-only filesystem only through a root-owned operation directory on /tmp",
    {
      skip:
        spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" })
          .status !== 0 ||
        spawnSync("docker", ["image", "inspect", "node:24.18.0-bookworm-slim"], {
          stdio: "ignore",
        }).status !== 0,
    },
    () => {
      const { windowsRoot } = createTestRoot();
      cleanupRoots.push(windowsRoot);
      const source = join(windowsRoot, "proof-client.mjs");
      copyFileSync(resolve("deploy/lightsail/scripts/incident-admission-proof-client.mjs"), source);
      const created = spawnSync(
        "docker",
        [
          "create",
          "--pull=never",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges:true",
          "--pids-limit=32",
          "--memory=128m",
          "--tmpfs=/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=1777,size=16m",
          "--user=1000:1000",
          "--entrypoint=node",
          "node:24.18.0-bookworm-slim",
          "-e",
          "setInterval(()=>{},1000)",
        ],
        { encoding: "utf8" },
      );
      assert.equal(created.status, 0, created.stderr);
      const containerId = created.stdout.trim();
      assert.match(containerId, /^[0-9a-f]{64}$/u);
      const run = (...args) => spawnSync("docker", args, { encoding: "utf8" });
      const sourceBytes = readFileSync(source);
      const writer = `
        const {createHash}=require("node:crypto"),{closeSync,constants,fstatSync,fsyncSync,openSync,unlinkSync,writeSync}=require("node:fs");
        const path=process.argv[1],expected=process.argv[2],expectedSize=Number(process.argv[3]); let fd,created=false,count=0; const digest=createHash("sha256");
        (async()=>{try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);created=true;
        for await(const chunk of process.stdin){count+=chunk.length;if(count>expectedSize)throw new Error();digest.update(chunk);let offset=0;while(offset<chunk.length)offset+=writeSync(fd,chunk,offset,chunk.length-offset);}
        fsyncSync(fd);const stat=fstatSync(fd);if(count!==expectedSize||digest.digest("hex")!==expected||!stat.isFile()||stat.uid!==0||stat.gid!==0||(stat.mode&0o777)!==0o400||stat.size!==expectedSize)throw new Error();closeSync(fd);fd=undefined;process.exit(0);
        }catch{if(fd!==undefined){try{closeSync(fd)}catch{}}if(created){try{unlinkSync(path)}catch{}}process.exit(98);}})();`;
      const streamSource = (target, bytes) =>
        spawnSync(
          "docker",
          [
            "exec",
            "--interactive",
            "--user=0",
            containerId,
            "node",
            "-e",
            writer,
            target,
            hash(sourceBytes),
            String(sourceBytes.length),
          ],
          { encoding: "utf8", input: bytes },
        );
      try {
        assert.equal(run("start", containerId).status, 0);
        assert.notEqual(
          run("exec", "--user=0", containerId, "mkdir", "/run/refunddesk-incident-admission-denied")
            .status,
          0,
        );
        assert.equal(
          run(
            "exec",
            "--user=0",
            containerId,
            "mkdir",
            "--mode=700",
            "/tmp/refunddesk-incident-admission-contract",
          ).status,
          0,
        );
        const target = "/tmp/refunddesk-incident-admission-contract/proof-client.mjs";
        assert.equal(streamSource(target, sourceBytes).status, 0);
        assert.notEqual(
          streamSource(target, sourceBytes).status,
          0,
          "pre-existing target must be refused",
        );
        for (const [name, bytes] of [
          ["truncated.mjs", sourceBytes.subarray(0, sourceBytes.length - 1)],
          ["extra.mjs", Buffer.concat([sourceBytes, Buffer.from("x")])],
        ]) {
          const rejectedTarget = `/tmp/refunddesk-incident-admission-contract/${name}`;
          assert.notEqual(streamSource(rejectedTarget, bytes).status, 0);
          assert.notEqual(
            run("exec", "--user=0", containerId, "test", "-e", rejectedTarget).status,
            0,
          );
        }
        for (const probe of [
          "require('fs').readFileSync('/tmp/refunddesk-incident-admission-contract/proof-client.mjs')",
          "require('fs').writeFileSync('/tmp/refunddesk-incident-admission-contract/proof-client.mjs','swap')",
          "require('fs').writeFileSync('/tmp/refunddesk-incident-admission-contract/swap.mjs','swap')",
        ]) {
          assert.notEqual(
            run("exec", "--user=1000:1000", containerId, "node", "-e", probe).status,
            0,
          );
        }
        assert.equal(
          run(
            "exec",
            "--user=0",
            "--env=REFUNDDESK_INCIDENT_PROOF_CLIENT_UNIT_TEST=1",
            containerId,
            "node",
            target,
          ).status,
          0,
        );
        assert.equal(
          run(
            "exec",
            "--user=0",
            containerId,
            "sh",
            "-c",
            "rm /tmp/refunddesk-incident-admission-contract/proof-client.mjs && rmdir /tmp/refunddesk-incident-admission-contract && test ! -e /tmp/refunddesk-incident-admission-contract",
          ).status,
          0,
        );
      } finally {
        const inspected = run("container", "inspect", "--format", "{{.Id}}", containerId);
        if (inspected.status === 0 && inspected.stdout.trim() === containerId) {
          assert.equal(run("container", "rm", "--force", "--volumes", containerId).status, 0);
        }
      }
    },
  );

  it("admits exactly one contained workflow and persists a complete proof projection", () => {
    const context = setup("pass");
    const result = invoke(context);
    assert.equal(result.status, 0, `${result.stderr.toString()} ${result.stdout.toString()}`);
    assert.equal(result.stderr.length, 0);
    const document = parseCanonicalIncidentAdmissionDocument(result.stdout, {
      expectedRevision: REVISION,
      repositoryHead: HEAD,
    });
    assert.equal(document.code, "PASS_INCIDENT_ADMITTED_CONTAINED");
    assert.equal(document.proof.workflowCount, 1);
    assert.equal(document.proof.refundCount, 1);
    assert.equal(document.proof.ambiguousResumeSameKey, false);
    assert.deepEqual(document.postIncidentBaseline, {
      activeFinancialJobs: 0,
      auditEvents: 12,
      mutationReceipts: 4,
      refundExecutionAttempts: 2,
      refundExecutions: 2,
      refundRequests: 3,
      snapshotSha256: "1d75c67f621c244b5f069ca9210d0546d6575e6487af52950a6cd9ad2ae59cb3",
      unreleasedPaymentGuards: 0,
      webhookReceipts: 0,
    });
    const marker = JSON.parse(
      readFileSync(
        join(context.paths.control, "current-stripe-binding-incident-admission.json"),
        "utf8",
      ),
    );
    assert.equal(marker.state, "complete");
    assert.match(marker.proofSha256, /^[0-9a-f]{64}$/u);
    assert.equal(marker.proof.complete, true);
    assert.equal(JSON.stringify(marker).includes("pi_"), false);
  });

  for (const failure of ["find", "shred", "residue", "rmdir"]) {
    it(`never emits PASS when strict secret-input cleanup fails at ${failure}`, () => {
      const context = setup("pass");
      context.environment.REFUNDDESK_INCIDENT_ADMISSION_TEST_CLEANUP_FAILURE = failure;
      const result = invoke(context);
      assert.equal(result.status, 21);
      assert.equal(result.document.result, "INCOMPLETE");
      assert.equal(result.document.code, "CONTROL_STATE_UNAVAILABLE");
      assert.notEqual(result.document.code, "PASS_INCIDENT_ADMITTED_CONTAINED");
      const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.equal(state.workflows, 1);
      assert.equal(state.refunds, 1);
      assert.equal(state.workerRunning, false);
    });
  }

  for (const [mode, code] of [
    ["public-listener", "CONTAINMENT_INVALID"],
    ["live-enabled", "CONTAINMENT_INVALID"],
    ["wrong-revision", "SOURCE_IDENTITY_INVALID"],
    ["read-create-allowed", "WORKER_PROOF_FAILED"],
    ["requester-approver-same", "WORKER_PROOF_FAILED"],
    ["two-workflows", "WORKER_PROOF_FAILED"],
    ["two-refunds", "WORKER_PROOF_FAILED"],
    ["changed-idempotency", "WORKER_PROOF_FAILED"],
    ["postflight-drift", "CONTAINMENT_INVALID"],
    ["postflight-baseline-mismatch", "CONTROL_STATE_UNAVAILABLE"],
  ]) {
    it(`fails closed for ${mode}`, () => {
      const result = invoke(setup(mode));
      assert.ok([20, 21].includes(result.status));
      assert.equal(result.document.code, code);
      assert.equal(result.stderr.length, 0);
    });
  }

  for (const [mode, code] of [
    ["binding-mismatch", "NEW_ROTATION_REQUIRED"],
    ["legacy-key", "NEW_ROTATION_REQUIRED"],
    ["platform-effect-key-in-web", "NEW_ROTATION_REQUIRED"],
    ["platform-read-key-in-worker", "NEW_ROTATION_REQUIRED"],
    ["previous-signing-secret", "NEW_ROTATION_REQUIRED"],
    ["runtime-env-mismatch", "NEW_ROTATION_REQUIRED"],
    ["runtime-env-extra", "NEW_ROTATION_REQUIRED"],
    ["env-duplicate", "NEW_ROTATION_REQUIRED"],
    ["env-malformed", "NEW_ROTATION_REQUIRED"],
    ["aws-secret-extra", "NEW_ROTATION_REQUIRED"],
    ["sandbox-effect-key-in-web", "NEW_ROTATION_REQUIRED"],
    ["sandbox-read-key-in-worker", "NEW_ROTATION_REQUIRED"],
    ["financial-work", "FINANCIAL_WORK_ACTIVE"],
    ["foreign-job", "FINANCIAL_WORK_ACTIVE"],
    ["webhook-job", "FINANCIAL_WORK_ACTIVE"],
    ["webhook-recovery-job", "FINANCIAL_WORK_ACTIVE"],
    ["docker-unavailable", "CONTAINMENT_INVALID"],
    ["duplicate-worker", "CONTAINMENT_INVALID"],
    ["foreign-container", "CONTAINMENT_INVALID"],
    ["missing-worker", "CONTAINMENT_INVALID"],
    ["sentinel-mutated", "CONTAINMENT_INVALID"],
    ["sentinel-image-id-mismatch", "CONTAINMENT_INVALID"],
    ["ss-unavailable", "CONTAINMENT_INVALID"],
    ["systemd-unavailable", "CONTAINMENT_INVALID"],
    ["wrong-config", "CONTAINMENT_INVALID"],
    ["wrong-image", "CONTAINMENT_INVALID"],
  ]) {
    it(`refuses ${mode} before marker or financial effect`, () => {
      const context = setup(mode);
      const result = invoke(context);
      assert.equal(result.status, 20);
      assert.equal(result.document.code, code);
      assert.equal(
        existsSync(join(context.paths.control, "current-stripe-binding-incident-admission.json")),
        false,
      );
      assert.equal(existsSync(context.paths.state), false);
    });
  }

  it("resumes an ambiguous effect with the same operation and no second workflow or Refund", () => {
    const context = setup("ambiguous-once");
    const first = invoke(context);
    assert.equal(first.status, 21);
    assert.equal(first.document.code, "WORKER_PROOF_AMBIGUOUS");
    assert.equal(first.document.marker.state, "proof_started");
    const markerBefore = JSON.parse(
      readFileSync(
        join(context.paths.control, "current-stripe-binding-incident-admission.json"),
        "utf8",
      ),
    );
    const second = invoke(context);
    assert.equal(second.status, 0, second.stderr.toString());
    assert.equal(second.document.marker.resumed, true);
    assert.equal(second.document.proof.ambiguousResumeSameKey, true);
    assert.equal(second.document.proof.workflowCount, 1);
    assert.equal(second.document.proof.refundCount, 1);
    const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
    assert.equal(state.workflows, 1);
    assert.equal(state.refunds, 1);
    const markerAfter = JSON.parse(
      readFileSync(
        join(context.paths.control, "current-stripe-binding-incident-admission.json"),
        "utf8",
      ),
    );
    assert.equal(state.operation, markerBefore.operation);
    assert.equal(markerAfter.operation, markerBefore.operation);
    assert.equal(state.idempotencyKey, markerBefore.idempotencyKey);
    assert.equal(markerAfter.idempotencyKey, markerBefore.idempotencyKey);
  });

  it("keeps the financial operation stable across a fresh postflight and Dashboard timestamp window", () => {
    const context = setup("ambiguous-once");
    const first = invoke(context);
    assert.equal(first.status, 21);
    const markerPath = join(
      context.paths.control,
      "current-stripe-binding-incident-admission.json",
    );
    const firstMarker = JSON.parse(readFileSync(markerPath, "utf8"));
    const stateBefore = JSON.parse(readFileSync(context.paths.state, "utf8"));
    refreshTemporalEvidence(context);
    const second = invoke(context);
    assert.equal(second.status, 0, second.stderr.toString());
    const secondMarker = JSON.parse(readFileSync(markerPath, "utf8"));
    const stateAfter = JSON.parse(readFileSync(context.paths.state, "utf8"));
    assert.equal(secondMarker.operation, firstMarker.operation);
    assert.equal(secondMarker.idempotencyKey, firstMarker.idempotencyKey);
    assert.equal(secondMarker.initialPostflightSha256, HEX[5]);
    assert.equal(stateAfter.operation, stateBefore.operation);
    assert.equal(stateAfter.workflows, 1);
    assert.equal(stateAfter.refunds, 1);
  });

  it("refuses a changed fixture authority on resume without another host command or financial effect", () => {
    const context = setup("ambiguous-once");
    assert.equal(invoke(context).status, 21);
    const before = JSON.parse(readFileSync(context.paths.state, "utf8"));
    context.values.fixture.requesterUserId = "usr_Requester02";
    const fixtureBytes = Buffer.from(canonicalJson(context.values.fixture));
    setArgument(context, "--fixture-sha256", hash(fixtureBytes));
    context.input = Buffer.from(canonicalJson(context.values));
    const rejected = invoke(context);
    assert.equal(rejected.status, 20);
    assert.equal(rejected.document.code, "DASHBOARD_AUTHORITY_CHANGED");
    const after = JSON.parse(readFileSync(context.paths.state, "utf8"));
    assert.equal(after.startCalls, before.startCalls);
    assert.equal(after.stopCalls, before.stopCalls);
    assert.equal(after.proofCalls, before.proofCalls);
    assert.equal(after.workflows, 1);
    assert.equal(after.refunds, 1);
  });

  for (const mode of ["crash-before-call-once", "crash-after-link-once", "crash-terminal-once"]) {
    it(`converges ${mode} with one operation and one Refund`, () => {
      const context = setup(mode);
      const first = invoke(context);
      assert.equal(first.status, 21);
      assert.equal(first.document.code, "WORKER_PROOF_AMBIGUOUS");
      const second = invoke(context);
      assert.equal(second.status, 0, second.stderr.toString());
      const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.equal(state.workflows, 1);
      assert.equal(state.refunds, 1);
      assert.equal(second.document.marker.resumed, true);
    });
  }

  it("converges a Stripe success before the durable DB link with the exact same operation", () => {
    const context = setup("crash-after-stripe-before-link");
    const first = invoke(context);
    assert.equal(first.status, 21);
    assert.equal(first.document.code, "WORKER_PROOF_AMBIGUOUS");
    const markerBefore = JSON.parse(
      readFileSync(
        join(context.paths.control, "current-stripe-binding-incident-admission.json"),
        "utf8",
      ),
    );
    const second = invoke(context);
    assert.equal(second.status, 0, second.stderr.toString());
    const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
    const markerAfter = JSON.parse(
      readFileSync(
        join(context.paths.control, "current-stripe-binding-incident-admission.json"),
        "utf8",
      ),
    );
    assert.equal(state.operation, markerBefore.operation);
    assert.equal(state.idempotencyKey, markerBefore.idempotencyKey);
    assert.equal(markerAfter.operation, markerBefore.operation);
    assert.equal(markerAfter.idempotencyKey, markerBefore.idempotencyKey);
    assert.equal(state.workflows, 1);
    assert.equal(state.refunds, 1);
    assert.equal(state.refundLinked, true);
    assert.equal(state.jobRequeues, 1);
    assert.equal(second.document.marker.resumed, true);
  });

  it("revalidates real fake-host proof on a complete-marker replay", () => {
    const context = setup("pass");
    assert.equal(invoke(context).status, 0);
    const before = JSON.parse(readFileSync(context.paths.state, "utf8"));
    context.environment.REFUNDDESK_INCIDENT_FAKE_MODE = "postflight-drift";
    const replay = invoke(context);
    assert.equal(replay.status, 21);
    assert.equal(replay.document.code, "CONTAINMENT_INVALID");
    const after = JSON.parse(readFileSync(context.paths.state, "utf8"));
    assert.equal(after.startCalls, before.startCalls);
    assert.equal(after.stopCalls, before.stopCalls);
    assert.equal(after.proofCalls, before.proofCalls);
  });

  it("never restarts or re-proves late marker states and reports cumulative operation mutations", () => {
    const context = setup("pass");
    const initial = invoke(context);
    assert.equal(initial.status, 0);
    let priorStartedAt = initial.document.startedAt;
    const markerPath = join(
      context.paths.control,
      "current-stripe-binding-incident-admission.json",
    );
    const complete = JSON.parse(readFileSync(markerPath, "utf8"));
    for (const [state, markerTransitions] of [
      ["proof_observed", 3],
      ["contained_verified", 4],
      ["complete", 5],
    ]) {
      writeFileSync(markerPath, canonicalJson({ ...complete, markerTransitions, state }), "utf8");
      if (state === "complete") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
        refreshTemporalEvidence(context);
      }
      const before = JSON.parse(readFileSync(context.paths.state, "utf8"));
      const replay = invoke(context);
      assert.equal(replay.status, 0, `${state}: ${replay.stderr.toString()}`);
      assert.equal(replay.document.proof.workerStartedPrivately, true);
      assert.equal(replay.document.proof.workerStoppedAfter, true);
      assert.equal(replay.document.mutations.workerStarts, 1);
      assert.equal(replay.document.mutations.workerStops, 1);
      assert.equal(replay.document.mutations.workflowsCreated, 1);
      assert.equal(replay.document.mutations.refundsCreated, 1);
      assert.equal(replay.document.proof.ambiguousResumeSameKey, true);
      if (state === "complete") {
        assert.notEqual(replay.document.startedAt, priorStartedAt);
        assert.notEqual(replay.document.completedAt, initial.document.completedAt);
        const replayedMarker = JSON.parse(readFileSync(markerPath, "utf8"));
        assert.equal(replayedMarker.operation, complete.operation);
        assert.equal(replayedMarker.initialPostflightSha256, complete.initialPostflightSha256);
      }
      const after = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.equal(after.startCalls, before.startCalls, `${state}: start`);
      assert.equal(after.stopCalls, before.stopCalls, `${state}: stop`);
      assert.equal(after.proofCalls, before.proofCalls, `${state}: proof`);
      assert.equal(after.postflightCalls, before.postflightCalls + 1, `${state}: postflight`);
      priorStartedAt = replay.document.startedAt;
    }
  });

  it("rejects inconsistent marker state, transition and proof combinations before host activity", () => {
    const context = setup("pass");
    assert.equal(invoke(context).status, 0);
    const markerPath = join(
      context.paths.control,
      "current-stripe-binding-incident-admission.json",
    );
    const complete = JSON.parse(readFileSync(markerPath, "utf8"));
    const corruptions = [
      { ...complete, markerTransitions: 5, proof: null, proofSha256: null, state: "prepared" },
      { ...complete, markerTransitions: 1, state: "prepared" },
      { ...complete, markerTransitions: 1, state: "complete" },
      { ...complete, markerTransitions: 3, state: "proof_started" },
      { ...complete, markerTransitions: 4, state: "proof_observed" },
      {
        ...complete,
        markerTransitions: 3,
        proof: null,
        proofSha256: null,
        state: "proof_observed",
      },
    ];
    for (const marker of corruptions) {
      writeFileSync(markerPath, canonicalJson(marker), "utf8");
      const before = JSON.parse(readFileSync(context.paths.state, "utf8"));
      const rejected = invoke(context);
      assert.equal(rejected.status, 20);
      assert.equal(rejected.document.code, "MARKER_INVALID");
      const after = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.deepEqual(after, before);
    }
  });

  it(
    "turns TERM at start, proof and stop boundaries into contained exit 21 without resuming flow",
    { skip: process.platform === "win32" },
    async () => {
      for (const [mode, boundary] of [
        ["delay-start", (state) => state.startCalls >= 1 && state.workerRunning],
        ["delay-proof", (state) => state.proofCalls >= 1 && state.workerRunning],
        ["delay-stop", (state) => state.stopCalls >= 1 && !state.workerRunning],
      ]) {
        const context = setup(mode);
        const result = await invokeAndTerminateAt(context, boundary);
        assert.equal(result.status, 21, mode);
        assert.equal(result.stderr.length, 0, mode);
        assert.equal(result.document.result, "INCOMPLETE", mode);
        assert.equal(result.document.code, "CONTROL_STATE_UNAVAILABLE", mode);
        const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
        assert.equal(state.workerRunning, false, mode);
      }
    },
  );

  it(
    "adopts an exact durable host baseline after a pre-marker SIGKILL",
    { skip: process.platform === "win32" },
    async () => {
      const context = setup("delay-prepare");
      const killed = await invokeAndTerminateAt(
        context,
        (state) => state.prepareCalls >= 1 && state.hostStatePrepared,
        "SIGKILL",
      );
      assert.equal(killed.status, null);
      assert.equal(
        existsSync(join(context.paths.control, "current-stripe-binding-incident-admission.json")),
        false,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
      rmSync(`${context.paths.operatorLock}.fixture-lock`, {
        force: true,
        recursive: true,
      });
      context.environment.REFUNDDESK_INCIDENT_FAKE_MODE = "pass";
      const resumed = invoke(context);
      assert.equal(resumed.status, 0, resumed.stderr.toString());
      assert.equal(resumed.document.marker.resumed, true);
      const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.equal(state.workflows, 1);
      assert.equal(state.refunds, 1);
    },
  );

  it(
    "contains and resumes the same operation after SIGKILL following worker start",
    { skip: process.platform === "win32" },
    async () => {
      const context = setup("delay-start");
      const killed = await invokeAndTerminateAt(
        context,
        (state) => state.startCalls >= 1 && state.workerRunning,
        "SIGKILL",
      );
      assert.equal(killed.status, null);
      const markerPath = join(
        context.paths.control,
        "current-stripe-binding-incident-admission.json",
      );
      const prepared = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(prepared.state, "prepared");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
      rmSync(`${context.paths.operatorLock}.fixture-lock`, { force: true, recursive: true });
      context.environment.REFUNDDESK_INCIDENT_FAKE_MODE = "pass";
      const resumed = invoke(context);
      assert.equal(resumed.status, 0, resumed.stderr.toString());
      const complete = JSON.parse(readFileSync(markerPath, "utf8"));
      const state = JSON.parse(readFileSync(context.paths.state, "utf8"));
      assert.equal(complete.operation, prepared.operation);
      assert.equal(complete.idempotencyKey, prepared.idempotencyKey);
      assert.equal(state.operation, prepared.operation);
      assert.equal(state.idempotencyKey, prepared.idempotencyKey);
      assert.ok(state.stopCalls >= 1);
      assert.equal(state.workflows, 1);
      assert.equal(state.refunds, 1);
    },
  );

  it("rejects postflight-before-promotion and Dashboard/postflight timestamp mismatch", () => {
    const before = setup("pass", (value) => {
      value.postflight.capturedAt = timestamp(
        new Date(Date.parse(value.promotionEvidence.completedAt) - 1000),
      );
      value.dashboardAttestation.containmentCapturedAt = value.postflight.capturedAt;
    });
    assert.equal(invoke(before).status, 20);
    const mismatch = setup("pass", (value) => {
      value.dashboardAttestation.containmentValidUntil = timestamp(
        new Date(Date.parse(value.postflight.validUntil) - 1000),
      );
    });
    assert.equal(invoke(mismatch).status, 20);
  });

  it("rejects source hash substitution, malformed, oversized and secret-bearing host output", () => {
    const changed = setup("pass");
    changed.args[changed.args.indexOf("--proof-client-sha256") + 1] = HEX[0];
    assert.equal(invoke(changed).status, 20);
    for (const mode of ["malformed", "oversized", "secret-canary"]) {
      const result = invoke(setup(mode));
      assert.ok([20, 21].includes(result.status));
      assert.equal(result.stdout.toString().includes("sk_test_"), false);
    }
  });
});
