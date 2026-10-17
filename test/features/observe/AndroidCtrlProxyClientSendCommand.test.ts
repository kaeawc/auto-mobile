import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import {
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
  type CtrlProxyRequest,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  sendError?: Error;
  onFrame?: () => void;
  override send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    super.send(data);
    this.frames.push(data);
    this.onFrame?.();
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "client-send-command", platform: "android", name: "Android", isEmulator: true },
    new FakeAdbExecutor(),
    {
      webSocketFactory: () => socket as unknown as WebSocket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new CountingIdGenerator("delegate"),
    },
  );
  await Promise.resolve();
  client["ws"] = socket as unknown as WebSocket;
  client["supportedCommands"] = new Set([
    "request_activate_accessibility_link",
    "discover_keystore",
    "tap_double_v1",
  ]);
  const manager = client["requestManager"];
  const ids = new CountingIdGenerator("wire");
  manager.generateId = (prefix) => `${prefix}_${ids.next()}`;
  client.ensureConnected = async () => true;
  client["connectWebSocket"] = async () => true;
  client["cancelScreenshotBackoff"] = () => {};
  return { client, timer, socket, manager };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const perf = new NoOpPerformanceTracker();
async function flushDispatch() {
  for (let i = 0; i < 32; i++) {
    await Promise.resolve();
  }
}

interface Method {
  name: string;
  invoke: (h: Harness, signal?: AbortSignal, onDispatch?: () => void) => Promise<unknown>;
  frame: (requestId: string) => CtrlProxyRequest;
  literal: string;
  timeout: string;
  acknowledged?: boolean;
}
const selector = { resourceId: "res/id", text: "label", occurrence: 2 };
const methods: Method[] = [
  {
    name: "requestAction",
    invoke: (h, signal) => h.client.requestAction("click", "res/id", 50, perf, selector, signal),
    frame: (requestId) =>
      ctrlProxyRequests.requestAction({
        requestId,
        action: "click",
        resourceId: "res/id",
        selector,
      }),
    literal:
      '{"type":"request_action","requestId":"action_wire-1","action":"click","resourceId":"res/id","selector":{"resourceId":"res/id","text":"label","occurrence":2}}',
    timeout: "Action timeout after 50ms",
    acknowledged: true,
  },
  {
    name: "requestNodeAction",
    invoke: (h, signal) => h.client.requestNodeAction("click", selector, 50, perf, signal),
    frame: (requestId) =>
      ctrlProxyRequests.requestAction({
        requestId,
        action: "click",
        resourceId: "res/id",
        selector,
      }),
    literal:
      '{"type":"request_action","requestId":"action_wire-1","action":"click","resourceId":"res/id","selector":{"resourceId":"res/id","text":"label","occurrence":2}}',
    timeout: "Action timeout after 50ms",
    acknowledged: true,
  },
  {
    name: "requestAction omits undefined resource and selector",
    invoke: (h, signal) => h.client.requestAction("focus", undefined, 50, perf, undefined, signal),
    frame: (requestId) => ctrlProxyRequests.requestAction({ requestId, action: "focus" }),
    literal: '{"type":"request_action","requestId":"action_wire-1","action":"focus"}',
    timeout: "Action timeout after 50ms",
    acknowledged: true,
  },
  {
    name: "requestClickFocusedInput",
    invoke: (h, signal) => h.client.requestClickFocusedInput(50, perf, signal),
    frame: (requestId) => ctrlProxyRequests.requestClickFocusedInput({ requestId }),
    literal: '{"type":"request_click_focused_input","requestId":"action_wire-1"}',
    timeout: "Action timeout after 50ms",
    acknowledged: true,
  },
  {
    name: "requestActivateAccessibilityLink",
    invoke: (h, signal, onDispatch) =>
      h.client.requestActivateAccessibilityLink(
        " link ",
        2,
        selector,
        50,
        perf,
        signal,
        onDispatch,
      ),
    frame: (requestId) =>
      ctrlProxyRequests.requestActivateAccessibilityLink({
        requestId,
        text: " link ",
        occurrence: 2,
        selector,
      }),
    literal:
      '{"type":"request_activate_accessibility_link","requestId":"accessibility-link_wire-1","text":" link ","occurrence":2,"selector":{"resourceId":"res/id","text":"label","occurrence":2}}',
    timeout: "Semantic link activation timed out after 50ms",
    acknowledged: true,
  },
  {
    name: "requestClipboard copy",
    invoke: (h, signal, onDispatch) =>
      h.client.requestClipboard("copy", " text ", 50, perf, signal, onDispatch),
    frame: (requestId) =>
      ctrlProxyRequests.requestClipboard({ requestId, action: "copy", text: " text " }),
    literal:
      '{"type":"request_clipboard","requestId":"clipboard_wire-1","action":"copy","text":" text "}',
    timeout: "Clipboard copy timeout after 50ms",
    acknowledged: true,
  },
  ...(["get", "clear", "paste"] as const).map((action): Method => ({
    name: `requestClipboard ${action}`,
    invoke: (h, signal, onDispatch) =>
      h.client.requestClipboard(action, undefined, 50, perf, signal, onDispatch),
    frame: (requestId) => ctrlProxyRequests.requestClipboard({ requestId, action }),
    literal: `{"type":"request_clipboard","requestId":"clipboard_wire-1","action":"${action}"}`,
    timeout: `Clipboard ${action} timeout after 50ms`,
    acknowledged: true,
  })),
  {
    name: "requestGlobalAction",
    invoke: (h, signal, onDispatch) =>
      h.client.requestGlobalAction("back", 50, perf, "frame", signal, onDispatch),
    frame: (requestId) =>
      ctrlProxyRequests.requestGlobalAction({ requestId, action: "back", frameContext: "frame" }),
    literal:
      '{"type":"request_global_action","requestId":"global_action_wire-1","action":"back","frameContext":"frame"}',
    timeout: "Global action timeout after 50ms",
    acknowledged: true,
  },
  {
    name: "validateFrameContext",
    invoke: (h, signal) => h.client.validateFrameContext("frame", 50, signal),
    frame: (requestId) =>
      ctrlProxyRequests.validateFrameContext({ requestId, frameContext: "frame" }),
    literal:
      '{"type":"validate_frame_context","requestId":"validate_frame_context_wire-1","frameContext":"frame"}',
    timeout: "Frame context validation timeout after 50ms",
  },
  {
    name: "requestDeviceInfo",
    invoke: (h) => h.client.requestDeviceInfo(50, perf),
    frame: (requestId) => ctrlProxyRequests.requestDeviceInfo({ requestId }),
    literal: '{"type":"request_device_info","requestId":"device_info_wire-1"}',
    timeout: "Device info timeout after 50ms",
  },
];
for (const method of methods) {
  describe(method.name, () => {
    test("preserves literal builder bytes and bypasses the generic command gate", async () => {
      const h = await harness();
      const frame = JSON.parse(method.literal);
      h.client["rejectedCommands"].add(frame.type);
      // Link activation retains its explicit capability check.
      if (method.name === "requestActivateAccessibilityLink") {
        h.client["rejectedCommands"].delete(frame.type);
      }
      let dispatches = 0;
      const pending = method.invoke(h, undefined, () => {
        expect(h.socket.frames).toEqual([method.literal]);
        dispatches++;
      });
      await flushDispatch();
      expect(h.socket.frames).toEqual([method.literal]);
      expect(h.socket.frames[0]).toBe(serializeCtrlProxyRequest(method.frame(frame.requestId)));
      h.manager.resolve(frame.requestId, { success: true, totalTimeMs: 7 });
      await pending;
      expect(dispatches).toBe(
        /requestClipboard|requestGlobalAction|requestActivateAccessibilityLink/.test(method.name)
          ? 1
          : 0,
      );
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });
    test("preserves timeout text and does not acknowledge a timeout", async () => {
      const h = await harness();
      const pending = method.invoke(h);
      await flushDispatch();
      expect(h.manager.getPendingCount()).toBe(1);
      h.timer.advanceTime(50);
      const result = await pending;
      expect(result).toMatchObject({ success: false, error: method.timeout });
      if (method.acknowledged) {
        expect(result).toMatchObject({ acknowledged: false });
      }
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });
  });
}

for (const method of methods) {
  test(`${method.name} preserves device error settlement`, async () => {
    const h = await harness();
    const pending = method.invoke(h);
    await flushDispatch();
    const frame = JSON.parse(method.literal);
    h.manager.resolveError(frame.requestId, "device refused", 17);
    const result = await pending;
    expect(result).toMatchObject({ success: false, error: "device refused", totalTimeMs: 17 });
    if (method.acknowledged) {
      expect(result).toMatchObject({ acknowledged: true });
    }
    if (/requestClipboard|requestGlobalAction/.test(method.name)) {
      // These requests historically use RequestManager's default error shape.
      expect(result).toEqual({
        success: false,
        error: "device refused",
        totalTimeMs: 17,
        acknowledged: true,
      });
    }
    expect(h.manager.getPendingCount()).toBe(0);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });
  if (method.name !== "requestDeviceInfo") {
    test(`${method.name} settles abort during the send`, async () => {
      const h = await harness();
      const controller = new AbortController();
      h.socket.onFrame = () => controller.abort(new Error("cancelled during send"));
      const result = await method.invoke(h, controller.signal);
      expect(result).toMatchObject({ success: false });
      if (method.acknowledged) {
        expect(result).toMatchObject({ acknowledged: false });
      }
      if (method.name === "requestActivateAccessibilityLink") {
        expect(result).toMatchObject({ dispatched: true, retryable: false });
      }
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });
  }
}

test("device info remains uncancellable under an aborted ambient request", async () => {
  const h = await harness();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const pending = runWithAbortSignal(controller.signal, () => h.client.requestDeviceInfo(50));
  await flushDispatch();
  expect(h.socket.frames).toEqual([
    '{"type":"request_device_info","requestId":"device_info_wire-1"}',
  ]);
  h.manager.resolve("device_info_wire-1", { success: true, totalTimeMs: 7, sdkInt: 35 });
  expect(await pending).toMatchObject({ success: true, sdkInt: 35 });
  expect(h.manager.getPendingCount()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});
