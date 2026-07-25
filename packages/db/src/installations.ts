import type { PrismaClient, StripeEnvironment } from "./generated/prisma/client.js";

const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]+$/u;

export interface ResolvedInstallation {
  readonly tenantId: string;
  readonly installationId: string;
  readonly status: "active" | "suspended" | "deauthorized";
}

export interface WebhookProvisionResult extends ResolvedInstallation {
  readonly applied: boolean;
}

export interface ScannableInstallation {
  readonly tenantId: string;
  readonly installationId: string;
  readonly stripeAccountId: string;
  readonly environment: Exclude<StripeEnvironment, "live">;
  readonly tenantStatus: "active";
  readonly installationStatus: "active";
  readonly liveEnabled: false;
  readonly installedAt: Date;
}

interface ResolvedInstallationRow {
  readonly tenant_id: string;
  readonly installation_id: string;
  readonly status: "active" | "suspended" | "deauthorized";
}

interface ScannableInstallationRow {
  readonly tenant_id: string;
  readonly installation_id: string;
  readonly stripe_account_id: string;
  readonly environment: "test" | "sandbox";
  readonly tenant_status: "active";
  readonly installation_status: "active";
  readonly live_enabled: false;
  readonly installed_at: Date;
}

interface WebhookProvisionRow extends ResolvedInstallationRow {
  readonly applied: boolean;
}

export async function resolveInstallation(
  client: PrismaClient,
  stripeAccountId: string,
  environment: StripeEnvironment,
): Promise<ResolvedInstallation | null> {
  if (!STRIPE_ACCOUNT_PATTERN.test(stripeAccountId)) {
    throw new TypeError("Invalid Stripe account ID");
  }
  const rows = await client.$queryRaw<readonly ResolvedInstallationRow[]>`
    SELECT tenant_id, installation_id, status
    FROM refunddesk_resolve_installation(
      ${stripeAccountId}::VARCHAR,
      ${environment}::stripe_environment
    )
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        tenantId: row.tenant_id,
        installationId: row.installation_id,
        status: row.status,
      };
}

export async function resolveWebhookInstallation(
  client: PrismaClient,
  stripeAccountId: string,
  environment: Exclude<StripeEnvironment, "live">,
): Promise<ResolvedInstallation | null> {
  if (!STRIPE_ACCOUNT_PATTERN.test(stripeAccountId)) {
    throw new TypeError("Invalid Stripe account ID");
  }
  const rows = await client.$queryRaw<readonly ResolvedInstallationRow[]>`
    SELECT tenant_id, installation_id, status
    FROM refunddesk_resolve_webhook_installation(
      ${stripeAccountId}::VARCHAR,
      ${environment}::stripe_environment
    )
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        tenantId: row.tenant_id,
        installationId: row.installation_id,
        status: row.status,
      };
}

export async function provisionInstallation(
  client: PrismaClient,
  stripeAccountId: string,
  environment: Exclude<StripeEnvironment, "live">,
): Promise<ResolvedInstallation> {
  if (!STRIPE_ACCOUNT_PATTERN.test(stripeAccountId)) {
    throw new TypeError("Invalid Stripe account ID");
  }
  const rows = await client.$queryRaw<readonly ResolvedInstallationRow[]>`
    SELECT tenant_id, installation_id, status
    FROM refunddesk_provision_installation(
      ${stripeAccountId}::VARCHAR,
      ${environment}::stripe_environment
    )
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Installation provisioning returned no result");
  }
  return {
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    status: row.status,
  };
}

export async function provisionWebhookInstallation(
  client: PrismaClient,
  stripeAccountId: string,
  environment: Exclude<StripeEnvironment, "live">,
  stripeEventId: string,
  stripeEventCreatedAt: Date,
): Promise<WebhookProvisionResult> {
  if (!STRIPE_ACCOUNT_PATTERN.test(stripeAccountId)) {
    throw new TypeError("Invalid Stripe account ID");
  }
  if (!/^evt_[A-Za-z0-9]+$/u.test(stripeEventId)) {
    throw new TypeError("Invalid Stripe event ID");
  }
  if (Number.isNaN(stripeEventCreatedAt.getTime())) {
    throw new TypeError("Invalid Stripe event creation time");
  }
  const rows = await client.$queryRaw<readonly WebhookProvisionRow[]>`
    SELECT tenant_id, installation_id, status, applied
    FROM refunddesk_provision_webhook_installation(
      ${stripeAccountId}::VARCHAR,
      ${environment}::stripe_environment,
      ${stripeEventId}::VARCHAR,
      ${stripeEventCreatedAt}::TIMESTAMPTZ
    )
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Webhook installation provisioning returned no result");
  }
  return {
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    status: row.status,
    applied: row.applied,
  };
}

export async function listScannableInstallations(
  client: PrismaClient,
): Promise<readonly ScannableInstallation[]> {
  const rows = await client.$queryRaw<readonly ScannableInstallationRow[]>`
    SELECT
      tenant_id,
      installation_id,
      stripe_account_id,
      environment,
      tenant_status,
      installation_status,
      live_enabled,
      installed_at
    FROM refunddesk_list_scannable_installations()
  `;
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    stripeAccountId: row.stripe_account_id,
    environment: row.environment,
    tenantStatus: row.tenant_status,
    installationStatus: row.installation_status,
    liveEnabled: row.live_enabled,
    installedAt: row.installed_at,
  }));
}

export async function listActiveTenantIds(client: PrismaClient): Promise<readonly string[]> {
  const rows = await client.$queryRaw<readonly { tenant_id: string }[]>`
    SELECT tenant_id FROM refunddesk_list_active_tenant_ids()
  `;
  return rows.map((row) => row.tenant_id);
}
