import { createTestUnixSocketServer } from "./createTestUnixSocketServer";
import { expect, spyOn } from "bun:test";
import type { ControlSocket } from "../../src/daemon/socketServer/ControlConnection";
import { UnixSocketServer, type AppendTextInput } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { InputText } from "../../src/features/action/InputText";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeFrameSocket } from "../fakes/FakeControlSocket";

export { FakeFrameSocket };
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "./fakeTimerStepping";
export interface Harness {
  timer: Timer;
  mcpForwardTails: Map<string, Promise<void>>;
  mcpForwardIdleCloseKeys: Map<string, Set<string>>;
  appendTextInputs: Map<string, unknown>;
  appendTextFactory: (device: BootedDevice) => AppendTextInput;
  createSocketAppendTextInput?(device: BootedDevice): AppendTextInput;
  clearForwardKeyIdleTimer(): void;
  scheduleForwardKeyIdle(): void;
  resolveInputTargetDevice(platform: string, deviceId: string): Promise<BootedDevice>;
  requireCurrentFrameContext(): void;
  runTrackedDeviceInput<T>(
    method: string,
    device: BootedDevice,
    operation: (signal?: AbortSignal, dispatching?: () => void) => Promise<T>,
    owner?: AbortSignal,
  ): Promise<T>;
  handleInputTypeText(
    request: DaemonRequest,
    session?: string,
    input?: { signal?: AbortSignal; receivedAtMs?: number },
  ): Promise<unknown>;
  handleInputTap(
    request: DaemonRequest,
    session?: string,
    input?: { signal?: AbortSignal },
  ): Promise<unknown>;
  handleInputSwipe(
    request: DaemonRequest,
    session?: string,
    input?: { signal?: AbortSignal },
  ): Promise<unknown>;
  handleInputGesture(
    request: DaemonRequest,
    kind: "start" | "move" | "end",
    session?: string,
    input?: { signal?: AbortSignal },
  ): Promise<unknown>;
  handleInputKey(
    request: DaemonRequest,
    session?: string,
    input?: { signal?: AbortSignal },
  ): Promise<unknown>;
  handleInputPressButton(
    request: DaemonRequest,
    session?: string,
    input?: { signal?: AbortSignal },
  ): Promise<unknown>;
}
export function harness() {
  const handler = Object.create(UnixSocketServer.prototype) as Harness;
  const timer = new FakeTimer();
  const stamps: string[] = [];
  handler.timer = timer;
  handler.mcpForwardTails = new Map();
  handler.mcpForwardIdleCloseKeys = new Map();
  handler.appendTextInputs = new Map();
  Object.assign(handler, {
    confirmedLegacyScaleDevices: new Set(),
    toIosRunnerCoordinates: async (_client: unknown, _id: string, coords: number[]) => coords,
  });
  handler.clearForwardKeyIdleTimer = () => {};
  handler.scheduleForwardKeyIdle = () => {};
  handler.requireCurrentFrameContext = () => {};
  handler.resolveInputTargetDevice = async (platform, deviceId) =>
    ({ platform, deviceId, name: "Fake" }) as BootedDevice;
  // Keep the real per-device key; replace only session admission, which needs a DB.
  handler.runTrackedDeviceInput = async (_method, device, operation, owner) =>
    operation(owner, () => stamps.push(device.deviceId));
  handler.appendTextFactory = (device) =>
    handler.createSocketAppendTextInput
      ? handler.createSocketAppendTextInput(device)
      : new InputText(device, defaultAdbClientFactory, undefined, timer);
  return { handler, timer, stamps };
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
  const pending = new Promise<{ success: boolean; totalTimeMs: number }>((resolve, reject) => {
    reply = () => {
      inFlight = false;
      resolve({ success: true, totalTimeMs: 0 });
    };
    fail = () => {
      inFlight = false;
      reject(new Error("runner request failed"));
    };
  });
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
export interface SocketHarness extends Harness {
  handleRequest(
    sessionId: string,
    socket: ControlSocket,
    request: DaemonRequest,
  ): Promise<DaemonResponse | undefined>;
  acceptingRequests: boolean;
  handleConnection(socket: ControlSocket): void;
  activeRequestHandlers: Set<Promise<void>>;
}
export function socketHarness(state?: DaemonStateAccess) {
  const { timer, stamps, handler: admission } = harness();
  const server = createTestUnixSocketServer(
    "unused",
    state ?? ({ isInitialized: () => false } as DaemonStateAccess),
    timer,
    null,
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  ) as unknown as SocketHarness;
  server.acceptingRequests = true;
  server.clearForwardKeyIdleTimer = admission.clearForwardKeyIdleTimer;
  server.scheduleForwardKeyIdle = admission.scheduleForwardKeyIdle;
  server.resolveInputTargetDevice = admission.resolveInputTargetDevice;
  server.requireCurrentFrameContext = () => {};
  if (!state) {
    server.runTrackedDeviceInput = admission.runTrackedDeviceInput;
  }
  const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const socket = new FakeFrameSocket();
  const other = new FakeFrameSocket();
  server.handleConnection(socket);
  server.handleConnection(other);
  return { server, timer, stamps, client, socket, other };
}
export function cancel(socket: FakeFrameSocket, requestId: string) {
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
  await Promise.all([...f.server.activeRequestHandlers]);
  expect(f.server.activeRequestHandlers.size).toBe(0);
  expect(f.server.mcpForwardTails.size).toBe(0);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
}
