import { applicationKeyMaterialStateIsValid, type PlatformConfig } from "@refunddesk/config";
import { FieldEncryptionKeyring } from "@refunddesk/domain";

function requiredFieldKey(key: Buffer | undefined): Buffer {
  if (key === undefined) {
    throw new Error("FIELD_ENCRYPTION_KEY_ROTATION_STATE_INVALID");
  }
  return key;
}

export function createFieldEncryptionKeyring(keys: PlatformConfig["keys"]): FieldEncryptionKeyring {
  if (
    !applicationKeyMaterialStateIsValid({
      activeVersion: keys.activeFieldVersion,
      rotationState: keys.fieldRotationState,
      v1Present: keys.fieldV1 !== undefined,
      v2Present: keys.fieldV2 !== undefined,
    })
  ) {
    throw new Error("FIELD_ENCRYPTION_KEY_ROTATION_STATE_INVALID");
  }

  if (keys.fieldRotationState === "legacy") {
    return new FieldEncryptionKeyring({
      active: {
        version: "v1",
        key: requiredFieldKey(keys.fieldV1),
      },
    });
  }
  if (keys.fieldRotationState === "staged" || keys.fieldRotationState === "rollback") {
    return new FieldEncryptionKeyring({
      active: {
        version: "v1",
        key: requiredFieldKey(keys.fieldV1),
      },
      decryptOnly: {
        v2: requiredFieldKey(keys.fieldV2),
      },
    });
  }
  if (keys.fieldRotationState === "active") {
    return new FieldEncryptionKeyring({
      active: {
        version: "v2",
        key: requiredFieldKey(keys.fieldV2),
      },
      decryptOnly: {
        v1: requiredFieldKey(keys.fieldV1),
      },
    });
  }
  return new FieldEncryptionKeyring({
    active: {
      version: "v2",
      key: requiredFieldKey(keys.fieldV2),
    },
  });
}
