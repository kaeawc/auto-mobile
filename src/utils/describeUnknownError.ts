/**
 * Produces a single-line string for logging `unknown` errors (including non-Error throws
 * and empty objects that stringify to `{}`).
 */
export function describeUnknownError(value: unknown): string {
  if (value instanceof Error) {
    const base = [value.name, value.message].filter(Boolean).join(": ");
    const stack = value.stack?.split("\n").slice(0, 3).join(" ← ");
    const cause =
      "cause" in value && value.cause !== undefined
        ? describeUnknownError(value.cause as unknown)
        : "";
    return [base || "Error", stack, cause ? `cause=${cause}` : ""].filter(Boolean).join(" | ");
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) {
      return `${Object.prototype.toString.call(value)} (no enumerable keys)`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}
