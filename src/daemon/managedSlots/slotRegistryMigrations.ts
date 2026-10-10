import type { Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { selectMigrationLock } from "../../db/migrationLock";
import * as slotRegistry000 from "./migrations/2026_10_09_000_slot_registry";

/**
 * The slot registry's own migration set (#11174). Statically imported rather than read from a
 * folder so the bundled daemon always carries them and they can never mix with the per-daemon
 * `auto-mobile.db` migration folder.
 */
export const SLOT_REGISTRY_MIGRATIONS: Readonly<Record<string, Migration>> = {
  "2026_10_09_000_slot_registry": slotRegistry000,
};

export const slotRegistryMigrationProvider: MigrationProvider = {
  getMigrations: async () => ({ ...SLOT_REGISTRY_MIGRATIONS }),
};

/**
 * Migrate the registry to latest under a cross-process file lock keyed to `dbPath` (no-op for
 * `:memory:`), so two daemons opening the shared file at once cannot collide on the migration table.
 */
export async function migrateSlotRegistry<DB>(db: Kysely<DB>, dbPath: string): Promise<void> {
  const lock = selectMigrationLock(dbPath);
  await lock.acquire();
  try {
    const { error } = await new Migrator({
      db,
      provider: slotRegistryMigrationProvider,
    }).migrateToLatest();
    if (error) {
      throw new ActionableError(
        `Failed to migrate the managed slot registry at ${dbPath}: ${errorMessage(error)}`,
      );
    }
  } finally {
    await lock.release();
  }
}
