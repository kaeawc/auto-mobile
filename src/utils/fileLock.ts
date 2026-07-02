import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
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
   */
  reclaimOwnPid?: boolean;
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

  if (writeExclusiveLockFile(lockFilePath, pid)) {
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

  const ownerPid = Number.parseInt(content, 10);
  if (Number.isNaN(ownerPid)) {
    // Unreadable PID — a writer may still be filling it in; treat as held.
    return false;
  }

  const isOwnStaleLeak = reclaimOwnPid && ownerPid === pid;
  if (isProcessRunning(ownerPid) && !isOwnStaleLeak) {
    return false;
  }

  // Dead holder (or our own recycled PID under reclaimOwnPid) — reclaim it, then
  // re-create atomically. The `wx` open below is the arbiter: two openers racing
  // on the same dead PID can't both win — the loser's create throws and it waits.
  try {
    unlinkSync(lockFilePath);
  } catch {
    // Someone else reclaimed it first; retry on the next attempt.
    return false;
  }
  return writeExclusiveLockFile(lockFilePath, pid);
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
 * Returns true on success, false if the file already exists.
 */
function writeExclusiveLockFile(lockFilePath: string, pid: number): boolean {
  try {
    mkdirSync(dirname(lockFilePath), { recursive: true });
    const fd = openSync(lockFilePath, "wx", 0o600);
    writeFileSync(fd, String(pid));
    closeSync(fd);
    return true;
  } catch {
    // Expected: `wx` (O_EXCL) throws EEXIST when another opener already holds the
    // lock. The caller treats false as "contended" and retries.
    return false;
  }
}
