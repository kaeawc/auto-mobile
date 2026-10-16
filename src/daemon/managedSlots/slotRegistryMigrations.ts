import { sql, type Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { selectMigrationLock } from "../../db/migrationLock";
import { ManagedSlotRegistrySchemaUnsupportedError } from "./managedSlotRefusal";
import * as slotRegistry000 from "./migrations/2026_10_09_000_slot_registry";
import * as slotRegistry001 from "./migrations/2026_10_09_001_slot_owner_fencing";
import * as slotJournal002 from "./migrations/2026_10_09_002_slot_journal";
import * as freeDeviceDeletion004 from "./migrations/2026_10_12_004_free_device_deletion";
import * as freeDeviceDeletionFailedDeletes005 from "./migrations/2026_10_13_005_free_device_deletion_failed_deletes";
import * as freeDeviceStop003 from "./migrations/2026_10_10_003_free_device_stop_state";
import * as sessionBrokerFailure007 from "./migrations/2026_10_15_007_session_broker_failure_retryable";
import * as sessionBroker006 from "./migrations/2026_10_15_006_session_broker";

/**
 * The slot registry's own migration set (#11174). Statically imported rather than read from a
 * folder so the bundled daemon always carries them and they can never mix with the per-daemon
 * `auto-mobile.db` migration folder.
 */
export const SLOT_REGISTRY_MIGRATIONS: Readonly<Record<string, Migration>> = {
  "2026_10_09_000_slot_registry": slotRegistry000,
  "2026_10_09_001_slot_owner_fencing": slotRegistry001,
  "2026_10_09_002_slot_journal": slotJournal002,
  "2026_10_10_003_free_device_stop_state": freeDeviceStop003,
  "2026_10_12_004_free_device_deletion": freeDeviceDeletion004,
  "2026_10_13_005_free_device_deletion_failed_deletes": freeDeviceDeletionFailedDeletes005,
  "2026_10_15_006_session_broker": sessionBroker006,
  "2026_10_15_007_session_broker_failure_retryable": sessionBrokerFailure007,
};

export const slotRegistryMigrationProvider: MigrationProvider = {
  getMigrations: async () => ({ ...SLOT_REGISTRY_MIGRATIONS }),
};

/** Read only: refuse newer schemas before Kysely can create or update bookkeeping. */
async function assertSupportedRegistrySchema<DB>(db: Kysely<DB>, dbPath: string): Promise<void> {
  const table = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'
  `.execute(db);
  if (table.rows.length === 0) {
    return;
  }
  const executed = await sql<{
    name: string;
  }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  const unknownMigrations = executed.rows
    .map(({ name }) => name)
    .filter((name) => !Object.hasOwn(SLOT_REGISTRY_MIGRATIONS, name));
  if (unknownMigrations.length > 0) {
    throw new ManagedSlotRegistrySchemaUnsupportedError(dbPath, unknownMigrations);
  }
}

/**
 * Probe with reads only: Kysely's getMigrations does not create missing bookkeeping tables, and
 * reports their migrations as unexecuted. A migrated WAL registry can open behind a peer writer.
 * Only pending work takes the cross-process file lock (no-op for `:memory:`); migrateToLatest
 * rechecks under that lock and the registry's transactional-DDL adapter keeps the changes atomic.
 */
export async function migrateSlotRegistry<DB>(db: Kysely<DB>, dbPath: string): Promise<void> {
  await assertSupportedRegistrySchema(db, dbPath);
  const migrator = new Migrator({ db, provider: slotRegistryMigrationProvider });
  if ((await migrator.getMigrations()).every((migration) => migration.executedAt !== undefined)) {
    return;
  }
  const lock = selectMigrationLock(dbPath);
  await lock.acquire();
  try {
    await assertSupportedRegistrySchema(db, dbPath);
    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw new ActionableError(
        `Failed to migrate the managed slot registry at ${dbPath}: ${errorMessage(error)}`,
      );
    }
  } finally {
    await lock.release();
  }
}
