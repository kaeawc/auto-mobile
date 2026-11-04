import { SimulatorContainerOwnershipError } from "../../../src/utils/ios-cmdline-tools/simulatorOwnContainer";
import { cloneContainerFixture } from "../../helpers/simulatorContainerFixture";
import {
  simulatorOwnership,
  simulatorDataContainer,
} from "../../helpers/simulatorContainerFixture";
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { ClearAppData } from "../../../src/features/action/ClearAppData";
import { AppNotInstalledError } from "../../../src/models";
import {
  PhysicalIosClearDataBackend,
  SimulatorIosClearDataBackend,
  resolveIosClearDataBackend,
  type IosAppDataFileSystem,
  type IosClearDataBackendDeps,
  type IosClearDataReinstaller,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import { IOS_APP_DATA_FOLDERS } from "../../../src/utils/ios-cmdline-tools/iosAppContainer";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const simulatorId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const physicalId = "00008030-001A2B3C0E11002E";
const bundleId = "com.example.app";
const containerPath = simulatorDataContainer(simulatorId);

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

class FakeAppDataFileSystem implements IosAppDataFileSystem {
  readonly nodes = new Map<string, { kind: "directory" | "file" }>();
  readonly removals: Array<{ path: string; options: { recursive: boolean; force: boolean } }> = [];
  readonly creations: Array<{ path: string; options?: { recursive?: boolean; mode?: number } }> =
    [];
  beforeRemove?: () => void;
  removalError?: Error;
  readError?: Error;

  seed(root: string): void {
    this.nodes.set(root, { kind: "directory" });
    for (const folder of [
      "Documents",
      "Library",
      "Library/Caches",
      "Library/Preferences",
      "Library/Other",
      "tmp",
    ]) {
      this.nodes.set(join(root, folder), { kind: "directory" });
    }
    for (const file of [
      ".com.apple.mobile_container_manager.metadata.plist",
      "Documents/a.txt",
      "Library/Caches/b",
      "Library/Preferences/c.plist",
      "Library/Other/d",
      "tmp/d",
    ]) {
      this.write(join(root, file));
    }
  }

  write(path: string): void {
    if (this.nodes.get(dirname(path))?.kind !== "directory") {
      throw new Error(`Missing parent directory for ${path}`);
    }
    this.nodes.set(path, { kind: "file" });
  }

  async readdir(path: string): Promise<string[]> {
    if (this.readError) {
      throw this.readError;
    }
    const node = this.nodes.get(path);
    if (!node) {
      throw Object.assign(new Error(`Missing directory ${path}`), { code: "ENOENT" });
    }
    if (node.kind !== "directory") {
      throw Object.assign(new Error(`Not a directory ${path}`), { code: "ENOTDIR" });
    }
    return [...this.nodes.keys()]
      .filter((entry) => dirname(entry) === path)
      .map((entry) => entry.slice(path.length + 1));
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    this.creations.push({ path, options });
    if (this.nodes.get(path)?.kind === "directory" && options?.recursive) {
      return;
    }
    if (this.nodes.has(path)) {
      throw new Error(`Already exists: ${path}`);
    }
    if (this.nodes.get(dirname(path))?.kind !== "directory") {
      if (!options?.recursive) {
        throw new Error(`Missing parent directory for ${path}`);
      }
      await this.mkdir(dirname(path), options);
    }
    this.nodes.set(path, { kind: "directory" });
  }

  async rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void> {
    this.beforeRemove?.();
    this.removals.push({ path, options });
    if (this.removalError) {
      throw this.removalError;
    }
    for (const entry of this.nodes.keys()) {
      if (entry === path || entry.startsWith(`${path}/`)) {
        this.nodes.delete(entry);
      }
    }
  }
}

function harness() {
  const simctl = new FakeSimctl();
  const reinstaller = new FakeReinstaller();
  const appDataFs = new FakeAppDataFileSystem();
  appDataFs.seed(containerPath);
  appDataFs.beforeRemove = () => {
    expect(simctl.getMethodCalls("terminateApp")).toEqual([{ bundleId, deviceId: simulatorId }]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: ["get_app_container", simulatorId, bundleId, "data"], timeoutMs: undefined },
    ]);
  };
  let creations = 0;
  const deps: IosClearDataBackendDeps = {
    containerOwnership: simulatorOwnership,
    simctl,
    createReinstaller: () => {
      creations++;
      return reinstaller;
    },
    appDataFs,
  };
  return {
    simctl,
    reinstaller,
    deps,
    appDataFs,
    removals: appDataFs.removals,
    creations: () => creations,
  };
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
    const directoriesBefore = IOS_APP_DATA_FOLDERS.map((folder) =>
      h.appDataFs.nodes.get(join(containerPath, folder)),
    );
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: true,
      packageName: bundleId,
    });
    IOS_APP_DATA_FOLDERS.forEach((folder, index) => {
      expect(h.appDataFs.nodes.get(join(containerPath, folder))).toBe(directoriesBefore[index]);
    });
    for (const folder of IOS_APP_DATA_FOLDERS) {
      expect(h.appDataFs.nodes.get(join(containerPath, folder))?.kind).toBe("directory");
      expect(await h.appDataFs.readdir(join(containerPath, folder))).toEqual(
        folder === "Library" ? ["Caches", "Preferences"] : [],
      );
    }
    for (const folder of ["Caches", "Preferences"]) {
      expect(await h.appDataFs.readdir(join(containerPath, "Library", folder))).toEqual([]);
    }
    expect(h.appDataFs.nodes.get(containerPath)?.kind).toBe("directory");
    expect(
      h.appDataFs.nodes.get(
        join(containerPath, ".com.apple.mobile_container_manager.metadata.plist"),
      )?.kind,
    ).toBe("file");
    h.appDataFs.write(join(containerPath, "tmp", "download"));
    expect(await h.appDataFs.readdir(join(containerPath, "tmp"))).toEqual(["download"]);
    expect(
      h.removals.every(
        ({ path, options }) =>
          !IOS_APP_DATA_FOLDERS.some((folder) => path === join(containerPath, folder)) &&
          options.recursive &&
          options.force,
      ),
    ).toBe(true);
    expect(h.creations()).toBe(0);
  });

  test.each(IOS_APP_DATA_FOLDERS)("creates missing %s with mode 0755", async (folder) => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    h.appDataFs.beforeRemove = undefined;
    await h.appDataFs.rm(join(containerPath, folder), { recursive: true, force: true });
    h.removals.length = 0;
    expect(
      await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId),
    ).toMatchObject({ success: true });
    expect(h.appDataFs.creations).toContainEqual({
      path: join(containerPath, folder),
      options: { mode: 0o755 },
    });
    expect(await h.appDataFs.readdir(join(containerPath, folder))).toEqual(
      folder === "Library" ? ["Caches", "Preferences"] : [],
    );
  });

  test("aborts after container lookup before any filesystem mutation", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    const controller = new AbortController();
    const lookup = h.simctl.executeCommandArgs.bind(h.simctl);
    h.simctl.executeCommandArgs = async (...args) => {
      const result = await lookup(...args);
      controller.abort(new Error("cancelled"));
      return result;
    };
    const before = [...h.appDataFs.nodes];
    await expect(
      new SimulatorIosClearDataBackend(simulatorId, h.deps).clearAppData(
        bundleId,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect([...h.appDataFs.nodes]).toEqual(before);
    expect(h.removals).toEqual([]);
    expect(h.appDataFs.creations).toEqual([]);
  });

  test("returns non-ENOENT read failures without recreating directories", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    h.appDataFs.readError = new Error("read permission denied");
    expect(await resolveIosClearDataBackend(simulatorId, h.deps).clearAppData(bundleId)).toEqual({
      success: false,
      packageName: bundleId,
      error: "read permission denied",
    });
    expect(h.appDataFs.creations).toEqual([]);
    expect(h.removals).toEqual([]);
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
    expect(h.removals).toHaveLength(5);
  });

  test("returns the removal error unchanged", async () => {
    const h = harness();
    h.simctl.setContainerPath(bundleId, containerPath);
    h.appDataFs.removalError = new Error("permission denied");
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

for (const proven of [true, false]) {
  test(`clear data refuses or resolves cloned registration: ${proven}`, async () => {
    const clone = cloneContainerFixture(simulatorId, proven ? bundleId : null);
    const h = harness();
    h.simctl.setContainerPath(bundleId, clone.reported);
    h.appDataFs.seed(clone.own);
    const backend = resolveIosClearDataBackend(simulatorId, {
      ...h.deps,
      containerOwnership: clone.ownership,
    });
    if (!proven) {
      await expect(backend.clearAppData(bundleId)).rejects.toBeInstanceOf(
        SimulatorContainerOwnershipError,
      );
      expect(h.removals).toEqual([]);
      expect(h.simctl.getMethodCalls("listAppsOrThrow")).toEqual([]);
      return;
    }
    expect(await backend.clearAppData(bundleId)).toMatchObject({ success: true });
    expect(h.removals).toHaveLength(5);
    expect(h.removals.every((entry) => entry.path.startsWith(`${clone.own}/`))).toBe(true);
    for (const folder of IOS_APP_DATA_FOLDERS) {
      expect(await h.appDataFs.readdir(join(clone.own, folder))).toEqual(
        folder === "Library" ? ["Caches", "Preferences"] : [],
      );
    }
  });
}
