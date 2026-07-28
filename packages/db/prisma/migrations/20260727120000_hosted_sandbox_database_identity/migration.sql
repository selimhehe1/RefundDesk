CREATE TABLE "refunddesk_database_identity" (
  "singleton" BOOLEAN PRIMARY KEY DEFAULT TRUE,
  "identity_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "release_nonce" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schema_contract_version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refunddesk_database_identity_singleton_check" CHECK ("singleton"),
  CONSTRAINT "refunddesk_database_identity_identity_key" UNIQUE ("identity_id"),
  CONSTRAINT "refunddesk_database_identity_schema_contract_check"
    CHECK ("schema_contract_version" = 1)
);

INSERT INTO "refunddesk_database_identity" ("singleton")
VALUES (TRUE);

REVOKE ALL PRIVILEGES ON "refunddesk_database_identity" FROM PUBLIC;
