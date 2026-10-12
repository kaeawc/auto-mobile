import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { UnixSocketServer, type AppendTextInput } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { screenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";
import { TakeScreenshot } from "../../src/features/observe/TakeScreenshot";
import type { DaemonResponse } from "../../src/daemon/types";
import type { DaemonRequest } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { CtrlProxyText as IosTextDelegate } from "../../src/features/observe/ios/CtrlProxyText";
import { InputText } from "../../src/features/action/InputText";
import { InputKey } from "../../src/features/action/InputKey";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { createIosDelegateHarness } from "../helpers/iosDelegateHarness";

interface Harness {
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
function harness() {
  const handler = Object.create(UnixSocketServer.prototype) as Harness;
  const timer = new FakeTimer();
  const stamps: string[] = [];
  handler.timer = timer;
  handler.mcpForwardTails = new Map();
  handler.mcpForwardIdleCloseKeys = new Map();
  handler.appendTextInputs = new Map();
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
function frame(platform: string, deviceId = "A", append = false, submit = false): DaemonRequest {
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
function runner(ignoreAbort = false) {
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
beforeEach(() => {
  // InputText constructs observation services, but append never observes. Suppress
  // their filesystem/retention work so these tests use no real timers or I/O.
  spyOn(screenshotPathProtection, "start").mockImplementation(() => {});
  spyOn(screenshotPathProtection, "sweepOnce").mockResolvedValue(undefined);
  spyOn(TakeScreenshot as unknown as { getCacheDir(): string }, "getCacheDir").mockReturnValue(
    "scratch/restart-edges-codex/screenshots",
  );
});
afterEach(() => {
  mock.restore();
  expect((screenshotPathProtection.start as { mock?: unknown }).mock).toBeUndefined();
  expect((screenshotPathProtection.sweepOnce as { mock?: unknown }).mock).toBeUndefined();
  // Spies bypass getInstance; no real clients are constructed or connected.
  AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
  IOSCtrlProxyClient.clearInstanceRegistryForTesting();
  expect(AndroidCtrlProxyClient.getExistingInstance("A")).toBeNull();
  expect(IOSCtrlProxyClient.getExistingInstance("A")).toBeNull();
});

const variants = [
  "android replace",
  "ios replace",
  "ios append",
  "android append",
  "android submit",
  "ios submit",
  "android append submit",
] as const;
test.each(
  variants.flatMap((variant) =>
    ["reply", "error", "deadline"].map((end) => [variant, end] as const),
  ),
)("%s post-dispatch abort holds same-device text and key until %s", async (variant, end) => {
  const { handler, timer, stamps } = harness();
  const platform = variant.startsWith("android") ? "android" : "ios";
  const append = variant.includes("append");
  const submit = variant.endsWith("submit");
  const first = runner(end === "deadline");
  const secondDispatches: string[] = [];
  const client = Object.create(
    platform === "android" ? AndroidCtrlProxyClient.prototype : IOSCtrlProxyClient.prototype,
  );
  if (platform === "android") {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  } else {
    spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
  }
  let textCalls = 0;
  const set = (_text: string, options?: { abortSignal?: AbortSignal; onDispatch?: () => void }) => {
    textCalls++;
    if (textCalls === 1 && !submit && !(append && platform === "android")) {
      return first.send(options?.abortSignal, options?.onDispatch);
    }
    options?.onDispatch?.();
    if (textCalls > 1 || (append && platform === "android")) {
      secondDispatches.push("text");
    }
    return Promise.resolve({ success: true, totalTimeMs: 0 });
  };
  spyOn(client, "requestSetText").mockImplementation(set);
  if (platform === "ios") {
    spyOn(client, "requestAppendText").mockImplementation(
      (text, _timeout, _perf, _context, options) => set(text, options),
    );
  }
  spyOn(client, "requestImeAction").mockImplementation(
    (_action, _timeout, _perf, signal, onDispatch) => first.send(signal, onDispatch),
  );
  const adb = new FakeAdbExecutor();
  spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  let commands = 0;
  spyOn(adb, "execute").mockImplementation(async (_args, options) => {
    await options?.beforeDispatch?.(options.timeoutMs);
    commands++;
    if (append && !submit && platform === "android" && commands === 1) {
      await first.send(options?.signal);
    }
    return { stdout: "", stderr: "" };
  });
  spyOn(InputKey.prototype, "press").mockImplementation(
    async (_key, _timeout, _context, _args, routing) => {
      routing?.onDispatch?.();
      secondDispatches.push("key");
      return { success: true, key: "enter", keyCode: "KEYCODE_ENTER" };
    },
  );
  const owner = new AbortController();
  let answered = false;
  const a = handler
    .handleInputTypeText(frame(platform, "A", append, submit), undefined, { signal: owner.signal })
    .then(
      (value) => {
        answered = true;
        return value;
      },
      (error) => {
        answered = true;
        throw error;
      },
    );
  void a.catch(() => {});
  await drainUntil(() => first.dispatched, { description: "A dispatch" });
  const b = handler.handleInputTypeText(frame(platform, "A"), undefined, { receivedAtMs: 1 });
  const key = handler.handleInputKey({
    id: "key",
    type: "mcp_request",
    method: "input/key",
    timeoutMs: 2000,
    params: { platform: "android", deviceId: "A", key: "enter" },
  });
  const other = handler.handleInputTypeText(frame(platform, "other"));
  owner.abort(new Error("owner cancelled"));
  await other;
  await drainMicrotasks(100);
  expect(first.inFlight).toBe(true);
  expect(secondDispatches).toEqual(["text"]);
  expect(answered).toBe(false); // different device only
  expect(stamps.filter((id) => id === "A")).toEqual(["A"]);
  if (end === "reply") {
    first.reply();
  } else if (end === "error") {
    first.fail();
  } else {
    timer.advanceTime(1000);
  }
  await expect(a).rejects.toThrow("outcome is indeterminate");
  await expect(a).rejects.toThrow("Do not retry automatically");
  if (append && submit) {
    await expect(a).rejects.toMatchObject({ name: "InputTypeTextAppendError", charsSent: 2 });
  }
  await b;
  await key;
  expect(secondDispatches).toEqual(["text", "text", "key"]);
  if (append && platform === "android") {
    expect(commands).toBe(submit ? 2 : 1);
  } // no suffix after abort
  first.reply();
  await drainMicrotasks(100);
  expect(handler.mcpForwardTails.size).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test.each(["replace", "append", "legacy append"] as const)(
  "iOS %s holds the real request-manager entry through owner abort",
  async (variant) => {
    const { handler, timer } = harness();
    const transport = createIosDelegateHarness({
      timer,
      supportedCommands: variant === "legacy append" ? ["request_set_text"] : undefined,
    });
    const delegate = new IosTextDelegate(transport.context);
    const client = Object.create(IOSCtrlProxyClient.prototype) as IOSCtrlProxyClient;
    spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "requestSetText").mockImplementation(delegate.requestSetText.bind(delegate));
    spyOn(client, "requestAppendText").mockImplementation(
      delegate.requestAppendText.bind(delegate),
    );
    const owner = new AbortController();
    const a = handler.handleInputTypeText(frame("ios", "A", variant !== "replace"), undefined, {
      signal: owner.signal,
    });
    void a.catch(() => {});
    await drainUntil(() => transport.sentMessages.length === 1, {
      description: "real delegate send",
    });
    const b = handler.handleInputTypeText(frame("ios"));
    owner.abort(new Error("owner cancelled"));
    await drainMicrotasks(100);
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.requestManager.getPendingCount()).toBe(1);
    expect(transport.sentMessages[0]?.type).toBe(
      variant === "append" ? "request_append_text" : "request_set_text",
    );
    expect(transport.resolveLast({ success: true, totalTimeMs: 0 })).toBe(true);
    await expect(a).rejects.toThrow("outcome is indeterminate");
    await drainUntil(() => transport.sentMessages.length === 2, {
      description: "queued delegate send",
    });
    expect(transport.resolveLast({ success: true, totalTimeMs: 0 })).toBe(true);
    await b;
    await drainMicrotasks(100);
    expect(transport.requestManager.getPendingCount()).toBe(0);
    expect(handler.mcpForwardTails.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("abort before dispatch releases the device key with plain cancellation and no stamp", async () => {
  const { handler, timer, stamps } = harness();
  const owner = new AbortController();
  let preparing = false;
  let sent = 0;
  const client = Object.create(IOSCtrlProxyClient.prototype) as IOSCtrlProxyClient;
  spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
  spyOn(client, "requestSetText").mockImplementation((_text, options) => {
    if (!preparing) {
      preparing = true;
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), {
          once: true,
        });
      });
    }
    options?.onDispatch?.();
    sent++;
    return Promise.resolve({ success: true, totalTimeMs: 0 });
  });
  const reason = new Error("cancel before send");
  const a = handler.handleInputTypeText(frame("ios"), undefined, { signal: owner.signal });
  void a.catch(() => {});
  await drainUntil(() => preparing, { description: "preparation" });
  const b = handler.handleInputTypeText(frame("ios"));
  expect(stamps).toEqual([]);
  owner.abort(reason);
  await expect(a).rejects.toBe(reason);
  await b;
  expect(sent).toBe(1);
  expect(stamps).toEqual(["A"]);
  await drainMicrotasks(100);
  expect(handler.mcpForwardTails.size).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("Android append abort at the dispatch latch cannot escape the request hold", async () => {
  const { handler, timer, stamps } = harness();
  const owner = new AbortController();
  const first = runner();
  const reason = new Error("cancel at dispatch");
  handler.runTrackedDeviceInput = async (_method, device, operation, signal) =>
    operation(signal, () => {
      stamps.push(device.deviceId);
      owner.abort(reason);
    });
  const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  let nextSent = false;
  spyOn(client, "requestSetText").mockImplementation(async (_text, options) => {
    options?.onDispatch?.();
    nextSent = true;
    return { success: true, totalTimeMs: 0 };
  });
  const adb = new FakeAdbExecutor();
  spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  let commands = 0;
  spyOn(adb, "execute").mockImplementation(async (_args, options) => {
    await options?.beforeDispatch?.(options.timeoutMs);
    commands++;
    await first.send(options?.signal);
    return { stdout: "", stderr: "" };
  });
  const a = handler.handleInputTypeText(frame("android", "A", true), undefined, {
    signal: owner.signal,
  });
  void a.catch(() => {});
  await drainUntil(() => first.dispatched, { description: "append dispatched after latch abort" });
  expect(owner.signal.aborted).toBe(true);
  expect(first.cancelled).toBe(false);
  const b = handler.handleInputTypeText(frame("android"));
  await drainMicrotasks(100);
  expect(nextSent).toBe(false);
  expect(stamps).toEqual(["A"]);
  first.reply();
  await expect(a).rejects.toThrow("outcome is indeterminate");
  await b;
  expect(commands).toBe(1);
  expect(nextSent).toBe(true);
  await drainMicrotasks(100);
  expect(handler.mcpForwardTails.size).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("ordinary timeout still holds the key until the dispatched request settles", async () => {
  const { handler, timer } = harness();
  const first = runner();
  let calls = 0;
  const client = Object.create(IOSCtrlProxyClient.prototype) as IOSCtrlProxyClient;
  spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
  spyOn(client, "requestSetText").mockImplementation((_text, options) => {
    calls++;
    if (calls === 1) {
      return first.send(options?.abortSignal, options?.onDispatch);
    }
    options?.onDispatch?.();
    return Promise.resolve({ success: true, totalTimeMs: 0 });
  });
  const a = handler.handleInputTypeText(frame("ios"));
  void a.catch(() => {});
  await drainUntil(() => first.dispatched, { description: "timeout A dispatch" });
  const b = handler.handleInputTypeText({ ...frame("ios"), timeoutMs: 2000 });
  timer.advanceTime(1000);
  await drainMicrotasks(100);
  expect(calls).toBe(1);
  expect(first.inFlight).toBe(true);
  await handler.handleInputTypeText(frame("ios", "other"));
  expect(calls).toBe(2);
  first.reply();
  await expect(a).rejects.toThrow("operation exceeded remaining budget");
  await b;
  expect(calls).toBe(3);
  await drainMicrotasks(100);
  expect(handler.mcpForwardTails.size).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

// Read-only diagnostics for adjacent handlers. These deliberately document the
// current early-release behavior; changing their delivery policy is another lane.
test.each(["key", "pressButton"] as const)(
  "report-only: input/%s can release the key after dispatch cancellation",
  async (method) => {
    const { handler, stamps } = harness();
    const first = runner();
    const owner = new AbortController();
    const adb = new FakeAdbExecutor();
    spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
    spyOn(adb, "execute").mockImplementation(async (_args, options) => {
      await options?.beforeDispatch?.(options.timeoutMs);
      await first.send(options?.signal);
      return { stdout: "", stderr: "" };
    });
    const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "requestGlobalAction").mockImplementation(
      (_action, _timeout, _perf, _context, signal, onDispatch) => first.send(signal, onDispatch),
    );
    spyOn(client, "requestSetText").mockImplementation(async (_text, options) => {
      options?.onDispatch?.();
      return { success: true, totalTimeMs: 0 };
    });
    const request: DaemonRequest = {
      id: method,
      type: "mcp_request",
      method: `input/${method}`,
      timeoutMs: 1000,
      params: {
        platform: "android",
        deviceId: "A",
        ...(method === "key" ? { key: "enter" } : { button: "back" }),
      },
    };
    const a =
      method === "key"
        ? handler.handleInputKey(request, undefined, { signal: owner.signal })
        : handler.handleInputPressButton(request, undefined, { signal: owner.signal });
    void a.catch(() => {});
    await drainUntil(() => first.dispatched, { description: "diagnostic dispatch" });
    const b = handler.handleInputTypeText(frame("android"));
    const reason = new Error("diagnostic cancel");
    owner.abort(reason);
    if (method === "key") {
      await expect(a).rejects.toThrow("Key outcome is indeterminate");
    } else {
      await expect(a).rejects.toThrow("Operation cancelled");
    }
    await b;
    expect(first.inFlight).toBe(true);
    expect(stamps).toEqual(["A", "A"]);
    first.reply();
    await drainMicrotasks(100);
    expect(handler.mcpForwardTails.size).toBe(0);
  },
);

interface FrameSocket {
  destroyed: boolean;
  writableLength: number;
  responses: DaemonResponse[];
  setTimeout(): FrameSocket;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
  destroy(): FrameSocket;
  send(frame: DaemonRequest): void;
}
class FakeFrameSocket extends EventEmitter implements FrameSocket {
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
interface SocketHarness extends Harness {
  handleRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
  ): Promise<DaemonResponse | undefined>;
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
}
function socketHarness() {
  const { timer, stamps, handler: admission } = harness();
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    { isInitialized: () => false } as DaemonStateAccess,
    timer,
  ) as unknown as SocketHarness;
  server.acceptingRequests = true;
  server.clearMcpClientIdleTimer = admission.clearMcpClientIdleTimer;
  server.scheduleMcpClientIdleClose = admission.scheduleMcpClientIdleClose;
  server.resolveInputTargetDevice = admission.resolveInputTargetDevice;
  server.requireCurrentFrameContext = () => {};
  server.runTrackedDeviceInput = admission.runTrackedDeviceInput;
  const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const socket = new FakeFrameSocket();
  const other = new FakeFrameSocket();
  server.handleConnection(socket as unknown as Socket);
  server.handleConnection(other as unknown as Socket);
  return { server, timer, stamps, client, socket, other };
}
function cancel(socket: FakeFrameSocket, requestId: string) {
  socket.send({
    id: "cancel",
    type: "daemon_request",
    method: "daemon/cancelRequest",
    params: { requestId },
  });
}
async function finishSockets(f: ReturnType<typeof socketHarness>) {
  f.socket.destroy();
  f.other.destroy();
  await drainMicrotasks(100);
  await Promise.all([...f.server.activeRequestHandlers]);
  expect(f.server.activeRequestHandlers.size).toBe(0);
  expect(f.server.mcpForwardTails.size).toBe(0);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
}
test.each(["cancel", "close"] as const)(
  "parked text %s releases socket admission without sending or stamping",
  async (mode) => {
    const f = socketHarness();
    const first = runner();
    const sends: string[] = [];
    spyOn(f.client, "requestSetText").mockImplementation((text, options) => {
      sends.push(text);
      if (text === "holder") {
        return first.send(options?.abortSignal, options?.onDispatch);
      }
      options?.onDispatch?.();
      return Promise.resolve({ success: true, totalTimeMs: 0 });
    });
    f.other.send({
      ...frame("android"),
      id: "holder",
      params: { platform: "android", deviceId: "A", text: "holder" },
    });
    await drainUntil(() => first.dispatched, { description: "holder dispatch" });
    const requests = spyOn(f.server, "handleRequest");
    f.socket.send({ ...frame("android"), id: "parked" });
    await drainMicrotasks(100);
    expect(f.server.mcpForwardTails.size).toBe(1);
    const parked = requests.mock.results.at(-1)!;
    expect(parked.type).toBe("return");
    let answered = false;
    if (parked.type === "return") {
      void parked.value.then(
        () => {
          answered = true;
        },
        () => {
          answered = true;
        },
      );
    }
    if (mode === "cancel") {
      cancel(f.socket, "parked");
    } else {
      f.socket.destroy();
    }
    f.socket.send({ ...frame("android", "other"), id: "next" });
    await drainMicrotasks(100);
    try {
      if (mode === "cancel") {
        expect(f.socket.responses.find((r) => r.id === "parked")).toMatchObject({
          success: false,
          error: expect.stringContaining("cancel"),
        });
        expect(f.socket.responses.find((r) => r.id === "next")).toMatchObject({ success: true });
        expect(f.stamps).toEqual(["A", "other"]);
      } else {
        expect(answered).toBe(true);
        expect(f.stamps).toEqual(["A"]);
      }
    } finally {
      first.reply();
      await finishSockets(f);
      requests.mockRestore();
    }
    expect(sends).toEqual(mode === "cancel" ? ["holder", "a"] : ["holder"]);
  },
);
test("text socket close while queued settles the undispatched frame before its holder", async () => {
  const f = socketHarness();
  const first = runner();
  let sends = 0;
  spyOn(f.client, "requestSetText").mockImplementation((_text, options) => {
    sends++;
    return first.send(options?.abortSignal, options?.onDispatch);
  });
  f.socket.send({ ...frame("android"), id: "holder" });
  await drainUntil(() => first.dispatched, { description: "same socket holder dispatch" });
  const requests = spyOn(f.server, "handleRequest");
  f.socket.send({ ...frame("android"), id: "queued" });
  const queued = requests.mock.results.at(-1)!;
  expect(queued.type).toBe("return");
  let answered = false;
  if (queued.type === "return") {
    void queued.value.then(
      () => {
        answered = true;
      },
      () => {
        answered = true;
      },
    );
  }
  f.socket.destroy();
  await drainMicrotasks(100);
  try {
    expect(answered).toBe(true);
    expect(sends).toBe(1);
    expect(f.stamps).toEqual(["A"]);
    expect(first.inFlight).toBe(true);
  } finally {
    first.reply();
    await finishSockets(f);
    requests.mockRestore();
  }
  expect(sends).toBe(1);
});
test("text cancelled during target resolution answers and admits another device immediately", async () => {
  const f = socketHarness();
  const target = Promise.withResolvers<BootedDevice>();
  let resolving = false;
  const resolve = f.server.resolveInputTargetDevice;
  f.server.resolveInputTargetDevice = (platform, id) => {
    if (id === "A") {
      resolving = true;
      return target.promise;
    }
    return resolve(platform, id);
  };
  let sent = 0;
  spyOn(f.client, "requestSetText").mockImplementation(async (_text, options) => {
    options?.onDispatch?.();
    sent++;
    return { success: true, totalTimeMs: 0 };
  });
  f.socket.send(frame("android"));
  await drainUntil(() => resolving, { description: "target resolution" });
  cancel(f.socket, "A");
  f.socket.send(frame("android", "other"));
  await drainMicrotasks(100);
  try {
    expect(f.socket.responses.find((r) => r.id === "A")).toMatchObject({ success: false });
    expect(f.socket.responses.find((r) => r.id === "other")).toMatchObject({ success: true });
    expect(sent).toBe(1);
    expect(f.stamps).toEqual(["other"]);
  } finally {
    target.resolve({ platform: "android", deviceId: "A", name: "Fake" });
    await finishSockets(f);
  }
  expect(sent).toBe(1);
  expect(f.stamps).toEqual(["other"]);
});
test.each(["before", "after"] as const)(
  "wire cancellation %s the synchronous dispatch latch cannot answer cancelled and send",
  async (order) => {
    const f = socketHarness();
    const first = runner();
    spyOn(f.client, "requestSetText").mockImplementation((_text, options) => {
      if (order === "before") {
        cancel(f.socket, "A");
      }
      options?.abortSignal?.throwIfAborted();
      const pending = first.send(options?.abortSignal, options?.onDispatch);
      if (order === "after") {
        cancel(f.socket, "A");
      }
      return pending;
    });
    f.socket.send(frame("android"));
    await drainMicrotasks(100);
    try {
      if (order === "before") {
        expect(f.socket.responses.find((r) => r.id === "A")).toMatchObject({ success: false });
        expect(first.dispatched).toBe(false);
        expect(f.stamps).toEqual([]);
      } else {
        expect(first.dispatched).toBe(true);
        expect(f.socket.responses.find((r) => r.id === "A")).toBeUndefined();
      }
    } finally {
      first.reply();
      await drainMicrotasks(100);
      await finishSockets(f);
    }
    if (order === "after") {
      expect(f.socket.responses.find((r) => r.id === "A")?.error).toContain(
        "outcome is indeterminate",
      );
    }
  },
);
test("client cancel wire answer waits for dispatched text and reports indeterminate", async () => {
  const f = socketHarness();
  const { stamps, client, socket, other } = f;
  const first = runner();
  let calls = 0;
  spyOn(client, "requestSetText").mockImplementation((_text, options) => {
    calls++;
    if (calls === 1) {
      return first.send(options?.abortSignal, options?.onDispatch);
    }
    options?.onDispatch?.();
    return Promise.resolve({ success: true, totalTimeMs: 0 });
  });
  socket.send(frame("android"));
  await drainUntil(() => first.dispatched, { description: "wire dispatch" });
  other.send({ ...frame("android"), id: "B" });
  socket.send({
    id: "cancel",
    type: "daemon_request",
    method: "daemon/cancelRequest",
    params: { requestId: "A" },
  });
  await drainUntil(() => socket.responses.some((response) => response.id === "cancel"), {
    description: "cancel ack",
  });
  await drainMicrotasks(100);
  expect(socket.responses.some((response) => response.id === "A")).toBe(false);
  expect(calls).toBe(1);
  expect(stamps).toEqual(["A"]);
  first.reply();
  await drainUntil(() => other.responses.some((response) => response.id === "B"), {
    description: "queued wire response",
  });
  expect(socket.responses.find((response) => response.id === "A")).toMatchObject({
    success: false,
    error: expect.stringContaining("Text input outcome is indeterminate"),
  });
  await finishSockets(f);
});

test("abort during submit holds only the remaining caller budget", async () => {
  const { handler, timer } = harness();
  const first = runner();
  let calls = 0;
  let actionBudget: number | undefined;
  const client = Object.create(IOSCtrlProxyClient.prototype) as IOSCtrlProxyClient;
  spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
  spyOn(client, "requestSetText").mockImplementation(async (_text, options) => {
    calls++;
    options?.onDispatch?.();
    if (calls === 1) {
      timer.advanceTime(200);
    }
    return { success: true, totalTimeMs: 0 };
  });
  spyOn(client, "requestImeAction").mockImplementation(
    (_action, timeout, _perf, signal, dispatch) => {
      actionBudget = timeout;
      return first.send(signal, dispatch);
    },
  );
  const owner = new AbortController();
  const a = handler.handleInputTypeText(frame("ios", "A", false, true), undefined, {
    signal: owner.signal,
  });
  void a.catch(() => {});
  await drainUntil(() => first.dispatched, { description: "submit dispatch" });
  expect(actionBudget).toBe(800);
  timer.advanceTime(100);
  owner.abort(new Error("submit cancelled"));
  const b = handler.handleInputTypeText({ ...frame("ios"), timeoutMs: 2000 });
  timer.advanceTime(699);
  await drainMicrotasks(100);
  expect(calls).toBe(1);
  timer.advanceTime(1);
  await expect(a).rejects.toThrow("outcome is indeterminate");
  await b;
  expect(calls).toBe(2);
  first.reply();
  await drainMicrotasks(100);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(handler.mcpForwardTails.size).toBe(0);
});
