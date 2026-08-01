import { describe, expect, it } from "vitest";

import { startWorkerHealthServer, type RunningWorkerHealthServer } from "../src/health-server.js";
import type { WorkerReadinessProbe } from "../src/readiness.js";
import {
  WorkerSignedRequestAuthorityError,
  type WorkerSignedRequestAuthority,
} from "../src/signed-request-authority.js";

interface CapturedResponse {
  readonly response: Response;
  readonly body: string;
}

function readyProbe(): WorkerReadinessProbe {
  return {
    check: () => Promise.resolve({ ready: true, scanner: "fresh" }),
  };
}

async function start(
  probe: WorkerReadinessProbe,
  signedRequest?: {
    readonly authority: WorkerSignedRequestAuthority;
    readonly token: string;
  },
): Promise<RunningWorkerHealthServer> {
  return startWorkerHealthServer({
    host: "127.0.0.1",
    port: 0,
    readiness: probe,
    ...(signedRequest === undefined
      ? {}
      : {
          signedRequestAuthority: signedRequest.authority,
          signedRequestVerifierToken: signedRequest.token,
        }),
  });
}

async function request(
  server: RunningWorkerHealthServer,
  path: string,
  init?: RequestInit,
): Promise<CapturedResponse> {
  const response = await fetch(`http://${server.address.host}:${server.address.port}${path}`, init);
  return {
    response,
    body: await response.text(),
  };
}

describe("worker health server", () => {
  it("serves generic, non-cacheable liveness without evaluating readiness", async () => {
    let readinessCalls = 0;
    const server = await start({
      check: () => {
        readinessCalls += 1;
        return Promise.reject(new Error("SHOULD_NOT_RUN"));
      },
    });

    try {
      const result = await request(server, "/health?from=orchestrator");

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(result.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(result.response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(result.body).toBe('{"status":"ok"}');
      expect(readinessCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("returns 200 only when the injected readiness probe is ready", async () => {
    const server = await start(readyProbe());

    try {
      const result = await request(server, "/ready");

      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(result.body).toBe('{"status":"ok"}');
    } finally {
      await server.close();
    }
  });

  it("returns a generic 503 without reason, identifiers or secrets when not ready", async () => {
    const server = await start({
      check: () =>
        Promise.resolve({
          ready: false,
          scanner: "stale",
          code: "scanner_stale",
        }),
    });

    try {
      const result = await request(server, "/ready");

      expect(result.response.status).toBe(503);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(result.body).toBe('{"status":"unavailable"}');
      expect(result.body).not.toContain("scanner");
      expect(result.body).not.toContain("tenant");
      expect(result.body).not.toContain("acct_");
    } finally {
      await server.close();
    }
  });

  it("fails closed with the same generic 503 when readiness throws", async () => {
    const server = await start({
      check: () => Promise.reject(new Error("sk_test_sensitive_value acct_sensitive")),
    });

    try {
      const result = await request(server, "/ready");

      expect(result.response.status).toBe(503);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(result.body).toBe('{"status":"unavailable"}');
      expect(result.body).not.toContain("sensitive");
    } finally {
      await server.close();
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])(
    "allows GET only and rejects %s",
    async (method) => {
      const server = await start(readyProbe());

      try {
        const result = await request(server, "/ready", { method });

        expect(result.response.status).toBe(405);
        expect(result.response.headers.get("allow")).toBe("GET");
        expect(result.response.headers.get("cache-control")).toBe("no-store");
        if (method === "HEAD") {
          expect(result.body).toBe("");
        } else {
          expect(result.body).toBe('{"status":"method_not_allowed"}');
        }
      } finally {
        await server.close();
      }
    },
  );

  it("returns a non-cacheable generic 404 for every other path", async () => {
    const server = await start(readyProbe());

    try {
      const result = await request(server, "/metrics");

      expect(result.response.status).toBe(404);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(result.body).toBe('{"status":"not_found"}');
    } finally {
      await server.close();
    }
  });

  it("keeps signed verification private, POST-only and body-bounded", async () => {
    let calls = 0;
    const authority: WorkerSignedRequestAuthority = {
      verifyAndAttest: (_rawText, signature) => {
        calls += 1;
        if (signature === "invalid") {
          return Promise.reject(new WorkerSignedRequestAuthorityError(401, "signature_invalid"));
        }
        return Promise.resolve({
          approvalAttestationId: null,
          canonicalRequestHash: "0".repeat(64),
          envelope: {
            account_id: "acct_test",
            command_json: "{}",
            is_sandbox: false,
            mode: "test",
            operation: "context.sync",
            request_nonce: "1d48dd30-0eb4-4ce0-a731-57423e57567d",
            resource_type: "account",
            roles_asserted: false,
            user_id: "usr_test",
          },
        });
      },
    };
    const token = Buffer.alloc(32, 7).toString("base64");
    const server = await start(readyProbe(), { authority, token });

    try {
      const unauthorized = await request(server, "/internal/v1/signed-requests/verify", {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(unauthorized.response.status).toBe(403);
      expect(unauthorized.body).toBe('{"status":"unauthorized"}');

      const invalidBearer = await request(server, "/internal/v1/signed-requests/verify", {
        body: "{}",
        headers: {
          Authorization: "Bearer invalid-service-token",
          "Content-Type": "application/json",
          "Stripe-Signature": "synthetic",
        },
        method: "POST",
      });
      expect(invalidBearer.response.status).toBe(403);
      expect(invalidBearer.body).toBe('{"status":"unauthorized"}');
      expect(calls).toBe(0);

      const wrongMethod = await request(server, "/internal/v1/signed-requests/verify", {
        headers: { Authorization: `Bearer ${token}` },
        method: "GET",
      });
      expect(wrongMethod.response.status).toBe(405);
      expect(wrongMethod.response.headers.get("allow")).toBe("POST");

      const oversized = await request(server, "/internal/v1/signed-requests/verify", {
        body: "x".repeat(32 * 1_024 + 1),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      expect(oversized.response.status).toBe(413);

      const invalidStripeSignature = await request(server, "/internal/v1/signed-requests/verify", {
        body: "{}",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Stripe-Signature": "invalid",
        },
        method: "POST",
      });
      expect(invalidStripeSignature.response.status).toBe(401);
      expect(invalidStripeSignature.body).toBe('{"status":"unauthorized"}');

      const verified = await request(server, "/internal/v1/signed-requests/verify", {
        body: "{}",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Stripe-Signature": "synthetic",
        },
        method: "POST",
      });
      expect(verified.response.status).toBe(200);
      expect(JSON.parse(verified.body)).toMatchObject({
        approval_attestation_id: null,
        canonical_request_hash: "0".repeat(64),
      });
      expect(calls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("closes idempotently", async () => {
    const server = await start(readyProbe());

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("rejects invalid bindings before opening a socket", async () => {
    await expect(
      startWorkerHealthServer({
        host: "",
        port: -1,
        readiness: readyProbe(),
      }),
    ).rejects.toThrow("INVALID_WORKER_HEALTH_SERVER_BINDING");
  });
});
