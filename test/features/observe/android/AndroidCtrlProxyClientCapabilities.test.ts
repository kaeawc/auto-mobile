import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { PortManager } from "../../../../src/utils/PortManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

describe("AndroidCtrlProxyClient node action selector capabilities", function () {
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let testDevice: BootedDevice;

  beforeEach(function () {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    testDevice = {
      deviceId: "test-device-capabilities",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      testDevice,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
  });

  afterEach(async function () {
    AndroidCtrlProxyClient.resetInstances();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("waits for the connected handshake before reading node selector support", async function () {
    let socket: FakeWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket as unknown as WebSocket;
      },
      fakeTimer,
    );

    try {
      await client.ensureConnected();
      const supported = client.supportsNodeActionSelectors();
      let resolved = false;
      void supported.then(() => {
        resolved = true;
      });

      await waitForPendingSleep(fakeTimer);
      expect(resolved).toBe(false);
      socket!.simulateMessage(
        JSON.stringify({
          type: "connected",
          supportedCommands: ["node_selector_actions"],
        }),
      );
      fakeTimer.resolveAll();

      await expect(supported).resolves.toBe(true);
    } finally {
      await client.close();
    }
  });

  test("returns the command set only after the connected handshake", async function () {
    let socket: FakeWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket as unknown as WebSocket;
      },
      fakeTimer,
    );

    try {
      await client.ensureConnected();
      const supported = client.getSupportedCommands();
      await waitForPendingSleep(fakeTimer);
      socket!.simulateMessage(
        JSON.stringify({
          type: "connected",
          supportedCommands: ["request_press_key", "request_insert_text"],
        }),
      );
      fakeTimer.resolveAll();

      await expect(supported).resolves.toEqual(["request_insert_text", "request_press_key"]);
    } finally {
      await client.close();
    }
  });
  test("cancels a pending connection without closing the shared client", async () => {
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      undefined,
      fakeTimer,
    );
    let finish!: (connected: boolean) => void;
    const connection = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const connect = spyOn(client as any, "connectWebSocket").mockReturnValue(connection);
    const close = spyOn(client, "close");
    const controller = new AbortController();
    let settled = false;
    const result = client.supportsNodeActionSelectors(undefined, controller.signal).catch(() => {
      settled = true;
    });
    controller.abort();
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
    expect(close).not.toHaveBeenCalled();
    finish(true);
    await result;
    connect.mockRestore();
    close.mockRestore();
    await client.close();
  });

  test("cancels handshake polling and removes its timer", async () => {
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      undefined,
      fakeTimer,
    );
    const connect = spyOn(client as any, "connectWebSocket").mockResolvedValue(true);
    const controller = new AbortController();
    let settled = false;
    const result = client.supportsNodeActionSelectors(undefined, controller.signal).catch(() => {
      settled = true;
    });
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    controller.abort();
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(fakeTimer.getPendingSleepCount()).toBe(0);
    await result;
    connect.mockRestore();
    await client.close();
  });

  test("does not dispatch an action when cancellation wins the connection wait", async () => {
    let socket!: FakeWebSocket;
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket as unknown as WebSocket;
      },
      fakeTimer,
    );
    await client.ensureConnected();
    const send = spyOn(socket, "send");
    let finish!: (connected: boolean) => void;
    const connect = spyOn(client as any, "connectWebSocket").mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    let settled = false;
    const result = client
      .requestNodeAction("click", { uniqueId: "row" }, 5000, undefined, controller.signal)
      .then((value) => {
        settled = true;
        return value;
      });
    controller.abort();
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
    finish(true);
    expect((await result).success).toBe(false);
    expect((client as any).requestManager.getPendingCount()).toBe(0);
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
    connect.mockRestore();
    await client.close();
  });

  test.each([true, false])(
    "cancels a sent action, cleans correlation, and ignores late success=%s",
    async (success) => {
      let socket!: FakeWebSocket;
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        (url) => {
          socket = new FakeWebSocket(url, "none", 0, fakeTimer);
          return socket as unknown as WebSocket;
        },
        fakeTimer,
      );
      await client.ensureConnected();
      const controller = new AbortController();
      const add = spyOn(controller.signal, "addEventListener");
      const remove = spyOn(controller.signal, "removeEventListener");
      const result = client.requestNodeAction(
        "click",
        { uniqueId: "row" },
        5000,
        undefined,
        controller.signal,
      );
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      const manager = (client as any).requestManager;
      const [requestId] = manager.getPendingIds();
      expect(requestId).toBeDefined();
      controller.abort();
      for (let i = 0; i < 12; i++) {
        await Promise.resolve();
      }
      expect(manager.getPendingCount()).toBe(0);
      socket.simulateMessage(
        JSON.stringify({
          type: "action_result",
          requestId,
          success,
          action: "click",
          totalTimeMs: 1,
        }),
      );
      expect((await result).success).toBe(false);
      expect(client.isConnected()).toBe(true);
      expect(remove.mock.calls.length).toBe(add.mock.calls.length);
      add.mockRestore();
      remove.mockRestore();
      await client.close();
    },
  );
  test("already-aborted requests never start connection work", async () => {
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      undefined,
      fakeTimer,
    );
    const connect = spyOn(client as any, "connectWebSocket").mockResolvedValue(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.supportsNodeActionSelectors(undefined, controller.signal),
    ).rejects.toThrow();
    expect(
      (
        await client.requestNodeAction(
          "click",
          { uniqueId: "row" },
          5000,
          undefined,
          controller.signal,
        )
      ).success,
    ).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
    await client.close();
  });

  test.each(["response", "send failure"])("cleans up when cancellation races %s", async (mode) => {
    let socket!: FakeWebSocket;
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket as unknown as WebSocket;
      },
      fakeTimer,
    );
    await client.ensureConnected();
    const controller = new AbortController();
    const send = spyOn(socket, "send").mockImplementation((data) => {
      const message = JSON.parse(String(data));
      if (mode === "send failure") {
        throw new Error("send failed");
      }
      socket.simulateMessage(
        JSON.stringify({
          type: "action_result",
          requestId: message.requestId,
          success: true,
          action: "click",
          totalTimeMs: 1,
        }),
      );
      controller.abort();
    });
    const result = await client.requestNodeAction(
      "click",
      { uniqueId: "row" },
      5000,
      undefined,
      controller.signal,
    );
    expect(result.success).toBe(false);
    expect(result.action).toBe("click");
    expect((client as any).requestManager.getPendingCount()).toBe(0);
    expect(client.isConnected()).toBe(true);
    send.mockRestore();
    await client.close();
  });
});

async function waitForPendingSleep(timer: FakeTimer): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (timer.getPendingSleepCount() > 0) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected the capability probe to wait for the connected handshake");
}
