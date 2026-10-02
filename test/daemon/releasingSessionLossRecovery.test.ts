import { expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { DeviceRecoveryPoolPort } from "../../src/daemon/deviceRecoveryCoordinator";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const sessionId = "releasing-loss-session";
const android: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel_8_API_35",
  platform: "android",
};
const ios: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  name: "iPhone 16 Pro",
  platform: "ios",
};

interface RecoveryInternals {
  performSessionPreservingRecovery: DeviceRecoveryPoolPort["performSessionPreservingRecovery"];
  finishEmulatorLossIncident: DevicePool["finishEmulatorLossIncident"];
  emulatorLossRecoveryResolvers: Map<string, () => void>;
  emulatorLossRecoverySettlements: Map<string, Promise<void>>;
}

async function harness(booted: BootedDevice) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const sessions = new SessionManager(timer, persistence);
  const manager = new FakeDeviceManager([], [booted]);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceSessionContinuityEnabled: true,
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
    }),
  );
  await pool.initializeWithDevices([booted]);
  const session = await sessions.createSession(sessionId, booted.deviceId, booted.platform);
  const device = pool.getDevice(booted.deviceId)!;
  device.sessionId = sessionId;
  device.status = "assigned";
  // Same private-map inspection as devicePool.test.ts, with the public finalizer as the overlap.
  const internals = pool as RecoveryInternals;
  return { sessions, persistence, pool, session, device, internals };
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

for (const booted of [android, ios]) {
  for (const reason of ["explicit-release", "heartbeat-timeout"]) {
    test(`${booted.platform} loss joins ${reason} without starting recovery`, async () => {
      const { sessions, persistence, pool, session, device, internals } = await harness(booted);
      const finishSetup = Promise.withResolvers<void>();
      const perform = spyOn(internals, "performSessionPreservingRecovery");
      const finishIncident = spyOn(pool, "finishEmulatorLossIncident");
      try {
        const setup = sessions.trackSessionSetup(session, () => finishSetup.promise);
        const release = sessions.releaseSession(sessionId, reason);
        await flush();
        expect(sessions.getReleasingSession(sessionId)).toBe(session);
        // Only Android opens emulator incidents; iOS exercises the same coordinator wait without one.
        const incidentId = await pool.recordEmulatorLossIncident(
          device.id,
          "device-discovery-miss",
        );
        if (booted.platform === "android") {
          expect(incidentId).toBeDefined();
          expect(internals.emulatorLossRecoveryResolvers.has(incidentId!)).toBe(true);
          expect(internals.emulatorLossRecoverySettlements.has(incidentId!)).toBe(true);
        }
        let returned = false;
        const recovery = pool.recoverSessionBoundDeviceAfterLoss(device.id, incidentId, device);
        void recovery.then(() => {
          returned = true;
        });
        await flush();
        expect(perform).not.toHaveBeenCalled();
        expect(returned).toBe(false);
        expect(finishIncident).not.toHaveBeenCalled();
        finishSetup.resolve();
        await Promise.all([setup, release]);
        expect(await recovery).toBe("not-attempted");
        expect(perform).not.toHaveBeenCalled();
        expect(pool.isSessionRecoveryInFlight(sessionId)).toBe(false);
        expect(sessions.getSession(sessionId)).toBeNull();
        expect(sessions.getTerminalReleaseSnapshot(sessionId)).toMatchObject({
          releaseReason: reason,
          terminal: true,
        });
        expect(await persistence.getSession?.(sessionId)).toMatchObject({ release_reason: reason });
        expect(finishIncident).toHaveBeenCalledWith(incidentId, "not-attempted");
        // A later loss probe has no release to join and still cannot start recovery.
        expect(await pool.recoverSessionBoundDeviceAfterLoss(device.id, incidentId, device)).toBe(
          "not-attempted",
        );
        expect(perform).not.toHaveBeenCalled();
        expect(finishIncident).toHaveBeenCalledTimes(1);
        if (incidentId) {
          const settled = await pool.waitForEmulatorLossIncident(incidentId, 0);
          expect(settled).toMatchObject({
            session: { state: "released" },
            recovery: { outcome: "not-attempted", attempts: [] },
          });
          expect(internals.emulatorLossRecoveryResolvers.has(incidentId)).toBe(false);
          expect(internals.emulatorLossRecoverySettlements.has(incidentId)).toBe(false);
          // The caller's normal fallthrough finalization is harmless.
          await pool.finishEmulatorLossIncident(incidentId, "not-attempted");
          expect(await pool.waitForEmulatorLossIncident(incidentId, 0)).toEqual(settled);
          expect(internals.emulatorLossRecoveryResolvers.has(incidentId)).toBe(false);
          expect(internals.emulatorLossRecoverySettlements.has(incidentId)).toBe(false);
        }
      } finally {
        finishSetup.resolve();
        perform.mockRestore();
        finishIncident.mockRestore();
        sessions.stopCleanupTimer();
      }
    });
  }

  test(`${booted.platform} admitted session still starts ordinary recovery`, async () => {
    const { sessions, pool, device, internals } = await harness(booted);
    const perform = spyOn(internals, "performSessionPreservingRecovery");
    try {
      const incidentId = await pool.recordEmulatorLossIncident(device.id, "device-discovery-miss");
      expect(await pool.recoverSessionBoundDeviceAfterLoss(device.id, incidentId, device)).toBe(
        "released",
      );
      expect(perform).toHaveBeenCalledTimes(1);
      if (incidentId) {
        expect(await pool.waitForEmulatorLossIncident(incidentId, 0)).toMatchObject({
          session: { state: "awaiting-device" },
          recovery: { outcome: "not-attempted", attempts: [] },
        });
        expect(internals.emulatorLossRecoveryResolvers.has(incidentId)).toBe(false);
        expect(internals.emulatorLossRecoverySettlements.has(incidentId)).toBe(false);
      }
    } finally {
      perform.mockRestore();
      sessions.stopCleanupTimer();
    }
  });
}

test("superseded release settles loss as active without starting recovery", async () => {
  const { sessions, pool, session, device, internals } = await harness(android);
  const finishSetup = Promise.withResolvers<void>();
  const perform = spyOn(internals, "performSessionPreservingRecovery");
  let shouldCommit = true;
  try {
    const incidentId = await pool.recordEmulatorLossIncident(device.id, "device-discovery-miss");
    const setup = sessions.trackSessionSetup(session, () => finishSetup.promise);
    const release = sessions.releaseSession(
      sessionId,
      "explicit-release",
      false,
      () => shouldCommit,
    );
    await flush();
    const recovery = pool.recoverSessionBoundAndroidDeviceAfterLoss(device.id, incidentId, device);
    await flush();
    shouldCommit = false;
    finishSetup.resolve();
    await Promise.all([setup, release]);
    expect(await recovery).toBe("not-attempted");
    expect(perform).not.toHaveBeenCalled();
    expect(sessions.isAdmittedForAutomation(session)).toBe(true);
    expect(await pool.waitForEmulatorLossIncident(incidentId!, 0)).toMatchObject({
      session: { state: "active" },
      recovery: { outcome: "not-attempted", attempts: [] },
    });
    expect(internals.emulatorLossRecoveryResolvers.has(incidentId!)).toBe(false);
    expect(internals.emulatorLossRecoverySettlements.has(incidentId!)).toBe(false);
  } finally {
    finishSetup.resolve();
    perform.mockRestore();
    sessions.stopCleanupTimer();
  }
});
