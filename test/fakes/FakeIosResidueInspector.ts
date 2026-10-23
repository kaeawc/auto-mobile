import {
  IOS_INCREASE_CONTRAST_DEFAULT_KEYS,
  type IosResidueFileArea,
  type IosResidueInspector,
  type IosResidueSnapshot,
} from "../../src/utils/ios-cmdline-tools/SimulatorResidueReader";

export function emptyIosResidue(): IosResidueSnapshot {
  return { photos: [], documents: [], safariDocuments: [], keyboard: {}, accessibility: {} };
}

/** Holds the simulator's out-of-band state in memory; removals and keyboard writes mutate it. */
export class FakeIosResidueInspector implements IosResidueInspector {
  snapshot: IosResidueSnapshot = emptyIosResidue();
  reads = 0;
  readError: Error | undefined;
  /** When false, removals are recorded but leave the files in place, like a failed delete. */
  removalTakesEffect = true;
  readonly removals: { area: IosResidueFileArea; names: readonly string[] }[] = [];

  async read(_deviceId: string, signal: AbortSignal): Promise<IosResidueSnapshot> {
    signal.throwIfAborted();
    this.reads++;
    if (this.readError) {
      throw this.readError;
    }
    return structuredClone(this.snapshot);
  }

  async removeEntries(
    _deviceId: string,
    area: IosResidueFileArea,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.removals.push({ area, names });
    if (!this.removalTakesEffect) {
      return;
    }
    const key = area === "documents" ? "documents" : "safariDocuments";
    this.snapshot[key] = this.snapshot[key].filter((name) => !names.includes(name));
  }

  /**
   * Applies a `defaults write|delete <domain> <key> [-type value]` command to the tracked
   * `com.apple.Preferences` keyboard and `com.apple.Accessibility` defaults.
   */
  applyDefaultsCommand(args: readonly string[]): void {
    const [, , , verb, domain, key, flag, value] = args;
    const defaults =
      domain === "com.apple.Preferences"
        ? this.snapshot.keyboard
        : domain === "com.apple.Accessibility" &&
            (IOS_INCREASE_CONTRAST_DEFAULT_KEYS as readonly string[]).includes(key ?? "")
          ? this.snapshot.accessibility
          : undefined;
    if (defaults === undefined || key === undefined) {
      return;
    }
    if (verb === "delete") {
      delete defaults[key];
    } else if (verb === "write") {
      defaults[key] =
        flag === "-bool" ? value === "true" : flag === "-int" ? Number(value) : String(value);
    }
  }
}
