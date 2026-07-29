export const APPLICATION_KEY_ROTATION_STATES = [
  "legacy",
  "staged",
  "active",
  "rollback",
  "retired",
] as const;

export type ApplicationKeyRotationState = (typeof APPLICATION_KEY_ROTATION_STATES)[number];
export type ApplicationKeyVersion = "v1" | "v2";

export interface ApplicationKeyRotationSet {
  readonly approvalAttestation: ApplicationKeyRotationState;
  readonly field: ApplicationKeyRotationState;
  readonly proof: ApplicationKeyRotationState;
}

export interface ApplicationKeyMaterialState {
  readonly activeVersion: ApplicationKeyVersion;
  readonly rotationState: ApplicationKeyRotationState;
  readonly v1Present: boolean;
  readonly v2Present: boolean;
}

export function isApplicationKeyRotationState(value: string): value is ApplicationKeyRotationState {
  return (APPLICATION_KEY_ROTATION_STATES as readonly string[]).includes(value);
}

export function applicationKeyMaterialStateIsValid(state: ApplicationKeyMaterialState): boolean {
  switch (state.rotationState) {
    case "legacy":
      return state.activeVersion === "v1" && state.v1Present && !state.v2Present;
    case "staged":
    case "rollback":
      return state.activeVersion === "v1" && state.v1Present && state.v2Present;
    case "active":
      return state.activeVersion === "v2" && state.v1Present && state.v2Present;
    case "retired":
      return state.activeVersion === "v2" && !state.v1Present && state.v2Present;
  }
}

const ALLOWED_INITIAL_STATES = new Set<ApplicationKeyRotationState>(["legacy", "staged"]);
const ALLOWED_TRANSITIONS: Readonly<
  Record<ApplicationKeyRotationState, ReadonlySet<ApplicationKeyRotationState>>
> = {
  legacy: new Set(["legacy", "staged"]),
  staged: new Set(["legacy", "staged", "active"]),
  active: new Set(["active", "rollback"]),
  rollback: new Set(["active", "rollback"]),
  // `retired` remains loadable and stable for a previously evidenced historical state. This cycle
  // cannot create that state because it has no automated database-dependency and backup-retirement
  // proof, so no other state is allowed to transition into it.
  retired: new Set(["retired"]),
};

export function assertApplicationKeyRotationTransition(
  previous: ApplicationKeyRotationSet | null,
  target: ApplicationKeyRotationSet,
): void {
  for (const family of ["field", "proof", "approvalAttestation"] as const) {
    const targetState = target[family];
    if (targetState === "retired" && previous?.[family] !== "retired") {
      throw new Error("APPLICATION_KEY_RETIREMENT_EVIDENCE_UNAVAILABLE");
    }
    const allowed =
      previous === null ? ALLOWED_INITIAL_STATES : ALLOWED_TRANSITIONS[previous[family]];
    if (!allowed.has(targetState)) {
      throw new Error("APPLICATION_KEY_ROTATION_TRANSITION_INVALID");
    }
  }
}
