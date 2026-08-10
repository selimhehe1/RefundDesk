import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL("../.github/workflows/sandbox-images.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
const operatorDockerfile = await readFile(
  new URL("../deploy/lightsail/edge-operator.Dockerfile", import.meta.url),
  "utf8",
);
const operatorDockerignore = await readFile(
  new URL("../deploy/lightsail/edge-operator.Dockerfile.dockerignore", import.meta.url),
  "utf8",
);

const operatorSourcePaths = Object.freeze([
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
]);
const expectedOperatorDockerignoreRules = Object.freeze([
  "**",
  "!.dockerignore",
  "!.github/",
  "!.github/workflows/",
  "!.github/workflows/sandbox-images.yml",
  "!deploy/",
  "!deploy/lightsail/",
  "!deploy/lightsail/Caddyfile.public",
  "!deploy/lightsail/compose.yml",
  "!deploy/lightsail/edge-operator.Dockerfile",
  "!deploy/lightsail/edge-operator.Dockerfile.dockerignore",
  "!deploy/lightsail/scripts/",
  "!deploy/lightsail/scripts/_common.sh",
  "!deploy/lightsail/scripts/observe-host-postflight.sh",
  "!deploy/lightsail/scripts/prove-bounded-edge-window.sh",
  "!deploy/lightsail/scripts/recover-quiesced-runtime.sh",
  "!deploy/lightsail/scripts/release.sh",
  "!deploy/lightsail/scripts/refunddesk-edge-operator.sh",
  "!deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh",
  "!deploy/lightsail/systemd/",
  "!deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service",
  "!deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer",
  "!docs/",
  "!docs/adr/",
  "!docs/adr/0037-bounded-cloudfront-origin-window.md",
  "!docs/schemas/",
  "!docs/schemas/refunddesk-edge-operator-image-v1.schema.json",
  "!docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json",
  "!docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json",
  "!docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json",
  "!docs/schemas/refunddesk-lightsail-postflight-v1.schema.json",
  "!scripts/",
  "!scripts/check-sandbox-images-workflow.mjs",
  "!scripts/invoke-lightsail-edge-window.ps1",
  "!scripts/invoke-lightsail-postflight.ps1",
  "!scripts/submit-lightsail-edge-window-checkpoint.ps1",
  "!scripts/validate-edge-operator-image.mjs",
  "!scripts/validate-lightsail-contained-promotion.mjs",
  "!scripts/validate-lightsail-edge-window.mjs",
  "!scripts/validate-lightsail-incident-admission.mjs",
  "!scripts/validate-lightsail-postflight.mjs",
]);

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
  "refunddesk-edge-operator:sandbox-$actual_revision",
  "deploy/lightsail/edge-operator.Dockerfile",
  "deploy/lightsail/edge-operator.Dockerfile.dockerignore",
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
  "20260808T000000Z",
  "- name: Build the exact-revision edge operator image",
  "- name: Prove the edge operator build context is deny-by-default",
  "- name: Verify edge watchdog systemd units",
  "- name: Inspect the edge operator image boundary",
  "10001:10001",
  "--network none",
  "--read-only",
  "--cap-drop ALL",
  "--security-opt no-new-privileges",
  "refunddesk-edge-operator-${actual_revision}.docker.tar.zst",
  "validate-edge-operator-image.mjs",
  "- name: Attest edge operator provenance",
  "dist/sandbox-images/edge-operator/*.tar.zst",
  "- name: Materialize edge operator attestation bundle",
  "- name: Materialize edge operator input provenance",
  "refunddesk-edge-operator-${actual_revision}.provenance.json",
  "refunddesk-edge-operator-input-provenance",
  "dockerfileIgnoreSha256:$dockerfile_ignore_sha256",
  "github-actions-attestation-bundle-issued",
  "workflowRunAttempt:$workflowRunAttempt",
  "refunddesk-sandbox/edge-operator/$REVISION",
  "exactly five edge-operator objects",
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
  'remote_count="$(jq \'[.Contents[]?] | length\' <<<"$remote_listing")"',
  'if [[ "$remote_count" != "5" ]]',
  "for _ in {1..60}",
  "The temporary bucket credential did not propagate within ten minutes.",
  'for artifact_file in "${upload_order[@]}"',
  "--sse AES256",
  "--checksum-algorithm SHA256",
  "Existing runtime object differs from the exact local bytes.",
  "Existing edge object differs from the exact local bytes.",
  "The exact five-file bundle was delivered or resumed byte-identically",
  "The exact five-file edge-operator artifact was delivered or resumed byte-identically",
  "retention-days: 1",
  "compression-level: 0",
  "dist/sandbox-images/*.tar.zst",
];

for (const fragment of requiredFragments) {
  if (!workflow.includes(fragment)) {
    throw new Error(`SANDBOX_IMAGE_WORKFLOW_CONTRACT_MISSING:${fragment}`);
  }
}

if (
  !operatorDockerfile.startsWith(
    "# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e\n",
  )
) {
  throw new Error("EDGE_OPERATOR_DOCKERFILE_FRONTEND_INVALID");
}

const actualOperatorDockerignoreRules = operatorDockerignore.split(/\r?\n/u);
if (actualOperatorDockerignoreRules.at(-1) === "") actualOperatorDockerignoreRules.pop();
if (
  JSON.stringify(actualOperatorDockerignoreRules) !==
  JSON.stringify(expectedOperatorDockerignoreRules)
) {
  throw new Error("EDGE_OPERATOR_DOCKERIGNORE_RULES_INVALID");
}
const operatorDockerignoreFiles = actualOperatorDockerignoreRules
  .filter((rule) => rule.startsWith("!") && !rule.endsWith("/"))
  .map((rule) => rule.slice(1));
if (JSON.stringify(operatorDockerignoreFiles) !== JSON.stringify(operatorSourcePaths)) {
  throw new Error("EDGE_OPERATOR_DOCKERIGNORE_SOURCE_SCOPE_INVALID");
}

const operatorWorkspaceCopies = [
  ...operatorDockerfile.matchAll(/^COPY --chmod=(0(?:444|555)) (\S+) \/workspace\/(\S+)$/gmu),
];
const operatorWorkspaceCopySources = operatorWorkspaceCopies.map((match) => match[2]);
if (JSON.stringify(operatorWorkspaceCopySources) !== JSON.stringify(operatorSourcePaths)) {
  throw new Error("EDGE_OPERATOR_DOCKERFILE_SOURCE_SCOPE_INVALID");
}
for (const [, mode, source, destination] of operatorWorkspaceCopies) {
  const expectedMode = source.startsWith("deploy/lightsail/scripts/") ? "0555" : "0444";
  if (source !== destination || mode !== expectedMode) {
    throw new Error(`EDGE_OPERATOR_DOCKERFILE_COPY_INVALID:${source}`);
  }
}
if (/^(?:ADD|COPY)\s+(?:--\S+\s+)*\.\s+/mu.test(operatorDockerfile)) {
  throw new Error("EDGE_OPERATOR_DOCKERFILE_BROAD_COPY_INVALID");
}

for (const fragment of [
  ".github",
  "!.github/",
  ".github/*",
  "!.github/workflows/",
  ".github/workflows/*",
  "!.github/workflows/sandbox-images.yml",
]) {
  if (!dockerignore.split(/\r?\n/u).includes(fragment)) {
    throw new Error(`SANDBOX_IMAGE_DOCKERIGNORE_ALLOWLIST_INVALID:${fragment}`);
  }
}
const githubDockerignoreRules = dockerignore
  .split(/\r?\n/u)
  .filter((line) => /^!?\.github(?:\/|$)/u.test(line));
const exactGithubDockerignoreRules = [
  ".github",
  "!.github/",
  ".github/*",
  "!.github/workflows/",
  ".github/workflows/*",
  "!.github/workflows/sandbox-images.yml",
];
if (JSON.stringify(githubDockerignoreRules) !== JSON.stringify(exactGithubDockerignoreRules)) {
  throw new Error("SANDBOX_IMAGE_DOCKERIGNORE_GITHUB_SCOPE_INVALID");
}
if (
  (workflow.match(/docker run --rm --pull never --network none --read-only --cap-drop ALL/gu) ?? [])
    .length !== 2
) {
  throw new Error("EDGE_OPERATOR_PULL_NEVER_CARDINALITY_INVALID");
}
const workflowLines = workflow.split(/\r?\n/u);
for (let index = 0; index < workflowLines.length; index += 1) {
  if (/\bdocker run\b/u.test(workflowLines[index] ?? "")) {
    const invocationPrefix = workflowLines.slice(index, index + 3).join("\n");
    if (!invocationPrefix.includes("--pull never")) {
      throw new Error(`SANDBOX_IMAGE_DOCKER_RUN_PULL_POLICY_INVALID:${index + 1}`);
    }
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

const systemdUnitStep = namedStep(workflow, "Verify edge watchdog systemd units");
requireStepFragments(
  systemdUnitStep,
  [
    "set -euo pipefail",
    'test ! -e "$watchdog_install_path"',
    "trap cleanup_watchdog_install EXIT",
    "sudo install --mode=0555",
    "deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh",
    "systemd-analyze verify --recursive-errors=yes",
    "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service",
    "deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer",
  ],
  "EDGE_OPERATOR_SYSTEMD_VERIFY_STEP_INVALID",
);
if (
  systemdUnitStep.indexOf("deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service") >=
  systemdUnitStep.indexOf("deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer")
) {
  throw new Error("EDGE_OPERATOR_SYSTEMD_UNIT_ORDER_INVALID");
}

const contextProofStep = namedStep(
  workflow,
  "Prove the edge operator build context is deny-by-default",
);
requireStepFragments(
  contextProofStep,
  [
    'canary_path="deploy/lightsail/refunddesk-edge-context-arbitrary-canary-${REVISION}.txt"',
    'probe_ignore="${probe_dockerfile}.dockerignore"',
    'probe_root="$(mktemp -d "$RUNNER_TEMP/refunddesk-edge-context-probe.XXXXXX")"',
    "trap cleanup_context_probe EXIT",
    "deploy/lightsail/edge-operator.Dockerfile.dockerignore",
    "cp --no-clobber",
    "COPY deploy/lightsail/edge-operator.Dockerfile.dockerignore /allowed",
    '--output "type=local,dest=$positive_output"',
    "cmp --silent",
    '"COPY $canary_path /forbidden"',
    "if docker buildx build",
    '--output "type=local,dest=$negative_output"',
    'grep --fixed-strings --quiet -- "$canary_path" "$negative_log"',
    "not found|excluded by \\.dockerignore",
    'test ! -e "$negative_output/forbidden"',
  ],
  "EDGE_OPERATOR_CONTEXT_PROOF_STEP_INVALID",
);
if (
  (contextProofStep.match(/\bdocker buildx build\b/gu) ?? []).length !== 2 ||
  contextProofStep.includes("continue-on-error:") ||
  contextProofStep.includes("|| true")
) {
  throw new Error("EDGE_OPERATOR_CONTEXT_PROOF_FAIL_CLOSED_INVALID");
}
const systemdUnitStepIndex = workflow.indexOf("      - name: Verify edge watchdog systemd units");
const buildxSetupStepIndex = workflow.indexOf("      - name: Set up Docker Buildx");
const contextProofStepIndex = workflow.indexOf(
  "      - name: Prove the edge operator build context is deny-by-default",
);
const edgeBuildStepIndex = workflow.indexOf(
  "      - name: Build the exact-revision edge operator image",
);
if (
  systemdUnitStepIndex < 0 ||
  buildxSetupStepIndex <= systemdUnitStepIndex ||
  contextProofStepIndex <= buildxSetupStepIndex ||
  edgeBuildStepIndex <= contextProofStepIndex
) {
  throw new Error("EDGE_OPERATOR_PREFLIGHT_ORDER_INVALID");
}

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

const edgeProvenanceStep = namedStep(workflow, "Attest edge operator provenance");
requireStepFragments(
  edgeProvenanceStep,
  [
    "id: edge_provenance",
    "uses: actions/attest@36051bcae73b7c2a8a6945a48cbf80953c6baa35 # v4",
    "with:",
    "subject-path: dist/sandbox-images/edge-operator/*.tar.zst",
  ],
  "EDGE_OPERATOR_PROVENANCE_STEP_INVALID",
);
if (edgeProvenanceStep.includes("continue-on-error:")) {
  throw new Error("EDGE_OPERATOR_PROVENANCE_STEP_MUST_FAIL_CLOSED");
}

const edgeAttestationStep = namedStep(workflow, "Materialize edge operator attestation bundle");
requireStepFragments(
  edgeAttestationStep,
  [
    "EDGE_ATTESTATION_BUNDLE_PATH: ${{ steps.edge_provenance.outputs.bundle-path }}",
    "cp --no-clobber",
    "$EDGE_OPERATOR_ATTESTATION_BASENAME",
  ],
  "EDGE_OPERATOR_ATTESTATION_MATERIALIZATION_INVALID",
);

const provenanceGateStep = namedStep(workflow, "Require provenance success");
requireStepFragments(
  provenanceGateStep,
  [
    "if: ${{ always() && !cancelled() }}",
    "EDGE_PROVENANCE_OUTCOME: ${{ steps.edge_provenance.outcome }}",
    "PROVENANCE_OUTCOME: ${{ steps.provenance.outcome }}",
    'if [[ "$PROVENANCE_OUTCOME" = "success" && "$EDGE_PROVENANCE_OUTCOME" = "success" ]]; then',
    "GitHub build provenance is required before bundle delivery or promotion.",
    "exit 1",
  ],
  "SANDBOX_PROVENANCE_GATE_STEP_INVALID",
);

const provenanceStepIndex = workflow.indexOf("      - name: Attest bundle provenance");
const edgeProvenanceStepIndex = workflow.indexOf("      - name: Attest edge operator provenance");
const edgeAttestationStepIndex = workflow.indexOf(
  "      - name: Materialize edge operator attestation bundle",
);
const edgeInputProvenanceStepIndex = workflow.indexOf(
  "      - name: Materialize edge operator input provenance",
);
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
if (
  edgeProvenanceStepIndex <= provenanceStepIndex ||
  edgeAttestationStepIndex <= edgeProvenanceStepIndex ||
  edgeInputProvenanceStepIndex <= edgeAttestationStepIndex ||
  edgeInputProvenanceStepIndex >= provenanceGateIndex
) {
  throw new Error("EDGE_OPERATOR_PROVENANCE_ORDER_INVALID");
}
const edgeArchiveCreationIndex = workflow.indexOf('docker image save "$EDGE_OPERATOR_IMAGE"');
const edgeChecksumCreationIndex = workflow.indexOf(
  'sha256sum "$EDGE_OPERATOR_ARCHIVE_BASENAME" > "$EDGE_OPERATOR_ARCHIVE_BASENAME.sha256"',
);
const edgeManifestCompletionIndex = workflow.indexOf(
  'edge_manifest_sha256="$(sha256sum "$edge_manifest_path"',
);
if (
  edgeArchiveCreationIndex < 0 ||
  edgeChecksumCreationIndex <= edgeArchiveCreationIndex ||
  edgeManifestCompletionIndex <= edgeChecksumCreationIndex ||
  edgeProvenanceStepIndex <= edgeManifestCompletionIndex ||
  edgeAttestationStepIndex <= edgeProvenanceStepIndex ||
  edgeInputProvenanceStepIndex <= edgeAttestationStepIndex
) {
  throw new Error("EDGE_OPERATOR_ARTIFACT_CREATION_ORDER_INVALID");
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
  "node --test scripts/validate-lightsail-containment-reconciliation.test.mjs",
  "node --test scripts/validate-lightsail-contained-promotion.test.mjs",
  "node --test scripts/validate-lightsail-incident-admission.test.mjs",
  "node --test scripts/validate-lightsail-edge-window.test.mjs",
  "node --test scripts/validate-edge-operator-image.test.mjs",
  "scripts/invoke-lightsail-postflight.contract.Tests.ps1",
  "scripts/invoke-lightsail-containment-reconciliation.contract.Tests.ps1",
  "scripts/invoke-lightsail-contained-promotion.contract.Tests.ps1",
  "scripts/invoke-lightsail-incident-admission.contract.Tests.ps1",
  "scripts/invoke-lightsail-edge-window.contract.Tests.ps1",
  "- name: Preload exact Caddy origin-contract image",
  "- name: Exercise exact Caddy origin contract without network",
  "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
  'docker pull "$CADDY_IMAGE"',
  "deploy/lightsail/scripts/test-caddy-origin-contract.sh",
  '--caddyfile "$PWD/deploy/lightsail/Caddyfile.public"',
  "REFUNDDESK_EDGE_ORIGIN_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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

const ciWindowsCheckoutStep = namedStep(ciWorkflow, "Check out the exact Windows event revision");
requireStepFragments(
  ciWindowsCheckoutStep,
  [
    "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    "with:",
    "ref: ${{ github.sha }}",
    "fetch-depth: 1",
    "persist-credentials: false",
  ],
  "CI_WINDOWS_EXACT_CHECKOUT_STEP_INVALID",
);

const ciWindowsContractsStep = namedStep(
  ciWorkflow,
  "Validate Windows postflight transport contracts",
);
requireStepFragments(
  ciWindowsContractsStep,
  [
    "node --test scripts/validate-lightsail-postflight.test.mjs",
    "node --test scripts/validate-lightsail-containment-reconciliation.test.mjs",
    "node --test scripts/validate-lightsail-contained-promotion.test.mjs",
    "node --test scripts/validate-lightsail-incident-admission.test.mjs",
    "node --test scripts/validate-lightsail-edge-window.test.mjs",
    "node --test scripts/validate-edge-operator-image.test.mjs",
    "scripts/invoke-lightsail-postflight.contract.Tests.ps1",
    "scripts/invoke-lightsail-containment-reconciliation.contract.Tests.ps1",
    "scripts/invoke-lightsail-contained-promotion.contract.Tests.ps1",
    "scripts/invoke-lightsail-incident-admission.contract.Tests.ps1",
    "scripts/invoke-lightsail-edge-window.contract.Tests.ps1",
  ],
  "CI_WINDOWS_OPERATOR_CONTRACT_STEP_INVALID",
);

const ciCaddyPreloadStep = namedStep(ciWorkflow, "Preload exact Caddy origin-contract image");
requireStepFragments(
  ciCaddyPreloadStep,
  [
    "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
    'docker pull "$CADDY_IMAGE"',
    "docker image inspect --format '{{.Id}}' -- \"$CADDY_IMAGE\"",
  ],
  "CI_CADDY_PRELOAD_STEP_INVALID",
);

const ciCaddyContractStep = namedStep(
  ciWorkflow,
  "Exercise exact Caddy origin contract without network",
);
requireStepFragments(
  ciCaddyContractStep,
  [
    "EXPECTED_REVISION: ${{ github.sha }}",
    "REFUNDDESK_EDGE_ORIGIN_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "deploy/lightsail/scripts/test-caddy-origin-contract.sh",
    '--revision "$EXPECTED_REVISION"',
    '--caddyfile "$PWD/deploy/lightsail/Caddyfile.public"',
  ],
  "CI_CADDY_ORIGIN_CONTRACT_STEP_INVALID",
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

const runtimeManifestUpload = workflow.indexOf(
  '"$MANIFEST_BASENAME"',
  workflow.indexOf("upload_order=("),
);
const runtimeBundleUpload = workflow.indexOf(
  '"$BUNDLE_BASENAME"',
  workflow.indexOf("upload_order=("),
);
if (runtimeBundleUpload < 0 || runtimeManifestUpload <= runtimeBundleUpload) {
  throw new Error("SANDBOX_IMAGE_RECOVERABLE_COMMIT_ORDER_INVALID");
}
const edgeUploadOrderMatch = workflow.match(
  /edge_upload_order=\(\r?\n((?:\s+"[^"]+"\r?\n)+)\s+\)/u,
);
if (edgeUploadOrderMatch === null) {
  throw new Error("EDGE_OPERATOR_UPLOAD_ORDER_INVALID");
}
const edgeUploadOrder = [...edgeUploadOrderMatch[1].matchAll(/^\s+"([^"]+)"$/gmu)].map(
  (match) => match[1],
);
const expectedEdgeUploadOrder = [
  "$EDGE_OPERATOR_ARCHIVE_BASENAME",
  "$EDGE_OPERATOR_ARCHIVE_BASENAME.sha256",
  "$EDGE_OPERATOR_MANIFEST_BASENAME",
  "$EDGE_OPERATOR_ATTESTATION_BASENAME",
  "$EDGE_OPERATOR_PROVENANCE_BASENAME",
];
if (JSON.stringify(edgeUploadOrder) !== JSON.stringify(expectedEdgeUploadOrder)) {
  throw new Error("EDGE_OPERATOR_UPLOAD_ORDER_INVALID");
}

const forbiddenPatterns = [
  { name: "scheduled_or_push_trigger", pattern: /^\s{2}(?:push|pull_request|schedule):/mu },
  { name: "invalid_git_ls_tree_option", pattern: /git ls-tree --recursive/u },
  { name: "lightsail_omitted_key_count", pattern: /--query ['"]KeyCount['"]/u },
  { name: "registry_login", pattern: /docker\/login-action|docker\s+login/iu },
  { name: "registry_push", pattern: /docker\s+(?:image\s+)?push|push-to-registry:\s*true/iu },
  { name: "ghcr_reference", pattern: /ghcr\.io/iu },
  { name: "soft_provenance_gate", pattern: /continue-on-error:\s*true/u },
  { name: "published_object_deletion", pattern: /aws\s+s3\s+rm|delete-object|delete-objects/iu },
  { name: "partial_upload_cleanup", pattern: /cleanup_partial_upload/iu },
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
