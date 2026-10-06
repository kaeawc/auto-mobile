import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent, settleWithFakeTime } from "../helpers/fakeTimerStepping";

for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} multi-device allocation with session-held devices`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let pool: DevicePool;
    let manager: FakeDeviceManager;
    beforeEach(async () => {
      timer = new FakeTimer();
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      manager = new FakeDeviceManager();
      const devices = ["d1", "d2"].map((deviceId) => ({
        deviceId,
        name: deviceId,
        platform: "android" as const,
      }));
      manager.bootedDevices = devices;
      pool = new DevicePool(
        createDevicePoolDependencies(sessions, "session-held-test", {
          timer,
          deviceManager: manager,
          retryExecutor: new DefaultRetryExecutor(timer),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        }),
      );
      await pool.initializeWithDevices(devices);
      // Each session came from getAndroid and already holds one device.
      await pool.bindOrReuseDeviceSession("s1", "d1", "android");
      await pool.bindOrReuseDeviceSession("s2", "d2", "android");
    });
    afterEach(() => {
      sessions.stopCleanupTimer();
      timer.reset();
    });

    const allocate = (ids: string[], timeout: number) =>
      criteria
        ? pool.assignMultipleDevicesByCriteria(
            ids.map((sessionId) => ({ sessionId, criteria: { platform: "android" } })),
            timeout,
          )
        : pool.assignMultipleDevices(ids, timeout, "android");
    const observe = (ids: string[], timeout = 90_000) => {
      let settled = false;
      const result = allocate(ids, timeout).then(
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

    const release = async (id: string) => {
      const deviceId = sessions.getSession(id)?.assignedDevice;
      if (!deviceId) {
        throw new Error(`Missing session ${id}`);
      }
      await sessions.releaseSession(id);
      await pool.releaseDevice(deviceId, id);
    };
    const settle = (result: Promise<unknown>) =>
      settleWithFakeTime(timer, result, {
        stepMs: 1_000,
        maxSteps: 20,
        description: "allocation outcome",
      });

    test("two plans from two sessions that each hold a device run one after the other", async () => {
      const first = observe(["s1", "s1:B"]);
      const second = observe(["s2", "s2:B"]);
      await drainUntilQuiescent(timer);

      // Well under the 90 s allocation timeout: the first plan has its devices.
      const firstOutcome = await settle(first.result);
      expect(firstOutcome).toBeInstanceOf(Map);
      expect([...(firstOutcome as Map<string, string>)]).toEqual([
        ["s1", "d1"],
        ["s1:B", "d2"],
      ]);
      expect(sessions.getSession("s1")?.assignedDevice).toBe("d1");
      expect(pool.getDevice("d1")?.sessionId).toBe("s1");
      expect(pool.getDevice("d2")?.sessionId).toBe("s1:B");
      expect(second.isSettled()).toBe(false);

      // The executePlan epilogue frees the first plan's sessions and devices.
      await release("s1:B");
      await release("s1");
      const secondOutcome = await settle(second.result);
      expect(secondOutcome).toBeInstanceOf(Map);
      expect([...(secondOutcome as Map<string, string>)].map(([id]) => id)).toEqual(["s2", "s2:B"]);
      expect(sessions.getSession("s2")?.assignedDevice).toBe("d2");
      expect(pool.getDevice("d2")?.sessionId).toBe("s2");
      expect(pool.getDevice("d1")?.sessionId).toBe("s2:B");
    });

    test("a lone plan keeps its session's device while it waits for another", async () => {
      await release("s2");
      await pool.bindOrReuseDeviceSession("owner", "d2", "android");
      const plan = observe(["s1", "s1:B"]);
      await drainUntilQuiescent(timer);
      await settleWithFakeTime(timer, Promise.resolve(), { stepMs: 1_000, maxSteps: 3 });
      expect(plan.isSettled()).toBe(false);
      expect(pool.getDevice("d1")?.sessionId).toBe("s1");
      await release("owner");
      expect(await settle(plan.result)).toBeInstanceOf(Map);
    });

    test("a queued plan that times out gets its session's device back and reports its attempts", async () => {
      const third = { deviceId: "d3", name: "d3", platform: "android" as const };
      manager.bootedDevices = [...manager.bootedDevices, third];
      await pool.addDevice(third);
      await pool.bindOrReuseDeviceSession("owner", "d3", "android");
      // The head needs three devices and can never get them while "owner" holds d3.
      const head = observe(["s1", "s1:B", "s1:C"]);
      await drainUntilQuiescent(timer);
      const follower = observe(["s2", "s2:B"], 3_000);
      await drainUntilQuiescent(timer);

      const error = await settle(follower.result);
      expect(String(error)).toContain("Timed out allocating devices");
      expect(String(error)).not.toContain("(0 attempts)");
      expect(pool.getDevice("d2")?.sessionId).toBe("s2");
      expect(head.isSettled()).toBe(false);
    });
  });
}
