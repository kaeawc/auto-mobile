import type { Kysely } from "kysely";
import { ensureMigrations, getDatabase } from "../../db/database";
import type { Database } from "../../db/types";
import type {
  FeatureFlagConfig,
  FeatureFlagDefinition,
  FeatureFlagKey,
} from "./FeatureFlagDefinitions";

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

export class SqliteFeatureFlagRepository implements FeatureFlagRepository {
  private readonly injectedDb: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.injectedDb = db ?? null;
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
    const now = new Date().toISOString();

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
      config: row.config_json ? JSON.parse(row.config_json) : null,
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
    const now = new Date().toISOString();
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
