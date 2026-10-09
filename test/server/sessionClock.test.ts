import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { retireShutdownOwnership } from "../../src/server/deviceToolsShutdown";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  SessionManager,
  PLAN_AUTO_RELEASE_REASON,
  CLOCK_RESTORE_TIMEOUT_MS,
} from "../../src/daemon/sessionManager";
import { DeviceState } from "../../src/features/utility/DeviceState";
import {
  restoreDeviceClock,
  defaultDeviceClockRestoreRegistry,
  MAX_DEVICE_CLOCK_INSTANT_MS,
  type SetDeviceClockInput,
} from "../../src/features/utility/DeviceClock";
import { runSessionClockMutation } from "../../src/server/sessionClock";
import { FakeDeviceClockAdapter } from "../fakes/FakeDeviceClockAdapter";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const set: SetDeviceClockInput = { mode: "set", instant: "2030-01-01T00:00:00Z" };
const flush = async () => {
  for (let index = 0; index < 50; index++) {
    await Promise.resolve();
  }
};
function harness(adapter = new FakeDeviceClockAdapter()) {
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.parse("2026-10-01T12:34:56Z"));
  const invalidations: string[] = [];
  const dependencies = {
    hostClock: timer,
    invalidate: (deviceId: string) => {
      invalidations.push(deviceId);
    },
  };
  const restoreSignals: Array<AbortSignal | undefined> = [];
  const restored: Array<{ deviceId: string; value: 0 | 1 }> = [];
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: async () => {} }),
    () => ({ restore: async () => {} }),
    {
      networkCondition: () => ({ restore: async () => {} }),
      clock: (target) => ({
        restore: async (value, signal) => {
          restoreSignals.push(signal);
          restored.push({ deviceId: target.deviceId, value: value.initialAutomaticTime });
          const result = await restoreDeviceClock(target, adapter, value, dependencies);
          if (!result.verified) {
            throw new Error(result.error);
          }
        },
      }),
    },
  );
  const state = new DeviceState(device, {
    timer,
    clockAdapter: adapter,
    invalidateClockCaches: dependencies.invalidate,
    clockMutation: (mutation) =>
      runSessionClockMutation(manager, "clock-session", device.deviceId, mutation),
  });
  return { timer, restored, manager, state, adapter, invalidations, restoreSignals, dependencies };
}

describe("session clock restoration", () => {
  beforeEach(() => defaultDeviceClockRestoreRegistry.retire(device.deviceId));
  afterEach(() => defaultDeviceClockRestoreRegistry.retire(device.deviceId));

  test("old device restore preserves the rebound session's replacement clock baseline", async () => {
    const h = harness();
    try {
      const session = await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      const original = session.cacheData.clock!;
      defaultDeviceClockRestoreRegistry.restored(device.deviceId, original);
      expect(session.cacheData.clock).toBeUndefined();

      await h.state.setState({ clock: { mode: "advance", byMs: 1000 } });
      const oldBaseline = session.cacheData.clock!;
      const replacement = { ...oldBaseline, initialAutomaticTime: 1 as const };
      // Rebind preserves the Session object while replacing its device cache.
      session.assignedDevice = "emulator-5556";
      session.cacheData = { clock: replacement };
      // The old device's timed-out restore succeeds after the replacement records its baseline.
      defaultDeviceClockRestoreRegistry.restored(device.deviceId, oldBaseline);
      expect(session.cacheData.clock).toBe(replacement);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test.each(["sessionless", "mixed", "two sessions"])(
    "device queue adds concurrent advances across %s callers",
    async (callers) => {
      const h = harness();
      const second = new DeviceState(device, {
        timer: h.timer,
        clockAdapter: h.adapter,
        clockMutation: (mutation) =>
          runSessionClockMutation(
            callers === "two sessions" ? h.manager : undefined,
            callers === "two sessions" ? "second-session" : undefined,
            device.deviceId,
            mutation,
          ),
      });
      const first = callers === "sessionless" ? second : h.state;
      const start = h.adapter.instantMs;
      try {
        await h.manager.createSession("clock-session", device.deviceId, "android");
        await h.manager.createSession("second-session", device.deviceId, "android");
        const results = await Promise.all([
          first.setState({ clock: { mode: "advance", byMs: 60_000 } }),
          second.setState({ clock: { mode: "advance", byMs: 60_000 } }),
        ]);
        expect(results.every((result) => result.clock?.verified)).toBe(true);
        expect(h.adapter.instantMs).toBe(start + 120_000);
      } finally {
        h.manager.stopCleanupTimer();
      }
    },
  );

  test.each(["sessionless first", "session first"])(
    "mixed ownership inherits original auto time and root (%s)",
    async (order) => {
      const h = harness();
      const sessionless = new DeviceState(device, { timer: h.timer, clockAdapter: h.adapter });
      try {
        await h.manager.createSession("clock-session", device.deviceId, "android");
        const states =
          order === "sessionless first" ? [sessionless, h.state] : [h.state, sessionless];
        await states[0].setState({ clock: set });
        h.adapter.rootedByUs = false;
        await states[1].setState({ clock: { mode: "advance", byMs: 1000 } });
        expect(h.manager.getClock("clock-session")).toMatchObject({
          initialAutomaticTime: 1,
          rootedByUs: true,
        });
        expect(defaultDeviceClockRestoreRegistry.slot(device.deviceId).get()).toMatchObject({
          initialAutomaticTime: 1,
          rootedByUs: true,
        });
        await h.manager.releaseSession("clock-session");
        expect(h.adapter.automaticTime).toBe(1);
        expect(h.adapter.instantMs).toBe(h.timer.now());
        expect(defaultDeviceClockRestoreRegistry.slot(device.deviceId).get()).toBeDefined();
        await sessionless.setState({ clock: { mode: "reset" } });
        expect(defaultDeviceClockRestoreRegistry.slot(device.deviceId).get()).toBeUndefined();
      } finally {
        h.manager.stopCleanupTimer();
      }
    },
  );

  test("late setup settles within the drain bound while failed restore retries in background", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class LateSetup extends FakeDeviceClockAdapter {
      override async ensureRoot() {
        started.resolve();
        await finish.promise;
        return super.ensureRoot();
      }
      override async setInstantMs(value: number) {
        if (value < Date.parse("2030-01-01T00:00:00Z")) {
          throw new Error("restore unavailable");
        }
        await super.setInstantMs(value);
      }
    }
    const h = harness(new LateSetup());
    let settled = false;
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      const changing = h.state.setState({ clock: set }).then(() => {
        settled = true;
      });
      await started.promise;
      let released = false;
      const release = h.manager.releaseSession("clock-session").then(() => {
        released = true;
      });
      await flush();
      h.timer.advanceTime(1000);
      await flush();
      expect(released).toBe(true);
      await release;
      finish.resolve();
      await flush();
      h.timer.advanceTime(1000);
      await flush();
      expect(settled).toBe(true);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
      h.manager.retireClockRestoration(device.deviceId);
      await changing;
    } finally {
      finish.resolve();
      h.manager.retireClockRestoration(device.deviceId);
      h.timer.advanceTime(1000);
      await flush();
      h.manager.stopCleanupTimer();
    }
  });

  test("duplicate clock restoration joins one pending promise and removal stops retries", async () => {
    const h = harness();
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      h.adapter.writeError = new Error("restore unavailable");
      const session = h.manager.getSession("clock-session")!;
      const first = await h.manager["getPendingClockRestoration"](session, null);
      const second = await h.manager["getPendingClockRestoration"](session, null);
      expect(second.pending).toBe(first.pending);
      expect(h.restored).toHaveLength(1);
      h.manager.retireClockRestoration(device.deviceId);
      expect(h.restoreSignals.every((signal) => signal?.aborted)).toBe(true);
      const calls = h.adapter.calls.length;
      h.timer.advanceTime(1000);
      await flush();
      expect(h.adapter.calls).toHaveLength(calls);
      await Promise.all([first.pending, second.pending]);
    } finally {
      h.manager.retireClockRestoration(device.deviceId);
      h.timer.advanceTime(1000);
      await flush();
      h.manager.stopCleanupTimer();
    }
  });

  test("retirement cancels every distinct restore state on the same device", async () => {
    const h = harness();
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.manager.createSession("second-session", device.deviceId, "android");
      h.manager.setClock(h.manager.getSession("clock-session")!, {
        initialAutomaticTime: 1,
        clockChangedByUs: true,
        rootedByUs: true,
      });
      h.manager.setClock(h.manager.getSession("second-session")!, {
        initialAutomaticTime: 0,
        clockChangedByUs: true,
        rootedByUs: false,
      });
      h.adapter.writeError = new Error("restore unavailable");
      const first = await h.manager["getPendingClockRestoration"](
        h.manager.getSession("clock-session")!,
        null,
      );
      const second = await h.manager["getPendingClockRestoration"](
        h.manager.getSession("second-session")!,
        null,
      );
      h.manager.retireClockRestoration(device.deviceId);
      expect(h.restoreSignals).toHaveLength(2);
      expect(h.restoreSignals.every((signal) => signal?.aborted)).toBe(true);
      const calls = h.adapter.calls.length;
      h.timer.advanceTime(1000);
      await flush();
      expect(h.adapter.calls).toHaveLength(calls);
      await Promise.all([first.pending, second.pending]);
    } finally {
      h.manager.retireClockRestoration(device.deviceId);
      h.timer.advanceTime(1000);
      await flush();
      h.manager.stopCleanupTimer();
    }
  });

  test("pool removal cancels a sessionless mutation before replacement serial writes", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class DelayedRoot extends FakeDeviceClockAdapter {
      override async ensureRoot() {
        started.resolve();
        await finish.promise;
        return super.ensureRoot();
      }
    }
    const h = harness(new DelayedRoot());
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "clock-idle-removal", { timer: h.timer }),
    );
    const state = new DeviceState(device, { timer: h.timer, clockAdapter: h.adapter });
    try {
      await pool.initializeWithDevices([device]);
      const changing = state.setState({ clock: set });
      await started.promise;
      await pool.removeDevice(device.deviceId);
      await pool.initializeWithDevices([device]);
      finish.resolve();
      const result = await changing;
      expect(result.clock?.verified).toBe(false);
      expect(
        h.adapter.calls.some((call) => call.startsWith("auto:") || call.startsWith("instant:")),
      ).toBe(false);
      expect(defaultDeviceClockRestoreRegistry.slot(device.deviceId).get()).toBeUndefined();
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });

  test("queued advance bounds reject before combined biometric mutation", async () => {
    const h = harness();
    h.adapter.instantMs = MAX_DEVICE_CLOCK_INSTANT_MS - 1000;
    const biometrics = spyOn(h.state, "setBiometricEnrollmentState");
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      const results = await Promise.allSettled([
        h.state.setState({ clock: { mode: "advance", byMs: 1000 } }),
        h.state.setState({
          clock: { mode: "advance", byMs: 1000 },
          biometrics: { enrollment: "enrolled" },
        }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(biometrics).not.toHaveBeenCalled();
      expect(h.adapter.instantMs).toBe(MAX_DEVICE_CLOCK_INSTANT_MS);
      expect(h.invalidations).toEqual([device.deviceId]);
    } finally {
      biometrics.mockRestore();
      h.manager.stopCleanupTimer();
    }
  });

  test("device removal retires sessionless clock ownership through the existing hook", async () => {
    const h = harness();
    const state = new DeviceState(device, {
      clockAdapter: h.adapter,
      timer: h.timer,
      invalidateClockCaches: h.dependencies.invalidate,
    });
    try {
      await state.setState({ clock: set });
      expect(defaultDeviceClockRestoreRegistry.slot(device.deviceId).get()?.rootedByUs).toBe(true);
      h.manager.retireClockRestoration(device.deviceId);
      expect(defaultDeviceClockRestoreRegistry.slot(device.deviceId).get()).toBeUndefined();
      h.adapter.rootedByUs = false;
      await state.setState({ clock: { mode: "reset" } });
      expect(h.adapter.calls).not.toContain("unroot");
    } finally {
      defaultDeviceClockRestoreRegistry.retire(device.deviceId);
      h.manager.stopCleanupTimer();
    }
  });

  test("concurrent advances recompute device time inside the session queue", async () => {
    const h = harness();
    const start = h.adapter.instantMs;
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      const results = await Promise.all([
        h.state.setState({ clock: { mode: "advance", byMs: 60_000 } }),
        h.state.setState({ clock: { mode: "advance", byMs: 60_000 } }),
      ]);
      expect(results.every((result) => result.clock?.verified)).toBe(true);
      expect(h.adapter.instantMs).toBe(start + 120_000);
      expect(h.invalidations).toEqual([device.deviceId, device.deviceId]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("non-terminal release without a clock slot keeps the no-restore microtask budget and never quarantines", async () => {
    const h = harness();
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      let releasedDevice: string | null | undefined;
      const releasing = h.manager
        .releaseSession("clock-session", PLAN_AUTO_RELEASE_REASON)
        .then((deviceId) => {
          releasedDevice = deviceId;
        });
      // Measured against HEAD~1 using these same persistence and timer fakes; one more tick
      // since the release write races its deadline (#10836).
      for (let tick = 0; tick < 9; tick++) {
        expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
        await Promise.resolve();
      }
      expect(releasedDevice).toBe(device.deviceId);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(h.manager.getSession("clock-session")).toBeNull();
      expect(h.restored).toEqual([]);
      expect(h.adapter.calls).toEqual([]);
      await releasing;
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test.each([0, 1] as const)(
    "release restores original auto time %s exactly once after repeated set and advance",
    async (value) => {
      const h = harness();
      h.adapter.automaticTime = value;
      try {
        await h.manager.createSession("clock-session", device.deviceId, "android");
        await h.state.setState({ clock: set });
        await h.state.setState({ clock: set });
        await h.state.setState({ clock: { mode: "advance", byMs: 1000 } });
        expect(h.manager.getClock("clock-session")).toEqual({
          initialAutomaticTime: value,
          clockChangedByUs: true,
          rootedByUs: true,
        });
        // One baseline read plus one read-back per mutation.
        expect(h.adapter.calls.filter((call) => call === "readAuto")).toHaveLength(4);
        await Promise.all([
          h.manager.releaseSession("clock-session"),
          h.manager.releaseSession("clock-session"),
        ]);
        await h.manager.releaseSession("clock-session");
        expect(h.restored).toEqual([{ deviceId: device.deviceId, value }]);
        expect(h.adapter.automaticTime).toBe(value);
        expect(h.adapter.instantMs).toBe(Math.floor(h.timer.now() / 1000) * 1000);
        expect(h.invalidations).toHaveLength(3);
      } finally {
        h.manager.stopCleanupTimer();
      }
    },
  );
  test("device teardown retires ownership and restores exactly once", async () => {
    const h = harness();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "clock-daemon", { timer: h.timer, deviceManager }),
    );
    const daemon = DaemonState.getInstance();
    daemon.initialize(h.manager, pool);
    try {
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("clock-session", "android");
      const session = h.manager.getSession("clock-session")!;
      const pooled = pool.getDevice(device.deviceId)!;
      await h.state.setState({ clock: set });
      deviceManager.setBootedDevices("android", []);
      const context = {
        device,
        expectedPooledDevice: pooled,
        expectedSession: session,
        deviceManager,
        timer: h.timer,
        deadlineMs: h.timer.now() + 10_000,
        requestAbortSignal: undefined,
        stopPerformanceMonitoring: () => {},
        retainReservationUntil: () => {},
      };
      await retireShutdownOwnership(context, undefined, true, { skipAndroidNameEnrichment: true });
      await retireShutdownOwnership(context, undefined, true, { skipAndroidNameEnrichment: true });
      expect(h.restored).toEqual([{ deviceId: device.deviceId, value: 1 }]);
      expect(h.adapter.instantMs).toBe(Math.floor(h.timer.now() / 1000) * 1000);
      expect(h.invalidations).toEqual([device.deviceId, device.deviceId]);
      expect(h.manager.getSession("clock-session")).toBeNull();
      expect(pool.getDevice(device.deviceId)).toBeNull();
      expect(pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    } finally {
      daemon.reset();
      h.manager.stopCleanupTimer();
    }
  });
  test("rebind restores the old device and the new slot is empty", async () => {
    const h = harness();
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      await h.manager.rebindSession("clock-session", "emulator-5556", "android");
      expect(h.restored).toEqual([{ deviceId: device.deviceId, value: 1 }]);
      expect(h.adapter.instantMs).toBe(Math.floor(h.timer.now() / 1000) * 1000);
      expect(h.invalidations).toEqual([device.deviceId, device.deviceId]);
      expect(h.manager.getClock("clock-session")).toBeUndefined();
      expect((await h.state.setState({ clock: set })).clock?.error).toContain("rebound");
      await h.manager.releaseSession("clock-session");
      expect(h.restored).toHaveLength(1);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("reset restores original off value, clears slot, and release does not restore again", async () => {
    const h = harness();
    h.adapter.automaticTime = 0;
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      expect((await h.state.setState({ clock: { mode: "reset" } })).clock?.automaticTime).toBe(
        false,
      );
      expect(h.manager.getClock("clock-session")).toBeUndefined();
      await h.manager.releaseSession("clock-session");
      expect(h.restored).toEqual([]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("reset with no slot enables automatic time", async () => {
    const h = harness();
    h.adapter.automaticTime = 0;
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      expect((await h.state.setState({ clock: { mode: "reset" } })).clock?.automaticTime).toBe(
        true,
      );
      expect(h.manager.getClock("clock-session")).toBeUndefined();
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("set after reset captures a new baseline", async () => {
    const h = harness();
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      await h.state.setState({ clock: { mode: "reset" } });
      h.adapter.automaticTime = 0;
      await h.state.setState({ clock: set });
      await h.manager.releaseSession("clock-session");
      expect(h.restored).toEqual([{ deviceId: device.deviceId, value: 0 }]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("restore slot is present before disabling auto time and release waits for mutation", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class DelayedAdapter extends FakeDeviceClockAdapter {
      override async setAutomaticTime(value: 0 | 1) {
        if (value === 0) {
          started.resolve();
          await finish.promise;
        }
        await super.setAutomaticTime(value);
      }
    }
    const h = harness(new DelayedAdapter());
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      const changing = h.state.setState({ clock: set });
      await started.promise;
      expect(h.manager.getClock("clock-session")).toEqual({
        initialAutomaticTime: 1,
        clockChangedByUs: true,
        rootedByUs: true,
      });
      const releasing = h.manager.releaseSession("clock-session");
      await flush();
      expect(h.restored).toEqual([]);
      finish.resolve();
      await changing;
      await releasing;
      expect(h.restored).toEqual([{ deviceId: device.deviceId, value: 1 }]);
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });
  test("a release timeout before baseline capture still defers restore until setup settles", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class DelayedAdapter extends FakeDeviceClockAdapter {
      override async ensureRoot() {
        started.resolve();
        await finish.promise;
        return super.ensureRoot();
      }
    }
    const h = harness(new DelayedAdapter());
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      const changing = h.state.setState({ clock: set });
      await started.promise;
      const releasing = h.manager.releaseSession("clock-session");
      await flush();
      h.timer.advanceTime(60_000);
      await flush();
      await releasing;
      expect(h.restored).toEqual([]);
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
      finish.resolve();
      await changing;
      await h.manager.getPendingDeviceCleanup(device.deviceId);
      expect(h.restored).toEqual([{ deviceId: device.deviceId, value: 1 }]);
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });
  test("concurrent sets capture once and serialize device writes", async () => {
    const h = harness();
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await Promise.all([h.state.setState({ clock: set }), h.state.setState({ clock: set })]);
      expect(h.adapter.calls.filter((call) => call.startsWith("instant:"))).toEqual([
        `instant:${Date.parse("2030-01-01T00:00:00Z")}`,
      ]);
      expect(h.manager.getClock("clock-session")?.initialAutomaticTime).toBe(1);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("root refusal records no restore slot", async () => {
    const h = harness();
    h.adapter.root = false;
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      expect((await h.state.setState({ clock: set })).clock?.supported).toBe(false);
      expect(h.manager.getClock("clock-session")).toBeUndefined();
      await h.manager.releaseSession("clock-session");
      expect(h.restored).toEqual([]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("a failed release restore keeps ownership and quarantines beyond the network retry batch until success", async () => {
    const h = harness();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "clock-quarantine", {
        timer: h.timer,
        deviceManager,
      }),
    );
    try {
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("clock-session", "android");
      await h.state.setState({ clock: set });
      const session = h.manager.getSession("clock-session")!;
      h.adapter.writeError = new Error("restore failed");
      await h.manager.releaseSession("clock-session");
      await pool.releaseDevice(device.deviceId, "clock-session");
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
      expect(session.cacheData.clock).toBeDefined();
      expect(pool.getDevice(device.deviceId)?.status).not.toBe("idle");
      expect(pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("clock");
      for (let attempt = 0; attempt < 5; attempt++) {
        h.timer.advanceTime(250);
        await flush();
      }
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
      expect(session.cacheData.clock).toBeDefined();
      h.adapter.writeError = undefined;
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      h.timer.advanceTime(250);
      await pending;
      await flush();
      expect(session.cacheData.clock).toBeUndefined();
      expect(pool.getDevice(device.deviceId)?.status).toBe("idle");
      expect(pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
      expect(h.adapter.instantMs).toBe(Math.floor(h.timer.now() / 1000) * 1000);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("device removal retires pending restoration without touching a replacement", async () => {
    const h = harness();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "clock-removal", { timer: h.timer, deviceManager }),
    );
    try {
      await pool.initializeWithDevices([device]);
      await pool.assignDeviceToSession("clock-session", "android");
      await h.state.setState({ clock: set });
      h.adapter.writeError = new Error("gone");
      await h.manager.releaseSession("clock-session");
      await pool.releaseDevice(device.deviceId, "clock-session");
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      // Model the ownership detachment performed after a proven device shutdown.
      pool.getDevice(device.deviceId)!.sessionId = null;
      await pool.removeDevice(device.deviceId);
      expect(h.restoreSignals.at(-1)?.aborted).toBe(true);
      const writes = h.adapter.calls.filter((call) => call.startsWith("instant:")).length;
      h.timer.advanceTime(250);
      await pending;
      expect(h.adapter.calls.filter((call) => call.startsWith("instant:"))).toHaveLength(writes);
      expect(pool.getDevice(device.deviceId)).toBeNull();
      expect(pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
  test("restore that waits for adbd to reconnect after unroot is not timed out or quarantined (#10771)", async () => {
    const reconnect = Promise.withResolvers<void>();
    class OfflineAfterUnroot extends FakeDeviceClockAdapter {
      override async unroot() {
        await super.unroot();
        await reconnect.promise;
      }
    }
    const h = harness(new OfflineAfterUnroot());
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      let released = false;
      const releasing = h.manager.releaseSession("clock-session").then(() => {
        released = true;
      });
      await flush();
      // Past the old 1s network deadline while the device is still offline.
      h.timer.advanceTime(5000);
      await flush();
      expect(released).toBe(false);
      reconnect.resolve();
      await releasing;
      expect(h.adapter.calls).toContain("unroot");
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
    } finally {
      reconnect.resolve();
      h.manager.stopCleanupTimer();
    }
  });
  test("slow restore failure remains quarantined and retries after its deadline", async () => {
    const start = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class SlowRestore extends FakeDeviceClockAdapter {
      override async setInstantMs(value: number) {
        if (value < Date.parse("2030-01-01T00:00:00Z")) {
          start.resolve();
          await finish.promise;
        }
        await super.setInstantMs(value);
      }
    }
    const h = harness(new SlowRestore());
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      await h.state.setState({ clock: set });
      h.adapter.writeError = new Error("slow failure");
      const releasing = h.manager.releaseSession("clock-session");
      await start.promise;
      h.timer.advanceTime(CLOCK_RESTORE_TIMEOUT_MS);
      await flush();
      await releasing;
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      expect(pending).not.toBeNull();
      finish.resolve();
      await flush();
      h.adapter.writeError = undefined;
      h.timer.advanceTime(250);
      await pending;
      expect(h.adapter.instantMs).toBe(Math.floor(h.timer.now() / 1000) * 1000);
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });
  test("removal during a timed-out setup skips restoration against a replacement serial", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    class DelayedSetup extends FakeDeviceClockAdapter {
      override async ensureRoot() {
        started.resolve();
        await finish.promise;
        return super.ensureRoot();
      }
    }
    const h = harness(new DelayedSetup());
    try {
      await h.manager.createSession("clock-session", device.deviceId, "android");
      const mutation = h.state.setState({ clock: set });
      await started.promise;
      const session = h.manager.getSession("clock-session")!;
      const release = h.manager.releaseSession("clock-session");
      await flush();
      h.timer.advanceTime(60_000);
      await flush();
      await release;
      const pending = h.manager.getPendingDeviceCleanup(device.deviceId);
      h.manager.retireClockRestoration(device.deviceId);
      finish.resolve();
      await mutation;
      await pending;
      expect(h.restored).toEqual([]);
      expect(session.cacheData.clock).toBeUndefined();
    } finally {
      finish.resolve();
      h.manager.stopCleanupTimer();
    }
  });
  test("sessionless mutation has no restore slot", async () => {
    let captured = false;
    await runSessionClockMutation(undefined, undefined, device.deviceId, async (slot) => {
      captured = slot !== undefined;
    });
    expect(captured).toBe(false);
  });
});
