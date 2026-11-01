import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { SessionManager } from "../../src/daemon/sessionManager";
import { InstallApp } from "../../src/features/action/InstallApp";
import { WatchAppManager } from "../../src/features/action/watch/WatchAppManager";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  registerAppTools,
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import { listAppsResultSchema } from "../../src/server/appToolOutputSchemas";
import { createPlatformInstallApp, createPlatformLaunchApp } from "../../src/server/appToolsWatch";
import { LaunchApp } from "../../src/features/action/LaunchApp";
import { sessionlessDeviceReadFor } from "../../src/server/deviceObservationAccess";
import { resolveSessionlessDeviceRead } from "../../src/server/pipeline/readTarget";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SELECTS_ACTIVE_DEVICE } from "../../src/server/toolRegistryTypes";
import { setActiveDeviceSchema } from "../../src/server/utilityTools";
import { APPLE_PLATFORM_SUPPORTED_TOOLS } from "../../src/server/applePlatformToolSupport";
import { bindingPlatformsFor } from "../../src/server/pipeline/deviceCallDispatch";
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

const tv: BootedDevice = {
  name: "Apple TV 4K (3rd generation)",
  deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
  platform: "tvos",
};
const iphone: BootedDevice = {
  name: "iPhone 16",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  platform: "ios",
};
const APP = "/build/Debug-appletvsimulator/Television.app";
const BUNDLE = "com.example.television";
const CONNECTION = "client-tv";
const TV_SESSION = "tv-session";

describe("app tools on an Apple TV simulator", () => {
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

  async function arrange() {
    const connected = [iphone];
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    const timer = new FakeTimer();
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("tvos", [tv]);
    deviceUtils.setBootedDevices("ios", connected);
    deviceUtils.setBootedDevices("android", []);
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "tv-apps-daemon", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([tv, ...connected]);
    DaemonState.getInstance().initialize(sessions, pool);
    const adb = new FakeAdbExecutor();
    adb.setDevices([]);
    const simctl = new FakeSimctl();
    simctl.setBootedSimulators(connected);
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
      // Read discovery stays in memory on every platform.
      deviceReadAccess: {
        listBooted: async (_signal, scope) => (scope === "tvos" ? [tv] : connected),
        isAuthorized: () => true,
      },
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
    const tvSimctl = new FakeWatchAppsSimctl(plist);
    tvSimctl.seed(tv.deviceId, {
      CFBundleIdentifier: "com.apple.TVSettings",
      ApplicationType: "System",
      CFBundleDisplayName: "Settings",
    });
    registerAppTools({
      watchApps: (device) => new WatchAppManager(device, { simctl: tvSimctl, plist }),
    });
    ToolRegistry.register("setActiveDevice", "Set active device", setActiveDeviceSchema, {
      handler: createSetActiveDeviceHandler({
        displayInventory: new FakeDisplayInventoryProvider(),
        resumeCtrlProxy: async () => {},
        legacyDeviceSelection: () => readiness,
      }),
      defaultEnabled: true,
      ...SELECTS_ACTIVE_DEVICE,
    });
    return { readiness, tvSimctl, timer };
  }

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler({ __mcpSessionId: CONNECTION, ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  const bindTvSession = () =>
    call("setActiveDevice", {
      deviceId: tv.deviceId,
      platform: "tvos",
      sessionUuid: TV_SESSION,
    });

  const listedBundles = async (args: Record<string, unknown>) => {
    const result = listAppsResultSchema.parse(toolJson(await call("listApps", args)));
    return {
      platform: result.devices[0]?.platform,
      bundles: result.devices.flatMap((device) => device.apps.map((app) => app.packageName)),
      type: result.query.type,
    };
  };

  test.each(["installApp", "uninstallApp", "launchApp", "terminateApp", "listApps"])(
    "%s is allowlisted for tvOS",
    (name) => expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has(name)).toBe(true),
  );

  test("install, list and uninstall use simctl on a pooled tvOS session", async () => {
    const { tvSimctl, timer } = await arrange();
    await bindTvSession();
    expect(
      toolJson(await call("installApp", { sessionUuid: TV_SESSION, artifactPath: APP })),
    ).toMatchObject({ success: true, packageName: BUNDLE, upgrade: false });
    expect(await listedBundles({ sessionUuid: TV_SESSION })).toEqual({
      platform: "tvos",
      bundles: ["com.apple.TVSettings", BUNDLE],
      type: "launchable",
    });
    expect(
      toolJson(await call("uninstallApp", { sessionUuid: TV_SESSION, appId: BUNDLE })),
    ).toMatchObject({ success: true, wasInstalled: true });
    expect(await listedBundles({ sessionUuid: TV_SESSION })).toMatchObject({
      bundles: ["com.apple.TVSettings"],
    });
    expect(timer.getSleepHistory()).toEqual([]);
    expect(tvSimctl.commands).toEqual([
      `install ${tv.deviceId} ${APP}`,
      `uninstall ${tv.deviceId} ${BUNDLE}`,
    ]);
  });

  test("launch and terminate use simctl on a pooled tvOS session", async () => {
    const { tvSimctl, timer } = await arrange();
    await bindTvSession();
    tvSimctl.seed(tv.deviceId, { CFBundleIdentifier: BUNDLE, ApplicationType: "User" });
    const launched = toolJson(await call("launchApp", { sessionUuid: TV_SESSION, appId: BUNDLE }));
    expect(launched).toMatchObject({
      success: true,
      packageName: BUNDLE,
      pid: tvSimctl.pidOf(tv.deviceId, BUNDLE),
    });
    expect(
      toolJson(await call("terminateApp", { sessionUuid: TV_SESSION, appId: BUNDLE })),
    ).toMatchObject({ success: true, wasInstalled: true, wasRunning: true });
    expect(timer.getSleepHistory()).toEqual([]);
    expect(tvSimctl.commands).toEqual([
      `launch ${tv.deviceId} ${BUNDLE}`,
      `terminate ${tv.deviceId} ${BUNDLE}`,
    ]);
  });

  test("prototype is refused with a tvOS ActionableError before simctl launch", async () => {
    const { tvSimctl, timer } = await arrange();
    await bindTvSession();
    tvSimctl.seed(tv.deviceId, { CFBundleIdentifier: BUNDLE, ApplicationType: "User" });
    const error = await failure(
      call("launchApp", {
        sessionUuid: TV_SESSION,
        appId: BUNDLE,
        prototype: true,
      }),
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("not supported on tvOS");
    expect(String(error)).toContain("prototype agent runs only in iOS simulator apps");
    expect(timer.getSleepHistory()).toEqual([]);
    expect(tvSimctl.commands).toEqual([]);
  });

  test("listApps with explicit tvOS lists from simctl", async () => {
    await arrange();
    expect(await listedBundles({ platform: "tvos", deviceId: tv.deviceId })).toEqual({
      platform: "tvos",
      bundles: ["com.apple.TVSettings"],
      type: "launchable",
    });
  });

  test("listApps can read a pooled Apple TV held by another session", async () => {
    const { timer } = await arrange();
    await bindTvSession();
    const result = listAppsResultSchema.parse(
      toolJson(
        await ToolRegistry.getTool("listApps")!.handler({
          __mcpSessionId: "observer-tv",
          platform: "tvos",
          deviceId: tv.deviceId,
        }),
      ),
    );
    expect(result.devices).toEqual([
      expect.objectContaining({ deviceId: tv.deviceId, platform: "tvos" }),
    ]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a failed tvOS discovery stays incomplete rather than reporting a missing TV", async () => {
    const { readiness, timer } = await arrange();
    const read = sessionlessDeviceReadFor(
      {
        avdConfigReader: undefined,
        listBooted: async () => [],
        listBootedWithStatus: async () => ({
          devices: [],
          scanned: { android: false, ios: false, watchos: false, tvos: false },
          discoveryErrors: { tvos: { code: "unavailable", message: "simctl missing" } },
        }),
        isAuthorized: () => true,
      },
      { timer },
    );
    const error = await failure(
      resolveSessionlessDeviceRead(
        { name: "listApps", args: {}, options: {}, deviceReadiness: readiness, timer },
        read,
        tv.deviceId,
      ),
    );
    expect(error).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a late pooled tvOS read without platform resolves the Apple TV", async () => {
    const { readiness } = await arrange();
    const read = sessionlessDeviceReadFor({
      avdConfigReader: undefined,
      listBooted: async (_signal, scope) => (scope === "tvos" ? [tv] : [iphone]),
      isAuthorized: () => true,
    });
    const context = await resolveSessionlessDeviceRead(
      { name: "listApps", args: {}, options: {}, deviceReadiness: readiness },
      read,
      tv.deviceId,
    );
    expect(context.device).toMatchObject(tv);
  });

  test("pooled tvOS binding checks already use tvOS without widening unpooled checks", () => {
    expect(bindingPlatformsFor("tvos", undefined)).toEqual(["tvos"]);
    expect(bindingPlatformsFor(undefined, "tvos")).toEqual(["android", "ios"]);
  });

  test("tvOS factories bypass iOS executors while iPhone paths stay unchanged", () => {
    const plist = new FakeWatchBundleIds();
    const simctl = new FakeWatchAppsSimctl(plist);
    const factory = (device: BootedDevice) => new WatchAppManager(device, { simctl, plist });
    expect(createPlatformInstallApp(tv, factory)).not.toBeInstanceOf(InstallApp);
    expect(createPlatformLaunchApp(tv, factory)).not.toBeInstanceOf(LaunchApp);
    expect(createPlatformInstallApp(iphone, factory)).toBeInstanceOf(InstallApp);
    expect(createPlatformLaunchApp(iphone, factory)).toBeInstanceOf(LaunchApp);
  });
});
