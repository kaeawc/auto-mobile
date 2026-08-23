import type { Kysely } from "kysely";
import type { AppearanceConfig, DeviceSnapshotConfig, VideoRecordingConfig } from "../models";
import { logger, type Logger } from "../utils/logger";
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
  logger?: Logger;
}

const KEYED_JSON_CONFIG_TABLES = {
  appearance: {
    tableName: "appearance_configs",
    loggerTag: "AppearanceConfigRepository",
  },
  deviceSnapshot: {
    tableName: "device_snapshot_configs",
    loggerTag: "DeviceSnapshotConfigRepository",
  },
  videoRecording: {
    tableName: "video_recording_configs",
    loggerTag: "VideoRecordingConfigRepository",
  },
} as const satisfies Record<
  string,
  {
    tableName: KeyedJsonConfigTableName;
    loggerTag: string;
  }
>;

export interface ConfigRepository<TConfig> {
  getConfig(): Promise<TConfig | null>;
  setConfig(config: TConfig): Promise<void>;
  clearConfig(): Promise<void>;
}

export class KeyedJsonConfigRepository<TConfig> implements ConfigRepository<TConfig> {
  private readonly tableName: KeyedJsonConfigTableName;
  private readonly loggerTag: string;
  private readonly db: Kysely<Database> | null;
  private readonly logger: Logger;

  constructor(options: KeyedJsonConfigRepositoryOptions) {
    this.tableName = options.tableName;
    this.loggerTag = options.loggerTag ?? "KeyedJsonConfigRepository";
    this.db = options.db ?? null;
    this.logger = options.logger ?? logger;
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
      this.logger.warn(`[${this.loggerTag}] Failed to parse config JSON: ${error}`);
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
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          config_json: payload.config_json,
          updated_at: payload.updated_at,
        }),
      )
      .execute();
  }

  async clearConfig(): Promise<void> {
    const db = await this.getDb();
    await db.deleteFrom(this.tableName).where("key", "=", CONFIG_KEY).execute();
  }
}

function createConfigRepository<TConfig>(
  key: keyof typeof KEYED_JSON_CONFIG_TABLES,
  db?: Kysely<Database>,
): ConfigRepository<TConfig> {
  return new KeyedJsonConfigRepository<TConfig>({
    ...KEYED_JSON_CONFIG_TABLES[key],
    db,
  });
}

export function createAppearanceConfigRepository(
  db?: Kysely<Database>,
): ConfigRepository<AppearanceConfig> {
  return createConfigRepository<AppearanceConfig>("appearance", db);
}

export function createDeviceSnapshotConfigRepository(
  db?: Kysely<Database>,
): ConfigRepository<DeviceSnapshotConfig> {
  return createConfigRepository<DeviceSnapshotConfig>("deviceSnapshot", db);
}

export function createVideoRecordingConfigRepository(
  db?: Kysely<Database>,
): ConfigRepository<VideoRecordingConfig> {
  return createConfigRepository<VideoRecordingConfig>("videoRecording", db);
}
