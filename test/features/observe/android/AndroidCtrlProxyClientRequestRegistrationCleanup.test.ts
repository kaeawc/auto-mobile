import { logger } from "../../../../src/utils/logger";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
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

  const disconnectedClient = (timer: FakeTimer): AndroidCtrlProxyClient => {
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
    );
    return instance;
  };

  test("global action clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    spyOn(client, "isConnected").mockReturnValue(true);

    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await client.requestGlobalAction("back", 5000);
      expect(result.success).toBe(false);
      expect(log).toHaveBeenCalledWith(
        "[CTRL_PROXY] Global action failed: WebSocket not connected",
        expect.any(Error),
      );
      expect(result.error).toBe("Error: WebSocket not connected");
    } finally {
      log.mockRestore();
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("frame validation clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    spyOn(client, "isConnected").mockReturnValue(true);

    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await client.validateFrameContext("frame", 5000);
      expect(result.success).toBe(false);
      expect(log).toHaveBeenCalledWith(
        "[CTRL_PROXY] Frame validation failed: WebSocket not connected",
        expect.any(Error),
      );
      expect(result.error).toBe("Error: WebSocket not connected");
    } finally {
      log.mockRestore();
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("device info retains its failure when dispatch throws and warns", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    spyOn(client, "connectWebSocket").mockRejectedValue(new Error("connection denied"));
    const log = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await client.requestDeviceInfo(5000);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Error: connection denied");
      expect(log).toHaveBeenCalledWith(
        "[CTRL_PROXY] Device info failed: connection denied",
        expect.any(Error),
      );
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      log.mockRestore();
    }
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
