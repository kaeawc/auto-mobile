/** UTF-16 code unit order, never locale order: the same bytes on every host. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

/** JSON with every object's keys sorted: the bytes an attestation is signed and identified by. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
