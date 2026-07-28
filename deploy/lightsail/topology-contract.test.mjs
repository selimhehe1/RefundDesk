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
  for (const caddyService of ["verifier", "caddy"]) {
    const block = serviceBlock(compose, caddyService);
    assert.match(block, /^\s{4}cap_add:\n\s{6}- NET_BIND_SERVICE$/mu);
  }
  for (const service of ["postgres", "bootstrap", "migrate", "worker", "web"]) {
    assert.doesNotMatch(serviceBlock(compose, service), /NET_BIND_SERVICE/u);
  }
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
  const [compose, publicCaddy, verifierCaddy, platform, worker, migration, verifyDeployment] =
    await Promise.all([
      read("compose.yml"),
      read("Caddyfile.public"),
      read("Caddyfile.verifier"),
      read("platform.env.example"),
      read("worker.env.example"),
      read("migration.env.example"),
      read("scripts/verify-deployment.sh"),
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
    /@blocked path \/internal \/internal\/\* \/api\/ready \/api\/webhooks\/stripe-connected \/api\/webhooks\/stripe-connected\/\* \/api\/webhooks\/stripe-account\/live/u,
  );
  assert.match(verifierCaddy, /https:\/\/verifier\.refunddesk\.internal:8443/u);
  assert.match(verifierCaddy, /method POST\s+path \/internal\/v1\/signed-requests\/verify/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-account\/test/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-account\/sandbox/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-account\/live/u);
  assert.match(verifyDeployment, /\/api\/webhooks\/stripe-connected\/test/u);
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
    "STRIPE_ACCOUNT_TEST_WEBHOOK_SECRET",
    "STRIPE_ACCOUNT_SANDBOX_WEBHOOK_SECRET",
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
  assert.match(platformSource, /^STRIPE_ACCOUNT_LIVE_WEBHOOK_SECRET=disabled$/mu);
  for (const source of [platformSource, workerSource]) {
    assert.match(source, /^STRIPE_PLATFORM_TEST_ACCOUNT_ID=acct_[A-Za-z0-9]+$/mu);
    assert.match(source, /^STRIPE_MANAGED_SANDBOX_ACCOUNT_ID=acct_[A-Za-z0-9]+$/mu);
  }
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

test("installed unprivileged-container policies remain readable and read-only", async () => {
  const [compose, installSource] = await Promise.all([
    read("compose.yml"),
    read("scripts/install-source.sh"),
  ]);
  const postgres = serviceBlock(compose, "postgres");
  const publicCaddy = serviceBlock(compose, "caddy");
  const verifierCaddy = serviceBlock(compose, "verifier");

  for (const requiredPolicy of [
    "deploy/lightsail/Caddyfile.public",
    "deploy/lightsail/Caddyfile.verifier",
    "deploy/lightsail/pg_hba.conf",
  ]) {
    assert.ok(
      installSource.includes(`  ${requiredPolicy} \\`),
      `source installation must reject an archive without ${requiredPolicy}`,
    );
  }
  const rootOwnership = installSource.indexOf('chown -R root:root "${TEMP_SOURCE}"');
  const recursiveHardening = installSource.indexOf('chmod -R go-w "${TEMP_SOURCE}"');
  const containerReadMode = installSource.indexOf("chmod 0444 \\");
  assert.ok(
    rootOwnership >= 0 &&
      rootOwnership < recursiveHardening &&
      recursiveHardening < containerReadMode,
    "root-owned policies must be made readable only after recursive source hardening",
  );
  const readOnlyPolicyBlock = installSource.slice(
    containerReadMode,
    installSource.indexOf("\nprintf ", containerReadMode),
  );
  for (const readablePolicy of ["Caddyfile.public", "Caddyfile.verifier", "pg_hba.conf"]) {
    assert.match(
      readOnlyPolicyBlock,
      new RegExp(
        `\\$\\{TEMP_SOURCE\\}/deploy/lightsail/${readablePolicy.replace(".", "\\.")}`,
        "u",
      ),
      `${readablePolicy} must be installed read-only for its unprivileged container`,
    );
  }
  assert.match(
    postgres,
    /source: \.\/pg_hba\.conf\s+target: \/etc\/postgresql\/refunddesk-pg_hba\.conf\s+read_only: true\s+bind:\s+create_host_path: false/u,
  );
  assert.match(
    publicCaddy,
    /source: \.\/Caddyfile\.public\s+target: \/etc\/caddy\/Caddyfile\s+read_only: true\s+bind:\s+create_host_path: false/u,
  );
  assert.match(
    verifierCaddy,
    /source: \.\/Caddyfile\.verifier\s+target: \/etc\/caddy\/Caddyfile\s+read_only: true\s+bind:\s+create_host_path: false/u,
  );
});

test("host installs a pinned and authenticated AWS CLI v2", async () => {
  const bootstrapHost = await read("scripts/bootstrap-host.sh");

  assert.doesNotMatch(bootstrapHost, /^\s+awscli \\$/mu);
  assert.match(bootstrapHost, /^\s+gnupg \\$/mu);
  assert.match(bootstrapHost, /^\s+unzip \\$/mu);
  assert.match(bootstrapHost, /^readonly AWS_CLI_VERSION="2\.36\.9"$/mu);
  assert.match(
    bootstrapHost,
    /^readonly AWS_CLI_X86_64_SHA256="9b92ccb50dfc55479ac14c4ba1bb36f603a1cbfb004b50e4a50b1592ffad3da0"$/mu,
  );
  assert.match(
    bootstrapHost,
    /https:\/\/awscli\.amazonaws\.com\/awscli-exe-linux-x86_64-\$\{AWS_CLI_VERSION\}\.zip/u,
  );
  assert.match(bootstrapHost, /\[\[ "\$\(uname --machine\)" == "x86_64" \]\]/u);
  assert.match(bootstrapHost, /sha256sum --check --strict --status/u);
  assert.match(
    bootstrapHost,
    /^readonly AWS_CLI_SIGNING_KEY_FINGERPRINT="FB5DB77FD5C118B80511ADA8A6310ACC4672475C"$/mu,
  );
  assert.match(bootstrapHost, /--no-auto-key-retrieve[\s\S]+--status-fd 1 --verify/u);
  assert.match(bootstrapHost, /VALIDSIG \$\{AWS_CLI_SIGNING_KEY_FINGERPRINT\}/u);
  assert.match(
    bootstrapHost,
    /\[\[ "\$\{installed_version\}" == "aws-cli\/\$\{AWS_CLI_VERSION\} ".*\]\]/u,
  );
  assert.match(bootstrapHost, /if \[\[ -x \/usr\/local\/bin\/aws \]\]; then[\s\S]+return 0/u);
  assert.match(
    bootstrapHost,
    /if existing_aws="\$\(command -v aws 2>\/dev\/null\)"; then[\s\S]+refusing to replace AWS CLI installation/u,
  );
  assert.match(
    bootstrapHost,
    /\[\[ -e \/usr\/local\/bin\/aws \|\| -L \/usr\/local\/bin\/aws \|\| -e \/usr\/local\/aws-cli \]\]/u,
  );
  assert.doesNotMatch(bootstrapHost, /aws\/install[\s\S]{0,160}--update/u);

  const fastPath = bootstrapHost.indexOf("if [[ -x /usr/local/bin/aws ]]");
  const download = bootstrapHost.indexOf('download_url="https://awscli.amazonaws.com/');
  assert.ok(fastPath >= 0 && fastPath < download, "exact-version fast path must precede download");

  const swap = bootstrapHost.indexOf("if [[ ! -e /swapfile ]]");
  const apt = bootstrapHost.indexOf("apt-get update");
  const installAws = bootstrapHost.indexOf("\ninstall_aws_cli_v2\n");
  assert.ok(
    swap >= 0 && swap < apt && apt < installAws,
    "swap must be active before APT and the AWS CLI installation",
  );
});

test("new swapfiles retain two GiB of usable capacity after mkswap", async () => {
  const [bootstrapHost, verifyDeployment] = await Promise.all([
    read("scripts/bootstrap-host.sh"),
    read("scripts/verify-deployment.sh"),
  ]);
  const requiredUsableBytes = 2 * 1024 * 1024 * 1024;
  const swapHeaderBytes = 4096;
  const newSwapfileBytes = 2304 * 1024 * 1024;

  assert.ok(newSwapfileBytes - swapHeaderBytes >= requiredUsableBytes);
  assert.ok(requiredUsableBytes - swapHeaderBytes < requiredUsableBytes);
  assert.match(
    bootstrapHost,
    /log "creating the dedicated 2304 MiB swapfile with headroom for 2 GiB usable swap"\s+if ! fallocate --length 2304M \/swapfile; then\s+dd if=\/dev\/zero of=\/swapfile bs=1M count=2304 status=progress\s+fi\s+chmod 0600 \/swapfile\s+mkswap \/swapfile/u,
  );
  assert.doesNotMatch(bootstrapHost, /fallocate --length 2G|count=2048/u);

  const existingSwapStart = bootstrapHost.indexOf("else\n  [[ -f /swapfile && ! -L /swapfile ]]");
  const existingSwapEnd = bootstrapHost.indexOf("\nfi\n\nif ! swapon", existingSwapStart);
  assert.ok(existingSwapStart >= 0 && existingSwapStart < existingSwapEnd);
  const existingSwapBranch = bootstrapHost.slice(existingSwapStart, existingSwapEnd);
  assert.match(existingSwapBranch, /swap_bytes >= 2147483648/u);
  assert.doesNotMatch(existingSwapBranch, /\b(?:dd|fallocate|mkswap|swapoff|truncate)\b/u);
  assert.match(verifyDeployment, /bytes >= 2147483648[\s\S]+host swap is below 2 GiB/u);
});

test("host pins the classic Docker store required by release image IDs", async () => {
  const bootstrapHost = await read("scripts/bootstrap-host.sh");

  assert.match(bootstrapHost, /and \(\(\.features \/\/ \{\}\) \| type == "object"\)/u);
  assert.match(
    bootstrapHost,
    /\.features = \(\(\.features \/\/ \{\}\) \+ \{"containerd-snapshotter":false\}\)/u,
  );
  assert.match(
    bootstrapHost,
    /\{"features":\{"containerd-snapshotter":false\},"log-driver":"local"/u,
  );
  assert.match(
    bootstrapHost,
    /io\.containerd\.snapshotter\.v1[\s\S]+docker ps --all --quiet[\s\S]+docker image ls --quiet/u,
  );
  assert.match(
    bootstrapHost,
    /current_containers="\$\(docker ps --all --quiet\)" \|\|\s+die "Docker container inventory is unavailable"/u,
  );
  assert.match(
    bootstrapHost,
    /current_images="\$\(docker image ls --quiet\)" \|\|\s+die "Docker image inventory is unavailable"/u,
  );
  assert.doesNotMatch(bootstrapHost, /"containerd-snapshotter":true/u);

  const emptyStoreGuard = bootstrapHost.indexOf(
    "refusing to hide images while switching Docker image stores",
  );
  const daemonInstall = bootstrapHost.indexOf('install -o root -g root -m 0644 "${daemon_tmp}"');
  const daemonValidation = bootstrapHost.indexOf(
    'dockerd --validate --config-file="${daemon_tmp}"',
  );
  const daemonRestart = bootstrapHost.indexOf("systemctl restart docker.service");
  const driverCheck = bootstrapHost.indexOf(
    "Docker classic overlay2 image store is required for verified RefundDesk image IDs",
  );
  assert.ok(
    emptyStoreGuard >= 0 && emptyStoreGuard < daemonInstall,
    "the active containerd store must be empty before the daemon config changes",
  );
  assert.ok(
    daemonValidation >= 0 && daemonValidation < daemonInstall,
    "the generated daemon config must validate before installation",
  );
  assert.ok(
    daemonInstall < daemonRestart && daemonRestart < driverCheck,
    "the daemon config must be installed and restarted before its driver is accepted",
  );
  assert.match(
    bootstrapHost,
    /\[\[ "\$\{docker_driver\}" == "overlay2" \]\][\s\S]+Docker classic overlay2 image store is required/u,
  );
  assert.match(
    bootstrapHost,
    /docker_driver_status="\$\(docker info --format '\{\{json \.DriverStatus\}\}'\)"[\s\S]+Docker containerd image store remained active after restart/u,
  );
});

test("one-shot database jobs cannot build or pull an unverified image", async () => {
  const [bootstrapDatabase, release] = await Promise.all([
    read("scripts/bootstrap-database.sh"),
    read("scripts/release.sh"),
  ]);

  for (const script of [bootstrapDatabase, release]) {
    assert.doesNotMatch(script, /\brun\b[^\n]*--no-build/u);
    assert.match(script, /\brun --rm --no-deps --pull never\b/u);
  }
  assert.match(
    bootstrapDatabase,
    /pg_isready --quiet --username=refunddesk_owner --dbname=refunddesk/u,
  );
});

test("backup upload uses the AWS CLI v2 SSE-S3 surface and verifies the result", async () => {
  const backup = await read("scripts/backup.sh");
  const uploadStart = backup.indexOf("\naws s3 cp \\");
  const uploadEnd = backup.indexOf("\nUPLOAD_CREATED=true", uploadStart);

  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, "missing backup upload command");
  const upload = backup.slice(uploadStart, uploadEnd);
  assert.match(upload, /--sse AES256/u);
  assert.doesNotMatch(upload, /--server-side-encryption/u);
  assert.match(upload, /--metadata "sha256=\$\{archive_sha256\},revision=\$\{revision\}"/u);

  assert.match(backup, /AWS_SHARED_CREDENTIALS_FILE=\/dev\/null/u);
  assert.match(backup, /static or preloaded AWS credentials are prohibited/u);
  assert.match(backup, /rotate_to_count "\$\(\(REFUNDDESK_BACKUP_RETENTION_COUNT - 1\)\)"/u);
  assert.match(backup, /\.Metadata\.sha256 \/\/ empty/u);
  assert.match(backup, /\.ServerSideEncryption \/\/ empty/u);
  assert.match(backup, /"\$\{remote_sse\}" == "AES256"/u);
});
