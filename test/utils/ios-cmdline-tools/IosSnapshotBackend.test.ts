import { SimulatorContainerOwnershipError } from "../../../src/utils/ios-cmdline-tools/simulatorOwnContainer";
import { cloneContainerFixture } from "../../helpers/simulatorContainerFixture";
import {
  simulatorOwnership,
  simulatorDataContainer,
} from "../../helpers/simulatorContainerFixture";
import { loggerCallsWithPrefix } from "../../helpers/loggerCallsWithPrefix";
import { describe, expect, spyOn, test } from "bun:test";
import {
  resolveIosSnapshotBackend,
  SimulatorIosSnapshotBackend,
} from "../../../src/utils/ios-cmdline-tools/IosSnapshotBackend";
import { CaptureSnapshot } from "../../../src/features/action/CaptureSnapshot";
import { RestoreSnapshot } from "../../../src/features/action/RestoreSnapshot";
import {
  ActionableError,
  type BootedDevice,
  type DeviceSnapshotManifest,
} from "../../../src/models";
import { FakeDeviceSnapshotStore } from "../../fakes/FakeDeviceSnapshotStore";
import { useScratchRoot } from "../../helpers/scratchRoot";
import { join } from "node:path";
import { logger } from "../../../src/utils/logger";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const PHYSICAL_IDS = ["00008030-001C2D3E1234567A", "a".repeat(40)];

function simulatorBackend(deviceId = UDID) {
  const simctl = new FakeSimctl();
  const backend = resolveIosSnapshotBackend(deviceId, {
    simctl,
    containerOwnership: simulatorOwnership,
  });
  if (backend.kind !== "simulator") {
    throw new Error("Expected a simulator backend");
  }
  return { simctl, backend };
}

// No store methods run in guard/metadata tests; avoid initializing the real DB or filesystem.
function actions(options: { deviceId: string; simctl: FakeSimctl }) {
  const device: BootedDevice = { deviceId: options.deviceId, name: "iPhone", platform: "ios" };
  const adb = new FakeAdbClient();
  const factory = { create: () => adb };
  const store = new FakeDeviceSnapshotStore();
  const simctl = options.simctl;
  const timer = new FakeTimer();
  return {
    capture: new CaptureSnapshot(device, { adbFactory: factory, timer, store, simctl }),
    restore: new RestoreSnapshot(device, { adbFactory: factory, timer, store, simctl }),
  };
}

const manifest: DeviceSnapshotManifest = {
  snapshotName: "snapshot",
  timestamp: "2026-10-03T00:00:00Z",
  platform: "ios",
  deviceId: UDID,
  deviceName: "iPhone",
  includeAppData: true,
  includeSettings: true,
  snapshotType: "app_data",
};

describe("IosSnapshotBackend", () => {
  for (const deviceId of [UDID, "unknown-ios-id"]) {
    test(`retains simctl for ${deviceId}`, async () => {
      const { simctl, backend } = simulatorBackend(deviceId);
      expect(backend.kind).toBe("simulator");
      await backend.getDeviceInfo();
      expect(simctl.getMethodCalls("getDeviceInfo")).toEqual([{ udid: deviceId }]);
    });
  }

  for (const deviceId of PHYSICAL_IDS) {
    test(`physical backend exposes no simctl operations for ${deviceId}`, () => {
      const simctl = new FakeSimctl();
      expect(
        resolveIosSnapshotBackend(deviceId, { simctl, containerOwnership: simulatorOwnership }),
      ).toEqual({ kind: "physical" });
      expect(simctl.getMethodCalls("getDeviceInfo")).toEqual([]);
    });

    test(`both actions preserve the exact physical guard for ${deviceId}`, async () => {
      const simctl = new FakeSimctl();
      const { capture, restore } = actions({ deviceId, simctl });
      const message = `Device snapshots are not supported on physical iOS devices (${deviceId}); they require a Simulator (simctl).`;
      await expect(capture.execute({ snapshotName: "snapshot" })).rejects.toThrow(message);
      await expect(restore.execute({ snapshotName: "snapshot", manifest })).rejects.toThrow(
        message,
      );
      await expect(capture.execute({ snapshotName: "snapshot" })).rejects.toBeInstanceOf(
        ActionableError,
      );
      await expect(restore.execute({ snapshotName: "snapshot", manifest })).rejects.toBeInstanceOf(
        ActionableError,
      );
      // Snapshot-name validation still precedes the physical-device guard.
      await expect(capture.execute({ snapshotName: "../bad" })).rejects.not.toThrow(message);
      await expect(restore.execute({ snapshotName: "../bad", manifest })).rejects.not.toThrow(
        message,
      );
      for (const method of [
        "getDeviceInfo",
        "getRuntimes",
        "executeCommandArgs",
        "listApps",
        "listAppsOrThrow",
        "terminateApp",
      ]) {
        expect(simctl.getMethodCalls(method)).toEqual([]);
      }
    });
  }

  test("delegates device info and runtimes without changing arguments or results", async () => {
    const { simctl, backend } = simulatorBackend();
    const info = {
      udid: UDID,
      name: "iPhone",
      state: "Booted",
      isAvailable: true,
      runtime: "runtime",
    };
    const runtimes = [
      {
        identifier: "runtime",
        name: "iOS",
        version: "18.0",
        buildversion: "build",
        bundlePath: "/fake/runtime",
        runtimeRoot: "/fake/runtime/root",
        isAvailable: true,
      },
    ];
    simctl.setDeviceInfo(UDID, info);
    simctl.setRuntimes(runtimes);
    expect(await backend.getDeviceInfo()).toEqual(info);
    expect(await backend.getRuntimes()).toEqual(runtimes);
    expect(simctl.getMethodCalls("getDeviceInfo")).toEqual([{ udid: UDID }]);
    expect(simctl.getMethodCalls("getRuntimes")).toEqual([{}]);
    simctl.setDeviceInfoError(new Error("info failure"));
    const runtimeSpy = spyOn(simctl, "getRuntimes").mockRejectedValue(new Error("runtime failure"));
    await expect(backend.getDeviceInfo()).rejects.toThrow("info failure");
    await expect(backend.getRuntimes()).rejects.toThrow("runtime failure");
    runtimeSpy.mockRestore();
  });

  test("delegates settings capture and restore with identical ordered argv", async () => {
    const { simctl, backend } = simulatorBackend();
    simctl.setCommandArgsResult(
      ["spawn", UDID, "defaults", "read", ".GlobalPreferences", "AppleLocale"],
      "en_US\n",
    );
    simctl.setCommandArgsResult(["ui", UDID, "appearance"], "dark\n");
    simctl.setCommandArgsResult(["ui", UDID, "content_size"], "large\n");
    const settings = await backend.captureSettings();
    expect(settings).toEqual({
      values: { ".GlobalPreferences/AppleLocale": "en_US" },
      ui: { appearance: "dark", contentSize: "large" },
    });
    await backend.restoreSettings(settings);
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      ["spawn", UDID, "defaults", "read", ".GlobalPreferences", "AppleLocale"],
      ["ui", UDID, "appearance"],
      ["ui", UDID, "content_size"],
      ["spawn", UDID, "defaults", "write", ".GlobalPreferences", "AppleLocale", "en_US"],
      ["ui", UDID, "appearance", "dark"],
      ["ui", UDID, "content_size", "large"],
    ]);
  });

  test("delegates container resolution and termination with unchanged arguments", async () => {
    const { simctl, backend } = simulatorBackend();
    simctl.setContainerPath("com.example.app", simulatorDataContainer(UDID));
    expect(await backend.getAppDataContainerPath("com.example.app")).toBe(
      simulatorDataContainer(UDID),
    );
    await backend.terminateAppIfRunning("com.example.app");
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      ["get_app_container", UDID, "com.example.app", "data"],
    ]);
    expect(simctl.getMethodCalls("terminateApp")).toEqual([
      { bundleId: "com.example.app", deviceId: UDID },
    ]);
  });

  test("keeps strict capture listing and lenient restore listing separate", async () => {
    const { simctl, backend } = simulatorBackend();
    const apps = [{ CFBundleIdentifier: "com.example.app" }];
    simctl.setInstalledApps(apps);
    expect(await backend.listAppsOrThrow()).toEqual(apps);
    expect(await backend.listApps()).toEqual(apps);
    expect(simctl.getMethodCalls("listAppsOrThrow")).toEqual([{ deviceId: UDID }]);
    expect(simctl.getMethodCalls("listApps")).toEqual([{ deviceId: UDID }]);
  });

  test("actions use the backend for metadata and preserve distinct warning texts", async () => {
    const simctl = new FakeSimctl();
    simctl.setDeviceInfoError(new Error("metadata failure"));
    const { capture, restore } = actions({ deviceId: UDID, simctl });
    const backendSpy = spyOn(SimulatorIosSnapshotBackend.prototype, "getDeviceInfo");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await capture.getIosDeviceMetadata()).toEqual({});
      expect(await restore.getIosDeviceOsVersion()).toBeUndefined();
      expect(backendSpy).toHaveBeenCalledTimes(2);
      expect(loggerCallsWithPrefix(warn.mock.calls, "[iOS] Failed to read simulator ")).toEqual([
        ["[iOS] Failed to read simulator metadata: Error: metadata failure"],
        ["[iOS] Failed to read simulator OS version: Error: metadata failure"],
      ]);
    } finally {
      backendSpy.mockRestore();
      warn.mockRestore();
    }
  });
});

const snapshotScratch = useScratchRoot("clone-snapshot-");

for (const proven of [true, false]) {
  test(`snapshot capture and restore use only the clone container: ${proven}`, async () => {
    const bundleId = "com.apple.mobilesafari";
    const clone = cloneContainerFixture(UDID, proven ? bundleId : null);
    const simctl = new FakeSimctl();
    simctl.setContainerPath(bundleId, clone.reported);
    simctl.setInstalledApps([{ bundleId }]);
    const backend = new SimulatorIosSnapshotBackend({
      deviceId: UDID,
      simctl,
      containerOwnership: clone.ownership,
    });
    const copied: Array<[string, string]> = [];
    const removed: string[] = [];
    const inspected: string[] = [];
    const device: BootedDevice = { platform: "ios", deviceId: UDID, name: "clone" };
    const store = new FakeDeviceSnapshotStore(snapshotScratch.next());
    const capture = new CaptureSnapshot(device, {
      store,
      simctl,
      containerOwnership: clone.ownership,
      iosCaptureContainerFiles: {
        mkdir: async () => {},
        pathExists: async (path) => {
          inspected.push(path);
          return true;
        },
        cp: async (source, destination) => {
          copied.push([source, destination]);
        },
      },
    });
    const restore = new RestoreSnapshot(device, {
      store,
      simctl,
      containerOwnership: clone.ownership,
      iosRestoreOperations: {
        terminateAppIfRunning: async () => {},
        getAppDataContainerPath: (_id, bundle) => backend.getAppDataContainerPath(bundle),
        pathExists: async () => true,
        rm: async (path) => {
          removed.push(path);
        },
        cp: async (source, destination) => {
          copied.push([source, destination]);
        },
      },
    });
    const captureArgs = { snapshotName: "clone", appBundleIds: [bundleId], includeSettings: false };
    const restoreArgs = {
      snapshotName: "clone",
      manifest: {
        ...manifest,
        includeSettings: false,
        appDataBackup: { backupMethod: "simctl_copy" as const, backedUpPackages: [bundleId] },
      },
    };
    if (!proven) {
      await expect(capture.execute(captureArgs)).rejects.toBeInstanceOf(
        SimulatorContainerOwnershipError,
      );
      expect(await restore.execute(restoreArgs)).toMatchObject({
        success: false,
        failures: [
          { kind: "ios_bundle", bundleId, reason: expect.stringContaining("ownership refused") },
        ],
      });
      expect(copied).toEqual([]);
      expect(removed).toEqual([]);
      expect(inspected).toEqual([]);
      return;
    }
    await capture.execute(captureArgs);
    expect(await restore.execute(restoreArgs)).toMatchObject({ success: true, failures: [] });
    expect(inspected).toEqual(
      ["Documents", "Library", "tmp"].map((folder) => join(clone.own, folder)),
    );
    expect(removed).toEqual(inspected);
    expect(copied).toHaveLength(6);
    expect(copied.flat().some((path) => path.startsWith(clone.reported))).toBe(false);
  });
}
