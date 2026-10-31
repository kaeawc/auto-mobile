import type { Kysely } from "kysely";
import { getMcpServerVersion } from "../../../utils/mcpVersion";
import { assertBindingRegistryCurrent, migrateBindingRegistry } from "./bindingRegistryMigrations";
import type { BindingRegistryDatabase } from "./bindingRegistryRows";
import type { OpenSqliteBindingRegistryOptions } from "./sqliteBindingRegistry";
import { SqliteLegacySlotRetirementStore } from "./sqliteLegacySlotRetirementStore";

/** Initialize schema on the opened connection, preserving read-only and legacy-retirement rules. */
export async function initializeBindingRegistrySchema(
  db: Kysely<BindingRegistryDatabase>,
  dbPath: string,
  options: Pick<
    OpenSqliteBindingRegistryOptions,
    "migrate" | "legacyDeviceRetirement" | "writerVersion"
  >,
): Promise<void> {
  if (options.migrate === false) {
    await assertBindingRegistryCurrent(db, dbPath);
  } else {
    await migrateBindingRegistry(
      db,
      dbPath,
      () =>
        options.legacyDeviceRetirement?.retire(new SqliteLegacySlotRetirementStore(db)) ??
        Promise.resolve(),
      { writerVersion: options.writerVersion ?? getMcpServerVersion() },
    );
  }
}
