import { expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool } from "../../src/daemon/devicePool";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { MISSING_DEVICE_MISS_THRESHOLD } from "../../src/daemon/missingDeviceLiveness";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { ExecutionTracker, executionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

interface DisconnectMonitorSurface {
  deviceDisconnectMonitor: SingleFlightInterval;
  deviceDisconnectMisses: Map<string, number>;
  confirmedDisconnectedDeviceIds: Set<string>;
  startDeviceDisconnectMonitor(
    manager: MissingDeviceManager,
    listRecordings: () => Promise<[]>,
  ): void;
}

class MissingDeviceManager extends FakeDeviceManager {
  async getAndroidOfflineDeviceIds() {
    return new Set<string>();
  }
  async recoverAndroidOfflineDevices() {}
}

async function withMonitor(
  platform: "android" | "ios",
  action: (h: Awaited<ReturnType<typeof monitorHarness>>) => Promise<void>,
  initiatingSessionId = "kill-session",
) {
  const h = await monitorHarness(platform, initiatingSessionId);
  try {
    await action(h);
  } finally {
    await h.daemon.deviceDisconnectMonitor.stop();
    h.tracker.endExecution(h.execution.id);
    h.tracker.endExecution(h.killExecution.id);
    h.cancel.mockRestore();
    h.warn.mockRestore();
  }
}

async function monitorHarness(platform: "android" | "ios", initiatingSessionId: string) {
  const timer = new FakeTimer();
  const ids = new FakeIdGenerator();
  const incidents = new InMemoryEmulatorLossIncidentStore(timer, ids);
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new MissingDeviceManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      idGenerator: ids,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      emulatorLossIncidentStore: incidents,
      recoveryPolicy: { onLoss: false, maxAttempts: 0 },
      deviceSessionContinuityEnabled: false,
    }),
  );
  const booted: BootedDevice = {
    deviceId: platform === "android" ? "emulator-5554" : "sim-1",
    name: "Monitor device",
    platform,
  };
  const image: DeviceInfo = { name: booted.name, platform, source: "local", isRunning: true };
  manager.bootedDevices = [booted];
  await pool.addDevice(booted, image);
  await pool.bindOrReuseDeviceSession(
    "kill-session",
    booted.deviceId,
    platform,
    image,
    undefined,
    booted,
  );
  const device = pool.getDevice(booted.deviceId)!;
  manager.bootedDevices = [];

  // Like the existing monitor harnesses, use the real daemon tick without
  // constructing its unrelated socket/database/process services. Keep pool,
  // shutdown reservation, incident recording, and session release real.
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    timer,
    devicePool: pool,
    sessionManager: sessions,
    deviceDisconnectMonitor: null,
    deviceDisconnectMisses: new Map<string, number>(),
    deviceDisconnectMissIncarnations: new Map(),
    confirmedDisconnectedDeviceIds: new Set<string>(),
    forceDisconnectedDeviceIds: new Set(),
    forceDisconnectedDeviceGenerations: new Map(),
    offlineRecoveryAttemptedDeviceIds: new Set(),
    offlineRecoveryAttemptedIncarnations: new Map(),
    deferredSessionRecoverySweeps: new Set(),
  }) as DisconnectMonitorSurface;
  const tracker = new ExecutionTracker(timer, ids);
  const execution = tracker.startExecution(
    initiatingSessionId === "kill-session" ? "killDevice" : "inputText",
    undefined,
    "kill-session",
  );
  const killExecution =
    initiatingSessionId === "kill-session"
      ? execution
      : tracker.startExecution("killDevice", undefined, initiatingSessionId);
  const cancel = spyOn(executionTracker, "cancelSessionUuidExecutions").mockImplementation(
    (sessionId, reason) => tracker.cancelSessionUuidExecutions(sessionId, reason),
  );
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  daemon.startDeviceDisconnectMonitor(manager, async () => []);
  const tick = async () => {
    // The kill's owner remains connected while its device disappears.
    if (sessions.getSession("kill-session")) {
      sessions.recordHeartbeat("kill-session");
    }
    timer.advanceTime(5000);
    await daemon.deviceDisconnectMonitor.run();
  };
  const reachThreshold = async () => {
    for (let miss = 0; miss < MISSING_DEVICE_MISS_THRESHOLD; miss++) {
      await tick();
    }
  };
  return {
    daemon,
    pool,
    sessions,
    device,
    incidents,
    tracker,
    execution,
    killExecution,
    cancel,
    warn,
    tick,
    reachThreshold,
  };
}

async function expectDeferred(h: Awaited<ReturnType<typeof monitorHarness>>) {
  expect(h.execution.abortController.signal.aborted).toBe(false);
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.killExecution.abortController.signal.aborted).toBe(false);
  expect(await h.incidents.list()).toEqual([]);
  expect(h.sessions.getSession("kill-session")).not.toBeNull();
  expect(h.pool.getDevice(h.device.id)).toBe(h.device);
  expect(h.daemon.confirmedDisconnectedDeviceIds.has(h.device.id)).toBe(false);
  expect(h.daemon.deviceDisconnectMisses.get(h.device.id)).toBe(MISSING_DEVICE_MISS_THRESHOLD);
  expect(
    h.warn.mock.calls.filter(([message]) =>
      message.includes("Retaining intentionally stopped device"),
    ),
  ).toHaveLength(0);
}

async function expectCleanedUp(h: Awaited<ReturnType<typeof monitorHarness>>) {
  expect(h.execution.abortController.signal.aborted).toBe(true);
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.sessions.getSession("kill-session")).toBeNull();
  expect(h.pool.getDevice(h.device.id)).toBeNull();
  expect(h.daemon.confirmedDisconnectedDeviceIds.has(h.device.id)).toBe(true);
  expect(h.daemon.deviceDisconnectMisses.has(h.device.id)).toBe(false);
  const incidents = await h.incidents.list();
  if (h.device.platform === "android") {
    expect(incidents).toHaveLength(1);
    expect(incidents[0].recovery.outcome).toBe("not-attempted");
    expect(incidents[0].detectionPath).toBe("device-discovery-miss");
    const reason = `device-disconnected:${h.device.id};incident=${incidents[0].id}`;
    expect(h.cancel).toHaveBeenCalledWith("kill-session", reason);
    expect(h.execution.cancelReason).toMatchObject({
      code: "device_lost",
      deviceId: h.device.id,
      incidentId: incidents[0].id,
      message: reason,
    });
  }
}

for (const platform of ["ios", "android"] as const) {
  test(`${platform} shutdown reservation protects an in-flight kill at the third miss`, async () => {
    await withMonitor(platform, async (h) => {
      const reservation = await h.pool.reserveDeviceForShutdown(h.device.id);
      expect(reservation).toBeDefined();
      try {
        await h.reachThreshold();
        await expectDeferred(h);
        await h.tick();
        await expectDeferred(h);
      } finally {
        await reservation?.release();
        reservation?.releaseRecoveryRouteLease();
      }
    });
  });
}

test("an Android mark without a reservation cancels and releases the ghost session without repeated warnings", async () => {
  await withMonitor("android", async (h) => {
    const reservation = await h.pool.reserveDeviceForShutdown(h.device.id);
    expect(reservation).toBeDefined();
    h.pool.markIntentionalShutdown(h.device.id);
    await reservation?.release();
    reservation?.releaseRecoveryRouteLease();
    expect(await h.pool.isShutdownReserved(h.device.id)).toBe(true);
    expect(await h.pool.isShutdownReservationHeld(h.device.id)).toBe(false);
    await h.tick();
    await h.tick();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(await h.incidents.list()).toEqual([]);
    await h.tick();
    await expectCleanedUp(h);
    for (let poll = 0; poll < 20; poll++) {
      await h.tick();
    }
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.sessions.getSession("kill-session")).toBeNull();
    expect(h.pool.getDevice(h.device.id)).toBeNull();
    expect(await h.incidents.list()).toHaveLength(1);
    expect(
      h.warn.mock.calls.filter(([message]) =>
        message.includes("Retaining intentionally stopped device"),
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(await h.pool.isShutdownReserved(h.device.id)).toBe(false);
  });
});

test("an Android reservation with an intentional-shutdown mark protects the in-flight kill", async () => {
  await withMonitor("android", async (h) => {
    const reservation = await h.pool.reserveDeviceForShutdown(h.device.id);
    expect(reservation).toBeDefined();
    h.pool.markIntentionalShutdown(h.device.id);
    try {
      await h.reachThreshold();
      await expectDeferred(h);
      for (let poll = 0; poll < 20; poll++) {
        await h.tick();
      }
      await expectDeferred(h);
    } finally {
      await reservation?.release();
      reservation?.releaseRecoveryRouteLease();
    }
  });
});

test("a different session's reserved kill does not cancel the device owner's executions", async () => {
  await withMonitor(
    "android",
    async (h) => {
      expect(h.device.sessionId).toBe("kill-session");
      expect(h.killExecution.sessionUuid).toBe("other-session");
      const reservation = await h.pool.reserveDeviceForShutdown(h.device.id);
      expect(reservation?.session).toBe(h.sessions.getSession("kill-session")!);
      try {
        await h.reachThreshold();
        await expectDeferred(h);
        await h.tick();
        await expectDeferred(h);
      } finally {
        await reservation?.release();
        reservation?.releaseRecoveryRouteLease();
      }
    },
    "other-session",
  );
});

test("an absent device with neither shutdown signal is cancelled and cleaned up", async () => {
  await withMonitor("android", async (h) => {
    await h.tick();
    await h.tick();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(await h.incidents.list()).toEqual([]);
    await h.tick();
    await expectCleanedUp(h);
  });
});

test("releasing a failed kill's reservation lets the very next miss cancel and clean up", async () => {
  await withMonitor("android", async (h) => {
    const reservation = await h.pool.reserveDeviceForShutdown(h.device.id);
    expect(reservation).toBeDefined();
    try {
      await h.reachThreshold();
      await expectDeferred(h);
    } finally {
      await reservation?.release();
      reservation?.releaseRecoveryRouteLease();
    }
    await h.tick();
    await expectCleanedUp(h);
  });
});

test("a stale Android shutdown marker does not suppress cancellation or mutate on read", async () => {
  await withMonitor("android", async (h) => {
    h.pool.markIntentionalShutdown(h.device.id);
    const markedIncarnation = h.device.incarnation;
    h.device.incarnation++;
    expect(await h.pool.isShutdownReserved(h.device.id)).toBe(false);
    h.device.incarnation = markedIncarnation;
    expect(await h.pool.isShutdownReserved(h.device.id)).toBe(true);
    h.device.incarnation++;
    await h.reachThreshold();
    await expectCleanedUp(h);
  });
});
