import { describe, expect, it } from "vitest";

import {
  checkApplicationKeyRotationReleaseTransition,
  LEGACY_KEY_ROTATION_ADOPTION_REVISIONS,
} from "../src/check-key-rotation-transition.js";
import {
  applicationKeyMaterialStateIsValid,
  assertApplicationKeyRotationTransition,
  type ApplicationKeyRotationSet,
} from "../src/key-rotation.js";

const revisionA = "1".repeat(40);
const revisionB = "2".repeat(40);
const legacyAdoptionRevision = LEGACY_KEY_ROTATION_ADOPTION_REVISIONS[0];

function states(
  field: ApplicationKeyRotationSet["field"],
  proof = field,
  approvalAttestation = proof,
): ApplicationKeyRotationSet {
  return { approvalAttestation, field, proof };
}

describe("application key rotation contract", () => {
  it("requires exact key presence and active versions for every lifecycle state", () => {
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v1",
        rotationState: "legacy",
        v1Present: true,
        v2Present: false,
      }),
    ).toBe(true);
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v1",
        rotationState: "staged",
        v1Present: true,
        v2Present: true,
      }),
    ).toBe(true);
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v2",
        rotationState: "active",
        v1Present: true,
        v2Present: true,
      }),
    ).toBe(true);
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v1",
        rotationState: "rollback",
        v1Present: true,
        v2Present: true,
      }),
    ).toBe(true);
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v2",
        rotationState: "retired",
        v1Present: false,
        v2Present: true,
      }),
    ).toBe(true);

    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v2",
        rotationState: "retired",
        v1Present: true,
        v2Present: true,
      }),
    ).toBe(false);
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v2",
        rotationState: "active",
        v1Present: false,
        v2Present: true,
      }),
    ).toBe(false);
    expect(
      applicationKeyMaterialStateIsValid({
        activeVersion: "v1",
        rotationState: "legacy",
        v1Present: true,
        v2Present: true,
      }),
    ).toBe(false);
  });

  it("requires a successful staged release before first activation", () => {
    expect(() => assertApplicationKeyRotationTransition(null, states("active"))).toThrow(
      "APPLICATION_KEY_ROTATION_TRANSITION_INVALID",
    );
    expect(() => assertApplicationKeyRotationTransition(null, states("staged"))).not.toThrow();
    expect(() =>
      assertApplicationKeyRotationTransition(states("staged"), states("active")),
    ).not.toThrow();
  });

  it("allows controlled rollback but refuses a new retirement without automated evidence", () => {
    expect(() =>
      assertApplicationKeyRotationTransition(states("active"), states("rollback")),
    ).not.toThrow();
    expect(() =>
      assertApplicationKeyRotationTransition(states("rollback"), states("active")),
    ).not.toThrow();
    expect(() =>
      assertApplicationKeyRotationTransition(states("active"), states("retired")),
    ).toThrow("APPLICATION_KEY_RETIREMENT_EVIDENCE_UNAVAILABLE");
  });

  it("can validate an already-retired historical state without enabling a new retirement", () => {
    expect(() =>
      assertApplicationKeyRotationTransition(states("retired"), states("retired")),
    ).not.toThrow();
    expect(() =>
      assertApplicationKeyRotationTransition(states("retired"), states("rollback")),
    ).toThrow("APPLICATION_KEY_ROTATION_TRANSITION_INVALID");
    expect(() =>
      assertApplicationKeyRotationTransition(
        states("retired", "active", "active"),
        states("retired", "retired", "active"),
      ),
    ).toThrow("APPLICATION_KEY_RETIREMENT_EVIDENCE_UNAVAILABLE");
  });

  it("binds the recorded staged proof to the currently active revision", () => {
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        legacyAdoptionRevision,
        "none",
        "none",
        "none",
        "none",
        "active",
        "active",
        "active",
      ]),
    ).toThrow("APPLICATION_KEY_ROTATION_TRANSITION_INVALID");
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        legacyAdoptionRevision,
        "none",
        "none",
        "none",
        "none",
        "staged",
        "staged",
        "staged",
      ]),
    ).not.toThrow();
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        revisionA,
        revisionA,
        "staged",
        "staged",
        "staged",
        "active",
        "active",
        "active",
      ]),
    ).not.toThrow();
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        revisionA,
        revisionB,
        "staged",
        "staged",
        "staged",
        "active",
        "active",
        "active",
      ]),
    ).toThrow("APPLICATION_KEY_ROTATION_REVISION_MISMATCH");
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        "none",
        "none",
        "none",
        "none",
        "none",
        "active",
        "active",
        "active",
      ]),
    ).toThrow("APPLICATION_KEY_ROTATION_TRANSITION_INVALID");
  });

  it("fails closed if a rotation-aware active revision loses or tampers with its state", () => {
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        revisionB,
        "none",
        "none",
        "none",
        "none",
        "staged",
        "staged",
        "staged",
      ]),
    ).toThrow("APPLICATION_KEY_ROTATION_STATE_MISSING");
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        revisionB,
        revisionA,
        "retired",
        "retired",
        "retired",
        "staged",
        "staged",
        "staged",
      ]),
    ).toThrow("APPLICATION_KEY_ROTATION_REVISION_MISMATCH");
  });

  it("blocks a release-time active-to-retired transition until retirement evidence exists", () => {
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        revisionA,
        revisionA,
        "active",
        "active",
        "active",
        "retired",
        "retired",
        "retired",
      ]),
    ).toThrow("APPLICATION_KEY_RETIREMENT_EVIDENCE_UNAVAILABLE");
    expect(() =>
      checkApplicationKeyRotationReleaseTransition([
        revisionA,
        revisionA,
        "retired",
        "retired",
        "retired",
        "retired",
        "retired",
        "retired",
      ]),
    ).not.toThrow();
  });
});
