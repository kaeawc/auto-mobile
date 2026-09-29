import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
    const instance = AndroidCtrlProxyClient.createForTesting(device, adb, undefined, timer);
    (instance as any).ws = { readyState: WebSocket.CLOSED };
    return instance;
  };

  test("global action clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    spyOn(client as any, "isConnected").mockReturnValue(true);

    const result = await client.requestGlobalAction("back", 5000);

    expect(result.error).toBe("Error: WebSocket not connected");
    expect((client as any).requestManager.getPendingCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("frame validation clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    spyOn(client as any, "isConnected").mockReturnValue(true);

    const result = await client.validateFrameContext("frame", 5000);

    expect(result.error).toBe("Error: WebSocket not connected");
    expect((client as any).requestManager.getPendingCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("device info clears its registration when the socket disconnects before send", async () => {
    const timer = new FakeTimer();
    client = disconnectedClient(timer);
    spyOn(client as any, "connectWebSocket").mockResolvedValue(true);

    const result = await client.requestDeviceInfo(5000);

    expect(result.error).toBe("Error: WebSocket not connected");
    expect((client as any).requestManager.getPendingCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
