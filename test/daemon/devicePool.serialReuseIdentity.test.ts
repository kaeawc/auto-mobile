import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logger, LogLevel } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  isTerminalReleaseReason,
  sessionReleaseReasonTraits,
} from "../../src/daemon/releaseReasons";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { warmedTests } from "../helpers/warmedTests";

const warmedTest = warmedTests(() => {});

// Membership and session semantics do not need real file logging.
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
const replacement = { ...original, name: "AVD-B", observedAt: 10 };
const placeholder = { ...original, name: "Unknown (emulator-5554)", observedAt: 5 };

async function setup(device: BootedDevice = original, knownAvd = false) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  sessions.stopCleanupTimer();
  const manager = new FakeDeviceManager([], [device]);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon-test", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  if (knownAvd) {
    await pool.addDevice(device, { ...device, source: "local", isRunning: true });
  } else {
    await pool.initializeWithDevices([device]);
  }
  const entry = pool.getDevice(device.deviceId)!;
  return { timer, sessions, persistence, manager, pool, entry };
}

test("sub-threshold absence and an unreadable console preserve the pooled incarnation", async () => {
  const h = await setup();
  try {
    h.manager.bootedDevices = [];
    await h.pool.reconcileDiscoveryObservation([], "disconnect-monitor", {
      settleMembership: true,
    });
    await h.pool.reconcileDiscoveryObservation([], "disconnect-monitor", {
      settleMembership: true,
    });
    h.manager.bootedDevices = [placeholder];
    await h.pool.reconcileDiscoveryObservation([placeholder], "disconnect-monitor", {
      settleMembership: true,
    });
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.entry.incarnation).toBe(1);
    expect(h.entry).toMatchObject({ name: "AVD-A", sessionId: null, identityUnresolved: true });
    expect(h.manager.startedDevices).toHaveLength(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("a resolved different AVD replaces the incarnation after an unreadable console", async () => {
  const h = await setup();
  try {
    await h.pool.reconcileDiscoveryObservation([placeholder], "disconnect-monitor", {
      settleMembership: true,
    });
    h.manager.bootedDevices = [replacement];
    await h.pool.reconcileDiscoveryObservation([replacement], "disconnect-monitor", {
      settleMembership: true,
    });
    const current = h.pool.getDevice(original.deviceId)!;
    expect(current).not.toBe(h.entry);
    expect(current.incarnation).not.toBe(h.entry.incarnation);
    expect(current).toMatchObject({ name: "AVD-B", status: "idle", sessionId: null });
    expect(current.identityUnresolved).not.toBe(true);
    expect(h.manager.startedDevices).toHaveLength(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("resolved disagreement without membership opt-in only quarantines the same incarnation", async () => {
  const h = await setup();
  try {
    const incarnation = h.entry.incarnation;
    await h.pool.reconcileDiscoveryObservation([replacement], "disconnect-monitor");
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.entry.incarnation).toBe(incarnation);
    expect(h.entry).toMatchObject({ name: "AVD-A", identityUnresolved: true });
    expect(h.manager.startedDevices).toHaveLength(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

warmedTest("fresh settlement replaces a resolved unheld identity", async () => {
  const h = await setup();
  try {
    h.manager.bootedDevices = [replacement];
    expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
    const current = h.pool.getDevice(original.deviceId)!;
    expect(current).not.toBe(h.entry);
    expect(current.incarnation).not.toBe(h.entry.incarnation);
    expect(current.name).toBe("AVD-B");
    expect(current.sessionId).toBeNull();
    expect(
      h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "rival" }),
    ).toBeUndefined();
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

for (const evidence of ["placeholder", "failure", "absent"] as const) {
  test(`fresh settlement leaves ${evidence} evidence unsettled`, async () => {
    const h = await setup();
    try {
      h.manager.bootedDevices = evidence === "absent" ? [] : [placeholder];
      if (evidence === "failure") {
        h.manager.failedPlatforms.add("android");
      }
      expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("unsettled");
      expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
      expect(h.entry.name).toBe("AVD-A");
      expect(h.entry.identityUnresolved).not.toBe(true);
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });
}

for (const path of ["monitor", "fresh settlement", "refresh"] as const) {
  warmedTest(`${path}: held serial reuse hands off A without holding B`, async () => {
    const h = await setup(original, true);
    const kill = spyOn(h.manager, "killDevice");
    try {
      await h.pool.bindOrReuseDeviceSession("holder", original.deviceId, "android");
      h.manager.bootedDevices = [replacement];
      if (path === "monitor") {
        await h.pool.reconcileDiscoveryObservation([replacement], "disconnect-monitor", {
          settleMembership: true,
        });
      } else if (path === "refresh") {
        await h.pool.refreshDevices();
      } else {
        expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
      }
      expect(h.sessions.getSession("holder")).toBeNull();
      const row = (await h.persistence.getSession!("holder"))!;
      expect(row).toMatchObject({ status: "released", release_reason: "device-restart:AVD-A" });
      expect(isTerminalReleaseReason(row.release_reason!)).toBe(false);
      expect(
        h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "rival" }),
      ).toMatchObject({ sessionUuid: "holder", owned: false, restartHandoff: true });
      const owned = h.pool.restartReservationForStart("android", ["AVD-A"], {
        sessionUuid: "holder",
      })!;
      expect(owned.owned).toBe(true);
      expect(owned.retryAfterMs).toBeGreaterThan(0);
      expect(owned.retryAfterMs).toBeLessThanOrEqual(180_000);
      expect(
        h.pool.restartReservationForStart("android", ["AVD-B"], { sessionUuid: "rival" }),
      ).toBeUndefined();
      const current = h.pool.getDevice(original.deviceId)!;
      expect(current).not.toBe(h.entry);
      expect(current.incarnation).not.toBe(h.entry.incarnation);
      expect(current).toMatchObject({ name: "AVD-B", sessionId: null });
      expect(await h.pool.bindOrReuseDeviceSession("rival", original.deviceId, "android")).toBe(
        "rival",
      );
      expect(h.sessions.getSession("rival")?.assignedDevice).toBe(original.deviceId);
      expect(
        h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "holder" })?.owned,
      ).toBe(true);
      expect(h.manager.startedDevices).toHaveLength(0);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      h.pool.releaseDeviceClaimsForShutdown();
      h.sessions.stopCleanupTimer();
      h.timer.reset();
    }
  });
}

for (const idleMs of [600_000, 120_000]) {
  warmedTest(
    `settlement handoff expires at ${idleMs > 180_000 ? "recovery window" : "idle deadline"}`,
    async () => {
      const h = await setup();
      try {
        await h.pool.bindOrReuseDeviceSession("holder", original.deviceId, "android");
        const live = h.sessions.getSession("holder")!;
        live.expiresAt = h.timer.now() + idleMs;
        live.sessionTimeoutMs = idleMs;
        const row = (await h.persistence.getSession!("holder"))!;
        row.expires_at_ms = live.expiresAt;
        row.session_timeout_ms = idleMs;
        h.manager.bootedDevices = [replacement];
        expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
        const deadline = Math.min(idleMs, 180_000);
        h.timer.advanceTime(deadline - 1);
        await drainMicrotasks(40);
        expect(
          h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "holder" }),
        ).toBeDefined();
        h.timer.advanceTime(1);
        await drainMicrotasks(40);
        expect(row.release_reason).toBe(idleMs > 180_000 ? "restart-recovery-timeout" : "expired");
        expect(sessionReleaseReasonTraits(row.release_reason!).idle).toBe(idleMs < 180_000);
        await expect(h.sessions.admitIssuedSessionForAutomation("holder")).rejects.toMatchObject({
          release: {
            terminal: true,
            releaseReason: idleMs > 180_000 ? "restart-recovery-timeout" : "expired",
          },
        });
        expect(
          h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "holder" }),
        ).toBeUndefined();
        expect(h.pool.getDevice(original.deviceId)).toMatchObject({
          name: "AVD-B",
          sessionId: null,
        });
      } finally {
        h.pool.releaseDeviceClaimsForShutdown();
        h.sessions.stopCleanupTimer();
        h.timer.reset();
      }
    },
  );
}

warmedTest(
  "newer A confirmation supersedes an in-flight settlement release without a hold",
  async () => {
    const h = await setup();
    const gate = Promise.withResolvers<void>();
    const release = h.sessions.releaseSessionUnlessSuperseded.bind(h.sessions);
    const paused = spyOn(h.sessions, "releaseSessionUnlessSuperseded").mockImplementation(
      async (...args) => {
        await gate.promise;
        return release(...args);
      },
    );
    try {
      await h.pool.bindOrReuseDeviceSession("holder", original.deviceId, "android");
      const live = h.sessions.getSession("holder");
      h.manager.bootedDevices = [replacement];
      const pending = h.pool.settlePooledRuntimeIdentity(original.deviceId);
      await drainUntil(() => paused.mock.calls.length === 1, {
        description: "identity release in flight",
      });
      const inFlightHold = h.pool.restartReservationForStart("android", ["AVD-A"], {
        sessionUuid: "holder",
      });
      await h.pool.reconcileDiscoveryObservation(
        [{ ...original, observedAt: 20 }],
        "newer-confirmation",
      );
      gate.resolve();
      expect(await pending).toBe("unsettled");
      expect(h.sessions.getSession("holder")).toBe(live);
      expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
      expect(h.entry).toMatchObject({ name: "AVD-A", sessionId: "holder" });
      expect(h.entry.identityUnresolved).not.toBe(true);
      expect(
        h.pool.restartReservationForStart("android", ["AVD-A"], { sessionUuid: "holder" }),
      ).toBeUndefined();
      expect((await h.persistence.getSession!("holder"))?.status).toBe("active");
      expect(inFlightHold).toMatchObject({ owned: true, restartHandoff: true });
    } finally {
      gate.resolve();
      paused.mockRestore();
      h.pool.releaseDeviceClaimsForShutdown();
      h.sessions.stopCleanupTimer();
      h.timer.reset();
    }
  },
);

test("monitor leaves agreeing and older disagreeing evidence alone", async () => {
  const h = await setup();
  try {
    await h.pool.reconcileDiscoveryObservation([{ ...original, observedAt: 10 }], "test:newer");
    await h.pool.reconcileDiscoveryObservation(
      [{ ...original, observedAt: 10 }],
      "disconnect-monitor",
      {
        settleMembership: true,
      },
    );
    await h.pool.reconcileDiscoveryObservation(
      [{ ...replacement, observedAt: 9 }],
      "disconnect-monitor",
      {
        settleMembership: true,
      },
    );
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.entry).toMatchObject({ name: "AVD-A", identityObservedAt: 10 });
    expect(h.entry.identityUnresolved).not.toBe(true);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("fresh settlement is bounded by the request deadline without late replacement", async () => {
  const h = await setup();
  const gate =
    Promise.withResolvers<Awaited<ReturnType<FakeDeviceManager["getBootedDevicesDetailed"]>>>();
  const probe = spyOn(h.manager, "getBootedDevicesDetailed").mockImplementation(() => gate.promise);
  try {
    const pending = h.pool.settlePooledRuntimeIdentity(original.deviceId, { totalDeadlineMs: 100 });
    const refusal = pending.then(
      (value) => value,
      (error: unknown) => error,
    );
    await drainUntil(() => h.timer.getPendingTimeouts().includes(100), {
      description: "settlement deadline",
    });
    h.timer.advanceTime(100);
    expect(await refusal).toBe("unsettled");
    probe.mockRestore();
    h.manager.bootedDevices = [replacement];
    gate.resolve(await h.manager.getBootedDevicesDetailed("android"));
    await Promise.resolve();
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    probe.mockRestore();
    h.sessions.stopCleanupTimer();
  }
});

test("fresh settlement honours cancellation before membership changes", async () => {
  const h = await setup();
  const controller = new AbortController();
  try {
    controller.abort(new DOMException("cancel settlement", "AbortError"));
    h.manager.bootedDevices = [replacement];
    await expect(
      h.pool.settlePooledRuntimeIdentity(original.deviceId, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

const handset: BootedDevice = {
  deviceId: "R58M1234ABC",
  name: "Pixel 7",
  platform: "android",
  observedAt: 1,
};

for (const path of ["monitor", "fresh settlement"] as const) {
  warmedTest(
    `${path} preserves a held physical Android handset across name fallback and recovery`,
    async () => {
      const h = await setup(handset);
      try {
        await h.pool.bindOrReuseDeviceSession("handset-holder", handset.deviceId, "android");
        const incarnation = h.entry.incarnation;
        const holder = h.sessions.getSession("handset-holder");
        const discovery = spyOn(h.manager, "getBootedDevicesDetailed");
        try {
          for (const observation of [
            { ...handset, name: handset.deviceId, observedAt: 10 },
            { ...handset, observedAt: 20 },
          ]) {
            h.manager.bootedDevices = [observation];
            if (path === "monitor") {
              await h.pool.reconcileDiscoveryObservation([observation], "disconnect-monitor", {
                settleMembership: true,
              });
            } else {
              expect(await h.pool.settlePooledRuntimeIdentity(handset.deviceId)).toBe("unsettled");
            }
            expect(h.pool.getDevice(handset.deviceId)).toBe(h.entry);
            expect(h.entry.incarnation).toBe(incarnation);
            expect(h.entry.sessionId).toBe("handset-holder");
            expect(h.sessions.getSession("handset-holder")).toBe(holder);
            expect(holder?.assignedDevice).toBe(handset.deviceId);
            expect(
              h.pool.restartReservationForStart("android", [handset.name], {
                sessionUuid: "rival",
              }),
            ).toBeUndefined();
          }
          expect(discovery).not.toHaveBeenCalled();
        } finally {
          discovery.mockRestore();
        }
      } finally {
        h.sessions.stopCleanupTimer();
      }
    },
  );
}

test("fresh settlement re-checks serial reuse on the current entry after discovery", async () => {
  const h = await setup();
  const gate =
    Promise.withResolvers<Awaited<ReturnType<FakeDeviceManager["getBootedDevicesDetailed"]>>>();
  const discovery = spyOn(h.manager, "getBootedDevicesDetailed").mockImplementation(
    () => gate.promise,
  );
  try {
    const pending = h.pool.settlePooledRuntimeIdentity(original.deviceId);
    await drainUntil(() => discovery.mock.calls.length === 1, {
      description: "settlement discovery",
    });
    // Another pool update publishes non-reusable platform metadata while discovery is in flight.
    await h.pool.initializeWithDevices([{ ...original, platform: "ios" }]);
    const current = h.pool.getDevice(original.deviceId)!;
    const incarnation = current.incarnation;
    discovery.mockRestore();
    h.manager.bootedDevices = [replacement];
    gate.resolve(await h.manager.getBootedDevicesDetailed("android"));
    expect(await pending).toBe("unsettled");
    expect(h.pool.getDevice(original.deviceId)).toBe(current);
    expect(current.incarnation).toBe(incarnation);
    expect(current).toMatchObject({ platform: "ios", name: "AVD-A", sessionId: null });
  } finally {
    discovery.mockRestore();
    h.sessions.stopCleanupTimer();
  }
});

for (const pin of [
  "ios",
  "platform mismatch",
  "unresolved observation",
  "unresolved pooled identity",
  "quarantined pooled identity",
] as const) {
  warmedTest(
    `PIN: ${pin} keeps its existing held-entry outcome without a restart hold`,
    async () => {
      const device =
        pin === "ios"
          ? { ...original, platform: "ios" as const }
          : pin === "unresolved pooled identity"
            ? placeholder
            : original;
      const h = await setup(device);
      try {
        if (pin === "unresolved pooled identity") {
          await h.sessions.createSession("holder", device.deviceId, device.platform);
          h.entry.sessionId = "holder";
          h.entry.status = "assigned";
        } else {
          await h.pool.bindOrReuseDeviceSession(
            "holder",
            device.deviceId,
            device.platform,
            undefined,
            undefined,
            device,
          );
        }
        if (pin === "quarantined pooled identity") {
          await h.pool.reconcileDiscoveryObservation([placeholder], "unresolved-own-identity");
          expect(h.entry.identityUnresolved).toBe(true);
        }
        const observation =
          pin === "unresolved observation"
            ? placeholder
            : pin === "platform mismatch"
              ? { ...replacement, platform: "ios" as const }
              : { ...replacement, platform: device.platform };
        h.manager.bootedDevices = [observation];
        if (pin === "platform mismatch") {
          await h.pool.refreshDevices();
        } else {
          await h.pool.reconcileDiscoveryObservation([observation], "disconnect-monitor", {
            settleMembership: true,
          });
        }
        const terminal = pin === "platform mismatch" || pin === "quarantined pooled identity";
        if (terminal) {
          expect(h.sessions.getSession("holder")).toBeNull();
          const row = (await h.persistence.getSession!("holder"))!;
          expect(row.release_reason).toStartWith("device-disconnected:");
          expect(isTerminalReleaseReason(row.release_reason!)).toBe(true);
        } else {
          expect(h.sessions.getSession("holder")?.assignedDevice).toBe(device.deviceId);
          expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
        }
        expect(
          h.pool.restartReservationForStart("android", ["AVD-A", "AVD-B", device.name], {
            sessionUuid: "holder",
          }),
        ).toBeUndefined();
      } finally {
        h.pool.releaseDeviceClaimsForShutdown();
        h.sessions.stopCleanupTimer();
        h.timer.reset();
      }
    },
  );
}
