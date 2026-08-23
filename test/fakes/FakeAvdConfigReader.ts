import type {
  AvdConfig,
  AvdConfigReader,
} from "../../src/utils/android-cmdline-tools/AvdConfigReader";

/** Deterministic AVD config reader for tests that must not inspect host state. */
export class FakeAvdConfigReader implements AvdConfigReader {
  readonly readConfigCalls: string[] = [];

  constructor(private readonly config: AvdConfig | null = null) {}

  async readConfig(avdName: string): Promise<AvdConfig | null> {
    this.readConfigCalls.push(avdName);
    return this.config;
  }
}
