import * as registryWriters017 from "./migrations/2026_10_31_017_binding_registry_writers";
import { getMcpServerVersion } from "../../../utils/mcpVersion";
import { logger } from "../../../utils/logger";
import * as resourceIndexes011 from "./migrations/2026_10_20_011_session_broker_resource_indexes";
import * as deviceMutations012 from "./migrations/2026_10_21_012_device_mutation_journal";
import * as brokerTiming013 from "./migrations/2026_10_21_013_session_broker_timing";
import * as deviceClaims014 from "./migrations/2026_10_26_014_device_claims";
import * as deviceClaimsMetadata015 from "./migrations/2026_10_27_015_device_claims_metadata";
import * as watchosPlatform016 from "./migrations/2026_10_30_016_watchos_binding_platform";
import { sql, type Kysely } from "kysely";
import type { BunSqliteHandle } from "../../../db/bunSqliteDialect";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { selectMigrationLock } from "../../../db/migrationLock";
import { BindingRegistrySchemaUnsupportedError } from "../provisioning/refusal";
import * as retireSlot008 from "./migrations/2026_10_16_008_retire_slot_features";
import * as bindingRegistry000 from "./migrations/2026_10_09_000_binding_registry";
import * as bindingRegistry001 from "./migrations/2026_10_09_001_binding_owner_fencing";
import * as bindingJournal002 from "./migrations/2026_10_09_002_binding_journal";
import * as freeDeviceDeletion004 from "./migrations/2026_10_12_004_free_device_deletion";
import * as freeDeviceDeletionFailedDeletes005 from "./migrations/2026_10_13_005_free_device_deletion_failed_deletes";
import * as freeDeviceStop003 from "./migrations/2026_10_10_003_free_device_stop_state";
import * as sessionBrokerFailure007 from "./migrations/2026_10_15_007_session_broker_failure_retryable";
import * as sessionBroker006 from "./migrations/2026_10_15_006_session_broker";
import * as sessionBrokerExports010 from "./migrations/2026_10_19_010_session_broker_exports";
import * as receiptRetention009 from "./migrations/2026_10_16_009_session_broker_receipt_retention";

export const BROKER_TIMING_MIGRATION = "2026_10_21_013_session_broker_timing";
export const BINDING_REGISTRY_WRITERS_MIGRATION = "2026_10_31_017_binding_registry_writers";

/**
 * The binding registry's own migration set (#11174). Statically imported rather than read from a
 * folder so the bundled daemon always carries them and they can never mix with the per-daemon
 * `auto-mobile.db` migration folder.
 */
export const BINDING_REGISTRY_MIGRATIONS: Readonly<Record<string, Migration>> = {
  "2026_10_09_000_slot_registry": bindingRegistry000,
  "2026_10_09_001_slot_owner_fencing": bindingRegistry001,
  "2026_10_09_002_slot_journal": bindingJournal002,
  "2026_10_10_003_free_device_stop_state": freeDeviceStop003,
  "2026_10_12_004_free_device_deletion": freeDeviceDeletion004,
  "2026_10_13_005_free_device_deletion_failed_deletes": freeDeviceDeletionFailedDeletes005,
  "2026_10_15_006_session_broker": sessionBroker006,
  "2026_10_15_007_session_broker_failure_retryable": sessionBrokerFailure007,
  "2026_10_16_008_retire_slot_features": retireSlot008,
  "2026_10_16_009_session_broker_receipt_retention": receiptRetention009,
  "2026_10_19_010_session_broker_exports": sessionBrokerExports010,
  "2026_10_20_011_session_broker_resource_indexes": resourceIndexes011,
  "2026_10_21_012_device_mutation_journal": deviceMutations012,
  [BROKER_TIMING_MIGRATION]: brokerTiming013,
  "2026_10_26_014_device_claims": deviceClaims014,
  "2026_10_27_015_device_claims_metadata": deviceClaimsMetadata015,
  "2026_10_30_016_watchos_binding_platform": watchosPlatform016,
  [BINDING_REGISTRY_WRITERS_MIGRATION]: registryWriters017,
};

export const KNOWN_BINDING_REGISTRY_SCHEMA_VERSION = Object.keys(BINDING_REGISTRY_MIGRATIONS).at(
  -1,
)!;

export interface BindingRegistrySchemaDescription {
  schemaVersion: string | null;
  knownSchemaVersion: string;
  supported: boolean;
  writerVersion: string | null;
}

/** Record provenance on the migrator's handle so schema and writer identity commit together. */
export function withBindingRegistryMigrationWriters(
  migrations: Readonly<Record<string, Migration>>,
  writerVersion: () => string = getMcpServerVersion,
): Record<string, Migration> {
  return Object.fromEntries(
    Object.entries(migrations).map(([name, migration]) => {
      if (name < BINDING_REGISTRY_WRITERS_MIGRATION) {
        return [name, migration];
      }
      const wrapped: Migration = {
        async up(db) {
          await migration.up(db);
          await sql`INSERT OR IGNORE INTO binding_registry_migration_writers
            (migration_name, writer_version, recorded_at)
            VALUES (${name}, ${writerVersion()}, ${new Date().toISOString()})`.execute(db);
        },
        async down(db) {
          await sql`DELETE FROM binding_registry_migration_writers
            WHERE migration_name = ${name}`.execute(db);
          await migration.down?.(db);
        },
      };
      return [name, wrapped];
    }),
  );
}

export function bindingRegistryMigrationProviderFor(writerVersion?: string): MigrationProvider {
  return {
    getMigrations: async () =>
      withBindingRegistryMigrationWriters(
        BINDING_REGISTRY_MIGRATIONS,
        () => writerVersion ?? getMcpServerVersion(),
      ),
  };
}

export const bindingRegistryMigrationProvider = bindingRegistryMigrationProviderFor();

/** One read-only probe, implemented on the already-open registry connection. */
export interface BindingRegistrySchemaProbe {
  assertSupportedSchema(): Promise<void>;
  describeSchema(): Promise<BindingRegistrySchemaDescription>;
}

/** Shared by open-time guards and resident readers; never writes migration bookkeeping. */
export async function assertSupportedRegistrySchema<DB>(
  db: Kysely<DB>,
  dbPath: string,
): Promise<void> {
  const executed = await readRegistryMigrations(db);
  const unknownMigrations = unknownRegistryMigrations(executed);
  if (unknownMigrations.length > 0) {
    throw new BindingRegistrySchemaUnsupportedError(
      dbPath,
      unknownMigrations,
      await readBindingRegistryWriterVersions(db, unknownMigrations),
    );
  }
}

async function registryTableExists<DB>(db: Kysely<DB>, tableName: string): Promise<boolean> {
  const table = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}
  `.execute(db);
  return table.rows.length > 0;
}

async function readRegistryMigrations<DB>(db: Kysely<DB>): Promise<string[]> {
  const executed = await sql<{
    name: string;
  }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  return executed.rows.map(({ name }) => name);
}

function unknownRegistryMigrations(executed: readonly string[]): string[] {
  return executed.filter((name) => !Object.hasOwn(BINDING_REGISTRY_MIGRATIONS, name));
}

/** Optional provenance must never replace the typed compatibility refusal with a lookup error. */
function registryWriterVersionsQuery(migrationNames: readonly string[]) {
  return sql<{ migration_name: string; writer_version: string }>`
    SELECT migration_name, writer_version FROM binding_registry_migration_writers
    WHERE migration_name IN (${sql.join(migrationNames)})
  `;
}

/** Same optional provenance lookup on the guarded transaction's physical SQLite connection. */
export function readBindingRegistryWriterVersionsSync<DB>(
  db: Kysely<DB>,
  sqlite: BunSqliteHandle,
  migrationNames: readonly string[],
): Readonly<Record<string, string>> {
  if (migrationNames.length === 0) {
    return {};
  }
  try {
    const table = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    try {
      if (!table.get("binding_registry_migration_writers")) {
        return {};
      }
    } finally {
      table.finalize();
    }
    const query = registryWriterVersionsQuery(migrationNames).compile(db);
    const statement = sqlite.prepare(query.sql);
    try {
      return Object.fromEntries(
        statement.all(...query.parameters).map((row) => {
          if (
            typeof row !== "object" ||
            row === null ||
            !("migration_name" in row) ||
            typeof row.migration_name !== "string" ||
            !("writer_version" in row) ||
            typeof row.writer_version !== "string"
          ) {
            throw new ActionableError("Invalid binding registry migration writer version");
          }
          return [row.migration_name, row.writer_version];
        }),
      );
    } finally {
      statement.finalize();
    }
  } catch (error) {
    logger.warn("[Bindings] Cannot read registry migration writer versions", error);
    return {};
  }
}

/** Optional provenance must never replace the typed compatibility refusal with a lookup error. */
export async function readBindingRegistryWriterVersions<DB>(
  db: Kysely<DB>,
  migrationNames: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  if (migrationNames.length === 0) {
    return {};
  }
  try {
    if (!(await registryTableExists(db, "binding_registry_migration_writers"))) {
      return {};
    }
    const result = await registryWriterVersionsQuery(migrationNames).execute(db);
    return Object.fromEntries(result.rows.map((row) => [row.migration_name, row.writer_version]));
  } catch (error) {
    logger.warn("[Bindings] Cannot read registry migration writer versions", error);
    return {};
  }
}

/** Describes the on-disk schema on the resident connection without opening or migrating it. */
export async function describeBindingRegistrySchema<DB>(
  db: Kysely<DB>,
): Promise<BindingRegistrySchemaDescription> {
  const executed = (await registryTableExists(db, "kysely_migration"))
    ? await readRegistryMigrations(db)
    : [];
  const schemaVersion = executed.at(-1) ?? null;
  const writers = await readBindingRegistryWriterVersions(
    db,
    schemaVersion === null ? [] : [schemaVersion],
  );
  return {
    schemaVersion,
    knownSchemaVersion: KNOWN_BINDING_REGISTRY_SCHEMA_VERSION,
    supported: unknownRegistryMigrations(executed).length === 0,
    writerVersion: schemaVersion === null ? null : (writers[schemaVersion] ?? null),
  };
}

/** Fresh databases have no bookkeeping yet; resident handles always have the migration table. */
async function assertSupportedRegistryOnOpen<DB>(db: Kysely<DB>, dbPath: string): Promise<void> {
  if (await registryTableExists(db, "kysely_migration")) {
    await assertSupportedRegistrySchema(db, dbPath);
  }
}

/** Exclusion readers cannot perform an upgrade or bypass legacy retirement. */
export class BindingRegistryUpgradePendingError extends ActionableError {}

export async function assertBindingRegistryCurrent<DB>(
  db: Kysely<DB>,
  dbPath: string,
): Promise<void> {
  await assertSupportedRegistryOnOpen(db, dbPath);
  const migrations = await new Migrator({
    db,
    provider: bindingRegistryMigrationProvider,
  }).getMigrations();
  if (migrations.some((migration) => migration.executedAt === undefined)) {
    throw new BindingRegistryUpgradePendingError(
      "Binding registry upgrade pending; exclusion will retry after retirement",
    );
  }
}

/**
 * Probe with reads only: Kysely's getMigrations does not create missing bookkeeping tables, and
 * reports their migrations as unexecuted. A migrated WAL registry can open behind a peer writer.
 * Only pending work takes the cross-process file lock (no-op for `:memory:`); migrateToLatest
 * rechecks under that lock and the registry's transactional-DDL adapter keeps the changes atomic.
 */
export async function migrateBindingRegistry<DB>(
  db: Kysely<DB>,
  dbPath: string,
  beforeMigrate?: () => Promise<void>,
  options: { writerVersion?: string } = {},
): Promise<void> {
  await assertSupportedRegistryOnOpen(db, dbPath);
  const migrator = new Migrator({
    db,
    provider: bindingRegistryMigrationProviderFor(options.writerVersion),
  });
  if ((await migrator.getMigrations()).every((migration) => migration.executedAt !== undefined)) {
    return;
  }
  const lock = selectMigrationLock(dbPath);
  await lock.acquire();
  try {
    await assertSupportedRegistryOnOpen(db, dbPath);
    const pending = (await migrator.getMigrations()).some(
      (migration) =>
        migration.name === "2026_10_16_008_retire_slot_features" &&
        migration.executedAt === undefined,
    );
    if (pending) {
      await beforeMigrate?.();
    }
    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw new ActionableError(
        `Failed to migrate the binding registry at ${dbPath}: ${errorMessage(error)}`,
      );
    }
  } finally {
    await lock.release();
  }
}
