import { existsSync, realpathSync } from "fs";
import { basename, dirname, join } from "path";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../utils/fileLock";
import { defaultIdGenerator } from "../utils/IdGenerator";

/**
 * A per-process-instance nonce written into every migration lock this process
 * takes. Generated ONCE at module load (so every generation within one process
 * shares it), unique per process start (a crashed prior incarnation, even after
 * PID recycling, had a different one). This lets {@link FileMigrationLock}
 * distinguish a lock still held by a LIVE in-flight run of this process — which an
 * in-process same-path reopen must wait for — from a genuine stale leak to reclaim
 * (issue #2947). See `ownerToken` in `src/utils/fileLock.ts`.
 */
const PROCESS_MIGRATION_TOKEN = defaultIdGenerator.next();

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
 *
 * NOTE: this default provides NO cross-process protection — it is correct only
 * for `:memory:` DBs and the single-daemon path (already serialized by the
 * in-process mutex). Production DB openers must pass a {@link FileMigrationLock}
 * via {@link createFileMigrationLock}; `database.ts#startMigrations` does so.
 */
export class NoOpMigrationLock implements MigrationLock {
  async acquire(): Promise<void> {
    // Nothing to serialize.
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
  /**
   * Per-process-instance token distinguishing a lock held by a live in-flight run
   * of THIS process from a recycled-PID leak (issue #2947). Defaults to the shared
   * {@link PROCESS_MIGRATION_TOKEN} so every generation in one process agrees;
   * injectable for tests.
   */
  ownerToken?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
// 60s is comfortably above a cold full-migration run on a slow/loaded disk, well
// clear of the 5s `busy_timeout` that made `BEGIN EXCLUSIVE` unsuitable here.
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;

/**
 * File-based cross-process migration lock keyed to the resolved DB path
 * (`${dbPath}.migrate.lock`). Wraps the canonical `O_CREAT | O_EXCL` acquire +
 * dead-PID stale reclaim primitive (`src/utils/fileLock.ts`, shared with the
 * daemon lock) in a bounded busy-wait so a mid-migration holder is waited out
 * rather than failed fast.
 */
export class FileMigrationLock implements MigrationLock {
  private readonly timer: Timer;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly isProcessRunning: ((pid: number) => boolean) | undefined;
  private readonly pid: number;
  private readonly ownerToken: string;

  constructor(
    private readonly lockFilePath: string,
    options: FileMigrationLockOptions = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    // Clamp to >= 1ms: a 0ms poll would hammer the filesystem as fast as the
    // macrotask queue allows until the deadline.
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
    this.isProcessRunning = options.isProcessRunning;
    this.pid = options.pid ?? process.pid;
    this.ownerToken = options.ownerToken ?? PROCESS_MIGRATION_TOKEN;
  }

  async acquire(): Promise<void> {
    const deadline = this.timer.now() + this.timeoutMs;

    // Fast path: a fresh lock (single opener) acquires on the first attempt with
    // no sleep, so the default single-process path adds no latency.
    for (;;) {
      if (this.tryAcquire()) {
        return;
      }

      if (this.timer.now() >= deadline) {
        throw new ActionableError(
          `Timed out after ${this.timeoutMs}ms waiting for the database migration lock ` +
            `at ${this.lockFilePath}. Another process is likely migrating this database — ` +
            `you may be sharing one DB across worktrees/instances. Point each instance at a ` +
            `distinct database via AUTOMOBILE_DB_PATH, or stop the other opener.`,
        );
      }

      await this.timer.sleep(this.pollIntervalMs);
    }
  }

  async release(): Promise<void> {
    // Pass the owner token so release is incarnation-aware and symmetric with
    // acquire: a same-PID lock bearing a different token belongs to another
    // incarnation that recycled our PID and must not be deleted (#3006).
    releaseExclusiveLock(this.lockFilePath, this.pid, this.ownerToken);
  }

  private tryAcquire(): boolean {
    return tryAcquireExclusiveLock(this.lockFilePath, {
      pid: this.pid,
      isProcessRunning: this.isProcessRunning,
      // A lock file bearing our own PID is normally a stale leak from a crashed
      // prior incarnation whose PID the OS recycled — reclaim it rather than hang
      // for the full timeout. But an in-process same-path reopen while a prior
      // generation's migration is still in flight would ALSO see our own PID; the
      // owner token below tells the two apart so we wait for a live sibling run
      // instead of stealing its lock and running two migrators on one DB (#2947).
      reclaimOwnPid: true,
      ownerToken: this.ownerToken,
    });
  }
}

/**
 * Resolve the lock file path for a DB path, canonicalizing symlinks/aliases so
 * two openers reaching the *same* DB file through different path aliases (e.g. a
 * symlinked or bind-mounted `AUTOMOBILE_DB_PATH`) derive the SAME lock file and
 * actually contend — otherwise a string-keyed lock would let them both enter
 * `migrateToLatest()`. The DB file itself may not exist yet on first boot, so
 * canonicalize the (already-created) parent directory and re-append the basename.
 */
export function migrationLockPathFor(dbPath: string): string {
  let canonical = dbPath;
  try {
    // If the DB file already exists, resolve it fully so a symlinked DB file
    // *itself* (e.g. AUTOMOBILE_DB_PATH pointing at an alias of the real file)
    // maps to the same lock as its real path. Before first creation the file is
    // absent, so fall back to canonicalizing the (existing) parent dir + basename.
    canonical = existsSync(dbPath)
      ? realpathSync(dbPath)
      : join(realpathSync(dirname(dbPath)), basename(dbPath));
  } catch {
    // Path not resolvable yet — fall back to the raw path (best effort).
  }
  return `${canonical}.migrate.lock`;
}

/**
 * SQLite in-memory sentinel path. A DB opened at this path is private to its
 * connection and lives entirely in RAM — it has no file, no `-wal`/`-shm`
 * sidecars, and no lock file. So it needs neither daemon-launch-cwd path
 * resolution (which would `path.resolve(":memory:")` into a bogus absolute path)
 * nor a cross-process migration lock (there is no shared file for a second
 * process to reach). Used to make DB-lifecycle tests that don't need a real file
 * flake-free (issue #3047). `file::memory:?cache=shared` was considered and
 * rejected — it reintroduces the cross-process lock concern and carries bun
 * URI-filename risk for no benefit here.
 *
 * TEST-ONLY. Because `:memory:` is private per connection, the app connection
 * (`getDatabase()`) and the migration connection (`startMigrations()`'s separate
 * `migrationDb`) get DIFFERENT empty databases: `ensureMigrations()` reports
 * success, yet the app connection has NONE of the migrated tables, so a real
 * schema-dependent read/write (e.g. `tool_calls`) fails with `no such table`.
 * This sentinel is therefore only for lifecycle tests that exercise the
 * open/close/reopen contract without querying migrated schema — not a production
 * DB configuration. (Sharing one connection across the app and the migrator would
 * break the migration failure-isolation the separate `migrationDb` provides, so
 * it is deliberately out of scope.) A production `AUTOMOBILE_DB_PATH=:memory:` is
 * now rejected at path-resolution time unless {@link IN_MEMORY_DB_OPT_IN_ENV} is
 * set, so this footgun fails fast instead of silently (issue #3065).
 */
export const IN_MEMORY_DATABASE_PATH = ":memory:";

/** True for the plain `:memory:` sentinel (see {@link IN_MEMORY_DATABASE_PATH}). */
export function isInMemoryDatabasePath(dbPath: string): boolean {
  return dbPath === IN_MEMORY_DATABASE_PATH;
}

/**
 * Explicit opt-in that permits the test-only `:memory:` sentinel DB path.
 *
 * `:memory:` is private per connection, so a real daemon that set it would get a
 * migrated-but-empty app connection (see {@link IN_MEMORY_DATABASE_PATH}). The
 * runtime guard in `database.ts#resolveDatabasePathFromEnvironment` rejects
 * `:memory:` unless this flag is truthy, so production misuse fails fast and
 * legibly while lifecycle tests keep the fast, file-free seam (issue #3065).
 */
export const IN_MEMORY_DB_OPT_IN_ENV = "AUTOMOBILE_ALLOW_IN_MEMORY_DB";

/**
 * True when {@link IN_MEMORY_DB_OPT_IN_ENV} is set to a truthy value
 * (`1`/`true`/`yes`, case- and whitespace-insensitive). Anything else — absent,
 * empty, `0`/`false`/`no` — is treated as disabled so the guard fails safe: a
 * typo'd or empty flag never silently opts a production daemon into the
 * migrated-but-empty `:memory:` footgun (issue #3065).
 */
export function isInMemoryDatabaseOptInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = env[IN_MEMORY_DB_OPT_IN_ENV]?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Select the migration lock for a resolved DB path: a {@link NoOpMigrationLock}
 * for the `:memory:` sentinel (private per-connection, no file to guard, and
 * `:memory:.migrate.lock` would be a bogus file), a {@link FileMigrationLock}
 * keyed to the file otherwise. This is the single decision point so every opener
 * (currently `database.ts#startMigrations`) can stay DB-path-agnostic (#3047).
 * Named for its role as the chooser — it dispatches to
 * {@link createFileMigrationLock} for the file branch (issue #3065 nit).
 */
export function selectMigrationLock(dbPath: string): MigrationLock {
  return isInMemoryDatabasePath(dbPath) ? new NoOpMigrationLock() : createFileMigrationLock(dbPath);
}

/**
 * Default migration lock for a resolved DB file path. Keyed per-file (not
 * per-uid) because the trigger — two openers on one DB file — is per-file. The
 * busy-wait ceiling can be overridden via `AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS`
 * (with the legacy `AUTO_MOBILE_` alias), mirroring the daemon timeout knobs in
 * `src/daemon/constants.ts`.
 */
export function createFileMigrationLock(dbPath: string): MigrationLock {
  const lockFilePath = migrationLockPathFor(dbPath);
  const override =
    process.env.AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS ??
    process.env.AUTO_MOBILE_MIGRATION_LOCK_TIMEOUT_MS;
  const parsed = override ? Number.parseInt(override, 10) : NaN;
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

  logger.debug(`Migration lock keyed to ${lockFilePath}`);
  return new FileMigrationLock(lockFilePath, timeoutMs !== undefined ? { timeoutMs } : {});
}
