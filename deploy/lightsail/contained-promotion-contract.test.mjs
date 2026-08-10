import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalPromotionBytes,
  validatePromotionEvidence,
} from "../../scripts/validate-lightsail-contained-promotion.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const runnerPath = join(here, "scripts", "promote-contained-candidate.sh");
const localVerifierPath = join(here, "scripts", "verify-deployment-local.sh");
const caddyTestPath = join(here, "scripts", "test-caddy-origin-contract.sh");
const fixtureCommandPath = join(here, "test-fixtures", "contained-promotion-host-command.py");
const schemaPath = join(
  repositoryRoot,
  "docs",
  "schemas",
  "refunddesk-lightsail-contained-promotion-v1.schema.json",
);
const installSourcePath = join(here, "scripts", "install-source.sh");
const revision = "a".repeat(40);
const fromRevision = "b".repeat(40);
const nonce = "9".repeat(64);
const sourceSha256 = "1".repeat(64);
const containerIds = {
  postgres: "2".repeat(64),
  verifier: "3".repeat(64),
  web: "4".repeat(64),
  worker: "5".repeat(64),
  caddy: "6".repeat(64),
};
const databaseLine = "123456789012345678|0|0|0|0|0|0|7|3|4|5|6|9";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeMode(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

function manifest(bundleSha256) {
  return {
    bundle: {
      file: `refunddesk-sandbox-${revision}.images.tar.zst`,
      sha256: bundleSha256,
    },
    createdAt: "2026-08-08T20:00:00Z",
    images: ["web", "worker", "migrate"].map((role, index) => ({
      expectedUser: "node",
      imageId: `sha256:${String(index + 7).repeat(64)}`,
      reference: `refunddesk-${role}:sandbox-${revision}`,
      role,
    })),
    platform: "linux/amd64",
    revision,
    schemaVersion: 1,
    source: "https://github.com/selimhehe1/RefundDesk",
  };
}

function fakeState(overrides = {}) {
  return {
    caddyRunning: false,
    containers: {
      caddy: containerIds.caddy,
      verifier: containerIds.verifier,
      web: containerIds.web,
      worker: containerIds.worker,
    },
    databaseLine,
    fromRevision,
    listenersOpen: false,
    maintenanceRunning: false,
    migrationCount: 0,
    operationCounts: {},
    operations: [],
    postgresContainerId: containerIds.postgres,
    revision,
    timersEnabled: false,
    verifierRunning: false,
    webRunning: false,
    workerRunning: false,
    workerRuntimeMode: "incident_admission",
    ...overrides,
  };
}

async function makeFixture(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), "refunddesk-contained-promotion-test-"));
  const root = join(base, "host");
  const config = join(base, "config");
  const control = join(base, "control");
  const run = join(base, "run");
  const source = join(root, "releases", revision, "source");
  const scripts = join(source, "deploy", "lightsail", "scripts");
  const artifacts = join(base, "artifacts");
  const statePath = join(base, "state.json");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(control, { recursive: true }),
    mkdir(run, { recursive: true }),
  ]);
  await chmod(run, 0o700);
  for (const [name, sourcePath] of [
    ["promote-contained-candidate.sh", runnerPath],
    ["verify-deployment-local.sh", localVerifierPath],
    ["test-caddy-origin-contract.sh", caddyTestPath],
    ["release-transition-journal.py", join(here, "scripts", "release-transition-journal.py")],
    ["_common.sh", join(here, "scripts", "_common.sh")],
  ]) {
    const target = join(scripts, name);
    await copyFile(sourcePath, target);
    await chmod(target, 0o755);
  }
  await copyFile(join(here, "compose.yml"), join(source, "deploy", "lightsail", "compose.yml"));
  await copyFile(
    join(here, "Caddyfile.public"),
    join(source, "deploy", "lightsail", "Caddyfile.public"),
  );
  const fakeCommand = join(base, "contained-host-command.py");
  await copyFile(fixtureCommandPath, fakeCommand);
  await chmod(fakeCommand, 0o755);
  await writeMode(join(source, ".refunddesk-revision"), `${revision}\n`);
  await writeMode(join(source, ".refunddesk-source-sha256"), `${sourceSha256}\n`);
  await writeMode(join(root, "ACTIVE_REVISION"), `${fromRevision}\n`, 0o644);
  await writeMode(
    join(config, "release.env"),
    `REFUNDDESK_IMAGE_TAG=sandbox-${fromRevision}\nREFUNDDESK_REVISION=${fromRevision}\nREFUNDDESK_WORKER_RUNTIME_MODE=incident_admission\n`,
  );
  await writeMode(
    join(config, "application-key-rotation-state.json"),
    `${JSON.stringify({
      fingerprints: {
        approvalAttestation: { v1: null, v2: `sha256:${"a".repeat(64)}` },
        field: { v1: null, v2: `sha256:${"b".repeat(64)}` },
        proof: { v1: null, v2: `sha256:${"c".repeat(64)}` },
      },
      revision: fromRevision,
      schemaVersion: 2,
      states: { approvalAttestation: "active", field: "active", proof: "active" },
    })}\n`,
  );
  const bundleName = `refunddesk-sandbox-${revision}.images.tar.zst`;
  const bundleBytes = Buffer.from("synthetic-contained-bundle\n", "utf8");
  const bundleSha256 = sha256(bundleBytes);
  const bundlePath = join(artifacts, bundleName);
  await writeMode(bundlePath, bundleBytes, 0o600);
  await writeMode(join(artifacts, `${bundleName}.sha256`), `${bundleSha256}  ${bundleName}\n`);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest(bundleSha256))}\n`, "utf8");
  const manifestSha256 = sha256(manifestBytes);
  await writeMode(join(artifacts, `refunddesk-sandbox-${revision}.manifest.json`), manifestBytes);
  const provenance = {
    artifactId: 9025216948,
    attestationBundleSha256: "d".repeat(64),
    attestationId: 39599897,
    bundleEvent: "workflow_dispatch",
    bundleRunId: 31269550192,
    bundleSha256,
    bundleWorkflowPath: ".github/workflows/sandbox-images.yml",
    ciEvent: "push",
    ciRunId: 31269541134,
    ciWorkflowPath: ".github/workflows/ci.yml",
    kind: "refunddesk-contained-promotion-input-provenance",
    manifestSha256,
    rekorEntryIndex: 2386447207,
    repository: "selimhehe1/RefundDesk",
    revision,
    schemaVersion: 1,
    sourceSha256,
    verification: "github-cli-sigstore-and-actions-api-verified",
    verifiedAt: "2026-08-08T20:01:00Z",
  };
  const provenancePath = join(base, "provenance.json");
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance)}\n`, "utf8");
  await writeMode(provenancePath, provenanceBytes);
  await writeMode(statePath, `${JSON.stringify(fakeState(overrides))}\n`);
  return {
    arguments: [
      join(scripts, "promote-contained-candidate.sh"),
      "--artifact-dir",
      artifacts,
      "--revision",
      revision,
      "--expected-bundle-sha256",
      bundleSha256,
      "--expected-manifest-sha256",
      manifestSha256,
      "--expected-source-sha256",
      sourceSha256,
      "--provenance-file",
      provenancePath,
      "--expected-provenance-sha256",
      sha256(provenanceBytes),
      "--nonce",
      nonce,
    ],
    base,
    bundleSha256,
    config,
    control,
    environment: {
      ...process.env,
      REFUNDDESK_CONFIG_ROOT: config,
      REFUNDDESK_CONTAINED_PROMOTION_FAKE_STATE: statePath,
      REFUNDDESK_CONTAINED_PROMOTION_HOST_COMMAND: fakeCommand,
      REFUNDDESK_CONTAINED_PROMOTION_TEST_MODE: "1",
      REFUNDDESK_CONTROL_ROOT: control,
      REFUNDDESK_OPERATOR_LOCK: join(run, "operator.lock"),
      REFUNDDESK_POSTGRES_HOST_PGDATA: join(base, "pgdata"),
      REFUNDDESK_ROOT: root,
    },
    manifestSha256,
    provenancePath,
    provenanceSha256: sha256(provenanceBytes),
    root,
    statePath,
  };
}

function runRunner(fixture, environment = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", fixture.arguments, {
      env: { ...fixture.environment, ...environment },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stderr, stdout }));
  });
}

function runRunnerWithInheritedLock(fixture, wrongDescriptor = false) {
  return new Promise((resolveResult, reject) => {
    const lockPath = wrongDescriptor
      ? join(fixture.base, "run", "wrong-operator.lock")
      : fixture.environment.REFUNDDESK_OPERATOR_LOCK;
    const child = spawn(
      "bash",
      [
        "-c",
        'set -Eeuo pipefail; umask 077; exec 9>"$1"; flock --exclusive 9; shift; exec bash "$@" --operator-lock-inherited',
        "contained-inherited-lock",
        lockPath,
        ...fixture.arguments,
      ],
      { env: fixture.environment, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stderr, stdout }));
  });
}

async function readState(fixture) {
  return JSON.parse(await readFile(fixture.statePath, "utf8"));
}

test("contained promotion evidence schema and validator are strict", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.$defs.passEvidence.additionalProperties, false);
  assert.equal(schema.$defs.nonPassEvidence.additionalProperties, false);
  assert.equal(schema.$defs.passEvidence.properties.kind.const, "refunddesk-contained-promotion");
  assert.equal(
    schema.$defs.passEvidence.properties.code.const,
    "PASS_CONTAINED_CANDIDATE_PROMOTED",
  );
  assert.equal(schema.$defs.containment.additionalProperties, false);
  assert.equal(schema.$defs.database.additionalProperties, false);
  assert.equal(schema.$defs.effects.additionalProperties, false);
  assert.equal(schema.$defs.redaction.additionalProperties, false);
  assert.equal(schema.$defs.runtime.additionalProperties, false);
});

test("runner is contained, journalled, owner-migrated and never invokes legacy recovery", async () => {
  const [runner, verifier, caddyTest, caddyfile, installSource] = await Promise.all([
    readFile(runnerPath, "utf8"),
    readFile(localVerifierPath, "utf8"),
    readFile(caddyTestPath, "utf8"),
    readFile(join(here, "Caddyfile.public"), "utf8"),
    readFile(installSourcePath, "utf8"),
  ]);
  assert.match(runner, /acquire_operator_lock/u);
  assert.match(runner, /adopt_inherited_operator_lock/u);
  assert.match(runner, /write_journal committing/u);
  assert.match(runner, /clear_database_owner_job_reservation/u);
  assert.match(runner, /--profile release run/u);
  assert.match(runner, /REFUNDDESK_RUNTIME_RESTART_POLICY=no/u);
  assert.match(runner, /REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission/u);
  assert.match(verifier, /REFUNDDESK_WORKER_RUNTIME_MODE=incident_admission/u);
  assert.doesNotMatch(runner, /docker container ls --all --quiet/u);
  assert.doesNotMatch(verifier, /docker container ls --all --quiet/u);
  assert.match(
    runner,
    /systemctl disable --now refunddesk-backup\.timer refunddesk-retention\.timer/u,
  );
  assert.doesNotMatch(runner, /\brelease\.sh\b[^\n]*--artifact-dir/u);
  assert.doesNotMatch(runner, /recover-quiesced-runtime\.sh[^:]/u);
  assert.doesNotMatch(runner, /docker compose[^\n]*(?:start|up)[^\n]*(?:worker|caddy)/u);
  assert.doesNotMatch(runner, /\b(?:aws|curl|wget)\b/u);
  assert.doesNotMatch(verifier, /PUBLIC_ORIGIN|cloudfront\.net|https:\/\//u);
  assert.match(caddyTest, /--network none/u);
  assert.match(caddyTest, /caddy adapt/u);
  assert.match(caddyTest, /caddy validate/u);
  assert.equal(caddyTest.match(/--pull never/gu)?.length, 2);
  assert.match(caddyTest, /NetworkMode/u);
  assert.match(caddyTest, /missing origin token was not rejected with 404/u);
  assert.match(caddyTest, /incorrect origin token was not rejected with 404/u);
  assert.match(caddyTest, /source=\$\{CADDYFILE\},target=\/etc\/caddy\/Caddyfile,readonly/u);
  assert.match(caddyfile, /header_up -X-RefundDesk-Origin-Token/u);
  assert.match(caddyfile, /refunddesk_cloudfront_viewer_chain/u);
  assert.match(caddyTest, /autosave\.json/u);
  assert.match(installSource, /--no-quiesce-recovery/u);
  assert.match(installSource, /--operator-lock-inherited/u);
});

test(
  "runner adopts only the exact inherited operator-lock descriptor",
  { skip: process.platform !== "linux", timeout: 120_000 },
  async () => {
    const admitted = await makeFixture();
    const rejected = await makeFixture();
    try {
      const pass = await runRunnerWithInheritedLock(admitted);
      assert.equal(pass.code, 0, pass.stderr);
      assert.equal(JSON.parse(pass.stdout).result, "PASS");
      const fail = await runRunnerWithInheritedLock(rejected, true);
      assert.notEqual(fail.code, 0);
      assert.deepEqual((await readState(rejected)).operations, []);
    } finally {
      await Promise.all([
        rm(admitted.base, { recursive: true, force: true }),
        rm(rejected.base, { recursive: true, force: true }),
      ]);
    }
  },
);

test(
  "fake host proves success, exact evidence and containment",
  { skip: process.platform !== "linux", timeout: 120_000 },
  async () => {
    const fixture = await makeFixture();
    try {
      const result = await runRunner(fixture);
      assert.equal(result.signal, null);
      assert.equal(result.code, 0, result.stderr);
      const evidence = JSON.parse(result.stdout);
      validatePromotionEvidence(evidence, {
        bundleSha256: fixture.bundleSha256,
        manifestSha256: fixture.manifestSha256,
        nonce,
        provenanceSha256: fixture.provenanceSha256,
        revision,
        sourceSha256,
      });
      assert.equal(result.stdout, canonicalPromotionBytes(evidence).toString("utf8"));
      const state = await readState(fixture);
      assert.equal(state.migrationCount, 1);
      assert.equal(state.workerRunning, false);
      assert.equal(state.caddyRunning, false);
      assert.equal(state.webRunning, true);
      assert.equal(state.verifierRunning, true);
      assert.equal(evidence.runtime.workerRuntimeMode, "incident_admission");
      assert.ok(!state.operations.includes("start-worker"));
      assert.ok(!state.operations.includes("start-caddy"));
      assert.equal(await readFile(join(fixture.root, "ACTIVE_REVISION"), "utf8"), `${revision}\n`);
      assert.equal(
        await readFile(join(fixture.config, "release.env"), "utf8"),
        `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\nREFUNDDESK_WORKER_RUNTIME_MODE=incident_admission\n`,
      );
      const beforeReplayCounts = { ...state.operationCounts };
      const replay = await runRunner(fixture);
      assert.equal(replay.code, 0, replay.stderr);
      assert.equal(replay.stdout, result.stdout);
      const replayedState = await readState(fixture);
      assert.equal(replayedState.migrationCount, 1);
      assert.equal(replayedState.operationCounts.migrate, beforeReplayCounts.migrate);
      assert.equal(replayedState.operationCounts.recreate, beforeReplayCounts.recreate);
      assert.equal(replayedState.operationCounts["assert-completed-state"], 1);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  },
);

test(
  "every durable phase can crash and resume the exact operation",
  { skip: process.platform !== "linux", timeout: 240_000 },
  async (t) => {
    for (const phase of [
      "prepared",
      "contained",
      "images_loaded",
      "database_prepared",
      "candidate_inert",
      "candidate_verified",
      "committing",
      "metadata_committed",
      "complete",
      "evidence_written",
    ]) {
      await t.test(phase, async () => {
        const fixture = await makeFixture();
        try {
          const crashed = await runRunner(fixture, {
            REFUNDDESK_CONTAINED_PROMOTION_TEST_CRASH_AFTER: phase,
          });
          assert.equal(crashed.signal, "SIGKILL");
          const resumed = await runRunner(fixture);
          assert.equal(resumed.code, 0, resumed.stderr);
          const evidence = JSON.parse(resumed.stdout);
          assert.equal(evidence.resumed, phase !== "evidence_written");
          assert.equal(evidence.result, "PASS");
          const state = await readState(fixture);
          assert.equal(state.workerRunning, false);
          assert.equal(state.caddyRunning, false);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "a durable operation resumes after one hour while the final invocation stays bounded",
  { skip: process.platform !== "linux", timeout: 120_000 },
  async () => {
    const fixture = await makeFixture();
    const journalPath = join(fixture.control, "contained-promotion-in-progress.json");
    try {
      const crashed = await runRunner(fixture, {
        REFUNDDESK_CONTAINED_PROMOTION_TEST_CRASH_AFTER: "prepared",
      });
      assert.equal(crashed.signal, "SIGKILL");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      const operationStartedAt = new Date(Date.now() - 3_600_000)
        .toISOString()
        .replace(/\.[0-9]{3}Z$/u, "Z");
      journal.operationStartedAt = operationStartedAt;
      journal.startedAt = operationStartedAt;
      await writeMode(journalPath, `${JSON.stringify(journal)}\n`);

      const resumed = await runRunner(fixture);
      assert.equal(resumed.code, 0, resumed.stderr);
      const evidence = JSON.parse(resumed.stdout);
      validatePromotionEvidence(evidence, {
        bundleSha256: fixture.bundleSha256,
        manifestSha256: fixture.manifestSha256,
        nonce,
        provenanceSha256: fixture.provenanceSha256,
        revision,
        sourceSha256,
      });
      assert.equal(evidence.operationStartedAt, operationStartedAt);
      assert.equal(evidence.resumed, true);
      assert.ok(Date.parse(evidence.startedAt) - Date.parse(operationStartedAt) >= 3_500_000);
      assert.ok(Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt) <= 900_000);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  },
);

test(
  "negative fake-host cases fail closed and preserve the monotone journal",
  { skip: process.platform !== "linux", timeout: 180_000 },
  async (t) => {
    for (const [name, override, preEffect] of [
      ["migration failure", { failOperation: "migrate", failOperationCount: 1 }, false],
      ["database count drift", { databaseDriftAfterMigrate: true }, false],
      ["postgres recreation", { postgresRecreatedAfterMigrate: true }, false],
      ["invalid local verification", { invalidVerification: true }, false],
      ["effect service start", { unsafeStartEffectServices: true }, false],
      ["foreign project container", { foreignContainer: true }, true],
      ["missing runtime container", { missingRuntimeContainer: true }, true],
      ["invalid owner reservation", { invalidOwnerReservation: true }, true],
      ["wrong worker runtime mode", { workerRuntimeMode: "normal" }, false],
      [
        "nonquiescent financial snapshot",
        { databaseLine: "123456789012345678|1|0|0|0|0|0|7|3|4|5|6|9" },
        true,
      ],
    ]) {
      await t.test(name, async () => {
        const fixture = await makeFixture(override);
        try {
          const result = await runRunner(fixture);
          assert.notEqual(result.code, 0);
          assert.equal(
            await readFile(join(fixture.root, "ACTIVE_REVISION"), "utf8"),
            `${fromRevision}\n`,
          );
          const state = await readState(fixture);
          assert.equal(state.workerRunning, false);
          assert.equal(state.caddyRunning, false);
          assert.equal(state.webRunning, false);
          assert.equal(state.verifierRunning, false);
          if (preEffect) {
            assert.ok(!state.operations.includes("contain"));
            await assert.rejects(
              readFile(join(fixture.control, "contained-promotion-in-progress.json"), "utf8"),
              { code: "ENOENT" },
            );
          } else {
            assert.ok(state.operations.at(-1) === "contain");
            await readFile(join(fixture.control, "contained-promotion-in-progress.json"), "utf8");
          }
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "post-commit failure is forward-only and resumable",
  { skip: process.platform !== "linux", timeout: 120_000 },
  async () => {
    const fixture = await makeFixture({ failOperation: "start-core", failOperationCount: 2 });
    try {
      const failed = await runRunner(fixture);
      assert.notEqual(failed.code, 0);
      assert.equal(await readFile(join(fixture.root, "ACTIVE_REVISION"), "utf8"), `${revision}\n`);
      const failure = JSON.parse(
        await readFile(
          join(
            fixture.control,
            `contained-promotion-${revision}-${nonce.slice(0, 12)}.failure.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(failure.code, "INCOMPLETE_CONTAINED_PROMOTION_POST_COMMIT");
      assert.equal(failure.result, "INCOMPLETE");
      validatePromotionEvidence(failure, {
        bundleSha256: fixture.bundleSha256,
        manifestSha256: fixture.manifestSha256,
        nonce,
        provenanceSha256: fixture.provenanceSha256,
        revision,
        sourceSha256,
      });
      const state = await readState(fixture);
      delete state.failOperation;
      delete state.failOperationCount;
      await writeMode(fixture.statePath, `${JSON.stringify(state)}\n`);
      const resumed = await runRunner(fixture);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).resumed, true);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  },
);

test(
  "an unresolved quiescence journal blocks before every host mutation",
  { skip: process.platform !== "linux", timeout: 60_000 },
  async () => {
    const fixture = await makeFixture();
    try {
      await writeMode(join(fixture.control, "runtime-quiesce-in-progress.json"), "{}\n");
      const result = await runRunner(fixture);
      assert.notEqual(result.code, 0);
      const state = await readState(fixture);
      assert.deepEqual(state.operations, []);
      assert.equal(
        await readFile(join(fixture.root, "ACTIVE_REVISION"), "utf8"),
        `${fromRevision}\n`,
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  },
);

test(
  "operator lock serializes two exact concurrent invocations",
  { skip: process.platform !== "linux", timeout: 120_000 },
  async () => {
    const fixture = await makeFixture();
    try {
      const [first, second] = await Promise.all([runRunner(fixture), runRunner(fixture)]);
      assert.equal([first.code, second.code].filter((code) => code === 0).length, 2);
      const state = await readState(fixture);
      assert.equal(state.migrationCount, 1);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  },
);
