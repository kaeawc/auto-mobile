import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/wire/constants";
import { mcpRequestFailureDetails, type UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";
import { FakeSocket } from "../fakes/FakeNetServer";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { spyOnAndroidClientInstance } from "../helpers/androidCtrlProxyClientSpies";

/**
 * Interactions between the four daemon input/shutdown changes that were each tested alone:
 * #10007 (queued request refused at quiesce), #10005 (gesture-ownership registry), #10006
 * (owner abort fence on `input/*`) and #9958 (rebound-session refusal in
 * `runTrackedDeviceInput`). Sockets, the CtrlProxy client and the device manager are in-memory
 * fakes; nothing spawns and no daemon or database is touched.
 */

type Ack = { success: boolean; error?: string };

interface Recorded {
  label: string;
  args: unknown[];
  release: (result: Ack) => void;
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

/** The real server with the gesture registry, owner capture and tracked input exposed. */
class LifecycleInputServer extends UnixSocketServerHarness {
  get ownedGestureOwnerCount(): number {
    return this.ownedGestures.ownerCount;
  }

  captureOwner(device: BootedDevice): void {
    this.captureInputTargetOwner(device);
  }

  trackDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
    requester?: () => string | undefined,
  ): Promise<T> {
    return this.runTrackedDeviceInput(toolName, targetDevice, operation, ownerSignal, requester);
  }
}

function createServer(state: DaemonStateArg): LifecycleInputServer {
  return new LifecycleInputServer(
    "unused",
    state,
    new FakeTimer(),
    null,
    { mcpDispatcher: unreachableMcpDispatcher },
    undefined,
    { bindLock: fakeBindLock },
  );
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
  params: {},
};

let server: LifecycleInputServer;
let sessionState: ReturnType<typeof createFakeDaemonState> | undefined;
let calls: Recorded[];
let sockets: FakeSocket[];

function pending(label: string): Recorded[] {
  return calls.filter((call) => call.label === label);
}

function installClient(): void {
  const record = (label: string, args: unknown[]) =>
    new Promise<Ack & { totalTimeMs: number }>((resolve) => {
      calls.push({ label, args, release: (result) => resolve({ totalTimeMs: 0, ...result }) });
    });
  spyOnAndroidClientInstance(androidDevice, {
    getScreenScaleMetadata: () => null,
    requestTapCoordinates: (...args) => record("tap", args),
    requestGestureStart: (...args) => record("gestureStart", args),
    requestGestureEnd: (...args) => record("gestureEnd", args),
  });
}

beforeEach(() => {
  calls = [];
  sockets = [];
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
  installClient();
  sessionState = undefined;
  server = createServer(uninitializedDaemonState);
  server.allowRequests();
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
  server.connect(socket);
  return socket;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function drain(): Promise<void> {
  await settle();
  await Promise.all([...server.state.activeRequestHandlers]);
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
    expect(server.ownedGestureOwnerCount).toBe(0);
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
    expect(server.ownedGestureOwnerCount).toBe(0);
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
    expect(pending("gestureEnd")[0].args).toEqual(["g1", 0, 0, true, { timeoutMs: 5000 }]);
    expect(server.ownedGestureOwnerCount).toBe(0);
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
    expect(server.ownedGestureOwnerCount).toBe(1);
    expect(pending("gestureEnd")).toHaveLength(0);

    owner.destroy();
    await settle();
    expect(pending("gestureEnd")).toHaveLength(1);
    pending("gestureEnd")[0].release({ success: true });
    await drain();
    expect(pending("gestureEnd")).toHaveLength(1);
    expect(server.ownedGestureOwnerCount).toBe(0);
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
    sessionState = state;
    server = createServer(state);
  }

  /** The session that resolved the target, then left the device (rebind). */
  function rebindAway(): void {
    // The in-place session is shared by reference with the fake state's map.
    const session = sessionState?.getSessionManager().getSession("session-c");
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
    server.captureOwner(device);
    rebindAway();

    await expect(
      server.trackDeviceInput("input/tap", device, operation, abortedSignal()),
    ).rejects.toThrow(/no longer owns device 'emulator-5599'/);
    expect(operationRuns).toBe(0);
  });

  test("the refusal for a holder that left after target resolution is typed on the frame (#11351)", async () => {
    useSessionState(device.deviceId);
    server.captureOwner(device);
    rebindAway();

    const error = await server
      .trackDeviceInput("input/tap", device, operation)
      .catch((thrown: unknown) => thrown);

    expect(mcpRequestFailureDetails(error, undefined)).toEqual({
      code: "session_no_longer_owns_device",
      retryable: false,
    });
    expect(operationRuns).toBe(0);
  });

  test("a refused bind wins over an already-aborted owner and the execution is still ended", async () => {
    useSessionState(device.deviceId);
    server.captureOwner(device);
    const refusal = new ActionableError(
      "Session session-c was rebound from device 'emulator-5599'",
    );
    const bind = spyOn(executionTracker, "bindDeviceExecution").mockImplementation(() => {
      throw refusal;
    });
    try {
      await expect(
        server.trackDeviceInput("input/tap", device, operation, abortedSignal(), () => "session-c"),
      ).rejects.toBe(refusal);
    } finally {
      bind.mockRestore();
    }
    expect(operationRuns).toBe(0);
  });

  test("with ownership intact an aborted owner fails as the owner's abort, before dispatch", async () => {
    useSessionState(device.deviceId);
    server.captureOwner(device);
    const signal = abortedSignal();

    await expect(
      server.trackDeviceInput("input/tap", device, operation, signal, () => "session-c"),
    ).rejects.toBe(signal.reason);
    expect(operationRuns).toBe(0);
  });

  test("an abort that lands during the operation ends the execution too", async () => {
    useSessionState(device.deviceId);
    server.captureOwner(device);
    const controller = new AbortController();

    await expect(
      server.trackDeviceInput(
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
    server.captureOwner(device);

    await expect(
      server.trackDeviceInput(
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
        server.trackDeviceInput(
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
