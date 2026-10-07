import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent, settleWithFakeTime } from "../helpers/fakeTimerStepping";

// #10153: a labelled plan whose label maps to its base session must count the
// device that session already holds instead of waiting for an idle device.
for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} allocation with an existing session`, () => {
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
        createDevicePoolDependencies(sessions, "existing-session-test", {
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

    test("one-label plan on the only device, held by its base session, allocates without waiting", async () => {
      await setUp(["d1"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      const held = sessions.getSession("base");

      // executePlan maps the plan's only label to its base session.
      const labelSessions = Object.values(buildDeviceLabelMap(["A"], "base"));
      const plan = observe(labelSessions);
      await drainUntilQuiescent(timer);

      expect(labelSessions).toEqual(["base"]);
      expect(plan.isSettled()).toBe(true);
      expect([...((await plan.result) as Map<string, string>)]).toEqual([["base", "d1"]]);
      expect(sessions.getSession("base")).toBe(held);
      expect(pool.getDevice("d1")?.sessionId).toBe("base");
      expect(timer.now()).toBe(0);
    });

    test("one-label plan allocates when every device is assigned (issue repro: idle 0, assigned 2)", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      await pool.bindOrReuseDeviceSession("other-client", "d2", "android");

      const plan = observe(["base"]);
      await drainUntilQuiescent(timer);

      expect(plan.isSettled()).toBe(true);
      expect([...((await plan.result) as Map<string, string>)]).toEqual([["base", "d1"]]);
      expect(pool.getDevice("d2")?.sessionId).toBe("other-client");
    });

    test("two-label plan uses the base session's device and claims one idle device", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("base", "d2", "android");

      const result = (await settle(observe(["base", "base:B"]).result)) as Map<string, string>;

      expect(result.get("base")).toBe("d2");
      expect(result.get("base:B")).toBe("d1");
      expect(sessions.getSession("base:B")?.assignedDevice).toBe("d1");
    });

    test("two-label plan with no idle device times out, keeps the base session and reports why", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      await pool.bindOrReuseDeviceSession("other-client", "d2", "android");
      const held = sessions.getSession("base");

      const outcome = String(await settle(observe(["base", "base:B"]).result));

      expect(outcome).toContain("Timed out allocating devices after 4s");
      expect(outcome).toContain(
        "0 attempts; too few matching devices were idle to attempt allocation",
      );
      expect(sessions.getSession("base")).toBe(held);
      expect(sessions.getSession("base:B")).toBeNull();
      expect(pool.getDevice("d1")?.sessionId).toBe("base");
    });

    test("a request that never reaches the queue head says so in its timeout (#9950)", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("owner", "d2", "android");
      const head = observe(["a", "b"], 8_000);
      await drainUntilQuiescent(timer);
      const follower = observe(["c"], 2_000);

      const outcome = String(await settle(follower.result));

      expect(outcome).toContain("Timed out allocating devices after 2s");
      expect(outcome).toContain(
        "0 attempts; still queued behind an earlier multi-device request that was waiting for devices",
      );
      expect(head.isSettled()).toBe(false);
      await sessions.releaseSession("owner");
      await pool.releaseDevice("d2", "owner");
      expect(await settle(head.result)).toBeInstanceOf(Map);
    });

    test("a plan needing no new claim is not queued behind a request waiting on its device", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      // Another client's two-device request waits for d1, which base holds.
      const other = observe(["x", "y"], 8_000);
      await drainUntilQuiescent(timer);

      const plan = observe(["base"]);
      await drainUntilQuiescent(timer);

      expect(plan.isSettled()).toBe(true);
      expect([...((await plan.result) as Map<string, string>)]).toEqual([["base", "d1"]]);
      expect(timer.now()).toBe(0);
      expect(other.isSettled()).toBe(false);
      await sessions.releaseSession("base");
      await pool.releaseDevice("d1", "base");
      expect(await settle(other.result)).toBeInstanceOf(Map);
    });

    test("a held device in an error state fails fast naming the label", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      pool.getDevice("d1")!.status = "error";

      const plan = observe(["base"]);
      await drainUntilQuiescent(timer);

      expect(plan.isSettled()).toBe(true);
      const outcome = String(await plan.result);
      expect(outcome).toContain("Session 'base' already holds device 'd1'");
      expect(outcome).toContain("the device is in an error state");
      expect(pool.getDevice("d2")?.sessionId).toBeNull();
      expect(sessions.getSession("base")?.assignedDevice).toBe("d1");
      expect(timer.now()).toBe(0);
    });

    test("a held device on another platform fails fast naming the label", async () => {
      await setUp(["d1", "d2"], ["d1"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "ios");

      const plan = observe(["base"]);
      await drainUntilQuiescent(timer);

      expect(plan.isSettled()).toBe(true);
      const outcome = String(await plan.result);
      expect(outcome).toContain("Session 'base' already holds device 'd1'");
      expect(outcome).toContain("does not match the requested criteria (platform=android)");
      expect(pool.getDevice("d2")?.sessionId).toBeNull();
      expect(timer.now()).toBe(0);
    });

    test("a session whose device left the pool is counted as needing a claim", async () => {
      await setUp(["d1", "d2"]);
      await pool.bindOrReuseDeviceSession("base", "d1", "android");
      await pool.bindOrReuseDeviceSession("other-client", "d2", "android");
      // The session survives, but the pool no longer attributes d1 to it.
      pool.getDevice("d1")!.sessionId = "someone-else";

      const outcome = String(await settle(observe(["base"], 2_000).result));

      expect(outcome).toContain(
        "0 attempts; too few matching devices were idle to attempt allocation",
      );
    });
  });
}
