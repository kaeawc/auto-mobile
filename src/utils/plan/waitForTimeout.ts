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

const MAX_TIMEOUT_CANDIDATES = 5;
const CANDIDATE_FIELDS = ["text", "content-desc", "resource-id", "class", "bounds"] as const;
const SCALAR_FIELDS = ["awaitDuration", "timedOut", "matched", "polls", "waitMs"] as const;

/**
 * Bounded record of what a timed-out `waitFor` reported: how long it waited and
 * the last-seen near matches (capped, identifying fields only). The condition
 * that was waited for is the step's own `params.waitFor`. Returns undefined when
 * the payload is not a timeout or carries none of these fields.
 */
export function waitForTimeoutDiagnostics(payload: unknown): Record<string, unknown> | undefined {
  if (waitForTimeoutError(payload, "") === null) {
    return undefined;
  }
  const raw = payload as Record<string, unknown>;
  const diagnostics: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    const value = raw[key];
    if (typeof value === "number" || typeof value === "boolean") {
      diagnostics[key] = value;
    }
  }
  if (typeof raw.timeoutReason === "string") {
    diagnostics.timeoutReason = raw.timeoutReason;
  }
  if (Array.isArray(raw.candidates) && raw.candidates.length > 0) {
    diagnostics.candidates = raw.candidates
      .slice(0, MAX_TIMEOUT_CANDIDATES)
      .map(candidateDigest)
      .filter((digest) => Object.keys(digest).length > 0);
    diagnostics.candidateCount = raw.candidates.length;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function candidateDigest(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== "object") {
    return {};
  }
  const element = candidate as Record<string, unknown>;
  return Object.fromEntries(
    CANDIDATE_FIELDS.filter((field) => element[field] !== undefined).map((field) => [
      field,
      element[field],
    ]),
  );
}
