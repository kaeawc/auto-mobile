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
    if (this.profiles.has(udid)) {
      this.profiles.set(udid, {
        offline: false,
        delayMs: 0,
        downloadKbps: 0,
        uploadKbps: 0,
        packetLossPercent: 0,
      });
    }
  }

  async read(udid: string): Promise<IosNetworkShaperReadResult> {
    const profile = this.profiles.get(udid);
    return { injected: this.injected.has(udid), ...(profile ? { profile } : {}) };
  }
}
