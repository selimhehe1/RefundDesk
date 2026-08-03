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
    readonly onRejection?: (event: {
      readonly action: "attest" | "verify";
      readonly code: string;
      readonly reason?: string | undefined;
      readonly status: number;
    }) => void;
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
          ...(signedRequest.onRejection === undefined
            ? {}
            : { signedRequestRejectionObserver: signedRequest.onRejection }),
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
    let verifyCalls = 0;
    let attestCalls = 0;
    const envelope = {
      account_id: "acct_test",
      command_json: "{}",
      is_sandbox: false,
      mode: "test" as const,
      operation: "context.sync" as const,
      request_nonce: "1d48dd30-0eb4-4ce0-a731-57423e57567d",
      resource_type: "account" as const,
      roles_asserted: false as const,
      user_id: "usr_test",
    };
    const authority: WorkerSignedRequestAuthority = {
      attestApproval: (_rawText, signature) => {
        attestCalls += 1;
        if (signature !== "synthetic") {
          return Promise.reject(new WorkerSignedRequestAuthorityError(401, "signature_invalid"));
        }
        return Promise.resolve({
          approvalAttestationId: "0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b",
          canonicalRequestHash: "0".repeat(64),
          envelope,
        });
      },
      verify: (_rawText, signature) => {
        verifyCalls += 1;
        if (signature !== "synthetic") {
          return Promise.reject(new WorkerSignedRequestAuthorityError(401, "signature_invalid"));
        }
        return Promise.resolve({
          canonicalRequestHash: "0".repeat(64),
          envelope,
        });
      },
    };
    const token = Buffer.alloc(32, 7).toString("base64");
    const server = await start(readyProbe(), { authority, token });
    const paths = [
      "/internal/v1/signed-requests/verify",
      "/internal/v1/signed-requests/attest",
    ] as const;

    try {
      for (const path of paths) {
        const unauthorized = await request(server, path, {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        expect(unauthorized.response.status).toBe(403);
        expect(unauthorized.body).toBe('{"status":"unauthorized"}');

        const invalidBearer = await request(server, path, {
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

        const wrongMethod = await request(server, path, {
          headers: { Authorization: `Bearer ${token}` },
          method: "GET",
        });
        expect(wrongMethod.response.status).toBe(405);
        expect(wrongMethod.response.headers.get("allow")).toBe("POST");

        const wrongContentType = await request(server, path, {
          body: "{}",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
            "Stripe-Signature": "synthetic",
          },
          method: "POST",
        });
        expect(wrongContentType.response.status).toBe(400);
        expect(wrongContentType.body).toBe('{"status":"invalid"}');

        const oversized = await request(server, path, {
          body: "x".repeat(32 * 1_024 + 1),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Stripe-Signature": "synthetic",
          },
          method: "POST",
        });
        expect(oversized.response.status).toBe(413);

        const invalidStripeSignature = await request(server, path, {
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
      }
      expect(verifyCalls).toBe(1);
      expect(attestCalls).toBe(1);

      for (const path of paths) {
        for (const suffix of ["?unexpected=true", "/"] as const) {
          const inexact = await request(server, `${path}${suffix}`, {
            body: "{}",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Stripe-Signature": "synthetic",
            },
            method: "POST",
          });
          expect(inexact.response.status).toBe(404);
        }
      }

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
      const verifiedBody = JSON.parse(verified.body) as Record<string, unknown>;
      expect(verifiedBody).toMatchObject({
        canonical_request_hash: "0".repeat(64),
      });
      expect(verifiedBody).not.toHaveProperty("approval_attestation_id");
      expect(Object.keys(verifiedBody).sort()).toEqual(["canonical_request_hash", "envelope"]);

      const attested = await request(server, "/internal/v1/signed-requests/attest", {
        body: "{}",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Stripe-Signature": "synthetic",
        },
        method: "POST",
      });
      expect(attested.response.status).toBe(200);
      const attestedBody = JSON.parse(attested.body) as Record<string, unknown>;
      expect(attestedBody).toMatchObject({
        approval_attestation_id: "0dddf88a-4d04-4ae0-a0ce-4a3056d8bf4b",
        canonical_request_hash: "0".repeat(64),
      });
      expect(Object.keys(attestedBody).sort()).toEqual([
        "approval_attestation_id",
        "canonical_request_hash",
        "envelope",
      ]);
      expect(verifyCalls).toBe(2);
      expect(attestCalls).toBe(2);
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

describe("signed request rejection observability", () => {
  // An attestation the store refuses on a domain precondition and a genuinely
  // malformed envelope both surface as the same opaque rejection, which is right for
  // the caller and was wrong for the operator: nothing recorded which check said no,
  // so a correctly signed request refused for an ineligible approver read as a
  // signing defect. The response is unchanged; only the observer learns the reason.
  const authority = (error: WorkerSignedRequestAuthorityError): WorkerSignedRequestAuthority => ({
    attestApproval: () => Promise.reject(error),
    verify: () => Promise.reject(error),
  });

  it("reports the refused precondition without putting it in the response", async () => {
    const seen: unknown[] = [];
    const server = await start(readyProbe(), {
      authority: authority(
        new WorkerSignedRequestAuthorityError(400, "envelope_invalid", "approver_not_eligible"),
      ),
      token: "verifier-token",
      onRejection: (event) => seen.push(event),
    });

    try {
      const attested = await request(server, "/internal/v1/signed-requests/attest", {
        body: "{}",
        headers: {
          authorization: "Bearer verifier-token",
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=deadbeef",
        },
        method: "POST",
      });

      expect(attested.response.status).toBe(400);
      expect(seen).toEqual([
        {
          action: "attest",
          code: "envelope_invalid",
          reason: "approver_not_eligible",
          status: 400,
        },
      ]);
      expect(attested.body).not.toContain("approver_not_eligible");
      expect(JSON.parse(attested.body)).toEqual({ status: "invalid" });
    } finally {
      await server.close();
    }
  });

  it("still answers when no observer is supplied", async () => {
    const server = await start(readyProbe(), {
      authority: authority(new WorkerSignedRequestAuthorityError(400, "envelope_invalid")),
      token: "verifier-token",
    });

    try {
      const attested = await request(server, "/internal/v1/signed-requests/attest", {
        body: "{}",
        headers: {
          authorization: "Bearer verifier-token",
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=deadbeef",
        },
        method: "POST",
      });

      expect(attested.response.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
