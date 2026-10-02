import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { DeviceAppUninstaller } from "../../../src/features/action/UninstallApp";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeDeviceAppTerminator } from "../../fakes/FakeDeviceAppTerminator";
import { FakeDeviceAppLauncher } from "../../fakes/FakeDeviceAppLauncher";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  PhysicalIosDeviceBackend,
  PhysicalIosTerminateBackend,
  SimulatorIosTerminateBackend,
  resolveIosTerminateBackend,
  resolveIosDeviceBackend,
  resolveIosLaunchBackend,
  SimulatorIosDeviceBackend,
  type IosDeviceBackend,
  type IosLaunchBackend,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";
const bundleId = "com.example.app";
const fakeDevicectlTempDir = "/tmp/fake-devicectl";

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
  test("passes launch arguments through simulator and physical backends", async () => {
    const launchArguments = ["--automobile-mutation-token", "test-token"];
    const simulatorCalls: Array<{ bundleId: string; options?: { launchArguments?: string[] } }> =
      [];
    const launcher = new FakeDeviceAppLauncher();
    const deps = {
      simctl: {
        launchApp: async (id: string, options?: { launchArguments?: string[] }) => {
          simulatorCalls.push({ bundleId: id, options });
          return { success: true };
        },
      },
      deviceAppLauncher: launcher,
    };

    await resolveIosLaunchBackend(simulatorUdid, deps).launchApp(bundleId, {
      foregroundIfRunning: false,
      launchArguments,
    });
    await resolveIosLaunchBackend(physicalUdid, deps).launchApp(bundleId, { launchArguments });

    expect(simulatorCalls).toEqual([
      { bundleId, options: { foregroundIfRunning: false, launchArguments } },
    ]);
    expect(launcher.launchCalls).toEqual([
      { deviceUdid: physicalUdid, bundleId, terminateExisting: true, launchArguments },
    ]);
  });

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
      mkdtemp: async () => fakeDevicectlTempDir,
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
        join(fakeDevicectlTempDir, "launch.json"),
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

describe("resolveIosTerminateBackend", () => {
  test("selects simulator backend and preserves simctl argument order", async () => {
    const simctl = new FakeSimctl();
    const terminator = new FakeDeviceAppTerminator();
    const backend = resolveIosTerminateBackend(simulatorUdid, {
      simctl,
      deviceAppTerminator: terminator,
    });

    expect(backend).toBeInstanceOf(SimulatorIosTerminateBackend);
    expect(backend.requiresInstalledAppCheck).toBe(true);
    expect(await backend.terminateApp(bundleId)).toEqual({ wasInstalled: true, wasRunning: true });
    expect(simctl.getMethodCalls("terminateApp")).toEqual([{ bundleId, deviceId: simulatorUdid }]);
    expect(terminator.terminateCalls).toEqual([]);
  });

  test("selects physical backend and preserves terminator argument order and outcome", async () => {
    const simctl = new FakeSimctl();
    const terminator = new FakeDeviceAppTerminator({
      result: { wasInstalled: true, wasRunning: false },
    });
    const backend = resolveIosTerminateBackend(physicalUdid, {
      simctl,
      deviceAppTerminator: terminator,
    });

    expect(backend).toBeInstanceOf(PhysicalIosTerminateBackend);
    expect(backend.requiresInstalledAppCheck).toBe(false);
    expect(await backend.terminateApp(bundleId)).toEqual({ wasInstalled: true, wasRunning: false });
    expect(terminator.terminateCalls).toEqual([{ deviceUdid: physicalUdid, bundleId }]);
    expect(simctl.getMethodCalls("terminateApp")).toEqual([]);
  });

  test("simulator backend propagates transport errors for action-level mapping", async () => {
    const simctl = new FakeSimctl();
    const error = new Error("found nothing to terminate");
    spyOn(simctl, "terminateApp").mockRejectedValue(error);
    const backend = resolveIosTerminateBackend(simulatorUdid, {
      simctl,
      deviceAppTerminator: new FakeDeviceAppTerminator(),
    });

    await expect(backend.terminateApp(bundleId)).rejects.toBe(error);
  });

  test("physical backend propagates transport errors for action-level logging", async () => {
    const error = new Error("device disconnected");
    const backend = resolveIosTerminateBackend(physicalUdid, {
      simctl: new FakeSimctl(),
      deviceAppTerminator: new FakeDeviceAppTerminator({ error }),
    });

    await expect(backend.terminateApp(bundleId)).rejects.toBe(error);
  });
});
