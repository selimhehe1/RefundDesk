import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers";

import {
  parseCanonicalEdgeWindowDocument,
  sortJsonKeys,
  validateEdgeWindowDocument,
} from "../../scripts/validate-lightsail-edge-window.mjs";

const { structuredClone } = globalThis;

const repository = resolve(import.meta.dirname, "../..");
const runnerPath = join(repository, "deploy/lightsail/scripts/prove-bounded-edge-window.sh");
const watchdogPath = join(
  repository,
  "deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh",
);
const fixturePath = join(repository, "deploy/lightsail/test-fixtures/edge-window-host-command.py");
const servicePath = join(
  repository,
  "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service",
);
const timerPath = join(
  repository,
  "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer",
);
const caddyPath = join(repository, "deploy/lightsail/Caddyfile.public");
const releasePath = join(repository, "deploy/lightsail/scripts/release.sh");
const recoveryPath = join(repository, "deploy/lightsail/scripts/recover-quiesced-runtime.sh");
const schemaPath = join(repository, "docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json");
const wrapperPath = join(repository, "scripts/invoke-lightsail-edge-window.ps1");
const operatorDockerfilePath = join(repository, "deploy/lightsail/edge-operator.Dockerfile");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
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
const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
});
const revision = revisionResult.status === 0 ? revisionResult.stdout.trim() : "b".repeat(40);
const nonce = "a".repeat(64);
const eventFingerprint = "c".repeat(64);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function canonical(value) {
  return `${JSON.stringify(sortJsonKeys(value))}\n`;
}

function canonicalSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(sortJsonKeys(value)), "utf8"));
}

function sources() {
  return sourcePaths.map((path) => {
    const sourceSha256 = sha256File(join(repository, path));
    return { headSha256: sourceSha256, indexSha256: sourceSha256, path, sourceSha256 };
  });
}

function controlDocument(transport) {
  const sourceRecords = sources();
  return {
    admission: {
      authorizationAccepted: true,
      authorizationEvidenceSha256: "1".repeat(64),
      authorizationMaxWindowSeconds: 300,
      authorizationValidFrom: "2026-08-08T11:50:00Z",
      authorizationValidUntil: "2026-08-08T12:45:00Z",
      authorizedAwsAccountIdSha256: sha256Text(transport.awsAccountId),
      authorizedAwsRegionSha256: sha256Text(transport.awsRegion),
      authorizedDistributionIdSha256: sha256Text(transport.distributionId),
      authorizedInstanceNameSha256: sha256Text(transport.instanceName),
      authorizedOriginIdSha256: sha256Text(transport.originId),
      authorizedPublicBaseUrlSha256: sha256Text(transport.publicBaseUrl),
      authorizedSshCidrSha256: sha256Text(transport.expectedSshCidr),
      authorizedSshHostSha256: sha256Text(transport.targetHost),
      incidentAccepted: true,
      incidentCapturedAt: "2026-08-08T11:59:30Z",
      incidentEvidenceSha256: "2".repeat(64),
      incidentRemainingSecondsAtStart: 899,
      incidentValidUntil: "2026-08-08T12:14:59Z",
      postflightAccepted: true,
      postflightCapturedAt: "2026-08-08T11:59:00Z",
      postflightEvidenceSha256: "3".repeat(64),
      postflightRemainingSecondsAtStart: 900,
      postflightValidUntil: "2026-08-08T12:15:00Z",
      promotionAccepted: true,
      promotionCaddyContainerIdSha256: sha256Text(transport.caddyContainerId),
      promotionDatabaseSystemIdentifierSha256: "6".repeat(64),
      promotionEvidenceSha256: "4".repeat(64),
      promotionPostgresContainerIdSha256: sha256Text(transport.postgresContainerId),
      promotionVerifierContainerIdSha256: sha256Text(transport.verifierContainerId),
      promotionWebContainerIdSha256: sha256Text(transport.webContainerId),
      promotionWorkerContainerIdSha256: sha256Text(transport.workerContainerId),
      promotionWorkerRuntimeMode: "incident_admission",
      promotionRevision: revision,
    },
    eventFingerprintSha256: eventFingerprint,
    expectedRevision: revision,
    kind: "refunddesk.edge-window-control",
    nonce,
    operationRemainingSecondsAtRunnerStart: 1860,
    operationStartedAt: "2026-08-08T12:00:00Z",
    operatorBootIdentifierSha256: "d".repeat(64),
    operatorControlCalculatedMonotonicMilliseconds: 1_000_000,
    operatorDeadlineMonotonicMilliseconds: 3_100_000,
    operatorStartedMonotonicMilliseconds: 1_000_000,
    postIncidentBaseline: {
      activeFinancialJobs: 0,
      auditEvents: 2088,
      mutationReceipts: 34,
      refundExecutionAttempts: 34,
      refundExecutions: 34,
      refundRequests: 34,
      snapshotSha256: "471d268c41b0c22019ebe468e3f49ea4a0eb1805a5fbe0814ddcf86ffe361c37",
      unreleasedPaymentGuards: 0,
      webhookReceipts: 41,
    },
    provenance: {
      fixtureOnly: true,
      operatorLockHeld: true,
      repositoryHead: revision,
      repositoryIndexSha256: canonicalSha256(
        sourceRecords.map(({ indexSha256, path }) => ({ indexSha256, path })),
      ),
      sourceBundleSha256: canonicalSha256(sourceRecords),
      sources: sourceRecords,
      sourcesExact: true,
      transportInputsSha256: sha256Bytes(Buffer.from(canonical(transport), "utf8")),
      transportInputsPinned: true,
      toolImageIdSha256: "b".repeat(64),
      workflowRunId: 31269550192,
      workflowRunObservationSha256: "c".repeat(64),
    },
    schemaVersion: 1,
    windowSeconds: 300,
  };
}

function transportDocument(root) {
  const gitResult = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" });
  assert.equal(gitResult.status, 0, gitResult.stderr);
  const gitExecutable = realpathSync(gitResult.stdout.trim());
  const nodeExecutable = realpathSync(process.execPath);
  const sshConfigPath = join(root, "ssh-config");
  const sshConfig = [
    "Host refunddesk-edge",
    "  HostName 192.0.2.44",
    "  User ubuntu",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  GSSAPIAuthentication no",
    "  IdentitiesOnly yes",
    "  IdentityFile /operator/ssh/id",
    "  UserKnownHostsFile /operator/ssh/known_hosts",
    "  StrictHostKeyChecking yes",
    "  ForwardAgent no",
    "  ClearAllForwardings yes",
    "  PermitLocalCommand no",
    "  RequestTTY no",
    "  SendEnv -*",
    "  IdentityAgent none",
    "  LogLevel ERROR",
    "",
  ].join("\n");
  const awsConfigPath = join(root, "aws-config");
  const awsConfig = "[default]\nregion = eu-west-3\noutput = json\n";
  writeFileSync(sshConfigPath, sshConfig, { mode: 0o600 });
  chmodSync(sshConfigPath, 0o600);
  writeFileSync(awsConfigPath, awsConfig, { mode: 0o600 });
  chmodSync(awsConfigPath, 0o600);
  return {
    awsAccountId: "123456789012",
    awsConfigSha256: sha256File(awsConfigPath),
    awsRegion: "eu-west-3",
    caddyContainerId: "e".repeat(64),
    distributionId: "E123456789ABC",
    expectedSshCidr: "192.0.2.45/32",
    gitExecutable,
    gitSha256: sha256File(gitExecutable),
    instanceName: "refunddesk-sandbox",
    nodeExecutable,
    nodeSha256: sha256File(nodeExecutable),
    originId: "refunddesk-lightsail-origin",
    postgresContainerId: "f".repeat(64),
    publicBaseUrl: "https://sandbox.example.test",
    sshConfigPath,
    sshConfigSha256: sha256File(sshConfigPath),
    sshHost: "refunddesk-edge",
    targetHost: "192.0.2.44",
    verifierContainerId: "1".repeat(64),
    webContainerId: "2".repeat(64),
    workerContainerId: "3".repeat(64),
  };
}

const linuxContractAvailable = (() => {
  if (process.platform === "win32") {
    return false;
  }
  const result = spawnSync(
    "bash",
    ["-lc", "command -v jq >/dev/null && command -v python3 >/dev/null"],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0;
})();
const systemdAnalyzeAvailable =
  linuxContractAvailable &&
  spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" }).status === 0;

function scenarioState(scenario) {
  return {
    caddyRunning: false,
    firewallOpen: false,
    operations: [],
    originBound: false,
    scenario,
    timestamps: [
      "2026-08-08T12:00:00Z",
      "2026-08-08T12:00:20Z",
      "2026-08-08T12:00:30Z",
      "2026-08-08T12:01:30Z",
      "2026-08-08T12:01:40Z",
    ],
    unitStates: {},
    watchdogArmed: false,
    workerRunning: false,
  };
}

function runScenario(
  scenario,
  {
    controlMutator,
    crashPoint,
    environmentPatch = {},
    mode = "run",
    signalPoint,
    statePatch = {},
    timeout = 30_000,
    transportMutator,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-window-test-"));
  const controlRoot = join(root, "control");
  const runtimeRoot = join(root, "runtime");
  mkdirSync(controlRoot, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o700 });
  chmodSync(root, 0o700);
  const command = join(root, "edge-window-host-command.py");
  copyFileSync(fixturePath, command);
  chmodSync(command, 0o700);
  const statePath = join(root, "state.json");
  const controlPath = join(controlRoot, "control.json");
  const checkpointPath = join(controlRoot, "workbench.json");
  const requestPath = join(controlRoot, "workbench-request.json");
  const transportPath = join(controlRoot, "transport.json");
  const transport = transportDocument(root);
  if (transportMutator !== undefined) {
    transportMutator(transport, root);
  }
  writeFileSync(statePath, canonical({ ...scenarioState(scenario), ...statePatch }), {
    mode: 0o600,
  });
  const control = controlDocument(transport);
  if (controlMutator !== undefined) {
    controlMutator(control);
  }
  writeFileSync(controlPath, canonical(control), { mode: 0o600 });
  writeFileSync(transportPath, canonical(transport), { mode: 0o600 });
  chmodSync(transportPath, 0o600);
  const environment = {
    ...process.env,
    ...environmentPatch,
    AWS_CONFIG_FILE: join(root, "aws-config"),
    REFUNDDESK_EDGE_WINDOW_COMMAND: command,
    REFUNDDESK_EDGE_WINDOW_CONTROL_ROOT: controlRoot,
    REFUNDDESK_EDGE_WINDOW_FAKE_STATE: statePath,
    REFUNDDESK_EDGE_WINDOW_RUNTIME_ROOT: runtimeRoot,
    REFUNDDESK_EDGE_WINDOW_TEST_MODE: "1",
    REFUNDDESK_EDGE_WINDOW_TRANSPORT_FILE: transportPath,
  };
  if (crashPoint !== undefined) {
    environment.REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT = crashPoint;
  }
  if (signalPoint !== undefined) {
    environment.REFUNDDESK_EDGE_WINDOW_TEST_SIGNAL_POINT = signalPoint;
  }
  if (scenario === "checkpoint-overwrite-race") {
    environment.REFUNDDESK_EDGE_WINDOW_TEST_CHECKPOINT_SNAPSHOT_DELAY = "1";
  }
  const result = spawnSync(
    "bash",
    [
      runnerPath,
      "--mode",
      mode,
      "--nonce",
      nonce,
      "--expected-revision",
      revision,
      "--control-file",
      controlPath,
      "--workbench-checkpoint",
      checkpointPath,
      "--checkpoint-request",
      requestPath,
      "--transport-file",
      transportPath,
    ],
    { encoding: "utf8", env: environment, timeout },
  );
  return {
    checkpointPath,
    command,
    controlPath,
    controlRoot,
    environment,
    requestPath,
    result,
    root,
    runtimeRoot,
    statePath,
    transportPath,
  };
}

function cleanupScenario(run) {
  rmSync(run.root, { force: true, recursive: true });
}

function resumeScenario(run, { crashPoint = "", mode = "cleanup", timeout = 30_000 } = {}) {
  return spawnSync(
    "bash",
    [
      runnerPath,
      "--mode",
      mode,
      "--nonce",
      nonce,
      "--expected-revision",
      revision,
      "--control-file",
      run.controlPath,
      "--workbench-checkpoint",
      run.checkpointPath,
      "--checkpoint-request",
      run.requestPath,
      "--transport-file",
      run.transportPath,
    ],
    {
      encoding: "utf8",
      env: {
        ...run.environment,
        REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: crashPoint,
        REFUNDDESK_EDGE_WINDOW_TEST_FINAL_REQUEST_CRASH: "",
        REFUNDDESK_EDGE_WINDOW_TEST_SIGNAL_POINT: "",
      },
      timeout,
    },
  );
}

function parseEvidence(result) {
  return parseCanonicalEdgeWindowDocument(Buffer.from(result.stdout, "utf8"));
}

function validateFixtureEvidence(document, processExitCode) {
  try {
    validateEdgeWindowDocument(document, {
      allowFixture: true,
      expectedNonce: nonce,
      expectedRevision: revision,
      processExitCode,
      schema,
    });
  } catch (error) {
    error.message = `${error.message}\n${JSON.stringify({ containment: document.containment, origin: document.origin, probes: document.probes.finalPostflight, watchdog: document.watchdog, window: document.window })}`;
    throw error;
  }
}

test("Caddy, schema and runner share the exact origin-token matcher and strip contract", () => {
  const caddy = readFileSync(caddyPath, "utf8");
  const runner = readFileSync(runnerPath, "utf8");
  const schemaText = readFileSync(schemaPath, "utf8");
  assert.match(
    caddy,
    /@unverified_edge not header X-RefundDesk-Origin-Token \{\$REFUNDDESK_EDGE_ORIGIN_TOKEN\}/u,
  );
  assert.match(caddy, /header_up -X-RefundDesk-Origin-Token/u);
  assert.match(runner, /headerName:"X-RefundDesk-Origin-Token"/u);
  assert.match(schemaText, /"const": "X-RefundDesk-Origin-Token"/u);
  assert.doesNotMatch(runner + schemaText, /X-RefundDesk-Origin-Verify/u);
});

test(
  "the production origin token reader accepts the exact 43 bytes without a trailing newline",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    assert.match(
      runner,
      /token_value="\$\(<"\$\{token\}"\)"[\s\S]*?\[\[ "\$\{token_value\}" =~ \^\[A-Za-z0-9_-\]\{43\}\$ \]\]/u,
    );
    assert.match(runner, /printf '%s\\n' "\$\{token_value\}"/u);
    assert.match(
      runner,
      /while len\(token_input\) <= 44:[\s\S]*?os\.read\(3, 45 - len\(token_input\)\)/u,
    );
    assert.match(
      runner,
      /token_input\.endswith\(b"\\n"\)[\s\S]*?token_input\.count\(b"\\n"\) != 1/u,
    );
    assert.match(runner, /token_pattern\.fullmatch\(expected_token\) is None/u);
    const token = "A".repeat(43);
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'set -eu; token_value="$(cat)"; [[ "${token_value}" =~ ^[A-Za-z0-9_-]{43}$ ]]; printf "%s\\n" "${token_value}" | { IFS= read -r token; [[ "${token}" =~ ^[A-Za-z0-9_-]{43}$ ]]; printf "%s" accepted; }',
      ],
      { encoding: "utf8", input: token, timeout: 2000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "accepted");
  },
);

test("watchdog uses an immutable stable path, a self-hash marker and no internet socket family", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const watchdog = readFileSync(watchdogPath, "utf8");
  const service = readFileSync(servicePath, "utf8");
  const timer = readFileSync(timerPath, "utf8");
  assert.match(service, /ExecStart=\/usr\/local\/libexec\/refunddesk-edge-window-watchdog\.sh/u);
  assert.doesNotMatch(service, /\/opt\/refunddesk\/current/u);
  assert.doesNotMatch(service, /^Requires=docker\.service$/mu);
  assert.doesNotMatch(service, /^After=docker\.service$/mu);
  assert.match(
    service,
    /^ReadWritePaths=\/var\/lib\/refunddesk\/control \/run\/refunddesk -\/run\/docker\.sock$/mu,
  );
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_NETLINK/u);
  assert.match(service, /^Environment=PATH=\/usr\/bin:\/bin$/mu);
  assert.match(service, /^Environment=DOCKER_HOST=unix:\/\/\/run\/docker\.sock$/mu);
  assert.match(
    service,
    /^Environment=DOCKER_CONFIG=\/run\/refunddesk\/edge-window-watchdog-docker-config$/mu,
  );
  assert.match(
    service,
    /^UnsetEnvironment=DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY DOCKER_TLS$/mu,
  );
  assert.match(service, /^ExecSearchPath=\/usr\/bin:\/bin$/mu);
  assert.match(service, /TimeoutStartSec=180s/u);
  assert.match(watchdog, /timeout --signal=TERM --kill-after=1s 2s systemctl stop/u);
  assert.match(watchdog, /timeout --signal=TERM --kill-after=1s 1s systemctl kill/u);
  assert.match(watchdog, /kill-container-scope/u);
  assert.match(watchdog, /systemctl kill --kill-who=all --signal=KILL -- "docker-\$1\.scope"/u);
  assert.match(watchdog, /systemctl kill --kill-who=all --signal=KILL -- docker\.service/u);
  assert.doesNotMatch(service, /AF_INET/u);
  assert.match(watchdog, /watchdogSha256/u);
  assert.match(watchdog, /sha256sum -- "\$0"/u);
  assert.match(watchdog, /refunddesk-release-\(fence-\)\?/u);
  assert.match(timer, /OnBootSec=1s/u);
  assert.match(timer, /OnUnitActiveSec=1s/u);
  assert.match(timer, /AccuracySec=1ms/u);
  assert.match(watchdog, /effective_units_valid/u);
  assert.match(watchdog, /--property=DropInPaths/u);
  assert.match(watchdog, /--property=FragmentPath/u);
  assert.match(watchdog, /--property=OnUnitActiveUSec/u);
  assert.match(
    watchdog,
    /argv\[\]=\/usr\/local\/libexec\/refunddesk-edge-window-watchdog\.sh ; ignore_errors=no/u,
  );
  assert.match(
    runner,
    /argv\[\]=\/usr\/local\/libexec\/refunddesk-edge-window-watchdog\.sh ; ignore_errors=no/u,
  );
  assert.match(watchdog, /DEADLINE_CONTAINMENT_GUARD_MILLISECONDS=25000/u);
  assert.match(watchdog, /DEADLINE_HARD_FENCE_WORST_CASE_SECONDS=8/u);
  assert.match(watchdog, /readonly DOCKER_BIN=\/usr\/bin\/docker/u);
  assert.match(watchdog, /readonly DOCKER_SOCKET=\/run\/docker\.sock/u);
  assert.match(watchdog, /readonly DOCKER_HOST_VALUE=unix:\/\/\/run\/docker\.sock/u);
  assert.match(watchdog, /env -i PATH=\/usr\/bin:\/bin HOME=\/nonexistent LC_ALL=C/u);
  assert.doesNotMatch(watchdog, /timeout[^\n]*\sdocker\s/u);
  assert.ok(
    watchdog.indexOf("load_clock_state || clock_incomplete") <
      watchdog.indexOf("effective_units_valid || clock_incomplete"),
  );
  assert.match(readFileSync(runnerPath, "utf8"), /assert_effective_units/u);
  assert.ok(
    watchdog.indexOf("for service in caddy worker") < watchdog.indexOf("refunddesk-backup.timer"),
    "the deadline path must fence and stop Caddy before unrelated units",
  );
  assert.match(
    runnerPath && readFileSync(runnerPath, "utf8"),
    /systemctl enable --now refunddesk-edge-window-watchdog\.timer/u,
  );
  assert.match(
    readFileSync(runnerPath, "utf8"),
    /systemctl disable --now refunddesk-edge-window-watchdog\.timer/u,
  );
  assert.match(watchdog, /edge-window-watchdog-preflight\.json/u);
});

test(
  "watchdog Docker calls ignore inherited daemon, context, config and PATH decoys",
  { skip: !linuxContractAvailable },
  () => {
    const watchdog = readFileSync(watchdogPath, "utf8");
    const helpers = watchdog.match(
      /docker_cli_environment_valid\(\) \{[\s\S]*?\n\}\n\ndocker_cli_bounded\(\) \{[\s\S]*?\n\}/u,
    );
    assert.ok(helpers?.[0]);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-watchdog-docker-env-"));
    try {
      const dockerBin = join(root, "docker-exact");
      const config = join(root, "config");
      const log = join(root, "observed");
      mkdirSync(config, { mode: 0o555 });
      writeFileSync(
        dockerBin,
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'log="${@: -1}"',
          'printf \'%s\\n\' "PATH=${PATH}" "HOME=${HOME}" "LC_ALL=${LC_ALL}" "DOCKER_HOST=${DOCKER_HOST}" "DOCKER_CONFIG=${DOCKER_CONFIG}" "DOCKER_CONTEXT=${DOCKER_CONTEXT-unset}" "DOCKER_TLS_VERIFY=${DOCKER_TLS_VERIFY-unset}" "ARGS=$*" >"${log}"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(dockerBin, 0o700);
      const invocation = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -eu",
            "export PATH=/usr/bin:/bin",
            `DOCKER_BIN=${JSON.stringify(dockerBin)}`,
            "DOCKER_SOCKET=/run/docker.sock",
            "DOCKER_HOST_VALUE=unix:///run/docker.sock",
            `DOCKER_CONFIG_ROOT=${JSON.stringify(config)}`,
            "DOCKER_CLI_ENVIRONMENT_VALID=true",
            "REFUNDDESK_EDGE_WINDOW_TEST_MODE=1",
            helpers[0],
            `docker_cli_bounded 2s probe ${JSON.stringify(log)}`,
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DOCKER_CONFIG: "/tmp/decoy-config",
            DOCKER_CONTEXT: "decoy-context",
            DOCKER_HOST: "tcp://127.0.0.1:2375",
            DOCKER_TLS_VERIFY: "1",
          },
          timeout: 5000,
        },
      );
      assert.equal(invocation.status, 0, invocation.stderr);
      const observed = readFileSync(log, "utf8");
      assert.match(observed, /^PATH=\/usr\/bin:\/bin$/mu);
      assert.match(observed, /^HOME=\/nonexistent$/mu);
      assert.match(observed, /^LC_ALL=C$/mu);
      assert.match(observed, /^DOCKER_HOST=unix:\/\/\/run\/docker\.sock$/mu);
      assert.match(
        observed,
        new RegExp(`^DOCKER_CONFIG=${config.replaceAll("\\", "\\\\")}$`, "mu"),
      );
      assert.match(observed, /^DOCKER_CONTEXT=unset$/mu);
      assert.match(observed, /^DOCKER_TLS_VERIFY=unset$/mu);
      assert.match(
        observed,
        new RegExp(
          `^ARGS=--host unix:\\/\\/\\/run\\/docker\\.sock --config ${config.replaceAll("\\", "\\\\")} probe `,
          "mu",
        ),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("the local orchestrator keeps immutable inputs outside the writable state volume", () => {
  const runner = readFileSync(runnerPath, "utf8");
  assert.match(
    runner,
    /"\$\{CONTROL_FILE\}" == "\/var\/lib\/refunddesk\/input\/control-\$\{NONCE\}\.json"/u,
  );
  assert.match(
    runner,
    /"\$\{TRANSPORT_FILE\}" == "\/var\/lib\/refunddesk\/input\/transport-\$\{NONCE\}\.json"/u,
  );
  assert.match(runner, /immutable_input_directory\(\)/u);
  assert.match(runner, /== "0:0:555:2"/u);
  assert.match(runner, /immutable_input_file\(\)/u);
  assert.match(runner, /== "0:0:444:1"/u);
  assert.match(runner, /immutable_input_file "\$\{CONTROL_FILE\}"/u);
  assert.match(runner, /immutable_input_file "\$\{TRANSPORT_FILE\}"/u);
  assert.match(runner, /immutable_input_file "\$\{ssh_config\}"/u);
  assert.match(runner, /sshConfigSha256/u);
  assert.match(runner, /awsConfigSha256/u);
  assert.match(runner, /"\$\{ssh_config\}" == "\/var\/lib\/refunddesk\/input\/ssh-config"/u);
});

test("CloudFront recovery documents are published only from durable private pending files", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const bind = runner.match(
    /production_origin_bind\(\) \{([\s\S]*?)\n\}\n\nproduction_origin_unbind/u,
  );
  assert.ok(bind?.[1]);
  assert.match(bind[1], /local response_pending="\$\{response\}\.pending"/u);
  assert.match(bind[1], /local original_pending="\$\{original\}\.pending"/u);
  assert.match(bind[1], /local bound_pending="\$\{bound\}\.pending"/u);
  assert.match(bind[1], /durable_replace "\$\{response\}" "\$\{response_pending\}"/u);
  assert.match(bind[1], /durable_replace "\$\{original\}" "\$\{original_pending\}"/u);
  assert.match(bind[1], /durable_replace "\$\{bound\}" "\$\{bound_pending\}"/u);
  assert.doesNotMatch(bind[1], />"\$\{(?:response|original|bound)\}"/u);
  const unbind = runner.match(
    /production_origin_unbind\(\) \{([\s\S]*?)\n\}\n\nproduction_origin_status/u,
  );
  assert.ok(unbind?.[1]);
  assert.ok(
    unbind[1].indexOf("provider_state=prebind") < unbind[1].indexOf("for provider_pending in"),
  );
});

test("host lease transient units bind the full nonce and cannot collide on a prefix", () => {
  const runner = readFileSync(runnerPath, "utf8");
  assert.doesNotMatch(runner, /edge-lease-\$\{(?:NONCE|nonce):0:12\}/u);
  assert.match(runner, /local unit="refunddesk-edge-lease-\$\{NONCE\}\.service"/u);
  assert.match(runner, /unit="refunddesk-edge-lease-\$\{nonce\}\.service"/u);
  const prefix = "0123456789ab";
  const nonceA = `${prefix}${"a".repeat(52)}`;
  const nonceB = `${prefix}${"b".repeat(52)}`;
  assert.notEqual(
    `refunddesk-edge-lease-${nonceA}.service`,
    `refunddesk-edge-lease-${nonceB}.service`,
  );
});

test(
  "host lease publication recovers partial writes but preserves a canonical foreign pending authority",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const helper = runner.match(
      /# REFUNDDESK_EDGE_HOST_LEASE_MARKER_PUBLISH_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_HOST_LEASE_MARKER_PUBLISH_PY_END/u,
    );
    assert.ok(helper?.[1], "the host lease marker publisher must remain extractable");
    const root = mkdtempSync(join(tmpdir(), "refunddesk-host-lease-publish-"));
    const lease = join(root, "edge-window-lease.json");
    const authorization = join(root, `${"7".repeat(64)}.json`);
    const invoke = () =>
      spawnSync("python3", ["-", lease, authorization, nonce, revision, "7".repeat(64)], {
        encoding: "utf8",
        input: helper[1],
        timeout: 5000,
      });
    try {
      writeFileSync(`${lease}.pending`, '{"kind":', { mode: 0o600 });
      chmodSync(`${lease}.pending`, 0o600);
      const recovered = invoke();
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(existsSync(`${lease}.pending`), false);
      assert.equal(JSON.parse(readFileSync(lease, "utf8")).nonce, nonce);
      assert.equal(JSON.parse(readFileSync(authorization, "utf8")).nonce, nonce);

      rmSync(lease);
      const foreignNonce = `${nonce.slice(0, 12)}${"f".repeat(52)}`;
      const foreign = {
        expectedRevision: revision,
        kind: "refunddesk.edge-window-host-lease",
        nonce: foreignNonce,
        schemaVersion: 1,
        state: "held",
      };
      writeFileSync(`${lease}.pending`, canonical(foreign), { mode: 0o600 });
      chmodSync(`${lease}.pending`, 0o600);
      const rejected = invoke();
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(existsSync(lease), false);
      assert.deepEqual(JSON.parse(readFileSync(`${lease}.pending`, "utf8")), foreign);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "the local origin token publisher recovers only private partial or exact pending bytes",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const helper = runner.match(
      /# REFUNDDESK_EDGE_LOCAL_ORIGIN_TOKEN_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_LOCAL_ORIGIN_TOKEN_PY_END/u,
    );
    assert.ok(helper?.[1], "the local token publication helper must remain extractable");
    const root = mkdtempSync(join(tmpdir(), "refunddesk-origin-token-publish-"));
    const target = join(root, "origin-token");
    const pending = join(root, ".origin-token.pending");
    const invoke = (createMissing) =>
      spawnSync("python3", ["-", target, pending, String(createMissing)], {
        encoding: "utf8",
        input: helper[1],
        timeout: 5000,
      });
    try {
      const partial = "partial-secret";
      writeFileSync(pending, partial, { mode: 0o600 });
      chmodSync(pending, 0o600);
      const partialRecovery = invoke(false);
      assert.equal(partialRecovery.status, 0, partialRecovery.stderr);
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(pending), false);

      const exact = "A".repeat(43);
      writeFileSync(pending, exact, { mode: 0o600 });
      chmodSync(pending, 0o600);
      const exactRecovery = invoke(false);
      assert.equal(exactRecovery.status, 0, exactRecovery.stderr);
      assert.equal(readFileSync(target, "ascii"), exact);
      assert.equal(statSync(target).nlink, 1);
      assert.equal(statSync(target).mode & 0o777, 0o600);

      const foreign = "B".repeat(43);
      writeFileSync(pending, foreign, { mode: 0o600 });
      chmodSync(pending, 0o600);
      const foreignRecovery = invoke(false);
      assert.equal(foreignRecovery.status, 1, foreignRecovery.stderr);
      assert.equal(readFileSync(target, "ascii"), exact);
      assert.equal(readFileSync(pending, "ascii"), foreign);

      rmSync(target);
      rmSync(pending);
      const generated = invoke(true);
      assert.equal(generated.status, 0, generated.stderr);
      assert.match(readFileSync(target, "ascii"), /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(existsSync(pending), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "the runner rejects every unmediated production invocation before an operation",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const dispatch = runner.match(
      /if \[\[ "\$\{REFUNDDESK_EDGE_WINDOW_TEST_MODE:-\}" == "1" \]\]; then[\s\S]*?readonly CONTROL_ROOT RUNTIME_ROOT COMMAND_ADAPTER/u,
    );
    assert.ok(dispatch?.[0]);
    assert.doesNotMatch(dispatch[0], /EUID == 0/u);
    assert.match(dispatch[0], /EUID == 10001/u);
    assert.match(dispatch[0], /id -g 2>\/dev\/null.*== "10001"/u);
    assert.match(
      dispatch[0],
      /elif \[\[ "\$\{REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR:-\}" == "1" \]\]; then[\s\S]*?else\s+usage\s+fi/u,
    );

    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-unmediated-"));
    try {
      const controlPath = join(root, "control.json");
      const checkpointPath = join(root, "checkpoint.json");
      const requestPath = join(root, "checkpoint-request.json");
      const transportPath = join(root, "transport.json");
      writeFileSync(controlPath, "{}\n", { mode: 0o600 });
      writeFileSync(transportPath, "{}\n", { mode: 0o600 });
      const result = spawnSync(
        "bash",
        [
          runnerPath,
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          controlPath,
          "--workbench-checkpoint",
          checkpointPath,
          "--checkpoint-request",
          requestPath,
          "--transport-file",
          transportPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            REFUNDDESK_EDGE_WINDOW_COMMAND: "",
            REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR: "",
            REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "",
            REFUNDDESK_EDGE_WINDOW_TEST_MODE: "",
          },
          timeout: 5000,
        },
      );
      assert.equal(result.status, 64, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(checkpointPath), false);
      assert.equal(existsSync(requestPath), false);
      assert.equal(existsSync(join(root, "edge-window-facts.json")), false);

      const monovolume = spawnSync(
        "bash",
        [
          runnerPath,
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          controlPath,
          "--workbench-checkpoint",
          checkpointPath,
          "--checkpoint-request",
          requestPath,
          "--transport-file",
          transportPath,
          "--control-root",
          root,
          "--runtime-root",
          root,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            AWS_CONFIG_FILE: join(root, "aws-config"),
            REFUNDDESK_EDGE_WINDOW_COMMAND: "",
            REFUNDDESK_EDGE_WINDOW_LOCAL_ORCHESTRATOR: "1",
            REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "",
            REFUNDDESK_EDGE_WINDOW_TEST_MODE: "",
          },
          timeout: 5000,
        },
      );
      assert.equal(monovolume.status, 64, monovolume.stderr);
      assert.equal(monovolume.stdout, "");
      assert.equal(existsSync(checkpointPath), false);
      assert.equal(existsSync(requestPath), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "systemd verifies the watchdog service and timer sandbox",
  { skip: !systemdAnalyzeAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-systemd-"));
    try {
      const executable = join(root, "refunddesk-edge-window-watchdog.sh");
      const service = join(root, "refunddesk-edge-window-watchdog.service");
      const timer = join(root, "refunddesk-edge-window-watchdog.timer");
      const dockerService = join(root, "docker.service");
      copyFileSync(watchdogPath, executable);
      chmodSync(executable, 0o755);
      writeFileSync(
        service,
        readFileSync(servicePath, "utf8").replace(
          "ExecStart=/usr/local/libexec/refunddesk-edge-window-watchdog.sh",
          `ExecStart=${executable}`,
        ),
        "utf8",
      );
      copyFileSync(timerPath, timer);
      writeFileSync(
        dockerService,
        "[Unit]\nDescription=Contract-only Docker dependency\n[Service]\nType=oneshot\nExecStart=/bin/true\nRemainAfterExit=yes\n",
        "utf8",
      );
      const verification = spawnSync("systemd-analyze", ["verify", service, timer, dockerService], {
        encoding: "utf8",
        env: { ...process.env, SYSTEMD_LOG_LEVEL: "warning" },
        timeout: 10_000,
      });
      assert.equal(verification.status, 0, verification.stderr);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "effective systemd validation rejects a second oneshot ExecStart entry",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const watchdog = readFileSync(watchdogPath, "utf8");
    const assertion = runner.match(
      /assert_effective_units\(\) \{\n[\s\S]*?\n\}\nexec 9>\/run\/refunddesk\/edge-window-watchdog\.lock/u,
    );
    assert.ok(assertion?.[0]);
    const assertionFunction = assertion[0].replace(
      /\nexec 9>\/run\/refunddesk\/edge-window-watchdog\.lock$/u,
      "",
    );
    for (const source of [assertionFunction, watchdog]) {
      assert.match(source, /!= \*'\} ; \{'\*/u);
      assert.match(source, /grep --only-matching --fixed-strings 'path='/u);
      assert.match(source, /grep --only-matching --fixed-strings 'argv\[\]='/u);
    }

    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-execstart-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin, { mode: 0o700 });
      const systemctl = join(bin, "systemctl");
      writeFileSync(
        systemctl,
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'property=""',
          'for argument in "$@"; do',
          '  case "${argument}" in --property=*) property="${argument#--property=}" ;; esac',
          "done",
          'unit="${*: -1}"',
          'case "${property}" in',
          '  FragmentPath) if [[ "${unit}" == *.service ]]; then printf \'%s\\n\' "${REFUNDDESK_TEST_SERVICE_PATH}"; else printf \'%s\\n\' "${REFUNDDESK_TEST_TIMER_PATH}"; fi ;;',
          "  DropInPaths) printf '\\n' ;;",
          "  User|Group) printf 'root\\n' ;;",
          "  Type) printf 'oneshot\\n' ;;",
          "  NoNewPrivileges|ProtectClock) printf 'yes\\n' ;;",
          "  ProtectSystem) printf 'strict\\n' ;;",
          "  Environment) printf 'PATH=/usr/bin:/bin DOCKER_HOST=unix:///run/docker.sock DOCKER_CONFIG=/run/refunddesk/edge-window-watchdog-docker-config\\n' ;;",
          "  UnsetEnvironment) printf 'DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY DOCKER_TLS\\n' ;;",
          "  ExecSearchPath) printf '/usr/bin:/bin\\n' ;;",
          "  ExecStart) printf '%s\\n' \"${REFUNDDESK_TEST_EXEC_START}\" ;;",
          "  Unit) printf 'refunddesk-edge-window-watchdog.service\\n' ;;",
          "  OnBootUSec|OnUnitActiveUSec) printf '1s\\n' ;;",
          "  AccuracyUSec) printf '1ms\\n' ;;",
          "  RandomizedDelayUSec) printf '0\\n' ;;",
          "  Persistent) printf 'no\\n' ;;",
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(systemctl, 0o700);
      const service = "/etc/systemd/system/refunddesk-edge-window-watchdog.service";
      const timer = "/etc/systemd/system/refunddesk-edge-window-watchdog.timer";
      const exact =
        "{ path=/usr/local/libexec/refunddesk-edge-window-watchdog.sh ; argv[]=/usr/local/libexec/refunddesk-edge-window-watchdog.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }";
      const invoke = (execStart) =>
        spawnSync(
          "bash",
          [
            "-c",
            `set -eu\n${assertionFunction}\nservice=${service}\ntimer=${timer}\nassert_effective_units`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              REFUNDDESK_TEST_EXEC_START: execStart,
              REFUNDDESK_TEST_SERVICE_PATH: service,
              REFUNDDESK_TEST_TIMER_PATH: timer,
            },
            timeout: 10_000,
          },
        );
      const accepted = invoke(exact);
      assert.equal(accepted.status, 0, accepted.stderr);
      const rogue = invoke(
        `${exact} ; { path=/evil ; argv[]=/evil ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
      );
      assert.notEqual(rogue.status, 0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("runner statically closes AWS first, arms watchdog before ingress and never invokes Stripe CLI", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const cleanupStart = runner.indexOf("cleanup_surfaces() {");
  const close = runner.indexOf("run_patch_operation firewall-close", cleanupStart);
  const unbind = runner.indexOf("run_patch_operation origin-unbind", cleanupStart);
  const host = runner.indexOf("run_patch_operation host-contain", cleanupStart);
  assert.ok(cleanupStart >= 0 && close > cleanupStart && host > close && unbind > host);
  assert.ok(
    runner.indexOf("run_patch_operation watchdog-arm") <
      runner.indexOf("run_patch_operation firewall-open"),
  );
  const originBind = runner.slice(
    runner.indexOf("production_origin_bind()"),
    runner.indexOf("production_origin_unbind()"),
  );
  const caddyStart = runner.slice(
    runner.indexOf("production_caddy_start()"),
    runner.indexOf("production_local_probe()"),
  );
  assert.match(
    originBind,
    /up --no-start --no-deps --no-build --pull never --force-recreate caddy/u,
  );
  assert.match(originBind, /preparedCaddyContainerId/u);
  assert.doesNotMatch(caddyStart, /force-recreate/u);
  assert.match(caddyStart, /docker info --format '\{\{\.CgroupDriver\}\}'\)" = systemd/u);
  assert.match(caddyStart, /ControlGroup=\/system\.slice\/docker\.service/u);
  assert.match(caddyStart, /MainPID=/u);
  assert.match(caddyStart, /\/proc\/\$\{docker_main_pid\}\/exe/u);
  assert.match(caddyStart, /ControlGroup=\/system\.slice\/\$\{scope\}/u);
  const ingressOpen = runner.indexOf("write_run_marker ingress_open");
  assert.ok(runner.indexOf("write_checkpoint_request", ingressOpen) > ingressOpen);
  assert.doesNotMatch(runner, /(?:^|[;&|\s])stripe(?:\.exe)?(?:\s|$)/imu);
  assert.doesNotMatch(runner, /--arg\s+token\b/u);
  assert.doesNotMatch(runner, /"\$\{transient_token\}"/u);
  assert.match(runner, /timeout --signal=TERM --kill-after=5s "\$\{seconds\}s" aws/u);
  assert.match(
    runner,
    /SECONDS - postflight_wait_started_seconds <= FINAL_POSTFLIGHT_WAIT_SECONDS/u,
  );
  assert.ok(
    (runner.match(/cloudfront wait distribution-deployed/gu) ?? []).length >= 3,
    "bind, unbind and persisted-unbind recovery must each observe Deployed",
  );
  assert.match(runner, /MAX_WINDOW_SECONDS=300/u);
  assert.match(runner, /'\$\{EFFECTIVE_WINDOW_SECONDS\}'/u);
  const prefixFunction = runner.slice(
    runner.indexOf("production_prefix_fetch()"),
    runner.indexOf("validate_firewall_document()"),
  );
  assert.match(prefixFunction, /--max-filesize 2097152/u);
  const publicHealthFunction = runner.slice(
    runner.indexOf("production_public_health()"),
    runner.indexOf("production_checkpoint_publish()"),
  );
  assert.match(publicHealthFunction, /--output \/dev\/null/u);
  assert.match(publicHealthFunction, /--max-filesize 65536/u);
  assert.match(publicHealthFunction, /--dump-header -/u);
  assert.match(publicHealthFunction, /head --bytes=65537/u);
  assert.doesNotMatch(publicHealthFunction, /public-health\.body/u);
  const passValidatorFunction = runner.slice(
    runner.indexOf("validate_pass_evidence_official()"),
    runner.indexOf("terminal_failure_evidence_ready()"),
  );
  assert.match(passValidatorFunction, /scripts\/validate-lightsail-edge-window\.mjs\s+-/u);
  assert.match(passValidatorFunction, /"\$\{arguments\[@\]\}" 2>&1 \|/u);
  assert.match(passValidatorFunction, /head --bytes=65/u);
  assert.match(passValidatorFunction, /\$\{#output\} <= 64/u);
  const leaseFinalizationFunction = runner.slice(
    runner.indexOf("production_host_lease_finalization_status()"),
    runner.indexOf("production_host_lease_cleanup_status()"),
  );
  assert.match(leaseFinalizationFunction, /EVIDENCE_AUTHORITY_BYTES/u);
  assert.doesNotMatch(leaseFinalizationFunction, /EVIDENCE_FILE/u);
  const journalFunction = runner.slice(
    runner.indexOf("write_run_marker()"),
    runner.indexOf("commit_facts()"),
  );
  assert.match(journalFunction, /evidence_sha.*EVIDENCE_AUTHORITY_SHA/u);
  assert.match(journalFunction, /evidence_json="\$\{EVIDENCE_AUTHORITY_BYTES\}"/u);
  assert.match(runner, /readonly EXIT_FAIL=20/u);
  assert.match(runner, /readonly EXIT_INCOMPLETE=21/u);
  assert.match(runner, /readonly EXIT_USAGE=64/u);
});

test(
  "remote watchdog installation preserves the original deadline after delay and rejects wall rollback",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const match = runner.match(
      /# REFUNDDESK_EDGE_WATCHDOG_REMAINING_DEADLINE_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_WATCHDOG_REMAINING_DEADLINE_END/u,
    );
    assert.ok(match?.[1], "the production remaining-deadline calculation must remain extractable");
    const calculate = (now, deadline, window, bootMilliseconds) =>
      spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `set -eu\nnow=$1\ndeadline=$2\nwindow=$3\nboot_ms=$4\n${match[1]}printf '%s\\n' "\${deadline_boot_ms}"`,
          "_",
          String(now),
          String(deadline),
          String(window),
          String(bootMilliseconds),
        ],
        { encoding: "utf8", timeout: 2000 },
      );

    const delayed = calculate(1170, 1270, 270, 500_000);
    assert.equal(delayed.status, 0, delayed.stderr);
    assert.equal(delayed.stdout, "600000\n");
    assert.notEqual(calculate(900, 1270, 270, 500_000).status, 0);
    assert.notEqual(calculate(1241, 1270, 270, 500_000).status, 0);
  },
);

test(
  "production public-health headers are bounded while curl writes them",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const match = runner.match(
      /# REFUNDDESK_EDGE_PUBLIC_HEALTH_BOUNDED_HEADERS_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_PUBLIC_HEALTH_BOUNDED_HEADERS_END/u,
    );
    assert.ok(match?.[1], "the production bounded-header pipeline must remain extractable");
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-public-headers-"));
    const serverPath = join(root, "server.py");
    const readyPath = join(root, "ready");
    const headersPath = join(root, "headers");
    writeFileSync(
      serverPath,
      [
        "import socket,sys",
        "listener=socket.socket()",
        "listener.bind(('127.0.0.1',0))",
        "listener.listen(1)",
        "open(sys.argv[1],'w',encoding='ascii').write(str(listener.getsockname()[1]))",
        "connection,_=listener.accept()",
        "request=b''",
        "while b'\\r\\n\\r\\n' not in request:",
        " request += connection.recv(4096)",
        "line=b'X-RefundDesk-Fill: '+(b'a'*60)+b'\\r\\n'",
        "response=b'HTTP/1.1 200 OK\\r\\n'+(line*1200)+b'Content-Length: 0\\r\\n\\r\\n'",
        "try: connection.sendall(response)",
        "except (BrokenPipeError,ConnectionResetError): pass",
        "connection.close(); listener.close()",
      ].join("\n"),
      { mode: 0o700 },
    );
    writeFileSync(headersPath, "", { mode: 0o600 });
    const server = spawn("python3", [serverPath, readyPath], { stdio: "ignore" });
    try {
      const ready = spawnSync(
        "bash",
        [
          "-c",
          'for _ in $(seq 1 100); do test -s "$1" && exit 0; sleep .02; done; exit 1',
          "_",
          readyPath,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(ready.status, 0, ready.stderr);
      const port = readFileSync(readyPath, "utf8").trim();
      const bounded = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `set -uo pipefail\npublic_url="$1"\nheaders_temporary="$2"\n${match[1]}printf '%s:%s:%s\\n' "\${pipeline_status[0]}" "\${pipeline_status[1]}" "$(wc --bytes <"\${headers_temporary}")"`,
          "_",
          `http://127.0.0.1:${port}/api/health`,
          headersPath,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(bounded.status, 0, bounded.stderr);
      const [curlStatus, headStatus, byteCount] = bounded.stdout.trim().split(":").map(Number);
      assert.equal(headStatus, 0);
      assert.ok(byteCount <= 65_537);
      assert.ok(curlStatus !== 0 || byteCount > 65_536);
    } finally {
      server.kill("SIGTERM");
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("CloudFront admission routes every behavior directly to the authorized origin", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const match = runner.match(
    /# REFUNDDESK_EDGE_CLOUDFRONT_ROUTE_BINDING_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_CLOUDFRONT_ROUTE_BINDING_END/u,
  );
  assert.ok(match?.[1], "the production CloudFront route predicate must remain extractable");
  assert.equal(
    (runner.match(/validate_cloudfront_route_projection "\$\{/gu) ?? []).length,
    2,
    "the baseline and exact pre-update ETag bytes must share the same route predicate",
  );
  const bindFunction = runner.slice(
    runner.indexOf("production_origin_bind()"),
    runner.indexOf("production_origin_unbind()"),
  );
  const routePredicate = bindFunction.indexOf("validate_cloudfront_route_projection");
  const localTokenPublication = bindFunction.indexOf("recover_local_origin_token true");
  const hostTokenPublication = bindFunction.indexOf("production_origin_host_files bind");
  const providerMutation = bindFunction.indexOf("cloudfront update-distribution");
  assert.ok(
    routePredicate >= 0 &&
      localTokenPublication > routePredicate &&
      hostTokenPublication > localTokenPublication &&
      providerMutation > hostTokenPublication,
    "the route predicate must precede local/host token publication and the provider mutation",
  );
  if (!linuxContractAvailable) return;
  const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-cloudfront-route-"));
  try {
    const documentPath = join(root, "distribution.json");
    const origin = "refunddesk-lightsail-origin";
    const zero = { Quantity: 0 };
    const valid = {
      Aliases: ["sandbox.example.test"],
      ContinuousDeploymentPolicyId: null,
      CustomErrorResponses: zero,
      DefaultCacheBehavior: {
        FunctionAssociations: zero,
        LambdaFunctionAssociations: zero,
        TargetOriginId: origin,
      },
      Enabled: true,
      Id: "E123456789ABC",
      OrderedCacheBehaviors: { Quantity: 0 },
      OriginGroups: zero,
      Origins: [{ DomainName: "192.0.2.44", Id: origin }],
      Staging: false,
      Status: "Deployed",
      WebACLId: null,
    };
    const validate = (document) => {
      writeFileSync(documentPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
      return spawnSync(
        "jq",
        [
          "--exit-status",
          "--arg",
          "distribution",
          valid.Id,
          "--arg",
          "origin",
          origin,
          "--arg",
          "hostname",
          "sandbox.example.test",
          "--arg",
          "host",
          "192.0.2.44",
          match[1],
          documentPath,
        ],
        { encoding: "utf8", timeout: 2000 },
      );
    };
    assert.equal(validate(valid).status, 0);
    const defaultDrift = structuredClone(valid);
    defaultDrift.DefaultCacheBehavior.TargetOriginId = "other-origin";
    assert.notEqual(validate(defaultDrift).status, 0);
    const orderedDrift = structuredClone(valid);
    orderedDrift.OrderedCacheBehaviors = {
      Items: [
        {
          FunctionAssociations: zero,
          LambdaFunctionAssociations: zero,
          PathPattern: "/api/*",
          TargetOriginId: "other-origin",
        },
      ],
      Quantity: 1,
    };
    assert.notEqual(validate(orderedDrift).status, 0);
    const edgeAssociation = structuredClone(valid);
    edgeAssociation.DefaultCacheBehavior.FunctionAssociations = {
      Items: [{ EventType: "viewer-request", FunctionARN: "arn:aws:cloudfront::123:function/x" }],
      Quantity: 1,
    };
    assert.notEqual(validate(edgeAssociation).status, 0);
    const customError = structuredClone(valid);
    customError.CustomErrorResponses = {
      Items: [{ ErrorCachingMinTTL: 0, ErrorCode: 404, ResponseCode: "200" }],
      Quantity: 1,
    };
    assert.notEqual(validate(customError).status, 0);
    const continuousDeployment = structuredClone(valid);
    continuousDeployment.ContinuousDeploymentPolicyId = "continuous-policy";
    assert.notEqual(validate(continuousDeployment).status, 0);
    const staging = structuredClone(valid);
    staging.Staging = true;
    assert.notEqual(validate(staging).status, 0);
    const webAcl = structuredClone(valid);
    webAcl.WebACLId = "arn:aws:wafv2:eu-west-3:123456789012:global/webacl/edge/example";
    assert.notEqual(validate(webAcl).status, 0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "post-GC origin status consumes one no-follow receipt snapshot and rejects hardlinks",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const reader = runner.match(
      /# REFUNDDESK_EDGE_CONTROLLED_FILE_BYTES_ONCE_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_CONTROLLED_FILE_BYTES_ONCE_PY_END/u,
    );
    assert.ok(reader?.[1]);
    assert.match(reader[1], /O_NOFOLLOW/u);
    assert.match(reader[1], /os\.fstat/u);
    assert.match(reader[1], /os\.lstat/u);
    const originStatus = runner.slice(
      runner.indexOf("production_origin_status()"),
      runner.indexOf("production_origin_secret_scan()"),
    );
    assert.match(
      originStatus,
      /receipt_bytes="\$\(controlled_file_bytes_once "\$\{receipt\}" 4096\)"/u,
    );
    assert.doesNotMatch(originStatus, /jq[^\n]*"\$\{receipt\}"/u);
    assert.doesNotMatch(originStatus, /tr -d '\\n' <"\$\{receipt\}"/u);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-origin-receipt-"));
    const receipt = join(root, "origin-status-receipt.json");
    const alias = join(root, "receipt-alias.json");
    const raw = Buffer.from(
      canonical({
        configurationSha256: "1".repeat(64),
        etag: "ETAG",
        expectedRevision: "2".repeat(40),
        finalCaddyContainerIdSha256: "3".repeat(64),
        kind: "refunddesk.edge-window-origin-status-receipt",
        nonce: "4".repeat(64),
        schemaVersion: 1,
        transientTokenSha256: "none",
      }),
      "utf8",
    );
    const invoke = () =>
      spawnSync(
        "python3",
        ["-", receipt, String(process.getuid()), String(process.getgid()), "4096"],
        { input: reader[1], timeout: 5000 },
      );
    try {
      writeFileSync(receipt, raw, { mode: 0o600 });
      const exact = invoke();
      assert.equal(exact.status, 0, exact.stderr?.toString("utf8"));
      assert.deepEqual(exact.stdout, raw);

      linkSync(receipt, alias);
      const linked = invoke();
      assert.notEqual(linked.status, 0);
      assert.equal(statSync(receipt).nlink, 2);
      assert.deepEqual(readFileSync(receipt), raw);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("official final postflight is joined to the post-incident baseline and exact candidate", () => {
  const runner = readFileSync(runnerPath, "utf8");
  assert.match(runner, /observed\["remote"\]\["captures"\]\[capture_name\]/u);
  assert.match(runner, /"mutationReceipts": "apiMutationReceipts"/u);
  assert.match(runner, /projection != \{key: baseline\[key\] for key in count_keys\}/u);
  assert.match(
    runner,
    /hashlib\.sha256\(encoded\)\.hexdigest\(\) != baseline\["snapshotSha256"\]/u,
  );
  assert.match(runner, /promotionDatabaseSystemIdentifierSha256/u);
  assert.match(runner, /promotionWorkerContainerIdSha256/u);
  assert.match(runner, /releaseEnvironmentWorkerRuntimeMode.*INCIDENT_ADMISSION/u);
  assert.match(runner, /effectiveWorkerRuntimeMode.*INCIDENT_ADMISSION/u);
  assert.match(runner, /scripts\/validate-lightsail-postflight\.mjs/u);
  assert.match(runner, /--attested-workspace/u);
  assert.match(runner, /\$official\.remote == \.remote/u);
});

test(
  "the production final-postflight projection rejects real counter and candidate drift",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const match = runner.match(
      /# REFUNDDESK_EDGE_FINAL_POSTFLIGHT_BINDING_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_FINAL_POSTFLIGHT_BINDING_PY_END/u,
    );
    assert.ok(match?.[1], "the exact production Python projection must remain extractable");
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-final-postflight-"));
    try {
      const programPath = join(root, "validate.py");
      const resultPath = join(root, "postflight.json");
      const controlPath = join(root, "control.json");
      writeFileSync(programPath, match[1], "utf8");

      const rawIds = {
        caddy: "c".repeat(64),
        postgres: "d".repeat(64),
        verifier: "e".repeat(64),
        web: "f".repeat(64),
        worker: "1".repeat(64),
      };
      const promotionCaddyId = "a".repeat(64);
      const finalCaddySha256 = createHash("sha256").update(rawIds.caddy).digest("hex");
      const systemIdentifier = "7463589210473628001";
      const counts = {
        activeFinancialJobs: 0,
        auditEvents: 17,
        mutationReceipts: 3,
        refundExecutionAttempts: 2,
        refundExecutions: 2,
        refundRequests: 2,
        unreleasedPaymentGuards: 0,
        webhookReceipts: 4,
      };
      const snapshotSha256 = createHash("sha256").update(JSON.stringify(counts)).digest("hex");
      const database = {
        activeFinancialJobs: counts.activeFinancialJobs,
        activeWorkflows: 0,
        apiMutationReceipts: counts.mutationReceipts,
        auditEvents: counts.auditEvents,
        liveInstallations: 0,
        liveTenants: 0,
        preparedTransactions: 0,
        refundExecutionAttempts: counts.refundExecutionAttempts,
        refundExecutions: counts.refundExecutions,
        refundRequests: counts.refundRequests,
        systemIdentifier,
        unreleasedPaymentGuards: counts.unreleasedPaymentGuards,
        webhookReceipts: counts.webhookReceipts,
      };
      const containers = Object.entries(rawIds).map(([service, containerId]) => ({
        containerId,
        effectiveWorkerRuntimeMode: service === "worker" ? "INCIDENT_ADMISSION" : null,
        service,
      }));
      const capture = {
        containers,
        database,
        identity: { releaseEnvironmentWorkerRuntimeMode: "INCIDENT_ADMISSION" },
      };
      const observed = { remote: { captures: { a: capture, b: structuredClone(capture) } } };
      const control = {
        admission: {
          promotionCaddyContainerIdSha256: createHash("sha256")
            .update(promotionCaddyId)
            .digest("hex"),
          promotionDatabaseSystemIdentifierSha256: createHash("sha256")
            .update(systemIdentifier)
            .digest("hex"),
          promotionPostgresContainerIdSha256: createHash("sha256")
            .update(rawIds.postgres)
            .digest("hex"),
          promotionVerifierContainerIdSha256: createHash("sha256")
            .update(rawIds.verifier)
            .digest("hex"),
          promotionWebContainerIdSha256: createHash("sha256").update(rawIds.web).digest("hex"),
          promotionWorkerContainerIdSha256: createHash("sha256")
            .update(rawIds.worker)
            .digest("hex"),
        },
        postIncidentBaseline: { ...counts, snapshotSha256 },
      };
      const execute = (value) => {
        writeFileSync(resultPath, JSON.stringify(value), "utf8");
        writeFileSync(controlPath, JSON.stringify(control), "utf8");
        return spawnSync(
          "bash",
          [
            "-c",
            'python3 "$1" "$2" "$3" 3<"$4"',
            "_",
            programPath,
            controlPath,
            finalCaddySha256,
            resultPath,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
      };

      assert.equal(execute(observed).status, 0);
      const countDrift = structuredClone(observed);
      countDrift.remote.captures.b.database.refundRequests += 1;
      assert.equal(execute(countDrift).status, 1);
      const databaseDrift = structuredClone(observed);
      databaseDrift.remote.captures.a.database.systemIdentifier = "7463589210473628002";
      assert.equal(execute(databaseDrift).status, 1);
      const containerDrift = structuredClone(observed);
      containerDrift.remote.captures.b.containers[0].containerId = "2".repeat(64);
      assert.equal(execute(containerDrift).status, 1);
      const stableCandidateDrift = structuredClone(observed);
      stableCandidateDrift.remote.captures.a.containers.find(
        (container) => container.service === "postgres",
      ).containerId = "2".repeat(64);
      assert.equal(execute(stableCandidateDrift).status, 1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "the final postflight request stays on the armed boot and follows the durable close observation",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const helper = runner.match(
      /final_postflight_request_clock_matches_window\(\) \{\n[\s\S]*?\n\}/u,
    );
    assert.notEqual(helper, null);
    const expectedBoot = "b".repeat(64);
    const invoke = (...arguments_) =>
      spawnSync(
        "bash",
        [
          "-c",
          `${helper[0]}\nfinal_postflight_request_clock_matches_window "$@"`,
          "_",
          ...arguments_,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
    assert.equal(invoke(expectedBoot, "250000", "true", expectedBoot, "250000").status, 0);
    assert.equal(invoke(expectedBoot, "250000", "true", "c".repeat(64), "250001").status, 1);
    assert.equal(invoke(expectedBoot, "250000", "true", expectedBoot, "249999").status, 1);
    assert.equal(invoke("", "", "false", expectedBoot, "1").status, 0);
    assert.match(runner, /completion_boot_sha\}" != "\$\{expected_boot_sha\}/u);
  },
);

test(
  "the final postflight validator consumes one immutable snapshot and rejects pathname races",
  { skip: !linuxContractAvailable },
  async () => {
    const runner = readFileSync(runnerPath, "utf8");
    const helper = runner.match(
      /# REFUNDDESK_EDGE_CANONICAL_SNAPSHOT_HELPER_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_CANONICAL_SNAPSHOT_HELPER_END/u,
    );
    assert.notEqual(helper, null);
    const fileSync = helper[1].indexOf("os.fsync(output)");
    const pendingDirectorySync = helper[1].indexOf("fsync_directory(directory)", fileSync);
    const noReplacePublish = helper[1].indexOf("rename_noreplace(pending, destination)");
    const publishedDirectorySync = helper[1].indexOf(
      "fsync_directory(directory)",
      noReplacePublish,
    );
    assert.ok(fileSync >= 0);
    assert.ok(pendingDirectorySync > fileSync);
    assert.ok(noReplacePublish > pendingDirectorySync);
    assert.ok(publishedDirectorySync > noReplacePublish);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-postflight-snapshot-"));
    const invoke = (source, destination, environment = {}) =>
      spawn(
        "bash",
        [
          "-c",
          `${helper[1]}\nsnapshot_canonical_json_file "$1" "$2" 4096`,
          "_",
          source,
          destination,
        ],
        { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] },
      );
    const waitForExit = (child) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
      return new Promise((resolveExit) =>
        child.once("exit", (code, signal) => resolveExit({ code, signal, stderr, stdout })),
      );
    };
    try {
      const original = canonical({
        capturedAt: "2026-08-08T12:01:35Z",
        value: "a".repeat(64),
      });
      const replacement = canonical({
        capturedAt: "2026-08-08T12:01:35Z",
        value: "b".repeat(64),
      });
      const stableSource = join(root, "stable.json");
      const stableSnapshot = join(root, "stable.snapshot.json");
      writeFileSync(stableSource, original, { mode: 0o600 });
      const stable = invoke(stableSource, stableSnapshot);
      const stableExit = await waitForExit(stable);
      assert.equal(stableExit.code, 0, stableExit.stderr);
      assert.equal(stableExit.signal, null);
      assert.equal(stableExit.stdout, original);
      assert.equal(statSync(stableSnapshot).mode & 0o777, 0o400);
      writeFileSync(stableSource, replacement, { mode: 0o600 });
      assert.equal(readFileSync(stableSnapshot, "utf8"), original);
      const resumed = invoke(stableSource, stableSnapshot);
      const resumedExit = await waitForExit(resumed);
      assert.equal(resumedExit.code, 0, resumedExit.stderr);
      assert.equal(resumedExit.signal, null);
      assert.equal(resumedExit.stdout, original);
      assert.equal(readFileSync(stableSnapshot, "utf8"), original);

      const linkedSource = join(root, "linked-crash.json");
      const linkedSnapshot = join(root, "linked-crash.snapshot.json");
      const linkedPending = join(root, `.linked-crash.snapshot.json.123.${"c".repeat(16)}.pending`);
      writeFileSync(linkedSource, original, { mode: 0o600 });
      const linkedInitial = await waitForExit(invoke(linkedSource, linkedSnapshot));
      assert.equal(linkedInitial.code, 0, linkedInitial.stderr);
      linkSync(linkedSnapshot, linkedPending);
      assert.equal(statSync(linkedSnapshot).nlink, 2);
      writeFileSync(linkedSource, replacement, { mode: 0o600 });
      const linkedRecovered = await waitForExit(invoke(linkedSource, linkedSnapshot));
      assert.equal(linkedRecovered.code, 0, linkedRecovered.stderr);
      assert.equal(linkedRecovered.stdout, original);
      assert.equal(existsSync(linkedPending), false);
      assert.equal(statSync(linkedSnapshot).nlink, 1);

      const pendingOnlySource = join(root, "pending-only.json");
      const pendingOnlySnapshot = join(root, "pending-only.snapshot.json");
      const pendingOnly = join(root, `.pending-only.snapshot.json.124.${"d".repeat(16)}.pending`);
      writeFileSync(pendingOnlySource, replacement, { mode: 0o600 });
      writeFileSync(pendingOnly, original, { mode: 0o400 });
      const pendingRecovered = await waitForExit(invoke(pendingOnlySource, pendingOnlySnapshot));
      assert.equal(pendingRecovered.code, 0, pendingRecovered.stderr);
      assert.equal(pendingRecovered.stdout, original);
      assert.equal(existsSync(pendingOnly), false);
      assert.equal(statSync(pendingOnlySnapshot).nlink, 1);

      const ambiguousSource = join(root, "ambiguous.json");
      const ambiguousSnapshot = join(root, "ambiguous.snapshot.json");
      const ambiguousPending = join(root, `.ambiguous.snapshot.json.125.${"e".repeat(16)}.pending`);
      writeFileSync(ambiguousSource, original, { mode: 0o600 });
      const ambiguousInitial = await waitForExit(invoke(ambiguousSource, ambiguousSnapshot));
      assert.equal(ambiguousInitial.code, 0, ambiguousInitial.stderr);
      writeFileSync(ambiguousPending, replacement, { mode: 0o400 });
      const ambiguousRecovery = await waitForExit(invoke(ambiguousSource, ambiguousSnapshot));
      assert.notEqual(ambiguousRecovery.code, 0);

      for (const race of ["overwrite", "rename"]) {
        const source = join(root, `${race}.json`);
        const snapshot = join(root, `${race}.snapshot.json`);
        const sync = join(root, `${race}.read-sync`);
        writeFileSync(source, original, { mode: 0o600 });
        const child = invoke(source, snapshot, {
          REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_READ_SYNC: sync,
          REFUNDDESK_EDGE_WINDOW_TEST_FINAL_POSTFLIGHT_SNAPSHOT_DELAY: "1",
        });
        for (let index = 0; index < 100 && !existsSync(sync); index += 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        assert.equal(existsSync(sync), true);
        if (race === "overwrite") {
          writeFileSync(source, replacement, { mode: 0o600 });
        } else {
          renameSync(source, `${source}.old`);
          writeFileSync(source, replacement, { mode: 0o600 });
        }
        const raced = await waitForExit(child);
        assert.notEqual(raced.code, 0, `${race} unexpectedly produced a trusted snapshot`);
        assert.equal(existsSync(snapshot), false);
      }

      const destinationRaceSource = join(root, "destination-race.json");
      const destinationRaceSnapshot = join(root, "destination-race.snapshot.json");
      const destinationRaceSync = join(root, "destination-race.output-sync");
      writeFileSync(destinationRaceSource, original, { mode: 0o600 });
      const destinationRace = invoke(destinationRaceSource, destinationRaceSnapshot, {
        REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_OUTPUT_DELAY: "1",
        REFUNDDESK_EDGE_WINDOW_TEST_CANONICAL_SNAPSHOT_OUTPUT_SYNC: destinationRaceSync,
      });
      for (let index = 0; index < 100 && !existsSync(destinationRaceSync); index += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      assert.equal(existsSync(destinationRaceSync), true);
      assert.equal(existsSync(destinationRaceSnapshot), true);
      renameSync(destinationRaceSnapshot, `${destinationRaceSnapshot}.old`);
      writeFileSync(destinationRaceSnapshot, replacement, { mode: 0o400 });
      const destinationRaced = await waitForExit(destinationRace);
      assert.equal(destinationRaced.code, 0, destinationRaced.stderr);
      assert.equal(destinationRaced.stdout, original);
      assert.match(
        runner,
        /result_bytes="\$\(snapshot_canonical_json_file "\$\{result\}" "\$\{result_snapshot\}" 131072\)"/u,
      );
      assert.doesNotMatch(runner, /rm -- "\$\{result_snapshot\}"/u);
      assert.doesNotMatch(runner, /result="\$\{result_snapshot\}"/u);
      assert.doesNotMatch(runner, /<"\$\{result_snapshot\}"/u);
      assert.match(
        runner,
        /snapshot_bytes="\$\(snapshot_canonical_json_file "\$\{CHECKPOINT_FILE\}" "\$\{snapshot\}" 16384\)"/u,
      );
      assert.doesNotMatch(runner, /rm -- "\$\{snapshot\}"/u);
      assert.doesNotMatch(runner, /jq[^\n]+"\$\{snapshot\}"/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "a Workbench snapshot survives a crash before its facts merge and never adopts replacement bytes",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_workbench_snapshot", timeout: 30_000 });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      const snapshot = join(
        run.controlRoot,
        `edge-window-operation-${nonce}`,
        "workbench-checkpoint.snapshot.json",
      );
      const original = readFileSync(snapshot, "utf8");
      const replacement = {
        ...JSON.parse(original),
        capturedAt: "2026-08-08T12:01:01Z",
      };
      const replacementBytes = canonical(replacement);
      assert.notEqual(replacementBytes, original);
      writeFileSync(run.checkpointPath, replacementBytes, { mode: 0o600 });

      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      validateFixtureEvidence(evidence, 21);
      assert.equal(readFileSync(snapshot, "utf8"), original);
      assert.notEqual(
        evidence.probes.workbench.attestationSha256,
        createHash("sha256").update(replacementBytes).digest("hex"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(state.firewallOpen, false);
      assert.equal(state.hostLeaseReleased, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "the local origin secret scan rejects FIFOs and bounded-storage abuse without blocking",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const scanner = runner.match(
      /# REFUNDDESK_EDGE_LOCAL_SECRET_SCAN_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_LOCAL_SECRET_SCAN_PY_END/u,
    );
    assert.notEqual(scanner, null);
    const invoke = (controlRoot, operationRoot, tokenPath, postGc = false) =>
      spawnSync(
        "timeout",
        [
          "--signal=TERM",
          "--kill-after=1s",
          "2s",
          "python3",
          "-",
          controlRoot,
          operationRoot,
          tokenPath,
          createHash("sha256").update("A".repeat(43)).digest("hex"),
          String(postGc),
        ],
        { encoding: "utf8", input: scanner[1], timeout: 5000 },
      );
    const makeRoot = () => {
      const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-secret-scan-"));
      const controlRoot = join(root, "control");
      const operationRoot = join(controlRoot, `edge-window-operation-${"a".repeat(64)}`);
      const tokenPath = join(operationRoot, "origin-token");
      mkdirSync(operationRoot, { mode: 0o700, recursive: true });
      chmodSync(controlRoot, 0o700);
      chmodSync(operationRoot, 0o700);
      writeFileSync(tokenPath, "A".repeat(43), { mode: 0o600 });
      return { controlRoot, operationRoot, root, tokenPath };
    };

    const stable = makeRoot();
    try {
      writeFileSync(join(stable.operationRoot, "facts.json"), "{}\n", { mode: 0o600 });
      const historical = join(stable.controlRoot, `edge-window-operation-${"b".repeat(64)}`);
      mkdirSync(historical, { mode: 0o700 });
      writeFileSync(join(historical, "evidence.json"), "{}\n", { mode: 0o600 });
      assert.equal(invoke(stable.controlRoot, stable.operationRoot, stable.tokenPath).status, 0);
    } finally {
      rmSync(stable.root, { force: true, recursive: true });
    }

    for (const postGcAbuse of ["token", "cloudfront", "secret-copy"]) {
      const fixture = makeRoot();
      try {
        rmSync(fixture.tokenPath);
        if (postGcAbuse === "token") {
          writeFileSync(fixture.tokenPath, "A".repeat(43), { mode: 0o600 });
        } else if (postGcAbuse === "cloudfront") {
          writeFileSync(
            join(fixture.operationRoot, "cloudfront.resurrected.json"),
            `${JSON.stringify({ token: "A".repeat(43) })}\n`,
            { mode: 0o600 },
          );
        } else {
          writeFileSync(join(fixture.operationRoot, "resurrected-secret"), "A".repeat(43), {
            mode: 0o600,
          });
        }
        const result = invoke(fixture.controlRoot, fixture.operationRoot, fixture.tokenPath, true);
        assert.notEqual(result.status, 0, `post-GC ${postGcAbuse} unexpectedly passed`);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    }

    for (const abuse of [
      "fifo",
      "oversize",
      "many-files",
      "secret-copy",
      "historical-fifo",
      "historical-oversize",
      "historical-secret-copy",
    ]) {
      const fixture = makeRoot();
      try {
        const targetRoot = abuse.startsWith("historical-")
          ? join(fixture.controlRoot, `edge-window-operation-${"b".repeat(64)}`)
          : fixture.operationRoot;
        if (targetRoot !== fixture.operationRoot) {
          mkdirSync(targetRoot, { mode: 0o700 });
        }
        if (abuse.endsWith("fifo")) {
          const fifo = spawnSync("mkfifo", [join(targetRoot, "blocked.pipe")], {
            encoding: "utf8",
          });
          assert.equal(fifo.status, 0, fifo.stderr);
        } else if (abuse.endsWith("oversize")) {
          writeFileSync(join(targetRoot, "oversize.bin"), Buffer.alloc(2_097_153), {
            mode: 0o600,
          });
        } else if (abuse === "many-files") {
          for (let index = 0; index < 257; index += 1) {
            writeFileSync(join(fixture.operationRoot, `entry-${index}`), "", { mode: 0o600 });
          }
        } else {
          writeFileSync(join(targetRoot, "secret-copy"), "A".repeat(43), {
            mode: 0o600,
          });
        }
        const result = invoke(fixture.controlRoot, fixture.operationRoot, fixture.tokenPath);
        assert.notEqual(result.status, 0, `${abuse} unexpectedly passed`);
        assert.notEqual(result.signal, "SIGTERM", `${abuse} blocked until TERM`);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    }
    assert.match(runner, /timeout --signal=TERM --kill-after=1s 15s/u);
    assert.doesNotMatch(scanner[1], /os\.walk|read_bytes/u);
  },
);

test(
  "official postflight Node validators have bounded output and kill TERM-ignoring process groups",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const helper = runner.match(
      /# REFUNDDESK_EDGE_BOUNDED_NODE_VALIDATION_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_BOUNDED_NODE_VALIDATION_END/u,
    );
    assert.ok(helper?.[1]);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-node-timeout-"));
    try {
      const hangingNode = join(root, "hanging-node");
      writeFileSync(
        hangingNode,
        ["#!/usr/bin/env bash", "trap '' TERM", "while :; do sleep 10; done", ""].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(hangingNode, 0o700);
      const started = Date.now();
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -uo pipefail\nEXIT_USAGE=64\n${helper[1]}\nprintf '{}\\n' | bounded_node_validation 4096 "$1"`,
          "_",
          hangingNode,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            REFUNDDESK_EDGE_WINDOW_TEST_MODE: "1",
            REFUNDDESK_EDGE_WINDOW_TEST_NODE_VALIDATION_TIMEOUT_SECONDS: "1",
          },
          timeout: 5000,
        },
      );
      assert.notEqual(result.status, 0);
      assert.equal(result.signal, null);
      assert.ok(Date.now() - started < 4000);
      assert.match(
        runner,
        /bounded_node_validation 4096 "\$\{node_executable\}" scripts\/validate-lightsail-incident-admission\.mjs/u,
      );
      assert.match(
        runner,
        /bounded_node_validation 524288 "\$\{node_executable\}" scripts\/validate-lightsail-postflight\.mjs/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "production host containment caps Docker drift and fences exact identities before later barriers",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const block = runner.match(
      /# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_END/u,
    );
    assert.ok(block?.[1]);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-host-contain-"));
    try {
      const bin = join(root, "bin");
      const log = join(root, "calls.log");
      mkdirSync(bin, { mode: 0o700 });
      const docker = join(bin, "docker");
      const systemctl = join(bin, "systemctl");
      writeFileSync(
        docker,
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf \'%s\\n\' "$*" >>"${REFUNDDESK_TEST_LOG}"',
          'if [[ "$1" == container && "$2" == ls ]]; then',
          "  for value in $(seq 1 300); do printf '%064x\\n' \"${value}\"; done",
          "  exit 0",
          "fi",
          "if [[ \"$1\" == inspect ]]; then printf 'always:true\\n'; exit 0; fi",
          'if [[ "$1" == update || "$1" == stop || "$1" == kill ]]; then exit 0; fi',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      writeFileSync(
        systemctl,
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf \'systemctl %s\\n\' "$*" >>"${REFUNDDESK_TEST_LOG}"',
          'if [[ "$1" == show && "$*" == *"LoadState"* ]]; then printf \'masked\\n\'; exit 0; fi',
          'if [[ "$1" == show && "$*" == *"ActiveState"* ]]; then printf \'inactive\\n\'; exit 0; fi',
          "if [[ \"$1\" == is-enabled ]]; then printf 'masked-runtime\\n'; exit 0; fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(docker, 0o700);
      chmodSync(systemctl, 0o700);
      const exactCaddy = "a".repeat(64);
      const exactWorker = "b".repeat(64);
      const program = [
        "set -uo pipefail",
        "status=0",
        "containers_stopped=0",
        "containers_fenced=0",
        "docker_api_fenced=false",
        `expected_caddy=${exactCaddy}`,
        `expected_worker=${exactWorker}`,
        "marker_publication_recovered=true",
        block[1],
        'printf \'status=%s fenced=%s stopped=%s\\n\' "${status}" "${containers_fenced}" "${containers_stopped}"',
      ].join("\n");
      const started = Date.now();
      const result = spawnSync("bash", ["-c", program], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          REFUNDDESK_TEST_LOG: log,
        },
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Date.now() - started < 10_000);
      assert.match(result.stdout, /status=1/u);
      const calls = readFileSync(log, "utf8");
      const caddyFence = calls.indexOf(`update --restart=no ${exactCaddy}`);
      assert.ok(caddyFence >= 0);
      assert.doesNotMatch(calls, /update --restart=no 0{63}1/u);
      assert.doesNotMatch(calls, /stop --time 3 0{63}1/u);
      const allScopeFence = calls.indexOf(
        "systemctl kill --kill-who=all --signal=KILL -- docker-*.scope",
      );
      const socketFence = calls.indexOf("systemctl mask --runtime --now -- docker.socket");
      const daemonFence = calls.indexOf(
        "systemctl kill --kill-who=all --signal=KILL -- docker.service",
      );
      const workerScopeFence = calls.indexOf(
        `systemctl kill --kill-who=all --signal=KILL docker-${exactWorker}.scope`,
      );
      assert.ok(socketFence > caddyFence && allScopeFence > socketFence, calls);
      assert.ok(daemonFence > allScopeFence, calls);
      assert.ok(workerScopeFence > daemonFence, calls);
      assert.doesNotMatch(calls.slice(socketFence), /^docker /mu);
      const blockEnd = runner.indexOf("# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_END");
      assert.ok(blockEnd < runner.indexOf("for unit in refunddesk-backup.timer", blockEnd));
      const earlyListener = runner.indexOf("# REFUNDDESK_EDGE_HOST_CONTAIN_EARLY_LISTENERS_BEGIN");
      const exactCaddyPosition = runner.indexOf('contain_exact_container "${expected_caddy}"');
      const exactWorkerPosition = runner.indexOf(
        'contain_exact_container "${expected_worker}"',
        earlyListener,
      );
      assert.ok(
        exactCaddyPosition >= 0 &&
          earlyListener > exactCaddyPosition &&
          exactWorkerPosition > earlyListener &&
          blockEnd > exactWorkerPosition,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("broad host containment preserves the marker pair and never starts a fresh Docker-capable tick", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const hostContain = runner.match(
    /production_host_contain\(\) \{([\s\S]*?)\n\}\n\nproduction_watchdog_disarm/u,
  );
  assert.ok(hostContain?.[1]);
  const body = hostContain[1];
  assert.match(
    body,
    /if test "\$\{docker_api_fenced\}" != true && test "\$\{marker_publication_recovered\}" = true[^\n]+mktemp/u,
  );
  assert.match(
    body,
    /if test "\$\{docker_api_fenced\}" = true; then[\s\S]*?status=1[\s\S]*?continuity_valid=false[\s\S]*?elif test "\$\{marker_valid\}"/u,
  );
  assert.equal((body.match(/marker_pair_refresh_required=true/gu) ?? []).length, 1);
  assert.equal(
    (body.match(/systemctl start refunddesk-edge-window-watchdog\.service/gu) ?? []).length,
    1,
  );
  assert.ok(
    body.indexOf('if test "${docker_api_fenced}" = true; then') <
      body.indexOf("marker_pair_refresh_required=true") &&
      body.indexOf("marker_pair_refresh_required=true") <
        body.indexOf("systemctl start refunddesk-edge-window-watchdog.service"),
  );
});

test(
  "production host containment broad-fences a persistent public listener and reads it again",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const listeners = runner.match(
      /# REFUNDDESK_EDGE_HOST_CONTAIN_LISTENERS_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_HOST_CONTAIN_LISTENERS_END/u,
    );
    assert.ok(listeners?.[1]);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-host-listener-"));
    try {
      const bin = join(root, "bin");
      const log = join(root, "calls.log");
      const listener = join(root, "listener-active");
      mkdirSync(bin, { mode: 0o700 });
      writeFileSync(listener, "active\n", { mode: 0o600 });
      writeFileSync(
        join(bin, "ss"),
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf \'ss %s\\n\' "$*" >>"${REFUNDDESK_TEST_LOG}"',
          "test ! -e \"${REFUNDDESK_TEST_LISTENER}\" || printf 'LISTEN fixture\\n'",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(join(bin, "ss"), 0o700);
      const invoke = (persistent) => {
        writeFileSync(listener, "active\n", { mode: 0o600 });
        writeFileSync(log, "", { mode: 0o600 });
        const program = [
          "set -uo pipefail",
          "status=0",
          "fence_ambiguous_docker() {",
          "  printf 'broad-fence\\n' >>\"${REFUNDDESK_TEST_LOG}\"",
          persistent ? "  :" : '  rm --force -- "${REFUNDDESK_TEST_LISTENER}"',
          "}",
          listeners[1],
          "printf 'status=%s\\n' \"${status}\"",
        ].join("\n");
        return spawnSync("bash", ["-c", program], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            REFUNDDESK_TEST_LISTENER: listener,
            REFUNDDESK_TEST_LOG: log,
          },
          timeout: 10_000,
        });
      };

      const closed = invoke(false);
      assert.equal(closed.status, 0, closed.stderr);
      assert.match(closed.stdout, /status=1/u);
      let calls = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(calls.filter((line) => line.startsWith("ss ")).length, 8);
      assert.ok(calls.indexOf("broad-fence") >= 4);
      assert.equal(existsSync(listener), false);

      const retained = invoke(true);
      assert.equal(retained.status, 0, retained.stderr);
      assert.match(retained.stdout, /status=1/u);
      calls = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(calls.filter((line) => line.startsWith("ss ")).length, 8);
      assert.ok(calls.indexOf("broad-fence") >= 4);
      assert.equal(existsSync(listener), true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "production host containment closes UDP 443 drift before a TERM-ignoring worker",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const block = runner.match(
      /# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_HOST_CONTAIN_CONTAINERS_END/u,
    );
    assert.ok(block?.[1]);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-host-early-listener-"));
    const exactCaddy = "a".repeat(64);
    const exactWorker = "b".repeat(64);
    try {
      const bin = join(root, "bin");
      const log = join(root, "calls.log");
      const listener = join(root, "listener-active");
      mkdirSync(bin, { mode: 0o700 });
      writeFileSync(listener, "active\n", { mode: 0o600 });
      writeFileSync(
        join(bin, "docker"),
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf \'docker %s\\n\' "$*" >>"${REFUNDDESK_TEST_LOG}"',
          'if [[ "$1" == container && "$2" == ls ]]; then',
          `  if [[ "$*" == *"service=caddy"* ]]; then printf '${exactCaddy}\\n'; else printf '${exactWorker}\\n'; fi`,
          "  exit 0",
          "fi",
          `if [[ "$1" == inspect && "$*" == *"${exactWorker}"* ]]; then`,
          "  trap '' TERM",
          "  while :; do sleep 10; done",
          "fi",
          "if [[ \"$1\" == inspect ]]; then printf 'no:false\\n'; exit 0; fi",
          'if [[ "$1" == update || "$1" == stop || "$1" == kill ]]; then exit 0; fi',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "ss"),
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf \'ss %s\\n\' "$*" >>"${REFUNDDESK_TEST_LOG}"',
          'if [[ "$*" == *"-lun"* && "$*" == *"sport = :443"* ]] && test -e "${REFUNDDESK_TEST_LISTENER}"; then printf \'LISTEN fixture\\n\'; fi',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "systemctl"),
        [
          "#!/usr/bin/env bash",
          "set -eu",
          'printf \'systemctl %s\\n\' "$*" >>"${REFUNDDESK_TEST_LOG}"',
          'if [[ "$*" == *"docker.service"* ]]; then rm -f -- "${REFUNDDESK_TEST_LISTENER}"; fi',
          'if [[ "$1" == show && "$*" == *"LoadState"* ]]; then printf \'masked\\n\'; exit 0; fi',
          'if [[ "$1" == show && "$*" == *"ActiveState"* ]]; then printf \'inactive\\n\'; exit 0; fi',
          "if [[ \"$1\" == is-enabled ]]; then printf 'masked-runtime\\n'; exit 0; fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(join(bin, "docker"), 0o700);
      chmodSync(join(bin, "ss"), 0o700);
      chmodSync(join(bin, "systemctl"), 0o700);
      const program = [
        "set -uo pipefail",
        "status=0",
        "containers_stopped=0",
        "containers_fenced=0",
        "docker_api_fenced=false",
        `expected_caddy=${exactCaddy}`,
        `expected_worker=${exactWorker}`,
        "marker_publication_recovered=true",
        block[1],
        "printf 'status=%s\\n' \"${status}\"",
      ].join("\n");
      const started = Date.now();
      const result = spawnSync("bash", ["-c", program], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          REFUNDDESK_TEST_LISTENER: listener,
          REFUNDDESK_TEST_LOG: log,
        },
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Date.now() - started < 12_000);
      assert.match(result.stdout, /status=1/u);
      const calls = readFileSync(log, "utf8");
      const broad = calls.indexOf("systemctl kill --kill-who=all --signal=KILL -- docker-*.scope");
      const socketFence = calls.indexOf("systemctl mask --runtime --now -- docker.socket");
      const worker = calls.indexOf(
        `systemctl kill --kill-who=all --signal=KILL docker-${exactWorker}.scope`,
      );
      const earlyUdp443 = calls.indexOf("ss -H -lun sport = :443");
      assert.ok(earlyUdp443 >= 0 && socketFence > earlyUdp443 && broad > socketFence, calls);
      assert.ok(worker > broad, calls);
      assert.doesNotMatch(calls.slice(socketFence), /^docker /mu);
      assert.equal(existsSync(listener), false);
      assert.ok(calls.split("\n").filter((line) => line.startsWith("ss ")).length >= 8);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "firewall cleanup keeps the exact TCP 443 rule first and caps ambiguous extras",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const builder = runner.match(
      /# REFUNDDESK_EDGE_FIREWALL_CLOSE_CANDIDATES_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_FIREWALL_CLOSE_CANDIDATES_PY_END/u,
    );
    assert.notEqual(builder, null);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-firewall-close-"));
    const allowlistPath = join(root, "allowlist.json");
    const currentPath = join(root, "current.json");
    const outputPath = join(root, "candidates.json");
    const exact = {
      cidrs: ["203.0.113.0/24"],
      fromPort: 443,
      ipv6Cidrs: ["2001:db8::/48"],
      protocol: "tcp",
      toPort: 443,
    };
    writeFileSync(allowlistPath, canonical({ ipv4: exact.cidrs, ipv6: exact.ipv6Cidrs }), {
      mode: 0o600,
    });
    const invoke = (states) => {
      writeFileSync(currentPath, canonical({ portStates: states }), { mode: 0o600 });
      const result = spawnSync("python3", ["-", currentPath, allowlistPath, outputPath, "8"], {
        encoding: "utf8",
        input: builder[1],
        timeout: 5000,
      });
      return { candidates: JSON.parse(readFileSync(outputPath, "utf8")), result };
    };
    try {
      const firstDangerous = {
        cidrs: ["0.0.0.0/0"],
        fromPort: 1,
        ipv6Cidrs: [],
        protocol: "udp",
        state: "open",
        toPort: 65_535,
      };
      const ordinary = invoke([firstDangerous]);
      assert.equal(ordinary.result.status, 0, ordinary.result.stderr);
      assert.equal(ordinary.result.stdout.trim(), "true");
      assert.deepEqual(ordinary.candidates[0], exact);
      assert.deepEqual(ordinary.candidates[1], {
        cidrs: firstDangerous.cidrs,
        fromPort: firstDangerous.fromPort,
        ipv6Cidrs: firstDangerous.ipv6Cidrs,
        protocol: firstDangerous.protocol,
        toPort: firstDangerous.toPort,
      });

      const many = invoke(
        Array.from({ length: 70 }, (_, index) => ({
          cidrs: [`198.51.100.${index}/32`],
          fromPort: 443,
          ipv6Cidrs: [],
          protocol: index % 2 === 0 ? "tcp" : "udp",
          state: "open",
          toPort: 443,
        })),
      );
      assert.equal(many.result.status, 0, many.result.stderr);
      assert.equal(many.result.stdout.trim(), "true");
      assert.deepEqual(many.candidates[0], exact);
      assert.ok(many.candidates.length <= 9);
      const closeFunction = runner.slice(
        runner.indexOf("production_firewall_close()"),
        runner.indexOf("production_watchdog_arm()"),
      );
      const exactCloseIndex = closeFunction.indexOf(
        'lightsail close-instance-public-ports --instance-name "${instance}"',
      );
      const firstInventoryIndex = closeFunction.indexOf(
        "lightsail get-instance-port-states --instance-name",
      );
      assert.ok(exactCloseIndex >= 0 && exactCloseIndex < firstInventoryIndex);
      assert.match(closeFunction, /firewall_open_attempted.*close_attempted_first=false/u);
      assert.doesNotMatch(closeFunction, /current_sha.*before_sha[\s\S]*?return/u);
      assert.doesNotMatch(closeFunction, /\baws_command lightsail close-instance-public-ports/u);
      assert.match(
        closeFunction,
        /bounded_aws_command "\$\{remaining\}" lightsail close-instance-public-ports/u,
      );
      assert.match(closeFunction, /close_phase_deadline=/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

for (const scenario of [
  "firewall-extra-after-open-wildcard",
  "firewall-extra-after-open-port80-udp",
]) {
  test(
    `${scenario} is removed but permanently invalidates CloudFront-only PASS attribution`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario, { timeout: 30_000 });
      try {
        assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
        const evidence = parseEvidence(run.result);
        validateFixtureEvidence(evidence, 21);
        assert.equal(evidence.result, "INCOMPLETE");
        assert.equal(evidence.code, "FIREWALL_CLOSE_AMBIGUOUS");
        assert.equal(evidence.firewall.closeAmbiguous, true);
        assert.equal(evidence.firewall.finalClosed, true);
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        const open = state.operations.indexOf("firewall-open");
        const close = state.operations.indexOf("firewall-close");
        assert.ok(open >= 0 && close > open);
        assert.equal(
          state.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.equal(state.firewallOpen, false);
        assert.equal(state.firewallExtraRuleClosed, true);
        assert.equal(state.watchdogDisarmed, true);
        assert.equal(state.hostLeaseReleased, true);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test("operator image exposes only the pinned source allowlist, never the caller repository", () => {
  const dockerfile = readFileSync(operatorDockerfilePath, "utf8");
  const wrapper = readFileSync(wrapperPath, "utf8");
  assert.doesNotMatch(dockerfile, /^COPY\s+(?:--\S+\s+)*\.\s+/mu);
  for (const path of sourcePaths) {
    assert.match(
      dockerfile,
      new RegExp(
        `^COPY\\s+--chmod=0(?:444|555)\\s+${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s+/workspace/${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
        "mu",
      ),
    );
  }
  assert.equal((dockerfile.match(/\s\/workspace\/[^\s]+$/gmu) ?? []).length, sourcePaths.length);
  assert.doesNotMatch(wrapper, /target=\/workspace,readonly/u);
  assert.match(wrapper, /OPERATOR_SOURCES_INVALID/u);
  assert.match(wrapper, /root\.rglob\("\*"\)/u);
});

test("host lease serializes every edge phase against release and quiesce recovery", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const release = readFileSync(releasePath, "utf8");
  const recovery = readFileSync(recoveryPath, "utf8");
  assert.ok(
    runner.indexOf("run_patch_operation host-lease-acquire") <
      runner.indexOf("run_patch_operation origin-bind"),
  );
  const cleanup = runner.indexOf("cleanup_surfaces() {");
  const finalPostflight = runner.indexOf("run_patch_operation final-postflight", cleanup);
  const watchdogDisarm = runner.indexOf("run_patch_operation watchdog-disarm", cleanup);
  const leaseComplete = runner.indexOf("run_patch_operation host-lease-complete", watchdogDisarm);
  const leaseRelease = runner.indexOf("run_patch_operation host-lease-release", leaseComplete);
  assert.ok(
    finalPostflight < watchdogDisarm &&
      watchdogDisarm < leaseComplete &&
      leaseComplete < leaseRelease,
  );
  const leaseReleaseFunction = runner.slice(
    runner.indexOf("production_host_lease_release()"),
    runner.indexOf("production_host_lease_finalization_status()"),
  );
  assert.doesNotMatch(leaseReleaseFunction, /systemctl show[^\n]+\|\| true/u);
  assert.match(leaseReleaseFunction, /flock --exclusive --timeout 5 8/u);
  assert.match(leaseReleaseFunction, /flock --exclusive --timeout 5 9/u);
  for (const launcher of [release, recovery]) {
    assert.match(launcher, /edge-window-lease\.json/u);
    assert.match(launcher, /document\.get\("state"\) != "complete"/u);
    assert.match(launcher, /active or invalid edge-window interlock/u);
    const guards = launcher.match(/edge_window_allows_runtime_start \|\|/gu) ?? [];
    assert.equal(guards.length, 2);
  }
});

test(
  "the holder takes the unique edge lock and operator shared lock directly with no conversion gap",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const holderSource = runner.slice(
      runner.indexOf("holder='set -Eeuo pipefail"),
      runner.indexOf('while test ! -e "${signal}"', runner.indexOf("holder='set -Eeuo pipefail")),
    );
    const edgeLock = holderSource.indexOf("flock --exclusive --nonblock 8");
    const operatorShared = holderSource.indexOf("flock --shared --nonblock 9");
    const markerPublish = holderSource.indexOf("publish_or_recover(authorization_path");
    assert.ok(edgeLock >= 0 && edgeLock < operatorShared && operatorShared < markerPublish);
    assert.doesNotMatch(holderSource, /flock --exclusive[^\n]* 9/u);
    assert.equal((holderSource.match(/flock --shared[^\n]* 9/gu) ?? []).length, 1);

    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-lock-contract-"));
    const holderLock = join(root, "edge-window-holder.lock");
    const operatorLock = join(root, "operator.lock");
    const ready = join(root, "ready");
    const release = join(root, "release");
    const waiterStarted = join(root, "waiter-started");
    const waiterWon = join(root, "waiter-won");
    const holder = spawn(
      "bash",
      [
        "-c",
        'exec 8>"$1"; flock --exclusive --nonblock 8 || exit 1; exec 9>"$2"; flock --shared --nonblock 9 || exit 2; : >"$3"; while test ! -e "$4"; do sleep .02; done',
        "_",
        holderLock,
        operatorLock,
        ready,
        release,
      ],
      { stdio: "ignore" },
    );
    let waiter;
    try {
      const admitted = spawnSync(
        "bash",
        [
          "-c",
          'for _ in $(seq 1 100); do test -e "$1" && exit 0; sleep .02; done; exit 1',
          "_",
          ready,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(admitted.status, 0, admitted.stderr);
      const observer = spawnSync("flock", ["--shared", "--nonblock", operatorLock, "true"], {
        encoding: "utf8",
        timeout: 2000,
      });
      assert.equal(observer.status, 0, observer.stderr);

      waiter = spawn(
        "bash",
        [
          "-c",
          ': >"$2"; exec 9>"$1"; flock --exclusive 9; : >"$3"; sleep 10',
          "_",
          operatorLock,
          waiterStarted,
          waiterWon,
        ],
        { stdio: "ignore" },
      );
      const waiting = spawnSync(
        "bash",
        [
          "-c",
          'for _ in $(seq 1 100); do test -e "$1" && exit 0; sleep .02; done; exit 1',
          "_",
          waiterStarted,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(waiting.status, 0, waiting.stderr);
      const remainedBlocked = spawnSync(
        "bash",
        ["-c", 'sleep .2; test ! -e "$1"', "_", waiterWon],
        {
          encoding: "utf8",
          timeout: 2000,
        },
      );
      assert.equal(remainedBlocked.status, 0, remainedBlocked.stderr);

      writeFileSync(release, "release\n", { mode: 0o600 });
      const acquiredAfterRelease = spawnSync(
        "bash",
        [
          "-c",
          'for _ in $(seq 1 100); do test -e "$1" && exit 0; sleep .02; done; exit 1',
          "_",
          waiterWon,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(acquiredAfterRelease.status, 0, acquiredAfterRelease.stderr);
    } finally {
      holder.kill("SIGKILL");
      waiter?.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "offline PASS proves one open, post-open Workbench checkpoint, AWS-first close and containment",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass");
    try {
      assert.equal(
        run.result.status,
        0,
        `${run.result.stderr}\n${run.result.stdout}\n${readFileSync(run.statePath, "utf8")}`,
      );
      const document = parseEvidence(run.result);
      validateEdgeWindowDocument(document, {
        allowFixture: true,
        expectedNonce: nonce,
        expectedRevision: revision,
        notAfter: "2026-08-08T12:02:00Z",
        notBefore: "2026-08-08T11:59:59Z",
        processExitCode: 0,
        schema,
      });
      assert.equal(document.code, "PASS_EDGE_WINDOW_RECONTAINED");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(
        state.operations.indexOf("watchdog-arm") < state.operations.indexOf("firewall-open"),
      );
      assert.ok(
        state.operations.indexOf("firewall-close") < state.operations.indexOf("host-contain"),
      );
      assert.ok(
        state.operations.indexOf("host-contain") < state.operations.indexOf("origin-unbind"),
      );
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(document.probes.workbench.createdAfterOpen, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "slow CloudFront deployment consumes no ingress budget and the armed window remains at most 300 seconds",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      statePatch: {
        timestamps: [
          "2026-08-08T12:00:00Z",
          "2026-08-08T12:06:00Z",
          "2026-08-08T12:06:10Z",
          "2026-08-08T12:07:00Z",
          "2026-08-08T12:07:10Z",
        ],
        workbenchCapturedAt: "2026-08-08T12:06:30Z",
      },
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const document = parseEvidence(run.result);
      const start = Date.parse(document.startedAt);
      const armed = Date.parse(document.watchdog.armedAt);
      const opened = Date.parse(document.window.openedAt);
      const deadline = Date.parse(document.window.deadlineAt);
      assert.ok(armed - start > 300_000);
      assert.ok(deadline - armed <= 300_000);
      assert.ok(deadline - opened <= 300_000);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a close after the conservative watchdog deadline is contained but can never be finalized as PASS",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      statePatch: {
        timestamps: [
          "2026-08-08T12:00:00Z",
          "2026-08-08T12:00:20Z",
          "2026-08-08T12:00:30Z",
          "2026-08-08T12:01:00Z",
          "2026-08-08T12:05:00Z",
          "2026-08-08T12:05:10Z",
        ],
      },
      timeout: 30000,
    });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const document = parseEvidence(run.result);
      assert.equal(document.result, "INCOMPLETE");
      assert.equal(document.window.state, "failed_closed");
      assert.ok(Date.parse(document.window.closedAt) > Date.parse(document.window.deadlineAt));
      validateFixtureEvidence(document, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [scenario, code, expectedExit = 20] of [
  ["etag-race", "ORIGIN_CONFIGURATION_AMBIGUOUS"],
  ["never-deployed", "ORIGIN_DEPLOYMENT_TIMEOUT"],
  ["stale-prefix", "PREFIX_DOCUMENT_STALE"],
  ["malformed-prefix", "PREFIX_DOCUMENT_INVALID"],
  ["wildcard", "FIREWALL_OPEN_INVALID"],
  ["port80", "FIREWALL_OPEN_INVALID"],
  ["udp", "FIREWALL_OPEN_INVALID"],
  ["deadline-before-open", "WATCHDOG_ARM_FAILED"],
  ["watchdog-effective-unit-drift", "WATCHDOG_ARM_FAILED"],
  ["watchdog-effective-unit-argv-drift", "WATCHDOG_ARM_FAILED"],
  ["checkpoint-before-open", "WORKBENCH_CHECKPOINT_INVALID"],
  ["checkpoint-cli", "WORKBENCH_CHECKPOINT_INVALID"],
  ["checkpoint-overwrite-race", "WORKBENCH_CHECKPOINT_INVALID"],
  ["counts-changed", "DURABLE_COUNTS_CHANGED"],
  ["public-health-body-overflow", "PUBLIC_HEALTH_FAILED"],
  ["external-preclosed", "FINAL_CONTAINMENT_FAILED"],
  ["origin-unbind-fail", "FINAL_CONTAINMENT_FAILED", 21],
  ["host-contain-fail-after-open", "FINAL_CONTAINMENT_FAILED", 21],
  ["origin-gc-fail", "FINAL_CONTAINMENT_FAILED", 21],
  ["final-postflight-fail", "FINAL_CONTAINMENT_FAILED", 21],
  ["final-postflight-baseline-drift", "FINAL_CONTAINMENT_FAILED", 21],
  ["provider-rebound-during-final-postflight", "FINAL_CONTAINMENT_FAILED", 21],
  ["provider-rebound-after-watchdog-disarm", "FINAL_CONTAINMENT_FAILED", 21],
  ["oversize", "PREFIX_DOCUMENT_INVALID"],
]) {
  test(
    `offline ${scenario} fails closed without a second open`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario);
      try {
        assert.equal(run.result.status, expectedExit, run.result.stderr);
        const document = parseEvidence(run.result);
        assert.equal(document.result, expectedExit === 20 ? "FAIL" : "INCOMPLETE");
        assert.equal(document.code, code);
        if (expectedExit === 21) {
          validateEdgeWindowDocument(document, {
            allowFixture: true,
            expectedNonce: nonce,
            expectedRevision: revision,
            notAfter: "2026-08-08T12:02:00Z",
            notBefore: "2026-08-08T11:59:59Z",
            processExitCode: 21,
            schema,
          });
        }
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        if (state.operations.includes("firewall-open")) {
          assert.ok(state.operations.includes("firewall-close"));
          assert.ok(
            state.operations.indexOf("firewall-close") < state.operations.indexOf("host-contain"),
          );
        }
        assert.ok(
          state.operations.filter((operation) => operation === "firewall-open").length <= 1,
        );
        if (scenario === "deadline-before-open") {
          assert.equal(
            state.operations.filter((operation) => operation === "firewall-open").length,
            0,
          );
        }
        if (scenario === "provider-rebound-after-watchdog-disarm") {
          assert.deepEqual(document.interlocksAtCapture, {
            authorizationMarkerState: "held",
            holderActive: true,
            hostLeaseMarkerState: "held",
            watchdogMarkerState: "complete",
          });
          assert.equal(document.watchdog.disarmed, true);
          assert.equal(document.watchdog.markerComplete, true);
          assert.equal(state.hostLease, "held");
          assert.equal(state.authorizationLease, "held");
          assert.equal(state.hostLeaseReleased ?? false, false);
          assert.equal(state.operations.includes("host-lease-complete"), false);
          assert.equal(state.operations.includes("host-lease-release"), false);
        }
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "a host containment failure after ingress is an officially valid retained INCOMPLETE proof",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("host-contain-fail-after-open", { timeout: 30_000 });
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      const document = parseEvidence(run.result);
      assert.equal(document.result, "INCOMPLETE");
      assert.equal(document.code, "FINAL_CONTAINMENT_FAILED");
      assert.equal(document.firewall.finalClosed, true);
      assert.equal(document.containment.awsIngressClosed, true);
      assert.equal(document.containment.caddyStopped, false);
      assert.equal(document.containment.publicListenersClosed, false);
      assert.equal(document.watchdog.disarmed, false);
      assert.equal(document.origin.tokenFileRemoved, false);
      validateEdgeWindowDocument(document, {
        allowFixture: true,
        expectedNonce: nonce,
        expectedRevision: revision,
        notAfter: "2026-08-08T12:02:00Z",
        notBefore: "2026-08-08T11:59:59Z",
        processExitCode: 21,
        schema,
      });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.hostLeaseReleased, undefined);
      assert.equal(state.watchdogDisarmed, undefined);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "lost CloudFront bind and unbind acknowledgements converge safely without repeating a window",
  { skip: !linuxContractAvailable },
  () => {
    const bindLost = runScenario("origin-bind-lost-ack", { timeout: 30_000 });
    try {
      assert.equal(bindLost.result.status, 21, bindLost.result.stderr);
      const evidence = parseEvidence(bindLost.result);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.window.state, "failed_closed");
      assert.equal(evidence.origin.etagBindMatched, false);
      assert.equal(evidence.origin.etagUnbindMatched, true);
      validateFixtureEvidence(evidence, 21);
      const state = JSON.parse(readFileSync(bindLost.statePath, "utf8"));
      assert.equal(state.originBound, false);
      assert.equal(state.originProviderState, "original");
      assert.equal(state.originProviderUpdateCount, 2);
      assert.equal(state.originUnbindCount, 1);
      assert.equal(state.hostLeaseReleased, true);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 0);
    } finally {
      cleanupScenario(bindLost);
    }

    const unbindLost = runScenario("origin-unbind-lost-ack", { timeout: 30_000 });
    try {
      assert.equal(unbindLost.result.status, 21, unbindLost.result.stderr);
      const firstState = JSON.parse(readFileSync(unbindLost.statePath, "utf8"));
      assert.equal(firstState.originBound, false);
      assert.equal(firstState.originProviderState, "original");
      assert.equal(firstState.originProviderUpdateCount, 2);
      assert.equal(firstState.originUnbindCount, 1);
      const resumed = resumeScenario(unbindLost);
      assert.equal(resumed.status, 21, resumed.stderr);
      const resumedEvidence = parseEvidence(resumed);
      assert.equal(resumedEvidence.result, "INCOMPLETE");
      assert.equal(resumedEvidence.origin.etagBindMatched, true);
      assert.equal(resumedEvidence.origin.etagUnbindMatched, false);
      validateFixtureEvidence(resumedEvidence, 21);
      const finalState = JSON.parse(readFileSync(unbindLost.statePath, "utf8"));
      assert.equal(finalState.originProviderUpdateCount, 2);
      assert.equal(finalState.originUnbindCount, 1);
      assert.equal(finalState.hostLeaseAcquireCount, 1);
      assert.equal(finalState.hostLeaseReleased, true);
      assert.equal(
        finalState.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(unbindLost);
    }
  },
);

test(
  "a provider rebind during the official postflight wait is caught before terminalization",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("provider-rebound-during-final-postflight", { timeout: 30000 });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      assert.equal(parseEvidence(run.result).result, "INCOMPLETE");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.originBound, true);
      assert.equal(state.operations.filter((operation) => operation === "origin-status").length, 2);
      assert.equal(state.operations.includes("host-lease-complete"), false);
      assert.equal(state.operations.includes("host-lease-release"), false);
      assert.equal(state.hostLease, "held");
      assert.equal(state.authorizationLease, "held");
      assert.equal(state.hostLeaseReleased ?? false, false);
      const evidence = parseEvidence(run.result);
      assert.deepEqual(evidence.interlocksAtCapture, {
        authorizationMarkerState: "held",
        holderActive: true,
        hostLeaseMarkerState: "held",
        watchdogMarkerState: "armed",
      });
      assert.equal(evidence.watchdog.disarmed, false);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "secret residue resurrected during final postflight is rescanned before PASS or lease consumption",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("secret-resurrected-during-final-postflight", { timeout: 30_000 });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.notEqual(evidence.code, "PASS_EDGE_WINDOW_RECONTAINED");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const scans = state.operations
        .map((operation, index) => ({ index, operation }))
        .filter(({ operation }) => operation === "origin-secret-scan")
        .map(({ index }) => index);
      const finalPostflight = state.operations.indexOf("final-postflight");
      assert.ok(scans.length >= 2, JSON.stringify(state.operations));
      assert.ok(scans[0] < finalPostflight && scans.some((index) => index > finalPostflight));
      assert.equal(state.originSecretCanary, true);
      assert.equal(state.operations.includes("host-lease-complete"), false);
      assert.equal(state.operations.includes("host-lease-release"), false);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(state.firewallOpen, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a host-token candidate left before origin acknowledgement is removed before cleanup can converge",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("origin-caddy-temp-crash", { timeout: 30000 });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "INCOMPLETE");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.caddyTempEffectObserved, true);
      assert.equal(state.caddyTempResidue, false);
      assert.equal(state.firewallOpen, false);
      assert.ok(state.operations.includes("origin-unbind"));
      assert.ok(state.operations.includes("origin-secret-scan"));
      assert.equal(state.operations.includes("firewall-open"), false);
      assert.equal(state.hostLeaseReleased, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a replay rescans secret residue immediately before GC instead of trusting an earlier scan",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_origin_secret_scan", timeout: 30_000 });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(interrupted.originGcCount ?? 0, 0);
      assert.equal(
        interrupted.operations.filter((operation) => operation === "origin-secret-scan").length,
        1,
      );
      interrupted.originSecretCanary = true;
      writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });

      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      validateFixtureEvidence(evidence, 21);
      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(
        finalState.operations.filter((operation) => operation === "origin-secret-scan").length,
        2,
      );
      assert.equal(finalState.originGcCount ?? 0, 0);
      assert.equal(finalState.firewallOpen, false);
      assert.notEqual(finalState.hostLeaseReleased, true);
      assert.equal(finalState.watchdogArmed, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a post-GC replay rescans secret residue before PASS",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_origin_gc", timeout: 30_000 });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(interrupted.originGcCount, 1);
      interrupted.originSecretCanary = true;
      writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });

      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      validateFixtureEvidence(evidence, 21);
      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(finalState.originGcCount, 1);
      assert.equal(finalState.firewallOpen, false);
      assert.notEqual(finalState.hostLeaseReleased, true);
      assert.equal(finalState.watchdogArmed, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a TERM-ignoring runner adapter is killed within the operation budget and never reaches origin or ingress",
  { skip: !linuxContractAvailable },
  () => {
    const started = Date.now();
    const run = runScenario("runner-adapter-ignore-term", { timeout: 25000 });
    try {
      assert.equal(run.result.status, 20, run.result.stderr);
      assert.ok(Date.now() - started < 20000);
      const document = parseEvidence(run.result);
      assert.equal(document.result, "FAIL");
      assert.equal(document.code, "PREFIX_DOCUMENT_INVALID");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(state.operations.includes("runner:adapter-term-ignored:prefix-fetch"));
      assert.equal(state.operations.includes("origin-bind"), false);
      assert.equal(state.operations.includes("firewall-open"), false);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [name, mutate] of [
  ["authorization rejection", (control) => (control.admission.authorizationAccepted = false)],
  [
    "authorization maximum-window underrun",
    (control) => (control.admission.authorizationMaxWindowSeconds = 299),
  ],
  ["incident rejection", (control) => (control.admission.incidentAccepted = false)],
  ["promotion rejection", (control) => (control.admission.promotionAccepted = false)],
  ["postflight rejection", (control) => (control.admission.postflightAccepted = false)],
  [
    "postflight captured after the incident envelope",
    (control) => (control.admission.postflightCapturedAt = "2026-08-08T11:59:31Z"),
  ],
  [
    "incident envelope captured after edge start",
    (control) => (control.admission.incidentCapturedAt = "2026-08-08T12:00:01Z"),
  ],
  [
    "incident admission has only 719 seconds remaining",
    (control) => {
      control.admission.incidentRemainingSecondsAtStart = 720;
      control.admission.incidentValidUntil = "2026-08-08T12:11:59Z";
    },
  ],
  [
    "incident admission has 901 seconds remaining",
    (control) => {
      control.admission.incidentRemainingSecondsAtStart = 900;
      control.admission.incidentValidUntil = "2026-08-08T12:15:01Z";
    },
  ],
  [
    "postflight admission has only 719 seconds remaining",
    (control) => {
      control.admission.postflightRemainingSecondsAtStart = 720;
      control.admission.postflightValidUntil = "2026-08-08T12:11:59Z";
    },
  ],
  [
    "postflight admission has 901 seconds remaining",
    (control) => {
      control.admission.postflightRemainingSecondsAtStart = 900;
      control.admission.postflightValidUntil = "2026-08-08T12:15:01Z";
    },
  ],
  ["promotion revision drift", (control) => (control.admission.promotionRevision = "9".repeat(40))],
  [
    "promotion runtime-mode drift",
    (control) => (control.admission.promotionWorkerRuntimeMode = "normal"),
  ],
]) {
  test(
    `${name} is rejected before the host lease, origin, or firewall can mutate`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { controlMutator: mutate });
      try {
        assert.equal(
          run.result.status,
          20,
          `${run.result.stderr}\n${run.result.stdout}\n${readFileSync(run.statePath, "utf8")}`,
        );
        const document = parseEvidence(run.result);
        assert.equal(document.result, "FAIL");
        assert.equal(document.code, "ADMISSION_EVIDENCE_INVALID");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(state.operations, []);
        assert.equal(state.firewallOpen, false);
        assert.equal(state.originBound, false);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "the runner admits the inclusive 720-second ADR0034/ADR0036 point-in-time boundary",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      controlMutator: (control) => {
        control.admission.incidentRemainingSecondsAtStart = 720;
        control.admission.incidentValidUntil = "2026-08-08T12:12:00Z";
        control.admission.postflightRemainingSecondsAtStart = 720;
        control.admission.postflightValidUntil = "2026-08-08T12:12:00Z";
      },
      timeout: 30_000,
    });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "PASS");
      validateFixtureEvidence(evidence, 0);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a delayed first runner invocation consumes the durable workstation admission instant",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      statePatch: {
        prefixFetchedAt: "2026-08-08T12:03:35Z",
        timestamps: [
          "2026-08-08T12:03:30Z",
          "2026-08-08T12:03:40Z",
          "2026-08-08T12:03:50Z",
          "2026-08-08T12:04:30Z",
          "2026-08-08T12:04:40Z",
        ],
        workbenchCapturedAt: "2026-08-08T12:04:00Z",
      },
      timeout: 30_000,
    });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.operationStartedAt, "2026-08-08T12:00:00Z");
      assert.equal(evidence.startedAt, "2026-08-08T12:03:30Z");
      assert.equal(evidence.result, "PASS");
      validateFixtureEvidence(evidence, 0);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.originBound, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a slow pre-effect adapter crossing the absolute operation deadline cannot bind an origin or open ingress",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("operation-deadline-crossing", {
      statePatch: {
        prefixFetchedAt: "2026-08-08T12:34:59Z",
        timestamps: ["2026-08-08T12:34:59Z", "2026-08-08T12:35:01Z", "2026-08-08T12:35:02Z"],
      },
      timeout: 30_000,
    });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.code, "CONTROL_PLANE_UNAVAILABLE");
      assert.equal(evidence.operationStartedAt, "2026-08-08T12:00:00Z");
      validateFixtureEvidence(evidence, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(state.operations.includes("runner:slow-prefix-crossed-operation-deadline"));
      assert.equal(state.operations.includes("origin-bind"), false);
      assert.equal(state.operations.includes("watchdog-arm"), false);
      assert.equal(state.operations.includes("caddy-start"), false);
      assert.equal(state.operations.includes("firewall-open"), false);
      assert.equal(state.originBound, false);
      assert.equal(state.firewallOpen, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a wall rollback cannot recreate a spent Linux boottime grant on runner resume",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      controlMutator: (control) => {
        // Ten minutes of operator preparation plus the 240-second handoff
        // reserve leaves at most 1,260 seconds for the runner.
        control.operationRemainingSecondsAtRunnerStart = 1260;
      },
      crashPoint: "after_run_marker_prepared",
    });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-run.json"), "utf8"),
      );
      assert.equal(
        marker.runnerDeadlineBoottimeMilliseconds - marker.runnerStartedBoottimeMilliseconds,
        1_260_000,
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.deepEqual(state.operations, []);
      state.boottimeMilliseconds = marker.runnerDeadlineBoottimeMilliseconds + 1;
      state.operationClockEpoch = Math.floor(Date.parse("2026-08-08T11:55:00Z") / 1000);
      state.timestampIndex = 0;
      state.timestamps = ["2026-08-08T11:55:00Z"];
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const resumed = resumeScenario(run, { mode: "run", timeout: 40_000 });
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      assert.equal(resumed.stdout, "");
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.operations.includes("origin-bind"), false);
      assert.equal(after.operations.includes("watchdog-arm"), false);
      assert.equal(after.operations.includes("caddy-start"), false);
      assert.equal(after.operations.includes("firewall-open"), false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a complete embedded terminal PASS replays after runner deadline expiry without a new effect",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { timeout: 40_000 });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${run.result.stdout}`);
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-run.json"), "utf8"),
      );
      assert.equal(marker.state, "complete");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operationOffset = state.operations.length;
      state.bootId = "87654321-4321-4321-8321-cba987654321";
      state.boottimeMilliseconds = marker.runnerDeadlineBoottimeMilliseconds + 60_000;
      state.operationClockEpoch = Math.floor(Date.parse("2026-08-08T13:00:00Z") / 1000);
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const replay = resumeScenario(run, { mode: "run", timeout: 30_000 });
      assert.equal(replay.status, 0, `${replay.stderr}\n${replay.stdout}`);
      assert.equal(replay.stdout, run.result.stdout);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.deepEqual(after.operations.slice(operationOffset), []);
    } finally {
      cleanupScenario(run);
    }
  },
);

test("every effectful opening phase is subordinate to the fixed 35-minute operation deadline", () => {
  const runner = readFileSync(runnerPath, "utf8");
  assert.match(
    runner,
    /OPERATION_DEADLINE_AT="\$\(timestamp_add_seconds "\$\{OPERATION_STARTED_AT\}" "\$\{EXECUTION_MAX_SECONDS\}"\)"/u,
  );
  assert.match(
    runner,
    /RUNNER_DEADLINE_BOOTTIME_MILLISECONDS - RUNNER_CLOCK_OBSERVED_BOOTTIME_MILLISECONDS[\s\S]*?wall_remaining < boottime_remaining/u,
  );
  assert.match(runner, /runnerBootIdentifierSha256/u);
  assert.match(runner, /runnerDeadlineBoottimeMilliseconds/u);
  assert.match(runner, /operationRemainingSecondsAtRunnerStart/u);
  for (const [minimum, operation] of [
    ["ORIGIN_BIND_MINIMUM_REMAINING_SECONDS", "origin-bind"],
    ["CADDY_START_MINIMUM_REMAINING_SECONDS", "caddy-start"],
    ["FIREWALL_OPEN_MINIMUM_REMAINING_SECONDS", "firewall-open"],
  ]) {
    assert.ok(
      runner.lastIndexOf(`begin_pre_effect_budget "\${${minimum}}"`) <
        runner.lastIndexOf(`run_patch_operation ${operation}`),
    );
  }
  assert.ok(
    runner.lastIndexOf('begin_pre_effect_budget "${WATCHDOG_ARM_MINIMUM_REMAINING_SECONDS}"') <
      runner.lastIndexOf("run_patch_operation watchdog-arm"),
  );
  assert.match(
    runner,
    /operation_remaining="\$\(operation_budget_remaining_seconds\)"[\s\S]*?candidate_deadline_epoch=\$\(\(armed_epoch \+ WINDOW_SECONDS - WATCHDOG_CONTAINMENT_RESERVE_SECONDS\)\)[\s\S]*?operation_deadline_epoch < deadline_epoch[\s\S]*?authorization_valid_until < deadline_epoch/u,
  );
  assert.match(runner, /seconds="\$\(effect_timeout_seconds "\$\{requested_seconds\}" 5\)"/u);
  assert.match(
    runner,
    /timeout_seconds="\$\(effect_timeout_seconds "\$\{ADAPTER_OPERATION_TIMEOUT_SECONDS\}" 1\)"/u,
  );
});

for (const [name, field] of [
  ["AWS account", "authorizedAwsAccountIdSha256"],
  ["AWS region", "authorizedAwsRegionSha256"],
  ["SSH CIDR", "authorizedSshCidrSha256"],
]) {
  test(
    `${name} transport/authorization drift is rejected before every effect`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", {
        controlMutator: (control) => {
          control.admission[field] = "0".repeat(64);
        },
      });
      try {
        assert.equal(run.result.status, 64, run.result.stderr);
        assert.equal(run.result.stdout, "");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(state.operations, []);
        assert.equal(state.firewallOpen, false);
        assert.equal(state.originBound, false);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const [name, mutate] of [
  [
    "SSH config path and command drift with recomputed digests",
    (transport, root) => {
      const rogue = join(root, "rogue-ssh-config");
      writeFileSync(
        rogue,
        "Host refunddesk-edge\n  HostName 192.0.2.44\n  User ubuntu\n  ProxyCommand /bin/false\n",
        { mode: 0o600 },
      );
      chmodSync(rogue, 0o600);
      transport.sshConfigPath = rogue;
      transport.sshConfigSha256 = sha256File(rogue);
    },
  ],
  [
    "AWS config semantic drift with a recomputed digest",
    (transport, root) => {
      const awsConfig = join(root, "aws-config");
      writeFileSync(awsConfig, "[default]\nregion = us-east-1\noutput = json\n", { mode: 0o600 });
      chmodSync(awsConfig, 0o600);
      transport.awsConfigSha256 = sha256File(awsConfig);
    },
  ],
]) {
  test(`${name} is rejected before every effect`, { skip: !linuxContractAvailable }, () => {
    const run = runScenario("pass", { transportMutator: mutate });
    try {
      assert.equal(run.result.status, 64, run.result.stderr);
      assert.equal(run.result.stdout, "");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.deepEqual(state.operations, []);
      assert.equal(state.firewallOpen, false);
      assert.equal(state.originBound, false);
    } finally {
      cleanupScenario(run);
    }
  });
}

for (const scenario of [
  "cloudfront-default-route-mismatch",
  "cloudfront-ordered-route-mismatch",
  "cloudfront-edge-association",
  "cloudfront-custom-error-response",
  "cloudfront-continuous-deployment",
  "cloudfront-web-acl",
]) {
  test(
    `${scenario} is rejected under the lease before origin bind or firewall open`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario);
      try {
        assert.equal(
          run.result.status,
          20,
          `${run.result.stderr}\n${run.result.stdout}\n${readFileSync(run.statePath, "utf8")}`,
        );
        const document = parseEvidence(run.result);
        assert.equal(document.result, "FAIL");
        assert.equal(document.code, "TOPOLOGY_BINDING_INVALID");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(state.operations.slice(0, 2), ["host-lease-acquire", "aws-baseline"]);
        assert.equal(state.hostLeaseAcquireCount, 1);
        assert.equal(state.hostLeaseReleased, true);
        assert.equal(state.originBound, false);
        assert.equal(state.originProviderUpdateCount ?? 0, 0);
        assert.equal(state.hostTokenRewriteCount ?? 0, 0);
        assert.equal(state.firewallOpen, false);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "an inactive but enabled maintenance timer is rejected under the lease before origin mutation",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("maintenance-timer-enabled");
    try {
      assert.equal(run.result.status, 20, `${run.result.stderr}\n${run.result.stdout}`);
      assert.equal(parseEvidence(run.result).code, "TOPOLOGY_BINDING_INVALID");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.originProviderUpdateCount ?? 0, 0);
      assert.equal(state.hostTokenRewriteCount ?? 0, 0);
      assert.equal(state.firewallOpen, false);
      assert.equal(state.hostLeaseReleased, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const scenario of ["residual-watchdog-marker", "watchdog-timer-enabled-inactive"]) {
  test(
    `${scenario} blocks a new nonce before origin bind and remains a fail-closed interlock`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario);
      try {
        assert.equal(run.result.status, 20, `${run.result.stderr}\n${run.result.stdout}`);
        assert.equal(parseEvidence(run.result).code, "TOPOLOGY_BINDING_INVALID");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(state.operations.slice(0, 2), ["host-lease-acquire", "aws-baseline"]);
        assert.equal(state.originProviderUpdateCount ?? 0, 0);
        assert.equal(state.hostTokenRewriteCount ?? 0, 0);
        assert.equal(state.operations.includes("origin-bind"), false);
        assert.equal(state.operations.includes("firewall-open"), false);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test("watchdog installation can only create a fresh marker after exact inactive preflight", () => {
  const runner = readFileSync(runnerPath, "utf8");
  const baseline = runner.slice(
    runner.indexOf("production_aws_baseline()"),
    runner.indexOf("remote_install()"),
  );
  const arm = runner.slice(
    runner.indexOf("production_watchdog_arm()"),
    runner.indexOf("production_window_clock_stop()"),
  );
  assert.match(baseline, /test ! -e "\$\{watchdog_marker\}"/u);
  assert.match(baseline, /is-enabled refunddesk-edge-window-watchdog\.timer/u);
  assert.match(arm, /remote_install_create_new "\$\{WATCHDOG_MARKER\}"/u);
  assert.match(arm, /flock --exclusive --timeout 10 9/u);
  assert.ok(
    arm.indexOf("flock --unlock 9") <
      arm.indexOf("systemctl start refunddesk-edge-window-watchdog.service"),
  );
  assert.ok(
    arm.indexOf("systemctl start refunddesk-edge-window-watchdog.service") <
      arm.indexOf('test -f "${receipt}"'),
  );
  assert.ok(
    arm.indexOf('test ! -e "${marker}"') < arm.indexOf('remote_install "${watchdog_source}"'),
  );
});

test(
  "watchdog marker publication recovers only its exact no-replace pending authority",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    const publisher = runner.match(
      /# REFUNDDESK_EDGE_REMOTE_MARKER_PUBLISH_PY_BEGIN\n([\s\S]*?)# REFUNDDESK_EDGE_REMOTE_MARKER_PUBLISH_PY_END/u,
    );
    assert.ok(publisher?.[1]);
    assert.match(publisher[1], /renameat2/u);
    assert.doesNotMatch(publisher[1], /os\.link/u);
    const hostContain = runner.slice(
      runner.indexOf("production_host_contain()"),
      runner.indexOf("production_watchdog_disarm()"),
    );
    assert.match(
      hostContain,
      /remote_install_create_new "\$\{WATCHDOG_MARKER\}"[^\n]+false \|\| \{\s*marker_publication_recovered=false/u,
    );
    const broadOnAmbiguity = hostContain.indexOf(
      'if test "${marker_publication_recovered}" != true; then\n  # An ambiguous create-new inode',
    );
    const workerContainment = hostContain.indexOf('contain_exact_container "${expected_worker}"');
    assert.ok(broadOnAmbiguity >= 0 && workerContainment > broadOnAmbiguity);
    const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-marker-publish-"));
    const destination = join(root, "edge-window-watchdog.json");
    const pending = join(root, ".edge-window-watchdog.json.pending");
    const legacy = join(root, ".edge-window-install.0123456789ABCDEF");
    const expected = Buffer.from(
      canonical({
        expectedRevision: "1".repeat(40),
        kind: "refunddesk.edge-window-watchdog",
        nonce: "2".repeat(64),
        schemaVersion: 1,
      }),
      "utf8",
    );
    const digest = createHash("sha256").update(expected).digest("hex");
    const invoke = (createMissing) =>
      spawnSync(
        "python3",
        ["-", destination, digest, expected.toString("base64"), String(createMissing)],
        { encoding: "utf8", input: publisher[1], timeout: 5000 },
      );
    try {
      const fresh = invoke(true);
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.deepEqual(readFileSync(destination), expected);
      assert.equal(statSync(destination).nlink, 1);
      assert.equal(existsSync(pending), false);

      rmSync(destination);
      writeFileSync(destination, expected, { mode: 0o600 });
      linkSync(destination, legacy);
      assert.equal(statSync(destination).nlink, 2);
      const legacyRepair = invoke(false);
      assert.equal(legacyRepair.status, 0, legacyRepair.stderr);
      assert.equal(existsSync(legacy), false);
      assert.equal(statSync(destination).nlink, 1);

      rmSync(destination);
      writeFileSync(pending, expected, { mode: 0o600 });
      const preRenameRecovery = invoke(false);
      assert.equal(preRenameRecovery.status, 0, preRenameRecovery.stderr);
      assert.deepEqual(readFileSync(destination), expected);
      assert.equal(existsSync(pending), false);
      assert.equal(statSync(destination).nlink, 1);

      rmSync(destination);
      writeFileSync(pending, '{"partial"', { mode: 0o600 });
      const partialRecovery = invoke(false);
      assert.equal(partialRecovery.status, 0, partialRecovery.stderr);
      assert.equal(existsSync(destination), false);
      assert.equal(existsSync(pending), false);

      writeFileSync(pending, canonical({ foreign: true }), { mode: 0o600 });
      const foreignPending = invoke(false);
      assert.notEqual(foreignPending.status, 0);
      assert.equal(existsSync(destination), false);
      assert.equal(existsSync(pending), true);

      rmSync(pending);
      writeFileSync(destination, expected, { mode: 0o600 });
      writeFileSync(legacy, expected, { mode: 0o600 });
      const differentInode = invoke(false);
      assert.notEqual(differentInode.status, 0);
      assert.equal(existsSync(destination), true);
      assert.equal(existsSync(legacy), true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

for (const scenario of [
  "cloudfront-prebind-default-route-drift",
  "cloudfront-prebind-ordered-route-drift",
  "cloudfront-prebind-edge-association",
  "cloudfront-prebind-custom-error-response",
  "cloudfront-prebind-continuous-deployment",
  "cloudfront-prebind-web-acl",
]) {
  test(
    `${scenario} is rejected on the exact pre-update ETag bytes without a host token or provider write`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario);
      try {
        assert.equal(run.result.status, 20, `${run.result.stderr}\n${run.result.stdout}`);
        const document = parseEvidence(run.result);
        assert.equal(document.result, "FAIL");
        assert.equal(document.code, "TOPOLOGY_BINDING_INVALID");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(state.hostTokenRewriteCount ?? 0, 0);
        assert.equal(state.originProviderUpdateCount ?? 0, 0);
        assert.equal(state.originUnbindCount ?? 0, 0);
        assert.equal(state.caddyRecreateCount ?? 0, 0);
        assert.equal(state.firewallOpen, false);
        assert.equal(state.operations.includes("firewall-open"), false);
        assert.equal(state.operations.includes("origin-bind"), true);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const [name, mutate] of [
  ["fixture mode drift", (control) => (control.provenance.fixtureOnly = false)],
  ["repository HEAD drift", (control) => (control.provenance.repositoryHead = "9".repeat(40))],
  ["sourcesExact downgrade", (control) => (control.provenance.sourcesExact = false)],
  [
    "source digest drift",
    (control) => {
      control.provenance.sources[0].sourceSha256 = "0".repeat(64);
      control.provenance.sources[0].indexSha256 = "0".repeat(64);
      control.provenance.sources[0].headSha256 = "0".repeat(64);
    },
  ],
]) {
  test(
    `${name} is rejected before every host, origin, and firewall effect`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { controlMutator: mutate });
      try {
        assert.equal(run.result.status, 20, run.result.stderr);
        assert.equal(run.result.stdout, "");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(state.operations, []);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "a resumed functional gate cannot complete after authorization and final-postflight expiry",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      crashPoint: "after_functional_gate",
      statePatch: {
        timestamps: [
          "2026-08-08T12:00:00Z",
          "2026-08-08T12:00:20Z",
          "2026-08-08T12:00:30Z",
          "2026-08-08T12:01:00Z",
          "2026-08-08T12:01:30Z",
          "2026-08-08T12:46:00Z",
        ],
      },
      timeout: 30000,
    });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const resumed = spawnSync(
        "bash",
        [
          runnerPath,
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 30000,
        },
      );
      assert.equal(resumed.status, 21, resumed.stderr);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.window.state, "failed_closed");
      validateFixtureEvidence(evidence, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.hostLeaseReleased, true);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a reboot after the monotonic close and before final postflight can never finalize PASS",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("reboot-before-final-postflight", { timeout: 30000 });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.window.state, "failed_closed");
      validateFixtureEvidence(evidence, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.rebootedAfterWindowClockStop, true);
      assert.equal(state.firewallOpen, false);
      assert.ok(state.operations.includes("host-contain"));
      assert.equal(state.operations.includes("final-postflight"), false);
      assert.equal(state.operations.includes("host-lease-complete"), true);
      assert.equal(state.hostLease, "complete");
      assert.equal(state.authorizationLease, "complete");
      assert.equal(state.hostLeaseReleased, true);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const scenario of ["reboot-after-final-postflight", "reboot-after-watchdog-disarm"]) {
  test(
    `${scenario} invalidates the terminal boot and can never consume the lease as PASS`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario, { timeout: 30000 });
      try {
        assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
        const evidence = parseEvidence(run.result);
        assert.equal(evidence.result, "INCOMPLETE");
        assert.equal(evidence.window.state, "failed_closed");
        validateFixtureEvidence(evidence, 21);
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(state.firewallOpen, false);
        assert.equal(state.caddyRunning, false);
        assert.equal(state.workerRunning, false);
        assert.equal(state.hostLease, "complete", JSON.stringify(state));
        assert.equal(state.authorizationLease, "complete");
        assert.equal(state.hostLeaseReleased, true);
        assert.equal(
          state.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.ok(state.operations.includes("window-boot-guard"));
        assert.equal(state.operations.includes("host-lease-release"), true);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "SIGTERM after the functional gate remains an incomplete failed-closed result, never PASS",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { signalPoint: "after_functional_gate", timeout: 30000 });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.code, "CONTROL_PLANE_UNAVAILABLE");
      assert.equal(evidence.window.state, "failed_closed");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(state.hostLeaseReleased, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a firewall-open effect with a lost acknowledgement preserves a conservative openedAt",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("firewall-open-lost-ack");
    try {
      assert.equal(run.result.status, 20, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "FAIL");
      assert.equal(evidence.code, "FIREWALL_OPEN_INVALID");
      assert.notEqual(evidence.window.openedAt, null);
      validateFixtureEvidence(evidence, 20);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const open = state.operations.indexOf("firewall-open");
      const close = state.operations.indexOf("firewall-close");
      assert.ok(open >= 0 && close > open);
      assert.equal(state.firewallOpen, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const crashPoint of [
  "after_evidence_embedded_before_publish",
  "after_evidence_publish_before_published_marker",
  "after_evidence_published_marker",
]) {
  for (const [scenario, expectedExit, expectedResult] of [
    ["pass", 0, "PASS"],
    ["counts-changed", 20, "FAIL"],
    ["close-ambiguous", 21, "INCOMPLETE"],
  ]) {
    test(
      `${scenario} terminal evidence replays exact bytes after ${crashPoint}`,
      { skip: !linuxContractAvailable },
      () => {
        const run = runScenario(scenario, { crashPoint, timeout: 40_000 });
        try {
          assert.equal(run.result.signal, "SIGKILL", `${run.result.stderr}\n${run.result.stdout}`);
          const markerPath = join(run.controlRoot, "edge-window-run.json");
          const markerBefore = JSON.parse(readFileSync(markerPath, "utf8"));
          assert.match(markerBefore.evidenceSha256, /^[0-9a-f]{64}$/u);
          assert.equal(typeof markerBefore.evidence, "object");
          const embedded = canonical(markerBefore.evidence);

          const resumed = resumeScenario(run, { mode: "run", timeout: 50_000 });
          assert.equal(resumed.status, expectedExit, `${resumed.stderr}\n${resumed.stdout}`);
          const evidence = parseEvidence(resumed);
          assert.equal(evidence.result, expectedResult);
          assert.equal(canonical(evidence), embedded);
          const markerAfter = JSON.parse(readFileSync(markerPath, "utf8"));
          assert.equal(markerAfter.evidencePublished, true);
          assert.equal(canonical(markerAfter.evidence), embedded);
          const state = JSON.parse(readFileSync(run.statePath, "utf8"));
          assert.ok(
            state.operations.filter((operation) => operation === "firewall-open").length <= 1,
          );
        } finally {
          cleanupScenario(run);
        }
      },
    );
  }
}

for (const journalFailure of ["missing", "digest-tampered", "directory-mode-tampered"]) {
  test(
    `an ${journalFailure} run journal after ingress returns only recovery-required 21`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_ingress_open" });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        const markerPath = join(run.controlRoot, "edge-window-run.json");
        const before = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(before.firewallOpen, true);
        if (journalFailure === "missing") {
          rmSync(markerPath);
        } else if (journalFailure === "directory-mode-tampered") {
          chmodSync(join(run.controlRoot, `edge-window-operation-${nonce}`), 0o777);
        } else {
          const marker = JSON.parse(readFileSync(markerPath, "utf8"));
          marker.factsSha256 = "0".repeat(64);
          writeFileSync(markerPath, canonical(marker), { mode: 0o600 });
        }
        const resumed = resumeScenario(run);
        assert.equal(resumed.status, 21, resumed.stderr);
        assert.equal(resumed.stdout, "");
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(after.operations, before.operations);
        assert.equal(after.firewallOpen, true);
        assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog.json")), true);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const inputFailure of [
  "control-missing",
  "control-corrupt",
  "transport-corrupt",
  "input-root-mode-drift",
  "control-mode-drift",
]) {
  test(
    `${inputFailure} after ingress is recovery-required 21, never fresh usage`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_ingress_open" });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        const before = JSON.parse(readFileSync(run.statePath, "utf8"));
        if (inputFailure === "control-missing") {
          rmSync(run.controlPath);
        } else if (inputFailure === "control-corrupt") {
          writeFileSync(run.controlPath, "{\n", { mode: 0o600 });
        } else if (inputFailure === "transport-corrupt") {
          writeFileSync(run.transportPath, "{\n", { mode: 0o600 });
        } else if (inputFailure === "input-root-mode-drift") {
          chmodSync(run.controlRoot, 0o777);
        } else {
          chmodSync(run.controlPath, 0o644);
        }

        const resumed = resumeScenario(run);
        assert.equal(resumed.status, 21, resumed.stderr);
        assert.equal(resumed.stdout, "");
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.deepEqual(after.operations, before.operations);
        assert.equal(after.firewallOpen, true);
        assert.equal(after.hostLeaseReleased ?? false, false);
        assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog.json")), true);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "source provenance drift after ingress enters cleanup-only recovery and never reopens",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const control = JSON.parse(readFileSync(run.controlPath, "utf8"));
      control.provenance.sources[0].headSha256 = "0".repeat(64);
      control.provenance.sources[0].indexSha256 = "0".repeat(64);
      control.provenance.sources[0].sourceSha256 = "0".repeat(64);
      writeFileSync(run.controlPath, canonical(control), { mode: 0o600 });
      chmodSync(run.controlPath, 0o600);

      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, resumed.stderr);
      assert.equal(resumed.stdout, "");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const open = state.operations.indexOf("firewall-open");
      const close = state.operations.indexOf("firewall-close");
      assert.ok(open >= 0 && close > open);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(state.firewallOpen, false);
      assert.equal(state.caddyRunning, false);
      assert.equal(state.workerRunning, false);
      assert.equal(state.watchdogArmed, false);
      assert.equal(state.hostLeaseReleased, true);
      assert.equal(state.operations.includes("final-postflight"), false);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [scenario, expectedExit] of [
  ["etag-race", 20],
  ["close-ambiguous", 21],
  ["pass", 0],
]) {
  test(
    `a ${scenario} terminal marker repairs substituted evidence and replays exact exit ${expectedExit}`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario, { timeout: 30_000 });
      try {
        assert.equal(run.result.status, expectedExit, run.result.stderr);
        const originalBytes = run.result.stdout;
        const operationRoot = join(run.controlRoot, `edge-window-operation-${nonce}`);
        const evidencePath = join(operationRoot, "evidence.json");
        const before = JSON.parse(readFileSync(run.statePath, "utf8"));
        writeFileSync(evidencePath, '{"substituted":true}\n', { mode: 0o600 });
        chmodSync(evidencePath, 0o600);
        run.environment.REFUNDDESK_EDGE_WINDOW_TEST_SUBSTITUTE_EVIDENCE_BEFORE_OUTPUT = "1";

        const replay = resumeScenario(run, { mode: "run", timeout: 30_000 });
        assert.equal(replay.status, expectedExit, replay.stderr);
        assert.equal(replay.stdout, originalBytes);
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(after.evidenceSubstitutedBeforeOutput, true);
        assert.deepEqual(
          after.operations.filter((operation) => operation !== "evidence-substitute-before-output"),
          before.operations,
        );
        if (expectedExit === 0) {
          validateFixtureEvidence(parseEvidence(replay), 0);
        }
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const [name, timestamps] of [
  [
    "rollback before open",
    [
      "2026-08-08T12:00:00Z",
      "2026-08-08T12:00:20Z",
      "2026-08-08T11:59:50Z",
      "2026-08-08T12:00:40Z",
      "2026-08-08T12:01:00Z",
      "2026-08-08T12:01:10Z",
    ],
  ],
  [
    "rollback before close",
    [
      "2026-08-08T12:00:00Z",
      "2026-08-08T12:00:20Z",
      "2026-08-08T12:00:30Z",
      "2026-08-08T12:01:00Z",
      "2026-08-08T12:00:25Z",
      "2026-08-08T12:01:10Z",
    ],
  ],
]) {
  test(
    `${name} is honestly recontained and never committed as PASS`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { statePatch: { timestamps }, timeout: 30000 });
      try {
        assert.equal(run.result.status, 21, run.result.stderr);
        const evidence = parseEvidence(run.result);
        assert.equal(evidence.result, "INCOMPLETE");
        assert.equal(evidence.window.state, "failed_closed");
        validateFixtureEvidence(evidence, 21);
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(state.firewallOpen, false);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "close ambiguity is explicit and can never become PASS",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("close-ambiguous");
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      const document = parseEvidence(run.result);
      assert.equal(document.result, "INCOMPLETE");
      assert.equal(document.code, "FIREWALL_CLOSE_AMBIGUOUS");
      assert.equal(document.firewall.closeAmbiguous, true);
      assert.equal(document.firewall.finalClosed, false);
      assert.equal(document.window.closedAt, null);
      assert.equal(document.watchdog.disarmed, false);
      assert.equal(document.watchdog.markerComplete, false);
      assert.equal(document.containment.watchdogDisarmed, false);
      assert.equal(document.containment.markerComplete, false);
      validateFixtureEvidence(document, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.notEqual(state.hostLeaseReleased, true);
      assert.notEqual(state.watchdogDisarmed, true);
      assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog.json")), true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "an exact closed readback after a lost close proof still completes cleanup as INCOMPLETE",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("firewall-close-proof-ambiguous-safe", { timeout: 30_000 });
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      const document = parseEvidence(run.result);
      assert.equal(document.result, "INCOMPLETE");
      assert.equal(document.code, "FIREWALL_CLOSE_AMBIGUOUS");
      assert.equal(document.firewall.finalClosed, true);
      assert.equal(document.firewall.closeAmbiguous, true);
      assert.equal(document.containment.awsIngressClosed, true);
      validateFixtureEvidence(document, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.firewallOpen, false);
      assert.equal(state.originBound, false);
      assert.equal(state.hostLeaseReleased, true);
      assert.equal(state.watchdogDisarmed, true);
      assert.ok(state.operations.includes("origin-gc"));
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a raced Workbench CreateNew checkpoint fails incomplete and cannot reopen",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("checkpoint-race");
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      const document = parseEvidence(run.result);
      assert.equal(document.result, "INCOMPLETE");
      assert.equal(document.code, "TOOL_UNAVAILABLE");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.ok(
        state.operations.indexOf("firewall-close") < state.operations.indexOf("host-contain"),
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a completed nonce is consumed and a rerun performs no operation or second open",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass");
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const before = JSON.parse(readFileSync(run.statePath, "utf8"));
      const rerun = spawnSync(
        "bash",
        [
          runnerPath,
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        { encoding: "utf8", env: run.environment, timeout: 30_000 },
      );
      assert.equal(rerun.status, 0, rerun.stderr);
      assert.equal(parseEvidence(rerun).code, "PASS_EDGE_WINDOW_RECONTAINED");
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.deepEqual(after.operations, before.operations);
      assert.equal(after.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "close ambiguity retains a contained watchdog that re-fences a later Caddy restart",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("close-ambiguous");
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
      assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).state, "contained");
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.caddyRestart = "always";
      state.caddyRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: false, udp443: false };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: run.environment,
        timeout: 10000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.caddyRestart, "no");
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog fences stopped restart-always containers and an activating release fence unit",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const releaseUnit = "refunddesk-release-fence-abcdef123456-42.service";
      state.caddyRunning = false;
      state.caddyRestart = "always";
      state.listeners = { tcp80: false, tcp443: false, udp80: false, udp443: false };
      state.releaseUnits = [releaseUnit];
      state.unitStates = { [releaseUnit]: "activating" };
      state.unitEnabled = {
        "refunddesk-backup.timer": "enabled",
        "refunddesk-retention.timer": "enabled",
      };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(tick.status, 0, `${tick.stderr}\n${readFileSync(run.statePath, "utf8")}`);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRestart, "no");
      assert.equal(after.unitStates[releaseUnit], "inactive");
      assert.equal(after.unitEnabled["refunddesk-backup.timer"], "disabled");
      assert.equal(after.unitEnabled["refunddesk-retention.timer"], "disabled");
      assert.deepEqual(after.releaseUnits, []);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog bulk-stops release surfaces even when their inventory fails",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const releaseUnit = "refunddesk-release-fence-abcdef123456-43.service";
      state.scenario = "watchdog-release-list-fail";
      state.releaseUnits = [releaseUnit];
      state.unitStates = { [releaseUnit]: "active" };
      state.caddyRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: false, udp443: false };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath, "--force", nonce], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(after.operations.includes("watchdog:stop-release-surface"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.releaseUnits, []);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog remains independently executable and attempts every non-Docker barrier when Docker fails",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-docker-unavailable";
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.unknownDockerScopeRunning = true;
      state.dockerProxyRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: false, udp443: false };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 25_000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(Date.now() - started < 25_000);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(
        after.operations.includes("watchdog:disable-unit:refunddesk-backup.timer"),
        JSON.stringify(after),
      );
      assert.ok(after.operations.includes("watchdog:disable-unit:refunddesk-retention.timer"));
      assert.ok(after.operations.includes("watchdog:stop-unit:refunddesk-retention.service"));
      assert.ok(after.operations.includes("watchdog:scope-kill:c"), JSON.stringify(after));
      assert.ok(after.operations.includes("watchdog:scope-kill:3"), JSON.stringify(after));
      assert.ok(after.operations.includes("watchdog:docker-socket-stopped"), JSON.stringify(after));
      assert.ok(
        after.operations.includes("watchdog:all-container-scopes-killed"),
        JSON.stringify(after),
      );
      assert.ok(after.operations.includes("watchdog:docker-daemon-killed"), JSON.stringify(after));
      assert.ok(
        after.operations.indexOf("watchdog:docker-socket-stopped") <
          after.operations.indexOf("watchdog:all-container-scopes-killed") &&
          after.operations.indexOf("watchdog:all-container-scopes-killed") <
            after.operations.indexOf("watchdog:docker-daemon-killed"),
      );
      assert.equal(
        after.operations.some((operation) => operation.startsWith("watchdog:docker-unavailable")),
        false,
      );
      assert.equal(
        after.operations.filter((operation) => operation.startsWith("watchdog:listener-check:"))
          .length,
        8,
      );
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.equal(after.unknownDockerScopeRunning, false);
      assert.equal(after.dockerProxyRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [scenario, listenersClosed] of [
  ["watchdog-listener-drift", true],
  ["watchdog-listener-persists", false],
]) {
  test(
    `${scenario} broad-fences Docker and repeats every public-listener readback`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_ingress_open" });
      try {
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        state.scenario = scenario;
        state.caddyRunning = false;
        state.workerRunning = false;
        state.caddyRestart = "no";
        state.workerRestart = "no";
        state.listeners = { tcp80: false, tcp443: true, udp80: false, udp443: false };
        writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
        const tick = spawnSync("bash", [watchdogPath, "--force", nonce], {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 15_000,
        });
        assert.equal(tick.status, 20, tick.stderr);
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.ok(after.operations.includes("watchdog:all-container-scopes-killed"));
        assert.ok(after.operations.includes("watchdog:docker-daemon-killed"));
        assert.equal(
          after.operations.filter((operation) => operation.startsWith("watchdog:listener-check:"))
            .length,
          listenersClosed ? 8 : 12,
        );
        assert.equal(after.listeners.tcp443, !listenersClosed);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "an asynchronous watchdog transition before Caddy start is monotone and opens no ingress",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_watchdog_armed" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.bootId = marker.bootId;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 20_000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      const contained = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(contained.state, "contained");
      assert.equal(contained.triggered, true);

      const resumed = resumeScenario(run, { mode: "run", timeout: 40_000 });
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.operations.includes("firewall-open"), false);
      assert.equal(after.caddyRunning, false);
      assert.equal(after.firewallOpen, false);
      assert.equal(after.hostLeaseReleased, true);
      assert.doesNotMatch(resumed.stdout, /"result":"PASS"/u);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a concurrent watchdog containment during the AWS open call is reclosed and never passes",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("watchdog-contained-during-firewall-open", { timeout: 40_000 });
    try {
      assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(state.firewallOpen, false);
      assert.equal(state.watchdogDisarmed, true);
      assert.equal(state.hostLeaseReleased, true);
      assert.doesNotMatch(run.result.stdout, /"result":"PASS"/u);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "the final inert Caddy identity is transferred atomically before a contained watchdog tick",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("watchdog-final-caddy-tick", {
      crashPoint: "after_origin_unbound",
      timeout: 40_000,
    });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
      const receiptPath = join(run.controlRoot, "edge-window-watchdog-preflight.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(marker.state, "contained");
      assert.equal(marker.triggered, false);
      assert.equal(marker.caddyContainerId, "d".repeat(64));
      assert.equal(receipt.caddyContainerId, marker.caddyContainerId);
      assert.equal(
        receipt.markerSha256,
        createHash("sha256").update(readFileSync(markerPath)).digest("hex"),
      );

      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "pass";
      state.nowEpoch = marker.deadlineEpoch - 60;
      state.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 2000;
      state.bootId = marker.bootId;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15_000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      const afterTick = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(afterTick.operations.includes("watchdog:fence:d"), JSON.stringify(afterTick));
      assert.equal(afterTick.operations.includes("watchdog:all-container-scopes-killed"), false);
      assert.equal(afterTick.operations.includes("watchdog:docker-daemon-killed"), false);

      const resumed = resumeScenario(run, { mode: "cleanup", timeout: 40_000 });
      assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "PASS");
      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(finalState.hostLeaseReleased, true);
      assert.equal(
        finalState.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog fences a UDP listener before a slow worker can spend the deadline reserve",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-listener-before-slow-worker";
      state.caddyRunning = false;
      state.workerRunning = false;
      state.caddyRestart = "no";
      state.workerRestart = "no";
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.listeners = { tcp80: false, tcp443: false, udp80: false, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath, "--force", nonce], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15_000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(Date.now() - started < 15_000);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      const daemonFence = after.operations.indexOf("watchdog:docker-daemon-killed");
      const slowWorker = after.operations.indexOf("watchdog:slow-worker-after-listener-fence");
      assert.ok(daemonFence >= 0 && slowWorker === -1, JSON.stringify(after));
      assert.ok(
        after.dockerDaemonKilledAtBoottimeMilliseconds <= marker.deadlineBoottimeMilliseconds,
      );
      assert.equal(after.listeners.udp443, false);
      const watchdog = readFileSync(watchdogPath, "utf8");
      const runner = readFileSync(runnerPath, "utf8");
      assert.match(watchdog, /listener\).*head --bytes=1/u);
      assert.match(runner, /ss -H -ltn.*\| head --bytes=1/u);
      assert.match(runner, /ss -H -lun.*\| head --bytes=1/u);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const markerFailure of ["missing", "malformed"]) {
  test(
    `watchdog recovers exact scope identities from its receipt when the marker is ${markerFailure} and Docker is unavailable`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_ingress_open" });
      try {
        const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        const preflightState = JSON.parse(readFileSync(run.statePath, "utf8"));
        preflightState.scenario = "pass";
        preflightState.nowEpoch = marker.deadlineEpoch - 60;
        preflightState.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
        writeFileSync(run.statePath, canonical(preflightState), { mode: 0o600 });
        const preflightTick = spawnSync("bash", [watchdogPath], {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 10_000,
        });
        assert.equal(preflightTick.status, 0, preflightTick.stderr);
        const receipt = JSON.parse(
          readFileSync(join(run.controlRoot, "edge-window-watchdog-preflight.json"), "utf8"),
        );
        assert.equal(receipt.caddyContainerId, "c".repeat(64));
        assert.equal(receipt.workerContainerId, "3".repeat(64));
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        state.scenario = "watchdog-docker-unavailable";
        state.nowEpoch = marker.deadlineEpoch - 1;
        state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
        state.caddyRunning = true;
        state.workerRunning = true;
        state.unknownDockerScopeRunning = true;
        state.dockerProxyRunning = true;
        state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
        writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
        if (markerFailure === "missing") {
          rmSync(markerPath);
        } else {
          writeFileSync(
            markerPath,
            canonical({
              caddyContainerId: "f".repeat(64),
              state: "malformed",
              workerContainerId: "e".repeat(64),
            }),
            { mode: 0o600 },
          );
          chmodSync(markerPath, 0o600);
        }
        const started = Date.now();
        const tick = spawnSync("bash", [watchdogPath], {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 25_000,
        });
        assert.equal(tick.status, 20, tick.stderr);
        assert.ok(Date.now() - started < 25_000);
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.ok(after.operations.includes("watchdog:scope-kill:c"), JSON.stringify(after));
        assert.ok(after.operations.includes("watchdog:scope-kill:3"), JSON.stringify(after));
        assert.ok(
          after.operations.includes("watchdog:all-container-scopes-killed"),
          JSON.stringify(after),
        );
        assert.equal(after.operations.includes("watchdog:scope-kill:f"), false);
        assert.equal(after.operations.includes("watchdog:scope-kill:e"), false);
        assert.ok(
          after.operations.includes("watchdog:docker-daemon-killed"),
          JSON.stringify(after),
        );
        assert.equal(after.caddyRunning, false);
        assert.equal(after.workerRunning, false);
        assert.equal(after.unknownDockerScopeRunning, false);
        assert.equal(after.dockerProxyRunning, false);
        assert.deepEqual(after.listeners, {
          tcp80: false,
          tcp443: false,
          udp80: false,
          udp443: false,
        });
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "watchdog fences every Docker scope when both identity documents are invalid and Docker is unavailable",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
      const receiptPath = join(run.controlRoot, "edge-window-watchdog-preflight.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const preflightState = JSON.parse(readFileSync(run.statePath, "utf8"));
      preflightState.scenario = "pass";
      preflightState.nowEpoch = marker.deadlineEpoch - 60;
      preflightState.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
      writeFileSync(run.statePath, canonical(preflightState), { mode: 0o600 });
      const preflightTick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(preflightTick.status, 0, preflightTick.stderr);
      writeFileSync(
        markerPath,
        canonical({
          caddyContainerId: "f".repeat(64),
          state: "malformed",
          workerContainerId: "e".repeat(64),
        }),
        { mode: 0o600 },
      );
      writeFileSync(receiptPath, canonical({ kind: "malformed-receipt" }), { mode: 0o600 });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-docker-unavailable";
      state.caddyRunning = true;
      state.workerRunning = true;
      state.unknownDockerScopeRunning = true;
      state.dockerProxyRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 25_000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(
        after.operations.includes("watchdog:all-container-scopes-killed"),
        JSON.stringify(after),
      );
      assert.ok(after.operations.includes("watchdog:docker-daemon-killed"));
      assert.equal(after.operations.includes("watchdog:scope-kill:f"), false);
      assert.equal(after.operations.includes("watchdog:scope-kill:e"), false);
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.equal(after.unknownDockerScopeRunning, false);
      assert.equal(after.dockerProxyRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog kills a TERM-ignoring stop helper and still attempts every later fence",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-ignore-term";
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath, "--force", nonce], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(Date.now() - started < 10000);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(after.operations.some((operation) => operation.startsWith("watchdog:fence:c")));
      assert.ok(after.operations.some((operation) => operation.startsWith("watchdog:fence:3")));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a force containment cannot report success while the timer owns the watchdog lock",
  { skip: !linuxContractAvailable },
  async () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    const readyPath = join(run.runtimeRoot, "lock-ready");
    const lockPath = join(run.runtimeRoot, "edge-window-watchdog.lock");
    const holder = spawn(
      "bash",
      ["-c", 'exec 8>"$1"; flock --exclusive 8; : >"$2"; sleep 5', "_", lockPath, readyPath],
      { env: run.environment, stdio: "ignore" },
    );
    try {
      const ready = spawnSync(
        "bash",
        [
          "-c",
          'for _ in $(seq 1 50); do test -e "$1" && exit 0; sleep .05; done; exit 1',
          "_",
          readyPath,
        ],
        { encoding: "utf8", env: run.environment, timeout: 5000 },
      );
      assert.equal(ready.status, 0, ready.stderr);
      const forced = spawnSync("bash", [watchdogPath, "--force", nonce], {
        encoding: "utf8",
        env: {
          ...run.environment,
          REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "",
          REFUNDDESK_EDGE_WINDOW_TEST_LOCK_WAIT_SECONDS: "1",
        },
        timeout: 5000,
      });
      assert.equal(forced.status, 21, forced.stderr);
    } finally {
      holder.kill("SIGTERM");
      cleanupScenario(run);
    }
  },
);

test(
  "a contended scheduled tick cannot count as the synchronous pre-ingress heartbeat",
  { skip: !linuxContractAvailable },
  async () => {
    const run = runScenario("pass", { crashPoint: "after_watchdog_marker_written" });
    const readyPath = join(run.runtimeRoot, "heartbeat-lock-ready");
    const lockPath = join(run.runtimeRoot, "edge-window-watchdog.lock");
    const receiptPath = join(run.controlRoot, "edge-window-watchdog-preflight.json");
    const holder = spawn(
      "bash",
      ["-c", 'exec 8>"$1"; flock --exclusive 8; : >"$2"; sleep 30', "_", lockPath, readyPath],
      { env: run.environment, stdio: "ignore" },
    );
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.nowEpoch = marker.deadlineEpoch - 120;
      state.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
      state.bootId = marker.bootId;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const ready = spawnSync(
        "bash",
        [
          "-c",
          'for _ in $(seq 1 50); do test -e "$1" && exit 0; sleep .05; done; exit 1',
          "_",
          readyPath,
        ],
        { encoding: "utf8", env: run.environment, timeout: 5000 },
      );
      assert.equal(ready.status, 0, ready.stderr);
      const collided = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 5000,
      });
      assert.equal(collided.status, 0, collided.stderr);
      assert.equal(existsSync(receiptPath), false);
      holder.kill("SIGTERM");
      await new Promise((resolveClose) => holder.once("close", resolveClose));
      const realTick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 5000,
      });
      assert.equal(realTick.status, 0, realTick.stderr);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(receipt.kind, "refunddesk.edge-window-watchdog-preflight");
      assert.equal(receipt.nonce, nonce);
      assert.equal(receipt.expectedRevision, revision);
      assert.match(receipt.markerSha256, /^[0-9a-f]{64}$/u);
      assert.match(receipt.bootIdSha256, /^[0-9a-f]{64}$/u);
      assert.equal(receipt.observedBoottimeMilliseconds, state.boottimeMilliseconds);
    } finally {
      holder.kill("SIGKILL");
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog receipt publication recovers only its exact durable pending inode",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_watchdog_armed" });
    const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
    const receiptPath = join(run.controlRoot, "edge-window-watchdog-preflight.json");
    const pendingPath = join(run.controlRoot, ".edge-window-watchdog-preflight.crash-boundary");
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "pass";
      state.nowEpoch = marker.deadlineEpoch - 120;
      state.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
      state.bootId = marker.bootId;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const initial = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(initial.status, 0, initial.stderr);
      assert.equal(statSync(receiptPath).nlink, 1);

      // Power loss after the pending entry is fsynced but before RENAME_NOREPLACE.
      renameSync(receiptPath, pendingPath);
      state.nowEpoch += 1;
      state.boottimeMilliseconds += 1000;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const pendingRecovery = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(pendingRecovery.status, 0, pendingRecovery.stderr);
      assert.equal(existsSync(pendingPath), false);
      assert.equal(statSync(receiptPath).nlink, 1);

      // A killed writer can leave a private partial pending before the first
      // RENAME_NOREPLACE. It was never authoritative and is discarded before
      // the exact marker-bound receipt is rebuilt.
      rmSync(receiptPath);
      writeFileSync(pendingPath, '{"kind":', { mode: 0o600 });
      chmodSync(pendingPath, 0o600);
      state.nowEpoch += 1;
      state.boottimeMilliseconds += 1000;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const partialRecovery = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(partialRecovery.status, 0, partialRecovery.stderr);
      assert.equal(existsSync(pendingPath), false);
      assert.equal(statSync(receiptPath).nlink, 1);

      // Repair the legacy link-before-unlink crash shape only when both names
      // are the same private inode; this cannot adopt unrelated bytes.
      linkSync(receiptPath, pendingPath);
      assert.equal(statSync(receiptPath).nlink, 2);
      assert.equal(statSync(pendingPath).ino, statSync(receiptPath).ino);
      state.nowEpoch += 1;
      state.boottimeMilliseconds += 1000;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const legacyRecovery = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(legacyRecovery.status, 0, legacyRecovery.stderr);
      assert.equal(existsSync(pendingPath), false);
      assert.equal(statSync(receiptPath).nlink, 1);

      copyFileSync(receiptPath, pendingPath);
      chmodSync(pendingPath, 0o600);
      state.nowEpoch += 1;
      state.boottimeMilliseconds += 1000;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const unrelatedPending = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(unrelatedPending.status, 21, unrelatedPending.stderr);
      const contained = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(contained.state, "contained");
      assert.equal(contained.triggered, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "the watchdog permits only the bounded Caddy starting handoff and contains it after its mini-deadline",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_watchdog_armed" });
    const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "pass";
      state.nowEpoch = marker.deadlineEpoch - 120;
      state.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
      state.bootId = marker.bootId;
      marker.state = "starting";
      marker.startDeadlineBoottimeMilliseconds = state.boottimeMilliseconds + 5000;
      writeFileSync(markerPath, canonical(marker), { mode: 0o600 });
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const handoffTick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(handoffTick.status, 0, handoffTick.stderr);
      const stillStarting = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(stillStarting.state, "starting");
      assert.equal(stillStarting.triggered, false);

      state.boottimeMilliseconds = marker.startDeadlineBoottimeMilliseconds;
      state.caddyRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: false, udp443: false };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const expiredTick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15_000,
      });
      assert.equal(expiredTick.status, 0, expiredTick.stderr);
      const contained = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(contained.state, "contained");
      assert.equal(contained.startDeadlineBoottimeMilliseconds, null);
      assert.equal(contained.triggered, true);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.listeners.tcp80, false);
      assert.equal(after.listeners.tcp443, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a forced watchdog with no marker still contains every host surface and fails closed",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      rmSync(join(run.controlRoot, "edge-window-watchdog.json"), { force: true });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const forced = spawnSync("bash", [watchdogPath, "--force", nonce], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(forced.status, 20, forced.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a scheduled watchdog with a missing marker still contains every host surface and fails closed",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      rmSync(join(run.controlRoot, "edge-window-watchdog.json"), { force: true });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a blocked trigger sentinel sync cannot delay missing-marker public containment",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      rmSync(join(run.controlRoot, "edge-window-watchdog.json"), { force: true });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-trigger-sync-hang";
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      const operationOffset = state.operations.length;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const startedAt = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      const elapsedMilliseconds = Date.now() - startedAt;
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(elapsedMilliseconds < 8000, `watchdog took ${elapsedMilliseconds}ms`);

      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
      const operations = after.operations.slice(operationOffset);
      const caddyFence = operations.indexOf("watchdog:scope-kill:c");
      const listenerReadback = operations.indexOf("watchdog:public-listeners");
      const workerFence = operations.indexOf("watchdog:scope-kill:3");
      const blockedSync = operations.indexOf("watchdog:trigger-sync-term-ignored");
      assert.ok(
        caddyFence >= 0 &&
          caddyFence < listenerReadback &&
          listenerReadback < workerFence &&
          workerFence < blockedSync,
        operations.join("\n"),
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "an effective systemd drop-in drift is contained and can never count as a watchdog tick",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-effective-unit-drift";
      state.nowEpoch = marker.deadlineEpoch - 120;
      state.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(tick.status, 21, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(after.operations.includes("watchdog:unit-contract-drift"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a near-deadline tick contains Caddy before a TERM-ignoring effective-unit probe",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-effective-unit-hang";
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10_000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      assert.ok(Date.now() - started < 9000);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.operations.includes("watchdog:unit-contract-hang"), false);
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a bounded receipt publication failure hard-fences every live surface before the deadline",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_watchdog_armed" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      rmSync(join(run.controlRoot, "edge-window-watchdog-preflight.json"), { force: true });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.nowEpoch = marker.deadlineEpoch - 26;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 26_000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      const operationOffset = state.operations.length;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: {
          ...run.environment,
          REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "",
          REFUNDDESK_EDGE_WINDOW_TEST_RECEIPT_PUBLISH_HANG: "1",
        },
        timeout: 15_000,
      });
      const elapsed = Date.now() - started;
      assert.equal(tick.status, 21, tick.stderr);
      assert.ok(elapsed < 12_000, `receipt failure containment took ${elapsed}ms`);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operations = after.operations.slice(operationOffset);
      const receiptTimeout = operations.indexOf("watchdog:receipt-publish-term-ignored");
      const caddyFence = operations.indexOf("watchdog:scope-kill:c");
      const firstRead = operations.indexOf("watchdog:public-listeners");
      const workerFence = operations.indexOf("watchdog:scope-kill:3");
      assert.ok(
        receiptTimeout >= 0 &&
          receiptTimeout < caddyFence &&
          caddyFence < firstRead &&
          firstRead < workerFence,
        operations.join("\n"),
      );
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
      const contained = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      assert.equal(contained.state, "contained");
      assert.equal(contained.triggered, true);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a running marker with a missing receipt contains immediately without attempting republication",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      rmSync(join(run.controlRoot, "edge-window-watchdog-preflight.json"), { force: true });
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.nowEpoch = marker.deadlineEpoch - 26;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 26_000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      const operationOffset = state.operations.length;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: {
          ...run.environment,
          REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "",
          REFUNDDESK_EDGE_WINDOW_TEST_RECEIPT_PUBLISH_HANG: "1",
        },
        timeout: 15_000,
      });
      assert.equal(tick.status, 21, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operations = after.operations.slice(operationOffset);
      assert.equal(
        operations.some((operation) => operation.startsWith("watchdog:receipt-publish")),
        false,
        operations.join("\n"),
      );
      assert.ok(operations.indexOf("watchdog:scope-kill:c") >= 0, operations.join("\n"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "the deadline hard fence closes public listeners inside the guard despite TERM-ignoring helpers",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-deadline-hard-fence-budget";
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 25_000,
      });
      const elapsed = Date.now() - started;
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(elapsed < 24_000, `deadline hard fence took ${elapsed}ms`);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operations = after.operations;
      const exactScope = operations.indexOf("watchdog:deadline-scope-timeout:c");
      const firstRead = operations.indexOf("watchdog:public-listeners");
      const socketFence = operations.indexOf("watchdog:docker-socket-stopped");
      const broad = operations.indexOf("watchdog:all-container-scopes-killed");
      const daemon = operations.indexOf("watchdog:docker-daemon-killed");
      const secondRead = operations.indexOf("watchdog:public-listeners", firstRead + 1);
      const firstWorkerOperation = operations.findIndex(
        (operation) =>
          operation.includes(":3") ||
          operation.includes("refunddesk-backup") ||
          operation.includes("refunddesk-retention"),
      );
      assert.ok(exactScope >= 0);
      assert.ok(firstRead > exactScope);
      assert.ok(socketFence > firstRead);
      assert.ok(broad > socketFence);
      assert.ok(daemon > broad);
      assert.ok(secondRead > daemon);
      assert.ok(firstWorkerOperation === -1 || firstWorkerOperation > secondRead);
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "invalid marker and receipt authorities execute one bounded broad deadline fence",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operationOffset = state.operations.length;
      state.scenario = "watchdog-deadline-hard-fence-budget";
      state.caddyRunning = true;
      state.workerRunning = true;
      state.dockerSocketActive = true;
      state.dockerDaemonActive = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      writeFileSync(join(run.controlRoot, "edge-window-watchdog.json"), '{"invalid":true}\n', {
        mode: 0o600,
      });
      writeFileSync(
        join(run.controlRoot, "edge-window-watchdog-preflight.json"),
        '{"invalid":true}\n',
        { mode: 0o600 },
      );

      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15_000,
      });
      const elapsed = Date.now() - started;
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(elapsed < 12_000, `invalid-authority hard fence took ${elapsed}ms`);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operations = after.operations.slice(operationOffset);
      assert.equal(
        operations.filter((operation) => operation === "watchdog:docker-socket-stopped").length,
        1,
        operations.join("\n"),
      );
      assert.equal(
        operations.filter((operation) => operation === "watchdog:all-container-scopes-killed")
          .length,
        1,
        operations.join("\n"),
      );
      assert.equal(
        operations.filter((operation) => operation === "watchdog:docker-daemon-killed").length,
        1,
        operations.join("\n"),
      );
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a blocked worker scope triggers the monotone Docker socket fence inside the deadline guard",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-worker-hard-fence-budget";
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.dockerSocketActive = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 25_000,
      });
      const elapsed = Date.now() - started;
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(elapsed < 24_000, `worker hard fence took ${elapsed}ms`);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operations = after.operations;
      const caddy = operations.indexOf("watchdog:scope-kill:c");
      const firstRead = operations.indexOf("watchdog:public-listeners");
      const workerTimeout = operations.indexOf("watchdog:deadline-worker-scope-timeout:3");
      const socketFence = operations.indexOf("watchdog:docker-socket-stopped");
      const broad = operations.indexOf("watchdog:all-container-scopes-killed");
      const daemon = operations.indexOf("watchdog:docker-daemon-killed");
      const secondRead = operations.indexOf("watchdog:public-listeners", firstRead + 1);
      assert.ok(caddy >= 0 && firstRead > caddy);
      assert.ok(workerTimeout > firstRead);
      assert.ok(socketFence > workerTimeout);
      assert.ok(broad > socketFence);
      assert.ok(daemon > broad);
      assert.ok(secondRead > daemon);
      assert.equal(
        operations.some((operation) => operation.startsWith("watchdog:docker-api-after-socket:")),
        false,
      );
      assert.equal(after.dockerSocketActive, false);
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a contained tick refreshes its receipt without reactivating Docker after a broad fence",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
      const markerRaw = readFileSync(markerPath);
      const marker = JSON.parse(markerRaw.toString("utf8"));
      const initialReceipt = {
        bootIdSha256: sha256Text(marker.bootId),
        caddyContainerId: marker.caddyContainerId,
        expectedRevision: marker.expectedRevision,
        kind: "refunddesk.edge-window-watchdog-preflight",
        markerSha256: sha256Bytes(markerRaw),
        nonce: marker.nonce,
        observedAtEpoch: marker.deadlineEpoch - 60,
        observedBoottimeMilliseconds: marker.armedBoottimeMilliseconds + 1000,
        schemaVersion: 1,
        workerContainerId: marker.workerContainerId,
      };
      writeFileSync(
        join(run.controlRoot, "edge-window-watchdog-preflight.json"),
        canonical(initialReceipt),
        { mode: 0o600 },
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-docker-unavailable";
      state.caddyRunning = true;
      state.workerRunning = true;
      state.dockerSocketActive = true;
      state.dockerSocketMasked = false;
      state.dockerDaemonActive = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });

      const broadTick = spawnSync("bash", [watchdogPath, "--force", nonce], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15_000,
      });
      assert.equal(broadTick.status, 20, broadTick.stderr);
      const afterBroad = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(afterBroad.dockerSocketActive, false);
      assert.equal(afterBroad.dockerSocketMasked, true);
      assert.equal(afterBroad.dockerDaemonActive, false);

      afterBroad.scenario = "watchdog-contained-after-broad-fence";
      const operationOffset = afterBroad.operations.length;
      writeFileSync(run.statePath, canonical(afterBroad), { mode: 0o600 });
      const containedTick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 15_000,
      });
      assert.equal(containedTick.status, 0, containedTick.stderr);

      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      const operations = finalState.operations.slice(operationOffset);
      assert.equal(
        operations.some((operation) => operation.startsWith("watchdog:docker-api-after-socket:")),
        false,
        operations.join("\n"),
      );
      assert.equal(finalState.dockerSocketActive, false);
      assert.equal(finalState.dockerSocketMasked, true);
      assert.equal(finalState.dockerDaemonActive, false);
      assert.equal(finalState.caddyRunning, false);
      assert.equal(finalState.workerRunning, false);
      assert.deepEqual(finalState.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
      const receipt = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog-preflight.json"), "utf8"),
      );
      assert.equal(
        receipt.markerSha256,
        createHash("sha256").update(readFileSync(markerPath)).digest("hex"),
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "duplicate Caddy inventory is fenced and stopped as one bounded group before the deadline",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-duplicate-caddy";
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 25_000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(Date.now() - started < 25_000);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(after.operations.includes("watchdog:fence:c"));
      assert.ok(after.operations.includes("watchdog:fence:e"));
      assert.equal(after.operations.includes("watchdog:bulk-stop-term-ignored"), false);
      assert.ok(after.operations.includes("watchdog:docker-socket-stopped"));
      assert.ok(after.operations.includes("watchdog:all-container-scopes-killed"));
      assert.ok(after.operations.includes("watchdog:docker-daemon-killed"));
      assert.ok(
        after.operations.indexOf("watchdog:docker-socket-stopped") <
          after.operations.indexOf("watchdog:all-container-scopes-killed") &&
          after.operations.indexOf("watchdog:all-container-scopes-killed") <
            after.operations.indexOf("watchdog:docker-daemon-killed"),
      );
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "an oversized Docker inventory skips drift IDs and immediately uses the exact scope and daemon fences",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.scenario = "watchdog-container-inventory-overflow";
      state.nowEpoch = marker.deadlineEpoch - 1;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds - 1000;
      state.caddyRunning = true;
      state.workerRunning = true;
      state.dockerProxyRunning = true;
      state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const started = Date.now();
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 25_000,
      });
      assert.equal(tick.status, 20, tick.stderr);
      assert.ok(Date.now() - started < 25_000);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(after.operations.includes("watchdog:container-inventory-overflow"));
      assert.equal(after.operations.includes("watchdog:fence:a"), false);
      assert.equal(after.operations.includes("watchdog:stop:a"), false);
      assert.ok(after.operations.includes("watchdog:scope-kill:c"), JSON.stringify(after));
      assert.ok(after.operations.includes("watchdog:docker-daemon-killed"), JSON.stringify(after));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.dockerProxyRunning, false);
      assert.deepEqual(after.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const clockScenario of [
  "watchdog-clock-error-now",
  "watchdog-clock-malformed-now",
  "watchdog-clock-error-boot",
  "watchdog-clock-error-boottime",
]) {
  test(
    `watchdog ${clockScenario} contains before returning incomplete`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_ingress_open" });
      try {
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        state.scenario = clockScenario;
        state.caddyRunning = true;
        state.workerRunning = true;
        state.listeners = { tcp80: true, tcp443: true, udp80: true, udp443: true };
        writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
        const tick = spawnSync("bash", [watchdogPath], {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 10000,
        });
        assert.equal(tick.status, 21, tick.stderr);
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(after.caddyRunning, false);
        assert.equal(after.workerRunning, false);
        assert.deepEqual(after.listeners, {
          tcp80: false,
          tcp443: false,
          udp80: false,
          udp443: false,
        });
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "runner SIGKILL at ingress leaves deadline watchdog independent and cleanup starts with AWS close",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(run.result.signal, "SIGKILL");
      const stateAfterCrash = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(stateAfterCrash.firewallOpen, true);
      assert.equal(stateAfterCrash.watchdogArmed, true);

      const watchdogResult = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(watchdogResult.status, 0, watchdogResult.stderr);
      const afterWatchdog = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(afterWatchdog.caddyRunning, false);
      assert.equal(afterWatchdog.workerRunning, false);
      const watchdogMarker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      assert.equal(watchdogMarker.state, "contained");

      const operationsBeforeCleanup = afterWatchdog.operations.length;
      const cleanup = spawnSync(
        "bash",
        [
          runnerPath,
          "--mode",
          "cleanup",
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        { encoding: "utf8", env: run.environment, timeout: 30_000 },
      );
      assert.equal(cleanup.status, 21, cleanup.stderr);
      const afterCleanup = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(afterCleanup.operations[operationsBeforeCleanup], "firewall-close");
      assert.equal(afterCleanup.firewallOpen, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a post-unbind replay revalidates the provider and host without a second update or Caddy recreation",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_origin_unbound" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(interrupted.originProviderState, "original");
      assert.equal(interrupted.originUnbindCount, 1);
      assert.equal(interrupted.caddyRecreateCount, 1);
      const resumed = spawnSync(
        "bash",
        [
          runnerPath,
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 30_000,
        },
      );
      assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
      assert.equal(parseEvidence(resumed).result, "PASS");
      const completed = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(completed.originUnbindCount, 1);
      assert.equal(completed.caddyRecreateCount, 1);
      assert.ok(completed.operations.includes("origin-status"));
      assert.equal(
        completed.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const providerState of ["rebound", "third"]) {
  test(
    `a ${providerState} CloudFront state after unbind is incomplete and retains recovery material`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_origin_unbound" });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
        interrupted.originProviderState = providerState;
        interrupted.originBound = providerState === "rebound";
        writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });
        const resumed = spawnSync(
          "bash",
          [
            runnerPath,
            "--nonce",
            nonce,
            "--expected-revision",
            revision,
            "--control-file",
            run.controlPath,
            "--workbench-checkpoint",
            run.checkpointPath,
            "--checkpoint-request",
            run.requestPath,
          ],
          {
            encoding: "utf8",
            env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
            timeout: 30_000,
          },
        );
        assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
        assert.equal(parseEvidence(resumed).result, "INCOMPLETE");
        const failed = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(failed.originUnbindCount, 1);
        assert.equal(failed.caddyRecreateCount, 1);
        assert.equal(failed.originGcCount ?? 0, 0);
        assert.ok(failed.operations.includes("origin-status"));
        assert.equal(failed.operations.includes("origin-gc"), false);
        assert.equal(
          failed.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const [name, providerState, caddyTokenState] of [
  ["provider third-state without the transient header", "third", "restored"],
  ["restored Caddy token replacement", "original", "other"],
]) {
  test(
    `post-GC ${name} is caught by the private status receipt and can never PASS`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_origin_gc" });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(interrupted.originStatusReceipt, true);
        assert.equal(interrupted.originGcCount, 1);
        interrupted.originProviderState = providerState;
        interrupted.originBound = false;
        interrupted.caddyTokenState = caddyTokenState;
        writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });
        const resumed = spawnSync(
          "bash",
          [
            runnerPath,
            "--nonce",
            nonce,
            "--expected-revision",
            revision,
            "--control-file",
            run.controlPath,
            "--workbench-checkpoint",
            run.checkpointPath,
            "--checkpoint-request",
            run.requestPath,
          ],
          {
            encoding: "utf8",
            env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
            timeout: 30_000,
          },
        );
        assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
        assert.equal(parseEvidence(resumed).result, "INCOMPLETE");
        const failed = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(failed.originGcCount, 1);
        assert.equal(failed.originUnbindCount, 1);
        assert.equal(failed.caddyRecreateCount, 1);
        assert.ok(failed.operations.includes("origin-status"));
        assert.equal(
          failed.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const [receiptState, providerState] of [
  [false, "original"],
  [false, "third"],
  ["corrupt", "original"],
]) {
  test(
    `post-GC ${receiptState === false ? "missing" : "corrupt"} private receipt cannot rebaseline ${providerState} provider bytes`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_origin_gc" });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(interrupted.originGcCount, 1);
        interrupted.originStatusReceipt = receiptState;
        interrupted.originProviderState = providerState;
        interrupted.originBound = false;
        writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });

        const resumed = resumeScenario(run);
        assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
        const evidence = parseEvidence(resumed);
        assert.equal(evidence.result, "INCOMPLETE");
        const failed = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(failed.originGcCount, 1);
        assert.equal(failed.originStatusReceipt, receiptState);
        assert.equal(
          failed.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.equal(failed.hostLeaseReleased ?? false, false);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

for (const crashPoint of [
  "after_functional_gate",
  "after_origin_gc",
  "after_contained_verified",
  "after_watchdog_disarm_returned",
  "after_pass_candidate_embedded_before_validation",
  "after_success_evidence",
  "after_watchdog_disarmed",
  "after_host_lease_complete",
  "after_host_lease_release",
  "after_run_marker_complete",
]) {
  test(
    `runner SIGKILL ${crashPoint} resumes the same nonce to one canonical PASS`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        if (crashPoint === "after_watchdog_disarm_returned") {
          assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog.json")), false);
          assert.equal(JSON.parse(readFileSync(run.statePath, "utf8")).watchdogDisarmed, true);
        }
        const resumed = spawnSync(
          "bash",
          [
            runnerPath,
            "--nonce",
            nonce,
            "--expected-revision",
            revision,
            "--control-file",
            run.controlPath,
            "--workbench-checkpoint",
            run.checkpointPath,
            "--checkpoint-request",
            run.requestPath,
          ],
          {
            encoding: "utf8",
            env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
            timeout: 30_000,
          },
        );
        assert.equal(
          resumed.status,
          0,
          `${crashPoint}\n${resumed.stderr}\n${resumed.stdout}\n${readFileSync(run.statePath, "utf8")}`,
        );
        const evidence = parseEvidence(resumed);
        assert.equal(evidence.result, "PASS");
        assert.equal(evidence.code, "PASS_EDGE_WINDOW_RECONTAINED");
        assert.equal(evidence.window.state, "complete");
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(
          state.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.equal(state.hostLeaseAcquireCount, 1);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "an official PASS-validator rejection is latched before a post-disarm crash and can never replay as PASS",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      crashPoint: "after_watchdog_disarmed",
      environmentPatch: { REFUNDDESK_EDGE_WINDOW_TEST_OFFICIAL_VALIDATOR_FAIL_ONCE: "1" },
    });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      const interruptedMarker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-run.json"), "utf8"),
      );
      assert.equal(interruptedMarker.state, "contained_disarmed_pending_validation");
      assert.equal(interruptedMarker.evidenceSha256, null);
      assert.equal(interruptedMarker.facts.intents.abortRequested, true);
      assert.equal(interruptedMarker.facts.intents.terminalReason, "OFFICIAL_VALIDATOR_REJECTED");
      assert.equal(interruptedMarker.facts.probes.finalPostflight.officialValidator, false);
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(interrupted.officialValidatorRejectedOnce, true);
      assert.equal(interrupted.hostLeasePassCompletionCount ?? 0, 0);

      const resumed = resumeScenario(run, { timeout: 40_000 });
      assert.equal(resumed.status, 20, `${resumed.stderr}\n${resumed.stdout}`);
      assert.doesNotMatch(resumed.stdout, /"result":"PASS"/u);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "FAIL");
      validateFixtureEvidence(evidence, 20);
      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(finalState.hostLeasePassCompletionCount ?? 0, 0);
      assert.ok((finalState.hostLeaseCleanupCompletionCount ?? 0) >= 1);
      assert.equal(finalState.hostLeaseReleased, true);
      assert.equal(
        finalState.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a restored immutable PASS candidate is revalidated and a rejection remains exact FAIL20",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      crashPoint: "after_pass_candidate_embedded_before_validation",
    });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      const candidateMarker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-run.json"), "utf8"),
      );
      assert.equal(candidateMarker.state, "contained_disarmed_pending_validation");
      assert.match(candidateMarker.evidenceSha256, /^[0-9a-f]{64}$/u);
      assert.equal(candidateMarker.evidencePublished, false);
      assert.equal(candidateMarker.facts.intents.abortRequested, false);

      run.environment.REFUNDDESK_EDGE_WINDOW_TEST_OFFICIAL_VALIDATOR_FAIL_ONCE = "1";
      const resumed = resumeScenario(run, { timeout: 40_000 });
      assert.equal(resumed.status, 20, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "FAIL");
      validateFixtureEvidence(evidence, 20);
      const failedMarker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-run.json"), "utf8"),
      );
      assert.equal(failedMarker.state, "failed_closed");
      assert.equal(failedMarker.facts.intents.abortRequested, true);
      assert.equal(failedMarker.facts.intents.terminalReason, "OFFICIAL_VALIDATOR_REJECTED");
      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(finalState.officialValidatorRejectedOnce, true);
      assert.equal(finalState.hostLeasePassCompletionCount ?? 0, 0);
      assert.equal(
        finalState.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [environmentName, stateFlag, expectedReason] of [
  [
    "REFUNDDESK_EDGE_WINDOW_TEST_TERMINAL_TIMESTAMP_FAIL_ONCE",
    "terminalTimestampRejectedOnce",
    "TERMINAL_TIMESTAMP_INVALID",
  ],
  [
    "REFUNDDESK_EDGE_WINDOW_TEST_TERMINAL_TEMPORAL_FAIL_ONCE",
    "terminalTemporalRejectedOnce",
    "TERMINAL_TEMPORAL_BOUNDS_INVALID",
  ],
]) {
  test(
    `${expectedReason} is durably latched as exact INCOMPLETE21 before a crash`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", {
        crashPoint: "after_watchdog_disarmed",
        environmentPatch: { [environmentName]: "1" },
      });
      try {
        assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
        const interruptedMarker = JSON.parse(
          readFileSync(join(run.controlRoot, "edge-window-run.json"), "utf8"),
        );
        assert.equal(interruptedMarker.facts.intents.abortRequested, true);
        assert.equal(interruptedMarker.facts.intents.terminalReason, expectedReason);
        assert.equal(interruptedMarker.evidenceSha256, null);
        const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(interrupted[stateFlag], true);
        assert.equal(interrupted.hostLeasePassCompletionCount ?? 0, 0);

        const resumed = resumeScenario(run, { timeout: 40_000 });
        assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
        const evidence = parseEvidence(resumed);
        assert.equal(evidence.result, "INCOMPLETE");
        validateFixtureEvidence(evidence, 21);
        const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(finalState.hostLeasePassCompletionCount ?? 0, 0);
        assert.ok((finalState.hostLeaseCleanupCompletionCount ?? 0) >= 1);
        assert.equal(finalState.hostLeaseReleased, true);
        assert.equal(
          finalState.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "a candidate pathname substitution after the official validator publishes only authority A",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", {
      environmentPatch: {
        REFUNDDESK_EDGE_WINDOW_TEST_SUBSTITUTE_EVIDENCE_AFTER_VALIDATOR: "1",
      },
      timeout: 40_000,
    });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${run.result.stdout}`);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "PASS");
      assert.equal(evidence.watchdog.triggered, false);
      validateFixtureEvidence(evidence, 0);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.evidenceSubstitutedAfterValidator, true);
      assert.equal(state.hostLeasePassCompletionCount, 1);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "contained_verified replay ignores a pathname substitution and consumes only embedded authority A",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_success_evidence" });
    try {
      assert.equal(run.result.signal, "SIGKILL", run.result.stderr);
      run.environment.REFUNDDESK_EDGE_WINDOW_TEST_SUBSTITUTE_EVIDENCE_AFTER_VALIDATOR = "1";
      const resumed = resumeScenario(run, { timeout: 40_000 });
      assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "PASS");
      assert.equal(evidence.watchdog.triggered, false);
      validateFixtureEvidence(evidence, 0);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.evidenceSubstitutedAfterValidator, true);
      assert.equal(state.hostLeasePassCompletionCount, 1);
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "contained_verified replay rescans resurrected secret residue before lease consumption",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_success_evidence" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      const scanCount = interrupted.operations.filter(
        (operation) => operation === "origin-secret-scan",
      ).length;
      assert.ok(scanCount >= 2, JSON.stringify(interrupted.operations));
      interrupted.originSecretCanary = true;
      writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });

      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.notEqual(evidence.code, "PASS_EDGE_WINDOW_RECONTAINED");
      const failed = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.ok(
        failed.operations.filter((operation) => operation === "origin-secret-scan").length >
          scanCount,
        JSON.stringify(failed.operations),
      );
      assert.equal(
        failed.operations.includes("host-lease-release"),
        false,
        JSON.stringify(failed.operations),
      );
      // Recovery may invoke the repair-only completion predicate to detect a
      // crash between already-complete markers; an ordinary held/held pair is
      // rejected and must remain unconsumed after this secret-scan failure.
      assert.equal(failed.hostLease, "held");
      assert.equal(failed.authorizationLease, "held");
      assert.equal(failed.hostLeaseReleased ?? false, false);
      assert.equal(
        failed.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
      assert.equal(failed.firewallOpen, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [name, mutate] of [
  [
    "CloudFront rebound",
    (state) => Object.assign(state, { originBound: true, originProviderState: "bound" }),
  ],
  [
    "CloudFront third state",
    (state) => Object.assign(state, { originBound: false, originProviderState: "third" }),
  ],
  ["restored Caddy token drift", (state) => Object.assign(state, { caddyTokenState: "other" })],
]) {
  test(
    `contained_verified replay rejects ${name} before lease consumption`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_success_evidence" });
      try {
        assert.equal(run.result.signal, "SIGKILL");
        const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
        const originStatusCount = interrupted.operations.filter(
          (operation) => operation === "origin-status",
        ).length;
        mutate(interrupted);
        writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });
        const resumed = resumeScenario(run);
        assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
        const evidence = parseEvidence(resumed);
        assert.equal(evidence.result, "INCOMPLETE");
        validateFixtureEvidence(evidence, 21);
        const failed = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.ok(
          failed.operations.filter((operation) => operation === "origin-status").length >
            originStatusCount,
        );
        assert.equal(
          failed.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.equal(failed.originProviderState, "original");
        assert.equal(failed.originBound, false);
        assert.equal(failed.caddyTokenState, "restored");
        assert.equal(failed.hostLease, "complete");
        assert.equal(failed.authorizationLease, "complete");
        assert.equal(failed.hostLeaseReleased, true);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "contained_verified replay cannot consume PASS after admission and operation validity expire",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_success_evidence" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      interrupted.timestampIndex = 0;
      interrupted.timestamps = ["2026-08-08T13:00:00Z"];
      writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });
      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      validateFixtureEvidence(evidence, 21);
      const failed = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(
        failed.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
      assert.equal(failed.hostLeaseReleased, true);
      assert.equal(failed.hostLease, "complete");
      assert.equal(failed.authorizationLease, "complete");
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const [scenario, markersReleased] of [
  ["pass-completion-crosses-validity", false],
  ["pass-validity-crosses-after-finalization", true],
  ["pass-validity-crosses-after-main-validator", true],
]) {
  test(
    `${scenario} cannot emit PASS or consume a late completion`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario);
      try {
        assert.equal(run.result.status, 21, `${run.result.stderr}\n${run.result.stdout}`);
        const evidence = parseEvidence(run.result);
        assert.equal(evidence.result, "INCOMPLETE");
        validateFixtureEvidence(evidence, 21);
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(
          state.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.equal(state.hostLeaseReleased ?? false, markersReleased);
        if (markersReleased) {
          assert.equal(state.hostLease, "complete");
          assert.equal(state.authorizationLease, "complete");
        } else {
          assert.equal(state.completionRejectedAfterValidity, true);
          assert.equal(state.hostLease, "held");
          assert.equal(state.authorizationLease, "held");
        }
        const runner = readFileSync(runnerPath, "utf8");
        assert.match(runner, /completion_not_before="\$6"\ncompletion_not_after="\$7"/u);
        assert.match(runner, /earliest <= instant\(lease\["completedAt"\]\) <= latest/u);
        assert.match(runner, /earliest <= instant\(authorization\["completedAt"\]\) <= latest/u);
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "generic functional-gate recovery rechecks validity after its final validator",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass-validity-crosses-after-main-validator", {
      crashPoint: "after_functional_gate",
    });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const resumed = resumeScenario(run);
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "INCOMPLETE");
      validateFixtureEvidence(evidence, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.operations.filter((operation) => operation === "firewall-open").length, 1);
      assert.equal(state.hostLease, "complete");
      assert.equal(state.authorizationLease, "complete");
      assert.equal(state.hostLeaseReleased, true);
      const runner = readFileSync(runnerPath, "utf8");
      const cleanupIndex = runner.indexOf("cleanup_surfaces || cleanup_status=$?");
      const evidenceIndex = runner.indexOf(
        'final_evidence_ready "${EVIDENCE_FILE}" "${EVIDENCE_AUTHORITY_SHA}"; then',
        cleanupIndex,
      );
      const guardIndex = runner.indexOf("if pass_completion_guard; then", evidenceIndex);
      assert.ok(cleanupIndex >= 0 && evidenceIndex > cleanupIndex && guardIndex > evidenceIndex);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a crash between the two lease-completion markers finishes both without reacquire or a second open",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_success_evidence" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(interrupted.hostLease, "held");
      assert.equal(interrupted.authorizationLease, "held");
      interrupted.hostLease = "complete";
      writeFileSync(run.statePath, canonical(interrupted), { mode: 0o600 });

      const resumed = spawnSync(
        "bash",
        [
          runnerPath,
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 30_000,
        },
      );
      assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.result, "PASS");
      const completed = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(completed.hostLease, "complete");
      assert.equal(completed.authorizationLease, "complete");
      assert.equal(completed.hostLeaseReleased, true);
      assert.equal(completed.hostLeaseAcquireCount, 1);
      assert.equal(
        completed.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const scenario of ["host-lease-complete-lost-ack", "host-lease-release-lost-ack"]) {
  test(
    `${scenario} converges in cleanup mode without marker regression, reacquire, or reopen`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario(scenario);
      try {
        assert.equal(run.result.status, 21, run.result.stderr);
        assert.equal(parseEvidence(run.result).result, "INCOMPLETE");
        const beforeCleanup = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(beforeCleanup.hostLease, "complete");
        assert.equal(beforeCleanup.authorizationLease, "complete");

        const cleanup = spawnSync(
          "bash",
          [
            runnerPath,
            "--mode",
            "cleanup",
            "--nonce",
            nonce,
            "--expected-revision",
            revision,
            "--control-file",
            run.controlPath,
            "--workbench-checkpoint",
            run.checkpointPath,
            "--checkpoint-request",
            run.requestPath,
          ],
          { encoding: "utf8", env: run.environment, timeout: 30_000 },
        );
        assert.equal(cleanup.status, 21, cleanup.stderr);
        assert.equal(parseEvidence(cleanup).result, "INCOMPLETE");
        const afterCleanup = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(afterCleanup.hostLease, "complete");
        assert.equal(afterCleanup.authorizationLease, "complete");
        assert.equal(afterCleanup.hostLeaseReleased, true);
        assert.equal(afterCleanup.hostLeaseAcquireCount, 1);
        assert.equal(
          afterCleanup.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
        assert.ok(afterCleanup.operations.includes("host-lease-cleanup-status"));
      } finally {
        cleanupScenario(run);
      }
    },
  );
}

test(
  "cleanup repairs a host-complete authorization-held crash without marker regression or reacquire",
  { skip: !linuxContractAvailable },
  () => {
    const runner = readFileSync(runnerPath, "utf8");
    assert.match(runner, /host-lease-complete\) production_host_lease_complete "\$@"/u);
    assert.match(runner, /run_patch_operation host-lease-complete false true/u);
    assert.match(
      runner,
      /if set\(document\) == \{"authorizationSha256","completedAt","expectedRevision","kind","nonce","schemaVersion","state"\} and document\.get\("state"\) == "complete":/u,
    );
    assert.match(
      runner,
      /if previous != \{"expectedRevision":revision,"kind":"refunddesk\.edge-window-host-lease","nonce":nonce,"schemaVersion":1,"state":"held"\}: raise SystemExit\(1\)/u,
    );
    const run = runScenario("host-lease-partial-complete-lost-ack");
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      assert.equal(parseEvidence(run.result).result, "INCOMPLETE");
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(interrupted.hostLease, "complete");
      assert.equal(interrupted.authorizationLease, "held");
      assert.equal(interrupted.hostLeaseReleased ?? false, false);
      assert.equal(interrupted.hostLeaseAcquireCount, 1);

      const cleanup = spawnSync(
        "bash",
        [
          runnerPath,
          "--mode",
          "cleanup",
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        { encoding: "utf8", env: run.environment, timeout: 30_000 },
      );
      assert.equal(cleanup.status, 21, cleanup.stderr);
      assert.equal(parseEvidence(cleanup).result, "INCOMPLETE");
      const recovered = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(recovered.hostLease, "complete");
      assert.equal(recovered.authorizationLease, "complete");
      assert.equal(recovered.hostLeaseReleased, true);
      assert.equal(recovered.hostLeaseRepairOnlyObserved, true);
      assert.equal(recovered.hostLeaseAcquireCount, 1);
      assert.equal(
        recovered.operations.filter((operation) => operation === "firewall-open").length,
        1,
      );
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a lost host-lease acquire acknowledgement is recovered from durable intent in the same cleanup",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("host-lease-acquire-lost-ack");
    try {
      assert.equal(run.result.status, 21, run.result.stderr);
      const evidence = parseEvidence(run.result);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.window.state, "failed_closed");
      validateFixtureEvidence(evidence, 21);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.hostLeaseAcquireCount, 1);
      assert.equal(state.hostLease, "complete");
      assert.equal(state.authorizationLease, "complete");
      assert.equal(state.hostLeaseReleased, true);
      assert.equal(state.operations[0], "host-lease-acquire");
      assert.equal(state.operations[1], "firewall-close");
      assert.equal(state.operations.includes("origin-bind"), false);
      assert.equal(state.operations.includes("firewall-open"), false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a crash after the durable watchdog marker but before arm cleans the exact intent without ingress",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("watchdog-marker-written-crash", {
      crashPoint: "after_watchdog_marker_written",
    });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const interrupted = JSON.parse(readFileSync(run.statePath, "utf8"));
      const cleanupStart = interrupted.operations.length;
      assert.equal(interrupted.hostLeaseAcquireCount, 1);
      assert.equal(interrupted.operations.includes("watchdog-arm"), false);
      assert.equal(interrupted.operations.includes("firewall-open"), false);
      assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog.json")), true);

      const cleanup = resumeScenario(run);
      assert.equal(cleanup.status, 21, cleanup.stderr);
      const evidence = parseEvidence(cleanup);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.window.state, "failed_closed");
      validateFixtureEvidence(evidence, 21);
      const recovered = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(recovered.operations[cleanupStart], "firewall-close");
      assert.equal(recovered.caddyRunning, false);
      assert.equal(recovered.workerRunning, false);
      assert.equal(recovered.watchdogDisarmed, true);
      assert.equal(recovered.hostLease, "complete");
      assert.equal(recovered.authorizationLease, "complete");
      assert.equal(recovered.hostLeaseReleased, true);
      assert.equal(recovered.hostLeaseAcquireCount, 1);
      assert.equal(recovered.operations.includes("final-postflight"), false);
      assert.equal(recovered.operations.includes("firewall-open"), false);
      assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog.json")), false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "an invalid watchdog marker during ingress still triggers best-effort host containment",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const markerPath = join(run.controlRoot, "edge-window-watchdog.json");
      writeFileSync(
        markerPath,
        canonical({
          armedBoottimeMilliseconds: 100000,
          bootId: "12345678-1234-4123-8123-123456789abc",
          deadlineBoottimeMilliseconds: 400000,
          deadlineEpoch: 1786190700,
          expectedRevision: revision,
          kind: "refunddesk.edge-window-watchdog",
          metrics: {
            containersRestartFenced: 0,
            containersStopped: 0,
            unitsStopRequested: 0,
          },
          nonce,
          schemaVersion: 1,
          serviceSha256: "1".repeat(64),
          state: "armed",
          timerSha256: "2".repeat(64),
          watchdogSha256: "0".repeat(64),
          windowSeconds: 300,
        }),
        { mode: 0o600 },
      );
      chmodSync(markerPath, 0o600);
      const watchdogResult = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(watchdogResult.status, 20, watchdogResult.stderr);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.caddyRunning, false);
      assert.equal(state.workerRunning, false);
      assert.deepEqual(state.listeners, {
        tcp80: false,
        tcp443: false,
        udp80: false,
        udp443: false,
      });
      assert.ok(state.operations.some((operation) => operation.startsWith("watchdog:stop-unit:")));
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "a watchdog validation prerequisite failure still attempts Caddy-first fail-safe containment",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: {
          ...run.environment,
          REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "",
          REFUNDDESK_EDGE_WINDOW_TEST_PREREQUISITE_FAILURE: "1",
        },
        timeout: 10000,
      });
      assert.equal(tick.status, 21, tick.stderr);
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(state.caddyRunning, false);
      assert.equal(state.workerRunning, false);
      const caddyFence = state.operations.indexOf("watchdog:scope-kill:c");
      const firstRead = state.operations.indexOf("watchdog:public-listeners");
      const workerFence = state.operations.indexOf("watchdog:scope-kill:3");
      const firstUnit = state.operations.findIndex((operation) =>
        operation.startsWith("watchdog:stop-unit:"),
      );
      assert.ok(
        caddyFence >= 0 &&
          caddyFence < firstRead &&
          firstRead < workerFence &&
          workerFence < firstUnit,
        state.operations.join("\n"),
      );
      const resumed = resumeScenario(run, { mode: "cleanup", timeout: 40_000 });
      assert.equal(resumed.status, 21, `${resumed.stderr}\n${resumed.stdout}`);
      const evidence = parseEvidence(resumed);
      assert.equal(evidence.watchdog.triggered, true);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.doesNotMatch(resumed.stdout, /"result":"PASS"/u);
      const finalState = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(finalState.firewallOpen, false);
      assert.equal(finalState.hostLeaseReleased, true);
      assert.equal(existsSync(join(run.controlRoot, "edge-window-watchdog-triggered")), false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog contains on monotonic deadline even after wall-clock rollback",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.nowEpoch = marker.deadlineEpoch - 120;
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds;
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "watchdog contains immediately when the host boot identity changes",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.nowEpoch = marker.deadlineEpoch - 120;
      state.boottimeMilliseconds = marker.armedBoottimeMilliseconds + 1000;
      state.bootId = "87654321-4321-4321-8321-cba987654321";
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
    } finally {
      cleanupScenario(run);
    }
  },
);

test(
  "cleanup after a rebooted expired window converges to incomplete without a second open",
  { skip: !linuxContractAvailable },
  () => {
    const run = runScenario("pass", { crashPoint: "after_ingress_open" });
    try {
      assert.equal(run.result.signal, "SIGKILL");
      const marker = JSON.parse(
        readFileSync(join(run.controlRoot, "edge-window-watchdog.json"), "utf8"),
      );
      const state = JSON.parse(readFileSync(run.statePath, "utf8"));
      state.bootId = "87654321-4321-4321-8321-cba987654321";
      state.boottimeMilliseconds = marker.deadlineBoottimeMilliseconds + 1000;
      state.nowEpoch = marker.deadlineEpoch + 1;
      state.scenario = "reboot-after-deadline";
      writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
      const tick = spawnSync("bash", [watchdogPath], {
        encoding: "utf8",
        env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
        timeout: 10000,
      });
      assert.equal(tick.status, 0, tick.stderr);
      const cleanup = spawnSync(
        "bash",
        [
          runnerPath,
          "--mode",
          "cleanup",
          "--nonce",
          nonce,
          "--expected-revision",
          revision,
          "--control-file",
          run.controlPath,
          "--workbench-checkpoint",
          run.checkpointPath,
          "--checkpoint-request",
          run.requestPath,
        ],
        {
          encoding: "utf8",
          env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
          timeout: 30_000,
        },
      );
      assert.equal(cleanup.status, 21, cleanup.stderr);
      const evidence = parseEvidence(cleanup);
      assert.equal(evidence.result, "INCOMPLETE");
      assert.equal(evidence.window.state, "failed_closed");
      assert.equal(evidence.watchdog.monotonicBounded, false);
      validateFixtureEvidence(evidence, 21);
      const after = JSON.parse(readFileSync(run.statePath, "utf8"));
      assert.equal(after.firewallOpen, false);
      assert.equal(after.caddyRunning, false);
      assert.equal(after.workerRunning, false);
      assert.equal(after.watchdogDisarmed, true);
      assert.equal(after.hostLease, "complete");
      assert.equal(after.authorizationLease, "complete");
      assert.equal(after.hostLeaseReleased, true);
      assert.equal(after.operations.includes("final-postflight"), false);
      assert.equal(after.finalPostflightRejectedOldBoot ?? false, false);
      assert.equal(after.operations.filter((operation) => operation === "firewall-open").length, 1);
    } finally {
      cleanupScenario(run);
    }
  },
);

for (const tamper of ["marker-missing-after-arm", "watchdog-disabled-after-arm"]) {
  test(
    `${tamper} is recontained and can never produce PASS`,
    { skip: !linuxContractAvailable },
    () => {
      const run = runScenario("pass", { crashPoint: "after_ingress_open" });
      try {
        const state = JSON.parse(readFileSync(run.statePath, "utf8"));
        if (tamper === "marker-missing-after-arm") {
          rmSync(join(run.controlRoot, "edge-window-watchdog.json"), { force: true });
        } else {
          state.scenario = tamper;
        }
        writeFileSync(run.statePath, canonical(state), { mode: 0o600 });
        const cleanup = spawnSync(
          "bash",
          [
            runnerPath,
            "--mode",
            "cleanup",
            "--nonce",
            nonce,
            "--expected-revision",
            revision,
            "--control-file",
            run.controlPath,
            "--workbench-checkpoint",
            run.checkpointPath,
            "--checkpoint-request",
            run.requestPath,
          ],
          {
            encoding: "utf8",
            env: { ...run.environment, REFUNDDESK_EDGE_WINDOW_TEST_CRASH_POINT: "" },
            timeout: 30_000,
          },
        );
        assert.equal(cleanup.status, 21, cleanup.stderr);
        const evidence = parseEvidence(cleanup);
        assert.equal(evidence.result, "INCOMPLETE");
        // The host can still prove every physical surface stopped and the
        // timer/marker physically absent. The missing/drifted authority still
        // invalidates continuity and permanently forbids PASS.
        assert.equal(evidence.watchdog.failSafeContained, true);
        assert.equal(evidence.watchdog.disarmed, true);
        assert.equal(evidence.watchdog.markerComplete, true);
        validateFixtureEvidence(evidence, 21);
        const after = JSON.parse(readFileSync(run.statePath, "utf8"));
        assert.equal(after.firewallOpen, false);
        assert.equal(after.caddyRunning, false);
        assert.equal(after.workerRunning, false);
        assert.equal(
          after.operations.filter((operation) => operation === "firewall-open").length,
          1,
        );
      } finally {
        cleanupScenario(run);
      }
    },
  );
}
