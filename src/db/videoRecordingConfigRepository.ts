import type { Kysely } from "kysely";
import { ensureMigrations, getDatabase } from "./database";
import type { VideoRecordingConfig } from "../models";
import type { Database } from "./types";
import { logger } from "../utils/logger";

const CONFIG_KEY = "global";

export class VideoRecordingConfigRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
  }

  private async getDb(): Promise<Kysely<Database>> {
    if (this.db) {
      return this.db;
    }
    await ensureMigrations();
    return getDatabase();
  }

  async getConfig(): Promise<VideoRecordingConfig | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom("video_recording_configs")
      .select(["config_json"])
      .where("key", "=", CONFIG_KEY)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.config_json) as VideoRecordingConfig;
    } catch (error) {
      logger.warn(`[VideoRecordingConfigRepository] Failed to parse config JSON: ${error}`);
      return null;
    }
  }

  async setConfig(config: VideoRecordingConfig): Promise<void> {
    const db = await this.getDb();
    const now = new Date().toISOString();

    const payload = {
      key: CONFIG_KEY,
      config_json: JSON.stringify(config),
      updated_at: now,
    };

    // Atomic upsert on the key PRIMARY KEY. A concurrent first-write would otherwise
    // have one caller lose the SELECT/INSERT race and throw a UNIQUE collision (R2356).
    await db
      .insertInto("video_recording_configs")
      .values(payload)
      .onConflict(oc =>
        oc.column("key").doUpdateSet({
          config_json: payload.config_json,
          updated_at: payload.updated_at,
        })
      )
      .execute();
  }

  async clearConfig(): Promise<void> {
    const db = await this.getDb();
    await db
      .deleteFrom("video_recording_configs")
      .where("key", "=", CONFIG_KEY)
      .execute();
  }
}
