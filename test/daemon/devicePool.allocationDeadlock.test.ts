import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent, settleWithFakeTime } from "../helpers/fakeTimerStepping";

// #9950: two sessions that each hold one device and each run a two-device
// plan wait on each other's held device. The later request fails fast with a
// named deadlock instead of both waiting out the allocation timeout.
for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} allocation deadlock between sessions`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let pool: DevicePool;
    let manager: FakeDeviceManager;

    const setUp = async (deviceIds: string[], iosIds: string[] = []) => {
      const devices = deviceIds.map((deviceId) => ({
        deviceId,
        name: deviceId,
        platform: iosIds.includes(deviceId) ? ("ios" as const) : ("android" as const),
      }));
      manager.bootedDevices = devices;
      pool = new DevicePool(
        createDevicePoolDependencies(sessions, "allocation-deadlock-test", {
          timer,
          deviceManager: manager,
          retryExecutor: new DefaultRetryExecutor(timer),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        }),
      );
      await pool.initializeWithDevices(devices);
    };

    beforeEach(() => {
      timer = new FakeTimer();
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      manager = new FakeDeviceManager();
    });
    afterEach(() => {
      sessions.stopCleanupTimer();
      timer.reset();
    });

    const observe = (ids: string[], timeout = 4_000) => {
      let settled = false;
      const allocation = () =>
        criteria
          ? pool.assignMultipleDevicesByCriteria(
              ids.map((sessionId) => ({ sessionId, criteria: { platform: "android" } })),
              timeout,
            )
          : pool.assignMultipleDevices(ids, timeout, "android");
      const result = runWithAbortSignal(new AbortController().signal, allocation).then(
        (value: unknown) => {
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
        maxSteps: 8,
        description: "allocation outcome",
      });

    const release = async (sessionId: string, deviceId: string) => {
      await sessions.releaseSession(sessionId);
      await pool.releaseDevice(deviceId, sessionId);
    };

    test("issue repro: the later of two cross-held two-device plans fails fast naming the devices", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("s2", "d2", "android");

      const first = observe(["s1", "s1:B"]);
      await drainUntilQuiescent(timer);
      const second = observe(["s2", "s2:B"]);
      await drainUntilQuiescent(timer);

      expect(second.isSettled()).toBe(true);
      const outcome = String(await second.result);
      expect(outcome).toContain("deadlocked with another waiting multi-device request");
      expect(outcome).toContain("This request's sessions hold 'd2' (session 's2')");
      expect(outcome).toContain(
        "Session 's2:B' (platform=android) can only use 'd1' (session 's1')",
      );
      expect(outcome).not.toContain("Timed out");
      expect(timer.now()).toBe(0);
      // The failed request keeps its held device and drops its new session.
      expect(pool.getDevice("d2")?.sessionId).toBe("s2");
      expect(sessions.getSession("s2:B")).toBeNull();
      // The earlier request keeps waiting, then runs once the other session is released.
      expect(first.isSettled()).toBe(false);
      await release("s2", "d2");
      const allocated = (await settle(first.result)) as Map<string, string>;
      expect([...allocated]).toEqual([
        ["s1", "d1"],
        ["s1:B", "d2"],
      ]);
    });

    test("a plan waiting on a device held by a session with no waiting request keeps waiting", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("other-client", "d2", "android");

      const plan = observe(["s1", "s1:B"], 8_000);
      await drainUntilQuiescent(timer);
      timer.advanceTime(3_000);
      await drainUntilQuiescent(timer);

      expect(plan.isSettled()).toBe(false);
      await release("other-client", "d2");
      const allocated = (await settle(plan.result)) as Map<string, string>;
      expect(allocated.get("s1:B")).toBe("d2");
    });

    test("a would-be cycle with a releasable device is not reported as a deadlock", async () => {
      await setUp(["d1", "d2", "d3"]);
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("s2", "d2", "android");
      await pool.bindOrReuseDeviceSession("other-client", "d3", "android");

      const first = observe(["s1", "s1:B"], 8_000);
      await drainUntilQuiescent(timer);
      const second = observe(["s2", "s2:B"], 8_000);
      await drainUntilQuiescent(timer);

      expect(first.isSettled()).toBe(false);
      expect(second.isSettled()).toBe(false);
      await release("other-client", "d3");
      const allocated = (await settle(first.result)) as Map<string, string>;
      expect(allocated.get("s1:B")).toBe("d3");
      // The first plan now runs; its sessions hold devices but wait on nothing.
      await drainUntilQuiescent(timer);
      expect(second.isSettled()).toBe(false);
      await release("s1", "d1");
      const secondAllocated = (await settle(second.result)) as Map<string, string>;
      expect(secondAllocated.get("s2:B")).toBe("d1");
    });
  });
}
