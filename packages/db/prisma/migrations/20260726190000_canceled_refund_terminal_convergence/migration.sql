CREATE OR REPLACE FUNCTION "refunddesk_validate_workflow_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed BOOLEAN := false;
  current_refund_status "stripe_refund_status";
BEGIN
  IF NEW."workflow_status" = OLD."workflow_status" THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD."workflow_status"
    WHEN 'pending_approval' THEN NEW."workflow_status" IN ('approved', 'rejected', 'canceled', 'expired', 'stale')
    WHEN 'approved' THEN NEW."workflow_status" IN ('executing', 'stale')
    WHEN 'executing' THEN NEW."workflow_status" IN ('succeeded', 'reconciliation_required', 'failed_terminal')
    WHEN 'reconciliation_required' THEN NEW."workflow_status" IN ('succeeded', 'failed_terminal', 'executing')
    WHEN 'succeeded' THEN NEW."workflow_status" = 'failed_terminal'
    ELSE false
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid workflow transition from % to %',
      OLD."workflow_status", NEW."workflow_status"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."workflow_status" = 'reconciliation_required'
     AND NEW."workflow_status" = 'executing'
     AND NEW."effect_state" <> 'absence_proven' THEN
    RAISE EXCEPTION 'reconciliation can resume only after absence is proven'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."workflow_status" = 'succeeded' THEN
    SELECT "stripe_refund_status" INTO current_refund_status
    FROM "refund_executions"
    WHERE "request_id" = NEW."id" AND "tenant_id" = NEW."tenant_id";
    IF NEW."effect_state" <> 'identified' OR current_refund_status <> 'succeeded' THEN
      RAISE EXCEPTION 'workflow succeeds only after Stripe confirms refund success'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."workflow_status" = 'succeeded'
     AND NEW."workflow_status" = 'failed_terminal' THEN
    SELECT "stripe_refund_status" INTO current_refund_status
    FROM "refund_executions"
    WHERE "request_id" = NEW."id" AND "tenant_id" = NEW."tenant_id";
    IF OLD."effect_state" <> 'identified'
       OR NEW."effect_state" <> 'absence_proven'
       OR current_refund_status IS NULL
       OR current_refund_status NOT IN ('failed', 'canceled') THEN
      RAISE EXCEPTION 'succeeded workflow can fail only after the same Refund fails or is canceled'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."workflow_status" IN ('stale', 'failed_terminal')
     AND NEW."effect_state" <> 'absence_proven' THEN
    RAISE EXCEPTION 'terminal state requires certain absence of effect'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "refunddesk_preserve_first_refund_link"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."tenant_id",
    NEW."request_id",
    NEW."idempotency_key",
    NEW."canonical_parameters_hash",
    NEW."amount_minor",
    NEW."currency",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."tenant_id",
    OLD."request_id",
    OLD."idempotency_key",
    OLD."canonical_parameters_hash",
    OLD."amount_minor",
    OLD."currency",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'refund execution identity and parameters are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."stripe_refund_id" IS NOT NULL
     AND NEW."stripe_refund_id" IS DISTINCT FROM OLD."stripe_refund_id" THEN
    RAISE EXCEPTION 'the first linked Stripe Refund ID is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."stripe_refund_status" IN ('succeeded', 'failed', 'canceled')
     AND NEW."stripe_refund_status" IS DISTINCT FROM OLD."stripe_refund_status"
     AND NOT (
       (
         OLD."stripe_refund_status" = 'succeeded'
         AND NEW."stripe_refund_status" IN ('failed', 'canceled')
       )
       OR (
         OLD."stripe_refund_status" = 'canceled'
         AND NEW."stripe_refund_status" = 'failed'
       )
     ) THEN
    RAISE EXCEPTION 'terminal Stripe refund status is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."last_stripe_event_created_at" IS NOT NULL
     AND NEW."last_stripe_event_created_at" IS NOT NULL
     AND NEW."last_stripe_event_created_at" < OLD."last_stripe_event_created_at" THEN
    RAISE EXCEPTION 'out-of-order Stripe event cannot replace newer state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
