import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { DaemonStateAccess } from "../../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import {
  hasActiveSessionExecution,
  subscribeToolCallEndActivity,
} from "../../../src/daemon/toolCallActivity";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { executionTracker } from "../../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "../helpers/inputSocketHarness";

/**
 * Holder-change matrix, cell "a session acquires the device × an open sessionless stroke".
 *
 * A sessionless `input/gestureStart` is admitted on a device no session holds, and the runner
 * parks the stroke with no ceiling. When a session then acquires the device, the daemon stops
 * everything else sessionless work left on it (#10829 in-flight calls, #10961 recordings, #11130
 * network state), and #11448 lifts a stroke when its holder is RELEASED, but nothing lifts a
 * sessionless stroke when the device gains a holder: the frames of a gesture are separate control
 * calls, so with no frame in flight `cancelSessionlessDeviceUse` finds nothing to cancel. The new
 * owner gets its device with a finger down until the pane sends another frame or disconnects.
 *
 * Same harness as `socketServerInputStrokeAfterSessionRelease.test.ts`. The acquisition hook is
 * wired as `daemon.ts` wires it (`setDeviceAcquisitionExecutionCanceller`), and the release hook
 * as `socketServer.start()` wires it.
 */

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  end(): this {
    return this.destroy();
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  liftStrokesHeldBy(releasedSessionId: string): Promise<void>;
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
    sessionManager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, sessionId, query),
    );
    // daemon.ts: a session acquiring a device cancels the sessionless calls admitted on it.
    sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId, sessionId) => {
      acquisitions.push(`${sessionId}@${deviceId}`);
      executionTracker.cancelSessionlessDeviceUse(deviceId);
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
          requestGestureStart: stroke("start"),
          requestGestureMove: stroke("move"),
          requestGestureEnd: stroke("end"),
        }) as unknown as AndroidCtrlProxyClient,
    );
    const fakePool = createFakeDaemonState().getDevicePool();
    const server = new UnixSocketServer(
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

  test("control: the pane's next frame is refused and only then lifts the stroke", async () => {
    expect(await sendSessionlessGesture("Start")).toMatchObject({ success: true });
    await sessionManager.createSession(NEW_OWNER, DEVICE, "android", IDLE_MS);
    await settle();

    expect(await sendSessionlessGesture("Move")).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
    });
    expect(strokes).toEqual(["start", "cancel"]);
  });
});
