import type { DeviceUrlLauncher } from "../../src/utils/ios-cmdline-tools/DeviceCtlClient";

/**
 * Test double for {@link DeviceCtlClient} implementing the narrow
 * {@link DeviceUrlLauncher} seam OpenURL depends on. Records every
 * launchWithPayloadUrl call so tests can assert the exact
 * (deviceUdid, bundleId, url) devicectl would receive without shelling out.
 */
export class FakeDeviceCtlClient implements DeviceUrlLauncher {
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

  async isAvailable(): Promise<boolean> {
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
