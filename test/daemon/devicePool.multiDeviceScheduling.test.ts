import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import type { Platform } from "../../src/models";
import { holdAsPlanSession } from "../helpers/planSessionHold";

for (const criteria of [false, true]) {
  describe(`${criteria ? "criteria" : "platform"} multi-device scheduling`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let discovery: FakeDeviceManager;
    let persistence: FakeDeviceSessionPersistence;
    let pool: DevicePool;
    let markers: FakeDeviceHealthMarkers;
    const controllers: AbortController[] = [];
    beforeEach(async () => {
      timer = new FakeTimer();
      markers = new FakeDeviceHealthMarkers(timer);
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
          deviceHealthMarkers: markers,
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
        await holdAsPlanSession(pool, `owner:${deviceId}`, deviceId, "ios");
      }
      const head = allocate(["h:a", "h:b"], "ios");
      await drainUntilQuiescent(timer);
      const follower = allocate(["f:a", "f:b"]);
      await drainUntilQuiescent(timer);
      expect(head.settled()).toBe(false);
      expect(follower.outcome()).toBeInstanceOf(Map);
    });
    test("overlapping follower retains its deadline budget while waiting for a turn", async () => {
      await holdAsPlanSession(pool, "owner", "b");
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
      await holdAsPlanSession(pool, "owner", "b");
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

    for (const restores of [false, true]) {
      test(`round-2: errored singleton refreshes once and ${restores ? "recovers" : "rejects"} without waiting`, async () => {
        await pool.removeDevice("b");
        discovery.bootedDevices = discovery.bootedDevices.filter(
          (device) => device.deviceId === "a",
        );
        const device = pool.getDevice("a")!;
        device.status = "error";
        const original = discovery.getBootedDevicesDetailed.bind(discovery);
        const refresh = spyOn(discovery, "getBootedDevicesDetailed").mockImplementation(
          async (platform) => {
            // Model recovery completing during the allocation's inventory refresh.
            if (platform === "either" && restores) {
              device.status = "idle";
            }
            return original(platform);
          },
        );
        try {
          const head = allocate(["h:a"], "android", 300_000);
          await drainUntilQuiescent(timer);
          expect(head.settled()).toBe(true);
          expect(timer.now()).toBe(0);
          expect(refresh.mock.calls.filter(([platform]) => platform === "either")).toHaveLength(1);
          if (restores) {
            expect(head.outcome()).toEqual(new Map([["h:a", "a"]]));
          } else {
            expect(String(head.outcome())).toContain(
              criteria ? "No matching devices are currently available" : "no devices available",
            );
            expect(device.status).toBe("error");
          }
          expect(timer.getPendingTimeoutCount()).toBe(0);
        } finally {
          refresh.mockRestore();
        }
      });
    }

    test("round-2: a removed busy candidate rejects within one poll", async () => {
      await pool.removeDevice("b");
      discovery.bootedDevices = discovery.bootedDevices.filter((device) => device.deviceId === "a");
      // A busy pool entry can outlive its session during disconnect handling.
      const device = pool.getDevice("a")!;
      device.status = "busy";
      const head = allocate(["h:a"], "android", 300_000);
      await drainUntilQuiescent(timer);
      expect(head.settled()).toBe(false);
      discovery.bootedDevices = [];
      await pool.removeDevice("a");
      timer.advanceTime(1_000);
      await drainUntilQuiescent(timer);
      expect(head.settled()).toBe(true);
      expect(String(head.outcome())).toContain(
        criteria ? "No matching devices are currently available" : "no devices available",
      );
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("round-2: mixed health idle capacity waits without repeated session claims", async () => {
      markers.mark("b", pool.getDeviceIncarnation("b")!, "network-condition");
      const claims = spyOn(sessions, "createSession");
      try {
        const head = allocate(["h:a", "h:b"]);
        await drainUntilQuiescent(timer);
        expect(head.settled()).toBe(false);
        expect(claims.mock.calls.length).toBe(0);
        for (let poll = 0; poll < 3; poll++) {
          timer.advanceTime(1_000);
          await drainUntilQuiescent(timer);
          expect(head.settled()).toBe(false);
          expect(claims.mock.calls.length).toBe(0);
        }
        timer.advanceTime(1_000);
        await drainUntilQuiescent(timer);
        expect(String(head.outcome())).toContain("Timed out allocating devices after 4s");
        expect(claims.mock.calls.length).toBe(0);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        claims.mockRestore();
      }
    });

    test("round-2: mixed health platform-disjoint waiters do not wake each other into claim churn", async () => {
      for (const deviceId of ["ios-a", "ios-b"]) {
        const device = { deviceId, name: deviceId, platform: "ios" as const };
        discovery.bootedDevices.push(device);
        await pool.addDevice(device);
      }
      markers.mark("b", pool.getDeviceIncarnation("b")!, "network-condition");
      markers.mark("ios-b", pool.getDeviceIncarnation("ios-b")!, "network-condition");
      const claims = spyOn(sessions, "createSession");
      try {
        const android = allocate(["android:a", "android:b"]);
        const ios = allocate(["ios:a", "ios:b"], "ios");
        // Bound the drain even if the old source continually wakes its peer.
        await drainMicrotasks(1_000);
        const initiallyWaiting = !android.settled() && !ios.settled();
        const initialClaims = claims.mock.calls.length;
        timer.advanceTime(1_000);
        await drainMicrotasks(1_000);
        const laterClaims = claims.mock.calls.length;
        // Finish both deadlines before asserting so even a churning old source
        // leaves no active allocation when the regression assertion fails.
        timer.advanceTime(3_000);
        await drainMicrotasks(1_000);
        const outcomes = await Promise.all([android.result, ios.result]);
        expect(initiallyWaiting).toBe(true);
        expect(initialClaims).toBe(0);
        expect(laterClaims).toBe(0);
        for (const outcome of outcomes) {
          expect(String(outcome)).toContain("Timed out allocating devices after 4s");
        }
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        claims.mockRestore();
      }
    });

    test("round-2: timeout reports required capacity without a rolled-back allocation count", async () => {
      await holdAsPlanSession(pool, "owner", "b");
      const head = allocate(["h:a", "h:b"], "android", 2_000);
      await drainUntilQuiescent(timer);
      for (let poll = 0; poll < 2; poll++) {
        timer.advanceTime(1_000);
        await drainUntilQuiescent(timer);
      }
      expect(String(head.outcome())).toContain("Timed out allocating devices after 2s");
      expect(String(head.outcome())).toContain("Required: 2 devices\n");
      expect(String(head.outcome())).not.toContain("allocated:");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  });
}
