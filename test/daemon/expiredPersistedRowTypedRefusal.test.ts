import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  SessionManager,
  TerminalSessionError,
  UnissuedSessionError,
  type SessionDeviceAssigner,
  type SessionRecoveryTarget,
} from "../../src/daemon/sessionManager";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { sessionOwnershipLostPayload } from "../../src/daemon/deviceSessionResult";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

// #11361 item 1: a row whose deadline passed while its daemon was down names a session that is
// gone for good. A call naming it is told so with the typed terminal refusal (carrying the
// `expired` reason), not the untyped "not found" a typo gets. The row itself stays non-terminal.

const SESSION = "s1";
const DEVICE = "emulator-5554";
const DEADLINE = 61_000;

describe("a session whose row expired while the daemon was down (#11361)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: DeviceSessionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    repo = new DeviceSessionRepository(db, timer);
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** A row the previous daemon left behind, released with `reason` when one is given. */
  async function seedRow(reason?: string, sessionTimeoutMs = 60_000): Promise<void> {
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      daemonSessionId: "peer-daemon",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: 1_000 + sessionTimeoutMs,
      sessionTimeoutMs,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    if (reason) {
      await repo.markReleased(SESSION, "released", 1_000, { reason });
    }
  }

  /** The daemon that starts after the previous one died. */
  function restartedDaemon(): SessionManager {
    const manager = new SessionManager(timer, repo, { barrier: () => new FakeDbWriteBarrier() });
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-b");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-b"]));
    return manager;
  }

  async function refusal(manager: SessionManager, access?: "read-only"): Promise<unknown> {
    return await manager
      .admitIssuedSessionForAutomation(SESSION, undefined, access ? { access } : {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  }

  for (const [label, reason] of [
    ["a live row whose idle deadline passed", undefined],
    ["a daemon-shutdown handoff whose recovery window lapsed", "daemon-shutdown"],
    ["a device-restart handoff whose recovery window lapsed", `device-restart:${DEVICE}`],
    ["a row already marked expired", "expired"],
  ] as const) {
    test(`${label} answers the typed terminal refusal with reason expired`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE + 1);
      const manager = restartedDaemon();

      const error = await refusal(manager);
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect((error as TerminalSessionError).release).toMatchObject({
        sessionId: SESSION,
        deviceId: DEVICE,
        releaseReason: "expired",
        terminal: true,
      });
      if (!(error instanceof TerminalSessionError)) {
        throw new Error("expected terminal refusal");
      }
      expect(
        sessionOwnershipLostPayload({
          message: error.message,
          sessionUuid: SESSION,
          reason: error.release.releaseReason,
          release: error.release,
        }).error,
      ).toMatchObject({
        code: "session_ownership_lost",
        reason: "expired",
        idle: true,
        retryable: false,
        nextAction: "acquire_new_session",
      });
      expect(mcpRequestFailureDetails(error, undefined).details).toEqual({
        sessionUuid: SESSION,
        reason: "expired",
        idle: true,
      });
      // Row hygiene is unchanged: the answer writes no terminal reason to the row.
      expect((await repo.getSession(SESSION))?.release_reason ?? undefined).toBe(reason);

      // A read is never refused: it gets the answer its caller turns into a sessionless read.
      expect(await refusal(manager, "read-only")).toBeInstanceOf(UnissuedSessionError);
    });
  }

  test("a row the startup sweep already marked expired answers the same refusal", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE + 1);
    await repo.listRecoverableSessions(timer.now());
    expect((await repo.getSession(SESSION))?.release_reason).toBe("expired");

    const error = await refusal(restartedDaemon());
    expect(error).toBeInstanceOf(TerminalSessionError);
    expect((error as TerminalSessionError).release.releaseReason).toBe("expired");
  });

  test("the device-tool path marks the row expired and answers the same refusal", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE + 1);
    const manager = restartedDaemon();
    const assigned: string[] = [];
    const pool = {
      async assignDeviceToSession(id: string): Promise<string> {
        assigned.push(id);
        return DEVICE;
      },
    };

    const error = await manager
      .getOrCreateSession(SESSION, pool, "android", { requireIssuedSession: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalSessionError);
    expect((error as TerminalSessionError).release.releaseReason).toBe("expired");
    // No device is assigned to the expired name, and the row keeps the non-terminal reason.
    expect(assigned).toEqual([]);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "expired",
    });
  });

  test("the expired answer raises no in-memory fence, so the name can be issued again", async () => {
    await seedRow();
    timer.setCurrentTime(DEADLINE + 1);
    const manager = restartedDaemon();

    expect(await refusal(manager)).toBeInstanceOf(TerminalSessionError);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    const created = await manager.createSession(SESSION, DEVICE, "android");
    expect(created.assignedDevice).toBe(DEVICE);
  });

  test("a recoverable handoff inside its window is still recovered, not refused", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE - 1);

    // Read-only admission never recovers; it reports the row as admissible by resolving.
    expect(await refusal(restartedDaemon(), "read-only")).toBeUndefined();
  });

  /** What `daemon/heartbeat` or `daemon/sessionInfo` answers a client naming the session. */
  async function wireAnswer(manager: SessionManager, method: string): Promise<unknown> {
    const registry = new DeviceSessionRegistry();
    return await handleDaemonRequest(
      { id: "request-1", type: "daemon_request", method, params: { sessionId: SESSION } },
      {
        isInitialized: () => true,
        getSessionManager: () => manager,
        getDevicePool: () => {
          throw new Error("a session-not-found answer never reaches the pool");
        },
        getDeviceSessionRegistry: () => registry,
      },
    );
  }

  // The heartbeat and session-info wires answer session-not-found with the recorded reason. A row
  // past its deadline is ended whatever reason it still stores, so they name `expired` as
  // admission does: a stored handoff reason would tell the owner's proxy to keep resuming a
  // session every call is refused for, and no reason at all reads as a never-issued id.
  for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
    for (const [label, reason] of [
      ["a live row whose idle deadline passed", undefined],
      ["a daemon-shutdown handoff whose recovery window lapsed", "daemon-shutdown"],
      ["a device-restart handoff whose recovery window lapsed", `device-restart:${DEVICE}`],
      ["a row the sweep already marked expired", "expired"],
    ] as const) {
      test(`${method} names expired for ${label}`, async () => {
        await seedRow(reason);
        timer.setCurrentTime(DEADLINE + 1);
        const manager = restartedDaemon();

        expect(await wireAnswer(manager, method)).toEqual({
          success: false,
          error: `Session not found: ${SESSION}`,
          code: "daemon_session_not_found",
          releaseReason: "expired",
          idle: true,
        });
        // Answering is a read: the row is left as it was.
        expect((await repo.getSession(SESSION))?.release_reason ?? undefined).toBe(reason);
      });
    }

    test(`${method} still names a handoff inside its recovery window`, async () => {
      await seedRow("daemon-shutdown");
      timer.setCurrentTime(DEADLINE - 1);

      const answer = await wireAnswer(restartedDaemon(), method);
      expect(answer).not.toHaveProperty("idle");
      expect(answer).toMatchObject({
        code: "daemon_session_not_found",
        releaseReason: "daemon-shutdown",
      });
    });

    test(`${method} keeps a terminal reason on a row past its deadline`, async () => {
      await seedRow("heartbeat-timeout");
      timer.setCurrentTime(DEADLINE + 1);

      const answer = await wireAnswer(restartedDaemon(), method);
      expect(answer).not.toHaveProperty("idle");
      expect(answer).toMatchObject({
        code: "daemon_session_not_found",
        releaseReason: "heartbeat-timeout",
      });
    });

    test(`${method} keeps the plain not-found for a never-issued id`, async () => {
      expect(await wireAnswer(restartedDaemon(), method)).toEqual({
        success: false,
        error: `Session not found: ${SESSION}`,
        code: "daemon_session_not_found",
      });
    });
  }

  test("the expired release snapshot is offered only for a row past its deadline", async () => {
    await seedRow("daemon-shutdown");
    timer.setCurrentTime(DEADLINE - 1);
    const manager = restartedDaemon();
    expect(await manager.getExpiredReleaseSnapshot(SESSION)).toBeUndefined();
    expect(await manager.getExpiredReleaseSnapshot("never-issued")).toBeUndefined();

    timer.setCurrentTime(DEADLINE + 1);
    expect(await manager.getExpiredReleaseSnapshot(SESSION)).toMatchObject({
      sessionId: SESSION,
      deviceId: DEVICE,
      releaseReason: "expired",
      terminal: true,
    });
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
  });

  for (const withPool of [false, true]) {
    test(`pins: never-resumed restart row past 180 seconds ${withPool ? "is rewritten by device-tool admission" : "is left intact by pool-less admission"}`, async () => {
      await seedRow(`device-restart:${DEVICE}`, 120_000);
      timer.setCurrentTime(181_001);
      const manager = restartedDaemon();
      const assigned: string[] = [];
      const pool = {
        async assignDeviceToSession(id: string): Promise<string> {
          assigned.push(id);
          return DEVICE;
        },
      };
      const error = await (
        withPool
          ? manager.getOrCreateSession(SESSION, pool, "android", { requireIssuedSession: true })
          : manager.admitIssuedSessionForAutomation(SESSION)
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect((error as TerminalSessionError).release).toMatchObject({
        releaseReason: "expired",
        terminal: true,
      });
      expect(await repo.getSession(SESSION)).toMatchObject({
        status: withPool ? "expired" : "released",
        release_reason: withPool ? "expired" : `device-restart:${DEVICE}`,
      });
      expect(assigned).toEqual([]);
    });
  }

  for (const now of [181_001, 301_001]) {
    for (const withPool of [false, true]) {
      test(`a lapsed 300-second restart row refuses ${withPool ? "device-tool" : "pool-less"} admission at ${now}`, async () => {
        await seedRow(`device-restart:${DEVICE}`, 300_000);
        timer.setCurrentTime(now);
        const manager = restartedDaemon();
        expect(await manager.isReleasedSessionInRestartRecoveryWindow(SESSION)).toBe(false);
        expect(await manager.getExpiredReleaseSnapshot(SESSION)).toMatchObject({
          releaseReason: "restart-recovery-timeout",
          terminal: true,
        });
        expect(await refusal(manager, "read-only")).toBeInstanceOf(UnissuedSessionError);
        for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
          expect(await wireAnswer(manager, method)).toEqual({
            success: false,
            error: `Session not found: ${SESSION}`,
            code: "daemon_session_not_found",
            releaseReason: "restart-recovery-timeout",
          });
        }
        const assigned: string[] = [];
        const pool = {
          async assignDeviceToSession(id: string) {
            assigned.push(id);
            return DEVICE;
          },
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = withPool
            ? await manager
                .getOrCreateSession(SESSION, pool, "android", { requireIssuedSession: true })
                .then(
                  () => undefined,
                  (caught: unknown) => caught,
                )
            : await refusal(manager);
          expect(error).toBeInstanceOf(TerminalSessionError);
          if (!(error instanceof TerminalSessionError)) {
            throw new Error("expected terminal refusal");
          }
          expect(error.release).toMatchObject({
            releaseReason: "restart-recovery-timeout",
            terminal: true,
          });
          const wire = sessionOwnershipLostPayload({
            message: error.message,
            sessionUuid: SESSION,
            reason: error.release.releaseReason,
            release: error.release,
          }).error;
          expect(wire).not.toHaveProperty("idle");
          expect(wire).toMatchObject({
            code: "session_ownership_lost",
            reason: "restart-recovery-timeout",
            retryable: false,
            nextAction: "acquire_new_session",
          });
          expect(mcpRequestFailureDetails(error, undefined).details).toEqual({
            sessionUuid: SESSION,
            reason: "restart-recovery-timeout",
          });
        }
        expect(assigned).toEqual([]);
        expect(await repo.getSession(SESSION)).toMatchObject({
          status: withPool ? "expired" : "released",
          release_reason: withPool ? "restart-recovery-timeout" : `device-restart:${DEVICE}`,
        });
      });
    }
    test(`startup sweep preserves the window-first reason at ${now}`, async () => {
      await seedRow(`device-restart:${DEVICE}`, 300_000);
      timer.setCurrentTime(now);
      expect(await repo.listRecoverableSessions(now)).toEqual([]);
      expect(await repo.getSession(SESSION)).toMatchObject({
        status: "expired",
        release_reason: "restart-recovery-timeout",
      });
    });
  }

  test("startup never assigns a lapsed restart row", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    timer.setCurrentTime(181_001);
    const assigned: string[] = [];
    const manager = restartedDaemon();
    const result = await manager.rehydratePersistedSessions({
      async assignDeviceToSession(id: string) {
        assigned.push(id);
        return DEVICE;
      },
    });
    expect(result.rehydrated).toEqual([]);
    expect(assigned).toEqual([]);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
    });
  });

  for (const now of [179_000, 181_001]) {
    test(`non-device-tool admission respects the restart window at ${now}`, async () => {
      await seedRow(`device-restart:${DEVICE}`, 300_000);
      timer.setCurrentTime(now);
      const manager = restartedDaemon();
      const targets: Array<SessionRecoveryTarget | undefined> = [];
      const pool: SessionDeviceAssigner = {
        async assignDeviceToSession(id, platform, target) {
          targets.push(target);
          await manager.createSession(id, DEVICE, platform ?? "android", {
            stableDeviceId: target?.stableDeviceId,
            recoveredLiveness: target?.liveness,
          });
          return DEVICE;
        },
      };
      const result = manager.getOrCreateSession(SESSION, pool, "android");
      if (now === 179_000) {
        await expect(result).resolves.toMatchObject({ assignedDevice: DEVICE });
        expect(targets).toHaveLength(1);
        expect(targets[0]).toMatchObject({
          deviceId: DEVICE,
          stableDeviceId: "Pixel_8_API_35",
          restartRecoveryDeadlineMs: 181_000,
        });
      } else {
        const error = await result.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(TerminalSessionError);
        expect(error).toMatchObject({
          release: { releaseReason: "restart-recovery-timeout", terminal: true },
        });
        expect(targets).toEqual([]);
        expect(await repo.getSession(SESSION)).toMatchObject({
          status: "expired",
          release_reason: "restart-recovery-timeout",
        });
      }
    });
  }

  test("failed peer discovery refuses a lapsed restart row without writing or fencing it", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    timer.setCurrentTime(181_001);
    const before = await repo.getSession(SESSION);
    const manager = restartedDaemon();
    manager.attachLiveDaemonSessionIds(() => {
      throw new Error("live daemon discovery unavailable");
    });
    let assigned = false;
    let notices = 0;
    manager.onSessionRelease(() => {
      notices++;
    });
    const error = await manager
      .getOrCreateSession(
        SESSION,
        {
          async assignDeviceToSession() {
            assigned = true;
            return DEVICE;
          },
        },
        "android",
        { requireIssuedSession: true },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalSessionError);
    expect(error).toMatchObject({
      release: { releaseReason: "restart-recovery-timeout", terminal: true },
    });
    expect(await repo.getSession(SESSION)).toEqual(before);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    expect(assigned).toBe(false);
    expect(notices).toBe(0);
  });

  for (const idleWindow of [120_000, 180_000]) {
    test(`startup keeps idle-first semantics for a ${idleWindow} ms idle deadline`, async () => {
      await seedRow(`device-restart:${DEVICE}`, idleWindow);
      timer.setCurrentTime(301_001);
      expect(await repo.listRecoverableSessions(timer.now())).toEqual([]);
      expect(await repo.getSession(SESSION)).toMatchObject({
        status: "expired",
        release_reason: "expired",
      });
      const error = await refusal(restartedDaemon());
      expect(error).toBeInstanceOf(TerminalSessionError);
      if (!(error instanceof TerminalSessionError)) {
        throw new Error("expected terminal refusal");
      }
      expect(mcpRequestFailureDetails(error, undefined).details).toEqual({
        sessionUuid: SESSION,
        reason: "expired",
        idle: true,
      });
    });
  }

  for (const idleWindow of [120_000, 300_000]) {
    test(`startup does not write a live peer's lapsed ${idleWindow} ms restart row`, async () => {
      await seedRow(`device-restart:${DEVICE}`, idleWindow);
      timer.setCurrentTime(301_001);
      const before = await repo.getSession(SESSION);
      expect(await repo.listRecoverableSessions(timer.now(), () => ["peer-daemon"])).toEqual([]);
      expect(await repo.getSession(SESSION)).toEqual(before);
    });
  }

  test("device-tool admission leaves a live peer's row untouched after both deadlines", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    timer.setCurrentTime(301_001);
    const before = await repo.getSession(SESSION);
    const manager = restartedDaemon();
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-b", "peer-daemon"]));
    let assigned = false;
    const pool = {
      async assignDeviceToSession() {
        assigned = true;
        return DEVICE;
      },
    };
    await expect(
      manager.getOrCreateSession(SESSION, pool, "android", { requireIssuedSession: true }),
    ).rejects.toMatchObject({ release: { releaseReason: "expired" } });
    expect(assigned).toBe(false);
    expect(await repo.getSession(SESSION)).toEqual(before);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
  });

  test("device-tool admission may terminalize a null-owner lapsed restart row", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    await db
      .updateTable("device_sessions")
      .set({ daemon_session_id: null })
      .where("session_uuid", "=", SESSION)
      .execute();
    timer.setCurrentTime(181_001);
    let assigned = false;
    const pool = {
      async assignDeviceToSession() {
        assigned = true;
        return DEVICE;
      },
    };
    await expect(
      restartedDaemon().getOrCreateSession(SESSION, pool, "android", {
        requireIssuedSession: true,
      }),
    ).rejects.toMatchObject({
      release: { releaseReason: "restart-recovery-timeout", terminal: true },
    });
    expect(assigned).toBe(false);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
    });
  });

  test("a 300-second restart row remains admissible at 179 seconds", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    timer.setCurrentTime(180_000);
    expect(await refusal(restartedDaemon())).toBeUndefined();
  });

  for (const decision of ["initial claim", "lost claim retry"] as const) {
    for (const offset of [-1, 0, 1]) {
      test(`${decision} checks the restart window at end ${offset >= 0 ? "+" : ""}${offset} ms`, async () => {
        await seedRow(`device-restart:${DEVICE}`, 300_000);
        const windowEnd = 1_000 + DEVICE_RESTART_RECOVERY_WINDOW_MS;
        timer.setCurrentTime(windowEnd - 2);
        const manager = restartedDaemon();
        let activityAt: number | undefined;
        let claims = 0;
        const recordActivity = repo.recordRestartRecoveryActivity.bind(repo);
        repo.recordRestartRecoveryActivity = async (...args) => {
          activityAt = timer.now();
          if (decision === "initial claim") {
            timer.setCurrentTime(windowEnd + offset);
          }
          await recordActivity(...args);
        };
        const claim = repo.claimRecoverableSession.bind(repo);
        repo.claimRecoverableSession = async (...args) => {
          claims++;
          if (decision === "lost claim retry" && claims === 1) {
            timer.setCurrentTime(windowEnd + offset);
            return undefined;
          }
          return await claim(...args);
        };
        const targets: Array<SessionRecoveryTarget | undefined> = [];
        const pool: SessionDeviceAssigner = {
          async assignDeviceToSession(id, platform, target) {
            targets.push(target);
            await manager.createSession(id, DEVICE, platform ?? "android", {
              stableDeviceId: target?.stableDeviceId,
              recoveredLiveness: target?.liveness,
            });
            return DEVICE;
          },
        };
        const result = manager.getOrCreateSession(SESSION, pool, "android", {
          requireIssuedSession: true,
        });
        if (offset < 0) {
          await expect(result).resolves.toMatchObject({ assignedDevice: DEVICE });
          expect(targets).toHaveLength(1);
          expect(targets[0]).toMatchObject({
            deviceId: DEVICE,
            stableDeviceId: "Pixel_8_API_35",
            restartRecoveryDeadlineMs: windowEnd,
          });
        } else {
          await expect(result).rejects.toMatchObject({
            release: { releaseReason: "restart-recovery-timeout", terminal: true },
          });
          expect(targets).toEqual([]);
          expect(await repo.getSession(SESSION)).toMatchObject({
            status: "expired",
            release_reason: "restart-recovery-timeout",
          });
        }
        expect(activityAt).toBe(windowEnd - 2);
        expect(claims).toBe((decision === "lost claim retry" ? 1 : 0) + (offset < 0 ? 1 : 0));
        manager.stopCleanupTimer();
      });
    }
  }

  for (const offset of [-1, 0, 1]) {
    test(`startup lost claim retry checks the restart window at end ${offset >= 0 ? "+" : ""}${offset} ms`, async () => {
      await seedRow(`device-restart:${DEVICE}`, 300_000);
      const windowEnd = 1_000 + DEVICE_RESTART_RECOVERY_WINDOW_MS;
      timer.setCurrentTime(windowEnd - 2);
      const manager = restartedDaemon();
      let claims = 0;
      const claim = repo.claimRecoverableSession.bind(repo);
      repo.claimRecoverableSession = async (...args) => {
        claims++;
        if (claims === 1) {
          timer.setCurrentTime(windowEnd + offset);
          return undefined;
        }
        return await claim(...args);
      };
      const targets: Array<SessionRecoveryTarget | undefined> = [];
      const result = await manager.rehydratePersistedSessions({
        async assignDeviceToSession(id, platform, target) {
          targets.push(target);
          await manager.createSession(id, DEVICE, platform ?? "android", {
            stableDeviceId: target?.stableDeviceId,
            recoveredLiveness: target?.liveness,
            initialOwnership: target?.initialOwnership,
          });
          return DEVICE;
        },
      });
      if (offset < 0) {
        expect(result.rehydrated).toEqual([SESSION]);
        expect(targets).toHaveLength(1);
        expect(targets[0]).toMatchObject({ deviceId: DEVICE, initialOwnership: "awaiting-owner" });
      } else {
        expect(result.rehydrated).toEqual([]);
        expect(result.terminalized).toEqual([
          { sessionUuid: SESSION, reason: "restart-recovery-timeout" },
        ]);
        expect(targets).toEqual([]);
        expect(await repo.getSession(SESSION)).toMatchObject({
          status: "expired",
          release_reason: "restart-recovery-timeout",
        });
      }
      expect(claims).toBe(offset < 0 ? 2 : 1);
      manager.stopCleanupTimer();
    });
  }

  test("a recovery claimed before the window end keeps its target when the claim returns late", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    const windowEnd = 1_000 + DEVICE_RESTART_RECOVERY_WINDOW_MS;
    timer.setCurrentTime(windowEnd - 1);
    const manager = restartedDaemon();
    const claim = repo.claimRecoverableSession.bind(repo);
    repo.claimRecoverableSession = async (...args) => {
      const generation = await claim(...args);
      expect(generation).toBeDefined();
      timer.setCurrentTime(windowEnd);
      return generation;
    };
    const targets: Array<SessionRecoveryTarget | undefined> = [];
    const pool: SessionDeviceAssigner = {
      async assignDeviceToSession(id, platform, target) {
        targets.push(target);
        await manager.createSession(id, DEVICE, platform ?? "android", {
          stableDeviceId: target?.stableDeviceId,
          recoveredLiveness: target?.liveness,
        });
        return DEVICE;
      },
    };
    await expect(
      manager.getOrCreateSession(SESSION, pool, "android", { requireIssuedSession: true }),
    ).resolves.toMatchObject({ assignedDevice: DEVICE });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      restartRecoveryDeadlineMs: windowEnd,
    });
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    manager.stopCleanupTimer();
  });

  test("a live peer's row stays exempt when the window lapses between admission and claim", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    const windowEnd = 1_000 + DEVICE_RESTART_RECOVERY_WINDOW_MS;
    timer.setCurrentTime(windowEnd - 1);
    const manager = restartedDaemon();
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-b", "peer-daemon"]));
    manager.onRestartRecoveryActivity(() => timer.setCurrentTime(windowEnd));
    let assigned = false;
    await expect(
      manager.getOrCreateSession(
        SESSION,
        {
          async assignDeviceToSession() {
            assigned = true;
            return DEVICE;
          },
        },
        "android",
        { requireIssuedSession: true },
      ),
    ).rejects.toMatchObject({ code: "device_owned_by_other_daemon" });
    expect(assigned).toBe(false);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "released",
      release_reason: `device-restart:${DEVICE}`,
      daemon_session_id: "peer-daemon",
      stable_identity_generation: 0,
    });
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    manager.stopCleanupTimer();
  });

  test("a live peer's lapsed recovery row is neither refused for lapse nor written", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    timer.setCurrentTime(181_001);
    const manager = restartedDaemon();
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-b", "peer-daemon"]));
    const before = await repo.getSession(SESSION);
    expect(await refusal(manager)).toBeUndefined();
    expect(await manager.getExpiredReleaseSnapshot(SESSION)).toBeUndefined();
    expect(await repo.getSession(SESSION)).toEqual(before);
  });

  test("a terminally released row is not offered as expired", async () => {
    await seedRow("heartbeat-timeout");
    timer.setCurrentTime(DEADLINE + 1);

    expect(await restartedDaemon().getExpiredReleaseSnapshot(SESSION)).toBeUndefined();
  });

  test("a never-issued id keeps the untyped not-found answer", async () => {
    const error = await refusal(restartedDaemon());
    expect(error).toBeInstanceOf(UnissuedSessionError);
    expect((error as Error).message).toContain("not an active daemon session (not found)");
  });
});
