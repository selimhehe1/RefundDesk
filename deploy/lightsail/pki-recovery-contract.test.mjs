import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("scripts/provision-internal-pki.sh", import.meta.url);

function functionBody(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = source.indexOf("\n}\n", start);
  assert.notEqual(next, -1, `unterminated ${name}`);
  return source.slice(start, next + 3);
}

test("SIGKILL recovery validates exact PKI orphans before bounded cleanup", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const privateValidation = functionBody(source, "assert_private_work_directory");
  const privateRemoval = functionBody(source, "remove_private_work_directory_path");
  const stageValidation = functionBody(source, "assert_staging_directory");
  const stageRemoval = functionBody(source, "remove_staging_directory_path");
  const recovery = functionBody(source, "recover_interrupted_pki_generation");

  assert.match(source, /^readonly PRIVATE_WORK_PARENT="\/run"$/mu);
  assert.match(source, /^readonly PRIVATE_WORK_PREFIX="refunddesk-internal-pki\."$/mu);
  assert.match(source, /^readonly STAGING_PREFIX="\.pki-stage\."$/mu);
  assert.match(source, /^readonly TEMPORARY_SUFFIX_PATTERN='\^\[A-Za-z0-9\]\{6\}\$'$/mu);

  for (const validation of [privateValidation, stageValidation]) {
    assert.match(validation, /TEMPORARY_SUFFIX_PATTERN/u);
    assert.match(validation, /assert_cleanup_directory/u);
  }
  assert.match(privateValidation, /postgres-ca\.key\|postgres-ca\.crt/u);
  assert.match(privateValidation, /verifier-key\.pub\|verifier-cert\.pub/u);
  assert.match(stageValidation, /postgres\|verifier\|client/u);

  assert.match(recovery, /PRIVATE_WORK_PREFIX/u);
  assert.match(recovery, /STAGING_PREFIX/u);
  assert.match(recovery, /-xdev/u);
  assert.match(recovery, /-mindepth 1/u);
  assert.match(recovery, /-maxdepth 1/u);
  assert.match(recovery, /multiple interrupted PKI generations require manual review/u);
  assert.match(recovery, /private_suffix.*stage_suffix/su);

  assert.match(privateRemoval, /assert_private_work_directory/u);
  assert.match(stageRemoval, /assert_staging_directory/u);
  for (const removal of [privateRemoval, stageRemoval]) {
    assert.match(removal, /rm -- "\$\{entry\}"/u);
    assert.doesNotMatch(removal, /\brm\s+(?:-[^\n]*r|--recursive)\b/u);
    assert.doesNotMatch(removal, /\bfind\b[\s\S]*-delete/u);
  }

  const lock = source.indexOf("flock --exclusive --nonblock 9");
  const recover = source.lastIndexOf("\nrecover_interrupted_pki_generation");
  const inventory = source.indexOf("while IFS= read -r -d '' existing_entry");
  assert.ok(
    lock >= 0 && recover > lock && inventory > recover,
    "recovery must run under the exclusive lock before TLS-root admission",
  );
});

test("orphan cleanup rejects links, foreign metadata and mount boundaries", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const directoryGuard = functionBody(source, "assert_cleanup_directory_state");
  const fileGuard = functionBody(source, "assert_cleanup_file_state");
  const stagingFileGuard = functionBody(source, "assert_staging_file");

  assert.match(directoryGuard, /-d "\$\{path\}" && ! -L "\$\{path\}"/u);
  assert.match(directoryGuard, /readlink --canonicalize-existing/u);
  assert.match(directoryGuard, /stat --format='%u:%g:%a'/u);
  assert.match(directoryGuard, /stat --format='%d'/u);
  assert.match(directoryGuard, /findmnt --noheadings --raw --output TARGET --target/u);

  assert.match(fileGuard, /-f "\$\{path\}" && ! -L "\$\{path\}"/u);
  assert.match(fileGuard, /stat --format='%u:%g:%a'/u);
  assert.match(fileGuard, /stat --format='%h'/u);
  assert.match(fileGuard, /stat --format='%d'/u);
  assert.match(fileGuard, /findmnt --noheadings --raw --output TARGET --target/u);

  assert.match(stagingFileGuard, /"0:0:600"/u);
  assert.match(stagingFileGuard, /"999:999:600"/u);
  assert.match(stagingFileGuard, /"999:999:400"/u);
  assert.match(stagingFileGuard, /"1000:1000:600"/u);
  assert.match(stagingFileGuard, /"1000:1000:400"/u);
  assert.doesNotMatch(source, /\brm\s+-rf\b/u);
  assert.doesNotMatch(source, /\brm\s+[^\n]*\*/u);
});

test("partial publication is byte-correlated and removed before restart", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const recovery = functionBody(source, "recover_interrupted_pki_generation");
  const publishedValidation = functionBody(
    source,
    "assert_published_service_matches_private_generation",
  );
  const publishedRemoval = functionBody(source, "remove_published_service_generation");
  const correlation = functionBody(source, "assert_file_matches_private_generation");

  assert.match(
    source,
    /STAGING_DIRECTORY="\$\{TLS_ROOT\}\/\$\{STAGING_PREFIX\}\$\{PRIVATE_WORK_DIRECTORY##\*\$\{PRIVATE_WORK_PREFIX\}\}"/u,
  );
  assert.match(correlation, /private_source_path/u);
  assert.match(correlation, /cmp --silent/u);
  assert.match(publishedValidation, /published PKI service contains an unexpected entry/u);
  assert.match(publishedValidation, /assert_file_matches_private_generation/u);
  assert.match(publishedRemoval, /assert_published_service_matches_private_generation/u);
  assert.match(recovery, /PKI target conflicts with its staged generation/u);
  assert.match(recovery, /published_services\+=\("\$\{service\}"\)/u);
  assert.match(recovery, /populated_targets == 0 \|\| populated_targets == 3/u);

  const validate = recovery.indexOf(
    'assert_published_service_matches_private_generation "${private_orphan}" "${service}"',
  );
  const remove = recovery.indexOf(
    'remove_published_service_generation "${private_orphan}" "${service}"',
  );
  assert.ok(
    validate >= 0 && remove > validate,
    "all published fragments must validate before delete",
  );
});

test("terminal crash marker makes a complete publication idempotent", async () => {
  const [source, workflow] = await Promise.all([
    readFile(scriptUrl, "utf8"),
    readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ]);
  const recovery = functionBody(source, "recover_interrupted_pki_generation");
  const markerValidation = functionBody(source, "assert_generation_marker");
  const installedDigests = functionBody(source, "assert_manifest_matches_installed_targets");

  assert.match(source, /^readonly GENERATION_MANIFEST_NAME="\.pki-generation\.sha256"$/mu);
  assert.match(source, /^readonly GENERATION_MARKER_PREFIX="\.pki-generation\."$/mu);
  assert.match(source, /write_generation_manifest "\$\{STAGING_DIRECTORY\}"/u);
  assert.match(
    source,
    /mv -- "\$\{STAGING_DIRECTORY\}\/\$\{GENERATION_MANIFEST_NAME\}" "\$\{generation_marker_candidate\}"/u,
  );
  assert.match(markerValidation, /assert_generation_manifest/u);
  assert.match(installedDigests, /assert_file_matches_generation_manifest/u);
  assert.match(recovery, /validate_installed_material "\$\{TLS_ROOT\}"/u);
  assert.match(recovery, /assert_manifest_matches_installed_targets "\$\{marker_orphan\}"/u);
  assert.match(recovery, /finishing interrupted private PKI cleanup/u);
  assert.match(
    recovery,
    /remove_private_work_directory_path "\$\{private_orphan\}"[\s\S]*RECOVERED_COMMITTED_GENERATION=true/u,
  );
  assert.match(recovery, /RECOVERED_COMMITTED_GENERATION=true/u);
  assert.match(
    source,
    /if \[\[ "\$\{RECOVERED_COMMITTED_GENERATION\}" == "true" \]\]; then[\s\S]*COMMITTED=true[\s\S]*exit 0/u,
  );

  const provisionRuns = workflow.match(
    /bash deploy\/lightsail\/scripts\/provision-internal-pki\.sh/gu,
  );
  assert.ok(
    (provisionRuns?.length ?? 0) >= 3,
    "CI must exercise rejection, recovery and idempotency",
  );
  assert.match(workflow, /pki_state_before/u);
  assert.match(workflow, /pki_state_after/u);
  assert.match(workflow, /interrupted_private_cleanup/u);
  assert.match(workflow, /pki_state_final/u);
  assert.match(workflow, /test "\$pki_state_after" = "\$pki_state_before"/u);
  assert.match(workflow, /test "\$pki_state_final" = "\$pki_state_before"/u);
});
