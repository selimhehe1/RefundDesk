import { createHash, createHmac } from "node:crypto";

// The real host helper copies these non-secret source bytes into the web
// container, then streams one root-controlled canonical JSON input through an
// anonymous docker-exec stdin pipe. Nothing sensitive is accepted in argv,
// written to a named file or emitted by this client.
const unitTestMode = process.env.REFUNDDESK_INCIDENT_PROOF_CLIENT_UNIT_TEST === "1";
function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonKeys(value[key])]),
    );
  }
  return value;
}
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32_768) process.exit(64);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (
    raw.length === 0 ||
    !raw.subarray(-1).equals(Buffer.from("\n")) ||
    raw.subarray(0, -1).includes(0x0a) ||
    raw.includes(0x0d) ||
    raw.includes(0x00) ||
    raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  ) {
    process.exit(64);
  }
  let value;
  try {
    value = JSON.parse(raw.subarray(0, -1).toString("utf8"));
  } catch {
    process.exit(64);
  }
  if (`${JSON.stringify(sortJsonKeys(value))}\n` !== raw.toString("utf8")) process.exit(64);
  return value;
}
const input = unitTestMode ? undefined : await readInput();
const required = [
  "accountId",
  "amountMinor",
  "approverUserId",
  "appSigningSecret",
  "currency",
  "deadline",
  "denialPaymentIntentId",
  "operation",
  "phase",
  "readKey",
  "refundablePaymentIntentId",
  "resume",
  "stripeBaseline",
  "requesterUserId",
  "resumeState",
];
if (
  !unitTestMode &&
  (input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !== [...required].sort().join("\0"))
) {
  process.exit(64);
}
if (
  !unitTestMode &&
  (!["baseline", "effect"].includes(input.phase) ||
    input.amountMinor !== "1" ||
    input.currency !== "eur" ||
    typeof input.deadline !== "string" ||
    !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u.test(input.deadline) ||
    !Number.isFinite(Date.parse(input.deadline)) ||
    Date.parse(input.deadline) - Date.now() < 45_000 ||
    Date.parse(input.deadline) - Date.now() > 900_000 ||
    typeof input.resume !== "boolean" ||
    !/^acct_[A-Za-z0-9]{6,64}$/u.test(input.accountId) ||
    !/^rk_test_[A-Za-z0-9]{12,256}$/u.test(input.readKey) ||
    !/^absec_[A-Za-z0-9_]{12,256}$/u.test(input.appSigningSecret) ||
    !/^pi_[A-Za-z0-9]{6,64}$/u.test(input.denialPaymentIntentId) ||
    !/^pi_[A-Za-z0-9]{6,64}$/u.test(input.refundablePaymentIntentId) ||
    input.denialPaymentIntentId === input.refundablePaymentIntentId ||
    !/^usr_[A-Za-z0-9]{6,64}$/u.test(input.requesterUserId) ||
    !/^usr_[A-Za-z0-9]{6,64}$/u.test(input.approverUserId) ||
    input.requesterUserId === input.approverUserId)
) {
  process.exit(64);
}
if (
  !unitTestMode &&
  (input.resumeState === null ||
    typeof input.resumeState !== "object" ||
    Array.isArray(input.resumeState) ||
    Object.keys(input.resumeState).sort().join("\0") !==
      [
        "bounded",
        "databaseProjectionSha256",
        "pristine",
        "refundIdSha256",
        "refundLinked",
        "terminalExact",
      ]
        .sort()
        .join("\0") ||
    input.resumeState.bounded !== true ||
    typeof input.resumeState.pristine !== "boolean" ||
    typeof input.resumeState.refundLinked !== "boolean" ||
    typeof input.resumeState.terminalExact !== "boolean" ||
    (input.resumeState.refundLinked
      ? !/^[0-9a-f]{64}$/u.test(input.resumeState.refundIdSha256)
      : input.resumeState.refundIdSha256 !== null) ||
    !/^[0-9a-f]{64}$/u.test(input.resumeState.databaseProjectionSha256) ||
    (input.resumeState.terminalExact && !input.resumeState.refundLinked) ||
    (input.resumeState.pristine &&
      (input.resumeState.refundLinked || input.resumeState.terminalExact)) ||
    (!input.resume &&
      (!input.resumeState.pristine ||
        input.resumeState.refundLinked ||
        input.resumeState.terminalExact)))
) {
  process.exit(64);
}

const emit = (value, status = 0) => {
  process.stdout.write(`${JSON.stringify(sortJsonKeys(value))}\n`);
  process.exit(status);
};
const uuid = (label) => {
  const digest = createHmac("sha256", input.operation).update(label).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
const roles = [{ type: "builtIn", name: "Administrator" }];
const sign = (raw, secret = input.appSigningSecret) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
};
const commandJson = (command) => JSON.stringify(sortJsonKeys(command));
const serializeEnvelope = ({ operation, nonce, resourceId, userId, command }) =>
  JSON.stringify({
    operation,
    request_nonce: nonce,
    mode: "test",
    is_sandbox: true,
    resource_type: resourceId === undefined ? "account" : "payment_intent",
    ...(resourceId === undefined ? {} : { resource_id: resourceId }),
    command_json: commandJson(command),
    roles_asserted: true,
    stripe_roles: roles,
    user_id: userId,
    account_id: input.accountId,
  });

const authorityStopAt = unitTestMode ? 0 : Date.parse(input.deadline) - 45_000;
const MAX_RESPONSE_BYTES = 131_072;
const boundedNetworkSignal = () => {
  const remaining = authorityStopAt - Date.now();
  if (remaining < 1) throw new AmbiguousProofError("ADMISSION_AUTHORITY_DEADLINE");
  return AbortSignal.timeout(Math.min(15_000, remaining));
};

async function pilot(path, envelope, secret = input.appSigningSecret) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    body: envelope,
    headers: {
      "Accept-Encoding": "identity",
      "Content-Type": "application/json",
      "Stripe-Signature": sign(envelope, secret),
    },
    method: "POST",
    redirect: "error",
    signal: boundedNetworkSignal(),
  });
  const body = await readBoundedJsonResponse(response);
  return { body, status: response.status };
}

async function stripe(path, init = {}) {
  return fetch(`https://api.stripe.com${path}`, {
    ...init,
    headers: {
      "Accept-Encoding": "identity",
      Authorization: `Bearer ${input.readKey}`,
      "Stripe-Version": "2026-06-24.dahlia",
      ...(init.headers ?? {}),
    },
    redirect: "error",
    signal: boundedNetworkSignal(),
  });
}

async function stripeJson(path, init = {}) {
  const response = await stripe(path, init);
  const body = await readBoundedJsonResponse(response);
  return { body, status: response.status };
}

export async function readBoundedJsonResponse(response, maximumBytes = MAX_RESPONSE_BYTES) {
  if (
    response === null ||
    typeof response !== "object" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_RESPONSE_BYTES ||
    response.body === null ||
    typeof response.body?.getReader !== "function"
  ) {
    throw new Error("RESPONSE_BODY_INVALID");
  }
  const encoding = response.headers?.get?.("content-encoding");
  if (encoding !== null && encoding !== "" && encoding.toLowerCase() !== "identity") {
    await response.body.cancel().catch(() => undefined);
    throw new Error("RESPONSE_ENCODING_FORBIDDEN");
  }
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength !== null &&
    (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > maximumBytes ||
      !Number.isSafeInteger(Number(declaredLength)))
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("RESPONSE_LENGTH_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let observed = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("RESPONSE_CHUNK_INVALID");
      observed += value.byteLength;
      if (observed > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && observed !== Number(declaredLength)) {
    throw new Error("RESPONSE_LENGTH_MISMATCH");
  }
  const raw = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    observed,
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("RESPONSE_UTF8_INVALID");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("RESPONSE_JSON_INVALID");
  }
}

export const denialIdempotencyKey = (operation) => {
  if (!/^[0-9a-f]{64}$/u.test(operation)) throw new Error("OPERATION_INVALID");
  return `refunddesk:incident-admission-denial:${createHash("sha256").update(operation).digest("hex")}`;
};

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const strictTimestamp = (value) =>
  typeof value === "string" &&
  /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function validateSettingsAuthority(settings, approverUserId) {
  if (
    !exactKeys(settings, [
      "approver_user_ids",
      "expiration_days",
      "onboarding_completed",
      "observed_users",
    ]) ||
    !Array.isArray(settings.approver_user_ids) ||
    settings.approver_user_ids.length > 100 ||
    settings.approver_user_ids.some(
      (value) =>
        typeof value !== "string" || !/^usr_[A-Za-z0-9]+$/u.test(value) || value.length > 255,
    ) ||
    new Set(settings.approver_user_ids).size !== settings.approver_user_ids.length ||
    !settings.approver_user_ids.includes(approverUserId) ||
    settings.expiration_days !== 7 ||
    settings.onboarding_completed !== true ||
    !Array.isArray(settings.observed_users) ||
    settings.observed_users.length > 500
  ) {
    return false;
  }
  const observedIds = new Set();
  for (const user of settings.observed_users) {
    if (
      !exactKeys(user, ["approver_enabled", "display_name", "last_seen_at", "stripe_user_id"]) ||
      typeof user.stripe_user_id !== "string" ||
      !/^usr_[A-Za-z0-9]+$/u.test(user.stripe_user_id) ||
      user.stripe_user_id.length > 255 ||
      (user.display_name !== null &&
        (typeof user.display_name !== "string" || user.display_name.length > 255)) ||
      typeof user.approver_enabled !== "boolean" ||
      !strictTimestamp(user.last_seen_at) ||
      observedIds.has(user.stripe_user_id)
    ) {
      return false;
    }
    observedIds.add(user.stripe_user_id);
  }
  return settings.approver_user_ids.every((id) =>
    settings.observed_users.some(
      (user) => user.stripe_user_id === id && user.approver_enabled === true,
    ),
  );
}

class AmbiguousProofError extends Error {}

async function refundSet(paymentIntentId) {
  const query = new URLSearchParams({ limit: "100", payment_intent: paymentIntentId });
  const response = await stripeJson(`/v1/refunds?${query}`);
  if (
    response.status !== 200 ||
    !exactKeys(response.body, ["data", "has_more", "object", "url"]) ||
    response.body.object !== "list" ||
    response.body.has_more !== false ||
    response.body.url !== "/v1/refunds" ||
    !Array.isArray(response.body.data)
  ) {
    throw new Error("REFUND_LIST_FAILED");
  }
  const projection = response.body.data
    .map((item) => ({
      amount: item?.amount,
      currency: item?.currency,
      id: item?.id,
      object: item?.object,
      payment_intent: item?.payment_intent,
      status: item?.status,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const item of projection) {
    if (
      !exactKeys(item, ["amount", "currency", "id", "object", "payment_intent", "status"]) ||
      !/^re_[A-Za-z0-9]{6,64}$/u.test(item.id) ||
      item.object !== "refund" ||
      item.payment_intent !== paymentIntentId ||
      !Number.isSafeInteger(item.amount) ||
      item.amount <= 0 ||
      item.currency !== "eur" ||
      typeof item.status !== "string"
    ) {
      throw new Error("REFUND_LIST_INVALID");
    }
  }
  const canonical = JSON.stringify(sortJsonKeys(projection));
  return {
    count: projection.length,
    digest: createHash("sha256").update(canonical).digest("hex"),
    projection,
  };
}

const refundProjectionDigest = (projection) =>
  createHash("sha256")
    .update(JSON.stringify(sortJsonKeys(projection)))
    .digest("hex");

export function identifyPersistedRefund(projection, baselineDigest, linkedRefundIdSha256 = null) {
  if (
    !Array.isArray(projection) ||
    !/^[0-9a-f]{64}$/u.test(baselineDigest) ||
    (linkedRefundIdSha256 !== null && !/^[0-9a-f]{64}$/u.test(linkedRefundIdSha256))
  ) {
    return null;
  }
  const candidates = projection.filter((candidate, candidateIndex) => {
    if (
      candidate?.amount !== 1 ||
      candidate?.currency !== "eur" ||
      candidate?.object !== "refund" ||
      candidate?.status !== "succeeded" ||
      typeof candidate.id !== "string" ||
      (linkedRefundIdSha256 !== null &&
        createHash("sha256").update(candidate.id).digest("hex") !== linkedRefundIdSha256)
    ) {
      return false;
    }
    return (
      refundProjectionDigest(
        projection.filter((_item, itemIndex) => itemIndex !== candidateIndex),
      ) === baselineDigest
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

async function assertAccount() {
  const account = await stripeJson("/v1/account");
  if (account.status !== 200 || account.body?.id !== input.accountId) {
    throw new Error("ACCOUNT_BINDING_INVALID");
  }
}

async function readPayment(paymentIntentId, fullyRefunded) {
  const expanded = new URLSearchParams();
  expanded.append("expand[]", "latest_charge");
  const payment = await stripeJson(
    `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?${expanded}`,
  );
  if (
    payment.status !== 200 ||
    payment.body?.id !== paymentIntentId ||
    payment.body?.livemode !== false ||
    payment.body?.currency !== "eur" ||
    payment.body?.status !== "succeeded"
  ) {
    throw new Error("PAYMENT_READ_FAILED");
  }
  const chargeId =
    typeof payment.body.latest_charge === "string"
      ? payment.body.latest_charge
      : payment.body.latest_charge?.id;
  if (!/^ch_[A-Za-z0-9]{6,64}$/u.test(chargeId ?? "")) throw new Error("CHARGE_ID_INVALID");
  const charge = await stripeJson(`/v1/charges/${encodeURIComponent(chargeId)}`);
  const remaining = charge.body?.amount - charge.body?.amount_refunded;
  if (
    charge.status !== 200 ||
    charge.body?.id !== chargeId ||
    charge.body?.object !== "charge" ||
    charge.body?.payment_intent !== paymentIntentId ||
    charge.body?.livemode !== false ||
    charge.body?.currency !== "eur" ||
    charge.body?.status !== "succeeded" ||
    charge.body?.paid !== true ||
    charge.body?.captured !== true ||
    !Number.isSafeInteger(charge.body?.amount) ||
    !Number.isSafeInteger(charge.body?.amount_refunded) ||
    charge.body.amount <= 0 ||
    (fullyRefunded
      ? charge.body.refunded !== true ||
        remaining !== 0 ||
        charge.body.amount_refunded !== charge.body.amount
      : remaining < 1)
  ) {
    throw new Error("CHARGE_READ_FAILED");
  }
  return { chargeId };
}

async function main() {
  try {
    await assertAccount();
    await readPayment(input.denialPaymentIntentId, true);
    await readPayment(input.refundablePaymentIntentId, false);
    const denialBefore = await refundSet(input.denialPaymentIntentId);
    const refundableBefore = await refundSet(input.refundablePaymentIntentId);

    const denialBody = new URLSearchParams({
      amount: "1",
      payment_intent: input.denialPaymentIntentId,
      reason: "requested_by_customer",
    });
    const denied = await stripeJson("/v1/refunds", {
      body: denialBody,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": denialIdempotencyKey(input.operation),
      },
      method: "POST",
    });
    if (denied.status !== 403 || denied.body?.error?.code !== "more_permissions_required") {
      throw new Error("READ_KEY_EFFECT_NOT_DENIED");
    }
    const denialAfter = await refundSet(input.denialPaymentIntentId);
    if (denialAfter.count !== denialBefore.count || denialAfter.digest !== denialBefore.digest) {
      throw new Error("DENIAL_REFUND_SET_CHANGED");
    }

    if (input.phase === "baseline") {
      if (
        input.stripeBaseline !== null ||
        !input.resumeState.pristine ||
        input.resumeState.terminalExact
      ) {
        throw new Error("BASELINE_INPUT_INVALID");
      }
      emit({
        accountExact: true,
        complete: true,
        denialRefundCount: denialBefore.count,
        denialRefundSetSha256: denialBefore.digest,
        readChargeSucceeded: true,
        readPaymentIntentSucceeded: true,
        readRefundCreateDenied: true,
        refundableRefundCount: refundableBefore.count,
        refundableRefundSetSha256: refundableBefore.digest,
      });
    }

    const baselineKeys = [
      "denialRefundCount",
      "denialRefundSetSha256",
      "refundableRefundCount",
      "refundableRefundSetSha256",
    ];
    if (
      !exactKeys(input.stripeBaseline, baselineKeys) ||
      !Number.isSafeInteger(input.stripeBaseline.denialRefundCount) ||
      !Number.isSafeInteger(input.stripeBaseline.refundableRefundCount) ||
      input.stripeBaseline.denialRefundCount < 1 ||
      input.stripeBaseline.refundableRefundCount < 0 ||
      !/^[0-9a-f]{64}$/u.test(input.stripeBaseline.denialRefundSetSha256) ||
      !/^[0-9a-f]{64}$/u.test(input.stripeBaseline.refundableRefundSetSha256) ||
      denialBefore.count !== input.stripeBaseline.denialRefundCount ||
      denialBefore.digest !== input.stripeBaseline.denialRefundSetSha256 ||
      ![
        input.stripeBaseline.refundableRefundCount,
        input.stripeBaseline.refundableRefundCount + 1,
      ].includes(refundableBefore.count) ||
      (refundableBefore.count === input.stripeBaseline.refundableRefundCount &&
        refundableBefore.digest !== input.stripeBaseline.refundableRefundSetSha256) ||
      (refundableBefore.count === input.stripeBaseline.refundableRefundCount + 1 &&
        !input.resume) ||
      (input.resumeState.terminalExact &&
        refundableBefore.count !== input.stripeBaseline.refundableRefundCount + 1)
    ) {
      throw new Error("PERSISTED_BASELINE_MISMATCH");
    }
    const effectPresentBeforeReplay =
      refundableBefore.count === input.stripeBaseline.refundableRefundCount + 1;
    let persistedRefund = null;
    if (effectPresentBeforeReplay) {
      persistedRefund = identifyPersistedRefund(
        refundableBefore.projection,
        input.stripeBaseline.refundableRefundSetSha256,
        input.resumeState.refundLinked ? input.resumeState.refundIdSha256 : null,
      );
      if (
        persistedRefund === null ||
        persistedRefund.payment_intent !== input.refundablePaymentIntentId
      ) {
        throw new AmbiguousProofError("RESUMED_REFUND_BINDING_INVALID");
      }
    }

    const unrelated = createHmac("sha256", input.operation)
      .update("unrelated-signing-secret")
      .digest("hex");
    const settingsEnvelope = serializeEnvelope({
      command: {},
      nonce: uuid("settings"),
      operation: "settings.get",
      userId: input.requesterUserId,
    });
    const rejected = await pilot("/api/v1/settings/get", settingsEnvelope, unrelated);
    if (rejected.status !== 401) throw new Error("UNRELATED_SIGNING_ACCEPTED");
    const settings = await pilot("/api/v1/settings/get", settingsEnvelope);
    if (
      settings.status !== 200 ||
      !validateSettingsAuthority(settings.body, input.approverUserId)
    ) {
      throw new Error("APPROVER_NOT_ELIGIBLE");
    }

    const createCommand = {
      amount_minor: input.amountMinor,
      currency: input.currency,
      justification: "ADR 0036 synthetic incident admission proof",
      reason: "requested_by_customer",
    };
    const createEnvelope = serializeEnvelope({
      command: createCommand,
      nonce: uuid("create"),
      operation: "refund_request.create",
      resourceId: input.refundablePaymentIntentId,
      userId: input.requesterUserId,
    });
    const created = await pilot("/api/v1/refund-requests/create", createEnvelope);
    if (
      created.status !== 200 ||
      typeof created.body?.request_id !== "string" ||
      created.body.status !== "pending_approval"
    ) {
      throw new Error("WORKFLOW_CREATE_FAILED");
    }
    const replayed = await pilot("/api/v1/refund-requests/create", createEnvelope);
    if (
      replayed.status !== created.status ||
      replayed.body?.request_id !== created.body.request_id
    ) {
      throw new Error("WORKFLOW_REPLAY_DIVERGED");
    }

    const approvalCommand = {
      approval_snapshot: {
        amount_minor: input.amountMinor,
        currency: input.currency,
        reason: "requested_by_customer",
        requester_user_id: input.requesterUserId,
      },
      decision: "approve",
      expected_request_version: 0,
      request_id: created.body.request_id,
    };
    const approvalEnvelope = serializeEnvelope({
      command: approvalCommand,
      nonce: uuid("approve"),
      operation: "refund_request.decide",
      resourceId: input.refundablePaymentIntentId,
      userId: input.approverUserId,
    });
    const approved = await pilot("/api/v1/refund-requests/decide", approvalEnvelope);
    if (approved.status !== 200 || approved.body?.status !== "approved")
      throw new Error("WORKFLOW_APPROVAL_FAILED");

    let terminal = false;
    const deadline = Math.min(Date.now() + 360_000, authorityStopAt);
    while (Date.now() < deadline) {
      const getEnvelope = serializeEnvelope({
        command: { request_id: created.body.request_id },
        nonce: uuid("get"),
        operation: "refund_request.get",
        resourceId: input.refundablePaymentIntentId,
        userId: input.requesterUserId,
      });
      const observed = await pilot("/api/v1/refund-requests/get", getEnvelope);
      if (observed.status !== 200 || observed.body?.id !== created.body.request_id)
        throw new Error("WORKFLOW_READ_FAILED");
      if (observed.body.status === "succeeded") {
        terminal = true;
        break;
      }
      if (observed.body.status === "failed_terminal") throw new Error("WORKFLOW_TERMINAL_FAILURE");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, remaining)));
    }
    if (!terminal) emit({ ambiguous: true, sameIdempotencyKey: true }, 75);

    const refundableAfter = await refundSet(input.refundablePaymentIntentId);
    const denialFinal = await refundSet(input.denialPaymentIntentId);
    const newlyObserved = effectPresentBeforeReplay
      ? refundableAfter.projection.filter((item) => item.id === persistedRefund.id)
      : refundableAfter.projection.filter(
          (item) => !refundableBefore.projection.some((before) => before.id === item.id),
        );
    if (
      refundableAfter.count !== input.stripeBaseline.refundableRefundCount + 1 ||
      newlyObserved.length !== 1 ||
      newlyObserved[0].amount !== 1 ||
      newlyObserved[0].currency !== "eur" ||
      newlyObserved[0].payment_intent !== input.refundablePaymentIntentId ||
      newlyObserved[0].status !== "succeeded" ||
      denialFinal.count !== input.stripeBaseline.denialRefundCount ||
      denialFinal.digest !== input.stripeBaseline.denialRefundSetSha256
    ) {
      throw new Error("REFUND_DELTA_INVALID");
    }

    emit({
      ambiguousResumeSameKey: input.resume,
      appSigningAccepted: true,
      complete: true,
      denialRefundSetUnchanged: true,
      deterministicIdempotency: true,
      guardReleased: true,
      readChargeSucceeded: true,
      readPaymentIntentSucceeded: true,
      readRefundCreateDenied: true,
      refundCount: 1,
      refundIdSha256: createHash("sha256").update(newlyObserved[0].id).digest("hex"),
      requesterApproverDistinct: true,
      terminalReconciled: true,
      unrelatedSigningRejected: true,
      workflowCount: 1,
    });
  } catch (error) {
    if (error instanceof AmbiguousProofError) {
      emit({ ambiguous: true, sameIdempotencyKey: true }, 75);
    }
    emit({ complete: false, sameIdempotencyKey: true }, 20);
  }
}

if (!unitTestMode) await main();
