import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import type { Platform } from "../../src/models";

for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} multi-device scheduling`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let discovery: FakeDeviceManager;
    let persistence: FakeDeviceSessionPersistence;
    let pool: DevicePool;
    const controllers: AbortController[] = [];
    beforeEach(async () => {
      timer = new FakeTimer();
      persistence = new FakeDeviceSessionPersistence();
      sessions = new SessionManager(timer, persistence);
      discovery = new FakeDeviceManager(
        [],
        ["a", "b"].map((deviceId) => ({
          deviceId,
          name: deviceId,
          platform: "android",
        })),
      );
      pool = new DevicePool(
        createDevicePoolDependencies(sessions, "scheduling", {
          timer,
          deviceManager: discovery,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          retryExecutor: new DefaultRetryExecutor(timer),
        }),
      );
      await pool.initializeWithDevices(discovery.bootedDevices);
    });
    afterEach(async () => {
      for (const controller of controllers.splice(0)) {
        controller.abort(new Error("test cleanup"));
      }
      await drainUntilQuiescent(timer);
      sessions.stopCleanupTimer();
      timer.reset();
    });
    const allocate = (ids: string[], platform: Platform = "android", timeout = 4_000) => {
      const controller = new AbortController();
      controllers.push(controller);
      let outcome: unknown;
      let settled = false;
      const result = runWithAbortSignal(controller.signal, () =>
        criteria
          ? pool.assignMultipleDevicesByCriteria(
              ids.map((sessionId) => ({ sessionId, criteria: { platform } })),
              timeout,
            )
          : pool.assignMultipleDevices(ids, timeout, platform),
      ).then(
        (value) => {
          settled = true;
          outcome = value;
          return value;
        },
        (error: unknown) => {
          settled = true;
          outcome = error;
          return error;
        },
      );
      return { result, controller, settled: () => settled, outcome: () => outcome };
    };
    const release = async (id: string) => {
      const device = sessions.getSession(id)?.assignedDevice;
      if (!device) {
        throw new Error(`Missing session ${id}`);
      }
      await sessions.releaseSession(id);
      await pool.releaseDevice(device, id);
    };
    test("idle Android pair bypasses blocked iOS head without advancing time", async () => {
      for (const deviceId of ["ios-a", "ios-b"]) {
        const device = { deviceId, name: deviceId, platform: "ios" as const };
        discovery.bootedDevices.push(device);
        await pool.addDevice(device);
        await pool.bindOrReuseDeviceSession(`owner:${deviceId}`, deviceId, "ios");
      }
      const head = allocate(["h:a", "h:b"], "ios");
      await drainUntilQuiescent(timer);
      const follower = allocate(["f:a", "f:b"]);
      await drainUntilQuiescent(timer);
      expect(head.settled()).toBe(false);
      expect(follower.outcome()).toBeInstanceOf(Map);
    });
    test("overlapping follower retains its deadline budget while waiting for a turn", async () => {
      await pool.bindOrReuseDeviceSession("owner", "b", "android");
      const head = allocate(["h:a", "h:b"]);
      await drainUntilQuiescent(timer);
      const follower = allocate(["f:a", "f:b"], "android", 2_000);
      await drainUntilQuiescent(timer);
      timer.advanceTime(1_500);
      await drainUntilQuiescent(timer);
      expect(follower.settled()).toBe(false);
      await release("owner");
      await drainUntilQuiescent(timer);
      expect(head.outcome()).toBeInstanceOf(Map);
      await release("h:a");
      await release("h:b");
      await drainUntilQuiescent(timer);
      expect(follower.outcome()).toBeInstanceOf(Map);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
    test("preflight image discovery does not hold a FIFO ticket", async () => {
      let finish = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let entered = false;
      const original = discovery.listDeviceImages.bind(discovery);
      const listing = spyOn(discovery, "listDeviceImages").mockImplementation(async (platform) => {
        entered = true;
        await gate;
        return original(platform);
      });
      const head = allocate(["h:a", "h:b", "h:c"]);
      try {
        await drainUntilQuiescent(timer);
        expect(entered).toBe(true);
        const follower = allocate(["f:a", "f:b"]);
        await drainUntilQuiescent(timer);
        expect(follower.outcome()).toBeInstanceOf(Map);
      } finally {
        listing.mockRestore();
        finish();
        await drainUntilQuiescent(timer);
        head.controller.abort(new Error("cancel preflight test"));
        await head.result;
      }
    });
    test("last device release wakes head before the next poll without session churn", async () => {
      await pool.bindOrReuseDeviceSession("owner", "b", "android");
      const creates = spyOn(persistence, "upsertActiveSession");
      try {
        const head = allocate(["h:a", "h:b"]);
        await drainUntilQuiescent(timer);
        timer.advanceTime(250);
        const writesWhileWaiting = creates.mock.calls.length;
        await release("owner");
        await drainUntilQuiescent(timer);
        expect(head.outcome()).toBeInstanceOf(Map);
        expect(writesWhileWaiting).toBe(0);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        creates.mockRestore();
      }
    });
    if (criteria) {
      test("capacity shortage waits for a matching device to join", async () => {
        const head = allocate(["h:a", "h:b", "h:c"]);
        await drainUntilQuiescent(timer);
        expect(head.settled()).toBe(false);
        const device = { deviceId: "c", name: "c", platform: "android" as const };
        discovery.bootedDevices.push(device);
        await pool.addDevice(device);
        timer.advanceTime(1_000);
        await drainUntilQuiescent(timer);
        expect(head.outcome()).toBeInstanceOf(Map);
      });
    }
  });
}
