import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient, CtrlProxyHierarchy } from "../../../../src/features/observe/ios";
import { BootedDevice, HighlightShape } from "../../../../src/models";
import { NetworkState } from "../../../../src/server/NetworkState";
import { serverConfig } from "../../../../src/utils/ServerConfig";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  WebSocketState
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeScreenshotBackoffScheduler } from "../../../../src/features/observe/ScreenshotBackoffScheduler";
import type { DeviceConnectionLostNotifier } from "../../../../src/features/observe/DeviceConnectionLostNotifier";
import { FakeIosSdkEventIngestor } from "../../../fakes/FakeIosSdkEventIngestor";

describe("IOSCtrlProxyClient", function() {
  let ctrlProxyClient: IOSCtrlProxyClient;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function() {
    // Create fake timer with auto-advance for fast tests
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Create test device (iOS simulator format)
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator"
    };

    // Reset singleton instances for clean test state
    IOSCtrlProxyClient.resetInstances();
    NetworkState.resetInstance();
    serverConfig.setNetworkMockableEnabled(false);

    ctrlProxyClient = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer
    );
  });

  afterEach(async function() {
    // Clean up WebSocket connections
    if (ctrlProxyClient) {
      await ctrlProxyClient.close();
    }
    NetworkState.resetInstance();
    serverConfig.setNetworkMockableEnabled(false);
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: unknown): void {
      this.sentMessages.push(String(data));
      super.send(data);
    }
  }

  const createCapturingWebSocketFactory = (timer?: FakeTimer | undefined): {
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

  const createConnectionTimeoutWebSocketFactory = (timer: FakeTimer): (url: string) => FakeWebSocket =>
    url => new FakeWebSocket(url, "timeout", 60000, timer);

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>(resolve => {
      socket.once("open", () => resolve());
    });
  };

  const waitForSocket = async (getSocket: () => FakeWebSocket | null): Promise<FakeWebSocket | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const socket = getSocket();
      if (socket) {
        return socket;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    return getSocket();
  };

  const waitForSentMessages = async (socket: CapturingWebSocket | null, minCount: number = 1): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (commandPayloads(socket).length >= minCount) {
        return;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  const syncMessageTypes = new Set([
    "set_network_mock_rules",
    "set_network_error_simulation",
  ]);

  const commandPayloads = (socket: CapturingWebSocket): any[] =>
    socket.sentMessages
      .map(message => JSON.parse(message))
      .filter(payload => !syncMessageTypes.has(payload.type));

  const flushPromises = async (iterations: number = 3): Promise<void> => {
    for (let i = 0; i < iterations; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  describe("connection lifecycle", function() {
    test("cancels screenshot backoff when the connection closes", function() {
      const scheduler = new FakeScreenshotBackoffScheduler();

      (ctrlProxyClient as any).screenshotBackoffScheduler = scheduler;
      (ctrlProxyClient as any).onConnectionClosed();

      expect(scheduler.cancelPendingCapturesCalls).toBe(1);
    });

    test("refreshes screenshot cadence by rescheduling keepalive", function() {
      const scheduler = new FakeScreenshotBackoffScheduler();

      (ctrlProxyClient as any).screenshotBackoffScheduler = scheduler;
      ctrlProxyClient.refreshObservationStreamScreenshotCadence();

      expect(scheduler.rescheduleKeepAliveCalls).toBe(1);
    });

    test("sends hierarchy cadence updates to the runner", function() {
      const sentMessages: string[] = [];
      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };

      (ctrlProxyClient as any).refreshObservationStreamHierarchyCadence(500);

      expect(sentMessages.map(message => JSON.parse(message))).toEqual([{
        type: "set_hierarchy_poll_interval",
        intervalMs: 500,
      }]);
    });

    test("does not send hierarchy cadence updates to stale runners without command support", function() {
      const sentMessages: string[] = [];
      (ctrlProxyClient as any).supportedCommands = new Set(["request_hierarchy"]);
      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };

      (ctrlProxyClient as any).refreshObservationStreamHierarchyCadence(500);

      expect(sentMessages).toEqual([]);
    });

    test("notifies the observation stream when the WebSocket connection closes", function() {
      const lostDeviceIds: string[] = [];
      const notifier: DeviceConnectionLostNotifier = {
        onDeviceConnectionLost: deviceId => {
          lostDeviceIds.push(deviceId);
        },
      };
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
        undefined,
        undefined,
        notifier
      );

      (testClient as any).onConnectionClosed();

      expect(lostDeviceIds).toEqual(["A1B2C3D4-E5F6-7890-ABCD-EF1234567890"]);
    });

    test("restarts screenshot backoff when the connection (re)establishes", function() {
      // Regression guard: onConnectionClosed() cancels the keepalive, so a
      // transient reconnect on a static screen must restart it or the live view
      // freezes forever. startScreenshotBackoff() is itself subscriber-gated.
      let backoffStarts = 0;
      (ctrlProxyClient as any).startScreenshotBackoff = () => { backoffStarts++; };
      // Isolate from SDK polling side effects for this unit.
      (ctrlProxyClient as any).startSdkEventPolling = () => { /* no-op */ };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(backoffStarts).toBe(1);
    });

    test("syncs network mock rules when the connection (re)establishes", function() {
      serverConfig.setNetworkMockableEnabled(true);
      const state = NetworkState.getInstance();
      const mock = state.addMock({
        host: "api\\.example\\.com",
        path: "/v1/items",
        method: "GET",
        limit: 3,
        remaining: 3,
        statusCode: 201,
        responseHeaders: { "X-Test": "yes" },
        responseBody: "{\"ok\":true}",
        contentType: "application/json",
      });
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => { /* no-op */ };
      (ctrlProxyClient as any).startScreenshotBackoff = () => { /* no-op */ };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages.map(message => JSON.parse(message).type)).toEqual([
        "set_network_mock_rules",
        "set_network_error_simulation",
      ]);
      expect(JSON.parse(sentMessages[0])).toEqual({
        type: "set_network_mock_rules",
        rules: [{
          mockId: mock.mockId,
          host: "api\\.example\\.com",
          path: "/v1/items",
          method: "GET",
          limit: 3,
          remaining: 3,
          statusCode: 201,
          responseHeaders: { "X-Test": "yes" },
          responseBody: "{\"ok\":true}",
          contentType: "application/json",
        }],
      });
      expect(JSON.parse(sentMessages[1])).toEqual({
        type: "set_network_error_simulation",
        enabled: false,
      });
    });

    test("clears stale network error simulation when the connection (re)establishes without an active simulation", function() {
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => { /* no-op */ };
      (ctrlProxyClient as any).startScreenshotBackoff = () => { /* no-op */ };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0])).toEqual({
        type: "set_network_error_simulation",
        enabled: false,
      });
    });

    test("does not sync network error simulation to stale runners without command support", function() {
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).supportedCommands = new Set(["set_network_mock_rules"]);
      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => { /* no-op */ };
      (ctrlProxyClient as any).startScreenshotBackoff = () => { /* no-op */ };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages.map(message => JSON.parse(message).type)).not.toContain("set_network_error_simulation");
    });

    test("syncs active network error simulation when the connection (re)establishes", function() {
      const state = NetworkState.getInstance();
      state.startSimulation("tlsFailure", 20, 4);
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => { /* no-op */ };
      (ctrlProxyClient as any).startScreenshotBackoff = () => { /* no-op */ };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0])).toEqual({
        type: "set_network_error_simulation",
        enabled: true,
        errorType: "tlsFailure",
        limit: 4,
        expiresAtEpochMs: expect.any(Number),
      });
    });
  });

  describe("setNetworkErrorSimulation", function() {
    test("sends capability-gated request and resolves runner acknowledgement", async function() {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        socket!.simulateMessage(JSON.stringify({
          type: "connected",
          supportedCommands: ["set_network_error_simulation"],
        }));

        const resultPromise = testClient.setNetworkErrorSimulation({
          enabled: true,
          errorType: "timeout",
          limit: 2,
          expiresAtEpochMs: 1_720_000_000_000,
        });
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (socket!.sentMessages.some(message => {
            const payload = JSON.parse(message);
            return payload.type === "set_network_error_simulation" && payload.requestId !== undefined;
          })) {
            break;
          }
          await new Promise(resolve => setImmediate(resolve));
        }
        const sentMessage = socket!.sentMessages
          .map(message => JSON.parse(message))
          .find(message => message.type === "set_network_error_simulation" && message.requestId !== undefined);
        expect(sentMessage).toEqual({
          type: "set_network_error_simulation",
          requestId: expect.any(String),
          enabled: true,
          errorType: "timeout",
          limit: 2,
          expiresAtEpochMs: 1_720_000_000_000,
        });

        socket!.simulateMessage(JSON.stringify({
          type: "set_network_error_simulation_result",
          requestId: sentMessage.requestId,
          ok: true,
          totalTimeMs: 4,
        }));

        expect(await resultPromise).toEqual({
          success: true,
          totalTimeMs: 4,
          error: undefined,
        });
      } finally {
        await testClient.close();
      }
    });

    test("fails without sending when the runner does not advertise network error simulation", async function() {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        socket!.simulateMessage(JSON.stringify({
          type: "connected",
          supportedCommands: ["request_recent_apps"],
        }));

        const result = await testClient.setNetworkErrorSimulation({
          enabled: true,
          errorType: "timeout",
          limit: null,
          expiresAtEpochMs: 1_720_000_000_000,
        });

        expect(result.success).toBe(false);
        expect(result.totalTimeMs).toBe(0);
        expect(result.error).toContain("does not support set_network_error_simulation");
        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("getLatestHierarchy", function() {
    test("should return hierarchy data when WebSocket receives fresh data", async function() {
      const mockHierarchyData: CtrlProxyHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.apple.mobilesafari",
        hierarchy: {
          text: "Welcome",
          contentDesc: "Welcome to Safari",
          resourceId: "safari_welcome",
          bounds: {
            left: 0,
            top: 100,
            right: 390,
            bottom: 200
          },
          clickable: "true",
          enabled: "true"
        }
      };

      // Use delayed mode with 1ms for fast execution
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        // Parse sent message to get requestId
        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_hierarchy_if_stale");

        // Respond with matching requestId
        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          requestId: sentMessage.requestId,
          timestamp: Date.now(),
          data: mockHierarchyData
        }));

        const result = await resultPromise;

        expect(result).not.toBeNull();
        expect(result.hierarchy).not.toBeNull();
        expect(result.fresh).toBe(true);
        expect(result.updatedAt).toBe(1750934583218);
        expect(result.hierarchy!.updatedAt).toBe(1750934583218);
        expect(result.hierarchy!.packageName).toBe("com.apple.mobilesafari");
        expect(result.hierarchy!.hierarchy.text).toBe("Welcome");
      } finally {
        await testClient.close();
      }
    });

    test("suppresses observation stream push for explicit hierarchy sync request", async function() {
      const mockHierarchyData: CtrlProxyHierarchy = {
        updatedAt: 1750934584218,
        packageName: "com.example.ios",
        hierarchy: {
          text: "Initial frame",
        },
      };
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );
      const suppressionIds = (): string[] =>
        Array.from((testClient as unknown as {
          hierarchyObservationStreamSuppressions: Map<string, unknown>;
        }).hierarchyObservationStreamSuppressions.keys());

      try {
        const resultPromise = testClient.requestHierarchySyncWithoutObservationStreamPush(
          undefined,
          false,
          undefined,
          3000
        );
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_hierarchy_if_stale");
        expect(suppressionIds()).toEqual([sentMessage.requestId]);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          requestId: sentMessage.requestId,
          timestamp: Date.now(),
          data: mockHierarchyData,
        }));

        const result = await resultPromise;

        expect(result?.hierarchy.updatedAt).toBe(1750934584218);
        expect(suppressionIds()).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });

    test("should return null hierarchy when not connected", async function() {
      const testTimer = fakeTimer;

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );

      try {
        const result = await testClient.getLatestHierarchy(false, 100);

        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("uses a short reconnect cooldown for failed iOS CtrlProxy connections", async function() {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        await testClient.ensureConnected();
        await testClient.ensureConnected();
        await testClient.ensureConnected();

        expect(testClient.getReconnectStatus()).toEqual({
          state: "cooldown",
          retryAfterMs: 2000,
          retryAfterSeconds: 2,
          connectionAttempts: 3,
          maxConnectionAttempts: 3,
        });
      } finally {
        await testClient.close();
      }
    });

    test("keeps reconnect cooldown active after iOS WebSocket connection timeouts", async function() {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createConnectionTimeoutWebSocketFactory(testTimer),
        testTimer
      );
      (testClient as any).autoReconnectEnabled = false;

      const failAfterConnectionTimeout = async (): Promise<void> => {
        const resultPromise = testClient.ensureConnected();
        await flushPromises();
        testTimer.advanceTime(5000);
        expect(await resultPromise).toBe(false);
      };

      try {
        await failAfterConnectionTimeout();
        await failAfterConnectionTimeout();
        await failAfterConnectionTimeout();

        expect(testClient.getReconnectStatus()).toEqual({
          state: "cooldown",
          retryAfterMs: 2000,
          retryAfterSeconds: 2,
          connectionAttempts: 3,
          maxConnectionAttempts: 3,
        });
      } finally {
        await testClient.close();
      }
    });

    test("returns reconnecting metadata instead of an ambiguous empty hierarchy during cooldown", async function() {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        await testClient.ensureConnected();
        await testClient.ensureConnected();
        await testClient.ensureConnected();

        const result = await testClient.getLatestHierarchy(false, 100);

        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
        expect(result.reconnectStatus).toEqual({
          state: "cooldown",
          retryAfterMs: 2000,
          retryAfterSeconds: 2,
          connectionAttempts: 3,
          maxConnectionAttempts: 3,
        });
        expect(result.reconnectMessage).toBe("CtrlProxy reconnecting, retry in 2s");
      } finally {
        await testClient.close();
      }
    });

    test("returns reconnecting metadata for default observe skip-wait hierarchy calls during cooldown", async function() {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        await testClient.ensureConnected();
        await testClient.ensureConnected();
        await testClient.ensureConnected();

        const result = await testClient.getLatestHierarchy(
          false,
          100,
          undefined,
          true
        );

        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
        expect(result.reconnectStatus).toEqual({
          state: "cooldown",
          retryAfterMs: 2000,
          retryAfterSeconds: 2,
          connectionAttempts: 3,
          maxConnectionAttempts: 3,
        });
        expect(result.reconnectMessage).toBe("CtrlProxy reconnecting, retry in 2s");
      } finally {
        await testClient.close();
      }
    });

    test("preserves stale hierarchy while reporting reconnecting metadata during cooldown", async function() {
      const testTimer = new FakeTimer();
      const cachedHierarchy: CtrlProxyHierarchy = {
        updatedAt: 1750934585218,
        packageName: "com.example.cached",
        hierarchy: { text: "Cached screen" },
      };

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );
      (testClient as any).autoReconnectEnabled = false;
      (testClient as any).cachedHierarchy = {
        hierarchy: cachedHierarchy,
        receivedAt: 0,
        fresh: false,
      };
      (testClient as any).connectionAttempts = 3;
      (testClient as any).lastConnectionAttempt = 1000;
      testTimer.advanceTime(1000);

      try {
        const result = await testClient.getLatestHierarchy(true, 100);

        expect(result.hierarchy).toBe(cachedHierarchy);
        expect(result.fresh).toBe(false);
        expect(result.updatedAt).toBe(1750934585218);
        expect(result.reconnectStatus).toEqual({
          state: "cooldown",
          retryAfterMs: 2000,
          retryAfterSeconds: 2,
          connectionAttempts: 3,
          maxConnectionAttempts: 3,
        });
        expect(result.reconnectMessage).toBe("CtrlProxy reconnecting, retry in 2s");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestSwipe", function() {
    test("should send swipe request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestSwipe(100, 200, 100, 500, 300, 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        // Parse sent message to get requestId
        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_swipe");
        expect(sentMessage.x1).toBe(100);
        expect(sentMessage.y1).toBe(200);
        expect(sentMessage.x2).toBe(100);
        expect(sentMessage.y2).toBe(500);
        expect(sentMessage.duration).toBe(300);

        // Simulate response
        socket!.simulateMessage(JSON.stringify({
          type: "swipe_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 320
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(320);
      } finally {
        await testClient.close();
      }
    });

    test("should return error when not connected", async function() {
      const testTimer = fakeTimer;

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );

      try {
        const result = await testClient.requestSwipe(100, 200, 100, 500, 300, 100);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Not connected");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestTapCoordinates", function() {
    test("should send tap request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestTapCoordinates(150, 300, 0, 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_tap_coordinates");
        expect(sentMessage.x).toBe(150);
        expect(sentMessage.y).toBe(300);

        socket!.simulateMessage(JSON.stringify({
          type: "tap_coordinates_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 50
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(50);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestSetText", function() {
    test("should send setText request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestSetText("Hello World", { resourceId: "text_field_1", timeoutMs: 5000 });
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_set_text");
        expect(sentMessage.text).toBe("Hello World");
        expect(sentMessage.resourceId).toBe("text_field_1");

        socket!.simulateMessage(JSON.stringify({
          type: "set_text_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 100
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("highlight requests", function() {
    test("requestAddHighlight sends payload and resolves highlight response", async function() {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );
      const shape: HighlightShape = {
        type: "path",
        points: [
          { x: 1.2, y: 3.4 },
          { x: 5.6, y: 7.8 },
        ],
        bounds: {
          x: 10.2,
          y: 20.8,
          width: 100.4,
          height: 80.6,
        },
        style: {
          strokeColor: "#FF0000",
          strokeWidth: 4,
        },
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-1", shape, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const highlightMsg = socket!.sentMessages.find(message => {
          try { return JSON.parse(message).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);
        expect(payload.id).toBe("highlight-1");
        expect(payload.shape.bounds).toEqual({
          x: 10,
          y: 21,
          width: 100,
          height: 81,
        });
        expect(payload.shape.points).toEqual(shape.points);

        socket!.simulateMessage(JSON.stringify({
          type: "highlight_response",
          requestId: payload.requestId,
          success: true,
          error: null,
        }));

        const result = await requestPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("treats iOS highlight responses without success as failures", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );
      const shape: HighlightShape = {
        type: "box",
        bounds: {
          x: 10,
          y: 20,
          width: 100,
          height: 80,
        },
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-1", shape, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const payload = commandPayloads(socket!)[0];
        socket!.simulateMessage(JSON.stringify({
          type: "highlight_response",
          requestId: payload.requestId,
        }));

        const result = await requestPromise;
        expect(result.success).toBe(false);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestScreenshot", function() {
    test("should send screenshot request and return base64 data", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestScreenshot(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_screenshot");

        const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        socket!.simulateMessage(JSON.stringify({
          type: "screenshot",
          requestId: sentMessage.requestId,
          data: fakeBase64,
          format: "png",
          timestamp: Date.now()
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.data).toBe(fakeBase64);
        expect(result.format).toBe("png");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestImeAction", function() {
    test("should send imeAction request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestImeAction("done", 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_ime_action");
        expect(sentMessage.action).toBe("done");

        socket!.simulateMessage(JSON.stringify({
          type: "ime_action_result",
          requestId: sentMessage.requestId,
          action: "done",
          success: true,
          totalTimeMs: 50
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.action).toBe("done");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestKeyboard", function() {
    test("should send keyboard request and return open state", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestKeyboard("detect", 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_keyboard");
        expect(sentMessage.action).toBe("detect");

        socket!.simulateMessage(JSON.stringify({
          type: "keyboard_result",
          requestId: sentMessage.requestId,
          success: true,
          open: true,
          totalTimeMs: 20
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.open).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("returns a clear skew error when advertised runner capabilities exclude keyboard", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "connected",
          id: 1,
          supportedCommands: ["request_recent_apps"]
        }));

        const result = await testClient.requestKeyboard("detect", 5000);

        expect(result.success).toBe(false);
        expect(result.open).toBe(false);
        expect(result.error).toContain("does not support request_keyboard");
        expect(result.error).toContain("out of sync");
        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("command fallback result shapes", function() {
    test("preserves required fields for unsupported non-BaseResult command contracts", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "connected",
          id: 1,
          supportedCommands: ["request_recent_apps"]
        }));

        const imeAction = await testClient.requestImeAction("done", 5000);
        expect(imeAction.success).toBe(false);
        expect(imeAction.action).toBe("done");
        expect(imeAction.totalTimeMs).toBe(0);
        expect(imeAction.error).toContain("does not support request_ime_action");

        const rotate = await testClient.requestRotate("landscape", 5000);
        expect(rotate.success).toBe(false);
        expect(rotate.previousOrientation).toBe("");
        expect(rotate.currentOrientation).toBe("");
        expect(rotate.value).toBe(0);
        expect(rotate.rotationPerformed).toBe(false);
        expect(rotate.error).toContain("does not support request_rotate");

        const clipboard = await testClient.requestClipboard("get", undefined, 5000);
        expect(clipboard.success).toBe(false);
        expect(clipboard.action).toBe("get");
        expect(clipboard.totalTimeMs).toBe(0);
        expect(clipboard.error).toContain("does not support request_clipboard");

        const voiceOver = await testClient.requestVoiceOverState(5000);
        expect(voiceOver.success).toBe(false);
        expect(voiceOver.enabled).toBe(false);
        expect(voiceOver.totalTimeMs).toBe(0);
        expect(voiceOver.error).toContain("does not support get_voiceover_state");

        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });

    test("preserves required fields for timed out non-BaseResult command contracts", async function() {
      const testTimer = new FakeTimer();

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const imeActionPromise = testClient.requestImeAction("done", 100);
        await waitForSentMessages(socket as CapturingWebSocket, 1);
        testTimer.advanceTime(100);
        const imeAction = await imeActionPromise;
        expect(imeAction.success).toBe(false);
        expect(imeAction.action).toBe("done");
        expect(imeAction.totalTimeMs).toBe(100);
        expect(imeAction.error).toContain("IME action timed out");

        const rotatePromise = testClient.requestRotate("landscape", 100);
        await waitForSentMessages(socket as CapturingWebSocket, 2);
        testTimer.advanceTime(100);
        const rotate = await rotatePromise;
        expect(rotate.success).toBe(false);
        expect(rotate.previousOrientation).toBe("");
        expect(rotate.currentOrientation).toBe("");
        expect(rotate.value).toBe(0);
        expect(rotate.rotationPerformed).toBe(false);
        expect(rotate.totalTimeMs).toBe(100);
        expect(rotate.error).toContain("Rotate timed out");

        const clipboardPromise = testClient.requestClipboard("get", undefined, 100);
        await waitForSentMessages(socket as CapturingWebSocket, 3);
        testTimer.advanceTime(100);
        const clipboard = await clipboardPromise;
        expect(clipboard.success).toBe(false);
        expect(clipboard.action).toBe("get");
        expect(clipboard.totalTimeMs).toBe(100);
        expect(clipboard.error).toContain("Clipboard operation timed out");
      } finally {
        await testClient.close();
      }
    });

    test("preserves required fields for not-connected non-BaseResult command contracts", async function() {
      const testTimer = fakeTimer;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );

      try {
        const imeAction = await testClient.requestImeAction("done", 100);
        expect(imeAction.success).toBe(false);
        expect(imeAction.action).toBe("done");
        expect(imeAction.totalTimeMs).toBe(0);
        expect(imeAction.error).toBe("Not connected");

        const rotate = await testClient.requestRotate("landscape", 100);
        expect(rotate.success).toBe(false);
        expect(rotate.previousOrientation).toBe("");
        expect(rotate.currentOrientation).toBe("");
        expect(rotate.value).toBe(0);
        expect(rotate.rotationPerformed).toBe(false);
        expect(rotate.totalTimeMs).toBe(0);
        expect(rotate.error).toBe("Not connected");

        const clipboard = await testClient.requestClipboard("get", undefined, 100);
        expect(clipboard.success).toBe(false);
        expect(clipboard.action).toBe("get");
        expect(clipboard.totalTimeMs).toBe(0);
        expect(clipboard.error).toBe("Not connected");
      } finally {
        await testClient.close();
      }
    });

    test("preserves required fields for old-runner unknown command errors", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const keyboardPromise = testClient.requestKeyboard("detect", 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 1);
        const keyboardMessage = commandPayloads(socket!)[0];
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: keyboardMessage.requestId,
          error: "Unknown command type: request_keyboard",
        }));
        const keyboard = await keyboardPromise;
        expect(keyboard.success).toBe(false);
        expect(keyboard.open).toBe(false);
        expect(keyboard.totalTimeMs).toBe(0);
        expect(keyboard.error).toContain("runner is likely older");

        const imeActionPromise = testClient.requestImeAction("done", 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 2);
        const imeActionMessage = commandPayloads(socket!)[1];
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: imeActionMessage.requestId,
          error: "Unknown command type: request_ime_action",
        }));
        const imeAction = await imeActionPromise;
        expect(imeAction.success).toBe(false);
        expect(imeAction.action).toBe("done");
        expect(imeAction.totalTimeMs).toBe(0);
        expect(imeAction.error).toContain("runner is likely older");

        const rotatePromise = testClient.requestRotate("landscape", 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 3);
        const rotateMessage = commandPayloads(socket!)[2];
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: rotateMessage.requestId,
          error: "Unknown command type: request_rotate",
        }));
        const rotate = await rotatePromise;
        expect(rotate.success).toBe(false);
        expect(rotate.previousOrientation).toBe("");
        expect(rotate.currentOrientation).toBe("");
        expect(rotate.value).toBe(0);
        expect(rotate.rotationPerformed).toBe(false);
        expect(rotate.totalTimeMs).toBe(0);
        expect(rotate.error).toContain("runner is likely older");

        const clipboardPromise = testClient.requestClipboard("get", undefined, 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 4);
        const clipboardMessage = commandPayloads(socket!)[3];
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: clipboardMessage.requestId,
          error: "Unknown command type: request_clipboard",
        }));
        const clipboard = await clipboardPromise;
        expect(clipboard.success).toBe(false);
        expect(clipboard.action).toBe("get");
        expect(clipboard.totalTimeMs).toBe(0);
        expect(clipboard.error).toContain("runner is likely older");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestRecentApps", function() {
    test("should send recent apps request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestRecentApps(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_recent_apps");

        socket!.simulateMessage(JSON.stringify({
          type: "recent_apps_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 15
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestShake", function() {
    test("should send shake request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestShake(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_shake");

        socket!.simulateMessage(JSON.stringify({
          type: "shake_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 15
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestLaunchApp", function() {
    test("should send launch app request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestLaunchApp("com.apple.Preferences", 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_launch_app");
        expect(sentMessage.bundleId).toBe("com.apple.Preferences");

        socket!.simulateMessage(JSON.stringify({
          type: "launch_app_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 120
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(120);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestPressBack", function() {
    test("should send press back request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestPressBack(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_press_back");

        socket!.simulateMessage(JSON.stringify({
          type: "press_back_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 80
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(80);
      } finally {
        await testClient.close();
      }
    });

    test("rewrites old-runner unknown command responses into an actionable skew error", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestPressBack(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_press_back");

        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: sentMessage.requestId,
          error: "Unknown command type: request_press_back",
          totalTimeMs: 3
        }));

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.totalTimeMs).toBe(3);
        expect(result.error).toContain("rejected request_press_back as unknown");
        expect(result.error).toContain("likely older than this daemon");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestPressButton", function() {
    test("should send generic press button request and return result", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestPressButton("volume_up", 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_press_button");
        expect(sentMessage.action).toBe("volume_up");

        socket!.simulateMessage(JSON.stringify({
          type: "press_button_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 90
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(90);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("connection management", function() {
    test("isConnected should return true when WebSocket is open", async function() {
      const testTimer = fakeTimer;

      const { factory } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        // Initially not connected
        expect(testClient.isConnected()).toBe(false);

        // Connect
        await testClient.ensureConnected();
        await flushPromises();

        expect(testClient.isConnected()).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("isConnected should return false after close", async function() {
      const testTimer = fakeTimer;

      const { factory } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      await testClient.ensureConnected();
      await flushPromises();
      expect(testClient.isConnected()).toBe(true);

      await testClient.close();
      await flushPromises();

      expect(testClient.isConnected()).toBe(false);
    });
  });

  describe("caching", function() {
    test("hasCachedHierarchy should return true after receiving hierarchy", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        expect(testClient.hasCachedHierarchy()).toBe(false);

        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const mockHierarchy: CtrlProxyHierarchy = {
          updatedAt: Date.now(),
          packageName: "com.test.app",
          hierarchy: { text: "Test" }
        };

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          data: mockHierarchy
        }));

        await resultPromise;
        expect(testClient.hasCachedHierarchy()).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("invalidateCache should mark cache as not fresh", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        // Get hierarchy to populate cache
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const mockHierarchy: CtrlProxyHierarchy = {
          updatedAt: Date.now(),
          packageName: "com.test.app",
          hierarchy: { text: "Test" }
        };

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          data: mockHierarchy
        }));

        await resultPromise;
        expect(testClient.hasCachedHierarchy()).toBe(true);

        // Invalidate cache
        testClient.invalidateCache();

        // Cache still exists but is marked as stale
        expect(testClient.hasCachedHierarchy()).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("convertToViewHierarchyResult", function() {
    test("should convert CtrlProxyHierarchy to ViewHierarchyResult format", async function() {
      const testTimer = fakeTimer;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createSuccessWebSocketFactory(testTimer),
        testTimer
      );

      try {
        const ctrlProxyHierarchy: CtrlProxyHierarchy = {
          updatedAt: 1234567890,
          packageName: "com.apple.test",
          hierarchy: {
            text: "Button",
            contentDesc: "Submit button",
            resourceId: "submit_btn",
            className: "UIButton",
            bounds: { left: 10, top: 20, right: 100, bottom: 60 },
            clickable: "true",
            enabled: "true",
            node: [
              {
                text: "Label",
                className: "UILabel"
              }
            ]
          }
        };

        const result = testClient.convertToViewHierarchyResult(ctrlProxyHierarchy);

        expect(result.packageName).toBe("com.apple.test");
        expect(result.updatedAt).toBe(1234567890);
        expect(result.hierarchy).toBeDefined();
        expect(result.hierarchy.node.$["text"]).toBe("Button");
        expect(result.hierarchy.node.$["content-desc"]).toBe("Submit button");
        expect(result.hierarchy.node.$["resource-id"]).toBe("submit_btn");
        expect(result.hierarchy.node.$["class"]).toBe("UIButton");
        expect(result.hierarchy.node.$["bounds"]).toEqual({
          left: 10,
          top: 20,
          right: 100,
          bottom: 60
        });
        expect(result.hierarchy.node.$["clickable"]).toBe("true");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestClearText", function() {
    test("sends request_clear_text (not request_set_text)", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestClearText();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_clear_text");
        expect(sentMessage.resourceId).toBeUndefined();

        socket!.simulateMessage(JSON.stringify({
          type: "clear_text_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 30
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("passes resourceId when provided", async function() {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.requestClearText("com.app:id/email_field");
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_clear_text");
        expect(sentMessage.resourceId).toBe("com.app:id/email_field");

        socket!.simulateMessage(JSON.stringify({
          type: "clear_text_result",
          requestId: sentMessage.requestId,
          success: true,
          totalTimeMs: 45
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("returns error when not connected", async function() {
      const testTimer = fakeTimer;

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );

      try {
        const result = await testClient.requestClearText(undefined, 100);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Not connected");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("getSupportedCommands", function() {
    test("returns the advertised command set (sorted) once the runner handshakes", async function() {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "connected",
          id: 1,
          supportedCommands: ["request_shake", "add_highlight", "request_press_button"]
        }));
        await flushPromises();

        const commands = await testClient.getSupportedCommands();

        expect(commands).toEqual(["add_highlight", "request_press_button", "request_shake"]);
        // Cached accessor never opens a connection and mirrors the live set.
        expect(testClient.getCachedSupportedCommands()).toEqual([
          "add_highlight",
          "request_press_button",
          "request_shake"
        ]);
      } finally {
        await testClient.close();
      }
    });

    test("waits for the connected handshake that arrives after the socket opens", async function() {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer
      );

      try {
        // Probe before any handshake — the runner sends `connected` a beat after
        // the WebSocket opens, simulating doctor being first to reach the runner.
        const pending = testClient.getSupportedCommands();

        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await flushPromises();

        socket!.simulateMessage(JSON.stringify({
          type: "connected",
          id: 1,
          supportedCommands: ["request_shake", "add_highlight"]
        }));

        const commands = await pending;
        expect(commands).toEqual(["add_highlight", "request_shake"]);
      } finally {
        await testClient.close();
      }
    });

    test("getExistingInstance does not create a client when none exists", function() {
      IOSCtrlProxyClient.resetInstances();
      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBeNull();

      const created = IOSCtrlProxyClient.getInstance(testDevice);
      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBe(created);
    });

    test("createDetached returns an unregistered client (not rediscoverable after close)", async function() {
      IOSCtrlProxyClient.resetInstances();

      const detached = IOSCtrlProxyClient.createDetached(testDevice);
      try {
        // The throwaway probe must never enter the singleton map, so a later probe
        // can't rediscover a closed client and reconnect it (regression guard).
        expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBeNull();
        expect(detached).toBeInstanceOf(IOSCtrlProxyClient);
      } finally {
        await detached.close();
      }

      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBeNull();
    });

    test("returns null when the runner cannot be reached", async function() {
      const testTimer = fakeTimer;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer
      );

      try {
        const commands = await testClient.getSupportedCommands();
        expect(commands).toBeNull();
        expect(testClient.getCachedSupportedCommands()).toBeNull();
      } finally {
        await testClient.close();
      }
    });
  });

  describe("SDK event ingestor forwarding", function() {
    test("forwards a hierarchy_update to the ingestor's recordLayoutTelemetryEvent", async function() {
      const fakeIngestor = new FakeIosSdkEventIngestor();
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
        undefined,
        undefined,
        undefined,
        fakeIngestor
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: Date.now(),
          data: {
            updatedAt: 1750934583218,
            packageName: "com.example.ios",
            hierarchy: { text: "Welcome" },
          },
        }));

        await flushPromises();

        expect(fakeIngestor.layoutEvents.length).toBe(1);
        expect(fakeIngestor.layoutEvents[0].packageName).toBe("com.example.ios");
      } finally {
        await testClient.close();
      }
    });

    test("forwards decoded SDK events from the /sdk-events poll to the ingestor", async function() {
      const fakeIngestor = new FakeIosSdkEventIngestor();
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
        undefined,
        undefined,
        undefined,
        fakeIngestor
      );

      // SDK envelopes carry a base64-encoded JSON payload; verify the client
      // decodes the envelope (base64 → JSON, timestamp default, bundleId → applicationId)
      // and forwards it to the ingestor.
      const payload = { url: "https://x.test/a", method: "POST", timestamp: 4242 };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          { bundleId: "com.example.ios", events: [{ eventType: "network_request", payload: encoded }] },
        ],
      })) as unknown as typeof fetch;

      try {
        (testClient as unknown as { startSdkEventPolling(): void }).startSdkEventPolling();
        // Auto-advance timer fires the interval via setImmediate; flush the async
        // fetch → decode → recordSdkEvent chain.
        await flushPromises(8);

        expect(fakeIngestor.sdkEvents.length).toBe(1);
        expect(fakeIngestor.sdkEvents[0].applicationId).toBe("com.example.ios");
        expect(fakeIngestor.sdkEvents[0].event.type).toBe("network_request");
        expect(fakeIngestor.sdkEvents[0].event.timestamp).toBe(4242);
        expect(fakeIngestor.sdkEvents[0].event.payload).toMatchObject({
          url: "https://x.test/a",
          method: "POST",
        });
      } finally {
        globalThis.fetch = originalFetch;
        (testClient as unknown as { stopSdkEventPolling(): void }).stopSdkEventPolling();
        await testClient.close();
      }
    });
  });
});
