import type {
  AvdConfig,
  AvdConfigReader,
} from "../../src/utils/android-cmdline-tools/AvdConfigReader";

/** Deterministic AVD config reader for tests that must not inspect host state. */
export class FakeAvdConfigReader implements AvdConfigReader {
  readonly readConfigCalls: string[] = [];

  /**
   * `config` answers every AVD name (the legacy shape most callers need); use
   * {@link forAvds} when an unknown AVD must read as null like the real reader.
   */
  constructor(
    private readonly config: AvdConfig | null = null,
    private readonly configsByName?: ReadonlyMap<string, AvdConfig>,
  ) {}

  /** A reader that only knows the named AVDs; every other name reads as null. */
  static forAvds(configs: Readonly<Record<string, AvdConfig>>): FakeAvdConfigReader {
    return new FakeAvdConfigReader(null, new Map(Object.entries(configs)));
  }

  async readConfig(avdName: string): Promise<AvdConfig | null> {
    this.readConfigCalls.push(avdName);
    const config = this.configsByName ? (this.configsByName.get(avdName) ?? null) : this.config;
    // Each read parses afresh in the real reader, so callers never share a mutable result.
    return config === null ? null : structuredClone(config);
  }
}
