import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

async function read(name) {
  return readFile(resolve(directory, name), "utf8");
}

function serviceBlock(compose, name) {
  const startMarker = `  ${name}:\n`;
  const start = compose.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${name} service`);
  const remainder = compose.slice(start + startMarker.length);
  const nextService = remainder.search(/^ {2}[a-z][a-z0-9-]*:\n/gmu);
  return nextService === -1 ? remainder : remainder.slice(0, nextService);
}

function environmentNames(source) {
  return new Set(
    source
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("="))),
  );
}

test("runtime topology publishes only the public Caddy ports", async () => {
  const compose = await read("compose.yml");
  assert.match(compose, /^name: refunddesk$/mu);
  assert.match(compose, /image: postgres:18\.4-bookworm/u);
  assert.equal((compose.match(/image: caddy:2\.11\.4-alpine/gu) ?? []).length, 2);
  assert.doesNotMatch(compose, /^\s{4}build:/mu, "the 1 GiB host must never build images");

  for (const service of ["postgres", "bootstrap", "migrate", "worker", "verifier", "web"]) {
    assert.doesNotMatch(serviceBlock(compose, service), /^\s{4}ports:/mu);
  }
  const publicCaddy = serviceBlock(compose, "caddy");
  assert.match(publicCaddy, /^\s{4}ports:\n\s{6}- "80:8080"\n\s{6}- "443:8443"$/mu);
});

test("web and worker have disjoint database and verifier networks", async () => {
  const compose = await read("compose.yml");
  const web = serviceBlock(compose, "web");
  const worker = serviceBlock(compose, "worker");
  const migrate = serviceBlock(compose, "migrate");
  const bootstrap = serviceBlock(compose, "bootstrap");

  assert.match(web, /database-web:/u);
  assert.match(web, /verifier-front:/u);
  assert.match(web, /web-egress:/u);
  assert.doesNotMatch(web, /database-worker|database-migrate|verifier-back|worker-egress/u);
  assert.doesNotMatch(
    web,
    /depends_on:[\s\S]*?\bverifier:/u,
    "webhook ingestion must start independently of the verifier and worker",
  );

  assert.match(worker, /database-worker:/u);
  assert.match(worker, /verifier-back:/u);
  assert.match(worker, /worker-egress:/u);
  assert.doesNotMatch(worker, /database-web|database-migrate|verifier-front|web-egress/u);

  assert.match(migrate, /- database-migrate/u);
  assert.match(migrate, /^\s{4}read_only: true$/mu);
  assert.doesNotMatch(migrate, /database-web|database-worker|egress|verifier-/u);
  assert.match(bootstrap, /- database-migrate/u);
  assert.doesNotMatch(bootstrap, /database-web|database-worker|egress|verifier-/u);

  for (const network of [
    "edge",
    "verifier-front",
    "verifier-back",
    "database-web",
    "database-worker",
    "database-migrate",
  ]) {
    assert.match(
      compose,
      new RegExp(`  ${network}:\\n    driver: bridge\\n    internal: true`, "u"),
    );
  }
});

test("TLS names and ingress deny rules are explicit", async () => {
  const [compose, publicCaddy, verifierCaddy, platform, worker, migration] = await Promise.all([
    read("compose.yml"),
    read("Caddyfile.public"),
    read("Caddyfile.verifier"),
    read("platform.env.example"),
    read("worker.env.example"),
    read("migration.env.example"),
  ]);

  assert.match(compose, /postgres\.refunddesk\.internal/gu);
  assert.match(platform, /sslmode=verify-full/u);
  assert.match(worker, /sslmode=verify-full/gu);
  assert.match(migration, /sslmode=verify-full/gu);
  assert.match(
    platform,
    /https:\/\/verifier\.refunddesk\.internal:8443\/internal\/v1\/signed-requests\/verify/u,
  );
  assert.match(
    publicCaddy,
    /@blocked path \/internal \/internal\/\* \/api\/ready \/api\/webhooks\/stripe-connected\/live/u,
  );
  assert.match(verifierCaddy, /https:\/\/verifier\.refunddesk\.internal:8443/u);
  assert.match(verifierCaddy, /method POST\s+path \/internal\/v1\/signed-requests\/verify/u);
  assert.equal(
    (verifierCaddy.match(/reverse_proxy/gu) ?? []).length,
    1,
    "verifier must have one exact upstream",
  );
});

test("environment examples preserve authority separation and disable live", async () => {
  const [
    compose,
    platformSource,
    workerSource,
    migrationSource,
    postgresSource,
    bootstrapSql,
    bootstrapScript,
  ] = await Promise.all([
    read("compose.yml"),
    read("platform.env.example"),
    read("worker.env.example"),
    read("migration.env.example"),
    read("postgres.env.example"),
    read("10-bootstrap-roles.sql"),
    read("scripts/bootstrap-roles.sh"),
  ]);
  const platform = environmentNames(platformSource);
  const worker = environmentNames(workerSource);
  const migration = environmentNames(migrationSource);

  for (const forbidden of [
    "WORKER_DATABASE_URL",
    "PGBOSS_DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_APP_SIGNING_SECRET",
    "STRIPE_PLATFORM_TEST_EFFECT_KEY",
    "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    "REFUNDDESK_PROOF_HMAC_KEY_V1",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
  ]) {
    assert.equal(platform.has(forbidden), false, `platform contains ${forbidden}`);
  }
  for (const forbidden of [
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_PLATFORM_TEST_READ_KEY",
    "STRIPE_MANAGED_SANDBOX_READ_KEY",
    "STRIPE_CONNECTED_TEST_WEBHOOK_SECRET",
    "STRIPE_CONNECTED_SANDBOX_WEBHOOK_SECRET",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
    "REFUNDDESK_EXPORT_SIGNING_KEY_V1",
  ]) {
    assert.equal(worker.has(forbidden), false, `worker contains ${forbidden}`);
  }
  assert.deepEqual([...migration].sort(), [
    "DATABASE_MIGRATION_URL",
    "DATABASE_URL",
    "LOG_LEVEL",
    "NODE_ENV",
    "PGBOSS_DATABASE_URL",
    "WORKER_DATABASE_URL",
  ]);
  for (const source of [platformSource, workerSource, migrationSource]) {
    assert.doesNotMatch(source, /(?:sk|rk)_live_|STRIPE_PLATFORM_TEST_KEY=/u);
  }
  assert.match(platformSource, /^REFUNDDESK_GLOBAL_LIVE_ENABLED=false$/mu);
  assert.match(workerSource, /^REFUNDDESK_GLOBAL_LIVE_ENABLED=false$/mu);
  assert.match(platformSource, /^STRIPE_CONNECTED_LIVE_WEBHOOK_SECRET=disabled$/mu);
  assert.match(
    postgresSource,
    /^POSTGRES_PASSWORD_FILE=\/run\/secrets\/postgres-owner-password$/mu,
  );
  assert.doesNotMatch(
    postgresSource,
    /(?:^|_)(?:PASSWORD|WEB_PASSWORD|WORKER_PASSWORD|QUEUE_PASSWORD)=/mu,
  );
  assert.doesNotMatch(
    serviceBlock(compose, "postgres"),
    /docker-entrypoint-initdb\.d|postgres-(?:web|worker|queue)-password/u,
  );
  const bootstrap = serviceBlock(compose, "bootstrap");
  for (const name of ["owner", "web", "worker", "queue"]) {
    assert.match(bootstrap, new RegExp(`postgres-${name}-password`, "u"));
  }
  assert.match(bootstrapScript, /export PGSSLMODE=verify-full/u);
  assert.doesNotMatch(bootstrapSql, /\brefunddesk_(?:runtime|worker|queue|maintenance)\b/u);
  assert.doesNotMatch(bootstrapSql, /\brefunddesk_attestation_writer\b/u);
  assert.doesNotMatch(bootstrapSql, /^\s*(?:GRANT|REVOKE)\b/mu);
  assert.equal((bootstrapSql.match(/CREATE ROLE refunddesk_[a-z]+_login LOGIN/gu) ?? []).length, 3);
});

test("internal PKI provisioning is initial-only and preserves exact TLS identities", async () => {
  const provisionPki = await read("scripts/provision-internal-pki.sh");

  assert.match(provisionPki, /^readonly POSTGRES_DNS_NAME="postgres\.refunddesk\.internal"$/mu);
  assert.match(provisionPki, /^readonly VERIFIER_DNS_NAME="verifier\.refunddesk\.internal"$/mu);
  assert.match(provisionPki, /^readonly SERVER_VALID_DAYS=365$/mu);
  assert.match(provisionPki, /rsa_keygen_bits:3072/gu);
  assert.match(provisionPki, /extendedKeyUsage=serverAuth/gu);
  assert.match(provisionPki, /subjectAltName=DNS:\$\{dns_name\}/u);
  assert.match(provisionPki, /-verify_hostname "\$\{dns_name\}"/u);
  assert.match(
    provisionPki,
    /refusing to overwrite existing TLS material in \$\{TLS_ROOT\}\/\$\{name\}/u,
  );

  assert.match(provisionPki, /install -o 999 -g 999 -m 0400[\s\S]*postgres-server\.key/u);
  assert.match(provisionPki, /install -o 1000 -g 1000 -m 0400[\s\S]*verifier-server\.key/u);
  assert.match(
    provisionPki,
    /assert_file_metadata "\$\{root\}\/client\/refunddesk-ca-bundle\.crt" 0 0 444/u,
  );
  assert.match(
    provisionPki,
    /\/run must be tmpfs so CA private keys never reach persistent storage/u,
  );
  assert.match(provisionPki, /mktemp --directory \/run\/refunddesk-internal-pki\.XXXXXX/u);
  assert.match(
    provisionPki,
    /find "\$\{PRIVATE_WORK_DIRECTORY\}"[\s\S]+-xdev[\s\S]+-maxdepth 1[\s\S]+-type f[\s\S]+-delete/u,
  );
  assert.doesNotMatch(provisionPki, /install[\s\S]{0,160}(?:postgres|verifier)-ca\.key/u);
});

test("operator source is cryptographically bound to the requested Git revision", async () => {
  const [installSource, release, bootstrapHost] = await Promise.all([
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("scripts/bootstrap-host.sh"),
  ]);

  assert.match(
    installSource,
    /refunddesk-source-\$\{REVISION\}\.tar\.zst/,
    "the accepted filename must carry the requested full revision",
  );
  assert.match(
    installSource,
    /zstd --test --quiet -- "\$\{ARCHIVE\}"[\s\S]+set \+o pipefail[\s\S]+zstd --decompress --stdout -- "\$\{ARCHIVE\}" \|\s+git get-tar-commit-id/u,
    "the Git archive PAX marker must be read from the authenticated source bytes",
  );
  assert.match(
    installSource,
    /\[\[ "\$\{archive_revision\}" == "\$\{REVISION\}" \]\]/u,
    "the embedded Git commit must equal the requested revision",
  );
  assert.match(
    bootstrapHost,
    /^\s+git \\$/mu,
    "the sandbox host must install Git for verification",
  );
  assert.match(
    release,
    /\[\[ "\$\{source_revision_lines\[0\]\}" == "\$\{REVISION\}" \]\]/u,
    "release promotion must preserve the source-to-image revision equality",
  );
});
