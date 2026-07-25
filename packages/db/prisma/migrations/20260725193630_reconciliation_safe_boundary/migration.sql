ALTER TABLE "refund_requests"
ADD COLUMN "reconciliation_safe_after_at" TIMESTAMPTZ(6);

-- Existing guarded ambiguities predate the explicit boundary. Migration is an
-- operational stop-the-world action, so its statement clock is a conservative
-- point after every pre-existing attempt that can safely be covered by a later
-- Stripe scan.
UPDATE "refund_requests"
SET "reconciliation_safe_after_at" = GREATEST(
  clock_timestamp(),
  "execution_started_at"
)
WHERE "workflow_status" = 'reconciliation_required';

CREATE FUNCTION "refunddesk_stamp_reconciliation_safe_boundary"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."workflow_status" = 'reconciliation_required'
     AND (
       TG_OP = 'INSERT'
       OR OLD."workflow_status" IS DISTINCT FROM 'reconciliation_required'
     ) THEN
    NEW."reconciliation_safe_after_at" := GREATEST(
      clock_timestamp(),
      NEW."execution_started_at"
    );
  ELSIF TG_OP = 'UPDATE'
     AND NEW."reconciliation_safe_after_at"
       IS DISTINCT FROM OLD."reconciliation_safe_after_at" THEN
    RAISE EXCEPTION 'reconciliation safe boundary is database-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_requests_stamp_reconciliation_safe_boundary"
BEFORE INSERT OR UPDATE OF "workflow_status", "reconciliation_safe_after_at"
ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_stamp_reconciliation_safe_boundary"();

ALTER TABLE "refund_requests"
ADD CONSTRAINT "refund_requests_reconciliation_safe_boundary_check"
CHECK (
  "workflow_status" <> 'reconciliation_required'
  OR (
    "reconciliation_safe_after_at" IS NOT NULL
    AND "execution_started_at" IS NOT NULL
    AND "reconciliation_safe_after_at" >= "execution_started_at"
  )
);
