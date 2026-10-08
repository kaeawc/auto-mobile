import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import {
  SessionManager,
  TerminalSessionError,
  PLAN_AUTO_RELEASE_REASON,
  type Session,
  type SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { CLI_SESSION_LIVENESS_POLICY } from "../../src/daemon/constants";
import { DAEMON_SESSION_NOT_FOUND_CODE, type DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { releasingSessionHarness } from "../helpers/releasingSessionHarness";

const sessionId = "00000000-0000-4000-8000-000000000001";
const deviceId = "emulator-fake";
const notFound = {
  success: false,
  error: `Session not found: ${sessionId}`,
  code: DAEMON_SESSION_NOT_FOUND_CODE,
};
const released = {
  success: true,
  result: { message: `Session ${sessionId} released`, device: deviceId, alreadyReleased: false },
};
const alreadyReleased = {
  success: true,
  result: {
    message: `Session ${sessionId} already released or never existed`,
    alreadyReleased: true,
  },
};
const request = (
  method: string,
  params: Record<string, unknown> = { sessionId },
): DaemonRequest => ({
  id: "test",
  type: "daemon_request",
  method,
  params,
});

class DeferredPersistence extends FakeDeviceSessionPersistence {
  activityWrites = 0;
  releaseWrites = 0;
  deferRelease = false;
  deferUpsert = false;
  deferOwnership = false;
  readonly ownershipStarted = Promise.withResolvers<void>();
  readonly finishOwnership = Promise.withResolvers<void>();
  readonly releaseStarted = Promise.withResolvers<void>();
  readonly finishRelease = Promise.withResolvers<void>();
  readonly upsertStarted = Promise.withResolvers<void>();
  readonly finishUpsert = Promise.withResolvers<void>();

  override async recordActivity(
    ...args: Parameters<FakeDeviceSessionPersistence["recordActivity"]>
  ): Promise<void> {
    this.activityWrites++;
    await super.recordActivity(...args);
  }

  override async recordLivenessOwnership(
    ...args: Parameters<FakeDeviceSessionPersistence["recordLivenessOwnership"]>
  ): Promise<void> {
    if (this.deferOwnership) {
      this.ownershipStarted.resolve();
      await this.finishOwnership.promise;
    }
    await super.recordLivenessOwnership(...args);
  }

  override async markReleased(
    ...args: Parameters<FakeDeviceSessionPersistence["markReleased"]>
  ): Promise<void> {
    this.releaseWrites++;
    if (this.deferRelease) {
      this.releaseStarted.resolve();
      await this.finishRelease.promise;
    }
    await super.markReleased(...args);
  }

  override async upsertActiveSession(
    ...args: Parameters<FakeDeviceSessionPersistence["upsertActiveSession"]>
  ): Promise<void> {
    if (this.deferUpsert) {
      this.upsertStarted.resolve();
      await this.finishUpsert.promise;
    }
    await super.upsertActiveSession(...args);
  }
}

function liveness(session: Session) {
  return {
    lastHeartbeat: session.lastHeartbeat,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    hasReceivedHeartbeat: session.hasReceivedHeartbeat,
    livenessPolicy: session.livenessPolicy,
    livenessOwnerToken: session.livenessOwnerToken,
    ownership: session.ownership,
    awaitingOwnerSince: session.awaitingOwnerSince,
    activityGeneration: session.activityGeneration,
    heartbeatTimeoutMs: session.heartbeatTimeoutMs,
    sessionTimeoutMs: session.sessionTimeoutMs,
    preCliLiveness: session.preCliLiveness,
    livenessOwnershipClaims: session.livenessOwnershipClaims
      ? [...session.livenessOwnershipClaims]
      : undefined,
  };
}

describe("requests during device session release", () => {
  let timer: FakeTimer;
  let persistence: DeferredPersistence;
  let manager: SessionManager;
  let registry: ObserverSessionRegistry;
  let state: DaemonStateAccess;
  let restoreCalls: number;
  let poolReleases: Array<[string, string]>;
  let snapshots: SessionReleaseSnapshot[];
  let restoreStarted: ReturnType<typeof Promise.withResolvers<void>>;
  let finishRestore: ReturnType<typeof Promise.withResolvers<void>>;

  beforeEach(() => {
    timer = new FakeTimer();
    persistence = new DeferredPersistence();
    const barrier = new FakeDbWriteBarrier();
    restoreStarted = Promise.withResolvers<void>();
    finishRestore = Promise.withResolvers<void>();
    restoreCalls = 0;
    poolReleases = [];
    snapshots = [];
    manager = new SessionManager(
      timer,
      persistence,
      () => barrier,
      () => ({
        restore: async () => {
          restoreCalls++;
          restoreStarted.resolve();
          await finishRestore.promise;
        },
      }),
    );
    manager.onSessionRelease((_id, _device, _reason, snapshot) => snapshots.push(snapshot));
    registry = new ObserverSessionRegistry(timer, 10000);
    manager.setObserverSessionRegistry(registry);
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getObserverSessionRegistry: () => registry,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
        releaseDevice: async (device, owner) => {
          poolReleases.push([device, owner]);
        },
      }),
    };
  });

  afterEach(() => {
    finishRestore.resolve();
    persistence.finishRelease.resolve();
    persistence.finishUpsert.resolve();
    persistence.finishOwnership.resolve();
    registry.dispose();
    manager.stopCleanupTimer();
  });

  async function beginPhaseA(reason: string, cli = false) {
    const session = await manager.createSession(sessionId, deviceId, "android");
    if (reason === "heartbeat-timeout") {
      manager.recordHeartbeat(sessionId);
    }
    if (cli) {
      manager.adoptCliLivenessPolicy(sessionId, 60000);
    }
    manager.setKeepScreenAwake(sessionId, { applied: true });
    timer.advanceTime(11000);
    const release = manager.releaseSession(sessionId, reason);
    await restoreStarted.promise;
    expect(manager.getSession(sessionId)).toBe(session);
    expect(manager.isAdmittedForAutomation(session)).toBe(false);
    return { session, release };
  }

  async function flushImmediateResponse() {
    await handleDaemonRequest(request("daemon/heartbeat", { sessionId: "unrelated" }), state);
  }

  for (const reason of ["explicit-release", "heartbeat-timeout", "daemon-shutdown"]) {
    for (const mode of ["plain", "cli-idle", "literal-cli-idle", "claim", "restore"] as const) {
      test(`Phase A ${reason}: ${mode} heartbeat rejects without liveness mutation`, async () => {
        const { session, release } = await beginPhaseA(reason, mode === "restore");
        const before = liveness(session);
        const writes = persistence.activityWrites;
        const timers = [
          timer.getPendingTimeoutCount(),
          timer.getPendingIntervalCount(),
          timer.getPendingSleepCount(),
        ];
        timer.advanceTime(1);
        const params =
          mode === "claim"
            ? {
                sessionId,
                livenessOwnerToken: "new-owner",
                claimLivenessOwnership: true,
                livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
              }
            : {
                sessionId,
                livenessPolicy:
                  mode === "cli-idle"
                    ? CLI_SESSION_LIVENESS_POLICY
                    : mode === "literal-cli-idle"
                      ? "cli-idle"
                      : mode === "plain"
                        ? undefined
                        : "heartbeat",
              };
        const response = await handleDaemonRequest(request("daemon/heartbeat", params), state);
        const after = liveness(session);
        const afterTimers = [
          timer.getPendingTimeoutCount(),
          timer.getPendingIntervalCount(),
          timer.getPendingSleepCount(),
        ];
        const afterWrites = persistence.activityWrites;
        finishRestore.resolve();
        await release;
        expect(response).toEqual(notFound);
        expect(after).toEqual(before);
        expect(afterWrites).toBe(writes);
        expect(afterTimers).toEqual(timers);
        expect(snapshots[0]?.heartbeat).toMatchObject({
          lastHeartbeatMs: before.lastHeartbeat,
          ageMs: 11001 - before.lastHeartbeat,
        });
      });
    }
  }

  for (const policy of [CLI_SESSION_LIVENESS_POLICY, "heartbeat"] as const) {
    test(`release during ownership claim rejects ${policy} heartbeat without policy mutation`, async () => {
      const session = await manager.createSession(sessionId, deviceId, "android");
      if (policy === "heartbeat") {
        manager.adoptCliLivenessPolicy(sessionId, 60000);
      }
      manager.setKeepScreenAwake(sessionId, { applied: true });
      const before = liveness(session);
      timer.advanceTime(1);
      persistence.deferOwnership = true;
      const heartbeat = handleDaemonRequest(
        request("daemon/heartbeat", {
          sessionId,
          livenessOwnerToken: "new-owner",
          claimLivenessOwnership: true,
          livenessPolicy: policy,
          idleTimeoutMs: 60000,
        }),
        state,
      );
      await persistence.ownershipStarted.promise;
      const release = manager.releaseSession(sessionId, "explicit-release");
      await restoreStarted.promise;
      expect(manager.isAdmittedForAutomation(session)).toBe(false);
      persistence.finishOwnership.resolve();
      const response = await heartbeat;
      const after = liveness(session);
      finishRestore.resolve();
      await release;
      expect(response).toEqual(notFound);
      expect(after).toEqual({
        ...before,
        livenessOwnerToken: "new-owner",
        livenessOwnershipClaims: ["new-owner"],
      });
      expect((await persistence.getSession?.(sessionId))?.liveness_owner_token).toBeNull();
      const replacement = await manager.createSession("fresh-session", deviceId, "android");
      expect(replacement.livenessOwnerToken).toBeUndefined();
      expect(replacement.livenessOwnershipClaims).toBeUndefined();
    });
  }

  test("ownership claim accepts the same terminal-fenced session when no release is in flight", async () => {
    const h = releasingSessionHarness();
    try {
      const session = await h.create();
      h.holdTerminalFence(session);
      // Ordinary lookup hides terminal fences; expose the still-registered object
      // to isolate the handler's post-claim check from lookup's admission policy.
      h.manager.getSession = (id) => (id === sessionId ? session : null);
      expect(h.manager.getSession(sessionId)).toBe(session);
      expect(h.manager.isAdmittedForAutomation(session)).toBe(false);
      expect(h.manager.getReleasingSession(sessionId)).toBeNull();
      expect(
        await handleDaemonRequest(
          request("daemon/heartbeat", {
            sessionId,
            livenessOwnerToken: "new-owner",
            claimLivenessOwnership: true,
            livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
            idleTimeoutMs: 60000,
          }),
          h.state,
        ),
      ).toEqual({
        success: true,
        result: { sessionId, livenessPolicy: "cli-idle", idleTimeoutMs: 60000 },
      });
      expect(session.livenessOwnerToken).toBe("new-owner");
    } finally {
      h.dispose();
    }
  });

  test("direct recordHeartbeat during Phase A does not mutate or persist activity", async () => {
    const { session, release } = await beginPhaseA("explicit-release");
    session.ownership = "awaiting-owner";
    session.awaitingOwnerSince = 0;
    const before = liveness(session);
    const writes = persistence.activityWrites;
    timer.advanceTime(1);
    manager.recordHeartbeat(sessionId);
    const after = liveness(session);
    finishRestore.resolve();
    await release;
    expect(after).toEqual(before);
    expect(persistence.activityWrites).toBe(writes);
  });

  test("Phase B terminal heartbeat already rejects without mutation", async () => {
    persistence.deferRelease = true;
    const { session, release } = await beginPhaseA("heartbeat-timeout");
    finishRestore.resolve();
    await persistence.releaseStarted.promise;
    expect(manager.getSession(sessionId)).toBeNull();
    const before = liveness(session);
    const writes = persistence.activityWrites;
    timer.advanceTime(1);
    const response = await handleDaemonRequest(
      request("daemon/heartbeat", {
        sessionId,
        livenessOwnerToken: "new-owner",
        claimLivenessOwnership: true,
        livenessPolicy: "cli-idle",
      }),
      state,
    );
    persistence.finishRelease.resolve();
    await release;
    expect(response).toEqual(notFound);
    expect(liveness(session)).toEqual(before);
    expect(persistence.activityWrites).toBe(writes);
  });

  for (const phase of ["A", "B", "expired-A", "removed"] as const) {
    test(`Phase ${phase}: repeated release joins once and returns the device`, async () => {
      persistence.deferRelease = phase === "B" || phase === "removed";
      const { session, release } = await beginPhaseA(
        phase === "B" ? "heartbeat-timeout" : "explicit-release",
      );
      if (phase === "B" || phase === "removed") {
        finishRestore.resolve();
        await persistence.releaseStarted.promise;
        expect(manager.getSession(sessionId)).toBeNull();
      } else if (phase === "expired-A") {
        session.expiresAt = timer.now() - 1;
        expect(manager.getSession(sessionId)).toBeNull();
      }
      let responded = false;
      const repeated = handleDaemonRequest(request("daemon/releaseSession"), state).then(
        (response) => {
          responded = true;
          return response;
        },
      );
      await flushImmediateResponse();
      const respondedBeforeFinish = responded;
      expect(poolReleases).toEqual([]);
      finishRestore.resolve();
      persistence.finishRelease.resolve();
      expect(await release).toBe(deviceId);
      const response = await repeated;
      expect(respondedBeforeFinish).toBe(false);
      expect(response).toEqual(released);
      expect(restoreCalls).toBe(1);
      expect(persistence.releaseWrites).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(poolReleases).toEqual([[deviceId, sessionId]]);
    });
  }

  for (const reason of ["explicit-release", "heartbeat-timeout"]) {
    test(`${reason}: tool admission waits for teardown then rejects without assigning`, async () => {
      const { release } = await beginPhaseA(reason);
      // This persistence seam retains no recoverable row for tool admission.
      // A retained nonterminal row is eligible for recovery, pinned separately below.
      persistence.getSession = undefined;
      let assignments = 0;
      let settled = false;
      const admission = manager
        .getOrCreateSession(
          sessionId,
          {
            assignDeviceToSession: async () => {
              assignments++;
              return "unexpected-device";
            },
          },
          "android",
          undefined,
          true,
        )
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await flushImmediateResponse();
      expect(settled).toBe(false);
      expect(assignments).toBe(0);
      finishRestore.resolve();
      await release;
      const error = await admission;
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect(assignments).toBe(0);
      expect(await handleDaemonRequest(request("daemon/heartbeat"), state)).toEqual(notFound);
      expect(await handleDaemonRequest(request("daemon/releaseSession"), state)).toEqual(
        alreadyReleased,
      );
      await expect(
        manager.getOrCreateSession(sessionId, undefined, undefined, undefined, true),
      ).rejects.toThrow(
        reason === "heartbeat-timeout" ? "is terminal after heartbeat-timeout" : "was released",
      );
    });
  }

  test("persisted internal release admission waits then permits existing recovery", async () => {
    const { release } = await beginPhaseA(PLAN_AUTO_RELEASE_REASON);
    let assignments = 0;
    let settled = false;
    const admission = manager
      .getOrCreateSession(
        sessionId,
        {
          assignDeviceToSession: async () => {
            assignments++;
            await manager.createSession(sessionId, deviceId, "android");
            return deviceId;
          },
        },
        "android",
        undefined,
        true,
      )
      .then((session) => {
        settled = true;
        return session;
      });
    await flushImmediateResponse();
    expect(settled).toBe(false);
    expect(assignments).toBe(0);
    finishRestore.resolve();
    await release;
    expect((await admission).assignedDevice).toBe(deviceId);
    expect(assignments).toBe(1);
  });

  for (const phase of ["A", "B"] as const) {
    for (const method of ["getOrCreateSession", "admitIssuedSessionForAutomation"] as const) {
      test(`Phase ${phase}: ${method} refuses explicit release with a retained persisted row`, async () => {
        const h = releasingSessionHarness();
        let assignments = 0;
        let settled = false;
        const pool = {
          assignDeviceToSession: async () => {
            assignments++;
            return "unexpected-device";
          },
        };
        const admit = () =>
          method === "getOrCreateSession"
            ? h.manager.getOrCreateSession(sessionId, pool, "android", undefined, true)
            : h.manager.admitIssuedSessionForAutomation(sessionId);
        try {
          const session = await h.create();
          const finish = await h.beginRelease(phase);
          const admission = admit().then(
            (result) => {
              settled = true;
              return result;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
          expect(await h.request("daemon/heartbeat")).toEqual(notFound);
          if (phase === "A") {
            expect(settled).toBe(false);
          }
          expect(assignments).toBe(0);
          await finish();
          const error = await admission;
          expect(error).toBeInstanceOf(TerminalSessionError);
          expect(error).toHaveProperty(
            "message",
            `Session ${sessionId} was released and cannot be reused. Acquire a new device with getAndroid or getApple.`,
          );
          await expect(admit()).rejects.toThrow(TerminalSessionError);
          await expect(
            h.manager.admitIssuedSessionForAutomation(sessionId, undefined, {
              access: "read-only",
            }),
          ).rejects.toThrow("was released");
          expect(assignments).toBe(0);
          expect(h.manager.isAdmittedForAutomation(session)).toBe(false);
          expect(h.manager.getSession(sessionId)).toBeNull();
          expect(h.manager.getSessionForDevice(session.assignedDevice)).toBeNull();
          expect(await h.request("daemon/heartbeat")).toEqual(notFound);
          expect(await h.persistence.getSession?.(sessionId)).toMatchObject({
            status: "released",
            release_reason: "explicit-release",
          });
        } finally {
          h.dispose();
        }
      });
    }
  }

  test("non-releasing heartbeat succeeds and renews liveness without extending the idle deadline", async () => {
    const session = await manager.createSession(sessionId, deviceId, "android");
    const expiresAt = session.expiresAt;
    timer.advanceTime(1);
    expect(await handleDaemonRequest(request("daemon/heartbeat"), state)).toEqual({
      success: true,
      result: { sessionId },
    });
    expect(session.lastHeartbeat).toBe(1);
    // A heartbeat proves liveness, not use (#10656).
    expect(session.lastUsedAt).toBe(0);
    expect(session.expiresAt).toBe(expiresAt);
    expect(session.hasReceivedHeartbeat).toBe(true);
    expect(persistence.activityWrites).toBe(1);
  });

  test("heartbeat mid-rebind remains admitted and succeeds", async () => {
    const session = await manager.createSession(sessionId, deviceId, "android");
    persistence.deferUpsert = true;
    const rebind = manager.rebindSession(sessionId, "emulator-new", "android");
    await persistence.upsertStarted.promise;
    expect(manager.isAdmittedForAutomation(session)).toBe(true);
    timer.advanceTime(1);
    const response = await handleDaemonRequest(request("daemon/heartbeat"), state);
    persistence.finishUpsert.resolve();
    await rebind;
    expect(response).toEqual({ success: true, result: { sessionId } });
    expect(manager.getSession(sessionId)?.lastHeartbeat).toBe(1);
  });

  test("observer heartbeat and release preserve their envelopes without pool release", async () => {
    registry.register(sessionId, "desktop");
    timer.advanceTime(1);
    expect(await handleDaemonRequest(request("daemon/heartbeat"), state)).toEqual({
      success: true,
      result: { sessionId },
    });
    expect(registry.list()[0]?.expiresAtMs).toBe(10001);
    expect(await handleDaemonRequest(request("daemon/releaseSession"), state)).toEqual({
      success: true,
      result: { message: `Session ${sessionId} released`, alreadyReleased: false },
    });
    expect(poolReleases).toEqual([]);
    expect(persistence.releaseWrites).toBe(0);
  });
});
