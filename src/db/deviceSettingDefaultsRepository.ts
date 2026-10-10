import { sql, type Kysely } from "kysely";
import { z } from "zod/v4";
import { getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  DEVICE_SETTING_KEYS,
  type DeviceSettingDefaultsPersistence,
  type DeviceSettingDefaultsRecord,
} from "../features/utility/DeviceSettingDefaults";

const settingValueSchema = z.union([z.string(), z.number(), z.null()]);
const recordSchema = z.object({
  settingDefaults: z.object({
    name: z.string(),
    sessionId: z.string(),
    values: z.partialRecord(z.enum(DEVICE_SETTING_KEYS), settingValueSchema),
  }),
});

/**
 * Recorded device-setting defaults (#11145), stored in the per-device `device_configs` row's
 * `config_json` under `settingDefaults`, so they survive a daemon restart.
 */
export class DeviceSettingDefaultsRepository implements DeviceSettingDefaultsPersistence {
  constructor(private readonly db?: Kysely<Database>) {}

  // Resolve lazily so construction never opens the default database.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async get(deviceId: string): Promise<DeviceSettingDefaultsRecord | null> {
    const row = await this.getDb()
      .selectFrom("device_configs")
      .select(["platform", "config_json"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    let parsed: z.infer<typeof recordSchema>;
    try {
      parsed = recordSchema.parse(JSON.parse(row.config_json));
    } catch (error) {
      logger.warn(
        `Ignoring unreadable device setting defaults for ${deviceId}: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
    return { platform: row.platform, ...parsed.settingDefaults };
  }

  async put(deviceId: string, record: DeviceSettingDefaultsRecord): Promise<void> {
    const values = {
      device_id: deviceId,
      platform: record.platform,
      config_json: JSON.stringify({
        settingDefaults: { name: record.name, sessionId: record.sessionId, values: record.values },
      }),
    };
    await this.getDb()
      .insertInto("device_configs")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("device_id").doUpdateSet({
          platform: values.platform,
          config_json: values.config_json,
          updated_at: sql`(datetime('now'))`,
        }),
      )
      .execute();
  }

  async delete(deviceId: string): Promise<void> {
    await this.getDb().deleteFrom("device_configs").where("device_id", "=", deviceId).execute();
  }
}
