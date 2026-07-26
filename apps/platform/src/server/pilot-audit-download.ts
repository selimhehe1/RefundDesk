import { randomUUID } from "node:crypto";

import {
  withTenantTransaction,
  type AuditEvent,
  type Prisma,
  type PrismaClient,
} from "@refunddesk/db";
import { isStripeAdministratorRole } from "@refunddesk/domain";

import { apiError } from "./http";
import { verifyPilotAuditToken } from "./pilot-audit-token";
import { asSafePilotError, PilotApiError } from "./pilot-errors";

const AUDIT_PAGE_SIZE = 1_000;
const AUDIT_EXPORT_LIMIT = 10_000;

export interface PilotAuditDownloadDependencies {
  readonly auditSigningKey: Uint8Array;
  readonly client: PrismaClient;
}

export function isStoredStripeAdministrator(roles: Prisma.JsonValue): boolean {
  if (!Array.isArray(roles)) {
    return false;
  }
  return roles.some((role) => {
    if (typeof role !== "object" || role === null || Array.isArray(role)) {
      return false;
    }
    const id = role["id"];
    const name = role["name"];
    const type = role["type"];
    return (
      (id === undefined || typeof id === "string") &&
      typeof name === "string" &&
      (type === "builtIn" || type === "custom") &&
      isStripeAdministratorRole({
        ...(typeof id === "string" ? { id } : {}),
        name,
        type,
      })
    );
  });
}

export function auditDownloadActorSnapshot(
  approverEnabled: boolean,
  roles: Prisma.JsonValue,
): Prisma.InputJsonObject {
  return {
    explicit_approver: approverEnabled,
    stored_stripe_administrator: isStoredStripeAdministrator(roles),
  };
}

function safeCsvCell(value: string): string {
  const formulaSafe = /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export function renderRedactedAuditCsv(events: readonly AuditEvent[]): string {
  const header = [
    "occurred_at",
    "action",
    "entity_type",
    "entity_id",
    "actor_type",
    "actor_id",
    "schema_version",
  ];
  const rows = events.map((event) =>
    [
      event.occurredAt.toISOString(),
      event.action,
      event.entityType,
      event.entityId,
      event.actorType,
      event.actorId ?? "",
      event.schemaVersion.toString(),
    ]
      .map((cell) => safeCsvCell(cell))
      .join(","),
  );
  return `${header.map((cell) => safeCsvCell(cell)).join(",")}\r\n${rows.join("\r\n")}\r\n`;
}

export function auditCsvResponse(events: readonly AuditEvent[], now = new Date()): Response {
  const date = now.toISOString().slice(0, 10);
  return new Response(renderRedactedAuditCsv(events), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `attachment; filename="refunddesk-audit-${date}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function assertDownloadRoute(request: Request): URL {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (url.pathname !== "/api/v1/audit/download" || keys.length !== 1 || keys[0] !== "token") {
    throw new PilotApiError("ROUTE_MISMATCH", 400, "The audit download route is invalid.");
  }
  return url;
}

export async function handlePilotAuditDownload(
  request: Request,
  dependencies: PilotAuditDownloadDependencies,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const url = assertDownloadRoute(request);
    const rawToken = url.searchParams.get("token");
    if (rawToken === null || rawToken.length > 4_096) {
      throw new PilotApiError(
        "UNAUTHORIZED",
        403,
        "The audit download link is invalid or expired.",
      );
    }
    const token = verifyPilotAuditToken(rawToken, dependencies.auditSigningKey);
    if (token === null) {
      throw new PilotApiError(
        "UNAUTHORIZED",
        403,
        "The audit download link is invalid or expired.",
      );
    }

    const events = await withTenantTransaction(
      dependencies.client,
      token.tenant_id,
      async ({ repositories, tx }) => {
        const installation = await repositories.getInstallationContext(token.installation_id);
        const actor = await tx.tenantUser.findFirst({
          where: {
            stripeUserId: token.actor_id,
            tenantId: token.tenant_id,
          },
        });
        if (
          installation === null ||
          installation.environment !== token.environment ||
          installation.status !== "active" ||
          installation.tenant.status !== "active" ||
          actor === null ||
          (!actor.approverEnabled && !isStoredStripeAdministrator(actor.stripeRoles))
        ) {
          throw new PilotApiError(
            "UNAUTHORIZED",
            403,
            "The audit download link is no longer authorized.",
          );
        }

        const collected: AuditEvent[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await repositories.listAuditEvents({
            ...(cursor === undefined ? {} : { cursor }),
            limit: AUDIT_PAGE_SIZE,
          });
          if (collected.length + page.length > AUDIT_EXPORT_LIMIT) {
            throw new PilotApiError(
              "REQUEST_TOO_LARGE",
              413,
              "The audit export is too large for synchronous download.",
            );
          }
          collected.push(...page);
          if (page.length < AUDIT_PAGE_SIZE) {
            break;
          }
          cursor = page.at(-1)?.id;
        }
        await repositories.appendAuditEvent({
          action: "audit.export_downloaded",
          actorId: actor.stripeUserId,
          actorSnapshot: auditDownloadActorSnapshot(actor.approverEnabled, actor.stripeRoles),
          actorType: "stripe_user",
          correlationRequestId: token.nonce,
          entityId: installation.id,
          entityType: "stripe_installation",
          payload: { exported_event_count: collected.length },
        });
        return collected;
      },
    );

    return auditCsvResponse(events);
  } catch (error) {
    const safeError = asSafePilotError(error);
    return apiError(safeError.code, safeError.message, safeError.status, requestId);
  }
}
