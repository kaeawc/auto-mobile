import type {
  CoreDeviceGuardVersionProvider,
  CoreDeviceVersion,
  DevicectlCommandInvoker,
  DevicectlCommandResult,
  DevicectlVersionSource,
  SimulatorBootStateProvider,
} from "../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";

export class FakeDevicectlVersionSource implements DevicectlVersionSource {
  calls = 0;
  failure?: Error;

  constructor(private readonly capturedOutput: string) {}

  async getDevicectlVersion(): Promise<string> {
    this.calls += 1;
    if (this.failure) {
      throw this.failure;
    }
    return this.capturedOutput;
  }
}

export class FakeCoreDeviceGuardVersionProvider implements CoreDeviceGuardVersionProvider {
  versions?: {
    installedCoreDevice: CoreDeviceVersion;
    selectedDeveloperDirCoreDevice: CoreDeviceVersion;
  };

  async getVersions() {
    return this.versions;
  }
}

export class FakeSimulatorBootStateProvider implements SimulatorBootStateProvider {
  state: "booted" | "shutdown" | "unknown" = "booted";
  calls = 0;

  async getBootState(): Promise<"booted" | "shutdown" | "unknown"> {
    this.calls += 1;
    return this.state;
  }
}

export class FakeDevicectlCommandInvoker implements DevicectlCommandInvoker {
  calls: Array<{ deviceId: string; command: string }> = [];
  result: DevicectlCommandResult = { kind: "ok" };

  async invoke(deviceId: string, command: string): Promise<DevicectlCommandResult> {
    this.calls.push({ deviceId, command });
    return this.result;
  }
}
