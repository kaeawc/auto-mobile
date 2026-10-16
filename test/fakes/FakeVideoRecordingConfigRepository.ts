import type { VideoRecordingConfig } from "../../src/models";
import type { ConfigRepository } from "../../src/db/keyedJsonConfigRepository";

const GLOBAL_KEY = "global";

/** Keyed like the SQLite repository: an omitted key addresses the single global row. */
export class FakeVideoRecordingConfigRepository implements ConfigRepository<VideoRecordingConfig> {
  private readonly configs = new Map<string, VideoRecordingConfig>();

  async getConfig(key: string = GLOBAL_KEY): Promise<VideoRecordingConfig | null> {
    const config = this.configs.get(key);
    return config ? { ...config } : null;
  }

  async setConfig(config: VideoRecordingConfig, key: string = GLOBAL_KEY): Promise<void> {
    this.configs.set(key, { ...config });
  }

  async clearConfig(key: string = GLOBAL_KEY): Promise<void> {
    this.configs.delete(key);
  }
}
