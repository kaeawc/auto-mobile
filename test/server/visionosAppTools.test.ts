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
import { createPlatformInstallApp, createPlatformLaunchApp } from "../../src/server/appToolsWatch";
import { LaunchApp } from "../../src/features/action/LaunchApp";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SELECTS_ACTIVE_DEVICE } from "../../src/server/toolRegistryTypes";
import { setActiveDeviceSchema } from "../../src/server/utilityTools";
import { APPLE_PLATFORM_SUPPORTED_TOOLS } from "../../src/server/applePlatformToolSupport";
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

const visionPro: BootedDevice = {
  name: "Apple Vision Pro 4K (3rd generation)",
  deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
  platform: "visionos",
};
const iphone: BootedDevice = {
  name: "iPhone 16",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  platform: "ios",
};
const APP = "/build/Debug-xrsimulator/Spatial.app";
const BUNDLE = "com.example.spatial";
const CONNECTION = "client-visionos";
const VISION_SESSION = "visionos-session";

describe("app tools on an Apple Vision Pro simulator", () => {
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
    deviceUtils.setBootedDevices("visionos", [visionPro]);
    deviceUtils.setBootedDevices("ios", connected);
    deviceUtils.setBootedDevices("android", []);
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "visionos-apps-daemon", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([visionPro, ...connected]);
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
        listBooted: async (_signal, scope) => (scope === "visionos" ? [visionPro] : connected),
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
    const visionSimctl = new FakeWatchAppsSimctl(plist);
    visionSimctl.seed(visionPro.deviceId, {
      CFBundleIdentifier: "com.apple.Settings",
      ApplicationType: "System",
      CFBundleDisplayName: "Settings",
    });
    registerAppTools({
      watchApps: (device) => new WatchAppManager(device, { simctl: visionSimctl, plist }),
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
    return { readiness, visionSimctl, timer };
  }

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler({ __mcpSessionId: CONNECTION, ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  const bindVisionSession = () =>
    call("setActiveDevice", {
      deviceId: visionPro.deviceId,
      platform: "visionos",
      sessionUuid: VISION_SESSION,
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
    "%s is allowlisted for visionOS",
    (name) => expect(APPLE_PLATFORM_SUPPORTED_TOOLS.visionos.has(name)).toBe(true),
  );

  test("install, list and uninstall use simctl on a pooled visionOS session", async () => {
    const { visionSimctl, timer } = await arrange();
    await bindVisionSession();
    expect(
      toolJson(await call("installApp", { sessionUuid: VISION_SESSION, artifactPath: APP })),
    ).toMatchObject({ success: true, packageName: BUNDLE, upgrade: false });
    expect(await listedBundles({ sessionUuid: VISION_SESSION })).toEqual({
      platform: "visionos",
      bundles: ["com.apple.Settings", BUNDLE],
      type: "launchable",
    });
    expect(
      toolJson(await call("uninstallApp", { sessionUuid: VISION_SESSION, appId: BUNDLE })),
    ).toMatchObject({ success: true, wasInstalled: true });
    expect(await listedBundles({ sessionUuid: VISION_SESSION })).toMatchObject({
      bundles: ["com.apple.Settings"],
    });
    expect(timer.getSleepHistory()).toEqual([]);
    expect(visionSimctl.commands).toEqual([
      `install ${visionPro.deviceId} ${APP}`,
      `uninstall ${visionPro.deviceId} ${BUNDLE}`,
    ]);
  });

  test("launch and terminate use simctl on a pooled visionOS session", async () => {
    const { visionSimctl, timer } = await arrange();
    await bindVisionSession();
    visionSimctl.seed(visionPro.deviceId, { CFBundleIdentifier: BUNDLE, ApplicationType: "User" });
    const launched = toolJson(
      await call("launchApp", { sessionUuid: VISION_SESSION, appId: BUNDLE }),
    );
    expect(launched).toMatchObject({
      success: true,
      packageName: BUNDLE,
      pid: visionSimctl.pidOf(visionPro.deviceId, BUNDLE),
    });
    expect(
      toolJson(await call("terminateApp", { sessionUuid: VISION_SESSION, appId: BUNDLE })),
    ).toMatchObject({ success: true, wasInstalled: true, wasRunning: true });
    expect(timer.getSleepHistory()).toEqual([]);
    expect(visionSimctl.commands).toEqual([
      `launch ${visionPro.deviceId} ${BUNDLE}`,
      `terminate ${visionPro.deviceId} ${BUNDLE}`,
    ]);
  });

  test("prototype is refused with a visionOS ActionableError before simctl launch", async () => {
    const { visionSimctl, timer } = await arrange();
    await bindVisionSession();
    visionSimctl.seed(visionPro.deviceId, { CFBundleIdentifier: BUNDLE, ApplicationType: "User" });
    const error = await failure(
      call("launchApp", {
        sessionUuid: VISION_SESSION,
        appId: BUNDLE,
        prototype: true,
      }),
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("not supported on visionOS");
    expect(String(error)).toContain("prototype agent runs only in iOS simulator apps");
    expect(timer.getSleepHistory()).toEqual([]);
    expect(visionSimctl.commands).toEqual([]);
  });

  test("listApps with explicit visionOS lists from simctl", async () => {
    await arrange();
    expect(await listedBundles({ platform: "visionos", deviceId: visionPro.deviceId })).toEqual({
      platform: "visionos",
      bundles: ["com.apple.Settings"],
      type: "launchable",
    });
  });

  test("listApps defaults unknown launchability to user and refuses an explicit launchable filter", async () => {
    const { visionSimctl } = await arrange();
    visionSimctl.seed(visionPro.deviceId, { CFBundleIdentifier: "com.apple.Settings" });
    const args = { platform: "visionos", deviceId: visionPro.deviceId };
    expect(await listedBundles(args)).toMatchObject({ type: "user" });
    await expect(listedBundles({ ...args, type: "launchable" })).rejects.toThrow(
      `Cannot filter by type=launchable for visionOS ${visionPro.deviceId}`,
    );
  });

  test("listApps can read a pooled Apple Vision Pro held by another session", async () => {
    const { timer } = await arrange();
    await bindVisionSession();
    const result = listAppsResultSchema.parse(
      toolJson(
        await ToolRegistry.getTool("listApps")!.handler({
          __mcpSessionId: "observer-visionos",
          platform: "visionos",
          deviceId: visionPro.deviceId,
        }),
      ),
    );
    expect(result.devices).toEqual([
      expect.objectContaining({ deviceId: visionPro.deviceId, platform: "visionos" }),
    ]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("visionOS factories bypass iOS executors while iPhone paths stay unchanged", () => {
    const plist = new FakeWatchBundleIds();
    const simctl = new FakeWatchAppsSimctl(plist);
    const factory = (device: BootedDevice) => new WatchAppManager(device, { simctl, plist });
    expect(createPlatformInstallApp(visionPro, factory)).not.toBeInstanceOf(InstallApp);
    expect(createPlatformLaunchApp(visionPro, factory)).not.toBeInstanceOf(LaunchApp);
    expect(createPlatformInstallApp(iphone, factory)).toBeInstanceOf(InstallApp);
    expect(createPlatformLaunchApp(iphone, factory)).toBeInstanceOf(LaunchApp);
  });
  test.each([
    ["all", ["com.apple.Settings", BUNDLE]],
    ["user", [BUNDLE]],
    ["system", ["com.apple.Settings"]],
    ["launchable", ["com.apple.Settings", BUNDLE]],
  ])("listApps filters type=%s", async (type, bundles) => {
    const { visionSimctl } = await arrange();
    visionSimctl.seed(visionPro.deviceId, { CFBundleIdentifier: BUNDLE, ApplicationType: "User" });
    expect(
      await listedBundles({ platform: "visionos", deviceId: visionPro.deviceId, type }),
    ).toMatchObject({ type, bundles });
  });

  test("manager refusals name visionOS", async () => {
    const plist = new FakeWatchBundleIds();
    const simctl = new FakeWatchAppsSimctl(plist);
    const manager = new WatchAppManager(visionPro, { simctl, plist });
    await expect(manager.install("/build/App.ipa")).rejects.toThrow(
      "installApp on visionOS needs a .app bundle built for the visionOS simulator",
    );
    await expect(manager.install(APP, { userId: 1 })).rejects.toThrow(
      "installApp on visionOS does not support: userId",
    );
    await expect(manager.uninstall(BUNDLE, { keepData: true })).rejects.toThrow(
      "uninstallApp on visionOS cannot keep app data",
    );
    await expect(manager.uninstall(BUNDLE, { userId: 1 })).rejects.toThrow(
      "uninstallApp on visionOS does not support: userId",
    );
    await expect(
      manager.launch(BUNDLE, { userId: 1, clearAppData: false, coldBoot: false }),
    ).rejects.toThrow("launchApp on visionOS does not support: userId");
    simctl.seed(visionPro.deviceId, { CFBundleIdentifier: BUNDLE, ApplicationType: "User" });
    simctl.terminateError = new Error("stop failed");
    expect(await manager.launch(BUNDLE, { coldBoot: true, clearAppData: false })).toMatchObject({
      error: `Could not stop ${BUNDLE} on visionOS ${visionPro.deviceId} before launching: stop failed`,
    });
    expect(simctl.commands).toEqual([`terminate ${visionPro.deviceId} ${BUNDLE}`]);
  });
});
