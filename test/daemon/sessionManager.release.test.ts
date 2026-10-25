import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "../../src/daemon/wire/sessionLivenessWindows";
import { describe, expect, test } from "bun:test";
import { SessionManager, type KeepScreenAwakeRestorer } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import type { KeepScreenAwakeState } from "../../src/utils/KeepScreenAwakeManager";
import {
  DeferredReleaseDeviceSessionPersistence,
  installSessionManagerFixture,
  makeSessionManager,
  quietPersistence,
} from "../helpers/sessionManagerSuite";
import { unbindDevice } from "../../src/daemon/deviceBinding";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    sessionManager = fixture.manager;
    fakeTimer = fixture.timer;
  });

  describe("releaseSession", () => {
    test("should release session and return device id", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const deviceId = await sessionManager.releaseSession("session-1");
      expect(deviceId).toBe("emulator-5554");
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("should return null for non-existent session", async () => {
      const deviceId = await sessionManager.releaseSession("non-existent");
      expect(deviceId).toBeNull();
    });

    test("coalesces concurrent releases before callbacks and persistence", async () => {
      const released: string[] = [];
      const callbacks: string[] = [];
      let beginRestore!: () => void;
      const restoreStarted = new Promise<void>((resolve) => {
        beginRestore = resolve;
      });
      let finishRestore!: () => void;
      const restoreFinished = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      const restorer: KeepScreenAwakeRestorer = {
        async restore(_state: KeepScreenAwakeState): Promise<{ status: "restored" }> {
          beginRestore();
          await restoreFinished;

          return { status: "restored" as const };
        },
      };
      const repository = quietPersistence({
        async markReleased(sessionId: string): Promise<void> {
          released.push(sessionId);
        },
      });
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: repository,
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => restorer,
      });

      await manager.createSession("s1", "device-1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
      manager.onSessionRelease((sessionId) => callbacks.push(sessionId));

      const first = manager.releaseSession("s1", "heartbeat-timeout");
      await restoreStarted;
      const second = manager.releaseSession("s1", "daemon-shutdown");
      finishRestore();

      await expect(Promise.all([first, second])).resolves.toEqual(["device-1", "device-1"]);
      expect(callbacks).toEqual(["s1"]);
      expect(released).toEqual(["s1"]);
    });

    test("waits for tracked setup before restoring and removing a session", async () => {
      const setupGate = Promise.withResolvers<void>();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
      });

      const session = await manager.createSession("s1", "device-1", "android");
      const setup = manager.trackSessionSetup(session, () => setupGate.promise);
      const release = manager.releaseSession("s1", "daemon-shutdown");

      await Promise.resolve();
      expect(manager.getSession("s1")).not.toBeNull();

      setupGate.resolve();
      await setup;
      await expect(release).resolves.toBe("device-1");
      expect(manager.getSession("s1")).toBeNull();
    });

    test("re-checks the commit fence after awaiting tracked setup (#7031 round 2)", async () => {
      // The daemon's pre-release fence passes, then release awaits pending
      // setup work. A newer identity confirmation that lands during that await
      // must still stop the stale eviction from retiring the live session.
      const setupGate = Promise.withResolvers<void>();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
      });

      const session = await manager.createSession("s1", "emulator-5554", "android");
      const setup = manager.trackSessionSetup(session, () => setupGate.promise);
      let superseded = false;
      const release = manager.releaseSessionUnlessSuperseded(
        "s1",
        "device-disconnected:emulator-5554",
        { commitFence: () => !superseded },
      );

      await Promise.resolve();
      expect(manager.getSession("s1")).toBe(session);

      superseded = true;
      setupGate.resolve();
      await setup;
      await expect(release).resolves.toEqual({ superseded: true });
      expect(manager.getSession("s1")).toBe(session);
      expect(manager.getSessionForDevice("emulator-5554")).toBe("s1");
    });

    test("a fence that declines during terminal persistence leaves the session live", async () => {
      const persistence = new DeferredReleaseDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence });

      const session = await manager.createSession("s1", "emulator-5554", "android");
      let superseded = false;
      const release = manager.releaseSessionUnlessSuperseded(
        "s1",
        "device-disconnected:emulator-5554",
        { commitFence: () => !superseded },
      );
      await persistence.releaseStarted.promise;

      superseded = true;
      persistence.finishRelease.resolve();
      await expect(release).resolves.toEqual({ superseded: true });
      expect(manager.getSession("s1")).toBe(session);
      expect(manager.getSessionForDevice("emulator-5554")).toBe("s1");
    });

    test("a fence that stays open commits the release and reports the device", async () => {
      const manager = makeSessionManager({ timer: fakeTimer });

      await manager.createSession("s1", "emulator-5554", "android");

      await expect(
        manager.releaseSessionUnlessSuperseded("s1", "explicit-release", {
          commitFence: () => true,
        }),
      ).resolves.toEqual({ superseded: false, deviceId: "emulator-5554" });
      expect(manager.getSession("s1")).toBeNull();
    });

    test("does not admit setup that arrives after release begins", async () => {
      let finishInitialSetup!: () => void;
      const initialSetup = new Promise<void>((resolve) => {
        finishInitialSetup = resolve;
      });
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
      });

      const session = await manager.createSession("s1", "device-1", "android");
      const setup = manager.trackSessionSetup(session, () => initialSetup);
      const release = manager.releaseSession("s1", "daemon-shutdown");
      let lateSetupStarted = false;

      await Promise.resolve();
      await manager.trackSessionSetup(session, async () => {
        lateSetupStarted = true;
      });
      expect(lateSetupStarted).toBe(false);

      finishInitialSetup();
      await setup;
      await expect(release).resolves.toBe("device-1");
    });

    test("keeps an expiring session assigned until its release finishes", async () => {
      const setupGate = Promise.withResolvers<void>();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
      });

      const session = await manager.createSession("s1", "device-1", "android", { timeoutMs: 1 });
      const setup = manager.trackSessionSetup(session, () => setupGate.promise);
      const release = manager.releaseSession("s1", "daemon-shutdown", { allowExpired: true });

      fakeTimer.advanceTime(1);
      manager.cleanupExpiredSessions();

      await expect(manager.createSession("s1", "device-2", "android")).resolves.toBe(session);
      setupGate.resolve();
      await setup;
      await expect(release).resolves.toBe("device-1");
      expect(manager.getSession("s1")).toBeNull();
    });

    test("bounds a drain of an already-started release", async () => {
      let finishRestore!: () => void;
      const restoreFinished = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => ({
          restore: async () => {
            await restoreFinished;
            return { status: "restored" as const };
          },
        }),
      });

      await manager.createSession("s1", "device-1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
      const release = manager.releaseSession("s1", "daemon-shutdown");
      await Promise.resolve();
      const drain = manager.drainReleasePromises(1_000);
      fakeTimer.advanceTime(1_000);
      await expect(drain).resolves.toBe(false);

      finishRestore();
      await expect(release).resolves.toBe("device-1");
    });

    test("waits for an old session's terminal write before recreating its UUID", async () => {
      let finishFirstPersistence!: () => void;
      const firstPersistence = new Promise<void>((resolve) => {
        finishFirstPersistence = resolve;
      });
      let firstPersistenceStarted!: () => void;
      const firstPersistenceStartedPromise = new Promise<void>((resolve) => {
        firstPersistenceStarted = resolve;
      });
      const releases: string[] = [];
      const repository = quietPersistence({
        async markReleased(
          _sessionId: string,
          _status: string,
          _releasedAt: number,
          reason: string,
        ): Promise<void> {
          releases.push(reason);
          if (reason === "superseded") {
            firstPersistenceStarted();
            await firstPersistence;
          }
        },
      });
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: repository,
        fakeBarrier: true,
      });

      await manager.createSession("s1", "device-1", "android");
      const first = manager.releaseSession("s1", "superseded");
      await firstPersistenceStartedPromise;
      const replacement = manager.createSession("s1", "device-2", "android");

      expect(manager.getSession("s1")).toBeNull();
      finishFirstPersistence();
      await expect(first).resolves.toBe("device-1");
      await expect(replacement).resolves.toMatchObject({ assignedDevice: "device-2" });
      expect(manager.getSession("s1")).toMatchObject({ assignedDevice: "device-2" });
      await expect(manager.releaseSession("s1", "plan-auto-release")).resolves.toBe("device-2");
      expect(releases).toEqual(["superseded", "plan-auto-release"]);
    });

    test("persists terminal state when keep-awake restoration times out", async () => {
      const released: string[] = [];
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence({
          async markReleased(sessionId: string): Promise<void> {
            released.push(sessionId);
          },
        }),
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => ({
          restore: async () => {
            await new Promise<void>(() => {});
            return { status: "restored" as const };
          },
        }),
      });

      await manager.createSession("s1", "device-1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
      const release = manager.releaseSession("s1", "daemon-shutdown");
      await Promise.resolve();
      fakeTimer.advanceTime(1_000);
      await expect(release).resolves.toBe("device-1");

      expect(manager.getSession("s1")).toBeNull();
      expect(released).toEqual(["s1"]);
    });

    test("keeps a device quarantined until timed-out keep-awake restoration completes", async () => {
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => ({
          restore: async () => {
            restoreStarted();
            await restoration;

            return { status: "restored" as const };
          },
        }),
      });
      const device = { name: "device-1", deviceId: "device-1", platform: "android" as const };
      const deviceManager = new FakeDeviceManager();
      // A pooled Android entry is re-proved present against discovery before it
      // is handed out, handsets included, so discovery has to list it.
      deviceManager.bootedDevices = [device];
      const pool = new DevicePool(
        createDevicePoolDependencies(manager, "test-daemon", {
          timer: fakeTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: deviceManager,
        }),
      );

      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("s1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });

      const release = manager.releaseSession("s1", "daemon-shutdown");
      await restorationStarted;
      await Promise.resolve();
      fakeTimer.advanceTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
      const deviceId = await release;
      await pool.releaseDevice(deviceId!, "s1");

      expect(pool.getDevice("device-1")).toMatchObject({ sessionId: "s1", status: "busy" });

      // A same-serial replacement must not be released by the old deferred callback.
      const oldDevice = pool.getDevice("device-1")!;
      unbindDevice(oldDevice);
      await pool.removeDevice("device-1");
      await pool.initializeWithDevices([
        { name: "device-1", deviceId: "device-1", platform: "android" },
      ]);
      await pool.assignDeviceToSession("s2", "android");

      finishRestore();
      for (
        let attempt = 0;
        attempt < 10 && pool.getDevice("device-1")?.status !== "idle";
        attempt++
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(pool.getDevice("device-1")).toMatchObject({ sessionId: "s2", status: "busy" });
    });

    test("coalesces a failed in-flight release into terminal cleanup", async () => {
      let rejectRestore!: (error: Error) => void;
      const restore = new Promise<void>((_resolve, reject) => {
        rejectRestore = reject;
      });
      const released: string[] = [];
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence({
          async markReleased(sessionId: string): Promise<void> {
            released.push(sessionId);
          },
        }),
        fakeBarrier: true,
        keepScreenAwakeRestorer: () => ({
          restore: async () => {
            await restore;
            return { status: "restored" as const };
          },
        }),
      });

      await manager.createSession("s1", "device-1", "android");
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });

      const first = manager.releaseSession("s1", "heartbeat-timeout");
      const joined = manager.releaseSession("s1", "daemon-shutdown", { allowExpired: true });
      rejectRestore(new Error("restore failed"));

      await expect(Promise.all([first, joined])).resolves.toEqual(["device-1", "device-1"]);
      expect(manager.getSession("s1")).toBeNull();
      expect(released).toEqual(["s1"]);
    });
  });

  describe("onSessionRelease callbacks", () => {
    test("should invoke release callbacks when session is released", async () => {
      await sessionManager.createSession("session-cb", "emulator-5554", "android");

      const released: { sessionId: string; deviceId: string }[] = [];
      sessionManager.onSessionRelease((sessionId, deviceId) => {
        released.push({ sessionId, deviceId });
      });

      await sessionManager.releaseSession("session-cb");

      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-cb");
      expect(released[0].deviceId).toBe("emulator-5554");
    });

    test("should continue releasing even if a callback throws", async () => {
      await sessionManager.createSession("session-err", "emulator-5554", "android");

      const results: string[] = [];
      sessionManager.onSessionRelease(() => {
        throw new Error("callback error");
      });
      sessionManager.onSessionRelease((sessionId) => {
        results.push(sessionId);
      });

      await sessionManager.releaseSession("session-err");

      // Second callback should still fire despite first throwing
      expect(results).toEqual(["session-err"]);
    });

    test("should invoke release callbacks when expired session is accessed via getSession", async () => {
      await sessionManager.createSession("session-expiry", "emulator-5554", "android");

      const released: { sessionId: string; deviceId: string }[] = [];
      sessionManager.onSessionRelease((sessionId, deviceId) => {
        released.push({ sessionId, deviceId });
      });

      // Advance time past the idle window, before the first cleanup sweep
      fakeTimer.advanceTime(DEFAULT_SESSION_IDLE_TIMEOUT_MS + 60_000);

      // Accessing the expired session should trigger cleanup + callback
      const result = sessionManager.getSession("session-expiry");
      expect(result).toBeNull();
      await sessionManager.waitForSessionRelease("session-expiry");
      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-expiry");
      expect(released[0].deviceId).toBe("emulator-5554");
    });

    test("should invoke release callbacks when cleanup timer fires for expired sessions", async () => {
      await sessionManager.createSession("session-timer", "emulator-5556", "android");

      const released: { sessionId: string; deviceId: string }[] = [];
      sessionManager.onSessionRelease((sessionId, deviceId) => {
        released.push({ sessionId, deviceId });
      });

      // Advance well past the idle window and several cleanup intervals
      fakeTimer.advanceTime(36 * 60 * 1000);
      await sessionManager.waitForSessionRelease("session-timer");

      expect(released).toHaveLength(1);
      expect(released[0].sessionId).toBe("session-timer");
      expect(released[0].deviceId).toBe("emulator-5556");
    });

    test("persists expired status for lazy and periodic session expiry", async () => {
      const releases: Array<{ sessionId: string; status: DeviceSessionStatus; reason: string }> =
        [];
      const repository: DeviceSessionPersistence = quietPersistence({
        async markReleased(sessionId, status, _releasedAtMs, reason): Promise<void> {
          releases.push({ sessionId, status, reason });
        },
      });
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repository });

      await manager.createSession("lazy-expiry", "emulator-5554", "android");
      // Past the idle window, before the first 5-minute cleanup sweep.
      fakeTimer.advanceTime(DEFAULT_SESSION_IDLE_TIMEOUT_MS + 60_000);
      expect(manager.getSession("lazy-expiry")).toBeNull();
      await manager.waitForSessionRelease("lazy-expiry");

      await manager.createSession("periodic-expiry", "emulator-5556", "android");
      fakeTimer.advanceTime(36 * 60 * 1000);
      await manager.waitForSessionRelease("periodic-expiry");

      expect(releases).toEqual([
        { sessionId: "lazy-expiry", status: "expired", reason: "cleanup-expired" },
        { sessionId: "periodic-expiry", status: "expired", reason: "cleanup-expired" },
      ]);
    });
  });

  test("read-only admission sees an expired session as absent without releasing it", async () => {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer, persistence });

    const session = await manager.createSession("expired-read", "emulator-5554", "android");
    session.expiresAt = timer.now() - 1;

    expect(
      await manager.admitIssuedSessionForAutomation("expired-read", undefined, {
        access: "read-only",
      }),
    ).toBeUndefined();
    expect(manager.getAllSessionIds()).toContain("expired-read");
    expect((await persistence.getSession("expired-read"))?.release_reason).toBeNull();
  });

  describe("shutdown draining (issue #2792)", () => {
    // A manager over a repo double capturing the fire-and-forget session writes, with its barrier.
    function makeDrainableManager(): {
      mgr: SessionManager;
      barrier: FakeDbWriteBarrier;
      activity: string[];
      released: string[];
    } {
      const activity: string[] = [];
      const released: string[] = [];
      const barrier = new FakeDbWriteBarrier();
      const mgr = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence({
          async recordActivity(sessionId: string): Promise<void> {
            activity.push(sessionId);
          },
          async markReleased(sessionId: string): Promise<void> {
            released.push(sessionId);
          },
        }),
        barrier: () => barrier,
      });
      return { mgr, barrier, activity, released };
    }

    test("routes fire-and-forget session activity writes through the barrier", async () => {
      const { mgr, barrier, activity } = makeDrainableManager();

      await mgr.createSession("s1", "emulator-5554", "android");
      await deliverDaemonHeartbeat(mgr, "s1");
      await Promise.resolve(); // let the void-tracked write run
      expect(activity).toContain("s1");
      // Exactly one barrier-tracked write: a single recordHeartbeat drives one
      // fire-and-forget recordSessionActivity. createSession's persistSession is
      // awaited, not barrier-tracked. A regression that fires the barrier twice
      // for one logical write (#2912's failure mode) would push this to 2.
      expect(barrier.ran.length).toBe(1);
    });

    test("skips fire-and-forget session writes while draining", async () => {
      const { mgr, barrier, activity } = makeDrainableManager();

      await mgr.createSession("s1", "emulator-5554", "android");
      barrier.beginDrain();
      await deliverDaemonHeartbeat(mgr, "s1");
      await Promise.resolve();
      // The heartbeat's activity write was short-circuited by the drain.
      expect(activity).toHaveLength(0);
    });

    // The cleanup interval is the ONE best-effort DB writer that fires on its own
    // timer rather than an external socket. With per-write barrier resolution
    // (#2912) it would resolve a fresh, non-draining barrier if it fired after
    // closeDatabase()'s reset — so `daemon.stop()` stops it before draining. These
    // two tests pin the property that call relies on: the timer routes a tracked
    // write when it fires, and stopping it neutralizes that writer.
    test("cleanup timer routes an expired-session release through the barrier", async () => {
      const { mgr, barrier, released } = makeDrainableManager();

      await mgr.createSession("s1", "emulator-5554", "android");
      // Past the idle window and a cleanup interval (5m): the timer fires.
      fakeTimer.advanceTime(36 * 60 * 1000);
      await mgr.waitForSessionRelease("s1");
      expect(released).toContain("s1");
      // Exactly one release promise is registered before daemon shutdown can
      // begin draining. A duplicate release regression would push this to 2.
      expect(barrier.trackedExisting.length).toBe(1);
    });

    test("stopCleanupTimer prevents the timer from routing any further tracked write", async () => {
      const { mgr, barrier, released } = makeDrainableManager();
      await mgr.createSession("s1", "emulator-5554", "android");

      // Model the shutdown ordering: stop the timer BEFORE the (would-be) drain.
      mgr.stopCleanupTimer();

      fakeTimer.advanceTime(36 * 60 * 1000);
      await Promise.resolve();

      // No cleanup fired, so no tracked write was ever attempted against a
      // reopened/closed connection.
      expect(released).toHaveLength(0);
      expect(barrier.trackCalls).toBe(0);
    });
  });
});
