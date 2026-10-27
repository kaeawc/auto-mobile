import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import type {
  TerminalReleaseIntent,
  TerminalReleaseJournal,
} from "../../src/daemon/terminalReleaseJournal";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { releasedSessionNotFoundFields } from "../../src/daemon/types";
import { sessionReleaseReasonTraits } from "../../src/daemon/releaseReasons";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/wire/sessionLivenessWindows";
import { sessionOwnershipLostPayload } from "../../src/daemon/deviceSessionResult";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// Owner decision 2026-10-09 (#11258): every idle release ends the session. The UUID is journaled
// and fenced like any terminal release, and a later call naming it is told to acquire a new one.

const SESSION = "00000000-0000-4000-8000-000000000011";
const DEVICE = "emulator-5554";

// Neither request under test reaches the device pool or the device-session registry.
function stateFor(manager: SessionManager): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      releaseDevice: async () => {},
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

class RecordingJournal implements TerminalReleaseJournal {
  readonly recorded: TerminalReleaseIntent[] = [];
  loadUnconfirmed(): TerminalReleaseIntent[] {
    return [];
  }
  record(intent: TerminalReleaseIntent): "volatile" {
    this.recorded.push(intent);
    return "volatile";
  }
  resolve(): void {}
}

beforeAll(async () => {
  // Pay the release path's one-time initialization outside the assertion budget.
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager.attachTerminalReleaseJournal(new RecordingJournal());
  try {
    const session = await manager.createSession("warm-idle-release", DEVICE, "android");
    timer.setCurrentTime(session.expiresAt + 1);
    manager.cleanupExpiredSessions();
    await manager.waitForSessionRelease(session.sessionId);
  } finally {
    manager.stopCleanupTimer();
  }
});

describe("an idle release is terminal (#11258)", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let manager: SessionManager;
  let journal: RecordingJournal;
  let assignments: string[];
  const pool: SessionDeviceAssigner = {
    async assignDeviceToSession(sessionId: string): Promise<string> {
      assignments.push(sessionId);
      return "emulator-5556";
    },
  };
  const savedEnv = process.env[SESSION_IDLE_TIMEOUT_ENV];

  beforeEach(async () => {
    delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    manager = new SessionManager(timer, persistence);
    journal = new RecordingJournal();
    manager.attachTerminalReleaseJournal(journal);
    assignments = [];
    await manager.createSession(SESSION, DEVICE, "android");
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    if (savedEnv === undefined) {
      delete process.env[SESSION_IDLE_TIMEOUT_ENV];
    } else {
      process.env[SESSION_IDLE_TIMEOUT_ENV] = savedEnv;
    }
  });

  const refusalOf = async (attempt: Promise<unknown>): Promise<unknown> =>
    await attempt.then(
      () => undefined,
      (error: unknown) => error,
    );

  test.each([
    ["sweep", "heartbeat"],
    ["lookup", "heartbeat"],
    ["sweep", "managed-execution"],
    ["lookup", "managed-execution"],
  ] as const)(
    "an idle %s judgement of %s agrees with its policy on every surface",
    async (path, policy) => {
      if (policy === "managed-execution") {
        await manager.adoptManagedExecutionLivenessPolicy(SESSION);
      }
      const origins: unknown[] = [];
      manager.onSessionRelease((_id, _device, _reason, _snapshot, options) => {
        origins.push(options.expiryOrigin);
      });
      timer.setCurrentTime(manager.getAllSessions()[0]!.expiresAt + 1);
      if (policy === "managed-execution") {
        await handleDaemonRequest(
          {
            id: "hb",
            type: "daemon_request",
            method: "daemon/heartbeat",
            params: { sessionId: SESSION },
          },
          stateFor(manager),
        );
        if (path === "sweep") {
          manager.cleanupExpiredSessions();
        } else {
          expect(manager.getSession(SESSION)).not.toBeNull();
        }
        expect(manager.getSession(SESSION)).not.toBeNull();
        expect(origins).toEqual([]);
        expect(journal.recorded).toEqual([]);
        expect((await persistence.getSession!(SESSION))?.release_reason).toBeNull();
        return;
      }
      if (path === "sweep") {
        manager.cleanupExpiredSessions();
      } else {
        expect(manager.getSession(SESSION)).toBeNull();
      }
      await manager.waitForSessionRelease(SESSION);
      const reason = "cleanup-expired";
      expect(origins).toEqual([path === "sweep" ? "cleanup-expired" : "lazy-expiry"]);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toMatchObject({ releaseReason: reason });
      expect(
        releasedSessionNotFoundFields(await manager.getReleasedSessionReason(SESSION)),
      ).toEqual({
        releaseReason: reason,
        idle: true,
      });
      const registration = await handleDaemonRequest(
        {
          id: "late",
          type: "daemon_request",
          method: "daemon/registerSession",
          params: { sessionId: SESSION, clientName: "late-client" },
        },
        stateFor(manager),
      );
      expect(registration).toMatchObject({ success: false, details: { reason, idle: true } });

      expect(journal.recorded.map((intent) => [intent.sessionId, intent.reason])).toEqual([
        [SESSION, reason],
      ]);
      expect(await persistence.getSession!(SESSION)).toMatchObject({
        status: "expired",
        release_reason: reason,
      });

      const refusal = await refusalOf(manager.getOrCreateSession(SESSION, pool));
      expect(refusal).toBeInstanceOf(TerminalSessionError);
      const error = refusal as TerminalSessionError;
      expect(error.release).toMatchObject({ releaseReason: reason, terminal: true });
      expect(
        sessionOwnershipLostPayload({
          message: error.message,
          sessionUuid: error.sessionUuid,
          reason: error.release.releaseReason,
          release: error.release,
        }),
      ).toMatchObject({
        error: {
          code: "session_ownership_lost",
          reason,
          idle: true,
          retryable: false,
          nextAction: "acquire_new_session",
        },
      });
      expect(assignments).toEqual([]);
    },
  );

  test("a restarted daemon refuses the idle-released UUID instead of rehydrating it", async () => {
    timer.setCurrentTime(manager.getAllSessions()[0]!.expiresAt + 1);
    manager.cleanupExpiredSessions();
    await manager.waitForSessionRelease(SESSION);
    manager.stopCleanupTimer();

    const restarted = new SessionManager(timer, persistence);
    try {
      const refusal = await refusalOf(restarted.getOrCreateSession(SESSION, pool));
      expect(refusal).toBeInstanceOf(TerminalSessionError);
      expect((refusal as TerminalSessionError).release).toMatchObject({
        releaseReason: "cleanup-expired",
        terminal: true,
      });
      expect(assignments).toEqual([]);
    } finally {
      restarted.stopCleanupTimer();
    }
  });
});

test("legacy lazy-expiry keeps its idle terminal expiry traits", () => {
  expect(sessionReleaseReasonTraits("lazy-expiry")).toMatchObject({
    idle: true,
    terminal: true,
    expiry: true,
  });
});
