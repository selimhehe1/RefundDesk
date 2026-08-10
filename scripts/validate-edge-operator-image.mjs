import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const EDGE_OPERATOR_MANIFEST_MAX_BYTES = 64 * 1024;

const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const TOOL_NAMES = Object.freeze(["aws", "bash", "curl", "git", "jq", "node", "python3", "ssh"]);
const SECRET_PATTERNS = Object.freeze([
  /\b(?:AKIA[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|(?:whsec|absec)_[A-Za-z0-9_]{12,})\b/u,
  /-----BEGIN (?:(?:EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY-----/u,
]);

export class EdgeOperatorImageValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "EdgeOperatorImageValidationError";
    this.code = code;
  }
}

function fail(code) {
  throw new EdgeOperatorImageValidationError(code);
}

export function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonKeys(value[key])]),
    );
  }
  return value;
}

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(code);
}

function canonicalJson(value) {
  return `${JSON.stringify(sortJsonKeys(value))}\n`;
}

export function parseCanonicalEdgeOperatorManifest(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > EDGE_OPERATOR_MANIFEST_MAX_BYTES
  ) {
    fail("MANIFEST_SIZE_INVALID");
  }
  if (bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a) || bytes.includes(0x0d)) {
    fail("MANIFEST_ENCODING_INVALID");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("MANIFEST_ENCODING_INVALID");
  }
  if (text.charCodeAt(0) === 0xfeff || SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("MANIFEST_REDACTION_INVALID");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("MANIFEST_JSON_INVALID");
  }
  if (canonicalJson(value) !== text) fail("MANIFEST_CANONICAL_INVALID");
  return value;
}

export function validateEdgeOperatorManifest(
  value,
  {
    expectedRevision,
    expectedArchiveSha256,
    expectedArchiveSizeBytes,
    dockerfileIgnoreSha256,
    dockerfileSha256,
    entrypointSha256,
  } = {},
) {
  exactKeys(
    value,
    [
      "archive",
      "build",
      "createdAt",
      "image",
      "kind",
      "platform",
      "revision",
      "schemaVersion",
      "source",
      "tools",
    ],
    "MANIFEST_KEYS_INVALID",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "refunddesk.edge-operator-image" ||
    value.platform !== "linux/amd64" ||
    value.source !== "https://github.com/selimhehe1/RefundDesk" ||
    !REVISION.test(value.revision) ||
    value.revision !== expectedRevision ||
    !TIMESTAMP.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    fail("MANIFEST_IDENTITY_INVALID");

  exactKeys(value.archive, ["file", "sha256", "sizeBytes"], "ARCHIVE_KEYS_INVALID");
  if (
    value.archive.file !== `refunddesk-edge-operator-${expectedRevision}.docker.tar.zst` ||
    !SHA256.test(value.archive.sha256) ||
    value.archive.sha256 !== expectedArchiveSha256 ||
    !Number.isSafeInteger(value.archive.sizeBytes) ||
    value.archive.sizeBytes < 1 ||
    value.archive.sizeBytes > 1024 ** 3 ||
    value.archive.sizeBytes !== expectedArchiveSizeBytes
  )
    fail("ARCHIVE_IDENTITY_INVALID");

  exactKeys(
    value.build,
    [
      "dockerfileIgnoreSha256",
      "dockerfileSha256",
      "entrypointSha256",
      "nodeBaseDigest",
      "snapshot",
    ],
    "BUILD_KEYS_INVALID",
  );
  if (
    value.build.dockerfileIgnoreSha256 !== dockerfileIgnoreSha256 ||
    value.build.dockerfileSha256 !== dockerfileSha256 ||
    value.build.entrypointSha256 !== entrypointSha256 ||
    value.build.nodeBaseDigest !==
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d" ||
    value.build.snapshot !== "20260808T000000Z"
  )
    fail("BUILD_PROVENANCE_INVALID");

  exactKeys(value.image, ["configSha256", "id", "reference", "user"], "IMAGE_KEYS_INVALID");
  if (
    !SHA256.test(value.image.configSha256) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.image.id) ||
    value.image.reference !== `refunddesk-edge-operator:sandbox-${expectedRevision}` ||
    value.image.user !== "10001:10001"
  )
    fail("IMAGE_IDENTITY_INVALID");

  exactKeys(value.tools, TOOL_NAMES, "TOOLS_KEYS_INVALID");
  const paths = new Set();
  for (const name of TOOL_NAMES) {
    const tool = value.tools[name];
    exactKeys(tool, ["path", "sha256", "version"], "TOOL_KEYS_INVALID");
    if (
      typeof tool.path !== "string" ||
      !/^\/(?:usr|bin)\/[^\r\n]{1,255}$/u.test(tool.path) ||
      paths.has(tool.path) ||
      !SHA256.test(tool.sha256) ||
      typeof tool.version !== "string" ||
      tool.version.length < 1 ||
      tool.version.length > 256 ||
      /[\r\n]/u.test(tool.version)
    )
      fail("TOOL_IDENTITY_INVALID");
    paths.add(tool.path);
  }
  return value;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
    if (size > 1024 ** 3) fail("ARCHIVE_SIZE_INVALID");
  }
  return { sha256: hash.digest("hex"), size };
}

function parseArguments(argv) {
  if (argv.length % 2 !== 0) fail("USAGE");
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || options[name.slice(2)] !== undefined) fail("USAGE");
    options[name.slice(2)] = argv[index + 1];
  }
  const expected = [
    "archive",
    "expected-archive-sha256",
    "expected-manifest-sha256",
    "expected-revision",
    "manifest",
    "repository",
  ];
  if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expected)) fail("USAGE");
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (
      !REVISION.test(options["expected-revision"]) ||
      !SHA256.test(options["expected-archive-sha256"]) ||
      !SHA256.test(options["expected-manifest-sha256"])
    )
      fail("USAGE");
    const repository = resolve(options.repository);
    const manifestPath = resolve(options.manifest);
    const archivePath = resolve(options.archive);
    const manifestBytes = readFileSync(manifestPath);
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    if (manifestSha256 !== options["expected-manifest-sha256"]) fail("MANIFEST_DIGEST_INVALID");
    const archive = await sha256File(archivePath);
    if (archive.sha256 !== options["expected-archive-sha256"]) fail("ARCHIVE_DIGEST_INVALID");
    const dockerfileIgnoreSha256 = createHash("sha256")
      .update(
        readFileSync(resolve(repository, "deploy/lightsail/edge-operator.Dockerfile.dockerignore")),
      )
      .digest("hex");
    const dockerfileSha256 = createHash("sha256")
      .update(readFileSync(resolve(repository, "deploy/lightsail/edge-operator.Dockerfile")))
      .digest("hex");
    const entrypointSha256 = createHash("sha256")
      .update(
        readFileSync(resolve(repository, "deploy/lightsail/scripts/refunddesk-edge-operator.sh")),
      )
      .digest("hex");
    const document = parseCanonicalEdgeOperatorManifest(manifestBytes);
    validateEdgeOperatorManifest(document, {
      dockerfileIgnoreSha256,
      dockerfileSha256,
      entrypointSha256,
      expectedArchiveSha256: archive.sha256,
      expectedArchiveSizeBytes: archive.size,
      expectedRevision: options["expected-revision"],
    });
    process.stdout.write(canonicalJson({ code: "PASS_EDGE_OPERATOR_IMAGE_VALID", result: "PASS" }));
  } catch (error) {
    const code =
      error instanceof EdgeOperatorImageValidationError ? error.code : "VALIDATION_INTERNAL_ERROR";
    process.stdout.write(canonicalJson({ code, result: "FAIL" }));
    process.exitCode = code === "USAGE" ? 64 : 20;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
