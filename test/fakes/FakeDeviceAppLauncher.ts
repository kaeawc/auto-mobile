import { DeviceAppLauncher } from "../../src/features/action/LaunchApp";

type LaunchCall = { deviceUdid: string; bundleId: string; terminateExisting: boolean };
type TerminateCall = { deviceUdid: string; bundleId: string; knownPid?: number };

type FakeDeviceAppLauncherOptions = {
  launchResult?: { success: boolean; pid?: number; error?: string };
};

/**
 * Records devicectl launch/terminate calls so LaunchApp tests can assert the
 * physical-device path was taken without shelling out. Parallels the injected
 * simctl fake used for the simulator path.
 */
export class FakeDeviceAppLauncher implements DeviceAppLauncher {
  readonly launchCalls: LaunchCall[] = [];
  readonly terminateCalls: TerminateCall[] = [];
  private launchResult: { success: boolean; pid?: number; error?: string };

  constructor(options: FakeDeviceAppLauncherOptions = {}) {
    this.launchResult = options.launchResult ?? { success: true, pid: 4321 };
  }

  setLaunchResult(result: { success: boolean; pid?: number; error?: string }): void {
    this.launchResult = result;
  }

  async launchApp(
    deviceUdid: string,
    bundleId: string,
    options: { terminateExisting?: boolean } = {}
  ): Promise<{ success: boolean; pid?: number; error?: string }> {
    this.launchCalls.push({ deviceUdid, bundleId, terminateExisting: options.terminateExisting ?? false });
    return this.launchResult;
  }

  async terminateApp(deviceUdid: string, bundleId: string, knownPid?: number): Promise<void> {
    this.terminateCalls.push({ deviceUdid, bundleId, knownPid });
  }
}
