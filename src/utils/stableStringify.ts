/**
 * Order-insensitive JSON serialization.
 *
 * `JSON.stringify` preserves key *insertion* order, so two semantically
 * identical objects written with their keys in a different order serialize
 * differently. Anything that uses a serialized object as a cache key or an
 * identity signature must sort keys first, or it silently misses.
 *
 * Array element order is meaningful and is preserved.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value;
}
