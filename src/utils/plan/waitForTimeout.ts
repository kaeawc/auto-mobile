/** Interpret an already-unwrapped tool payload; numeric awaitTimeout is an input, not a verdict. */
export function waitForTimeoutError(payload: unknown, tool: string): string | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("awaitTimeout" in payload) ||
    payload.awaitTimeout !== true
  ) {
    return null;
  }
  const duration =
    "awaitDuration" in payload && typeof payload.awaitDuration === "number"
      ? payload.awaitDuration
      : "unknown";
  return `${tool} waitFor timed out after ${duration}ms`;
}
