import { expect, mock, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

test.each(["waiting", "in-flight", "absent", "prepared"])(
  "captured disconnect preserves the %s preparation path",
  async (branch) => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        timer,
        deviceManager: new FakeDeviceManager(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    const preparation =
      branch === "prepared" ? { sessionId: "session", token: Symbol() } : undefined;
    pool.isShutdownReservationHeld = async () => false;
    pool.prepareSessionPreservingRecovery = () => preparation;
    pool.recordEmulatorLossIncident = async () => "incident";
    const wait = mock(async () => branch === "waiting");
    pool.waitForSessionPreservingRecovery = wait;
    const inFlight = mock(() => branch === "in-flight");
    pool.isSessionRecoveryInFlight = inFlight;
    const finishIncident = mock(async () => {});
    pool.finishEmulatorLossIncident = finishIncident;
    const finishPreparation = mock(() => {});
    pool.finishSessionPreservingRecoveryPreparation = finishPreparation;
    const daemon: Daemon = Object.create(Daemon.prototype);
    Object.assign(daemon, { devicePool: pool, forceDisconnectedDeviceIds: new Set<string>() });
    daemon["shouldSkipStaleDisconnectCleanup"] = async () => false;
    daemon["isCapturedDisconnectTargetCurrent"] = () => true;
    const retire = mock(() => {});
    daemon["retireAdbServerResetDisconnectState"] = retire;
    try {
      expect(
        await daemon["recordAndTryRecoverCapturedDisconnect"](
          "device",
          null,
          0,
          "session",
          null,
          undefined,
        ),
      ).toEqual({
        incidentId: "incident",
        handled: branch === "waiting" || branch === "in-flight",
      });
      expect(wait.mock.calls.length).toBe(branch === "prepared" ? 0 : 1);
      expect(inFlight.mock.calls.length).toBe(
        branch === "prepared" || branch === "waiting" ? 0 : 1,
      );
      expect(finishIncident.mock.calls).toEqual(
        branch === "in-flight" ? [["incident", "not-attempted"]] : [],
      );
      expect(retire.mock.calls).toEqual(
        branch === "waiting" || branch === "in-flight" ? [["device", undefined]] : [],
      );
      expect(finishPreparation.mock.calls).toEqual([[preparation]]);
    } finally {
      sessions.stopCleanupTimer();
    }
  },
);

test.each([
  { outcome: "not-attempted", hasSession: true },
  { outcome: "recovered", hasSession: true },
  { outcome: "recovered", hasSession: false },
] as const)(
  "captured disconnect recovery outcome=$outcome session present=$hasSession",
  async ({ outcome, hasSession }) => {
    const deviceId = "captured-device";
    const incidentId = "loss-incident";
    const sessionId = "bound-session";
    const assignmentCount = 17;
    const forceGeneration = 43;
    const pooledDevice: PooledDevice = {
      id: deviceId,
      name: "Captured emulator",
      platform: "android",
      sessionId,
      status: "busy",
      lastUsedAt: 101,
      assignmentCount,
      errorCount: 2,
      incarnation: 29,
    };
    const session: Session | null = hasSession
      ? {
          sessionId,
          assignedDevice: deviceId,
          platform: "android",
          createdAt: 103,
          lastUsedAt: 107,
          activityGeneration: 31,
          expiresAt: 5003,
          cacheData: {},
          lastHeartbeat: 109,
          sessionTimeoutMs: 2003,
          heartbeatTimeoutMs: 3001,
          heartbeatTimeoutSource: "custom",
          hasReceivedHeartbeat: true,
          ownership: "owned",
          livenessPolicy: "heartbeat",
        }
      : null;
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        timer,
        deviceManager: new FakeDeviceManager(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    pool.isShutdownReservationHeld = async () => false;
    const prepare = mock<DevicePool["prepareSessionPreservingRecovery"]>(() => undefined);
    pool.prepareSessionPreservingRecovery = prepare;
    pool.recordEmulatorLossIncident = async () => incidentId;
    const wait = mock(async () => false);
    pool.waitForSessionPreservingRecovery = wait;
    const inFlight = mock(() => false);
    pool.isSessionRecoveryInFlight = inFlight;
    const recover = mock<DevicePool["recoverSessionBoundDeviceAfterLoss"]>(async () => outcome);
    pool.recoverSessionBoundDeviceAfterLoss = recover;
    const finish = mock(() => {});
    pool.finishSessionPreservingRecoveryPreparation = finish;
    const daemon: Daemon = Object.create(Daemon.prototype);
    Object.assign(daemon, { devicePool: pool, forceDisconnectedDeviceIds: new Set<string>() });
    const skip = mock<Daemon["shouldSkipStaleDisconnectCleanup"]>(async () => false);
    daemon["shouldSkipStaleDisconnectCleanup"] = skip;
    const current = mock<Daemon["isCapturedDisconnectTargetCurrent"]>(() => true);
    daemon["isCapturedDisconnectTargetCurrent"] = current;
    const retire = mock<Daemon["retireAdbServerResetDisconnectState"]>(() => {});
    daemon["retireAdbServerResetDisconnectState"] = retire;
    try {
      expect(
        await daemon["recordAndTryRecoverCapturedDisconnect"](
          deviceId,
          pooledDevice,
          assignmentCount,
          sessionId,
          session,
          forceGeneration,
        ),
      ).toEqual({ incidentId, handled: hasSession && outcome !== "not-attempted" });
      expect(prepare.mock.calls).toEqual([[deviceId, pooledDevice]]);
      expect(skip.mock.calls).toEqual([[pooledDevice, deviceId, forceGeneration]]);
      expect(current.mock.calls).toEqual([
        [deviceId, pooledDevice, assignmentCount, sessionId, session],
      ]);
      expect(current.mock.calls[0][1]).toBe(pooledDevice);
      expect(current.mock.calls[0][4]).toBe(session);
      expect(wait.mock.calls).toEqual([[sessionId, incidentId]]);
      expect(inFlight.mock.calls).toEqual([[sessionId]]);
      expect(recover.mock.calls).toEqual(hasSession ? [[deviceId, incidentId, pooledDevice]] : []);
      if (hasSession) {
        expect(recover.mock.calls[0][2]).toBe(pooledDevice);
      }
      expect(retire.mock.calls).toEqual(
        hasSession && outcome !== "not-attempted" ? [[deviceId, forceGeneration]] : [],
      );
      expect(finish.mock.calls).toEqual(hasSession ? [[undefined], [undefined]] : [[undefined]]);
    } finally {
      sessions.stopCleanupTimer();
    }
  },
);
