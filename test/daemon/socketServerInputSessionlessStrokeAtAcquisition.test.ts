import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
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
 * Holder-change matrix, cell "a session acquires the device × an open sessionless stroke" (#11541).
 *
 * A sessionless `input/gestureStart` is admitted on a device no session holds, and the runner
 * parks the stroke with no ceiling. When a session then acquires the device, the daemon stops
 * everything else sessionless work left on it (#10829 in-flight calls, #10961 recordings, #11130
 * network state). The frames of a gesture are separate control calls, so with no frame in flight
 * `cancelSessionlessDeviceUse` finds nothing to cancel: the acquisition hook lifts the stroke
 * itself, and a start still awaiting its ack when the session arrives is lifted on the ack.
 *
 * Same harness as `socketServerInputStrokeAfterSessionRelease.test.ts`. The acquisition hook is
 * wired as `daemon.ts` wires it (`setDeviceAcquisitionExecutionCanceller`), and the release hook
 * as `socketServer.start()` wires it.
 */

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  liftStrokesHeldBy(releasedSessionId: string): Promise<void>;
  liftSessionlessStrokesOn(deviceId: string): void;
}

const NEW_OWNER = "new-owner-session";
const DEVICE = androidDevice.deviceId;
const IDLE_MS = 60_000;

describe("an open sessionless input stroke vs. a session acquiring its device", () => {
  let sessionManager: SessionManager;
  let socket: FakeSocket;
  let internals: Internals;
  /** Device-side gesture frames, in the order the fake device received them. */
  let strokes: string[];
  let acquisitions: string[];
  /** When set, the fake device holds the start's ack until it resolves. */
  let startAck: PromiseWithResolvers<{ success: boolean }> | undefined;
  let unsubscribeActivity: () => void;
  const pool = { isSessionRecoveryInFlight: () => false, sessionExecutionsEnded: () => {} };

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function sendSessionlessGesture(
    kind: "Start" | "Move",
  ): Promise<DaemonResponse | undefined> {
    const id = `gesture-${kind}`;
    socket.send({
      id,
      type: "mcp_request",
      method: `input/gesture${kind}`,
      params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, gestureId: "drag-1" },
    });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === id);
  }

  beforeEach(() => {
    strokes = [];
    acquisitions = [];
    startAck = undefined;
    sessionManager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    // daemon.ts: a session acquiring a device cancels the sessionless calls admitted on it and
    // lifts the sessionless strokes parked on it.
    sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId, sessionId) => {
      acquisitions.push(`${sessionId}@${deviceId}`);
      executionTracker.cancelSessionlessDeviceUse(deviceId);
      internals.liftSessionlessStrokesOn(deviceId);
    });
    unsubscribeActivity = subscribeToolCallEndActivity(executionTracker, sessionManager, pool);

    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const stroke =
      (kind: string) => async (_id: string, _x: number, _y: number, last?: unknown) => {
        strokes.push(kind === "end" && last === true ? "cancel" : kind);
        return { success: true };
      };
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestGestureStart: async () => {
            strokes.push("start");
            return startAck ? await startAck.promise : { success: true };
          },
          requestGestureMove: stroke("move"),
          requestGestureEnd: stroke("end"),
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
    // socketServer.start(): the session-release subscription that lifts a released holder's strokes.
    sessionManager.onSessionRelease((sessionId) => void internals.liftStrokesHeldBy(sessionId));
  });

  afterEach(async () => {
    socket.destroy();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    unsubscribeActivity();
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    sessionManager.stopCleanupTimer();
  });

  test("the stroke is lifted when a session acquires the device", async () => {
    // The pane puts a finger down on a device no session holds.
    expect(await sendSessionlessGesture("Start")).toMatchObject({ success: true });
    expect(strokes).toEqual(["start"]);

    await sessionManager.createSession(NEW_OWNER, DEVICE, "android", IDLE_MS);
    await settle();

    // The acquisition was announced and the device has its new holder.
    expect(acquisitions).toEqual([`${NEW_OWNER}@${DEVICE}`]);
    expect(sessionManager.getSessionForDevice(DEVICE)).toBe(NEW_OWNER);
    // The pane is still connected and its mouse is held still: no further frame arrives. The new
    // owner's device must not keep the sessionless pointer down.
    expect(socket.destroyed).toBe(false);
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("the lifted stroke is cancelled once: a refused frame and the socket close lift nothing more", async () => {
    expect(await sendSessionlessGesture("Start")).toMatchObject({ success: true });
    await sessionManager.createSession(NEW_OWNER, DEVICE, "android", IDLE_MS);
    await settle();

    expect(await sendSessionlessGesture("Move")).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
    });
    socket.destroy();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a stroke on another device, and one a session holds, are left alone", async () => {
    expect(await sendSessionlessGesture("Start")).toMatchObject({ success: true });

    internals.liftSessionlessStrokesOn("some-other-device");
    await settle();
    expect(strokes).toEqual(["start"]);

    // The new owner's own stroke is not sessionless work: a later acquisition signal leaves it.
    await sessionManager.createSession(NEW_OWNER, DEVICE, "android", IDLE_MS);
    await settle();
    socket.send({
      id: "owner-start",
      type: "mcp_request",
      method: "input/gestureStart",
      params: {
        platform: "android",
        deviceId: DEVICE,
        x: 1,
        y: 2,
        sessionUuid: NEW_OWNER,
        gestureId: "owner-drag",
      },
    });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    expect(socket.responses.find((frame) => frame.id === "owner-start")).toMatchObject({
      success: true,
    });
    internals.liftSessionlessStrokesOn(DEVICE);
    await settle();
    expect(strokes).toEqual(["start", "cancel", "start"]);
  });

  test("a sessionless start still awaiting its ack when the session arrives is lifted on the ack, once", async () => {
    startAck = Promise.withResolvers<{ success: boolean }>();
    socket.send({
      id: "gesture-Start",
      type: "mcp_request",
      method: "input/gestureStart",
      params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, gestureId: "drag-1" },
    });
    await settle();
    expect(strokes).toEqual(["start"]);

    // The acquisition finds no recorded stroke: the pointer is down, the ack is not in yet.
    await sessionManager.createSession(NEW_OWNER, DEVICE, "android", IDLE_MS);
    await settle();
    expect(strokes).toEqual(["start"]);

    startAck.resolve({ success: true });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);

    expect(strokes).toEqual(["start", "cancel"]);
    expect(socket.responses.find((frame) => frame.id === "gesture-Start")).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
    });
    socket.destroy();
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);
    expect(strokes).toEqual(["start", "cancel"]);
  });

  test("a sessionless start the runner refused opened nothing, so the acquisition cancels nothing", async () => {
    startAck = Promise.withResolvers<{ success: boolean }>();
    socket.send({
      id: "gesture-Start",
      type: "mcp_request",
      method: "input/gestureStart",
      params: { platform: "android", deviceId: DEVICE, x: 1, y: 2, gestureId: "drag-1" },
    });
    await settle();
    await sessionManager.createSession(NEW_OWNER, DEVICE, "android", IDLE_MS);
    await settle();

    startAck.resolve({ success: false });
    await settle();
    await Promise.all([...internals.activeRequestHandlers]);

    expect(strokes).toEqual(["start"]);
  });
});
