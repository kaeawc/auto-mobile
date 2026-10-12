import { expect, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { UnixSocketServer, type AppendTextInput } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { InputText } from "../../src/features/action/InputText";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "./fakeTimerStepping";
export interface Harness {
  timer: Timer;
  mcpForwardTails: Map<string, Promise<void>>;
  mcpForwardIdleCloseKeys: Map<string, Set<string>>;
  appendTextInputs: Map<string, unknown>;
  appendTextFactory: (device: BootedDevice) => AppendTextInput;
  createSocketAppendTextInput?(device: BootedDevice): AppendTextInput;
  clearMcpClientIdleTimer(): void;
  scheduleMcpClientIdleClose(): void;
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
  handler.clearMcpClientIdleTimer = () => {};
  handler.scheduleMcpClientIdleClose = () => {};
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
interface FrameSocket {
  destroyed: boolean;
  writableLength: number;
  responses: DaemonResponse[];
  setTimeout(): FrameSocket;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
  destroy(): FrameSocket;
  send(frame: DaemonRequest): void;
}
export class FakeFrameSocket extends EventEmitter implements FrameSocket {
  destroyed = false;
  writableLength = 0;
  responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close", false);
    return this;
  }
  send(frame: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }
}
export interface SocketHarness extends Harness {
  handleRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
  ): Promise<DaemonResponse | undefined>;
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
}
export function socketHarness(state?: DaemonStateAccess) {
  const { timer, stamps, handler: admission } = harness();
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    state ?? ({ isInitialized: () => false } as DaemonStateAccess),
    timer,
    null,
    { sessionToolSelectionService: { isEnabled: async () => true, setEnabled: async () => {} } },
  ) as unknown as SocketHarness;
  server.acceptingRequests = true;
  server.clearMcpClientIdleTimer = admission.clearMcpClientIdleTimer;
  server.scheduleMcpClientIdleClose = admission.scheduleMcpClientIdleClose;
  server.resolveInputTargetDevice = admission.resolveInputTargetDevice;
  server.requireCurrentFrameContext = () => {};
  if (!state) {
    server.runTrackedDeviceInput = admission.runTrackedDeviceInput;
  }
  const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const socket = new FakeFrameSocket();
  const other = new FakeFrameSocket();
  server.handleConnection(socket as unknown as Socket);
  server.handleConnection(other as unknown as Socket);
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
