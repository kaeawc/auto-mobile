import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { sessionReleasedDuringCallPayload } from "../../src/server/deviceSessionResult";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

// `--daemon release-session S` (daemon/releaseSession) while a control call is in flight on S.
// #11381/#11384 made every idle, heartbeat and owner-disconnect release cancel the calls it cuts
// with the typed SessionReleasedDuringCallError, so the cut caller gets `session_ownership_lost`
// with `nextAction: acquire_new_session`. The explicit release is also terminal
// (docs/using/device-ownership.md release-reason table) but still cancels with a bare string.

const SESSION = "00000000-0000-4000-8000-000000000042";
const DEVICE = "emulator-5554";

describe("explicit release of a session with a call in flight", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let tracker: ExecutionTracker;

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    tracker = new ExecutionTracker(timer, new FakeIdGenerator());
    await manager.createSession(SESSION, DEVICE, "android");
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the cut call is answered with the typed terminal session_ownership_lost refusal", async () => {
    const execution = tracker.startExecution("tapOn", undefined, SESSION);
    const state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => ({ releaseDevice: async () => {} }),
    } as unknown as Parameters<typeof handleDaemonRequest>[1];

    const reply = await handleDaemonRequest(
      {
        id: "r1",
        type: "daemon_request",
        method: "daemon/releaseSession",
        params: { sessionId: SESSION, requireKnown: true },
      },
      state,
      tracker,
    );

    expect(reply.success).toBe(true);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(sessionReleasedDuringCallPayload(execution.cancelReason)).toMatchObject({
      error: {
        code: "session_ownership_lost",
        sessionUuid: SESSION,
        retryable: false,
        nextAction: "acquire_new_session",
      },
    });
  });
});
