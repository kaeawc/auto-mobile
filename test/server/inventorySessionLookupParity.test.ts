import { makePool } from "../helpers/makePool";
import { listDevicesOutputSchema } from "../../src/server/deviceTools";
import { toolStructured } from "../helpers/toolResponse";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
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
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

// Inventory contract: every surface reports the same holder for a device. The listDevices tool
// names the session from the pool's own assignment (`pooled.sessionId`); the booted resource names
// it from a map of every session by `assignedDevice`, whichever the pool says holds the device.
// A session the session manager still points at the device, while the pool has it idle, is
// therefore a holder on the resource and no holder on the tool.

const android: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
};

describe("session attribution on the tool and the resource", () => {
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

  test("a session the pool does not hold on the device is attributed identically by the tool and the resource", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = makePool(sessions, "hunt-session-parity", { timer, deviceManager: manager });
    await pool.initializeWithDevices([android]);
    await sessions.createSession("session-pointing-at-device", android.deviceId, "android");
    expect(pool.getDevice(android.deviceId)?.sessionId).toBeNull();

    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);

    const resource = await getBootedDevicesForPlatforms(["android"], timer);
    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "android" });
    const payload = listDevicesOutputSchema.parse(toolStructured(response));

    const fromResource = resource.devices.find((d) => d.runtime.deviceId === android.deviceId)!;
    const fromTool = payload.devices.find((d) => d.runtime.deviceId === android.deviceId)!;
    expect(fromTool.runtime.poolStatus).toBe(fromResource.runtime.poolStatus);
    expect(fromResource.runtime.session).toEqual(fromTool.runtime.session ?? null);
  });
});
