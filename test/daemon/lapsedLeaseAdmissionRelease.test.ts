import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionSuspectError, TerminalSessionError } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import { executionTracker, type ActiveExecution } from "../../src/server/executionTracker";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

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

  // An implicit call is already tracked under its autolock session (provisional/resolved
  // autolock), so the lapsed-lease check must not count the caller itself as "a control call in
  // flight": that answered the retryable suspect refusal ("retry this call now") for a session
  // whose owner is gone and whose lease can no longer be restored.
  test("an implicit (autolock) call naming itself as the caller is refused terminally, not as suspect", async () => {
    lapseOwnerLease();
    const call = track(executionTracker.startExecution("tapOn", "mcp-connection-1"));
    executionTracker.setResolvedAutolockSessionUuid(call.id, SESSION);

    const refusal = await daemon
      .getSessionManager()
      .getOrCreateSession(SESSION, undefined, undefined, undefined, false, {
        callerExecutionId: call.id,
      })
      .catch((error: unknown) => error);

    expect(refusal).not.toBeInstanceOf(SessionSuspectError);
    expect(refusal).toBeInstanceOf(TerminalSessionError);
  });

  test("another control call still in flight keeps the refusal retryable", async () => {
    lapseOwnerLease();
    const earlier = track(executionTracker.startExecution("swipeOn", "mcp-connection-1"));
    executionTracker.setResolvedAutolockSessionUuid(earlier.id, SESSION);
    const call = track(executionTracker.startExecution("tapOn", "mcp-connection-1"));
    executionTracker.setResolvedAutolockSessionUuid(call.id, SESSION);

    const refusal = await daemon
      .getSessionManager()
      .getOrCreateSession(SESSION, undefined, undefined, undefined, false, {
        callerExecutionId: call.id,
      })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SessionSuspectError);
    expect(daemon.getSessionManager().hasSession(SESSION)).toBe(true);
  });
});

// The autolock reuse paths (`DeviceAutolockManager.reuseOwnedAutolockSession`,
// `DevicePool.reuseExistingDeviceSession`) refresh the holder on behalf of a call that is already
// tracked under it. Both must name that call, or it is refused as suspect (#11400 item 3).
describe("an implicit call reusing its holder on a lapsed owner lease (#11400)", () => {
  const DEVICE: BootedDevice = {
    name: "Pixel_8_API_35",
    deviceId: DEVICE_ID,
    platform: "android",
  };
  const MCP_CONNECTION = "hunt-lapsed-lease-mcp-connection";
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
    daemon.getSessionManager().stopCleanupTimer();
    started = [];
    const devicePool = daemon.getDevicePool();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [DEVICE];
    Object.assign(devicePool, { deviceManager });
    await devicePool.initializeWithDevices([DEVICE]);
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

  /** The owner heartbeated once and went silent past lease plus grace; the scan has not run. */
  async function lapseOwnerLease(sessionId: string): Promise<void> {
    const sessionManager = daemon.getSessionManager();
    expect(await sessionManager.claimLivenessOwnership(sessionId, OWNER_TOKEN)).toBe("claimed");
    sessionManager.recordHeartbeat(sessionId);
    timer.advanceTime(DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS + 1);
    expect(sessionManager.getSessionLeaseState(sessionId)?.phase).toBe("lapsed");
  }

  /** Run `reuse` as an implicit control call already tracked under `sessionId`. */
  async function refusalOfImplicitCall(
    sessionId: string,
    reuse: () => Promise<unknown>,
  ): Promise<unknown> {
    const call = executionTracker.startExecution("tapOn", MCP_CONNECTION);
    started.push(call);
    executionTracker.setResolvedAutolockSessionUuid(call.id, sessionId);
    return runWithToolSelectionContext(
      { execution: { executionId: call.id, startTime: call.startTime } },
      () => reuse().catch((error: unknown) => error),
    );
  }

  test("warm autolock reuse is refused terminally, not as suspect", async () => {
    const devicePool = daemon.getDevicePool();
    const autolock = () =>
      devicePool.autolockDevice(
        DEVICE_ID,
        "android",
        MCP_CONNECTION,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { autolockEnabled: true },
      );
    const sessionId = await autolock();
    expect(sessionId).toBeDefined();
    await lapseOwnerLease(sessionId!);

    const refusal = await refusalOfImplicitCall(sessionId!, autolock);

    expect(refusal).not.toBeInstanceOf(SessionSuspectError);
    expect(refusal).toBeInstanceOf(TerminalSessionError);
  });

  test("an explicit bind reusing the holder is refused terminally, not as suspect", async () => {
    const devicePool = daemon.getDevicePool();
    const bind = () =>
      devicePool.bindOrReuseDeviceSession(
        SESSION,
        DEVICE_ID,
        "android",
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        MCP_CONNECTION,
      );
    await bind();
    await lapseOwnerLease(SESSION);

    const refusal = await refusalOfImplicitCall(SESSION, bind);

    expect(refusal).not.toBeInstanceOf(SessionSuspectError);
    expect(refusal).toBeInstanceOf(TerminalSessionError);
  });
});
