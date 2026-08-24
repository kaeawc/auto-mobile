import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  WebSocketState,
  createInstantFailureWebSocketFactory,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("CtrlProxyFocus (Android) - set/clear accessibility focus", function () {
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    testDevice = {
      deviceId: "test-device-focus",
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

  afterEach(function () {
    NavigationGraphManager.getInstance();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];
    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  const createCapturingFactory = (
    timer?: FakeTimer,
  ): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await new Promise((r) => setImmediate(r));
    }
    return getSocket();
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 10; i++) {
      if (socket.sentMessages.length >= minCount) {
        return;
      }
      await new Promise((r) => setImmediate(r));
    }
  };

  const findSentMessage = (socket: CapturingWebSocket, type: string): any => {
    for (let i = socket.sentMessages.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(socket.sentMessages[i]);
        if (parsed.type === type) {
          return parsed;
        }
      } catch {
        // skip
      }
    }
    throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
  };

  test("setAccessibilityFocus sends request_action with action='focus' and resolves on success", async function () {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);

      const baseCount = socket!.sentMessages.length;
      const resultPromise = client.setAccessibilityFocus("com.example:id/title");
      await waitForSentMessages(socket, baseCount + 1);

      const sent = findSentMessage(socket!, "request_action");
      expect(sent.action).toBe("focus");
      expect(sent.resourceId).toBe("com.example:id/title");

      socket!.simulateMessage(
        JSON.stringify({
          type: "action_result",
          requestId: sent.requestId,
          action: "focus",
          success: true,
          totalTimeMs: 5,
        }),
      );

      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("clearAccessibilityFocus sends request_action with action='clear_focus'", async function () {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);

      const baseCount = socket!.sentMessages.length;
      const resultPromise = client.clearAccessibilityFocus("com.example:id/title");
      await waitForSentMessages(socket, baseCount + 1);

      const sent = findSentMessage(socket!, "request_action");
      expect(sent.action).toBe("clear_focus");
      expect(sent.resourceId).toBe("com.example:id/title");

      socket!.simulateMessage(
        JSON.stringify({
          type: "action_result",
          requestId: sent.requestId,
          action: "clear_focus",
          success: true,
          totalTimeMs: 3,
        }),
      );

      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("setAccessibilityFocus throws with the service error on node-not-found", async function () {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);

      const baseCount = socket!.sentMessages.length;
      const resultPromise = client.setAccessibilityFocus("com.example:id/missing");
      await waitForSentMessages(socket, baseCount + 1);

      const sent = findSentMessage(socket!, "request_action");
      socket!.simulateMessage(
        JSON.stringify({
          type: "action_result",
          requestId: sent.requestId,
          action: "focus",
          success: false,
          error: "Element not found with resource-id: com.example:id/missing",
          totalTimeMs: 1,
        }),
      );

      await expect(resultPromise).rejects.toThrow(/Element not found with resource-id/);
    } finally {
      await client.close();
    }
  });

  test("setAccessibilityFocus rejects empty resource-id without sending a request", async function () {
    const { factory } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await expect(client.setAccessibilityFocus("")).rejects.toThrow(/requires a resource-id/);
    } finally {
      await client.close();
    }
  });

  test("setAccessibilityFocus surfaces the timeout error when no result arrives", async function () {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);

      // Use a short timeout; never simulate a result so the RequestManager times out.
      await expect(client.setAccessibilityFocus("com.example:id/title", 50)).rejects.toThrow(
        /timeout/i,
      );
    } finally {
      await client.close();
    }
  });

  test("setAccessibilityFocus throws a connection error when the socket cannot connect", async function () {
    // Drive a genuine connection failure: sendAction calls ensureConnected itself, so an
    // instant-failure socket makes ensureConnected return false and the delegate surfaces the
    // "Failed to connect to accessibility service" error. The /connect/i matcher pins THAT cause
    // so a harness TypeError can no longer masquerade as a connection failure (the old bare
    // rejects.toThrow() accepted any throw, and — because the capturing socket connects fine —
    // actually exercised the RequestManager timeout path, duplicating the timeout test above).
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
    );
    try {
      await expect(client.setAccessibilityFocus("com.example:id/title", 50)).rejects.toThrow(
        /connect/i,
      );
    } finally {
      await client.close();
    }
  });
});
