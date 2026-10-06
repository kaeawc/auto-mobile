import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import {
  resolveIosInstallBackend,
  SimulatorIosInstallBackend,
  PhysicalIosInstallBackend,
  type IosInstallBackend,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import type { DeviceAppUninstaller } from "../../../src/features/action/UninstallApp";
import { FakeDeviceAppTerminator } from "../../fakes/FakeDeviceAppTerminator";
import { FakeDeviceAppLauncher } from "../../fakes/FakeDeviceAppLauncher";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  PhysicalIosDeviceBackend,
  PhysicalIosTerminateBackend,
  SimulatorIosTerminateBackend,
  resolveIosColdStartTerminateBackend,
  resolveIosDowngradeRecoveryBackend,
  resolveIosSnapshotAppListBackend,
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
  /** Runs inside terminateApp before it settles, e.g. to cancel the request mid-terminate. */
  onTerminate?: () => void;
  terminateOptions?: { timeoutMs?: number; signal?: AbortSignal };

  constructor(private readonly calls: Call[]) {}

  async terminateApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    this.calls.push({ operation: "terminate", bundleId, deviceId: deviceId ?? "" });
    this.terminateOptions = options;
    this.onTerminate?.();
    if (this.terminateError) {
      throw this.terminateError;
    }
  }
}

class FakeDeviceAppUninstaller implements DeviceAppUninstaller {
  uninstallOptions?: { signal?: AbortSignal };

  constructor(private readonly calls: Call[]) {}

  async uninstallApp(
    deviceId: string,
    bundleId: string,
    isSimulator?: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    this.calls.push({ operation: "uninstall", deviceId, bundleId, isSimulator });
    this.uninstallOptions = options;
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
    expect(backend?.kind).toBe("simulator");
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
    expect(backend?.kind).toBe("physical");
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

describe("SimulatorIosDeviceBackend uninstall cancellation (issue #10077)", () => {
  const abortError = () => new DOMException("The operation was aborted", "AbortError");

  function simulatorBackend() {
    const calls: Call[] = [];
    const simctl = new FakeSimctlTerminator(calls);
    const uninstaller = new FakeDeviceAppUninstaller(calls);
    const backend = new SimulatorIosDeviceBackend(simulatorUdid, {
      simctl,
      deviceAppUninstaller: uninstaller,
    });
    return { backend, calls, simctl, uninstaller };
  }

  test("a request cancelled during the terminate leaves the app installed (ambient signal)", async () => {
    const { backend, calls, simctl } = simulatorBackend();
    const controller = new AbortController();
    simctl.onTerminate = () => controller.abort();
    simctl.terminateError = abortError();

    await expect(
      runWithAbortSignal(controller.signal, () => backend.uninstallApp(bundleId)),
    ).rejects.toThrow();

    expect(calls).toEqual([{ operation: "terminate", bundleId, deviceId: simulatorUdid }]);
  });

  test("a request cancelled during the terminate leaves the app installed (explicit signal)", async () => {
    const { backend, calls, simctl } = simulatorBackend();
    const controller = new AbortController();
    simctl.onTerminate = () => controller.abort();
    simctl.terminateError = abortError();

    await expect(backend.uninstallApp(bundleId, controller.signal)).rejects.toThrow();

    expect(calls).toEqual([{ operation: "terminate", bundleId, deviceId: simulatorUdid }]);
  });

  test("a cancellation landing after a successful terminate still stops before the uninstall", async () => {
    const { backend, calls, simctl } = simulatorBackend();
    const controller = new AbortController();
    simctl.onTerminate = () => controller.abort();

    await expect(backend.uninstallApp(bundleId, controller.signal)).rejects.toThrow();

    expect(calls).toEqual([{ operation: "terminate", bundleId, deviceId: simulatorUdid }]);
  });

  test("an already-cancelled request dispatches nothing", async () => {
    const { backend, calls } = simulatorBackend();

    await expect(backend.uninstallApp(bundleId, AbortSignal.abort())).rejects.toThrow();

    expect(calls).toEqual([]);
  });

  test("runs terminate and uninstall under the request signal with a bounded terminate", async () => {
    const { backend, simctl, uninstaller } = simulatorBackend();
    const controller = new AbortController();

    await backend.uninstallApp(bundleId, controller.signal);

    expect(simctl.terminateOptions?.timeoutMs).toBeGreaterThan(0);
    expect(simctl.terminateOptions?.signal?.aborted).toBe(false);
    expect(uninstaller.uninstallOptions?.signal?.aborted).toBe(false);
    controller.abort();
    expect(simctl.terminateOptions?.signal?.aborted).toBe(true);
    expect(uninstaller.uninstallOptions?.signal?.aborted).toBe(true);
  });

  test("a non-cancellation terminate failure still uninstalls without a signal", async () => {
    const { backend, calls, simctl, uninstaller } = simulatorBackend();
    simctl.terminateError = new Error("app not running");

    await backend.uninstallApp(bundleId);

    expect(calls.map((call) => call.operation)).toEqual(["terminate", "uninstall"]);
    expect(uninstaller.uninstallOptions).toBeUndefined();
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

    expect(resolveIosLaunchBackend(simulatorUdid, deps).kind).toBe("simulator");
    expect(resolveIosLaunchBackend(physicalUdid, deps).kind).toBe("physical");
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
    const simctl = new SimCtlClient(null, async (file, args) => {
      commands.push({ file, args });
      return {
        stdout: `${bundleId}: 1234`,
        stderr: "",
        toString: () => `${bundleId}: 1234`,
        trim: () => `${bundleId}: 1234`,
        includes: (value: string) => `${bundleId}: 1234`.includes(value),
      };
    });
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
    expect(backend?.kind).toBe("simulator");
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
    expect(backend?.kind).toBe("physical");
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

  test("cold-start adapter passes the selected simulator to the shared backend", async () => {
    const simctl = new FakeSimctl();
    const backend = resolveIosColdStartTerminateBackend(simulatorUdid, { simctl });

    expect(backend).toBeInstanceOf(SimulatorIosTerminateBackend);
    expect(backend?.kind).toBe("simulator");
    await backend?.terminateApp(bundleId);
    expect(simctl.getMethodCalls("terminateApp")).toEqual([{ bundleId, deviceId: simulatorUdid }]);
  });

  test("cold-start adapter returns no backend for a physical device", () => {
    const simctl = new FakeSimctl();
    expect(resolveIosColdStartTerminateBackend(physicalUdid, { simctl })).toBeNull();
    expect(simctl.getMethodCalls("terminateApp")).toEqual([]);
  });
});

describe("resolveIosInstallBackend", () => {
  test("simulator install and verification use simctl with the resolved device ID", async () => {
    const simctl = new FakeSimctl();
    const apps = [{ bundleId, bundlePath: "/tmp/Test.app" }];
    simctl.setInstalledApps(apps);
    const physicalCalls: string[] = [];
    const backend: IosInstallBackend = resolveIosInstallBackend(simulatorUdid, {
      simctl,
      deviceAppInstaller: {
        installApp: async () => {
          physicalCalls.push("install");
        },
      },
      physicalAppLister: {
        listInstalledApps: async () => {
          physicalCalls.push("list");
          return [];
        },
      },
    });

    expect(backend).toBeInstanceOf(SimulatorIosInstallBackend);
    expect(backend?.kind).toBe("simulator");
    await backend.installApp("/tmp/Test.app");
    expect(await backend.listApps()).toEqual(apps);
    expect(simctl.getMethodCalls("installApp")).toEqual([
      { appPath: "/tmp/Test.app", deviceId: simulatorUdid },
    ]);
    expect(simctl.getMethodCalls("listAppsOrThrow")).toEqual([{ deviceId: simulatorUdid }]);
    expect(physicalCalls).toEqual([]);
  });

  test("physical install and verification use the injected device transports", async () => {
    const simctl = new FakeSimctl();
    const calls: Array<{ deviceId: string; artifactPath?: string }> = [];
    const apps = [{ bundleIdentifier: bundleId }];
    const backend = resolveIosInstallBackend(physicalUdid, {
      simctl,
      deviceAppInstaller: {
        installApp: async (deviceId, artifactPath) => {
          calls.push({ deviceId, artifactPath });
        },
      },
      physicalAppLister: {
        listInstalledApps: async (deviceId) => {
          calls.push({ deviceId });
          return apps;
        },
      },
    });

    expect(backend).toBeInstanceOf(PhysicalIosInstallBackend);
    expect(backend?.kind).toBe("physical");
    await backend.installApp("/tmp/Test.ipa");
    expect(await backend.listApps()).toBe(apps);
    expect(calls).toEqual([
      { deviceId: physicalUdid, artifactPath: "/tmp/Test.ipa" },
      { deviceId: physicalUdid },
    ]);
    expect(simctl.getMethodCalls("installApp")).toEqual([]);
    expect(simctl.getMethodCalls("listAppsOrThrow")).toEqual([]);
  });

  test.each([simulatorUdid, physicalUdid])(
    "preserves install and listing errors for %s",
    async (deviceId) => {
      const installError = new Error("install rejected");
      const listingError = new Error("listing unavailable");
      const backend = resolveIosInstallBackend(deviceId, {
        simctl: {
          installApp: async () => {
            throw installError;
          },
          listAppsOrThrow: async () => {
            throw listingError;
          },
        },
        deviceAppInstaller: {
          installApp: async () => {
            throw installError;
          },
        },
        physicalAppLister: {
          listInstalledApps: async () => {
            throw listingError;
          },
        },
      });

      await expect(backend.installApp("/tmp/Test.app")).rejects.toBe(installError);
      await expect(backend.listApps()).rejects.toBe(listingError);
    },
  );
});

test("malformed IDs keep launch and install on physical backends", () => {
  const deviceId = "unrecognized-device";
  const simctl = new FakeSimctl();
  expect(
    resolveIosLaunchBackend(deviceId, {
      simctl,
      deviceAppLauncher: new FakeDeviceAppLauncher(),
    }).kind,
  ).toBe("physical");
  expect(
    resolveIosInstallBackend(deviceId, {
      simctl,
      deviceAppInstaller: { installApp: async () => {} },
      physicalAppLister: { listInstalledApps: async () => [] },
    }).kind,
  ).toBe("physical");
  expect(resolveIosColdStartTerminateBackend(deviceId, { simctl })).toBeNull();
});

describe("resolveIosDowngradeRecoveryBackend", () => {
  test("routes both recovery operations through simctl with the selected simulator", async () => {
    const simctl = new FakeSimctl();
    const backend = resolveIosDowngradeRecoveryBackend(simulatorUdid, { simctl });

    expect(backend?.kind).toBe("simulator");
    await backend?.terminateApp(bundleId);
    await backend?.uninstallApp(bundleId);
    expect(simctl.getMethodCalls("terminateApp")).toEqual([{ bundleId, deviceId: simulatorUdid }]);
    expect(simctl.getMethodCalls("uninstallApp")).toEqual([{ bundleId, deviceId: simulatorUdid }]);
  });

  test.each([physicalUdid, "unrecognized-device"])(
    "returns no recovery backend for %s",
    (deviceId) => {
      const simctl = new FakeSimctl();
      expect(resolveIosDowngradeRecoveryBackend(deviceId, { simctl })).toBeNull();
      expect(simctl.getMethodCalls("terminateApp")).toEqual([]);
      expect(simctl.getMethodCalls("uninstallApp")).toEqual([]);
    },
  );

  test("preserves both transport errors for the caller", async () => {
    const error = new Error("recovery transport failed");
    const backend = resolveIosDowngradeRecoveryBackend(simulatorUdid, {
      simctl: {
        terminateApp: async () => {
          throw error;
        },
        uninstallApp: async () => {
          throw error;
        },
      },
    });
    await expect(backend!.terminateApp(bundleId)).rejects.toBe(error);
    await expect(backend!.uninstallApp(bundleId)).rejects.toBe(error);
  });
});

describe("resolveIosSnapshotAppListBackend", () => {
  test.each([simulatorUdid, "unrecognized-device"])(
    "keeps strict simctl listing for %s",
    async (deviceId) => {
      const simctl = new FakeSimctl();
      const backend = resolveIosSnapshotAppListBackend(deviceId, { simctl });
      expect(backend?.kind).toBe("simulator");
      expect(await backend?.listApps()).toEqual([]);
      expect(simctl.getMethodCalls("listAppsOrThrow")).toEqual([{ deviceId }]);
      const error = new Error("listing unavailable");
      spyOn(simctl, "listAppsOrThrow").mockRejectedValue(error);
      await expect(backend!.listApps()).rejects.toBe(error);
    },
  );

  test("does not add listing support for physical devices", () => {
    const simctl = new FakeSimctl();
    expect(resolveIosSnapshotAppListBackend(physicalUdid, { simctl })).toBeNull();
    expect(simctl.getMethodCalls("listAppsOrThrow")).toEqual([]);
  });
});
