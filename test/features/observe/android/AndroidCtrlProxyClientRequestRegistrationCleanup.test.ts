import { logger, type Logger } from "../../../../src/utils/logger";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeLogger } from "../../../fakes/FakeLogger";
import {
  createInstantFailureWebSocketFactory,
  FakeWebSocket,
  WebSocketState,
} from "../../../fakes/FakeWebSocket";

describe("AndroidCtrlProxyClient request registration cleanup", () => {
  const device: BootedDevice = {
    deviceId: "request-registration-cleanup",
    platform: "android",
    isEmulator: true,
    name: "Test Device",
  };
  let client: AndroidCtrlProxyClient | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.resetInstances();
  });

  const disconnectedClient = (
    timer: FakeTimer,
    loggerInstance?: Logger,
  ): AndroidCtrlProxyClient => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    adb.setScreenState(true);
    const instance = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        socket.readyState = WebSocketState.CLOSED;
        return socket;
      },
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loggerInstance,
    );
    return instance;
  };

  test("global action clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();
    client = disconnectedClient(timer, log);
    spyOn(client, "isConnected").mockReturnValue(true);

    const result = await client.requestGlobalAction("back", 5000);
    expect(result.success).toBe(false);
    expect(log.at("warn")).toContainEqual({
      level: "warn",
      message: "[CTRL_PROXY] Global action failed: WebSocket not connected",
      args: [expect.any(Error)],
    });
    expect(result.error).toBe("Error: WebSocket not connected");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("frame validation clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();
    client = disconnectedClient(timer, log);
    spyOn(client, "isConnected").mockReturnValue(true);

    const result = await client.validateFrameContext("frame", 5000);
    expect(result.success).toBe(false);
    expect(log.at("warn")).toContainEqual({
      level: "warn",
      message: "[CTRL_PROXY] Frame validation failed: WebSocket not connected",
      args: [expect.any(Error)],
    });
    expect(result.error).toBe("Error: WebSocket not connected");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("device info retains its failure when dispatch throws and warns", async () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();
    client = disconnectedClient(timer, log);
    spyOn(client, "connectWebSocket").mockRejectedValue(new Error("connection denied"));
    const result = await client.requestDeviceInfo(5000);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Error: connection denied");
    expect(log.at("warn")).toContainEqual({
      level: "warn",
      message: "[CTRL_PROXY] Device info failed: connection denied",
      args: [expect.any(Error)],
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("reset clears singleton state even when close rejects and warns", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    AndroidCtrlProxyClient["instances"].set(device.deviceId, client);
    const close = spyOn(client, "close").mockRejectedValue(new Error("close denied"));
    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(AndroidCtrlProxyClient.resetInstances()).toBeUndefined();
      await Promise.resolve();
      expect(AndroidCtrlProxyClient["instances"].size).toBe(0);
      expect(log).toHaveBeenCalledWith(
        "[CTRL_PROXY] Instance reset cleanup failed: close denied",
        expect.any(Error),
      );
    } finally {
      close.mockRestore();
      log.mockRestore();
    }
  });

  test("reset logs close rejection through the injected logger", async () => {
    const timer = new FakeTimer();
    const log = new FakeLogger();
    const instance = disconnectedClient(timer, log);
    AndroidCtrlProxyClient.registerForTesting(instance, device.deviceId);
    const error = new Error("boom");
    const close = spyOn(instance, "close").mockRejectedValue(error);
    const globalWarn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      AndroidCtrlProxyClient.resetInstances();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(log.at("warn")).toContainEqual({
        level: "warn",
        message: "[CTRL_PROXY] Instance reset cleanup failed: boom",
        args: [error],
      });
      expect(globalWarn).not.toHaveBeenCalled();
    } finally {
      close.mockRestore();
      globalWarn.mockRestore();
    }
  });

  test("device info clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    adb.setScreenState(true);
    client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      createInstantFailureWebSocketFactory(timer),
      timer,
    );
    const result = await client.requestDeviceInfo(5000);

    expect(result.error).toBe("Failed to connect to accessibility service");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
