import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/wire/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { sessionReleaseReasonTraits } from "../../src/daemon/releaseReasons";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { SESSION_OWNERSHIP_LOST_CODE } from "../../src/daemon/sessionReleasedDuringCall";
import { DAEMON_SESSION_NOT_FOUND_CODE, type DaemonRequest } from "../../src/daemon/types";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import type { SessionReleaseReason } from "../../src/models/releaseReasons";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../../src/models/deviceSessionRecovery";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// #11367 follow-up: the registerSession fence must survive a daemon restart. Two SessionManagers
// over one database model the restart: the first releases the session, the second starts with an
// empty in-memory terminal-release snapshot and has only the persisted row to go on.

const SESSION = "00000000-0000-4000-8000-000000000001";
const DEVICE = "emulator-5554";
const OBSERVER_TIMEOUT_MS = 10_000;

const request = (method: string, params: unknown): DaemonRequest => ({
  id: "test",
  type: "daemon_request",
  method,
  params,
});

interface TestDaemon {
  manager: SessionManager;
  registry: ObserverSessionRegistry;
  state: DaemonStateAccess;
}

describe("registerSession after a daemon restart (#11367)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: DeviceSessionRepository;
  let registries: ObserverSessionRegistry[];

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    repo = new DeviceSessionRepository({ db, timer });
    registries = [];
  });

  afterEach(async () => {
    for (const registry of registries) {
      registry.dispose();
    }
    await db.destroy();
  });

  function daemon(id: string): TestDaemon {
    const manager = new SessionManager(timer, repo);
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId(id);
    manager.attachLiveDaemonSessionIds(() => new Set([id]));
    const registry = new ObserverSessionRegistry(timer, OBSERVER_TIMEOUT_MS);
    manager.setObserverSessionRegistry(registry);
    registries.push(registry);
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getObserverSessionRegistry: () => registry,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => {
        throw new Error("Registration must not consult the pool");
      },
    };
    return { manager, registry, state };
  }

  /** The first daemon issues the session and releases it; the returned daemon is its successor. */
  async function restartedAfterRelease(releaseReason: SessionReleaseReason): Promise<TestDaemon> {
    const first = daemon("daemon-a");
    await first.manager.createSession(SESSION, DEVICE, "android");
    timer.advanceTime(5);
    await first.manager.releaseSession(SESSION, releaseReason);
    expect((await repo.getSession(SESSION))?.release_reason).toBe(releaseReason);
    return daemon("daemon-b");
  }

  const register = (state: DaemonStateAccess, sessionId = SESSION) =>
    handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    );
  const heartbeat = (state: DaemonStateAccess) =>
    handleDaemonRequest(request("daemon/heartbeat", { sessionId: SESSION }), state);
  const accepted = {
    success: true,
    result: {
      accepted: true,
      heartbeatTimeoutMs: OBSERVER_TIMEOUT_MS,
      expiresAtMs: expect.any(Number),
    },
  };

  for (const releaseReason of [
    "cleanup-expired",
    "lazy-expiry",
    "cli-idle-timeout",
    "heartbeat-timeout",
    "missing-first-heartbeat",
    "rehydration-owner-timeout",
  ] as const) {
    test(`the restarted daemon refuses a UUID the previous daemon released by ${releaseReason}`, async () => {
      const { manager, registry, state } = await restartedAfterRelease(releaseReason);
      const idle = sessionReleaseReasonTraits(releaseReason).idle;
      const released = {
        success: false,
        error: `Session not found: ${SESSION}`,
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        releaseReason,
        ...(idle ? ({ idle: true } as const) : {}),
      } as const;
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      expect(await heartbeat(state)).toEqual(released);

      expect(await register(state)).toEqual({
        success: false,
        code: SESSION_OWNERSHIP_LOST_CODE,
        retryable: false,
        nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
        error: expect.stringContaining(`Session ${SESSION} is terminal after ${releaseReason}`),
        details: {
          sessionUuid: SESSION,
          reason: releaseReason,
          ...(idle ? ({ idle: true } as const) : {}),
        },
        releaseReason,
        ...(idle ? ({ idle: true } as const) : {}),
      });

      expect(registry.list()).toEqual([]);
      expect(await heartbeat(state)).toEqual(released);
      expect(manager.getSession(SESSION)).toBeNull();
    });
  }

  // Scope stays as #11454 shipped it: only idle and heartbeat releases are refused.
  for (const releaseReason of [
    "explicit-release",
    "owner-disconnected",
    "device-killed",
    `device-disconnected:${DEVICE}`,
    "identity-recovery-device-missing",
    "plan-auto-release",
  ] as const) {
    test(`the restarted daemon still registers a UUID released by ${releaseReason}`, async () => {
      const { registry, state } = await restartedAfterRelease(releaseReason);

      expect(await register(state)).toEqual(accepted);

      expect(registry.list().map((entry) => entry.sessionId)).toEqual([SESSION]);
      expect((await repo.getSession(SESSION))?.release_reason).toBe(releaseReason);
    });
  }

  test("a recoverable handoff registers and its row stays recoverable", async () => {
    const { registry, state } = await restartedAfterRelease("daemon-shutdown");
    const before = await repo.getSession(SESSION);
    expect(before).toMatchObject({ status: "released", release_reason: "daemon-shutdown" });

    expect(await register(state)).toEqual(accepted);

    expect(registry.list().map((entry) => entry.sessionId)).toEqual([SESSION]);
    expect(await repo.getSession(SESSION)).toEqual(before);
  });

  test("a never-seen UUID registers as an observer beside a persisted terminal row", async () => {
    const { registry, state } = await restartedAfterRelease("cleanup-expired");
    const fresh = "00000000-0000-4000-8000-000000000002";

    expect(await register(state, fresh)).toEqual(accepted);

    expect(registry.list().map((entry) => entry.sessionId)).toEqual([fresh]);
  });

  for (const known of [false, true]) {
    test(`an expired snapshot read failure falls back to the persisted reason for a ${known ? "terminal" : "never-seen"} UUID`, async () => {
      const { manager, registry, state } = await restartedAfterRelease("cleanup-expired");
      manager.getExpiredReleaseSnapshot = async () => {
        throw new Error("snapshot repository read failed");
      };
      const sessionId = known ? SESSION : "00000000-0000-4000-8000-000000000002";

      const result = await register(state, sessionId);

      if (known) {
        expect(result).toMatchObject({
          success: false,
          code: SESSION_OWNERSHIP_LOST_CODE,
          retryable: false,
          nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
          details: { sessionUuid: SESSION, reason: "cleanup-expired", idle: true },
          releaseReason: "cleanup-expired",
          idle: true,
        });
        expect(registry.list()).toEqual([]);
      } else {
        expect(result).toEqual(accepted);
        expect(registry.list().map((entry) => entry.sessionId)).toEqual([sessionId]);
      }
    });
  }

  test("a session issued while the persisted row is read answers as itself, not an observer", async () => {
    const { manager, registry, state } = daemon("daemon-b");
    const reading = Promise.withResolvers<void>();
    const finishRead = Promise.withResolvers<void>();
    const getSession = repo.getSession.bind(repo);
    repo.getSession = async (sessionUuid) => {
      reading.resolve();
      await finishRead.promise;
      return getSession(sessionUuid);
    };
    const registration = register(state);
    await reading.promise;
    repo.getSession = getSession;
    const session = await manager.createSession(SESSION, DEVICE, "android");
    finishRead.resolve();

    expect(await registration).toEqual({
      success: true,
      result: {
        accepted: true,
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        expiresAtMs: expect.any(Number),
      },
    });
    expect(registry.list()).toEqual([]);
  });

  test("a row that expired while no daemon ran refuses registration with the same idle reason on every surface", async () => {
    const first = daemon("daemon-a");
    await first.manager.createSession(SESSION, DEVICE, "android");
    const row = await repo.getSession(SESSION);
    expect(row).toMatchObject({ status: "active", release_reason: null });
    timer.setCurrentTime((row?.expires_at_ms ?? 0) + 1);
    const { manager, registry, state } = daemon("daemon-b");

    expect(await register(state)).toEqual({
      success: false,
      code: SESSION_OWNERSHIP_LOST_CODE,
      retryable: false,
      nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
      error: expect.stringContaining(`Session ${SESSION} is terminal after expired`),
      details: { sessionUuid: SESSION, reason: "expired", idle: true },
      releaseReason: "expired",
      idle: true,
    });

    expect(registry.list()).toEqual([]);
    const missing = {
      success: false,
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      error: `Session not found: ${SESSION}`,
      releaseReason: "expired",
      idle: true,
    } as const;
    expect(await heartbeat(state)).toEqual(missing);
    expect(
      await handleDaemonRequest(request("daemon/sessionInfo", { sessionId: SESSION }), state),
    ).toEqual(missing);
    const control = manager.admitIssuedSessionForAutomation(SESSION, {
      executionId: "late-control",
      startTime: timer.now(),
    });
    await expect(control).rejects.toBeInstanceOf(TerminalSessionError);
    await expect(control).rejects.toMatchObject({
      release: { releaseReason: "expired", terminal: true },
    });
    expect(await repo.getSession(SESSION)).toEqual(row);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();

    const fresh = "00000000-0000-4000-8000-000000000002";
    expect(await register(state, fresh)).toEqual(accepted);
    expect(registry.list().map((entry) => entry.sessionId)).toEqual([fresh]);
  });
});
