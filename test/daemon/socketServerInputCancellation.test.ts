import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";
import { androidDevice, createFakeDeviceManager } from "./helpers/inputSocketHarness";

/**
 * `input/*` frames get the owner fence a forwarded MCP call has (#10006): a frame whose socket
 * closed or whose client cancelled it is not dispatched, and its budget runs from receipt.
 * No listener, device, adb or daemon is touched: sockets are in-memory fakes and the CtrlProxy
 * client is a recorder.
 */

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) {
      throw Object.assign(new Error("peer closed"), { code: "EPIPE" });
    }
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close", false);
    return this;
  }
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

interface TapCall {
  x: number;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  release: (result: { success: boolean; error?: string }) => void;
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  dispatchFencedInput<T>(
    gesture: "Tap" | "Swipe",
    signal: AbortSignal | undefined,
    send: (onDispatch: () => void) => Promise<T>,
  ): Promise<T>;
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
let internals: Internals;
let taps: TapCall[];
let allSockets: FakeSocket[];

beforeEach(() => {
  timer = new FakeTimer();
  taps = [];
  allSockets = [];
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
    () =>
      ({
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: (
          x: number,
          _y: number,
          _duration?: number,
          timeoutMs?: number,
          _perf?: unknown,
          _frameContext?: string,
          _onDispatch?: () => void,
          signal?: AbortSignal,
        ) =>
          new Promise<{ success: boolean; error?: string }>((resolve) => {
            taps.push({ x, timeoutMs, signal, release: resolve });
          }),
      }) as unknown as AndroidCtrlProxyClient,
  );
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    { isInitialized: () => false } as DaemonStateAccess,
    timer,
  );
  internals = server as unknown as Internals;
  internals.acceptingRequests = true;
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
  internals.handleConnection(socket as unknown as Socket);
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
  await Promise.all([...internals.activeRequestHandlers]);
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
    internals.dispatchFencedInput("Tap", controller.signal, async (onDispatch) => {
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
    internals.dispatchFencedInput("Swipe", controller.signal, async () => {
      controller.abort();
      throw cancelled;
    }),
  ).rejects.toBe(cancelled);
});

test("a dispatched swipe that fails without an abort keeps its own error", async () => {
  const failure = new ActionableError("device offline");
  await expect(
    internals.dispatchFencedInput("Swipe", new AbortController().signal, async (onDispatch) => {
      onDispatch();
      throw failure;
    }),
  ).rejects.toBe(failure);
});

test("auto-advancing time does not expire a tap whose key holder finishes in time", async () => {
  timer.enableAutoAdvance();
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
    () =>
      ({
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: async () => {
          calls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => timer.setTimeout(resolve, 40));
          inFlight -= 1;
          return { success: true };
        },
      }) as unknown as AndroidCtrlProxyClient,
  );
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
