import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { UNSETTLED_EXECUTION_VETO_CEILING_MS } from "../../src/daemon/unsettledExecutionVeto";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { sessionReleasedDuringCallPayload } from "../../src/server/deviceSessionResult";
import { executionTracker } from "../../src/server/executionTracker";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// #10820: the daemon installs the execution tracker as the session manager's expiry-release
// canceller, so an idle-expiry release that overrides a never-settling call aborts it.

describe("Daemon expiry-release cancel wiring", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("an idle sweep past the veto ceiling aborts the session's hung call", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(await createTestDatabase(), timer),
    );
    const sessionManager = daemon.getSessionManager();
    const sessionId = "expiry-cancel-wiring";
    const session = await sessionManager.createSession(sessionId, "emulator-5554", "android");
    const hung = executionTracker.startExecution("rotate", undefined, sessionId);
    const bystander = executionTracker.startExecution("rotate", undefined, "other-session");
    try {
      timer.setCurrentTime(session.expiresAt + UNSETTLED_EXECUTION_VETO_CEILING_MS - 1);
      sessionManager.cleanupExpiredSessions();
      expect(hung.abortController.signal.aborted).toBe(false);
      expect(sessionManager.hasSession(sessionId)).toBe(true);

      timer.setCurrentTime(session.expiresAt + UNSETTLED_EXECUTION_VETO_CEILING_MS);
      sessionManager.cleanupExpiredSessions();
      expect(hung.abortController.signal.aborted).toBe(true);
      expect(bystander.abortController.signal.aborted).toBe(false);
      // #11381: the real wiring aborts it with the typed release, so the MCP server answers the
      // terminal refusal rather than a generic abort.
      expect(sessionReleasedDuringCallPayload(hung.cancelReason)).toMatchObject({
        error: {
          code: "session_ownership_lost",
          sessionUuid: sessionId,
          reason: "cleanup-expired",
          retryable: false,
          nextAction: "acquire_new_session",
        },
      });
    } finally {
      executionTracker.endExecution(hung.id);
      executionTracker.endExecution(bystander.id);
      sessionManager.stopCleanupTimer();
    }
  });
});
