import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const observerPath = join(here, "scripts", "observe-host-postflight.sh");
const schemaPath = join(
  repositoryRoot,
  "docs",
  "schemas",
  "refunddesk-lightsail-postflight-v1.schema.json",
);
const fixturesRoot = join(here, "test-fixtures", "postflight");
const scenariosPath = join(fixturesRoot, "scenarios.json");
const fakeCommandPath = join(fixturesRoot, "fake-command.mjs");
const revision = "a".repeat(40);
const otherRevision = "b".repeat(40);
const nonce = "9".repeat(64);
const webhookSecretCanary = ["wh", "sec_fixture_must_never_escape"].join("");
const appSigningSecretCanary = ["ab", "sec_fixture_must_never_escape"].join("");
const restrictedKeyCanary = ["rk", "_test_fixture_must_never_escape"].join("");
const secretCanaries = [webhookSecretCanary, appSigningSecretCanary, restrictedKeyCanary];

const observer = await readFile(observerPath, "utf8");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const scenarios = JSON.parse(await readFile(scenariosPath, "utf8"));
const selectedScenarios = process.env.POSTFLIGHT_TEST_SCENARIO
  ? scenarios.filter(({ name }) => name === process.env.POSTFLIGHT_TEST_SCENARIO)
  : scenarios;

function sorted(value) {
  return [...value].sort();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function dereference(rootSchema, reference) {
  assert.match(reference, /^#\//u);
  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((node, segment) => node[segment], rootSchema);
}

function schemaMatches(value, node, rootSchema, path = "$") {
  try {
    validateSchema(value, node, rootSchema, path);
    return true;
  } catch {
    return false;
  }
}

function validateSchema(value, originalNode, rootSchema, path = "$") {
  let node = originalNode;
  if (node.$ref) node = dereference(rootSchema, node.$ref);
  if (node.allOf) {
    for (const child of node.allOf) validateSchema(value, child, rootSchema, path);
  }
  if (node.oneOf) {
    const matches = node.oneOf.filter((child) => schemaMatches(value, child, rootSchema, path));
    assert.equal(matches.length, 1, `${path} must match exactly one oneOf branch`);
  }
  if (Object.hasOwn(node, "const")) assert.deepEqual(value, node.const, `${path} const`);
  if (node.enum) assert.ok(node.enum.includes(value), `${path} enum`);
  if (node.type === "object") {
    assert.ok(
      value !== null && typeof value === "object" && !Array.isArray(value),
      `${path} object`,
    );
    for (const required of node.required ?? [])
      assert.ok(Object.hasOwn(value, required), `${path}.${required} required`);
    if (node.additionalProperties === false) {
      assert.deepEqual(
        sorted(Object.keys(value)),
        sorted(Object.keys(node.properties ?? {})),
        `${path} exact keys`,
      );
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (Object.hasOwn(value, key))
        validateSchema(value[key], child, rootSchema, `${path}.${key}`);
    }
  } else if (node.type === "array") {
    assert.ok(Array.isArray(value), `${path} array`);
    if (node.minItems !== undefined) assert.ok(value.length >= node.minItems, `${path} minItems`);
    if (node.maxItems !== undefined) assert.ok(value.length <= node.maxItems, `${path} maxItems`);
    if (node.uniqueItems)
      assert.equal(
        new Set(value.map((item) => JSON.stringify(item))).size,
        value.length,
        `${path} uniqueItems`,
      );
    for (const [index, child] of (node.prefixItems ?? []).entries()) {
      validateSchema(value[index], child, rootSchema, `${path}[${index}]`);
    }
    if (node.items && node.items !== false) {
      for (let index = (node.prefixItems ?? []).length; index < value.length; index += 1) {
        validateSchema(value[index], node.items, rootSchema, `${path}[${index}]`);
      }
    }
    if (node.items === false)
      assert.ok(value.length <= (node.prefixItems ?? []).length, `${path} extra items`);
  } else if (node.type === "string") {
    assert.equal(typeof value, "string", `${path} string`);
    if (node.pattern) assert.match(value, new RegExp(node.pattern, "u"), `${path} pattern`);
  } else if (node.type === "integer") {
    assert.ok(Number.isSafeInteger(value), `${path} safe integer`);
    if (node.minimum !== undefined) assert.ok(value >= node.minimum, `${path} minimum`);
    if (node.maximum !== undefined) assert.ok(value <= node.maximum, `${path} maximum`);
  } else if (node.type === "boolean") {
    assert.equal(typeof value, "boolean", `${path} boolean`);
  } else if (node.type === "null") {
    assert.equal(value, null, `${path} null`);
  }
}

async function writeMode(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

function fingerprints() {
  return {
    approvalAttestation: { v1: null, v2: `sha256:${"1".repeat(64)}` },
    field: { v1: null, v2: `sha256:${"2".repeat(64)}` },
    proof: { v1: null, v2: `sha256:${"3".repeat(64)}` },
  };
}

function states() {
  return { approvalAttestation: "active", field: "active", proof: "active" };
}

function commitMarker() {
  const side = { fingerprints: fingerprints(), recorded: true, revision, states: states() };
  return { from: side, schemaVersion: 1, status: "committed", to: side };
}

function manifest() {
  return {
    schemaVersion: 1,
    revision,
    source: "https://github.com/selimhehe1/RefundDesk",
    createdAt: "2026-08-08T12:00:00Z",
    platform: "linux/amd64",
    bundle: {
      file: `refunddesk-sandbox-${revision}.images.tar.zst`,
      sha256: "e".repeat(64),
    },
    images: [
      {
        role: "web",
        reference: `refunddesk-web:sandbox-${revision}`,
        imageId: `sha256:${"d".repeat(64)}`,
        expectedUser: "node",
      },
      {
        role: "worker",
        reference: `refunddesk-worker:sandbox-${revision}`,
        imageId: `sha256:${"c".repeat(64)}`,
        expectedUser: "node",
      },
      {
        role: "migrate",
        reference: `refunddesk-migrate:sandbox-${revision}`,
        imageId: `sha256:${"e".repeat(64)}`,
        expectedUser: "node",
      },
    ],
  };
}

async function makeFixture(base, scenario) {
  const root = join(base, "root");
  const config = join(base, "config");
  const control = join(base, "control");
  const run = join(base, "run");
  const runtime = join(base, "runtime");
  const source = join(root, "releases", revision, "source");
  const currentTarget = scenario.metadataMismatch
    ? join(root, "releases", otherRevision, "source")
    : source;
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(currentTarget, { recursive: true }),
    mkdir(config, { recursive: true, mode: 0o700 }),
    mkdir(control, { recursive: true, mode: 0o700 }),
    mkdir(run, { recursive: true, mode: 0o700 }),
    mkdir(runtime, { recursive: true, mode: 0o700 }),
    mkdir(join(config, "aws"), { recursive: true, mode: 0o700 }),
    mkdir(join(config, "secrets"), { recursive: true, mode: 0o700 }),
  ]);
  for (const directory of [
    config,
    control,
    run,
    runtime,
    join(config, "aws"),
    join(config, "secrets"),
  ]) {
    await chmod(directory, 0o700);
  }
  await writeMode(join(root, "ACTIVE_REVISION"), `${revision}\n`, 0o644);
  await writeMode(
    join(source, ".refunddesk-revision"),
    scenario.sourceMarkerCrlf ? `${revision}\r\n` : `${revision}\n`,
  );
  await writeMode(
    join(source, "deploy", "lightsail", "compose.yml"),
    "name: refunddesk\n",
    scenario.composeSourceUnreadable ? 0o666 : scenario.composeSourceOwnerOnly ? 0o600 : 0o644,
  );
  await writeMode(
    join(root, "releases", revision, "manifest.json"),
    `${JSON.stringify({
      ...manifest(),
      ...(scenario.manifestBundleMismatch
        ? {
            bundle: {
              ...manifest().bundle,
              file: `refunddesk-sandbox-${otherRevision}.images.tar.zst`,
            },
          }
        : {}),
    })}\n`,
    0o644,
  );
  await symlink(currentTarget, join(root, "current"), "dir");
  await writeMode(
    join(config, "release.env"),
    `REFUNDDESK_IMAGE_TAG=sandbox-${revision}\nREFUNDDESK_REVISION=${revision}\n`,
  );
  await writeMode(
    join(config, "platform.env"),
    `REFUNDDESK_GLOBAL_LIVE_ENABLED=${scenario.liveEnabled ? "true" : "false"}\n` +
      "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled\n" +
      `STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET=${webhookSecretCanary}\n`,
    scenario.sensitiveModeInvalid ? 0o644 : 0o600,
  );
  await writeMode(
    join(config, "worker.env"),
    `REFUNDDESK_GLOBAL_LIVE_ENABLED=false\nSTRIPE_APP_SECRET=${appSigningSecretCanary}\n`,
  );
  for (const name of [
    "migration.env",
    "maintenance.env",
    "postgres.env",
    "caddy.env",
    "backup.env",
  ]) {
    await writeMode(join(config, name), "FIXTURE_VALUE=fixture\n");
  }
  await writeMode(join(config, "aws", "config"), "[default]\nregion=eu-west-3\n");
  await writeMode(join(config, "public-origin"), "https://sandbox.refunddesk.test\n");
  await writeMode(
    join(config, "application-key-rotation-state.json"),
    `${JSON.stringify({ schemaVersion: 2, revision, states: states(), fingerprints: fingerprints() })}\n`,
  );
  for (const name of [
    "postgres-owner-password",
    "postgres-web-password",
    "postgres-worker-password",
    "postgres-queue-password",
    "postgres-maintenance-password",
  ]) {
    await writeMode(join(config, "secrets", name), `${restrictedKeyCanary}\n`);
  }
  await writeMode(
    join(config, "application-key-transition-committed.json"),
    `${JSON.stringify(scenario.commitMarkerInvalid ? {} : commitMarker())}\n`,
  );
  if (scenario.completionMarkerInvalid) {
    await writeMode(
      join(control, "managed-sandbox-three-binding-transition-completed.json"),
      "{}\n",
    );
  }
  if (scenario.releaseRuntimeMarker) {
    await writeMode(
      join(runtime, `refunddesk-release-fence-${revision.slice(0, 12)}-123.ready`),
      "fixture\n",
    );
  }
  await writeMode(join(run, "operator.lock"), "");
  return { root, config, control, lock: join(run, "operator.lock"), run, runtime };
}

async function treeDigest(roots) {
  const rows = [];
  async function visit(root, path) {
    const metadata = await lstat(path);
    const name = `${relative(root, path) || "."}`;
    if (metadata.isSymbolicLink()) {
      rows.push([root, name, "link", metadata.mode & 0o7777, await readlink(path)]);
      return;
    }
    if (metadata.isDirectory()) {
      rows.push([root, name, "directory", metadata.mode & 0o7777]);
      const entries = await readdir(path);
      for (const entry of entries.sort()) await visit(root, join(path, entry));
      return;
    }
    const bytes = await readFile(path);
    rows.push([
      root,
      name,
      "file",
      metadata.mode & 0o7777,
      createHash("sha256").update(bytes).digest("hex"),
    ]);
  }
  for (const root of roots) await visit(root, root);
  return JSON.stringify(rows);
}

async function runObserver(scenario) {
  const base = await mkdtemp(join(tmpdir(), "refunddesk-postflight-test-"));
  try {
    const fixture = await makeFixture(base, scenario);
    const fakeBin = join(base, "fake-bin");
    const scenarioFile = join(base, "scenario.json");
    const phaseFile = join(base, "phase");
    await mkdir(fakeBin, { mode: 0o700 });
    await writeFile(scenarioFile, `${JSON.stringify(scenario)}\n`, { mode: 0o600 });
    for (const command of ["docker", "systemctl", "ss"]) {
      const wrapper = join(fakeBin, command);
      await writeFile(
        wrapper,
        `#!/usr/bin/env bash\nexec node ${shellQuote(fakeCommandPath)} ${command} "$@"\n`,
        { mode: 0o700 },
      );
      await chmod(wrapper, 0o700);
    }
    const observedRoots = [
      fixture.root,
      fixture.config,
      fixture.control,
      fixture.run,
      fixture.runtime,
    ];
    const before = await treeDigest(observedRoots);
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn("bash", [observerPath, "--nonce", nonce], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          REFUNDDESK_POSTFLIGHT_TEST_MODE: "1",
          REFUNDDESK_POSTFLIGHT_ROOT: fixture.root,
          REFUNDDESK_POSTFLIGHT_CONFIG_ROOT: fixture.config,
          REFUNDDESK_POSTFLIGHT_CONTROL_ROOT: fixture.control,
          REFUNDDESK_POSTFLIGHT_OPERATOR_LOCK: fixture.lock,
          REFUNDDESK_POSTFLIGHT_RUNTIME_ROOT: fixture.runtime,
          POSTFLIGHT_SCENARIO_FILE: scenarioFile,
          POSTFLIGHT_PHASE_FILE: phaseFile,
          POSTFLIGHT_REVISION: revision,
        },
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
      child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    });
    const after = await treeDigest(observedRoots);
    return { ...result, before, after };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("postflight schema is strict and versioned", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.kind.const, "refunddesk.lightsail.host-postflight");
  assert.deepEqual(schema.properties.exitCode.enum, [0, 20, 21]);
  assert.ok(schema.required.includes("captures"));
  assert.equal(schema.$defs.capture.additionalProperties, false);
});

test("observer has a read-only, bounded, shared-lock contract", async () => {
  assert.match(observer, /exec 2>\/dev\/null/u);
  assert.match(observer, /exec 9<"\$\{OPERATOR_LOCK\}"/u);
  assert.match(observer, /flock --shared --timeout 30 9/u);
  assert.match(observer, /MAX_OUTPUT_BYTES=262144/u);
  assert.match(observer, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u);
  assert.match(observer, /SET LOCAL transaction_read_only = on/u);
  assert.match(observer, /--state=activating,active,reloading,deactivating/u);
  assert.match(observer, /eq \. "REFUNDDESK_GLOBAL_LIVE_ENABLED=false"/u);
  assert.match(observer, /eq \. "STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled"/u);
  assert.match(observer, /index \(split \. "="\) 0/u);
  assert.match(observer, /global-other/u);
  assert.match(observer, /webhook-other/u);
  assert.doesNotMatch(observer, /json \.Config\.Env/u);
  assert.doesNotMatch(observer, /^\s*source\s/mu);
  assert.doesNotMatch(
    observer,
    /docker\s+(?:start|stop|restart|kill|rm|create|run|update|compose\s+up)\b/u,
  );
  assert.doesNotMatch(
    observer,
    /systemctl\s+(?:start|stop|restart|enable|disable|daemon-reload)\b/u,
  );
  assert.doesNotMatch(observer, /^\s*(?:rm|mv|cp|install|mkdir|touch|chmod|chown|tee)\b/mu);
  assert.doesNotMatch(
    observer,
    /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/u,
  );
  const installSource = await readFile(join(here, "scripts", "install-source.sh"), "utf8");
  assert.match(installSource, /deploy\/lightsail\/scripts\/observe-host-postflight\.sh/u);
});

test(
  "invalid invocation is silent and returns 64 on Linux",
  { skip: process.platform !== "linux" },
  async () => {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn("bash", [observerPath], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });
    assert.deepEqual(result, { code: 64, stdout: "", stderr: "" });
  },
);

test(
  "Linux fixtures prove exact output, fail-closed cases, redaction and non-mutation",
  { skip: process.platform !== "linux", timeout: 180_000 },
  async (t) => {
    for (const scenario of selectedScenarios) {
      await t.test(scenario.name, async () => {
        const result = await runObserver(scenario);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, "");
        assert.equal(result.before, result.after, "observer changed the fixture host tree");
        assert.notEqual(
          result.stdout,
          "",
          JSON.stringify({ exitCode: result.code, signal: result.signal }),
        );
        assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 262_144);
        const lines = result.stdout.trimEnd().split("\n");
        assert.equal(lines.length, 1, "observer must emit exactly one JSON document");
        assert.ok(secretCanaries.every((canary) => !result.stdout.includes(canary)));
        const document = JSON.parse(lines[0]);
        assert.equal(
          result.code,
          scenario.expectedExit,
          JSON.stringify({ code: document.code, diagnostics: document.diagnostics }),
        );
        validateSchema(document, schema, schema);
        assert.equal(document.nonce, nonce);
        assert.equal(document.exitCode, result.code);
        assert.equal(document.result, scenario.expectedResult);
        assert.equal(document.posture, scenario.expectedPosture);
        if (scenario.expectedCode) assert.equal(document.code, scenario.expectedCode);
        if (scenario.expectedDiagnostic)
          assert.ok(document.diagnostics.includes(scenario.expectedDiagnostic));
        assert.deepEqual(document.redaction, {
          rawSecretPresent: false,
          rawApiKeyPresent: false,
          rawSignaturePresent: false,
          rawPayloadPresent: false,
          customerDataPresent: false,
          arbitraryPathPresent: false,
          stderrPresent: false,
        });
      });
    }
  },
);
