import type { Kysely } from "kysely";
import { z } from "zod";
import { ensureMigrations, getDatabase } from "./database";
import { nowIso } from "./nowIso";
import type { Database } from "./types";
import { errorMessage } from "../utils/describeUnknownError";
import { logger, type Logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type {
  FeatureFlagConfig,
  FeatureFlagDefinition,
  FeatureFlagKey,
} from "../models/FeatureFlagDefinitions";
import type { RepositoryDeps } from "./repositoryDeps";

export interface FeatureFlagRecord {
  key: FeatureFlagKey;
  enabled: boolean;
  config: FeatureFlagConfig | null;
  updatedAt: string;
}

export interface FeatureFlagRepository {
  ensureFlags(definitions: FeatureFlagDefinition[]): Promise<void>;
  listFlags(): Promise<FeatureFlagRecord[]>;
  upsertFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    config?: FeatureFlagConfig | null,
  ): Promise<void>;
}

const featureFlagConfigSchema = z.record(z.string(), z.unknown());

/**
 * Decode a stored `config_json`. A malformed or wrongly shaped value must neither throw (which
 * would fail the whole flag listing and service startup) nor silently drive behaviour, so it
 * logs a warning and reads as null; the service then falls back to the definition default (#11859).
 */
export function parseFeatureFlagConfig(
  key: string,
  configJson: string | null,
  log: Logger = logger,
): FeatureFlagConfig | null {
  if (!configJson) {
    return null;
  }
  try {
    return featureFlagConfigSchema.parse(JSON.parse(configJson));
  } catch (error) {
    log.warn(
      `[FeatureFlagRepository] Ignoring invalid config_json for flag "${key}": ${errorMessage(error)}`,
    );
    return null;
  }
}

export class SqliteFeatureFlagRepository implements FeatureFlagRepository {
  private readonly injectedDb: Kysely<Database> | null;
  private readonly logger: Logger;

  private readonly timer: Timer;

  constructor({
    db,
    timer = defaultTimer,
    log,
  }: Pick<RepositoryDeps, "db" | "timer"> & { log?: Logger } = {}) {
    this.timer = timer;
    this.injectedDb = db ?? null;
    this.logger = log ?? logger;
  }

  private async ensureReady(): Promise<void> {
    if (!this.injectedDb) {
      await ensureMigrations();
    }
  }

  private getDb(): Kysely<Database> {
    return this.injectedDb ?? getDatabase();
  }

  async ensureFlags(definitions: FeatureFlagDefinition[]): Promise<void> {
    await this.ensureReady();
    if (definitions.length === 0) {
      return;
    }
    const db = this.getDb();
    const now = nowIso(this.timer);

    await db
      .insertInto("feature_flags")
      .values(
        definitions.map((definition) => ({
          key: definition.key,
          enabled: definition.defaultValue ? 1 : 0,
          config_json: definition.defaultConfig ? JSON.stringify(definition.defaultConfig) : null,
          updated_at: now,
        })),
      )
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  }

  async listFlags(): Promise<FeatureFlagRecord[]> {
    await this.ensureReady();
    const db = this.getDb();
    const rows = await db
      .selectFrom("feature_flags")
      .select(["key", "enabled", "config_json", "updated_at"])
      .execute();

    return rows.map((row) => ({
      key: row.key as FeatureFlagKey,
      enabled: row.enabled === 1,
      config: parseFeatureFlagConfig(row.key, row.config_json, this.logger),
      updatedAt: row.updated_at,
    }));
  }

  async upsertFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    config?: FeatureFlagConfig | null,
  ): Promise<void> {
    await this.ensureReady();
    const db = this.getDb();
    const now = nowIso(this.timer);
    const configJson = config ? JSON.stringify(config) : null;

    await db
      .insertInto("feature_flags")
      .values({
        key,
        enabled: enabled ? 1 : 0,
        config_json: configJson,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet((eb) => ({
          enabled: enabled ? 1 : 0,
          config_json: config === undefined ? eb.ref("feature_flags.config_json") : configJson,
          updated_at: now,
        })),
      )
      .execute();
  }
}
