import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  original,
  image,
  KillTrackingShutdownManager,
  setupWith,
  setupPassiveRestart,
  flush,
  setupSettledRestart,
} from "../helpers/devicePoolRecoveryShutdownHarness";

// These tests exercise the three-minute restart recovery window, which the idle deadline caps.
useSessionIdleWindowForSuite();

test.each(["not-attempted", "exhausted"] as const)(
  "settled %s loss stays non-terminal and resumes if the device returns inside the window",
  async (outcome) => {
    const { timer, persistence, sessions, pool, manager, incident } =
      await setupSettledRestart(outcome);
    const persisted = { ...(await persistence.getSession("session"))! };
    timer.advanceTime(60_000);
    timer.clearHistory();
    const error = await sessions
      .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toMatchObject({
      details: {
        sessionUuid: "session",
        platform: "android",
        deviceId: original.deviceId,
        stableDeviceId: original.name,
        incidentId: incident.id,
        detectionPath: "watched-process-exit",
        processExit: { code: 1, signal: null },
        recoveryOutcome: outcome,
        code: "session_recovery_pending",
        retryable: true,
        recoveryWindowRemainingMs: 120_000,
        recovery: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
      },
    });
    expect(
      String(error)
        .toLowerCase()
        .match(/acquire a new device/g),
    ).toHaveLength(1);
    expect(String(error).indexOf("The session can still resume")).toBeLessThan(
      String(error).indexOf("acquire a new device"),
    );
    expect(String(error)).toBe(
      "SessionRecoveryAssignmentError: Cannot safely recover session session: android device 'Pixel_8_API_35' is unavailable or already in use. " +
        `Loss incident ${incident.id}: watched-process-exit (code=1, signal=null); recovery outcome: ${outcome}. ` +
        "The session can still resume if the device returns before the recovery window ends " +
        "(120 seconds remaining); otherwise acquire a new device with getAndroid or getApple.",
    );
    expect(timer.getSleepHistory()).toEqual([]);
    // The row stays non-terminal; only the call's restart-recovery activity extends its expiry (#10713).
    expect(await persistence.getSession("session")).toEqual({
      ...persisted,
      expires_at_ms: timer.now() + persisted.session_timeout_ms!,
    });
    expect(sessions.getTerminalReleaseSnapshot("session")).toBeUndefined();
    timer.advanceTime(60_000);
    manager.bootedDevices = [original];
    expect(pool.getDevice(original.deviceId)).toBeNull();
    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).resolves.toMatchObject({ sessionId: "session", assignedDevice: original.deviceId });
    expect(await persistence.getSession("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  },
);

test("sequential settled restart retries bound discovery and keep the bystander idle", async () => {
  const { timer, sessions, pool, manager } = await setupSettledRestart();
  const bystander = { ...original, deviceId: "emulator-5556", name: "Bystander_AVD" };
  await pool.addDevice(bystander, { ...image, name: bystander.name });
  const discover = manager.getBootedDevicesDetailed.bind(manager);
  let discoveries = 0;
  manager.getBootedDevicesDetailed = (platform) => {
    discoveries++;
    return discover(platform);
  };
  for (let retry = 0; retry < 3; retry++) {
    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).rejects.toMatchObject({
      details: { code: "session_recovery_pending", retryable: true },
    });
  }
  expect(timer.now()).toBe(0);
  expect({ discoveries, bystander: pool.getDevice(bystander.deviceId) }).toMatchObject({
    discoveries: 1,
    bystander: { sessionId: null, status: "idle" },
  });
});

test("sequential settled restart retries never reboot an idle bystander with onLoss enabled", async () => {
  const incidents = new InMemoryEmulatorLossIncidentStore(new FakeTimer());
  const { timer, sessions, pool, manager, captured } = await setupWith(
    new KillTrackingShutdownManager(),
    undefined,
    incidents,
  );
  try {
    await pool.releaseDevice(original.deviceId, "session");
    await pool.removeDevice(original.deviceId, true, captured);
    const incident = await incidents.open({
      deviceId: original.deviceId,
      avdName: original.name,
      detectionPath: "watched-process-exit",
      session: {
        sessionUuid: "session",
        state: "awaiting-device",
        lastHeartbeatMs: 0,
        hasReceivedHeartbeat: false,
        heartbeatTimeoutMs: 60_000,
      },
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
    });
    await incidents.completeRecovery(incident.id, "exhausted");
    const bystander = { ...original, deviceId: "emulator-5556", name: "Bystander_AVD" };
    await pool.addDevice(bystander, { ...image, name: bystander.name });
    manager.bootedDevices = [];
    const discover = manager.getBootedDevicesDetailed.bind(manager);
    let discoveries = 0;
    manager.getBootedDevicesDetailed = (platform) => {
      discoveries++;
      return discover(platform);
    };
    for (let retry = 0; retry < 3; retry++) {
      await expect(
        pool.assignDeviceToSession("session", "android", {
          platform: "android",
          deviceId: original.deviceId,
          stableDeviceId: original.name,
          androidEmulator: true,
          restartRecoveryDeadlineMs: 180_000,
        }),
      ).rejects.toMatchObject({ details: { code: "session_recovery_pending" } });
    }
    expect(timer.now()).toBe(0);
    expect(discoveries).toBe(1);
    expect(pool.getDevice(bystander.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
    expect(manager.kills).toEqual([]);
    expect(manager.startedDevices).toEqual([]);
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("settled restart retry keeps serial reuse pending without claiming the replacement", async () => {
  const { sessions, pool, manager, persistence } = await setupSettledRestart();
  const replacement = { ...original, name: "Different_AVD" };
  const unrelated = { ...original, deviceId: "emulator-5556", name: "Unrelated_AVD" };
  manager.bootedDevices = [replacement, unrelated];
  const error = await sessions
    .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    name: "SessionRecoveryAssignmentError",
    details: {
      code: "session_recovery_pending",
      retryable: true,
      recoveryWindowRemainingMs: 180_000,
    },
  });
  expect(sessions.getSession("session")).toBeNull();
  expect(await persistence.getSession("session")).toMatchObject({
    status: "released",
    release_reason: `device-restart:${original.name}`,
  });
  expect(pool.getDevice(replacement.deviceId)).toMatchObject({
    name: replacement.name,
    sessionId: null,
    status: "idle",
  });
  expect(pool.getDevice(unrelated.deviceId)).toMatchObject({ sessionId: null, status: "idle" });
});

test("settled restart retry keeps an absent serial pending without changing persistence", async () => {
  const { sessions, pool, persistence, incident } = await setupSettledRestart();
  const persisted = await persistence.getSession("session");
  await expect(
    sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
  ).rejects.toMatchObject({
    details: {
      code: "session_recovery_pending",
      retryable: true,
      incidentId: incident.id,
      recoveryWindowRemainingMs: 180_000,
    },
  });
  expect(await persistence.getSession("session")).toEqual(persisted);
  expect(sessions.getTerminalReleaseSnapshot("session")).toBeUndefined();
});

test("settled restart retry finds the returned device at the refresh interval boundary", async () => {
  const { timer, sessions, pool, manager } = await setupSettledRestart();
  // A recent ordinary refresh must not suppress the first retry after loss.
  await pool.refreshDevices();
  const discover = manager.getBootedDevicesDetailed.bind(manager);
  let discoveries = 0;
  manager.getBootedDevicesDetailed = (platform) => {
    discoveries++;
    return discover(platform);
  };
  await expect(
    sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
  ).rejects.toMatchObject({ details: { code: "session_recovery_pending" } });
  expect(discoveries).toBe(1);
  manager.bootedDevices = [original];
  timer.advanceTime(4_999);
  await expect(
    sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
  ).rejects.toMatchObject({ details: { code: "session_recovery_pending" } });
  expect(discoveries).toBe(1);
  expect(pool.getDevice(original.deviceId)).toBeNull();
  timer.advanceTime(1);
  await expect(
    sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
  ).resolves.toMatchObject({ assignedDevice: original.deviceId });
  expect(discoveries).toBe(3); // Refresh, then the independent fresh assignment proof.
  expect(pool.getDevice(original.deviceId)).toMatchObject({ sessionId: "session", status: "busy" });
  expect(manager.kills).toEqual([]);
  expect(manager.startedDevices).toEqual([]);
});

test("settled restart retry resumes when the device returns during refresh", async () => {
  const { timer, sessions, pool, manager } = await setupSettledRestart();
  const discover = manager.getBootedDevicesDetailed.bind(manager);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let discoveries = 0;
  manager.getBootedDevicesDetailed = async (platform) => {
    discoveries++;
    if (discoveries === 1) {
      started.resolve();
      await release.promise;
    }
    return discover(platform);
  };
  const retry = sessions.getOrCreateSession("session", pool, "android", {
    requireIssuedSession: true,
  });
  try {
    await started.promise;
    expect(pool.getDevice(original.deviceId)).toBeNull();
    manager.bootedDevices = [original];
    release.resolve();
    await expect(retry).resolves.toMatchObject({ assignedDevice: original.deviceId });
    expect(discoveries).toBe(2);
    expect(timer.now()).toBe(0);
    expect(pool.getDevice(original.deviceId)).toMatchObject({
      sessionId: "session",
      status: "busy",
    });
  } finally {
    release.resolve();
  }
});

test("restart retry reports a settled loss recorded during refresh without sleeping", async () => {
  const { timer, sessions, pool, manager, incidents } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  expect(await incidents.list()).toEqual([]);
  const discover = manager.getBootedDevicesDetailed.bind(manager);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  manager.getBootedDevicesDetailed = async (platform) => {
    started.resolve();
    await release.promise;
    return discover(platform);
  };
  const retry = sessions
    .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
    .catch((error: unknown) => error);
  try {
    await started.promise;
    const incident = await incidents.open({
      deviceId: original.deviceId,
      avdName: original.name,
      detectionPath: "watched-process-exit",
      session: {
        sessionUuid: "session",
        state: "awaiting-device",
        lastHeartbeatMs: 0,
        hasReceivedHeartbeat: false,
        heartbeatTimeoutMs: 60_000,
      },
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    });
    await incidents.completeRecovery(incident.id, "not-attempted");
    release.resolve();
    expect(await retry).toMatchObject({
      details: {
        code: "session_recovery_pending",
        incidentId: incident.id,
        recoveryOutcome: "not-attempted",
        retryable: true,
        recoveryWindowRemainingMs: 180_000,
      },
    });
    expect(timer.getSleepHistory()).toEqual([]);
    expect(timer.now()).toBe(0);
    expect(sessions.getTerminalReleaseSnapshot("session")).toBeUndefined();
  } finally {
    release.resolve();
  }
});

test("restart retry terminalizes absence if its post-refresh incident read crosses the window", async () => {
  const { timer, sessions, pool, incidents } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const list = incidents.list.bind(incidents);
  let reads = 0;
  incidents.list = () => {
    if (++reads === 2) {
      timer.advanceTime(180_000);
    }
    return list();
  };
  await expect(
    sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
  ).rejects.toMatchObject({ reason: "target-absent" });
  expect(await incidents.list()).toEqual([]);
  expect(sessions.getTerminalReleaseSnapshot("session")).toMatchObject({
    releaseReason: "identity-recovery-target-absent",
  });
});

test("settled restart retries share exactly one discovery for ten overlapping callers", async () => {
  const { timer, pool, manager, incident } = await setupSettledRestart();
  const discover = manager.getBootedDevicesDetailed.bind(manager);
  const absent = await discover("either");
  const discovery = Promise.withResolvers<typeof absent>();
  let discoveries = 0;
  manager.getBootedDevicesDetailed = () => {
    discoveries++;
    return discovery.promise;
  };
  timer.clearHistory();
  const retries = Array.from({ length: 10 }, () =>
    pool
      .assignDeviceToSession("session", "android", {
        platform: "android",
        deviceId: original.deviceId,
        stableDeviceId: original.name,
        androidEmulator: true,
        restartRecoveryDeadlineMs: 180_000,
      })
      .catch((error: unknown) => error),
  );
  await drainUntilQuiescent(timer);
  discovery.resolve(absent);
  const results = await Promise.all(retries);
  expect(discoveries).toBe(1);
  for (const error of results) {
    expect(error).toMatchObject({
      details: {
        code: "session_recovery_pending",
        incidentId: incident.id,
        retryable: true,
        recoveryWindowRemainingMs: 180_000,
      },
    });
  }
  expect(timer.getSleepHistory()).toEqual([]);
});

test("settled restart callers keep their own deadlines during shared discovery", async () => {
  const { timer, sessions, pool, manager, incident } = await setupSettledRestart();
  const discover = manager.getBootedDevicesDetailed.bind(manager);
  manager.bootedDevices = [original];
  const returned = await discover("either");
  const discovery = Promise.withResolvers<typeof returned>();
  let discoveries = 0;
  manager.getBootedDevicesDetailed = (platform) => {
    discoveries++;
    return discoveries === 1 ? discovery.promise : discover(platform);
  };
  const first = sessions
    .getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
      requestDeadlineMs: 3_500,
    })
    .catch((error: unknown) => error);
  await drainUntilQuiescent(timer);
  let secondSettled = false;
  const second = sessions
    .getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
      requestDeadlineMs: 60_000,
    })
    .catch((error: unknown) => error)
    .finally(() => {
      secondSettled = true;
    });
  await drainUntilQuiescent(timer);
  timer.advanceTime(2_500);
  expect(await first).toMatchObject({
    details: {
      code: "session_recovery_pending",
      incidentId: incident.id,
      recoveryWindowRemainingMs: 177_500,
    },
  });
  expect(secondSettled).toBe(false);
  discovery.resolve(returned);
  await expect(second).resolves.toMatchObject({
    sessionId: "session",
    assignedDevice: original.deviceId,
  });
  expect(discoveries).toBe(2); // Shared refresh, then the existing fresh identity/presence proof.
  expect(pool.getDevice(original.deviceId)?.sessionId).toBe("session");
  expect(timer.getPendingTimeouts()).toEqual([]);
});

test("restart assignment without an incident exposes same-session retry details", async () => {
  const { timer, sessions, pool } = await setupPassiveRestart();
  sessions.stopCleanupTimer();
  const request = sessions
    .getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
      access: "acquire",
      requestDeadlineMs: 3_500,
    })
    .catch((error: unknown) => error);
  await drainUntilQuiescent(timer);
  timer.advanceTime(2_500);
  const error = await request;
  expect(error).toBeInstanceOf(ActionableError);
  expect(error).toMatchObject({
    details: {
      deviceId: original.deviceId,
      stableDeviceId: original.name,
      code: "session_recovery_pending",
      retryable: true,
      recoveryWindowRemainingMs: 177_500,
      recovery: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
    },
  });
  expect(error).not.toHaveProperty("details.incidentId");
  expect(String(error)).toBe(
    "SessionRecoveryAssignmentError: Cannot safely recover session session: android device 'Pixel_8_API_35' is unavailable or already in use. " +
      "The session can still resume if the device returns before the recovery window ends " +
      "(178 seconds remaining); otherwise acquire a new device with getAndroid or getApple.",
  );
});

test("the restart recovery window is judged on the session clock across a wall-clock step (#11105)", async () => {
  const { timer, sessions, pool } = await setupSettledRestart();
  timer.advanceTime(2_500);
  // A backward NTP step: the deadline derives from session stamps, which the step does not move.
  timer.stepWallClock(-3_600_000);
  const buildError = pool.testHooks.recoveryAssignmentError.bind(pool) as (
    sessionId: string,
    target: { platform: "android"; stableDeviceId: string; restartRecoveryDeadlineMs?: number },
  ) => ActionableError;

  const error = buildError("session", {
    platform: "android",
    stableDeviceId: original.name,
    restartRecoveryDeadlineMs: 180_000,
  });

  expect(error).toMatchObject({ details: { recoveryWindowRemainingMs: 177_500 } });
  sessions.stopCleanupTimer();
});

test.each([undefined, 60_000, 59_999])(
  "recovery assignment outside the window preserves its text with deadline %s",
  async (deadline) => {
    const { timer, sessions, pool, incident, incidents } = await setupSettledRestart();
    timer.advanceTime(60_000);
    const buildError = pool.testHooks.recoveryAssignmentError.bind(pool) as (
      sessionId: string,
      target: { platform: "android"; stableDeviceId: string; restartRecoveryDeadlineMs?: number },
      loss?: typeof incident,
    ) => ActionableError;
    const settledIncident = await incidents.get(incident.id);
    for (const loss of [undefined, settledIncident]) {
      const error = buildError(
        "session",
        { platform: "android", stableDeviceId: original.name, restartRecoveryDeadlineMs: deadline },
        loss,
      );
      expect(error.message).toBe(
        "Cannot safely recover session session: android device 'Pixel_8_API_35' is unavailable or already in use. " +
          "Acquire a new device with getAndroid or getApple. " +
          (loss
            ? `Loss incident ${incident.id}: watched-process-exit (code=1, signal=null); recovery outcome: not-attempted. `
            : ""),
      );
      expect(error).not.toHaveProperty("details.recoveryWindowRemainingMs");
      expect(error.message.toLowerCase().match(/acquire a new device/g)).toHaveLength(1);
    }
    sessions.stopCleanupTimer();
  },
);

test.each([180_000, 240_000])(
  "settled restart loss terminalizes the same session at %s ms",
  async (elapsed) => {
    const { timer, persistence, sessions, pool, manager } = await setupSettledRestart();
    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).rejects.toThrow("recovery outcome: not-attempted");
    expect(await persistence.getSession("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });
    timer.advanceTime(elapsed);
    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).rejects.toThrow("terminal after restart-recovery-timeout");
    expect(await persistence.getSession("session")).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
      released_at_ms: elapsed,
    });
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    const terminalError = await sessions
      .getOrCreateSession("session", pool, "android", { requireIssuedSession: true })
      .catch((error: unknown) => error);
    expect(terminalError).toBeInstanceOf(TerminalSessionError);
    expect(terminalError).toHaveProperty(
      "message",
      "Session session is terminal after restart-recovery-timeout and cannot be reused. " +
        "Acquire a new device with getAndroid or getApple.",
    );
  },
);

test("device-restart resume waits for the same serial and preserves its session UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
    });
    await flush();
    // The handoff hold outlives this caller; its three-minute expiry is still armed.
    expect(timer.getPendingTimeouts()).toEqual([180_000, 1_000]);
    expect(await persistence.getSession("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });

    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    timer.advanceTime(1_000);
    await expect(resume).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
    });
    expect(await persistence.getSession("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume keeps retrying across a forward wall-clock step inside its window (#11162)", async () => {
  const { timer, sessions, manager, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
    });
    await flush();
    // The handoff hold outlives this caller; its three-minute expiry is still armed.
    expect(timer.getPendingTimeouts()).toEqual([180_000, 1_000]);
    // An NTP step an hour forward on a clock whose monotonic reading runs through host sleep
    // (Linux, Windows), so the session clock ignores the step: the recovery window derives from
    // session stamps, and the retry gate must not read the stepped wall clock as past it.
    timer.simulateSleepCountingMonotonicClock();
    timer.stepWallClock(3_600_000);
    timer.advanceTime(1_000);
    await flush();

    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    timer.advanceTime(1_000);
    await expect(resume).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume waits through an unknown new serial and binds by AVD name", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    const unknown = { ...original, deviceId: "emulator-5556", name: "Unknown (emulator-5556)" };
    manager.bootedDevices = [unknown];
    await pool.refreshDevices();
    const resume = sessions.getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
    });
    await drainUntilQuiescent(timer);
    // The handoff hold outlives this caller; its three-minute expiry is still armed.
    expect(timer.getPendingTimeouts()).toEqual([180_000, 1_000]);
    expect(await persistence.getSession("session")).toMatchObject({
      release_reason: `device-restart:${original.name}`,
    });

    const returned = { ...original, deviceId: unknown.deviceId };
    manager.bootedDevices = [returned];
    await pool.refreshDevices();
    timer.advanceTime(1_000);
    await expect(resume).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
      stableDeviceId: original.name,
    });
    expect(pool.getDevice(returned.deviceId)).toMatchObject({
      sessionId: "session",
      status: "busy",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume after 45 seconds reuses the same serial and session UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    timer.advanceTime(45_000);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);

    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).resolves.toMatchObject({ sessionId: "session", assignedDevice: original.deviceId });
    expect(await persistence.getSession("session")).toMatchObject({
      status: "active",
      device_id: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume after 45 seconds binds a new serial by AVD name and preserves the UUID", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    timer.advanceTime(45_000);
    const unknown = { ...original, deviceId: "emulator-5556", name: "Unknown (emulator-5556)" };
    manager.bootedDevices = [unknown];
    await pool.refreshDevices();
    const returned = { ...original, deviceId: unknown.deviceId };
    manager.bootedDevices = [returned];
    await pool.refreshDevices();

    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).resolves.toMatchObject({
      sessionId: "session",
      assignedDevice: returned.deviceId,
      stableDeviceId: original.name,
    });
    expect(await persistence.getSession("session")).toMatchObject({
      status: "active",
      device_id: returned.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume refuses a present device after the full recovery deadline", async () => {
  const { timer, persistence, sessions, manager, pool } = await setupPassiveRestart();
  try {
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS + 1);
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);

    await expect(
      sessions.getOrCreateSession("session", pool, "android", { requireIssuedSession: true }),
    ).rejects.toMatchObject({
      release: { releaseReason: "restart-recovery-timeout", terminal: true },
    });
    expect(await persistence.getSession("session")).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
      device_id: original.deviceId,
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});

test("device-restart resume terminalizes absence at the persisted restart deadline", async () => {
  const { timer, persistence, sessions, pool } = await setupPassiveRestart();
  try {
    const resume = sessions.getOrCreateSession("session", pool, "android", {
      requireIssuedSession: true,
    });
    await flush();
    // The handoff hold outlives this caller; its three-minute expiry is still armed.
    expect(timer.getPendingTimeouts()).toEqual([180_000, 1_000]);
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    await expect(resume).rejects.toThrow("recovery reason: target-absent");
    expect(await persistence.getSession("session")).toMatchObject({
      status: "released",
      release_reason: "identity-recovery-target-absent",
    });
  } finally {
    sessions.stopCleanupTimer();
  }
});
