import { deliverDaemonHeartbeatIfKnown } from "../helpers/daemonHeartbeatHandler";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { describe, expect, test } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  PLAN_AUTO_RELEASE_REASON,
  SessionActivityPersistenceError,
  SessionRecoveryIdentityLossError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { DEVICE_SESSION_RETENTION_MAX_AGE_MS } from "../../src/db/deviceSessionRepository";
import {
  countingAssigner,
  gatedKeepAwakeRestore,
  installSessionManagerFixture,
  makeSessionManager,
  persistedRecoverySession,
  persistenceMirroringRelease,
  persistenceServing,
  quietPersistence,
  recoverPersisted,
  replacingAssigner,
  sessionRow,
  stubbedPersistence,
} from "../helpers/sessionManagerSuite";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    sessionManager = fixture.manager;
    fakeTimer = fixture.timer;
  });

  describe("getOrCreateSession", () => {
    test("should return existing session without creating new one", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const session = await sessionManager.getOrCreateSession("session-1");
      expect(session.sessionId).toBe("session-1");
      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });

    test("should update last used time when getting session", async () => {
      const session1 = await sessionManager.createSession("session-1", "emulator-5554", "android");
      const initialLastUsed = session1.lastUsedAt;
      const initialExpiry = session1.expiresAt;
      fakeTimer.advanceTime(10);
      const session2 = await sessionManager.getOrCreateSession("session-1");
      expect(session2.lastUsedAt).toBe(initialLastUsed + 10);
      expect(session2.expiresAt).toBe(initialExpiry + 10);
    });

    test("surfaces a failed existing-session liveness refresh", async () => {
      const persistence: DeviceSessionPersistence = stubbedPersistence({
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {
          throw new Error("database unavailable");
        },
        async markReleased(): Promise<void> {},
      });
      const manager = makeSessionManager({ timer: fakeTimer, persistence });

      const existing = await manager.createSession(
        "session-activity-failure",
        "emulator-5554",
        "android",
      );
      const initialLastUsedAt = existing.lastUsedAt;
      fakeTimer.advanceTime(10);

      await expect(manager.getOrCreateSession("session-activity-failure")).rejects.toBeInstanceOf(
        SessionActivityPersistenceError,
      );
      expect(existing.lastUsedAt).toBe(initialLastUsedAt);
      expect(existing.lastHeartbeat).toBe(initialLastUsedAt);
    });

    test("does not roll back a newer overlapping liveness refresh", async () => {
      const firstActivity = Promise.withResolvers<void>();
      const firstActivityStarted = Promise.withResolvers<void>();
      let activityAttempts = 0;
      const persistence: DeviceSessionPersistence = stubbedPersistence({
        async upsertActiveSession(): Promise<void> {},
        async recordActivity(): Promise<void> {
          activityAttempts++;
          if (activityAttempts === 1) {
            firstActivityStarted.resolve();
            await firstActivity.promise;
            throw new Error("first activity persistence failed");
          }
        },
        async markReleased(): Promise<void> {},
      });
      const manager = makeSessionManager({ timer: fakeTimer, persistence });

      const existing = await manager.createSession(
        "overlapping-activity",
        "emulator-5554",
        "android",
      );
      fakeTimer.advanceTime(10);
      const firstRefresh = manager.getOrCreateSession("overlapping-activity");
      await firstActivityStarted.promise;

      fakeTimer.advanceTime(10);
      const secondRefresh = manager.getOrCreateSession("overlapping-activity");
      const second = await secondRefresh;
      const newerActivity = {
        lastUsedAt: second.lastUsedAt,
        lastHeartbeat: second.lastHeartbeat,
        expiresAt: second.expiresAt,
      };

      firstActivity.resolve();
      await expect(firstRefresh).rejects.toBeInstanceOf(SessionActivityPersistenceError);
      expect(existing.lastUsedAt).toBe(newerActivity.lastUsedAt);
      expect(existing.lastHeartbeat).toBe(newerActivity.lastHeartbeat);
      expect(existing.expiresAt).toBe(newerActivity.expiresAt);
    });

    test("should bump lastHeartbeat when resolving an existing session", async () => {
      // The daemon heartbeat watchdog reaps sessions on a stale lastHeartbeat.
      // Resolving a session for a tool call must count as activity, otherwise an
      // actively-used autolock client (which sends no explicit heartbeats) would
      // be reaped mid-use.
      const session1 = await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 60_000,
        heartbeatTimeoutMs: 60_000,
      });
      const initialHeartbeat = session1.lastHeartbeat;
      fakeTimer.advanceTime(30_000);

      const session2 = await sessionManager.getOrCreateSession("session-1");

      expect(session2.lastHeartbeat).toBe(initialHeartbeat + 30_000);
      expect(session2.lastHeartbeat).toBe(fakeTimer.now());
    });

    test("should preserve custom timeout when getting existing session", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 5000,
      });
      fakeTimer.advanceTime(4000);

      const session = await sessionManager.getOrCreateSession("session-1");

      expect(session.expiresAt).toBe(fakeTimer.now() + 5000);
    });

    test("should throw error for non-existent session without device pool", async () => {
      try {
        await sessionManager.getOrCreateSession("non-existent");
        expect.unreachable("Should have thrown error");
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("not found");
      }
    });

    // #6069: with requireIssuedSession, a never-issued id must NOT be minted a
    // pooled device just because a live device pool is in scope. Admission is
    // decided from the registry, not from pool presence.
    test("requireIssuedSession rejects a never-issued id instead of minting a pooled device", async () => {
      const assignedSessionIds: string[] = [];
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          assignedSessionIds.push(sessionId);
          const session = await sessionManager.createSession(sessionId, "device-x", "android");
          return session.assignedDevice;
        },
      };

      await expect(
        sessionManager.getOrCreateSession("kumquat-D", devicePool, "android", undefined, true),
      ).rejects.toThrow(/not an active daemon session/);
      expect(assignedSessionIds).toEqual([]);
      expect(sessionManager.getSession("kumquat-D")).toBeNull();
    });

    // Regression: requireIssuedSession must NOT block minting for a NEW id when
    // requireIssuedSession is false (device-label / internal derived sessions).
    test("still mints a fresh id when requireIssuedSession is false (default)", async () => {
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          const session = await sessionManager.createSession(sessionId, "device-y", "android");
          return session.assignedDevice;
        },
      };

      const session = await sessionManager.getOrCreateSession("base:B", devicePool, "android");
      expect(session.assignedDevice).toBe("device-y");
    });

    // Regression: live-during-restart recovery — a persisted, non-terminal row is
    // an issued identity, so requireIssuedSession still recovers it.
    test("requireIssuedSession still recovers a persisted, non-terminal session", async () => {
      const persisted = sessionRow({
        device_id: "emulator-5560",
        stable_device_id: "Pixel_8_API_35",
        status: "active",
        created_at: "2026-09-03T00:00:00.000Z",
        updated_at: "2026-09-03T00:00:00.000Z",
      });
      const persistence: DeviceSessionPersistence = persistenceServing(persisted);
      const restarted = makeSessionManager({ timer: fakeTimer, persistence });
      let recoveryTarget:
        | { platform: string; stableDeviceId: string; deviceId: string }
        | undefined;
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
          recoveryTarget = target;
          await restarted.createSession(sessionId, "emulator-5560", "android", {
            stableDeviceId: target?.stableDeviceId,
          });
          return "emulator-5560";
        },
      };

      await expect(
        restarted.getOrCreateSession("restarted-session", devicePool, "android", undefined, true),
      ).resolves.toMatchObject({ assignedDevice: "emulator-5560" });
      expect(recoveryTarget).toMatchObject({
        platform: "android",
        stableDeviceId: "Pixel_8_API_35",
        deviceId: "emulator-5560",
        androidEmulator: true,
      });
    });

    test("rejects and terminalizes an on-demand recovery whose expiry has passed", async () => {
      fakeTimer.advanceTime(1_000);
      const persisted = persistedRecoverySession({
        status: "active",
        expires_at_ms: 1_000,
      });
      const persistence: DeviceSessionPersistence = persistenceMirroringRelease(persisted);
      const manager = makeSessionManager({ timer: fakeTimer, persistence });
      const devicePool = countingAssigner("emulator-5556");

      // Typed terminal refusal carrying the expired reason, not an untyped not-found (#11361).
      const error = await manager
        .getOrCreateSession("persisted-session", devicePool, "android", undefined, true)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect((error as TerminalSessionError).release).toMatchObject({
        releaseReason: "expired",
        terminal: true,
      });
      expect(devicePool.assignments).toBe(0);
      expect(persisted).toMatchObject({
        status: "expired",
        released_at_ms: 1_000,
        release_reason: "expired",
      });
    });

    // #10832: an idle-released UUID was issued; it must read as released, not as never issued.
    // Idle releases are terminal (#11258), so the release reads back as terminal.
    test.each(["lazy-expiry", "cleanup-expired"])(
      "an explicit UUID idle-released by %s gets the ownership-lost release, not not-found",
      async (releaseReason) => {
        fakeTimer.advanceTime(5_000);
        const persisted = persistedRecoverySession({
          status: "expired",
          expires_at_ms: 1_000,
          released_at_ms: 2_000,
          last_used_at_ms: 500,
          release_reason: releaseReason,
        });
        const written: string[] = [];
        const persistence: DeviceSessionPersistence = persistenceServing(persisted, {
          async markReleased(_sessionUuid, _status, _releasedAtMs, reason) {
            written.push(reason);
          },
        });
        const manager = makeSessionManager({ timer: fakeTimer, persistence });
        const devicePool = countingAssigner("emulator-5556");

        for (const attempt of [
          () =>
            manager.getOrCreateSession("persisted-session", devicePool, "android", undefined, true),
          () => manager.admitIssuedSessionForAutomation("persisted-session"),
        ]) {
          const error = await attempt().then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(TerminalSessionError);
          expect((error as TerminalSessionError).release).toMatchObject({
            sessionId: "persisted-session",
            deviceId: "emulator-5554",
            releaseReason,
            releasedAtMs: 2_000,
            terminal: true,
          });
        }
        expect(devicePool.assignments).toBe(0);
        // The recorded idle reason is kept, not overwritten by terminalization.
        expect(written).toEqual([]);
      },
    );

    test("rejects an on-demand recovery past the retention window", async () => {
      const persisted = persistedRecoverySession({
        released_at_ms: -DEVICE_SESSION_RETENTION_MAX_AGE_MS - 1,
        expires_at_ms: 1_000,
      });
      const persistence: DeviceSessionPersistence = persistenceServing(persisted);
      const manager = makeSessionManager({ timer: fakeTimer, persistence });
      const devicePool = countingAssigner("emulator-5556");

      await expect(
        manager.getOrCreateSession("persisted-session", devicePool, "android", undefined, true),
      ).rejects.toThrow("not found");
      expect(devicePool.assignments).toBe(0);
      expect(persisted.release_reason).toBe("daemon-restart");
    });

    test("terminalizes persisted Android recovery when its stable identity is missing", async () => {
      const persisted = sessionRow({
        session_uuid: "missing-stable-identity",
        device_id: "emulator-5560",
        stable_device_id: null,
        status: "active",
      });
      const releases: string[] = [];
      const persistence: DeviceSessionPersistence = persistenceServing(persisted, {
        async upsertActiveSession() {
          throw new Error("missing stable identity must not assign a sibling");
        },
        async markReleased(_sessionUuid, status, releasedAtMs, releaseReason) {
          releases.push(releaseReason);
          persisted.status = status;
          persisted.released_at_ms = releasedAtMs;
          persisted.release_reason = releaseReason;
        },
      });
      const restarted = makeSessionManager({ timer: fakeTimer, persistence });
      const devicePool = countingAssigner("emulator-5562");

      await expect(recoverPersisted(restarted, persisted, devicePool)).rejects.toThrow(
        "persisted device identity is unavailable",
      );
      expect(devicePool.assignments).toBe(0);
      expect(releases).toEqual(["identity-recovery-identity-continuity-lost"]);
      expect(restarted.getTerminalReleaseSnapshot(persisted.session_uuid)).toMatchObject({
        deviceId: persisted.device_id,
        releaseReason: "identity-recovery-identity-continuity-lost",
        terminal: true,
      });

      // The explicit release path remains idempotent for the now-terminal UUID.
      await expect(restarted.releaseSession(persisted.session_uuid)).resolves.toBe("emulator-5560");
      await expect(recoverPersisted(restarted, persisted, devicePool)).rejects.toThrow(
        "terminal after identity-recovery-identity-continuity-lost and cannot be reused",
      );
      expect(devicePool.assignments).toBe(0);
      expect(releases).toEqual([
        "identity-recovery-identity-continuity-lost",
        "identity-recovery-identity-continuity-lost",
      ]);
    });

    test("recovers a legacy physical Android session using its serial as the stable identity", async () => {
      const persisted = sessionRow({
        session_uuid: "legacy-physical-session",
        device_id: "R5CT123ABC",
        stable_device_id: null,
        status: "active",
      });
      const persistence: DeviceSessionPersistence = persistenceServing(persisted);
      const restarted = makeSessionManager({ timer: fakeTimer, persistence });
      let recoveryTarget: Parameters<SessionDeviceAssigner["assignDeviceToSession"]>[2];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
          recoveryTarget = target;
          await restarted.createSession(sessionId, persisted.device_id, "android", {
            stableDeviceId: target?.stableDeviceId,
          });
          return persisted.device_id;
        },
      };

      await expect(recoverPersisted(restarted, persisted, devicePool)).resolves.toMatchObject({
        assignedDevice: persisted.device_id,
        stableDeviceId: persisted.device_id,
      });
      expect(recoveryTarget).toMatchObject({
        platform: "android",
        stableDeviceId: persisted.device_id,
        deviceId: persisted.device_id,
        androidEmulator: false,
      });
    });

    test.each(["192.168.1.24:5555", "adb-XXXX._adb-tls-connect._tcp", "[fe80::1234%en0]:5555"])(
      "terminalizes a legacy Android transport address recovery: %s",
      async (deviceId) => {
        const persisted = sessionRow({
          session_uuid: `legacy-transport-${deviceId}`,
          device_id: deviceId,
          stable_device_id: null,
          status: "active",
        });
        const releases: string[] = [];
        const persistence: DeviceSessionPersistence = persistenceServing(persisted, {
          async upsertActiveSession() {
            throw new Error("transport address must not assign a sibling");
          },
          async markReleased(_sessionUuid, status, releasedAtMs, releaseReason) {
            releases.push(releaseReason);
            persisted.status = status;
            persisted.released_at_ms = releasedAtMs;
            persisted.release_reason = releaseReason;
          },
        });
        const restarted = makeSessionManager({ timer: fakeTimer, persistence });

        await expect(
          restarted.getOrCreateSession(
            persisted.session_uuid,
            {
              async assignDeviceToSession() {
                return "unexpected";
              },
            },
            "android",
            undefined,
            true,
          ),
        ).rejects.toThrow("persisted device identity is unavailable");
        expect(releases).toEqual(["identity-recovery-identity-continuity-lost"]);
      },
    );

    test("terminalizes a legacy physical Android recovery when the device is no longer found", async () => {
      const persisted = sessionRow({
        session_uuid: "missing-legacy-physical-session",
        device_id: "R5CT123ABC",
        stable_device_id: null,
        status: "active",
      });
      const persistence: DeviceSessionPersistence = persistenceMirroringRelease(persisted);
      const restarted = makeSessionManager({ timer: fakeTimer, persistence });
      let recoveryTarget: Parameters<SessionDeviceAssigner["assignDeviceToSession"]>[2];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionUuid, _platform, target): Promise<string> {
          recoveryTarget = target;
          if (!target) {
            throw new Error("persisted recovery target was not supplied");
          }
          throw new SessionRecoveryIdentityLossError(sessionUuid, target, "target-absent");
        },
      };

      await expect(recoverPersisted(restarted, persisted, devicePool)).rejects.toThrow(
        `Cannot safely recover session ${persisted.session_uuid}`,
      );
      expect(recoveryTarget).toMatchObject({
        stableDeviceId: persisted.device_id,
        deviceId: persisted.device_id,
        androidEmulator: false,
      });
      expect(persisted.release_reason).toBe("identity-recovery-target-absent");
    });

    test("keeps a named pending recovery error nonterminal and permits the same UUID to retry", async () => {
      const persisted = sessionRow({
        session_uuid: "missing-legacy-physical-session",
        device_id: "R5CT123ABC",
        stable_device_id: null,
        status: "active",
      });
      const persistence: DeviceSessionPersistence = persistenceMirroringRelease(persisted);
      const restarted = makeSessionManager({ timer: fakeTimer, persistence });
      let recoveryTarget: Parameters<SessionDeviceAssigner["assignDeviceToSession"]>[2];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionUuid, _platform, target): Promise<string> {
          recoveryTarget = target;
          if (!target) {
            throw new Error("persisted recovery target was not supplied");
          }
          throw new SessionRecoveryAssignmentError({
            sessionUuid,
            platform: target.platform,
            deviceId: target.deviceId,
            stableDeviceId: target.stableDeviceId,
            recoveryWindowRemainingMs: 120_000,
          });
        },
      };

      await expect(recoverPersisted(restarted, persisted, devicePool)).rejects.toThrow(
        `Cannot safely recover session ${persisted.session_uuid}`,
      );
      expect(recoveryTarget).toMatchObject({
        stableDeviceId: persisted.device_id,
        deviceId: persisted.device_id,
        androidEmulator: false,
      });
      expect(persisted.release_reason).toBe("daemon-restart");
      expect(restarted.getTerminalReleaseSnapshot(persisted.session_uuid)).toBeUndefined();
      await expect(
        restarted.admitIssuedSessionForAutomation(persisted.session_uuid),
      ).resolves.toBeUndefined();
      const error = await restarted
        .getOrCreateSession(persisted.session_uuid, devicePool, "android", undefined, true)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SessionRecoveryAssignmentError);
      expect(error).toMatchObject({
        name: "SessionRecoveryAssignmentError",
        details: { code: "session_recovery_pending", retryable: true },
      });
      expect(persisted.release_reason).toBe("daemon-restart");
    });

    test.each([
      ["android", "target-absent", "Original_AVD", "emulator-5554"],
      ["android", "target-busy", "Original_AVD", "emulator-5554"],
      ["ios", "target-absent", "original-simulator-uuid", "original-simulator-uuid"],
      ["ios", "target-busy", "original-simulator-uuid", "original-simulator-uuid"],
    ] as const)(
      "fences a persisted %s session after %s without assigning a sibling",
      async (platform, reason, stableDeviceId, deviceId) => {
        const persisted = sessionRow({
          session_uuid: `${platform}-${reason}`,
          device_id: deviceId,
          stable_device_id: stableDeviceId,
          platform,
          source: "session-manager",
        });
        const releases: string[] = [];
        const persistence: DeviceSessionPersistence = persistenceServing(persisted, {
          async upsertActiveSession() {
            throw new Error("a recovery conflict must not assign a sibling");
          },
          async markReleased(_sessionUuid, _status, _releasedAtMs, releaseReason) {
            releases.push(releaseReason);
            persisted.release_reason = releaseReason;
          },
        });
        const restarted = makeSessionManager({ timer: fakeTimer, persistence });
        let assignments = 0;
        const devicePool: SessionDeviceAssigner = {
          async assignDeviceToSession(sessionUuid, _requestedPlatform, target): Promise<string> {
            assignments++;
            if (!target) {
              throw new Error("persisted recovery target was not supplied");
            }
            throw new SessionRecoveryIdentityLossError(sessionUuid, target, reason);
          },
        };

        await expect(
          restarted.getOrCreateSession(
            persisted.session_uuid,
            devicePool,
            platform,
            undefined,
            true,
          ),
        ).rejects.toThrow(`Cannot safely recover session ${persisted.session_uuid}`);
        expect(assignments).toBe(1);
        expect(releases).toEqual([`identity-recovery-${reason}`]);

        await expect(
          restarted.admitIssuedSessionForAutomation(persisted.session_uuid),
        ).rejects.toThrow(
          `Session ${persisted.session_uuid} is terminal after identity-recovery-${reason} ` +
            "and cannot be reused. Acquire a new device with getAndroid or getApple.",
        );
        expect(assignments).toBe(1);
      },
    );

    test.each(["target-absent", "target-busy", "identity-continuity-lost"] as const)(
      "durably fences a persisted recovery failure from a separately loaded assigner: %s",
      async (reason) => {
        const persisted = sessionRow({
          session_uuid: `detached-${reason}`,
          stable_device_id: "Original_AVD",
          source: "session-manager",
        });
        const persistence: DeviceSessionPersistence = persistenceServing(persisted, {
          async upsertActiveSession() {
            throw new Error("a recovery conflict must not assign a sibling");
          },
          async markReleased(_sessionUuid, status, releasedAtMs, releaseReason) {
            persisted.status = status;
            persisted.released_at_ms = releasedAtMs;
            persisted.release_reason = releaseReason;
          },
        });
        const firstManager = makeSessionManager({ timer: fakeTimer, persistence });
        let assignments = 0;
        const devicePool: SessionDeviceAssigner = {
          async assignDeviceToSession(sessionUuid, _requestedPlatform, target): Promise<string> {
            assignments++;
            if (!target) {
              throw new Error("persisted recovery target was not supplied");
            }
            const recoveryError = new SessionRecoveryIdentityLossError(sessionUuid, target, reason);
            throw Object.assign(new Error(recoveryError.message), {
              name: recoveryError.name,
              sessionUuid: recoveryError.sessionUuid,
              target: recoveryError.target,
              reason: recoveryError.reason,
              terminalReleaseReason: recoveryError.terminalReleaseReason,
            });
          },
        };

        await expect(recoverPersisted(firstManager, persisted, devicePool)).rejects.toThrow(
          `recovery reason: ${reason}`,
        );
        expect(assignments).toBe(1);
        expect(persisted.release_reason).toBe(`identity-recovery-${reason}`);

        const restartedManager = makeSessionManager({ timer: fakeTimer, persistence });

        await expect(recoverPersisted(restartedManager, persisted, devicePool)).rejects.toThrow(
          `terminal after identity-recovery-${reason}`,
        );
        expect(assignments).toBe(1);
      },
    );

    // Regression: a terminal persisted row keeps yielding TerminalSessionError,
    // never a pooled assignment, under requireIssuedSession.
    test("requireIssuedSession preserves TerminalSessionError for a terminal persisted row", async () => {
      const persisted = sessionRow({
        session_uuid: "lost-session",
        status: "released",
        release_reason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
        created_at: "2026-09-03T00:00:00.000Z",
        updated_at: "2026-09-03T00:00:00.000Z",
      });
      const restarted = makeSessionManager({
        timer: fakeTimer,
        persistence: persistenceServing(persisted),
      });
      const assignedSessionIds: string[] = [];
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          assignedSessionIds.push(sessionId);
          return "emulator-5560";
        },
      };

      await expect(
        restarted.getOrCreateSession("lost-session", devicePool, "android", undefined, true),
      ).rejects.toThrow("terminal");
      expect(assignedSessionIds).toEqual([]);
    });

    test("allows distinct unseen session IDs to begin assignment independently", async () => {
      const assignedSessionIds: string[] = [];
      let releaseAssignments!: () => void;
      const assignmentsReleased = new Promise<void>((resolve) => {
        releaseAssignments = resolve;
      });
      let signalBothAssignmentsStarted!: () => void;
      const bothAssignmentsStarted = new Promise<void>((resolve) => {
        signalBothAssignmentsStarted = resolve;
      });
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          assignedSessionIds.push(sessionId);
          if (assignedSessionIds.length === 2) {
            signalBothAssignmentsStarted();
          }
          await assignmentsReleased;
          const session = await sessionManager.createSession(
            sessionId,
            `device-${sessionId}`,
            "android",
          );
          return session.assignedDevice;
        },
      };

      const sessionsPromise = Promise.all([
        sessionManager.getOrCreateSession("session-a", devicePool),
        sessionManager.getOrCreateSession("session-b", devicePool),
      ]);

      await bothAssignmentsStarted;
      expect(assignedSessionIds).toEqual(["session-a", "session-b"]);

      releaseAssignments();
      const [first, second] = await sessionsPromise;
      expect(first.assignedDevice).toBe("device-session-a");
      expect(second.assignedDevice).toBe("device-session-b");
    });

    test("does not report a finalized identity as latest while replacement assignment is pending", async () => {
      const original = await sessionManager.createSession("reused", "emulator-old", "android");
      await sessionManager.releaseSession("reused", PLAN_AUTO_RELEASE_REASON);
      const assignmentStarted = Promise.withResolvers<void>();
      const finishAssignment = Promise.withResolvers<void>();
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          assignmentStarted.resolve();
          await finishAssignment.promise;
          const replacement = await sessionManager.createSession(
            sessionId,
            "emulator-new",
            "android",
          );
          return replacement.assignedDevice;
        },
      };

      const replacementAssignment = sessionManager.getOrCreateSession("reused", devicePool);
      await assignmentStarted.promise;
      expect(sessionManager.isLatestSessionIdentity(original)).toBe(false);

      finishAssignment.resolve();
      const replacement = await replacementAssignment;
      expect(sessionManager.isLatestSessionIdentity(original)).toBe(false);
      expect(sessionManager.isLatestSessionIdentity(replacement)).toBe(true);
    });

    test("allows a retry after an unseen-session assignment fails", async () => {
      let attempts = 0;
      const devicePool: SessionDeviceAssigner = {
        assignDeviceToSession: async (sessionId: string): Promise<string> => {
          attempts++;
          if (attempts === 1) {
            throw new Error("first assignment failed");
          }
          const session = await sessionManager.createSession(sessionId, "retry-device", "android");
          return session.assignedDevice;
        },
      };

      await expect(sessionManager.getOrCreateSession("retry-session", devicePool)).rejects.toThrow(
        "first assignment failed",
      );

      await expect(
        sessionManager.getOrCreateSession("retry-session", devicePool),
      ).resolves.toMatchObject({
        sessionId: "retry-session",
        assignedDevice: "retry-device",
      });
      expect(attempts).toBe(2);
    });

    test("releases a session after its pending automatic assignment finishes", async () => {
      const manager = makeSessionManager({ timer: fakeTimer });
      const assignmentStarted = Promise.withResolvers<void>();
      const finishAssignment = Promise.withResolvers<void>();
      const devicePool: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId: string): Promise<string> {
          assignmentStarted.resolve();
          await finishAssignment.promise;
          return (await manager.createSession(sessionId, "emulator-5554", "android"))
            .assignedDevice;
        },
      };

      const assignment = manager.getOrCreateSession("pending-assignment", devicePool);
      await assignmentStarted.promise;
      const release = manager.releaseSession(
        "pending-assignment",
        "device-disconnected:emulator-5554",
      );
      finishAssignment.resolve();

      await expect(assignment).resolves.toMatchObject({ assignedDevice: "emulator-5554" });
      await expect(release).resolves.toBe("emulator-5554");
      expect(manager.getSession("pending-assignment")).toBeNull();
      expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
    });

    test("should return null session when expired session requested", async () => {
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android");
      // Force expiration by setting expiresAt to past
      fakeTimer.advanceTime(2000);
      const oneSecondAgo = fakeTimer.now() - 1000;
      Object.assign(session, { expiresAt: oneSecondAgo });
      const retrieved = sessionManager.getSession("session-1");
      expect(retrieved).toBeNull();
    });

    test("admits a request after its deadline while timely control work holds the session (#11361)", async () => {
      const released: string[] = [];
      sessionManager.setActiveSessionExecutionChecker(
        (_sessionId, query) =>
          !query?.recoveryOnly &&
          query?.excludeExecutionId !== "earlier" &&
          (query?.sessionClockStartedAtOrBefore === undefined ||
            0 <= query.sessionClockStartedAtOrBefore),
      );
      sessionManager.onSessionRelease((sessionId) => released.push(sessionId));
      await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 1000,
      });
      fakeTimer.advanceTime(1001);

      // Existing work keeps an expired session assigned, and a routing lookup with no
      // execution respects that veto rather than releasing under the running call.
      expect(sessionManager.getSession("session-1")).not.toBeNull();
      expect(sessionManager.getSessionForNewExecution("session-1")).not.toBeNull();
      // The timely control call keeps this session in use; acquisition restarts its idle window.
      await expect(
        sessionManager.getOrCreateSession("session-1", undefined, undefined, {
          executionId: "late",
          startTime: fakeTimer.now(),
        }),
      ).resolves.toMatchObject({ sessionId: "session-1", expiresAt: 2001 });

      expect(released).toEqual([]);
      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });

    test("keeps an idle-expired session unavailable during teardown, then refuses its UUID for good", async () => {
      const keepAwake = gatedKeepAwakeRestore();
      const activity: string[] = [];
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence({
          async recordActivity(sessionId: string): Promise<void> {
            activity.push(sessionId);
          },
        }),
        fakeBarrier: true,
        keepScreenAwakeRestorer: keepAwake.restorer,
      });
      const devicePool = replacingAssigner(manager);

      const session = await manager.createSession("s1", "device-1", "android", { timeoutMs: 1 });
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
      await Promise.resolve();
      activity.length = 0;
      fakeTimer.advanceTime(2);

      expect(manager.getSession("s1")).toBeNull();
      await keepAwake.started;
      expect(manager.getSession("s1")).toBeNull();
      expect(manager.getSessionForNewExecution("s1")).toBeNull();

      const expiresAt = session.expiresAt;
      await deliverDaemonHeartbeatIfKnown(manager, "s1");
      await Promise.resolve();
      expect(session.expiresAt).toBe(expiresAt);
      expect(activity).toEqual([]);

      const replacement = manager.getOrCreateSession("s1", devicePool);
      await Promise.resolve();
      expect(devicePool.assignedSessionIds).toEqual([]);

      // The idle release is terminal (#11258): once its teardown ends the UUID stays refused
      // with the ownership-lost release instead of being recreated on a pooled device.
      keepAwake.finish();
      const refusal = await replacement.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(refusal).toBeInstanceOf(TerminalSessionError);
      expect((refusal as TerminalSessionError).release).toMatchObject({
        sessionId: "s1",
        releaseReason: "cleanup-expired",
        terminal: true,
      });
      expect(devicePool.assignedSessionIds).toEqual([]);
    });

    test("keeps a periodically expired session unavailable during teardown", async () => {
      const keepAwake = gatedKeepAwakeRestore();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence(),
        fakeBarrier: true,
        keepScreenAwakeRestorer: keepAwake.restorer,
      });

      const session = await manager.createSession("s1", "device-1", "android", { timeoutMs: 1 });
      manager.setKeepScreenAwake("s1", { applied: true, method: "svc", svcWasEnabled: false });
      fakeTimer.advanceTime(5 * 60 * 1000);

      await keepAwake.started;
      expect(manager.getSession("s1")).toBeNull();
      expect(manager.getSessionForNewExecution("s1")).toBeNull();
      await deliverDaemonHeartbeatIfKnown(manager, "s1");
      expect(session.expiresAt).toBe(1);

      keepAwake.finish();
      await manager.waitForSessionRelease("s1");
    });

    test("waits for an idle-expired session's terminal work, then refuses its UUID for good", async () => {
      const persistenceStarted = Promise.withResolvers<void>();
      const finishPersistence = Promise.withResolvers<void>();
      const manager = makeSessionManager({
        timer: fakeTimer,
        persistence: quietPersistence({
          async markReleased(): Promise<void> {
            persistenceStarted.resolve();
            await finishPersistence.promise;
          },
        }),
        fakeBarrier: true,
      });
      const devicePool = replacingAssigner(manager);

      await manager.createSession("s1", "device-1", "android", { timeoutMs: 1 });
      fakeTimer.advanceTime(2);
      expect(manager.getSession("s1")).toBeNull();
      await persistenceStarted.promise;

      const replacement = manager.getOrCreateSession("s1", devicePool);
      await Promise.resolve();
      expect(devicePool.assignedSessionIds).toEqual([]);

      // The idle release is terminal (#11258): once its row lands the UUID is refused with the
      // ownership-lost release instead of being recreated on a pooled device.
      finishPersistence.resolve();
      const refusal = await replacement.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(refusal).toBeInstanceOf(TerminalSessionError);
      expect((refusal as TerminalSessionError).release).toMatchObject({
        sessionId: "s1",
        terminal: true,
      });
      expect(devicePool.assignedSessionIds).toEqual([]);
    });

    test("keeps a session when work began before its expiry deadline", async () => {
      const session = await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 1000,
      });
      fakeTimer.advanceTime(1001);

      const resolved = await sessionManager.getOrCreateSession("session-1", undefined, undefined, {
        executionId: "pre-deadline",
        startTime: 1000,
      });

      expect(resolved).toBe(session);
      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });

    test("admits a late execution while timely control work keeps the session assigned", async () => {
      sessionManager.setActiveSessionExecutionChecker(
        (_sessionId, query) =>
          !query?.recoveryOnly &&
          query?.excludeExecutionId !== "earlier" &&
          (query?.sessionClockStartedAtOrBefore === undefined ||
            0 <= query.sessionClockStartedAtOrBefore),
      );
      await sessionManager.createSession("session-1", "emulator-5554", "android", {
        timeoutMs: 1000,
      });
      fakeTimer.advanceTime(1001);

      await expect(
        sessionManager.getOrCreateSession("session-1", undefined, undefined, {
          executionId: "late",
          startTime: 1001,
        }),
      ).resolves.toMatchObject({ sessionId: "session-1", expiresAt: 2001 });

      expect(sessionManager.getActiveSessionCount()).toBe(1);
    });
  });
});
