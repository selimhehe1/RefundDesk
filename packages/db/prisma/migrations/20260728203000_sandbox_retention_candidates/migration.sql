-- Installation lifecycle changes and guarded tenant purge share one advisory
-- lock keyed by tenant. Provisioning first discovers the identity without a
-- row lock, acquires that tenant lock, then reselects FOR UPDATE. If purge won
-- while provisioning waited, the identity disappears and provisioning safely
-- retries as a new installation instead of resurrecting deleted tenant state.
CREATE OR REPLACE FUNCTION "refunddesk_provision_installation"(
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
  lifecycle_attempts INTEGER := 0;
BEGIN
  IF requested_environment = 'live' THEN
    RAISE EXCEPTION 'live installation provisioning is disabled for the pilot'
      USING ERRCODE = '42501';
  END IF;
  IF requested_account_id !~ '^acct_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'invalid Stripe account identifier' USING ERRCODE = '22023';
  END IF;

  LOOP
    lifecycle_attempts := lifecycle_attempts + 1;
    IF lifecycle_attempts > 8 THEN
      RAISE EXCEPTION 'installation lifecycle contention'
        USING ERRCODE = '40001';
    END IF;
    selected_tenant_id := NULL;
    selected_installation_id := NULL;
    SELECT
      installation."tenant_id",
      installation."id"
    INTO
      selected_tenant_id,
      selected_installation_id
    FROM public."stripe_installations" AS installation
    WHERE installation."stripe_account_id" = requested_account_id
      AND installation."environment" = requested_environment;

    IF selected_tenant_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(selected_tenant_id::TEXT, 0)
      );
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
        AND installation."tenant_id" = selected_tenant_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'installation identity changed under lifecycle lock'
          USING ERRCODE = '40001';
      END IF;

      IF selected_status = 'deauthorized'
         AND selected_lifecycle_type = 'account.application.deauthorized' THEN
        RETURN QUERY
          SELECT selected_tenant_id, selected_installation_id, selected_status;
        RETURN;
      END IF;
      UPDATE public."tenants"
      SET "status" = 'active', "pending_delete_at" = NULL
      WHERE "id" = selected_tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'installation tenant disappeared under lifecycle lock'
          USING ERRCODE = '40001';
      END IF;
      UPDATE public."stripe_installations" AS updated
      SET "status" = 'active', "deauthorized_at" = NULL
      WHERE "id" = selected_installation_id
      RETURNING updated."status" INTO selected_status;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'installation disappeared under lifecycle lock'
          USING ERRCODE = '40001';
      END IF;
      RETURN QUERY
        SELECT selected_tenant_id, selected_installation_id, selected_status;
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
      CONTINUE;
    END;
    RETURN QUERY
      SELECT selected_tenant_id, selected_installation_id, selected_status;
    RETURN;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION
  "refunddesk_provision_installation"(VARCHAR, "stripe_environment")
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION "refunddesk_provision_webhook_installation"(
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
  selected_tenant_id UUID;
  selected_installation_id UUID;
  selected_status "installation_status";
  last_event_id VARCHAR;
  last_event_created_at TIMESTAMPTZ;
  should_apply BOOLEAN;
  lifecycle_attempts INTEGER := 0;
BEGIN
  IF requested_environment = 'live' THEN
    RAISE EXCEPTION 'live installation provisioning is disabled for the pilot'
      USING ERRCODE = '42501';
  END IF;
  IF requested_account_id !~ '^acct_[A-Za-z0-9]+$'
     OR requested_event_id !~ '^evt_[A-Za-z0-9]+$'
     OR requested_event_created_at IS NULL THEN
    RAISE EXCEPTION 'invalid Stripe identifier' USING ERRCODE = '22023';
  END IF;

  LOOP
    lifecycle_attempts := lifecycle_attempts + 1;
    IF lifecycle_attempts > 8 THEN
      RAISE EXCEPTION 'installation lifecycle contention'
        USING ERRCODE = '40001';
    END IF;
    selected_tenant_id := NULL;
    selected_installation_id := NULL;
    SELECT
      installation."tenant_id",
      installation."id"
    INTO
      selected_tenant_id,
      selected_installation_id
    FROM public."stripe_installations" AS installation
    WHERE installation."stripe_account_id" = requested_account_id
      AND installation."environment" = requested_environment;

    IF selected_tenant_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(selected_tenant_id::TEXT, 0)
      );
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
        AND installation."tenant_id" = selected_tenant_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'installation identity changed under lifecycle lock'
          USING ERRCODE = '40001';
      END IF;

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
        IF NOT FOUND THEN
          RAISE EXCEPTION 'installation tenant disappeared under lifecycle lock'
            USING ERRCODE = '40001';
        END IF;
        UPDATE public."stripe_installations" AS updated
        SET
          "status" = 'active',
          "deauthorized_at" = NULL,
          "last_lifecycle_event_id" = requested_event_id,
          "last_lifecycle_event_type" = 'account.application.authorized',
          "last_lifecycle_event_created_at" = requested_event_created_at
        WHERE "id" = selected_installation_id
        RETURNING updated."status" INTO selected_status;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'installation disappeared under lifecycle lock'
            USING ERRCODE = '40001';
        END IF;
      END IF;
      RETURN QUERY
        SELECT selected_tenant_id, selected_installation_id, selected_status, should_apply;
      RETURN;
    END IF;

    RAISE EXCEPTION 'webhook authorization requires existing installation context'
      USING ERRCODE = '55000';
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION
  "refunddesk_provision_webhook_installation"(
    VARCHAR,
    "stripe_environment",
    VARCHAR,
    TIMESTAMPTZ
  )
  FROM PUBLIC;

CREATE FUNCTION "refunddesk_list_due_tenant_purges"(requested_limit INTEGER)
RETURNS TABLE (
  "tenant_id" UUID,
  "blocker_reason" VARCHAR,
  "overdue_seconds" BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF requested_limit IS NULL OR requested_limit < 1 OR requested_limit > 100 THEN
    RAISE EXCEPTION 'invalid tenant purge candidate limit' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT
      due_tenant."id",
      due_tenant."blocker_reason",
      due_tenant."overdue_seconds"
    FROM (
      SELECT
        tenant."id",
        tenant."pending_delete_at",
        FLOOR(
          EXTRACT(
            EPOCH FROM statement_timestamp() - tenant."pending_delete_at"
          )
        )::BIGINT AS overdue_seconds,
        CASE
          WHEN tenant."legal_hold_at" IS NOT NULL
            THEN 'legal_hold'
          WHEN NOT EXISTS (
            SELECT 1
            FROM public."stripe_installations" AS installation
            WHERE installation."tenant_id" = tenant."id"
          )
            THEN 'installation_missing'
          WHEN EXISTS (
            SELECT 1
            FROM public."stripe_installations" AS installation
            WHERE installation."tenant_id" = tenant."id"
              AND (
                installation."environment" NOT IN ('test', 'sandbox')
                OR installation."status" <> 'deauthorized'
                OR installation."deauthorized_at" IS NULL
              )
          )
            THEN 'installation_state'
          WHEN tenant."pending_delete_at" > (
            SELECT MAX(installation."deauthorized_at") + INTERVAL '30 days'
            FROM public."stripe_installations" AS installation
            WHERE installation."tenant_id" = tenant."id"
          )
            THEN 'deadline_invalid'
          WHEN EXISTS (
            SELECT 1
            FROM public."refund_requests" AS request
            WHERE request."tenant_id" = tenant."id"
              AND (
                request."payment_guard_released_at" IS NULL
                OR request."workflow_status" IN ('executing', 'reconciliation_required')
                OR request."effect_state" = 'possible'
                OR (
                  request."effect_state" = 'identified'
                  AND request."workflow_status" <> 'succeeded'
                )
              )
          )
            THEN 'financial_state'
          WHEN EXISTS (
            SELECT 1
            FROM public."refund_execution_attempts" AS attempt
            WHERE attempt."tenant_id" = tenant."id"
              AND attempt."state" = 'started'
          )
            THEN 'execution_attempt'
          WHEN EXISTS (
            SELECT 1
            FROM public."refund_correlation_candidates" AS candidate
            WHERE candidate."tenant_id" = tenant."id"
              AND candidate."state" IN ('pending', 'conflict')
          )
            THEN 'correlation_state'
          WHEN EXISTS (
            SELECT 1
            FROM public."webhook_receipts" AS receipt
            WHERE receipt."tenant_id" = tenant."id"
              AND receipt."event_type" LIKE 'refund.%'
              AND receipt."status" <> 'processed'
          )
            THEN 'webhook_state'
          WHEN EXISTS (
            SELECT 1
            FROM public."reconciliation_checkpoints" AS checkpoint
            WHERE checkpoint."tenant_id" = tenant."id"
              AND checkpoint."page_in_progress"
          )
            THEN 'checkpoint_state'
          ELSE NULL
        END::VARCHAR AS blocker_reason
      FROM public."tenants" AS tenant
      WHERE tenant."status" = 'pending_deletion'
        AND tenant."pending_delete_at" IS NOT NULL
        AND tenant."pending_delete_at" <= statement_timestamp()
    ) AS due_tenant
    ORDER BY
      (due_tenant."blocker_reason" IS NOT NULL),
      due_tenant."pending_delete_at",
      due_tenant."id"
    LIMIT requested_limit;
END
$$;

REVOKE ALL ON FUNCTION "refunddesk_list_due_tenant_purges"(INTEGER) FROM PUBLIC;

-- The guarded wrapper deletes external-alert audit records only after complete
-- uninstall and queue validation. The raw primitive then retains every other
-- unresolved-financial-state guard. The certificate trigger accounts for the
-- wrapper-owned deletions and the pg-boss rows in the same atomic transaction.
CREATE OR REPLACE FUNCTION "refunddesk_include_attestation_purge_count"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purged_attestations TEXT := NULLIF(
    current_setting(
      'refunddesk.purged_approval_attestation_count',
      true
    ),
    ''
  );
  purged_external_alerts TEXT := NULLIF(
    current_setting(
      'refunddesk.purged_external_alert_count',
      true
    ),
    ''
  );
  purged_queued_jobs TEXT := NULLIF(
    current_setting(
      'refunddesk.purged_queued_job_count',
      true
    ),
    ''
  );
BEGIN
  IF NEW."process_version" = 'db-purge-v1'
     AND purged_attestations IS NOT NULL THEN
    NEW."deleted_counts" := NEW."deleted_counts" || jsonb_build_object(
      'approval_attestations',
      purged_attestations::BIGINT
    );
    IF purged_external_alerts IS NOT NULL
       AND purged_queued_jobs IS NOT NULL THEN
      NEW."deleted_counts" := NEW."deleted_counts" || jsonb_build_object(
        'external_alerts',
        purged_external_alerts::BIGINT,
        'queued_jobs',
        purged_queued_jobs::BIGINT
      );
      NEW."process_version" := 'db-purge-v3';
    ELSE
      NEW."process_version" := 'db-purge-v2';
    END IF;
    PERFORM set_config(
      'refunddesk.purged_approval_attestation_count',
      '',
      true
    );
    PERFORM set_config(
      'refunddesk.purged_external_alert_count',
      '',
      true
    );
    PERFORM set_config(
      'refunddesk.purged_queued_job_count',
      '',
      true
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "refunddesk_purge_test_sandbox_tenant"(
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
  tenant_found BOOLEAN := false;
  installation_found BOOLEAN := false;
  pgboss_schema_version INTEGER;
  matched_pgboss_jobs INTEGER := 0;
  active_pgboss_jobs INTEGER := 0;
  unsafe_pgboss_jobs INTEGER := 0;
  dependent_pgboss_jobs INTEGER := 0;
  deleted_pgboss_jobs INTEGER := 0;
  remaining_pgboss_jobs INTEGER := 0;
  deleted_external_alerts INTEGER := 0;
  previous_tenant_context TEXT := current_setting('app.tenant_id', true);
  previous_purge_context TEXT := current_setting('refunddesk.purge_tenant_id', true);
BEGIN
  IF requested_tenant_id IS NULL
     OR requested_tenant_pseudonym IS NULL
     OR requested_tenant_pseudonym !~ '^v1\.[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'invalid test/sandbox tenant purge request' USING ERRCODE = '22023';
  END IF;

  -- Every lifecycle/effect boundary takes installation rows before the tenant
  -- row. The tenant advisory lock serializes install/deauth/purge, while this
  -- row-lock order avoids deadlocking a financial effect that already holds
  -- its installation row.
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_tenant_id::TEXT, 0));
  PERFORM installation."id"
  FROM public."stripe_installations" AS installation
  WHERE installation."tenant_id" = requested_tenant_id
  ORDER BY installation."id"
  FOR UPDATE;
  installation_found := FOUND;

  PERFORM 1
  FROM public."tenants" AS tenant
  WHERE tenant."id" = requested_tenant_id
  FOR UPDATE;
  tenant_found := FOUND;

  IF NOT tenant_found THEN
    -- A committed purge may lose its response. Delegate the absent-tenant
    -- replay to the primitive that returns only the exact completed
    -- pseudonymous certificate, or raises P0002 when none exists.
    RETURN QUERY
      SELECT *
      FROM public."refunddesk_purge_tenant"(
        requested_tenant_id,
        requested_tenant_pseudonym
      );
    RETURN;
  END IF;

  IF NOT installation_found OR EXISTS (
    SELECT 1
    FROM public."stripe_installations" AS installation
    WHERE installation."tenant_id" = requested_tenant_id
      AND installation."environment" NOT IN ('test', 'sandbox')
  ) THEN
    RAISE EXCEPTION 'automatic purge is restricted to test/sandbox installations'
      USING ERRCODE = '55000';
  END IF;

  -- Prisma migrations run before the pg-boss owner migration on both fresh
  -- installs and releases. Keep these references dynamic so this function can
  -- be created before the pgboss schema exists, then fail closed at execution
  -- unless the exact pinned pg-boss schema is ready.
  IF to_regclass('pgboss.version') IS NULL
     OR to_regclass('pgboss.job') IS NULL
     OR to_regclass('pgboss.job_dependency') IS NULL THEN
    RAISE EXCEPTION 'pg-boss retention boundary is unavailable'
      USING ERRCODE = 'RDQ01';
  END IF;

  EXECUTE
    'SELECT CASE WHEN count(*) = 1 THEN min(version) ELSE NULL END
       FROM pgboss.version'
  INTO pgboss_schema_version;
  IF pgboss_schema_version IS DISTINCT FROM 37 THEN
    RAISE EXCEPTION 'pg-boss retention boundary has an unsupported schema version'
      USING ERRCODE = 'RDQ01';
  END IF;

  -- pg-boss writes directly to its common/queue partitions. LOCK without ONLY
  -- covers the partition tree, preventing a concurrent claim, retry, completion
  -- or enqueue from invalidating the final zero-count proof.
  EXECUTE
    'LOCK TABLE pgboss.job, pgboss.job_dependency
       IN SHARE ROW EXCLUSIVE MODE';

  EXECUTE $pgboss$
    WITH matched_job AS MATERIALIZED (
      SELECT
        job."id",
        job."name",
        job."data",
        job."state"::TEXT AS state,
        job."blocking",
        job."pending_dependencies",
        job."source_name",
        job."source_id"
      FROM pgboss.job AS job
      WHERE job."data"->>'tenant_id' = $1::TEXT
         OR EXISTS (
           SELECT 1
           FROM public."refund_requests" AS request
           WHERE request."tenant_id" = $1
             AND request."id"::TEXT = job."data"->>'request_id'
         )
         OR EXISTS (
           SELECT 1
           FROM public."stripe_installations" AS installation
           WHERE installation."tenant_id" = $1
             AND installation."id"::TEXT = job."data"->>'installation_id'
         )
         OR EXISTS (
           SELECT 1
           FROM public."webhook_receipts" AS receipt
           WHERE receipt."tenant_id" = $1
             AND receipt."id"::TEXT = job."data"->>'receipt_id'
         )
      ORDER BY job."name", job."id"
      FOR UPDATE OF job
    )
    SELECT
      count(*)::INTEGER,
      count(*) FILTER (
        WHERE matched_job.state = 'active'
      )::INTEGER,
      count(*) FILTER (
        WHERE matched_job."blocking"
           OR matched_job."pending_dependencies" <> 0
           OR matched_job."source_name" IS NOT NULL
           OR matched_job."source_id" IS NOT NULL
           OR CASE matched_job."name"
             WHEN 'refunddesk_refund_execute' THEN NOT (
               jsonb_typeof(matched_job."data") = 'object'
               AND matched_job."data"->>'tenant_id' = $1::TEXT
               AND EXISTS (
                 SELECT 1
                 FROM public."refund_requests" AS request
                 WHERE request."tenant_id" = $1
                   AND request."id"::TEXT =
                     matched_job."data"->>'request_id'
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM jsonb_object_keys(
                   CASE
                     WHEN jsonb_typeof(matched_job."data") = 'object'
                       THEN matched_job."data"
                     ELSE '{}'::JSONB
                   END
                 ) AS payload_key(name)
                 WHERE payload_key.name NOT IN ('tenant_id', 'request_id')
               )
             )
             WHEN 'refunddesk_webhook_process' THEN NOT (
               jsonb_typeof(matched_job."data") = 'object'
               AND matched_job."data"->>'tenant_id' = $1::TEXT
               AND EXISTS (
                 SELECT 1
                 FROM public."stripe_installations" AS installation
                 WHERE installation."tenant_id" = $1
                   AND installation."id"::TEXT =
                     matched_job."data"->>'installation_id'
               )
               AND EXISTS (
                 SELECT 1
                 FROM public."webhook_receipts" AS receipt
                 WHERE receipt."tenant_id" = $1
                   AND receipt."installation_id"::TEXT =
                     matched_job."data"->>'installation_id'
                   AND receipt."id"::TEXT =
                     matched_job."data"->>'receipt_id'
               )
             )
             ELSE true
           END
      )::INTEGER
    FROM matched_job
  $pgboss$
  INTO matched_pgboss_jobs, active_pgboss_jobs, unsafe_pgboss_jobs
  USING requested_tenant_id;

  IF matched_pgboss_jobs > 0 THEN
    EXECUTE $pgboss$
      WITH matched_job AS MATERIALIZED (
        SELECT job."id", job."name"
        FROM pgboss.job AS job
        WHERE job."data"->>'tenant_id' = $1::TEXT
           OR EXISTS (
             SELECT 1
             FROM public."refund_requests" AS request
             WHERE request."tenant_id" = $1
               AND request."id"::TEXT = job."data"->>'request_id'
           )
           OR EXISTS (
             SELECT 1
             FROM public."stripe_installations" AS installation
             WHERE installation."tenant_id" = $1
               AND installation."id"::TEXT =
                 job."data"->>'installation_id'
           )
           OR EXISTS (
             SELECT 1
             FROM public."webhook_receipts" AS receipt
             WHERE receipt."tenant_id" = $1
               AND receipt."id"::TEXT = job."data"->>'receipt_id'
           )
      )
      SELECT count(*)::INTEGER
      FROM pgboss.job_dependency AS dependency
      INNER JOIN matched_job
        ON (
          dependency."child_name" = matched_job."name"
          AND dependency."child_id" = matched_job."id"
        )
        OR (
          dependency."parent_name" = matched_job."name"
          AND dependency."parent_id" = matched_job."id"
        )
    $pgboss$
    INTO dependent_pgboss_jobs
    USING requested_tenant_id;
  END IF;

  IF active_pgboss_jobs <> 0
     OR unsafe_pgboss_jobs <> 0
     OR dependent_pgboss_jobs <> 0 THEN
    RAISE EXCEPTION 'tenant purge is blocked by active or unsupported pg-boss work'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE $pgboss$
    DELETE FROM pgboss.job AS job
    WHERE job."data"->>'tenant_id' = $1::TEXT
       OR EXISTS (
         SELECT 1
         FROM public."refund_requests" AS request
         WHERE request."tenant_id" = $1
           AND request."id"::TEXT = job."data"->>'request_id'
       )
       OR EXISTS (
         SELECT 1
         FROM public."stripe_installations" AS installation
         WHERE installation."tenant_id" = $1
           AND installation."id"::TEXT = job."data"->>'installation_id'
       )
       OR EXISTS (
         SELECT 1
         FROM public."webhook_receipts" AS receipt
         WHERE receipt."tenant_id" = $1
           AND receipt."id"::TEXT = job."data"->>'receipt_id'
       )
  $pgboss$
  USING requested_tenant_id;
  GET DIAGNOSTICS deleted_pgboss_jobs = ROW_COUNT;

  EXECUTE $pgboss$
    SELECT count(*)::INTEGER
    FROM pgboss.job AS job
    WHERE job."data"->>'tenant_id' = $1::TEXT
       OR EXISTS (
         SELECT 1
         FROM public."refund_requests" AS request
         WHERE request."tenant_id" = $1
           AND request."id"::TEXT = job."data"->>'request_id'
       )
       OR EXISTS (
         SELECT 1
         FROM public."stripe_installations" AS installation
         WHERE installation."tenant_id" = $1
           AND installation."id"::TEXT = job."data"->>'installation_id'
       )
       OR EXISTS (
         SELECT 1
         FROM public."webhook_receipts" AS receipt
         WHERE receipt."tenant_id" = $1
           AND receipt."id"::TEXT = job."data"->>'receipt_id'
       )
  $pgboss$
  INTO remaining_pgboss_jobs
  USING requested_tenant_id;

  IF deleted_pgboss_jobs <> matched_pgboss_jobs
     OR remaining_pgboss_jobs <> 0 THEN
    RAISE EXCEPTION 'pg-boss tenant cleanup did not reach zero'
      USING ERRCODE = 'RDQ02';
  END IF;

  PERFORM set_config('app.tenant_id', requested_tenant_id::TEXT, true);
  PERFORM set_config(
    'refunddesk.purge_tenant_id',
    requested_tenant_id::TEXT,
    true
  );
  DELETE FROM public."external_refund_alerts"
  WHERE "tenant_id" = requested_tenant_id;
  GET DIAGNOSTICS deleted_external_alerts = ROW_COUNT;
  PERFORM set_config(
    'refunddesk.purged_external_alert_count',
    deleted_external_alerts::TEXT,
    true
  );
  PERFORM set_config(
    'refunddesk.purged_queued_job_count',
    deleted_pgboss_jobs::TEXT,
    true
  );

  RETURN QUERY
    SELECT *
    FROM public."refunddesk_purge_tenant"(
      requested_tenant_id,
      requested_tenant_pseudonym
    );
  PERFORM set_config(
    'refunddesk.purge_tenant_id',
    COALESCE(previous_purge_context, ''),
    true
  );
  PERFORM set_config(
    'app.tenant_id',
    COALESCE(previous_tenant_context, ''),
    true
  );
  RETURN;
END
$$;

REVOKE ALL ON FUNCTION
  "refunddesk_purge_test_sandbox_tenant"(UUID, VARCHAR)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'refunddesk_maintenance'
  ) THEN
    EXECUTE
      'REVOKE EXECUTE ON FUNCTION public.refunddesk_purge_tenant(UUID, VARCHAR) FROM refunddesk_maintenance';
  END IF;
END
$$;
