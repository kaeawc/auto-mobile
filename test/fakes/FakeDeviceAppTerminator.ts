import { DeviceAppTerminator } from "../../src/features/action/TerminateApp";

type TerminateCall = { deviceUdid: string; bundleId: string };

type FakeDeviceAppTerminatorOptions = {
  result?: { wasInstalled: boolean; wasRunning: boolean };
  error?: Error;
};

/**
 * Records devicectl terminate calls so TerminateApp tests can assert the
 * physical-device path was taken without shelling out. Parallels the injected
 * simctl fake used for the simulator path and FakeDeviceAppLauncher for launch.
 */
export class FakeDeviceAppTerminator implements DeviceAppTerminator {
  readonly terminateCalls: TerminateCall[] = [];
  private result: { wasInstalled: boolean; wasRunning: boolean };
  private error: Error | undefined;

  constructor(options: FakeDeviceAppTerminatorOptions = {}) {
    this.result = options.result ?? { wasInstalled: true, wasRunning: true };
    this.error = options.error;
  }

  setResult(result: { wasInstalled: boolean; wasRunning: boolean }): void {
    this.result = result;
    this.error = undefined;
  }

  setError(error: Error): void {
    this.error = error;
  }

  async terminateApp(
    deviceUdid: string,
    bundleId: string,
  ): Promise<{ wasInstalled: boolean; wasRunning: boolean }> {
    this.terminateCalls.push({ deviceUdid, bundleId });
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}
