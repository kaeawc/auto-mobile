/**
 * Runtime-checked unwrap for values a test has already arranged to exist. Throws a descriptive
 * error instead of asserting the type, so a broken fixture fails at the unwrap and not later.
 */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be defined`);
  }
  return value;
}
