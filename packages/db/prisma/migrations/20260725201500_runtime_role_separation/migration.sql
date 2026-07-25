CREATE FUNCTION "refunddesk_enforce_request_role_boundary"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  web_runtime_session BOOLEAN := false;
  protective_deauthorization BOOLEAN := false;
BEGIN
  -- session_user is the authenticated principal and cannot be changed with
  -- SET ROLE. Table owners (including an owner using SET ROLE for fixtures)
  -- remain able to perform privileged lifecycle work.
  SELECT CASE
    WHEN web_role."oid" IS NULL THEN false
    WHEN session_role."oid" = relation."relowner" THEN false
    ELSE pg_has_role(session_user, web_role."oid", 'MEMBER')
  END
  INTO web_runtime_session
  FROM pg_catalog.pg_class AS relation
  LEFT JOIN pg_catalog.pg_roles AS web_role
    ON web_role."rolname" = 'refunddesk_runtime'
  LEFT JOIN pg_catalog.pg_roles AS session_role
    ON session_role."rolname" = session_user
  WHERE relation."oid" = TG_RELID;

  IF NOT COALESCE(web_runtime_session, false) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."workflow_status" <> 'pending_approval'
       OR NEW."effect_state" <> 'not_started'
       OR NEW."version" <> 0
       OR NEW."payment_guard_released_at" IS NOT NULL
       OR NEW."approved_at" IS NOT NULL
       OR NEW."execution_started_at" IS NOT NULL
       OR NEW."reconciliation_safe_after_at" IS NOT NULL
       OR NEW."terminal_at" IS NOT NULL THEN
      RAISE EXCEPTION 'web runtime can create only a new pending refund request'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "stripe_installations" AS installation
    WHERE installation."id" = NEW."installation_id"
      AND installation."tenant_id" = NEW."tenant_id"
      AND installation."environment" = NEW."environment"
      AND installation."status" IN ('suspended', 'deauthorized')
  )
  AND NEW."approved_at" IS NOT DISTINCT FROM OLD."approved_at"
  AND NEW."execution_started_at" IS NOT DISTINCT FROM OLD."execution_started_at"
  AND NEW."reconciliation_safe_after_at"
    IS NOT DISTINCT FROM OLD."reconciliation_safe_after_at"
  AND (
    (
      OLD."workflow_status" IN ('pending_approval', 'approved')
      AND OLD."effect_state" = 'not_started'
      AND OLD."payment_guard_released_at" IS NULL
      AND NEW."workflow_status" = 'stale'
      AND NEW."effect_state" = 'absence_proven'
      AND NEW."terminal_at" IS NOT NULL
      AND NEW."payment_guard_released_at" = NEW."terminal_at"
    )
    OR (
      OLD."workflow_status" = 'executing'
      AND OLD."effect_state" IN ('not_started', 'absence_proven')
      AND OLD."payment_guard_released_at" IS NULL
      AND NEW."workflow_status" = 'failed_terminal'
      AND NEW."effect_state" = 'absence_proven'
      AND NEW."terminal_at" IS NOT NULL
      AND NEW."payment_guard_released_at" = NEW."terminal_at"
    )
    OR (
      OLD."workflow_status" = 'executing'
      AND OLD."effect_state" IN ('possible', 'identified')
      AND OLD."payment_guard_released_at" IS NULL
      AND NEW."workflow_status" = 'reconciliation_required'
      AND NEW."effect_state" = OLD."effect_state"
      AND NEW."terminal_at" IS NOT DISTINCT FROM OLD."terminal_at"
      AND NEW."payment_guard_released_at" IS NULL
    )
  )
  INTO protective_deauthorization;

  IF COALESCE(protective_deauthorization, false) THEN
    RETURN NEW;
  END IF;

  IF OLD."workflow_status" = 'pending_approval'
     AND NEW."workflow_status" IN ('approved', 'rejected', 'canceled')
     AND OLD."effect_state" = 'not_started'
     AND NEW."effect_state" = 'not_started'
     AND NEW."execution_started_at" IS NULL
     AND NEW."reconciliation_safe_after_at" IS NULL
     AND (
       (
         NEW."workflow_status" = 'approved'
         AND NEW."approved_at" IS NOT NULL
         AND NEW."terminal_at" IS NULL
         AND NEW."payment_guard_released_at" IS NULL
       )
       OR (
         NEW."workflow_status" IN ('rejected', 'canceled')
         AND NEW."approved_at" IS NULL
         AND NEW."terminal_at" IS NOT NULL
         AND NEW."payment_guard_released_at" = NEW."terminal_at"
       )
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'web runtime cannot mutate worker-owned refund lifecycle state'
      USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER "refund_requests_enforce_role_boundary"
BEFORE INSERT OR UPDATE ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_enforce_request_role_boundary"();

CREATE FUNCTION "refunddesk_validate_durable_decision_transition"()
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
        AND approver."approver_enabled"
        AND approver."id" <> NEW."requester_user_id"
    ),
    count(*) FILTER (
      WHERE decision."decision" = 'reject'
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
    RAISE EXCEPTION 'refund decision references an inactive, self, or cross-tenant approver'
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

CREATE TRIGGER "refund_requests_validate_durable_decision_transition"
BEFORE UPDATE OF "workflow_status" ON "refund_requests"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_validate_durable_decision_transition"();

CREATE FUNCTION "refunddesk_enforce_worker_owned_relation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  web_runtime_session BOOLEAN := false;
BEGIN
  SELECT CASE
    WHEN web_role."oid" IS NULL THEN false
    WHEN session_role."oid" = relation."relowner" THEN false
    ELSE pg_has_role(session_user, web_role."oid", 'MEMBER')
  END
  INTO web_runtime_session
  FROM pg_catalog.pg_class AS relation
  LEFT JOIN pg_catalog.pg_roles AS web_role
    ON web_role."rolname" = 'refunddesk_runtime'
  LEFT JOIN pg_catalog.pg_roles AS session_role
    ON session_role."rolname" = session_user
  WHERE relation."oid" = TG_RELID;

  IF COALESCE(web_runtime_session, false) THEN
    RAISE EXCEPTION 'web runtime cannot write worker-owned execution data'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "refund_executions_enforce_worker_owner"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_executions"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_enforce_worker_owned_relation"();

CREATE TRIGGER "refund_execution_attempts_enforce_worker_owner"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_execution_attempts"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_enforce_worker_owned_relation"();

CREATE TRIGGER "refund_correlation_candidates_enforce_worker_owner"
BEFORE INSERT OR UPDATE OR DELETE ON "refund_correlation_candidates"
FOR EACH ROW EXECUTE FUNCTION "refunddesk_enforce_worker_owned_relation"();

CREATE OR REPLACE FUNCTION "refunddesk_validate_decision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requester UUID;
  approver_is_active BOOLEAN := false;
  request_status "workflow_status";
  request_created_at TIMESTAMPTZ;
  request_expiry TIMESTAMPTZ;
BEGIN
  SELECT
    "requester_user_id",
    "workflow_status",
    "created_at",
    "expires_at"
  INTO requester, request_status, request_created_at, request_expiry
  FROM "refund_requests"
  WHERE "id" = NEW."request_id"
    AND "tenant_id" = NEW."tenant_id"
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
    FROM "tenant_users"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."approver_user_id"
      AND "approver_enabled"
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

  RETURN NEW;
END
$$;
