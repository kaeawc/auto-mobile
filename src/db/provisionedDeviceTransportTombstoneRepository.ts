import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";

export interface RetiredProvisionedDeviceTransport {
  deviceId: string;
  stableId: string;
  reason: string;
}

export interface ProvisionedDeviceTransportTombstoneStore {
  retire(input: RetiredProvisionedDeviceTransport, retiredAtMs: number): Promise<void>;
  get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined>;
}

export class ProvisionedDeviceTransportTombstoneRepository implements ProvisionedDeviceTransportTombstoneStore {
  constructor(private readonly database?: Kysely<Database>) {}

  async retire(input: RetiredProvisionedDeviceTransport, retiredAtMs: number): Promise<void> {
    await this.getDb()
      .insertInto("provisioned_device_transport_tombstones")
      .values({
        device_id: input.deviceId,
        stable_id: input.stableId,
        reason: input.reason,
        retired_at_ms: retiredAtMs,
      })
      .onConflict((conflict) =>
        conflict.column("device_id").doUpdateSet({
          stable_id: input.stableId,
          reason: input.reason,
          retired_at_ms: retiredAtMs,
        }),
      )
      .execute();
  }

  async get(deviceId: string): Promise<RetiredProvisionedDeviceTransport | undefined> {
    const row = await this.getDb()
      .selectFrom("provisioned_device_transport_tombstones")
      .select(["device_id", "stable_id", "reason"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    return row
      ? {
          deviceId: row.device_id,
          stableId: row.stable_id,
          reason: row.reason,
        }
      : undefined;
  }

  private getDb(): Kysely<Database> {
    return this.database ?? getDatabase();
  }
}
