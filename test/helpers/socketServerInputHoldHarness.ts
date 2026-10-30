import { expect, spyOn } from "bun:test";
import type { Socket } from "node:net";
import type { UnixSocketServer } from "../../src/daemon/socketServer";
import type { SocketRequestHandling } from "../../src/daemon/socketServerParts/SocketAdmission";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { FakeSocket, NonThrowingFakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { UnixSocketServerHarness } from "../daemon/helpers/UnixSocketServerHarness";
import { createAndroidTestClient } from "./androidCtrlProxyClientSpies";
import { fakeBindLock, unreachableMcpDispatcher } from "./createTestUnixSocketServer";
import { drainMicrotasks } from "./fakeTimerStepping";

type DaemonStateArg = ConstructorParameters<typeof UnixSocketServer>[1];

const unexpectedDaemonState = (): never => {
  throw new Error("Unexpected daemon state access");
};

/** A daemon that never finished initialising: input admission is the only thing exercised. */
const uninitializedDaemonState: DaemonStateArg = {
  isInitialized: () => false,
  getSessionManager: unexpectedDaemonState,
  getDevicePool: unexpectedDaemonState,
  getDeviceSessionRegistry: unexpectedDaemonState,
};

/** Device every hold-harness server resolves to unless a test installs its own resolver. */
export const holdDevice = (platform: "android" | "ios", deviceId = "A"): BootedDevice => ({
  platform,
  deviceId,
  name: "Fake",
});

export type TrackedDeviceInput = <T>(
  method: string,
  device: BootedDevice,
  operation: (signal?: AbortSignal, dispatching?: () => void) => Promise<T>,
  owner?: AbortSignal,
) => Promise<T>;

export type InputTargetResolver = (
  platform: "android" | "ios",
  deviceId: string | undefined,
) => Promise<BootedDevice>;

interface InputOwner {
  signal?: AbortSignal;
  receivedAtMs?: number;
}

/**
 * A real `UnixSocketServer` whose per-device input admission is exercised directly. It keeps the
 * real per-device key and replaces only session admission (which needs a DB), target resolution,
 * the frame-context check, the idle-key timers and the iOS coordinate probe. Tests swap
 * `trackedInput` / `targetResolver` per case instead of reassigning private members.
 */
export class InputHoldServer extends UnixSocketServerHarness {
  /** Device ids in the order input was dispatched through the default admission. */
  readonly stamps: string[] = [];
  trackedInput: TrackedDeviceInput = async (_method, device, operation, owner) =>
    operation(owner, () => {
      this.stamps.push(device.deviceId);
    });
  targetResolver: InputTargetResolver = async (platform, deviceId) =>
    holdDevice(platform, deviceId);
  private readonly handled: Promise<DaemonResponse | undefined>[] = [];

  constructor(
    readonly fakeTimer: FakeTimer,
    state: DaemonStateArg,
    private readonly realTracking: boolean,
  ) {
    super(
      "unused",
      state,
      fakeTimer,
      null,
      {
        mcpDispatcher: unreachableMcpDispatcher,
        sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} },
      },
      undefined,
      { bindLock: fakeBindLock },
    );
  }

  /** Every request the socket framer handed to `handleRequest`, in order. */
  get handledRequests(): readonly Promise<DaemonResponse | undefined>[] {
    return this.handled;
  }

  get forwardTails(): Map<string, Promise<void>> {
    return this.mcpForwardTails;
  }

  /** The failure frame an owner socket receives for `error`. */
  forwardFailureResponse(args: {
    error: unknown;
    request: DaemonRequest;
    sessionId: string;
    ownerSocket: Socket;
    signal?: AbortSignal;
  }): DaemonResponse | undefined {
    return this.mcpForwardFailureResponse(args);
  }

  protected override handleRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
    receivedAtMs: number,
    handling?: SocketRequestHandling,
  ): Promise<DaemonResponse | undefined> {
    // Forwards only the admission hook, as before: the request context is rebuilt at receipt.
    const result = super.handleRequest(sessionId, socket, request, receivedAtMs, {
      onAdmitted: handling?.onAdmitted,
    });
    this.handled.push(result);
    return result;
  }

  protected override scheduleForwardKeyIdle(): void {}

  protected override clearForwardKeyIdleTimer(): void {}

  protected override requireCurrentFrameContext(): void {}

  protected override async toIosRunnerCoordinates(
    _client: unknown,
    _deviceId: string,
    coordinates: number[],
  ): Promise<number[]> {
    return coordinates;
  }

  override resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
  ): Promise<BootedDevice> {
    return this.targetResolver(platform, deviceId);
  }

  protected override runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: (signal?: AbortSignal, dispatching?: () => void) => Promise<T>,
    ownerSignal?: AbortSignal,
    requester?: () => string | undefined,
  ): Promise<T> {
    return this.realTracking
      ? super.runTrackedDeviceInput(toolName, targetDevice, operation, ownerSignal, requester)
      : this.trackedInput(toolName, targetDevice, operation, ownerSignal);
  }

  override handleInputTypeText(
    request: DaemonRequest,
    session?: string,
    input?: InputOwner,
  ): Promise<unknown> {
    return super.handleInputTypeText(request, session, input);
  }

  override handleInputTap(
    request: DaemonRequest,
    session?: string,
    input?: InputOwner,
  ): Promise<unknown> {
    return super.handleInputTap(request, session, input);
  }

  override handleInputSwipe(
    request: DaemonRequest,
    session?: string,
    input?: InputOwner,
  ): Promise<unknown> {
    return super.handleInputSwipe(request, session, input);
  }

  override handleInputKey(
    request: DaemonRequest,
    session?: string,
    input?: InputOwner,
  ): Promise<unknown> {
    return super.handleInputKey(request, session, input);
  }

  override handleInputPressButton(
    request: DaemonRequest,
    session?: string,
    input?: InputOwner,
  ): Promise<unknown> {
    return super.handleInputPressButton(request, session, input);
  }
}

export type Harness = InputHoldServer;

export function harness() {
  const timer = new FakeTimer();
  const handler = new InputHoldServer(timer, uninitializedDaemonState, false);
  return { handler, timer, stamps: handler.stamps };
}

export function frame(
  platform: string,
  deviceId = "A",
  append = false,
  submit = false,
): DaemonRequest {
  return {
    id: deviceId,
    type: "mcp_request",
    method: "input/typeText",
    timeoutMs: 1000,
    params: {
      platform,
      deviceId,
      text: append ? "ab" : "a",
      ...(append ? { mode: "append" } : {}),
      submit,
    },
  };
}
export function runner(ignoreAbort = false) {
  let reply!: () => void;
  let fail!: () => void;
  let inFlight = false;
  let dispatched = false;
  let cancelled = false;
  const pending = new Promise<{ success: boolean; totalTimeMs: number; action: string }>(
    (resolve, reject) => {
      reply = () => {
        inFlight = false;
        resolve({ success: true, totalTimeMs: 0, action: "runner" });
      };
      fail = () => {
        inFlight = false;
        reject(new Error("runner request failed"));
      };
    },
  );
  return {
    reply: () => reply(),
    fail: () => fail(),
    get inFlight() {
      return inFlight;
    },
    get dispatched() {
      return dispatched;
    },
    get cancelled() {
      return cancelled;
    },
    send(signal?: AbortSignal, onDispatch?: () => void) {
      signal?.throwIfAborted();
      inFlight = dispatched = true;
      onDispatch?.();
      return new Promise<typeof pending extends Promise<infer T> ? T : never>((resolve, reject) => {
        pending.then(resolve, reject);
        if (ignoreAbort) {
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
}
export function socketHarness(state?: DaemonStateArg) {
  const timer = new FakeTimer();
  const server = new InputHoldServer(timer, state ?? uninitializedDaemonState, state !== undefined);
  server.allowRequests();
  const client = createAndroidTestClient(holdDevice("android"));
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const socket = new NonThrowingFakeSocket();
  const other = new NonThrowingFakeSocket();
  server.connect(socket);
  server.connect(other);
  return { server, timer, stamps: server.stamps, client, socket, other };
}
export function cancel(socket: FakeSocket, requestId: string) {
  socket.send({
    id: "cancel",
    type: "daemon_request",
    method: "daemon/cancelRequest",
    params: { requestId },
  });
}
export async function finishSockets(f: ReturnType<typeof socketHarness>) {
  f.socket.destroy();
  f.other.destroy();
  await drainMicrotasks(100);
  await Promise.all([...f.server.state.activeRequestHandlers]);
  expect(f.server.state.activeRequestHandlers.size).toBe(0);
  expect(f.server.forwardTails.size).toBe(0);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
}
