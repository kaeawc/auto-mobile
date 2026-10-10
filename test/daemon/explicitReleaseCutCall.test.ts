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

  /** Releases `sessionId` through the socket method; `onFree` runs when the pool frees the device. */
  function explicitRelease(sessionId: string, onFree: () => void = () => {}, signal?: AbortSignal) {
    const state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => ({
        releaseDevice: async () => {
          onFree();
        },
      }),
    } as unknown as Parameters<typeof handleDaemonRequest>[1];
    return handleDaemonRequest(
      {
        id: "r1",
        type: "daemon_request",
        method: "daemon/releaseSession",
        params: { sessionId, requireKnown: true },
      },
      state,
      tracker,
      signal,
      { socketSessionId: REQUESTER },
    );
  }

  const REQUESTER = "requester-connection";

  // An implicit call reaches the session through autolock, so it is indexed by the autolock map,
  // not under the session UUID. The release must cut it too: left running, it would keep driving
  // a device the release has already freed (the #11400 item 2 class, on the explicit path).
  test.each(["resolved", "unresolved"])(
    "an implicit (%s autolock) control call is cut with the terminal refusal before the device is freed",
    async (binding) => {
      tracker.setAutolockSessionResolver({ autolockSessionForMcpSession: () => SESSION });
      const execution =
        binding === "resolved"
          ? tracker.startExecution("tapOn", "conn-1")
          : tracker.startExecution("tapOn", "conn-1", undefined, undefined, "conn-1");
      if (binding === "resolved") {
        tracker.setResolvedAutolockSessionUuid(execution.id, SESSION);
      }
      const abortedWhenFreed: boolean[] = [];

      const reply = await explicitRelease(SESSION, () =>
        abortedWhenFreed.push(execution.abortController.signal.aborted),
      );

      expect(reply.success).toBe(true);
      expect(abortedWhenFreed).toEqual([true]);
      expect(sessionReleasedDuringCallPayload(execution.cancelReason)).toMatchObject({
        error: {
          code: "session_ownership_lost",
          sessionUuid: SESSION,
          reason: "explicit-release",
          retryable: false,
          nextAction: "acquire_new_session",
        },
      });
    },
  );

  test("the requester and its calls on other sessions are not cut", async () => {
    const OTHER = "00000000-0000-4000-8000-000000000043";
    await manager.createSession(OTHER, "emulator-5556", "android");
    const request = new AbortController();
    const requesterCallElsewhere = tracker.startExecution("tapOn", REQUESTER, OTHER);
    const requesterSessionlessCall = tracker.startExecution("listDevices", REQUESTER);

    const reply = await explicitRelease(SESSION, undefined, request.signal);

    expect(reply).toMatchObject({ success: true, result: { device: DEVICE } });
    expect(request.signal.aborted).toBe(false);
    expect(requesterCallElsewhere.abortController.signal.aborted).toBe(false);
    expect(requesterSessionlessCall.abortController.signal.aborted).toBe(false);
    expect(manager.hasSession(OTHER)).toBe(true);
  });

  test("releasing a derived label session cuts the base call on its device with a plain cancellation, and no other base call", async () => {
    const DERIVED = `${SESSION}:B`;
    const DERIVED_DEVICE = "emulator-5556";
    await manager.createSession(DERIVED, DERIVED_DEVICE, "android");
    manager.setDeviceLabels(SESSION, { A: SESSION, B: DERIVED });
    const baseOnOwnDevice = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.bindDeviceExecution(baseOnOwnDevice.id, DEVICE);
    const baseOnDerivedDevice = tracker.startExecution("tapOn", undefined, SESSION);
    tracker.bindDeviceExecution(baseOnDerivedDevice.id, DERIVED_DEVICE);
    const derivedCall = tracker.startExecution("tapOn", undefined, DERIVED);

    const reply = await explicitRelease(DERIVED);

    expect(reply).toMatchObject({ success: true, result: { device: DERIVED_DEVICE } });
    expect(baseOnOwnDevice.abortController.signal.aborted).toBe(false);
    expect(baseOnDerivedDevice.abortController.signal.aborted).toBe(true);
    expect(sessionReleasedDuringCallPayload(baseOnDerivedDevice.cancelReason)).toBeUndefined();
    expect(sessionReleasedDuringCallPayload(derivedCall.cancelReason)).toMatchObject({
      error: { code: "session_ownership_lost", sessionUuid: DERIVED, reason: "explicit-release" },
    });
    expect(manager.hasSession(SESSION)).toBe(true);
  });
});
