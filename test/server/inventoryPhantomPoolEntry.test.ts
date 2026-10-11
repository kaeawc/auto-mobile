import { afterEach, describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract: every surface reports the same devices and the same counts. The
// booted-devices resource deliberately counts "from the live booted list so phantom (shut-down)
// pool entries are excluded", and listDevices lists only live devices. The pool-stats surfaces
// (`daemon/availableDevices`, the in-daemon `available-devices`, `daemon status` pool counts) count
// every pool entry and never re-read discovery, so an emulator that has been shut down between
// pool refreshes is still "1 available device" there while the other surfaces list none.

const android: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
};

describe("a pooled device that discovery no longer lists", () => {
  let sessions: SessionManager | undefined;

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
    resetDeviceToolsDependencies();
  });

  test("is not counted available by daemon/availableDevices while listDevices and the resource list none", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = sessionManager;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "hunt-phantom", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([android]);
    // The emulator is shut down; adb now succeeds and lists nothing.
    manager.setBootedDevices("android", []);
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);
    if (!ToolRegistry.getTool("listDevices")) {
      registerDeviceTools();
    }

    const resource = await getBootedDevicesForPlatforms(["android"], timer);
    const toolResponse = await ToolRegistry.getTool("listDevices")!.handler({
      platform: "android",
    });
    const tool = JSON.parse(toolResponse.content?.[0]?.text ?? "{}");
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager as never,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    const daemon = await handleDaemonRequest(
      { id: "r", type: "daemon_request", method: "daemon/availableDevices", params: {} },
      state,
    );
    const available = daemon.result as { availableDevices: number; totalDevices: number };

    // Sanity: the two live surfaces agree there is no device.
    expect({ listed: tool.count, resourceIdle: resource.poolStatus?.idle }).toEqual({
      listed: 0,
      resourceIdle: 0,
    });
    // The pool-stats surface must agree with them.
    expect(available.availableDevices).toBe(0);
  });

  async function poolOf(devices: BootedDevice[]) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", devices);
    manager.setBootedDevices("ios", []);
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = sessionManager;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "phantom-stats", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(devices);
    return { pool, manager };
  }

  test("an incomplete listing makes the count unknown, never the stale pool tally or zero", async () => {
    const { pool, manager } = await poolOf([android]);
    manager.setAndroidDiscoveryIncomplete("adb devices failed");

    await expect(pool.getRefreshedStats()).rejects.toMatchObject({ code: "discovery_incomplete" });
  });

  test("a platform with no pooled entries is not discovered, and a live device is still counted", async () => {
    const { pool, manager } = await poolOf([android]);

    const stats = await pool.getRefreshedStats();

    expect(stats).toMatchObject({ total: 1, idle: 1, assigned: 0 });
    expect(manager.getBootedDevicesDetailedCalls().map((call) => call.platform)).toEqual([
      "android",
    ]);
  });

  test("a held device adb still lists offline stays counted as assigned", async () => {
    const { pool, manager } = await poolOf([android]);
    await pool.bindOrReuseDeviceSession("held-1", android.deviceId, "android");
    manager.setBootedDevices("android", []);
    Object.assign(manager, {
      getAndroidListedDeviceStates: async () => new Map([[android.deviceId, "offline"]]),
    });

    expect(await pool.getRefreshedStats()).toMatchObject({ total: 1, idle: 0, assigned: 1 });
  });

  test("a held simulator that simctl no longer lists at all is absent from the counts", async () => {
    // A simulator in Booting / Shutting Down is listed with its state and counted assigned
    // (#11573, inventorySurfaceParity); one simctl does not report is shut down, a phantom.
    const sim: BootedDevice = { platform: "ios", name: "iPhone 17", deviceId: "SIM-HELD" };
    const { pool, manager } = await poolOf([]);
    manager.setBootedDevices("ios", [sim]);
    await pool.initializeWithDevices([sim]);
    await pool.bindOrReuseDeviceSession("held-ios", sim.deviceId, "ios");
    manager.setBootedDevices("ios", []);

    expect(await pool.getRefreshedStats()).toMatchObject({ total: 0, idle: 0, assigned: 0 });
  });

  test("a failed source no pooled device depends on leaves the counts exact", async () => {
    const sim: BootedDevice = { platform: "ios", name: "iPhone 17", deviceId: "SIM-LIVE" };
    const { pool, manager } = await poolOf([android, sim]);
    manager.setBootedDevices("ios", [sim]);
    manager.failedSources.add("ios-physical");

    expect(await pool.getRefreshedStats()).toMatchObject({ total: 2, idle: 2 });
  });

  test("daemon/availableDevices lists only the devices it counts", async () => {
    const { pool, manager } = await poolOf([android]);
    manager.setBootedDevices("android", []);
    const sessionManager = sessions as SessionManager;
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => sessionManager as never,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };

    const response = await handleDaemonRequest(
      { id: "r", type: "daemon_request", method: "daemon/availableDevices", params: {} },
      state,
    );

    expect(response.result).toMatchObject({ totalDevices: 0, devices: [] });
  });
});
