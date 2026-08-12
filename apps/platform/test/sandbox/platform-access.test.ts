import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Stripe from "stripe";
import { describe, expect, it } from "vitest";

/**
 * ADR 0020 section 2b: settle whether `stripe_api_access_type: platform` works.
 *
 * The manifest declares `platform`, but the runtime abandoned it after real
 * `account_invalid` responses (ADR 0012) and now uses restricted keys minted by
 * hand in the two accounts the publisher controls. That is `restricted_api_key`
 * reimplemented manually, and it cannot survive real customers: no merchant can
 * be asked to mint a key and hand it over. Until this question is answered,
 * ADR 0020 forbids building a registry, an OAuth flow or a per-account webhook
 * destination.
 *
 * The hypothesis is that the historical failure used a **restricted** key of one
 * account together with a `Stripe-Account` header naming a different account,
 * which an `rk_` cannot do. This probe therefore refuses an `rk_` outright:
 * accepting one would reproduce the original mistake and prove nothing.
 *
 * Scope, stated plainly because the distinction matters. This settles
 * **authentication** only: whether the publisher's platform secret key can act
 * on an installed third-party account across the four declared permissions. It
 * emits `PASS_PLATFORM_ACCESS_AUTHENTICATION`, deliberately not the
 * `PASS_PLATFORM_ACCESS` that ADR 0020 section 2b defines, because that gate
 * also requires the refund to travel the normal distinct-requester/approver
 * workflow. That remains open after this probe and must not be claimed from it.
 */

const API_VERSION = "2026-06-24.dahlia" as const;
const CONSENT = "I_ACKNOWLEDGE_SYNTHETIC_TEST_ONLY";
const PLATFORM_KEY_PATTERN = /^sk_test_[A-Za-z0-9_]+$/u;
const RESTRICTED_KEY_PATTERN = /^rk_/u;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/u;
const PAYMENT_INTENT_ID_PATTERN = /^pi_[A-Za-z0-9]+$/u;
const PROBE_REFUND_AMOUNT_MINOR = 1;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EVIDENCE_DIRECTORY = path.join(REPOSITORY_ROOT, "sandbox-evidence.local");

interface ProbeEnvironment {
  readonly platformKey: string;
  readonly installedAccountId: string;
  readonly paymentIntentId: string;
}

interface StepOutcome {
  readonly step: string;
  readonly ok: boolean;
  readonly stripeErrorCode: string | null;
  readonly stripeErrorType: string | null;
  readonly httpStatus: number | null;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`PLATFORM_ACCESS_MISSING_${name}`);
  }
  return value;
}

/**
 * Every refusal below happens before a single network call, so a misconfigured
 * run costs nothing and cannot produce a misleading artifact.
 */
export function readProbeEnvironment(): ProbeEnvironment {
  if (requiredEnvironment("REFUNDDESK_RUN_PLATFORM_ACCESS_PROBE") !== CONSENT) {
    throw new Error("PLATFORM_ACCESS_CONSENT_REQUIRED");
  }
  const platformKey = requiredEnvironment("STRIPE_PLATFORM_SECRET_KEY");
  if (RESTRICTED_KEY_PATTERN.test(platformKey)) {
    // The whole point of the probe. A restricted key cannot act for a third
    // party, so accepting one would reproduce ADR 0012's failure and teach us
    // nothing about the platform model.
    throw new Error("PLATFORM_ACCESS_RESTRICTED_KEY_REJECTED");
  }
  if (!PLATFORM_KEY_PATTERN.test(platformKey)) {
    throw new Error("PLATFORM_ACCESS_NON_TEST_PLATFORM_KEY_REJECTED");
  }
  const installedAccountId = requiredEnvironment("STRIPE_INSTALLED_ACCOUNT_ID");
  if (!ACCOUNT_ID_PATTERN.test(installedAccountId)) {
    throw new Error("PLATFORM_ACCESS_ACCOUNT_ID_INVALID");
  }
  const paymentIntentId = requiredEnvironment("STRIPE_PROBE_PAYMENT_INTENT_ID");
  if (!PAYMENT_INTENT_ID_PATTERN.test(paymentIntentId)) {
    throw new Error("PLATFORM_ACCESS_PAYMENT_INTENT_ID_INVALID");
  }
  return { platformKey, installedAccountId, paymentIntentId };
}

/** Identifiers are hashed, never emitted. Nothing here can carry a credential. */
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function describeStripeFailure(step: string, error: unknown): StepOutcome {
  if (error instanceof Stripe.errors.StripeError) {
    return {
      step,
      ok: false,
      stripeErrorCode: error.code ?? null,
      stripeErrorType: error.type ?? null,
      httpStatus: error.statusCode ?? null,
    };
  }
  return { step, ok: false, stripeErrorCode: null, stripeErrorType: null, httpStatus: null };
}

const consentGiven = process.env["REFUNDDESK_RUN_PLATFORM_ACCESS_PROBE"]?.trim() === CONSENT;

describe("ADR 0020 platform access probe", () => {
  it("refuses a restricted key before any network call", () => {
    const saved = process.env["STRIPE_PLATFORM_SECRET_KEY"];
    process.env["REFUNDDESK_RUN_PLATFORM_ACCESS_PROBE"] = CONSENT;
    process.env["STRIPE_PLATFORM_SECRET_KEY"] = "rk_test_example";
    try {
      expect(() => readProbeEnvironment()).toThrow("PLATFORM_ACCESS_RESTRICTED_KEY_REJECTED");
    } finally {
      if (saved === undefined) delete process.env["STRIPE_PLATFORM_SECRET_KEY"];
      else process.env["STRIPE_PLATFORM_SECRET_KEY"] = saved;
      if (!consentGiven) delete process.env["REFUNDDESK_RUN_PLATFORM_ACCESS_PROBE"];
    }
  });

  it("refuses a live key before any network call", () => {
    const saved = process.env["STRIPE_PLATFORM_SECRET_KEY"];
    process.env["REFUNDDESK_RUN_PLATFORM_ACCESS_PROBE"] = CONSENT;
    process.env["STRIPE_PLATFORM_SECRET_KEY"] = "sk_live_example";
    try {
      expect(() => readProbeEnvironment()).toThrow(
        "PLATFORM_ACCESS_NON_TEST_PLATFORM_KEY_REJECTED",
      );
    } finally {
      if (saved === undefined) delete process.env["STRIPE_PLATFORM_SECRET_KEY"];
      else process.env["STRIPE_PLATFORM_SECRET_KEY"] = saved;
      if (!consentGiven) delete process.env["REFUNDDESK_RUN_PLATFORM_ACCESS_PROBE"];
    }
  });

  it.runIf(consentGiven)(
    "exercises the four declared permissions on an installed account",
    async () => {
      const environment = readProbeEnvironment();
      const stripe = new Stripe(environment.platformKey, { apiVersion: API_VERSION });
      const onBehalf = { stripeAccount: environment.installedAccountId } as const;
      const steps: StepOutcome[] = [];
      let chargeId: string | null = null;
      let refundId: string | null = null;

      // 1. payment_intent_read
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          environment.paymentIntentId,
          {},
          onBehalf,
        );
        chargeId =
          typeof paymentIntent.latest_charge === "string"
            ? paymentIntent.latest_charge
            : (paymentIntent.latest_charge?.id ?? null);
        steps.push({
          step: "payment_intent_read",
          ok: true,
          stripeErrorCode: null,
          stripeErrorType: null,
          httpStatus: null,
        });
      } catch (error) {
        steps.push(describeStripeFailure("payment_intent_read", error));
      }

      // 2. charge_read
      if (chargeId !== null) {
        try {
          const charge = await stripe.charges.retrieve(chargeId, {}, onBehalf);
          expect(charge.id).toBe(chargeId);
          steps.push({
            step: "charge_read",
            ok: true,
            stripeErrorCode: null,
            stripeErrorType: null,
            httpStatus: null,
          });
        } catch (error) {
          steps.push(describeStripeFailure("charge_read", error));
        }
      } else {
        steps.push({
          step: "charge_read",
          ok: false,
          stripeErrorCode: "no_latest_charge",
          stripeErrorType: null,
          httpStatus: null,
        });
      }

      // 3. event_read
      try {
        await stripe.events.list({ limit: 1 }, onBehalf);
        steps.push({
          step: "event_read",
          ok: true,
          stripeErrorCode: null,
          stripeErrorType: null,
          httpStatus: null,
        });
      } catch (error) {
        steps.push(describeStripeFailure("event_read", error));
      }

      // 4. charge_write, bounded to a single minor unit. The idempotency key is
      // derived from the exact account and PaymentIntent, so a rerun of this
      // probe can never create a second refund.
      if (chargeId !== null) {
        try {
          const refund = await stripe.refunds.create(
            { charge: chargeId, amount: PROBE_REFUND_AMOUNT_MINOR },
            {
              ...onBehalf,
              idempotencyKey: `platform-access-probe-${digest(
                `${environment.installedAccountId}:${environment.paymentIntentId}`,
              ).slice(0, 32)}`,
            },
          );
          refundId = refund.id;
          steps.push({
            step: "charge_write",
            ok: true,
            stripeErrorCode: null,
            stripeErrorType: null,
            httpStatus: null,
          });
        } catch (error) {
          steps.push(describeStripeFailure("charge_write", error));
        }
      } else {
        steps.push({
          step: "charge_write",
          ok: false,
          stripeErrorCode: "no_latest_charge",
          stripeErrorType: null,
          httpStatus: null,
        });
      }

      const allPassed = steps.every((step) => step.ok);
      const evidence = {
        kind: "refunddesk.platform-access-probe",
        schemaVersion: 1,
        adr: "0020",
        section: "2b",
        result: allPassed ? "PASS" : "FAIL",
        code: allPassed ? "PASS_PLATFORM_ACCESS_AUTHENTICATION" : "FAIL_PLATFORM_ACCESS",
        scope:
          "authentication only; the ADR 0020 section 2b gate additionally requires the refund " +
          "to travel the normal distinct-requester/approver workflow, which this probe does not " +
          "exercise and which remains open",
        capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
        apiVersion: API_VERSION,
        mode: "test",
        installedAccountSha256: digest(environment.installedAccountId),
        paymentIntentSha256: digest(environment.paymentIntentId),
        refundCreated: refundId !== null,
        refundAmountMinor: refundId === null ? 0 : PROBE_REFUND_AMOUNT_MINOR,
        steps,
        rawSecretsEmitted: false,
        stripeObjectIdsEmitted: false,
      } as const;

      await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
      const evidencePath = path.join(
        EVIDENCE_DIRECTORY,
        `platform-access-probe-${evidence.capturedAt.replace(/[:-]/gu, "")}.local.json`,
      );
      const temporaryPath = `${evidencePath}.partial`;
      await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, evidencePath);

      // The probe reports; it does not decide. A FAIL is the documented signal
      // to adopt the `oauth` fallback, not a defect in this harness, so surface
      // the exact per-step outcome either way.
      expect(
        steps.map((step) => `${step.step}:${step.ok ? "ok" : (step.stripeErrorCode ?? "err")}`),
      ).toEqual(["payment_intent_read:ok", "charge_read:ok", "event_read:ok", "charge_write:ok"]);
    },
    180_000,
  );
});
