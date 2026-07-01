import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

/**
 * End-to-end WebSocket round-trip tests for the storage subscribe/unsubscribe lifecycle on the
 * Android CtrlProxy client. These pin the wire contract between the device (which emits flat
 * packageName/fileName/subscriptionId fields) and the TS client (which awaits a resolved promise),
 * so a timeout-only resolution or a dropped field is caught here.
 */
describe("CtrlProxyStorage (Android)", function() {
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function() {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    testDevice = {
      deviceId: "test-device-storage",
      platform: "android",
      isEmulator: true,
      name: "Test Device"
    };

    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(testDevice, new FakeAdbClientFactory()).clearAvailabilityCache();
  });

  afterEach(function() {
    NavigationGraphManager.getInstance();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];
    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  const createCapturingFactory = (timer?: FakeTimer): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {return;}
    await new Promise<void>(resolve => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (getSocket: () => CapturingWebSocket | null): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {return s;}
      await new Promise(r => setImmediate(r));
    }
    return getSocket();
  };

  const waitForSentMessages = async (socket: CapturingWebSocket | null, minCount = 1): Promise<void> => {
    if (!socket) {return;}
    for (let i = 0; i < 10; i++) {
      if (socket.sentMessages.length >= minCount) {return;}
      await new Promise(r => setImmediate(r));
    }
  };

  const findSentMessage = (socket: CapturingWebSocket, type: string): any => {
    for (let i = socket.sentMessages.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(socket.sentMessages[i]);
        if (parsed.type === type) {return parsed;}
      } catch {
        // skip non-JSON control frames
      }
    }
    throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
  };

  describe("subscribeStorage", function() {
    test("resolves with a subscription rebuilt from the device's flat result fields", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.subscribeStorage("com.example", "settings.xml");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "subscribe_storage");
        expect(sent.packageName).toBe("com.example");
        expect(sent.fileName).toBe("settings.xml");

        // The device emits flat fields (no nested `subscription` object).
        socket!.simulateMessage(JSON.stringify({
          type: "subscribe_storage_result",
          requestId: sent.requestId,
          success: true,
          packageName: "com.example",
          fileName: "settings.xml",
          subscriptionId: "com.example:settings.xml",
          totalTimeMs: 5,
        }));

        const subscription = await resultPromise;
        expect(subscription.subscriptionId).toBe("com.example:settings.xml");
        expect(subscription.packageName).toBe("com.example");
        expect(subscription.fileName).toBe("settings.xml");
      } finally {
        await client.close();
      }
    });

    test("rejects when the device reports failure", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.subscribeStorage("com.example", "settings.xml");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket!, "subscribe_storage");

        socket!.simulateMessage(JSON.stringify({
          type: "subscribe_storage_result",
          requestId: sent.requestId,
          success: false,
          packageName: "com.example",
          fileName: "settings.xml",
          error: "SDK not installed",
        }));

        await expect(resultPromise).rejects.toThrow("SDK not installed");
      } finally {
        await client.close();
      }
    });
  });

  describe("unsubscribeStorage", function() {
    test("sends the subscriptionId and resolves on the device's result", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.unsubscribeStorage("com.example:settings.xml");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "unsubscribe_storage");
        expect(sent.subscriptionId).toBe("com.example:settings.xml");

        socket!.simulateMessage(JSON.stringify({
          type: "unsubscribe_storage_result",
          requestId: sent.requestId,
          success: true,
          packageName: "com.example",
          fileName: "settings.xml",
          totalTimeMs: 3,
        }));

        // Resolves (does not hang until timeout) — this is the bug the device-side fix repairs.
        await expect(resultPromise).resolves.toBeUndefined();
      } finally {
        await client.close();
      }
    });
  });
});
