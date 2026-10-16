import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { releasePlanSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import type { DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "./helpers/inputSocketHarness";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

/**
 * Release-cut matrix, cell "release that cuts × `input/gestureStart` in flight on the device"
 * (#11541).
 *
 * #11448 lifts a released holder's strokes at release time (`liftStrokesHeldBy`), but only the
 * strokes already recorded in the ownership registry, and a stroke is recorded when its
 * `gestureStart` is ACKED. A release that cuts (explicit release, plan auto-release: neither
 * waits for a control call) can land while the start is on the device and not yet acked: the
 * release's lift finds nothing and the device is freed. Streamed gesture frames carry no abort
 * signal to the runner, so the cut does not stop the start either. The ack therefore cancels the
 * stroke instead of recording it under a holder that has left, and answers the release.
 *
 * Same harness as `socketServerInputStrokeAfterSessionRelease.test.ts`: real SessionManager,
 * socket server, release handler and execution tracker; only the device client is a fake.
 */

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  liftStrokesHeldBy(releasedSessionId: string): Promise<void>;
  strokeAdmissionStillHolds(admission: {
    deviceId: string;
    holderSessionId?: string;
    holderIncarnation?: object;
  }): boolean;
}

const SESSION = "stroke-holder-session";
const DEVICE = androidDevice.deviceId;
const IDLE_MS = 60_000;

describe("a release that cuts an input/gestureStart still in flight on the device", () => {
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  /** Device-side gesture frames, in the order the fake device received them. */
  let strokes: string[];
  let startOnDevice: PromiseWithResolvers<void>;
  let startAck: PromiseWithResolvers<{ success: boolean }>;
  let unsubscribeActivity: () => void;
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Send the start and wait until the pointer is down on the (fake) device, ack pending. */
  async function putPointerDownWithAckPending(): Promise<void> {
    socket.send({
      id: "gesture-Start",
      type: "mcp_request",
      method: "input/gestureStart",
      params: {
        platform: "android",
        deviceId: DEVICE,
        x: 1,
        y: 2,
        sessionUuid: SESSION,
        gestureId: "drag-1",
      },
    });
    await startOnDevice.promise;
    expect(strokes).toEqual(["start"]);
    expect(executionTracker.hasActiveSessionUuidExecutions(SESSION)).toBe(true);
  }

  /** The runner acks the start; the frame's handler finishes. */
  async function ackStart(): Promise<DaemonResponse | undefined> {
    startAck.resolve({ success: true });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    await settle();
    return socket.responses.find((frame) => frame.id === "gesture-Start");
  }

  beforeEach(async () => {
    strokes = [];
    startOnDevice = Promise.withResolvers<void>();
    startAck = Promise.withResolvers<{ success: boolean }>();
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);

    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestGestureStart: () => {
            strokes.push("start");
            startOnDevice.resolve();
            return startAck.promise;
          },
          requestGestureMove: async () => {
            strokes.push("move");
            return { success: true };
          },
          requestGestureEnd: async (_id: string, _x: number, _y: number, cancel?: unknown) => {
            strokes.push(cancel === true ? "cancel" : "end");
            return { success: true };
          },
        }) as unknown as AndroidCtrlProxyClient,
    );
    const fakePool = createFakeDaemonState().getDevicePool();
    const server = createTestUnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDevicePool: () => fakePool,
      } as unknown as DaemonStateAccess,
      new FakeTimer(),
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);
    // The server's session-release subscription, which `start()` wires to the broadcaster.
    sessionManager.onSessionRelease((sessionId) => void internals.liftStrokesHeldBy(sessionId));
  });

  afterEach(async () => {
    startAck.resolve({ success: true });
    socket.destroy();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    unsubscribeActivity();
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
  });

  test("an explicit release during the start leaves no pointer down on the freed device", async () => {
    await putPointerDownWithAckPending();
    const freed: string[] = [];

    const reply = await handleDaemonRequest(
      {
        id: "release",
        type: "daemon_request",
        method: "daemon/releaseSession",
        params: { sessionId: SESSION, requireKnown: true },
      },
      {
        isInitialized: () => true,
        getSessionManager: () => sessionManager,
        getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
        getDevicePool: () => ({
          releaseDevice: async (deviceId: string) => {
            freed.push(deviceId);
          },
        }),
      } as unknown as DaemonStateAccess,
    );
    await settle();

    // The release is done: terminal, device back in the pool, nothing holds it.
    expect(reply).toMatchObject({ success: true, result: { device: DEVICE } });
    expect(freed).toEqual([DEVICE]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBeNull();
    expect(sessionManager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe(
      "explicit-release",
    );

    const answer = await ackStart();

    // The pane's socket is still connected and sends nothing more (the mouse is held still). The
    // pointer the cut start put down is lifted, and the frame answers the release that cut it.
    expect(socket.destroyed).toBe(false);
    expect(strokes).toEqual(["start", "cancel"]);
    expect(answer).toMatchObject({
      success: false,
      code: "session_ownership_lost",
      details: { reason: "explicit-release", sessionUuid: SESSION },
    });

    // Nothing was recorded, so the socket close has no stroke to cancel a second time.
    socket.destroy();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("the same session id holding the device again is a different holder than the one admitted", async () => {
    const admitted = sessionManager.getSession(SESSION)!;
    const admission = { deviceId: DEVICE, holderSessionId: SESSION, holderIncarnation: admitted };
    expect(internals.strokeAdmissionStillHolds(admission)).toBe(true);

    // A plan's auto-release leaves the UUID free for a later plan to be issued again by name.
    await sessionManager.releaseSession(SESSION, "plan-auto-release");
    expect(internals.strokeAdmissionStillHolds(admission)).toBe(false);

    // Same id, same device, a new incarnation: the admitted holder is still gone.
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);
    expect(sessionManager.getSession(SESSION)).not.toBe(admitted);
    expect(internals.strokeAdmissionStillHolds(admission)).toBe(false);
    expect(
      internals.strokeAdmissionStillHolds({
        ...admission,
        holderIncarnation: sessionManager.getSession(SESSION)!,
      }),
    ).toBe(true);
    // A start admitted with no holder does not survive a session holding the device.
    expect(internals.strokeAdmissionStillHolds({ deviceId: DEVICE })).toBe(false);
  });

  test("a plan re-issuing the released session id before the ack does not keep the old holder's stroke", async () => {
    await putPointerDownWithAckPending();
    await releasePlanSessionAndDevice(
      sessionManager,
      { releaseDevice: async () => {} },
      { sessionId: SESSION, deviceId: DEVICE },
    );
    await settle();
    await sessionManager.createSession(SESSION, DEVICE, "android", IDLE_MS);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(SESSION);

    await ackStart();

    expect(strokes).toEqual(["start", "cancel"]);
    // The new incarnation's release finds no stroke of the old one to lift again.
    await sessionManager.releaseSession(SESSION, "plan-auto-release");
    await settle();
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a start the runner refused opened nothing: the release cancels no stroke", async () => {
    await putPointerDownWithAckPending();
    await releasePlanSessionAndDevice(
      sessionManager,
      { releaseDevice: async () => {} },
      { sessionId: SESSION, deviceId: DEVICE },
    );
    await settle();

    startAck.resolve({ success: false });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);

    expect(strokes).toEqual(["start"]);
  });

  test("a start acked while its holder still holds the device is recorded and lifted by the release", async () => {
    await putPointerDownWithAckPending();
    expect(await ackStart()).toMatchObject({ success: true });
    expect(strokes).toEqual(["start"]);

    await releasePlanSessionAndDevice(
      sessionManager,
      { releaseDevice: async () => {} },
      { sessionId: SESSION, deviceId: DEVICE },
    );
    await settle();

    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a plan auto-release during the start leaves no pointer down on the freed device", async () => {
    await putPointerDownWithAckPending();
    const freed: string[] = [];

    await releasePlanSessionAndDevice(
      sessionManager,
      {
        releaseDevice: async (deviceId: string) => {
          freed.push(deviceId);
        },
      },
      { sessionId: SESSION, deviceId: DEVICE },
    );
    await settle();
    expect(freed).toEqual([DEVICE]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBeNull();

    await ackStart();

    expect(socket.destroyed).toBe(false);
    expect(strokes).toEqual(["start", "cancel"]);
  });
});
