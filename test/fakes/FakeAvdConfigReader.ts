import type { AvdConfig, AvdConfigReader } from "../../src/utils/android-cmdline-tools/AvdConfigReader";

export class FakeAvdConfigReader implements AvdConfigReader {
  private configs: Map<string, AvdConfig> = new Map();

  setConfig(avdName: string, config: AvdConfig): void {
    this.configs.set(avdName, config);
  }

  async readConfig(avdName: string): Promise<AvdConfig | null> {
    return this.configs.get(avdName) ?? null;
  }
}
