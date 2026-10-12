import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { DeviceLockRepository } from "../../src/db/deviceLockRepository";
import { logger, LogLevel } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import { DevicePool } from "../../src/daemon/devicePool";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { fixedBackoff } from "../../src/utils/Backoff";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { registerNetworkStateSessionCleanup } from "../../src/server/networkStateSessionCleanup";
import { NetworkState } from "../../src/server/NetworkState";
import {
  registerLocationRouteSessionCleanup,
  LocationRouteRegistry,
} from "../../src/features/utility/LocationRoutePlayer";
import {
  deferHeldPlanAppCleanup,
  takeHeldPlanAppCleanup,
} from "../../src/server/heldPlanAppCleanup";
import { warmedTests } from "../helpers/warmedTests";

// Harness follows test/daemon/devicePool.serialReuseIdentity.test.ts.
const warmedTest = warmedTests(() => {});

let previousLogLevel: LogLevel;
beforeEach(() => {
  previousLogLevel = logger.getLogLevel();
  logger.setLogLevel(LogLevel.NONE);
});
afterEach(() => logger.setLogLevel(previousLogLevel));

const original: BootedDevice = {
  deviceId: "emulator-5554",
  name: "AVD-A",
  platform: "android",
  observedAt: 1,
};
/** A different AVD now answers on the serial the holder's emulator vacated. */
const stranger = { ...original, name: "AVD-B", observedAt: 10 };

async function setup(saved = true) {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const forget = spyOn(DeviceLockRepository.prototype, "forget").mockImplementation(async () => {});
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  /** Every device-state write the holder's release teardown sends, by serial. */
  const restores: string[] = [];
  const behavior: {
    rotationFails: boolean;
    failingKind: string;
    parkedKind: string;
    gate?: Promise<void>;
    started: boolean;
  } = { rotationFails: false, failingKind: "", parkedKind: "", started: false };
  const record = (kind: string) => (device: BootedDevice) => ({
    restore: async (_state: unknown, signal = getAbortSignal()) => {
      if (kind === behavior.parkedKind) {
        behavior.started = true;
        await behavior.gate;
        signal?.throwIfAborted();
      }
      restores.push(`${kind}:${device.deviceId}`);
      if ((kind === "rotation" && behavior.rotationFails) || kind === behavior.failingKind) {
        throw new Error("restore not confirmed");
      }
    },
  });
  const sessions = new SessionManager(
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
  sessions.stopCleanupTimer();
  const releases: Array<{ reason: string; identityReplaced: boolean }> = [];
  sessions.onSessionRelease((_id, _deviceId, reason, _snapshot, options) => {
    releases.push({ reason, identityReplaced: options.deviceIdentityReplaced === true });
  });
  const manager = new FakeDeviceManager([], [original]);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon-test", {
      timer,
      deviceManager: manager,
      emulatorLossIncidentStore: new InMemoryEmulatorLossIncidentStore(timer),
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  await pool.initializeWithDevices([original]);
  await pool.bindOrReuseDeviceSession("holder", original.deviceId, "android");
  const holder = sessions.getSession("holder")!;
  if (saved) {
    sessions.setKeepScreenAwake("holder", { applied: true, method: "settings" });
    sessions.setBiometricEnrollment("holder", { initialEnrollment: "not_enrolled" });
    sessions.setNetworkCondition("holder", { initialProfile: "none" });
    sessions.setClock(holder, {
      initialAutomaticTime: 1,
      clockChangedByUs: true,
      rootedByUs: true,
    });
    sessions.setRotation(holder, { accelerometerRotation: 1, userRotation: 0 });
    sessions.setScreenReader(holder, { platform: "android", previousEnabled: false });
  }
  const cleanup = () => {
    pool.releaseDeviceClaimsForShutdown();
    sessions.stopCleanupTimer();
    timer.reset();
    defaultDeviceClockRestoreRegistry.retire(original.deviceId);
    warn.mockRestore();
    forget.mockRestore();
  };
  return {
    timer,
    sessions,
    persistence,
    manager,
    pool,
    restores,
    releases,
    holder,
    warn,
    behavior,
    cleanup,
  };
}

warmedTest("control: an explicit release restores every saved kind", async () => {
  const h = await setup();
  try {
    await h.sessions.releaseSession("holder", "explicit-release");
    await drainMicrotasks(40);
    expect(h.restores).toEqual(allRestores);
    expect(h.releases[0]?.identityReplaced).toBe(false);
  } finally {
    h.cleanup();
  }
});

const allRestores = [
  "keep-awake",
  "biometric",
  "network",
  "clock",
  "rotation",
  "screen-reader",
].map((kind) => `${kind}:emulator-5554`);

for (const reason of ["device-restart:AVD-A", "device-disconnected:emulator-5554"] as const) {
  warmedTest(`${reason} without identity replacement retains ordinary teardown`, async () => {
    const h = await setup();
    try {
      await h.sessions.releaseSession("holder", reason);
      await drainMicrotasks(40);
      expect(h.restores).toEqual(allRestores);
      expect(h.releases[0]?.identityReplaced).toBe(false);
    } finally {
      h.cleanup();
    }
  });
}

for (const path of ["fresh settlement", "monitor", "refresh"] as const) {
  warmedTest(
    `${path}: the serial-reuse handoff writes none of the holder's saved state to the stranger`,
    async () => {
      const h = await setup();
      try {
        h.manager.bootedDevices = [stranger];
        if (path === "fresh settlement") {
          expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
        } else if (path === "monitor") {
          await h.pool.reconcileDiscoveryObservation([stranger], "disconnect-monitor", {
            settleMembership: true,
          });
        } else {
          await h.pool.refreshDevices();
        }
        await drainMicrotasks(40);
        // The handoff happened: the holder is released for restart recovery on AVD-A and the
        // serial is pooled as the unheld stranger.
        expect((await h.persistence.getSession!("holder"))?.release_reason).toBe(
          "device-restart:AVD-A",
        );
        expect(h.releases).toEqual([{ reason: "device-restart:AVD-A", identityReplaced: true }]);
        expect(
          h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "holder" })
            ?.restartHandoff,
        ).toBe(true);
        expect(h.pool.getDevice(original.deviceId)).toMatchObject({
          name: "AVD-B",
          sessionId: null,
        });
        // The pool settled the serial as AVD-B before it released the holder, so the holder's
        // saved AVD-A settings must not be written to emulator-5554.
        expect(h.restores).toEqual([]);
        expect(h.holder.cacheData).not.toHaveProperty("keepScreenAwake");
        for (const kind of [
          "biometricEnrollment",
          "networkCondition",
          "clock",
          "rotation",
          "screenReader",
        ]) {
          expect(h.holder.cacheData).not.toHaveProperty(kind);
        }
        const warnings = h.warn.mock.calls.filter(([message]) =>
          String(message).startsWith("Dropped restore state"),
        );
        expect(warnings).toHaveLength(1);
        const message = String(warnings[0]![0]);
        for (const value of [
          "holder",
          original.deviceId,
          "keep-awake",
          "biometric",
          "network-condition",
          "clock",
          "rotation",
          "screen-reader",
        ]) {
          expect(message).toContain(value);
        }
        await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
        expect(h.pool.getDevice(original.deviceId)?.sessionId).toBe("next");
        expect(h.restores).toEqual([]);
        // The fence retires A's work, while B's own later release still restores its baseline.
        const next = h.sessions.getSession("next")!;
        h.sessions.setKeepScreenAwake("next", { applied: true, method: "settings" });
        h.sessions.setBiometricEnrollment("next", { initialEnrollment: "not_enrolled" });
        h.sessions.setNetworkCondition("next", { initialProfile: "none" });
        h.sessions.setClock(next, {
          initialAutomaticTime: 1,
          clockChangedByUs: true,
          rootedByUs: true,
        });
        h.sessions.setRotation(next, { accelerometerRotation: 1, userRotation: 0 });
        h.sessions.setScreenReader(next, { platform: "android", previousEnabled: false });
        await h.sessions.releaseSession("next", "explicit-release");
        await drainMicrotasks(80);
        expect(h.restores).toEqual(allRestores);
        h.timer.advanceTime(240_000);
        await drainMicrotasks(80);
        expect(h.restores).toEqual(allRestores);
      } finally {
        h.cleanup();
      }
    },
  );
}

warmedTest("identity replacement with no saved state emits no warning", async () => {
  const h = await setup(false);
  try {
    h.manager.bootedDevices = [stranger];
    await h.pool.settlePooledRuntimeIdentity(original.deviceId);
    expect(h.restores).toEqual([]);
    expect(
      h.warn.mock.calls.filter(([message]) => String(message).startsWith("Dropped restore state")),
    ).toEqual([]);
  } finally {
    h.cleanup();
  }
});

warmedTest("serial reuse retires a previously abandoned rotation restore", async () => {
  const h = await setup(false);
  try {
    h.sessions.setRotation(h.holder, { accelerometerRotation: 1, userRotation: 0 });
    h.behavior.rotationFails = true;
    await h.sessions.releaseSession("holder");
    for (const delay of [250, 500, 1000, 2000, 2000]) {
      h.timer.advanceTime(delay);
      await drainMicrotasks(80);
    }
    await h.sessions.getPendingDeviceCleanup(original.deviceId);
    expect(h.restores).toHaveLength(6);
    await h.pool.releaseDevice(original.deviceId, "holder");
    await h.pool.bindOrReuseDeviceSession("handoff-holder", original.deviceId, "android");
    expect(h.restores).toHaveLength(7);
    h.behavior.rotationFails = false;
    h.restores.length = 0;
    h.warn.mockClear();
    h.manager.bootedDevices = [stranger];
    await h.pool.settlePooledRuntimeIdentity(original.deviceId);
    expect(h.restores).toEqual([]);
    expect(
      h.warn.mock.calls.filter(([message]) => String(message).startsWith("Dropped restore state")),
    ).toEqual([
      [
        "Dropped restore state for session handoff-holder on replaced serial emulator-5554: rotation",
      ],
    ]);
    await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
    h.timer.advanceTime(240_000);
    await drainMicrotasks(80);
    expect(h.restores).toEqual([]);
  } finally {
    h.cleanup();
  }
});

warmedTest("serial reuse waits for in-flight setup and drops its late saved state", async () => {
  const h = await setup();
  const gate = Promise.withResolvers<void>();
  try {
    const setup = h.sessions.trackSessionSetup(h.holder, async () => {
      await gate.promise;
      h.sessions.setRotation(h.holder, { accelerometerRotation: 1, userRotation: 2 });
    });
    h.manager.bootedDevices = [stranger];
    let settled = false;
    const settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId).then((result) => {
      settled = true;
      return result;
    });
    await drainMicrotasks(80);
    expect(settled).toBe(false);
    expect(h.restores).toEqual([]);
    gate.resolve();
    await setup;
    expect(await settlement).toBe("replaced");
    expect(h.holder.cacheData.rotation).toBeUndefined();
    expect(h.restores).toEqual([]);
    expect(
      h.warn.mock.calls.filter(([message]) => String(message).startsWith("Dropped restore state")),
    ).toHaveLength(1);
  } finally {
    gate.resolve();
    h.cleanup();
  }
});

warmedTest(
  "a newer AVD-A observation preserves restore state when handoff is superseded",
  async () => {
    const h = await setup();
    const gate = Promise.withResolvers<void>();
    try {
      const saved = structuredClone(h.holder.cacheData);
      const setup = h.sessions.trackSessionSetup(h.holder, () => gate.promise);
      h.manager.bootedDevices = [stranger];
      let settled = false;
      const settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId).then((result) => {
        settled = true;
        return result;
      });
      await drainMicrotasks(80);
      expect(settled).toBe(false);
      expect(h.sessions.getReleasingSession("holder")).toBe(h.holder);
      const newer = { ...original, observedAt: 20 };
      h.manager.bootedDevices = [newer];
      await h.pool.reconcileDiscoveryObservation([newer], "newer-A");
      gate.resolve();
      await setup;
      expect(await settlement).toBe("unsettled");
      expect(h.sessions.getSession("holder")).toBe(h.holder);
      expect(h.holder.assignedDevice).toBe(original.deviceId);
      expect(h.pool.getDevice(original.deviceId)).toMatchObject({
        name: "AVD-A",
        sessionId: "holder",
      });
      expect(h.restores).toEqual([]);
      expect(h.holder.cacheData).toEqual(saved);
      expect(Object.keys(saved).sort()).toEqual([
        "biometricEnrollment",
        "clock",
        "keepScreenAwake",
        "networkCondition",
        "rotation",
        "screenReader",
      ]);
      expect(
        h.warn.mock.calls.filter(([message]) =>
          String(message).startsWith("Dropped restore state"),
        ),
      ).toEqual([]);
      await h.sessions.releaseSession("holder", "explicit-release");
      await drainMicrotasks(40);
      expect(h.restores).toEqual(allRestores);
    } finally {
      gate.resolve();
      h.cleanup();
    }
  },
);

const retryKinds = ["clock", "rotation", "screen-reader"] as const;
const savedKeys = [
  "keepScreenAwake",
  "biometricEnrollment",
  "networkCondition",
  "clock",
  "rotation",
  "screenReader",
] as const;

for (const key of savedKeys) {
  warmedTest(`joined release skips ${key} after identity replacement`, async () => {
    const h = await setup();
    const gate = Promise.withResolvers<void>();
    try {
      for (const other of savedKeys) {
        if (other !== key) {
          delete h.holder.cacheData[other];
        }
      }
      const tracked = h.sessions.trackSessionSetup(h.holder, () => gate.promise);
      const release = h.sessions.releaseSession("holder", "explicit-release");
      await drainMicrotasks(40);
      h.manager.bootedDevices = [stranger];
      const settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId);
      await drainMicrotasks(80);
      gate.resolve();
      await tracked;
      await release;
      expect(await settlement).toBe("replaced");
      expect(h.restores).toEqual([]);
      expect(h.holder.cacheData[key]).toBeUndefined();
      expect(h.releases).toEqual([{ reason: "explicit-release", identityReplaced: true }]);
      expect(
        h.warn.mock.calls.filter(([message]) =>
          String(message).startsWith("Dropped restore state"),
        ),
      ).toHaveLength(1);
      await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
      h.timer.advanceTime(240_000);
      await drainMicrotasks(80);
      expect(h.restores).toEqual([]);
    } finally {
      gate.resolve();
      h.cleanup();
    }
  });
}

function startRetry(h: Awaited<ReturnType<typeof setup>>, kind: (typeof retryKinds)[number]) {
  if (kind === "clock") {
    return h.sessions["getPendingClockRestoration"](h.holder, null);
  }
  if (kind === "rotation") {
    return h.sessions["getPendingRotationRestoration"](h.holder, null);
  }
  return h.sessions["getPendingScreenReaderRestoration"](h.holder, null);
}

for (const kind of retryKinds) {
  for (const outcome of ["commit", "supersede", "control"] as const) {
    warmedTest(`${kind} scheduled retry: ${outcome} fences the handoff window`, async () => {
      const h = await setup();
      const gate = Promise.withResolvers<void>();
      try {
        const key = kind === "screen-reader" ? "screenReader" : kind;
        for (const other of savedKeys) {
          if (other !== key) {
            delete h.holder.cacheData[other];
          }
        }
        h.behavior.failingKind = kind;
        const retry = await startRetry(h, kind);
        expect(h.restores).toEqual([`${kind}:${original.deviceId}`]);
        h.restores.length = 0;
        h.behavior.failingKind = "";
        if (outcome === "control") {
          h.timer.advanceTime(1000);
          await drainMicrotasks(100);
          await retry.pending;
          expect(h.restores).toEqual([`${kind}:${original.deviceId}`]);
          return;
        }
        const tracked = h.sessions.trackSessionSetup(h.holder, () => gate.promise);
        h.manager.bootedDevices = [stranger];
        const settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId);
        await drainMicrotasks(80);
        h.timer.advanceTime(300);
        await drainMicrotasks(100);
        expect(h.releases).toEqual([]);
        expect(h.restores).toEqual([]);
        if (outcome === "supersede") {
          const newer = { ...original, observedAt: 20 };
          h.manager.bootedDevices = [newer];
          await h.pool.reconcileDiscoveryObservation([newer], "newer-A");
        }
        gate.resolve();
        await tracked;
        expect(await settlement).toBe(outcome === "commit" ? "replaced" : "unsettled");
        await drainMicrotasks(100);
        if (outcome === "supersede") {
          await h.sessions.releaseSession("holder", "explicit-release");
          await retry.pending;
          expect(h.restores).toEqual([`${kind}:${original.deviceId}`]);
        } else {
          h.timer.advanceTime(240_000);
          await drainMicrotasks(100);
          await retry.pending;
          expect(h.restores).toEqual([]);
          expect(h.holder.cacheData[key]).toBeUndefined();
          await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
        }
      } finally {
        gate.resolve();
        h.cleanup();
      }
    });
  }
}

for (const kind of ["keep-awake", "biometric", "network", ...retryKinds]) {
  for (const replaced of [true, false]) {
    warmedTest(`parked ${kind} dispatch with joined identity replacement=${replaced}`, async () => {
      const h = await setup();
      const gate = Promise.withResolvers<void>();
      try {
        h.behavior.parkedKind = kind;
        h.behavior.gate = gate.promise;
        const release = h.sessions.releaseSession("holder", "explicit-release");
        await drainMicrotasks(80);
        expect(h.behavior.started).toBe(true);
        const beforeJoin = [...h.restores];
        let settlement: Promise<unknown> | undefined;
        if (replaced) {
          h.manager.bootedDevices = [stranger];
          settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId);
          await drainMicrotasks(80);
        }
        gate.resolve();
        await release;
        if (settlement) {
          expect(await settlement).toBe("replaced");
        }
        await drainMicrotasks(80);
        expect(h.restores).toEqual(replaced ? beforeJoin : allRestores);
        expect(h.releases).toEqual([{ reason: "explicit-release", identityReplaced: replaced }]);
        if (replaced) {
          expect(savedKeys.every((key) => h.holder.cacheData[key] === undefined)).toBe(true);
          await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
          h.timer.advanceTime(240_000);
          await drainMicrotasks(100);
          expect(h.restores).toEqual(beforeJoin);
        }
      } finally {
        gate.resolve();
        h.cleanup();
      }
    });
  }
}

warmedTest(
  "settlement runs real listener host cleanup and immediately binds the stranger",
  async () => {
    const h = await setup();
    try {
      const state = new NetworkState({
        timer: h.timer,
        notifier: { notifyResourceUpdated: () => {} },
      });
      state.startSimulation(original.deviceId, "timeout", 30, null, "holder");
      registerNetworkStateSessionCleanup(h.sessions, {
        state: () => state,
        pusher: {
          push: async (serial) => {
            h.restores.push(`network-push:${serial}`);
          },
        },
      });
      const registry = new LocationRouteRegistry(h.timer);
      registerLocationRouteSessionCleanup(h.sessions, {
        registry,
        mockLocationClears: {
          markSet: () => {},
          clearLateSet: () => null,
          retireDevice: () => {},
          clearAfter: (_owner, serial) => {
            h.restores.push(`location-clear:${serial}`);
            return Promise.resolve();
          },
        },
      });
      registry.start(
        original.deviceId,
        [
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 1 },
        ],
        1000,
        500,
        true,
        async () => {
          h.restores.push(`location-fix:${original.deviceId}`);
        },
      );
      deferHeldPlanAppCleanup(
        h.sessions,
        "holder",
        async () => {
          h.restores.push(`app-cleanup:${original.deviceId}`);
        },
        1000,
      );
      h.manager.bootedDevices = [stranger];
      expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
      expect(h.restores).toEqual([]);
      expect(state.getSimulation(original.deviceId)).toBeNull();
      expect(registry.isActive(original.deviceId)).toBe(false);
      expect(takeHeldPlanAppCleanup(h.sessions, "holder")).toBeUndefined();
      expect(h.sessions.hasDeviceCleanupInProgress(original.deviceId)).toBe(false);
      await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
      h.timer.advanceTime(240_000);
      await drainMicrotasks(100);
      expect(h.restores).toEqual([]);
    } finally {
      h.cleanup();
    }
  },
);

for (const kind of ["rotation", "screen-reader"] as const) {
  for (const outcome of ["commit", "supersede", "control"] as const) {
    warmedTest(`queued abandoned ${kind} retry: ${outcome}`, async () => {
      const h = await setup();
      const own = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      try {
        h.behavior.failingKind = kind;
        await startRetry(h, kind);
        for (const delay of [250, 500, 1000, 2000, 2000]) {
          h.timer.advanceTime(delay);
          await drainMicrotasks(80);
        }
        expect(h.restores).toHaveLength(kind === "rotation" ? 6 : 3);
        const abandoned =
          kind === "rotation"
            ? h.sessions["abandonedRotations"]
            : h.sessions["abandonedScreenReaders"];
        expect(abandoned.has(original.deviceId)).toBe(true);
        h.behavior.failingKind = "";
        h.restores.length = 0;
        const retry =
          kind === "rotation"
            ? h.sessions["retryAbandonedRotationAfter"](original.deviceId, own.promise)
            : h.sessions["retryAbandonedScreenReaderAfter"](original.deviceId, own.promise);
        if (outcome === "control") {
          own.resolve();
          await retry;
          expect(h.restores).toEqual([`${kind}:${original.deviceId}`]);
          return;
        }
        const tracked = h.sessions.trackSessionSetup(h.holder, () => gate.promise);
        h.manager.bootedDevices = [stranger];
        const settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId);
        await drainMicrotasks(80);
        own.resolve();
        h.timer.advanceTime(300);
        await drainMicrotasks(100);
        expect(h.releases).toEqual([]);
        expect(h.restores).toEqual([]);
        expect(abandoned.has(original.deviceId)).toBe(true);
        if (outcome === "supersede") {
          const newer = { ...original, observedAt: h.timer.now() + 20 };
          h.manager.bootedDevices = [newer];
          await h.pool.reconcileDiscoveryObservation([newer], "newer-A");
        }
        gate.resolve();
        await tracked;
        expect(await settlement).toBe(outcome === "commit" ? "replaced" : "unsettled");
        await retry;
        expect(h.restores).toEqual(outcome === "commit" ? [] : [`${kind}:${original.deviceId}`]);
        if (outcome === "commit") {
          h.timer.advanceTime(240_000);
          await drainMicrotasks(100);
          expect(h.restores).toEqual([]);
          expect(abandoned.has(original.deviceId)).toBe(false);
          await h.pool.bindOrReuseDeviceSession("next", original.deviceId, "android");
        }
      } finally {
        own.resolve();
        gate.resolve();
        h.cleanup();
      }
    });
  }
}

for (const reason of ["keep-screen-awake", "biometric-enrollment", "network-condition"] as const) {
  for (const outcome of ["commit", "supersede", "control"] as const) {
    warmedTest(`${reason} health recovery: ${outcome} preserves the serial fence`, async () => {
      const h = await setup(false);
      const gate = Promise.withResolvers<void>();
      try {
        const markers = new InMemoryDeviceHealthMarkers(h.timer);
        h.sessions.setDeviceHealthMarkers(
          markers,
          () => 1,
          () => true,
          fixedBackoff(250),
        );
        h.sessions["abandonRestore"](
          { deviceId: original.deviceId, incarnation: 1 },
          reason,
          async () => {
            h.restores.push(`${reason}:${original.deviceId}`);
          },
        );
        if (outcome === "control") {
          h.timer.advanceTime(300);
          await drainMicrotasks(100);
          expect(h.restores).toEqual([`${reason}:${original.deviceId}`]);
          return;
        }
        const tracked = h.sessions.trackSessionSetup(h.holder, () => gate.promise);
        h.manager.bootedDevices = [stranger];
        const settlement = h.pool.settlePooledRuntimeIdentity(original.deviceId);
        await drainMicrotasks(80);
        h.timer.advanceTime(300);
        await drainMicrotasks(100);
        expect(h.releases).toEqual([]);
        expect(h.restores).toEqual([]);
        if (outcome === "supersede") {
          const newer = { ...original, observedAt: 20 };
          h.manager.bootedDevices = [newer];
          await h.pool.reconcileDiscoveryObservation([newer], "newer-A");
        }
        gate.resolve();
        await tracked;
        expect(await settlement).toBe(outcome === "commit" ? "replaced" : "unsettled");
        h.timer.advanceTime(240_000);
        await drainMicrotasks(100);
        expect(h.restores).toEqual(outcome === "commit" ? [] : [`${reason}:${original.deviceId}`]);
      } finally {
        gate.resolve();
        h.cleanup();
      }
    });
  }
}
