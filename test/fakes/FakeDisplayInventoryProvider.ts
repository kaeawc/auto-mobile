import type { BootedDevice } from "../../src/models";
import type { DeviceDisplays } from "../../src/models/DisplayPanel";
import type {
  DisplayInventoryProvider,
  DisplayInventorySource,
} from "../../src/devices/DisplayInventoryProvider";

export class FakeDisplayInventorySource implements DisplayInventorySource {
  reads = 0;
  constructor(
    public result: { displays?: DeviceDisplays; degraded: boolean } = { degraded: false },
  ) {}
  async read(): Promise<{ displays?: DeviceDisplays; degraded: boolean }> {
    this.reads++;
    return this.result;
  }
}

export class FakeDisplayInventoryProvider implements DisplayInventoryProvider {
  calls = 0;
  tokens: string[] = [];
  invalidations: string[] = [];
  constructor(public displays?: DeviceDisplays) {}
  async hydrate(device: BootedDevice, identityToken: string): Promise<BootedDevice> {
    this.calls++;
    this.tokens.push(identityToken);
    return this.displays ? { ...device, displays: this.displays } : device;
  }
  invalidate(deviceId: string): void {
    this.invalidations.push(deviceId);
  }
}
