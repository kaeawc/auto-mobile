import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClearAppData } from "../../../src/features/action/ClearAppData";
import { AppNotInstalledError } from "../../../src/models";
import {
  PhysicalIosClearDataBackend,
  SimulatorIosClearDataBackend,
  resolveIosClearDataBackend,
  type IosClearDataBackendDeps,
  type IosClearDataReinstaller,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import { IOS_APP_DATA_FOLDERS } from "../../../src/utils/ios-cmdline-tools/iosAppContainer";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const simulatorId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const physicalId = "00008030-001A2B3C0E11002E";
const bundleId = "com.example.app";
const containerPath = "/fake/container";

class FakeReinstaller implements IosClearDataReinstaller {
  calls: Array<[string, string]> = [];
  error?: Error;

  async clearAppDataViaReinstall(deviceId: string, id: string): Promise<void> {
    this.calls.push([deviceId, id]);
    if (this.error) {
      throw this.error;
    }
  }
}

function harness() {
  const simctl = new FakeSimCtlClient();
  const reinstaller = new FakeReinstaller();
  const removals: Array<{
    path: Parameters<NonNullable<IosClearDataBackendDeps["rm"]>>[0];
    options: Parameters<NonNullable<IosClearDataBackendDeps["rm"]>>[1];
  }> = [];
  let creations = 0;
  const deps: IosClearDataBackendDeps = {
    simctl,
    createReinstaller: () => {
      creations++;
      return reinstaller;
    },
    rm: async (path, options) => {
      // Both simulator calls must have completed before any folder removal.
      expect(simctl.getMethodCalls("terminateApp")).toEqual([{ bundleId, deviceId: simulatorId }]);
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
        { args: ["get_app_container", simulatorId, bundleId, "data"], timeoutMs: undefined },
      ]);
      removals.push({ path, options });
    },
  };
  return { simctl, reinstaller, deps, removals, creations: () => creations };
}

describe("iOS clear-data backends", () => {
  test("resolves by device shape without constructing a reinstaller", () => {
    const h = harness();
    expect(resolveIosClearDataBackend(simulatorId, h.deps)).toBeInstanceOf(
      SimulatorIosClearDataBackend,
    );
    expect(resolveIosClearDataBackend(physicalId, h.deps)).toBeInstanceOf(
      PhysicalIosClearDataBackend,
    );
    expect(resolveIosClearDataBackend(simulatorId, h.deps).kind).toBe("simulator");
    expect(resolveIosClearDataBackend(physicalId, h.deps).kind).toBe("physical");
    expect(h.creations()).toBe(0);
  });

  test("honours the simulator predicate in both directions", () => {
    const h = harness();
    expect(resolveIosClearDataBackend(physicalId, h.deps, () => true)).toBeInstanceOf(
      SimulatorIosClearDataBackend,
    );
    expect(resolveIosClearDataBackend(simulatorId, h.deps, () => false)).toBeInstanceOf(
      PhysicalIosClearDataBackend,
    );
  });

  test("terminates before resolving the container, then removes only its data folders", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    const terminate = h.simctl.terminateApp.bind(h.simctl);
    h.simctl.terminateApp = async (id, deviceId) => {
      expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
      await terminate(id, deviceId);
    };
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: true,
      packageName: bundleId,
    });
    expect(h.removals).toEqual(
      IOS_APP_DATA_FOLDERS.map((folder) => ({
        path: join(containerPath, folder),
        options: { recursive: true, force: true },
      })),
    );
    expect(h.creations()).toBe(0);
  });

  test("returns the unchanged failure for a missing container of an installed app", async () => {
    const h = harness();
    h.simctl.setInstalledApps([{ bundleId }]);
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: false,
      packageName: bundleId,
      error: `Could not resolve data container for ${bundleId} (is it installed?)`,
    });
    expect(h.removals).toHaveLength(0);
  });

  test("container lookup errors on an installed app return the missing-container result", async () => {
    const h = harness();
    h.simctl.setInstalledApps([{ bundleId }]);
    h.simctl.setContainerError(bundleId, new Error("lookup failed"));
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: false,
      packageName: bundleId,
      error: `Could not resolve data container for ${bundleId} (is it installed?)`,
    });
    expect(h.removals).toHaveLength(0);
  });

  test("throws AppNotInstalledError when the listing succeeds without the bundle", async () => {
    const h = harness();
    h.simctl.setInstalledApps([{ bundleId: "com.example.other" }]);
    const outcome = resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId);
    await expect(outcome).rejects.toBeInstanceOf(AppNotInstalledError);
    await expect(outcome).rejects.toThrow(bundleId);
    expect(h.simctl.getMethodCalls("listAppsOrThrow")).toEqual([{ deviceId: simulatorId }]);
    expect(h.removals).toHaveLength(0);
  });

  test("an unreadable app listing stays a retryable failure, not not-installed", async () => {
    const h = harness();
    h.simctl.setListAppsError(new Error("simctl listapps timed out"));
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: false,
      packageName: bundleId,
      error: `Could not resolve data container for ${bundleId} (is it installed?)`,
    });
    expect(h.removals).toHaveLength(0);
  });

  test("does not list apps when the container resolves", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId);
    expect(h.simctl.getMethodCalls("listAppsOrThrow")).toHaveLength(0);
  });

  test("continues clearing when the app is already stopped", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    const terminate = h.simctl.terminateApp.bind(h.simctl);
    h.simctl.terminateApp = async (id, deviceId) => {
      await terminate(id, deviceId);
      throw new Error("not running");
    };
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: true,
      packageName: bundleId,
    });
    expect(h.removals).toHaveLength(3);
  });

  test("returns the removal error unchanged", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    h.deps.rm = async () => {
      throw new Error("permission denied");
    };
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: false,
      packageName: bundleId,
      error: "permission denied",
    });
  });

  test("physical clearing reinstalls lazily without simulator operations", async () => {
    const h = harness();
    expect(await resolveIosClearDataBackend(physicalId, h.deps).clearAppData(bundleId)).toEqual({
      success: true,
      packageName: bundleId,
    });
    expect(h.reinstaller.calls).toEqual([[physicalId, bundleId]]);
    expect(h.creations()).toBe(1);
    expect(h.simctl.getMethodCalls("terminateApp")).toHaveLength(0);
    expect(h.simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
    expect(h.removals).toHaveLength(0);
  });

  test("physical clearing returns reinstall failure unchanged", async () => {
    const h = harness();
    h.reinstaller.error = new Error("app is now UNINSTALLED: device offline");
    expect(await resolveIosClearDataBackend(physicalId, h.deps).clearAppData(bundleId)).toEqual({
      success: false,
      packageName: bundleId,
      error: h.reinstaller.error.message,
    });
  });

  test("ClearAppData forwards the predicate to its injected resolver", async () => {
    const h = harness();
    const predicate = () => false;
    const action = new ClearAppData(
      { deviceId: simulatorId, name: "fake", platform: "ios" },
      undefined,
      {
        reinstaller: h.reinstaller,
        isSimulatorFn: predicate,
        backendResolver: (deviceId, deps, isSimulatorFn) => {
          expect(deviceId).toBe(simulatorId);
          expect(isSimulatorFn).toBe(predicate);
          return resolveIosClearDataBackend(deviceId, { ...deps, simctl: h.simctl }, isSimulatorFn);
        },
      },
    );
    expect(await action.execute(bundleId)).toEqual({ success: true, packageName: bundleId });
    expect(h.reinstaller.calls).toEqual([[simulatorId, bundleId]]);
  });
});
