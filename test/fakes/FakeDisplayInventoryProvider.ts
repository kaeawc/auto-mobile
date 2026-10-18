import type { BootedDevice } from "../../src/models";
import { displayInventoryOutcome, type DisplayInventoryOutcome } from "../../src/models/DeviceInfo";
import type { DeviceDisplays } from "../../src/models/DisplayPanel";
import type {
  DisplayInventoryProvider,
  DisplayInventorySource,
} from "../../src/devices/DisplayInventoryProvider";

export class FakeDisplayInventorySource implements DisplayInventorySource {
  reads = 0;
  constructor(
    public result: Awaited<ReturnType<DisplayInventorySource["read"]>> = { degraded: false },
  ) {}
  async read(): ReturnType<DisplayInventorySource["read"]> {
    this.reads++;
    return this.result;
  }
}

interface FakeInventoryEntry {
  token: string;
  displays: DeviceDisplays | undefined;
  outcome: DisplayInventoryOutcome;
}

/**
 * Mirrors CachingDisplayInventoryProvider's observable contract: an inventory is read once per
 * (platform, device, identity token), invalidate() forces the next hydrate to re-read, a device
 * that already carries panels is returned untouched, and every read stamps the inventory outcome.
 * Set `displays` (and optionally `outcome`) to script what the next read observes.
 */
export class FakeDisplayInventoryProvider implements DisplayInventoryProvider {
  calls = 0;
  tokens: string[] = [];
  invalidations: string[] = [];
  /** Overrides the outcome a read reports; defaults to multi/single from `displays`. */
  outcome?: DisplayInventoryOutcome;
  private readonly entries = new Map<string, FakeInventoryEntry>();
  constructor(public displays?: DeviceDisplays) {}
  async hydrate(device: BootedDevice, identityToken: string): Promise<BootedDevice> {
    this.calls++;
    this.tokens.push(identityToken);
    if (device.displays?.panels.length) {
      return device;
    }
    const key = `${device.platform}:${device.deviceId}`;
    let entry = this.entries.get(key);
    if (!entry || entry.token !== identityToken) {
      entry = {
        token: identityToken,
        displays: this.displays,
        outcome: this.outcome ?? (this.displays ? { kind: "multi" } : { kind: "single" }),
      };
      this.entries.set(key, entry);
    }
    return {
      ...device,
      ...(entry.displays ? { displays: entry.displays } : {}),
      [displayInventoryOutcome]: entry.outcome,
    };
  }
  invalidate(deviceId: string): void {
    this.invalidations.push(deviceId);
    for (const key of this.entries.keys()) {
      if (key.endsWith(`:${deviceId}`)) {
        this.entries.delete(key);
      }
    }
  }
}
