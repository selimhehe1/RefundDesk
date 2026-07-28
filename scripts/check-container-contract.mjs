import { readFile } from "node:fs/promises";

const [dockerfile, dockerignore, gitignore] = await Promise.all([
  readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
  readFile(new URL("../.gitignore", import.meta.url), "utf8"),
]);

const requiredDockerfileFragments = [
  "ARG NODE_IMAGE=node:24.18.0-bookworm-slim",
  "corepack prepare pnpm@11.17.0 --activate",
  "FROM runtime-base AS web",
  "FROM runtime-base AS worker",
  "FROM runtime-base AS migrate",
  "FROM web AS default",
  "pnpm install --prod --frozen-lockfile --ignore-scripts",
  "ENV COREPACK_HOME=/opt/corepack",
  "ENV COREPACK_ENABLE_NETWORK=0",
  'CMD ["node", "apps/platform/server.js"]',
  'CMD ["node", "--enable-source-maps", "dist/apps/worker/src/main.js"]',
  'CMD ["node", "scripts/database-command.mjs", "release-prepare"]',
];
const requiredIgnoreFragments = [
  ".git",
  "**/node_modules",
  "**/.next",
  "**/dist",
  ".env.*",
  "*.env.local",
  "phase-0-evidence.local",
  "sandbox-evidence.local",
  "stripe-fixtures.local.json",
  "apps/stripe-app/stripe-app.local.json",
];

for (const fragment of requiredDockerfileFragments) {
  if (!dockerfile.includes(fragment)) {
    throw new Error("CONTAINER_DOCKERFILE_CONTRACT_MISSING");
  }
}
function dockerStage(target) {
  const header = new RegExp(`^FROM [^\\r\\n]+ AS ${target}\\r?$`, "mu").exec(dockerfile);
  if (header === null) {
    return undefined;
  }
  const remaining = dockerfile.slice(header.index + header[0].length);
  const nextStage = remaining.search(/\r?\nFROM /u);
  return nextStage === -1 ? remaining : remaining.slice(0, nextStage);
}

for (const [target, parent] of [
  ["web", "runtime-base"],
  ["worker", "runtime-base"],
  ["migrate", "runtime-base"],
]) {
  if (!new RegExp(`^FROM ${parent} AS ${target}\\r?$`, "mu").test(dockerfile)) {
    throw new Error("CONTAINER_TARGET_PARENT_CONTRACT_MISSING");
  }
  const stage = dockerStage(target);
  if (stage === undefined || !/^USER node$/mu.test(stage)) {
    throw new Error("CONTAINER_NONROOT_TARGET_CONTRACT_MISSING");
  }
}
if (!/^FROM web AS default\r?$/mu.test(dockerfile)) {
  throw new Error("CONTAINER_SAFE_DEFAULT_TARGET_MISSING");
}
const migrateStage = dockerStage("migrate");
if (
  migrateStage === undefined ||
  !migrateStage.includes('ENTRYPOINT ["/usr/bin/tini", "-g", "--"]') ||
  /COPY\s+--from=[^\r\n]+\s+\/workspace\/?\s+/u.test(migrateStage)
) {
  throw new Error("CONTAINER_MIGRATOR_BOUNDARY_INVALID");
}
for (const fragment of requiredIgnoreFragments) {
  if (!dockerignore.includes(fragment)) {
    throw new Error("CONTAINER_IGNORE_CONTRACT_MISSING");
  }
}
if (!gitignore.includes("*.env.local")) {
  throw new Error("GIT_LOCAL_ENVIRONMENT_IGNORE_CONTRACT_MISSING");
}
if (/^\s*(?:ARG|ENV)\s+.*(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|STRIPE_.*KEY)/imu.test(dockerfile)) {
  throw new Error("CONTAINER_BUILD_SECRET_DECLARATION_FORBIDDEN");
}

process.stdout.write(`${JSON.stringify({ component: "container-contract", status: "valid" })}\n`);
