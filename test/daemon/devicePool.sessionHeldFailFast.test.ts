import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent, settleWithFakeTime } from "../helpers/fakeTimerStepping";

// #9950: a multi-device request that only a device held by another live session
// could satisfy fails promptly instead of waiting out its allocation timeout.
for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} multi-device allocation blocked by session holds`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let pool: DevicePool;
    beforeEach(async () => {
      timer = new FakeTimer();
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const devices = ["d1", "d2", "d3"].map((deviceId) => ({
        deviceId,
        name: deviceId,
        platform: "android" as const,
      }));
      const manager = new FakeDeviceManager();
      manager.bootedDevices = devices;
      pool = new DevicePool(
        createDevicePoolDependencies(sessions, "session-held-fail-fast", {
          timer,
          deviceManager: manager,
          retryExecutor: new DefaultRetryExecutor(timer),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        }),
      );
      await pool.initializeWithDevices(devices);
    });
    afterEach(() => {
      sessions.stopCleanupTimer();
      timer.reset();
    });

    const observe = (ids: string[], timeout = 90_000) => {
      let settled = false;
      const request = criteria
        ? pool.assignMultipleDevicesByCriteria(
            ids.map((sessionId) => ({ sessionId, criteria: { platform: "android" as const } })),
            timeout,
          )
        : pool.assignMultipleDevices(ids, timeout, "android");
      const result = request.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      return { result, isSettled: () => settled };
    };
    const settle = (result: Promise<unknown>) =>
      settleWithFakeTime(timer, result, {
        stepMs: 1_000,
        maxSteps: 20,
        description: "allocation outcome",
      });
    const freeDevice = async (sessionId: string) => {
      const deviceId = sessions.getSession(sessionId)?.assignedDevice;
      if (!deviceId) {
        throw new Error(`Missing session ${sessionId}`);
      }
      await sessions.releaseSession(sessionId);
      await pool.releaseDevice(deviceId, sessionId);
    };
    // A running two-device plan: its sessions were created by a multi-device
    // allocation and free their devices when the plan ends.
    const startRunningPlan = () =>
      pool.assignMultipleDevices(["owner", "owner:B"], 5_000, "android");

    test("two sessions that each hold a device and each plan for two both fail fast", async () => {
      // Two devices only: the issue's pool of two emulators.
      await pool.removeDevice("d3");
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("s2", "d2", "android");

      const first = observe(["s1", "s1:B"]);
      const second = observe(["s2", "s2:B"]);
      // No fake time advances: the first allocation round decides.
      await drainUntilQuiescent(timer);

      expect(first.isSettled()).toBe(true);
      expect(second.isSettled()).toBe(true);
      const firstError = await first.result;
      const secondError = await second.result;
      expect(firstError).toBeInstanceOf(ActionableError);
      expect(String(firstError)).toContain("Cannot allocate 2 devices: 1 available");
      expect(String(firstError)).toContain("s2 (holding d2)");
      expect(String(firstError)).toContain("Release that session, or use a device label it owns");
      expect(String(secondError)).toContain("s1 (holding d1)");
      // Holds stay exclusive and untouched.
      expect(pool.getDevice("d1")?.sessionId).toBe("s1");
      expect(pool.getDevice("d2")?.sessionId).toBe("s2");
    });

    test("a request whose remaining devices are all held counts how many it needs", async () => {
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("s2", "d2", "android");
      await pool.bindOrReuseDeviceSession("s3", "d3", "android");

      const plan = observe(["s1", "s1:B", "s1:C"]);
      await drainUntilQuiescent(timer);

      expect(plan.isSettled()).toBe(true);
      const message = String(await plan.result);
      expect(message).toContain("Cannot allocate 3 devices: 1 available");
      expect(message).toContain("s2 (holding d2)");
      expect(message).toContain("s3 (holding d3)");
    });

    test("a device busy under a running plan's sessions is still waited for and then picked up", async () => {
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await startRunningPlan();
      const plan = observe(["s1", "s1:B"]);
      await drainUntilQuiescent(timer);
      await settleWithFakeTime(timer, Promise.resolve(), { stepMs: 1_000, maxSteps: 3 });
      expect(plan.isSettled()).toBe(false);

      const freed = sessions.getSession("owner:B")!.assignedDevice;
      await freeDevice("owner:B");
      const outcome = await settle(plan.result);
      expect(outcome).toBeInstanceOf(Map);
      expect([...(outcome as Map<string, string>)]).toEqual([
        ["s1", "d1"],
        ["s1:B", freed],
      ]);
    });

    test("a live session's hold does not fail a request that a temporarily busy device can still satisfy", async () => {
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("s2", "d2", "android");
      await pool.assignMultipleDevices(["owner"], 5_000, "android");
      const plan = observe(["s1", "s1:B"]);
      await drainUntilQuiescent(timer);
      expect(plan.isSettled()).toBe(false);

      await freeDevice("owner");
      const outcome = await settle(plan.result);
      expect([...(outcome as Map<string, string>)]).toEqual([
        ["s1", "d1"],
        ["s1:B", "d3"],
      ]);
      expect(pool.getDevice("d2")?.sessionId).toBe("s2");
    });

    test("a single session's plan with free devices is unchanged", async () => {
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");

      const plan = observe(["s1", "s1:B"]);
      const outcome = await settle(plan.result);

      expect(outcome).toBeInstanceOf(Map);
      expect([...(outcome as Map<string, string>)]).toEqual([
        ["s1", "d1"],
        ["s1:B", expect.stringMatching(/^d[23]$/)],
      ]);
    });

    test("a request waiting only on a running plan's devices still times out", async () => {
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await startRunningPlan();
      const plan = observe(["s1", "s1:B"], 3_000);

      const error = await settle(plan.result);

      expect(String(error)).toContain("Timed out allocating devices");
    });
  });
}
