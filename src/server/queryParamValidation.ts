export interface IntegerParamOptions {
  min?: number;
  max?: number;
}

export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function optionalInteger(
  value: string | undefined,
  label: string,
  options: IntegerParamOptions = {},
): number | undefined {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  const parsed = Number(normalized);
  const min = options.min ?? 0;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    (options.max !== undefined && parsed > options.max)
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

export function optionalEnum<T extends string>(
  value: string | undefined,
  label: string,
  allowed: readonly T[],
): T | undefined {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (!allowed.includes(normalized as T)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized as T;
}

export function optionalBoolean(value: string | undefined, label: string): boolean | undefined {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`Invalid ${label}: ${value}`);
}

export function queryParamsToRecord(query: string): Record<string, string> {
  const params = new URLSearchParams(query);
  // Null-prototype map: a `{}` here inherits `Object.prototype`, so a parameter named
  // `constructor`/`toString`/`__proto__`/... would hit an inherited member and be
  // rejected as a duplicate on its first occurrence (issue #4187).
  const entries: Record<string, string> = Object.create(null);
  for (const [key, value] of params.entries()) {
    if (key in entries) {
      throw new Error(`Duplicate query parameter: ${key}`);
    }
    entries[key] = value;
  }
  return entries;
}
