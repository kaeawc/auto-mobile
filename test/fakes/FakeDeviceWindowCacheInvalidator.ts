import type { BootedDevice } from "../../src/models";
import type { DeviceWindowCacheInvalidator } from "../../src/features/action/TerminateApp";
import type { ObserveResultCacheStore } from "../../src/features/observe/cache/ObserveResultCacheStore";

export class FakeDeviceWindowCacheInvalidator implements DeviceWindowCacheInvalidator {
  public calls: BootedDevice[] = [];
  public retiredProcesses: Array<{ device: BootedDevice; packageName: string }> = [];
  private readonly windowResolutionRequired = new Set<string>();

  /**
   * @param onInvalidate observer for each invalidate call.
   * @param observeCache when given, invalidate clears this device's cached observation from it,
   *   as the default invalidator does against the registered observe-result store.
   */
  constructor(
    private readonly onInvalidate?: (device: BootedDevice, preserveAppIdentity?: boolean) => void,
    private readonly observeCache?: ObserveResultCacheStore,
  ) {}

  invalidate(device: BootedDevice, preserveAppIdentity?: boolean): void {
    this.calls.push(device);
    this.observeCache?.clear(device.deviceId);
    if (device.platform === "android") {
      this.windowResolutionRequired.add(device.deviceId);
    }
    this.onInvalidate?.(device, preserveAppIdentity);
  }

  retireAppProcess(device: BootedDevice, packageName: string): void {
    this.retiredProcesses.push({ device, packageName });
  }

  /** Android invalidation requires the next element resolution to re-read the window. */
  isWindowResolutionRequired(deviceId: string): boolean {
    return this.windowResolutionRequired.has(deviceId);
  }
}
