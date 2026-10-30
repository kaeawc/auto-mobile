import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { SessionManager } from "../../src/daemon/sessionManager";
import { InstallApp } from "../../src/features/action/InstallApp";
import { WatchAppManager } from "../../src/features/action/watch/WatchAppManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  registerAppTools,
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import { listAppsResultSchema } from "../../src/server/appToolOutputSchemas";
import { createPlatformInstallApp } from "../../src/server/appToolsWatch";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SELECTS_ACTIVE_DEVICE } from "../../src/server/toolRegistryTypes";
import { setActiveDeviceSchema } from "../../src/server/utilityTools";
import { watchOsUnsupportedToolMessage } from "../../src/server/watchOsToolSupport";
import type { Platform } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWatchAppsSimctl, FakeWatchBundleIds } from "../fakes/FakeWatchApps";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { toolJson } from "../helpers/toolResponse";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";

isolateEmptyToolRegistry();

// installApp, uninstallApp and listApps reach an Apple Watch simulator only when the call names it
// (a watch session, or platform "watchos"); setActiveDevice selects one only by name (#14908).

const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "watchos",
};
const iphone: BootedDevice = {
  name: "iPhone 16",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  platform: "ios",
};
const pixel: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const APP = "/build/Debug-watchsimulator/Workout.app";
const BUNDLE = "com.example.workout.watchkitapp";
const CONNECTION = "client-a";
const WATCH_SESSION = "watch-session";

describe("app tools and setActiveDevice on an Apple Watch simulator", () => {
  const cleanups: Array<() => void> = [];
  const cleanup = () => {
    for (const run of cleanups.splice(0).reverse()) {
      run();
    }
  };
  afterEach(cleanup);
  afterAll(cleanup);

  // The first registration pays module/JIT cost outside the timed tests.
  beforeAll(async () => {
    await arrange();
    cleanup();
  });

  async function arrange(connected: BootedDevice[] = [iphone], { untypedListing = false } = {}) {
    const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    const timer = new FakeTimer();
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("watchos", [watch]);
    for (const platform of ["android", "ios"] as const satisfies Platform[]) {
      deviceUtils.setBootedDevices(
        platform,
        connected.filter((device) => device.platform === platform),
      );
    }
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "watch-apps-daemon", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([watch, ...connected]);
    DaemonState.getInstance().initialize(sessions, pool);
    const adb = new FakeAdbExecutor();
    adb.setDevices(connected.filter((device) => device.platform === "android"));
    const simctl = new FakeSimctl();
    simctl.setBootedSimulators(connected.filter((device) => device.platform === "ios"));
    const readiness = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(adb, deviceUtils, simctl),
    );
    const previous = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({
      deviceReadiness: readiness,
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
    });
    const restoreOverrides = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
      // The sessionless read path lists Android and iOS itself; never reach adb or simctl.
      deviceReadAccess: { listBooted: async () => connected, isAuthorized: () => true },
    });
    setInstalledAppResourceRefresh({ invalidate: () => {}, notify: async () => {} });
    cleanups.push(() => {
      ToolRegistry.clearTools();
      resetInstalledAppResourceRefresh();
      restoreOverrides();
      ToolRegistry.setCollaboratorsForTesting(previous);
      DaemonState.getInstance().reset();
      sessions.stopCleanupTimer();
    });

    const plist = new FakeWatchBundleIds();
    plist.byPath.set(APP, BUNDLE);
    const watchSimctl = new FakeWatchAppsSimctl(plist);
    watchSimctl.seed(watch.deviceId, {
      CFBundleIdentifier: "com.apple.NanoSettings",
      ...(untypedListing ? {} : { ApplicationType: "System" }),
      CFBundleDisplayName: "Settings",
    });
    registerAppTools({ watchApps: (device) => new WatchAppManager(device, watchSimctl, plist) });
    const resumed: string[] = [];
    ToolRegistry.register(
      "setActiveDevice",
      "Set active device",
      setActiveDeviceSchema,
      createSetActiveDeviceHandler({
        displayInventory: new FakeDisplayInventoryProvider(),
        resumeCtrlProxy: async (deviceId, platform) => {
          resumed.push(`${platform}:${deviceId}`);
        },
        legacyDeviceSelection: () => readiness,
      }),
      { defaultEnabled: true, ...SELECTS_ACTIVE_DEVICE },
    );
    return { pool, sessions, readiness, watchSimctl, resumed };
  }

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler({ __mcpSessionId: CONNECTION, ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  const bindWatchSession = () =>
    call("setActiveDevice", {
      deviceId: watch.deviceId,
      platform: "watchos",
      sessionUuid: WATCH_SESSION,
    });

  const listedBundles = async (args: Record<string, unknown>) => {
    const result = listAppsResultSchema.parse(toolJson(await call("listApps", args)));
    return {
      platform: result.devices[0]?.platform,
      bundles: result.devices.flatMap((device) => device.apps.map((app) => app.packageName)),
      type: result.query.type,
    };
  };

  test("setActiveDevice with platform watchos binds the pooled watch to the session", async () => {
    const { pool, sessions, resumed } = await arrange();

    const result = toolJson(await bindWatchSession());

    expect(result).toMatchObject({ deviceId: watch.deviceId, sessionUuid: WATCH_SESSION });
    expect(pool.getDevice(watch.deviceId)?.sessionId).toBe(WATCH_SESSION);
    expect(sessions.getSession(WATCH_SESSION)).toMatchObject({
      platform: "watchos",
      assignedDevice: watch.deviceId,
    });
    expect(sessions.getSession(WATCH_SESSION)?.cacheData.deviceReadiness).toBe("booted");
    // The resume seam is handed the watch; the production resume returns at once for watchOS.
    expect(resumed).toEqual([`watchos:${watch.deviceId}`]);
  });

  test("setActiveDevice refuses a bare watch deviceId without platform, binding nothing", async () => {
    const { pool, sessions } = await arrange();

    const error = await failure(
      call("setActiveDevice", { deviceId: watch.deviceId, sessionUuid: WATCH_SESSION }),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`Device '${watch.deviceId}' not found in device pool`);
    expect(pool.getDevice(watch.deviceId)?.sessionId ?? null).toBeNull();
    expect(sessions.getSession(WATCH_SESSION) ?? undefined).toBeUndefined();
  });

  test("install, list and uninstall an app on the session-bound watch", async () => {
    const { watchSimctl } = await arrange();
    await bindWatchSession();

    const installed = toolJson(
      await call("installApp", { sessionUuid: WATCH_SESSION, artifactPath: APP }),
    );
    expect(installed).toMatchObject({ success: true, packageName: BUNDLE, upgrade: false });
    expect(await listedBundles({ sessionUuid: WATCH_SESSION })).toEqual({
      platform: "watchos",
      bundles: ["com.apple.NanoSettings", BUNDLE],
      type: "launchable",
    });
    expect(await listedBundles({ sessionUuid: WATCH_SESSION, type: "user" })).toMatchObject({
      bundles: [BUNDLE],
    });
    expect(await listedBundles({ sessionUuid: WATCH_SESSION, search: "settings" })).toMatchObject({
      bundles: ["com.apple.NanoSettings"],
    });

    const removed = toolJson(
      await call("uninstallApp", { sessionUuid: WATCH_SESSION, appId: BUNDLE }),
    );
    expect(removed).toMatchObject({ success: true, wasInstalled: true, keepData: false });
    expect(await listedBundles({ sessionUuid: WATCH_SESSION })).toMatchObject({
      bundles: ["com.apple.NanoSettings"],
    });
    expect(watchSimctl.commands).toEqual([
      `install ${watch.deviceId} ${APP}`,
      `uninstall ${watch.deviceId} ${BUNDLE}`,
    ]);
  });

  test("the registered tools refuse Android-only options and keepData for a watch", async () => {
    const { watchSimctl } = await arrange();
    await bindWatchSession();

    const install = await failure(
      call("installApp", { sessionUuid: WATCH_SESSION, artifactPath: APP, allowDowngrade: true }),
    );
    const uninstall = await failure(
      call("uninstallApp", { sessionUuid: WATCH_SESSION, appId: BUNDLE, keepData: true }),
    );

    expect(String(install)).toContain("does not support: allowDowngrade");
    expect(String(uninstall)).toContain("cannot keep app data");
    expect(watchSimctl.commands).toEqual([]);
  });

  test("a tool that has not opted in is still refused on the watch session", async () => {
    await arrange();
    await bindWatchSession();

    const error = await failure(call("launchApp", { sessionUuid: WATCH_SESSION, appId: BUNDLE }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toMatchObject({ message: watchOsUnsupportedToolMessage("launchApp") });
  });

  test("sessionless listApps with platform watchos and the watch deviceId lists the watch", async () => {
    await arrange();

    expect(await listedBundles({ platform: "watchos", deviceId: watch.deviceId })).toEqual({
      platform: "watchos",
      bundles: ["com.apple.NanoSettings"],
      type: "launchable",
    });
  });

  test("a watch listing with no ApplicationType lists user apps and refuses type=launchable", async () => {
    await arrange([iphone], { untypedListing: true });
    const target = { platform: "watchos", deviceId: watch.deviceId };

    expect(await listedBundles(target)).toMatchObject({ platform: "watchos", type: "user" });
    const error = await failure(call("listApps", { ...target, type: "launchable" }));
    expect(String(error)).toContain("launchability is unknown");
  });

  test("sessionless listApps naming the watch id without platform never reaches the watch", async () => {
    const { watchSimctl } = await arrange();
    watchSimctl.listingError = new Error("the watch listing must not be read");

    const error = await failure(call("listApps", { deviceId: watch.deviceId }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).not.toContain("the watch listing must not be read");
  });

  test("sessionless setActiveDevice pins the watch, and a platform-less call ignores that pin", async () => {
    const { readiness } = await arrange([iphone, pixel]);

    await call("setActiveDevice", { deviceId: watch.deviceId, platform: "watchos" });
    expect(readiness.getExplicitDevicePin(CONNECTION)).toMatchObject({
      deviceId: watch.deviceId,
      platform: "watchos",
    });

    // The watch pin answers a call that names watchOS...
    expect(await listedBundles({ platform: "watchos" })).toMatchObject({ platform: "watchos" });
    // ...but with an iPhone and a Pixel connected a platform-less call is ambiguous, not the watch.
    const error = await failure(
      readiness.ensureDeviceReady("either", undefined, { connectionId: CONNECTION }),
    );
    expect(error).toMatchObject({ name: "AmbiguousDeviceTargetError" });
  });

  test("sessionless setActiveDevice refuses a bare watch deviceId and pins nothing", async () => {
    const { readiness } = await arrange();

    const error = await failure(call("setActiveDevice", { deviceId: watch.deviceId }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(readiness.getExplicitDevicePin(CONNECTION)).toBeUndefined();
  });

  test("installApp keeps the iOS installer for an iPhone", () => {
    expect(createPlatformInstallApp(iphone)).toBeInstanceOf(InstallApp);
    expect(createPlatformInstallApp(pixel)).toBeInstanceOf(InstallApp);
  });
});
