/**
 * Render a tool-result `error` value into a single human-readable string.
 *
 * A tool failure may carry `error` as a plain string or as the structured
 * `{ code, message }` envelope introduced for stable machine-readable codes
 * (e.g. `device_already_stopped`). Every layer that logs, records, or surfaces
 * such an error must flatten it the same way, or the object stringifies to
 * `[object Object]` (issue #1678 follow-up).
 *
 * Returns `undefined` when `error` carries no usable text, so callers can apply
 * their own fallback (a top-level `message`, a tool-named default, `String(err)`).
 */
export function formatStructuredToolError(error: unknown): string | undefined {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const details = error as Record<string, unknown>;
    const code = typeof details.code === "string" ? details.code : undefined;
    const message = typeof details.message === "string" ? details.message : undefined;
    if (code && message) {
      return `${code}: ${message}`;
    }
    if (message) {
      return message;
    }
  }
  return undefined;
}
