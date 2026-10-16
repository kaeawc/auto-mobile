import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { describe, expect, test, spyOn } from "bun:test";
import { getDefaultSessionHeartbeatTimeoutMs } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { KeepScreenAwakeState } from "../../src/utils/KeepScreenAwakeManager";
import { logger } from "../../src/utils/logger";
import {
  DeferredDeviceSessionPersistence,
  DeferredLivenessRebindPersistence,
  installSessionManagerFixture,
  makeHierarchy,
  makeSessionManager,
} from "../helpers/sessionManagerSuite";

describe("SessionManager", () => {
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    fakeTimer = fixture.timer;
  });

  describe("rebindSession", () => {
    test("bounds a rebind whose keep-awake restoration never settles", async () => {
      const restorationStarted = Promise.withResolvers<void>();
      const manager = makeSessionManager({
        timer: fakeTimer,
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => ({
          restore: () => {
            restorationStarted.resolve();
            return new Promise<{ status: "restored" }>(() => {});
          },
        }),
      });

      await manager.createSession("s1", "device-1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
      let rebound = false;
      const rebind = manager.rebindSession("s1", "device-2", "android").then((session) => {
        rebound = true;
        return session;
      });
      await restorationStarted.promise;

      await fakeTimer.advanceTimeAsync(999);
      expect(rebound).toBe(false);
      expect(manager.getDeviceForSession("s1")).toBe("device-1");
      await fakeTimer.advanceTimeAsync(1);
      expect(rebound).toBe(true);
      await expect(rebind).resolves.toMatchObject({ assignedDevice: "device-2" });
      expect(manager.getDeviceForSession("s1")).toBe("device-2");
      expect(manager.getPendingDeviceCleanup("device-1")).not.toBeNull();
      expect(manager.getPendingDeviceCleanup("device-2")).toBeNull();
    });

    test.each(["resolve", "reject"] as const)(
      "quarantines the old device until timed-out rebind keep-awake restoration settles (%s)",
      async (outcome) => {
        const restoration = Promise.withResolvers<void>();
        const restorationStarted = Promise.withResolvers<void>();
        const restored: Array<{ deviceId: string; state: KeepScreenAwakeState }> = [];
        const warning = spyOn(logger, "warn").mockImplementation(() => {});
        const manager = makeSessionManager({
          timer: fakeTimer,
          fakeBarrier: true,
          keepScreenAwakeRestorer: (device) => ({
            restore: async (state) => {
              restorationStarted.resolve();
              await restoration.promise;
              restored.push({ deviceId: device.deviceId, state });

              return { status: "restored" as const };
            },
          }),
        });
        const state: KeepScreenAwakeState = { applied: true, method: "svc", svcWasEnabled: false };
        try {
          const session = await manager.createSession("s1", "device-1", "android");
          manager.setKeepScreenAwake("s1", state);
          let rebound = false;
          const rebind = manager
            .rebindSession("s1", "device-2", "android")
            .then((reboundSession) => {
              rebound = true;
              return reboundSession;
            });
          await restorationStarted.promise;
          await fakeTimer.advanceTimeAsync(1_000);
          expect(rebound).toBe(true);
          await expect(rebind).resolves.toBe(session);
          expect(manager.getDeviceForSession("s1")).toBe("device-2");
          expect(session.cacheData.keepScreenAwake).toBeUndefined();
          expect(warning).toHaveBeenCalledWith(
            "Timed out after 1000ms restoring keep-awake state for session s1",
          );
          const cleanup = manager.getPendingDeviceCleanup("device-1");
          expect(cleanup).not.toBeNull();
          expect(manager.getPendingDeviceCleanup("device-2")).toBeNull();

          if (outcome === "reject") {
            restoration.reject(new Error("late keep-awake restore failure"));
            // A late failure is retried before the old device leaves quarantine (#11145).
            await new Promise<void>((resolve) => setImmediate(resolve));
            await fakeTimer.advanceTimeAsync(250);
            expect(manager.getPendingDeviceCleanup("device-1")).not.toBeNull();
            await new Promise<void>((resolve) => setImmediate(resolve));
            await fakeTimer.advanceTimeAsync(250);
          } else {
            restoration.resolve();
          }
          await expect(cleanup).resolves.toBeUndefined();
          expect(manager.getPendingDeviceCleanup("device-1")).toBeNull();
          expect(manager.getDeviceForSession("s1")).toBe("device-2");
          expect(restored).toEqual(outcome === "resolve" ? [{ deviceId: "device-1", state }] : []);
        } finally {
          restoration.resolve();
          manager.stopCleanupTimer();
          warning.mockRestore();
        }
      },
    );

    test("rebinds without advancing time when keep-awake restoration completes immediately", async () => {
      const restoredDevices: string[] = [];
      const manager = makeSessionManager({
        timer: fakeTimer,
        fakeBarrier: true,
        keepScreenAwakeRestorer: (device) => ({
          restore: async () => {
            restoredDevices.push(device.deviceId);

            return { status: "restored" as const };
          },
        }),
      });

      await manager.createSession("s1", "device-1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });

      await expect(manager.rebindSession("s1", "device-2", "android")).resolves.toMatchObject({
        assignedDevice: "device-2",
      });
      expect(fakeTimer.now()).toBe(0);
      expect(restoredDevices).toEqual(["device-1"]);
      expect(manager.getPendingDeviceCleanup("device-1")).toBeNull();
    });

    test("warns, rebinds and retries when keep-awake restoration rejects immediately (#11145)", async () => {
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      const manager = makeSessionManager({
        timer: fakeTimer,
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => ({
          restore: async () => {
            throw new Error("immediate keep-awake restore failure");
          },
        }),
      });
      try {
        await manager.createSession("s1", "device-1", "android");
        manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });

        await expect(manager.rebindSession("s1", "device-2", "android")).resolves.toMatchObject({
          assignedDevice: "device-2",
        });
        expect(fakeTimer.now()).toBe(0);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("immediate keep-awake restore failure"),
        );
        // The old device stays quarantined while the bounded retries run.
        expect(manager.getPendingDeviceCleanup("device-1")).not.toBeNull();
        for (const delay of [250, 250]) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await fakeTimer.advanceTimeAsync(delay);
        }
        await manager.getPendingDeviceCleanup("device-1");
        expect(manager.getPendingDeviceCleanup("device-1")).toBeNull();
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(
            "Gave up restoring keep-awake state for session s1 after 2 retries",
          ),
        );
      } finally {
        manager.stopCleanupTimer();
        warning.mockRestore();
      }
    });

    test("times out a stalled setup without persisting or publishing the rebind", async () => {
      const timer = new FakeTimer();
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer, persistence: repository });
      const setupFinished = Promise.withResolvers<void>();
      try {
        const session = await manager.createSession("stalled-rebind", "sim-old", "ios");
        const setup = manager.trackSessionSetup(session, () => setupFinished.promise);
        const rebind = manager.rebindSession("stalled-rebind", "sim-new", "ios");
        await Promise.resolve();
        timer.advanceTime(1_000);

        await expect(rebind).rejects.toThrow("retry the device rebind after it settles");
        expect(manager.getDeviceForSession("stalled-rebind")).toBe("sim-old");
        expect(repository.upsertedDeviceIds).toEqual(["sim-old"]);

        setupFinished.resolve();
        await setup;
        await expect(
          manager.rebindSession("stalled-rebind", "sim-new", "ios"),
        ).resolves.toMatchObject({
          assignedDevice: "sim-new",
        });
      } finally {
        setupFinished.resolve();
        manager.stopCleanupTimer();
      }
    });

    test("retains the existing binding when replacement persistence rejects", async () => {
      const repository = new FakeDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      await manager.createSession("session-1", "emulator-old", "android");
      repository.failure = "create";

      await expect(manager.rebindSession("session-1", "emulator-new", "android")).rejects.toThrow(
        "persist create failed",
      );

      expect(manager.getSession("session-1")?.assignedDevice).toBe("emulator-old");
      expect(manager.getSessionForDevice("emulator-old")).toBe("session-1");
      expect(manager.getSessionForDevice("emulator-new")).toBeNull();
    });

    test("clears device-scoped state when a new runtime reuses the serial", async () => {
      const repository = new FakeDeviceSessionPersistence();
      const restoredDevices: string[] = [];
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: repository,
        keepScreenAwakeRestorer: (device) => ({
          restore: async () => {
            restoredDevices.push(device.deviceId);

            return { status: "restored" as const };
          },
        }),
      });
      const unboundDevices: string[] = [];

      await manager.createSession("session-1", "emulator-5554", "android");
      manager.setLastHierarchy("session-1", makeHierarchy("old"));
      manager.setKeepScreenAwake("session-1", { applied: true });
      manager.onSessionDeviceUnbound((_sessionId, deviceId) => unboundDevices.push(deviceId));

      await expect(
        manager.rebindSession("session-1", "emulator-5554", "android", { force: true }),
      ).resolves.toMatchObject({
        assignedDevice: "emulator-5554",
        cacheData: {},
      });

      expect(restoredDevices).toEqual(["emulator-5554"]);
      expect(unboundDevices).toEqual(["emulator-5554"]);
    });

    test("serializes a pending rebind with release and clears device-scoped state", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const restoredDevices: string[] = [];
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: repository,
        keepScreenAwakeRestorer: (device) => ({
          restore: async () => {
            restoredDevices.push(device.deviceId);

            return { status: "restored" as const };
          },
        }),
      });
      const unboundDevices: string[] = [];

      await manager.createSession("session-1", "emulator-old", "android");
      manager.setLastHierarchy("session-1", makeHierarchy("old"));
      manager.setKeepScreenAwake("session-1", { applied: true });
      manager.onSessionDeviceUnbound((_sessionId, deviceId) => unboundDevices.push(deviceId));
      repository.deferNextUpsert();

      const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
      await repository.waitForUpsert();
      const releasing = manager.releaseSession("session-1");
      repository.finishUpsert();

      await expect(rebinding).resolves.toMatchObject({
        assignedDevice: "emulator-new",
        cacheData: {},
      });
      await expect(releasing).resolves.toBe("emulator-new");
      expect(restoredDevices).toEqual(["emulator-old"]);
      expect(unboundDevices).toEqual(["emulator-old"]);
      expect(manager.getSession("session-1")).toBeNull();
      expect(manager.getSessionForDevice("emulator-old")).toBeNull();
      expect(manager.getSessionForDevice("emulator-new")).toBeNull();
    });

    test("publishes live heartbeat and label routing updates after deferred persistence", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: repository,
        keepScreenAwakeRestorer: () => ({
          restore: async () => {
            return { status: "restored" as const };
          },
        }),
      });
      const labels = {
        primary: "session-1",
        secondary: "session-2",
      };

      await manager.createSession("session-1", "emulator-old", "android", 1_000);
      manager.setLastHierarchy("session-1", makeHierarchy("old"));
      manager.setKeepScreenAwake("session-1", { applied: true });
      repository.deferNextUpsert();

      const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
      await repository.waitForUpsert();

      fakeTimer.advanceTime(100);
      manager.setDeviceLabels("session-1", labels);
      fakeTimer.advanceTime(50);
      manager.recordHeartbeat("session-1");
      repository.finishUpsert();

      // Neither the label write at 100 (cache data, #10703) nor the heartbeat at 150 (liveness,
      // #10656) is tool usage, so the idle clocks stay where the session was created.
      await expect(rebinding).resolves.toMatchObject({
        assignedDevice: "emulator-new",
        lastUsedAt: 0,
        lastHeartbeat: 150,
        expiresAt: 1_000,
        hasReceivedHeartbeat: true,
        cacheData: { deviceLabels: labels },
      });
      expect(manager.getDeviceLabels("session-1")).toEqual(labels);
      expect(manager.getSession("session-1")?.cacheData).toEqual({ deviceLabels: labels });
    });

    test("serializes rebind persistence with liveness ownership claims", async () => {
      const repository = new DeferredLivenessRebindPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      try {
        await manager.createSession("session-1", "emulator-old", "android");
        await manager.claimLivenessOwnership("session-1", "owner-a");
        // owner-a's lease and suspect grace must lapse or the daemon rejects owner-b's claim
        // (#10050); an accepted claim is its owner's heartbeat, so it holds the grace (#11646).
        fakeTimer.advanceTime(getDefaultSessionHeartbeatTimeoutMs() + SUSPECT_GRACE_MS + 1);
        repository.deferUpsert = true;

        const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
        await repository.upsertStarted.promise;
        let claimSettled = false;
        const claim = manager
          .claimLivenessOwnership("session-1", "owner-b")
          .finally(() => (claimSettled = true));
        await Promise.resolve();

        expect(claimSettled).toBe(false);
        expect(repository.persistedOwnerToken).toBe("owner-a");
        repository.finishUpsert.resolve();

        await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
        await expect(claim).resolves.toBe("claimed");
        expect(manager.hasLivenessOwnership("session-1", "owner-b")).toBe(true);
        expect(repository.persistedOwnerToken).toBe("owner-b");
      } finally {
        repository.finishUpsert.resolve();
        manager.stopCleanupTimer();
      }
    });

    test("waits for a pending rebind before admitting a new execution", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      await manager.createSession("session-1", "emulator-old", "android");
      repository.deferNextUpsert();

      const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
      await repository.waitForUpsert();
      let resolvedDevice: string | null = null;
      const resolving = manager.getOrCreateSession("session-1").then((session) => {
        resolvedDevice = session.assignedDevice;
        return session;
      });
      await Promise.resolve();

      expect(resolvedDevice).toBeNull();
      repository.finishUpsert();

      await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
      await expect(resolving).resolves.toMatchObject({ assignedDevice: "emulator-new" });
    });

    test("does not admit device-state setup while a rebind is pending", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      const session = await manager.createSession("session-1", "emulator-old", "android");
      repository.deferNextUpsert();

      const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
      await repository.waitForUpsert();
      let setupStarted = false;
      await manager.trackSessionSetup(session, async () => {
        setupStarted = true;
      });

      expect(setupStarted).toBe(false);
      repository.finishUpsert();
      await rebinding;
    });

    test("serializes expiry cleanup with a pending rebind", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: repository,
        fakeBarrier: true,
      });

      await manager.createSession("session-1", "emulator-old", "android", 1);
      repository.deferNextUpsert();
      const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
      await repository.waitForUpsert();

      fakeTimer.advanceTime(2);
      manager.cleanupExpiredSessions();
      repository.finishUpsert();

      await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
      await expect(manager.drainReleasePromises(10)).resolves.toBe(true);
      expect(manager.getSession("session-1")).toBeNull();
      expect(manager.getSessionForDevice("emulator-old")).toBeNull();
      expect(manager.getSessionForDevice("emulator-new")).toBeNull();
    });

    test("does not remove rebind ownership when lazy expiry observes the pending rebind", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      await manager.createSession("session-1", "emulator-old", "android", 1);
      repository.deferNextUpsert();
      const rebinding = manager.rebindSession("session-1", "emulator-new", "android");
      await repository.waitForUpsert();

      fakeTimer.advanceTime(2);
      expect(manager.getSession("session-1")).toBeNull();
      repository.finishUpsert();

      await expect(rebinding).resolves.toMatchObject({ assignedDevice: "emulator-new" });
      await expect(manager.drainReleasePromises(10)).resolves.toBe(true);
      expect(manager.getSession("session-1")).toBeNull();
      expect(manager.getSessionForDevice("emulator-old")).toBeNull();
      expect(manager.getSessionForDevice("emulator-new")).toBeNull();
    });

    test("does not recreate a session when a release wins the rebind race", async () => {
      const repository = new DeferredDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      await manager.createSession("session-1", "emulator-old", "android");
      const releasing = manager.releaseSession("session-1");
      await expect(manager.rebindSession("session-1", "emulator-new", "android")).rejects.toThrow(
        "Cannot rebind released session session-1",
      );
      await expect(releasing).resolves.toBe("emulator-old");
      expect(manager.getSession("session-1")).toBeNull();
      expect(manager.getSessionForDevice("emulator-new")).toBeNull();
    });
  });

  describe("acquisition device cleanup (#11041)", () => {
    test("does not count as cleanup for the live holder, but quarantines the device once it is released", async () => {
      const timer = new FakeTimer();
      const manager = makeSessionManager({ timer });
      const stop = Promise.withResolvers<void>();
      try {
        await manager.createSession("session-1", "emulator-5554", "android");
        manager.registerAcquisitionDeviceCleanup("emulator-5554", stop.promise);
        expect(manager.hasDeviceCleanupInProgress("emulator-5554")).toBe(false);

        await manager.releaseSession("session-1");
        expect(manager.hasDeviceCleanupInProgress("emulator-5554")).toBe(true);

        stop.resolve();
        await manager.drainPendingDeviceCleanups(50);
        await Promise.resolve();
        expect(manager.hasDeviceCleanupInProgress("emulator-5554")).toBe(false);
      } finally {
        stop.resolve();
        manager.stopCleanupTimer();
      }
    });

    test("is waited on by the shutdown drain", async () => {
      const timer = new FakeTimer();
      const manager = makeSessionManager({ timer });
      const stop = Promise.withResolvers<void>();
      try {
        manager.registerAcquisitionDeviceCleanup("emulator-5554", stop.promise);
        const drain = manager.drainPendingDeviceCleanups(50);
        timer.advanceTime(50);
        await expect(drain).resolves.toBe(false);
      } finally {
        stop.resolve();
        manager.stopCleanupTimer();
      }
    });
  });

  test("drains pending device cleanups with a bounded wait", async () => {
    const timer = new FakeTimer();
    const manager = makeSessionManager({ timer });
    const cleanup = Promise.withResolvers<void>();
    try {
      manager.registerPendingDeviceCleanup("sim-dirty", cleanup.promise);
      const timedDrain = manager.drainPendingDeviceCleanups(50);
      timer.advanceTime(50);
      await expect(timedDrain).resolves.toBe(false);

      const settledDrain = manager.drainPendingDeviceCleanups(50);
      cleanup.resolve();
      await expect(settledDrain).resolves.toBe(true);
      expect(manager.getPendingDeviceCleanup("sim-dirty")).toBeNull();
    } finally {
      cleanup.resolve();
      manager.stopCleanupTimer();
    }
  });
});
