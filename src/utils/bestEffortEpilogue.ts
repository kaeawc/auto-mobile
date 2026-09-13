/**
 * Best-effort post-action epilogues (issue #6868).
 *
 * A tool call has ONE primary effect — write this text, put this app in the
 * foreground — and may run a cleanup step afterwards that is nice to have but
 * not what the caller asked for (dismissing the keyboard, for example). When
 * that epilogue fails the primary effect has still landed, so promoting the
 * whole call to an error is wrong twice over: a client that treats an error as
 * fatal aborts a task that is fine, and the only way to learn the real outcome
 * is to string-match English prose.
 *
 * `isError` means "the thing you asked for did not happen". A failed epilogue is
 * not that — it degrades to a `warnings[]` entry on a successful result.
 */

/** Any action result that can carry best-effort epilogue warnings. */
export interface EpilogueWarnable {
  warnings?: string[];
}

/**
 * Attach `warning` to `result`, or return `result` untouched when the epilogue
 * succeeded (a null/undefined/empty warning).
 *
 * Never mutates its argument and never touches `success`: the caller owns the
 * primary outcome, this only appends to the advisory list.
 */
export function withEpilogueWarning<T extends EpilogueWarnable>(
  result: T,
  warning: string | null | undefined,
): T {
  if (!warning) {
    return result;
  }
  return { ...result, warnings: [...(result.warnings ?? []), warning] };
}
