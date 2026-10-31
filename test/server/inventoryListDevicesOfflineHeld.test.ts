import { makePool } from "../helpers/makePool";
import { listDevicesOutputSchema } from "../../src/server/deviceTools";
import { toolStructured } from "../helpers/toolResponse";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
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
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

// Inventory contract: every surface reports the same status for a device. #11118 made the booted
// resource list a held device adb reports `offline` (session + pool status + connection), but the
// `listDevices` TOOL -- the surface #11118 is titled for -- still joins pool state only onto the
// online discovery rows, so the same held device is simply absent from it.

const android: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
};

isolateToolRegistry();

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
    const pool = makePool(sessions, "hunt-offline-held", { timer, deviceManager: manager });
    await pool.initializeWithDevices([android]);
    await pool.assignDeviceToSession("session-held");
    // adb now lists the held emulator `offline`: online-only discovery drops it.
    manager.setBootedDevices("android", []);
    manager.getAndroidListedDeviceStates = async (ids) =>
      new Map(Array.from(ids, (id) => [id, "offline"]));
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
    const payload = listDevicesOutputSchema.parse(toolStructured(response));
    const fromTool = payload.devices.find((d) => d.runtime.deviceId === android.deviceId);
    expect(fromTool?.runtime.session?.sessionUuid).toBe("session-held");
    expect(fromTool?.runtime.poolStatus).toBe("assigned");
    expect(fromTool?.runtime.connection).toEqual(fromResource?.runtime.connection);
    expect(fromTool?.runtime.connection?.state).toBe("offline");
  });
  test("tvOS listings exclude held offline Android devices without probing them", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    manager.setBootedDevices("tvos", []);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = makePool(sessions, "tvos-offline-held", { timer, deviceManager: manager });
    await pool.initializeWithDevices([android]);
    await pool.assignDeviceToSession("session-held");
    manager.setBootedDevices("android", []);
    let probeCalls = 0;
    manager.getAndroidListedDeviceStates = async (ids) => {
      probeCalls += 1;
      return new Map(Array.from(ids, (id) => [id, "offline"]));
    };
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });
    setDeviceManager(manager);

    const response = await ToolRegistry.getTool("listDevices")!.handler({ platform: "tvos" });
    const payload = listDevicesOutputSchema.parse(toolStructured(response));
    expect(payload.devices.some((device) => device.runtime.deviceId === android.deviceId)).toBe(
      false,
    );
    expect(payload.count).toBe(0);
    expect(probeCalls).toBe(0);
  });

  test("the held-device state probe receives the request's explicit signal, not an ambient one", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = makePool(sessions, "hunt-offline-held-signal", { timer, deviceManager: manager });
    await pool.initializeWithDevices([android]);
    await pool.assignDeviceToSession("session-held");
    manager.setBootedDevices("android", []);
    const probeSignals: Array<AbortSignal | undefined> = [];
    manager.getAndroidListedDeviceStates = async (ids, options) => {
      probeSignals.push(options?.signal);
      return new Map(Array.from(ids, (id) => [id, "offline"]));
    };
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    });

    const controller = new AbortController();
    // No runWithAbortSignal scope: only the signal passed to the handler can reach the probe.
    await ToolRegistry.getTool("listDevices")!.handler(
      { platform: "android" },
      undefined,
      controller.signal,
    );

    expect(probeSignals).toEqual([controller.signal]);
  });
});
