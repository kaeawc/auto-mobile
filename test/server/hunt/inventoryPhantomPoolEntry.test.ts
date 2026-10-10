import { afterEach, describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../../src/server/bootedDeviceResources";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

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
});
