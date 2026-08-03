import type { PilotAccountAdmission, PilotEnvironment } from "./pilot-ports";

export type AdmittedAccount = {
  readonly accountId: string;
  readonly environment: PilotEnvironment;
};

function key(accountId: string, environment: PilotEnvironment): string {
  return `${environment}:${accountId}`;
}

/**
 * Admits exactly the accounts this deployment is configured to serve (ADR 0020).
 *
 * The set is closed and built at startup: an account that is not configured is refused
 * before an installation is resolved or provisioned, rather than being refused later by
 * the credential resolver. An empty configuration admits nothing, which is the
 * fail-closed direction.
 */
export class ConfiguredAccountAdmission implements PilotAccountAdmission {
  private readonly admitted: ReadonlySet<string>;

  constructor(accounts: readonly AdmittedAccount[]) {
    this.admitted = new Set(accounts.map((account) => key(account.accountId, account.environment)));
  }

  isAdmitted(input: {
    readonly accountId: string;
    readonly environment: PilotEnvironment;
  }): boolean {
    return this.admitted.has(key(input.accountId, input.environment));
  }
}
