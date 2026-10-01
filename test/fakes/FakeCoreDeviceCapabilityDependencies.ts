import type {
  CoreDeviceGuardVersionProvider,
  CoreDeviceVersion,
  DevicectlCommandInvoker,
  DevicectlCommandResult,
  SimulatorBootStateProvider,
} from "../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import type { ExecResult } from "../../src/models";

export class FakeCoreDeviceVersionExecutor implements Pick<HostCommandExecutor, "executeCommand"> {
  calls = 0;
  failure?: Error;

  constructor(private readonly capturedOutput: string) {}

  async executeCommand(file: string, args: string[]): Promise<ExecResult> {
    this.calls += 1;
    if (file !== "xcrun" || args.join(" ") !== "devicectl --version") {
      throw new Error("Unexpected version command");
    }
    if (this.failure) {
      throw this.failure;
    }
    const stdout = this.capturedOutput;
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value: string) => stdout.includes(value),
    };
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
