import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  escapePathForOutput,
  listScannableFiles,
  runSecretCheck,
  scanFiles,
} from "./check-secrets.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scannerPath = join(scriptDirectory, "check-secrets.mjs");

const syntheticSecrets = Object.freeze({
  secretKey: ["sk", "live", "A".repeat(24)].join("_"),
  restrictedKey: ["rk", "test", "B".repeat(24)].join("_"),
  webhookSecret: `whsec_${"C".repeat(24)}`,
  appSigningSecret: ["absec", "segment", "with", "underscores", "D".repeat(20)].join("_"),
  privateKey: ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
  encryptedPrivateKey: ["-----BEGIN", "ENCRYPTED", "PRIVATE", "KEY-----"].join(" "),
  dsaPrivateKey: ["-----BEGIN", "DSA", "PRIVATE", "KEY-----"].join(" "),
});

function withTemporaryRepository(callback) {
  const repository = mkdtempSync(join(tmpdir(), "refunddesk-secret-scan-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repository });
    callback(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function writeFixture(repository, name, value) {
  writeFileSync(join(repository, name), `${value}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

test("detects every supported secret class without retaining matched values", () => {
  withTemporaryRepository((repository) => {
    const fixtures = [
      ["secret-key.txt", syntheticSecrets.secretKey, "stripe-api-key"],
      ["restricted-key.txt", syntheticSecrets.restrictedKey, "stripe-api-key"],
      ["webhook-secret.txt", syntheticSecrets.webhookSecret, "stripe-webhook-signing-secret"],
      ["app-secret.txt", syntheticSecrets.appSigningSecret, "stripe-app-signing-secret"],
      ["private-key.txt", syntheticSecrets.privateKey, "private-key"],
      ["encrypted-private-key.txt", syntheticSecrets.encryptedPrivateKey, "private-key"],
      ["dsa-private-key.txt", syntheticSecrets.dsaPrivateKey, "private-key"],
    ];

    for (const [name, value] of fixtures) {
      writeFixture(repository, name, value);
    }

    const findings = scanFiles(
      fixtures.map(([name]) => name),
      { cwd: repository },
    );

    assert.deepEqual(
      findings.map(({ code, file }) => [file, code]),
      fixtures.map(([name, , code]) => [name, code]),
    );
    const serializedFindings = JSON.stringify(findings);
    for (const value of Object.values(syntheticSecrets)) {
      assert.equal(serializedFindings.includes(value), false);
    }
  });
});

test("scans tracked and untracked non-ignored files but excludes ignored files", () => {
  withTemporaryRepository((repository) => {
    writeFileSync(join(repository, ".gitignore"), "ignored.txt\n", "utf8");
    writeFixture(repository, "tracked.txt", syntheticSecrets.secretKey);
    writeFixture(repository, "untracked.txt", syntheticSecrets.restrictedKey);
    writeFixture(repository, "ignored.txt", syntheticSecrets.webhookSecret);
    execFileSync("git", ["add", "--", ".gitignore", "tracked.txt"], {
      cwd: repository,
    });

    const files = listScannableFiles({ cwd: repository });
    assert.equal(files.includes(".gitignore"), true);
    assert.equal(files.includes("tracked.txt"), true);
    assert.equal(files.includes("untracked.txt"), true);
    assert.equal(files.includes("ignored.txt"), false);

    let stdout = "";
    let stderr = "";
    const status = runSecretCheck({
      cwd: repository,
      writeOut: (message) => {
        stdout += message;
      },
      writeError: (message) => {
        stderr += message;
      },
    });

    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /"tracked\.txt": stripe-api-key/u);
    assert.match(stderr, /"untracked\.txt": stripe-api-key/u);
    assert.doesNotMatch(stderr, /ignored\.txt/u);
    for (const value of Object.values(syntheticSecrets)) {
      assert.equal(stderr.includes(value), false);
    }
  });
});

test("CLI reports only escaped paths and rule identifiers", () => {
  withTemporaryRepository((repository) => {
    writeFixture(repository, "app-secret.txt", syntheticSecrets.appSigningSecret);
    execFileSync("git", ["add", "--", "app-secret.txt"], { cwd: repository });

    const result = spawnSync(process.execPath, [scannerPath], {
      cwd: repository,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /"app-secret\.txt": stripe-app-signing-secret/u);
    for (const value of Object.values(syntheticSecrets)) {
      assert.equal(result.stderr.includes(value), false);
    }
  });
});

test("fails closed without exposing an exception when a listed file cannot be read", () => {
  let stdout = "";
  let stderr = "";
  const status = runSecretCheck({
    cwd: process.cwd(),
    execFile: () => "locked.txt\0",
    readFile: () => {
      throw new Error("synthetic operating-system details");
    },
    writeOut: (message) => {
      stdout += message;
    },
    writeError: (message) => {
      stderr += message;
    },
  });

  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /"locked\.txt": source-file-read-error/u);
  assert.doesNotMatch(stderr, /synthetic operating-system details/u);
});

test("fails closed without exposing an exception when the Git inventory is unavailable", () => {
  let stderr = "";
  const status = runSecretCheck({
    execFile: () => {
      throw new Error("synthetic Git details");
    },
    writeError: (message) => {
      stderr += message;
    },
  });

  assert.equal(status, 1);
  assert.equal(stderr, 'Secret scan failed:\n"<repository>": repository-list-error\n');
  assert.doesNotMatch(stderr, /synthetic Git details/u);
});

test("escapes Unicode direction controls in diagnostic paths", () => {
  const directionOverride = String.fromCodePoint(0x202e);
  const unsafePath = `report-${directionOverride}txt.exe`;
  const escaped = escapePathForOutput(unsafePath);

  assert.equal(escaped.includes(directionOverride), false);
  assert.match(escaped, /report-\\u202Etxt\.exe/u);
});
