/** UTF-16 code unit order, never locale order: the same bytes on every host. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertSignable(value: unknown): void {
  if (value === undefined) {
    throw new Error("canonical JSON cannot carry undefined");
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    throw new Error("canonical JSON cannot carry NaN, Infinity or negative zero");
  }
  if (typeof value === "string" && !value.isWellFormed()) {
    throw new Error("canonical JSON cannot carry a lone surrogate");
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`canonical JSON cannot carry a ${typeof value}`);
  }
}

function sortValue(value: unknown): unknown {
  assertSignable(value);
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, item]) => {
          assertSignable(key);
          return [key, sortValue(item)];
        }),
    );
  }
  return value;
}

/**
 * JSON with every object's keys sorted: the bytes an attestation is signed and identified by.
 * Values another language would serialize differently are refused rather than guessed at
 * (undefined, NaN, Infinity, negative zero, lone surrogates), so the bytes are the same for any
 * verifier that follows docs/design-docs/ci/attestation-envelope.md.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
