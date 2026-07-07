import { beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import type { BootedDevice } from "../../../../src/models";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("CtrlProxyDatabase (iOS)", function() {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort = 8765;

  beforeEach(function() {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };
    IOSCtrlProxyClient.resetInstances();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: unknown): void {
      this.sentMessages.push(String(data));
      super.send(data);
    }
  }

  const createCapturingFactory = (): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, fakeTimer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) { return; }
    await new Promise<void>(resolve => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i += 1) {
      const socket = getSocket();
      if (socket) { return socket; }
      await new Promise(resolve => setImmediate(resolve));
    }
    return getSocket();
  };

  const waitForSentMessages = async (socket: CapturingWebSocket | null, minCount = 1): Promise<void> => {
    if (!socket) { return; }
    for (let i = 0; i < 10; i += 1) {
      if (commandPayloads(socket).length >= minCount) { return; }
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  const syncMessageTypes = new Set([
    "set_hierarchy_poll_interval",
    "set_network_mock_rules",
    "set_network_error_simulation",
  ]);

  const commandPayloads = (socket: CapturingWebSocket): any[] =>
    socket.sentMessages
      .map(message => JSON.parse(message))
      .filter(payload => !syncMessageTypes.has(payload.type));

  test("executeSQLForIos sends execute_sql and returns query rows including blob strings", async function() {
    const { factory, getSocket } = createCapturingFactory();
    const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

    try {
      const resultPromise = client.executeSQLForIos("com.example.app", "/app/Documents/app.db", "SELECT id, payload FROM notes");
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket);

      const sentMessage = commandPayloads(socket!)[0];
      expect(sentMessage.type).toBe("execute_sql");
      expect(sentMessage.appId).toBe("com.example.app");
      expect(sentMessage.databasePath).toBe("/app/Documents/app.db");
      expect(sentMessage.query).toBe("SELECT id, payload FROM notes");

      socket!.simulateMessage(JSON.stringify({
        type: "execute_sql_result",
        requestId: sentMessage.requestId,
        success: true,
        queryType: "query",
        columns: ["id", "payload"],
        rows: [["1", "0xCAFE"]],
        rowsAffected: 0,
        totalTimeMs: 4,
      }));

      await expect(resultPromise).resolves.toEqual({
        type: "query",
        columns: ["id", "payload"],
        rows: [["1", "0xCAFE"]],
      });
    } finally {
      await client.close();
    }
  });

  test("executeSQLForIos returns mutation rowsAffected", async function() {
    const { factory, getSocket } = createCapturingFactory();
    const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

    try {
      const resultPromise = client.executeSQLForIos("com.example.app", "/app/Documents/app.db", "UPDATE notes SET title = 'x'");
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket);
      const sentMessage = commandPayloads(socket!)[0];

      socket!.simulateMessage(JSON.stringify({
        type: "execute_sql_result",
        requestId: sentMessage.requestId,
        success: true,
        queryType: "mutation",
        rowsAffected: 2,
        totalTimeMs: 5,
      }));

      await expect(resultPromise).resolves.toEqual({
        type: "mutation",
        rowsAffected: 2,
      });
    } finally {
      await client.close();
    }
  });

  test("executeSQLForIos surfaces disabled SDK errors without timing out", async function() {
    const { factory, getSocket } = createCapturingFactory();
    const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

    try {
      const resultPromise = client.executeSQLForIos("com.example.app", "/app/Documents/app.db", "SELECT 1");
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket);
      const sentMessage = commandPayloads(socket!)[0];

      socket!.simulateMessage(JSON.stringify({
        type: "execute_sql_result",
        requestId: sentMessage.requestId,
        success: false,
        error: "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)",
        totalTimeMs: 3,
      }));

      await expect(resultPromise).rejects.toThrow("setEnabled(true)");
    } finally {
      await client.close();
    }
  });
});
