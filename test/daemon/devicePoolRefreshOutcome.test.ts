import { makePool } from "../helpers/makePool";
import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePoolRefresh } from "../../src/daemon/devicePoolRefresh";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { AdbUnavailableError } from "../../src/utils/android-cmdline-tools/AdbClient";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { logger } from "../../src/utils/logger";

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

  function failedRefreshPool(
    persistentFailure = true,
    failure = "tracking persistence unavailable",
    busy = false,
  ) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", [device]);
    let trackingAttempts = 0;
    let clearPool = () => {};
    const pool = makePool(sessions, "allocation-refresh-failure", {
      timer,
      deviceManager,
      devicePoolRefreshFactory: (port) => {
        clearPool = () => void pool.removeDevice(device.deviceId);
        return new DevicePoolRefresh({
          ...port,
          setDeviceSessionTracking: async () => {
            if (busy) {
              patchDeviceBinding(port.getDevices().get(device.deviceId)!, { status: "busy" });
            }
            if (persistentFailure || trackingAttempts++ === 0) {
              throw new Error(failure);
            }
          },
          // Criteria allocation refreshes again when the target is absent.
          ...(persistentFailure
            ? {
                foldObservationIntoPooledEntry: async () => {
                  throw new Error(failure);
                },
              }
            : {}),
        });
      },
    });
    return { pool, timer, deviceManager, clearPool: () => clearPool() };
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

  test.each(["single", "multiple"] as const)(
    // Restores main's immediate failure; fails against the PR's original HEAD.
    "%s allocation fails immediately when iOS liveness is unknown and refresh throws",
    async (kind) => {
      const { pool, timer, deviceManager } = failedRefreshPool();
      const simulator: BootedDevice = {
        deviceId: "SIM-UNKNOWN",
        name: "Unknown simulator",
        platform: "ios",
      };
      await pool.initializeWithDevices([simulator]);
      deviceManager.failedPlatforms.add("ios");
      const allocation =
        kind === "single"
          ? pool.assignDeviceToSession("allocation-session", "ios")
          : pool.assignMultipleDevices(["allocation-session"], 60_000, "ios");
      await expect(allocation).rejects.toMatchObject({
        message:
          "Unable to verify iOS simulator liveness for session allocation-session; iOS discovery failed.",
      });
      expect(timer.getSleepHistory()).toEqual([]);
      expect(sessions.getSession("allocation-session")).toBeNull();
      expect(pool.getDevice(simulator.deviceId)?.status).toBe("idle");
    },
  );

  test.each(["single", "multiple", "criteria"] as const)(
    "%s allocation retains the actual refresh failure through busy attempts without refresh",
    async (kind) => {
      const { pool, timer, deviceManager } = failedRefreshPool(
        true,
        "tracking persistence unavailable",
        true,
      );
      const discovery = spyOn(deviceManager, "getBootedDevicesDetailed");
      const waits = spyOn(timer, "setTimeout");
      try {
        const allocation =
          kind === "single"
            ? pool.assignDeviceToSession("allocation-session", "android")
            : kind === "multiple"
              ? pool.assignMultipleDevices(["allocation-session"], 3_000, "android")
              : pool.assignMultipleDevicesByCriteria(
                  [{ sessionId: "allocation-session", criteria: { platform: "android" } }],
                  3_000,
                );
        await expect(allocation).rejects.toThrow("tracking persistence unavailable");
        expect(
          kind === "single" ? timer.getSleepCallCount() : waits.mock.calls.length,
        ).toBeGreaterThan(1);
        // Exactly one real refresh; every subsequent attempt only sees a busy candidate.
        expect(discovery.mock.calls.filter(([platform]) => platform === "either")).toHaveLength(1);
      } finally {
        waits.mockRestore();
        discovery.mockRestore();
      }
    },
  );

  test.each(["single", "multiple", "criteria"] as const)(
    "pin: %s allocation clears the retained reason when a later allocation refresh succeeds",
    async (kind) => {
      // Passes on main too; guards clearing without mistaking a busy-only attempt for refresh.
      const { pool, timer, clearPool, deviceManager } = failedRefreshPool(
        false,
        "tracking persistence unavailable",
        true,
      );
      const discovery = spyOn(deviceManager, "getBootedDevicesDetailed");
      const sleep = timer.sleep.bind(timer);
      const timeout = timer.setTimeout.bind(timer);
      let waits = 0;
      const beforeWait = () => {
        if (waits++ === 0) {
          clearPool();
        }
      };
      const sleepSpy = spyOn(timer, "sleep").mockImplementation(async (ms) => {
        beforeWait();
        await sleep(ms);
      });
      const timeoutSpy = spyOn(timer, "setTimeout").mockImplementation((callback, ms) => {
        beforeWait();
        return timeout(callback, ms);
      });
      try {
        const allocation =
          kind === "single"
            ? pool.assignDeviceToSession("allocation-session", "android")
            : kind === "multiple"
              ? pool.assignMultipleDevices(["allocation-session"], 3_000, "android")
              : pool.assignMultipleDevicesByCriteria(
                  [{ sessionId: "allocation-session", criteria: { platform: "android" } }],
                  3_000,
                );
        await expect(allocation).rejects.toThrow("Timed out");
        await expect(allocation).rejects.not.toThrow("Could not refresh device list");
        expect(waits).toBeGreaterThan(1);
        expect(discovery.mock.calls.filter(([platform]) => platform === "either")).toHaveLength(2);
      } finally {
        sleepSpy.mockRestore();
        timeoutSpy.mockRestore();
        discovery.mockRestore();
      }
    },
  );

  test.each(["single", "multiple", "criteria"] as const)(
    "%s allocation caps a multi-line refresh failure at its first line",
    async (kind) => {
      const firstLine = "x".repeat(300);
      const { pool } = failedRefreshPool(true, `${firstLine}\r\nsecond line must stay in logs`);
      const allocation =
        kind === "single"
          ? pool.assignDeviceToSession("allocation-session", "ios")
          : kind === "multiple"
            ? pool.assignMultipleDevices(["allocation-session"], 1_000, "ios")
            : pool.assignMultipleDevicesByCriteria(
                [{ sessionId: "allocation-session", criteria: { platform: "ios" } }],
                1_000,
              );
      await expect(allocation).rejects.toThrow(
        `Could not refresh device list: ${"x".repeat(256)}.\n`,
      );
      await expect(allocation).rejects.not.toThrow("x".repeat(257));
      await expect(allocation).rejects.not.toThrow("second line must stay in logs");
    },
  );

  // Passes on main too; guards clearing after a successful preallocation refresh.
  test("pin: a successful later refresh clears the earlier criteria allocation failure reason", async () => {
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
    // Passes on main too; guards use of partially discovered allocation candidates.
    "pin: %s allocation can use the device added before the refresh failed",
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
      const pool = makePool(sessions, "refresh-success", {
        timer,
        deviceManager,
        devicePoolRefreshFactory: (port) =>
          new DevicePoolRefresh({ ...port, setDeviceSessionTracking: async () => {} }),
      });
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
    const pool = makePool(sessions, "refresh-outcome", {
      timer,
      deviceManager,
      devicePoolRefreshFactory: (port) =>
        new DevicePoolRefresh({
          ...port,
          setDeviceSessionTracking: async () => {
            throw new Error("tracking persistence unavailable");
          },
        }),
    });
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

describe("Android discovery failure refresh outcome", () => {
  function setup(failure?: string | Error, simctlFailure?: string) {
    const timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const iosDevice: BootedDevice = { deviceId: "SIM-FRESH", name: "iPhone", platform: "ios" };
    const iosDiscovery = async () => {
      if (simctlFailure) {
        throw new Error(simctlFailure);
      }
      return [iosDevice];
    };
    const deviceManager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      fakeDeviceManagerSimctl({
        isAvailable: async () => true,
        getBootedSimulatorsChecked: iosDiscovery,
      }),
      createFakeAndroidEmulator({
        getBootedDevicesChecked: async () => {
          if (failure) {
            throw failure instanceof Error ? failure : new Error(failure);
          }
          return [];
        },
      }),
      undefined,
      undefined,
      { listConnectedDevices: async () => ({ devices: [], complete: true }) },
    );
    const pool = makePool(sessions, "android-discovery-failure", {
      timer,
      deviceManager,
    });
    DaemonState.getInstance().initialize(sessions, pool);
    return { pool, iosDevice };
  }

  test("setActiveDevice surfaces the caught adb reason through the refresh outcome", async () => {
    setup(`${"x".repeat(300)}\r\nsecond line must stay in logs`);
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    });
    await expect(
      handler({ deviceId: "emulator-5604", sessionUuid: "selection" }),
    ).rejects.toMatchObject({
      message: `Could not refresh device list: ${("Android booted-device discovery failed: " + "x".repeat(300)).slice(0, 256)}. Resolve the cause and retry.`,
    });
  });

  test("a host with no adb binary answers an absent iOS device as not found, never retryable (#11605)", async () => {
    const { pool } = setup(
      new AdbUnavailableError("ADB executable is unavailable: spawn adb ENOENT"),
    );
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    });
    const refusal = await handler({
      deviceId: "99999999-2222-3333-4444-555555555555",
      sessionUuid: "selection",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      message: "Device '99999999-2222-3333-4444-555555555555' not found in device pool",
    });
    const refusalFields = typeof refusal === "object" && refusal !== null ? refusal : {};
    expect({
      code: "code" in refusalFields ? refusalFields.code : undefined,
      retryable: "retryable" in refusalFields ? refusalFields.retryable : undefined,
    }).toEqual({
      code: undefined,
      retryable: undefined,
    });
    expect((await pool.refreshDevicesWithOutcome()).failure).toBeUndefined();
  });

  // #11586: the answer is typed by the platform whose discovery failed and could have listed the id.
  const SIMULATOR_UDID = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";
  const select = (deviceId: string, platform?: "android" | "ios") =>
    createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    })({
      deviceId,
      sessionUuid: "selection",
      ...(platform ? { platform } : {}),
    }).then(
      () => undefined,
      (error: unknown) =>
        error as Error & { code?: string; platform?: string; retryable?: boolean },
    );

  test("a missing iOS UDID while only adb failed is not found, not Android discovery", async () => {
    setup("adb devices -l exited 1");

    const error = await select(SIMULATOR_UDID);

    expect(error?.message).toBe(`Device '${SIMULATOR_UDID}' not found in device pool`);
    expect(error?.code).toBeUndefined();
  });

  test("a missing iOS UDID while simctl failed is iOS-typed retryable discovery_incomplete", async () => {
    setup(undefined, "simctl list exited 72");

    const error = await select(SIMULATOR_UDID);

    expect(error).toMatchObject({ code: "discovery_incomplete", platform: "ios", retryable: true });
    expect(error?.message).toContain("simctl list exited 72");
  });

  test("a missing emulator serial while only simctl failed is not found", async () => {
    setup(undefined, "simctl list exited 72");

    const error = await select("emulator-5604");

    expect(error?.message).toBe("Device 'emulator-5604' not found in device pool");
  });

  test.each([
    { adb: "adb devices -l exited 1", simctl: undefined, platform: "android" },
    { adb: undefined, simctl: "simctl list exited 72", platform: "ios" },
    { adb: "adb devices -l exited 1", simctl: "simctl list exited 72", platform: "android" },
  ])("an id of unknown shape is typed by whichever discovery failed: %j", async (row) => {
    setup(row.adb, row.simctl);

    const error = await select("R58M123ABCD");

    expect(error).toMatchObject({ code: "discovery_incomplete", platform: row.platform });
  });

  test("the requested platform decides over the id's shape", async () => {
    setup("adb devices -l exited 1", "simctl list exited 72");

    expect(await select("R58M123ABCD", "ios")).toMatchObject({ platform: "ios" });
    expect(await select("R58M123ABCD", "android")).toMatchObject({ platform: "android" });
  });

  test("working adb with an absent device preserves the exact selection error", async () => {
    setup();
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer: new FakeTimer(),
        probe: async () => new Map(),
        invalidateDeviceList: () => {},
      },
    });
    await expect(
      handler({ deviceId: "emulator-5604", sessionUuid: "selection" }),
    ).rejects.toMatchObject({
      message: "Device 'emulator-5604' not found in device pool",
    });
  });

  test.each(["idle", "busy"] as const)(
    "failed Android discovery retains %s pooled devices while iOS refresh still adds devices",
    async (status) => {
      const { pool, iosDevice } = setup("adb devices -l exited 1");
      const warn = spyOn(logger, "warn");
      try {
        await pool.initializeWithDevices([
          { deviceId: "emulator-5600", name: "Pixel", platform: "android" },
        ]);
        const pooled = pool.getDevice("emulator-5600")!;
        patchDeviceBinding(pooled, { status });
        if (status === "busy") {
          patchDeviceBinding(pooled, { sessionId: "held-session" });
          await sessions.createSession("held-session", pooled.id, "android");
        }
        for (let refresh = 0; refresh < 4; refresh++) {
          const outcome = await pool.refreshDevicesWithOutcome();
          expect(outcome.failure).toBe(
            "Android booted-device discovery failed: adb devices -l exited 1",
          );
          expect(outcome.completeness?.succeededPlatforms.has("android")).toBe(false);
          expect(outcome.completeness?.succeededPlatforms.has("ios")).toBe(true);
          expect(pool.getDevice("emulator-5600")).toBe(pooled);
          expect(pooled.status).toBe(status);
          if (status === "busy") {
            expect(sessions.getSession("held-session")?.assignedDevice).toBe(pooled.id);
          }
          expect(pool.getDevice(iosDevice.deviceId)?.status).toBe("idle");
        }
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "Android booted-device discovery failed; retaining tracked Android devices",
          ),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );
});
