import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { releasePlanSessionAndDevice } from "../../../src/daemon/releaseSessionAndDevice";
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
 * Release-cut matrix, cell "release that cuts × `input/gestureStart` in flight on the device".
 *
 * #11448 lifts a released holder's strokes at release time (`liftStrokesHeldBy`), but only the
 * strokes already recorded in the ownership registry. A stroke is recorded when its
 * `gestureStart` is ACKED. A release that cuts (explicit release, plan auto-release: neither
 * waits for a control call) can land while the start is on the device and not yet acked: the
 * release's lift finds nothing, the device is freed, and then the ack records the stroke under
 * the holder that has just been released. Streamed gesture frames carry no abort signal to the
 * runner, so the cut does not stop the start either. Nothing lifts the pointer until the pane's
 * socket closes or sends another frame: the device is free for the next owner with a finger down.
 *
 * Same harness as `socketServerInputStrokeAfterSessionRelease.test.ts`: real SessionManager,
 * socket server, release handler and execution tracker; only the device client is a fake.
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

    await ackStart();

    // The pane's socket is still connected and sends nothing more (the mouse is held still). The
    // pointer the cut start put down must have been lifted; it stays down on the free device.
    expect(socket.destroyed).toBe(false);
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
