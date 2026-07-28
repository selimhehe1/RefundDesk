import type { Client } from "pg";

export const executableApprovalAttestationCoverageSql = `
  SELECT EXISTS (
    SELECT 1
      FROM public.refund_requests AS request
      INNER JOIN public.approval_decisions AS decision
        ON decision.tenant_id = request.tenant_id
       AND decision.request_id = request.id
     WHERE request.workflow_status IN (
       'approved',
       'executing',
       'reconciliation_required'
     )
       AND decision.decision = 'approve'
       AND decision.approval_attestation_id IS NULL
  ) AS has_unattested_executable_approval
`;

export async function assertExecutableApprovalAttestationCoverage(
  client: Pick<Client, "query">,
): Promise<void> {
  const result = await client.query<{
    readonly has_unattested_executable_approval: boolean;
  }>(executableApprovalAttestationCoverageSql);
  if (result.rows[0]?.has_unattested_executable_approval !== false) {
    throw new Error("DATABASE_EXECUTABLE_APPROVAL_ATTESTATION_MISSING");
  }
}
