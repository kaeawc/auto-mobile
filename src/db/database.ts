import { Kysely, sql } from "kysely";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { Database as DatabaseSchema } from "./types";
import { runMigrations } from "./migrator";
import { createFileMigrationLock } from "./migrationLock";
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
    return resolvePathFromDaemonLaunchWorkingDirectory(envDbPath);
  }

  const envDbDir = env.AUTOMOBILE_DB_DIR ?? env.AUTO_MOBILE_DB_DIR;
  const dbDir = envDbDir
    ? resolvePathFromDaemonLaunchWorkingDirectory(envDbDir)
    : defaultDbDir;
  return path.join(dbDir, "auto-mobile.db");
}

let resolvedDbPath: string | null = null;

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
  if (resolvedDbPath === null) {
    resolvedDbPath = resolveDatabasePathFromEnvironment();
  }
  return resolvedDbPath;
}

let dbInstance: Kysely<DatabaseSchema> | null = null;
let migrationsRun = false;
let migrationsPromise: Promise<void> | null = null;
// Cached startup-migration failure. When migrations fail, `migrationsPromise`
// RESOLVES (never floats a rejection — that would trip `unhandledRejection`
// before the daemon's fatal path runs) and the error is cached here so every
// awaiter (queries via `waitForMigrationsBeforeQuery`, startup via
// `ensureMigrations`) can re-check and rethrow it. The failure is sticky: we
// never null `migrationsPromise` to auto-retry (see issues #2784/#2786/#2796).
let migrationsError: Error | null = null;

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
  if (migrationsRun) {
    return;
  }

  if (migrationsPromise) {
    await migrationsPromise;
  }

  if (migrationsError) {
    throw migrationsError;
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
      lock: createFileMigrationLock(dbPath),
      backup: () => backupDatabaseFile(migrationDb, dbPath),
    });
    migrationsRun = true;
  } catch (error) {
    logger.error("Failed to run migrations on database initialization:", error);
    throw error;
  } finally {
    await migrationDb.destroy();
  }
}

function ensureMigrationsStarted(dbPath: string): void {
  if (!migrationsRun && !migrationsPromise) {
    // Resolve (never reject) so a failed migration does not float an unhandled
    // rejection; cache the error for synchronous re-checking by awaiters.
    migrationsPromise = startMigrations(dbPath).then(
      () => {
        migrationsError = null;
      },
      error => {
        migrationsError = createStartupMigrationError(error);
      }
    );
  }
}

function ensureDatabaseDirectory(dbPath: string): void {
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
  if (migrationsRun) {
    return;
  }

  if (!dbInstance) {
    getDatabase();
  }

  ensureMigrationsStarted(resolveDbPath());

  await migrationsPromise;

  // Under the resolved-promise model the await above never rejects; re-check the
  // cached error so a startup migration failure stays fatal for callers that
  // await migrations at startup (e.g. Daemon.initializeDatabase — issue #2784).
  if (migrationsError) {
    throw migrationsError;
  }
}

/**
 * The cached startup-migration failure, or null if migrations succeeded or have
 * not yet failed. Used by the daemon health/liveness path to detect a query-dead
 * DB without floating a rejection.
 */
export function getMigrationsError(): Error | null {
  return migrationsError;
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

  // Reset the module-global state that outlives the connection so a same-process
  // reopen behaves like a cold start (issue #2796). These are reset
  // unconditionally — outside the `if (dbInstance)` guard — so a
  // partially-initialized state (migrations started but `dbInstance` already
  // nulled) is still cleaned up.
  //
  // - `migrationsRun` / `migrationsPromise` / `migrationsError` are one state
  //   machine; leaving any set would let `ensureMigrationsStarted()` no-op and
  //   `waitForMigrationsBeforeQuery()` short-circuit (skipping migration gating
  //   on the new connection), or rethrow a stale startup error against an
  //   otherwise-healthy reopened DB.
  // - `resolvedDbPath` is cleared so a reopen re-reads AUTOMOBILE_DB_PATH /
  //   AUTOMOBILE_DB_DIR. In the daemon the only caller is shutdown-then-exit
  //   (daemon.ts), so this is inert there and the "path always matches" invariant
  //   from resolveDbPath() holds; the reset is what gives tests full isolation.
  migrationsRun = false;
  migrationsPromise = null;
  migrationsError = null;
  resolvedDbPath = null;

  // Cold-start the write barrier too (issue #2896, follow-up to #2796). Its
  // draining flag latches for the process lifetime, so shutdown's
  // `getDbWriteBarrier().drain(...)` before this close (issue #2792 ordering)
  // would otherwise leave the shared barrier permanently draining. Any future
  // in-process reopen (config reload / DB path switch / restart-without-exit)
  // would then silently skip every tracked best-effort write against the
  // reopened DB. Resetting here makes the "reopen behaves like a cold start"
  // contract fully true instead of carrying a barrier-shaped exception. Inert
  // in the daemon, where the only caller is shutdown-then-`process.exit`.
  resetDbWriteBarrier();
}

/**
 * Get the database file path.
 */
export function getDatabasePath(): string {
  return resolveDbPath();
}
