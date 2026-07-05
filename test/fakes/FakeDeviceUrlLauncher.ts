import type { DeviceUrlLauncher } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";

/**
 * Test double for {@link DeviceAppManager}'s {@link DeviceUrlLauncher} seam
 * OpenURL depends on for the physical-device open-URL path. Records every
 * launchWithPayloadUrl call so tests can assert the exact
 * (deviceUdid, bundleId, url) devicectl would receive without shelling out.
 */
export class FakeDeviceUrlLauncher implements DeviceUrlLauncher {
  private available = true;
  private launchError: Error | null = null;
  public readonly launchCalls: Array<{ deviceUdid: string; bundleId: string; url: string }> = [];
  public availabilityChecks = 0;

  setAvailable(available: boolean): void {
    this.available = available;
  }

  setLaunchError(error: Error | null): void {
    this.launchError = error;
  }

  async isUrlLaunchAvailable(): Promise<boolean> {
    this.availabilityChecks++;
    return this.available;
  }

  async launchWithPayloadUrl(deviceUdid: string, bundleId: string, url: string): Promise<void> {
    this.launchCalls.push({ deviceUdid, bundleId, url });
    if (this.launchError) {
      throw this.launchError;
    }
  }
}
