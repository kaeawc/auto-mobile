import type { DeviceSnapshotConfig } from "../../src/models";
import type { ConfigRepository } from "../../src/db/keyedJsonConfigRepository";

const GLOBAL_KEY = "global";

/** Keyed like the SQLite repository: an omitted key addresses the single global row. */
export class FakeDeviceSnapshotConfigRepository implements ConfigRepository<DeviceSnapshotConfig> {
  private readonly configs = new Map<string, DeviceSnapshotConfig>();

  async getConfig(key: string = GLOBAL_KEY): Promise<DeviceSnapshotConfig | null> {
    const config = this.configs.get(key);
    return config ? { ...config } : null;
  }

  async setConfig(config: DeviceSnapshotConfig, key: string = GLOBAL_KEY): Promise<void> {
    this.configs.set(key, { ...config });
  }

  async clearConfig(key: string = GLOBAL_KEY): Promise<void> {
    this.configs.delete(key);
  }
}
