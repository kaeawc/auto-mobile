/**
 * Interpret an already-unwrapped tool payload: did the tool report that it did NOT perform the
 * requested state change, without calling that a failure (#10175)?
 *
 * A direct tool call may answer a refusal with an ordinary, non-error result (`setPosture` returns
 * `{ status: "unsupported", message }` so a client can read the capability limit). Inside a plan
 * that is not enough: the step asked for a state change that never happened, and later steps would
 * run against the unchanged device. So a plan step (and a criticalSection sub-step) whose payload
 * has one of the shapes below fails with the tool's own message, exactly like a `success: false`
 * result. Direct callers keep their result shape; only the plan verdict reads this.
 *
 * Only shapes that unambiguously mean "not performed" belong here. Results that already carry
 * `success: false`, throw, or are idempotent no-ops (`skipped` because the state already holds)
 * are verdicts the executors handle on their own.
 *
 * Returns the error text, or null when the payload does not say the change was not performed.
 */
export function stepNotPerformedError(payload: unknown, tool: string): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.status !== "unsupported") {
    return null;
  }
  const message = typeof record.message === "string" ? record.message.trim() : "";
  return message.length > 0 ? message : `${tool} is not supported here; nothing was changed`;
}
