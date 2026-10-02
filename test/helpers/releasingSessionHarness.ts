import { expect } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import {
  SessionManager,
  type Session,
  type SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

export const releasingSessionId = "00000000-0000-4000-8000-000000000001";
export const releasingDeviceId = "emulator-5554";

class DeferredPersistence extends FakeDeviceSessionPersistence {
  readonly releaseStarted = Promise.withResolvers<void>();
  readonly finishRelease = Promise.withResolvers<void>();
  readonly upsertStarted = Promise.withResolvers<void>();
  readonly finishUpsert = Promise.withResolvers<void>();
  deferUpsert = false;
  activityWrites = 0;
  releaseWrites = 0;

  override async markReleased(...args: Parameters<FakeDeviceSessionPersistence["markReleased"]>) {
    this.releaseWrites++;
    this.releaseStarted.resolve();
    await this.finishRelease.promise;
    await super.markReleased(...args);
  }

  override async recordActivity(
    ...args: Parameters<FakeDeviceSessionPersistence["recordActivity"]>
  ) {
    this.activityWrites++;
    await super.recordActivity(...args);
  }

  override async upsertActiveSession(
    ...args: Parameters<FakeDeviceSessionPersistence["upsertActiveSession"]>
  ) {
    if (this.deferUpsert) {
      this.upsertStarted.resolve();
      await this.finishUpsert.promise;
    }
    await super.upsertActiveSession(...args);
  }
}

/** Real session publication and teardown, paused at two injected I/O boundaries. */
export function releasingSessionHarness() {
  const timer = new FakeTimer();
  const persistence = new DeferredPersistence();
  const barrier = new FakeDbWriteBarrier();
  const restoreStarted = Promise.withResolvers<void>();
  const finishRestore = Promise.withResolvers<void>();
  const restores: string[] = [];
  const poolReleases: Array<[string, string]> = [];
  const manager = new SessionManager(
    timer,
    persistence,
    () => barrier,
    (device) => ({
      restore: async () => {
        restores.push(device.deviceId);
        restoreStarted.resolve();
        await finishRestore.promise;
      },
    }),
  );
  const observers = new ObserverSessionRegistry(timer, 10000);
  manager.setObserverSessionRegistry(observers);
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getObserverSessionRegistry: () => observers,
    getDeviceSessionRegistry: () => ({ list: () => [] }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      releaseDevice: async (device, owner) => {
        poolReleases.push([device, owner]);
      },
    }),
  };
  const request = (method: string) =>
    handleDaemonRequest(
      {
        id: "test",
        type: "daemon_request",
        method,
        params: { sessionId: releasingSessionId },
      },
      state,
    );
  return {
    timer,
    persistence,
    manager,
    observers,
    state,
    request,
    async create() {
      return await manager.createSession(releasingSessionId, releasingDeviceId, "android");
    },
    async createUnregisteredSession() {
      const registered = await manager.createSession(
        releasingSessionId,
        releasingDeviceId,
        "android",
      );
      const session = { ...registered };
      manager.getSession = (id) => (id === releasingSessionId ? session : null);
      manager.getAllSessions = () => [session];
      expect(manager.isAdmittedForAutomation(session)).toBe(false);
      expect(manager.getReleasingSession(releasingSessionId)).toBeNull();
      return session;
    },
    holdTerminalFence(session: Session) {
      // Model a failed terminal persistence attempt awaiting retry, with no release in flight.
      const internals = manager as unknown as {
        terminalReleaseSnapshots: Map<string, SessionReleaseSnapshot>;
      };
      internals.terminalReleaseSnapshots.set(session.sessionId, {
        sessionId: session.sessionId,
        deviceId: session.assignedDevice!,
        releaseReason: "heartbeat-timeout",
        releasedAtMs: timer.now(),
        terminal: true,
        heartbeat: {
          lastHeartbeatMs: session.lastHeartbeat,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          timeoutMs: session.heartbeatTimeoutMs,
          ageMs: 0,
        },
      });
      expect(manager.isAdmittedForAutomation(session)).toBe(false);
      expect(manager.getReleasingSession(session.sessionId)).toBeNull();
    },
    async beginRelease(phase: "A" | "B" = "A") {
      manager.setKeepScreenAwake(releasingSessionId, { applied: true });
      const release = manager.releaseSession(releasingSessionId);
      const joined = request("daemon/releaseSession");
      await restoreStarted.promise;
      if (phase === "B") {
        finishRestore.resolve();
        await persistence.releaseStarted.promise;
        expect(manager.getSession(releasingSessionId)).toBeNull();
        expect(manager.getReleasingSession(releasingSessionId)).not.toBeNull();
      }
      return async () => {
        finishRestore.resolve();
        persistence.finishRelease.resolve();
        expect(await release).toBe(releasingDeviceId);
        expect(await joined).toEqual({
          success: true,
          result: {
            message: `Session ${releasingSessionId} released`,
            device: releasingDeviceId,
            alreadyReleased: false,
          },
        });
        expect(restores).toEqual([releasingDeviceId]);
        expect(poolReleases).toEqual([[releasingDeviceId, releasingSessionId]]);
        expect(persistence.releaseWrites).toBe(1);
        expect(await persistence.getSession?.(releasingSessionId)).toMatchObject({
          status: "released",
          release_reason: "explicit-release",
        });
        expect(manager.getTerminalReleaseSnapshot(releasingSessionId)).toMatchObject({
          releaseReason: "explicit-release",
          terminal: true,
        });
        expect(manager.getSession(releasingSessionId)).toBeNull();
        expect(manager.getReleasingSession(releasingSessionId)).toBeNull();
        expect(manager.getSessionForDevice(releasingDeviceId)).toBeNull();
      };
    },
    dispose() {
      finishRestore.resolve();
      persistence.finishRelease.resolve();
      persistence.finishUpsert.resolve();
      observers.dispose();
      manager.stopCleanupTimer();
    },
  };
}
