import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../../src/daemon/daemon";
import { DaemonState } from "../../../src/daemon/daemonState";
import { SessionSuspectError, TerminalSessionError } from "../../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../../src/daemon/sessionLivenessWindows";
import { resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { sessionReleasedDuringCallPayload } from "../../../src/server/deviceSessionResult";
import { executionTracker, type ActiveExecution } from "../../../src/server/executionTracker";
import { FakeDeviceSessionRepository } from "../../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt 2026-10-10, around #11285 (`refuseControlCallOnLapsedOwnerLease`). Between the end of the
// suspect grace and the monitor's next scan, a control call must be refused terminally and the
// session released "exactly as the scan would release it".

const SESSION = "hunt-lapsed-lease-session";
const DEVICE_ID = "emulator-5554";
const OWNER_TOKEN = "hunt-owner-token";

describe("a control call on a lapsed owner lease before the monitor's scan (#11285)", () => {
  let timer: FakeTimer;
  let daemon: Daemon;
  let started: ActiveExecution[];

  beforeEach(async () => {
    resetDbWriteBarrier();
    timer = new FakeTimer();
    daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const sessionManager = daemon.getSessionManager();
    sessionManager.stopCleanupTimer();
    started = [];
    await sessionManager.createSession(SESSION, DEVICE_ID, "android");
    expect(await sessionManager.claimLivenessOwnership(SESSION, OWNER_TOKEN)).toBe("claimed");
    sessionManager.recordHeartbeat(SESSION);
  });

  afterEach(() => {
    for (const execution of started) {
      executionTracker.endExecution(execution.id);
    }
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
    resetDbWriteBarrier();
  });

  const track = (execution: ActiveExecution): ActiveExecution => {
    started.push(execution);
    return execution;
  };

  function lapseOwnerLease(): void {
    timer.advanceTime(DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS + 1);
    expect(daemon.getSessionManager().getSessionLeaseState(SESSION)?.phase).toBe("lapsed");
  }

  test("control: a call naming its own execution is refused terminally", async () => {
    lapseOwnerLease();
    const call = track(executionTracker.startExecution("tapOn", undefined, SESSION));

    const refusal = await daemon
      .getSessionManager()
      .getOrCreateSession(SESSION, undefined, undefined, {
        executionId: call.id,
        startTime: call.startTime,
      })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(TerminalSessionError);
  });

  // The autolock reuse paths (`DeviceAutolockManager.reuseOwnedAutolockSession`,
  // `DevicePool.reuseExistingDeviceSession`) refresh the holder with `getOrCreateSession(id)`:
  // no execution metadata. The implicit call doing so is already tracked under the session
  // (provisional/resolved autolock), so the lapsed-lease check counts the caller itself as "a
  // control call in flight" and answers the retryable suspect refusal ("retry this call now")
  // for a session whose owner is gone and whose lease can no longer be restored.
  test("an implicit (autolock) call refreshing its holder is refused terminally, not as suspect", async () => {
    lapseOwnerLease();
    const call = track(executionTracker.startExecution("tapOn", "mcp-connection-1"));
    executionTracker.setResolvedAutolockSessionUuid(call.id, SESSION);

    const refusal = await daemon
      .getSessionManager()
      .getOrCreateSession(SESSION)
      .catch((error: unknown) => error);

    expect(refusal).not.toBeInstanceOf(SessionSuspectError);
    expect(refusal).toBeInstanceOf(TerminalSessionError);
  });

  // The scan cancels the read it cuts with the typed terminal refusal (#11322); the release this
  // admission performs in its place leaves the read running with no answer about the session.
  test("the release cuts an in-flight read with the terminal refusal, as the scan's release does", async () => {
    const read = track(executionTracker.startExecution("observe", undefined, SESSION));
    executionTracker.markDeviceReadCall(read.id, read.toolName);
    lapseOwnerLease();
    const call = track(executionTracker.startExecution("tapOn", undefined, SESSION));

    const refusal = await daemon
      .getSessionManager()
      .getOrCreateSession(SESSION, undefined, undefined, {
        executionId: call.id,
        startTime: call.startTime,
      })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(TerminalSessionError);
    expect(daemon.getSessionManager().hasSession(SESSION)).toBe(false);
    expect(read.abortController.signal.aborted).toBe(true);
    expect(sessionReleasedDuringCallPayload(read.cancelReason)).toMatchObject({
      error: { code: "session_ownership_lost", sessionUuid: SESSION, reason: "heartbeat-timeout" },
    });
  });
});
