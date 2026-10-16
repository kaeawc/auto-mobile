import type {
  FeatureFlagConfig,
  FeatureFlagDefinition,
  FeatureFlagKey,
} from "../../src/features/featureFlags/FeatureFlagDefinitions";
import type {
  FeatureFlagRecord,
  FeatureFlagRepository,
} from "../../src/features/featureFlags/FeatureFlagRepository";

/** SQLite stores config as JSON, so the fake keeps its own copy of every config it is given. */
function cloneConfig(config: FeatureFlagConfig | null | undefined): FeatureFlagConfig | null {
  return config ? structuredClone(config) : null;
}

export class FakeFeatureFlagRepository implements FeatureFlagRepository {
  private readonly flags = new Map<FeatureFlagKey, FeatureFlagRecord>();

  async ensureFlags(definitions: FeatureFlagDefinition[]): Promise<void> {
    const now = new Date().toISOString();
    for (const definition of definitions) {
      if (!this.flags.has(definition.key)) {
        this.flags.set(definition.key, {
          key: definition.key,
          enabled: definition.defaultValue,
          config: cloneConfig(definition.defaultConfig),
          updatedAt: now,
        });
      }
    }
  }

  async listFlags(): Promise<FeatureFlagRecord[]> {
    // Copies, like SQLite rows: a caller mutating a listed record must not change stored state.
    return Array.from(this.flags.values(), (record) => ({
      ...record,
      config: cloneConfig(record.config),
    }));
  }

  async upsertFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    config?: FeatureFlagConfig | null,
  ): Promise<void> {
    this.flags.set(key, {
      key,
      enabled,
      // Mirrors SQLite: undefined keeps the stored config, an explicit null clears it.
      config: config === undefined ? (this.flags.get(key)?.config ?? null) : cloneConfig(config),
      updatedAt: new Date().toISOString(),
    });
  }
}
