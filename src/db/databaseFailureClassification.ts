/**
 * Classification of a database bring-up / migration failure.
 *
 * - `transient`: expected to clear on its own within seconds (a locked/busy file,
 *   EBUSY/EAGAIN contention from another tool briefly holding the sqlite file). A
 *   fast restart is the right response — the next attempt may well succeed.
 * - `permanent`: does NOT clear without external intervention and reproduces on
 *   every respawn (corrupt/malformed DB, a migration that always throws, or a
 *   full disk — ENOSPC needs a human to free space). The daemon must back off to
 *   avoid a restart hot-loop (issue #2784).
 *
 * Defaults to `permanent` for unrecognized failures: treating an unknown failure
 * as permanent means it gets backoff protection, which is the fail-safe choice
 * against pinning CPU in a hot loop.
 */
export type DatabaseFailureKind = "transient" | "permanent";

const TRANSIENT_PATTERNS: RegExp[] = [
  /sqlite_busy/i,
  /database is locked/i,
  /database table is locked/i,
  /\bebusy\b/i,
  /\beagain\b/i,
  /resource (?:busy|temporarily unavailable)/i,
];

export function classifyDatabaseFailure(error: unknown): DatabaseFailureKind {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const haystack = typeof code === "string" ? `${code} ${message}` : message;

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return "transient";
    }
  }

  return "permanent";
}
