import { afterEach, describe, expect, test } from "bun:test";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DevicePoolRefresh } from "../../src/daemon/devicePoolRefresh";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

let sessions: SessionManager;

afterEach(() => {
  sessions.stopCleanupTimer();
  DaemonState.getInstance().reset();
});

describe("daemon/refreshDevices outcome", () => {
  test.each([
    { devices: [] },
    { devices: [{ deviceId: "refresh-device", name: "Refresh device", platform: "android" }] },
  ] satisfies { devices: BootedDevice[] }[])(
    "preserves a successful refresh response for %j",
    async ({ devices }) => {
      const timer = new FakeTimer();
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const deviceManager = new FakeDeviceUtils();
      deviceManager.setBootedDevices("android", devices);
      const pool = new DevicePool(
        createDevicePoolDependencies(sessions, "refresh-success", {
          timer,
          deviceManager,
          devicePoolRefreshFactory: (port) =>
            new DevicePoolRefresh({ ...port, setDeviceSessionTracking: async () => {} }),
        }),
      );
      const state = DaemonState.getInstance();
      state.initialize(sessions, pool);
      const response = await handleDaemonRequest(
        { id: "refresh", type: "daemon_request", method: "daemon/refreshDevices", params: {} },
        state,
      );
      expect(response).toEqual({
        success: true,
        result: {
          addedDevices: devices.length,
          totalDevices: devices.length,
          availableDevices: devices.length,
          stats: pool.getStats(),
        },
      });
    },
  );

  test("returns a failure response when tracking persistence fails", async () => {
    const timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", [
      { deviceId: "refresh-device", name: "Refresh device", platform: "android" },
    ]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "refresh-outcome", {
        timer,
        deviceManager,
        devicePoolRefreshFactory: (port) =>
          new DevicePoolRefresh({
            ...port,
            setDeviceSessionTracking: async () => {
              throw new Error("tracking persistence unavailable");
            },
          }),
      }),
    );
    const state = DaemonState.getInstance();
    state.initialize(sessions, pool);

    const response = await handleDaemonRequest(
      { id: "refresh", type: "daemon_request", method: "daemon/refreshDevices", params: {} },
      state,
    );

    expect(response).toEqual({
      success: false,
      error:
        "Could not refresh device list: tracking persistence unavailable. Resolve the cause and retry.",
    });
  });
});
