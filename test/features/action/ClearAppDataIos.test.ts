import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { ClearAppDataIos, IosAppReinstaller } from "../../../src/features/action/ClearAppDataIos";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { BootedDevice } from "../../../src/models";

describe("ClearAppDataIos", () => {
  // Simulator UDIDs are standard 8-4-4-4-12 hex UUIDs; physical device UDIDs are not.
  const simDevice: BootedDevice = {
    name: "ios-sim", platform: "ios", deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
  };
  const physicalDevice: BootedDevice = {
    name: "iphone", platform: "ios", deviceId: "00008030-001A2B3C0E11002E"
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

  test("throws for non-iOS devices", () => {
    const android: BootedDevice = { name: "a", platform: "android", deviceId: "x" };
    expect(() => new ClearAppDataIos(android)).toThrow();
  });

  describe("simulator", () => {
    test("terminates the app and wipes the data container folders", async () => {
      const container = await makeContainer();
      const fakeSimctl = new FakeSimCtlClient();
      fakeSimctl.setContainerPath(bundleId, container);

      const result = await new ClearAppDataIos(simDevice, fakeSimctl as any).execute(bundleId);

      expect(result.success).toBe(true);
      expect(result.packageName).toBe(bundleId);
      expect(fakeSimctl.getMethodCalls("terminateApp")).toEqual([{ bundleId, deviceId: simDevice.deviceId }]);
      await expect(fs.access(path.join(container, "Documents"))).rejects.toThrow();
      await expect(fs.access(path.join(container, "Library"))).rejects.toThrow();
      await expect(fs.access(path.join(container, "tmp"))).rejects.toThrow();
      const containerStat = await fs.stat(container);
      expect(containerStat.isDirectory()).toBe(true);
    });

    test("returns failure when the data container cannot be resolved", async () => {
      const fakeSimctl = new FakeSimCtlClient();
      const result = await new ClearAppDataIos(simDevice, fakeSimctl as any).execute(bundleId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("data container");
    });
  });

  describe("physical device", () => {
    test("clears data via devicectl uninstall+reinstall", async () => {
      const fakeSimctl = new FakeSimCtlClient();
      const calls: Array<[string, string]> = [];
      const reinstaller: IosAppReinstaller = {
        clearAppDataViaReinstall: async (deviceUdid, id) => { calls.push([deviceUdid, id]); },
      };

      const result = await new ClearAppDataIos(physicalDevice, fakeSimctl as any, reinstaller).execute(bundleId);

      expect(result.success).toBe(true);
      expect(calls).toEqual([[physicalDevice.deviceId, bundleId]]);
      // Physical clear does not use the simulator container/terminate path.
      expect(fakeSimctl.getMethodCalls("terminateApp")).toHaveLength(0);
    });

    test("returns failure when reinstall throws", async () => {
      const fakeSimctl = new FakeSimCtlClient();
      const reinstaller: IosAppReinstaller = {
        clearAppDataViaReinstall: async () => { throw new Error("device offline"); },
      };

      const result = await new ClearAppDataIos(physicalDevice, fakeSimctl as any, reinstaller).execute(bundleId);

      expect(result.success).toBe(false);
      expect(result.error).toContain("device offline");
    });
  });
});
