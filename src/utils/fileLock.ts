import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isProcessRunning as defaultIsProcessRunning } from "../daemon/daemonFiles";

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
   * {@link releaseExclusiveLock}'s `parseInt` are unaffected.
   */
  ownerToken?: string;
}

/**
 * One non-blocking attempt to acquire the exclusive lock. Returns true if the
 * lock is now held by `pid`, false if another live holder owns it.
 */
export function tryAcquireExclusiveLock(
  lockFilePath: string,
  options: ExclusiveLockOptions = {}
): boolean {
  const pid = options.pid ?? process.pid;
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const reclaimOwnPid = options.reclaimOwnPid ?? false;
  const ownerToken = options.ownerToken;

  if (writeExclusiveLockFile(lockFilePath, pid, ownerToken)) {
    return true;
  }

  let content: string;
  try {
    content = readFileSync(lockFilePath, "utf-8").trim();
  } catch {
    // File vanished between the failed `wx` create and this read — another opener
    // is churning it; treat as contended and let the caller retry.
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
  // second (see `writeExclusiveLockFile`). `parseInt` reads only the PID.
  const [pidLine, tokenLine] = content.split("\n", 2);
  const ownerPid = Number.parseInt(pidLine, 10);
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
  } catch {
    // Another opener reclaimed it first (path already moved/gone); retry.
    return false;
  }
  try {
    unlinkSync(reclaimMarker);
  } catch {
    // Best-effort: the consumed stale marker is ours to remove.
  }
  return writeExclusiveLockFile(lockFilePath, pid, ownerToken);
}

/**
 * Release a lock owned by `pid`. Compare-and-delete: the file is removed only if
 * it still holds `pid`, so a reclaim race can't delete a lock that a *different*
 * opener now owns (mirrors `shouldCleanupForExpectedPid` in `daemonFiles.ts`).
 */
export function releaseExclusiveLock(lockFilePath: string, pid: number = process.pid): void {
  let content: string;
  try {
    content = readFileSync(lockFilePath, "utf-8").trim();
  } catch {
    // Already gone (never acquired, or reclaimed elsewhere) — nothing to release.
    return;
  }

  if (Number.parseInt(content, 10) !== pid) {
    // The lock is no longer ours — do not delete another opener's file.
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
function writeExclusiveLockFile(lockFilePath: string, pid: number, ownerToken?: string): boolean {
  try {
    mkdirSync(dirname(lockFilePath), { recursive: true });
    const fd = openSync(lockFilePath, "wx", 0o600);
    writeFileSync(fd, ownerToken === undefined ? String(pid) : `${pid}\n${ownerToken}`);
    closeSync(fd);
    return true;
  } catch {
    // Expected: `wx` (O_EXCL) throws EEXIST when another opener already holds the
    // lock. The caller treats false as "contended" and retries.
    return false;
  }
}
