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
import { logger } from "../utils/logger";

export type DatabaseFailureKind = "transient" | "permanent";

const TRANSIENT_PATTERNS: RegExp[] = [
  /sqlite_busy/i,
  /database is locked/i,
  /database table is locked/i,
  /\bebusy\b/i,
  /\beagain\b/i,
  /resource (?:busy|temporarily unavailable)/i,
];

/**
 * `String(value)` throws for a null-prototype object (no inherited
 * `.toString`). Classification must stay total over `unknown` input, so an
 * unstringifiable value falls back to an empty haystack — it matches no
 * `TRANSIENT_PATTERNS` and is classified `permanent`, the same fail-safe
 * default as any other unrecognized failure.
 */
function stringifyErrorLike(error: unknown): string {
  try {
    return String(error ?? "");
  } catch (stringifyError) {
    // Null-prototype (or otherwise non-stringifiable) thrown values are rare
    // but not errors in themselves; falling back to "" is expected here.
    logger.debug(`Could not stringify error-like value for classification: ${stringifyError}`);
    return "";
  }
}

export function classifyDatabaseFailure(error: unknown): DatabaseFailureKind {
  const message = error instanceof Error ? error.message : stringifyErrorLike(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const haystack = typeof code === "string" ? `${code} ${message}` : message;

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return "transient";
    }
  }

  return "permanent";
}

/**
 * Classification of a single query error at the dialect boundary, used to decide
 * whether a bounded, backoff-driven retry is worthwhile:
 *
 * - `retryable`: a locking/contention error that a later attempt may clear on
 *   its own (`SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`, `SQLITE_LOCKED`, …). Safe to
 *   retry outside an open transaction — the WAL single-writer topology means a
 *   `busy_timeout` expiry or checkpoint contention is transient.
 * - `constraint`: a data/logic conflict (`SQLITE_CONSTRAINT*` — unique, foreign
 *   key, NOT NULL). Retrying is pointless and would mask the caller's bug; the
 *   error must surface immediately so callers (upserts, `ON CONFLICT`) can react.
 * - `fatal`: anything else — corruption, misuse, a closed handle, or a
 *   non-SQLite error. Surface immediately.
 */
export type SqliteErrorAction = "retryable" | "constraint" | "fatal";

// SQLite primary-result-code prefixes (`SQLITE_BUSY_SNAPSHOT`,
// `SQLITE_CONSTRAINT_UNIQUE`, …) all begin with the primary code, so a prefix
// match covers extended codes without enumerating every variant.
const RETRYABLE_CODE_PREFIXES = ["SQLITE_BUSY", "SQLITE_LOCKED"] as const;
const CONSTRAINT_CODE_PREFIX = "SQLITE_CONSTRAINT";

/**
 * Read the structured `SqliteError.code` reachable by identity from the thrown
 * error's `.cause` (the contract established in #2793 / PR #2873) and classify
 * it. Walks exactly one level of `.cause` — the dialect wraps the raw
 * `SqliteError` in a single `new Error(msg, { cause })` — and also inspects the
 * error itself so a bare `SqliteError` classifies too.
 *
 * Falls back to the message-pattern `classifyDatabaseFailure` ONLY when no
 * structured code is present, so callers prefer identity over `.message`
 * scraping (acceptance criterion for #2874) while still catching legacy shapes.
 */
export function classifySqliteError(error: unknown): SqliteErrorAction {
  const code = extractSqliteCode(error);
  if (code !== undefined) {
    if (RETRYABLE_CODE_PREFIXES.some(prefix => code.startsWith(prefix))) {
      return "retryable";
    }
    if (code.startsWith(CONSTRAINT_CODE_PREFIX)) {
      return "constraint";
    }
    return "fatal";
  }

  // No structured code: fall back to the message-based classifier. A transient
  // (busy/locked) message is the only thing worth retrying; everything else is
  // fatal here (constraint conflicts do not appear in TRANSIENT_PATTERNS).
  return classifyDatabaseFailure(error) === "transient" ? "retryable" : "fatal";
}

/**
 * Extract a `SqliteError.code` string from an error or its immediate `.cause`,
 * preferring the identity-preserved cause per the #2793 contract. Returns
 * `undefined` when no string code is reachable (so the caller can fall back to
 * message matching).
 */
function extractSqliteCode(error: unknown): string | undefined {
  const direct = readStringCode(error);
  if (direct !== undefined) {
    return direct;
  }
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  return readStringCode(cause);
}

function readStringCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
