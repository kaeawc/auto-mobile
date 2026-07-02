import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isProcessRunning as defaultIsProcessRunning } from "../daemon/daemonFiles";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";

/**
 * Cross-process lock guarding {@link runMigrations}.
 *
 * Kysely's SQLite adapter provides no cross-process migration lock
 * (`acquireMigrationLock` is a no-op, `supportsTransactionalDdl === false`), so
 * two processes pointed at the same DB file — reachable only via override env
 * (`AUTOMOBILE_DB_PATH`) or `--no-proxy` alongside a daemon — can both enter
 * `migrateToLatest()` and collide on the `kysely_migration` PRIMARY KEY. This
 * lock serializes the migration run across processes so the loser waits and then
 * observes an already-migrated DB. See issue #2794.
 */
export interface MigrationLock {
  /** Acquire the lock, waiting (bounded) if another opener holds it. */
  acquire(): Promise<void>;
  /** Release the lock. Best-effort; safe to call once per successful acquire. */
  release(): Promise<void>;
}

/**
 * No-op lock for the single-opener default and in-memory test databases, where
 * no second process can share the connection. Keeps the migrator's DB-path-
 * agnostic callers unchanged.
 */
export class NoOpMigrationLock implements MigrationLock {
  async acquire(): Promise<void> {
    // Nothing to serialize: a `:memory:` DB is private to one connection and the
    // single-daemon default already serializes via the in-process mutex.
  }

  async release(): Promise<void> {
    // No lock file to remove.
  }
}

export interface FileMigrationLockOptions {
  timer?: Timer;
  /** Poll interval between acquire attempts while another opener holds the lock. */
  pollIntervalMs?: number;
  /**
   * Ceiling for the bounded busy-wait. Must sit well above a cold migration
   * runtime (30+ files, DDL + backfills) so a slow first boot does not spuriously
   * time out the waiter.
   */
  timeoutMs?: number;
  /** Injectable liveness check for stale-lock reclaim (defaults to `process.kill(pid, 0)`). */
  isProcessRunning?: (pid: number) => boolean;
  /** Owner pid written into the lock file (injectable for tests). */
  pid?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
// 60s is comfortably above a cold full-migration run on a slow/loaded disk, well
// clear of the 5s `busy_timeout` that made `BEGIN EXCLUSIVE` unsuitable here.
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * File-based cross-process migration lock keyed to the resolved DB path
 * (`${dbPath}.migrate.lock`). Reuses the daemon's atomic `O_CREAT | O_EXCL`
 * (`wx`) create + dead-PID stale reclaim primitive (see
 * `src/daemon/manager.ts` `acquireLock`), but wraps it in a bounded busy-wait so
 * a mid-migration holder is waited out rather than failed fast.
 */
export class FileMigrationLock implements MigrationLock {
  private readonly timer: Timer;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly isProcessRunning: (pid: number) => boolean;
  private readonly pid: number;

  constructor(
    private readonly lockFilePath: string,
    options: FileMigrationLockOptions = {}
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
    this.pid = options.pid ?? process.pid;
  }

  async acquire(): Promise<void> {
    const deadline = this.timer.now() + this.timeoutMs;

    // Fast path: a fresh lock (single opener) acquires on the first attempt with
    // no sleep, so the default single-process path adds no latency.
    for (;;) {
      if (this.tryAcquireOnce()) {
        return;
      }

      if (this.timer.now() >= deadline) {
        throw new ActionableError(
          `Timed out after ${this.timeoutMs}ms waiting for the database migration lock ` +
            `at ${this.lockFilePath}. Another process is likely migrating this database — ` +
            `you may be sharing one DB across worktrees/instances. Point each instance at a ` +
            `distinct database via AUTOMOBILE_DB_PATH, or stop the other opener.`
        );
      }

      await this.timer.sleep(this.pollIntervalMs);
    }
  }

  async release(): Promise<void> {
    try {
      unlinkSync(this.lockFilePath);
    } catch {
      // Best-effort: the file may already be gone (never acquired, or removed by
      // a stale-reclaim in another opener). Nothing actionable to surface.
    }
  }

  /**
   * One non-blocking acquire attempt. Returns true if the lock is now ours.
   * Mirrors `DaemonManager.acquireLock`: atomic create, else inspect the owner
   * and reclaim only if it is a dead PID.
   */
  private tryAcquireOnce(): boolean {
    if (this.writeLockFile()) {
      return true;
    }

    let content: string;
    try {
      content = readFileSync(this.lockFilePath, "utf-8").trim();
    } catch {
      // File vanished between the failed `wx` create and this read — treat as
      // still-contended and retry on the next poll.
      return false;
    }

    if (content.length === 0) {
      // Another opener created the file but has not written its PID yet; treat as
      // actively held to avoid stealing a lock mid-write.
      return false;
    }

    const ownerPid = Number.parseInt(content, 10);
    if (Number.isNaN(ownerPid)) {
      // Unreadable PID — a writer may still be filling it in; wait.
      return false;
    }

    if (this.isProcessRunning(ownerPid)) {
      return false;
    }

    // Owner is dead — reclaim the stale lock, then re-create atomically. The
    // `wx` open below ensures two openers racing on the same dead PID cannot both
    // win: the loser's `wx` throws and it falls back to waiting.
    try {
      unlinkSync(this.lockFilePath);
    } catch {
      // Someone else reclaimed it first; retry on the next poll.
      return false;
    }
    return this.writeLockFile();
  }

  /**
   * Atomically create the lock file with our PID via `O_CREAT | O_EXCL` (`wx`).
   * Returns true on success, false if the file already exists.
   */
  private writeLockFile(): boolean {
    try {
      mkdirSync(dirname(this.lockFilePath), { recursive: true });
      const fd = openSync(this.lockFilePath, "wx", 0o600);
      writeFileSync(fd, String(this.pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Default migration lock for a resolved DB file path. Keyed per-file (not
 * per-uid) because the trigger — two openers on one DB file — is per-file.
 */
export function createFileMigrationLock(dbPath: string): MigrationLock {
  const lock = new FileMigrationLock(`${dbPath}.migrate.lock`);
  logger.debug(`Migration lock keyed to ${dbPath}.migrate.lock`);
  return lock;
}
