import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  SessionManager,
  TerminalSessionError,
  UnissuedSessionError,
} from "../../src/daemon/sessionManager";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
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
      daemonSessionId: "dead-daemon",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: 1_000 + sessionTimeoutMs,
      sessionTimeoutMs,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
    if (reason) {
      await repo.markReleased(SESSION, "released", 1_000, reason);
    }
  }

  /** The daemon that starts after the previous one died. */
  function restartedDaemon(): SessionManager {
    const manager = new SessionManager(timer, repo, () => new FakeDbWriteBarrier());
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
      .getOrCreateSession(SESSION, pool, "android", undefined, true)
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
          ? manager.getOrCreateSession(SESSION, pool, "android", undefined, true)
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

  test("pins: pool-less control admission after restart recovery but before a 300-second idle deadline remains admissible", async () => {
    await seedRow(`device-restart:${DEVICE}`, 300_000);
    timer.setCurrentTime(181_001);
    const manager = restartedDaemon();
    expect(await manager.isReleasedSessionInRestartRecoveryWindow(SESSION)).toBe(false);
    expect(await refusal(manager)).toBeUndefined();
    expect(manager.hasSession(SESSION)).toBe(false);
    expect(await repo.getSession(SESSION)).toMatchObject({
      status: "released",
      release_reason: `device-restart:${DEVICE}`,
      expires_at_ms: 301_000,
    });
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
