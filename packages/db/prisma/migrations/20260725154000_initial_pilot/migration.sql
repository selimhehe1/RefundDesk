CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "stripe_environment" AS ENUM ('live', 'test', 'sandbox');
CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended', 'deauthorized', 'pending_deletion');
CREATE TYPE "installation_status" AS ENUM ('active', 'suspended', 'deauthorized');
CREATE TYPE "workflow_status" AS ENUM (
  'pending_approval',
  'approved',
  'executing',
  'reconciliation_required',
  'succeeded',
  'failed_terminal',
  'rejected',
  'canceled',
  'expired',
  'stale'
);
CREATE TYPE "effect_state" AS ENUM ('not_started', 'possible', 'identified', 'absence_proven');
CREATE TYPE "stripe_refund_status" AS ENUM ('pending', 'requires_action', 'succeeded', 'failed', 'canceled');
CREATE TYPE "refund_reason" AS ENUM ('duplicate', 'fraudulent', 'requested_by_customer');
CREATE TYPE "decision_kind" AS ENUM ('approve', 'reject');
CREATE TYPE "execution_attempt_state" AS ENUM (
  'started',
  'retryable_failure',
  'ambiguous_failure',
  'terminal_failure',
  'completed'
);
CREATE TYPE "webhook_endpoint" AS ENUM ('connected_live', 'connected_test', 'connected_sandbox');
CREATE TYPE "receipt_status" AS ENUM ('received', 'processing', 'processed', 'failed');
CREATE TYPE "alert_status" AS ENUM ('open', 'acknowledged');
CREATE TYPE "correlation_candidate_state" AS ENUM (
  'pending',
  'exact_linked',
  'unique_linked',
  'conflict'
);
CREATE TYPE "event_idempotency_correlation" AS ENUM ('absent', 'exact', 'mismatch');

CREATE TABLE "tenants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "status" "tenant_status" NOT NULL DEFAULT 'active',
  "live_enabled" BOOLEAN NOT NULL DEFAULT false,
  "retention_days" INTEGER NOT NULL DEFAULT 365,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pending_delete_at" TIMESTAMPTZ(6),
  "legal_hold_at" TIMESTAMPTZ(6),
  CONSTRAINT "tenants_pilot_live_disabled_check" CHECK ("live_enabled" = false),
  CONSTRAINT "tenants_retention_days_check" CHECK ("retention_days" BETWEEN 1 AND 3650),
  CONSTRAINT "tenants_pending_delete_check" CHECK (
    ("status" = 'pending_deletion' AND "pending_delete_at" IS NOT NULL)
    OR ("status" <> 'pending_deletion')
  )
);

CREATE TABLE "purge_certificates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_pseudonym" VARCHAR(64) NOT NULL,
  "uninstalled_at" TIMESTAMPTZ(6) NOT NULL,
  "purge_completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "policy_version" VARCHAR(32) NOT NULL,
  "process_version" VARCHAR(64) NOT NULL,
  "deleted_counts" JSONB NOT NULL,
  "result" VARCHAR(16) NOT NULL,
  CONSTRAINT "purge_certificates_tenant_pseudonym_check"
    CHECK ("tenant_pseudonym" ~ '^v1\.[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "purge_certificates_uninstall_check"
    CHECK ("uninstalled_at" <= "purge_completed_at"),
  CONSTRAINT "purge_certificates_expiry_check"
    CHECK ("expires_at" > "purge_completed_at"),
  CONSTRAINT "purge_certificates_policy_version_check"
    CHECK ("policy_version" ~ '^[A-Za-z0-9._-]{1,32}$'),
  CONSTRAINT "purge_certificates_process_version_check"
    CHECK ("process_version" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "purge_certificates_counts_object_check"
    CHECK (jsonb_typeof("deleted_counts") = 'object'),
  CONSTRAINT "purge_certificates_result_check"
    CHECK ("result" = 'completed')
);

CREATE TABLE "stripe_installations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "stripe_account_id" VARCHAR(255) NOT NULL,
  "environment" "stripe_environment" NOT NULL,
  "status" "installation_status" NOT NULL DEFAULT 'active',
  "onboarding_completed_at" TIMESTAMPTZ(6),
  "installed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deauthorized_at" TIMESTAMPTZ(6),
  "last_lifecycle_event_id" VARCHAR(255),
  "last_lifecycle_event_type" VARCHAR(64),
  "last_lifecycle_event_created_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_installations_account_id_check" CHECK ("stripe_account_id" ~ '^acct_[A-Za-z0-9]+$'),
  CONSTRAINT "stripe_installations_deauthorization_check" CHECK (
    ("status" = 'deauthorized' AND "deauthorized_at" IS NOT NULL)
    OR ("status" <> 'deauthorized')
  ),
  CONSTRAINT "stripe_installations_lifecycle_watermark_check" CHECK (
    (
      "last_lifecycle_event_id" IS NULL
      AND "last_lifecycle_event_type" IS NULL
      AND "last_lifecycle_event_created_at" IS NULL
    )
    OR (
      "last_lifecycle_event_id" ~ '^evt_[A-Za-z0-9]+$'
      AND "last_lifecycle_event_type" IN (
        'account.application.authorized',
        'account.application.deauthorized'
      )
      AND "last_lifecycle_event_created_at" IS NOT NULL
    )
  ),
  CONSTRAINT "stripe_installations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "tenant_users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "stripe_user_id" VARCHAR(255) NOT NULL,
  "display_name" VARCHAR(255),
  "stripe_roles" JSONB NOT NULL DEFAULT '[]',
  "approver_enabled" BOOLEAN NOT NULL DEFAULT false,
  "last_verified_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_users_stripe_user_id_check" CHECK ("stripe_user_id" ~ '^usr_[A-Za-z0-9]+$'),
  CONSTRAINT "tenant_users_roles_array_check" CHECK (jsonb_typeof("stripe_roles") = 'array'),
  CONSTRAINT "tenant_users_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "approval_policies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "required_approvals" INTEGER NOT NULL DEFAULT 1,
  "expires_after_seconds" INTEGER NOT NULL DEFAULT 604800,
  "created_by_stripe_user_id" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_policies_version_check" CHECK ("version" > 0),
  CONSTRAINT "approval_policies_pilot_quorum_check" CHECK ("required_approvals" = 1),
  CONSTRAINT "approval_policies_expiry_check" CHECK ("expires_after_seconds" = 604800),
  CONSTRAINT "approval_policies_creator_check" CHECK ("created_by_stripe_user_id" ~ '^usr_[A-Za-z0-9]+$'),
  CONSTRAINT "approval_policies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "refund_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "installation_id" UUID NOT NULL,
  "environment" "stripe_environment" NOT NULL,
  "payment_key" VARCHAR(255) NOT NULL,
  "payment_intent_id" VARCHAR(255),
  "charge_id" VARCHAR(255),
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "reason" "refund_reason" NOT NULL,
  "justification_ciphertext" BYTEA NOT NULL,
  "justification_nonce" BYTEA NOT NULL,
  "justification_auth_tag" BYTEA NOT NULL,
  "justification_key_version" VARCHAR(16) NOT NULL,
  "requester_user_id" UUID NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "required_approvals" INTEGER NOT NULL DEFAULT 1,
  "workflow_status" "workflow_status" NOT NULL DEFAULT 'pending_approval',
  "effect_state" "effect_state" NOT NULL DEFAULT 'not_started',
  "version" INTEGER NOT NULL DEFAULT 0,
  "payment_guard_released_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "approved_at" TIMESTAMPTZ(6),
  "execution_started_at" TIMESTAMPTZ(6),
  "terminal_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_requests_identity_tenant_key" UNIQUE ("id", "tenant_id"),
  CONSTRAINT "refund_requests_non_live_check" CHECK ("environment" IN ('test', 'sandbox')),
  CONSTRAINT "refund_requests_payment_key_check" CHECK ("payment_key" ~ '^(pi|ch)_[A-Za-z0-9]+$'),
  CONSTRAINT "refund_requests_payment_reference_check" CHECK (
    "payment_intent_id" IS NOT NULL OR "charge_id" IS NOT NULL
  ),
  CONSTRAINT "refund_requests_payment_intent_check" CHECK (
    "payment_intent_id" IS NULL OR "payment_intent_id" ~ '^pi_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "refund_requests_charge_check" CHECK (
    "charge_id" IS NULL OR "charge_id" ~ '^ch_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "refund_requests_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "refund_requests_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "refund_requests_ciphertext_check" CHECK (
    octet_length("justification_ciphertext") > 0
    AND octet_length("justification_nonce") = 12
    AND octet_length("justification_auth_tag") = 16
    AND "justification_key_version" ~ '^v[1-9][0-9]*$'
  ),
  CONSTRAINT "refund_requests_pilot_quorum_check" CHECK ("required_approvals" = 1),
  CONSTRAINT "refund_requests_policy_version_check" CHECK ("policy_version" > 0),
  CONSTRAINT "refund_requests_version_check" CHECK ("version" >= 0),
  CONSTRAINT "refund_requests_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "refund_requests_terminal_timestamp_check" CHECK (
    ("workflow_status" IN ('succeeded', 'failed_terminal', 'rejected', 'canceled', 'expired', 'stale')
      AND "terminal_at" IS NOT NULL)
    OR ("workflow_status" NOT IN ('succeeded', 'failed_terminal', 'rejected', 'canceled', 'expired', 'stale'))
  ),
  CONSTRAINT "refund_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "approval_decisions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "approver_user_id" UUID NOT NULL,
  "decision" "decision_kind" NOT NULL,
  "rejection_ciphertext" BYTEA,
  "rejection_nonce" BYTEA,
  "rejection_auth_tag" BYTEA,
  "rejection_key_version" VARCHAR(16),
  "stripe_roles_snapshot" JSONB NOT NULL,
  "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_decisions_rejection_check" CHECK (
    (
      "decision" = 'reject'
      AND "rejection_ciphertext" IS NOT NULL
      AND octet_length("rejection_ciphertext") > 0
      AND octet_length("rejection_nonce") = 12
      AND octet_length("rejection_auth_tag") = 16
      AND "rejection_key_version" ~ '^v[1-9][0-9]*$'
    )
    OR (
      "decision" = 'approve'
      AND "rejection_ciphertext" IS NULL
      AND "rejection_nonce" IS NULL
      AND "rejection_auth_tag" IS NULL
      AND "rejection_key_version" IS NULL
    )
  ),
  CONSTRAINT "approval_decisions_roles_array_check" CHECK (
    jsonb_typeof("stripe_roles_snapshot") = 'array'
  ),
  CONSTRAINT "approval_decisions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "refund_executions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(255) NOT NULL,
  "canonical_parameters_hash" BYTEA NOT NULL,
  "stripe_refund_id" VARCHAR(255),
  "stripe_refund_status" "stripe_refund_status",
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "last_stripe_event_id" VARCHAR(255),
  "last_stripe_event_created_at" TIMESTAMPTZ(6),
  "last_stripe_request_id" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconciled_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_executions_identity_tenant_key" UNIQUE ("id", "tenant_id"),
  CONSTRAINT "refund_executions_request_tenant_key" UNIQUE ("request_id", "tenant_id"),
  CONSTRAINT "refund_executions_idempotency_check" CHECK (
    "idempotency_key" ~ '^refunddesk:refund-request:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:v1$'
  ),
  CONSTRAINT "refund_executions_hash_check" CHECK (
    octet_length("canonical_parameters_hash") = 32
  ),
  CONSTRAINT "refund_executions_refund_id_check" CHECK (
    "stripe_refund_id" IS NULL OR "stripe_refund_id" ~ '^re_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "refund_executions_refund_link_check" CHECK (
    ("stripe_refund_id" IS NULL AND "stripe_refund_status" IS NULL)
    OR "stripe_refund_id" IS NOT NULL
  ),
  CONSTRAINT "refund_executions_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "refund_executions_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "refund_executions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "refund_execution_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "execution_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "state" "execution_attempt_state" NOT NULL,
  "normalized_error_code" VARCHAR(64),
  "stripe_request_id" VARCHAR(255),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "refund_execution_attempts_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "refund_execution_attempts_finished_check" CHECK (
    ("state" = 'started' AND "finished_at" IS NULL)
    OR ("state" <> 'started' AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "refund_execution_attempts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "refund_correlation_candidates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "installation_id" UUID NOT NULL,
  "stripe_refund_id" VARCHAR(255) NOT NULL,
  "payment_key" VARCHAR(255) NOT NULL,
  "payment_intent_id" VARCHAR(255),
  "charge_id" VARCHAR(255),
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "stripe_refund_status" "stripe_refund_status",
  "stripe_created_at" TIMESTAMPTZ(6) NOT NULL,
  "stripe_state_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "stripe_event_id" VARCHAR(255),
  "stripe_event_created_at" TIMESTAMPTZ(6),
  "event_idempotency_correlation" "event_idempotency_correlation" NOT NULL DEFAULT 'absent',
  "last_seen_scan_window_end" TIMESTAMPTZ(6),
  "state" "correlation_candidate_state" NOT NULL DEFAULT 'pending',
  "first_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "refund_candidates_refund_id_check" CHECK (
    "stripe_refund_id" ~ '^re_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "refund_candidates_payment_key_check" CHECK (
    "payment_key" ~ '^(pi|ch)_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "refund_candidates_payment_reference_check" CHECK (
    "payment_intent_id" IS NOT NULL OR "charge_id" IS NOT NULL
  ),
  CONSTRAINT "refund_candidates_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "refund_candidates_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "refund_candidates_event_id_check" CHECK (
    "stripe_event_id" IS NULL OR "stripe_event_id" ~ '^evt_[A-Za-z0-9]+$'
  ),
  CONSTRAINT "refund_candidates_event_pair_check" CHECK (
    ("stripe_event_id" IS NULL AND "stripe_event_created_at" IS NULL)
    OR ("stripe_event_id" IS NOT NULL AND "stripe_event_created_at" IS NOT NULL)
  ),
  CONSTRAINT "refund_candidates_event_correlation_check" CHECK (
    "event_idempotency_correlation" = 'absent' OR "stripe_event_id" IS NOT NULL
  ),
  CONSTRAINT "refund_candidates_observation_time_check" CHECK (
    "last_observed_at" >= "first_observed_at"
  ),
  CONSTRAINT "refund_candidates_resolution_check" CHECK (
    ("state" IN ('exact_linked', 'unique_linked') AND "resolved_at" IS NOT NULL)
    OR ("state" IN ('pending', 'conflict') AND "resolved_at" IS NULL)
  ),
  CONSTRAINT "refund_candidates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "webhook_receipts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "installation_id" UUID NOT NULL,
  "endpoint" "webhook_endpoint" NOT NULL,
  "stripe_event_id" VARCHAR(255) NOT NULL,
  "stripe_account_id" VARCHAR(255) NOT NULL,
  "event_type" VARCHAR(255) NOT NULL,
  "object_id" VARCHAR(255) NOT NULL,
  "normalized_payload" JSONB NOT NULL,
  "stripe_created_at" TIMESTAMPTZ(6) NOT NULL,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "receipt_status" NOT NULL DEFAULT 'received',
  "processing_attempts" INTEGER NOT NULL DEFAULT 0,
  "processed_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(64),
  CONSTRAINT "webhook_receipts_event_id_check" CHECK ("stripe_event_id" ~ '^evt_[A-Za-z0-9]+$'),
  CONSTRAINT "webhook_receipts_account_id_check" CHECK ("stripe_account_id" ~ '^acct_[A-Za-z0-9]+$'),
  CONSTRAINT "webhook_receipts_pilot_endpoint_check" CHECK (
    "endpoint" IN ('connected_test', 'connected_sandbox')
  ),
  CONSTRAINT "webhook_receipts_supported_type_check" CHECK (
    "event_type" IN (
      'refund.created',
      'refund.updated',
      'refund.failed',
      'account.application.authorized',
      'account.application.deauthorized'
    )
  ),
  CONSTRAINT "webhook_receipts_payload_shape_check" CHECK (
    jsonb_typeof("normalized_payload") = 'object'
    AND "normalized_payload" ->> 'schema_version' = '1'
    AND "normalized_payload" ->> 'event_type' = "event_type"
    AND "normalized_payload" ->> 'environment' = CASE
      WHEN "endpoint" = 'connected_test' THEN 'test'
      WHEN "endpoint" = 'connected_sandbox' THEN 'sandbox'
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
  ),
  CONSTRAINT "webhook_receipts_attempts_check" CHECK ("processing_attempts" >= 0),
  CONSTRAINT "webhook_receipts_processed_check" CHECK (
    ("status" = 'processed' AND "processed_at" IS NOT NULL)
    OR "status" <> 'processed'
  ),
  CONSTRAINT "webhook_receipts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "external_refund_alerts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "installation_id" UUID NOT NULL,
  "environment" "stripe_environment" NOT NULL,
  "stripe_refund_id" VARCHAR(255) NOT NULL,
  "stripe_refund_created_at" TIMESTAMPTZ(6) NOT NULL,
  "payment_key" VARCHAR(255) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "classification" VARCHAR(32) NOT NULL,
  "status" "alert_status" NOT NULL DEFAULT 'open',
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMPTZ(6),
  "acknowledged_by_user_id" UUID,
  "overlapped_request_id" UUID,
  "reconciled_at" TIMESTAMPTZ(6),
  CONSTRAINT "external_refund_alerts_refund_id_check" CHECK ("stripe_refund_id" ~ '^re_[A-Za-z0-9]+$'),
  CONSTRAINT "external_refund_alerts_non_live_check" CHECK ("environment" IN ('test', 'sandbox')),
  CONSTRAINT "external_refund_alerts_observation_time_check"
    CHECK ("stripe_refund_created_at" <= "detected_at"),
  CONSTRAINT "external_refund_alerts_payment_key_check" CHECK ("payment_key" ~ '^(pi|ch)_[A-Za-z0-9]+$'),
  CONSTRAINT "external_refund_alerts_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "external_refund_alerts_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "external_refund_alerts_classification_check" CHECK (
    "classification" IN ('external', 'tampered', 'proof_replay')
  ),
  CONSTRAINT "external_refund_alerts_acknowledgement_check" CHECK (
    (
      "status" = 'acknowledged'
      AND "acknowledged_at" IS NOT NULL
      AND "acknowledged_by_user_id" IS NOT NULL
    )
    OR (
      "status" = 'open'
      AND "acknowledged_at" IS NULL
      AND "acknowledged_by_user_id" IS NULL
    )
  ),
  CONSTRAINT "external_refund_alerts_pilot_reconciliation_check"
    CHECK ("reconciled_at" IS NULL),
  CONSTRAINT "external_refund_alerts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "audit_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "actor_type" VARCHAR(32) NOT NULL,
  "actor_id" VARCHAR(255),
  "actor_snapshot" JSONB NOT NULL DEFAULT '{}',
  "action" VARCHAR(96) NOT NULL,
  "entity_type" VARCHAR(64) NOT NULL,
  "entity_id" VARCHAR(255) NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "correlation_request_id" UUID NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_actor_type_check" CHECK (
    "actor_type" IN ('stripe_user', 'system', 'worker', 'webhook')
  ),
  CONSTRAINT "audit_events_actor_snapshot_check" CHECK (jsonb_typeof("actor_snapshot") = 'object'),
  CONSTRAINT "audit_events_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "audit_events_schema_version_check" CHECK ("schema_version" > 0),
  CONSTRAINT "audit_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "api_mutation_receipts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "request_nonce" UUID NOT NULL,
  "actor_id" VARCHAR(255) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "canonical_request_hash" BYTEA NOT NULL,
  "response_status" INTEGER NOT NULL,
  "response_body" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "api_mutation_receipts_hash_check" CHECK (octet_length("canonical_request_hash") = 32),
  CONSTRAINT "api_mutation_receipts_response_check" CHECK ("response_status" BETWEEN 200 AND 499),
  CONSTRAINT "api_mutation_receipts_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "api_mutation_receipts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "reconciliation_checkpoints" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "installation_id" UUID NOT NULL,
  "committed_through" TIMESTAMPTZ(6) NOT NULL,
  "scan_window_end" TIMESTAMPTZ(6),
  "starting_after" VARCHAR(255),
  "page_in_progress" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reconciliation_checkpoints_progress_check" CHECK (
    (
      "page_in_progress"
      AND "scan_window_end" IS NOT NULL
      AND "scan_window_end" > "committed_through"
    )
    OR (
      NOT "page_in_progress"
      AND "scan_window_end" IS NULL
      AND "starting_after" IS NULL
    )
  ),
  CONSTRAINT "reconciliation_checkpoints_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "purge_certificates_tenant_pseudonym_key"
  ON "purge_certificates"("tenant_pseudonym");
CREATE INDEX "purge_certificates_expires_idx"
  ON "purge_certificates"("expires_at");

CREATE UNIQUE INDEX "stripe_installations_account_environment_key"
  ON "stripe_installations"("stripe_account_id", "environment");
CREATE UNIQUE INDEX "stripe_installations_identity_tenant_key"
  ON "stripe_installations"("id", "tenant_id");
CREATE UNIQUE INDEX "stripe_installations_identity_tenant_environment_key"
  ON "stripe_installations"("id", "tenant_id", "environment");
CREATE INDEX "stripe_installations_tenant_idx" ON "stripe_installations"("tenant_id");

CREATE UNIQUE INDEX "tenant_users_tenant_stripe_user_key"
  ON "tenant_users"("tenant_id", "stripe_user_id");
CREATE UNIQUE INDEX "tenant_users_identity_tenant_key"
  ON "tenant_users"("id", "tenant_id");
CREATE INDEX "tenant_users_tenant_approver_idx"
  ON "tenant_users"("tenant_id", "approver_enabled");

CREATE UNIQUE INDEX "approval_policies_tenant_version_key"
  ON "approval_policies"("tenant_id", "version");
CREATE UNIQUE INDEX "approval_policies_one_active_per_tenant_key"
  ON "approval_policies"("tenant_id") WHERE "active";
CREATE INDEX "approval_policies_tenant_active_idx"
  ON "approval_policies"("tenant_id", "active");

CREATE INDEX "refund_requests_tenant_status_created_idx"
  ON "refund_requests"("tenant_id", "workflow_status", "created_at" DESC);
CREATE INDEX "refund_requests_tenant_requester_created_idx"
  ON "refund_requests"("tenant_id", "requester_user_id", "created_at" DESC);
CREATE UNIQUE INDEX "refund_requests_active_payment_guard_key"
  ON "refund_requests"("tenant_id", "environment", "payment_key")
  WHERE "payment_guard_released_at" IS NULL;

CREATE UNIQUE INDEX "approval_decisions_request_approver_key"
  ON "approval_decisions"("request_id", "approver_user_id");
CREATE INDEX "approval_decisions_tenant_decided_idx"
  ON "approval_decisions"("tenant_id", "decided_at" DESC);

CREATE UNIQUE INDEX "refund_executions_tenant_idempotency_key"
  ON "refund_executions"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "refund_executions_tenant_stripe_refund_key"
  ON "refund_executions"("tenant_id", "stripe_refund_id");

CREATE UNIQUE INDEX "refund_execution_attempts_execution_number_key"
  ON "refund_execution_attempts"("execution_id", "attempt_number");
CREATE INDEX "refund_execution_attempts_tenant_started_idx"
  ON "refund_execution_attempts"("tenant_id", "started_at" DESC);

CREATE UNIQUE INDEX "refund_candidates_request_refund_key"
  ON "refund_correlation_candidates"("request_id", "stripe_refund_id");
CREATE INDEX "refund_candidates_installation_state_idx"
  ON "refund_correlation_candidates"("tenant_id", "installation_id", "state");

CREATE UNIQUE INDEX "webhook_receipts_endpoint_event_key"
  ON "webhook_receipts"("endpoint", "stripe_event_id");
CREATE INDEX "webhook_receipts_tenant_status_received_idx"
  ON "webhook_receipts"("tenant_id", "status", "received_at");
CREATE INDEX "webhook_receipts_recovery_idx"
  ON "webhook_receipts"("status", "received_at")
  WHERE "status" IN ('received', 'failed');

CREATE UNIQUE INDEX "external_refund_alerts_installation_refund_key"
  ON "external_refund_alerts"("installation_id", "stripe_refund_id");
CREATE INDEX "external_refund_alerts_tenant_status_detected_idx"
  ON "external_refund_alerts"("tenant_id", "status", "detected_at" DESC);
CREATE INDEX "external_refund_alerts_payment_protection_idx"
  ON "external_refund_alerts"(
    "tenant_id",
    "installation_id",
    "environment",
    "payment_key",
    "reconciled_at"
  );

CREATE INDEX "audit_events_tenant_occurred_idx"
  ON "audit_events"("tenant_id", "occurred_at" DESC, "id");

CREATE UNIQUE INDEX "api_mutation_receipts_tenant_nonce_key"
  ON "api_mutation_receipts"("tenant_id", "request_nonce");
CREATE INDEX "api_mutation_receipts_tenant_expires_idx"
  ON "api_mutation_receipts"("tenant_id", "expires_at");

CREATE UNIQUE INDEX "reconciliation_checkpoints_installation_key"
  ON "reconciliation_checkpoints"("installation_id");
CREATE UNIQUE INDEX "reconciliation_checkpoints_installation_tenant_key"
  ON "reconciliation_checkpoints"("installation_id", "tenant_id");
CREATE INDEX "reconciliation_checkpoints_tenant_window_idx"
  ON "reconciliation_checkpoints"("tenant_id", "committed_through");

ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_installation_id_tenant_id_environment_fkey"
  FOREIGN KEY ("installation_id", "tenant_id", "environment")
  REFERENCES "stripe_installations"("id", "tenant_id", "environment")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_requests"
  ADD CONSTRAINT "refund_requests_requester_user_id_tenant_id_fkey"
  FOREIGN KEY ("requester_user_id", "tenant_id")
  REFERENCES "tenant_users"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "approval_decisions_request_id_tenant_id_fkey"
  FOREIGN KEY ("request_id", "tenant_id")
  REFERENCES "refund_requests"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "approval_decisions_approver_user_id_tenant_id_fkey"
  FOREIGN KEY ("approver_user_id", "tenant_id")
  REFERENCES "tenant_users"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_executions"
  ADD CONSTRAINT "refund_executions_request_id_tenant_id_fkey"
  FOREIGN KEY ("request_id", "tenant_id")
  REFERENCES "refund_requests"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_execution_attempts"
  ADD CONSTRAINT "refund_execution_attempts_execution_id_tenant_id_fkey"
  FOREIGN KEY ("execution_id", "tenant_id")
  REFERENCES "refund_executions"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_correlation_candidates"
  ADD CONSTRAINT "refund_candidates_request_id_tenant_id_fkey"
  FOREIGN KEY ("request_id", "tenant_id")
  REFERENCES "refund_requests"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_correlation_candidates"
  ADD CONSTRAINT "refund_candidates_installation_id_tenant_id_fkey"
  FOREIGN KEY ("installation_id", "tenant_id")
  REFERENCES "stripe_installations"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_receipts"
  ADD CONSTRAINT "webhook_receipts_installation_id_tenant_id_fkey"
  FOREIGN KEY ("installation_id", "tenant_id")
  REFERENCES "stripe_installations"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_refund_alerts"
  ADD CONSTRAINT "external_refund_alerts_installation_tenant_environment_fkey"
  FOREIGN KEY ("installation_id", "tenant_id", "environment")
  REFERENCES "stripe_installations"("id", "tenant_id", "environment")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_refund_alerts"
  ADD CONSTRAINT "external_refund_alerts_acknowledger_tenant_fkey"
  FOREIGN KEY ("acknowledged_by_user_id", "tenant_id")
  REFERENCES "tenant_users"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_refund_alerts"
  ADD CONSTRAINT "external_refund_alerts_overlap_request_tenant_fkey"
  FOREIGN KEY ("overlapped_request_id", "tenant_id")
  REFERENCES "refund_requests"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_checkpoints"
  ADD CONSTRAINT "reconciliation_checkpoints_installation_id_tenant_id_fkey"
  FOREIGN KEY ("installation_id", "tenant_id")
  REFERENCES "stripe_installations"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "refunddesk_touch_updated_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tenants_touch_updated_at"
BEFORE UPDATE ON "tenants"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_touch_updated_at"();
CREATE TRIGGER "stripe_installations_touch_updated_at"
BEFORE UPDATE ON "stripe_installations"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_touch_updated_at"();
CREATE TRIGGER "tenant_users_touch_updated_at"
BEFORE UPDATE ON "tenant_users"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_touch_updated_at"();
CREATE TRIGGER "refund_requests_touch_updated_at"
BEFORE UPDATE ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_touch_updated_at"();
CREATE TRIGGER "refund_executions_touch_updated_at"
BEFORE UPDATE ON "refund_executions"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_touch_updated_at"();
CREATE TRIGGER "reconciliation_checkpoints_touch_updated_at"
BEFORE UPDATE ON "reconciliation_checkpoints"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_touch_updated_at"();

CREATE FUNCTION "refunddesk_lock_payment_scope"(
  requested_tenant_id UUID,
  requested_installation_id UUID,
  requested_environment "stripe_environment",
  requested_payment_key VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  IF requested_tenant_id IS NULL
     OR requested_installation_id IS NULL
     OR requested_environment NOT IN ('test', 'sandbox')
     OR requested_payment_key !~ '^(pi|ch)_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'invalid payment scope' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      requested_tenant_id::TEXT
        || chr(31)
        || requested_installation_id::TEXT
        || chr(31)
        || requested_environment::TEXT
        || chr(31)
        || requested_payment_key,
      0
    )
  );
END
$$;

REVOKE ALL ON FUNCTION "refunddesk_lock_payment_scope"(
  UUID,
  UUID,
  "stripe_environment",
  VARCHAR
) FROM PUBLIC;

CREATE FUNCTION "refunddesk_guard_external_payment_protection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public."refunddesk_lock_payment_scope"(
    NEW."tenant_id",
    NEW."installation_id",
    NEW."environment",
    NEW."payment_key"
  );

  IF NEW."workflow_status" IN ('pending_approval', 'approved', 'executing')
     AND EXISTS (
       SELECT 1
       FROM public."external_refund_alerts" AS alert
       WHERE alert."tenant_id" = NEW."tenant_id"
         AND alert."installation_id" = NEW."installation_id"
         AND alert."environment" = NEW."environment"
         AND alert."payment_key" = NEW."payment_key"
         AND alert."classification" IN ('external', 'tampered', 'proof_replay')
         AND alert."reconciled_at" IS NULL
     ) THEN
    RAISE EXCEPTION 'payment is protected by unresolved external reconciliation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_requests_external_payment_protection"
BEFORE INSERT OR UPDATE ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_guard_external_payment_protection"();

CREATE FUNCTION "refunddesk_preserve_request_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."tenant_id",
    NEW."installation_id",
    NEW."environment",
    NEW."payment_key",
    NEW."payment_intent_id",
    NEW."charge_id",
    NEW."amount_minor",
    NEW."currency",
    NEW."reason",
    NEW."justification_ciphertext",
    NEW."justification_nonce",
    NEW."justification_auth_tag",
    NEW."justification_key_version",
    NEW."requester_user_id",
    NEW."policy_version",
    NEW."required_approvals",
    NEW."created_at",
    NEW."expires_at"
  ) IS DISTINCT FROM ROW(
    OLD."tenant_id",
    OLD."installation_id",
    OLD."environment",
    OLD."payment_key",
    OLD."payment_intent_id",
    OLD."charge_id",
    OLD."amount_minor",
    OLD."currency",
    OLD."reason",
    OLD."justification_ciphertext",
    OLD."justification_nonce",
    OLD."justification_auth_tag",
    OLD."justification_key_version",
    OLD."requester_user_id",
    OLD."policy_version",
    OLD."required_approvals",
    OLD."created_at",
    OLD."expires_at"
  ) THEN
    RAISE EXCEPTION 'refund request financial snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'refund request version must increment exactly once'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."terminal_at" IS NOT NULL
     AND NEW."terminal_at" IS DISTINCT FROM OLD."terminal_at" THEN
    RAISE EXCEPTION 'refund request terminal timestamp is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_requests_preserve_snapshot"
BEFORE UPDATE ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_preserve_request_snapshot"();

CREATE FUNCTION "refunddesk_validate_workflow_transition"()
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
       OR current_refund_status IS DISTINCT FROM 'failed' THEN
      RAISE EXCEPTION 'succeeded workflow can fail only after the same Refund fails'
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

CREATE TRIGGER "refund_requests_validate_workflow_transition"
BEFORE UPDATE OF "workflow_status" ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_workflow_transition"();

CREATE FUNCTION "refunddesk_validate_effect_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed BOOLEAN := false;
  current_refund_status "stripe_refund_status";
BEGIN
  IF NEW."effect_state" = OLD."effect_state" THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD."effect_state"
    WHEN 'not_started' THEN NEW."effect_state" IN ('possible', 'absence_proven')
    WHEN 'possible' THEN NEW."effect_state" IN ('identified', 'absence_proven')
    WHEN 'identified' THEN NEW."effect_state" = 'absence_proven'
    WHEN 'absence_proven' THEN NEW."effect_state" = 'possible'
    ELSE false
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid effect transition from % to %',
      OLD."effect_state", NEW."effect_state"
      USING ERRCODE = '23514';
  END IF;
  IF OLD."effect_state" = 'identified' AND NEW."effect_state" = 'absence_proven' THEN
    SELECT "stripe_refund_status" INTO current_refund_status
    FROM "refund_executions"
    WHERE "request_id" = NEW."id" AND "tenant_id" = NEW."tenant_id";
    IF current_refund_status NOT IN ('failed', 'canceled') THEN
      RAISE EXCEPTION 'identified effect absence requires authoritative Stripe terminal status'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_requests_validate_effect_transition"
BEFORE UPDATE OF "effect_state" ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_effect_transition"();

CREATE FUNCTION "refunddesk_validate_guard_release"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refund_status "stripe_refund_status";
BEGIN
  IF OLD."payment_guard_released_at" IS NOT NULL THEN
    IF NEW."payment_guard_released_at" IS DISTINCT FROM OLD."payment_guard_released_at" THEN
      RAISE EXCEPTION 'payment guard release is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."payment_guard_released_at" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."workflow_status" = 'reconciliation_required' THEN
    RAISE EXCEPTION 'payment guard cannot be released during reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."workflow_status" IN ('rejected', 'canceled', 'expired')
     AND NEW."effect_state" = 'not_started' THEN
    RETURN NEW;
  END IF;

  IF NEW."workflow_status" IN ('stale', 'failed_terminal')
     AND NEW."effect_state" = 'absence_proven' THEN
    RETURN NEW;
  END IF;

  IF NEW."workflow_status" = 'succeeded' THEN
    SELECT "stripe_refund_status" INTO refund_status
    FROM "refund_executions"
    WHERE "request_id" = NEW."id" AND "tenant_id" = NEW."tenant_id";

    IF refund_status = 'succeeded' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'payment guard release requires certain absence or a terminal Stripe refund'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "refund_requests_validate_guard_release"
BEFORE UPDATE OF "payment_guard_released_at" ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_guard_release"();

CREATE FUNCTION "refunddesk_validate_request_approver_available"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "tenant_users"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "approver_enabled"
      AND "id" <> NEW."requester_user_id"
  ) THEN
    RAISE EXCEPTION 'a distinct enabled approver is required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_requests_validate_approver_available"
BEFORE INSERT ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_request_approver_available"();

CREATE FUNCTION "refunddesk_validate_decision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requester UUID;
  request_status "workflow_status";
  request_expiry TIMESTAMPTZ;
BEGIN
  SELECT "requester_user_id", "workflow_status", "expires_at"
  INTO requester, request_status, request_expiry
  FROM "refund_requests"
  WHERE "id" = NEW."request_id" AND "tenant_id" = NEW."tenant_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund request not found in tenant' USING ERRCODE = '23503';
  END IF;
  IF requester = NEW."approver_user_id" THEN
    RAISE EXCEPTION 'requester cannot decide their own request' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "tenant_users"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."approver_user_id"
      AND "approver_enabled"
  ) THEN
    RAISE EXCEPTION 'approver is not explicitly enabled' USING ERRCODE = '42501';
  END IF;
  IF request_status <> 'pending_approval' OR NEW."decided_at" >= request_expiry THEN
    RAISE EXCEPTION 'request is no longer open for decisions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "approval_decisions_validate_insert"
BEFORE INSERT ON "approval_decisions"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_decision"();

CREATE FUNCTION "refunddesk_prevent_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('refunddesk.purge_tenant_id', true) = OLD."tenant_id"::TEXT THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER "approval_decisions_append_only"
BEFORE UPDATE OR DELETE ON "approval_decisions"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_prevent_append_only_mutation"();
CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_prevent_append_only_mutation"();
CREATE TRIGGER "api_mutation_receipts_append_only"
BEFORE UPDATE OR DELETE ON "api_mutation_receipts"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_prevent_append_only_mutation"();

CREATE FUNCTION "refunddesk_prevent_purge_certificate_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'purge_certificates is append-only' USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER "purge_certificates_append_only"
BEFORE UPDATE OR DELETE ON "purge_certificates"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_prevent_purge_certificate_mutation"();

CREATE FUNCTION "refunddesk_preserve_external_refund_protection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."tenant_id",
    NEW."installation_id",
    NEW."environment",
    NEW."stripe_refund_id",
    NEW."stripe_refund_created_at",
    NEW."payment_key",
    NEW."amount_minor",
    NEW."currency",
    NEW."classification",
    NEW."detected_at",
    NEW."overlapped_request_id",
    NEW."reconciled_at"
  ) IS DISTINCT FROM ROW(
    OLD."tenant_id",
    OLD."installation_id",
    OLD."environment",
    OLD."stripe_refund_id",
    OLD."stripe_refund_created_at",
    OLD."payment_key",
    OLD."amount_minor",
    OLD."currency",
    OLD."classification",
    OLD."detected_at",
    OLD."overlapped_request_id",
    OLD."reconciled_at"
  ) THEN
    RAISE EXCEPTION 'external refund payment protection is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD."status" = 'acknowledged'
     AND ROW(
       NEW."status",
       NEW."acknowledged_at",
       NEW."acknowledged_by_user_id"
     ) IS DISTINCT FROM ROW(
       OLD."status",
       OLD."acknowledged_at",
       OLD."acknowledged_by_user_id"
     ) THEN
    RAISE EXCEPTION 'external refund acknowledgement is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "external_refund_alerts_preserve_payment_protection"
BEFORE UPDATE ON "external_refund_alerts"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_preserve_external_refund_protection"();

CREATE FUNCTION "refunddesk_validate_execution_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_amount BIGINT;
  requested_currency CHAR(3);
  request_status "workflow_status";
BEGIN
  SELECT "amount_minor", "currency", "workflow_status"
  INTO requested_amount, requested_currency, request_status
  FROM "refund_requests"
  WHERE "id" = NEW."request_id" AND "tenant_id" = NEW."tenant_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund request not found for execution' USING ERRCODE = '23503';
  END IF;
  IF requested_amount <> NEW."amount_minor"
     OR requested_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'execution parameters differ from request snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."idempotency_key" <> (
    'refunddesk:refund-request:' || NEW."request_id"::TEXT || ':v1'
  ) THEN
    RAISE EXCEPTION 'execution idempotency key does not match request'
      USING ERRCODE = '23514';
  END IF;
  IF request_status <> 'executing' THEN
    RAISE EXCEPTION 'execution can be created only for a claimed request'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_executions_validate_insert"
BEFORE INSERT ON "refund_executions"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_execution_insert"();

CREATE FUNCTION "refunddesk_preserve_first_refund_link"()
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
       OLD."stripe_refund_status" = 'succeeded'
       AND NEW."stripe_refund_status" = 'failed'
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

CREATE TRIGGER "refund_executions_preserve_first_refund_link"
BEFORE UPDATE ON "refund_executions"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_preserve_first_refund_link"();

CREATE FUNCTION "refunddesk_current_tenant_id"()
RETURNS UUID
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::UUID
$$;

REVOKE ALL ON FUNCTION "refunddesk_current_tenant_id"() FROM PUBLIC;

CREATE FUNCTION "refunddesk_resolve_installation"(
  requested_account_id VARCHAR,
  requested_environment "stripe_environment"
)
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "status" "installation_status"
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT installation."tenant_id", installation."id", installation."status"
  FROM public."stripe_installations" AS installation
  INNER JOIN public."tenants" AS tenant ON tenant."id" = installation."tenant_id"
  WHERE installation."stripe_account_id" = requested_account_id
    AND installation."environment" = requested_environment
    AND tenant."status" = 'active'
$$;

REVOKE ALL ON FUNCTION "refunddesk_resolve_installation"(VARCHAR, "stripe_environment") FROM PUBLIC;

CREATE FUNCTION "refunddesk_provision_installation"(
  requested_account_id VARCHAR,
  requested_environment "stripe_environment"
)
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "status" "installation_status"
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  created_tenant_id UUID;
  selected_tenant_id UUID;
  selected_installation_id UUID;
  selected_status "installation_status";
  selected_lifecycle_type VARCHAR;
BEGIN
  IF requested_environment = 'live' THEN
    RAISE EXCEPTION 'live installation provisioning is disabled for the pilot'
      USING ERRCODE = '42501';
  END IF;
  IF requested_account_id !~ '^acct_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'invalid Stripe account identifier' USING ERRCODE = '22023';
  END IF;

  SELECT
    installation."tenant_id",
    installation."id",
    installation."status",
    installation."last_lifecycle_event_type"
  INTO
    selected_tenant_id,
    selected_installation_id,
    selected_status,
    selected_lifecycle_type
  FROM public."stripe_installations" AS installation
  WHERE installation."stripe_account_id" = requested_account_id
    AND installation."environment" = requested_environment
  FOR UPDATE;

  IF FOUND THEN
    IF selected_status = 'deauthorized'
       AND selected_lifecycle_type = 'account.application.deauthorized' THEN
      RETURN QUERY SELECT selected_tenant_id, selected_installation_id, selected_status;
      RETURN;
    END IF;
    UPDATE public."tenants"
    SET "status" = 'active', "pending_delete_at" = NULL
    WHERE "id" = selected_tenant_id;
    UPDATE public."stripe_installations" AS updated
    SET "status" = 'active', "deauthorized_at" = NULL
    WHERE "id" = selected_installation_id
    RETURNING updated."status" INTO selected_status;
    RETURN QUERY SELECT selected_tenant_id, selected_installation_id, selected_status;
    RETURN;
  END IF;

  INSERT INTO public."tenants" DEFAULT VALUES
  RETURNING "id" INTO created_tenant_id;

  BEGIN
    INSERT INTO public."stripe_installations" AS inserted (
      "tenant_id",
      "stripe_account_id",
      "environment"
    )
    VALUES (
      created_tenant_id,
      requested_account_id,
      requested_environment
    )
    RETURNING inserted."tenant_id", inserted."id", inserted."status"
    INTO selected_tenant_id, selected_installation_id, selected_status;
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM public."tenants" WHERE "id" = created_tenant_id;
    SELECT installation."tenant_id", installation."id", installation."status"
    INTO selected_tenant_id, selected_installation_id, selected_status
    FROM public."stripe_installations" AS installation
    WHERE installation."stripe_account_id" = requested_account_id
      AND installation."environment" = requested_environment;
  END;

  RETURN QUERY SELECT selected_tenant_id, selected_installation_id, selected_status;
END
$$;

REVOKE ALL ON FUNCTION "refunddesk_provision_installation"(VARCHAR, "stripe_environment") FROM PUBLIC;

CREATE FUNCTION "refunddesk_provision_webhook_installation"(
  requested_account_id VARCHAR,
  requested_environment "stripe_environment",
  requested_event_id VARCHAR,
  requested_event_created_at TIMESTAMPTZ
)
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "status" "installation_status",
  "applied" BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  created_tenant_id UUID;
  selected_tenant_id UUID;
  selected_installation_id UUID;
  selected_status "installation_status";
  last_event_id VARCHAR;
  last_event_type VARCHAR;
  last_event_created_at TIMESTAMPTZ;
  should_apply BOOLEAN;
BEGIN
  IF requested_environment = 'live' THEN
    RAISE EXCEPTION 'live installation provisioning is disabled for the pilot'
      USING ERRCODE = '42501';
  END IF;
  IF requested_account_id !~ '^acct_[A-Za-z0-9]+$'
     OR requested_event_id !~ '^evt_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'invalid Stripe identifier' USING ERRCODE = '22023';
  END IF;

  SELECT
    installation."tenant_id",
    installation."id",
    installation."status",
    installation."last_lifecycle_event_id",
    installation."last_lifecycle_event_type",
    installation."last_lifecycle_event_created_at"
  INTO
    selected_tenant_id,
    selected_installation_id,
    selected_status,
    last_event_id,
    last_event_type,
    last_event_created_at
  FROM public."stripe_installations" AS installation
  WHERE installation."stripe_account_id" = requested_account_id
    AND installation."environment" = requested_environment
  FOR UPDATE;

  IF FOUND THEN
    should_apply :=
      last_event_created_at IS NULL
      OR requested_event_created_at > last_event_created_at
      OR (
        requested_event_created_at = last_event_created_at
        AND last_event_id = requested_event_id
      );
    IF should_apply THEN
      UPDATE public."tenants"
      SET "status" = 'active', "pending_delete_at" = NULL
      WHERE "id" = selected_tenant_id;
      UPDATE public."stripe_installations" AS updated
      SET
        "status" = 'active',
        "deauthorized_at" = NULL,
        "last_lifecycle_event_id" = requested_event_id,
        "last_lifecycle_event_type" = 'account.application.authorized',
        "last_lifecycle_event_created_at" = requested_event_created_at
      WHERE "id" = selected_installation_id
      RETURNING updated."status" INTO selected_status;
    END IF;
    RETURN QUERY
      SELECT selected_tenant_id, selected_installation_id, selected_status, should_apply;
    RETURN;
  END IF;

  INSERT INTO public."tenants" DEFAULT VALUES
  RETURNING "id" INTO created_tenant_id;

  BEGIN
    INSERT INTO public."stripe_installations" AS inserted (
      "tenant_id",
      "stripe_account_id",
      "environment",
      "last_lifecycle_event_id",
      "last_lifecycle_event_type",
      "last_lifecycle_event_created_at"
    )
    VALUES (
      created_tenant_id,
      requested_account_id,
      requested_environment,
      requested_event_id,
      'account.application.authorized',
      requested_event_created_at
    )
    RETURNING inserted."tenant_id", inserted."id", inserted."status"
    INTO selected_tenant_id, selected_installation_id, selected_status;
    RETURN QUERY
      SELECT selected_tenant_id, selected_installation_id, selected_status, true;
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM public."tenants" WHERE "id" = created_tenant_id;
    SELECT
      installation."tenant_id",
      installation."id",
      installation."status",
      installation."last_lifecycle_event_id",
      installation."last_lifecycle_event_created_at"
    INTO
      selected_tenant_id,
      selected_installation_id,
      selected_status,
      last_event_id,
      last_event_created_at
    FROM public."stripe_installations" AS installation
    WHERE installation."stripe_account_id" = requested_account_id
      AND installation."environment" = requested_environment
    FOR UPDATE;
    should_apply :=
      last_event_created_at IS NULL
      OR requested_event_created_at > last_event_created_at
      OR (
        requested_event_created_at = last_event_created_at
        AND last_event_id = requested_event_id
      );
    IF should_apply THEN
      UPDATE public."tenants"
      SET "status" = 'active', "pending_delete_at" = NULL
      WHERE "id" = selected_tenant_id;
      UPDATE public."stripe_installations" AS updated
      SET
        "status" = 'active',
        "deauthorized_at" = NULL,
        "last_lifecycle_event_id" = requested_event_id,
        "last_lifecycle_event_type" = 'account.application.authorized',
        "last_lifecycle_event_created_at" = requested_event_created_at
      WHERE "id" = selected_installation_id
      RETURNING updated."status" INTO selected_status;
    END IF;
    RETURN QUERY
      SELECT selected_tenant_id, selected_installation_id, selected_status, should_apply;
  END;
END
$$;

REVOKE ALL ON FUNCTION "refunddesk_provision_webhook_installation"(
  VARCHAR,
  "stripe_environment",
  VARCHAR,
  TIMESTAMPTZ
) FROM PUBLIC;

CREATE FUNCTION "refunddesk_list_scannable_installations"()
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "stripe_account_id" VARCHAR,
  "environment" "stripe_environment",
  "tenant_status" "tenant_status",
  "installation_status" "installation_status",
  "live_enabled" BOOLEAN,
  "installed_at" TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    installation."tenant_id",
    installation."id",
    installation."stripe_account_id",
    installation."environment",
    tenant."status",
    installation."status",
    tenant."live_enabled",
    installation."installed_at"
  FROM public."stripe_installations" AS installation
  INNER JOIN public."tenants" AS tenant ON tenant."id" = installation."tenant_id"
  WHERE tenant."status" = 'active'
    AND installation."status" = 'active'
    AND installation."environment" IN ('test', 'sandbox')
  ORDER BY installation."tenant_id", installation."id"
$$;

REVOKE ALL ON FUNCTION "refunddesk_list_scannable_installations"() FROM PUBLIC;

CREATE FUNCTION "refunddesk_list_active_tenant_ids"()
RETURNS TABLE ("tenant_id" UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT tenant."id"
  FROM public."tenants" AS tenant
  WHERE tenant."status" = 'active'
  ORDER BY tenant."id"
$$;

REVOKE ALL ON FUNCTION "refunddesk_list_active_tenant_ids"() FROM PUBLIC;

CREATE FUNCTION "refunddesk_find_webhook_receipt"(
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
  WHERE receipt."endpoint" = requested_endpoint
    AND receipt."stripe_event_id" = requested_event_id
    AND receipt."stripe_account_id" = requested_account_id
$$;

REVOKE ALL ON FUNCTION "refunddesk_find_webhook_receipt"(
  "webhook_endpoint",
  VARCHAR,
  VARCHAR
) FROM PUBLIC;

CREATE FUNCTION "refunddesk_resolve_webhook_installation"(
  requested_account_id VARCHAR,
  requested_environment "stripe_environment"
)
RETURNS TABLE (
  "tenant_id" UUID,
  "installation_id" UUID,
  "status" "installation_status"
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT installation."tenant_id", installation."id", installation."status"
  FROM public."stripe_installations" AS installation
  WHERE installation."stripe_account_id" = requested_account_id
    AND installation."environment" = requested_environment
    AND installation."environment" IN ('test', 'sandbox')
$$;

REVOKE ALL ON FUNCTION "refunddesk_resolve_webhook_installation"(
  VARCHAR,
  "stripe_environment"
) FROM PUBLIC;

CREATE FUNCTION "refunddesk_list_recoverable_webhook_receipts"(
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
     (receipt."endpoint" = 'connected_test' AND installation."environment" = 'test')
     OR (receipt."endpoint" = 'connected_sandbox' AND installation."environment" = 'sandbox')
   )
  INNER JOIN public."tenants" AS tenant
    ON tenant."id" = receipt."tenant_id"
  WHERE receipt."endpoint" IN ('connected_test', 'connected_sandbox')
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

REVOKE ALL ON FUNCTION "refunddesk_list_recoverable_webhook_receipts"(INTEGER) FROM PUBLIC;

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenants_isolate" ON "tenants"
  USING ("id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("id" = "refunddesk_current_tenant_id"());

ALTER TABLE "stripe_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_installations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "stripe_installations_isolate" ON "stripe_installations"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

DO $$
DECLARE
  migration_owner NAME := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY tenants_owner_management ON tenants TO %I USING (true) WITH CHECK (true)',
    migration_owner
  );
  EXECUTE format(
    'CREATE POLICY stripe_installations_owner_management ON stripe_installations TO %I USING (true) WITH CHECK (true)',
    migration_owner
  );
END
$$;

ALTER TABLE "tenant_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_users_isolate" ON "tenant_users"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approval_policies_isolate" ON "approval_policies"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "refund_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_requests_isolate" ON "refund_requests"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "approval_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approval_decisions_isolate" ON "approval_decisions"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "refund_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_executions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_executions_isolate" ON "refund_executions"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "refund_execution_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_execution_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_execution_attempts_isolate" ON "refund_execution_attempts"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "refund_correlation_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_correlation_candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refund_candidates_isolate" ON "refund_correlation_candidates"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "webhook_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "webhook_receipts_isolate" ON "webhook_receipts"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "external_refund_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_refund_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "external_refund_alerts_isolate" ON "external_refund_alerts"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_events_isolate" ON "audit_events"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "api_mutation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_mutation_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "api_mutation_receipts_isolate" ON "api_mutation_receipts"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

ALTER TABLE "reconciliation_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reconciliation_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "reconciliation_checkpoints_isolate" ON "reconciliation_checkpoints"
  USING ("tenant_id" = "refunddesk_current_tenant_id"())
  WITH CHECK ("tenant_id" = "refunddesk_current_tenant_id"());

CREATE FUNCTION "refunddesk_purge_tenant"(
  requested_tenant_id UUID,
  requested_tenant_pseudonym VARCHAR
)
RETURNS TABLE (
  "certificate_id" UUID,
  "tenant_pseudonym" VARCHAR,
  "uninstalled_at" TIMESTAMPTZ,
  "purge_completed_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ,
  "policy_version" VARCHAR,
  "process_version" VARCHAR,
  "deleted_counts" JSONB,
  "result" VARCHAR
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  previous_tenant_context TEXT := current_setting('app.tenant_id', true);
  previous_purge_context TEXT := current_setting('refunddesk.purge_tenant_id', true);
  selected_status public."tenant_status";
  selected_pending_delete_at TIMESTAMPTZ;
  selected_legal_hold_at TIMESTAMPTZ;
  selected_uninstalled_at TIMESTAMPTZ;
  completed_at TIMESTAMPTZ := statement_timestamp();
  certificate public."purge_certificates"%ROWTYPE;
  certificate_found BOOLEAN := false;
  purged_mutation_receipts INTEGER := 0;
  purged_webhook_receipts INTEGER := 0;
  purged_reconciliation_checkpoints INTEGER := 0;
  purged_refund_candidates INTEGER := 0;
  purged_external_alerts INTEGER := 0;
  purged_execution_attempts INTEGER := 0;
  purged_executions INTEGER := 0;
  purged_decisions INTEGER := 0;
  purged_audit_events INTEGER := 0;
  purged_requests INTEGER := 0;
  purged_policies INTEGER := 0;
  purged_users INTEGER := 0;
  purged_installations INTEGER := 0;
  purged_tenants INTEGER := 0;
  counts JSONB;
BEGIN
  IF requested_tenant_id IS NULL
     OR requested_tenant_pseudonym IS NULL
     OR requested_tenant_pseudonym !~ '^v1\.[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'invalid tenant purge request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(requested_tenant_id::TEXT, 0));
  PERFORM set_config('app.tenant_id', requested_tenant_id::TEXT, true);

  SELECT tenant."status", tenant."pending_delete_at", tenant."legal_hold_at"
  INTO selected_status, selected_pending_delete_at, selected_legal_hold_at
  FROM public."tenants" AS tenant
  WHERE tenant."id" = requested_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT *
    INTO certificate
    FROM public."purge_certificates" AS existing
    WHERE existing."tenant_pseudonym" = requested_tenant_pseudonym;
    certificate_found := FOUND;
    PERFORM set_config('app.tenant_id', COALESCE(previous_tenant_context, ''), true);
    IF NOT certificate_found THEN
      RAISE EXCEPTION 'tenant purge target was not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY
      SELECT
        certificate."id",
        certificate."tenant_pseudonym",
        certificate."uninstalled_at",
        certificate."purge_completed_at",
        certificate."expires_at",
        certificate."policy_version",
        certificate."process_version",
        certificate."deleted_counts",
        certificate."result";
    RETURN;
  END IF;

  IF selected_status <> 'pending_deletion'
     OR selected_pending_delete_at IS NULL
     OR selected_pending_delete_at > completed_at THEN
    RAISE EXCEPTION 'tenant purge deadline is not due' USING ERRCODE = '55000';
  END IF;
  IF selected_legal_hold_at IS NOT NULL THEN
    RAISE EXCEPTION 'tenant purge is blocked by legal hold' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."stripe_installations" AS installation
    WHERE installation."tenant_id" = requested_tenant_id
  ) OR EXISTS (
    SELECT 1
    FROM public."stripe_installations" AS installation
    WHERE installation."tenant_id" = requested_tenant_id
      AND (
        installation."status" <> 'deauthorized'
        OR installation."deauthorized_at" IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'tenant purge requires complete deauthorization' USING ERRCODE = '55000';
  END IF;
  SELECT MAX(installation."deauthorized_at")
  INTO selected_uninstalled_at
  FROM public."stripe_installations" AS installation
  WHERE installation."tenant_id" = requested_tenant_id;
  IF selected_uninstalled_at IS NULL
     OR selected_pending_delete_at > selected_uninstalled_at + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'tenant purge schedule exceeds the uninstall deadline'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."refund_requests" AS request
    WHERE request."tenant_id" = requested_tenant_id
      AND (
        request."payment_guard_released_at" IS NULL
        OR request."workflow_status" IN ('executing', 'reconciliation_required')
        OR request."effect_state" = 'possible'
        OR (
          request."effect_state" = 'identified'
          AND request."workflow_status" <> 'succeeded'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public."refund_execution_attempts" AS attempt
    WHERE attempt."tenant_id" = requested_tenant_id
      AND attempt."state" = 'started'
  ) OR EXISTS (
    SELECT 1
    FROM public."refund_correlation_candidates" AS candidate
    WHERE candidate."tenant_id" = requested_tenant_id
      AND candidate."state" IN ('pending', 'conflict')
  ) OR EXISTS (
    SELECT 1
    FROM public."webhook_receipts" AS receipt
    WHERE receipt."tenant_id" = requested_tenant_id
      AND receipt."event_type" LIKE 'refund.%'
      AND receipt."status" <> 'processed'
  ) OR EXISTS (
    SELECT 1
    FROM public."external_refund_alerts" AS alert
    WHERE alert."tenant_id" = requested_tenant_id
      AND alert."classification" IN ('external', 'tampered', 'proof_replay')
      AND alert."reconciled_at" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public."reconciliation_checkpoints" AS checkpoint
    WHERE checkpoint."tenant_id" = requested_tenant_id
      AND checkpoint."page_in_progress"
  ) THEN
    RAISE EXCEPTION 'tenant purge is blocked by unresolved financial state'
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('refunddesk.purge_tenant_id', requested_tenant_id::TEXT, true);

  DELETE FROM public."api_mutation_receipts"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_mutation_receipts = ROW_COUNT;

  DELETE FROM public."webhook_receipts"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_webhook_receipts = ROW_COUNT;

  DELETE FROM public."reconciliation_checkpoints"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_reconciliation_checkpoints = ROW_COUNT;

  DELETE FROM public."refund_correlation_candidates"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_refund_candidates = ROW_COUNT;

  DELETE FROM public."external_refund_alerts"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_external_alerts = ROW_COUNT;

  DELETE FROM public."refund_execution_attempts"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_execution_attempts = ROW_COUNT;

  DELETE FROM public."refund_executions"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_executions = ROW_COUNT;

  DELETE FROM public."approval_decisions"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_decisions = ROW_COUNT;

  DELETE FROM public."audit_events"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_audit_events = ROW_COUNT;

  DELETE FROM public."refund_requests"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_requests = ROW_COUNT;

  DELETE FROM public."approval_policies"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_policies = ROW_COUNT;

  DELETE FROM public."tenant_users"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_users = ROW_COUNT;

  DELETE FROM public."stripe_installations"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS purged_installations = ROW_COUNT;

  DELETE FROM public."tenants"
  WHERE "id" = requested_tenant_id;
  GET DIAGNOSTICS purged_tenants = ROW_COUNT;
  IF purged_tenants <> 1 THEN
    RAISE EXCEPTION 'tenant purge compare-and-set failed' USING ERRCODE = '40001';
  END IF;

  counts := jsonb_build_object(
    'mutation_receipts', purged_mutation_receipts,
    'webhook_receipts', purged_webhook_receipts,
    'reconciliation_checkpoints', purged_reconciliation_checkpoints,
    'refund_candidates', purged_refund_candidates,
    'external_alerts', purged_external_alerts,
    'execution_attempts', purged_execution_attempts,
    'executions', purged_executions,
    'decisions', purged_decisions,
    'audit_events', purged_audit_events,
    'requests', purged_requests,
    'policies', purged_policies,
    'users', purged_users,
    'installations', purged_installations,
    'tenants', purged_tenants
  );

  INSERT INTO public."purge_certificates" (
    "tenant_pseudonym",
    "uninstalled_at",
    "purge_completed_at",
    "expires_at",
    "policy_version",
    "process_version",
    "deleted_counts",
    "result"
  )
  VALUES (
    requested_tenant_pseudonym,
    selected_uninstalled_at,
    completed_at,
    completed_at + INTERVAL '365 days',
    'pilot-v1',
    'db-purge-v1',
    counts,
    'completed'
  )
  RETURNING * INTO certificate;

  PERFORM set_config(
    'refunddesk.purge_tenant_id',
    COALESCE(previous_purge_context, ''),
    true
  );
  PERFORM set_config('app.tenant_id', COALESCE(previous_tenant_context, ''), true);

  RETURN QUERY
    SELECT
      certificate."id",
      certificate."tenant_pseudonym",
      certificate."uninstalled_at",
      certificate."purge_completed_at",
      certificate."expires_at",
      certificate."policy_version",
      certificate."process_version",
      certificate."deleted_counts",
      certificate."result";
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'refunddesk.purge_tenant_id',
    COALESCE(previous_purge_context, ''),
    true
  );
  PERFORM set_config('app.tenant_id', COALESCE(previous_tenant_context, ''), true);
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION "refunddesk_purge_tenant"(UUID, VARCHAR) FROM PUBLIC;
