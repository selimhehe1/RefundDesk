-- PostgreSQL requires newly added enum values to commit before they are used
-- by constraints or functions. Keep this migration separate from the contract.
BEGIN;

ALTER TYPE "webhook_endpoint" ADD VALUE IF NOT EXISTS 'account_test';
ALTER TYPE "webhook_endpoint" ADD VALUE IF NOT EXISTS 'account_sandbox';

COMMIT;
