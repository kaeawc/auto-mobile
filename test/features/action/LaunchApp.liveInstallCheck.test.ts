import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { getInstalledAppsCacheWriteCoordinator } from "../../../src/db/installedAppsCacheWriteCoordinator";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeInstalledAppsProvider } from "../../fakes/FakeInstalledAppsProvider";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

// #9976: a "not installed" verdict read from the installed-apps cache is confirmed
// with one live `pm list packages --user N` before launchApp fails.
describe("LaunchApp live install confirmation (#9976)", () => {
  const packageName = "com.example.fresh";
  const deviceId = "device-9976";
  const device: BootedDevice = { name: "test-device", platform: "android", deviceId };
  const listCommand = "shell pm list packages --user 0";
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let staleStore: FakeInstalledAppsRepository;
  let staled: string[];

  const observeResult = (): ObserveResult => ({
    updatedAt: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
    activeWindow: { appId: packageName, activityName: "MainActivity", layoutSeqSum: 1 },
  });

  const createLaunchApp = (cachedApps: string[]): LaunchApp => {
    const action = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      installedAppsProvider: new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: cachedApps,
      }),
      installedAppsCacheStaleMarker: {
        markDeviceStale: async (id) => {
          staled.push(id);
          await staleStore.markDeviceStale(id);
        },
      },
    });
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(observeResult());
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({
      appId: packageName,
      activityName: "MainActivity",
      layoutSeqSum: 1,
    });
    action.awaitIdle = new FakeAwaitIdle();
    action.observeScreen = observeScreen;
    action.window = window;
    return action;
  };

  const listCommandCount = () =>
    fakeAdb.getExecutedCommands().filter((command) => command.includes("pm list packages")).length;
  const hasAmStart = () =>
    fakeAdb.getExecutedCommands().some((command) => command.includes("shell am start"));

  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    staleStore = new FakeInstalledAppsRepository();
    staled = [];
    fakeAdb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
    fakeAdb.setCommandResponse("shell am start --user 0", {
      stdout: "Starting: Intent",
      stderr: "",
    });
  });

  afterEach(async () => {
    await getInstalledAppsCacheWriteCoordinator().releaseDevice(deviceId);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("launches an app the cache lacks but the device lists, and stales the cache", async () => {
    fakeAdb.setCommandResponse(listCommand, { stdout: `package:${packageName}\n`, stderr: "" });

    const result = await createLaunchApp(["com.example.cached"]).execute(packageName, false, false);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(hasAmStart()).toBe(true);
    expect(staled).toEqual([deviceId]);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(true);
  });

  test("still reports App is not installed when the live read also lacks the package", async () => {
    fakeAdb.setCommandResponse(listCommand, {
      stdout: "package:com.example.cached\n",
      stderr: "",
    });

    const result = await createLaunchApp(["com.example.cached"]).execute(packageName, false, false);

    expect(result).toMatchObject({ success: false, error: "App is not installed" });
    expect(hasAmStart()).toBe(false);
    expect(listCommandCount()).toBe(1);
    expect(staled).toEqual([]);
  });

  test("a cache hit costs no live package listing", async () => {
    const result = await createLaunchApp([packageName]).execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(listCommandCount()).toBe(0);
    expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(false);
  });

  test("a failed live read is reported as undetermined, not as absent", async () => {
    fakeAdb.setCommandError(listCommand, new Error("adb: device offline"));

    await expect(
      createLaunchApp(["com.example.cached"]).execute(packageName, false, false),
    ).rejects.toThrow(`Could not determine whether ${packageName} is installed`);
    expect(hasAmStart()).toBe(false);
  });

  // #10192: the mirror of the case above. The cache still lists an app that was removed
  // outside the tools, so the launcher intent is rejected and the fallbacks cannot help.
  describe("an app removed outside the tools is still cached as installed (#10192)", () => {
    const amError = {
      stdout:
        "Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10000000 pkg=com.example.fresh }",
      stderr: "",
    };
    const adbCalls = (needle: string) =>
      fakeAdb.getExecutedCommands().filter((command) => command.includes(needle));

    beforeEach(() => {
      fakeAdb.setCommandResponse("shell am start --user 0", amError);
      fakeAdb.setCommandResponse("shell monkey", {
        stdout: "** No activities found to run, monkey aborted.",
        stderr: "",
      });
    });

    test("fails fast with App is not installed after one live read and stales the cache", async () => {
      fakeAdb.setCommandResponse(listCommand, {
        stdout: "package:com.example.cached\n",
        stderr: "",
      });

      const result = await createLaunchApp([packageName]).execute(packageName, false, false);

      expect(result).toMatchObject({
        success: false,
        packageName,
        userId: 0,
        error: "App is not installed",
      });
      // One launcher intent, one live listing; no monkey, discovery, patterns or final intent.
      expect(adbCalls("shell am start")).toHaveLength(1);
      expect(listCommandCount()).toBe(1);
      expect(adbCalls("shell monkey")).toHaveLength(0);
      expect(adbCalls("query-activities")).toHaveLength(0);
      expect(adbCalls("pm dump")).toHaveLength(0);
      expect(staled).toEqual([deviceId]);
      expect(getInstalledAppsCacheWriteCoordinator().isDirty(deviceId)).toBe(true);
    });

    test("an installed app without a launcher activity still runs every fallback", async () => {
      fakeAdb.setCommandResponse(listCommand, { stdout: `package:${packageName}\n`, stderr: "" });
      fakeAdb.setCommandResponse("shell am start --user 0 -n", {
        stdout: "Error type 3\nActivity class does not exist.",
        stderr: "",
      });

      await expect(
        createLaunchApp([packageName]).execute(packageName, false, false),
      ).rejects.toThrow("No launcher activity found and launcher intent failed");

      expect(listCommandCount()).toBe(1);
      expect(adbCalls("shell monkey")).toHaveLength(1);
      // launcher intent, six common component guesses, final launcher intent
      expect(adbCalls("shell am start")).toHaveLength(8);
      expect(staled).toEqual([]);
    });

    test("an unreadable live listing neither fails the launch nor skips the fallbacks", async () => {
      fakeAdb.setCommandError(listCommand, new Error("adb: device offline"));

      await expect(
        createLaunchApp([packageName]).execute(packageName, false, false),
      ).rejects.toThrow("No launcher activity found and launcher intent failed");

      expect(adbCalls("shell monkey")).toHaveLength(1);
      expect(staled).toEqual([]);
    });

    test("a launcher intent that succeeds never pays for a live listing", async () => {
      fakeAdb.setCommandResponse("shell am start --user 0", {
        stdout: "Starting: Intent",
        stderr: "",
      });

      const result = await createLaunchApp([packageName]).execute(packageName, false, false);

      expect(result.success).toBe(true);
      expect(listCommandCount()).toBe(0);
      expect(staled).toEqual([]);
    });
  });
});
