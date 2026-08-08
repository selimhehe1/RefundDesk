import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL("../.github/workflows/sandbox-images.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function namedStep(source, name) {
  const lines = source.split(/\r?\n/u);
  const header = `      - name: ${name}`;
  const starts = lines.flatMap((line, index) => (line === header ? [index] : []));
  if (starts.length !== 1) {
    throw new Error(`WORKFLOW_STEP_CARDINALITY_INVALID:${name}`);
  }

  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("      - ") === true) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function requireStepFragments(step, fragments, contract) {
  for (const fragment of fragments) {
    if (!step.includes(fragment)) {
      throw new Error(`${contract}:${fragment}`);
    }
  }
}

const requiredFragments = [
  "workflow_dispatch:",
  "permissions:",
  "contents: read",
  "id-token: write",
  "attestations: write",
  "ref: ${{ github.sha }}",
  "persist-credentials: false",
  'test "$actual_revision" = "$EXPECTED_REVISION"',
  '--target "$target"',
  "--platform linux/amd64",
  "org.opencontainers.image.revision=$REVISION",
  "org.opencontainers.image.source=$SOURCE_URL",
  "refunddesk-web:sandbox-$actual_revision",
  "refunddesk-worker:sandbox-$actual_revision",
  "refunddesk-migrate:sandbox-$actual_revision",
  "refunddesk-source-${actual_revision}.tar.zst",
  "docker image save",
  'git ls-tree -r --name-only "$REVISION" deploy/lightsail',
  'git archive --format=tar "$REVISION" deploy/lightsail',
  'zstd --test --no-progress "$bundle_path"',
  'zstd --test --no-progress "$source_path"',
  'sha256sum --check "$BUNDLE_BASENAME.sha256"',
  'sha256sum --check "$SOURCE_BASENAME.sha256"',
  "(.[0].Config.Env // [])",
  '(.[0].Config.ExposedPorts | keys) == ["3000/tcp"]',
  '(.[0].Config.ExposedPorts | keys) == ["3101/tcp"]',
  "(.[0].Config.ExposedPorts // {} | length) == 0",
  ".[0].Config.Healthcheck.Timeout == 10000000000",
  '.[0].Config.Healthcheck.Test[0:3] == ["CMD", "node", "-e"]',
  '(.[0].Config.Healthcheck.Test[3] | contains("/api/health"))',
  "Exercise the constrained web liveness contract",
  "--memory 256m",
  "--cpus 0.75",
  "--env NODE_OPTIONS=--max-old-space-size=192",
  '.[0].State.Health.Status == "healthy"',
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
  "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3",
  "actions/attest@36051bcae73b7c2a8a6945a48cbf80953c6baa35 # v4",
  "- name: Attest bundle provenance",
  "- name: Require provenance success",
  "GitHub build provenance is required before bundle delivery or promotion.",
  "exit 1",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
  "REFUNDDESK_SANDBOX_ARTIFACT_BUCKET",
  "REFUNDDESK_SANDBOX_ARTIFACT_ACCESS_KEY_ID",
  "REFUNDDESK_SANDBOX_ARTIFACT_SECRET_ACCESS_KEY",
  'artifact_prefix="refunddesk-sandbox/releases/$REVISION"',
  'existing_count="$(jq \'[.Contents[]?] | length\' "$s3_listing")"',
  'remote_count="$(jq \'[.Contents[]?] | length\' <<<"$remote_listing")"',
  'if [[ "$existing_count" != "0" ]]',
  'if [[ "$remote_count" != "5" ]]',
  "for _ in {1..60}",
  "The temporary bucket credential did not propagate within ten minutes.",
  'for artifact_file in "${upload_order[@]}"',
  "--sse AES256",
  "cleanup_partial_upload",
  "retention-days: 1",
  "compression-level: 0",
  "dist/sandbox-images/*.tar.zst",
];

for (const fragment of requiredFragments) {
  if (!workflow.includes(fragment)) {
    throw new Error(`SANDBOX_IMAGE_WORKFLOW_CONTRACT_MISSING:${fragment}`);
  }
}

const sandboxCheckoutStep = namedStep(workflow, "Check out the exact event revision");
requireStepFragments(
  sandboxCheckoutStep,
  [
    "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "with:",
    "ref: ${{ github.sha }}",
    "fetch-depth: 1",
    "persist-credentials: false",
  ],
  "SANDBOX_EXACT_CHECKOUT_STEP_INVALID",
);

const provenanceStep = namedStep(workflow, "Attest bundle provenance");
requireStepFragments(
  provenanceStep,
  [
    "id: provenance",
    "uses: actions/attest@36051bcae73b7c2a8a6945a48cbf80953c6baa35 # v4",
    "with:",
    "subject-path: dist/sandbox-images/*.tar.zst",
  ],
  "SANDBOX_PROVENANCE_STEP_INVALID",
);
if (provenanceStep.includes("continue-on-error:")) {
  throw new Error("SANDBOX_PROVENANCE_STEP_MUST_FAIL_CLOSED");
}

const provenanceGateStep = namedStep(workflow, "Require provenance success");
requireStepFragments(
  provenanceGateStep,
  [
    "if: ${{ always() && !cancelled() }}",
    "PROVENANCE_OUTCOME: ${{ steps.provenance.outcome }}",
    'if [[ "$PROVENANCE_OUTCOME" = "success" ]]; then',
    "GitHub build provenance is required before bundle delivery or promotion.",
    "exit 1",
  ],
  "SANDBOX_PROVENANCE_GATE_STEP_INVALID",
);

const provenanceStepIndex = workflow.indexOf("      - name: Attest bundle provenance");
const provenanceGateIndex = workflow.indexOf("      - name: Require provenance success");
const bundleCreationStepIndex = workflow.indexOf(
  "      - name: Create one checksummed image bundle",
);
if (bundleCreationStepIndex < 0 || bundleCreationStepIndex >= provenanceStepIndex) {
  throw new Error("SANDBOX_PROVENANCE_PRECEDES_VERIFIED_BUNDLE");
}
if (provenanceStepIndex >= provenanceGateIndex) {
  throw new Error("SANDBOX_PROVENANCE_GATE_PRECEDES_ATTESTATION");
}
for (const deliveryStepName of [
  "Deliver verified bundle to the private sandbox bucket",
  "Upload one-day sandbox bundle to GitHub",
]) {
  if (workflow.indexOf(`      - name: ${deliveryStepName}`) <= provenanceGateIndex) {
    throw new Error(`SANDBOX_DELIVERY_PRECEDES_PROVENANCE_GATE:${deliveryStepName}`);
  }
}

const requiredCiFragments = [
  "workflow_dispatch:",
  "- name: Check out the exact event revision",
  "ref: ${{ github.sha }}",
  "fetch-depth: 1",
  "persist-credentials: false",
  "- name: Verify the exact event revision",
  "EXPECTED_REVISION: ${{ github.sha }}",
  'actual_revision="$(git rev-parse HEAD)"',
  'test "$actual_revision" = "$EXPECTED_REVISION"',
  "postflight-windows:",
  "runs-on: windows-2025",
  "- name: Check out the exact Windows event revision",
  "- name: Validate Windows postflight transport contracts",
  "node --test scripts/validate-lightsail-postflight.test.mjs",
  "scripts/invoke-lightsail-postflight.contract.Tests.ps1",
];

for (const fragment of requiredCiFragments) {
  if (!ciWorkflow.includes(fragment)) {
    throw new Error(`CI_WORKFLOW_EXACT_REVISION_CONTRACT_MISSING:${fragment}`);
  }
}

const ciCheckoutStep = namedStep(ciWorkflow, "Check out the exact event revision");
requireStepFragments(
  ciCheckoutStep,
  [
    "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "with:",
    "ref: ${{ github.sha }}",
    "fetch-depth: 1",
    "persist-credentials: false",
  ],
  "CI_EXACT_CHECKOUT_STEP_INVALID",
);

const ciRevisionStep = namedStep(ciWorkflow, "Verify the exact event revision");
requireStepFragments(
  ciRevisionStep,
  [
    "EXPECTED_REVISION: ${{ github.sha }}",
    'actual_revision="$(git rev-parse HEAD)"',
    'test "$actual_revision" = "$EXPECTED_REVISION"',
  ],
  "CI_EXACT_REVISION_STEP_INVALID",
);

if (
  !workflow.includes('for image in "$WEB_IMAGE" "$WORKER_IMAGE" "$MIGRATE_IMAGE"') ||
  !workflow.includes(`docker image inspect --format '{{.Config.User}}' "$image"`)
) {
  throw new Error("SANDBOX_IMAGE_NONROOT_CHECK_MISSING");
}

const workerInspectPrefix = 'docker image inspect "$WORKER_IMAGE" |';
const workerInspectBlocks = workflow
  .split(workerInspectPrefix)
  .slice(1)
  .map((suffix) => {
    const terminator = suffix.indexOf(">/dev/null");
    return terminator === -1 ? null : suffix.slice(0, terminator);
  })
  .filter((block) => block !== null);
const workerHealthContract = workerInspectBlocks.find((block) =>
  block.includes(".Config.Healthcheck"),
);
const expectedWorkerHealthCommand =
  `expected_worker_health_command="const port=process.env.WORKER_HEALTH_PORT||'3101';` +
  `const host=(process.env.WORKER_HEALTH_HOST||'127.0.0.1').includes(':')?'[::1]':'127.0.0.1';` +
  `fetch('http://'+host+':'+port+'/health').then(r=>{if(!r.ok)process.exit(1)})` +
  `.catch(()=>process.exit(1))"`;
const requiredWorkerHealthFragments = [
  '--arg expected_command "$expected_worker_health_command"',
  ".[0].Config.Healthcheck.Interval == 30000000000",
  ".[0].Config.Healthcheck.Timeout == 10000000000",
  ".[0].Config.Healthcheck.StartPeriod == 20000000000",
  ".[0].Config.Healthcheck.Retries == 3",
  "(.[0].Config.Healthcheck.Test | length) == 4",
  '.[0].Config.Healthcheck.Test == ["CMD", "node", "-e", $expected_command]',
];
if (
  !workflow.includes(expectedWorkerHealthCommand) ||
  workerHealthContract === undefined ||
  requiredWorkerHealthFragments.some((fragment) => !workerHealthContract.includes(fragment))
) {
  throw new Error("SANDBOX_WORKER_HEALTHCHECK_CONTRACT_MISSING");
}

const prefixEmptyGuard = workflow.indexOf('if [[ "$existing_count" != "0" ]]');
const partialCleanupTrap = workflow.indexOf("trap cleanup_partial_upload EXIT");
if (prefixEmptyGuard < 0 || partialCleanupTrap < 0 || partialCleanupTrap < prefixEmptyGuard) {
  throw new Error("SANDBOX_IMAGE_PREFIX_CLEANUP_ORDER_INVALID");
}

const forbiddenPatterns = [
  { name: "scheduled_or_push_trigger", pattern: /^\s{2}(?:push|pull_request|schedule):/mu },
  { name: "invalid_git_ls_tree_option", pattern: /git ls-tree --recursive/u },
  { name: "lightsail_omitted_key_count", pattern: /--query ['"]KeyCount['"]/u },
  { name: "registry_login", pattern: /docker\/login-action|docker\s+login/iu },
  { name: "registry_push", pattern: /docker\s+(?:image\s+)?push|push-to-registry:\s*true/iu },
  { name: "ghcr_reference", pattern: /ghcr\.io/iu },
  { name: "soft_provenance_gate", pattern: /continue-on-error:\s*true/u },
];

for (const { name, pattern } of forbiddenPatterns) {
  if (pattern.test(workflow)) {
    throw new Error(`SANDBOX_IMAGE_WORKFLOW_FORBIDDEN:${name}`);
  }
}
if (/^\s*uses:\s+\S+@(?![0-9a-f]{40}(?:\s+#|$))/mu.test(workflow)) {
  throw new Error("SANDBOX_IMAGE_WORKFLOW_UNPINNED_ACTION");
}

const expectedSecretReferences = [
  "REFUNDDESK_SANDBOX_ARTIFACT_ACCESS_KEY_ID",
  "REFUNDDESK_SANDBOX_ARTIFACT_BUCKET",
  "REFUNDDESK_SANDBOX_ARTIFACT_SECRET_ACCESS_KEY",
];
const secretReferences = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/gu)]
  .map((match) => match[1])
  .sort();
if (JSON.stringify(secretReferences) !== JSON.stringify(expectedSecretReferences)) {
  throw new Error("SANDBOX_IMAGE_WORKFLOW_SECRET_SCOPE_INVALID");
}

process.stdout.write(
  `${JSON.stringify({ component: "sandbox-image-workflow", status: "valid" })}\n`,
);
