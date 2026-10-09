import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/constants";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";

/**
 * Interactions between the four daemon input/shutdown changes that were each tested alone:
 * #10007 (queued request refused at quiesce), #10005 (gesture-ownership registry), #10006
 * (owner abort fence on `input/*`) and #9958 (rebound-session refusal in
 * `runTrackedDeviceInput`). Sockets, the CtrlProxy client and the device manager are in-memory
 * fakes; nothing spawns and no daemon or database is touched.
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

type Ack = { success: boolean; error?: string };

interface Recorded {
  label: string;
  args: unknown[];
  release: (result: Ack) => void;
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  ownedGestures: { ownerCount: number };
  captureInputTargetOwner(device: BootedDevice): void;
  runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
    requester?: () => string | undefined,
  ): Promise<T>;
}

const tapFrame = (id: string): DaemonRequest => ({
  id,
  type: "mcp_request",
  method: "input/tap",
  params: { platform: "android", deviceId: androidDevice.deviceId, x: 1, y: 2 },
});

const gestureFrame = (id: string, method: string, gestureId: string): DaemonRequest => ({
  id,
  type: "mcp_request",
  method,
  params: { platform: "android", deviceId: androidDevice.deviceId, gestureId, x: 3, y: 4 },
});

const cancelFrame = (id: string, targetId: string): DaemonRequest => ({
  id,
  type: "daemon_request",
  method: "daemon/cancelRequest",
  params: { requestId: targetId },
});

const subscribeFrame: DaemonRequest = {
  id: "subscribe",
  type: "mcp_request",
  method: DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
};

let server: UnixSocketServer;
let internals: Internals;
let calls: Recorded[];
let sockets: FakeSocket[];

function pending(label: string): Recorded[] {
  return calls.filter((call) => call.label === label);
}

function installClient(): void {
  const record = (label: string) => {
    return (...args: unknown[]) =>
      new Promise<Ack>((resolve) => {
        calls.push({ label, args, release: resolve });
      });
  };
  spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
    () =>
      ({
        getScreenScaleMetadata: () => null,
        requestTapCoordinates: record("tap"),
        requestGestureStart: record("gestureStart"),
        requestGestureEnd: record("gestureEnd"),
      }) as unknown as AndroidCtrlProxyClient,
  );
}

beforeEach(() => {
  calls = [];
  sockets = [];
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  installClient();
  server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    { isInitialized: () => false } as DaemonStateAccess,
    new FakeTimer(),
  );
  internals = server as unknown as Internals;
  internals.acceptingRequests = true;
});

afterEach(() => {
  spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
  PlatformDeviceManagerFactory.reset();
  for (const socket of sockets) {
    socket.destroy();
  }
});

function connect(): FakeSocket {
  const socket = new FakeSocket();
  sockets.push(socket);
  internals.handleConnection(socket as unknown as Socket);
  return socket;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function drain(): Promise<void> {
  await settle();
  await Promise.all([...internals.activeRequestHandlers]);
}

/** A tap that owns the device key (mid-dispatch) until its recorded call is released. */
async function holdDeviceKey(): Promise<Recorded> {
  connect().send(tapFrame("holder"));
  await settle();
  expect(pending("tap")).toHaveLength(1);
  return pending("tap")[0];
}

describe("(a) input/gestureStart that leaves while waiting on the device key (#10006 x #10005)", () => {
  test("a start whose socket closed while parked is never dispatched and never recorded", async () => {
    const holder = await holdDeviceKey();
    const owner = connect();
    owner.send(gestureFrame("start", "input/gestureStart", "g1"));
    await settle();
    expect(pending("gestureStart")).toHaveLength(0);

    owner.destroy();
    holder.release({ success: true });
    await drain();

    expect(pending("gestureStart")).toHaveLength(0);
    expect(pending("gestureEnd")).toHaveLength(0);
    expect(internals.ownedGestures.ownerCount).toBe(0);
  });

  test("a start cancelled by daemon/cancelRequest while parked is never dispatched or recorded", async () => {
    const holder = await holdDeviceKey();
    const owner = connect();
    owner.send(gestureFrame("start", "input/gestureStart", "g1"));
    await settle();
    owner.send(cancelFrame("cancel", "start"));
    await settle();

    holder.release({ success: true });
    await drain();

    expect(pending("gestureStart")).toHaveLength(0);
    expect(pending("gestureEnd")).toHaveLength(0);
    expect(internals.ownedGestures.ownerCount).toBe(0);
    expect(owner.responses.find((frame) => frame.id === "start")).toMatchObject({
      success: false,
    });
  });

  test("a start dispatched before the disconnect and acked after it is cancelled exactly once", async () => {
    const owner = connect();
    owner.send(gestureFrame("start", "input/gestureStart", "g1"));
    await settle();
    expect(pending("gestureStart")).toHaveLength(1);

    owner.destroy();
    pending("gestureStart")[0].release({ success: true });
    await settle();

    // Registry saw the dead socket at ack time: one cancelling end, nothing recorded.
    expect(pending("gestureEnd")).toHaveLength(1);
    expect(pending("gestureEnd")[0].args).toEqual(["g1", 0, 0, true, 5000]);
    expect(internals.ownedGestures.ownerCount).toBe(0);
    pending("gestureEnd")[0].release({ success: true });
    await drain();
    expect(pending("gestureEnd")).toHaveLength(1);
  });

  test("a start acked while the socket is live is owned, then cancelled once by the close", async () => {
    const owner = connect();
    owner.send(gestureFrame("start", "input/gestureStart", "g1"));
    await settle();
    pending("gestureStart")[0].release({ success: true });
    await settle();
    expect(internals.ownedGestures.ownerCount).toBe(1);
    expect(pending("gestureEnd")).toHaveLength(0);

    owner.destroy();
    await settle();
    expect(pending("gestureEnd")).toHaveLength(1);
    pending("gestureEnd")[0].release({ success: true });
    await drain();
    expect(pending("gestureEnd")).toHaveLength(1);
    expect(internals.ownedGestures.ownerCount).toBe(0);
  });
});

describe("(b) a queued input/* request at quiesce (#10007 x #10006)", () => {
  test("is refused as not started, not failed as an abort, and never dispatched", async () => {
    const socket = connect();
    // Notification subscribers keep their socket through quiesce, as a bound proxy's does.
    socket.send(subscribeFrame);
    socket.send(tapFrame("holder"));
    await settle();
    expect(pending("tap")).toHaveLength(1);
    socket.send(tapFrame("queued"));
    await settle();
    expect(pending("tap")).toHaveLength(1);

    const quiesced = server.quiesce();
    pending("tap")[0].release({ success: true });
    await quiesced;
    await drain();

    expect(pending("tap")).toHaveLength(1);
    const refused = socket.responses.filter((frame) => frame.id === "queued");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      success: false,
      error: "Daemon is shutting down",
      daemonShuttingDown: { code: "daemon_shutting_down", retryable: true },
    });
    // Provably undispatched: the dispatch marker must be absent, and it is no abort/cancel error.
    expect(refused[0].daemonShuttingDown?.requestMayHaveDispatched).toBeUndefined();
    expect(JSON.stringify(refused[0])).not.toMatch(/abort|cancelled/i);
  });
});

describe("(c) order of #9958 ownership refusal and #10006 abort in runTrackedDeviceInput", () => {
  const device: BootedDevice = { deviceId: "emulator-5599", name: "Pixel", platform: "android" };
  let baselineActive: number;
  let operationRuns: number;

  const operation = async (): Promise<string> => {
    operationRuns += 1;
    return "ran";
  };
  const abortedSignal = (): AbortSignal => AbortSignal.abort(new Error("owner went away"));

  function useSessionState(assignedDevice: string): void {
    const session = createFakeSession("session-c", assignedDevice, "android");
    const state = createFakeDaemonState(new Map([["session-c", session]]));
    const stateServer = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      state,
      new FakeTimer(),
    );
    server = stateServer;
    internals = stateServer as unknown as Internals;
  }

  /** The session that resolved the target, then left the device (rebind). */
  function rebindAway(): void {
    // The in-place session is shared by reference with the fake state's map.
    const stateServer = internals as unknown as {
      daemonState: ReturnType<typeof createFakeDaemonState>;
    };
    const manager = stateServer.daemonState.getSessionManager();
    const session = manager.getSession("session-c");
    if (session) {
      session.assignedDevice = "emulator-other";
    }
  }

  beforeEach(() => {
    baselineActive = executionTracker.getActiveExecutionCount();
    operationRuns = 0;
  });

  afterEach(() => {
    expect(executionTracker.getActiveExecutionCount()).toBe(baselineActive);
    expect(executionTracker.hasActiveDeviceExecutions(device.deviceId)).toBe(false);
  });

  test("ownership refusal wins over an already-aborted owner and starts no execution", async () => {
    useSessionState(device.deviceId);
    internals.captureInputTargetOwner(device);
    rebindAway();

    await expect(
      internals.runTrackedDeviceInput("input/tap", device, operation, abortedSignal()),
    ).rejects.toThrow(/no longer owns device 'emulator-5599'/);
    expect(operationRuns).toBe(0);
  });

  test("a refused bind wins over an already-aborted owner and the execution is still ended", async () => {
    useSessionState(device.deviceId);
    internals.captureInputTargetOwner(device);
    const refusal = new ActionableError(
      "Session session-c was rebound from device 'emulator-5599'",
    );
    const bind = spyOn(executionTracker, "bindDeviceExecution").mockImplementation(() => {
      throw refusal;
    });
    try {
      await expect(
        internals.runTrackedDeviceInput(
          "input/tap",
          device,
          operation,
          abortedSignal(),
          () => "session-c",
        ),
      ).rejects.toBe(refusal);
    } finally {
      bind.mockRestore();
    }
    expect(operationRuns).toBe(0);
  });

  test("with ownership intact an aborted owner fails as the owner's abort, before dispatch", async () => {
    useSessionState(device.deviceId);
    internals.captureInputTargetOwner(device);
    const signal = abortedSignal();

    await expect(
      internals.runTrackedDeviceInput("input/tap", device, operation, signal, () => "session-c"),
    ).rejects.toBe(signal.reason);
    expect(operationRuns).toBe(0);
  });

  test("an abort that lands during the operation ends the execution too", async () => {
    useSessionState(device.deviceId);
    internals.captureInputTargetOwner(device);
    const controller = new AbortController();

    await expect(
      internals.runTrackedDeviceInput(
        "input/tap",
        device,
        async (signal) => {
          controller.abort(new Error("owner went away"));
          signal?.throwIfAborted();
          return "unreachable";
        },
        controller.signal,
        () => "session-c",
      ),
    ).rejects.toThrow("owner went away");
  });

  test("a live, still-owning session runs the operation", async () => {
    useSessionState(device.deviceId);
    internals.captureInputTargetOwner(device);

    await expect(
      internals.runTrackedDeviceInput(
        "input/tap",
        device,
        operation,
        new AbortController().signal,
        () => "session-c",
      ),
    ).resolves.toBe("ran");
    expect(operationRuns).toBe(1);
  });

  test("a sessionless or foreign-session frame on a held device is refused before any execution (#10698)", async () => {
    useSessionState(device.deviceId);

    for (const requester of [undefined, "someone-else"]) {
      await expect(
        internals.runTrackedDeviceInput(
          "input/tap",
          device,
          operation,
          new AbortController().signal,
          () => requester,
        ),
      ).rejects.toMatchObject({ code: "device_owned_by_other_session" });
    }
    expect(operationRuns).toBe(0);
  });
});
