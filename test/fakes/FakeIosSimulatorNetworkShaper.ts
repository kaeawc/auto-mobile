import type {
  IosNetworkShaperApplyResult,
  IosNetworkShaperProfile,
  IosNetworkShaperReadResult,
  IosSimulatorNetworkShaper,
} from "../../src/features/utility/ios/IosSimulatorNetworkShaper";

/** In-memory shaper: the first apply per simulator "reboots" it, later ones apply live. */
export class FakeIosSimulatorNetworkShaper implements IosSimulatorNetworkShaper {
  readonly calls: Array<{
    op: "apply" | "clear";
    udid: string;
    profile?: IosNetworkShaperProfile;
  }> = [];
  readonly profiles = new Map<string, IosNetworkShaperProfile>();
  readonly injected = new Set<string>();
  applyError?: Error;
  clearError?: Error;
  readError?: Error;

  async apply(
    udid: string,
    profile: IosNetworkShaperProfile,
  ): Promise<IosNetworkShaperApplyResult> {
    this.calls.push({ op: "apply", udid, profile });
    if (this.applyError) {
      throw this.applyError;
    }
    this.profiles.set(udid, profile);
    const rebooted = !this.injected.has(udid);
    this.injected.add(udid);
    return { rebooted };
  }

  async clear(udid: string): Promise<void> {
    this.calls.push({ op: "clear", udid });
    if (this.clearError) {
      throw this.clearError;
    }
    // Like the real shaper: the profile is removed, so reads fall through to per-app rules.
    this.profiles.delete(udid);
  }

  /** Simulators whose profile's writer is still running; the rest are orphaned. */
  readonly liveOwners = new Set<string>();

  async clearOrphaned(): Promise<string[]> {
    const cleared = [...this.profiles.keys()].filter((udid) => !this.liveOwners.has(udid));
    cleared.forEach((udid) => this.profiles.delete(udid));
    return cleared;
  }

  async read(udid: string): Promise<IosNetworkShaperReadResult> {
    if (this.readError) {
      throw this.readError;
    }
    const profile = this.profiles.get(udid);
    return { injected: this.injected.has(udid), ...(profile ? { profile } : {}) };
  }
}
