import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SessionManager,
  TerminalSessionError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import type {
  TerminalReleaseIntent,
  TerminalReleaseJournal,
} from "../../src/daemon/terminalReleaseJournal";
import { SESSION_IDLE_TIMEOUT_ENV } from "../../src/daemon/sessionLivenessWindows";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// Owner decision 2026-10-09 (#11258): every idle release ends the session. The UUID is journaled
// and fenced like any terminal release, and a later call naming it is told to acquire a new one.

const SESSION = "idle-terminal-session";
const DEVICE = "emulator-5554";

class RecordingJournal implements TerminalReleaseJournal {
  readonly recorded: TerminalReleaseIntent[] = [];
  loadUnconfirmed(): TerminalReleaseIntent[] {
    return [];
  }
  record(intent: TerminalReleaseIntent): void {
    this.recorded.push(intent);
  }
  resolve(): void {}
}

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

  test.each(["sweep", "lookup"] as const)(
    "an idle %s release is journaled, fenced and refused with acquire_new_session",
    async (path) => {
      timer.setCurrentTime(manager.getAllSessions()[0]!.expiresAt + 1);
      if (path === "sweep") {
        manager.cleanupExpiredSessions();
      } else {
        expect(manager.getSession(SESSION)).toBeNull();
      }
      await manager.waitForSessionRelease(SESSION);
      const reason = path === "sweep" ? "cleanup-expired" : "lazy-expiry";

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
