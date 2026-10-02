import type { BootedDevice } from "../../src/models";
import type { DeviceWindowCacheInvalidator } from "../../src/features/action/TerminateApp";

export class FakeDeviceWindowCacheInvalidator implements DeviceWindowCacheInvalidator {
  public calls: BootedDevice[] = [];

  constructor(private readonly onInvalidate?: (device: BootedDevice) => void) {}

  invalidate(device: BootedDevice): void {
    this.calls.push(device);
    this.onInvalidate?.(device);
  }
}
