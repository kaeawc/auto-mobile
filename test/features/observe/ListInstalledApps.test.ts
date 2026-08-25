import { expect, describe, test, beforeEach } from "bun:test";
import { ListInstalledApps } from "../../../src/features/observe/ListInstalledApps";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BootedDevice, AndroidUser } from "../../../src/models";
import type { NewInstalledApp } from "../../../src/db/types";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { getInstalledAppsCacheWriteCoordinator } from "../../../src/db/installedAppsCacheWriteCoordinator";

class FailsFirstInstalledAppsReplaceRepository extends FakeInstalledAppsRepository {
  private failNextReplace = true;

  override async replaceInstalledApps(deviceId: string, apps: NewInstalledApp[]): Promise<void> {
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("transient cache write failure");
    }
    await super.replaceInstalledApps(deviceId, apps);
  }
}

describe("ListInstalledApps", function () {
  let listInstalledApps: ListInstalledApps;
  let fakeAdb: FakeAdbExecutor;
  let mockDevice: BootedDevice;

  beforeEach(function () {
    mockDevice = {
      // The installed-apps write coordinator is process-global. Keep this
      // fixture distinct from generic device fixtures in concurrently loaded
      // test files so their invalidations cannot bypass this seeded cache.
      deviceId: "list-installed-apps-test-device",
      platform: "android",
    } as BootedDevice;

    fakeAdb = new FakeAdbExecutor();
    // Note: Don't set default command responses here - tests will configure as needed

    listInstalledApps = new ListInstalledApps(mockDevice, new FakeAdbClientFactory(fakeAdb));
  });

  describe("execute", function () {
    test("should list all installed packages", async function () {
      // Set up single user with packages
      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout:
          "package:com.android.chrome\npackage:com.google.android.gms\npackage:com.example.myapp\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "package:com.android.chrome\npackage:com.google.android.gms\n",
        stderr: "",
      });

      const result = await listInstalledApps.execute();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
      expect(result).toContain("com.android.chrome");
      expect(result).toContain("com.google.android.gms");
      expect(result).toContain("com.example.myapp");
    });

    test("should filter out empty lines and non-package lines", async function () {
      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.app\n\nsome other line\npackage:com.test.app\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "",
        stderr: "",
      });

      const result = await listInstalledApps.execute();

      expect(result).toHaveLength(2);
      expect(result).toContain("com.example.app");
      expect(result).toContain("com.test.app");
    });

    test("should handle adb command failure gracefully", async function () {
      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "",
        stderr: "error",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "",
        stderr: "",
      });

      const result = await listInstalledApps.execute();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    test("should trim package names correctly", async function () {
      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package: com.example.app \npackage:com.test.app\t\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "",
        stderr: "",
      });

      const result = await listInstalledApps.execute();

      expect(result).toContain("com.example.app");
      expect(result).toContain("com.test.app");
      expect(result).not.toContain(" com.example.app ");
    });
  });

  describe("executeDetailed", function () {
    test("should list apps from all user profiles", async function () {
      // Configure two users: primary and work profile
      const users: AndroidUser[] = [
        { userId: 0, name: "Owner", flags: 13, running: true },
        { userId: 10, name: "Work profile", flags: 30, running: true },
      ];
      fakeAdb.setUsers(users);

      // Configure packages for each user
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.android.chrome\npackage:com.example.personalapp\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "package:com.android.chrome\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages --user 10", {
        stdout: "package:com.android.chrome\npackage:com.example.workapp\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 10", {
        stdout: "package:com.android.chrome\n",
        stderr: "",
      });

      const result = await listInstalledApps.executeDetailed();

      expect(typeof result).toBe("object");
      expect(result).toHaveProperty("profiles");
      expect(result).toHaveProperty("system");

      // Check personal apps
      const personalApps = result.profiles[0];
      expect(Array.isArray(personalApps)).toBe(true);
      const personalApp = personalApps.find((app) => app.packageName === "com.example.personalapp");
      expect(personalApp).toBeDefined();
      expect(personalApp?.foreground).toBe(false);

      // Check work profile apps
      const workApps = result.profiles[10];
      expect(Array.isArray(workApps)).toBe(true);
      const workApp = workApps.find((app) => app.packageName === "com.example.workapp");
      expect(workApp).toBeDefined();

      // Check system apps are deduped
      expect(result.system).toHaveLength(1);
      expect(result.system[0].packageName).toBe("com.android.chrome");
      expect(result.system[0].userIds.sort()).toEqual([0, 10]);
    });

    test("should dedupe system apps across profiles", async function () {
      const users: AndroidUser[] = [
        { userId: 0, name: "Owner", flags: 13, running: true },
        { userId: 10, name: "Work profile", flags: 30, running: true },
      ];
      fakeAdb.setUsers(users);
      fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 10 });

      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.android.settings\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "package:com.android.settings\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages --user 10", {
        stdout: "package:com.android.settings\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 10", {
        stdout: "package:com.android.settings\n",
        stderr: "",
      });

      const result = await listInstalledApps.executeDetailed();

      expect(result.system).toHaveLength(1);
      expect(result.system[0].packageName).toBe("com.android.settings");
      expect(result.system[0].userIds.sort()).toEqual([0, 10]);
      expect(result.system[0].foreground).toBe(true);
    });

    test("should treat non-system packages as user apps even if not listed in -s", async function () {
      const users: AndroidUser[] = [{ userId: 0, name: "Owner", flags: 13, running: true }];
      fakeAdb.setUsers(users);

      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.android.chrome\npackage:com.google.android.apps.weather\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "package:com.android.chrome\n",
        stderr: "",
      });

      const result = await listInstalledApps.executeDetailed();

      const userPackages = result.profiles[0].map((app) => app.packageName);
      expect(userPackages).toContain("com.google.android.apps.weather");
      expect(
        result.system.some((app) => app.packageName === "com.google.android.apps.weather"),
      ).toBe(false);
    });

    test("should mark foreground app correctly", async function () {
      const users: AndroidUser[] = [
        { userId: 0, name: "Owner", flags: 13, running: true },
        { userId: 10, name: "Work profile", flags: 30, running: true },
      ];
      fakeAdb.setUsers(users);

      // Set foreground app in work profile
      fakeAdb.setForegroundApp({ packageName: "com.example.workapp", userId: 10 });

      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.personalapp\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages --user 10", {
        stdout: "package:com.example.workapp\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 10", {
        stdout: "",
        stderr: "",
      });

      const result = await listInstalledApps.executeDetailed();

      const personalApp = result.profiles[0].find(
        (app) => app.packageName === "com.example.personalapp",
      );
      expect(personalApp?.foreground).toBe(false);

      const workApp = result.profiles[10].find((app) => app.packageName === "com.example.workapp");
      expect(workApp?.foreground).toBe(true);
    });

    test("should handle single user (no work profile)", async function () {
      const users: AndroidUser[] = [{ userId: 0, name: "Owner", flags: 13, running: true }];
      fakeAdb.setUsers(users);

      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.android.chrome\npackage:com.example.app\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "package:com.android.chrome\n",
        stderr: "",
      });

      const result = await listInstalledApps.executeDetailed();

      expect(result.profiles[0]).toHaveLength(1);
      expect(result.profiles[0][0].userId).toBe(0);
      expect(result.system).toHaveLength(1);
    });

    test("should return empty result for non-Android platforms", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "test-device",
        platform: "ios",
      } as BootedDevice;

      const iosListApps = new ListInstalledApps(iosDevice, new FakeAdbClientFactory(fakeAdb));
      const result = await iosListApps.executeDetailed();

      expect(result).toEqual({ profiles: {}, system: [] });
    });
  });

  describe("cache", function () {
    test("lists iOS bundle IDs live after an out-of-band app change", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "ios-cache-device",
        platform: "ios",
      } as BootedDevice;
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.advanceTime(1_000);
      const simctl = new FakeSimctl();
      simctl.setInstalledApps([{ bundleId: "com.example.cached" }]);
      const list = new ListInstalledApps(iosDevice, new FakeAdbClientFactory(fakeAdb), simctl, {
        cacheEnabled: true,
        installedAppsRepository: repo,
        timer,
      });

      await expect(list.execute()).resolves.toEqual(["com.example.cached"]);
      simctl.setInstalledApps([{ bundleIdentifier: "com.example.updated" }]);
      await expect(list.execute()).resolves.toEqual(["com.example.updated"]);
    });

    test("preserves iOS app metadata for the apps resource path", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "ios-metadata-cache-device",
        platform: "ios",
      } as BootedDevice;
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.advanceTime(1_000);
      const simctl = new FakeSimctl();
      simctl.setInstalledApps([
        {
          bundleId: "com.example.cached",
          bundleDisplayName: "Cached App",
          bundleShortVersionString: "1.2.3",
          bundlePath: "/Applications/Cached.app",
        },
      ]);
      const list = new ListInstalledApps(iosDevice, new FakeAdbClientFactory(fakeAdb), simctl, {
        cacheEnabled: true,
        installedAppsRepository: repo,
        timer,
      });

      await expect(list.executeIosDetailed()).resolves.toEqual([
        {
          bundleId: "com.example.cached",
          bundleDisplayName: "Cached App",
          bundleShortVersionString: "1.2.3",
          bundlePath: "/Applications/Cached.app",
        },
      ]);
      expect(simctl.getMethodCallCount("listAppsOrThrow")).toBe(1);
    });

    test("normalizes all supported iOS bundle ID fields", async function () {
      const iosDevice: BootedDevice = {
        deviceId: "ios-bundle-id-fields",
        platform: "ios",
      } as BootedDevice;
      const simctl = new FakeSimctl();
      simctl.setInstalledApps([
        { bundleID: "  com.example.bundle-id  " },
        { CFBundleIdentifier: "com.example.cf-bundle-id" },
      ]);
      const list = new ListInstalledApps(iosDevice, new FakeAdbClientFactory(fakeAdb), simctl);

      await expect(list.execute()).resolves.toEqual([
        "com.example.bundle-id",
        "com.example.cf-bundle-id",
      ]);
    });

    test("should use cached apps when fresh", async function () {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.advanceTime(1000);
      const now = timer.now();
      const entries: NewInstalledApp[] = [
        {
          device_id: mockDevice.deviceId,
          user_id: 0,
          package_name: "com.cached.app",
          is_system: 0,
          installed_at: now,
          last_verified_at: now,
        },
        {
          device_id: mockDevice.deviceId,
          user_id: 0,
          package_name: "com.android.settings",
          is_system: 1,
          installed_at: now,
          last_verified_at: now,
        },
      ];

      await repo.replaceInstalledApps(mockDevice.deviceId, entries);
      fakeAdb.setForegroundApp({ packageName: "com.cached.app", userId: 0 });

      const cachedList = new ListInstalledApps(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        null,
        { cacheEnabled: true, installedAppsRepository: repo, timer },
      );
      const result = await cachedList.executeDetailed();

      expect(result.profiles[0].some((app) => app.packageName === "com.cached.app")).toBe(true);
      expect(result.system.some((app) => app.packageName === "com.android.settings")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell pm list packages")).toBe(false);
    });

    test("preserves cached profile metadata when the profile is absent from user discovery", async function () {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.advanceTime(1000);
      const now = timer.now();
      await repo.replaceInstalledApps(mockDevice.deviceId, [
        {
          device_id: mockDevice.deviceId,
          user_id: 10,
          package_name: "com.example.work",
          is_system: 0,
          installed_at: now,
          last_verified_at: now,
          profile_type: "managed",
        },
      ]);
      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);

      const cachedList = new ListInstalledApps(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        null,
        { cacheEnabled: true, installedAppsRepository: repo, timer },
      );

      await expect(cachedList.executeDetailed()).resolves.toMatchObject({
        profiles: {
          10: [{ packageName: "com.example.work", profileType: "managed" }],
        },
      });
    });

    test("should rebuild cache when stale", async function () {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      const staleTime = timer.now();
      await repo.replaceInstalledApps(mockDevice.deviceId, [
        {
          device_id: mockDevice.deviceId,
          user_id: 0,
          package_name: "com.stale.app",
          is_system: 0,
          installed_at: staleTime,
          last_verified_at: staleTime,
        },
      ]);

      timer.advanceTime(5 * 60 * 1000 + 1);

      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.fresh\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "",
        stderr: "",
      });

      const cachedList = new ListInstalledApps(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        null,
        { cacheEnabled: true, installedAppsRepository: repo, timer },
      );
      await cachedList.executeDetailed();

      expect(fakeAdb.wasCommandExecuted("shell pm list packages --user 0")).toBe(true);

      const stored = await repo.listInstalledApps(mockDevice.deviceId);
      expect(stored.some((row) => row.package_name === "com.example.fresh")).toBe(true);
      expect(stored.some((row) => row.package_name === "com.stale.app")).toBe(false);
    });

    test("should rebuild immediately when a package mutation marks the cache stale", async function () {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      const now = timer.now();
      await repo.replaceInstalledApps(mockDevice.deviceId, [
        {
          device_id: mockDevice.deviceId,
          user_id: 0,
          package_name: "com.removed.app",
          is_system: 0,
          installed_at: now,
          last_verified_at: now,
        },
      ]);
      await repo.markDeviceStale(mockDevice.deviceId);

      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.installed.app\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", {
        stdout: "",
        stderr: "",
      });

      const cachedList = new ListInstalledApps(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        null,
        { cacheEnabled: true, installedAppsRepository: repo, timer },
      );
      const result = await cachedList.executeDetailed();

      expect(result.profiles[0].map((app) => app.packageName)).toEqual(["com.installed.app"]);
      expect(fakeAdb.wasCommandExecuted("shell pm list packages --user 0")).toBe(true);
    });

    test("rebuilds a dirty cache after a stale-marker write fails", async function () {
      const device: BootedDevice = {
        deviceId: "dirty-cache-device",
        platform: "android",
      } as BootedDevice;
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.advanceTime(1_000);
      await repo.replaceInstalledApps(device.deviceId, [
        {
          device_id: device.deviceId,
          user_id: 0,
          package_name: "com.example.stale",
          is_system: 0,
          installed_at: timer.now(),
          last_verified_at: timer.now(),
        },
      ]);
      await expect(
        getInstalledAppsCacheWriteCoordinator().invalidate(device.deviceId, async () => {
          throw new Error("transient stale-marker failure");
        }),
      ).rejects.toThrow("transient stale-marker failure");

      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.fresh\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", { stdout: "", stderr: "" });
      const list = new ListInstalledApps(device, new FakeAdbClientFactory(fakeAdb), null, {
        cacheEnabled: true,
        installedAppsRepository: repo,
        timer,
      });

      await expect(list.executeDetailed()).resolves.toMatchObject({
        profiles: { 0: [{ packageName: "com.example.fresh" }] },
      });
      expect(fakeAdb.wasCommandExecuted("shell pm list packages --user 0")).toBe(true);
      expect(getInstalledAppsCacheWriteCoordinator().isDirty(device.deviceId)).toBe(false);
    });

    test("returns the live result and retries after a cache replacement failure", async function () {
      const device: BootedDevice = {
        deviceId: "replace-failure-device",
        platform: "android",
      } as BootedDevice;
      const repo = new FailsFirstInstalledAppsReplaceRepository();
      const timer = new FakeTimer();
      timer.advanceTime(1_000);
      await expect(
        getInstalledAppsCacheWriteCoordinator().invalidate(device.deviceId, async () => {
          throw new Error("stale cache row");
        }),
      ).rejects.toThrow("stale cache row");

      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.live\n",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell pm list packages -s --user 0", { stdout: "", stderr: "" });
      const list = new ListInstalledApps(device, new FakeAdbClientFactory(fakeAdb), null, {
        cacheEnabled: true,
        installedAppsRepository: repo,
        timer,
      });

      await expect(list.executeDetailed()).resolves.toMatchObject({
        profiles: { 0: [{ packageName: "com.example.live" }] },
      });
      expect(getInstalledAppsCacheWriteCoordinator().isDirty(device.deviceId)).toBe(true);

      await expect(list.executeDetailed()).resolves.toMatchObject({
        profiles: { 0: [{ packageName: "com.example.live" }] },
      });
      expect(getInstalledAppsCacheWriteCoordinator().isDirty(device.deviceId)).toBe(false);
    });
  });
});

describe("ListInstalledApps physical iOS devices", function () {
  const PHYSICAL_UDID = "00008130-001C2D3E1234567A";
  const SIMULATOR_UDID = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D";

  class FakePhysicalAppLister {
    calls: string[] = [];
    apps: Record<string, unknown>[] = [];
    failure: Error | null = null;

    async listInstalledApps(deviceUdid: string): Promise<Record<string, unknown>[]> {
      this.calls.push(deviceUdid);
      if (this.failure) {
        throw this.failure;
      }
      return this.apps;
    }
  }

  const iosDevice = (deviceId: string): BootedDevice =>
    ({ deviceId, platform: "ios" }) as BootedDevice;

  const createFakeAdbFactory = () => new FakeAdbClientFactory(new FakeAdbExecutor());

  test("lists apps via devicectl instead of simctl on a physical UDID", async function () {
    const lister = new FakePhysicalAppLister();
    lister.apps = [
      { bundleIdentifier: "com.example.device", name: "Device App" },
      { bundleIdentifier: "com.example.other" },
    ];
    const simctl = new FakeSimctl();
    simctl.setInstalledApps([{ bundleId: "com.example.simulator" }]);

    const list = new ListInstalledApps(iosDevice(PHYSICAL_UDID), createFakeAdbFactory(), simctl, {
      iosPhysicalAppLister: lister,
    });

    await expect(list.execute()).resolves.toEqual(["com.example.device", "com.example.other"]);
    expect(lister.calls).toEqual([PHYSICAL_UDID]);
    expect(simctl.getMethodCallCount("listAppsOrThrow")).toBe(0);
  });

  test("preserves devicectl app metadata in the detailed result", async function () {
    const lister = new FakePhysicalAppLister();
    lister.apps = [
      {
        bundleIdentifier: "com.example.device",
        name: "Device App",
        version: "4.2.0",
        url: "file:///private/var/containers/Bundle/Application/ABC/Device.app",
      },
    ];

    const list = new ListInstalledApps(
      iosDevice(PHYSICAL_UDID),
      createFakeAdbFactory(),
      new FakeSimctl(),
      { iosPhysicalAppLister: lister },
    );

    await expect(list.executeIosDetailedResult()).resolves.toEqual({
      apps: [
        {
          bundleIdentifier: "com.example.device",
          name: "Device App",
          version: "4.2.0",
          url: "file:///private/var/containers/Bundle/Application/ABC/Device.app",
        },
      ],
      successful: true,
    });
  });

  test("reports successful:false when devicectl fails rather than an empty listing", async function () {
    const lister = new FakePhysicalAppLister();
    lister.failure = new Error("devicectl is not installed");

    const list = new ListInstalledApps(
      iosDevice(PHYSICAL_UDID),
      createFakeAdbFactory(),
      new FakeSimctl(),
      { iosPhysicalAppLister: lister },
    );

    await expect(list.executeIosDetailedResult()).resolves.toEqual({
      apps: [],
      successful: false,
    });
  });

  test("keeps the simctl path for simulator UDIDs", async function () {
    const lister = new FakePhysicalAppLister();
    const simctl = new FakeSimctl();
    simctl.setInstalledApps([{ bundleId: "com.example.simulator" }]);

    const list = new ListInstalledApps(iosDevice(SIMULATOR_UDID), createFakeAdbFactory(), simctl, {
      iosPhysicalAppLister: lister,
    });

    await expect(list.execute()).resolves.toEqual(["com.example.simulator"]);
    expect(lister.calls).toEqual([]);
  });

  test("dedupes bundle identifiers reported twice by devicectl", async function () {
    const lister = new FakePhysicalAppLister();
    lister.apps = [
      { bundleIdentifier: "com.example.device", version: "1.0.0" },
      { bundleIdentifier: "com.example.device", version: "2.0.0" },
    ];

    const list = new ListInstalledApps(
      iosDevice(PHYSICAL_UDID),
      createFakeAdbFactory(),
      new FakeSimctl(),
      { iosPhysicalAppLister: lister },
    );

    await expect(list.executeIosDetailed()).resolves.toEqual([
      { bundleIdentifier: "com.example.device", version: "2.0.0" },
    ]);
  });
});
