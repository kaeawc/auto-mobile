import { errorMessage } from "../utils/describeUnknownError";
import { Kysely, sql } from "kysely";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { Database as DatabaseSchema } from "./types";
import { runMigrations } from "./migrator";
import {
  isInMemoryDatabaseOptInEnabled,
  isInMemoryDatabasePath,
  IN_MEMORY_DB_OPT_IN_ENV,
  selectMigrationLock,
} from "./migrationLock";
import { logger } from "../utils/logger";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { BunSqliteDialect, DEFAULT_OPTIMIZE_INTERVAL_MS } from "./bunSqliteDialect";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import {
  createIncompleteExtractionError,
  extractMissingPackageName,
  isMissingMigrationDependencyError,
} from "./migrationDependencyIntegrity";
import { resetDbWriteBarrier } from "./dbWriteBarrier";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";

type BunDatabaseConstructor = typeof import("bun:sqlite").Database;
type BunDatabase = import("bun:sqlite").Database;

let bunDatabaseConstructor: BunDatabaseConstructor | null = null;

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Runtime cap on the WAL file: after each passive/auto checkpoint SQLite
 * truncates the WAL back to this bound instead of leaving it allocated at its
 * high-water mark. This is a steady-state knob only — it is independent of the
 * one-shot `wal_checkpoint(TRUNCATE)` issued at connection close (which
 * truncates the WAL to zero unconditionally, ignoring this limit). See #2802.
 */
export const SQLITE_WAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Connection-local SQLite page cache budget. Negative cache_size values are
 * kibibytes, not pages; 16 MiB is enough to keep the SELECT-heavy telemetry and
 * navigation working sets warm without being surprising for a local daemon.
 */
export const SQLITE_CACHE_SIZE_KIB = 16 * 1024;

/**
 * Upper bound for SQLite memory-mapped reads. 64 MiB gives growing local
 * telemetry/diagnostics databases a cheap read path while keeping the address
 * window conservative on developer machines.
 */
export const SQLITE_MMAP_SIZE_BYTES = 64 * 1024 * 1024;

/**
 * Keep temporary sort and b-tree storage in memory. These are local diagnostic
 * queries over bounded data, so avoiding temp files is a read-performance knob
 * rather than a durability trade-off.
 */
export const SQLITE_TEMP_STORE = "MEMORY";

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

  // Truncate the WAL back to this bound after each passive/auto checkpoint
  // instead of leaving it allocated at its high-water mark (issue #2802).
  sqliteDb.exec(`PRAGMA journal_size_limit = ${SQLITE_WAL_SIZE_LIMIT_BYTES};`);

  // Use a modest page cache for the SELECT-heavy observe/nav/stream workload.
  sqliteDb.exec(`PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KIB};`);

  // Allow SQLite to memory-map the hot prefix of the local diagnostics DB.
  sqliteDb.exec(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES};`);

  // Keep temporary sort/b-tree structures off disk for local diagnostic queries.
  sqliteDb.exec(`PRAGMA temp_store = ${SQLITE_TEMP_STORE};`);

  // WAL + NORMAL avoids an fsync per commit while remaining corruption-safe.
  // The whole DB stores local telemetry, diagnostics, cache, config, and session
  // state where losing the last commit on OS/power loss is acceptable.
  sqliteDb.exec("PRAGMA synchronous = NORMAL;");

  // Enable foreign key enforcement for cascade deletes
  sqliteDb.exec("PRAGMA foreign_keys = ON;");
}

// Database file location (defaults to ~/.auto-mobile/auto-mobile.db)
const DEFAULT_DB_DIR = path.join(os.homedir(), ".auto-mobile");
// @deprecated AUTO_MOBILE_DB_PATH - use AUTOMOBILE_DB_PATH instead
// @deprecated AUTO_MOBILE_DB_DIR - use AUTOMOBILE_DB_DIR instead
export function resolveDatabasePathFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  defaultDbDir: string = DEFAULT_DB_DIR,
): string {
  const envDbPath = env.AUTOMOBILE_DB_PATH ?? env.AUTO_MOBILE_DB_PATH;
  if (envDbPath) {
    // The `:memory:` sentinel is not a filesystem path: routing it through the
    // daemon-launch-cwd resolver would `path.resolve(":memory:")` into a bogus
    // absolute path (and `selectMigrationLock` would then try to create a
    // `:memory:.migrate.lock` file). Pass it through un-resolved (issue #3047).
    if (isInMemoryDatabasePath(envDbPath)) {
      // `:memory:` is a test-only seam: it is private per connection, so the app
      // connection never sees the migration connection's schema — migrations
      // report success while the daemon queries a migrated-but-empty DB and the
      // first schema-dependent read/write fails with `no such table`. Reject it
      // outside an explicit opt-in so a production `AUTOMOBILE_DB_PATH=:memory:`
      // fails fast and legibly instead of silently breaking (issue #3065).
      if (!isInMemoryDatabaseOptInEnabled(env)) {
        throw new ActionableError(
          `AUTOMOBILE_DB_PATH=:memory: is not a valid production database. A ` +
            `SQLite \`:memory:\` DB is private per connection, so startup migrations ` +
            `run on a separate in-memory database and the daemon's connection is left ` +
            `migrated-but-empty — the first query (e.g. \`tool_calls\`) would fail with ` +
            `\`no such table\`. Point AUTOMOBILE_DB_PATH at a real file (or unset it to use ` +
            `~/.auto-mobile/auto-mobile.db). The \`:memory:\` sentinel is for lifecycle ` +
            `tests only; set ${IN_MEMORY_DB_OPT_IN_ENV}=1 to opt in from a test.`,
        );
      }
      return envDbPath;
    }
    return resolvePathFromDaemonLaunchWorkingDirectory(envDbPath);
  }

  const envDbDir = env.AUTOMOBILE_DB_DIR ?? env.AUTO_MOBILE_DB_DIR;
  const dbDir = envDbDir ? resolvePathFromDaemonLaunchWorkingDirectory(envDbDir) : defaultDbDir;
  return path.join(dbDir, "auto-mobile.db");
}

/**
 * True when this process is a Bun test runner context. `bun test` sets
 * `NODE_ENV=test` automatically when it is not already set, and nothing in
 * production (the daemon runs under `bun run`/a compiled binary) sets it, so this
 * is the arm-by-default signal for the real-DB guard (#3140). It is deliberately
 * env-based — not a `bun:test`/`Bun.jest` runtime probe — because `Bun.jest` is a
 * function under any Bun runtime (including a plain `bun run`), so it does not
 * distinguish a test run from production.
 */
function isBunTestContext(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "test";
}

/**
 * Whether the real-DB guard is armed for this process. As of #3185 this is a
 * pure inversion: the guard arms only from Bun's default test context signal
 * (`NODE_ENV=test`) and no longer keeps a preload-set force-arm fallback for the
 * unsupported `NODE_ENV=production bun test` corner case.
 */
function isUnitTestDbGuardArmed(env: NodeJS.ProcessEnv): boolean {
  return isBunTestContext(env);
}

// The four env vars that redirect the database off the default `~/.auto-mobile`
// location. A test that sets any of these has explicitly opted into a real
// file-backed (or `:memory:`) DB it controls, so the guard leaves it alone.
const DB_PATH_OVERRIDE_ENV_KEYS = [
  "AUTOMOBILE_DB_PATH",
  "AUTO_MOBILE_DB_PATH",
  "AUTOMOBILE_DB_DIR",
  "AUTO_MOBILE_DB_DIR",
] as const;

function hasExplicitDbPathOverride(env: NodeJS.ProcessEnv): boolean {
  return DB_PATH_OVERRIDE_ENV_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && value !== "";
  });
}

/**
 * Fail loudly when a unit test resolves the DEFAULT, file-backed `getDatabase()`
 * — i.e. the user's real `~/.auto-mobile/auto-mobile.db` — instead of injecting
 * an in-memory DB (`createTestDatabase`) or explicitly redirecting to a temp/
 * `:memory:` path.
 *
 * `getDatabase()`'s first-use path runs migrations + file IO on real wall-clock
 * time, so any test that asserts on the *result* of an async DB write races that
 * write and flakes (issue #3063). It also silently mutates the developer's real
 * DB. This guard turns both failure modes into a loud, actionable throw at the
 * exact call site that reached for the real DB, forcing the test to inject an
 * in-memory DB instead — the durable fix for the whole class (issue #3067).
 *
 * The guard is armed by default under a bun-test context and deliberately fires
 * ONLY on the default path: a test that sets AUTOMOBILE_DB_PATH /
 * AUTOMOBILE_DB_DIR (the DB-lifecycle tests that must exercise real file
 * behavior) or `:memory:` has explicitly opted in and passes. See
 * {@link isUnitTestDbGuardArmed} for the arm-by-default signal.
 */
function assertUnitTestDbAccessAllowed(env: NodeJS.ProcessEnv, resolvedPath: string): void {
  if (!isUnitTestDbGuardArmed(env)) {
    return;
  }
  if (isInMemoryDatabasePath(resolvedPath) || hasExplicitDbPathOverride(env)) {
    return;
  }
  throw new ActionableError(
    `Unit test resolved the real file-backed database at ${resolvedPath}. ` +
      "Unit tests must not touch the user's real ~/.auto-mobile DB: its first-use " +
      "migrations + file IO run on real wall-clock time and race async-write " +
      "assertions (issue #3063). Inject an in-memory DB via createTestDatabase() " +
      "(and NavigationGraphManager.setInstanceForTesting / TelemetryRecorder spies " +
      "for singletons), or, if the test must exercise real file behavior, set " +
      "AUTOMOBILE_DB_DIR to a temp dir or AUTOMOBILE_DB_PATH=':memory:' explicitly.",
  );
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
    const resolvedPath = resolveDatabasePathFromEnvironment();
    assertUnitTestDbAccessAllowed(process.env, resolvedPath);
    lifecycle.resolvedDbPath = resolvedPath;
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
  const causeMessage = errorMessage(cause);
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

function createSqliteKysely<T>(dbPath: string, beforeQuery?: () => Promise<void>): Kysely<T> {
  return new Kysely<T>({
    dialect: new BunSqliteDialect({
      database: () => openConfiguredSqliteDatabase(dbPath),
      beforeQuery,
      // Refresh planner statistics periodically over a long-lived daemon, not
      // only at connection close (#3497).
      optimizeIntervalMs: DEFAULT_OPTIMIZE_INTERVAL_MS,
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
      lock: selectMigrationLock(dbPath),
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
      (error) => {
        if (generation !== lifecycle.migrationsGeneration) {
          return; // Superseded run; do not resurrect a stale failure.
        }
        lifecycle.migrationsError = createStartupMigrationError(error);
      },
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
 *   #2912, leaving no reopen exception. The swap short-circuits only writes that
 *   resolve the still-draining barrier; a use-time write firing *after* the reset
 *   (`AndroidCtrlProxyClient.markInstalledAppsStale()`) resolves the fresh,
 *   non-draining barrier and is not short-circuited — it is bounded instead by the
 *   synchronous reset→`process.exit(0)` window plus its own `try/catch` (#2912
 *   sub-item 2). It stays a sibling call here rather than a
 *   field on `MigrationLifecycleState` because it is an identity swap in a
 *   separate, already-encapsulated module (`dbWriteBarrier.ts`), not part of the
 *   migration/path state machine.
 */
function resetDbLifecycleState(): void {
  lifecycle.reset();
  resetDbWriteBarrier();
}

/**
 * Await any in-flight startup migration (the detached, resolve-never-reject
 * `.then` chain built in {@link ensureMigrationsStarted}) before the daemon tears
 * down the app connection, bounded by `timeoutMs`.
 *
 * `getDatabase()` kicks `startMigrations()` off on a SEPARATE, detached
 * `migrationDb` connection. `closeDatabase()` only destroys the app connection and
 * bumps the generation fence so the detached success/failure handler no-ops — it
 * never awaits that connection's own writes/checkpoint settling. In steady-state
 * shutdown this is moot: startup already awaited `ensureMigrations()` before the
 * daemon served traffic, so migrations are long settled. The one reachable window
 * is a SIGTERM arriving mid cold-start migration, where the still-open
 * `migrationDb` connection's writes contend with the closing app connection —
 * the exact WAL contention #3040 removed from the test, which on Windows can
 * stall shutdown on `busy_timeout` (issue #3044).
 *
 * Calling this before `closeDatabase()` in the daemon shutdown path lets the
 * migration connection finish (and `startMigrations()` destroy it) first. The
 * underlying promise never rejects (a failed migration caches into
 * `migrationsError`), so this never throws; a wedged migration cannot itself hang
 * shutdown — the timeout wins and shutdown proceeds anyway. No-ops when no run is
 * in flight.
 *
 * @returns true if the migration settled within the budget (or none was in
 *   flight), false if the timeout won.
 */
export async function awaitInFlightMigrations(
  timeoutMs: number,
  timer: Timer = defaultTimer,
): Promise<boolean> {
  return awaitPromiseBounded(lifecycle.migrationsPromise, timeoutMs, timer);
}

/**
 * Race a resolve-never-reject promise against a bounded timeout, returning true if
 * it settled first (or was already null) and false if the timeout won. Extracted
 * from {@link awaitInFlightMigrations} so the timeout branch is unit-testable with
 * a caller-supplied in-flight promise + {@link Timer} fake, without having to force
 * a real cold-start migration to block (issue #3044). The bound timer is always
 * cleared, so a settled promise leaves no dangling timeout.
 */
export async function awaitPromiseBounded(
  inFlight: Promise<void> | null,
  timeoutMs: number,
  timer: Timer = defaultTimer,
): Promise<boolean> {
  if (!inFlight) {
    return true;
  }

  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    handle = timer.setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    // `inFlight` is resolve-never-reject by construction (ensureMigrationsStarted),
    // so this race never rejects.
    return await Promise.race([inFlight.then(() => true), timeout]);
  } finally {
    if (handle !== undefined) {
      timer.clearTimeout(handle);
    }
  }
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
