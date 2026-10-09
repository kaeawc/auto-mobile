import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { ClearAppData, IosAppReinstaller } from "../../../src/features/action/ClearAppData";
import { ActionableError, AppNotInstalledError } from "../../../src/models/ActionableError";
import { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeRecordingPerformanceTracker } from "../../fakes/FakeRecordingPerformanceTracker";

const device: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "device-123",
};

function adbFactoryFor(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("ClearAppData", () => {
  describe("android", () => {
    test("clears the owner for a personal-only app with a running work profile", async () => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      adb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.app",
        stderr: "",
      });
      adb.setCommandResponse("shell pm list packages --user 10", {
        stdout: "package:com.example.other",
        stderr: "",
      });
      adb.setCommandResponse("shell pm clear", { stdout: "Success\n", stderr: "" });
      const action = new ClearAppData(device, adbFactoryFor(adb));

      expect(await action.execute("com.example.app")).toEqual({
        success: true,
        packageName: "com.example.app",
        userId: 0,
      });
      expect(
        adb.getExecutedCommands().filter((command) => command.startsWith("shell pm clear ")),
      ).toEqual(["shell pm clear --user 0 'com.example.app'"]);
    });

    test("retires the app's process state only when pm clear succeeds", async () => {
      for (const [stdout, retired] of [
        ["Success\n", 1],
        ["Failed\n", 0],
      ] as const) {
        const adb = new FakeAdbExecutor();
        adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
        adb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
        adb.setCommandResponse("shell pm list packages --user 0", {
          stdout: "package:com.example.app",
          stderr: "",
        });
        adb.setCommandResponse("shell pm clear", { stdout, stderr: "" });
        const cacheInvalidator = new FakeDeviceWindowCacheInvalidator();
        await new ClearAppData(device, adbFactoryFor(adb), { cacheInvalidator }).execute(
          "com.example.app",
        );
        expect(cacheInvalidator.retiredProcesses.map((entry) => entry.packageName)).toEqual(
          retired === 1 ? ["com.example.app"] : [],
        );
      }
    });

    test("rejects an app installed for no user before clearing data", async () => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      for (const userId of [0, 10]) {
        adb.setCommandResponse(`shell pm list packages --user ${userId}`, {
          stdout: "package:com.example.other",
          stderr: "",
        });
      }
      const perf = new FakeRecordingPerformanceTracker();
      const action = new ClearAppData(device, adbFactoryFor(adb), {}, () => perf);
      const execution = action.execute("com.example.app");

      await expect(execution).rejects.toBeInstanceOf(ActionableError);
      await expect(execution).rejects.toThrow(
        "App com.example.app is not installed for Android user 10",
      );
      expect(
        adb.getExecutedCommands().some((command) => command.startsWith("shell pm clear ")),
      ).toBe(false);
      expect(perf.endCalls).toBe(1);
    });

    test("ends the performance block exactly once and propagates target-user resolution errors", async () => {
      const adb = new FakeAdbExecutor();
      const failure = new Error("adb offline during user resolution");
      adb.getForegroundApp = async () => {
        throw failure;
      };
      const perf = new FakeRecordingPerformanceTracker();
      const action = new ClearAppData(device, adbFactoryFor(adb), {}, () => perf);

      await expect(action.execute("com.example.app")).rejects.toBe(failure);

      expect(perf.serialNames).toEqual(["clearAppData"]);
      expect(perf.endCalls).toBe(1);
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test.each(["Success", "Failed", "throw"])(
      "ends the performance block exactly once for pm clear %s",
      async (outcome) => {
        const adb = new FakeAdbExecutor();
        if (outcome === "throw") {
          adb.setCommandError("shell pm clear", new Error("adb offline"));
        } else {
          adb.setCommandResponse("shell pm clear", { stdout: outcome, stderr: "" });
        }
        const perf = new FakeRecordingPerformanceTracker();
        const action = new ClearAppData(device, adbFactoryFor(adb), {}, () => perf);

        const result = await action.execute("com.example.app", 0);

        expect(result.success).toBe(outcome === "Success");
        expect(perf.endCalls).toBe(1);
      },
    );

    test.each([0, 10])("clears explicit Android user %s without install probes", async (userId) => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      adb.setCommandResponse(`shell pm clear --user ${userId}`, {
        stdout: "Success\n",
        stderr: "",
      });
      const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

      const result = await clearAppData.execute("com.example.app", userId);

      expect(result).toEqual({ success: true, packageName: "com.example.app", userId });
      expect(adb.getExecutedCommands()).toEqual([
        `shell pm clear --user ${userId} 'com.example.app'`,
      ]);
      expect(adb.getCommandCalls()[0]?.timeoutMs).toBe(60_000);
    });

    test("uses the package foreground user when no user is explicitly requested", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell pm clear --user 11", { stdout: "Success\n", stderr: "" });
      adb.setCommandResponse("shell pm list packages --user 11", {
        stdout: "package:com.example.app",
        stderr: "",
      });
      adb.setForegroundApp({ packageName: "com.example.app", userId: 11 });
      const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

      const result = await clearAppData.execute("com.example.app");

      expect(result).toEqual({ success: true, packageName: "com.example.app", userId: 11 });
      expect(adb.getExecutedCommands()).toEqual([
        "shell pm list packages --user 11",
        "shell pm clear --user 11 'com.example.app'",
      ]);
    });

    test("returns failure when pm clear prints Failed despite resolving successfully", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell pm clear --user 10", { stdout: "Failed\n", stderr: "" });
      const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

      const result = await clearAppData.execute("com.example.app", 10);

      expect(result).toEqual({
        success: false,
        packageName: "com.example.app",
        userId: 10,
        error: "Failed to clear application data: Failed",
      });
    });

    test("returns failure for synthetic unexpected pm clear output", async () => {
      const output = "Unexpected synthetic output";
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell pm clear --user 10", { stdout: output, stderr: "" });
      const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

      const result = await clearAppData.execute("com.example.app", 10);

      expect(result).toEqual({
        success: false,
        packageName: "com.example.app",
        userId: 10,
        error: `Failed to clear application data: ${output}`,
      });
    });

    test("succeeds when stdout is Success despite an unrelated stderr warning", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell pm clear --user 10", {
        stdout: "  Success  \n",
        stderr: "unrelated warning\n",
      });
      const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

      const result = await clearAppData.execute("com.example.app", 10);

      expect(result).toEqual({
        success: true,
        packageName: "com.example.app",
        userId: 10,
      });
    });

    test("returns a failure result when the adb command throws", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandError("shell pm clear --user 10 'com.example.app'", new Error("adb failed"));
      const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

      const result = await clearAppData.execute("com.example.app", 10);

      expect(result).toEqual({
        success: false,
        packageName: "com.example.app",
        userId: 10,
        error: "Failed to clear application data: adb failed",
      });
    });
  });

  describe("ios", () => {
    // Simulator UDIDs are standard 8-4-4-4-12 hex UUIDs; physical device UDIDs are not.
    const simDevice: BootedDevice = {
      name: "ios-sim",
      platform: "ios",
      deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    };
    const physicalDevice: BootedDevice = {
      name: "iphone",
      platform: "ios",
      deviceId: "00008030-001A2B3C0E11002E",
    };
    const bundleId = "com.example.app";
    const tempDirs: string[] = [];

    afterEach(async () => {
      for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    async function makeContainer(): Promise<string> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "automobile-clear-"));
      tempDirs.push(root);
      await fs.mkdir(path.join(root, "Documents"), { recursive: true });
      await fs.writeFile(path.join(root, "Documents", "state.json"), "{}");
      await fs.mkdir(path.join(root, "Library", "Preferences"), { recursive: true });
      await fs.writeFile(path.join(root, "Library", "Preferences", "app.plist"), "x");
      await fs.mkdir(path.join(root, "tmp"), { recursive: true });
      return root;
    }

    describe("simulator", () => {
      test("terminates the app and wipes the data container folders", async () => {
        const container = await makeContainer();
        const fakeSimctl = new FakeSimCtlClient();
        fakeSimctl.setContainerPath(bundleId, container);

        const result = await new ClearAppData(simDevice, undefined, { simctl: fakeSimctl }).execute(
          bundleId,
        );

        expect(result.success).toBe(true);
        expect(result.packageName).toBe(bundleId);
        expect(fakeSimctl.getMethodCalls("terminateApp")).toEqual([
          { bundleId, deviceId: simDevice.deviceId },
        ]);
        await expect(fs.access(path.join(container, "Documents"))).rejects.toThrow();
        await expect(fs.access(path.join(container, "Library"))).rejects.toThrow();
        await expect(fs.access(path.join(container, "tmp"))).rejects.toThrow();
        const containerStat = await fs.stat(container);
        expect(containerStat.isDirectory()).toBe(true);
      });

      test("returns failure when the data container cannot be resolved for an installed app", async () => {
        const fakeSimctl = new FakeSimCtlClient();
        fakeSimctl.setInstalledApps([{ bundleId }]);
        const result = await new ClearAppData(simDevice, undefined, { simctl: fakeSimctl }).execute(
          bundleId,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("data container");
      });

      test("throws AppNotInstalledError when the app is not installed", async () => {
        const fakeSimctl = new FakeSimCtlClient();
        await expect(
          new ClearAppData(simDevice, undefined, { simctl: fakeSimctl }).execute(bundleId),
        ).rejects.toBeInstanceOf(AppNotInstalledError);
      });
    });

    describe("physical device", () => {
      test("clears data via devicectl uninstall+reinstall", async () => {
        const fakeSimctl = new FakeSimCtlClient();
        const calls: Array<[string, string]> = [];
        const reinstaller: IosAppReinstaller = {
          clearAppDataViaReinstall: async (deviceUdid, id) => {
            calls.push([deviceUdid, id]);
          },
        };

        const result = await new ClearAppData(physicalDevice, undefined, {
          simctl: fakeSimctl,
          reinstaller,
        }).execute(bundleId);

        expect(result.success).toBe(true);
        expect(calls).toEqual([[physicalDevice.deviceId, bundleId]]);
        // Physical clear does not use the simulator container/terminate path.
        expect(fakeSimctl.getMethodCalls("terminateApp")).toHaveLength(0);
      });

      test("returns failure when reinstall throws", async () => {
        const fakeSimctl = new FakeSimCtlClient();
        const failureMessage = `${bundleId} is now UNINSTALLED: device offline`;
        const reinstaller: IosAppReinstaller = {
          clearAppDataViaReinstall: async () => {
            throw new ActionableError(failureMessage);
          },
        };

        const result = await new ClearAppData(physicalDevice, undefined, {
          simctl: fakeSimctl,
          reinstaller,
        }).execute(bundleId);

        expect(result.success).toBe(false);
        expect(result.error).toBe(failureMessage);
      });
    });
  });
});
