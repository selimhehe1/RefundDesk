import { applicationKeyMaterialStateIsValid, type WorkerConfig } from "@refunddesk/config";
import { ApprovalAttestationKeyring, RefundProofKeyring } from "@refunddesk/domain";

function requiredApplicationKey(key: Buffer | undefined, code: string): Buffer {
  if (key === undefined) {
    throw new Error(code);
  }
  return key;
}

export function createRefundProofKeyring(keys: WorkerConfig["keys"]): RefundProofKeyring {
  if (
    !applicationKeyMaterialStateIsValid({
      activeVersion: keys.activeProofVersion,
      rotationState: keys.proofRotationState,
      v1Present: keys.proofV1 !== undefined,
      v2Present: keys.proofV2 !== undefined,
    })
  ) {
    throw new Error("PROOF_HMAC_KEY_ROTATION_STATE_INVALID");
  }

  if (keys.proofRotationState === "legacy") {
    return new RefundProofKeyring({
      active: {
        version: "v1",
        key: requiredApplicationKey(keys.proofV1, "PROOF_HMAC_KEY_ROTATION_STATE_INVALID"),
      },
    });
  }
  if (keys.proofRotationState === "staged" || keys.proofRotationState === "rollback") {
    return new RefundProofKeyring({
      active: {
        version: "v1",
        key: requiredApplicationKey(keys.proofV1, "PROOF_HMAC_KEY_ROTATION_STATE_INVALID"),
      },
      verificationOnly: {
        v2: requiredApplicationKey(keys.proofV2, "PROOF_HMAC_KEY_ROTATION_STATE_INVALID"),
      },
    });
  }
  if (keys.proofRotationState === "active") {
    return new RefundProofKeyring({
      active: {
        version: "v2",
        key: requiredApplicationKey(keys.proofV2, "PROOF_HMAC_KEY_ROTATION_STATE_INVALID"),
      },
      verificationOnly: {
        v1: requiredApplicationKey(keys.proofV1, "PROOF_HMAC_KEY_ROTATION_STATE_INVALID"),
      },
    });
  }
  return new RefundProofKeyring({
    active: {
      version: "v2",
      key: requiredApplicationKey(keys.proofV2, "PROOF_HMAC_KEY_ROTATION_STATE_INVALID"),
    },
  });
}

export function createApprovalAttestationKeyring(
  keys: WorkerConfig["keys"],
): ApprovalAttestationKeyring {
  if (
    !applicationKeyMaterialStateIsValid({
      activeVersion: keys.activeApprovalAttestationVersion,
      rotationState: keys.approvalAttestationRotationState,
      v1Present: keys.approvalAttestationV1 !== undefined,
      v2Present: keys.approvalAttestationV2 !== undefined,
    })
  ) {
    throw new Error("APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID");
  }

  if (keys.approvalAttestationRotationState === "legacy") {
    return new ApprovalAttestationKeyring({
      active: {
        version: "v1",
        key: requiredApplicationKey(
          keys.approvalAttestationV1,
          "APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID",
        ),
      },
    });
  }
  if (
    keys.approvalAttestationRotationState === "staged" ||
    keys.approvalAttestationRotationState === "rollback"
  ) {
    return new ApprovalAttestationKeyring({
      active: {
        version: "v1",
        key: requiredApplicationKey(
          keys.approvalAttestationV1,
          "APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID",
        ),
      },
      verificationOnly: {
        v2: requiredApplicationKey(
          keys.approvalAttestationV2,
          "APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID",
        ),
      },
    });
  }
  if (keys.approvalAttestationRotationState === "active") {
    return new ApprovalAttestationKeyring({
      active: {
        version: "v2",
        key: requiredApplicationKey(
          keys.approvalAttestationV2,
          "APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID",
        ),
      },
      verificationOnly: {
        v1: requiredApplicationKey(
          keys.approvalAttestationV1,
          "APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID",
        ),
      },
    });
  }
  return new ApprovalAttestationKeyring({
    active: {
      version: "v2",
      key: requiredApplicationKey(
        keys.approvalAttestationV2,
        "APPROVAL_ATTESTATION_KEY_ROTATION_STATE_INVALID",
      ),
    },
  });
}
