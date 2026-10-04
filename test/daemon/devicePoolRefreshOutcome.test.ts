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
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";

let sessions: SessionManager;

afterEach(() => {
  sessions.stopCleanupTimer();
  DaemonState.getInstance().reset();
});

describe("allocation after a partial refresh failure", () => {
  const device: BootedDevice = {
    deviceId: "refresh-device",
    name: "Refresh device",
    platform: "android",
  };

  function failedRefreshPool(persistentFailure = true) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "allocation-refresh-failure", {
        timer,
        deviceManager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        devicePoolRefreshFactory: (port) =>
          new DevicePoolRefresh({
            ...port,
            setDeviceSessionTracking: async () => {
              throw new Error("tracking persistence unavailable");
            },
            // Criteria allocation refreshes again when the target is absent.
            ...(persistentFailure
              ? {
                  foldObservationIntoPooledEntry: async () => {
                    throw new Error("tracking persistence unavailable");
                  },
                }
              : {}),
          }),
      }),
    );
    return { pool, timer };
  }

  test.each(["single", "multiple", "criteria"] as const)(
    "%s allocation retains the refresh reason when no matching device was added",
    async (kind) => {
      const { pool, timer } = failedRefreshPool();
      const allocation =
        kind === "single"
          ? pool.assignDeviceToSession("allocation-session", "ios")
          : kind === "multiple"
            ? pool.assignMultipleDevices(["allocation-session"], 1_000, "ios")
            : pool.assignMultipleDevicesByCriteria(
                [{ sessionId: "allocation-session", criteria: { platform: "ios" } }],
                1_000,
              );
      await expect(allocation).rejects.toThrow("tracking persistence unavailable");
      expect(pool.getDevice(device.deviceId)).toBeDefined();
      expect(sessions.getSession("allocation-session")).toBeNull();
      if (kind === "single") {
        expect(timer.getSleepCallCount()).toBeGreaterThan(0);
      }
    },
  );

  test("a successful later refresh clears the earlier criteria allocation failure reason", async () => {
    const { pool } = failedRefreshPool(false);
    await expect(
      pool.assignMultipleDevicesByCriteria(
        [{ sessionId: "allocation-session", criteria: { platform: "ios" } }],
        1_000,
      ),
    ).rejects.toMatchObject({
      message:
        "No devices match criteria for session allocation-session (platform=ios).\n" +
        "Ensure the required devices are installed, startable, and available.",
    });
  });

  test.each(["single", "multiple", "criteria"] as const)(
    "%s allocation can use the device added before the refresh failed",
    async (kind) => {
      const { pool, timer } = failedRefreshPool();
      const allocated =
        kind === "single"
          ? await pool.assignDeviceToSession("allocation-session", "android")
          : kind === "multiple"
            ? (await pool.assignMultipleDevices(["allocation-session"], 1_000, "android")).get(
                "allocation-session",
              )
            : (
                await pool.assignMultipleDevicesByCriteria(
                  [{ sessionId: "allocation-session", criteria: { platform: "android" } }],
                  1_000,
                )
              ).get("allocation-session");
      expect(allocated).toBe(device.deviceId);
      expect(sessions.getSession("allocation-session")?.assignedDevice).toBe(device.deviceId);
      expect(timer.getSleepCallCount()).toBe(0);
    },
  );
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
