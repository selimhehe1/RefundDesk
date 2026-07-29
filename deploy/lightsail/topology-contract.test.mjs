import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  assert.match(
    compose,
    /image: postgres:18\.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296/u,
  );
  assert.equal(
    (
      compose.match(
        /image: caddy:2\.11\.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648/gu,
      ) ?? []
    ).length,
    2,
  );
  const postgres = serviceBlock(compose, "postgres");
  assert.match(postgres, /PGDATA: \/var\/lib\/postgresql$/mu);
  assert.match(
    postgres,
    /source: \/var\/lib\/refunddesk\/postgres\/data\s+target: \/var\/lib\/postgresql$/mu,
  );
  assert.doesNotMatch(postgres, /target: \/var\/lib\/postgresql\/data/u);
  assert.equal((compose.match(/image: caddy:2\.11\.4-alpine/gu) ?? []).length, 2);
  assert.doesNotMatch(compose, /^\s{4}build:/mu, "the 1 GiB host must never build images");

  for (const service of [
    "postgres",
    "bootstrap",
    "migrate",
    "maintenance",
    "worker",
    "verifier",
    "web",
  ]) {
    assert.doesNotMatch(serviceBlock(compose, service), /^\s{4}ports:/mu);
  }
  const publicCaddy = serviceBlock(compose, "caddy");
  assert.match(publicCaddy, /^\s{4}ports:\n\s{6}- "80:8080"\n\s{6}- "443:8443"$/mu);
  for (const caddyService of ["verifier", "caddy"]) {
    const block = serviceBlock(compose, caddyService);
    assert.match(block, /^\s{4}cap_add:\n\s{6}- NET_BIND_SERVICE$/mu);
  }
  for (const service of ["postgres", "bootstrap", "migrate", "maintenance", "worker", "web"]) {
    assert.doesNotMatch(serviceBlock(compose, service), /NET_BIND_SERVICE/u);
  }
});

test("web and worker have disjoint database and verifier networks", async () => {
  const compose = await read("compose.yml");
  const web = serviceBlock(compose, "web");
  const worker = serviceBlock(compose, "worker");
  const migrate = serviceBlock(compose, "migrate");
  const maintenance = serviceBlock(compose, "maintenance");
  const bootstrap = serviceBlock(compose, "bootstrap");

  assert.match(web, /database-web:/u);
  assert.match(web, /verifier-front:/u);
  assert.match(web, /web-egress:/u);
  assert.doesNotMatch(
    web,
    /database-worker|database-migrate|database-maintenance|verifier-back|worker-egress/u,
  );
  assert.doesNotMatch(
    web,
    /depends_on:[\s\S]*?\bverifier:/u,
    "webhook ingestion must start independently of the verifier and worker",
  );

  assert.match(worker, /database-worker:/u);
  assert.match(worker, /verifier-back:/u);
  assert.match(worker, /worker-egress:/u);
  assert.doesNotMatch(
    worker,
    /database-web|database-migrate|database-maintenance|verifier-front|web-egress/u,
  );

  assert.match(migrate, /- database-migrate/u);
  assert.match(migrate, /^\s{4}read_only: true$/mu);
  assert.doesNotMatch(
    migrate,
    /database-web|database-worker|database-maintenance|egress|verifier-/u,
  );
  assert.match(bootstrap, /- database-migrate/u);
  assert.doesNotMatch(
    bootstrap,
    /database-web|database-worker|database-maintenance|egress|verifier-/u,
  );
  assert.match(maintenance, /- database-maintenance/u);
  assert.match(maintenance, /^\s{4}read_only: true$/mu);
  assert.doesNotMatch(
    maintenance,
    /database-web|database-worker|database-migrate|egress|verifier-/u,
  );

  for (const network of [
    "edge",
    "verifier-front",
    "verifier-back",
    "database-web",
    "database-worker",
    "database-migrate",
    "database-maintenance",
  ]) {
    assert.match(
      compose,
      new RegExp(`  ${network}:\\n    driver: bridge\\n    internal: true`, "u"),
    );
  }
});

test("TLS names and ingress deny rules are explicit", async () => {
  const [
    compose,
    publicCaddy,
    verifierCaddy,
    platform,
    worker,
    migration,
    maintenance,
    verifyDeployment,
  ] = await Promise.all([
    read("compose.yml"),
    read("Caddyfile.public"),
    read("Caddyfile.verifier"),
    read("platform.env.example"),
    read("worker.env.example"),
    read("migration.env.example"),
    read("maintenance.env.example"),
    read("scripts/verify-deployment.sh"),
  ]);

  assert.match(compose, /postgres\.refunddesk\.internal/gu);
  assert.match(platform, /sslmode=verify-full/u);
  assert.match(worker, /sslmode=verify-full/gu);
  assert.match(migration, /sslmode=verify-full/gu);
  assert.match(maintenance, /sslmode=verify-full/gu);
  assert.match(
    platform,
    /https:\/\/verifier\.refunddesk\.internal:8443\/internal\/v1\/signed-requests\/verify/u,
  );
  assert.match(
    publicCaddy,
    /@blocked path \/internal \/internal\/\* \/api\/ready \/api\/webhooks\/stripe-connected \/api\/webhooks\/stripe-connected\/\* \/api\/webhooks\/stripe-account\/live/u,
  );
  assert.match(
    publicCaddy,
    /@signed_api path \/api\/v1\/\*\s+request_body @signed_api \{\s+max_size 32768\s+\}/u,
  );
  assert.match(
    publicCaddy,
    /@account_webhooks path \/api\/webhooks\/stripe-account\/test \/api\/webhooks\/stripe-account\/sandbox\s+request_body @account_webhooks \{\s+max_size 1048576\s+\}/u,
  );
  assert.match(verifierCaddy, /https:\/\/verifier\.refunddesk\.internal:8443/u);
  assert.match(verifierCaddy, /method POST\s+path \/internal\/v1\/signed-requests\/verify/u);
  assert.match(verifierCaddy, /request_body @verify \{\s+max_size 32768\s+\}/u);
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
    maintenanceSource,
    postgresSource,
    bootstrapSql,
    bootstrapScript,
  ] = await Promise.all([
    read("compose.yml"),
    read("platform.env.example"),
    read("worker.env.example"),
    read("migration.env.example"),
    read("maintenance.env.example"),
    read("postgres.env.example"),
    read("10-bootstrap-roles.sql"),
    read("scripts/bootstrap-roles.sh"),
  ]);
  const platform = environmentNames(platformSource);
  const worker = environmentNames(workerSource);
  const migration = environmentNames(migrationSource);
  const maintenance = environmentNames(maintenanceSource);

  for (const forbidden of [
    "WORKER_DATABASE_URL",
    "PGBOSS_DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_APP_SIGNING_SECRET",
    "STRIPE_PLATFORM_TEST_EFFECT_KEY",
    "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    "REFUNDDESK_PROOF_HMAC_KEY_V1",
    "REFUNDDESK_PROOF_HMAC_KEY_V2",
    "REFUNDDESK_PROOF_KEY_ROTATION_STATE",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2",
    "REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE",
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
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V2",
    "REFUNDDESK_FIELD_KEY_ROTATION_STATE",
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
  assert.deepEqual([...maintenance].sort(), [
    "NODE_ENV",
    "REFUNDDESK_MAINTENANCE_DATABASE_URL",
    "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
    "REFUNDDESK_RETENTION_BATCH_SIZE",
    "REFUNDDESK_RETENTION_SCOPE",
  ]);
  for (const forbidden of [
    "DATABASE_URL",
    "WORKER_DATABASE_URL",
    "PGBOSS_DATABASE_URL",
    "DATABASE_MIGRATION_URL",
    "STRIPE_APP_SIGNING_SECRET",
    "STRIPE_PLATFORM_TEST_EFFECT_KEY",
    "STRIPE_MANAGED_SANDBOX_EFFECT_KEY",
    "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
    "REFUNDDESK_PROOF_HMAC_KEY_V1",
    "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
  ]) {
    assert.equal(maintenance.has(forbidden), false, `maintenance contains ${forbidden}`);
  }
  for (const source of [platformSource, workerSource, migrationSource, maintenanceSource]) {
    assert.doesNotMatch(source, /(?:sk|rk)_live_|STRIPE_PLATFORM_TEST_KEY=/u);
  }
  assert.match(platformSource, /^REFUNDDESK_GLOBAL_LIVE_ENABLED=false$/mu);
  assert.match(workerSource, /^REFUNDDESK_GLOBAL_LIVE_ENABLED=false$/mu);
  assert.match(platformSource, /^REFUNDDESK_FIELD_KEY_ROTATION_STATE=legacy$/mu);
  assert.match(workerSource, /^REFUNDDESK_PROOF_KEY_ROTATION_STATE=legacy$/mu);
  assert.match(workerSource, /^REFUNDDESK_APPROVAL_ATTESTATION_KEY_ROTATION_STATE=legacy$/mu);
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
    /(?:^|_)(?:PASSWORD|WEB_PASSWORD|WORKER_PASSWORD|QUEUE_PASSWORD|MAINTENANCE_PASSWORD)=/mu,
  );
  assert.doesNotMatch(
    serviceBlock(compose, "postgres"),
    /docker-entrypoint-initdb\.d|postgres-(?:web|worker|queue|maintenance)-password/u,
  );
  const bootstrap = serviceBlock(compose, "bootstrap");
  for (const name of ["owner", "web", "worker", "queue", "maintenance"]) {
    assert.match(bootstrap, new RegExp(`postgres-${name}-password`, "u"));
  }
  assert.match(bootstrapScript, /export PGSSLMODE=verify-full/u);
  assert.match(bootstrapScript, /REFUNDDESK_POSTGRES_MAINTENANCE_PASSWORD/u);
  assert.doesNotMatch(bootstrapSql, /\brefunddesk_(?:runtime|worker|queue)\b/u);
  assert.doesNotMatch(bootstrapSql, /\brefunddesk_attestation_writer\b/u);
  assert.match(
    bootstrapSql,
    /CREATE ROLE refunddesk_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u,
  );
  assert.match(bootstrapSql, /ALTER ROLE refunddesk_maintenance WITH NOLOGIN PASSWORD NULL/u);
  assert.match(bootstrapSql, /GRANT refunddesk_maintenance TO refunddesk_maintenance_login;/u);
  assert.match(
    bootstrapSql,
    /'REVOKE %I FROM refunddesk_maintenance'[\s\S]+WHERE member\.rolname = 'refunddesk_maintenance'/u,
  );
  assert.match(
    bootstrapSql,
    /'REVOKE refunddesk_maintenance_login FROM %I'[\s\S]+WHERE parent\.rolname = 'refunddesk_maintenance_login'/u,
  );
  assert.match(
    bootstrapSql,
    /REVOKE refunddesk_maintenance\s+FROM refunddesk_web_login, refunddesk_worker_login, refunddesk_queue_login;/u,
  );
  assert.match(bootstrapSql, /count\(DISTINCT password_value\) = 5/u);
  assert.match(bootstrapSql, /min\(length\(password_value\)\) >= 32/u);
  assert.equal((bootstrapSql.match(/CREATE ROLE refunddesk_[a-z]+_login LOGIN/gu) ?? []).length, 4);
});

test("release promotion requires revision-bound application key rotation history", async () => {
  const release = await read("scripts/release.sh");
  const transitionCheck = release.indexOf("check-key-rotation-transition.js");
  const candidateCreation = release.indexOf(
    "refunddesk_compose create --no-deps --no-build --pull never verifier worker web caddy",
  );
  const effectWorkerStart = release.indexOf("refunddesk_compose start worker web verifier");
  const deploymentVerification = release.indexOf(
    'bash "${SCRIPT_DIR}/verify-deployment.sh" --origin "${PUBLIC_ORIGIN}"',
  );
  const rotationStateWrite = release.lastIndexOf('--target "${ROTATION_STATE_FILE}"');
  const journalPrepare = release.lastIndexOf('python3 "${TRANSITION_HELPER}" prepare');
  const journalComplete = release.indexOf('python3 "${TRANSITION_HELPER}" complete');

  assert.notEqual(transitionCheck, -1);
  assert.notEqual(candidateCreation, -1);
  assert.notEqual(effectWorkerStart, -1);
  assert.notEqual(deploymentVerification, -1);
  assert.notEqual(rotationStateWrite, -1);
  assert.notEqual(journalPrepare, -1);
  assert.notEqual(journalComplete, -1);
  assert.ok(transitionCheck < candidateCreation);
  assert.ok(journalPrepare < candidateCreation);
  assert.ok(candidateCreation < effectWorkerStart);
  assert.ok(transitionCheck < effectWorkerStart);
  assert.ok(journalPrepare < effectWorkerStart);
  assert.ok(deploymentVerification < rotationStateWrite);
  assert.ok(rotationStateWrite < journalComplete);
  assert.match(release, /prove_candidate_created_contract/u);
  assert.match(release, /prove_candidate_runtime_contract/u);
  assert.match(release, /REFUNDDESK_RUNTIME_RESTART_POLICY=no/u);
  assert.match(release, /docker update --restart=unless-stopped/u);
  assert.match(release, /ACTIVE_REVISION_FOR_ROTATION/u);
  assert.match(release, /CURRENT_SOURCE_REVISION_FOR_ROTATION/u);
  assert.match(release, /RECORDED_ROTATION_REVISION/u);
  assert.match(release, /active revision marker and current source revision differ/u);
  assert.match(release, /application-key-rotation-state\.json/u);
  assert.match(release, /PREVIOUS_ROTATION_STATE_BACKUP/u);
  assert.match(release, /schemaVersion: 2/u);
  assert.match(release, /assert-union/u);
  assert.match(
    release,
    /key retirement is disabled until retained rows and backups prove old-key independence/u,
  );
});

test("stable launchers reject pre-contract targets and bind retention to the active source", async () => {
  const [
    contract,
    releaseLauncher,
    retentionLauncher,
    installSource,
    bootstrapHost,
    release,
    transitionHelper,
    retentionService,
    releaseFence,
  ] = await Promise.all([
    read("RELEASE_CONTRACT_VERSION"),
    read("scripts/release-launcher.sh"),
    read("scripts/retention-launcher.sh"),
    read("scripts/install-source.sh"),
    read("scripts/bootstrap-host.sh"),
    read("scripts/release.sh"),
    read("scripts/release-transition-journal.py"),
    read("systemd/refunddesk-retention.service"),
    read("scripts/release-fence.sh"),
  ]);

  assert.equal(contract, "2\n");
  assert.match(installSource, /deploy\/lightsail\/RELEASE_CONTRACT_VERSION/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/release-launcher\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/release-fence\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/backup-launcher\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/scripts\/retention-launcher\.sh/u);
  assert.match(installSource, /control-plane-generations/u);
  assert.match(installSource, /requires_legacy_snapshot/u);
  assert.match(installSource, /python3 "\$\{CONTROL_PLANE_DURABILITY_HELPER\}" durable-symlink/u);
  assert.match(
    installSource,
    /--target "\$\{REFUNDDESK_CONTROL_PLANE_LINK\}"[\s\S]+--value "\$\{legacy_final\}"/u,
  );
  assert.doesNotMatch(installSource, /--value "\$\{target_generation\}"/u);
  for (const source of [installSource, bootstrapHost]) {
    assert.match(source, /\/usr\/local\/sbin\/refunddesk-release/u);
    assert.match(source, /\/usr\/local\/sbin\/refunddesk-release-fence/u);
    assert.match(source, /\/usr\/local\/sbin\/refunddesk-backup/u);
    assert.match(source, /\/usr\/local\/sbin\/refunddesk-retention/u);
    assert.match(source, /\/usr\/local\/sbin\/refunddesk-quiesce-recovery/u);
  }

  assert.match(releaseLauncher, /^readonly RELEASE_CONTRACT_VERSION="2"$/mu);
  assert.match(
    releaseLauncher,
    /target source does not implement release contract \$\{RELEASE_CONTRACT_VERSION\}/u,
  );
  assert.match(
    releaseLauncher,
    /unfinished release transition permits only its exact target revision/u,
  );
  const contractCheck = releaseLauncher.indexOf(
    "target source does not implement release contract",
  );
  const targetExecution = releaseLauncher.indexOf("exec systemd-run");
  assert.ok(contractCheck >= 0 && targetExecution > contractCheck);
  assert.match(releaseLauncher, /--property=KillMode=control-group/u);
  assert.match(releaseLauncher, /--property=Restart=no/u);
  assert.match(releaseLauncher, /REFUNDDESK_RELEASE_SYSTEMD_UNIT/u);

  assert.match(release, /release must be invoked by the stable host-side launcher/u);
  assert.match(release, /REFUNDDESK_RELEASE_LAUNCHER_CONTRACT/u);
  assert.match(
    release,
    /systemctl show "\$\{REFUNDDESK_RELEASE_SYSTEMD_UNIT\}" --property=MainPID/u,
  );
  assert.match(releaseFence, /observed_process_starttime/u);
  assert.match(releaseFence, /systemctl kill --kill-whom=all --signal=KILL/u);
  assert.match(
    releaseFence,
    /while \[\[ -e "\$\{TRANSITION_JOURNAL\}" \|\| -L "\$\{TRANSITION_JOURNAL\}" \]\]/u,
  );
  assert.match(releaseFence, /enforce_runtime_admission_once/u);
  assert.match(releaseFence, /database-owner-reservation/u);
  assert.match(releaseFence, /application-key-transition\.lock/u);
  assert.match(releaseFence, /flock --exclusive 8/u);
  assert.match(releaseFence, /flock --unlock 8/u);
  assert.match(
    release,
    /flock --exclusive 8[\s\S]*python3 "\$\{TRANSITION_HELPER\}" complete[\s\S]*TRANSITION_COMMITTED=true[\s\S]*flock --unlock 8/u,
  );
  assert.match(
    releaseFence,
    /release transition journal is absent; release fence is already disarmed[\s\S]*remove_runtime_markers[\s\S]*exit 0/u,
  );
  for (const startupFailure of [
    "release transition journal is invalid or divergent before arming",
    "release process disappeared before the fence was armed",
    "release process identity changed before the fence was armed",
    "candidate runtime admission could not be enforced before arming",
  ]) {
    assert.match(
      releaseFence,
      new RegExp(
        `enter_emergency_fence "${startupFailure.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
        "u",
      ),
    );
  }
  assert.doesNotMatch(
    releaseFence,
    /die "(?:release transition journal is absent|release transition journal is invalid or divergent|release process disappeared before the fence was armed|release process identity changed before the fence was armed|candidate runtime admission could not be enforced before arming)"/u,
  );
  assert.match(transitionHelper, /os\.O_EXCL/u);
  assert.match(transitionHelper, /os\.fsync\(stream\.fileno\(\)\)/u);
  assert.match(transitionHelper, /target key set does not preserve the prior key union/u);
  assert.match(retentionLauncher, /retention is blocked while a release transition is unfinished/u);
  assert.match(retentionLauncher, /active revision and current source differ/u);
  assert.match(
    retentionLauncher,
    /current source release contract is outside the supported range/u,
  );
  assert.match(retentionLauncher, /exec \/usr\/bin\/bash "\$\{runner\}"/u);
  assert.match(retentionService, /^ExecStart=\/usr\/local\/sbin\/refunddesk-retention$/mu);
  assert.doesNotMatch(retentionService, /^ConditionPathExists=/mu);
});

test("stable control-plane files switch through one crash-safe generation pointer", async () => {
  const [
    common,
    installSource,
    release,
    releaseLauncher,
    releaseFence,
    backupLauncher,
    retentionLauncher,
    recoveryLauncher,
  ] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("scripts/release-launcher.sh"),
    read("scripts/release-fence.sh"),
    read("scripts/backup-launcher.sh"),
    read("scripts/retention-launcher.sh"),
    read("scripts/quiesce-recovery-launcher.sh"),
  ]);

  assert.match(
    common,
    /^readonly REFUNDDESK_CONTROL_PLANE_LINK="\$\{REFUNDDESK_ROOT\}\/control-plane-current"$/mu,
  );
  for (const requiredControlPath of [
    "scripts/release-launcher.sh",
    "scripts/release-fence.sh",
    "scripts/backup-launcher.sh",
    "scripts/retention-launcher.sh",
    "scripts/quiesce-recovery-launcher.sh",
    "systemd/refunddesk-backup.service",
    "systemd/refunddesk-backup.timer",
    "systemd/refunddesk-retention.service",
    "systemd/refunddesk-retention.timer",
    "systemd/refunddesk-quiesce-recovery.service",
  ]) {
    assert.match(
      installSource,
      new RegExp(requiredControlPath.replaceAll(".", "\\."), "u"),
      `missing generation member ${requiredControlPath}`,
    );
  }
  const snapshotSync = installSource.indexOf(
    'python3 "${CONTROL_PLANE_DURABILITY_HELPER}" fsync-tree',
  );
  const snapshotPublication = installSource.indexOf('--value "${legacy_final}"', snapshotSync);
  const stableConversion = installSource.indexOf('--target "${stable_path}"', snapshotPublication);
  assert.ok(
    snapshotSync >= 0 &&
      snapshotPublication > snapshotSync &&
      stableConversion > snapshotPublication,
  );
  assert.match(installSource, /active release bridge cannot invoke release-contract-2 targets/u);
  assert.match(
    installSource,
    /active release-fence bridge cannot protect a contract-2 transition/u,
  );
  assert.doesNotMatch(installSource, /systemctl stop refunddesk-(?:backup|retention)\.timer/u);

  for (const launcher of [
    releaseLauncher,
    releaseFence,
    backupLauncher,
    retentionLauncher,
    recoveryLauncher,
  ]) {
    assert.match(launcher, /control-plane-current/u);
    assert.match(launcher, /control-plane-generations/u);
  }
  const verifiedGeneration = release.lastIndexOf('--target "${REFUNDDESK_CONTROL_PLANE_LINK}"');
  const transitionCommit = release.lastIndexOf('python3 "${TRANSITION_HELPER}" complete');
  assert.ok(verifiedGeneration >= 0 && transitionCommit > verifiedGeneration);
});

test("backup scheduling activates only after strict configuration validation", async () => {
  const [bootstrapHost, release, helper] = await Promise.all([
    read("scripts/bootstrap-host.sh"),
    read("scripts/release.sh"),
    read("scripts/release-transition-journal.py"),
  ]);
  for (const source of [bootstrapHost, release]) {
    assert.match(source, /validate-backup/u);
    assert.match(source, /systemctl enable --now refunddesk-backup\.timer/u);
    assert.match(source, /systemctl is-enabled --quiet refunddesk-backup\.timer/u);
    assert.match(source, /systemctl is-active --quiet refunddesk-backup\.timer/u);
    assert.match(source, /systemctl disable --now refunddesk-backup\.timer/u);
  }
  assert.match(helper, /def validate_backup\(/u);
  assert.match(helper, /set\(values\) != expected_names/u);
  assert.match(helper, /backup environment binding is invalid/u);
  const finalizationLock = release.lastIndexOf("flock --exclusive 8");
  const restartProof = release.indexOf("restore_runtime_restart_policies", finalizationLock);
  const systemdReload = release.indexOf("systemctl daemon-reload", restartProof);
  const backupActivation = release.indexOf(
    "systemctl enable --now refunddesk-backup.timer",
    systemdReload,
  );
  const durableCommit = release.indexOf(
    'python3 "${TRANSITION_HELPER}" complete',
    backupActivation,
  );
  const finalizationUnlock = release.indexOf("flock --unlock 8", durableCommit);
  assert.ok(
    finalizationLock >= 0 &&
      restartProof > finalizationLock &&
      systemdReload > restartProof &&
      backupActivation > systemdReload &&
      durableCommit > backupActivation &&
      finalizationUnlock > durableCommit,
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-backup-configuration-"));
  const environment = join(temporaryDirectory, "backup.env");
  const awsConfig = join(temporaryDirectory, "config");
  const runHelper = () =>
    spawnSync(
      "python3",
      [
        resolve(directory, "scripts/release-transition-journal.py"),
        "validate-backup",
        "--environment",
        environment,
        "--aws-config",
        awsConfig,
      ],
      { encoding: "utf8", windowsHide: true },
    );

  try {
    await writeFile(awsConfig, "[default]\nregion=eu-west-3\n", { mode: 0o600 });
    await writeFile(
      environment,
      [
        "REFUNDDESK_BACKUP_BUCKET=refunddesk-sandbox-backups",
        "REFUNDDESK_BACKUP_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        "REFUNDDESK_BACKUP_PREFIX=refunddesk-sandbox/postgres/",
        "REFUNDDESK_BACKUP_RETENTION_COUNT=7",
        `AWS_CONFIG_FILE=${awsConfig}`,
        "AWS_REGION=eu-west-3",
        "AWS_DEFAULT_REGION=eu-west-3",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const valid = runHelper();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /"status": "backup-valid"/u);

    await writeFile(
      environment,
      `${await readFile(environment, "utf8")}UNEXPECTED_COMMAND=$(id)\n`,
      { mode: 0o600 },
    );
    const executableConfiguration = runHelper();
    assert.notEqual(executableConfiguration.status, 0);
    assert.match(executableConfiguration.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("release rollback preserves the recoverable metadata lattice", async () => {
  const release = await read("scripts/release.sh");
  const rollbackStart = release.indexOf("fail_closed() {");
  const rollbackEnd = release.indexOf("trap fail_closed EXIT", rollbackStart);
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart);
  const rollback = release.slice(rollbackStart, rollbackEnd);

  assert.match(rollback, /local metadata_rollback_ok=true/u);
  assert.equal(
    (rollback.match(/\[\[ "\$\{metadata_rollback_ok\}" == "true" \]\]/gu) ?? []).length,
    4,
  );
  assert.ok((rollback.match(/metadata_rollback_ok=false/gu) ?? []).length >= 4);

  const rotationRollback = rollback.indexOf('--target "${ROTATION_STATE_FILE}"');
  const currentRollback = rollback.indexOf('--target "${REFUNDDESK_ROOT}/current"');
  const activeRollback = rollback.indexOf('--target "${REFUNDDESK_ROOT}/ACTIVE_REVISION"');
  const environmentRollback = rollback.indexOf('--target "${REFUNDDESK_RELEASE_ENV}"');
  assert.ok(
    rotationRollback >= 0 &&
      currentRollback > rotationRollback &&
      activeRollback > currentRollback &&
      environmentRollback > activeRollback,
  );
  assert.match(rollback, /preserving root-only recovery artifact after incomplete rollback/u);
  assert.match(
    rollback,
    /if \[\[ "\$\{TRANSITION_COMMITTED\}" == "true" \]\]; then[\s\S]+rm -f -- "\$\{PREVIOUS_RELEASE_ENV_BACKUP\}"/u,
  );

  const mainStart = release.indexOf("PROMOTION_STARTED=true", rollbackEnd);
  const quiescence = release.indexOf("fence_target_candidates", mainStart);
  const journalPrepare = release.indexOf('python3 "${TRANSITION_HELPER}" prepare', mainStart);
  const admission = release.indexOf("enable_candidate_runtime", journalPrepare);
  const runtimeStart = release.indexOf("refunddesk_compose start worker web verifier", admission);
  const restartRestoration = release.indexOf("restore_runtime_restart_policies", runtimeStart);
  const journalComplete = release.indexOf(
    'python3 "${TRANSITION_HELPER}" complete',
    restartRestoration,
  );
  assert.ok(
    mainStart >= 0 &&
      quiescence > mainStart &&
      journalPrepare > quiescence &&
      admission > journalPrepare &&
      runtimeStart > admission &&
      restartRestoration > runtimeStart &&
      journalComplete > restartRestoration,
  );
});

test("transition journal blocks divergence after a simulated kill before commit", async () => {
  const helper = resolve(directory, "scripts/release-transition-journal.py");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-release-transition-"));
  const journal = join(temporaryDirectory, "transition.json");
  const commitMarker = join(temporaryDirectory, "committed.json");
  const candidate = join(temporaryDirectory, "candidate.json");
  const divergent = join(temporaryDirectory, "divergent.json");
  const previousFingerprints = join(temporaryDirectory, "previous-fingerprints.json");
  const targetFingerprints = join(temporaryDirectory, "target-fingerprints.json");
  const replacedFingerprints = join(temporaryDirectory, "replaced-fingerprints.json");
  const fingerprintA = `sha256:${"a".repeat(64)}`;
  const fingerprintB = `sha256:${"b".repeat(64)}`;
  const fingerprintC = `sha256:${"c".repeat(64)}`;
  const fingerprintD = `sha256:${"d".repeat(64)}`;
  const revisionA = "1".repeat(40);
  const revisionB = "2".repeat(40);
  const revisionC = "3".repeat(40);
  const fingerprints = (v1, v2) => ({
    approvalAttestation: { v1, v2 },
    field: { v1, v2 },
    proof: { v1, v2 },
  });
  const transition = {
    from: {
      fingerprints: fingerprints(fingerprintA, null),
      recorded: false,
      revision: revisionA,
      states: {
        approvalAttestation: "legacy",
        field: "legacy",
        proof: "legacy",
      },
    },
    schemaVersion: 1,
    status: "in_progress",
    to: {
      fingerprints: {
        approvalAttestation: { v1: fingerprintA, v2: fingerprintB },
        field: { v1: fingerprintA, v2: fingerprintC },
        proof: { v1: fingerprintA, v2: fingerprintD },
      },
      recorded: true,
      revision: revisionB,
      states: {
        approvalAttestation: "staged",
        field: "staged",
        proof: "staged",
      },
    },
  };
  const runHelper = (...arguments_) =>
    spawnSync("python3", [helper, ...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });

  try {
    await writeFile(previousFingerprints, `${JSON.stringify(transition.from.fingerprints)}\n`, {
      mode: 0o600,
    });
    await writeFile(targetFingerprints, `${JSON.stringify(transition.to.fingerprints)}\n`, {
      mode: 0o600,
    });
    const union = runHelper(
      "assert-union",
      "--previous",
      previousFingerprints,
      "--target",
      targetFingerprints,
    );
    assert.equal(union.status, 0, union.stderr);
    await writeFile(
      replacedFingerprints,
      `${JSON.stringify({
        ...transition.to.fingerprints,
        field: { ...transition.to.fingerprints.field, v1: fingerprintB },
      })}\n`,
      { mode: 0o600 },
    );
    const replaced = runHelper(
      "assert-union",
      "--previous",
      previousFingerprints,
      "--target",
      replacedFingerprints,
    );
    assert.notEqual(replaced.status, 0);

    await writeFile(candidate, `${JSON.stringify(transition)}\n`, { mode: 0o600 });
    const prepared = runHelper("prepare", "--path", journal, "--candidate", candidate);
    assert.equal(prepared.status, 0, prepared.stderr);

    // Simulated SIGKILL after services-up: deliberately omit the complete command.
    await writeFile(join(temporaryDirectory, "services-up"), "true\n");
    await writeFile(
      divergent,
      `${JSON.stringify({
        ...transition,
        to: { ...transition.to, revision: revisionC },
      })}\n`,
      { mode: 0o600 },
    );
    const rejected = runHelper("prepare", "--path", journal, "--candidate", divergent);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /RELEASE_TRANSITION_CONTRACT_INVALID/u);

    const resumed = runHelper("prepare", "--path", journal, "--candidate", candidate);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /"status": "resumed"/u);

    const committed = runHelper(
      "complete",
      "--path",
      journal,
      "--candidate",
      candidate,
      "--commit-marker",
      commitMarker,
    );
    assert.equal(committed.status, 0, committed.stderr);
    await assert.rejects(readFile(journal), { code: "ENOENT" });
    const committedState = JSON.parse(await readFile(commitMarker, "utf8"));
    assert.equal(committedState.status, "committed");
    assert.equal(committedState.to.revision, revisionB);
    const assertedCommit = runHelper(
      "assert-commit",
      "--marker",
      commitMarker,
      "--candidate",
      candidate,
    );
    assert.equal(assertedCommit.status, 0, assertedCommit.stderr);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
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
  assert.match(provisionPki, /recover_interrupted_pki_generation/u);
  assert.match(provisionPki, /assert_private_work_directory/u);
  assert.match(provisionPki, /assert_staging_directory/u);
  assert.match(provisionPki, /assert_generation_marker/u);
  assert.match(provisionPki, /assert_manifest_matches_installed_targets/u);
  assert.match(provisionPki, /assert_published_service_matches_private_generation/u);
  assert.match(provisionPki, /remove_published_service_generation/u);
  assert.match(
    provisionPki,
    /STAGING_DIRECTORY="\$\{TLS_ROOT\}\/\$\{STAGING_PREFIX\}\$\{PRIVATE_WORK_DIRECTORY##\*\$\{PRIVATE_WORK_PREFIX\}\}"/u,
  );
  assert.match(
    provisionPki,
    /generation_marker_candidate="\$\{TLS_ROOT\}\/\$\{GENERATION_MARKER_PREFIX\}\$\{PRIVATE_WORK_DIRECTORY##\*\$\{PRIVATE_WORK_PREFIX\}\}\.sha256"/u,
  );
  assert.match(provisionPki, /rm -- "\$\{entry\}"/u);
  assert.doesNotMatch(provisionPki, /find[^\n]*-delete|rm\s+-rf/u);
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

test("daily retention is revision-bound, isolated and activated on fresh or existing hosts", async () => {
  const [
    compose,
    environment,
    runner,
    retentionService,
    retentionTimer,
    bootstrapHost,
    installSource,
    release,
    purge,
  ] = await Promise.all([
    read("compose.yml"),
    read("maintenance.env.example"),
    read("scripts/run-retention.sh"),
    read("systemd/refunddesk-retention.service"),
    read("systemd/refunddesk-retention.timer"),
    read("scripts/bootstrap-host.sh"),
    read("scripts/install-source.sh"),
    read("scripts/release.sh"),
    read("../../packages/db/scripts/retention-purge.mjs"),
  ]);
  const maintenance = serviceBlock(compose, "maintenance");

  for (const fragment of [
    "image: refunddesk-migrate:${REFUNDDESK_IMAGE_TAG:?REFUNDDESK_IMAGE_TAG is required}",
    "profiles:\n      - maintenance",
    'restart: "no"',
    "env_file:\n      - /etc/refunddesk/maintenance.env",
    "command:\n      - node\n      - packages/db/scripts/run-retention-purge.mjs",
    'user: "1000:1000"',
    "read_only: true",
    "cap_drop:\n      - ALL",
    "no-new-privileges:true",
    "condition: service_healthy",
    "- database-maintenance",
  ]) {
    assert.match(maintenance, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(
    maintenance,
    /STRIPE_|DATABASE_MIGRATION_URL|WORKER_DATABASE_URL|PGBOSS_DATABASE_URL|database-(?:web|worker|migrate)|egress/u,
  );
  assert.equal((maintenance.match(/source: /gu) ?? []).length, 1);
  assert.match(maintenance, /source: \/etc\/refunddesk\/tls\/postgres\/ca\.crt/u);

  assert.deepEqual([...environmentNames(environment)].sort(), [
    "NODE_ENV",
    "REFUNDDESK_MAINTENANCE_DATABASE_URL",
    "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
    "REFUNDDESK_RETENTION_BATCH_SIZE",
    "REFUNDDESK_RETENTION_SCOPE",
  ]);
  assert.match(environment, /^REFUNDDESK_RETENTION_SCOPE=test_sandbox$/mu);
  assert.doesNotMatch(environment, /STRIPE_|(?:sk|rk)_live_/u);

  for (const fragment of [
    "acquire_operator_lock",
    'assert_root_secret_file "${REFUNDDESK_RELEASE_ENV}"',
    'assert_root_secret_file "${MAINTENANCE_ENV}"',
    'assert_root_secret_file "${MAINTENANCE_PASSWORD_FILE}"',
    '[[ -L "${CURRENT_LINK}" ]]',
    'current_source="$(readlink --canonicalize-existing -- "${CURRENT_LINK}")"',
    "REFUNDDESK_IMAGE_TAG=sandbox-${revision}",
    "REFUNDDESK_REVISION=${revision}",
    "set(values) != expected_names",
    'urllib.parse.unquote(database_url.username or "")',
    "refunddesk_maintenance_login",
    'urllib.parse.unquote(database_url.password or "") != password_lines[0]',
    'manifest="${REFUNDDESK_ROOT}/releases/${revision}/manifest.json"',
    'expected_image_id="$(',
    'docker image inspect "${image}"',
    "org.opencontainers.image.revision",
    "service_container_id postgres",
    ".State.Health.Status",
    "worker must be present and running before retention",
    "prepare-quiesce",
    "--operation retention",
    "REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true",
    'bash "${RECOVERY_RUNNER}"',
    "refunddesk_compose stop --timeout 45 worker",
    "service_is_running worker",
    "trap restore_worker EXIT",
    "clear_database_owner_job_reservation",
    'refunddesk_compose --profile maintenance run \\\n  --name "${REFUNDDESK_DATABASE_OWNER_JOB_NAME}"',
    "--no-deps",
    "--pull never",
    'seal_database_owner_job_reservation maintenance "${revision}"',
    'assert_database_owner_job_reservation "${revision}"',
  ]) {
    assert.match(runner, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(runner, /^\s*(?:source|\.)\s+["']?\$\{?MAINTENANCE_ENV/mu);
  assert.doesNotMatch(runner, /docker\s+pull|refunddesk_compose\s+(?:build|pull)/u);
  assert.doesNotMatch(runner, /refunddesk_compose\s+up[^\n]*maintenance/u);
  const workerStop = runner.indexOf("refunddesk_compose stop --timeout 45 worker");
  const maintenanceRun = runner.indexOf("refunddesk_compose --profile maintenance run");
  const maintenanceSeal = runner.indexOf(
    'seal_database_owner_job_reservation maintenance "${revision}"',
    maintenanceRun,
  );
  const reservationProof = runner.indexOf(
    'assert_database_owner_job_reservation "${revision}"',
    maintenanceSeal,
  );
  assert.ok(
    workerStop >= 0 &&
      maintenanceRun > workerStop &&
      maintenanceSeal > maintenanceRun &&
      reservationProof > maintenanceSeal,
  );
  assert.doesNotMatch(runner.slice(maintenanceRun), /\brun\s+--rm\b/u);
  const restoreStart = runner.indexOf("restore_worker() {");
  const restoreEnd = runner.indexOf("trap restore_worker EXIT", restoreStart);
  const restoreWorker = runner.slice(restoreStart, restoreEnd);
  assert.match(restoreWorker, /bash "\$\{RECOVERY_RUNNER\}"/u);
  assert.doesNotMatch(restoreWorker, /leaving the worker stopped/u);
  assert.match(purge, /pg_try_advisory_lock/u);
  assert.match(purge, /RETENTION_PURGE_ALREADY_RUNNING/u);
  assert.match(purge, /FROM public\.refunddesk_purge_test_sandbox_tenant/u);

  for (const fragment of [
    "Environment=HOME=/run/refunddesk-retention",
    "Environment=DOCKER_CONFIG=/run/refunddesk-retention",
    "RuntimeDirectory=refunddesk-retention",
    "ExecStart=/usr/local/sbin/refunddesk-retention",
    "NoNewPrivileges=yes",
    "PrivateDevices=yes",
    "PrivateTmp=yes",
    "ProtectHome=yes",
    "ProtectSystem=strict",
    "RestrictAddressFamilies=AF_UNIX",
    "CapabilityBoundingSet=",
    "ReadWritePaths=/run/refunddesk /run/docker.sock /run/refunddesk-retention /var/lib/refunddesk/control /var/log/refunddesk",
  ]) {
    assert.match(
      retentionService,
      new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  assert.doesNotMatch(retentionService, /^EnvironmentFile=/mu);
  assert.doesNotMatch(
    retentionService,
    /^ConditionPathExists=/mu,
    "missing control files must fail visibly through the stable launcher instead of skipping retention",
  );
  assert.match(retentionTimer, /^OnCalendar=hourly$/mu);
  assert.match(retentionTimer, /^RandomizedDelaySec=5min$/mu);
  assert.match(retentionTimer, /^Persistent=true$/mu);

  for (const source of [bootstrapHost, release]) {
    assert.match(source, /refunddesk-retention\.service/u);
    assert.match(source, /refunddesk-retention\.timer/u);
    assert.match(source, /systemctl enable --now refunddesk-retention\.timer/u);
  }
  assert.match(installSource, /deploy\/lightsail\/scripts\/run-retention\.sh/u);
  assert.match(installSource, /deploy\/lightsail\/systemd\/refunddesk-retention\.service/u);
  const promotion = release.lastIndexOf('--target "${REFUNDDESK_ROOT}/current"');
  const activation = release.indexOf("systemctl enable --now refunddesk-retention.timer");
  assert.ok(promotion >= 0 && activation > promotion);
});

test("one-shot database jobs reserve one global name without retaining secrets", async () => {
  const [common, bootstrapDatabase, release, retention, reservationTest] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/bootstrap-database.sh"),
    read("scripts/release.sh"),
    read("scripts/run-retention.sh"),
    read("scripts/test-database-owner-reservation.sh"),
  ]);

  for (const script of [bootstrapDatabase, release, retention]) {
    assert.doesNotMatch(script, /\brun\b[^\n]*--no-build/u);
    assert.match(script, /--name "\$\{REFUNDDESK_DATABASE_OWNER_JOB_NAME\}"/u);
    assert.match(script, /--no-deps/u);
    assert.match(script, /--pull never/u);
    assert.match(script, /clear_database_owner_job_reservation/u);
    assert.match(script, /seal_database_owner_job_reservation/u);
  }
  assert.doesNotMatch(
    `${bootstrapDatabase}\n${release}\n${retention}`,
    /refunddesk_compose[\s\S]{0,120}\brun\s+--rm\b/u,
  );
  assert.match(common, /readonly REFUNDDESK_DATABASE_OWNER_JOB_NAME=/u);
  assert.match(common, /database-owner-reservation/u);
  assert.match(common, /--network none/u);
  assert.match(common, /--read-only/u);
  assert.match(common, /--restart=no/u);
  assert.match(common, /--cap-drop ALL/u);
  assert.match(common, /docker create \\\n\s+--pull=never/u);
  assert.match(common, /--tmpfs \/var\/lib\/postgresql:rw,nosuid,nodev,noexec,size=65536/u);
  assert.match(common, /--entrypoint \/bin\/true/u);
  assert.match(
    common,
    /\.HostConfig\.Tmpfs[\s\S]*== \{"\/var\/lib\/postgresql":"rw,nosuid,nodev,noexec,size=65536"\}/u,
  );
  assert.match(common, /all\(\.\[0\]\.Mounts\[\]\?; \.Type != "volume"\)/u);
  assert.ok((common.match(/docker rm --volumes/gu) ?? []).length >= 2);
  assert.match(release, /docker rm --volumes "\$\{container_id\}"/u);
  assert.match(reservationTest, /any\(\.\[0\]\.Mounts\[\]\?; \.Type == "volume"\)/u);
  assert.match(reservationTest, /seal_database_owner_job_reservation migrate/u);
  assert.match(reservationTest, /assert_database_owner_job_reservation/u);
  assert.match(reservationTest, /clear_database_owner_job_reservation/u);
  assert.match(reservationTest, /volume_inventory/u);
  assert.match(reservationTest, /leaked an anonymous Docker volume/u);
  assert.match(reservationTest, /docker rm --force --volumes/u);
  assert.match(reservationTest, /docker create \\\n\s+--pull=never/u);
  assert.match(common, /\.State\.ExitCode == 0/u);
  assert.match(common, /\(\.\[0\]\.State\.Error \/\/ ""\) == ""/u);
  assert.match(
    common,
    /test\("\(PASSWORD\|SECRET\|TOKEN\|DATABASE_URL\|HMAC_KEY\|ENCRYPTION_KEY\)"\)/u,
  );
  assert.match(
    bootstrapDatabase,
    /pg_isready --quiet --username=refunddesk_owner --dbname=refunddesk/u,
  );
});

test("PostgreSQL 18 root-mount migration proves a cold clone before deleting the old layout", async () => {
  const [common, migration, migrationTest, release, bootstrap, installSource] = await Promise.all([
    read("scripts/_common.sh"),
    read("scripts/prepare-postgres-root-mount.sh"),
    read("scripts/test-postgres-root-mount-migration.sh"),
    read("scripts/release.sh"),
    read("scripts/bootstrap-database.sh"),
    read("scripts/install-source.sh"),
  ]);

  for (const fragment of [
    'POSTGRES_IMAGE="postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"',
    'OLD_CONTAINER_PGDATA="/var/lib/postgresql/data"',
    "docker stop --time 60",
    "postmaster.pid",
    "999:999:700",
    "PG_VERSION",
    "cp --archive --reflink=auto --one-file-system",
    "tree_fingerprint",
    "insufficient free space",
    "--pull=never",
    "--network none",
    "target=${REFUNDDESK_POSTGRES_CONTAINER_PGDATA}",
    'all(.[0].Mounts[]?; .Type != "volume")',
    "to_regclass('public._prisma_migrations') IS NOT NULL",
    "--entrypoint /usr/lib/postgresql/18/bin/pg_checksums",
    "docker rm --volumes",
    "legacy PostgreSQL anonymous parent volume survived",
    "cold PostgreSQL root-mount probe leaked a Docker volume",
  ]) {
    assert.match(migration, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(
    common,
    /assert_postgres_root_mount_contract\(\)[\s\S]*all\(\.\[0\]\.Mounts\[\]\?; \.Type != "volume"\)/u,
  );
  assert.match(bootstrap, /refunddesk_compose up[\s\S]*assert_postgres_root_mount_contract/u);
  const migrationProof = release.indexOf('bash "${SCRIPT_DIR}/prepare-postgres-root-mount.sh"');
  const bootstrapStart = release.indexOf('bash "${SCRIPT_DIR}/bootstrap-database.sh"');
  assert.ok(migrationProof >= 0 && bootstrapStart > migrationProof);
  assert.match(installSource, /deploy\/lightsail\/scripts\/prepare-postgres-root-mount\.sh/u);
  assert.match(migrationTest, /PGDATA=\/var\/lib\/postgresql\/data/u);
  assert.match(migrationTest, /PGDATA=\/var\/lib\/postgresql/u);
  assert.match(migrationTest, /select\(\.Type == "volume"/u);
  assert.match(migrationTest, /all\(\.\[0\]\.Mounts\[\]\?; \.Type != "volume"\)/u);
  assert.match(migrationTest, /BASELINE_VOLUMES/u);
  assert.match(migrationTest, /interrupted-clone/u);
  assert.match(migration, /recover_stale_helper_container/u);
});

test("backup upload uses the AWS CLI v2 SSE-S3 surface and verifies the result", async () => {
  const [backup, backupLauncher, backupService] = await Promise.all([
    read("scripts/backup.sh"),
    read("scripts/backup-launcher.sh"),
    read("systemd/refunddesk-backup.service"),
  ]);
  const uploadStart = backup.indexOf("\n  aws s3api put-object \\");
  const uploadEnd = backup.indexOf('\n)"; then', uploadStart);

  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, "missing backup upload command");
  const upload = backup.slice(uploadStart, uploadEnd);
  assert.match(upload, /--server-side-encryption AES256/u);
  assert.doesNotMatch(upload, /\bs3 cp\b/u);
  assert.match(upload, /--metadata "sha256=\$\{archive_sha256\},revision=\$\{revision\}"/u);

  assert.match(backup, /AWS_SHARED_CREDENTIALS_FILE=\/dev\/null/u);
  assert.match(backup, /static or preloaded AWS credentials are prohibited/u);
  assert.match(backup, /UPLOAD_ATTEMPTED=true[\s\S]*aws s3api put-object/u);
  assert.match(backup, /UPLOAD_COMMITTED=true[\s\S]*rotate_to_count/u);
  assert.match(backup, /--version-id "\$\{UPLOADED_VERSION_ID\}"/u);
  assert.match(backup, /--no-paginate/u);
  assert.match(backup, /\.IsTruncated \/\/ false/u);
  assert.match(backup, /\.Metadata\.sha256 \/\/ empty/u);
  assert.match(backup, /\.ServerSideEncryption \/\/ empty/u);
  assert.match(backup, /"\$\{remote_sse\}" == "AES256"/u);
  assert.match(backupService, /^ExecStart=\/usr\/local\/sbin\/refunddesk-backup$/mu);
  assert.doesNotMatch(backupService, /^(?:EnvironmentFile|ConditionPathExists)=/mu);
  for (const source of [backupLauncher, backup]) {
    assert.match(source, /backup is blocked while a release transition is unfinished/u);
    assert.match(source, /ACTIVE_REVISION/u);
    assert.match(source, /release\.env/u);
    assert.match(source, /manifest\.json/u);
    assert.match(source, /docker image inspect/u);
    assert.match(source, /org\.opencontainers\.image\.revision/u);
  }
  assert.match(backupLauncher, /exec \/usr\/bin\/bash "\$\{runner\}"/u);
  assert.doesNotMatch(
    backup,
    /refunddesk_compose up(?![^\n]*--pull never)/u,
    "every backup restore must remain bound to a previously verified local image",
  );
});

test("runtime quiescence is durable, exact-revision recovered and boot-wired", async () => {
  const [
    backup,
    retention,
    backupLauncher,
    retentionLauncher,
    recoveryLauncher,
    recovery,
    recoveryService,
    backupService,
    retentionService,
    helper,
    installSource,
    releaseLauncher,
    release,
  ] = await Promise.all([
    read("scripts/backup.sh"),
    read("scripts/run-retention.sh"),
    read("scripts/backup-launcher.sh"),
    read("scripts/retention-launcher.sh"),
    read("scripts/quiesce-recovery-launcher.sh"),
    read("scripts/recover-quiesced-runtime.sh"),
    read("systemd/refunddesk-quiesce-recovery.service"),
    read("systemd/refunddesk-backup.service"),
    read("systemd/refunddesk-retention.service"),
    read("scripts/release-transition-journal.py"),
    read("scripts/install-source.sh"),
    read("scripts/release-launcher.sh"),
    read("scripts/release.sh"),
  ]);

  for (const [runner, operation, stopMarker] of [
    [backup, "backup", "refunddesk_compose stop --timeout 45 caddy"],
    [retention, "retention", "refunddesk_compose stop --timeout 45 worker"],
  ]) {
    const journal = runner.indexOf("prepare-quiesce");
    const operationBinding = runner.indexOf(`--operation ${operation}`, journal);
    const stop = runner.indexOf(stopMarker);
    assert.ok(journal >= 0 && operationBinding > journal && stop > operationBinding);
    assert.match(runner, /REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true/u);
    assert.match(runner, /bash "\$\{RECOVERY_RUNNER\}"/u);
  }

  const archiveSync = backup.indexOf('fsync-paths \\\n  --path "${archive_path}"');
  const uploadIntent = backup.indexOf("prepare-backup-upload", archiveSync);
  const upload = backup.indexOf("aws s3api put-object", uploadIntent);
  assert.ok(archiveSync >= 0 && uploadIntent > archiveSync && upload > uploadIntent);
  assert.match(backup, /preserving the encrypted local archive and upload intent/u);
  assert.match(helper, /def validate_quiesce_journal/u);
  assert.match(helper, /def validate_backup_upload_journal/u);
  assert.match(helper, /os\.O_EXCL/u);
  assert.match(helper, /def clear_quiesce[\s\S]*durable_unlink\(journal_path\)/u);

  for (const launcher of [backupLauncher, retentionLauncher, releaseLauncher, installSource]) {
    assert.match(launcher, /refunddesk-quiesce-recovery/u);
    assert.match(launcher, /runtime-quiesce-in-progress\.json/u);
  }
  const sourceInstallLock = installSource.indexOf("acquire_operator_lock");
  const sourceInstallRecovery = installSource.indexOf(
    'if [[ -e "${QUIESCE_JOURNAL}" || -L "${QUIESCE_JOURNAL}" ]]',
    sourceInstallLock,
  );
  assert.ok(sourceInstallLock >= 0 && sourceInstallRecovery > sourceInstallLock);
  assert.match(
    installSource.slice(sourceInstallRecovery),
    /REFUNDDESK_QUIESCE_RECOVERY_LOCK_INHERITED=true/u,
  );
  assert.match(release, /release is blocked until an unfinished runtime quiescence is recovered/u);
  assert.match(recoveryLauncher, /runtime control root must be root-owned mode 0700/u);
  assert.match(recovery, /assert-quiesce/u);
  assert.match(recovery, /recover_retention_database_owner_job/u);
  assert.doesNotMatch(
    recovery,
    /refunddesk_compose up(?![^\n]*--pull never)/u,
    "recovery must use only the already-verified exact local images",
  );
  const deploymentVerification = recovery.indexOf('bash "${SCRIPT_DIR}/verify-deployment.sh"');
  const journalClear = recovery.indexOf("clear-quiesce", deploymentVerification);
  assert.ok(deploymentVerification >= 0 && journalClear > deploymentVerification);
  assert.match(recovery, /flock --exclusive --nonblock 9/u);

  assert.match(
    recoveryService,
    /^ConditionPathExists=\/var\/lib\/refunddesk\/control\/runtime-quiesce-in-progress\.json$/mu,
  );
  assert.match(recoveryService, /^ExecStart=\/usr\/local\/sbin\/refunddesk-quiesce-recovery$/mu);
  assert.match(recoveryService, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/mu);
  assert.match(backupService, /^OnFailure=refunddesk-quiesce-recovery\.service$/mu);
  assert.match(retentionService, /^OnFailure=refunddesk-quiesce-recovery\.service$/mu);
});

test("quiesce and backup-upload journals reject divergence and clear durably", async () => {
  const helper = resolve(directory, "scripts/release-transition-journal.py");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refunddesk-quiesce-journal-"));
  const quiesceJournal = join(temporaryDirectory, "quiesce.json");
  const uploadJournal = join(temporaryDirectory, "upload.json");
  const revision = "a".repeat(40);
  const archive = `/var/lib/refunddesk/backups/postgres-20260729T031700Z-${revision}.tar.zst.age`;
  const commonUploadArguments = [
    "--path",
    uploadJournal,
    "--archive",
    archive,
    "--bucket",
    "refunddesk-sandbox-backups",
    "--bytes",
    "4096",
    "--object-key",
    `refunddesk-sandbox/postgres/${archive.split("/").at(-1)}`,
    "--revision",
    revision,
    "--sha256",
    "b".repeat(64),
  ];
  const runHelper = (...arguments_) =>
    spawnSync("python3", [helper, ...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });

  try {
    let result = runHelper(
      "prepare-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "backup",
      "--revision",
      revision,
    );
    assert.equal(result.status, 0, result.stderr);
    result = runHelper(
      "assert-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "retention",
      "--revision",
      revision,
    );
    assert.notEqual(result.status, 0);
    result = runHelper(
      "prepare-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "backup",
      "--revision",
      revision,
    );
    assert.notEqual(result.status, 0);
    result = runHelper(
      "clear-quiesce",
      "--path",
      quiesceJournal,
      "--operation",
      "backup",
      "--revision",
      revision,
    );
    assert.equal(result.status, 0, result.stderr);

    result = runHelper("prepare-backup-upload", ...commonUploadArguments);
    assert.equal(result.status, 0, result.stderr);
    result = runHelper(
      "assert-backup-upload",
      ...commonUploadArguments.map((value, index) =>
        commonUploadArguments[index - 1] === "--bytes" ? "4097" : value,
      ),
    );
    assert.notEqual(result.status, 0);
    result = runHelper("clear-backup-upload", ...commonUploadArguments);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
