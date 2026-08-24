export const SQLITE_MAX_BOUND_PARAMETERS = 999;

export function chunkBySqliteParameterLimit<T>(
  values: readonly T[],
  fixedParameterCount = 0,
  maxBoundParameters = SQLITE_MAX_BOUND_PARAMETERS,
): T[][] {
  const chunkSize = maxBoundParameters - fixedParameterCount;
  if (chunkSize < 1) {
    throw new Error(
      `SQLite batch query has ${fixedParameterCount} fixed parameters, exceeding ` +
        `${maxBoundParameters} available bound parameters`,
    );
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

export function appendToBucket<K, V>(buckets: Map<K, V[]>, key: K, value: V): void {
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.push(value);
    return;
  }
  buckets.set(key, [value]);
}
