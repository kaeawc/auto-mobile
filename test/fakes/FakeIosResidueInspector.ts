import type {
  IosResidueFileArea,
  IosResidueInspector,
  IosResidueSnapshot,
} from "../../src/utils/ios-cmdline-tools/SimulatorResidueReader";

export function emptyIosResidue(): IosResidueSnapshot {
  return { photos: [], documents: [], safariDocuments: [], keyboard: {} };
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

  /** Applies a `defaults write|delete com.apple.Preferences <key> [-type value]` command. */
  applyDefaultsCommand(args: readonly string[]): void {
    const [, , , verb, domain, key, flag, value] = args;
    if (domain !== "com.apple.Preferences" || key === undefined) {
      return;
    }
    if (verb === "delete") {
      delete this.snapshot.keyboard[key];
    } else if (verb === "write") {
      this.snapshot.keyboard[key] =
        flag === "-bool" ? value === "true" : flag === "-int" ? Number(value) : String(value);
    }
  }
}
