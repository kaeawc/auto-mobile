import { tryOrElse } from "./tryOrElse";

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
    return tryOrElse(
      () => JSON.stringify(value),
      () => Object.prototype.toString.call(value),
    );
  }
  return String(value);
}

/** Extracts a single-line message from an unknown thrown value (message-only; no stack/cause). */
export function errorMessage(value: unknown): string {
  // Formatting failures must not escape the caller's error handler; logging here could recurse.
  return tryOrElse(
    () => {
      if (value instanceof Error) {
        return value.message;
      }
      return String(value);
    },
    // A hostile Symbol.toStringTag getter can also throw; keep error formatting non-throwing.
    () =>
      tryOrElse(
        () => Object.prototype.toString.call(value),
        () => "Unknown error",
      ),
  );
}
