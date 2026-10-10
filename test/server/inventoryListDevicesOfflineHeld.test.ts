import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract: every surface reports the same status for a device. #11118 made the booted
// resource list a held device adb reports `offline` (session + pool status + connection), but the
// `listDevices` TOOL -- the surface #11118 is titled for -- still joins pool state only onto the
// online discovery rows, so the same held device is simply absent from it.

const android: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
};

describe("listDevices tool vs booted resource for a held, adb-offline device", () => {
  let sessions: SessionManager | undefined;

  beforeAll(() => {
    if (!ToolRegistry.getTool("listDevices")) {
      registerDeviceTools();
    }
  });

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
  });

  afterAll(() => {
    resetDeviceToolsDependencies();
  });

  test("the tool lists the held offline device the resource lists", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-offline-held", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([android]);
    await pool.assignDeviceToSession("session-held");
    // adb now lists the held emulator `offline`: online-only discovery drops it.
    manager.setBootedDevices("android", []);
    (manager as PlatformDeviceManager).getAndroidListedDeviceStates = async (ids) =>
      new Map(ids.map((id) => [id, "offline"]));
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);

    const resource = await getBootedDevicesForPlatforms(["android"], timer);
    const fromResource = resource.devices.find((d) => d.runtime.deviceId === android.deviceId);
    expect(fromResource?.runtime.session?.sessionUuid).toBe("session-held");

    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "android" });
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
    const fromTool = payload.devices.find(
      (d: { runtime: { deviceId: string } }) => d.runtime.deviceId === android.deviceId,
    );
    expect(fromTool?.runtime.session?.sessionUuid).toBe("session-held");
    expect(fromTool?.runtime.poolStatus).toBe("assigned");
    expect(fromTool?.runtime.connection).toEqual(fromResource?.runtime.connection);
    expect(fromTool?.runtime.connection?.state).toBe("offline");
  });
});
