import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { WorkerReadinessProbe } from "./readiness.js";
import {
  WorkerSignedRequestAuthorityError,
  type WorkerSignedRequestAuthority,
} from "./signed-request-authority.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const RESPONSE_OK = JSON.stringify({ status: "ok" });
const RESPONSE_UNAVAILABLE = JSON.stringify({ status: "unavailable" });
const RESPONSE_NOT_FOUND = JSON.stringify({ status: "not_found" });
const RESPONSE_METHOD_NOT_ALLOWED = JSON.stringify({ status: "method_not_allowed" });
const RESPONSE_UNAUTHORIZED = JSON.stringify({ status: "unauthorized" });
const RESPONSE_INVALID = JSON.stringify({ status: "invalid" });
const RESPONSE_CONFLICT = JSON.stringify({ status: "conflict" });
const RESPONSE_TOO_LARGE = JSON.stringify({ status: "too_large" });
const MAX_SIGNED_BODY_BYTES = 32 * 1_024;

export interface WorkerHealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly readiness: WorkerReadinessProbe;
  readonly signedRequestAuthority?: WorkerSignedRequestAuthority;
  readonly signedRequestVerifierToken?: string;
}

export interface RunningWorkerHealthServer {
  readonly address: {
    readonly host: string;
    readonly port: number;
  };
  close(): Promise<void>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: string,
  additionalHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body, "utf8").toString(),
    "Content-Type": JSON_CONTENT_TYPE,
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
  });
  response.end(body);
}

function requestTarget(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://refunddesk-worker.invalid");
  } catch {
    return null;
  }
}

function authorizationMatches(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) {
    return false;
  }
  const supplied = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

async function readBoundedBody(request: IncomingMessage): Promise<string | null> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^(?:0|[1-9]\d*)$/u.test(contentLength) ||
      Number.parseInt(contentLength, 10) > MAX_SIGNED_BODY_BYTES)
  ) {
    request.resume();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const stream: AsyncIterable<unknown> = request;
  for await (const chunk of stream) {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      request.destroy();
      return null;
    }
    const buffer = Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_SIGNED_BODY_BYTES) {
      request.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

type SignedRequestAction = "attest" | "verify";

async function handleSignedRequestAuthority(
  request: IncomingMessage,
  response: ServerResponse,
  authority: WorkerSignedRequestAuthority,
  authorizationToken: string,
  action: SignedRequestAction,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, RESPONSE_METHOD_NOT_ALLOWED, { Allow: "POST" });
    return;
  }
  if (!authorizationMatches(request.headers.authorization, authorizationToken)) {
    request.resume();
    sendJson(response, 403, RESPONSE_UNAUTHORIZED);
    return;
  }
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    request.resume();
    sendJson(response, 400, RESPONSE_INVALID);
    return;
  }
  const rawText = await readBoundedBody(request);
  if (rawText === null) {
    sendJson(response, 413, RESPONSE_TOO_LARGE);
    return;
  }
  try {
    const stripeSignature =
      typeof request.headers["stripe-signature"] === "string"
        ? request.headers["stripe-signature"]
        : null;
    if (action === "attest") {
      const attested = await authority.attestApproval(rawText, stripeSignature);
      sendJson(
        response,
        200,
        JSON.stringify({
          approval_attestation_id: attested.approvalAttestationId,
          canonical_request_hash: attested.canonicalRequestHash,
          envelope: attested.envelope,
        }),
      );
      return;
    }
    const verified = await authority.verify(rawText, stripeSignature);
    sendJson(
      response,
      200,
      JSON.stringify({
        canonical_request_hash: verified.canonicalRequestHash,
        envelope: verified.envelope,
      }),
    );
  } catch (error) {
    if (error instanceof WorkerSignedRequestAuthorityError) {
      const body =
        error.status === 401
          ? RESPONSE_UNAUTHORIZED
          : error.status === 409
            ? RESPONSE_CONFLICT
            : error.status === 503
              ? RESPONSE_UNAVAILABLE
              : RESPONSE_INVALID;
      sendJson(response, error.status, body);
      return;
    }
    sendJson(response, 503, RESPONSE_UNAVAILABLE);
  }
}

export async function handleWorkerHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  readiness: WorkerReadinessProbe,
  signedRequest?: {
    readonly authority: WorkerSignedRequestAuthority;
    readonly authorizationToken: string;
  },
): Promise<void> {
  const target = requestTarget(request);
  const path = target?.pathname ?? null;
  const signedRequestAction: SignedRequestAction | null =
    target === null || target.search.length > 0 || target.hash.length > 0
      ? null
      : path === "/internal/v1/signed-requests/verify"
        ? "verify"
        : path === "/internal/v1/signed-requests/attest"
          ? "attest"
          : null;
  if (signedRequestAction !== null) {
    if (signedRequest === undefined) {
      sendJson(response, 404, RESPONSE_NOT_FOUND);
      return;
    }
    await handleSignedRequestAuthority(
      request,
      response,
      signedRequest.authority,
      signedRequest.authorizationToken,
      signedRequestAction,
    );
    return;
  }
  const isKnownPath = path === "/health" || path === "/ready";

  if (!isKnownPath) {
    sendJson(response, 404, RESPONSE_NOT_FOUND);
    return;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, RESPONSE_METHOD_NOT_ALLOWED, { Allow: "GET" });
    return;
  }
  if (path === "/health") {
    sendJson(response, 200, RESPONSE_OK);
    return;
  }

  try {
    const result = await readiness.check();
    sendJson(response, result.ready ? 200 : 503, result.ready ? RESPONSE_OK : RESPONSE_UNAVAILABLE);
  } catch {
    sendJson(response, 503, RESPONSE_UNAVAILABLE);
  }
}

function createHealthServer(
  readiness: WorkerReadinessProbe,
  signedRequest:
    | {
        readonly authority: WorkerSignedRequestAuthority;
        readonly authorizationToken: string;
      }
    | undefined,
): Server {
  return createServer((request, response) => {
    void handleWorkerHealthRequest(request, response, readiness, signedRequest).catch(() => {
      if (!response.headersSent && !response.writableEnded) {
        sendJson(response, 503, RESPONSE_UNAVAILABLE);
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
}

async function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("WORKER_HEALTH_SERVER_ADDRESS_UNAVAILABLE");
  }
  return address;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

export async function startWorkerHealthServer(
  options: WorkerHealthServerOptions,
): Promise<RunningWorkerHealthServer> {
  if (
    options.host.length === 0 ||
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error("INVALID_WORKER_HEALTH_SERVER_BINDING");
  }

  if (
    (options.signedRequestAuthority === undefined) !==
    (options.signedRequestVerifierToken === undefined)
  ) {
    throw new Error("INCOMPLETE_SIGNED_REQUEST_AUTHORITY_CONFIGURATION");
  }
  const server = createHealthServer(
    options.readiness,
    options.signedRequestAuthority === undefined || options.signedRequestVerifierToken === undefined
      ? undefined
      : {
          authority: options.signedRequestAuthority,
          authorizationToken: options.signedRequestVerifierToken,
        },
  );
  const address = await listen(server, options.host, options.port);
  let closing: Promise<void> | null = null;

  return {
    address: {
      host: address.address,
      port: address.port,
    },
    close(): Promise<void> {
      closing ??= closeServer(server);
      return closing;
    },
  };
}
