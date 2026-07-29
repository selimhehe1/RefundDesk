import { describe, expect, it } from "vitest";

import { FieldEncryptionKeyring } from "@refunddesk/domain";

import { createFieldEncryptionKeyring } from "../src/server/field-keyring";

const context = {
  tenantId: "5c66ba36-d4c2-444e-9186-582c8e6b0671",
  table: "refund_requests",
  entityId: "ca3872bc-01b8-4df3-b649-e81a22c31c5e",
  field: "justification",
} as const;

describe("platform field-encryption runtime keyring", () => {
  it("keeps a staged or rollback V2 key decrypt-only while V1 remains active", () => {
    const v1 = Buffer.alloc(32, 1);
    const v2 = Buffer.alloc(32, 2);
    const runtime = createFieldEncryptionKeyring({
      activeFieldVersion: "v1",
      fieldRotationState: "staged",
      fieldV1: v1,
      fieldV2: v2,
      exportV1: Buffer.alloc(32, 3),
    });
    const future = new FieldEncryptionKeyring({
      active: { version: "v2", key: v2 },
    }).encrypt("future value", context);

    expect(runtime.encrypt("current value", context).keyVersion).toBe("v1");
    expect(runtime.decrypt(future, context)).toBe("future value");
  });

  it("writes with V2 and keeps V1 available only for decryption after activation", () => {
    const v1 = Buffer.alloc(32, 1);
    const v1Runtime = new FieldEncryptionKeyring({
      active: { version: "v1", key: v1 },
    });
    const historical = v1Runtime.encrypt("historical value", context);
    const runtime = createFieldEncryptionKeyring({
      activeFieldVersion: "v2",
      fieldRotationState: "active",
      fieldV1: v1,
      fieldV2: Buffer.alloc(32, 2),
      exportV1: Buffer.alloc(32, 3),
    });
    const current = runtime.encrypt("current value", context);

    expect(current.keyVersion).toBe("v2");
    expect(runtime.decrypt(historical, context)).toBe("historical value");
    expect(() => v1Runtime.decrypt(current, context)).toThrow();
  });

  it("fails closed if V2 is selected without a V2 key", () => {
    expect(() =>
      createFieldEncryptionKeyring({
        activeFieldVersion: "v2",
        fieldRotationState: "active",
        fieldV1: Buffer.alloc(32, 1),
        exportV1: Buffer.alloc(32, 3),
      }),
    ).toThrow("FIELD_ENCRYPTION_KEY_ROTATION_STATE_INVALID");
  });

  it("removes V1 decryption authority once V1 is declared retired", () => {
    const v1 = Buffer.alloc(32, 1);
    const historical = new FieldEncryptionKeyring({
      active: { version: "v1", key: v1 },
    }).encrypt("historical value", context);
    const runtime = createFieldEncryptionKeyring({
      activeFieldVersion: "v2",
      fieldRotationState: "retired",
      fieldV2: Buffer.alloc(32, 2),
      exportV1: Buffer.alloc(32, 3),
    });

    expect(runtime.encrypt("current value", context).keyVersion).toBe("v2");
    expect(() => runtime.decrypt(historical, context)).toThrow();
  });
});
