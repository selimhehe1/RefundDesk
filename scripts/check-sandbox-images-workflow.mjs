import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL("../.github/workflows/sandbox-images.yml", import.meta.url),
  "utf8",
);

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
  'git archive --format=tar "$REVISION" deploy/lightsail',
  'zstd --test --no-progress "$bundle_path"',
  'zstd --test --no-progress "$source_path"',
  'sha256sum --check "$BUNDLE_BASENAME.sha256"',
  'sha256sum --check "$SOURCE_BASENAME.sha256"',
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
  "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3",
  "actions/attest@36051bcae73b7c2a8a6945a48cbf80953c6baa35 # v4",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4",
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
  !workflow.includes('for image in "$WEB_IMAGE" "$WORKER_IMAGE" "$MIGRATE_IMAGE"') ||
  !workflow.includes(`docker image inspect --format '{{.Config.User}}' "$image"`)
) {
  throw new Error("SANDBOX_IMAGE_NONROOT_CHECK_MISSING");
}

const forbiddenPatterns = [
  { name: "scheduled_or_push_trigger", pattern: /^\s{2}(?:push|pull_request|schedule):/mu },
  { name: "secret_context", pattern: /\$\{\{\s*secrets\./u },
  { name: "registry_login", pattern: /docker\/login-action|docker\s+login/iu },
  { name: "registry_push", pattern: /docker\s+(?:image\s+)?push|push-to-registry:\s*true/iu },
  { name: "ghcr_reference", pattern: /ghcr\.io/iu },
];

for (const { name, pattern } of forbiddenPatterns) {
  if (pattern.test(workflow)) {
    throw new Error(`SANDBOX_IMAGE_WORKFLOW_FORBIDDEN:${name}`);
  }
}
if (/^\s*uses:\s+\S+@(?![0-9a-f]{40}(?:\s+#|$))/mu.test(workflow)) {
  throw new Error("SANDBOX_IMAGE_WORKFLOW_UNPINNED_ACTION");
}

process.stdout.write(
  `${JSON.stringify({ component: "sandbox-image-workflow", status: "valid" })}\n`,
);
