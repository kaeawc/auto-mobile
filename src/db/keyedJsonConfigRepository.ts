import type { Kysely } from "kysely";
import { logger } from "../utils/logger";
import { ensureMigrations, getDatabase } from "./database";
import type { Database } from "./types";

const CONFIG_KEY = "global";

export type KeyedJsonConfigTableName =
  | "appearance_configs"
  | "device_snapshot_configs"
  | "video_recording_configs";

export interface KeyedJsonConfigRepositoryOptions {
  tableName: KeyedJsonConfigTableName;
  loggerTag?: string;
  db?: Kysely<Database>;
}

export interface ConfigRepository<TConfig> {
  getConfig(): Promise<TConfig | null>;
  setConfig(config: TConfig): Promise<void>;
  clearConfig(): Promise<void>;
}

export class KeyedJsonConfigRepository<TConfig> implements ConfigRepository<TConfig> {
  private readonly tableName: KeyedJsonConfigTableName;
  private readonly loggerTag: string;
  private readonly db: Kysely<Database> | null;

  constructor(options: KeyedJsonConfigRepositoryOptions) {
    this.tableName = options.tableName;
    this.loggerTag = options.loggerTag ?? "KeyedJsonConfigRepository";
    this.db = options.db ?? null;
  }

  private async getDb(): Promise<Kysely<Database>> {
    if (this.db) {
      return this.db;
    }
    await ensureMigrations();
    return getDatabase();
  }

  async getConfig(): Promise<TConfig | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom(this.tableName)
      .select(["config_json"])
      .where("key", "=", CONFIG_KEY)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.config_json) as TConfig;
    } catch (error) {
      logger.warn(`[${this.loggerTag}] Failed to parse config JSON: ${error}`);
      return null;
    }
  }

  async setConfig(config: TConfig): Promise<void> {
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
      .insertInto(this.tableName)
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
      .deleteFrom(this.tableName)
      .where("key", "=", CONFIG_KEY)
      .execute();
  }
}
