import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertApplicationKeyRotationTransition,
  isApplicationKeyRotationState,
  type ApplicationKeyRotationSet,
} from "./key-rotation.js";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
export const LEGACY_KEY_ROTATION_ADOPTION_REVISIONS = [
  "42a1e4e65cf6e9144261a077c6956e77b368fffc",
] as const;
const legacyKeyRotationAdoptionRevisions = new Set<string>(LEGACY_KEY_ROTATION_ADOPTION_REVISIONS);

function parseState(
  value: string | undefined,
): ApplicationKeyRotationSet[keyof ApplicationKeyRotationSet] {
  if (value === undefined || !isApplicationKeyRotationState(value)) {
    throw new Error("APPLICATION_KEY_ROTATION_TRANSITION_INPUT_INVALID");
  }
  return value;
}

function parseSet(
  field: string | undefined,
  proof: string | undefined,
  approvalAttestation: string | undefined,
): ApplicationKeyRotationSet {
  return {
    approvalAttestation: parseState(approvalAttestation),
    field: parseState(field),
    proof: parseState(proof),
  };
}

export function checkApplicationKeyRotationReleaseTransition(arguments_: readonly string[]): void {
  const [
    activeRevision,
    recordedRevision,
    previousField,
    previousProof,
    previousApprovalAttestation,
    targetField,
    targetProof,
    targetApprovalAttestation,
    ...extra
  ] = arguments_;
  if (
    activeRevision === undefined ||
    recordedRevision === undefined ||
    targetField === undefined ||
    targetProof === undefined ||
    targetApprovalAttestation === undefined ||
    extra.length > 0
  ) {
    throw new Error("APPLICATION_KEY_ROTATION_TRANSITION_INPUT_INVALID");
  }

  const hasActiveRevision = activeRevision !== "none";
  const hasRecordedRevision = recordedRevision !== "none";
  if (
    (hasActiveRevision && !REVISION_PATTERN.test(activeRevision)) ||
    (hasRecordedRevision &&
      (!hasActiveRevision ||
        !REVISION_PATTERN.test(recordedRevision) ||
        activeRevision !== recordedRevision))
  ) {
    throw new Error("APPLICATION_KEY_ROTATION_REVISION_MISMATCH");
  }
  if (
    hasActiveRevision &&
    !hasRecordedRevision &&
    !legacyKeyRotationAdoptionRevisions.has(activeRevision)
  ) {
    throw new Error("APPLICATION_KEY_ROTATION_STATE_MISSING");
  }

  let previous: ApplicationKeyRotationSet | null = null;
  if (hasRecordedRevision) {
    previous = parseSet(previousField, previousProof, previousApprovalAttestation);
  } else if (
    previousField !== "none" ||
    previousProof !== "none" ||
    previousApprovalAttestation !== "none"
  ) {
    throw new Error("APPLICATION_KEY_ROTATION_TRANSITION_INPUT_INVALID");
  }

  assertApplicationKeyRotationTransition(
    previous,
    parseSet(targetField, targetProof, targetApprovalAttestation),
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    checkApplicationKeyRotationReleaseTransition(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify({ component: "application-key-rotation", status: "allowed" })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({
        code: "APPLICATION_KEY_ROTATION_TRANSITION_INVALID",
        component: "application-key-rotation",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
