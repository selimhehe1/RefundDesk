import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("./scripts/restore-verify.sh", import.meta.url), "utf8");

test("restore verification stays offline and runs a locked-down PostgreSQL 18 copy", () => {
  for (const fragment of [
    'POSTGRES_IMAGE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"',
    "--pull never",
    "--network none",
    "--user 999:999",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "listen_addresses=",
    "unix_socket_directories=/var/lib/postgresql",
  ]) {
    assert.match(script, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(script, /\b(?:aws|curl|s3|wget)\b/iu);
  assert.doesNotMatch(script, /(?:--publish|-p[=\s])/u);
});

test("restore verification authenticates the encrypted archive and cleans every exit", () => {
  for (const fragment of [
    "sha256sum",
    "age",
    "mktemp --directory",
    "safe_remove_work_directory",
    "trap cleanup EXIT",
    "rm --recursive --force --one-file-system",
  ]) {
    assert.match(script, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(script, /^TEMP_PARENT="\/var\/tmp\/refunddesk-restore-verify"$/mu);
  assert.match(script, /temporary parent must be root-owned mode 0700/u);
  assert.doesNotMatch(script, /\$\{TMPDIR:-\/tmp\}/u);
});

test("restore archive extraction is unprivileged and container-confined before scanning", () => {
  const extractionStart = script.indexOf(
    'if ! zstd --decompress --stdout --quiet -- "${decrypted_archive}"',
  );
  const extractionEnd = script.indexOf("; then", extractionStart);
  const physicalScan = script.indexOf('find "${restored_pgdata}"', extractionEnd);
  assert.ok(
    extractionStart >= 0 && extractionEnd > extractionStart && physicalScan > extractionEnd,
  );
  const extraction = script.slice(extractionStart, extractionEnd);
  for (const fragment of [
    "docker run",
    "--rm",
    "--interactive",
    "--pull never",
    "--network none",
    "--user 999:999",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--entrypoint /usr/bin/tar",
    "--directory=/restore",
    "--no-same-owner",
  ]) {
    assert.match(extraction, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(extraction, /--same-owner/u);
});

test("restore verification checks PostgreSQL, Prisma and restricted runtime roles", () => {
  for (const fragment of [
    "server_version_num",
    "_prisma_migrations",
    "finished_at IS NULL",
    "refunddesk_web_login",
    "refunddesk_worker_login",
    "refunddesk_queue_login",
    "refunddesk_maintenance_login",
    "refunddesk_maintenance",
    "refunddesk_purge_test_sandbox_tenant",
    "NOT has_function_privilege",
    "count(runtime_role.oid) = 4",
    "NOT runtime_role.rolsuper",
    "NOT runtime_role.rolbypassrls",
  ]) {
    assert.match(script, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("restore verification checks every physical checksum before PostgreSQL starts", () => {
  const checksumCheck = script.indexOf("--entrypoint /usr/lib/postgresql/18/bin/pg_checksums");
  const checksumRunStart = script.lastIndexOf("if ! docker run", checksumCheck);
  const checksumRunEnd = script.indexOf("; then", checksumCheck);
  const databaseStart = script.indexOf("--entrypoint /usr/lib/postgresql/18/bin/postgres");
  assert.ok(checksumCheck >= 0);
  assert.ok(checksumRunStart >= 0);
  assert.ok(checksumRunEnd > checksumCheck);
  assert.ok(databaseStart > checksumRunEnd);

  const checksumRun = script.slice(checksumRunStart, checksumRunEnd);
  for (const fragment of [
    'POSTGRES_IMAGE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"',
    "--rm",
    "--pull never",
    "--network none",
    "--user 999:999",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--entrypoint /usr/lib/postgresql/18/bin/pg_checksums",
    "--check",
    "--pgdata=/var/lib/postgresql",
    "target=/var/lib/postgresql,readonly",
  ]) {
    const target = fragment.startsWith("POSTGRES_IMAGE=") ? script : checksumRun;
    assert.match(target, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(script, /checksums are disabled or corrupt/u);
  assert.doesNotMatch(checksumRun, /--(?:disable|enable|filenode|progress)\b/u);
  assert.doesNotMatch(script, /target=\/var\/lib\/postgresql\/data/u);
});
