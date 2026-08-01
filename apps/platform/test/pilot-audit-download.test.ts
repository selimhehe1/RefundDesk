import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditEvent, Prisma, PrismaClient } from "@refunddesk/db";

import { handlePilotAuditDownload } from "../src/server/pilot-audit-download.js";
import {
  createPilotAuditToken,
  verifyPilotAuditToken,
  type PilotAuditTokenPayload,
} from "../src/server/pilot-audit-token.js";

const SIGNING_KEY = Buffer.alloc(32, 23);
const TENANT_ID = "b4d99977-29d0-4493-a3bf-25b9719fb570";
const OTHER_TENANT_ID = "7c1b6e04-0c10-4283-bb22-dba6c309409d";
const INSTALLATION_ID = "bc401781-0027-4aa7-8bb4-d4a29fd5cce8";
const ACTOR_ID = "usr_audit_approver";
const TEST_NOW = new Date("2026-07-25T12:00:00.000Z");

type TokenClaims = Omit<PilotAuditTokenPayload, "nonce">;

interface StoredInstallation {
  readonly environment: "sandbox" | "test";
  readonly id: string;
  readonly status: string;
  readonly tenant: { readonly status: string };
  readonly tenantId: string;
}

interface StoredActor {
  readonly approverEnabled: boolean;
  readonly stripeRoles: Prisma.JsonValue;
  readonly stripeUserId: string;
}

interface AuditFindManyArgs {
  readonly cursor?: { readonly id?: string };
  readonly orderBy?: readonly ({ readonly occurredAt: "desc" } | { readonly id: "desc" })[];
  readonly skip?: number;
  readonly take?: number;
  readonly where?: { readonly tenantId?: string };
}

interface AuditCreateData {
  readonly action: string;
  readonly actorId?: string | null;
  readonly actorSnapshot?: Prisma.JsonValue;
  readonly actorType: string;
  readonly correlationRequestId: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly payload?: Prisma.JsonValue;
  readonly schemaVersion?: number;
  readonly tenantId: string;
}

interface FakeAuditDatabaseOptions {
  readonly actor?: StoredActor | null;
  readonly auditReadError?: Error;
  readonly events?: readonly AuditEvent[];
  readonly installation?: StoredInstallation | null;
}

function defaultInstallation(overrides: Partial<StoredInstallation> = {}): StoredInstallation {
  return {
    environment: "test",
    id: INSTALLATION_ID,
    status: "active",
    tenant: { status: "active" },
    tenantId: TENANT_ID,
    ...overrides,
  };
}

function defaultActor(overrides: Partial<StoredActor> = {}): StoredActor {
  return {
    approverEnabled: true,
    stripeRoles: [],
    stripeUserId: ACTOR_ID,
    ...overrides,
  };
}

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function auditEvent(index: number, tenantId = TENANT_ID): AuditEvent {
  return {
    action: `audit.fixture.${index}`,
    actorId: ACTOR_ID,
    actorSnapshot: {},
    actorType: "stripe_user",
    correlationRequestId: uuidFor(100_000 + index),
    entityId: uuidFor(200_000 + index),
    entityType: "refund_request",
    id: uuidFor(index + 1),
    occurredAt: new Date(Date.UTC(2026, 6, 25, 12, 0, 0, 0) - index),
    payload: {},
    schemaVersion: 1,
    tenantId,
  };
}

class FakeAuditDatabase {
  readonly auditCreateInputs: AuditCreateData[] = [];
  readonly auditFindManyInputs: AuditFindManyArgs[] = [];
  readonly client: PrismaClient;
  readonly tenantContexts: string[] = [];
  transactionCount = 0;

  private readonly actor: StoredActor | null;
  private readonly auditReadError: Error | undefined;
  private readonly events: AuditEvent[];
  private readonly installation: StoredInstallation | null;
  private tenantContextReady = false;
  private currentTenantId: string | null = null;

  constructor(options: FakeAuditDatabaseOptions = {}) {
    this.actor = "actor" in options ? (options.actor ?? null) : defaultActor();
    this.auditReadError = options.auditReadError;
    this.events = [...(options.events ?? [])];
    this.installation =
      "installation" in options ? (options.installation ?? null) : defaultInstallation();
    this.client = { $transaction: this.runTransaction.bind(this) } as unknown as PrismaClient;
  }

  private async runTransaction<TResult>(
    operation: (tx: Prisma.TransactionClient) => Promise<TResult>,
  ): Promise<TResult> {
    this.transactionCount += 1;
    this.tenantContextReady = false;
    this.currentTenantId = null;
    return operation(this.transactionClient());
  }

  private transactionClient(): Prisma.TransactionClient {
    return {
      $queryRaw: (_query: TemplateStringsArray, ...values: readonly unknown[]) => {
        const tenantId = values[0];
        if (typeof tenantId !== "string") {
          throw new TypeError("Expected tenant context as the first transaction parameter");
        }
        this.tenantContextReady = true;
        this.currentTenantId = tenantId;
        this.tenantContexts.push(tenantId);
        return Promise.resolve([{ set_config: tenantId }]);
      },
      auditEvent: {
        create: (input: { readonly data: AuditCreateData }) => this.createAuditEvent(input.data),
        findMany: (input: AuditFindManyArgs) => this.findAuditEvents(input),
      },
      stripeInstallation: {
        findFirst: (input: {
          readonly where: { readonly id?: string; readonly tenantId?: string };
        }) => this.findInstallation(input.where),
      },
      tenantUser: {
        findFirst: (input: {
          readonly where: { readonly stripeUserId?: string; readonly tenantId?: string };
        }) => this.findActor(input.where),
      },
    } as unknown as Prisma.TransactionClient;
  }

  private assertTenantContext(): string {
    if (!this.tenantContextReady || this.currentTenantId === null) {
      throw new Error("Tenant data was accessed before transaction context was established");
    }
    return this.currentTenantId;
  }

  private findInstallation(where: {
    readonly id?: string;
    readonly tenantId?: string;
  }): Promise<StoredInstallation | null> {
    const tenantId = this.assertTenantContext();
    if (
      this.installation === null ||
      where.id !== this.installation.id ||
      where.tenantId !== tenantId ||
      this.installation.tenantId !== tenantId
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.installation);
  }

  private findActor(where: {
    readonly stripeUserId?: string;
    readonly tenantId?: string;
  }): Promise<StoredActor | null> {
    const tenantId = this.assertTenantContext();
    if (
      this.actor === null ||
      where.stripeUserId !== this.actor.stripeUserId ||
      where.tenantId !== tenantId
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.actor);
  }

  private findAuditEvents(input: AuditFindManyArgs): Promise<readonly AuditEvent[]> {
    const tenantId = this.assertTenantContext();
    this.auditFindManyInputs.push(input);
    if (input.where?.tenantId !== tenantId) {
      throw new Error("Audit read escaped the active tenant context");
    }
    if (this.auditReadError !== undefined) {
      throw this.auditReadError;
    }
    const limit = input.take ?? 100;
    const cursorId = input.cursor?.id;
    const cursorIndex =
      cursorId === undefined ? 0 : this.events.findIndex((event) => event.id === cursorId);
    if (cursorId !== undefined && cursorIndex < 0) {
      throw new Error("Audit cursor was not found in the fixture");
    }
    const start = cursorIndex + (input.skip ?? 0);
    return Promise.resolve(this.events.slice(start, start + limit));
  }

  private createAuditEvent(data: AuditCreateData): Promise<AuditEvent> {
    const tenantId = this.assertTenantContext();
    if (data.tenantId !== tenantId) {
      throw new Error("Audit write escaped the active tenant context");
    }
    this.auditCreateInputs.push(data);
    const created: AuditEvent = {
      action: data.action,
      actorId: data.actorId ?? null,
      actorSnapshot: data.actorSnapshot ?? {},
      actorType: data.actorType,
      correlationRequestId: data.correlationRequestId,
      entityId: data.entityId,
      entityType: data.entityType,
      id: uuidFor(900_000 + this.auditCreateInputs.length),
      occurredAt: new Date(Date.UTC(2026, 6, 25, 13, 0, 0, this.auditCreateInputs.length)),
      payload: data.payload ?? {},
      schemaVersion: data.schemaVersion ?? 1,
      tenantId,
    };
    this.events.unshift(created);
    return Promise.resolve(created);
  }
}

function tokenClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    actor_id: ACTOR_ID,
    environment: "test",
    expires_at: new Date(Date.now() + 4 * 60 * 1_000).toISOString(),
    installation_id: INSTALLATION_ID,
    tenant_id: TENANT_ID,
    ...overrides,
  };
}

function auditToken(overrides: Partial<TokenClaims> = {}): string {
  return createPilotAuditToken(tokenClaims(overrides), SIGNING_KEY);
}

function requestForToken(token: string): Request {
  const url = new URL("https://refunddesk.example/api/v1/audit/download");
  url.searchParams.set("token", token);
  return new Request(url);
}

function tamperSignature(token: string): string {
  const segments = token.split(".");
  const signature = segments[2];
  if (segments.length !== 3 || signature === undefined || signature.length === 0) {
    throw new TypeError("Expected a three-segment audit token");
  }
  const replacement = signature.startsWith("A") ? "B" : "A";
  return `${segments[0]}.${segments[1]}.${replacement}${signature.slice(1)}`;
}

async function errorBody(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const value = (await response.json()) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an API error object");
  }
  return value as Readonly<Record<string, unknown>>;
}

async function download(token: string, database: FakeAuditDatabase): Promise<Response> {
  return handlePilotAuditDownload(requestForToken(token), {
    auditSigningKey: SIGNING_KEY,
    client: database.client,
  });
}

describe("pilot audit download handler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: TEST_NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects malformed routes and invalid bearer links before opening a transaction", async () => {
    const database = new FakeAuditDatabase();
    const valid = auditToken();
    const expired = auditToken({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const cases = [
      {
        code: "ROUTE_MISMATCH",
        request: new Request("https://refunddesk.example/api/v1/audit/other?token=value"),
        status: 400,
      },
      {
        code: "ROUTE_MISMATCH",
        request: new Request("https://refunddesk.example/api/v1/audit/download"),
        status: 400,
      },
      {
        code: "ROUTE_MISMATCH",
        request: new Request(
          `https://refunddesk.example/api/v1/audit/download?token=${encodeURIComponent(valid)}&extra=1`,
        ),
        status: 400,
      },
      {
        code: "ROUTE_MISMATCH",
        request: new Request(
          `https://refunddesk.example/api/v1/audit/download?token=${encodeURIComponent(valid)}&token=duplicate`,
        ),
        status: 400,
      },
      {
        code: "UNAUTHORIZED",
        request: new Request("https://refunddesk.example/api/v1/audit/download?token="),
        status: 403,
      },
      {
        code: "UNAUTHORIZED",
        request: requestForToken("x".repeat(4_097)),
        status: 403,
      },
      {
        code: "UNAUTHORIZED",
        request: requestForToken(tamperSignature(valid)),
        status: 403,
      },
      {
        code: "UNAUTHORIZED",
        request: requestForToken(expired),
        status: 403,
      },
    ] as const;

    for (const testCase of cases) {
      const response = await handlePilotAuditDownload(testCase.request, {
        auditSigningKey: SIGNING_KEY,
        client: database.client,
      });
      expect(response.status).toBe(testCase.status);
      expect(await errorBody(response)).toMatchObject({ code: testCase.code });
    }
    expect(database.transactionCount).toBe(0);
  });

  it("rejects stale or cross-context authorization bindings inside the token tenant", async () => {
    const deniedCases: readonly {
      readonly database: FakeAuditDatabase;
      readonly token: string;
    }[] = [
      { database: new FakeAuditDatabase({ installation: null }), token: auditToken() },
      {
        database: new FakeAuditDatabase({
          installation: defaultInstallation({ environment: "sandbox" }),
        }),
        token: auditToken(),
      },
      {
        database: new FakeAuditDatabase({
          installation: defaultInstallation({ status: "deauthorized" }),
        }),
        token: auditToken(),
      },
      {
        database: new FakeAuditDatabase({
          installation: defaultInstallation({ tenant: { status: "pending_deletion" } }),
        }),
        token: auditToken(),
      },
      { database: new FakeAuditDatabase({ actor: null }), token: auditToken() },
      {
        database: new FakeAuditDatabase({ actor: defaultActor({ approverEnabled: false }) }),
        token: auditToken(),
      },
      {
        database: new FakeAuditDatabase({
          actor: defaultActor({
            approverEnabled: false,
            stripeRoles: [{ id: "super_admin", name: "Super Administrator", type: "custom" }],
          }),
        }),
        token: auditToken(),
      },
      {
        database: new FakeAuditDatabase(),
        token: auditToken({ actor_id: "usr_different" }),
      },
      {
        database: new FakeAuditDatabase(),
        token: auditToken({ tenant_id: OTHER_TENANT_ID }),
      },
    ];

    for (const testCase of deniedCases) {
      const response = await download(testCase.token, testCase.database);
      expect(response.status).toBe(403);
      expect(await errorBody(response)).toMatchObject({ code: "UNAUTHORIZED" });
      expect(testCase.database.transactionCount).toBe(1);
      expect(testCase.database.auditCreateInputs).toHaveLength(0);
    }
  });

  it.each([
    {
      actor: defaultActor({ approverEnabled: true, stripeRoles: [] }),
      description: "an explicit approver",
    },
    {
      actor: defaultActor({
        approverEnabled: false,
        stripeRoles: [{ id: "super_admin", name: "Super Administrator", type: "builtIn" }],
      }),
      description: "a persisted built-in Administrator",
    },
  ])("allows $description after revalidating stored access", async ({ actor }) => {
    const database = new FakeAuditDatabase({ actor, events: [auditEvent(0)] });

    const response = await download(auditToken(), database);

    expect(response.status).toBe(200);
    expect(database.transactionCount).toBe(1);
    expect(database.tenantContexts).toEqual([TENANT_ID]);
    expect(database.auditCreateInputs).toHaveLength(1);
  });

  it("paginates the tenant audit and records the token nonce with the exported count", async () => {
    const events = Array.from({ length: 1_001 }, (_, index) => auditEvent(index));
    const database = new FakeAuditDatabase({ events });
    const token = auditToken();
    const verified = verifyPilotAuditToken(token, SIGNING_KEY);
    if (verified === null) {
      throw new TypeError("Expected the generated token to verify");
    }

    const response = await download(token, database);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(database.auditFindManyInputs).toHaveLength(2);
    expect(database.auditFindManyInputs[0]).toMatchObject({
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 1_000,
    });
    expect(database.auditFindManyInputs[0]).not.toHaveProperty("cursor");
    expect(database.auditFindManyInputs[0]).not.toHaveProperty("skip");
    expect(database.auditFindManyInputs[1]).toMatchObject({
      cursor: { id: events[999]?.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: 1,
      take: 1_000,
    });
    expect(database.auditCreateInputs).toHaveLength(1);
    expect(database.auditCreateInputs[0]).toMatchObject({
      action: "audit.export_downloaded",
      actorId: ACTOR_ID,
      correlationRequestId: verified.nonce,
      entityId: INSTALLATION_ID,
      payload: { exported_event_count: 1_001 },
      tenantId: TENANT_ID,
    });
    const csv = await response.text();
    expect(csv.split("\r\n")).toHaveLength(1_003);
    expect(csv).toContain(events[0]?.entityId);
    expect(csv).toContain(events.at(-1)?.entityId);
  });

  it("accepts exactly ten thousand events and rejects the first event beyond the cap", async () => {
    const exactDatabase = new FakeAuditDatabase({
      events: Array.from({ length: 10_000 }, (_, index) => auditEvent(index)),
    });
    const oversizedDatabase = new FakeAuditDatabase({
      events: Array.from({ length: 10_001 }, (_, index) => auditEvent(index)),
    });

    const exact = await download(auditToken(), exactDatabase);
    const oversized = await download(auditToken(), oversizedDatabase);

    expect(exact.status).toBe(200);
    expect(exactDatabase.auditFindManyInputs).toHaveLength(11);
    expect(exactDatabase.auditCreateInputs[0]?.payload).toEqual({
      exported_event_count: 10_000,
    });
    expect(oversized.status).toBe(413);
    expect(await errorBody(oversized)).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(oversizedDatabase.auditFindManyInputs).toHaveLength(11);
    expect(oversizedDatabase.auditCreateInputs).toHaveLength(0);
  });

  it("returns only a generic error when tenant persistence fails", async () => {
    const database = new FakeAuditDatabase({
      auditReadError: new Error("sensitive synthetic database detail"),
    });

    const response = await download(auditToken(), database);
    const body = await errorBody(response);

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "RefundDesk could not complete the request.",
    });
    expect(JSON.stringify(body)).not.toContain("sensitive synthetic database detail");
    expect(database.auditCreateInputs).toHaveLength(0);
  });

  it("documents that one valid bearer link is replayable until expiry and audits every download", async () => {
    const database = new FakeAuditDatabase({ events: [auditEvent(0)] });
    const token = auditToken();
    const verified = verifyPilotAuditToken(token, SIGNING_KEY);
    if (verified === null) {
      throw new TypeError("Expected the generated token to verify");
    }

    const first = await download(token, database);
    const second = await download(token, database);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(database.transactionCount).toBe(2);
    expect(database.auditCreateInputs).toHaveLength(2);
    expect(database.auditCreateInputs.map((input) => input.correlationRequestId)).toEqual([
      verified.nonce,
      verified.nonce,
    ]);
    expect(database.auditCreateInputs.map((input) => input.payload)).toEqual([
      { exported_event_count: 1 },
      { exported_event_count: 2 },
    ]);
    expect(await second.text()).toContain("audit.export_downloaded");
  });
});
