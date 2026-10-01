import { describe, expect, test } from "bun:test";
import type { DeviceAppUninstaller } from "../../../src/features/action/UninstallApp";
import { FakeDeviceAppLauncher } from "../../fakes/FakeDeviceAppLauncher";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  PhysicalIosDeviceBackend,
  resolveIosDeviceBackend,
  resolveIosLaunchBackend,
  SimulatorIosDeviceBackend,
  type IosDeviceBackend,
  type IosLaunchBackend,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";
const bundleId = "com.example.app";

type Call =
  | { operation: "terminate"; bundleId: string; deviceId: string }
  | { operation: "uninstall"; deviceId: string; bundleId: string; isSimulator?: boolean };

class FakeSimctlTerminator {
  terminateError?: Error;

  constructor(private readonly calls: Call[]) {}

  async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
    this.calls.push({ operation: "terminate", bundleId, deviceId: deviceId ?? "" });
    if (this.terminateError) {
      throw this.terminateError;
    }
  }
}

class FakeDeviceAppUninstaller implements DeviceAppUninstaller {
  constructor(private readonly calls: Call[]) {}

  async uninstallApp(deviceId: string, bundleId: string, isSimulator?: boolean): Promise<void> {
    this.calls.push({ operation: "uninstall", deviceId, bundleId, isSimulator });
  }
}

describe("resolveIosDeviceBackend", () => {
  test("selects simulator backend and terminates before uninstalling", async () => {
    type ReturnsInterface = [ReturnType<typeof resolveIosDeviceBackend>] extends [IosDeviceBackend]
      ? [IosDeviceBackend] extends [ReturnType<typeof resolveIosDeviceBackend>]
        ? true
        : false
      : false;
    const returnsInterface: ReturnsInterface = true;
    expect(returnsInterface).toBe(true);

    const calls: Call[] = [];
    const backend: IosDeviceBackend = resolveIosDeviceBackend(simulatorUdid, {
      simctl: new FakeSimctlTerminator(calls),
      deviceAppUninstaller: new FakeDeviceAppUninstaller(calls),
    });

    expect(backend).toBeInstanceOf(SimulatorIosDeviceBackend);
    await backend.uninstallApp(bundleId);
    expect(calls).toEqual([
      { operation: "terminate", bundleId, deviceId: simulatorUdid },
      { operation: "uninstall", deviceId: simulatorUdid, bundleId, isSimulator: true },
    ]);
  });

  test("selects physical backend and uninstalls without terminating", async () => {
    const calls: Call[] = [];
    const backend = resolveIosDeviceBackend(physicalUdid, {
      simctl: new FakeSimctlTerminator(calls),
      deviceAppUninstaller: new FakeDeviceAppUninstaller(calls),
    });

    expect(backend).toBeInstanceOf(PhysicalIosDeviceBackend);
    await backend.uninstallApp(bundleId);
    expect(calls).toEqual([
      { operation: "uninstall", deviceId: physicalUdid, bundleId, isSimulator: false },
    ]);
  });

  test("still uninstalls a simulator app when termination fails", async () => {
    const calls: Call[] = [];
    const simctl = new FakeSimctlTerminator(calls);
    simctl.terminateError = new Error("app not running");
    const backend = resolveIosDeviceBackend(simulatorUdid, {
      simctl,
      deviceAppUninstaller: new FakeDeviceAppUninstaller(calls),
    });

    await backend.uninstallApp(bundleId);
    expect(calls).toEqual([
      { operation: "terminate", bundleId, deviceId: simulatorUdid },
      { operation: "uninstall", deviceId: simulatorUdid, bundleId, isSimulator: true },
    ]);
  });
});

describe("resolveIosLaunchBackend", () => {
  test("simulator cold and warm launches preserve simctl argv", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const simctl = new SimCtlClient(
      { deviceId: simulatorUdid, name: "Test iOS Simulator", platform: "ios" },
      async (file, args) => {
        commands.push({ file, args });
        return {
          stdout: `${bundleId}: 1234`,
          stderr: "",
          toString: () => `${bundleId}: 1234`,
          trim: () => `${bundleId}: 1234`,
          includes: (value: string) => `${bundleId}: 1234`.includes(value),
        };
      },
    );
    const backend: IosLaunchBackend = resolveIosLaunchBackend(simulatorUdid, {
      simctl,
      deviceAppLauncher: new FakeDeviceAppLauncher(),
    });

    expect(await backend.launchApp(bundleId, { foregroundIfRunning: false })).toEqual({
      success: true,
      pid: 1234,
    });
    expect(await backend.launchApp(bundleId)).toEqual({ success: true, pid: 1234 });
    expect(commands).toEqual([
      { file: "xcrun", args: ["simctl", "launch", simulatorUdid, bundleId] },
      { file: "xcrun", args: ["simctl", "launch", simulatorUdid, bundleId] },
    ]);
  });

  test("physical backend keeps DeviceAppManager devicectl launch argv", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const launcher = new DeviceAppManager({
      platform: () => "darwin",
      execute: async (file, args) => {
        commands.push({ file, args });
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
      readFile: async (path) =>
        path.endsWith("launch.json")
          ? JSON.stringify({ result: { process: { processIdentifier: 4321 } } })
          : "{}",
      mkdtemp: async () => "/tmp/fake-devicectl",
      rm: async () => undefined,
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false }),
      tmpdir: () => "/tmp",
      logger: { debug: () => undefined, warn: () => undefined },
    });
    const backend = resolveIosLaunchBackend(physicalUdid, {
      simctl: { launchApp: async () => ({ success: true }) },
      deviceAppLauncher: launcher,
    });

    expect(await backend.launchApp(bundleId)).toEqual({ success: true, pid: 4321 });
    expect(commands[1]).toEqual({
      file: "xcrun",
      args: [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        physicalUdid,
        "--terminate-existing",
        "--json-output",
        "/tmp/fake-devicectl/launch.json",
        "--quiet",
        bundleId,
      ],
    });
  });

  test("physical cold and warm launches retain DeviceAppManager argument shapes", async () => {
    const launcher = new FakeDeviceAppLauncher();
    const backend = resolveIosLaunchBackend(physicalUdid, {
      simctl: { launchApp: async () => ({ success: true }) },
      deviceAppLauncher: launcher,
    });

    expect(await backend.launchApp(bundleId, { foregroundIfRunning: false })).toEqual({
      success: true,
      pid: 4321,
    });
    expect(await backend.launchApp(bundleId)).toEqual({ success: true, pid: 4321 });
    expect(launcher.launchCalls).toEqual([
      { deviceUdid: physicalUdid, bundleId, terminateExisting: true },
      { deviceUdid: physicalUdid, bundleId, terminateExisting: true },
    ]);
  });
});
