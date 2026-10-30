import { makePool } from "../helpers/makePool";
import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { StreamlessChildProcess } from "../helpers/streamlessChildProcess";
import { ActionableError } from "../../src/models/ActionableError";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
  type OpenEmulatorLossIncidentInput,
  type EmulatorLossRecoverySettlement,
  type EmulatorRecoveryOutcome,
} from "../../src/daemon/emulatorLossIncident";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import type { SessionSlots } from "../../src/daemon/sessionSlots";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  original,
  image,
  withRecoveryEnvUnset,
  LaggingShutdownManager,
  KillTrackingShutdownManager,
  setup,
  setupPassiveRestart,
  assertNoRecoveryReservationsRemain,
  flush,
} from "../helpers/devicePoolRecoveryShutdownHarness";

// These tests exercise the three-minute restart recovery window, which the idle deadline caps.
useSessionIdleWindowForSuite();

test("recovery waits for checked disappearance after an untracked emulator acknowledges kill", async () => {
  const { timer, sessions, manager, pool, captured } = await setup();
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterAdbServerReset(
      original.deviceId,
      captured,
    );
    await manager.killAccepted.promise;
    await flush();
    expect(manager.startedDevices).toHaveLength(0);
    expect(pool.getDevice(original.deviceId)).toBe(captured);
    manager.bootedDevices = [];
    timer.advanceTime(1_000);
    expect(await recovery).toBe(true);
    expect(manager.startedDevices).toHaveLength(1);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("onLoss recovery still actively relaunches an owned emulator and preserves its session", async () => {
  const manager = new LaggingShutdownManager(original.deviceId);
  const { timer, sessions, pool, captured } = await setup(manager);
  const originalSession = sessions.getSession("session");
  const originalConnectionId = `${captured.id}#${captured.incarnation}`;
  try {
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(recovery).resolves.toBe("recovered");
    expect(manager.startedDevices).toEqual([
      {
        name: original.name,
        platform: "android",
        isRunning: false,
        source: "local",
      },
    ]);
    const replacement = pool.getDevice(original.deviceId)!;
    expect(sessions.getSession("session")).toBe(originalSession);
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
      stableDeviceId: original.name,
      ownership: "owned",
    });
    expect(replacement).toMatchObject({ sessionId: "session", status: "busy" });
    expect(`${replacement.id}#${replacement.incarnation}`).not.toBe(originalConnectionId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("same-serial recovery drops stale automation readiness until setup runs again", async () => {
  const manager = new LaggingShutdownManager(original.deviceId);
  const { timer, sessions, pool, captured } = await setup(manager);
  try {
    expect(sessions.getDeviceReadiness("session")).toBeUndefined();
    sessions.setDeviceReadiness("session", "automationReady");
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
      original.deviceId,
      undefined,
      captured,
    );
    await manager.killAccepted.promise;
    manager.bootedDevices = [];
    timer.advanceTime(1_000);

    await expect(recovery).resolves.toBe("recovered");
    expect(pool.getDevice(original.deviceId)).toMatchObject({ sessionId: "session" });
    expect(sessions.getDeviceReadiness("session")).toBe("booted");
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("same-serial emulator continuity is enabled when the recovery environment is unset", async () => {
  await withRecoveryEnvUnset(async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = new KillTrackingShutdownManager(original.deviceId);
    const releaseCancellation = Promise.withResolvers<void>();
    let cancellationCalls = 0;
    const pool = makePool(sessions, "daemon", {
      timer,
      deviceManager: manager,
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      cancelDeviceSessionExecutions: async () => {
        cancellationCalls++;
        await releaseCancellation.promise;
        return 0;
      },
    });
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession({
      sessionId: "session",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
      expectedIdentity: original,
    });
    const captured = pool.getDevice(original.deviceId)!;
    try {
      expect(pool.getRecoveryPolicy().onLoss).toBe(false);
      const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(
        original.deviceId,
        undefined,
        captured,
      );
      await flush();
      expect(cancellationCalls).toBe(1);

      await pool.releaseDevice(original.deviceId, "session");
      await pool.removeDevice(original.deviceId, true, captured);
      await pool.addDevice(original, image);
      const replacement = pool.getDevice(original.deviceId);
      releaseCancellation.resolve();

      await expect(recovery).resolves.toBe("recovered");
      expect(pool.getDevice(original.deviceId)).toBe(replacement);
      expect(sessions.getSession("session")).toMatchObject({
        sessionId: "session",
        assignedDevice: original.deviceId,
      });
      expect(manager.kills).toEqual([]);
      expect(manager.startedDevices).toEqual([]);
    } finally {
      releaseCancellation.resolve();
      sessions.stopCleanupTimer();
    }
  });
});

test("continuity releases an externally closed emulator without relaunch and rehydrates it on return", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager("emulator-5599");
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    deviceSessionContinuityEnabled: true,
  });
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  await pool.bindOrReuseDeviceSession({
    sessionId: "session",
    deviceId: original.deviceId,
    platform: "android",
    sourceImage: image,
    expectedIdentity: original,
  });
  const captured = pool.getDevice(original.deviceId)!;
  const originalConnectionId = `${captured.id}#${captured.incarnation}`;
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  manager.bootedDevices = [];

  try {
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, incidentId, captured),
    ).resolves.toBe("released");
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
    });
    expect(await pool.waitForEmulatorLossIncident(incidentId, 0)).toMatchObject({
      avdName: original.name,
      session: { state: "awaiting-device" },
      recovery: { attempts: [], outcome: "not-attempted" },
    });
    expect(sessions.getSession("session")).toBeNull();
    assertNoRecoveryReservationsRemain(pool, "session");

    const returned = { ...original, deviceId: "emulator-5599" };
    manager.bootedDevices = [returned];
    await pool.addDevice(returned, image);
    await expect(sessions.rehydratePersistedSessions(pool)).resolves.toEqual({
      rehydrated: ["session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });

    const replacement = pool.getDevice(returned.deviceId)!;
    expect(sessions.getSession("session")).toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
      stableDeviceId: original.name,
    });
    expect(replacement).toMatchObject({ sessionId: "session", status: "busy" });
    expect(`${replacement.id}#${replacement.incarnation}`).not.toBe(originalConnectionId);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("a pool-allocated emulator without a recorded image still persists as device-restart and rehydrates (#7546)", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    deviceSessionContinuityEnabled: true,
  });
  manager.bootedDevices = [original];
  // Discovery-only refresh -- no sourceImage, so unlike `addDevice(device, image)`
  // the pooled entry gets neither `avdName` nor `androidImage` (#7546's gap).
  await pool.refreshDevices();
  const pooled = pool.getDevice(original.deviceId);
  expect(pooled?.avdName).toBeUndefined();
  expect(pooled?.androidImage).toBeUndefined();

  // Idle allocation (assignDeviceToSession), not startDevice/getAndroid image
  // enrichment -- the client-supplied/runner-minted sessionUuid path.
  await sessions.getOrCreateSession("session", pool, "android");
  expect(pool.getDevice(original.deviceId)).toMatchObject({ sessionId: "session" });

  try {
    manager.bootedDevices = [];
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(
        original.deviceId,
        undefined,
        pool.getDevice(original.deviceId) ?? undefined,
      ),
    ).resolves.toBe("released");
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
    });
    expect(sessions.getSession("session")).toBeNull();

    const returned = { ...original, deviceId: "emulator-5599" };
    manager.bootedDevices = [returned];
    await pool.refreshDevices();
    await expect(sessions.rehydratePersistedSessions(pool)).resolves.toEqual({
      rehydrated: ["session"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(pool.getDevice(returned.deviceId)).toMatchObject({
      sessionId: "session",
      status: "busy",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("onLoss recovery does not actively relaunch a pool-allocated emulator without a recorded image (#7546)", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: true, maxAttempts: 1 },
    deviceSessionContinuityEnabled: true,
  });
  manager.bootedDevices = [original];
  await pool.refreshDevices();
  await sessions.getOrCreateSession("session", pool, "android");

  try {
    manager.bootedDevices = [];
    await expect(
      pool.recoverSessionBoundAndroidDeviceAfterLoss(
        original.deviceId,
        undefined,
        pool.getDevice(original.deviceId) ?? undefined,
      ),
    ).resolves.toBe("released");
    // Active relaunch stays gated on a recorded configured image even though
    // onLoss is enabled: passive continuity's looser identity check must not
    // widen what `isAndroidEmulatorActiveRelaunchEligible` permits.
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
    expect(await persistence.getSession("session")).toMatchObject({
      status: "released",
      release_reason: `device-restart:${original.name}`,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("continuity-disabled emulator loss keeps a terminal released settlement", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new KillTrackingShutdownManager();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    deviceSessionContinuityEnabled: false,
  });
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  await pool.bindOrReuseDeviceSession({
    sessionId: "session",
    deviceId: original.deviceId,
    platform: "android",
    sourceImage: image,
    expectedIdentity: original,
  });
  const captured = pool.getDevice(original.deviceId)!;
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "device-discovery-miss",
  );
  if (!incidentId) {
    throw new Error("Expected emulator-loss incident to be recorded");
  }
  try {
    const eviction = pool.testHooks;
    await eviction.evictMissingPooledDevice.call(captured, "not present in adb devices", {
      attemptDeviceLossRecovery: true,
      incidentId,
    });

    expect(await persistence.getSession("session")).toMatchObject({
      status: "released",
      release_reason: `device-disconnected:${original.deviceId};incident=${incidentId}`,
    });
    expect(await pool.waitForEmulatorLossIncident(incidentId, 0)).toMatchObject({
      session: { state: "released" },
      recovery: { attempts: [], outcome: "not-attempted" },
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("restart recovery remains pending after 60 seconds and recovers at 120 seconds", async () => {
  const { timer, sessions, manager, pool } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  let settled = false;
  const resume = sessions.getOrCreateSession("session", pool, "android", {
    requireIssuedSession: true,
  });
  void resume.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flush();
  for (let second = 1; second <= 120; second++) {
    timer.advanceTime(1_000);
    await flush();
    expect(settled).toBe(false);
  }
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  timer.advanceTime(1_000);
  await expect(resume).resolves.toMatchObject({
    sessionId: "session",
    assignedDevice: original.deviceId,
  });
});

test.each(["not-attempted", "exhausted"] as const)(
  "restart assignment reports a %s loss incident on the next retry tick",
  async (outcome) => {
    const { timer, sessions, pool, incidents, persistence } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    const incident = await incidents.open({
      deviceId: original.deviceId,
      avdName: original.name,
      detectionPath: "watched-process-exit",
      processExit: { code: null, signal: "SIGKILL" },
      session: {
        sessionUuid: "session",
        state: "recovering",
        lastHeartbeatMs: 0,
        hasReceivedHeartbeat: false,
        heartbeatTimeoutMs: 60_000,
      },
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });
    let failure: unknown;
    const resume = sessions
      .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
      .then(
        () => {},
        (error: unknown) => {
          failure = error;
        },
      );
    await flush();
    // The handoff hold outlives this caller; its three-minute expiry is still armed.
    expect(timer.getPendingTimeouts()).toEqual([180_000, 1_000]);
    await incidents.completeRecovery(incident.id, outcome, { sessionState: "awaiting-device" });
    timer.advanceTime(1_000);
    await drainUntilQuiescent(timer);
    // Drain the unfixed wait too, so the red test never leaves work behind.
    const failureAtNextTick = failure;
    const rowAtNextTick = await persistence.getSession("session");
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    await resume;
    expect(failureAtNextTick).toBeInstanceOf(ActionableError);
    expect(rowAtNextTick).toMatchObject({ release_reason: `device-restart:${original.name}` });
    expect(String(failureAtNextTick)).toContain("Cannot safely recover session");
    expect(String(failureAtNextTick)).toContain(incident.id);
    expect(String(failureAtNextTick)).toContain("watched-process-exit");
    expect(String(failureAtNextTick)).toContain("SIGKILL");
    expect(String(failureAtNextTick)).toContain("getAndroid or getApple");
    expect(String(failureAtNextTick)).toContain("179 seconds remaining");
  },
);

test("restart assignment keeps waiting while the loss incident has no recovery outcome", async () => {
  const { timer, sessions, pool, manager, incidents } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  await incidents.open({
    deviceId: original.deviceId,
    avdName: original.name,
    detectionPath: "watched-process-exit",
    recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    session: {
      sessionUuid: "session",
      state: "recovering",
      lastHeartbeatMs: 0,
      hasReceivedHeartbeat: false,
      heartbeatTimeoutMs: 60_000,
    },
  });
  let settled = false;
  const resume = sessions.getOrCreateSession("session", pool, "android", {
    requireIssuedSession: true,
  });
  void resume.then(() => {
    settled = true;
  });
  await flush();
  timer.advanceTime(1_000);
  await flush();
  expect(settled).toBe(false);
  // The handoff hold outlives this caller; its three-minute expiry is still armed.
  expect(timer.getPendingTimeouts()).toEqual([180_000, 1_000]);
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  timer.advanceTime(1_000);
  await expect(resume).resolves.toMatchObject({ assignedDevice: original.deviceId });
});

test.each([
  [3_500, 60_000],
  [undefined, 3_500],
  [3_500, undefined],
  [60_000, 3_500],
] as const)(
  "joined restart acquisition keeps caller deadlines separate (%s, %s)",
  async (firstDeadline, secondDeadline) => {
    const { timer, sessions, pool, manager } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    try {
      const acquire = (requestDeadlineMs: number | undefined) =>
        sessions.getOrCreateSession("session", pool, "android", {
          requireIssuedSession: true,
          requestDeadlineMs,
        });
      let firstResult: unknown;
      let secondResult: unknown;
      let firstSettled = false;
      let secondSettled = false;
      const first = acquire(firstDeadline).then(
        (session) => {
          firstResult = session;
          firstSettled = true;
        },
        (error: unknown) => {
          firstResult = error;
          firstSettled = true;
        },
      );
      await drainUntilQuiescent(timer);
      const second = acquire(secondDeadline).then(
        (session) => {
          secondResult = session;
          secondSettled = true;
        },
        (error: unknown) => {
          secondResult = error;
          secondSettled = true;
        },
      );
      await drainUntilQuiescent(timer);
      for (const step of [1_000, 1_000, 499]) {
        timer.advanceTime(step);
        await drainUntilQuiescent(timer);
      }
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      timer.advanceTime(1);
      await drainUntilQuiescent(timer);
      expect(firstSettled).toBe(firstDeadline === 3_500);
      expect(secondSettled).toBe(secondDeadline === 3_500);
      expect(String(firstDeadline === 3_500 ? firstResult : secondResult)).toContain(
        "Cannot safely recover session",
      );
      manager.bootedDevices = [original];
      timer.advanceTime(500);
      await drainUntilQuiescent(timer);
      timer.advanceTime(1_000);
      await Promise.all([first, second]);
      expect(firstDeadline === 3_500 ? secondResult : firstResult).toMatchObject({
        assignedDevice: original.deviceId,
      });
      expect(pool.getDevice(original.deviceId)?.sessionId).toBe("session");
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      sessions.stopCleanupTimer();
    }
  },
);

test("last joined restart waiter aborts slow discovery and fences its late device claim", async () => {
  const { timer, sessions, pool, manager } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const discovery =
    Promise.withResolvers<Awaited<ReturnType<typeof manager.getBootedDevicesDetailed>>>();
  const originalDiscovery = manager.getBootedDevicesDetailed.bind(manager);
  manager.getBootedDevicesDetailed = () => discovery.promise;
  const acquire = (requestDeadlineMs: number) =>
    sessions
      .getOrCreateSession("session", pool, "android", {
        requireIssuedSession: true,
        requestDeadlineMs,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  const first = acquire(3_500);
  await drainUntilQuiescent(timer);
  let secondSettled = false;
  const second = acquire(4_500).then((result) => {
    secondSettled = true;
    return result;
  });
  await drainUntilQuiescent(timer);
  timer.advanceTime(2_500);
  await drainUntilQuiescent(timer);
  expect(String(await first)).toContain("Cannot safely recover session");
  expect(secondSettled).toBe(false);
  manager.bootedDevices = [original];
  const lateDiscovery = await originalDiscovery("android");
  timer.advanceTime(1_000);
  // Resolve in the same turn as the final deadline, before rejection cleanup runs.
  discovery.resolve(lateDiscovery);
  expect(String(await second)).toContain("Cannot safely recover session");
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  expect(sessions.getSession("session")).toBeNull();
  expect(pool.getDevice(original.deviceId)?.sessionId ?? null).toBeNull();
  // The handoff hold outlives this caller; its three-minute expiry is still armed.
  expect(timer.getPendingTimeouts()).toEqual([180_000]);
});

// #11359: the request deadline is wall time, so a wall step must not move the wait's budget.
test.each([
  ["no step", 0],
  ["a backward step", -3_600_000],
  ["a forward step (Linux model)", 3_600_000],
])(
  "single restart acquisition retains its deadline and fences late availability across %s",
  async (_name, stepMs) => {
    const { timer, sessions, pool, manager } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    // Linux: the monotonic clock includes host sleep, so a forward wall step is not counted as sleep.
    timer.simulateSleepCountingMonotonicClock();
    timer.stepWallClock(stepMs);
    const acquisition = sessions
      .getOrCreateSession("session", pool, "android", {
        requireIssuedSession: true,
        requestDeadlineMs: timer.now() + 3_500,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let settled = false;
    void acquisition.then(() => {
      settled = true;
    });
    await drainUntilQuiescent(timer);
    // The 3.5 s request less its 1 s response margin: neither early nor late, whatever the step.
    timer.advanceTime(2_400);
    await drainUntilQuiescent(timer);
    expect(settled).toBe(false);
    timer.advanceTime(100);
    expect(String(await acquisition)).toContain("Cannot safely recover session");
    manager.bootedDevices = [original];
    timer.advanceTime(1_000);
    await drainUntilQuiescent(timer);
    expect(sessions.getSession("session")).toBeNull();
    expect(pool.getDevice(original.deviceId)?.sessionId ?? null).toBeNull();
    // The handoff hold outlives this caller; its three-minute expiry is still armed.
    expect(timer.getPendingTimeouts()).toEqual([180_000]);
  },
);

test.each([
  [60_000, false],
  [undefined, false],
  [60_000, true],
  [undefined, true],
] as const)(
  "join-after-abort recovers after a held incident read settles (deadline %s, rehydration %s)",
  async (requestDeadlineMs, rehydration) => {
    const { timer, sessions, pool, manager, incidents } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    const read = Promise.withResolvers<Awaited<ReturnType<typeof incidents.list>>>();
    const list = incidents.list.bind(incidents);
    let reads = 0;
    incidents.list = () => (++reads === 1 ? read.promise : list());
    const slots = Reflect.get(sessions, "sessionSlots") as SessionSlots<
      Promise<Session>,
      { controller: AbortController; waiters: number },
      unknown,
      object,
      unknown,
      unknown,
      unknown,
      object,
      object,
      object
    >;
    const acquire = (deadline: number | undefined) =>
      sessions
        .getOrCreateSession("session", pool, "android", {
          requireIssuedSession: true,
          requestDeadlineMs: deadline,
        })
        .then(
          (session) => session,
          (error: unknown) => error,
        );
    const startupCaller = new AbortController();
    const first = rehydration
      ? runWithAbortSignal(startupCaller.signal, () =>
          sessions.rehydratePersistedSessions(pool, { signal: startupCaller.signal }),
        )
      : acquire(3_500);
    await drainUntilQuiescent(timer);
    expect(reads).toBe(1);
    const deadAssignment = slots.assignments.get("session");
    const deadShared = slots.sharedAssignments.get("session")!;
    timer.advanceTime(2_500);
    if (rehydration) {
      startupCaller.abort(new Error("startup caller cancelled"));
      expect(await first).toMatchObject({ skipped: [{ reason: "startup caller cancelled" }] });
    } else {
      expect(String(await first)).toContain("Cannot safely recover session");
    }
    expect(deadShared.controller.signal.aborted).toBe(true);
    expect(deadShared.waiters).toBe(0);
    expect(slots.assignments.get("session")).toBe(deadAssignment);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    const second = acquire(requestDeadlineMs);
    await drainUntilQuiescent(timer);
    expect(deadShared.waiters).toBe(0);
    expect(slots.assignments.get("session")).toBe(deadAssignment);
    expect(pool.getDevice(original.deviceId)?.sessionId).toBeNull();
    read.resolve(await list());
    const result = await second;
    await drainUntilQuiescent(timer);
    expect(String(result)).not.toContain("no remaining callers");
    expect(reads).toBe(2);
    expect(result).toMatchObject({ sessionId: "session", assignedDevice: original.deviceId });
    expect(pool.getDevice(original.deviceId)).toMatchObject({
      sessionId: "session",
      assignmentCount: 1,
    });
    expect(slots.assignments.size).toBe(0);
    expect(slots.sharedAssignments.size).toBe(0);
    expect(slots.recoveries.size).toBe(0);
    expect(timer.getPendingTimeouts()).toEqual([]);
  },
);

test.each(["deadline", "abort"] as const)(
  "join-after-abort keeps the new caller's %s while draining the old assignment",
  async (cancellation) => {
    const { timer, sessions, pool, manager, incidents } = await setupPassiveRestart();
    sessions.stopCleanupTimer();
    const read = Promise.withResolvers<Awaited<ReturnType<typeof incidents.list>>>();
    const list = incidents.list.bind(incidents);
    incidents.list = () => read.promise;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const acquire = (requestDeadlineMs: number | undefined, signal?: AbortSignal) =>
        sessions
          .getOrCreateSession("session", pool, "android", {
            requireIssuedSession: true,
            requestDeadlineMs,
            signal,
          })
          .then(
            (session) => session,
            (error: unknown) => error,
          );
      const first = acquire(3_500);
      await drainUntilQuiescent(timer);
      timer.advanceTime(2_500);
      expect(String(await first)).toContain("Cannot safely recover session");
      manager.bootedDevices = [original];
      await pool.addDevice(original, image);
      const caller = new AbortController();
      let settled = false;
      const second = runWithAbortSignal(caller.signal, () =>
        acquire(cancellation === "deadline" ? 5_000 : undefined, caller.signal),
      ).then((result) => {
        settled = true;
        return result;
      });
      await drainUntilQuiescent(timer);
      timer.advanceTime(1_499);
      await drainUntilQuiescent(timer);
      expect(settled).toBe(false);
      // The handoff hold outlives this caller; its three-minute expiry is still armed.
      expect(timer.getPendingTimeouts()).toEqual(
        cancellation === "deadline" ? [180_000, 1_500] : [180_000],
      );
      if (cancellation === "deadline") {
        timer.advanceTime(1);
      } else {
        caller.abort(new Error("replacement caller cancelled"));
      }
      const error = await second;
      expect(String(error)).toContain(
        cancellation === "deadline"
          ? "Cannot safely recover session"
          : "replacement caller cancelled",
      );
      expect(String(error)).not.toContain("no remaining callers");
      expect(pool.getDevice(original.deviceId)?.assignmentCount).toBe(0);
      incidents.list = list;
      read.resolve(await list());
      await drainUntilQuiescent(timer);
      expect(await acquire(60_000)).toMatchObject({ assignedDevice: original.deviceId });
      expect(pool.getDevice(original.deviceId)).toMatchObject({
        sessionId: "session",
        assignmentCount: 1,
      });
      await drainUntilQuiescent(timer);
      expect(unhandled).toEqual([]);
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      read.resolve([]);
      process.removeListener("unhandledRejection", onUnhandled);
      sessions.stopCleanupTimer();
    }
  },
);

test("restart assignment waits until a recorded outcome's cleanup is settled", async () => {
  const { timer, sessions, pool, captured, incidents } = await setupPassiveRestart(false);
  sessions.stopCleanupTimer();
  const incidentId = await pool.recordEmulatorLossIncident(
    original.deviceId,
    "watched-process-exit",
    {
      code: null,
      signal: "SIGKILL",
    },
  );
  if (!incidentId) {
    throw new Error("Expected a recorded incident");
  }
  await pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured);
  await incidents.completeRecovery(incidentId, "exhausted", { sessionState: "awaiting-device" });
  let settled = false;
  const assignment = sessions
    .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_000);
  await drainUntilQuiescent(timer);
  expect(settled).toBe(false);
  await pool.finishEmulatorLossIncident(incidentId, "exhausted");
  timer.advanceTime(1_000);
  expect(String(await assignment)).toContain("watched-process-exit");
});

test("restart assignment bounds slow discovery and fences its late device claim", async () => {
  const { timer, sessions, pool, manager } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const discovery =
    Promise.withResolvers<Awaited<ReturnType<typeof manager.getBootedDevicesDetailed>>>();
  const originalDiscovery = manager.getBootedDevicesDetailed.bind(manager);
  manager.getBootedDevicesDetailed = () => discovery.promise;
  const assignment = sessions
    .getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
      requestDeadlineMs: 2_500,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await drainUntilQuiescent(timer);
  timer.advanceTime(1_500);
  expect(String(await assignment)).toContain("Cannot safely recover session");
  expect(timer.now()).toBe(1_500);
  manager.bootedDevices = [original];
  discovery.resolve(await originalDiscovery("android"));
  await drainUntilQuiescent(timer);
  expect(sessions.getSession("session")).toBeNull();
  expect(pool.getDevice(original.deviceId)?.sessionId ?? null).toBeNull();
  // The handoff hold outlives this caller; its three-minute expiry is still armed.
  expect(timer.getPendingTimeouts()).toEqual([180_000]);
});

test("binding during a gated idle process exit rejects and evicts the dead emulator", async () => {
  const timer = new FakeTimer();
  class GatedIncidentStore extends InMemoryEmulatorLossIncidentStore {
    readonly writeStarted = Promise.withResolvers<void>();
    readonly releaseWrite = Promise.withResolvers<void>();
    private firstWrite = true;

    override async open(input: OpenEmulatorLossIncidentInput) {
      if (this.firstWrite) {
        this.firstWrite = false;
        this.writeStarted.resolve();
        await this.releaseWrite.promise;
      }
      return await super.open(input);
    }
  }
  const incidents = new GatedIncidentStore(timer);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const manager = new FakeDeviceManager();
  manager.bootedDevices = [original];
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    emulatorLossIncidentStore: incidents,
    recoveryPolicy: { onLoss: false, maxAttempts: 1 },
  });
  const child = new StreamlessChildProcess();
  await pool.addDevice(original, image);
  await pool.bindOrReuseDeviceSession({
    sessionId: "owner",
    deviceId: original.deviceId,
    platform: "android",
    sourceImage: image,
    childProcess: child,
    expectedIdentity: original,
  });
  await sessions.releaseSession("owner");
  await pool.releaseDevice(original.deviceId, "owner");
  expect(pool.getDevice(original.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await incidents.writeStarted.promise;
  let failure: unknown;
  try {
    const binding = pool.bindOrReuseDeviceSession({
      sessionId: "new-session",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
      childProcess: child,
      expectedIdentity: original,
    });
    await drainUntil(() => timer.getPendingTimeouts().includes(1_000), {
      description: "bind armed the shared incident deadline",
    });
    // Keep main's ordering: bind fails before the recorder's write is released.
    timer.advanceTime(1_000);
    try {
      await binding;
    } catch (error) {
      failure = error;
    }
    expect(pool.getDevice(original.deviceId)).toBeNull();
  } finally {
    incidents.releaseWrite.resolve();
    await drainUntilQuiescent(timer);
  }
  expect(await incidents.list()).toHaveLength(1);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("exited before process tracking completed");
  expect(pool.getDevice(original.deviceId)).toBeNull();
  expect(sessions.getSession("new-session")).toBeNull();
});

function exitedChild(): StreamlessChildProcess {
  return new StreamlessChildProcess();
}

async function setupProcessExitPool(
  onLoss: boolean,
  continuity: boolean,
  incidents?: EmulatorLossIncidentStore,
  manager = new FakeDeviceManager(),
) {
  const timer = new FakeTimer();
  const store = incidents ?? new InMemoryEmulatorLossIncidentStore(timer);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    emulatorLossIncidentStore: store,
    recoveryPolicy: { onLoss, maxAttempts: 1 },
    deviceSessionContinuityEnabled: continuity,
  });
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  const child = exitedChild();
  const internals = pool.testHooks;
  await internals.trackStartedDeviceProcess.call(original, child);
  await pool.bindOrReuseDeviceSession({
    sessionId: "session",
    deviceId: original.deviceId,
    platform: "android",
    sourceImage: image,
    childProcess: child,
    expectedIdentity: original,
  });
  return { timer, store, sessions, pool, manager, child, internals };
}

test.each([
  { onLoss: true, continuity: true, listed: true, outcome: "recovered", state: "active" },
  {
    onLoss: false,
    continuity: true,
    listed: false,
    outcome: "not-attempted",
    state: "awaiting-device",
  },
  { onLoss: false, continuity: false, listed: false, outcome: "not-attempted", state: "released" },
] as const)("both process tracks preserve main's settlement fields: %j", async (config) => {
  const { timer, store, sessions, pool, manager, child } = await setupProcessExitPool(
    config.onLoss,
    config.continuity,
  );
  expect(child.listenerCount("exit")).toBe(2);
  if (!config.listed) {
    manager.bootedDevices = [];
  }
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await drainUntilQuiescent(timer);
  const rows = await store.list();
  expect(rows).toHaveLength(1);
  expect(recoveryInternals(pool).emulatorLossRecoverySettlements.size).toBe(0);
  for (const row of rows) {
    expect(row).toMatchObject({
      deviceId: original.deviceId,
      avdName: original.name,
      detectionPath: "watched-process-exit",
      processExit: { code: 1, signal: null },
      session: { sessionUuid: "session", state: config.state },
      recovery: {
        outcome: config.outcome,
        policy: { onLoss: config.onLoss, maxAttempts: 1 },
        attempts: [],
      },
    });
    expect(row.replacementDeviceId).toBeUndefined();
  }
  expect(sessions.getSession("session")?.assignedDevice ?? null).toBe(
    config.listed ? original.deviceId : null,
  );
});

test("a late dead-child track records a fresh loss and keeps its settlement guard armed", async () => {
  class GatedExhaustedStore extends InMemoryEmulatorLossIncidentStore {
    readonly completed = Promise.withResolvers<string>();
    readonly release = Promise.withResolvers<void>();
    override async completeRecovery(
      id: string,
      outcome: EmulatorRecoveryOutcome,
      settlement?: EmulatorLossRecoverySettlement,
    ) {
      await super.completeRecovery(id, outcome, settlement);
      if (outcome === "exhausted") {
        this.completed.resolve(id);
        await this.release.promise;
      }
    }
  }
  class FailingRelaunchManager extends FakeDeviceManager {
    override async startDevice(): Promise<ChildProcess> {
      throw new Error("relaunch failed");
    }
  }
  const store = new GatedExhaustedStore(new FakeTimer());
  const { timer, pool, manager, child, internals } = await setupProcessExitPool(
    true,
    true,
    store,
    new FailingRelaunchManager(),
  );
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await drainUntilQuiescent(timer);
  const [first] = await store.list();
  expect(first).toMatchObject({ recovery: { outcome: "recovered" }, session: { state: "active" } });
  expect(recoveryInternals(pool).emulatorLossRecoverySettlements.size).toBe(0);
  manager.bootedDevices = [];
  const late = internals.trackStartedDeviceProcess
    .call(original, child)
    .catch((error: unknown) => error);
  try {
    const secondId = await store.completed.promise;
    // An exhausted outcome is visible before cleanup finishes. The early-error
    // guard must still see this new row as pending throughout that interval.
    expect(recoveryInternals(pool).emulatorLossRecoverySettlements.has(secondId)).toBe(true);
    expect(secondId).not.toBe(first.id);
    expect(await store.get(first.id)).toEqual(first);
  } finally {
    store.release.resolve();
    await late;
    await drainUntilQuiescent(timer);
  }
  const rows = await store.list();
  expect(rows).toHaveLength(2);
  expect(await store.get(first.id)).toEqual(first);
  expect(rows[0]).toMatchObject({
    recovery: { outcome: "exhausted" },
    session: { sessionUuid: "session", state: "awaiting-device" },
  });
  expect(recoveryInternals(pool).emulatorLossRecoverySettlements.size).toBe(0);
});
