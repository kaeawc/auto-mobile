import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { PLAN_AUTO_RELEASE_REASON } from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import {
  buildDeviceLabelMap,
  getDeviceLabelMap,
  registerDeviceLabelMap,
  releaseDeviceLabelSessions,
} from "../../src/server/deviceLabelMapping";

/**
 * Behavioral coverage for the device-label map's read/write path through the REAL
 * SessionManager typed `deviceLabels` slot (issue #2973). The socketServer routing
 * tests inject a fake `getDeviceLabels`, so they prove socketServer *calls* the
 * helper but never exercise the real typed-slot read — this suite closes that gap.
 */
describe("deviceLabelMapping ↔ SessionManager.deviceLabels slot (issue #2973)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  let sessionManager: SessionManager;

  beforeEach(async () => {
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(sessionManager, pool);
  });

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("getDeviceLabelMap round-trips a map written via the typed setDeviceLabels slot", async () => {
    await sessionManager.createSession("base", "emulator-5554", "android");
    const map = buildDeviceLabelMap(["A", "B"], "base");
    sessionManager.setDeviceLabels("base", map);

    // getDeviceLabelMap reads through the real getDeviceLabels delegation, not a fake.
    expect(getDeviceLabelMap("base")).toEqual(map);
    expect(getDeviceLabelMap("base")).toEqual({ A: "base", B: "base:B" });
  });

  test("getDeviceLabelMap returns null for a session with no registered labels", async () => {
    await sessionManager.createSession("base", "emulator-5554", "android");
    expect(getDeviceLabelMap("base")).toBeNull();
  });

  test("getDeviceLabelMap returns null for an unknown session", () => {
    expect(getDeviceLabelMap("nope")).toBeNull();
  });

  test("getDeviceLabelMap returns null when the daemon is not initialized", () => {
    DaemonState.getInstance().reset();
    expect(getDeviceLabelMap("base")).toBeNull();
  });

  test.each(["removed", "present", "pool-failure"])(
    "label release logs a failed session and still releases the rest (session %s, #11091)",
    async (scenario) => {
      await sessionManager.createSession("base", androidA.deviceId, "android");
      await sessionManager.createSession("base:B", "device-B", "android");
      await sessionManager.createSession("base:C", "device-C", "android");
      sessionManager.setDeviceLabels("base", buildDeviceLabelMap(["A", "B", "C"], "base"));
      const pool = DaemonState.getInstance().getDevicePool();
      const failure = new Error("B release failed");
      const poolFailure = new Error("B pool release failed");
      const originalRelease = sessionManager.releaseSession.bind(sessionManager);
      const release = spyOn(sessionManager, "releaseSession").mockImplementation(
        async (id, reason) => {
          if (id === "base:B") {
            if (scenario !== "present") {
              await originalRelease(id, reason);
            }
            throw failure;
          }
          return originalRelease(id, reason);
        },
      );
      const poolRelease = spyOn(pool, "releaseDevice").mockImplementation(async (_device, id) => {
        if (id === "base:B" && scenario === "pool-failure") {
          throw poolFailure;
        }
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const info = spyOn(logger, "info").mockImplementation(() => {});
      try {
        // A session removed before the rejection is gone, so it counts as released.
        await expect(releaseDeviceLabelSessions("base")).resolves.toEqual(
          scenario === "present" ? ["base:C"] : ["base:B", "base:C"],
        );
        expect(release.mock.calls).toEqual([
          ["base:B", PLAN_AUTO_RELEASE_REASON],
          ["base:C", PLAN_AUTO_RELEASE_REASON],
        ]);
        expect(poolRelease.mock.calls).toEqual(
          scenario === "present"
            ? [["device-C", "base:C"]]
            : [
                ["device-B", "base:B"],
                ["device-C", "base:C"],
              ],
        );
        expect(sessionManager.hasSession("base:B")).toBe(scenario === "present");
        expect(sessionManager.hasSession("base:C")).toBe(false);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Failed to release label session base:B"),
          failure,
        );
        if (scenario === "pool-failure") {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("base:B"), poolFailure);
        }
      } finally {
        release.mockRestore();
        poolRelease.mockRestore();
        warn.mockRestore();
        info.mockRestore();
      }
    },
  );

  test("registerDeviceLabelMap keeps the real single-label base setup and publication", async () => {
    await sessionManager.createSession("base", androidA.deviceId, "android");
    // Already-ready fake device: the real context path needs no CtrlProxy/ADB I/O.
    sessionManager.setDeviceReadiness("base", "automationReady");
    const originalSetup = sessionManager.trackSessionSetup.bind(sessionManager);
    const setup = spyOn(sessionManager, "trackSessionSetup").mockImplementation((session, work) => {
      expect(getDeviceLabelMap("base")).toEqual({ A: "base" });
      return originalSetup(session, work);
    });
    try {
      expect(
        await registerDeviceLabelMap("base", ["A"], undefined, { keepScreenAwake: false }),
      ).toEqual({ A: "base" });
      expect(getDeviceLabelMap("base")).toEqual({ A: "base" });
      expect(setup).toHaveBeenCalledTimes(1);
      expect(setup.mock.calls[0][0].sessionId).toBe("base");
      expect(sessionManager.getDeviceReadiness("base")).toBe("automationReady");
    } finally {
      setup.mockRestore();
    }
  });

  test("failed label setup leaves published ownership intact without releasing sessions or devices", async () => {
    await sessionManager.createSession("base", androidA.deviceId, "android");
    sessionManager.setDeviceReadiness("base", "automationReady");
    const pool = DaemonState.getInstance().getDevicePool();
    for (const [label, deviceId] of [
      ["B", "emulator-5556"],
      ["C", "emulator-5558"],
      ["D", "emulator-5560"],
    ]) {
      await pool.addDevice({ ...androidA, name: `Pixel ${label}`, deviceId });
      await sessionManager.createSession(`base:${label}`, deviceId, "android");
      sessionManager.setDeviceReadiness(`base:${label}`, "automationReady");
    }
    const failure = new Error("B readiness failed");
    const originalSetup = sessionManager.trackSessionSetup.bind(sessionManager);
    const setup = spyOn(sessionManager, "trackSessionSetup").mockImplementation((session, work) => {
      if (session.sessionId === "base:B") {
        return Promise.reject(failure);
      }
      return originalSetup(session, work);
    });
    const releaseSession = spyOn(sessionManager, "releaseSession");
    const releaseDevice = spyOn(pool, "releaseDevice");
    try {
      const error = await registerDeviceLabelMap("base", ["A", "B", "C", "D"], undefined, {
        keepScreenAwake: false,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBe(failure);
      expect(setup.mock.calls.map(([session]) => session.sessionId)).toEqual([
        "base",
        "base:B",
        "base:C",
        "base:D",
      ]);
      expect(getDeviceLabelMap("base")).toEqual({
        A: "base",
        B: "base:B",
        C: "base:C",
        D: "base:D",
      });
      for (const label of ["B", "C", "D"]) {
        expect(sessionManager.getSession(`base:${label}`)).not.toBeNull();
      }
      expect(releaseSession).not.toHaveBeenCalled();
      expect(releaseDevice).not.toHaveBeenCalled();
    } finally {
      setup.mockRestore();
      releaseSession.mockRestore();
      releaseDevice.mockRestore();
    }
  });
});
