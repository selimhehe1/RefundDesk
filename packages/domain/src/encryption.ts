import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DomainError } from "./errors.js";
import type { VersionedSecret } from "./refund-proof.js";

const VERSION_PATTERN = /^v[1-9]\d*$/u;

export interface FieldEncryptionKeys {
  readonly active: VersionedSecret;
  readonly decryptOnly?: Readonly<Record<string, Uint8Array>>;
}

export interface EncryptedField {
  readonly algorithm: "aes-256-gcm";
  readonly keyVersion: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export interface FieldContext {
  readonly tenantId: string;
  readonly table: string;
  readonly entityId: string;
  readonly field: string;
}

function validateFieldKey(secret: VersionedSecret): void {
  if (!VERSION_PATTERN.test(secret.version) || secret.key.byteLength !== 32) {
    throw new DomainError(
      "INVALID_ENCRYPTION_KEY",
      "AES-256-GCM keys must be exactly 32 bytes and use a vN version",
    );
  }
}

function aad(context: FieldContext): Buffer {
  if (
    context.tenantId.length === 0 ||
    context.table.length === 0 ||
    context.entityId.length === 0 ||
    context.field.length === 0
  ) {
    throw new DomainError(
      "INVALID_ENCRYPTION_KEY",
      "Tenant and field type are required as authenticated context",
    );
  }
  return Buffer.from(
    JSON.stringify([context.tenantId, context.table, context.entityId, context.field]),
    "utf8",
  );
}

export class FieldEncryptionKeyring {
  private readonly active: VersionedSecret;
  private readonly decryptionKeys: ReadonlyMap<string, Uint8Array>;

  constructor(keys: FieldEncryptionKeys) {
    validateFieldKey(keys.active);
    const decryptionKeys = new Map<string, Uint8Array>();
    decryptionKeys.set(keys.active.version, keys.active.key);
    for (const [version, key] of Object.entries(keys.decryptOnly ?? {})) {
      validateFieldKey({ version, key });
      if (version === keys.active.version) {
        throw new DomainError(
          "INVALID_ENCRYPTION_KEY",
          "The active key cannot also be decrypt-only",
        );
      }
      decryptionKeys.set(version, key);
    }
    this.active = keys.active;
    this.decryptionKeys = decryptionKeys;
  }

  encrypt(plaintext: string, context: FieldContext): EncryptedField {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.active.key, nonce);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      keyVersion: this.active.version,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authenticationTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  decrypt(encrypted: EncryptedField, context: FieldContext): string {
    if (encrypted.algorithm !== "aes-256-gcm") {
      throw new DomainError("INVALID_ENCRYPTION_KEY", "Unsupported encryption algorithm");
    }
    const key = this.decryptionKeys.get(encrypted.keyVersion);
    if (key === undefined) {
      throw new DomainError("INVALID_ENCRYPTION_KEY", "Encryption key version unavailable");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(encrypted.nonce, "base64url"),
      );
      decipher.setAAD(aad(context));
      decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new DomainError("INVALID_ENCRYPTION_KEY", "Encrypted field authentication failed");
    }
  }
}
