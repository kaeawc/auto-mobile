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
import type { MigrationLock } from "./migrationLock";
import { NoOpMigrationLock } from "./migrationLock";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

const DISABLED_RECOVERY_VALUES = new Set(["0", "false", "no", "off"]);

/** Kysely seeds this lock table with one row; it must be ignored by the populated-DB check. */
const MIGRATION_LOCK_TABLE = `${DEFAULT_MIGRATION_TABLE}_lock`;

/**
 * Write a backup of the database before a destructive migration reset drops
 * user tables. Injected so unit tests (and `:memory:` databases, which have no
 * file) can assert "backup was called" without touching the filesystem.
 */
type BackupDatabase = () => Promise<void>;

/** Count rows in a single table. Seam so the fail-safe path can be unit-tested. */
type CountTableRows = (db: Kysely<unknown>, tableName: string) => Promise<number>;

export interface RunMigrationsOptions {
  /** Override the migration source (defaults to the on-disk migration folder). */
  provider?: MigrationProvider;
  /** Backup mechanism invoked before a destructive reset drops a populated DB. */
  backup?: BackupDatabase;
  /** Environment to read recovery gates from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Cross-process lock serializing the migration run so two openers on the same
   * DB file can't both enter `migrateToLatest()` and collide on the
   * `kysely_migration` PRIMARY KEY (issue #2794). Defaults to a no-op lock —
   * correct for `:memory:` databases and the single-daemon path (already
   * serialized by the in-process mutex). Production callers pass a file lock
   * keyed to the resolved DB path (see `database.ts#startMigrations`).
   */
  lock?: MigrationLock;
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
  return (env.AUTOMOBILE_MIGRATION_RECOVERY ?? env.AUTO_MOBILE_MIGRATION_RECOVERY)?.trim();
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
  return readRecoveryEnv(env) === "1";
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
    .addColumn("name", "varchar(255)", (col) => col.notNull().primaryKey())
    .addColumn("timestamp", "varchar(255)", (col) => col.notNull())
    .ifNotExists()
    .execute();
}

async function rebuildMigrationTable(
  db: Kysely<unknown>,
  migrator: Migrator,
  timer: Timer = defaultTimer,
): Promise<{ pruned: string[]; kept: string[] }> {
  const hasMigrationTable = await tableExists(db, DEFAULT_MIGRATION_TABLE);
  if (!hasMigrationTable) {
    return { pruned: [], kept: [] };
  }

  const availableMigrations = await migrator.getMigrations();
  const availableNames = new Set(availableMigrations.map((migration) => migration.name));
  const executedRows = await db
    .selectFrom(DEFAULT_MIGRATION_TABLE as any)
    .select(["name", "timestamp"])
    .execute();

  const pruned = executedRows.filter((row) => !availableNames.has(row.name)).map((row) => row.name);
  const executedSet = new Set(
    executedRows.filter((row) => availableNames.has(row.name)).map((row) => row.name),
  );
  const kept = availableMigrations
    .map((migration) => migration.name)
    .filter((name) => executedSet.has(name));

  await ensureMigrationTableExists(db);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom(DEFAULT_MIGRATION_TABLE as any).execute();

    if (kept.length > 0) {
      const baseTimestamp = timer.now();
      await trx
        .insertInto(DEFAULT_MIGRATION_TABLE as any)
        .values(
          kept.map((name, index) => ({
            name,
            timestamp: new Date(baseTimestamp + index).toISOString(),
          })),
        )
        .execute();
    }
  });

  return { pruned, kept };
}

/**
 * Classify a corrupted-migrations state as benign forward version-skew: every
 * migration this build ships is already recorded as executed, and the only
 * unrecognized ledger rows are lexically newer than the newest migration this
 * build knows about — i.e. a NEWER build ran ahead against the same shared DB
 * (issue #5684).
 *
 * In that case this build has nothing to do and MUST NOT rewrite the ledger.
 * Pruning those newer rows (the pre-#5684 rebuild behavior) is what converts a
 * harmless version skew into a churn loop: the newer daemon re-runs the pruned
 * migration on its next start, and with two builds alternating on one DB the
 * ledger is rewritten back and forth indefinitely.
 *
 * Anything else — a known migration not yet applied, or an unknown row that
 * sorts at or before the newest known migration (out-of-order / renamed /
 * middle-inserted) — is NOT forward skew and falls through to the existing
 * destructive rebuild/reset recovery. `availableNames` must be sorted (Kysely's
 * `Migrator.getMigrations()` guarantees this).
 *
 * Two conventions this repo already upholds keep the no-op safe; a future
 * maintainer must not break either (issue #5684):
 *   1. A shipped migration's body is immutable given its name. Like Kysely
 *      itself (which never re-runs an applied name), this trusts name == applied;
 *      re-bodying a released migration would let the no-op accept a divergent
 *      schema silently.
 *   2. Migration names are globally monotonic and append-only across releases,
 *      so a newer mainline build's migrations always sort AFTER an older build's
 *      newest. Branch divergence that interleaves names is deliberately treated
 *      as corruption (condition 2 returns false), not forward skew.
 */
export function isBenignForwardSkew(availableNames: string[], executedNames: string[]): boolean {
  // A build that ships no migrations cannot distinguish "newer build ran ahead"
  // from "everything is unknown"; stay conservative and let recovery decide.
  if (availableNames.length === 0) {
    return false;
  }

  const availableSet = new Set(availableNames);
  const executedSet = new Set(executedNames);

  // (1) Every migration this build knows about must already be applied.
  for (const name of availableNames) {
    if (!executedSet.has(name)) {
      return false;
    }
  }

  // (2) Every executed row this build does not recognize must be strictly newer
  //     than the newest migration it ships. Compare with the same default
  //     code-unit ordering that selected `newestKnown` (Kysely sorts the
  //     available set with `Array#sort`); using `localeCompare` here could
  //     disagree on case/diacritics against a code-unit-chosen `newestKnown`.
  const newestKnown = availableNames[availableNames.length - 1];
  for (const name of executedNames) {
    if (!availableSet.has(name) && name <= newestKnown) {
      return false;
    }
  }

  return true;
}

/**
 * Read the ledger and this build's migration set, and report whether the
 * corrupted-migrations state is benign forward version-skew (see
 * {@link isBenignForwardSkew}).
 */
async function isForwardVersionSkew(db: Kysely<unknown>, migrator: Migrator): Promise<boolean> {
  if (!(await tableExists(db, DEFAULT_MIGRATION_TABLE))) {
    return false;
  }
  const availableNames = (await migrator.getMigrations()).map((migration) => migration.name);
  // Raw sql (like defaultCountTableRows) rather than selectFrom(... as any), which
  // resolves to `never` under Kysely<unknown> and would add a fresh typecheck-
  // baseline error.
  const executedRows = await sql<{ name: string }>`select name from ${sql.table(
    DEFAULT_MIGRATION_TABLE,
  )}`.execute(db);
  const executedNames = executedRows.rows.map((row) => row.name);
  return isBenignForwardSkew(availableNames, executedNames);
}

const defaultCountTableRows: CountTableRows = async (db, tableName) => {
  const result = await sql<{ count: number }>`select count(*) as count from ${sql.table(
    tableName,
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
  countTableRows: CountTableRows = defaultCountTableRows,
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
        error,
      );
      return true;
    }
  }
  return false;
}

/**
 * Drop every user + bookkeeping table so the migrations can replay from scratch.
 * Production connections run with `PRAGMA foreign_keys = ON` (see
 * `configureSqliteDatabase`) and the schema has non-cascade FKs (e.g.
 * `scroll_positions.target_element_id` -> `ui_elements.id`), so dropping a parent
 * before its still-populated child would otherwise abort mid-reset with
 * `FOREIGN KEY constraint failed`, leaving a half-dropped database. Running the
 * drops inside a single transaction with `defer_foreign_keys` defers enforcement
 * to commit — by which point every referencing table is also gone — while leaving
 * the connection's `foreign_keys` pragma untouched (it auto-resets at commit).
 */
async function dropAllTables(db: Kysely<unknown>, tableNames: string[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`PRAGMA defer_foreign_keys = ON`.execute(trx);
    for (const name of tableNames) {
      await trx.schema.dropTable(name).ifExists().execute();
    }
  });
}

interface MigrationHistoryRow {
  name: string;
  timestamp: string;
}

/** Snapshot the current migration history so it can be restored if recovery refuses. */
async function snapshotMigrationHistory(
  db: Kysely<unknown>,
): Promise<MigrationHistoryRow[] | null> {
  if (!(await tableExists(db, DEFAULT_MIGRATION_TABLE))) {
    return null;
  }
  const rows = await db
    .selectFrom(DEFAULT_MIGRATION_TABLE as any)
    .select(["name", "timestamp"])
    .execute();
  return rows.map((row) => ({ name: String(row.name), timestamp: String(row.timestamp) }));
}

/** Replace the migration history with a previously captured snapshot. */
async function restoreMigrationHistory(
  db: Kysely<unknown>,
  snapshot: MigrationHistoryRow[],
): Promise<void> {
  await ensureMigrationTableExists(db);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom(DEFAULT_MIGRATION_TABLE as any).execute();
    if (snapshot.length > 0) {
      await trx
        .insertInto(DEFAULT_MIGRATION_TABLE as any)
        .values(snapshot)
        .execute();
    }
  });
}

async function resetDatabaseState(
  db: Kysely<unknown>,
  options: RunMigrationsOptions,
  env: NodeJS.ProcessEnv,
  originalHistory: MigrationHistoryRow[] | null,
): Promise<void> {
  const tables = await db
    .selectFrom("sqlite_master" as any)
    .select("name")
    .where("type", "=", "table")
    .where("name", "not like", "sqlite_%")
    .execute();

  const tableNames = tables.map((table) => String(table.name));
  // Exclude BOTH migration-bookkeeping tables from the populated check: the
  // history table always has rows post-rebuild, and the lock table is seeded
  // with one row — counting either would false-positive a genuinely empty user
  // DB and break the frictionless empty-DB auto-heal. They are still dropped
  // below so the replay gets a clean slate.
  const userTables = tableNames.filter(
    (name) => name !== DEFAULT_MIGRATION_TABLE && name !== MIGRATION_LOCK_TABLE,
  );

  const populated = await isAnyTableNonEmpty(db, userTables);

  if (populated && originalHistory) {
    // The safe rebuild already committed a rewrite of `kysely_migration`. Put the
    // original history back before we either refuse or back up, so a refusal leaves
    // the database exactly as we found it (no post-refusal wedge once the operator
    // fixes the branch) and an opted-in backup snapshots the true pre-recovery
    // state rather than the rebuilt one.
    await restoreMigrationHistory(db, originalHistory);
  }

  if (populated && !isDestructiveResetExplicitlyOptedIn(env)) {
    throw new ActionableError(
      "Refusing to drop a populated database during migration recovery. The safe " +
        "migration-history rebuild was already attempted and the migrations are still " +
        "corrupted (most likely an out-of-order or renamed migration). Your data and the " +
        "original migration history have been left untouched — fix the migration " +
        "ordering/name, or set AUTOMOBILE_MIGRATION_RECOVERY=1 to allow a destructive reset " +
        "(a timestamped backup of the database is written first).",
    );
  }

  if (populated) {
    if (!options.backup) {
      throw new ActionableError(
        "Refusing to drop a populated database during migration recovery: no backup " +
          "mechanism is available to preserve the data before the destructive reset.",
      );
    }
    await options.backup();
  }

  await dropAllTables(db, tableNames);
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

/**
 * Handle a failed migration run: attempt recovery when the error is a corrupted
 * migration history and recovery is enabled, otherwise rethrow. Extracted from
 * {@link runMigrations} so the nested branching lives in its own depth budget.
 * Returns normally when the database is healthy (recovered, or benign forward
 * skew); throws otherwise.
 */
async function handleMigrationFailure(
  db: Kysely<unknown>,
  migrator: Migrator,
  error: unknown,
  options: RunMigrationsOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (isCorruptedMigrationError(error) && isMigrationRecoveryEnabled(env)) {
    // A newer build migrated this shared DB ahead of us; every migration we ship
    // is already applied. Leave the ledger untouched instead of pruning the newer
    // rows, which would make the newer daemon re-run them and churn the history
    // back and forth (issue #5684).
    if (await isForwardVersionSkew(db, migrator)) {
      logger.info(
        "Migration ledger records migrations newer than this build ships and all " +
          "known migrations are already applied; a newer build migrated this database. " +
          "Leaving migration history untouched (issue #5684).",
      );
      return;
    }

    const recoveryResult = await recoverCorruptedMigrations(db, migrator, error, options, env);
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
        "recovery or reset the local database state.",
    );
  }

  logger.error("Failed to run migrations:", error);
  throw error;
}

async function recoverCorruptedMigrations(
  db: Kysely<unknown>,
  migrator: Migrator,
  error: Error,
  options: RunMigrationsOptions,
  env: NodeJS.ProcessEnv,
) {
  logger.warn(`Corrupted migrations detected: ${error.message}`);
  logger.warn(
    "Attempting automatic recovery by rebuilding migration history (destructive). " +
      "Set AUTOMOBILE_MIGRATION_RECOVERY=0 to disable.",
  );

  // Capture the history BEFORE the rebuild rewrites it, so a later refusal on a
  // populated DB can restore the original state instead of leaving it wedged.
  const originalHistory = await snapshotMigrationHistory(db);

  const rebuildResult = await rebuildMigrationTable(db, migrator);
  if (rebuildResult.pruned.length > 0) {
    logger.warn(
      `Pruned missing migrations from history (destructive): ${rebuildResult.pruned.join(", ")}`,
    );
  } else {
    logger.warn("Rebuilt migration history table to match existing migrations (destructive).");
  }

  let result = await runMigrationsOnce(migrator);
  if (!result.error) {
    return result;
  }

  logger.warn("Migration recovery failed after rebuild. Resetting database state (destructive).");
  await resetDatabaseState(db, options, env, originalHistory);
  result = await runMigrationsOnce(migrator);
  return result;
}

/**
 * Run all pending database migrations.
 *
 * `options.lock` serializes the run across processes so two openers pointed at
 * the same DB file can't both enter `migrateToLatest()` and collide on the
 * `kysely_migration` PRIMARY KEY (issue #2794). The default is a no-op lock —
 * correct for `:memory:` databases and the single-daemon path, which is already
 * serialized by the in-process mutex. Production callers pass a file lock keyed
 * to the resolved DB path (see `database.ts#startMigrations`). The lock is
 * always released, even when the migration throws.
 */
export async function runMigrations(
  db: Kysely<unknown>,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const lock = options.lock ?? new NoOpMigrationLock();

  await lock.acquire();
  try {
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
      await handleMigrationFailure(db, migrator, error, options, env);
      return;
    }

    logger.info("All migrations completed successfully");
  } finally {
    await lock.release();
  }
}
