import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { deviceLossCancellationReason } from "../../src/daemon/emulatorLossIncident";
import { describe, expect, test } from "bun:test";
import { Mutex } from "async-mutex";
import {
  AdbServerResetQuarantine,
  type AdbServerResetQuarantinePoolPort,
} from "../../src/daemon/adbServerResetQuarantine";
import type { AndroidRecoveryRecord } from "../../src/daemon/androidRecoveryRecordLedger";
import type { DeviceRecoveryCoordinator } from "../../src/daemon/deviceRecoveryCoordinator";
import type { AdbServerResetRecoveryReservation, PooledDevice } from "../../src/daemon/devicePool";
import type { Session, SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";

function device(sessionId: string | null = null): PooledDevice {
  return {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    sessionId,
    status: sessionId ? "busy" : "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
    avdName: "Pixel_AVD",
    androidImage: { name: "Pixel_AVD", platform: "android", isRunning: true, source: "local" },
  };
}

function harness(session?: Session) {
  const timer = new FakeTimer();
  const devices = new Map<string, PooledDevice>();
  const reservations = new Map<string, AdbServerResetRecoveryReservation>();
  const records = new Map<string, AndroidRecoveryRecord>();
  const finalized: string[] = [];
  const completed: Array<[string, string]> = [];
  const settled: string[] = [];
  const removed: string[] = [];
  const mutex = new Mutex();
  let cancel = async (_sessionId: string, _reason: string): Promise<number> => 0;
  let cancelDevice = async (_deviceId: string, _reason: string): Promise<number> => 0;
  const coordinator = {
    finalizeRecoveryRecord: (id: string, expected?: AndroidRecoveryRecord) => {
      finalized.push(id);
      const record = records.get(id);
      if (record && (!expected || expected === record)) {
        quarantine.clearAdbResetRecoveryReservation(record);
        records.delete(id);
      }
      return true;
    },
    waitForRecoverySettlements: async (promises: readonly Promise<void>[]) => {
      await Promise.all(promises);
    },
  } as unknown as DeviceRecoveryCoordinator;
  const port: AdbServerResetQuarantinePoolPort = {
    getAssignmentMutex: () => mutex,
    getDevices: () => devices,
    getSessionManager: () =>
      ({
        getSession: (id: string) => (id === session?.sessionId ? session : null),
        getSessionForDevice: (id: string) =>
          id === session?.assignedDevice ? session.sessionId : null,
        isCurrentSession: (current: Session) => current === session,
      }) as SessionManager,
    getStartedDeviceProcesses: () => new Map(),
    getAdbServerResetTrackedProcesses: () => new WeakMap(),
    getAdbServerResetRecoveryReservations: () => reservations,
    getAndroidStartupLeases: () => new Map(),
    getRecoveringAndroidImages: () => new Map(),
    getRecoveringAndroidDeviceIds: () => new Set(),
    getRecoveringSessionLosses: () => records,
    getFailedTerminalRecoveryReleases: () => new Set(),
    getRecoveryCoordinator: () => coordinator,
    getAfterAndroidStartupRecoverySnapshot: () => undefined,
    getDevice: (id) => devices.get(id) ?? null,
    isPreservedSessionCurrent: (current, id) =>
      current === session && current.assignedDevice === id,
    isAndroidEmulatorActiveRelaunchEligible: (
      current,
    ): current is PooledDevice & {
      avdName: string;
      androidImage: NonNullable<PooledDevice["androidImage"]>;
    } => Boolean(current.avdName && current.androidImage),
    removeDevice: async (id) => {
      removed.push(id);
      devices.delete(id);
    },
    startAndroidRecoveryRecord: (id, details, kinds, replace) => {
      const record = !replace ? records.get(id) : undefined;
      const next: AndroidRecoveryRecord = record ?? {
        sessionId: id,
        generation: 1,
        deviceId: details.deviceId ?? "",
        deferredShutdowns: 0,
        state: "pending",
        reservations: new Set(),
      };
      Object.assign(next, details);
      kinds.forEach((kind) => next.reservations.add(kind));
      records.set(id, next);
      return next;
    },
    recordEmulatorLossIncident: async () => "incident-1",
    cancelDeviceExecutions: (id, reason) => cancelDevice(id, reason),
    cancelDeviceSessionExecutions: (id, reason) => cancel(id, reason),
    completeEmulatorLossRecovery: async (id, outcome) => {
      completed.push([id, outcome]);
    },
    settleEmulatorLossIncident: (id) => {
      settled.push(id);
    },
    finishEmulatorLossIncident: async () => {},
    stopTrackedEmulatorProcess: async () => {},
  };
  const quarantine = new AdbServerResetQuarantine(port);
  return {
    quarantine,
    timer,
    devices,
    reservations,
    records,
    finalized,
    completed,
    settled,
    removed,
    setDeviceCancel: (next: typeof cancelDevice) => {
      cancelDevice = next;
    },
    setCancel: (next: typeof cancel) => {
      cancel = next;
    },
  };
}

function reservation(timer: FakeTimer): AdbServerResetRecoveryReservation {
  const settled = timer.sleep(5).then(() => {});
  const resolve = () => timer.advanceTime(5);
  return {
    deviceId: "emulator-5554",
    image: { name: "Pixel_AVD", platform: "android", isRunning: false, source: "local" },
    cancelled: false,
    settled,
    resolve,
  };
}

describe("AdbServerResetQuarantine", () => {
  test.each([false, true])(
    "reset cancels serial-bound work, including idle cohort members (session=%s)",
    async (withSession) => {
      const session = withSession
        ? ({
            sessionId: "session-1",
            assignedDevice: "emulator-5554",
            platform: "android",
          } as Session)
        : undefined;
      const h = harness(session);
      const tracker = new ExecutionTracker(
        h.timer,
        new FakeIdGenerator(["bound", "session", "other"]),
      );
      const member = device(session?.sessionId);
      h.devices.set(member.id, member);
      const bound = tracker.startExecution("takeScreenshot");
      tracker.bindDeviceExecution(bound.id, member.id);
      const sessionOnly = tracker.startExecution("takeScreenshot", undefined, session?.sessionId);
      const other = tracker.startExecution("takeScreenshot");
      tracker.bindDeviceExecution(other.id, "emulator-5556");
      const deviceReasons: string[] = [];
      h.setDeviceCancel(async (id, reason) => {
        deviceReasons.push(reason);
        return tracker.cancelDeviceExecutions(id, reason);
      });
      h.setCancel((id, reason) => tracker.cancelDeviceSessionExecutions(id, reason));
      await h.quarantine.detachAdbServerResetCohort([member]);
      expect(bound.abortController.signal.aborted).toBe(true);
      expect(sessionOnly.abortController.signal.aborted).toBe(withSession);
      expect(other.abortController.signal.aborted).toBe(false);
      expect(deviceReasons).toEqual([
        deviceLossCancellationReason(member.id, withSession ? "incident-1" : undefined),
      ]);
    },
  );

  test("reset issues device and session cancellation before awaiting either drain", async () => {
    const session = {
      sessionId: "session-1",
      assignedDevice: "emulator-5554",
      platform: "android",
    } as Session;
    const h = harness(session);
    const member = device(session.sessionId);
    h.devices.set(member.id, member);
    const calls: string[] = [];
    let finishDeviceDrain: (() => void) | undefined;
    const deviceDrain = new Promise<void>((resolve) => {
      finishDeviceDrain = resolve;
    });
    h.setDeviceCancel(async () => {
      calls.push("device");
      await deviceDrain;
      return 1;
    });
    h.setCancel(async () => {
      calls.push("session");
      finishDeviceDrain?.();
      return 1;
    });
    await h.quarantine.detachAdbServerResetCohort([member]);
    expect(calls).toEqual(["device", "session"]);
  });

  test("reserves an idle cohort member, then releases its reservation", async () => {
    const h = harness();
    const member = device();
    h.devices.set(member.id, member);

    const result = await h.quarantine.detachAdbServerResetCohort([member]);
    expect(result).toEqual({ devices: [member], deferred: false });
    expect(h.reservations.get(member.avdName!)?.deviceId).toBe(member.id);
    expect(h.removed).toEqual([member.id]);

    const settled = h.reservations.get(member.avdName!)!.settled;
    await h.quarantine.releaseAdbServerResetCohortReservations(result.devices);
    await settled;
    expect(h.reservations.size).toBe(0);
  });

  test("keeps a live session fence until its restored device owns the session", async () => {
    const session = {
      sessionId: "session-1",
      assignedDevice: "emulator-5554",
      platform: "android",
    } as Session;
    const h = harness(session);
    const member = device(session.sessionId);
    h.devices.set(member.id, member);
    const result = await h.quarantine.detachAdbServerResetCohort([member]);

    await h.quarantine.releaseAdbServerResetCohortReservations(result.devices);
    expect(h.reservations.has(member.avdName!)).toBe(true);
    expect(h.finalized).toEqual([]);

    const restored = device(session.sessionId);
    h.devices.set(restored.id, restored);
    await h.quarantine.releaseAdbServerResetCohortReservations(result.devices);
    expect(h.finalized).toEqual([session.sessionId]);
    expect(h.reservations.size).toBe(0);
  });

  test("consumes a reset cancellation once for the matching device", () => {
    const h = harness();
    const member = device();
    const pending = reservation(h.timer);
    pending.cancelled = true;
    h.reservations.set(member.avdName!, pending);

    expect(h.quarantine.consumeAdbServerResetRecoveryCancellation({ ...member, id: "other" })).toBe(
      false,
    );
    expect(h.quarantine.consumeAdbServerResetRecoveryCancellation(member)).toBe(true);
    expect(h.quarantine.consumeAdbServerResetRecoveryCancellation(member)).toBe(false);
  });

  test("waits for the reset reservation to settle", async () => {
    const h = harness();
    const pending = reservation(h.timer);
    h.reservations.set("Pixel_AVD", pending);
    let finished = false;
    const waiting = h.quarantine.waitForAdbServerResetRecovery("Pixel_AVD").then(() => {
      finished = true;
    });

    await Promise.resolve();
    expect(finished).toBe(false);
    pending.resolve();
    await waiting;
    expect(finished).toBe(true);
  });

  test("settles incidents without detaching when cohort preparation fails", async () => {
    const session = {
      sessionId: "session-1",
      assignedDevice: "emulator-5554",
      platform: "android",
    } as Session;
    const h = harness(session);
    const member = device(session.sessionId);
    h.devices.set(member.id, member);
    h.setCancel(async () => {
      throw new Error("cancellation failed");
    });

    await expect(h.quarantine.detachAdbServerResetCohort([member])).rejects.toThrow(
      "cancellation failed",
    );
    expect(h.completed).toEqual([["incident-1", "exhausted"]]);
    expect(h.settled).toEqual(["incident-1"]);
    expect(h.removed).toEqual([]);
    expect(member.sessionId).toBe(session.sessionId);
  });
});
