import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { isProcessRunning as defaultIsProcessRunning } from "../daemon/daemonFiles";
import { logger } from "./logger";
import { toActionableError } from "../models/ActionableError";

/**
 * The canonical cross-process file-lock primitive (issue #2794).
 *
 * A lock file created atomically via `O_CREAT | O_EXCL` (`wx`) holding the owner
 * PID. Two racers can't both win — the atomic create decides — and a lock left
 * by a dead holder is reclaimed on the next attempt via a PID liveness check.
 *
 * Both `DaemonManager` (start/stop coordination, non-blocking single attempt)
 * and the DB `FileMigrationLock` (bounded busy-wait) build on this so there is
 * "one canonical primitive per concern" rather than two copies of the subtle
 * `O_EXCL` + stale-reclaim logic.
 */
export interface ExclusiveLockOptions {
  /** Owner PID written into the lock file (defaults to `process.pid`). */
  pid?: number;
  /** Liveness check for stale-lock reclaim (defaults to `process.kill(pid, 0)`). */
  isProcessRunning?: (pid: number) => boolean;
  /**
   * When true, a lock file already owned by *this* PID is treated as a stale
   * leak from a crashed prior incarnation and reclaimed, instead of "held".
   *
   * Safe only where the caller guarantees a single in-process acquirer (e.g. the
   * migration singleton, whose `runMigrations` never runs twice concurrently in
   * one process): it removes the deterministic timeout hang that would otherwise
   * occur when a supervisor restarts a crashed process and the OS recycles the
   * same PID. The daemon coordinator leaves this `false` so a same-PID probe from
   * another manager instance still reads as held.
   *
   * See {@link ownerToken}: pairing this with a per-process-instance token narrows
   * the reclaim to a *genuine* recycled-PID leak, so an in-process reopen while
   * this process still holds the lock waits instead of stealing it (#2947).
   */
  reclaimOwnPid?: boolean;

  /**
   * A per-process-instance token written on the second line of the lock file
   * (below the PID). It disambiguates the two ways a same-PID lock can arise under
   * {@link reclaimOwnPid}:
   *
   * - token matches ours → a *live in-flight* acquire by THIS same process
   *   instance (e.g. an in-process same-path reopen while the prior generation's
   *   migration still holds the lock). Read as held so the reopen WAITS rather
   *   than stealing it and running two migrators on one DB file (#2947).
   * - token differs (or is absent, a pre-token incarnation) → a genuine stale leak
   *   from a crashed prior incarnation whose PID the OS recycled. Reclaimed, exactly
   *   as before (#2794 behavior preserved).
   *
   * Only consulted for the same-PID reclaim decision. When omitted, `reclaimOwnPid`
   * behaves exactly as it did before this token existed (any same-PID lock is a
   * reclaimable leak). The PID stays on the first line so daemon liveness reads and
   * {@link releaseExclusiveLock}'s PID compare are unaffected. The positional format
   * ("line 1 = bare integer PID, line 2 = token") is centralized in the
   * {@link formatLockContent} / {@link parseLockContent} pair, so a future third
   * field is added there and cannot silently move the PID off line 1 (#3006).
   *
   * Must be a NON-EMPTY, single-line, whitespace-free token (a UUID satisfies
   * this). The lock body is `trim()`-ed on read to tolerate a trailing newline, so
   * a token with surrounding whitespace — or an empty string — would be mangled or
   * dropped and read back as "no token". The only caller passes a `randomUUID()`
   * from `IdGenerator`; a future caller must uphold the same shape.
   */
  ownerToken?: string;

  /**
   * Optional single-line metadata written on line 3 of the lock file. It is
   * opaque to this primitive; callers that need to preserve arbitrary data must
   * encode it before passing it here.
   */
  metadata?: string;
}

/**
 * The parsed contents of a lock file.
 *
 * The on-disk format is positional and MUST keep line 1 a bare integer PID so
 * `parseInt`-based readers (daemon liveness, and historically {@link releaseExclusiveLock})
 * stay correct; the per-process token, when present, is line 2. This helper pair
 * ({@link formatLockContent} / {@link parseLockContent}) is the single place that
 * encodes that contract, so any future third field is added HERE — line 1 stays a
 * bare integer by construction rather than by every call site remembering to
 * (issue #3006, follow-up 2).
 */
export interface LockContent {
  /** Owner PID (line 1). `NaN` when the PID line is not a readable integer. */
  pid: number;
  /** Per-process-instance token (line 2), or `undefined` when absent. */
  token: string | undefined;
  /** Optional caller-defined metadata (line 3). */
  metadata?: string;
}

/**
 * Serialize a lock file body. PID on line 1 (bare integer, always), token on an
 * optional line 2, and opaque metadata on an optional line 3. Inverse of
 * {@link parseLockContent}. Centralizes the positional format so a future field
 * can't silently move the PID off line 1 (#3006).
 */
export function formatLockContent(pid: number, ownerToken?: string, metadata?: string): string {
  if (metadata === undefined) {
    return ownerToken === undefined ? String(pid) : `${pid}\n${ownerToken}`;
  }
  return `${pid}\n${ownerToken ?? ""}\n${metadata}`;
}

/**
 * Parse a lock file body (already `trim()`-ed by the caller) into its PID and
 * optional token and metadata. Line 1 is parsed as an integer PID (`NaN` when
 * unreadable); line 2, if present, is the token; line 3 is caller-defined
 * metadata. Inverse of {@link formatLockContent} (#3006).
 */
export function parseLockContent(content: string): LockContent {
  const [pidLine, tokenLine, metadataLine] = content.split("\n", 3);
  const rawPid = Number.parseInt(pidLine, 10);
  // A PID <= 0 is never a real single-process owner: `process.kill(0, 0)`
  // signals the current process group and `process.kill(-1, 0)` signals
  // every process this user can signal, so both "succeed" as a liveness
  // check without naming a real process. Treat a corrupt/stale lock
  // containing one the same as an unreadable PID (NaN) rather than ever
  // reporting it as a live owner or surfacing it in a `kill` suggestion
  // (issue #6260).
  const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : NaN;
  const parsed: LockContent = {
    pid,
    token: tokenLine || undefined,
  };
  if (metadataLine) {
    parsed.metadata = metadataLine;
  }
  return parsed;
}

/**
 * One non-blocking attempt to acquire the exclusive lock. Returns true if the
 * lock is now held by `pid`, false if another live holder owns it.
 */
export function tryAcquireExclusiveLock(
  lockFilePath: string,
  options: ExclusiveLockOptions = {},
): boolean {
  const pid = options.pid ?? process.pid;
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const reclaimOwnPid = options.reclaimOwnPid ?? false;
  const ownerToken = options.ownerToken;
  const metadata = options.metadata;

  if (writeExclusiveLockFile(lockFilePath, pid, ownerToken, metadata)) {
    return true;
  }

  let content: string;
  try {
    content = readFileSync(lockFilePath, "utf-8").trim();
  } catch (error) {
    // The lock file vanished between the failed `wx` create and this read (holder
    // released it); treat as still-held so the caller retries rather than racing.
    logger.debug(`src/utils/fileLock.ts fallback failed: ${error}`, error);
    return false;
  }

  if (content.length === 0) {
    // A writer created the file but hasn't written its PID yet; treat as actively
    // held to avoid stealing a lock mid-write.
    //
    // Known limitation: a crash in the microsecond window between the `wx` create
    // and the PID write leaves an empty file that is never reclaimable. This is
    // astronomically rare (the create+write is a single synchronous burst) and is
    // shared with the daemon lock; tracked as a follow-up, not fixed here.
    return false;
  }

  // The PID is the first line; a per-process-instance token (if any) is the
  // second (see `writeExclusiveLockFile`). `parseLockContent` reads only the PID
  // off line 1, keeping the positional contract in one place (#3006).
  const { pid: ownerPid, token: tokenLine } = parseLockContent(content);
  if (Number.isNaN(ownerPid)) {
    // Unreadable PID — a writer may still be filling it in; treat as held.
    return false;
  }

  // A same-PID lock is a reclaimable stale leak ONLY when its owner token differs
  // from ours (a crashed prior incarnation whose PID the OS recycled) or is absent
  // (a pre-token incarnation). A MATCHING token means this same process instance
  // still holds it live — an in-process reopen must wait, not steal it (#2947).
  // With no token supplied the pre-token semantics stand: any same-PID lock leaks.
  const isOwnStaleLeak =
    reclaimOwnPid &&
    ownerPid === pid &&
    (ownerToken === undefined || (tokenLine ?? "") !== ownerToken);
  if (isProcessRunning(ownerPid) && !isOwnStaleLeak) {
    return false;
  }

  // Dead holder (or our own recycled PID under reclaimOwnPid) — reclaim it.
  //
  // Do NOT unlink-by-path here: two openers can both read the same stale PID, and
  // an unlink-by-path would let each delete the OTHER's freshly recreated lock and
  // then both `wx`-create — so both would "own" it and enter migrateToLatest()
  // concurrently, reintroducing the PRIMARY KEY collision this lock prevents.
  //
  // Instead claim the stale file with an atomic rename to a per-PID marker: only
  // the opener whose rename succeeds consumed that exact stale instance; a racing
  // opener's rename throws (the path is already gone) and it retries, finding the
  // fresh lock held. The final `wx` create is still the arbiter against a third
  // opener that creates a brand-new lock in the gap.
  const reclaimMarker = `${lockFilePath}.${pid}.reclaim`;
  try {
    renameSync(lockFilePath, reclaimMarker);
  } catch (error) {
    // A racing opener already renamed/claimed this exact stale lock instance (see
    // comment above); losing the race means we don't own it, so report not-acquired.
    logger.debug(`src/utils/fileLock.ts fallback failed: ${error}`, error);
    return false;
  }
  try {
    unlinkSync(reclaimMarker);
  } catch {
    // Best-effort: the consumed stale marker is ours to remove.
  }
  return writeExclusiveLockFile(lockFilePath, pid, ownerToken, metadata);
}

/**
 * Read the PID recorded in an exclusive lock file without attempting to
 * acquire or reclaim it (issue #6260). Used by callers that need to name the
 * process currently holding a lease in an actionable error — e.g. "another
 * AutoMobile process (PID N) owns this resource" — rather than a bare
 * boolean. Returns `undefined` when the file is missing, unreadable, or
 * names a process that is not (or no longer) running.
 */
export function readLockOwnerPid(
  lockFilePath: string,
  isProcessRunning: (pid: number) => boolean = defaultIsProcessRunning,
): number | undefined {
  let content: string;
  try {
    content = readFileSync(lockFilePath, "utf-8").trim();
  } catch (error) {
    logger.debug(`src/utils/fileLock.ts readLockOwnerPid: lock unreadable: ${error}`, error);
    return undefined;
  }
  const { pid } = parseLockContent(content);
  if (Number.isNaN(pid) || !isProcessRunning(pid)) {
    return undefined;
  }
  return pid;
}

/**
 * Release a lock owned by `pid`. Compare-and-delete: the file is removed only if
 * it still holds `pid`, so a reclaim race can't delete a lock that a *different*
 * opener now owns (mirrors `shouldCleanupForExpectedPid` in `daemonFiles.ts`).
 *
 * When `ownerToken` is supplied, release is incarnation-aware: it unlinks only if
 * BOTH the PID and the token match, so it is symmetric with the reclaim decision
 * in {@link tryAcquireExclusiveLock}. This closes the recycled-PID window where a
 * process could delete a lock now held by a *different* incarnation that recycled
 * the same PID and wrote a different token (issue #3006, follow-up 1). A lock file
 * with NO token line (a pre-token incarnation) is treated as ours on a PID match,
 * preserving the legacy PID-only behavior. The daemon caller now passes its
 * per-instance startup-lock owner token too (issue #5904), so its release is
 * incarnation-aware rather than PID-only.
 */
export function releaseExclusiveLock(
  lockFilePath: string,
  pid: number = process.pid,
  ownerToken?: string,
): void {
  let content: string;
  try {
    content = readFileSync(lockFilePath, "utf-8").trim();
  } catch (error) {
    // Lock file is already gone (released concurrently, or never existed); there is
    // nothing left to release, so returning is a no-op, not a failure.
    logger.debug(`src/utils/fileLock.ts fallback failed: ${error}`, error);
    return;
  }

  const { pid: ownerPid, token: lockToken } = parseLockContent(content);
  if (ownerPid !== pid) {
    // The lock is no longer ours — do not delete another opener's file.
    return;
  }
  // Incarnation check: with a token supplied, a same-PID lock bearing a DIFFERENT
  // token belongs to another incarnation that recycled our PID — leave it. A lock
  // with no token line predates tokens and is treated as ours (PID match).
  if (ownerToken !== undefined && lockToken !== undefined && lockToken !== ownerToken) {
    return;
  }

  try {
    unlinkSync(lockFilePath);
  } catch {
    // Best-effort: removed concurrently between the read and here.
  }
}

/**
 * Atomically create the lock file with `pid` via `O_CREAT | O_EXCL` (`wx`).
 * Returns true on success, false if the file already exists. When `ownerToken` is
 * given it is written on a second line below the PID so a same-PID reader can tell
 * this process instance's live lock from a recycled-PID leak (#2947); the PID
 * stays on the first line so `parseInt`-based readers are unaffected.
 */
function writeExclusiveLockFile(
  lockFilePath: string,
  pid: number,
  ownerToken?: string,
  metadata?: string,
): boolean {
  try {
    mkdirSync(dirname(lockFilePath), { recursive: true });
    const fd = openSync(lockFilePath, "wx", 0o600);
    writeFileSync(fd, formatLockContent(pid, ownerToken, metadata));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Expected contention: `wx` create fails when the lock file already exists
      // (another holder got there first). false tells the caller to fall through to
      // the read/reclaim path.
      logger.debug(`src/utils/fileLock.ts: lock already held at ${lockFilePath}: ${error}`);
      return false;
    }
    // A genuine IO error (EACCES/ENOSPC/EROFS/ENOTDIR/…) is NOT lock contention.
    // Returning false would disguise a permissions/disk failure as "another process
    // holds the lock" and let the caller busy-wait to a misleading migration-lock
    // timeout. Surface the real cause instead (#3623).
    throw toActionableError(error, `Failed to create exclusive lock file at ${lockFilePath}`);
  }
}
