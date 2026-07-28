-- Approval verification remains outside the web runtime; this migration makes
-- its independently persisted evidence mandatory at the database boundary.
CREATE UNIQUE INDEX "stripe_installations_attestation_identity_key"
  ON "stripe_installations"(
    "id",
    "tenant_id",
    "stripe_account_id",
    "environment"
  );

CREATE UNIQUE INDEX "refund_requests_attestation_identity_key"
  ON "refund_requests"(
    "id",
    "tenant_id",
    "installation_id",
    "environment"
  );

CREATE TABLE "approval_attestations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "installation_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "approver_user_id" UUID NOT NULL,
  "request_nonce" UUID NOT NULL,
  "stripe_account_id" VARCHAR(255) NOT NULL,
  "environment" "stripe_environment" NOT NULL,
  "resource_type" VARCHAR(64) NOT NULL,
  "resource_id" VARCHAR(255) NOT NULL,
  "request_version" INTEGER NOT NULL,
  "signed_envelope_hash" BYTEA NOT NULL,
  "authorization_snapshot_hash" BYTEA NOT NULL,
  "verified_at" TIMESTAMPTZ(6) NOT NULL,
  "consume_before" TIMESTAMPTZ(6) NOT NULL,
  "hmac_key_version" VARCHAR(16) NOT NULL,
  "hmac" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_attestations_environment_check"
    CHECK ("environment" IN ('test', 'sandbox')),
  CONSTRAINT "approval_attestations_account_check"
    CHECK ("stripe_account_id" ~ '^acct_[A-Za-z0-9]+$'),
  CONSTRAINT "approval_attestations_resource_check"
    CHECK (
      (
        "resource_type" = 'payment_intent'
        AND "resource_id" ~ '^pi_[A-Za-z0-9]+$'
      )
      OR (
        "resource_type" = 'charge'
        AND "resource_id" ~ '^ch_[A-Za-z0-9]+$'
      )
    ),
  CONSTRAINT "approval_attestations_request_version_check"
    CHECK ("request_version" >= 0),
  CONSTRAINT "approval_attestations_hashes_check"
    CHECK (
      octet_length("signed_envelope_hash") = 32
      AND octet_length("authorization_snapshot_hash") = 32
      AND octet_length("hmac") = 32
    ),
  CONSTRAINT "approval_attestations_hmac_key_version_check"
    CHECK ("hmac_key_version" ~ '^v[1-9][0-9]{0,8}$'),
  CONSTRAINT "approval_attestations_time_window_check"
    CHECK (
      "verified_at" <= "created_at"
      AND "created_at" < "consume_before"
    ),
  CONSTRAINT "approval_attestations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "approval_attestations_installation_binding_fkey"
    FOREIGN KEY (
      "installation_id",
      "tenant_id",
      "stripe_account_id",
      "environment"
    )
    REFERENCES "stripe_installations"(
      "id",
      "tenant_id",
      "stripe_account_id",
      "environment"
    )
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "approval_attestations_request_binding_fkey"
    FOREIGN KEY (
      "request_id",
      "tenant_id",
      "installation_id",
      "environment"
    )
    REFERENCES "refund_requests"(
      "id",
      "tenant_id",
      "installation_id",
      "environment"
    )
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "approval_attestations_approver_binding_fkey"
    FOREIGN KEY ("approver_user_id", "tenant_id")
    REFERENCES "tenant_users"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "approval_attestations_tenant_nonce_key"
  ON "approval_attestations"("tenant_id", "request_nonce");
CREATE UNIQUE INDEX "approval_attestations_decision_binding_key"
  ON "approval_attestations"(
    "id",
    "tenant_id",
    "request_id",
    "approver_user_id"
  );
CREATE INDEX "approval_attestations_request_consume_idx"
  ON "approval_attestations"(
    "tenant_id",
    "request_id",
    "consume_before"
  );

ALTER TABLE "approval_decisions"
  ADD COLUMN "approval_attestation_id" UUID;

CREATE UNIQUE INDEX "approval_decisions_attestation_id_key"
  ON "approval_decisions"("approval_attestation_id");
CREATE UNIQUE INDEX "approval_decisions_attestation_binding_key"
  ON "approval_decisions"(
    "approval_attestation_id",
    "tenant_id",
    "request_id",
    "approver_user_id"
  );

ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "approval_decisions_attestation_binding_fkey"
  FOREIGN KEY (
    "approval_attestation_id",
    "tenant_id",
    "request_id",
    "approver_user_id"
  )
  REFERENCES "approval_attestations"(
    "id",
    "tenant_id",
    "request_id",
    "approver_user_id"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "approval_attestations_append_only"
BEFORE UPDATE OR DELETE ON "approval_attestations"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_prevent_append_only_mutation"();

ALTER TABLE "approval_attestations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_attestations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approval_attestations_isolate" ON "approval_attestations"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

CREATE FUNCTION "refunddesk_enforce_tenant_user_identity_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."stripe_user_id" IS DISTINCT FROM OLD."stripe_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'tenant user identity is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tenant_users_enforce_identity_immutable"
BEFORE UPDATE ON "tenant_users"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_enforce_tenant_user_identity_immutable"();

CREATE OR REPLACE FUNCTION "refunddesk_validate_decision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requester UUID;
  approver_is_active BOOLEAN := false;
  request_status public."workflow_status";
  request_created_at TIMESTAMPTZ;
  request_expiry TIMESTAMPTZ;
  request_installation_id UUID;
  request_environment public."stripe_environment";
  request_payment_intent_id VARCHAR(255);
  request_charge_id VARCHAR(255);
  current_request_version INTEGER;
  installation_account_id VARCHAR(255);
  attestation public."approval_attestations"%ROWTYPE;
BEGIN
  SELECT
    request."requester_user_id",
    request."workflow_status",
    request."created_at",
    request."expires_at",
    request."installation_id",
    request."environment",
    request."payment_intent_id",
    request."charge_id",
    request."version"
  INTO
    requester,
    request_status,
    request_created_at,
    request_expiry,
    request_installation_id,
    request_environment,
    request_payment_intent_id,
    request_charge_id,
    current_request_version
  FROM public."refund_requests" AS request
  WHERE request."id" = NEW."request_id"
    AND request."tenant_id" = NEW."tenant_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund request not found in tenant'
      USING ERRCODE = '23503';
  END IF;
  IF requester = NEW."approver_user_id" THEN
    RAISE EXCEPTION 'requester cannot decide their own request'
      USING ERRCODE = '23514';
  END IF;
  SELECT true
  INTO approver_is_active
  FROM public."tenant_users" AS approver
  WHERE approver."tenant_id" = NEW."tenant_id"
    AND approver."id" = NEW."approver_user_id"
    AND approver."approver_enabled"
  FOR SHARE;
  IF NOT COALESCE(approver_is_active, false) THEN
    RAISE EXCEPTION 'approver is not explicitly enabled in the request tenant'
      USING ERRCODE = '42501';
  END IF;
  IF request_status <> 'pending_approval'
     OR statement_timestamp() >= request_expiry
     OR NEW."decided_at" < request_created_at
     OR NEW."decided_at" >= request_expiry
     OR NEW."decided_at" > clock_timestamp() THEN
    RAISE EXCEPTION 'request is no longer open for decisions'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."decision" = 'reject' THEN
    IF NEW."approval_attestation_id" IS NOT NULL THEN
      RAISE EXCEPTION 'rejection decisions cannot consume an approval attestation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."approval_attestation_id" IS NULL THEN
    RAISE EXCEPTION 'approval decisions require an independent attestation'
      USING ERRCODE = '23514';
  END IF;

  SELECT candidate.*
  INTO attestation
  FROM public."approval_attestations" AS candidate
  WHERE candidate."id" = NEW."approval_attestation_id"
    AND candidate."tenant_id" = NEW."tenant_id"
    AND candidate."request_id" = NEW."request_id"
    AND candidate."approver_user_id" = NEW."approver_user_id"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval attestation does not match the decision identity'
      USING ERRCODE = '23514';
  END IF;

  SELECT installation."stripe_account_id"
  INTO installation_account_id
  FROM public."stripe_installations" AS installation
  WHERE installation."id" = request_installation_id
    AND installation."tenant_id" = NEW."tenant_id"
    AND installation."environment" = request_environment;

  IF NOT FOUND
     OR attestation."installation_id" <> request_installation_id
     OR attestation."stripe_account_id" <> installation_account_id
     OR attestation."environment" <> request_environment
     OR attestation."request_version" <> current_request_version
     OR attestation."verified_at" < request_created_at
     OR attestation."verified_at" > NEW."decided_at"
     OR NEW."decided_at" >= attestation."consume_before"
     OR attestation."consume_before" > request_expiry
     OR NOT (
       (
         attestation."resource_type" = 'payment_intent'
         AND request_payment_intent_id IS NOT NULL
         AND attestation."resource_id" = request_payment_intent_id
       )
       OR (
         attestation."resource_type" = 'charge'
         AND request_charge_id IS NOT NULL
         AND attestation."resource_id" = request_charge_id
       )
     ) THEN
    RAISE EXCEPTION 'approval attestation does not match the current request snapshot'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "refunddesk_validate_durable_decision_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total_decisions BIGINT := 0;
  valid_approvals BIGINT := 0;
  valid_rejections BIGINT := 0;
BEGIN
  IF OLD."workflow_status" <> 'pending_approval'
     OR NEW."workflow_status" NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE decision."decision" = 'approve'
        AND decision."approval_attestation_id" IS NOT NULL
        AND approver."approver_enabled"
        AND approver."id" <> NEW."requester_user_id"
    ),
    count(*) FILTER (
      WHERE decision."decision" = 'reject'
        AND decision."approval_attestation_id" IS NULL
        AND approver."approver_enabled"
        AND approver."id" <> NEW."requester_user_id"
    )
  INTO total_decisions, valid_approvals, valid_rejections
  FROM "approval_decisions" AS decision
  LEFT JOIN "tenant_users" AS approver
    ON approver."id" = decision."approver_user_id"
   AND approver."tenant_id" = decision."tenant_id"
  WHERE decision."tenant_id" = NEW."tenant_id"
    AND decision."request_id" = NEW."id";

  IF total_decisions <> valid_approvals + valid_rejections THEN
    RAISE EXCEPTION 'refund decision references invalid approval evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."workflow_status" = 'approved'
     AND (
       valid_approvals < NEW."required_approvals"
       OR valid_rejections <> 0
     ) THEN
    RAISE EXCEPTION 'approval transition requires a durable coherent quorum'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."workflow_status" = 'rejected'
     AND valid_rejections < 1 THEN
    RAISE EXCEPTION 'rejection transition requires a durable rejection decision'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- The existing purge routine deletes requests explicitly. The composite
-- request foreign key cascades both consumed and unused attestations, while
-- these triggers make that cascade visible in the durable purge certificate.
CREATE FUNCTION "refunddesk_reset_purge_attestation_count"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NULLIF(
    current_setting('refunddesk.purge_tenant_id', true),
    ''
  ) IS NOT NULL THEN
    PERFORM set_config(
      'refunddesk.purged_approval_attestation_count',
      '0',
      true
    );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "refund_requests_reset_purge_attestation_count"
BEFORE DELETE ON "refund_requests"
FOR EACH STATEMENT EXECUTE FUNCTION "refunddesk_reset_purge_attestation_count"();

CREATE FUNCTION "refunddesk_count_purged_approval_attestation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count BIGINT := COALESCE(
    NULLIF(
      current_setting(
        'refunddesk.purged_approval_attestation_count',
        true
      ),
      ''
    )::BIGINT,
    0
  );
BEGIN
  IF current_setting('refunddesk.purge_tenant_id', true)
     = OLD."tenant_id"::TEXT THEN
    PERFORM set_config(
      'refunddesk.purged_approval_attestation_count',
      (purged_count + 1)::TEXT,
      true
    );
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "approval_attestations_count_purge"
AFTER DELETE ON "approval_attestations"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_count_purged_approval_attestation"();

CREATE FUNCTION "refunddesk_include_attestation_purge_count"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count TEXT := NULLIF(
    current_setting(
      'refunddesk.purged_approval_attestation_count',
      true
    ),
    ''
  );
BEGIN
  IF NEW."process_version" = 'db-purge-v1'
     AND purged_count IS NOT NULL THEN
    NEW."deleted_counts" := NEW."deleted_counts" || jsonb_build_object(
      'approval_attestations',
      purged_count::BIGINT
    );
    NEW."process_version" := 'db-purge-v2';
    PERFORM set_config(
      'refunddesk.purged_approval_attestation_count',
      '',
      true
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "purge_certificates_include_attestation_count"
BEFORE INSERT ON "purge_certificates"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_include_attestation_purge_count"();

REVOKE ALL ON TABLE "approval_attestations" FROM PUBLIC;
