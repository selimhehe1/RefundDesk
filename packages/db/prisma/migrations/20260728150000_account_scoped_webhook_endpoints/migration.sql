BEGIN;

ALTER TABLE "webhook_receipts"
  DROP CONSTRAINT "webhook_receipts_pilot_endpoint_check",
  ADD CONSTRAINT "webhook_receipts_pilot_endpoint_check" CHECK (
    "endpoint" IN (
      'connected_test',
      'connected_sandbox',
      'account_test',
      'account_sandbox'
    )
  );

ALTER TABLE "webhook_receipts"
  DROP CONSTRAINT "webhook_receipts_payload_shape_check",
  ADD CONSTRAINT "webhook_receipts_payload_shape_check" CHECK (
    jsonb_typeof("normalized_payload") = 'object'
    AND "normalized_payload" ->> 'schema_version' = '1'
    AND "normalized_payload" ->> 'event_type' = "event_type"
    AND "normalized_payload" ->> 'environment' = CASE
      WHEN "endpoint" IN ('connected_test', 'account_test') THEN 'test'
      WHEN "endpoint" IN ('connected_sandbox', 'account_sandbox') THEN 'sandbox'
      ELSE NULL
    END
    AND jsonb_typeof("normalized_payload" -> 'event_created') = 'number'
    AND (
      (
        "event_type" LIKE 'refund.%'
        AND jsonb_typeof("normalized_payload" -> 'refund') = 'object'
        AND "normalized_payload" #>> '{refund,refund_id}' = "object_id"
      )
      OR (
        "event_type" LIKE 'account.application.%'
        AND "normalized_payload" ->> 'application_id' = "object_id"
      )
    )
  );

-- Build the account-global uniqueness boundary before removing the historical
-- endpoint-scoped index. If historical rows conflict, the migration fails
-- closed without discarding either financial receipt.
CREATE UNIQUE INDEX "webhook_receipts_account_event_key"
  ON "webhook_receipts"("stripe_account_id", "stripe_event_id");

DROP INDEX "webhook_receipts_endpoint_event_key";

CREATE FUNCTION "refunddesk_find_webhook_receipt_v2"(
  requested_endpoint "webhook_endpoint",
  requested_event_id VARCHAR,
  requested_account_id VARCHAR
)
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "receipt_id" UUID,
  "receipt_status" "receipt_status"
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    receipt."tenant_id",
    receipt."installation_id",
    receipt."id",
    receipt."status"
  FROM public."webhook_receipts" AS receipt
  WHERE receipt."stripe_event_id" = requested_event_id
    AND receipt."stripe_account_id" = requested_account_id
    AND CASE
      WHEN requested_endpoint IN ('connected_test', 'account_test') THEN 'test'
      WHEN requested_endpoint IN ('connected_sandbox', 'account_sandbox') THEN 'sandbox'
      ELSE NULL
    END = CASE
      WHEN receipt."endpoint" IN ('connected_test', 'account_test') THEN 'test'
      WHEN receipt."endpoint" IN ('connected_sandbox', 'account_sandbox') THEN 'sandbox'
      ELSE NULL
    END
$$;

REVOKE ALL ON FUNCTION "refunddesk_find_webhook_receipt_v2"(
  "webhook_endpoint",
  VARCHAR,
  VARCHAR
) FROM PUBLIC;

CREATE FUNCTION "refunddesk_list_recoverable_webhook_receipts_v2"(
  requested_limit INTEGER
)
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "receipt_id" UUID,
  "endpoint" "webhook_endpoint",
  "stripe_event_id" VARCHAR,
  "stripe_account_id" VARCHAR,
  "event_type" VARCHAR,
  "object_id" VARCHAR,
  "stripe_created_at" TIMESTAMPTZ,
  "normalized_payload" JSONB,
  "receipt_status" "receipt_status",
  "processing_attempts" INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    receipt."tenant_id",
    receipt."installation_id",
    receipt."id",
    receipt."endpoint",
    receipt."stripe_event_id",
    receipt."stripe_account_id",
    receipt."event_type",
    receipt."object_id",
    receipt."stripe_created_at",
    receipt."normalized_payload",
    receipt."status",
    receipt."processing_attempts"
  FROM public."webhook_receipts" AS receipt
  INNER JOIN public."stripe_installations" AS installation
    ON installation."id" = receipt."installation_id"
   AND installation."tenant_id" = receipt."tenant_id"
   AND installation."stripe_account_id" = receipt."stripe_account_id"
   AND (
     (
       receipt."endpoint" IN ('connected_test', 'account_test')
       AND installation."environment" = 'test'
     )
     OR (
       receipt."endpoint" IN ('connected_sandbox', 'account_sandbox')
       AND installation."environment" = 'sandbox'
     )
   )
  INNER JOIN public."tenants" AS tenant
    ON tenant."id" = receipt."tenant_id"
  WHERE receipt."endpoint" IN (
      'connected_test',
      'connected_sandbox',
      'account_test',
      'account_sandbox'
    )
    AND receipt."status" IN ('received', 'failed')
    AND (
      receipt."event_type" LIKE 'account.application.%'
      OR (
        tenant."status" = 'active'
        AND NOT tenant."live_enabled"
        AND installation."status" = 'active'
      )
    )
  ORDER BY receipt."received_at", receipt."id"
  LIMIT LEAST(GREATEST(COALESCE(requested_limit, 1), 1), 1000)
$$;

REVOKE ALL ON FUNCTION "refunddesk_list_recoverable_webhook_receipts_v2"(INTEGER)
  FROM PUBLIC;

COMMIT;
