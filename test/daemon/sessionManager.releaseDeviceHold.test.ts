import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import {
  ManagedExecutionReowner,
  MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS,
} from "../../src/daemon/managedSlots/managedExecutionReowner";
import { logger } from "../../src/utils/logger";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
} from "../../src/features/utility/LocationRoutePlayer";
import { registerNetworkStateSessionCleanup } from "../../src/server/networkStateSessionCleanup";
import { NetworkState } from "../../src/server/NetworkState";
import {
  deferHeldPlanAppCleanup,
  takeHeldPlanAppCleanup,
} from "../../src/server/heldPlanAppCleanup";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

const SESSION = "held-session";
const DEVICE = "fake-device";
const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
  defaultDeviceClockRestoreRegistry.retire(DEVICE);
});

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const writes: string[] = [];
  const persistence = new FakeDeviceSessionPersistence();
  const behavior: { gate?: Promise<void> } = {};
  const record = (kind: string) => () => ({
    restore: async () => {
      await behavior.gate;
      writes.push(kind);
    },
  });
  const manager = new SessionManager(
    timer,
    persistence,
    () => new FakeDbWriteBarrier(),
    record("keep-awake"),
    record("biometric"),
    {
      networkCondition: record("network"),
      clock: record("clock"),
      rotation: record("rotation"),
      screenReader: record("screen-reader"),
    },
  );
  manager.stopCleanupTimer();
  managers.push(manager);
  const session = await manager.createSession(SESSION, DEVICE, "android");
  manager.setKeepScreenAwake(SESSION, { applied: true });
  manager.setBiometricEnrollment(SESSION, { initialEnrollment: "not_enrolled" });
  manager.setNetworkCondition(SESSION, { initialProfile: "none" });
  manager.setClock(session, { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: true });
  manager.setRotation(session, { accelerometerRotation: 1, userRotation: 0 });
  manager.setScreenReader(session, { platform: "android", previousEnabled: false });
  return { manager, timer, writes, persistence, behavior, session };
}

describe("session release device ownership hold", () => {
  test("lost ownership skips every restore and leaves no pending device cleanup", async () => {
    const { manager, writes, timer, session } = await harness();
    manager.setReleaseDeviceHold(() => ({ skipDeviceWrites: true }));
    const options: boolean[] = [];
    manager.onSessionRelease((_id, _device, _reason, _snapshot, releaseOptions) => {
      options.push(releaseOptions.deviceIdentityReplaced === true);
    });
    const state = new NetworkState({ timer, notifier: { notifyResourceUpdated: () => {} } });
    state.startSimulation(DEVICE, "timeout", 30, null, SESSION);
    registerNetworkStateSessionCleanup(manager, {
      state: () => state,
      pusher: {
        push: async () => {
          writes.push("network-push");
        },
      },
    });
    const registry = new LocationRouteRegistry(timer);
    const retired: string[] = [];
    registerLocationRouteSessionCleanup(manager, {
      registry,
      mockLocationClears: {
        markSet: () => {},
        clearLateSet: () => null,
        retireDevice: (device) => {
          retired.push(device);
        },
        clearAfter: () => {
          writes.push("location-clear");
          return Promise.resolve();
        },
      },
    });
    registry.start(
      DEVICE,
      [
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 1 },
      ],
      1_000,
      500,
      true,
      async () => {
        writes.push("location-fix");
      },
    );
    deferHeldPlanAppCleanup(
      manager,
      SESSION,
      async () => {
        writes.push("app-cleanup");
      },
      100,
    );
    await manager.releaseSession(SESSION, "explicit-release");
    expect(writes).toEqual([]);
    expect(options).toEqual([true]);
    expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
    expect(state.getSimulation(DEVICE)).toBeNull();
    expect(registry.isActive(DEVICE)).toBe(false);
    expect(retired).toEqual([DEVICE]);
    expect(takeHeldPlanAppCleanup(manager, SESSION)).toBeUndefined();
    expect(session.cacheData.clock).toBeUndefined();
    expect(session.cacheData.rotation).toBeUndefined();
    expect(session.cacheData.screenReader).toBeUndefined();
  });

  test("unconfirmed release waits, then restores with a bound from hold end", async () => {
    const { manager, timer, writes } = await harness();
    const hold = Promise.withResolvers<"teardown" | "skip-device-writes">();
    manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
    const release = manager.releaseSession(SESSION);
    await drainMicrotasks(40);
    expect(writes).toEqual([]);
    expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(true);
    expect(manager.getDeviceCleanupRetryAfterMs(DEVICE)).toBe(
      10_000 + SESSION_RELEASE_TEARDOWN_CAP_MS + SESSION_RELEASE_PERSIST_TIMEOUT_MS,
    );
    timer.advanceTime(700);
    hold.resolve("teardown");
    await release;
    expect(writes).toEqual([
      "keep-awake",
      "biometric",
      "network",
      "clock",
      "rotation",
      "screen-reader",
    ]);
    expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
  });

  test.each(["skip-device-writes", "reject"] as const)(
    "hold → %s fails safe without restores or cleanup",
    async (outcome) => {
      const { manager, writes } = await harness();
      const hold = Promise.withResolvers<"teardown" | "skip-device-writes">();
      manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
      const release = manager.releaseSession(SESSION);
      await drainMicrotasks(30);
      expect(writes).toEqual([]);
      if (outcome === "reject") {
        hold.reject(new Error("ownership lookup failed"));
      } else {
        hold.resolve(outcome);
      }
      await release;
      expect(writes).toEqual([]);
      expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
    },
  );

  test("forced while awaiting ownership never dispatches teardown", async () => {
    const { manager, writes } = await harness();
    const hold = Promise.withResolvers<"teardown" | "skip-device-writes">();
    manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
    deferHeldPlanAppCleanup(
      manager,
      SESSION,
      async () => {
        writes.push("app-cleanup");
      },
      100,
    );
    const release = manager.releaseSession(SESSION);
    expect(manager.forceStuckRelease(SESSION)?.stage).toBe("awaiting-ownership");
    hold.resolve("teardown");
    await release;
    await drainMicrotasks(40);
    expect(writes).toEqual([]);
    expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
  });

  test("forcing a release already marked no-device preserves the option for listeners", async () => {
    const { manager, writes, persistence } = await harness();
    const persist = Promise.withResolvers<void>();
    const original = persistence.markReleased.bind(persistence);
    persistence.markReleased = async (...args) => {
      await persist.promise;
      return original(...args);
    };
    const options: boolean[] = [];
    manager.onSessionRelease((_id, _device, _reason, _snapshot, releaseOptions) => {
      options.push(releaseOptions.deviceIdentityReplaced === true);
    });
    const release = manager.releaseSession(SESSION, "explicit-release", false, undefined, {
      deviceIdentityReplaced: true,
    });
    await drainMicrotasks(40);
    expect(manager.forceStuckRelease(SESSION)).toBeDefined();
    persist.resolve();
    await release;
    await drainMicrotasks(40);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(Boolean)).toBe(true);
    expect(writes).toEqual([]);
  });

  test("joined releases share one resolver and receive the terminal loss reason", async () => {
    const { manager, writes } = await harness();
    const hold = Promise.withResolvers<"teardown" | "skip-device-writes">();
    let resolves = 0;
    manager.setReleaseDeviceHold(() => {
      resolves++;
      return { settled: hold.promise, capMs: 10_000 };
    });
    const first = manager.releaseSession(SESSION, "daemon-shutdown");
    const joined = manager.releaseSession(SESSION, "managed-slot-ownership-lost");
    expect(resolves).toBe(1);
    hold.resolve("skip-device-writes");
    expect(await first).toBe(DEVICE);
    expect(await joined).toBe(DEVICE);
    expect(writes).toEqual([]);
    expect(manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe(
      "managed-slot-ownership-lost",
    );
  });

  test.each(["cap", "close"] as const)(
    "%s resolves unknown ownership, warns once, and drops saved state",
    async (end) => {
      const { manager, timer, writes } = await harness();
      const recovery = Promise.withResolvers<void>();
      const reowner = new ManagedExecutionReowner({
        registry: async () => {
          throw new Error("recovery has not published");
        },
        owner: () => ({ daemonId: "test", pid: 1 }),
        timer,
        deviceOf: () => DEVICE,
      });
      reowner.noteRecovering(SESSION, recovery.promise);
      manager.setReleaseDeviceHold((id) => reowner.releaseDeviceHold(id));
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const release = manager.releaseSession(SESSION);
        await drainMicrotasks(30);
        expect(writes).toEqual([]);
        if (end === "cap") {
          timer.advanceTime(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS);
        } else {
          reowner.close();
        }
        await release;
        reowner.close();
        await reowner.whenIdle();
        expect(writes).toEqual([]);
        expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
        expect(reowner.isReleaseHeld(SESSION)).toBe(false);
        const drops = warn.mock.calls.filter(([message]) =>
          String(message).includes("ownership could not be confirmed"),
        );
        expect(drops).toHaveLength(1);
        expect(drops[0][0]).toContain(SESSION);
        expect(drops[0][0]).toContain(DEVICE);
        expect(drops[0][0]).toContain(
          "saved device state was dropped because ownership could not be confirmed",
        );
        expect(timer.getPendingTimeouts()).toEqual([]);
      } finally {
        warn.mockRestore();
        reowner.close();
        recovery.resolve();
      }
    },
  );

  test("retry hint includes the remaining hold and resets at confirmation without moving startedAtMs", async () => {
    const { manager, timer, behavior } = await harness();
    const hold = Promise.withResolvers<"teardown" | "skip-device-writes">();
    const teardown = Promise.withResolvers<void>();
    behavior.gate = teardown.promise;
    manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 10_000 }));
    const release = manager.releaseSession(SESSION, "daemon-shutdown");
    const base = SESSION_RELEASE_TEARDOWN_CAP_MS + SESSION_RELEASE_PERSIST_TIMEOUT_MS;
    timer.advanceTime(1_200);
    expect(manager.getDeviceCleanupRetryAfterMs(DEVICE)).toBe(8_800 + base);
    expect(manager.getNonTerminalReleasesInProgress()[0].startedAtMs).toBe(1_000);
    hold.resolve("teardown");
    await drainMicrotasks(40);
    expect(manager.getDeviceCleanupRetryAfterMs(DEVICE)).toBe(base);
    timer.advanceTime(300);
    expect(manager.getDeviceCleanupRetryAfterMs(DEVICE)).toBe(base - 300);
    expect(manager.isReleaseInProgress(SESSION, 1_000)).toBe(true);
    teardown.resolve();
    await release;
  });

  test("ordinary release keeps its original hint and synchronous teardown path", async () => {
    const { manager, timer, behavior, writes } = await harness();
    const teardown = Promise.withResolvers<void>();
    behavior.gate = teardown.promise;
    let resolves = 0;
    manager.setReleaseDeviceHold(() => {
      resolves++;
      return undefined;
    });
    const release = manager.releaseSession(SESSION);
    const base = SESSION_RELEASE_TEARDOWN_CAP_MS + SESSION_RELEASE_PERSIST_TIMEOUT_MS;
    expect(manager.getDeviceCleanupRetryAfterMs(DEVICE)).toBe(base);
    timer.advanceTime(700);
    expect(manager.getDeviceCleanupRetryAfterMs(DEVICE)).toBe(base - 700);
    teardown.resolve();
    await release;
    expect(resolves).toBe(1);
    expect(writes).toEqual([
      "keep-awake",
      "biometric",
      "network",
      "clock",
      "rotation",
      "screen-reader",
    ]);
  });

  test("a reap hiding its live lease still consults the recorded ownership mark", async () => {
    const { manager, timer, writes } = await harness();
    let held = true;
    const reowner = new ManagedExecutionReowner({
      registry: async () => {
        throw new Error("SQLITE_BUSY");
      },
      owner: () => ({ daemonId: "test", pid: 1 }),
      timer,
      isSessionHeld: () => held,
      deviceOf: () => DEVICE,
    });
    try {
      await reowner.reown([SESSION], { rehydrated: true });
      held = false;
      manager.setReleaseDeviceHold((id) => reowner.releaseDeviceHold(id));
      const release = manager.releaseSession(SESSION, "heartbeat-timeout", true);
      await drainMicrotasks(30);
      expect(reowner.isReleaseHeld(SESSION)).toBe(true);
      expect(writes).toEqual([]);
      reowner.close();
      await release;
      expect(writes).toEqual([]);
      expect(manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
    } finally {
      reowner.close();
      await reowner.whenIdle();
    }
  });
});
