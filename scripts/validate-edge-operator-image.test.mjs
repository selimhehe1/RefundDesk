import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  EdgeOperatorImageValidationError,
  parseCanonicalEdgeOperatorManifest,
  sortJsonKeys,
  validateEdgeOperatorManifest,
} from "./validate-edge-operator-image.mjs";

const repository = resolve(import.meta.dirname, "..");
const revision = "a".repeat(40);
const archiveBytes = Buffer.from("offline-docker-archive-fixture\n", "utf8");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const dockerfileIgnoreSha256 = createHash("sha256")
  .update(readFileSync(join(repository, "deploy/lightsail/edge-operator.Dockerfile.dockerignore")))
  .digest("hex");
const dockerfileSha256 = createHash("sha256")
  .update(readFileSync(join(repository, "deploy/lightsail/edge-operator.Dockerfile")))
  .digest("hex");
const entrypointSha256 = createHash("sha256")
  .update(readFileSync(join(repository, "deploy/lightsail/scripts/refunddesk-edge-operator.sh")))
  .digest("hex");

function canonical(value) {
  return Buffer.from(`${JSON.stringify(sortJsonKeys(value))}\n`, "utf8");
}

function manifest() {
  return {
    archive: {
      file: `refunddesk-edge-operator-${revision}.docker.tar.zst`,
      sha256: archiveSha256,
      sizeBytes: archiveBytes.length,
    },
    build: {
      dockerfileIgnoreSha256,
      dockerfileSha256,
      entrypointSha256,
      nodeBaseDigest:
        "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
      snapshot: "20260808T000000Z",
    },
    createdAt: "2026-08-08T12:00:00Z",
    image: {
      configSha256: "b".repeat(64),
      id: `sha256:${"c".repeat(64)}`,
      reference: `refunddesk-edge-operator:sandbox-${revision}`,
      user: "10001:10001",
    },
    kind: "refunddesk.edge-operator-image",
    platform: "linux/amd64",
    revision,
    schemaVersion: 1,
    source: "https://github.com/selimhehe1/RefundDesk",
    tools: Object.fromEntries(
      ["aws", "bash", "curl", "git", "jq", "node", "python3", "ssh"].map((name, index) => [
        name,
        {
          path: `/usr/bin/${name}${index}`,
          sha256: index.toString(16).repeat(64),
          version: `${name} fixture`,
        },
      ]),
    ),
  };
}

function validate(value) {
  return validateEdgeOperatorManifest(value, {
    dockerfileIgnoreSha256,
    dockerfileSha256,
    entrypointSha256,
    expectedArchiveSha256: archiveSha256,
    expectedArchiveSizeBytes: archiveBytes.length,
    expectedRevision: revision,
  });
}

test("accepts one canonical exact-revision operator manifest", () => {
  const parsed = parseCanonicalEdgeOperatorManifest(canonical(manifest()));
  assert.equal(validate(parsed).image.user, "10001:10001");
});

for (const [name, mutate, code] of [
  ["extra key", (value) => (value.extra = true), "MANIFEST_KEYS_INVALID"],
  [
    "runtime role reference",
    (value) => (value.image.reference = `refunddesk-web:sandbox-${revision}`),
    "IMAGE_IDENTITY_INVALID",
  ],
  [
    "wrong Dockerfile-specific ignore",
    (value) => (value.build.dockerfileIgnoreSha256 = "e".repeat(64)),
    "BUILD_PROVENANCE_INVALID",
  ],
  [
    "mutable base",
    (value) => (value.build.nodeBaseDigest = "node:24-bookworm-slim"),
    "BUILD_PROVENANCE_INVALID",
  ],
  ["wrong archive", (value) => (value.archive.sha256 = "f".repeat(64)), "ARCHIVE_IDENTITY_INVALID"],
  ["root user", (value) => (value.image.user = "0:0"), "IMAGE_IDENTITY_INVALID"],
  ["missing ssh", (value) => delete value.tools.ssh, "TOOLS_KEYS_INVALID"],
]) {
  test(`rejects ${name}`, () => {
    const value = manifest();
    mutate(value);
    assert.throws(
      () => validate(value),
      (error) => error instanceof EdgeOperatorImageValidationError && error.code === code,
    );
  });
}

test("rejects non-canonical, oversized and secret-bearing manifests", () => {
  const nonCanonical = `${JSON.stringify(manifest()).replace('"archive":', '"archive": ')}\n`;
  assert.throws(
    () => parseCanonicalEdgeOperatorManifest(Buffer.from(nonCanonical)),
    /MANIFEST_CANONICAL_INVALID/u,
  );
  const secret = manifest();
  secret.tools.aws.version = `AKIA${"A".repeat(16)}`;
  assert.throws(
    () => parseCanonicalEdgeOperatorManifest(canonical(secret)),
    /MANIFEST_REDACTION_INVALID/u,
  );
  assert.throws(
    () => parseCanonicalEdgeOperatorManifest(Buffer.alloc(65 * 1024, 0x20)),
    /MANIFEST_SIZE_INVALID/u,
  );
});

test("CLI verifies the archive, source files and out-of-band hashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "refunddesk-edge-operator-"));
  try {
    const archivePath = join(root, `refunddesk-edge-operator-${revision}.docker.tar.zst`);
    const manifestPath = join(root, `refunddesk-edge-operator-${revision}.manifest.json`);
    const manifestBytes = canonical(manifest());
    writeFileSync(archivePath, archiveBytes);
    writeFileSync(manifestPath, manifestBytes);
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [
        join(repository, "scripts/validate-edge-operator-image.mjs"),
        "--archive",
        archivePath,
        "--expected-archive-sha256",
        archiveSha256,
        "--expected-manifest-sha256",
        manifestSha256,
        "--expected-revision",
        revision,
        "--manifest",
        manifestPath,
        "--repository",
        repository,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"code":"PASS_EDGE_OPERATOR_IMAGE_VALID","result":"PASS"}\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
