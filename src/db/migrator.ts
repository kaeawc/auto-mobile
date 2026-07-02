import { Kysely, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { Migrator, FileMigrationProvider, DEFAULT_MIGRATION_TABLE } from "kysely/migration";
import { existsSync, promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { ActionableError } from "../models/ActionableError";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

const DISABLED_RECOVERY_VALUES = new Set(["0", "false", "no", "off"]);

/** Kysely seeds this lock table with one row; it must be ignored by the populated-DB check. */
const MIGRATION_LOCK_TABLE = `${DEFAULT_MIGRATION_TABLE}_lock`;

/**
 * Write a backup of the database before a destructive migration reset drops
 * user tables. Injected so unit tests (and `:memory:` databases, which have no
 * file) can assert "backup was called" without touching the filesystem.
 */
export type BackupDatabase = () => Promise<void>;

/** Count rows in a single table. Seam so the fail-safe path can be unit-tested. */
export type CountTableRows = (db: Kysely<unknown>, tableName: string) => Promise<number>;

export interface RunMigrationsOptions {
  /** Override the migration source (defaults to the on-disk migration folder). */
  provider?: MigrationProvider;
  /** Backup mechanism invoked before a destructive reset drops a populated DB. */
  backup?: BackupDatabase;
  /** Environment to read recovery gates from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Timer seam for the history-rebuild timestamps. */
  timer?: Timer;
}

export function resolveMigrationFolder(): string {
  // @deprecated AUTO_MOBILE_MIGRATIONS_DIR - use AUTOMOBILE_MIGRATIONS_DIR instead
  const envPath = process.env.AUTOMOBILE_MIGRATIONS_DIR ?? process.env.AUTO_MOBILE_MIGRATIONS_DIR;
  if (envPath) {
    return resolvePathFromDaemonLaunchWorkingDirectory(envPath);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(moduleDir, "migrations"), path.join(moduleDir, "db", "migrations")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Migrations folder not found. Checked: ${candidates.join(", ")}`);
}

function readRecoveryEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.AUTOMOBILE_MIGRATION_RECOVERY ?? env.AUTO_MOBILE_MIGRATION_RECOVERY;
}

function isMigrationRecoveryEnabled(env: NodeJS.ProcessEnv): boolean {
  const envValue = readRecoveryEnv(env);
  if (!envValue) {
    return true;
  }
  return !DISABLED_RECOVERY_VALUES.has(envValue.toLowerCase());
}

/**
 * The destructive reset (dropping every user table) is a strictly stricter gate
 * than {@link isMigrationRecoveryEnabled}: it requires an explicit `1`, not merely
 * a non-falsy value. So `AUTOMOBILE_MIGRATION_RECOVERY=true` keeps the safe
 * history rebuild enabled but REFUSES the destructive reset, while `=1` allows both.
 */
function isDestructiveResetExplicitlyOptedIn(env: NodeJS.ProcessEnv): boolean {
  return readRecoveryEnv(env)?.trim() === "1";
}

function isCorruptedMigrationError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("corrupted migrations");
}

async function tableExists(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await db
    .selectFrom("sqlite_master" as any)
    .select("name")
    .where("type", "=", "table")
    .where("name", "=", tableName)
    .executeTakeFirst();

  return result !== undefined;
}

async function ensureMigrationTableExists(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(DEFAULT_MIGRATION_TABLE)
    .addColumn("name", "varchar(255)", col => col.notNull().primaryKey())
    .addColumn("timestamp", "varchar(255)", col => col.notNull())
    .ifNotExists()
    .execute();
}

async function rebuildMigrationTable(
  db: Kysely<unknown>,
  migrator: Migrator,
  timer: Timer = defaultTimer
): Promise<{ pruned: string[]; kept: string[] }> {
  const hasMigrationTable = await tableExists(db, DEFAULT_MIGRATION_TABLE);
  if (!hasMigrationTable) {
    return { pruned: [], kept: [] };
  }

  const availableMigrations = await migrator.getMigrations();
  const availableNames = new Set(availableMigrations.map(migration => migration.name));
  const executedRows = await db
    .selectFrom(DEFAULT_MIGRATION_TABLE as any)
    .select(["name", "timestamp"])
    .execute();

  const pruned = executedRows
    .filter(row => !availableNames.has(row.name))
    .map(row => row.name);
  const executedSet = new Set(
    executedRows.filter(row => availableNames.has(row.name)).map(row => row.name)
  );
  const kept = availableMigrations.map(migration => migration.name).filter(name => executedSet.has(name));

  await ensureMigrationTableExists(db);

  await db.transaction().execute(async trx => {
    await trx.deleteFrom(DEFAULT_MIGRATION_TABLE as any).execute();

    if (kept.length > 0) {
      const baseTimestamp = timer.now();
      await trx
        .insertInto(DEFAULT_MIGRATION_TABLE as any)
        .values(
          kept.map((name, index) => ({
            name,
            timestamp: new Date(baseTimestamp + index).toISOString(),
          }))
        )
        .execute();
    }
  });

  return { pruned, kept };
}

const defaultCountTableRows: CountTableRows = async (db, tableName) => {
  const result = await sql<{ count: number }>`select count(*) as count from ${sql.table(
    tableName
  )}`.execute(db);
  return Number(result.rows[0]?.count ?? 0);
};

/**
 * Returns true if any of the given tables has at least one row. Fails safe: if a
 * count throws (a torn schema is exactly why recovery is running), assume the DB
 * is populated and refuse the destructive reset — never swallow the error.
 */
export async function isAnyTableNonEmpty(
  db: Kysely<unknown>,
  tableNames: string[],
  countTableRows: CountTableRows = defaultCountTableRows
): Promise<boolean> {
  for (const tableName of tableNames) {
    try {
      if ((await countTableRows(db, tableName)) > 0) {
        return true;
      }
    } catch (error) {
      logger.warn(
        `Row-count during migration recovery failed for table "${tableName}"; ` +
          "assuming the database is populated and refusing the destructive reset.",
        error
      );
      return true;
    }
  }
  return false;
}

async function resetDatabaseState(
  db: Kysely<unknown>,
  options: RunMigrationsOptions
): Promise<void> {
  const tables = await db
    .selectFrom("sqlite_master" as any)
    .select("name")
    .where("type", "=", "table")
    .where("name", "not like", "sqlite_%")
    .execute();

  const tableNames = tables.map(table => String(table.name));
  // Exclude BOTH migration-bookkeeping tables from the populated check: the
  // history table always has rows post-rebuild, and the lock table is seeded
  // with one row — counting either would false-positive a genuinely empty user
  // DB and break the frictionless empty-DB auto-heal.
  const userTables = tableNames.filter(
    name => name !== DEFAULT_MIGRATION_TABLE && name !== MIGRATION_LOCK_TABLE
  );

  const env = options.env ?? process.env;
  const populated = await isAnyTableNonEmpty(db, userTables);

  if (populated && !isDestructiveResetExplicitlyOptedIn(env)) {
    throw new ActionableError(
      "Refusing to drop a populated database during migration recovery. The safe " +
        "migration-history rebuild was already attempted and the migrations are still " +
        "corrupted (most likely an out-of-order or renamed migration). Fix the migration " +
        "ordering/name, or set AUTOMOBILE_MIGRATION_RECOVERY=1 to allow a destructive reset " +
        "(a timestamped backup of the database is written first)."
    );
  }

  if (populated) {
    if (!options.backup) {
      throw new ActionableError(
        "Refusing to drop a populated database during migration recovery: no backup " +
          "mechanism is available to preserve the data before the destructive reset."
      );
    }
    await options.backup();
  }

  for (const name of tableNames) {
    await db.schema.dropTable(name).ifExists().execute();
  }
}

async function runMigrationsOnce(migrator: Migrator) {
  const result = await migrator.migrateToLatest();

  if (result.results) {
    for (const item of result.results) {
      if (item.status === "Success") {
        logger.info(`Migration "${item.migrationName}" executed successfully`);
      } else if (item.status === "Error") {
        logger.error(`Migration "${item.migrationName}" failed`);
      }
    }
  }

  return result;
}

async function recoverCorruptedMigrations(
  db: Kysely<unknown>,
  migrator: Migrator,
  error: Error,
  options: RunMigrationsOptions
) {
  logger.warn(`Corrupted migrations detected: ${error.message}`);
  logger.warn(
    "Attempting automatic recovery by rebuilding migration history (destructive). " +
      "Set AUTOMOBILE_MIGRATION_RECOVERY=0 to disable."
  );

  const rebuildResult = await rebuildMigrationTable(db, migrator, options.timer ?? defaultTimer);
  if (rebuildResult.pruned.length > 0) {
    logger.warn(
      `Pruned missing migrations from history (destructive): ${rebuildResult.pruned.join(", ")}`
    );
  } else {
    logger.warn("Rebuilt migration history table to match existing migrations (destructive).");
  }

  let result = await runMigrationsOnce(migrator);
  if (!result.error) {
    return result;
  }

  logger.warn("Migration recovery failed after rebuild. Resetting database state (destructive).");
  await resetDatabaseState(db, options);
  result = await runMigrationsOnce(migrator);
  return result;
}

/**
 * Run all pending database migrations
 */
export async function runMigrations(
  db: Kysely<unknown>,
  options: RunMigrationsOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  const migrator = new Migrator({
    db,
    provider:
      options.provider ??
      new FileMigrationProvider({
        fs,
        path,
        migrationFolder: resolveMigrationFolder(),
      }),
  });

  const { error } = await runMigrationsOnce(migrator);

  if (error) {
    if (isCorruptedMigrationError(error) && isMigrationRecoveryEnabled(env)) {
      const recoveryResult = await recoverCorruptedMigrations(db, migrator, error, options);
      if (recoveryResult.error) {
        logger.error("Failed to run migrations after recovery:", recoveryResult.error);
        throw recoveryResult.error;
      }
      logger.info("All migrations completed successfully");
      return;
    }

    if (isCorruptedMigrationError(error) && !isMigrationRecoveryEnabled(env)) {
      logger.error(
        "Corrupted migrations detected. Set AUTOMOBILE_MIGRATION_RECOVERY=1 to enable automatic " +
          "recovery or reset the local database state."
      );
    }

    logger.error("Failed to run migrations:", error);
    throw error;
  }

  logger.info("All migrations completed successfully");
}
