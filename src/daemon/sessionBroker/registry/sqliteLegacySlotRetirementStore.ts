import { ActionableError } from "../../../models/ActionableError";
import { sql, type Kysely } from "kysely";
import { BROKER_BINDING_ROLE } from "../persistedIdentity";
import {
  deleteLegacyBindingRows,
  legacyJournalPredicate,
} from "./migrations/2026_10_16_008_retire_slot_features";
import { parseJournalTarget } from "./sqliteBindingRegistry";
import type { BindingPlatform, BindingProcessIdentity } from "./bindingRegistry";
import type {
  LegacySlotDeviceTarget,
  LegacySlotRetirementStore,
  LegacySlotSnapshot,
} from "./legacySlotDeviceRetirement";

interface LegacyAssignment {
  platform: BindingPlatform;
  stable_device_id: string | null;
  device_name: string | null;
  exec_owner_daemon_id: string | null;
  exec_owner_pid: number | null;
  exec_owner_process_token?: string | null;
  settler_daemon_id?: string | null;
  settler_pid?: number | null;
  settler_process_token?: string | null;
}
interface LegacyFreeDevice {
  platform: BindingPlatform;
  stable_device_id: string;
  deletion_owner_daemon_id?: string | null;
  deletion_owner_pid?: number | null;
  deletion_owner_process_token?: string | null;
  stop_claimed_by?: string | null;
}
interface LegacyJournal {
  phase: string;
  platform: BindingPlatform;
  binding_stable_device_id: string | null;
  target_json: string;
  owner_daemon_id: string;
  owner_pid: number;
  owner_process_token: string | null;
}

export class SqliteLegacySlotRetirementStore<DB> implements LegacySlotRetirementStore {
  constructor(private readonly db: Kysely<DB>) {}

  async withLegacyRows(
    operation: (snapshot: LegacySlotSnapshot, remove: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const tables = await this.db.introspection.getTables();
    if (!tables.some((table) => table.name === "slot_free_devices")) {
      return; // Fresh registry or already at 008: no native discovery required.
    }
    const hasJournal = tables.some((table) => table.name === "slot_journal");
    const readRows = async (trx: Kysely<DB>) => {
      const scopes = (await sql`SELECT * FROM slot_scopes ORDER BY scope_key`.execute(trx)).rows;
      const assignments = (
        await sql<LegacyAssignment>`SELECT * FROM slot_assignments WHERE role <> ${BROKER_BINDING_ROLE} ORDER BY scope_key, slot_index`.execute(
          trx,
        )
      ).rows;
      const free = (
        await sql<LegacyFreeDevice>`SELECT * FROM slot_free_devices ORDER BY platform, stable_device_id`.execute(
          trx,
        )
      ).rows;
      const journals = hasJournal
        ? (
            await sql<LegacyJournal>`SELECT * FROM slot_journal WHERE ${legacyJournalPredicate}
        ORDER BY id`.execute(trx)
          ).rows
        : [];
      const brokerDevices = (
        await sql<Pick<LegacyAssignment, "platform" | "stable_device_id" | "device_name">>`
        SELECT * FROM slot_assignments WHERE role = ${BROKER_BINDING_ROLE} ORDER BY scope_key, slot_index`.execute(
          trx,
        )
      ).rows;
      return { scopes, assignments, free, journals, brokerDevices };
    };
    // Native discovery and shutdown must never hold SQLite's write lock.
    const snapshot = await readRows(this.db);
    const { assignments, free, journals, brokerDevices } = snapshot;
    const devices: LegacySlotDeviceTarget[] = [];
    const owners: BindingProcessIdentity[] = [];
    const owner = (
      daemonId: string | null | undefined,
      pid: number | null | undefined,
      token?: string | null,
    ) => {
      if (pid !== null && pid !== undefined) {
        owners.push({
          daemonId: daemonId ?? "legacy",
          pid,
          processGenerationToken: token ?? null,
        });
      }
    };
    for (const row of assignments) {
      if (row.stable_device_id !== null || row.device_name !== null) {
        devices.push({
          platform: row.platform,
          stableId: row.stable_device_id,
          name: row.device_name,
        });
      }
      owner(row.exec_owner_daemon_id, row.exec_owner_pid, row.exec_owner_process_token);
      owner(row.settler_daemon_id, row.settler_pid, row.settler_process_token);
    }
    for (const row of free) {
      devices.push({ platform: row.platform, stableId: row.stable_device_id, name: null });
      owner(row.deletion_owner_daemon_id, row.deletion_owner_pid, row.deletion_owner_process_token);
    }
    for (const row of journals.filter(
      (entry) => !["committed", "rolled_back"].includes(entry.phase),
    )) {
      owner(row.owner_daemon_id, row.owner_pid, row.owner_process_token);
      const target = parseJournalTarget(row.target_json);
      for (const device of [
        { platform: row.platform, stableId: row.binding_stable_device_id, name: target.oldName },
        { platform: row.platform, stableId: target.oldStableId, name: target.oldName },
        {
          platform: target.newPlatform ?? row.platform,
          stableId: target.newStableId,
          name: target.newName,
        },
      ]) {
        if (device.stableId || device.name) {
          devices.push(device);
        }
      }
    }
    if (devices.some((target) => brokerDevices.some((broker) => refersToBroker(target, broker)))) {
      throw new ActionableError(
        "Legacy retirement overlaps a broker device; reconcile the duplicate legacy row before retrying",
      );
    }
    await operation({ devices, owners }, async () => {
      await this.db.transaction().execute(async (trx) => {
        // BEGIN IMMEDIATE fences peers only for the compare-and-delete, never native work.
        if (JSON.stringify(await readRows(trx)) !== JSON.stringify(snapshot)) {
          throw new ActionableError(
            "Legacy registry rows changed during retirement; retry daemon startup",
          );
        }
        await sql`DELETE FROM slot_free_devices`.execute(trx);
        await deleteLegacyBindingRows(trx, {
          hasJournal,
          hasBrokerResources: tables.some((table) => table.name === "session_broker_resources"),
        });
      });
    });
  }
}

function refersToBroker(
  target: LegacySlotDeviceTarget,
  broker: Pick<LegacyAssignment, "platform" | "stable_device_id" | "device_name">,
): boolean {
  if (target.platform !== broker.platform) {
    return false;
  }
  if (target.stableId) {
    return target.stableId === broker.stable_device_id;
  }
  return target.name !== null && target.name === broker.device_name;
}
