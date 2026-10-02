import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import {
  ANDROID_CAPABILITY_FLAGS,
  ANDROID_CAPABILITY_GATED_COMMANDS,
  ANDROID_CAPABILITY_REQUEST_TYPES,
  KNOWN_REQUEST_TYPES,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { sendCommand } from "../../../src/features/observe/DeviceServiceUtils";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { DelegateContext } from "../../../src/features/observe/shared/types";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

const androidDevice: BootedDevice = {
  deviceId: "command-support-android",
  platform: "android",
  isEmulator: true,
  name: "Android",
};
const iosDevice: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone",
};

// Copied in order from android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/WebSocketServer.kt's supportedCommands advertisement.
const androidAdvertisedCommands = [
  "discover_keystore",
  "set_hierarchy_interval",
  "node_selector_actions",
  "request_activate_accessibility_link",
  "request_insert_text",
  "request_insert_text_state",
  "request_commit_text",
  "ime_key_events_v1",
  "gesture_display_id_v1",
  "request_cancel_ime_commit",
  "request_set_keyboard_profile",
  "request_list_keyboard_profiles",
];

async function sendWithClientContext(client: AndroidCtrlProxyClient, messageType: string) {
  const sent: string[] = [];
  const actualContext = client["createDelegateContext"]();
  const context: DelegateContext = {
    ...actualContext,
    ensureConnected: async () => true,
    getWebSocket: () =>
      ({
        readyState: WebSocket.OPEN,
        send: (data: string) => sent.push(data),
      }) as unknown as WebSocket,
  };
  const result = await sendCommand<{ success: boolean; totalTimeMs: number; error?: string }>(
    context,
    {
      idPrefix: "command_support",
      responseType: "command_support_result",
      messageType,
      timeoutMs: 1000,
      onDispatch: (requestId) =>
        context.requestManager.resolve(requestId, { success: true, totalTimeMs: 0 }),
    },
  );
  return { result, sent: sent.map((data) => JSON.parse(data) as { type: string }) };
}

function androidClient(): AndroidCtrlProxyClient {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
  adb.setScreenState(true);
  const timer = new FakeTimer();
  AndroidCtrlProxyClient.resetInstances();
  return AndroidCtrlProxyClient.createForTesting(
    androidDevice,
    adb,
    (url) => new FakeWebSocket(url, "none", 0, timer) as unknown as WebSocket,
    timer,
  );
}

function iosClient(): IOSCtrlProxyClient {
  const timer = new FakeTimer();
  IOSCtrlProxyClient.resetInstances();
  return IOSCtrlProxyClient.createForTesting(
    iosDevice,
    8765,
    (url) => new FakeWebSocket(url, "none", 0, timer) as unknown as WebSocket,
    timer,
  );
}

describe("CtrlProxy command support", () => {
  test("Android delegate fails open until an explicit capability list arrives", () => {
    const client = androidClient();
    const context = client["createDelegateContext"]();
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
    expect(context.isCommandSupported?.("request_insert_text")).toBe(true);
    client["webSocketMessageHandlers"].connected({ type: "connected" });
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
    expect(context.isCommandSupported?.("request_insert_text")).toBe(true);
    client["webSocketMessageHandlers"].connected({
      type: "connected",
      supportedCommands: ["set_hierarchy_interval"],
    });
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
    expect(context.isCommandSupported?.("request_ime_action")).toBe(true);
    expect(context.isCommandSupported?.("request_insert_text")).toBe(false);
  });

  test("Android capability gate matches the advertised optional commands", () => {
    const known = new Set<string>(KNOWN_REQUEST_TYPES);
    const flags = new Set<string>(ANDROID_CAPABILITY_FLAGS);
    expect(ANDROID_CAPABILITY_GATED_COMMANDS).toEqual(new Set(androidAdvertisedCommands));
    for (const command of ANDROID_CAPABILITY_GATED_COMMANDS) {
      expect(known.has(command) || flags.has(command)).toBe(true);
    }
    for (const command of ANDROID_CAPABILITY_REQUEST_TYPES) {
      expect(known.has(command)).toBe(true);
    }
    for (const flag of ANDROID_CAPABILITY_FLAGS) {
      expect(known.has(flag)).toBe(false);
    }
  });

  test("Android sends core commands with the advertised capabilities", async () => {
    const client = androidClient();
    client["webSocketMessageHandlers"].connected({
      type: "connected",
      supportedCommands: androidAdvertisedCommands,
    });
    const context = client["createDelegateContext"]();
    for (const messageType of [
      "request_tap_coordinates",
      "request_swipe",
      "request_two_finger_swipe",
      "request_drag",
      "request_pinch",
      "request_gesture_start",
      "request_set_text",
    ]) {
      expect(context.isCommandSupported?.(messageType)).toBe(true);
      const { result, sent } = await sendWithClientContext(client, messageType);
      expect(result.success).toBe(true);
      expect(sent.map((message) => message.type)).toEqual([messageType]);
    }
  });

  test("Android rejects an absent optional command and sends an advertised one", async () => {
    const client = androidClient();
    client["webSocketMessageHandlers"].connected({
      type: "connected",
      supportedCommands: ["set_hierarchy_interval"],
    });
    const absent = await sendWithClientContext(client, "request_insert_text");
    expect(absent.result.error).toContain("is not supported by the connected device service");
    expect(absent.sent).toEqual([]);
    expect(await client.supportsCommand("request_insert_text")).toBe(false);
    expect(await client.supportsCommand("request_set_text")).toBe(false);
    expect(await client.supportsCommand("set_hierarchy_interval")).toBe(true);
    const present = await sendWithClientContext(client, "set_hierarchy_interval");
    expect(present.result.success).toBe(true);
    expect(present.sent.map((message) => message.type)).toEqual(["set_hierarchy_interval"]);
  });

  test("Android sends core and optional commands before an advertised list arrives", async () => {
    const client = androidClient();
    client["webSocketMessageHandlers"].connected({ type: "connected" });
    for (const messageType of ["request_set_text", "request_insert_text"]) {
      const { result, sent } = await sendWithClientContext(client, messageType);
      expect(result.success).toBe(true);
      expect(sent.map((message) => message.type)).toEqual([messageType]);
    }
  });

  test("Android remembers an unknown command error until reconnection", () => {
    const client = androidClient();
    const context = client["createDelegateContext"]();
    client["webSocketMessageHandlers"].error({
      type: "error",
      error: "Unknown command type: request_select_all",
    });
    expect(context.isCommandSupported?.("request_select_all")).toBe(false);
    expect(context.isCommandSupported?.("request_ime_action")).toBe(true);
    client["webSocketMessageHandlers"].connected({ type: "connected" });
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
  });

  test("iOS remembers an unknown command error until reconnection", () => {
    const client = iosClient();
    const context = client["createDelegateContext"]();
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
    client["processMessage"]({
      type: "error",
      requestId: "unknown-command",
      error: "Unknown command type: request_select_all",
    });
    expect(context.isCommandSupported?.("request_select_all")).toBe(false);
    expect(context.isCommandSupported?.("request_ime_action")).toBe(true);
    client["processMessage"]({ type: "connected" });
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
  });

  test("iOS still treats advertised commands as a complete list", () => {
    const client = iosClient();
    client["processMessage"]({ type: "connected", supportedCommands: ["request_set_text"] });
    const context = client["createDelegateContext"]();
    expect(context.isCommandSupported?.("request_set_text")).toBe(true);
    expect(context.isCommandSupported?.("request_tap_coordinates")).toBe(false);
  });
});
