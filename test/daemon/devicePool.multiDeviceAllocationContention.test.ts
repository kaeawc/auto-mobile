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

for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} multi-device contention`, () => {
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
        createDevicePoolDependencies(sessions, "contention-test", {
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

    const allocate = (ids: string[], timeout = 4_000, byCriteria = criteria) =>
      byCriteria
        ? pool.assignMultipleDevicesByCriteria(
            ids.map((sessionId) => ({
              sessionId,
              criteria: { platform: "android" },
            })),
            timeout,
          )
        : pool.assignMultipleDevices(ids, timeout, "android");
    const observe = (
      ids: string[],
      timeout = 4_000,
      controller = new AbortController(),
      byCriteria = criteria,
    ) => {
      let settled = false;
      const result = runWithAbortSignal(controller.signal, () =>
        allocate(ids, timeout, byCriteria),
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      return { result, controller, isSettled: () => settled };
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
        maxSteps: 8,
        description: "allocation outcome",
      });

    test("two concurrent pairs complete serially instead of holding one device each until timeout", async () => {
      const first = observe(["first:a", "first:b"]);
      const second = observe(["second:a", "second:b"]);
      await drainUntilQuiescent(timer);
      const owners = [pool.getDevice("d1")?.sessionId, pool.getDevice("d2")?.sessionId];
      if (!first.isSettled()) {
        // Capture the exact old-source interleaving and drive BOTH own timeouts.
        const outcomes = await settle(Promise.all([first.result, second.result]));
        console.info("Hold-and-wait reproduction:", owners, outcomes);
      }
      expect(first.isSettled()).toBe(true);
      expect(await first.result).toBeInstanceOf(Map);
      expect(second.isSettled()).toBe(false);
      await release("first:a");
      await release("first:b");
      expect(await settle(second.result)).toBeInstanceOf(Map);
    });

    test("uncontended allocation preserves sessions, devices and result order", async () => {
      expect([...(await allocate(["a", "b"]))]).toEqual([
        ["a", "d1"],
        ["b", "d2"],
      ]);
      expect(sessions.getSession("a")?.assignedDevice).toBe("d1");
      expect(sessions.getSession("b")?.assignedDevice).toBe("d2");
    });

    test("partial availability keeps the idle device free until the other is released", async () => {
      await pool.bindOrReuseDeviceSession("owner", "d2", "android");
      const waiter = observe(["a", "b"]);
      await drainUntilQuiescent(timer);
      const idle = pool.getDevice("d1")?.status;
      await release("owner");
      expect(await settle(waiter.result)).toBeInstanceOf(Map);
      expect(idle).toBe("idle");
    });

    test("aborted head releases no other owner's device and lets a follower acquire", async () => {
      await pool.bindOrReuseDeviceSession("owner", "d2", "android");
      const head = observe(["a", "b"]);
      await drainUntilQuiescent(timer);
      const follower = observe(["later"]);
      await drainUntilQuiescent(timer);
      const reason = new Error("cancel allocation");
      head.controller.abort(reason);
      // Cancellation must work without advancing fake time.
      await drainUntilQuiescent(timer);
      const cancelledImmediately = head.isSettled();
      expect(await settle(head.result)).toBe(reason);
      expect(await settle(follower.result)).toBeInstanceOf(Map);
      expect(pool.getDevice("d2")?.sessionId).toBe("owner");
      expect(cancelledImmediately).toBe(true);
    });

    test("aborted queued waiter is removed without blocking the next request", async () => {
      await pool.bindOrReuseDeviceSession("owner", "d2", "android");
      const head = observe(["a", "b"]);
      await drainUntilQuiescent(timer);
      const cancelled = observe(["cancelled"]);
      const follower = observe(["later"]);
      await drainUntilQuiescent(timer);
      const reason = new Error("cancel queued request");
      cancelled.controller.abort(reason);
      await settle(cancelled.result);
      await release("owner");
      expect(await settle(head.result)).toBeInstanceOf(Map);
      await release("a");
      await release("b");
      expect(await settle(follower.result)).toBeInstanceOf(Map);
      expect(await cancelled.result).toBe(reason);
    });

    test("earlier pair precedes a later singleton across both multi-device APIs", async () => {
      await pool.bindOrReuseDeviceSession("owner", "d2", "android");
      const head = observe(["a", "b"]);
      await drainUntilQuiescent(timer);
      const follower = observe(["later"], 8_000, new AbortController(), !criteria);
      await drainUntilQuiescent(timer);
      timer.advanceTime(1_000);
      await drainUntilQuiescent(timer);
      const followerWasWaiting = !follower.isSettled();
      await release("owner");
      expect(await settle(head.result)).toBeInstanceOf(Map);
      expect(followerWasWaiting).toBe(true);
      expect(follower.isSettled()).toBe(false);
      await release("a");
      await release("b");
      expect(await settle(follower.result)).toBeInstanceOf(Map);
    });

    test("FIFO prevents a smaller request taking newly freed capacity ahead of a blocked head", async () => {
      const third = { deviceId: "d3", name: "d3", platform: "android" as const };
      manager.bootedDevices.push(third);
      await pool.addDevice(third);
      await pool.bindOrReuseDeviceSession("owner:2", "d2", "android");
      await pool.bindOrReuseDeviceSession("owner:3", "d3", "android");
      const controller = new AbortController();
      const head = criteria
        ? runWithAbortSignal(controller.signal, () =>
            pool.assignMultipleDevicesByCriteria(
              [
                { sessionId: "a", criteria: { platform: "android", simulatorType: "d1" } },
                { sessionId: "b", criteria: { platform: "android", simulatorType: "d2" } },
              ],
              8_000,
            ),
          ).then(
            (value): unknown => value,
            (error: unknown) => error,
          )
        : observe(["a", "b", "c"], 8_000, controller).result;
      await drainUntilQuiescent(timer);
      const follower = observe(["later"], 10_000);
      await drainUntilQuiescent(timer);
      await release("owner:3");
      timer.advanceTime(1_000);
      await drainUntilQuiescent(timer);
      const didNotOvertake = !follower.isSettled();
      await release("owner:2");
      const outcome = await settle(head);
      if (outcome instanceof Map) {
        for (const id of outcome.keys()) {
          await release(id);
        }
      }
      expect(await settle(follower.result)).toBeInstanceOf(Map);
      expect(outcome).toBeInstanceOf(Map);
      expect(didNotOvertake).toBe(true);
    });

    test("preflight rejection leaves no queue entry", async () => {
      const impossible = criteria
        ? pool.assignMultipleDevicesByCriteria(
            [{ sessionId: "absent", criteria: { platform: "ios" } }],
            4_000,
          )
        : allocate(["too-many:a", "too-many:b", "too-many:c"]);
      await expect(impossible).rejects.toThrow(
        criteria ? "No devices match criteria" : "Not enough devices in pool",
      );
      expect([...(await allocate(["a", "b"]))]).toEqual([
        ["a", "d1"],
        ["b", "d2"],
      ]);
    });

    test("impossible pool-size request fails without waiting or blocking a follower", async () => {
      const impossible = observe(["too-many:a", "too-many:b", "too-many:c"]);
      const follower = observe(["a", "b"]);
      await drainUntilQuiescent(timer);
      const rejectedWithoutWaiting = impossible.isSettled();
      expect(String(await settle(impossible.result))).toContain("Not enough devices in pool");
      expect(await settle(follower.result)).toBeInstanceOf(Map);
      expect(rejectedWithoutWaiting).toBe(true);
    });

    test("a waiter's own timeout removes it from the queue", async () => {
      await allocate(["owner:a", "owner:b"]);
      const waiter = observe(["a", "b"], 2_000);
      const follower = observe(["later"], 8_000);
      expect(String(await settle(waiter.result))).toContain("Timed out allocating devices");
      expect(pool.getDevice("d1")?.sessionId).toBe("owner:a");
      await release("owner:a");
      await release("owner:b");
      expect(await settle(follower.result)).toBeInstanceOf(Map);
    });

    test("already held session survives waiting and abort; additional claims do not", async () => {
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      const held = sessions.getSession("base");
      const third = { deviceId: "d3", name: "d3", platform: "android" as const };
      manager.bootedDevices.push(third);
      await pool.addDevice(third);
      await pool.bindOrReuseDeviceSession("other-owner", "d3", "android");
      const waiter = observe(["base", "extra:a", "extra:b"]);
      await drainUntilQuiescent(timer);
      const idleWhileWaiting = pool.getDevice("d2")?.status;
      waiter.controller.abort(new Error("cancel held-base request"));
      await settle(waiter.result);
      expect(sessions.getSession("base")).toBe(held);
      expect(pool.getDevice("d1")?.sessionId).toBe("base");
      expect(pool.getDevice("d2")?.status).toBe("idle");
      expect(idleWhileWaiting).toBe("idle");
    });
  });
}
