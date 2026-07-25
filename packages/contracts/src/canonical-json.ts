export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function isCanonicalArray(value: CanonicalJsonValue): value is readonly CanonicalJsonValue[] {
  return Array.isArray(value);
}

function normalize(value: CanonicalJsonValue): CanonicalJsonValue {
  if (isCanonicalArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value !== null && typeof value === "object") {
    const normalized: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      const item = value[key];
      if (item === undefined) {
        throw new TypeError("Canonical JSON does not support undefined values");
      }
      normalized[key] = normalize(item);
    }
    return normalized;
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON does not support non-finite numbers");
  }

  return value;
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return JSON.stringify(normalize(value));
}
