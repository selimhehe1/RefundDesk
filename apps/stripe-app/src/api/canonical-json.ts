export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((item) => normalize(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON does not support non-finite numbers");
  }

  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}
