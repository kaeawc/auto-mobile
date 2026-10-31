import type { Kysely } from "kysely";
import type { AvdSnapshotCleanupRegistry } from "../AvdSnapshotCleanup";
import { parseJournalTarget, type BindingRegistryDatabase } from "./bindingRegistryRows";

/**
 * Existing registry read ports are scope-specific or live-only. Read all persisted
 * assignment and journal identities directly through the injected, already-open DB.
 * Terminal rows deliberately still protect names. No database singleton is opened here.
 */
export class SqliteAvdSnapshotCleanupRegistry implements AvdSnapshotCleanupRegistry {
  constructor(private readonly db: Kysely<BindingRegistryDatabase>) {}

  async listReferencedAvdNames(): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      const assignments = await trx
        .selectFrom("slot_assignments")
        .select(["device_name", "stable_device_id"])
        .execute();
      const journal = await trx
        .selectFrom("slot_journal")
        .select(["binding_stable_device_id", "target_json"])
        .execute();
      // Do not filter platform/state: even an inconsistent persisted row is reason to keep.
      const names = assignments.flatMap((row) => [row.device_name, row.stable_device_id]);
      for (const row of journal) {
        const target = parseJournalTarget(row.target_json);
        names.push(
          row.binding_stable_device_id,
          target.oldName,
          target.oldStableId,
          target.newName,
          target.newStableId,
        );
      }
      return [...new Set(names.filter((name): name is string => name !== null))];
    });
  }
}
