import type { DeviceSnapshotConfig } from "../../src/models";
import type { ConfigRepository } from "../../src/db/keyedJsonConfigRepository";

export class FakeDeviceSnapshotConfigRepository implements ConfigRepository<DeviceSnapshotConfig> {
  private config: DeviceSnapshotConfig | null = null;

  async getConfig(): Promise<DeviceSnapshotConfig | null> {
    return this.config ? { ...this.config } : null;
  }

  async setConfig(config: DeviceSnapshotConfig): Promise<void> {
    this.config = { ...config };
  }

  async clearConfig(): Promise<void> {
    this.config = null;
  }
}
