import { Kysely } from "kysely";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import type { Database as DatabaseSchema } from "./types";
import { runMigrations } from "./migrator";
import { logger } from "../utils/logger";
import { BunSqliteDialect } from "./bunSqliteDialect";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

type BunDatabaseConstructor = typeof import("bun:sqlite").Database;

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

/**
 * Get the singleton database instance.
 * Creates the database file and directory if they don't exist.
 */
export function getDatabase(): Kysely<DatabaseSchema> {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    const dbDir = path.dirname(dbPath);

    // Ensure directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Use Bun's built-in SQLite
    const BunDatabaseConstructor = resolveBunDatabaseConstructor();
    const sqliteDb = new BunDatabaseConstructor(dbPath);
    configureSqliteDatabase(sqliteDb);

    dbInstance = new Kysely<DatabaseSchema>({
      dialect: new BunSqliteDialect({
        database: sqliteDb,
      }),
    });

    // Run migrations if not already run
    if (!migrationsRun && !migrationsPromise) {
      migrationsPromise = runMigrations(dbInstance as Kysely<unknown>)
        .then(() => {
          migrationsRun = true;
        })
        .catch(error => {
          logger.error("Failed to run migrations on database initialization:", error);
          throw error;
        });
    }
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

  if (!migrationsPromise) {
    migrationsPromise = runMigrations(dbInstance as Kysely<unknown>)
      .then(() => {
        migrationsRun = true;
      })
      .catch(error => {
        logger.error("Failed to run migrations on database initialization:", error);
        throw error;
      });
  }

  await migrationsPromise;
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
}

/**
 * Get the database file path.
 */
export function getDatabasePath(): string {
  return resolveDbPath();
}
