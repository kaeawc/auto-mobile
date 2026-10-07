/** Return the message when an unwrapped result explicitly reports unsupported. */
export function unsupportedToolResultError(payload: unknown): string | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("status" in payload) ||
    payload.status !== "unsupported"
  ) {
    return null;
  }
  return "message" in payload && typeof payload.message === "string"
    ? payload.message
    : "Tool operation is unsupported";
}
