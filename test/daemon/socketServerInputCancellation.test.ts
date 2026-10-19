import type { TapCoordinatesRequest } from "../../src/features/observe/shared/SharedGestureDelegate";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import type { A11yTapCoordinatesResult } from "../../src/features/observe/android/types";
import { spyOnAndroidClientInstance } from "../helpers/androidCtrlProxyClientSpies";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
} from "./helpers/inputSocketHarness";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { executionTracker } from "../../src/daemon/executionTracker";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { FakeSocket } from "../fakes/FakeNetServer";

/**
 * `input/*` frames get the owner fence a forwarded MCP call has (#10006): a frame whose socket
 * closed or whose client cancelled it is not dispatched, and its budget runs from receipt.
 * No listener, device, adb or daemon is touched: sockets are in-memory fakes and the CtrlProxy
 * client is a recorder.
 */

interface TapCall {
  x: number;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  release: (result: { success: boolean; error?: string }) => void;
}

type DaemonStateArg = ConstructorParameters<typeof UnixSocketServer>[1];

const unexpectedDaemonState = (): never => {
  throw new Error("Unexpected daemon state access");
};

/** A daemon that never finished initialising: only input admission is exercised. */
const uninitializedDaemonState: DaemonStateArg = {
  isInitialized: () => false,
  getSessionManager: unexpectedDaemonState,
  getDevicePool: unexpectedDaemonState,
  getDeviceSessionRegistry: unexpectedDaemonState,
};

/** The real server with the fenced-dispatch step exposed for direct calls. */
class FencedInputServer extends UnixSocketServerHarness {
  dispatchFenced<T>(
    gesture: "Tap" | "Swipe",
    signal: AbortSignal | undefined,
    timeoutMs: number,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
  ): Promise<T> {
    return this.dispatchFencedInput(gesture, signal, timeoutMs, send);
  }
}

function createServer(state: DaemonStateArg): FencedInputServer {
  return new FencedInputServer(
    "unused",
    state,
    timer,
    null,
    { mcpDispatcher: unreachableMcpDispatcher },
    undefined,
    { bindLock: fakeBindLock },
  );
}

const tapFrame = (id: string, x: number): DaemonRequest => ({
  id,
  type: "mcp_request",
  method: "input/tap",
  params: { platform: "android", deviceId: androidDevice.deviceId, x, y: 20 },
});

const cancelFrame = (id: string, targetId: string): DaemonRequest => ({
  id,
  type: "daemon_request",
  method: "daemon/cancelRequest",
  params: { requestId: targetId },
});

let timer: FakeTimer;
let internals: FencedInputServer;
let taps: TapCall[];
let allSockets: FakeSocket[];

beforeEach(() => {
  timer = new FakeTimer();
  taps = [];
  allSockets = [];
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  spyOnAndroidClientInstance(androidDevice, {
    getScreenScaleMetadata: () => null,
    requestTapCoordinates: ({ x, timeoutMs, signal }: TapCoordinatesRequest) =>
      new Promise<A11yTapCoordinatesResult>((resolve) => {
        taps.push({
          x,
          timeoutMs,
          signal,
          release: (result) => resolve({ totalTimeMs: 0, ...result }),
        });
      }),
  });
  internals = createServer(uninitializedDaemonState);
  internals.allowRequests();
});

afterEach(() => {
  spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
  PlatformDeviceManagerFactory.reset();
  for (const socket of allSockets) {
    if (!socket.destroyed) {
      socket.destroy();
    }
  }
});

function connect(): FakeSocket {
  const socket = new FakeSocket();
  allSockets.push(socket);
  internals.connect(socket);
  return socket;
}

/** Let every queued microtask and `setImmediate` continuation settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function drain(): Promise<void> {
  await settle();
  await Promise.all([...internals.state.activeRequestHandlers]);
}

/** Start `holder` on its own socket and wait until it owns the device key mid-dispatch. */
async function holdDeviceKey(holderId = "holder"): Promise<FakeSocket> {
  const socket = connect();
  socket.send(tapFrame(holderId, 1));
  await settle();
  expect(taps).toHaveLength(1);
  return socket;
}

test("a queued input/tap whose socket closed is never dispatched", async () => {
  await holdDeviceKey();
  const waiter = connect();
  waiter.send(tapFrame("waiter", 2));
  await settle();
  expect(taps).toHaveLength(1);

  waiter.destroy();
  taps[0].release({ success: true });
  await drain();

  expect(taps.map((tap) => tap.x)).toEqual([1]);
  expect(waiter.responses).toEqual([]);
});

test("a queued input/tap cancelled by daemon/cancelRequest is never dispatched", async () => {
  await holdDeviceKey();
  const waiter = connect();
  waiter.send(tapFrame("waiter", 2));
  await settle();
  waiter.send(cancelFrame("cancel", "waiter"));
  await settle();

  taps[0].release({ success: true });
  await drain();

  expect(taps.map((tap) => tap.x)).toEqual([1]);
  expect(waiter.responses.find((frame) => frame.id === "waiter")).toMatchObject({
    success: false,
    error: expect.stringContaining("cancelled by its client"),
  });
});

test("frames still in the socket queue when the socket closes are not dispatched", async () => {
  const socket = await holdDeviceKey();
  // Same socket, same device lane: these wait in the socket admission queue behind the holder.
  socket.send(tapFrame("queued-a", 2));
  socket.send(tapFrame("queued-b", 3));
  await settle();
  expect(taps).toHaveLength(1);

  socket.destroy();
  taps[0].release({ success: true });
  await drain();

  expect(taps.map((tap) => tap.x)).toEqual([1]);
});

test("an input/tap that is still live is dispatched with its owner signal", async () => {
  await holdDeviceKey();
  const waiter = connect();
  waiter.send(tapFrame("waiter", 2));
  await settle();

  taps[0].release({ success: true });
  await settle();

  expect(taps.map((tap) => tap.x)).toEqual([1, 2]);
  expect(taps[1].signal?.aborted).toBe(false);
  taps[1].release({ success: true });
  await drain();
  expect(waiter.responses).toEqual([expect.objectContaining({ id: "waiter", success: true })]);
});

test("the owner signal reaches the device call so a later disconnect aborts the in-flight send", async () => {
  const holder = await holdDeviceKey();
  expect(taps[0].signal?.aborted).toBe(false);
  holder.destroy();
  expect(taps[0].signal?.aborted).toBe(true);
  taps[0].release({ success: true });
  await drain();
});

test("the budget runs from receipt: queue wait on the same socket is charged to the tap", async () => {
  const socket = await holdDeviceKey();
  socket.send(tapFrame("behind-barrier", 2));
  await settle();

  timer.advanceTime(25_000);
  taps[0].release({ success: true });
  await settle();

  expect(taps).toHaveLength(2);
  // 30s default input budget minus 25s spent queued; the old handler-relative clock passed 30000.
  expect(taps[1].timeoutMs).toBe(5_000);
  taps[1].release({ success: true });
  await drain();
});

test("an input/tap waiting on the device key past its budget is refused instead of dispatched", async () => {
  await holdDeviceKey();
  const waiter = connect();
  waiter.send(tapFrame("waiter", 2));
  await settle();

  timer.advanceTime(30_001);
  await settle();

  expect(waiter.responses).toEqual([
    expect.objectContaining({
      id: "waiter",
      success: false,
      error: expect.stringContaining("waiting in queue for device:emulator-5554"),
    }),
  ]);
  taps[0].release({ success: true });
  await drain();
  expect(taps.map((tap) => tap.x)).toEqual([1]);
});

test("an abort after the frame was written is reported as an indeterminate tap", async () => {
  const controller = new AbortController();
  await expect(
    internals.dispatchFenced("Tap", controller.signal, 1000, async (_fenced, onDispatch) => {
      onDispatch();
      controller.abort();
      throw new Error("Daemon MCP client disconnected");
    }),
  ).rejects.toThrow("Tap outcome is indeterminate");
});

test("an abort before the frame was written keeps the original cancellation", async () => {
  const controller = new AbortController();
  const cancelled = new Error("Daemon MCP client disconnected");
  await expect(
    internals.dispatchFenced("Swipe", controller.signal, 1000, async () => {
      controller.abort(cancelled);
      throw cancelled;
    }),
  ).rejects.toBe(cancelled);
});

test("a dispatched swipe that fails without an abort keeps its own error", async () => {
  const failure = new ActionableError("device offline");
  await expect(
    internals.dispatchFenced(
      "Swipe",
      new AbortController().signal,
      1000,
      async (_fenced, onDispatch) => {
        onDispatch();
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});

test("auto-advancing time does not expire a tap whose key holder finishes in time", async () => {
  timer.enableAutoAdvance();
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  spyOnAndroidClientInstance(androidDevice, {
    getScreenScaleMetadata: () => null,
    requestTapCoordinates: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => timer.setTimeout(resolve, 40));
      inFlight -= 1;
      return { success: true, totalTimeMs: 0 };
    },
  });
  const first = connect();
  const second = connect();
  first.send(tapFrame("first", 1));
  second.send(tapFrame("second", 2));
  await drain();

  expect(first.responses).toEqual([expect.objectContaining({ id: "first", success: true })]);
  expect(second.responses).toEqual([expect.objectContaining({ id: "second", success: true })]);
  expect(calls).toBe(2);
  expect(maxInFlight).toBe(1);
});

// #10829: a sessionless input on a free device passed the owner check, then parked on the device
// key. A session acquiring the device meanwhile did not stop it, so it was sent to the new holder.
test("a parked sessionless input/tap is not sent once another session acquires the device", async () => {
  const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessionManager.stopCleanupTimer();
  // Production wiring (daemon.ts).
  sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
    executionTracker.cancelSessionlessDeviceUse(deviceId);
  });
  internals = createServer({
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
    getDevicePool: createFakeDaemonState().getDevicePool,
    getDeviceSessionRegistry: unexpectedDaemonState,
  });
  internals.allowRequests();

  await holdDeviceKey();
  const waiter = connect();
  waiter.send(tapFrame("waiter", 2));
  await settle();
  expect(taps).toHaveLength(1);

  await sessionManager.createSession("late-holder", androidDevice.deviceId, "android");
  taps[0].release({ success: true });
  await drain();

  expect(taps.map((tap) => tap.x)).toEqual([1]);
  expect(waiter.responses.find((frame) => frame.id === "waiter")).toMatchObject({
    success: false,
    error: expect.stringContaining("acquired it while this call was in flight"),
    code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  });
  sessionManager.stopCleanupTimer();
});
