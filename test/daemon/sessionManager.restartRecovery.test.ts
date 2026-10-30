import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { describe, expect, test } from "bun:test";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import {
  SessionManager,
  getDefaultSessionHeartbeatTimeoutMs,
  SessionRecoveryIdentityLossError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { subscribeToolCallEndActivity } from "../../src/daemon/toolCallActivity";
import { ExecutionTracker, sessionExecutionMetadataOf } from "../../src/daemon/executionTracker";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import {
  installSessionManagerCleanup,
  installSessionManagerFixture,
  makeSessionManager,
  persistedRecoverySession,
  persistenceServing,
  recoveringAssigner,
  restartRow,
  seedRestartReleasedRow,
  seedRestartReleasedRows,
  sessionRow,
  stubbedPersistence,
} from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

describe("SessionManager", () => {
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    fakeTimer = fixture.timer;
  });

  test("rejects persisted daemon-restart recovery without a durable device identity", async () => {
    const persisted = sessionRow({
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    const persistence: DeviceSessionPersistence = persistenceServing(persisted);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const assignedSessionIds: string[] = [];
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId: string): Promise<string> {
        assignedSessionIds.push(sessionId);
        await restarted.createSession(sessionId, "emulator-5560", "android");
        return "emulator-5560";
      },
    };

    await expect(
      restarted.admitIssuedSessionForAutomation("restarted-session"),
    ).resolves.toBeUndefined();
    await expect(
      restarted.getOrCreateSession("restarted-session", devicePool, "android"),
    ).rejects.toThrow(/cannot safely recover/i);
    expect(assignedSessionIds).toEqual([]);
    persisted.status = "released";
    persisted.release_reason = "daemon-shutdown";
    const gracefullyRestarted = makeSessionManager({ timer: fakeTimer, persistence });

    await expect(
      gracefullyRestarted.admitIssuedSessionForAutomation("restarted-session"),
    ).resolves.toBeUndefined();

    persisted.release_reason = "explicit-release";
    const ordinarilyReleased = makeSessionManager({ timer: fakeTimer, persistence });

    await expect(
      ordinarilyReleased.admitIssuedSessionForAutomation("restarted-session"),
    ).rejects.toThrow("was released");
  });

  test("restores persisted iOS ownership before a replacement claim", async () => {
    const persisted = sessionRow({
      session_uuid: "restarted-ios-session",
      device_id: "simulator-uuid",
      platform: "ios",
      liveness_owner_token: "current-owner-token",
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    });
    const persistedOwnerTokens: Array<string | null> = [];
    const restarted = makeSessionManager({
      timer: fakeTimer,
      persistence: persistenceServing(persisted, {
        async recordLivenessOwnership(_sessionUuid, ownerToken) {
          persistedOwnerTokens.push(ownerToken);
        },
      }),
    });
    let recoveryTarget: { platform: string; stableDeviceId: string; deviceId: string } | undefined;
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        recoveryTarget = target;
        await restarted.createSession(sessionId, "simulator-uuid", "ios", {
          stableDeviceId: target?.stableDeviceId,
        });
        return "simulator-uuid";
      },
    };

    await expect(
      restarted.getOrCreateSession("restarted-ios-session", devicePool, "ios", {
        requireIssuedSession: true,
      }),
    ).resolves.toMatchObject({
      assignedDevice: "simulator-uuid",
      stableDeviceId: "simulator-uuid",
    });
    expect(recoveryTarget).toMatchObject({
      platform: "ios",
      stableDeviceId: "simulator-uuid",
      deviceId: "simulator-uuid",
    });
    // A restarted proxy resumes with its stable token without a conflict.
    await expect(
      restarted.claimLivenessOwnership("restarted-ios-session", "current-owner-token"),
    ).resolves.toBe("claimed");
    expect(persistedOwnerTokens).toEqual([]);
    // The restored owner's lease is live, so a replacement token is rejected (#10050).
    await expect(
      restarted.claimLivenessOwnership("restarted-ios-session", "replacement-owner-token"),
    ).resolves.toBe("conflict");
    expect(restarted.hasLivenessOwnership("restarted-ios-session", "current-owner-token")).toBe(
      true,
    );
    expect(persistedOwnerTokens).toEqual([]);
    fakeTimer.advanceTime(getDefaultSessionHeartbeatTimeoutMs() + 1);
    await expect(
      restarted.claimLivenessOwnership("restarted-ios-session", "replacement-owner-token"),
    ).resolves.toBe("claimed");
    expect(restarted.hasLivenessOwnership("restarted-ios-session", "replacement-owner-token")).toBe(
      true,
    );
    expect(persistedOwnerTokens).toEqual(["replacement-owner-token"]);
  });

  test("reacquires a restarted Android session by its persisted AVD identity", async () => {
    const persisted = sessionRow({
      session_uuid: "restarted-android-session",
      stable_device_id: "Pixel_8_API_35",
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    });
    const restarted = makeSessionManager({
      timer: fakeTimer,
      persistence: persistenceServing(persisted),
    });
    let recoveryTarget:
      | {
          platform: string;
          stableDeviceId: string;
          deviceId: string;
          androidEmulator?: boolean;
        }
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
      restarted.getOrCreateSession("restarted-android-session", devicePool, "android", {
        requireIssuedSession: true,
      }),
    ).resolves.toMatchObject({
      assignedDevice: "emulator-5560",
      stableDeviceId: "Pixel_8_API_35",
    });
    expect(recoveryTarget).toMatchObject({
      platform: "android",
      stableDeviceId: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      androidEmulator: true,
    });
  });

  test("terminal device-loss UUID remains fenced after manager restart", async () => {
    const persisted = sessionRow({
      session_uuid: "lost-session",
      status: "released",
      release_reason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    let upsertCount = 0;
    const persistence: DeviceSessionPersistence = persistenceServing(persisted, {
      async upsertActiveSession() {
        upsertCount += 1;
      },
    });
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const assignedSessionIds: string[] = [];
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId: string): Promise<string> {
        assignedSessionIds.push(sessionId);
        return "emulator-5560";
      },
    };

    await expect(
      restarted.getOrCreateSession("lost-session", devicePool, "android"),
    ).rejects.toThrow("terminal");
    expect(assignedSessionIds).toEqual([]);
    expect(upsertCount).toBe(0);
  });

  test("preserves a terminal release discovered while admitting an unissued UUID", async () => {
    const persisted = sessionRow({
      session_uuid: "late-terminal-session",
      status: "released",
      release_reason: "device-killed",
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    });
    let readCount = 0;
    const persistence: DeviceSessionPersistence = stubbedPersistence({
      async getSession() {
        readCount += 1;
        return readCount === 1 ? undefined : persisted;
      },
      async upsertActiveSession() {},
      async recordActivity() {},
      async markReleased() {},
    });
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    await expect(manager.admitIssuedSessionForAutomation("late-terminal-session")).rejects.toThrow(
      "terminal",
    );
  });

  test("rehydrates recoverable rows awaiting their prior owner and reclaims on use", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession(
      restartRow("rehydrate-me", { heartbeatTimeoutSource: "custom" }),
    );
    await persistence.recordLivenessOwnership("rehydrate-me", "owner-token");
    await persistence.markReleased("rehydrate-me", "expired", 30, "daemon-restart");
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const devicePool = recoveringAssigner(restarted);

    await expect(restarted.rehydratePersistedSessions(devicePool)).resolves.toEqual({
      rehydrated: ["rehydrate-me"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(restarted.getSession("rehydrate-me")).toMatchObject({
      assignedDevice: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      heartbeatTimeoutMs: 15_000,
      hasReceivedHeartbeat: false,
      livenessOwnerToken: "owner-token",
      ownership: "awaiting-owner",
      awaitingOwnerSince: fakeTimer.now(),
    });

    await restarted.getOrCreateSession("rehydrate-me");
    expect(restarted.getSession("rehydrate-me")).toMatchObject({ ownership: "owned" });
    expect(restarted.getSession("rehydrate-me")?.awaitingOwnerSince).toBeUndefined();
  });

  test("terminalizes missing rehydration targets without aborting the sweep", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession(restartRow("gone-after-restart"));
    await persistence.markReleased("gone-after-restart", "expired", 30, "daemon-restart");
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        if (!target) {
          throw new Error("missing recovery target");
        }
        throw new SessionRecoveryIdentityLossError(sessionId, target, "target-absent");
      },
    };

    await expect(restarted.rehydratePersistedSessions(devicePool)).resolves.toEqual({
      rehydrated: [],
      terminalized: [
        { sessionUuid: "gone-after-restart", reason: "identity-recovery-target-absent" },
      ],
      skipped: [],
      timedOut: false,
    });
    expect(await persistence.getSession("gone-after-restart")).toMatchObject({
      release_reason: "identity-recovery-target-absent",
      status: "released",
    });
  });

  /** Hangs the named rows' recovery; every other row recovers at once. */
  function poolHanging(restarted: SessionManager, hung: ReadonlySet<string>) {
    const assigned: string[] = [];
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        assigned.push(sessionId);
        if (hung.has(sessionId)) {
          return await new Promise<string>(() => {});
        }
        const session = await restarted.createSession(sessionId, "emulator-5556", "android", {
          timeoutMs: target?.liveness?.sessionTimeoutMs,
          heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
          stableDeviceId: target?.stableDeviceId,
          recoveredLiveness: target?.liveness,
          initialOwnership: target?.initialOwnership,
        });
        return session.assignedDevice;
      },
    };
    return { assigned, devicePool };
  }

  test("bounds hung rehydrations; every row starts before the deadline (#11114)", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await seedRestartReleasedRows(persistence, [
      ["hung-rehydration", 20],
      ["queued-rehydration", 10],
    ]);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const { assigned, devicePool } = poolHanging(
      restarted,
      new Set(["hung-rehydration", "queued-rehydration"]),
    );

    const rehydration = restarted.rehydratePersistedSessions(devicePool, { deadlineMs: 1_000 });
    for (let turn = 0; turn < 12 && assigned.length < 2; turn++) {
      await Promise.resolve();
    }
    await fakeTimer.advanceTimeAsync(1_000);
    await expect(rehydration).resolves.toEqual({
      rehydrated: [],
      terminalized: [],
      skipped: [
        { sessionUuid: "hung-rehydration", reason: "startup-deadline" },
        { sessionUuid: "queued-rehydration", reason: "startup-deadline" },
      ],
      timedOut: true,
    });
    expect(assigned).toEqual(["hung-rehydration", "queued-rehydration"]);
  });

  test("one slow row does not abandon the rows after it (#11114)", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await seedRestartReleasedRows(persistence, [
      ["slow-row", 20],
      ["later-row", 10],
    ]);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const { devicePool } = poolHanging(restarted, new Set(["slow-row"]));

    const rehydration = restarted.rehydratePersistedSessions(devicePool, { deadlineMs: 1_000 });
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    await fakeTimer.advanceTimeAsync(1_000);
    await expect(rehydration).resolves.toEqual({
      rehydrated: ["later-row"],
      terminalized: [],
      skipped: [{ sessionUuid: "slow-row", reason: "startup-deadline" }],
      timedOut: true,
    });
    expect(restarted.getSession("later-row")).toMatchObject({ ownership: "awaiting-owner" });
  });

  test("a follow-up sweep recovers rows the deadline kept from starting (#11114)", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await seedRestartReleasedRows(persistence, [
      ["slow-row", 20],
      ["deferred-row", 10],
    ]);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const { assigned, devicePool } = poolHanging(restarted, new Set(["slow-row"]));

    const rehydration = restarted.rehydratePersistedSessions(devicePool, {
      deadlineMs: 1_000,
      concurrency: 1,
    });
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    await fakeTimer.advanceTimeAsync(1_000);
    await expect(rehydration).resolves.toMatchObject({
      skipped: [
        { sessionUuid: "slow-row", reason: "startup-deadline" },
        { sessionUuid: "deferred-row", reason: "startup-deadline" },
      ],
      timedOut: true,
    });

    await fakeTimer.advanceTimeAsync(0);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(assigned).toEqual(["slow-row", "deferred-row"]);
    expect(restarted.getSession("deferred-row")).toMatchObject({ ownership: "awaiting-owner" });
  });

  test("bounds a hung recoverable-session list read inside the startup deadline", async () => {
    const listStarted = Promise.withResolvers<void>();
    const restarted = makeSessionManager({
      timer: fakeTimer,
      persistence: stubbedPersistence({
        async upsertActiveSession() {},
        async recordActivity() {},
        async markReleased() {},
        async listRecoverableSessions() {
          listStarted.resolve();
          return await new Promise<DeviceSession[]>(() => {});
        },
      }),
    });

    const rehydration = restarted.rehydratePersistedSessions(
      {
        async assignDeviceToSession(): Promise<string> {
          throw new Error("must not assign while the list is unavailable");
        },
      },
      { deadlineMs: 1_000 },
    );
    await listStarted.promise;
    await fakeTimer.advanceTimeAsync(1_000);
    await expect(rehydration).resolves.toEqual({
      rehydrated: [],
      terminalized: [],
      skipped: [],
      timedOut: true,
    });
  });

  test("does not overwrite a reconnect liveness claim after slow recovery", async () => {
    const persisted = sessionRow({
      session_uuid: "slow-owner-recovery",
      stable_device_id: "Pixel_8_API_35",
      status: "released",
      expires_at_ms: 60_020,
      released_at_ms: 30,
      session_timeout_ms: 60_000,
      heartbeat_timeout_ms: 15_000,
      liveness_owner_token: "persisted-owner",
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    });
    const sessionCreated = Promise.withResolvers<void>();
    const finishRecovery = Promise.withResolvers<void>();
    const restarted = makeSessionManager({
      timer: fakeTimer,
      persistence: persistenceServing(persisted, { async recordLivenessOwnership() {} }),
    });
    const devicePool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        await restarted.createSession(sessionId, "emulator-5554", "android", {
          timeoutMs: target?.liveness?.sessionTimeoutMs,
          heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
          stableDeviceId: target?.stableDeviceId,
          recoveredLiveness: target?.liveness,
          initialOwnership: target?.initialOwnership,
        });
        sessionCreated.resolve();
        await finishRecovery.promise;
        return "emulator-5554";
      },
    };
    try {
      const recovery = restarted.getOrCreateSession("slow-owner-recovery", devicePool, "android", {
        requireIssuedSession: true,
      });
      await sessionCreated.promise;
      // The persisted owner's lease must lapse or the reconnect claim is rejected (#10050).
      fakeTimer.advanceTime(persisted.heartbeat_timeout_ms + SUSPECT_GRACE_MS + 1);
      await expect(
        restarted.claimLivenessOwnership("slow-owner-recovery", "reconnected-owner"),
      ).resolves.toBe("claimed");
      finishRecovery.resolve();
      await recovery;
      expect(restarted.hasLivenessOwnership("slow-owner-recovery", "reconnected-owner")).toBe(true);
    } finally {
      finishRecovery.resolve();
      restarted.stopCleanupTimer();
    }
  });

  test("does not time out when all persisted rows recover quickly", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    for (const sessionUuid of ["quick-rehydration-a", "quick-rehydration-b"]) {
      await seedRestartReleasedRow(persistence, sessionUuid);
    }
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const devicePool = recoveringAssigner(restarted);

    await expect(
      restarted.rehydratePersistedSessions(devicePool, { deadlineMs: 15_000 }),
    ).resolves.toEqual({
      rehydrated: ["quick-rehydration-a", "quick-rehydration-b"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
  });

  test("does not attempt recovery when the startup deadline is zero", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await seedRestartReleasedRow(persistence, "zero-deadline-rehydration");
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    let assignments = 0;

    await expect(
      restarted.rehydratePersistedSessions(
        {
          async assignDeviceToSession(): Promise<string> {
            assignments += 1;
            return "emulator-5554";
          },
        },
        { deadlineMs: 0 },
      ),
    ).resolves.toEqual({
      rehydrated: [],
      terminalized: [],
      skipped: [{ sessionUuid: "zero-deadline-rehydration", reason: "startup-deadline" }],
      timedOut: true,
    });
    expect(assignments).toBe(0);
  });

  test("does not rehydrate terminal persisted rows", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession({
      sessionUuid: "terminal-row",
      deviceId: "emulator-5554",
      platform: "android",
      createdAtMs: 1,
      lastUsedAtMs: 20,
      expiresAtMs: 60_020,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 15_000,
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased("terminal-row", "released", 30, "device-killed");
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    let assignments = 0;

    await expect(
      restarted.rehydratePersistedSessions({
        async assignDeviceToSession(): Promise<string> {
          assignments += 1;
          return "emulator-5554";
        },
      }),
    ).resolves.toEqual({ rehydrated: [], terminalized: [], skipped: [], timedOut: false });
    expect(assignments).toBe(0);
  });

  test("promotes a slow startup recovery joined by an acquiring admission", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const sessionUuid = "joined-startup-recovery";
    await seedRestartReleasedRow(persistence, sessionUuid);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    let resolveAssignment!: () => void;
    const assignmentReady = new Promise<void>((resolve) => {
      resolveAssignment = resolve;
    });
    let assignments = 0;
    const devicePool = recoveringAssigner(restarted, {
      before: async () => {
        assignments += 1;
        await assignmentReady;
      },
    });

    const rehydration = restarted.rehydratePersistedSessions(devicePool, { deadlineMs: 10_000 });
    for (let turn = 0; turn < 12 && assignments === 0; turn++) {
      await Promise.resolve();
    }
    const joined = restarted.admitIssuedSessionForAutomation(sessionUuid);
    resolveAssignment();
    const [summary, session] = await Promise.all([rehydration, joined]);
    expect(assignments).toBe(1);
    expect(summary).toEqual({
      rehydrated: [sessionUuid],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(session).toBe(restarted.getSession(sessionUuid) ?? undefined);
    expect(session?.ownership).toBe("owned");
  });

  test("does not promote a pending startup recovery joined by read-only admission", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const sessionUuid = "read-only-joined-startup-recovery";
    await seedRestartReleasedRow(persistence, sessionUuid);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    const assignmentStarted = Promise.withResolvers<void>();
    const releaseAssignment = Promise.withResolvers<void>();
    let assignments = 0;
    const devicePool = recoveringAssigner(restarted, {
      before: async () => {
        assignments += 1;
        assignmentStarted.resolve();
        await releaseAssignment.promise;
      },
    });
    try {
      const rehydration = restarted.rehydratePersistedSessions(devicePool, { deadlineMs: 10_000 });
      await assignmentStarted.promise;
      const observed = restarted.admitIssuedSessionForAutomation(sessionUuid, undefined, {
        access: "read-only",
      });

      releaseAssignment.resolve();
      const [summary, session] = await Promise.all([rehydration, observed]);

      expect(assignments).toBe(1);
      expect(summary).toEqual({
        rehydrated: [sessionUuid],
        terminalized: [],
        skipped: [],
        timedOut: false,
      });
      expect(session).toBe(restarted.getSession(sessionUuid) ?? undefined);
      expect(session?.ownership).toBe("awaiting-owner");
    } finally {
      releaseAssignment.resolve();
      restarted.stopCleanupTimer();
    }
  });

  test("keeps a deadline-abandoned recovery available for reconnects", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const sessionUuid = "deadline-joined-recovery";
    await seedRestartReleasedRow(persistence, sessionUuid);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    let resolveAssignment!: () => void;
    const assignmentReady = new Promise<void>((resolve) => {
      resolveAssignment = resolve;
    });
    let assignments = 0;
    const devicePool = recoveringAssigner(restarted, {
      before: async () => {
        assignments += 1;
        await assignmentReady;
      },
    });

    const rehydration = restarted.rehydratePersistedSessions(devicePool, { deadlineMs: 1_000 });
    for (let turn = 0; turn < 12 && assignments === 0; turn++) {
      await Promise.resolve();
    }
    await fakeTimer.advanceTimeAsync(1_000);
    await expect(rehydration).resolves.toEqual({
      rehydrated: [],
      terminalized: [],
      skipped: [{ sessionUuid, reason: "startup-deadline" }],
      timedOut: true,
    });
    expect(assignments).toBe(1);

    const reconnected = restarted.getOrCreateSession(sessionUuid, devicePool, "android");
    await Promise.resolve();
    expect(assignments).toBe(1);
    resolveAssignment();
    await expect(reconnected).resolves.toMatchObject({
      sessionId: sessionUuid,
      ownership: "owned",
    });
    expect(assignments).toBe(1);
    expect(restarted.getSession(sessionUuid)).not.toBeNull();
    expect(restarted.getTerminalReleaseSnapshot(sessionUuid)).toBeUndefined();
  });

  test("skips a persisted row with an already-pending assignment", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const sessionUuid = "already-pending-recovery";
    await seedRestartReleasedRow(persistence, sessionUuid);
    const restarted = makeSessionManager({ timer: fakeTimer, persistence });
    let resolveAssignment!: () => void;
    const assignmentReady = new Promise<void>((resolve) => {
      resolveAssignment = resolve;
    });
    let assignments = 0;
    const devicePool = recoveringAssigner(restarted, {
      before: async () => {
        assignments += 1;
        await assignmentReady;
      },
    });

    const pending = restarted.getOrCreateSession(sessionUuid, devicePool, "android");
    await Promise.resolve();
    await Promise.resolve();
    const summary = await restarted.rehydratePersistedSessions(devicePool, {
      deadlineMs: 10_000,
    });
    expect(summary).toEqual({
      rehydrated: [],
      terminalized: [],
      skipped: [{ sessionUuid, reason: "already-pending" }],
      timedOut: false,
    });
    expect(assignments).toBe(1);
    resolveAssignment();
    await expect(pending).resolves.toMatchObject({ sessionId: sessionUuid });
  });
});

describe("released-session restart recovery window read-only probe", () => {
  test.each([
    { reason: "device-restart:Pixel", elapsed: 0, expiresAt: 600_000, expected: true },
    { reason: "device-restart:Pixel", elapsed: 179_999, expiresAt: 600_000, expected: true },
    { reason: "device-restart:Pixel", elapsed: 180_000, expiresAt: 600_000, expected: false },
    { reason: "device-restart:Pixel", elapsed: 1_000, expiresAt: 1_000, expected: false },
    { reason: "explicit-release", elapsed: 0, expiresAt: 600_000, expected: false },
    { reason: "heartbeat-timeout", elapsed: 0, expiresAt: 600_000, expected: false },
    { reason: "superseded", elapsed: 0, expiresAt: 600_000, expected: false },
    { reason: "device-killed", elapsed: 0, expiresAt: 600_000, expected: false },
    { reason: "daemon-restart", elapsed: 0, expiresAt: 600_000, expected: false },
  ])(
    "reason=$reason elapsed=$elapsed expiresAt=$expiresAt => $expected",
    async ({ reason, elapsed, expiresAt, expected }) => {
      const timer = new FakeTimer();
      const persistence = new FakeDeviceSessionPersistence();
      const row = persistedRecoverySession({
        status: "released",
        release_reason: reason,
        expires_at_ms: expiresAt,
      });
      persistence.seed(row);
      const manager = makeSessionManager({ timer, persistence });
      manager.stopCleanupTimer();
      timer.advanceTime(elapsed);
      const originalRow = { ...row };
      expect(await manager.isReleasedSessionInRestartRecoveryWindow(row.session_uuid)).toBe(
        expected,
      );
      expect(await persistence.getSession(row.session_uuid)).toEqual(originalRow);
      expect(manager.getAllSessions()).toEqual([]);
    },
  );

  test("no persisted row or release timestamp is not recoverable", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(
      persistedRecoverySession({ release_reason: "device-restart:Pixel", released_at_ms: null }),
    );
    const manager = makeSessionManager({ persistence });
    manager.stopCleanupTimer();
    expect(await manager.isReleasedSessionInRestartRecoveryWindow("missing")).toBe(false);
    expect(await manager.isReleasedSessionInRestartRecoveryWindow("persisted-session")).toBe(false);
  });

  test("row query errors propagate to the socket admission boundary", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    persistence.getSession = async () => {
      throw new Error("read failed");
    };
    const manager = makeSessionManager({ persistence });
    manager.stopCleanupTimer();
    await expect(manager.isReleasedSessionInRestartRecoveryWindow("missing")).rejects.toThrow(
      "read failed",
    );
  });
});

describe("restart recovery idle window counts control calls only (#11281)", () => {
  const SESSION = "restarting";

  /**
   * A session released for a device restart (60 s idle window, last control activity at t=0), with
   * the real execution tracker wired to the manager the way the daemon wires it. Its recovery is
   * pending in the pool, kept there by a waiter that is not a control call, so whatever extends
   * the window in a test is the call the test makes.
   */
  async function pendingRecovery(): Promise<{
    timer: FakeTimer;
    persistence: FakeDeviceSessionPersistence;
    manager: SessionManager;
    tracker: ExecutionTracker;
    failRecovery: () => void;
  }> {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(
      persistedRecoverySession({
        session_uuid: SESSION,
        stable_device_id: "Pixel",
        status: "released",
        release_reason: "device-restart:Pixel",
        expires_at_ms: 60_000,
      }),
    );
    const manager = makeSessionManager({ timer, persistence });
    manager.stopCleanupTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    subscribeToolCallEndActivity(tracker, manager, { sessionExecutionsEnded: () => {} });
    let failRecovery = (): void => {};
    const pool = {
      assignDeviceToSession: () =>
        new Promise<string>((_resolve, reject) => {
          failRecovery = () => reject(new Error("device still rebooting"));
        }),
    };
    void manager
      .getOrCreateSession(SESSION, pool, "android", {
        requireIssuedSession: true,
        access: "read-only",
      })
      .catch(() => {});
    await settle();
    return { timer, persistence, manager, tracker, failRecovery };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  /**
   * One tool call through the tracker and session admission, as `toolRegistry` runs it: a read is
   * marked and admitted read-only, a control call is marked admitted only once admission resolves.
   * The call ends when its admission settles.
   */
  function startCall(
    tracker: ExecutionTracker,
    manager: SessionManager,
    kind: "control" | "read",
  ): Promise<void> {
    const execution = tracker.startExecution(
      kind === "read" ? "observe" : "tapOn",
      undefined,
      SESSION,
    );
    const metadata = sessionExecutionMetadataOf(execution);
    if (kind === "read") {
      tracker.markDeviceReadCall(execution.id, execution.toolName);
    }
    const admission =
      kind === "read"
        ? manager.admitIssuedSessionForAutomation(SESSION, metadata, { access: "read-only" })
        : manager
            .admitIssuedSessionForAutomation(SESSION, metadata)
            .then(() => tracker.markSessionAdmitted(execution.id));
    return admission.then(
      () => tracker.endExecution(execution.id),
      () => tracker.endExecution(execution.id),
    );
  }

  test.each([
    { kind: "control" as const, recoverableAt70s: true },
    { kind: "read" as const, recoverableAt70s: false },
  ])(
    "a $kind call that waits on the restart and fails with it at 50 s => recoverable at 70 s: $recoverableAt70s",
    async ({ kind, recoverableAt70s }) => {
      const { timer, persistence, manager, tracker, failRecovery } = await pendingRecovery();
      const call = startCall(tracker, manager, kind);
      await settle();
      const expiryWhileWaiting = (await persistence.getSession(SESSION))?.expires_at_ms;

      timer.advanceTime(50_000);
      failRecovery();
      await call;
      await settle();

      const persistedExpiry = (await persistence.getSession(SESSION))?.expires_at_ms;
      expect(persistedExpiry === expiryWhileWaiting).toBe(!recoverableAt70s);
      timer.advanceTime(20_000);
      expect(await manager.isReleasedSessionInRestartRecoveryWindow(SESSION)).toBe(
        recoverableAt70s,
      );
    },
  );

  test.each([
    { kind: "control" as const, recoverableAt70s: true },
    { kind: "read" as const, recoverableAt70s: false },
  ])(
    "a $kind call joining the pending recovery at 50 s => recoverable at 70 s: $recoverableAt70s",
    async ({ kind, recoverableAt70s }) => {
      const { timer, manager, tracker } = await pendingRecovery();

      timer.advanceTime(50_000);
      void startCall(tracker, manager, kind);
      await settle();

      timer.advanceTime(20_000);
      expect(await manager.isReleasedSessionInRestartRecoveryWindow(SESSION)).toBe(
        recoverableAt70s,
      );
    },
  );

  test("a read that ran under the session id and ended at 50 s does not extend the recovery", async () => {
    const { timer, manager, tracker } = await pendingRecovery();

    timer.advanceTime(50_000);
    const read = tracker.startExecution("observe", undefined, SESSION);
    tracker.markDeviceReadCall(read.id, read.toolName);
    tracker.endExecution(read.id);
    await settle();

    timer.advanceTime(20_000);
    expect(await manager.isReleasedSessionInRestartRecoveryWindow(SESSION)).toBe(false);
  });
});
