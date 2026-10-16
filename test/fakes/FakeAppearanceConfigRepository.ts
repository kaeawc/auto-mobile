import type { KeyedConfigRepository } from "../../src/db/keyedJsonConfigRepository";
import type { AppearanceConfig } from "../../src/models";

const GLOBAL_KEY = "global";

/** In-memory {@link KeyedConfigRepository}; an omitted key addresses the single global row. */
export class FakeAppearanceConfigRepository implements KeyedConfigRepository<AppearanceConfig> {
  private readonly configs = new Map<string, AppearanceConfig>();

  async getConfig(key: string = GLOBAL_KEY): Promise<AppearanceConfig | null> {
    const config = this.configs.get(key);
    return config ? structuredClone(config) : null;
  }

  async setConfig(config: AppearanceConfig, key: string = GLOBAL_KEY): Promise<void> {
    this.configs.set(key, structuredClone(config));
  }

  async clearConfig(key: string = GLOBAL_KEY): Promise<void> {
    this.configs.delete(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.configs.keys()].filter((key) => key.startsWith(prefix));
  }
}
