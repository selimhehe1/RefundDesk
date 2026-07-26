-- RenameForeignKey
ALTER TABLE "external_refund_alerts" RENAME CONSTRAINT "external_refund_alerts_acknowledger_tenant_fkey" TO "external_refund_alerts_acknowledged_by_user_id_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "external_refund_alerts" RENAME CONSTRAINT "external_refund_alerts_installation_tenant_environment_fkey" TO "external_refund_alerts_installation_id_tenant_id_environme_fkey";

-- RenameForeignKey
ALTER TABLE "external_refund_alerts" RENAME CONSTRAINT "external_refund_alerts_overlap_request_tenant_fkey" TO "external_refund_alerts_overlapped_request_id_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "refund_correlation_candidates" RENAME CONSTRAINT "refund_candidates_installation_id_tenant_id_fkey" TO "refund_correlation_candidates_installation_id_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "refund_correlation_candidates" RENAME CONSTRAINT "refund_candidates_request_id_tenant_id_fkey" TO "refund_correlation_candidates_request_id_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "refund_correlation_candidates" RENAME CONSTRAINT "refund_candidates_tenant_id_fkey" TO "refund_correlation_candidates_tenant_id_fkey";
