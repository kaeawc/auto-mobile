import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
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
    client["webSocketMessageHandlers"].connected({ type: "connected" });
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
    client["webSocketMessageHandlers"].connected({
      type: "connected",
      supportedCommands: ["request_select_all"],
    });
    expect(context.isCommandSupported?.("request_select_all")).toBe(true);
    expect(context.isCommandSupported?.("request_ime_action")).toBe(false);
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
});
