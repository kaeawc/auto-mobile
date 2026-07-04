import { Kysely, sql } from "kysely";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { Database as DatabaseSchema } from "./types";
import { runMigrations } from "./migrator";
import { createMigrationLock, isInMemoryDatabasePath } from "./migrationLock";
import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import { BunSqliteDialect } from "./bunSqliteDialect";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import {
  createIncompleteExtractionError,
  extractMissingPackageName,
  isMissingMigrationDependencyError,
} from "./migrationDependencyIntegrity";
import { resetDbWriteBarrier } from "./dbWriteBarrier";

type BunDatabaseConstructor = typeof import("bun:sqlite").Database;
type BunDatabase = import("bun:sqlite").Database;

let bunDatabaseConstructor: BunDatabaseConstructor | null = null;

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface SqlitePragmaDatabase {
  exec(sql: string): unknown;
}

function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string> | undefined)?.bun === "string";
}

function resolveBunDatabaseConstructor(): BunDatabaseConstructor {
  if (!isBunRuntime()) {
    throw new Error("bun:sqlite is only available when running under Bun.");
  }

  if (!bunDatabaseConstructor) {
    const bunSqliteModule = require("bun:sqlite") as { Database: BunDatabaseConstructor };
    bunDatabaseConstructor = bunSqliteModule.Database;
  }

  return bunDatabaseConstructor;
}

export function configureSqliteDatabase(sqliteDb: SqlitePragmaDatabase): void {
  // Wait for transient writer locks instead of failing immediately with SQLITE_BUSY
  sqliteDb.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);

  // Enable WAL mode for better concurrent read performance
  sqliteDb.exec("PRAGMA journal_mode = WAL;");

  // Enable foreign key enforcement for cascade deletes
  sqliteDb.exec("PRAGMA foreign_keys = ON;");
}

// Database file location (defaults to ~/.auto-mobile/auto-mobile.db)
const DEFAULT_DB_DIR = path.join(os.homedir(), ".auto-mobile");
// @deprecated AUTO_MOBILE_DB_PATH - use AUTOMOBILE_DB_PATH instead
// @deprecated AUTO_MOBILE_DB_DIR - use AUTOMOBILE_DB_DIR instead
export function resolveDatabasePathFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  defaultDbDir: string = DEFAULT_DB_DIR
): string {
  const envDbPath = env.AUTOMOBILE_DB_PATH ?? env.AUTO_MOBILE_DB_PATH;
  if (envDbPath) {
    // The `:memory:` sentinel is not a filesystem path: routing it through the
    // daemon-launch-cwd resolver would `path.resolve(":memory:")` into a bogus
    // absolute path (and `createFileMigrationLock` would then try to create a
    // `:memory:.migrate.lock` file). Pass it through un-resolved (issue #3047).
    return isInMemoryDatabasePath(envDbPath)
      ? envDbPath
      : resolvePathFromDaemonLaunchWorkingDirectory(envDbPath);
  }

  const envDbDir = env.AUTOMOBILE_DB_DIR ?? env.AUTO_MOBILE_DB_DIR;
  const dbDir = envDbDir
    ? resolvePathFromDaemonLaunchWorkingDirectory(envDbDir)
    : defaultDbDir;
  return path.join(dbDir, "auto-mobile.db");
}

/**
 * The migration/path lifecycle state that outlives a single DB connection.
 *
 * These were five bare module globals (`resolvedDbPath` plus the
 * `migrationsRun` / `migrationsPromise` / `migrationsError` state machine and the
 * `migrationsGeneration` fence) that `closeDatabase()` had to remember to reset
 * one-by-one so a same-process reopen behaves like a cold start (issues #2796,
 * #2898). Collapsing them into one holder with a single {@link reset} makes
 * "reset them as a set" true *by construction*: a sixth lifecycle field is
 * cleared by the same `reset()`, closing the "forgot to reset the Nth global"
 * regression class (issues #2900/#2944).
 *
 * All fields are reset together — never individually — so the invariants they
 * encode ("reopen == cold start", "no stale error against a healthy reopen",
 * "re-read the DB path env", "stale in-flight completions are fenced off") hold
 * as a set.
 */
class MigrationLifecycleState {
  /**
   * Resolved database file path, cached on first use (see {@link resolveDbPath}).
   * Cleared on reset so a reopen re-reads AUTOMOBILE_DB_PATH / AUTOMOBILE_DB_DIR.
   */
  resolvedDbPath: string | null = null;

  /** True once startup migrations have completed successfully. */
  migrationsRun = false;

  /**
   * In-flight/settled startup-migration run. RESOLVES even on failure (never
   * floats a rejection — that would trip `unhandledRejection` before the
   * daemon's fatal path runs); the failure is cached in {@link migrationsError}
   * so every awaiter can re-check and rethrow it. The failure is sticky: this is
   * never nulled to auto-retry (see issues #2784/#2786/#2796).
   */
  migrationsPromise: Promise<void> | null = null;

  /**
   * Cached startup-migration failure so awaiters (queries via
   * `waitForMigrationsBeforeQuery`, startup via `ensureMigrations`) can re-check
   * and rethrow it without depending on the resolved promise rejecting.
   */
  migrationsError: Error | null = null;

  /**
   * Monotonic generation token fencing off stale migration completions. Nulling
   * `migrationsPromise` in {@link reset} does NOT cancel the still-running
   * detached `startMigrations().then(...)` chain — it runs on its own
   * `migrationDb` and settles independently. If a `getDatabase()` reopen starts a
   * NEW generation before the old chain settles, the stale handler would
   * overwrite the new generation's `migrationsRun`/`migrationsError`.
   * `ensureMigrationsStarted()` captures this counter when it creates the
   * promise; its handlers only write the fields if their captured generation
   * still matches. {@link reset} bumps it, so any handler from a superseded run
   * no-ops (#2898).
   */
  migrationsGeneration = 0;

  /**
   * Clear the whole lifecycle as a set so a same-process reopen cold-starts.
   * Adding a field above is reset-by-construction: extend this method with it.
   * `migrationsGeneration` is BUMPED (monotonic), never zeroed, so a superseded
   * run's completion can't collide with a reopened generation (#2898).
   */
  reset(): void {
    this.resolvedDbPath = null;
    this.migrationsRun = false;
    this.migrationsPromise = null;
    this.migrationsError = null;
    this.migrationsGeneration += 1;
  }
}

const lifecycle = new MigrationLifecycleState();

/**
 * Resolve the database file path lazily, on first use rather than at module load.
 *
 * A directly launched daemon (`--daemon-mode`, started by an IDE/user rather than
 * spawned by DaemonManager) sets AUTOMOBILE_DAEMON_LAUNCH_CWD and chdirs to a
 * stable working directory inside Daemon.start() — AFTER this module is imported.
 * Resolving at module load would bind a relative AUTOMOBILE_DB_DIR /
 * AUTOMOBILE_DB_PATH to the pre-chdir cwd with that env unset, diverging from
 * migrator.ts (which resolves AUTOMOBILE_MIGRATIONS_DIR at runtime) or landing the
 * database in the wrong place once the daemon chdirs. Deferring to first use makes
 * resolution happen post-chdir/post-env, consistent with the migrator. The result
 * is cached so getDatabasePath() always matches the path the database was opened at.
 */
function resolveDbPath(): string {
  if (lifecycle.resolvedDbPath === null) {
    lifecycle.resolvedDbPath = resolveDatabasePathFromEnvironment();
  }
  return lifecycle.resolvedDbPath;
}

let dbInstance: Kysely<DatabaseSchema> | null = null;

export const DATABASE_STARTUP_MIGRATION_FAILURE =
  "Database startup migrations failed; refusing to run queries until the daemon restarts.";

function createStartupMigrationError(cause: unknown): Error {
  // A half-linked bunx extraction (a known migration runtime dependency such as
  // `kysely` missing from this run's node_modules) surfaces as a "Cannot find
  // package" resolve error while the migrator dynamically imports a migration
  // file. Map that to the distinct, recoverable incomplete-extraction error
  // instead of the generic fatal crash so the caller knows to remove the
  // extraction and re-run (issue #2833). Scoped to known dependencies so a
  // genuine code-level bad import in a migration is not mislabeled.
  if (isMissingMigrationDependencyError(cause)) {
    return createIncompleteExtractionError(extractMissingPackageName(cause), cause);
  }
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${DATABASE_STARTUP_MIGRATION_FAILURE} Cause: ${causeMessage}`, { cause });
}

async function waitForMigrationsBeforeQuery(): Promise<void> {
  if (lifecycle.migrationsRun) {
    return;
  }

  if (lifecycle.migrationsPromise) {
    await lifecycle.migrationsPromise;
  }

  if (lifecycle.migrationsError) {
    throw lifecycle.migrationsError;
  }
}

function createSqliteKysely<T>(
  dbPath: string,
  beforeQuery?: () => Promise<void>
): Kysely<T> {
  return new Kysely<T>({
    dialect: new BunSqliteDialect({
      database: () => openConfiguredSqliteDatabase(dbPath),
      beforeQuery,
    }),
  });
}

function openConfiguredSqliteDatabase(dbPath: string): BunDatabase {
  const BunDatabaseConstructor = resolveBunDatabaseConstructor();
  const sqliteDb = new BunDatabaseConstructor(dbPath);
  configureSqliteDatabase(sqliteDb);
  return sqliteDb;
}

/**
 * Write a WAL-safe, timestamped backup of the database before a destructive
 * migration reset drops user tables. Uses SQLite's `VACUUM INTO`, which writes a
 * transactionally-consistent single-file snapshot *through the live connection* —
 * it captures uncheckpointed WAL frames without an OS-level copy of the open (and,
 * on Windows, locked) database file, and produces no `-wal`/`-shm` sidecars.
 */
export async function backupDatabaseFile(db: Kysely<unknown>, dbPath: string): Promise<void> {
  try {
    // Include the pid so a daemon that restart-loops on a corrupt DB (#2784) does
    // not clobber an earlier backup written in the same millisecond.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dbPath}.corrupt-backup-${timestamp}-${process.pid}`;
    // The interpolated path is bound as a parameter, not concatenated into SQL.
    await sql`VACUUM INTO ${backupPath}`.execute(db);

    logger.warn(`Wrote pre-reset database backup to ${backupPath}`);
  } catch (error) {
    throw toActionableError(error, "Failed to back up the database before migration reset");
  }
}

async function startMigrations(dbPath: string): Promise<void> {
  const migrationDb = createSqliteKysely<unknown>(dbPath);

  try {
    await runMigrations(migrationDb, {
      // Serialize the migration run across processes: two openers on the same DB
      // file (override env / --no-proxy alongside a daemon) must not both enter
      // migrateToLatest() and collide on the kysely_migration PRIMARY KEY (#2794).
      // A `:memory:` DB is private per connection, so it gets a no-op lock (#3047).
      lock: createMigrationLock(dbPath),
      backup: () => backupDatabaseFile(migrationDb, dbPath),
    });
    // `migrationsRun` is NOT set here: it is a fenced global written only by the
    // generation-guarded success handler in `ensureMigrationsStarted()`, so a
    // superseded run (closeDatabase()+reopen) can't flip it on the new generation.
  } catch (error) {
    logger.error("Failed to run migrations on database initialization:", error);
    throw error;
  } finally {
    await migrationDb.destroy();
  }
}

function ensureMigrationsStarted(dbPath: string): void {
  if (!lifecycle.migrationsRun && !lifecycle.migrationsPromise) {
    // Capture the generation so a completion that lands after a
    // closeDatabase()+reopen (which bumps the counter) is dropped instead of
    // stomping the newer generation's `migrationsRun`/`migrationsError` (#2898).
    const generation = lifecycle.migrationsGeneration;
    // Resolve (never reject) so a failed migration does not float an unhandled
    // rejection; cache the error for synchronous re-checking by awaiters.
    lifecycle.migrationsPromise = startMigrations(dbPath).then(
      () => {
        if (generation !== lifecycle.migrationsGeneration) {
          return; // Superseded run; its DB is already destroyed. Drop silently.
        }
        lifecycle.migrationsRun = true;
        lifecycle.migrationsError = null;
      },
      error => {
        if (generation !== lifecycle.migrationsGeneration) {
          return; // Superseded run; do not resurrect a stale failure.
        }
        lifecycle.migrationsError = createStartupMigrationError(error);
      }
    );
  }
}

function ensureDatabaseDirectory(dbPath: string): void {
  // The `:memory:` sentinel has no file or directory; `dirname(":memory:")` is a
  // bogus `.` that must not be created (issue #3047).
  if (isInMemoryDatabasePath(dbPath)) {
    return;
  }

  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

function createApplicationDatabase(dbPath: string): Kysely<DatabaseSchema> {
  return createSqliteKysely<DatabaseSchema>(dbPath, waitForMigrationsBeforeQuery);
}

/**
 * Get the singleton database instance.
 * Creates the database file and directory if they don't exist.
 */
export function getDatabase(): Kysely<DatabaseSchema> {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    ensureDatabaseDirectory(dbPath);

    dbInstance = createApplicationDatabase(dbPath);
    ensureMigrationsStarted(dbPath);
  }

  return dbInstance;
}

export async function ensureMigrations(): Promise<void> {
  if (lifecycle.migrationsRun) {
    return;
  }

  if (!dbInstance) {
    getDatabase();
  }

  ensureMigrationsStarted(resolveDbPath());

  await lifecycle.migrationsPromise;

  // Under the resolved-promise model the await above never rejects; re-check the
  // cached error so a startup migration failure stays fatal for callers that
  // await migrations at startup (e.g. Daemon.initializeDatabase — issue #2784).
  if (lifecycle.migrationsError) {
    throw lifecycle.migrationsError;
  }
}

/**
 * The cached startup-migration failure, or null if migrations succeeded or have
 * not yet failed. Used by the daemon health/liveness path to detect a query-dead
 * DB without floating a rejection.
 */
export function getMigrationsError(): Error | null {
  return lifecycle.migrationsError;
}

/**
 * Test-only handle on the in-flight migration promise (the resolve-never-reject
 * `.then` chain built in {@link ensureMigrationsStarted}), or null when no run is
 * in flight. Exposed so the generation-fence regression test can capture a
 * generation's promise while it is blocked, then deterministically `await` its
 * completion after a `closeDatabase()` + reopen — proving the settled stale
 * handler no-ops instead of racing a fixed delay. Not part of the daemon
 * contract; do not use in production paths (issue #2898).
 */
export function getMigrationsPromiseForTest(): Promise<void> | null {
  return lifecycle.migrationsPromise;
}

/**
 * Reset every piece of module-global state that outlives a single DB connection
 * so a same-process reopen behaves like a cold start. This is THE single named
 * entry point the reset checklist hangs off (issues #2900/#2935): adding a reset
 * is done by editing this one function, not by finding the right spot inside
 * `closeDatabase()`. The "if these resets are ever consolidated, X must move with
 * them" prose caveat that had already failed twice (#2796, #2896) is now
 * structural. Called by `closeDatabase()` unconditionally (partial-init cleanup);
 * inert in the daemon, whose only caller is shutdown-then-exit.
 *
 * Each owning module keeps its own private reset; the *orchestration* lives here.
 * Two resets with two different lifecycle semantics are deliberate siblings:
 *
 * - `lifecycle.reset()` clears the migration/path state machine as a set (issues
 *   #2796/#2900/#2944) and bumps the generation fence (#2898). Leaving any field
 *   set would let `ensureMigrationsStarted()` no-op and
 *   `waitForMigrationsBeforeQuery()` short-circuit (skipping migration gating on
 *   the new connection), rethrow a stale startup error against an
 *   otherwise-healthy reopened DB, redirect the reopen to the stale
 *   `resolvedDbPath` instead of re-reading AUTOMOBILE_DB_PATH / AUTOMOBILE_DB_DIR,
 *   or let a superseded in-flight migration completion stomp the new generation.
 *   In the daemon this is inert and the "path always matches" invariant from
 *   resolveDbPath() holds; the reset is what gives tests full isolation.
 *
 * - `resetDbWriteBarrier()` cold-starts the write barrier (issue #2896). Its
 *   draining flag latches for the process lifetime, so shutdown's
 *   `getDbWriteBarrier().drain(...)` before close (issue #2792 ordering) would
 *   otherwise leave the shared barrier permanently draining, and any future
 *   in-process reopen (config reload / DB path switch / restart-without-exit)
 *   would silently skip every tracked best-effort write against the reopened DB.
 *   Every shared-barrier consumer resolves `getDbWriteBarrier()` at use-time (per
 *   write), so this identity swap reaches all of them — the former
 *   construction-captured consumers were converted to per-write resolution in
 *   #2912, leaving no reopen exception. It stays a sibling call here rather than a
 *   field on `MigrationLifecycleState` because it is an identity swap in a
 *   separate, already-encapsulated module (`dbWriteBarrier.ts`), not part of the
 *   migration/path state machine.
 */
function resetDbLifecycleState(): void {
  lifecycle.reset();
  resetDbWriteBarrier();
}

/**
 * Close the database connection.
 * Call this during graceful shutdown.
 */
export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
  }

  // Reset unconditionally — outside the `if (dbInstance)` guard — so a
  // partially-initialized state (migrations started but `dbInstance` already
  // nulled) is still cleaned up.
  resetDbLifecycleState();
}

/**
 * Get the database file path.
 */
export function getDatabasePath(): string {
  return resolveDbPath();
}
