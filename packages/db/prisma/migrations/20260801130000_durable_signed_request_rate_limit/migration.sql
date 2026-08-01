BEGIN;

CREATE TABLE "signed_request_rate_limit_buckets" (
  "scope_key" BYTEA NOT NULL,
  "theoretical_arrival_at" TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "signed_request_rate_limit_buckets_pkey" PRIMARY KEY ("scope_key"),
  CONSTRAINT "signed_request_rate_limit_buckets_scope_key_check"
    CHECK (octet_length("scope_key") = 32),
  CONSTRAINT "signed_request_rate_limit_buckets_clock_check"
    CHECK ("theoretical_arrival_at" > "last_seen_at")
);

CREATE INDEX "signed_request_rate_limit_buckets_last_seen_idx"
  ON "signed_request_rate_limit_buckets"("last_seen_at");

CREATE FUNCTION "refunddesk_consume_signed_request_rate_limit"(
  requested_account_id VARCHAR,
  requested_environment "stripe_environment",
  requested_class VARCHAR
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after_seconds INTEGER
)
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '500ms'
AS $$
DECLARE
  computed_scope_key BYTEA;
  observed_at TIMESTAMPTZ;
  effective_now TIMESTAMPTZ;
  bucket_tat TIMESTAMPTZ;
  bucket_last_seen TIMESTAMPTZ;
  bucket_found BOOLEAN;
  token_interval INTERVAL;
  burst_capacity INTEGER;
  eligibility_at TIMESTAMPTZ;
  retry_seconds NUMERIC;
  scope_count BIGINT;
BEGIN
  IF requested_account_id IS NULL
     OR octet_length(requested_account_id) > 255
     OR requested_account_id !~ '^acct_[A-Za-z0-9]+$'
     OR requested_environment IS NULL
     OR requested_environment NOT IN ('test', 'sandbox')
     OR requested_class IS NULL
     OR requested_class NOT IN ('mutation', 'read') THEN
    RAISE EXCEPTION 'invalid signed request rate-limit scope'
      USING ERRCODE = '22023';
  END IF;

  IF requested_class = 'mutation' THEN
    burst_capacity := 30;
    token_interval := INTERVAL '2 seconds';
  ELSE
    burst_capacity := 60;
    token_interval := INTERVAL '1 second';
  END IF;

  computed_scope_key := public.digest(
    pg_catalog.convert_to(
      requested_account_id || ':' || requested_environment::TEXT || ':' || requested_class,
      'UTF8'
    ),
    'sha256'
  );
  SELECT
    bucket."theoretical_arrival_at",
    bucket."last_seen_at"
  INTO bucket_tat, bucket_last_seen
  FROM public."signed_request_rate_limit_buckets" AS bucket
  WHERE bucket."scope_key" = computed_scope_key
  FOR UPDATE;
  bucket_found := FOUND;

  IF NOT bucket_found THEN
    -- Only first use of a scope takes the global cardinality lock. Existing
    -- scopes contend solely on their own row.
    PERFORM pg_catalog.pg_advisory_xact_lock(1836216163, 20260801);

    SELECT
      bucket."theoretical_arrival_at",
      bucket."last_seen_at"
    INTO bucket_tat, bucket_last_seen
    FROM public."signed_request_rate_limit_buckets" AS bucket
    WHERE bucket."scope_key" = computed_scope_key
    FOR UPDATE;
    bucket_found := FOUND;
    observed_at := pg_catalog.clock_timestamp();

    IF NOT bucket_found THEN
      WITH stale_bucket AS (
        SELECT bucket."scope_key"
        FROM public."signed_request_rate_limit_buckets" AS bucket
        WHERE bucket."last_seen_at" <= observed_at - INTERVAL '10 minutes'
          AND bucket."theoretical_arrival_at" <= observed_at
        ORDER BY bucket."last_seen_at", bucket."scope_key"
        LIMIT 256
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM public."signed_request_rate_limit_buckets" AS bucket
      USING stale_bucket
      WHERE bucket."scope_key" = stale_bucket."scope_key";

      SELECT count(*)
      INTO scope_count
      FROM public."signed_request_rate_limit_buckets";

      IF scope_count >= 256 THEN
        RAISE EXCEPTION 'signed request rate-limit scope capacity exceeded'
          USING ERRCODE = '54000';
      END IF;

      INSERT INTO public."signed_request_rate_limit_buckets" (
        "scope_key",
        "theoretical_arrival_at",
        "last_seen_at"
      ) VALUES (
        computed_scope_key,
        observed_at + token_interval,
        observed_at
      );

      allowed := TRUE;
      retry_after_seconds := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF observed_at IS NULL THEN
    -- Capture shared database time only after acquiring the scope row lock.
    observed_at := pg_catalog.clock_timestamp();
  END IF;

  -- PostgreSQL wall time is shared by every web process. Pin a backwards
  -- adjustment to the last value observed for this scope so it cannot mint
  -- capacity or violate the persisted clock invariant.
  effective_now := GREATEST(observed_at, bucket_last_seen);
  eligibility_at := bucket_tat - ((burst_capacity - 1) * token_interval);

  IF effective_now >= eligibility_at THEN
    UPDATE public."signed_request_rate_limit_buckets" AS bucket
    SET
      "theoretical_arrival_at" = GREATEST(bucket_tat, effective_now) + token_interval,
      "last_seen_at" = effective_now
    WHERE bucket."scope_key" = computed_scope_key;

    allowed := TRUE;
    retry_after_seconds := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public."signed_request_rate_limit_buckets" AS bucket
  SET "last_seen_at" = effective_now
  WHERE bucket."scope_key" = computed_scope_key;

  retry_seconds := CEIL(EXTRACT(EPOCH FROM (eligibility_at - effective_now)));
  IF retry_seconds < 1 OR retry_seconds > 2147483647 THEN
    RAISE EXCEPTION 'invalid signed request rate-limit retry interval'
      USING ERRCODE = '22003';
  END IF;

  allowed := FALSE;
  retry_after_seconds := retry_seconds::INTEGER;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION "refunddesk_consume_signed_request_rate_limit"(
  VARCHAR,
  "stripe_environment",
  VARCHAR
) FROM PUBLIC;

COMMIT;
