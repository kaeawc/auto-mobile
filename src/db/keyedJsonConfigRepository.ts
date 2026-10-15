import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { DEFAULT_DEVICE_SNAPSHOT_CONFIG } from "../features/snapshot/DeviceSnapshotConfig";
import { errorMessage } from "../utils/describeUnknownError";
import type { AppearanceConfig, DeviceSnapshotConfig, VideoRecordingConfig } from "../models";
import { logger, type Logger } from "../utils/logger";
import { getDatabase } from "./database";
import type { Database } from "./types";

const CONFIG_KEY = "global";

export type KeyedJsonConfigTableName =
  | "appearance_configs"
  | "device_snapshot_configs"
  | "video_recording_configs";

export interface KeyedJsonConfigRepositoryOptions<TConfig> {
  schema: z.ZodType<TConfig>;
  tableName: KeyedJsonConfigTableName;
  loggerTag?: string;
  db?: Kysely<Database>;
  logger?: Logger;
}

// Orchestrator-chosen compatibility policy: non-strict objects strip unknown keys.
export const appearanceConfigSchema = z.object({
  syncWithHost: z.boolean(),
  defaultMode: z.enum(["light", "dark", "auto"]),
  applyOnConnect: z.boolean(),
});

export const deviceSnapshotConfigSchema = z.object({
  includeAppData: z.boolean(),
  includeSettings: z.boolean(),
  useVmSnapshot: z.boolean(),
  strictBackupMode: z.boolean(),
  vmSnapshotTimeoutMs: z.number(),
  // Rows predating #6960 lack retention fields; preserve the manager's default.
  maxVmSnapshotsPerAvd: z.number().default(DEFAULT_DEVICE_SNAPSHOT_CONFIG.maxVmSnapshotsPerAvd),
  maxVmArchiveSizeMb: z.number().optional(),
  maxArchiveSizeMb: z.number(),
});

export const videoRecordingConfigSchema = z.object({
  qualityPreset: z.enum(["low", "medium", "high"]),
  targetBitrateKbps: z.number(),
  maxThroughputMbps: z.number(),
  fps: z.number(),
  maxArchiveSizeMb: z.number(),
  format: z.literal("mp4"),
  resolution: z.object({ width: z.number(), height: z.number() }).optional(),
});

const KEYED_JSON_CONFIG_TABLES = {
  appearance: {
    tableName: "appearance_configs",
    loggerTag: "AppearanceConfigRepository",
    schema: appearanceConfigSchema,
  },
  deviceSnapshot: {
    tableName: "device_snapshot_configs",
    loggerTag: "DeviceSnapshotConfigRepository",
    schema: deviceSnapshotConfigSchema,
  },
  videoRecording: {
    tableName: "video_recording_configs",
    loggerTag: "VideoRecordingConfigRepository",
    schema: videoRecordingConfigSchema,
  },
} satisfies Record<string, KeyedJsonConfigRepositoryOptions<unknown>>;

/**
 * A config store. Every method addresses the single global row unless a `key` names another row
 * (the appearance config is per session, #10976).
 */
export interface ConfigRepository<TConfig> {
  getConfig(key?: string): Promise<TConfig | null>;
  setConfig(config: TConfig, key?: string): Promise<void>;
  clearConfig(key?: string): Promise<void>;
}

/** A config store whose rows can be enumerated by key prefix (per-session appearance rows). */
export interface KeyedConfigRepository<TConfig> extends ConfigRepository<TConfig> {
  listKeys(prefix: string): Promise<string[]>;
}

export class KeyedJsonConfigRepository<TConfig> implements KeyedConfigRepository<TConfig> {
  private readonly tableName: KeyedJsonConfigTableName;
  private readonly loggerTag: string;
  private readonly db: Kysely<Database> | null;
  private readonly logger: Logger;
  private readonly schema: z.ZodType<TConfig>;

  constructor(options: KeyedJsonConfigRepositoryOptions<TConfig>) {
    this.schema = options.schema;
    this.tableName = options.tableName;
    this.loggerTag = options.loggerTag ?? "KeyedJsonConfigRepository";
    this.db = options.db ?? null;
    this.logger = options.logger ?? logger;
  }

  // Migration gating is owned by startup (ensureMigrations) plus the app dialect
  // first-query gate (waitForMigrationsBeforeQuery, #6703); a repository helper
  // must NOT await ensureMigrations itself. Resolve the injected executor, else
  // the singleton, synchronously.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async getConfig(key: string = CONFIG_KEY): Promise<TConfig | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom(this.tableName)
      .select(["config_json"])
      .where("key", "=", key)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.config_json);
    } catch (error) {
      this.logger.warn(`[${this.loggerTag}] Failed to parse config JSON: ${errorMessage(error)}`);
      // Callers safely fall back to defaults when persisted JSON is unreadable.
      return null;
    }
    const result = this.schema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        `[${this.loggerTag}] Config JSON failed validation: ${result.error.message}`,
      );
      return null;
    }
    return result.data;
  }

  async setConfig(config: TConfig, key: string = CONFIG_KEY): Promise<void> {
    const db = await this.getDb();
    const now = new Date().toISOString();

    const payload = {
      key,
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

  async clearConfig(key: string = CONFIG_KEY): Promise<void> {
    const db = await this.getDb();
    await db.deleteFrom(this.tableName).where("key", "=", key).execute();
  }

  async listKeys(prefix: string): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.selectFrom(this.tableName).select(["key"]).execute();
    return rows.map((row) => row.key).filter((key) => key.startsWith(prefix));
  }
}

function createConfigRepository<TConfig>(
  options: KeyedJsonConfigRepositoryOptions<TConfig>,
  db?: Kysely<Database>,
): KeyedConfigRepository<TConfig> {
  return new KeyedJsonConfigRepository<TConfig>({
    ...options,
    db,
  });
}

export function createAppearanceConfigRepository(
  db?: Kysely<Database>,
): KeyedConfigRepository<AppearanceConfig> {
  return createConfigRepository<AppearanceConfig>(KEYED_JSON_CONFIG_TABLES.appearance, db);
}

export function createDeviceSnapshotConfigRepository(
  db?: Kysely<Database>,
): ConfigRepository<DeviceSnapshotConfig> {
  return createConfigRepository<DeviceSnapshotConfig>(KEYED_JSON_CONFIG_TABLES.deviceSnapshot, db);
}

export function createVideoRecordingConfigRepository(
  db?: Kysely<Database>,
): ConfigRepository<VideoRecordingConfig> {
  return createConfigRepository<VideoRecordingConfig>(KEYED_JSON_CONFIG_TABLES.videoRecording, db);
}
