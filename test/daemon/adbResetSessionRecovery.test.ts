import { describe, expect, mock, test } from "bun:test";
import {
  AdbResetSessionRecovery,
  type AdbResetSessionRecoveryPoolPort,
} from "../../src/daemon/adbResetSessionRecovery";
import { UnconfirmedRecoveryShutdownError } from "../../src/daemon/androidRebootCoordinator";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import type { AndroidRecoveryRecord } from "../../src/daemon/androidRecoveryRecordLedger";
import type { AndroidEmulatorRecoveryDevice } from "../../src/daemon/devicePool";
import type { Session } from "../../src/daemon/sessionManager";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import { FakeTimer } from "../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const device: AndroidEmulatorRecoveryDevice = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    avdName: "Pixel",
    androidImage: { name: "Pixel", platform: "android", isRunning: true },
    sessionId: "session",
    status: "busy",
    incarnation: 1,
    lastUsedAt: 0,
    assignmentCount: 1,
    errorCount: 0,
  };
  const session: Session = {
    sessionId: "session",
    assignedDevice: device.id,
    platform: "android",
    createdAt: 0,
    lastUsedAt: 0,
    activityGeneration: 0,
    expiresAt: 60_000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: true,
    ownership: "owned",
    livenessPolicy: "heartbeat",
  };
  const ledger = new AndroidRecoveryRecordLedger(
    { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
    timer,
  );
  const events: string[] = [];
  const port: AdbResetSessionRecoveryPoolPort = {
    maxDeferredRecoveryShutdowns: 1,
    unconfirmedRecoveryShutdownCooldownMs: 30_000,
    getRecoveryRecord: (id) => ledger.recoveringSessionLosses.get(id),
    getPooledDevice: () => undefined,
    isPreservedSessionCurrent: () => true,
    startAndroidRecoveryRecord: (id, details, reservations) => {
      events.push("start");
      return ledger.startAndroidRecoveryRecord(id, details, reservations);
    },
    rebootDisconnectedAndroidDevice: mock(async () => {
      events.push("reboot");
      return true;
    }),
    releaseDisconnectedRecoverySessionWithRetry: mock(async () => {
      events.push("release");
    }),
    refreshEmulatorLossRecoverySettlement: async () => {
      events.push("refresh");
    },
    completeEmulatorLossRecovery: async () => {
      events.push("complete");
    },
    settleEmulatorLossIncident: () => {
      events.push("settle");
    },
    finalizeReleasedRecoveryAfterAwait: async () => {
      events.push("released-check");
      return false;
    },
    finalizeReleasedRecoveryAfterCleanupFailure: async () => {
      events.push("cleanup-check");
      return false;
    },
    markAndroidRecoveryReleaseFailure: () => {
      events.push("mark-failure");
    },
    finalizeRecoveryRecord: (id, record) => {
      events.push("finalize");
      const finalization = ledger.finalizeRecoveryRecord(id, record);
      finalization?.finish();
      return finalization !== undefined;
    },
  };
  const coordinator = new AdbResetSessionRecovery(port, timer);
  const recover = () => coordinator.performAdbResetSessionRecovery(device, session, "incident");
  const record = () => ledger.recoveringSessionLosses.get(session.sessionId);
  return { coordinator, port, ledger, timer, device, session, events, recover, record };
}

function failReboot(port: AdbResetSessionRecoveryPoolPort, error = new Error("reboot failed")) {
  port.rebootDisconnectedAndroidDevice = async () => {
    throw error;
  };
}

describe("AdbResetSessionRecovery", () => {
  test("successful reboot preserves options and finalizes before settling", async () => {
    const h = harness();
    expect(await h.recover()).toBe("recovered");
    expect(h.port.rebootDisconnectedAndroidDevice).toHaveBeenCalledWith(h.device, "incident", {
      preserveSessionId: h.session.sessionId,
      preserveSession: h.session,
      bypassRecoveryPolicy: true,
      allowActiveRelaunch: true,
      allowExistingRecoveryReservation: true,
    });
    expect(h.events).toEqual(["start", "reboot", "released-check", "finalize", "settle"]);
    expect(h.record()).toBeUndefined();
  });

  test("failed reboot releases detached session before refreshing and finalizing", async () => {
    const h = harness();
    h.port.rebootDisconnectedAndroidDevice = async () => false;
    expect(await h.recover()).toBe("released");
    expect(h.port.releaseDisconnectedRecoverySessionWithRetry).toHaveBeenCalledWith(
      h.session.sessionId,
      h.device.id,
      deviceRestartReleaseReason(h.device.avdName),
    );
    expect(h.events).toEqual([
      "start",
      "released-check",
      "release",
      "refresh",
      "released-check",
      "finalize",
      "settle",
    ]);
  });

  test("unconfirmed shutdown retains record with a FakeTimer cooldown", async () => {
    const h = harness();
    h.timer.advanceTime(123);
    failReboot(h.port, new UnconfirmedRecoveryShutdownError("Pixel", new Error("still running")));
    expect(await h.recover()).toBe("deferred");
    expect(h.record()).toMatchObject({
      sessionId: "session",
      deviceId: h.device.id,
      expectedDevice: h.device,
      incidentId: "incident",
      avdName: "Pixel",
      deferredUntil: 30_123,
      deferredShutdowns: 1,
      state: "deferred",
      reservations: new Set(["quarantine", "loss"]),
    });
    expect(h.events).toEqual(["start"]);
    // A second unconfirmed shutdown reaches the unchanged deferral limit.
    expect(await h.recover()).toBe("released");
    expect(h.events.slice(1)).toEqual([
      "start",
      "release",
      "refresh",
      "released-check",
      "finalize",
      "settle",
    ]);
  });

  test("ordinary reboot error completes release and finalization", async () => {
    const h = harness();
    failReboot(h.port);
    expect(await h.recover()).toBe("released");
    expect(h.events).toEqual([
      "start",
      "release",
      "refresh",
      "released-check",
      "finalize",
      "settle",
    ]);
  });

  for (const finalized of [true, false]) {
    test(`release failure with cleanup finalization ${finalized} preserves completion ownership`, async () => {
      const h = harness();
      const releaseError = new Error("release failed");
      failReboot(h.port);
      h.port.releaseDisconnectedRecoverySessionWithRetry = async () => {
        throw releaseError;
      };
      h.port.finalizeReleasedRecoveryAfterCleanupFailure = mock(async () => finalized);
      if (finalized) {
        expect(await h.recover()).toBe("released");
        expect(h.events).toEqual(["start"]);
      } else {
        await expect(h.recover()).rejects.toBe(releaseError);
        expect(h.events).toEqual(["start", "mark-failure", "complete"]);
      }
      expect(h.port.finalizeReleasedRecoveryAfterCleanupFailure).toHaveBeenCalledWith(
        h.record(),
        "incident",
        releaseError,
      );
      expect(h.record()?.state).toBe("pending");
      expect(h.events).not.toContain("finalize");
      expect(h.events).not.toContain("settle");
    });
  }

  test("release finalized after a caught reboot error skips outer finalization", async () => {
    const h = harness();
    failReboot(h.port);
    h.port.finalizeReleasedRecoveryAfterAwait = async () => true;
    expect(await h.recover()).toBe("released");
    expect(h.events).toEqual(["start", "release", "refresh"]);
  });

  test("release detected after reboot completes without releasing again", async () => {
    const h = harness();
    h.port.finalizeReleasedRecoveryAfterAwait = async () => true;
    expect(await h.recover()).toBe("released");
    expect(h.events).toEqual(["start", "reboot", "finalize", "settle"]);
  });

  for (const stillAttached of [true, false]) {
    test(`detached release ignores ${stillAttached ? "still attached devices" : "stale sessions"}`, async () => {
      const h = harness();
      if (stillAttached) {
        h.port.getPooledDevice = () => h.device;
      } else {
        h.port.isPreservedSessionCurrent = () => false;
      }
      await h.coordinator.releasePreservedAdbResetSessionIfDetached(h.device, h.session);
      expect(h.port.releaseDisconnectedRecoverySessionWithRetry).not.toHaveBeenCalled();
    });
  }

  test("post-reboot false result passes the same record through both release checks", async () => {
    const h = harness();
    const record: AndroidRecoveryRecord = h.ledger.startAndroidRecoveryRecord(
      h.session.sessionId,
      { deviceId: h.device.id },
      [],
    );
    h.port.finalizeReleasedRecoveryAfterAwait = mock(async () => false);
    expect(
      await h.coordinator.finishAdbResetRecoveryAfterReboot(
        record,
        false,
        h.device,
        h.session,
        "incident",
      ),
    ).toBe("released");
    expect(h.port.finalizeReleasedRecoveryAfterAwait).toHaveBeenCalledTimes(2);
    expect(h.port.finalizeReleasedRecoveryAfterAwait).toHaveBeenNthCalledWith(
      1,
      record,
      "incident",
    );
    expect(h.port.finalizeReleasedRecoveryAfterAwait).toHaveBeenNthCalledWith(
      2,
      record,
      "incident",
    );
    expect(h.events).toEqual(["release", "refresh"]);
  });
});
