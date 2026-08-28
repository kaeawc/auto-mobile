import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient, CtrlProxyHierarchy } from "../../../../src/features/observe/ios";
import {
  IOS_RUNNER_FEATURE_FLAGS,
  getRequiredIosRunnerFeatureFlags,
} from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { BootedDevice, HighlightShape } from "../../../../src/models";
import { NetworkState } from "../../../../src/server/NetworkState";
import { serverConfig } from "../../../../src/utils/ServerConfig";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  WebSocketState,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { DefaultRetryExecutor } from "../../../../src/utils/retry/RetryExecutor";
import { FakeScreenshotBackoffScheduler } from "../../../../src/features/observe/ScreenshotBackoffScheduler";
import type { DeviceConnectionLostNotifier } from "../../../../src/features/observe/DeviceConnectionLostNotifier";
import { FakeIosSdkEventIngestor } from "../../../fakes/FakeIosSdkEventIngestor";
import { loadCoordinateMappingVectors } from "../../../parity/coordinateMappingGoldenVectors";
import {
  startDeviceDataStreamSocketServer,
  stopDeviceDataStreamSocketServer,
} from "../../../../src/daemon/deviceDataStreamSocketServer";
import { FakeSocket } from "../../../fakes/FakeNetServer";

describe("iOS runner feature release sequencing", () => {
  test("does not require an unreleased handshake from the immutable 0.0.66 IPA", () => {
    expect(getRequiredIosRunnerFeatureFlags({ AUTOMOBILE_VERSION: "0.0.66" })).toEqual([]);
  });

  test("requires the handshake starting with the release that will contain it", () => {
    expect(getRequiredIosRunnerFeatureFlags({ AUTOMOBILE_VERSION: "0.0.67" })).toEqual([
      ...IOS_RUNNER_FEATURE_FLAGS,
    ]);
  });
});

describe("IOSCtrlProxyClient", function () {
  let ctrlProxyClient: IOSCtrlProxyClient;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function () {
    // Create fake timer with auto-advance for fast tests
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Create test device (iOS simulator format)
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };

    // Reset singleton instances for clean test state
    IOSCtrlProxyClient.resetInstances();
    NetworkState.resetInstance();
    serverConfig.setNetworkMockableEnabled(false);

    ctrlProxyClient = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer,
    );
  });

  afterEach(async function () {
    // Clean up WebSocket connections
    if (ctrlProxyClient) {
      await ctrlProxyClient.close();
    }
    await stopDeviceDataStreamSocketServer();
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

  const createCapturingWebSocketFactory = (
    timer?: FakeTimer | undefined,
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

  const createConnectionTimeoutWebSocketFactory =
    (timer: FakeTimer): ((url: string) => FakeWebSocket) =>
    (url) =>
      new FakeWebSocket(url, "timeout", 60000, timer);

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("open", () => resolve());
    });
  };

  const waitForSocket = async (
    getSocket: () => FakeWebSocket | null,
  ): Promise<FakeWebSocket | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const socket = getSocket();
      if (socket) {
        return socket;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return getSocket();
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount: number = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (commandPayloads(socket).length >= minCount) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const syncMessageTypes = new Set([
    "set_hierarchy_poll_interval",
    "set_network_mock_rules",
    "set_network_error_simulation",
  ]);

  const commandPayloads = (socket: CapturingWebSocket): any[] =>
    socket.sentMessages
      .map((message) => JSON.parse(message))
      .filter((payload) => !syncMessageTypes.has(payload.type));

  const flushPromises = async (iterations: number = 3): Promise<void> => {
    for (let i = 0; i < iterations; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  describe("connection lifecycle", function () {
    test("cancels screenshot backoff when the connection closes", function () {
      const scheduler = new FakeScreenshotBackoffScheduler();

      (ctrlProxyClient as any).screenshotBackoffScheduler = scheduler;
      (ctrlProxyClient as any).onConnectionClosed();

      expect(scheduler.cancelPendingCapturesCalls).toBe(1);
    });

    test("refreshes screenshot cadence by rescheduling keepalive", function () {
      const scheduler = new FakeScreenshotBackoffScheduler();

      (ctrlProxyClient as any).screenshotBackoffScheduler = scheduler;
      ctrlProxyClient.refreshObservationStreamScreenshotCadence();

      expect(scheduler.rescheduleKeepAliveCalls).toBe(1);
    });

    test("sends hierarchy cadence updates to the runner", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        testClient.refreshObservationStreamHierarchyCadence(500);

        const cadenceMessages = (socket as CapturingWebSocket).sentMessages
          .map((message) => JSON.parse(message))
          .filter((payload) => payload.type === "set_hierarchy_poll_interval");
        expect(cadenceMessages).toEqual([
          {
            type: "set_hierarchy_poll_interval",
            intervalMs: 500,
          },
        ]);
      } finally {
        await testClient.close();
      }
    });

    test("does not send hierarchy cadence updates to stale runners without command support", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        // Runner handshake advertises a command set WITHOUT set_hierarchy_poll_interval.
        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_hierarchy"],
          }),
        );
        await flushPromises();

        testClient.refreshObservationStreamHierarchyCadence(500);

        const cadenceMessages = (socket as CapturingWebSocket).sentMessages
          .map((message) => JSON.parse(message))
          .filter((payload) => payload.type === "set_hierarchy_poll_interval");
        expect(cadenceMessages).toEqual([]);
      } finally {
        await testClient.close();
      }
    });

    test("notifies the observation stream when the WebSocket connection closes", function () {
      const lostDeviceIds: string[] = [];
      const notifier: DeviceConnectionLostNotifier = {
        onDeviceConnectionLost: (deviceId) => {
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
        notifier,
      );

      (testClient as any).onConnectionClosed();

      expect(lostDeviceIds).toEqual(["A1B2C3D4-E5F6-7890-ABCD-EF1234567890"]);
    });

    test("restarts screenshot backoff when the connection (re)establishes", function () {
      // Regression guard: onConnectionClosed() cancels the keepalive, so a
      // transient reconnect on a static screen must restart it or the live view
      // freezes forever. startScreenshotBackoff() is itself subscriber-gated.
      let backoffStarts = 0;
      (ctrlProxyClient as any).startScreenshotBackoff = () => {
        backoffStarts++;
      };
      // Isolate from SDK polling side effects for this unit.
      (ctrlProxyClient as any).startSdkEventPolling = () => {
        /* no-op */
      };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(backoffStarts).toBe(1);
    });

    test("syncs network mock rules when the connection (re)establishes", function () {
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
        responseBody: '{"ok":true}',
        contentType: "application/json",
      });
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => {
        /* no-op */
      };
      (ctrlProxyClient as any).startScreenshotBackoff = () => {
        /* no-op */
      };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages.map((message) => JSON.parse(message).type)).toEqual([
        "set_network_mock_rules",
        "set_network_error_simulation",
      ]);
      expect(JSON.parse(sentMessages[0])).toEqual({
        type: "set_network_mock_rules",
        rules: [
          {
            mockId: mock.mockId,
            host: "api\\.example\\.com",
            path: "/v1/items",
            method: "GET",
            limit: 3,
            remaining: 3,
            statusCode: 201,
            responseHeaders: { "X-Test": "yes" },
            responseBody: '{"ok":true}',
            contentType: "application/json",
          },
        ],
      });
      expect(JSON.parse(sentMessages[1])).toEqual({
        type: "set_network_error_simulation",
        enabled: false,
      });
    });

    test("clears stale network error simulation when the connection (re)establishes without an active simulation", function () {
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => {
        /* no-op */
      };
      (ctrlProxyClient as any).startScreenshotBackoff = () => {
        /* no-op */
      };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages).toHaveLength(1);
      expect(JSON.parse(sentMessages[0])).toEqual({
        type: "set_network_error_simulation",
        enabled: false,
      });
    });

    test("does not sync network error simulation to stale runners without command support", function () {
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).supportedCommands = new Set(["set_network_mock_rules"]);
      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => {
        /* no-op */
      };
      (ctrlProxyClient as any).startScreenshotBackoff = () => {
        /* no-op */
      };

      (ctrlProxyClient as any).onConnectionEstablished();

      expect(sentMessages.map((message) => JSON.parse(message).type)).not.toContain(
        "set_network_error_simulation",
      );
    });

    test("syncs active network error simulation when the connection (re)establishes", function () {
      const state = NetworkState.getInstance();
      state.startSimulation("tlsFailure", 20, 4);
      const sentMessages: string[] = [];

      (ctrlProxyClient as any).sendMessage = (message: string) => {
        sentMessages.push(message);
        return true;
      };
      (ctrlProxyClient as any).startSdkEventPolling = () => {
        /* no-op */
      };
      (ctrlProxyClient as any).startScreenshotBackoff = () => {
        /* no-op */
      };

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

  describe("setNetworkErrorSimulation", function () {
    test("sends capability-gated request and resolves runner acknowledgement", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["set_network_error_simulation"],
          }),
        );

        const resultPromise = testClient.setNetworkErrorSimulation({
          enabled: true,
          errorType: "timeout",
          limit: 2,
          expiresAtEpochMs: 1_720_000_000_000,
        });
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (
            socket!.sentMessages.some((message) => {
              const payload = JSON.parse(message);
              return (
                payload.type === "set_network_error_simulation" && payload.requestId !== undefined
              );
            })
          ) {
            break;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        const sentMessage = socket!.sentMessages
          .map((message) => JSON.parse(message))
          .find(
            (message) =>
              message.type === "set_network_error_simulation" && message.requestId !== undefined,
          );
        expect(sentMessage).toEqual({
          type: "set_network_error_simulation",
          requestId: expect.any(String),
          enabled: true,
          errorType: "timeout",
          limit: 2,
          expiresAtEpochMs: 1_720_000_000_000,
        });

        socket!.simulateMessage(
          JSON.stringify({
            type: "set_network_error_simulation_result",
            requestId: sentMessage.requestId,
            ok: true,
            totalTimeMs: 4,
          }),
        );

        expect(await resultPromise).toEqual({
          success: true,
          totalTimeMs: 4,
          error: undefined,
        });
      } finally {
        await testClient.close();
      }
    });

    test("fails without sending when the runner does not advertise network error simulation", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["request_recent_apps"],
          }),
        );

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

  describe("getLatestHierarchy", function () {
    test("should return hierarchy data when WebSocket receives fresh data", async function () {
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
            bottom: 200,
          },
          clickable: "true",
          enabled: "true",
        },
      };

      // Use delayed mode with 1ms for fast execution
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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
        socket!.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            requestId: sentMessage.requestId,
            timestamp: Date.now(),
            data: mockHierarchyData,
          }),
        );

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

    test("suppresses observation stream push for explicit hierarchy sync request", async function () {
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
        testTimer,
      );
      const suppressionIds = (): string[] =>
        Array.from(
          (
            testClient as unknown as {
              hierarchyObservationStreamSuppressions: Map<string, unknown>;
            }
          ).hierarchyObservationStreamSuppressions.keys(),
        );

      try {
        const resultPromise = testClient.requestHierarchySyncWithoutObservationStreamPush(
          undefined,
          false,
          undefined,
          3000,
        );
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_hierarchy_if_stale");
        expect(suppressionIds()).toEqual([sentMessage.requestId]);

        socket!.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            requestId: sentMessage.requestId,
            timestamp: Date.now(),
            data: mockHierarchyData,
          }),
        );

        const result = await resultPromise;

        expect(result?.hierarchy.updatedAt).toBe(1750934584218);
        expect(suppressionIds()).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });

    test("should return null hierarchy when not connected", async function () {
      const testTimer = fakeTimer;

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
      );

      try {
        const result = await testClient.getLatestHierarchy(false, 100);

        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("uses a short reconnect cooldown for failed iOS CtrlProxy connections", async function () {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
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

    test("keeps reconnect cooldown active after iOS WebSocket connection timeouts", async function () {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createConnectionTimeoutWebSocketFactory(testTimer),
        testTimer,
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

    test("returns reconnecting metadata instead of an ambiguous empty hierarchy during cooldown", async function () {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
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

    test("returns reconnecting metadata for default observe skip-wait hierarchy calls during cooldown", async function () {
      const testTimer = new FakeTimer();

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        await testClient.ensureConnected();
        await testClient.ensureConnected();
        await testClient.ensureConnected();

        const result = await testClient.getLatestHierarchy(false, 100, undefined, true);

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

    test("preserves stale hierarchy while reporting reconnecting metadata during cooldown", async function () {
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
        testTimer,
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

  describe("requestSwipe", function () {
    test("should send swipe request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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
        socket!.simulateMessage(
          JSON.stringify({
            type: "swipe_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 320,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(320);
      } finally {
        await testClient.close();
      }
    });

    test("should return error when not connected", async function () {
      const testTimer = fakeTimer;

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
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

  describe("requestTapCoordinates", function () {
    test("should send tap request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "tap_coordinates_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 50,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(50);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestSetText", function () {
    test("should send setText request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestSetText("Hello World", {
          resourceId: "text_field_1",
          timeoutMs: 5000,
        });
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_set_text");
        expect(sentMessage.text).toBe("Hello World");
        expect(sentMessage.resourceId).toBe("text_field_1");

        socket!.simulateMessage(
          JSON.stringify({
            type: "set_text_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 100,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("highlight requests", function () {
    test("requestAddHighlight sends payload and resolves highlight response", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        const highlightMsg = socket!.sentMessages.find((message) => {
          try {
            return JSON.parse(message).type === "add_highlight";
          } catch {
            return false;
          }
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "highlight_response",
            requestId: payload.requestId,
            success: true,
            error: null,
          }),
        );

        const result = await requestPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("treats iOS highlight responses without success as failures", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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
        socket!.simulateMessage(
          JSON.stringify({
            type: "highlight_response",
            requestId: payload.requestId,
          }),
        );

        const result = await requestPromise;
        expect(result.success).toBe(false);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestScreenshot", function () {
    test("should send screenshot request and return base64 data", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestScreenshot(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_screenshot");

        const fakeBase64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        socket!.simulateMessage(
          JSON.stringify({
            type: "screenshot",
            requestId: sentMessage.requestId,
            data: fakeBase64,
            format: "png",
            timestamp: Date.now(),
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.data).toBe(fakeBase64);
        expect(result.format).toBe("png");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestImeAction", function () {
    test("should send imeAction request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "ime_action_result",
            requestId: sentMessage.requestId,
            action: "done",
            success: true,
            totalTimeMs: 50,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.action).toBe("done");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestKeyboard", function () {
    test("should send keyboard request and return open state", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "keyboard_result",
            requestId: sentMessage.requestId,
            success: true,
            open: true,
            totalTimeMs: 20,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.open).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("returns a clear skew error when advertised runner capabilities exclude keyboard", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_recent_apps"],
          }),
        );

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

  describe("command fallback result shapes", function () {
    test("preserves required fields for unsupported non-BaseResult command contracts", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_recent_apps"],
          }),
        );

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

    test("preserves required fields for timed out non-BaseResult command contracts", async function () {
      const testTimer = new FakeTimer();

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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
        expect(imeAction.error).toBe("IME action timed out after 100ms");

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
        expect(rotate.error).toBe("Rotate timed out after 100ms");

        const clipboardPromise = testClient.requestClipboard("get", undefined, 100);
        await waitForSentMessages(socket as CapturingWebSocket, 3);
        testTimer.advanceTime(100);
        const clipboard = await clipboardPromise;
        expect(clipboard.success).toBe(false);
        expect(clipboard.action).toBe("get");
        expect(clipboard.totalTimeMs).toBe(100);
        expect(clipboard.error).toBe("Clipboard operation timed out after 100ms");
      } finally {
        await testClient.close();
      }
    });

    test("preserves required fields for not-connected non-BaseResult command contracts", async function () {
      const testTimer = fakeTimer;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
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

    test("preserves required fields for old-runner unknown command errors", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const keyboardPromise = testClient.requestKeyboard("detect", 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 1);
        const keyboardMessage = commandPayloads(socket!)[0];
        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: keyboardMessage.requestId,
            error: "Unknown command type: request_keyboard",
          }),
        );
        const keyboard = await keyboardPromise;
        expect(keyboard.success).toBe(false);
        expect(keyboard.open).toBe(false);
        expect(keyboard.totalTimeMs).toBe(0);
        expect(keyboard.error).toContain("runner is likely older");

        const imeActionPromise = testClient.requestImeAction("done", 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 2);
        const imeActionMessage = commandPayloads(socket!)[1];
        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: imeActionMessage.requestId,
            error: "Unknown command type: request_ime_action",
          }),
        );
        const imeAction = await imeActionPromise;
        expect(imeAction.success).toBe(false);
        expect(imeAction.action).toBe("done");
        expect(imeAction.totalTimeMs).toBe(0);
        expect(imeAction.error).toContain("runner is likely older");

        const rotatePromise = testClient.requestRotate("landscape", 5000);
        await waitForSentMessages(socket as CapturingWebSocket, 3);
        const rotateMessage = commandPayloads(socket!)[2];
        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: rotateMessage.requestId,
            error: "Unknown command type: request_rotate",
          }),
        );
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
        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: clipboardMessage.requestId,
            error: "Unknown command type: request_clipboard",
          }),
        );
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

  describe("requestRecentApps", function () {
    test("should send recent apps request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestRecentApps(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_recent_apps");

        socket!.simulateMessage(
          JSON.stringify({
            type: "recent_apps_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 15,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestShake", function () {
    test("should send shake request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestShake(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_shake");

        socket!.simulateMessage(
          JSON.stringify({
            type: "shake_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 15,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestLaunchApp", function () {
    test("should send launch app request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "launch_app_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 120,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(120);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestPressBack", function () {
    test("should send press back request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestPressBack(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_press_back");

        socket!.simulateMessage(
          JSON.stringify({
            type: "press_back_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 80,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(80);
      } finally {
        await testClient.close();
      }
    });

    test("rewrites old-runner unknown command responses into an actionable skew error", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestPressBack(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage.type).toBe("request_press_back");

        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: sentMessage.requestId,
            error: "Unknown command type: request_press_back",
            totalTimeMs: 3,
          }),
        );

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

  describe("requestPressButton", function () {
    test("should send generic press button request and return result", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "press_button_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 90,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(90);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("connection management", function () {
    test("isConnected should return true when WebSocket is open", async function () {
      const testTimer = fakeTimer;

      const { factory } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

    test("isConnected should return false after close", async function () {
      const testTimer = fakeTimer;

      const { factory } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      await testClient.ensureConnected();
      await flushPromises();
      expect(testClient.isConnected()).toBe(true);

      await testClient.close();
      await flushPromises();

      expect(testClient.isConnected()).toBe(false);
    });
  });

  describe("service port changes", function () {
    test("fails in-flight requests instead of stranding them when the CtrlProxy service port changes", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        // Register an in-flight request over the live socket. A long timeout keeps
        // it pending so it can only settle via the port-change cancellation, never
        // by timing out during the test.
        const inFlight = testClient.requestSwipe(0, 0, 10, 10, 300, 60000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        // Macrotask flush: ensure the request is registered before the port change.
        await new Promise((resolve) => setImmediate(resolve));

        const requestManager = (testClient as any).requestManager as { getPendingCount(): number };
        // Precondition: the request is genuinely in-flight before the port change.
        expect(requestManager.getPendingCount()).toBeGreaterThan(0);

        // Changing the service port on a live socket must FAIL the in-flight request
        // (cancelAll rejects it), not silently strand it in the pending map.
        (testClient as any).updatePort(serverPort + 1);

        // cancelAll clears the pending map synchronously — nothing is stranded.
        expect(requestManager.getPendingCount()).toBe(0);
        await expect(inFlight).rejects.toThrow("CtrlProxy service port changed");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("caching", function () {
    test("hasCachedHierarchy should return true after receiving hierarchy", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        expect(testClient.hasCachedHierarchy()).toBe(false);

        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const mockHierarchy: CtrlProxyHierarchy = {
          updatedAt: Date.now(),
          packageName: "com.test.app",
          hierarchy: { text: "Test" },
        };

        socket!.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            data: mockHierarchy,
          }),
        );

        await resultPromise;
        expect(testClient.hasCachedHierarchy()).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("retains the first host receipt time when a push re-delivers the same capture", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );
      const hierarchy: CtrlProxyHierarchy = {
        updatedAt: 1_750_934_583_218,
        packageName: "com.test.app",
        hierarchy: { text: "unchanged" },
      };

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({ type: "hierarchy_update", data: hierarchy }));
        await flushPromises();
        const firstReceivedAt = (testClient as any).cachedHierarchy.receivedAt;
        expect((testClient as any).cachedHierarchy.captureReceivedAt).toBe(firstReceivedAt);

        testTimer.advanceTime(10_000);
        const repeatedPushAt = testTimer.now();
        socket!.simulateMessage(JSON.stringify({ type: "hierarchy_update", data: hierarchy }));
        await flushPromises();

        expect((testClient as any).cachedHierarchy.receivedAt).toBe(repeatedPushAt);
        expect((testClient as any).cachedHierarchy.captureReceivedAt).toBe(firstReceivedAt);
      } finally {
        await testClient.close();
      }
    });

    test("invalidateCache should mark cache as not fresh", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        // Get hierarchy to populate cache
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const mockHierarchy: CtrlProxyHierarchy = {
          updatedAt: Date.now(),
          packageName: "com.test.app",
          hierarchy: { text: "Test" },
        };

        socket!.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            data: mockHierarchy,
          }),
        );

        await resultPromise;

        // Invalidate cache
        testClient.invalidateCache();

        // Cache still exists but is marked as stale (kept for the stale fallback
        // path). See ctrlProxyHierarchyCache.test.ts for the refetch semantics
        // this flag drives (issue #4193).
        expect(testClient.hasCachedHierarchy()).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("convertToViewHierarchyResult", function () {
    test("should convert CtrlProxyHierarchy to ViewHierarchyResult format", async function () {
      const testTimer = fakeTimer;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createSuccessWebSocketFactory(testTimer),
        testTimer,
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
                className: "UILabel",
              },
            ],
          },
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
          bottom: 60,
        });
        expect(result.hierarchy.node.$["clickable"]).toBe("true");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestClearText", function () {
    test("sends request_clear_text (not request_set_text)", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "clear_text_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 30,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("passes resourceId when provided", async function () {
      const testTimer = fakeTimer;

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
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

        socket!.simulateMessage(
          JSON.stringify({
            type: "clear_text_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 45,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("returns error when not connected", async function () {
      const testTimer = fakeTimer;

      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
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

  describe("getSupportedCommands", function () {
    test("returns the advertised command set (sorted) once the runner handshakes", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_shake", "add_highlight", "request_press_button"],
            supportedFeatures: ["display_cutout_info"],
          }),
        );
        await flushPromises();

        const commands = await testClient.getSupportedCommands();

        expect(commands).toEqual(["add_highlight", "request_press_button", "request_shake"]);
        // Cached accessor never opens a connection and mirrors the live set.
        expect(testClient.getCachedSupportedCommands()).toEqual([
          "add_highlight",
          "request_press_button",
          "request_shake",
        ]);
        expect(await testClient.getSupportedFeatures()).toEqual(["display_cutout_info"]);
        expect(testClient.getCachedSupportedFeatures()).toEqual(["display_cutout_info"]);
      } finally {
        await testClient.close();
      }
    });

    test("waits for the connected handshake that arrives after the socket opens", async function () {
      const testTimer = fakeTimer;
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        // Probe before any handshake — the runner sends `connected` a beat after
        // the WebSocket opens, simulating doctor being first to reach the runner.
        const pending = testClient.getSupportedCommands();

        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await flushPromises();

        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_shake", "add_highlight"],
          }),
        );

        const commands = await pending;
        expect(commands).toEqual(["add_highlight", "request_shake"]);
      } finally {
        await testClient.close();
      }
    });

    test("getExistingInstance does not create a client when none exists", function () {
      IOSCtrlProxyClient.resetInstances();
      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBeNull();

      const created = IOSCtrlProxyClient.getInstance(testDevice);
      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBe(created);
    });

    test("createDetached returns an unregistered client (not rediscoverable after close)", async function () {
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

    test("returns null when the runner cannot be reached", async function () {
      const testTimer = fakeTimer;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
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

  describe("SDK event ingestor forwarding", function () {
    test("forwards a hierarchy_update to the ingestor's recordLayoutTelemetryEvent", async function () {
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
        fakeIngestor,
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            timestamp: Date.now(),
            data: {
              updatedAt: 1750934583218,
              packageName: "com.example.ios",
              hierarchy: { text: "Welcome" },
            },
          }),
        );

        await flushPromises();

        expect(fakeIngestor.layoutEvents.length).toBe(1);
        expect(fakeIngestor.layoutEvents[0].packageName).toBe("com.example.ios");
      } finally {
        await testClient.close();
      }
    });

    test("forwards decoded SDK events from the /sdk-events poll to the ingestor", async function () {
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
        fakeIngestor,
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
          {
            bundleId: "com.example.ios",
            events: [{ eventType: "network_request", payload: encoded }],
          },
        ],
      })) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();

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
        await testClient.close();
      }
    });

    test("drains a navigation envelope before returning the SDK screen identity", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const payload = {
        destination: "ScrollPerformanceDemo",
        timestamp: 4242,
        arguments: { tab: "demos" },
        metadata: { presentation: "push" },
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          { bundleId: "com.example.ios", events: [{ eventType: "navigation", payload: encoded }] },
        ],
      })) as unknown as typeof fetch;

      try {
        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity).toMatchObject({
          platform: "ios",
          source: "sdk",
          confidence: "high",
          components: {
            bundleId: "com.example.ios",
            navigationRoute: "ScrollPerformanceDemo",
            selectedTab: "demos",
            presentation: "push",
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("keeps the newest navigation identity when SDK events arrive out of order", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (destination: string, timestamp: number): string =>
        Buffer.from(JSON.stringify({ destination, timestamp })).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          {
            bundleId: "com.example.ios",
            events: [
              { eventType: "navigation", payload: encode("NewScreen", 200) },
              { eventType: "navigation", payload: encode("OldScreen", 100) },
            ],
          },
        ],
      })) as unknown as typeof fetch;

      try {
        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity?.components.navigationRoute).toBe("NewScreen");
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("uses the navigation sequence to order same-millisecond SDK events", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (destination: string, sequenceNumber: number): string =>
        Buffer.from(
          JSON.stringify({
            destination,
            timestamp: 100,
            sequenceNumber,
          }),
        ).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          {
            bundleId: "com.example.ios",
            events: [
              { eventType: "navigation", payload: encode("NewScreen", 2) },
              { eventType: "navigation", payload: encode("OldScreen", 1) },
            ],
          },
        ],
      })) as unknown as typeof fetch;

      try {
        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity?.components.navigationRoute).toBe("NewScreen");
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("keeps the last navigation event when same-millisecond events lack a sequence", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (destination: string): string =>
        Buffer.from(JSON.stringify({ destination, timestamp: 100 })).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          {
            bundleId: "com.example.ios",
            events: [
              { eventType: "navigation", payload: encode("OldScreen") },
              { eventType: "navigation", payload: encode("NewScreen") },
            ],
          },
        ],
      })) as unknown as typeof fetch;

      try {
        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity?.components.navigationRoute).toBe("NewScreen");
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("retries an empty SDK-event drain within the identity refresh budget", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (destination: string, timestamp: number): string =>
        Buffer.from(
          JSON.stringify({
            destination,
            timestamp,
          }),
        ).toString("base64");
      const oldEvent = {
        bundleId: "com.example.ios",
        events: [{ eventType: "navigation", payload: encode("OldScreen", 1) }],
      };
      const newEvent = {
        bundleId: "com.example.ios",
        events: [{ eventType: "navigation", payload: encode("NewScreen", 2) }],
      };
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        polls += 1;
        return {
          ok: true,
          json: async () => {
            if (polls === 1) {
              return [oldEvent];
            }
            return fakeTimer.now() >= 50 ? [newEvent] : [];
          },
        };
      }) as unknown as typeof fetch;

      try {
        await testClient.refreshSdkScreenIdentity("com.example.ios");

        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity?.components.navigationRoute).toBe("NewScreen");
        expect(fakeTimer.now()).toBe(50);
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("retries after telemetry until the requested app reports navigation", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const oldEvent = {
        bundleId: "com.example.ios",
        events: [
          { eventType: "navigation", payload: encode({ destination: "OldScreen", timestamp: 1 }) },
        ],
      };
      const telemetry = {
        bundleId: "com.example.ios",
        events: [
          {
            eventType: "network_request",
            payload: encode({ timestamp: 2, url: "https://example.test" }),
          },
        ],
      };
      const newEvent = {
        bundleId: "com.example.ios",
        events: [
          { eventType: "navigation", payload: encode({ destination: "NewScreen", timestamp: 3 }) },
        ],
      };
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        polls += 1;
        return {
          ok: true,
          json: async () => (polls === 1 ? [oldEvent] : polls === 2 ? [telemetry] : [newEvent]),
        };
      }) as unknown as typeof fetch;

      try {
        await testClient.refreshSdkScreenIdentity("com.example.ios");

        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity?.components.navigationRoute).toBe("NewScreen");
        expect(polls).toBe(3);
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("caches navigation identities before awaited telemetry ingestion", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      let releaseTelemetry: (() => void) | undefined;
      const blockingIngestor = new FakeIosSdkEventIngestor();
      blockingIngestor.recordSdkEvent = async () =>
        new Promise<void>((resolve) => {
          releaseTelemetry = resolve;
        });
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
        undefined,
        undefined,
        undefined,
        blockingIngestor,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "network_request",
                payload: encode({ timestamp: 1, url: "https://example.test" }),
              },
              {
                eventType: "navigation",
                payload: encode({ timestamp: 2, destination: "NewScreen" }),
              },
            ],
          },
        ],
      })) as unknown as typeof fetch;

      try {
        const identity = testClient.refreshSdkScreenIdentity("com.example.ios");
        fakeTimer.advanceTime(100);

        expect((await identity)?.components.navigationRoute).toBe("NewScreen");
      } finally {
        releaseTelemetry?.();
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("clears SDK identities for a replaced application process", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encoded = Buffer.from(
        JSON.stringify({ destination: "OldScreen", timestamp: 1 }),
      ).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          { bundleId: "com.example.ios", events: [{ eventType: "navigation", payload: encoded }] },
        ],
      })) as unknown as typeof fetch;

      try {
        await testClient.refreshSdkScreenIdentity("com.example.ios");
        testClient.clearSdkScreenIdentity("com.example.ios");

        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("rejects late navigation from a process replaced by a session announcement", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (
        destination: string,
        timestamp: number,
        sessionId: string,
        sessionEpoch: number,
      ): string =>
        Buffer.from(JSON.stringify({ destination, timestamp, sessionId, sessionEpoch })).toString(
          "base64",
        );
      const oldEvent = {
        bundleId: "com.example.ios",
        events: [{ eventType: "navigation", payload: encode("OldProcess", 1, "old-session", 1) }],
      };
      const newSessionEvent = {
        bundleId: "com.example.ios",
        events: [
          {
            eventType: "lifecycle",
            payload: Buffer.from(
              JSON.stringify({
                state: "sdk_session_started",
                timestamp: 2,
                sessionId: "new-session",
                sessionEpoch: 2,
                trackingGeneration: 0,
              }),
            ).toString("base64"),
          },
        ],
      };
      const newEvent = {
        bundleId: "com.example.ios",
        events: [{ eventType: "navigation", payload: encode("NewProcess", 3, "new-session", 2) }],
      };
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        polls += 1;
        return {
          ok: true,
          json: async () =>
            polls === 1
              ? [oldEvent]
              : polls === 2
                ? [newSessionEvent]
                : polls === 3
                  ? [oldEvent]
                  : [newEvent],
        };
      }) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "OldProcess",
        );

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "NewProcess",
        );
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("resets tracking fences when a newer SDK session starts", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const batches = [
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "navigation",
                payload: encode({
                  destination: "Old",
                  timestamp: 1,
                  sessionId: "old-session",
                  sessionEpoch: 1,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_tracking_disabled",
                  timestamp: 2,
                  sessionId: "old-session",
                  sessionEpoch: 1,
                  trackingGeneration: 1,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_session_started",
                  timestamp: 3,
                  sessionId: "new-session",
                  sessionEpoch: 2,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "navigation",
                payload: encode({
                  destination: "New",
                  timestamp: 4,
                  sessionId: "new-session",
                  sessionEpoch: 2,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
      ];
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => batches[polls++],
      })) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "Old",
        );

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "New",
        );
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("ignores a delayed session announcement from an older epoch", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const batches = [
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_session_started",
                  timestamp: 2,
                  sessionId: "current-session",
                  sessionEpoch: 2,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_session_started",
                  timestamp: 1,
                  sessionId: "persisted-session",
                  sessionEpoch: 1,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "navigation",
                payload: encode({
                  destination: "Current",
                  timestamp: 3,
                  sessionId: "current-session",
                  sessionEpoch: 2,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
      ];
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => batches[polls++],
      })) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();

        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "Current",
        );
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("ignores a delayed tracking control from an older session", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const batches = [
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_session_started",
                  timestamp: 2,
                  sessionId: "current-session",
                  sessionEpoch: 2,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_tracking_disabled",
                  timestamp: 1,
                  sessionId: "persisted-session",
                  sessionEpoch: 1,
                  trackingGeneration: 5,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "navigation",
                payload: encode({
                  destination: "Current",
                  timestamp: 3,
                  sessionId: "current-session",
                  sessionEpoch: 2,
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
      ];
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => batches[polls++],
      })) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();

        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "Current",
        );
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("accepts navigation after an in-band tracking disable and enable", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_tracking_disabled",
                  timestamp: 1,
                  sessionId: "session",
                  sessionEpoch: 1,
                  trackingGeneration: 1,
                }),
              },
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_tracking_enabled",
                  timestamp: 2,
                  sessionId: "session",
                  sessionEpoch: 1,
                  trackingGeneration: 2,
                }),
              },
              {
                eventType: "navigation",
                payload: encode({
                  destination: "Discover",
                  timestamp: 3,
                  sessionId: "session",
                  sessionEpoch: 1,
                  trackingGeneration: 2,
                }),
              },
            ],
          },
        ],
      })) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();

        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "Discover",
        );
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("treats a malformed SDK event batch as a non-fatal empty poll", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [{ bundleId: "com.example.ios", events: {} }],
      })) as unknown as typeof fetch;

      try {
        const result = await (
          testClient as unknown as { pollSdkEvents(): Promise<{ receivedEvents: boolean }> }
        ).pollSdkEvents();

        expect(result.receivedEvents).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("backs off the SDK-event poll after consecutive empty batches (#5472)", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [],
      })) as unknown as typeof fetch;
      const internals = testClient as unknown as {
        runSdkEventPollCycle(generation: number): Promise<void>;
        currentSdkEventPollIntervalMs(): number;
        stopSdkEventPolling(): void;
        sdkEventPollGeneration: number;
        sdkEventPollConsecutiveEmpty: number;
      };

      try {
        const generation = internals.sdkEventPollGeneration;
        // Below the threshold the poll stays at the fast 2s cadence.
        for (let i = 0; i < 4; i++) {
          await internals.runSdkEventPollCycle(generation);
        }
        expect(internals.sdkEventPollConsecutiveEmpty).toBe(4);
        expect(internals.currentSdkEventPollIntervalMs()).toBe(2000);

        // The 5th consecutive empty batch trips the backoff to the slow cadence.
        await internals.runSdkEventPollCycle(generation);
        expect(internals.sdkEventPollConsecutiveEmpty).toBe(5);
        expect(internals.currentSdkEventPollIntervalMs()).toBe(30_000);

        internals.stopSdkEventPolling();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("resets SDK-event poll backoff on inbound WebSocket activity (#5472)", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [],
      })) as unknown as typeof fetch;
      const internals = testClient as unknown as {
        runSdkEventPollCycle(generation: number): Promise<void>;
        handleMessage(data: unknown): void;
        currentSdkEventPollIntervalMs(): number;
        stopSdkEventPolling(): void;
        sdkEventPollGeneration: number;
        sdkEventPollConsecutiveEmpty: number;
      };

      try {
        const generation = internals.sdkEventPollGeneration;
        for (let i = 0; i < 5; i++) {
          await internals.runSdkEventPollCycle(generation);
        }
        expect(internals.currentSdkEventPollIntervalMs()).toBe(30_000);

        // Any inbound runner frame is treated as app activity: reset the empty
        // counter and restore fast cadence, even for an unrecognized message type.
        internals.handleMessage(Buffer.from(JSON.stringify({ type: "unrecognized" })));

        expect(internals.sdkEventPollConsecutiveEmpty).toBe(0);
        expect(internals.currentSdkEventPollIntervalMs()).toBe(2000);

        internals.stopSdkEventPolling();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("orders tracking re-enable before an earlier-arriving navigation event", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      const batches = [
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "navigation",
                payload: encode({
                  destination: "Settings",
                  timestamp: 1,
                  sessionId: "session",
                  trackingGeneration: 0,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "lifecycle",
                payload: encode({
                  state: "sdk_tracking_disabled",
                  timestamp: 2,
                  sessionId: "session",
                  trackingGeneration: 1,
                }),
              },
            ],
          },
        ],
        [
          {
            bundleId: "com.example.ios",
            events: [
              {
                eventType: "navigation",
                payload: encode({
                  destination: "Discover",
                  timestamp: 3,
                  sessionId: "session",
                  trackingGeneration: 2,
                }),
              },
            ],
          },
        ],
      ];
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => batches[polls++],
      })) as unknown as typeof fetch;

      try {
        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "Settings",
        );

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();

        await (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        expect(testClient.getSdkScreenIdentity("com.example.ios")?.components.navigationRoute).toBe(
          "Discover",
        );
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("clears every SDK identity when the CtrlProxy connection resets", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encoded = Buffer.from(
        JSON.stringify({ destination: "OldScreen", timestamp: 1 }),
      ).toString("base64");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => [
          { bundleId: "com.example.ios", events: [{ eventType: "navigation", payload: encoded }] },
        ],
      })) as unknown as typeof fetch;

      try {
        await testClient.refreshSdkScreenIdentity("com.example.ios");
        (testClient as unknown as { onConnectionClosed(): void }).onConnectionClosed();

        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("does not restore an SDK identity after the application is cleared during a poll", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encoded = Buffer.from(
        JSON.stringify({ destination: "StaleScreen", timestamp: 100 }),
      ).toString("base64");
      let releaseFetch:
        | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
        | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          releaseFetch = resolve;
        })) as unknown as typeof fetch;

      try {
        const poll = (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await flushPromises();
        testClient.clearSdkScreenIdentity("com.example.ios");
        releaseFetch?.({
          ok: true,
          json: async () => [
            {
              bundleId: "com.example.ios",
              events: [{ eventType: "navigation", payload: encoded }],
            },
          ],
        });
        await poll;

        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("does not let a malformed navigation timestamp poison later identity ordering", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encode = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString("base64");
      let polls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        polls += 1;
        return {
          ok: true,
          json: async () => [
            {
              bundleId: "com.example.ios",
              events: [
                {
                  eventType: "navigation",
                  payload: encode(
                    polls === 1
                      ? { destination: "Poisoned", timestamp: "not-a-number" }
                      : { destination: "Fresh", timestamp: fakeTimer.now() + 1_000 },
                  ),
                },
              ],
            },
          ],
        };
      }) as unknown as typeof fetch;

      try {
        await testClient.refreshSdkScreenIdentity("com.example.ios");
        const identity = await testClient.refreshSdkScreenIdentity("com.example.ios");

        expect(identity?.components.navigationRoute).toBe("Fresh");
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("does not restore an SDK identity after the connection closes during a poll", async function () {
      const { factory } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const encoded = Buffer.from(
        JSON.stringify({ destination: "StaleScreen", timestamp: 100 }),
      ).toString("base64");
      let releaseFetch:
        | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
        | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          releaseFetch = resolve;
        })) as unknown as typeof fetch;

      try {
        const poll = (testClient as unknown as { pollSdkEvents(): Promise<void> }).pollSdkEvents();
        await flushPromises();
        (testClient as unknown as { onConnectionClosed(): void }).onConnectionClosed();
        releaseFetch?.({
          ok: true,
          json: async () => [
            {
              bundleId: "com.example.ios",
              events: [{ eventType: "navigation", payload: encoded }],
            },
          ],
        });
        await poll;

        expect(testClient.getSdkScreenIdentity("com.example.ios")).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });

    test("falls back without waiting for a stalled SDK-event poll", async function () {
      const controlledTimer = new FakeTimer();
      const { factory } = createCapturingWebSocketFactory(controlledTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        controlledTimer,
      );
      let releaseFetch:
        | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
        | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          releaseFetch = resolve;
        })) as unknown as typeof fetch;

      try {
        const identity = testClient.refreshSdkScreenIdentity("com.example.ios");
        controlledTimer.advanceTime(100);

        expect(await identity).toBeUndefined();
        releaseFetch?.({ ok: true, json: async () => [] });
        await flushPromises();
      } finally {
        globalThis.fetch = originalFetch;
        await testClient.close();
      }
    });
  });

  describe("capture provenance for screenshot geometry (issue #3348)", function () {
    // The iOS ordering rule: geometry must be derived from a hierarchy BEFORE it is pushed, so the
    // identity the daemon assigns is recorded against the geometry it actually describes.

    test("binds an explicitly forwarded initial hierarchy for later static-screen screenshots", function () {
      let backoffStarts = 0;
      (ctrlProxyClient as any).startScreenshotBackoff = () => {
        backoffStarts++;
      };

      ctrlProxyClient.recordInitialObservationStreamHierarchy(
        {
          hierarchy: {},
          screenWidth: 390,
          screenHeight: 844,
          screenScale: 3,
        },
        42,
      );

      expect((ctrlProxyClient as any).screenGeometry.bind()).toEqual({
        captureSequence: 42,
        width: 1170,
        height: 2532,
      });
      expect(backoffStarts).toBe(1);
    });

    test("drops stale provenance when an initial hierarchy has no assigned identity", function () {
      const geometry = (ctrlProxyClient as any).screenGeometry;
      geometry.update(1170, 2532);
      geometry.markForwarded(41);

      ctrlProxyClient.recordInitialObservationStreamHierarchy(
        {
          hierarchy: {},
          screenWidth: 390,
          screenHeight: 844,
          screenScale: 3,
        },
        null,
      );

      expect(geometry.bind()).toBeNull();
    });

    const startStreamServer = async (): Promise<FakeSocket> => {
      await stopDeviceDataStreamSocketServer();
      const server = await startDeviceDataStreamSocketServer(fakeTimer);
      const socket = new FakeSocket();
      await (server as any).processLine(
        socket as any,
        JSON.stringify({
          id: "subscribe-capture-provenance",
          command: "subscribe",
          deviceId: testDevice.deviceId,
          screenshotIntervalMs: 250,
        }),
      );
      socket.reset();
      return socket;
    };

    /**
     * Forward a hierarchy the way processMessage does: the SOURCE hierarchy is handed to the push
     * alongside the converted result. The cache is deliberately left holding something ELSE, which
     * is the real request/response ordering — processMessage forwards the converted response before
     * requestHierarchySync resumes and installs it in the cache.
     */
    const forwardHierarchy = (
      screenWidth: number,
      screenHeight: number,
      screenScale: number,
    ): void => {
      (ctrlProxyClient as any).pushHierarchyToObservationStream({ hierarchy: {} } as any, {
        screenWidth,
        screenHeight,
        screenScale,
      });
    };

    /** Put a DIFFERENT hierarchy in the cache, so a cache-reading implementation is caught. */
    const setStaleCache = (
      screenWidth: number,
      screenHeight: number,
      screenScale: number,
    ): void => {
      (ctrlProxyClient as any).cachedHierarchy = {
        hierarchy: { screenWidth, screenHeight, screenScale },
        receivedAt: fakeTimer.now(),
        fresh: true,
      };
    };

    test("derives geometry from the hierarchy being forwarded, not from the cache", async function () {
      await startStreamServer();
      const geometry = (ctrlProxyClient as any).screenGeometry;

      // The cache is EMPTY, exactly as it is when the first request/response hierarchy is forwarded
      // (processMessage pushes before requestHierarchySync installs it). A cache-reading
      // implementation clears geometry here and never establishes provenance at all.
      forwardHierarchy(390, 844, 3);
      expect(geometry.bind()).toEqual({
        captureSequence: expect.any(Number),
        width: 1170,
        height: 2532,
      });

      // Now the cache holds the PREVIOUS hierarchy while a resolution-changing response is
      // forwarded. A cache-reading implementation would associate the new capture id with the old
      // 1170x2532 dimensions, so screenshots could not pair until another hierarchy arrived.
      setStaleCache(390, 844, 3);
      forwardHierarchy(320, 693, 3);

      const bound = geometry.bind();
      expect(bound).not.toBeNull();
      expect(bound.width).toBe(960);
      expect(bound.height).toBe(2079);
    });

    test("clears tracked geometry when the forwarded hierarchy reports none", async function () {
      await startStreamServer();
      const geometry = (ctrlProxyClient as any).screenGeometry;

      forwardHierarchy(390, 844, 3);
      expect(geometry.bind()).not.toBeNull();

      // A forwarded hierarchy with no usable screen size must not leave the previous dimensions
      // vouched for — even though the cache still holds a perfectly good one.
      setStaleCache(390, 844, 3);
      (ctrlProxyClient as any).pushHierarchyToObservationStream(
        { hierarchy: {} } as any,
        {} as any,
      );
      expect(geometry.bind()).toBeNull();
    });

    describe("scale metadata retention (issue #4548)", function () {
      /**
       * Deliver a hierarchy the way the runner does — a raw `hierarchy_update` through
       * `processMessage` — so retention is exercised on RECEIPT, not via the observation-stream
       * push. A `requestId` routes it as a request-response update (the push-gated path); omitting
       * it routes it as a spontaneous push.
       */
      const receiveHierarchy = (data: Record<string, unknown>, requestId?: string): void => {
        (ctrlProxyClient as any).processMessage({
          type: "hierarchy_update",
          ...(requestId ? { requestId } : {}),
          timestamp: fakeTimer.now(),
          data: { packageName: "com.example.ios", hierarchy: {}, ...data },
        });
      };

      const fullMetadata = {
        screenWidth: 375,
        screenHeight: 812,
        screenScale: 3,
        nativeScale: 3.144,
        pixelWidth: 1179,
        pixelHeight: 2553,
      };
      const expectedFull = { nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 2553 };

      test("retains metadata on receipt even when NO device-data stream server is running", async function () {
        // No startStreamServer() here: the push early-returns with no server
        // (pushHierarchyToObservationStream ~2050), so a push-gated retention would leave this
        // null. Receipt-based retention must not. (afterEach stops any server from other tests.)
        await stopDeviceDataStreamSocketServer();
        receiveHierarchy(fullMetadata);
        expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual(expectedFull);
      });

      test("retains metadata on receipt even when the observation-stream push is SUPPRESSED", async function () {
        await startStreamServer();
        // Arm an initial-frame suppression for a requestId, then deliver that response. The push is
        // skipped (consumeHierarchyObservationStreamSuppression), but retention still happens.
        const requestId = "req-suppressed-1";
        (ctrlProxyClient as any).hierarchyObservationStreamSuppressions.set(
          requestId,
          fakeTimer.setTimeout(() => {}, 10_000),
        );
        receiveHierarchy(fullMetadata, requestId);
        // Prove the push really was suppressed (the suppression was consumed).
        expect((ctrlProxyClient as any).hierarchyObservationStreamSuppressions.has(requestId)).toBe(
          false,
        );
        expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual(expectedFull);
      });

      test("canonical pixels (#4549): the tracked geometry claim uses nativeScale pixel dims", async function () {
        await startStreamServer();
        const geometry = (ctrlProxyClient as any).screenGeometry;

        // Display Zoom values chosen so the two computations DISAGREE: points * screenScale
        // (375*3=1125, 812*3=2436) vs the runner-reported pixel dims points * nativeScale
        // (1179x2553). Under #4549 the capture-identity claim must equal the screenshot's real
        // pixels, which XCUIScreenshot renders at NATIVE scale — so the claim is 1179x2553, NOT the
        // old screenScale computation. This is what makes the daemon's exact pixel pairing work
        // under Display Zoom.
        receiveHierarchy(fullMetadata);
        expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual(expectedFull);
        const bound = geometry.bind();
        expect(bound.width).toBe(1179);
        expect(bound.height).toBe(2553);
      });

      test("legacy hierarchy without the fields: metadata is null", function () {
        receiveHierarchy({ screenWidth: 390, screenHeight: 844, screenScale: 3 });
        expect(ctrlProxyClient.getScreenScaleMetadata()).toBeNull();
      });

      test("a later hierarchy without the fields resets retained metadata to null", function () {
        receiveHierarchy(fullMetadata);
        expect(ctrlProxyClient.getScreenScaleMetadata()).not.toBeNull();

        // e.g. the device reconnects to a pre-#4548 runner: stale metadata must not survive.
        receiveHierarchy({ screenWidth: 375, screenHeight: 812, screenScale: 3 });
        expect(ctrlProxyClient.getScreenScaleMetadata()).toBeNull();
      });

      test("partial or degenerate metadata is never retained", function () {
        const base = { screenWidth: 375, screenHeight: 812, screenScale: 3 };
        const degenerates = [
          { nativeScale: 3.144, pixelWidth: 1179 }, // missing pixelHeight
          { nativeScale: 0, pixelWidth: 1179, pixelHeight: 2553 },
          { nativeScale: -1, pixelWidth: 1179, pixelHeight: 2553 },
          { nativeScale: Number.NaN, pixelWidth: 1179, pixelHeight: 2553 },
          { nativeScale: 3.144, pixelWidth: 0, pixelHeight: 2553 },
          { nativeScale: 3.144, pixelWidth: 1179, pixelHeight: Number.POSITIVE_INFINITY },
        ];
        for (const metadata of degenerates) {
          receiveHierarchy({ ...base, ...metadata });
          expect(ctrlProxyClient.getScreenScaleMetadata()).toBeNull();
        }
      });

      test("golden scaleReporting rows round-trip through retention", function () {
        const vectors = loadCoordinateMappingVectors().scaleReporting;
        expect(vectors.length).toBeGreaterThan(0);
        for (const vector of vectors) {
          receiveHierarchy({
            screenWidth: vector.pointWidth,
            screenHeight: vector.pointHeight,
            screenScale: 3,
            nativeScale: vector.nativeScale,
            pixelWidth: vector.expectedPixelWidth,
            pixelHeight: vector.expectedPixelHeight,
          });
          expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual({
            nativeScale: vector.nativeScale,
            pixelWidth: vector.expectedPixelWidth,
            pixelHeight: vector.expectedPixelHeight,
          });
        }
      });

      test("stamps the screenshot's coordinateSpace from the request-time binding, not later metadata (#4549)", async function () {
        const socket = await startStreamServer();
        const geometry = (ctrlProxyClient as any).screenGeometry;

        // Bind a CANONICAL-PIXEL capture: forward a hierarchy carrying complete #4548 scale metadata.
        (ctrlProxyClient as any).pushHierarchyToObservationStream({ hierarchy: {} } as any, {
          screenWidth: 375,
          screenHeight: 812,
          screenScale: 3,
          nativeScale: 3,
          pixelWidth: 1125,
          pixelHeight: 2436,
        });
        const boundPx = geometry.bind();
        expect(boundPx.coordinateSpace).toBe("px");
        expect(boundPx.nativeScale).toBe(3);

        // A legacy hierarchy arrives while the frame is in flight, flipping the LATEST metadata to
        // null. Reading it at delivery would DROP the px declaration from a canonical-bound frame.
        (ctrlProxyClient as any).reportedScaleMetadata = null;
        socket.reset();

        (ctrlProxyClient as any).pushScreenshotToObservationStream(
          "c2hvdA==",
          boundPx.width,
          boundPx.height,
          undefined,
          boundPx.captureSequence,
          boundPx.coordinateSpace,
          boundPx.nativeScale,
        );
        const pxShot = socket.getWrittenMessages<any>().find((m) => m.type === "screenshot_update");
        expect(pxShot.coordinateSpace).toBe("px"); // the bound value, NOT the flipped-to-null metadata
        expect(pxShot.nativeScale).toBe(3);

        // Reverse: a LEGACY-bound capture must not gain px just because metadata later appeared.
        (ctrlProxyClient as any).pushHierarchyToObservationStream({ hierarchy: {} } as any, {
          screenWidth: 320,
          screenHeight: 693,
          screenScale: 3, // no nativeScale => legacy binding
        });
        const boundLegacy = geometry.bind();
        expect(boundLegacy.coordinateSpace).toBeUndefined();
        expect(boundLegacy.nativeScale).toBeUndefined();

        (ctrlProxyClient as any).reportedScaleMetadata = {
          nativeScale: 3,
          pixelWidth: 960,
          pixelHeight: 2079,
        };
        socket.reset();

        (ctrlProxyClient as any).pushScreenshotToObservationStream(
          "c2hvdA==",
          boundLegacy.width,
          boundLegacy.height,
          undefined,
          boundLegacy.captureSequence,
          boundLegacy.coordinateSpace,
          boundLegacy.nativeScale,
        );
        const legacyShot = socket
          .getWrittenMessages<any>()
          .find((m) => m.type === "screenshot_update");
        expect(legacyShot.coordinateSpace).toBeUndefined(); // bound legacy, NOT the flipped-to-px metadata
        expect(legacyShot.nativeScale).toBeUndefined();
      });
    });

    describe("coordinate-mapping golden vectors: LIVE iOS point->pixel (issue #4547)", function () {
      // The bootstrap path (observationInitialFrame's getIosScreenshotDimensions) and this LIVE
      // hierarchy-update path (updateScreenGeometryFrom) are SEPARATE implementations of the same
      // points * screenScale conversion. Both consume the shared golden vectors independently, so
      // a #4549 canonical-pixel change (or any drift) in either path fails its own consumer —
      // green tests on one path can never vouch for the other.
      const vectors = loadCoordinateMappingVectors().iosPointToPixel;

      for (const [index, vector] of vectors.entries()) {
        test(`row ${index}: ${vector.pointWidth}x${vector.pointHeight} points at scale ${vector.scale || "absent"} -> ${vector.expectedPixelWidth}x${vector.expectedPixelHeight} pixels`, async function () {
          await startStreamServer();
          const geometry = (ctrlProxyClient as any).screenGeometry;

          // scale === 0 encodes "hierarchy carried no screenScale" (the live path defaults to 1).
          (ctrlProxyClient as any).pushHierarchyToObservationStream({ hierarchy: {} } as any, {
            screenWidth: vector.pointWidth,
            screenHeight: vector.pointHeight,
            ...(vector.scale === 0 ? {} : { screenScale: vector.scale }),
          });

          const bound = geometry.bind();
          expect(bound).not.toBeNull();
          expect(bound.width).toBe(vector.expectedPixelWidth);
          expect(bound.height).toBe(vector.expectedPixelHeight);
        });
      }
    });
  });

  describe("verifyServiceReady", function () {
    // Regression pin for the iOS readiness loop (issue #5460). Behaviour under test:
    // the two-phase probe (ensureConnected -> on false, count a failed attempt and
    // wait; else requestHierarchySync and succeed on a truthy `hierarchy`), the
    // maxAttempts budget, the fixed between-attempts delay, and the boolean outcome.
    //
    // Each test stubs `ensureConnected` and `requestHierarchySync` on a fresh
    // instance so no WebSocket/runner is involved, and drives an auto-advancing
    // FakeTimer so the delays resolve without wall-clock time. `getSleepHistory()`
    // pins the exact number of between-attempts waits — this is where the one
    // intentional behaviour change lands (RetryExecutor waits between attempts only,
    // i.e. maxAttempts - 1 waits, dropping the old loop's wasted trailing wait after
    // the final failed attempt).
    interface ProbeStub {
      connect: boolean[] | boolean;
      hierarchy: Array<{ hierarchy: unknown } | null | Error>;
    }

    const buildClient = (timer: FakeTimer, stub: ProbeStub): IOSCtrlProxyClient => {
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createSuccessWebSocketFactory(timer),
        timer,
        undefined,
        undefined,
        undefined,
        undefined,
        // Retry delays must run on the SAME fake timer so the test controls them.
        new DefaultRetryExecutor(timer),
      );

      let connectIndex = 0;
      (client as any).ensureConnected = async (): Promise<boolean> => {
        if (typeof stub.connect === "boolean") {
          return stub.connect;
        }
        const value = stub.connect[Math.min(connectIndex, stub.connect.length - 1)]!;
        connectIndex++;
        return value;
      };

      let hierarchyIndex = 0;
      (client as any).requestHierarchySync = async (): Promise<{ hierarchy: unknown } | null> => {
        const value = stub.hierarchy[Math.min(hierarchyIndex, stub.hierarchy.length - 1)]!;
        hierarchyIndex++;
        if (value instanceof Error) {
          throw value;
        }
        return value;
      };

      return client;
    };

    test("returns true on the first attempt when connected and hierarchy is present", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const client = buildClient(timer, { connect: true, hierarchy: [{ hierarchy: {} }] });
      try {
        expect(await client.verifyServiceReady(3, 1000, 5000)).toBe(true);
        // Success on attempt 1 waits zero times.
        expect(timer.getSleepHistory()).toEqual([]);
      } finally {
        await client.close();
      }
    });

    test("two-phase probe: a failed connection consumes an attempt, then it succeeds", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      // Attempt 1 fails to connect (waits, no hierarchy request), attempt 2 connects
      // and returns a hierarchy.
      const client = buildClient(timer, { connect: [false, true], hierarchy: [{ hierarchy: {} }] });
      try {
        expect(await client.verifyServiceReady(3, 1000, 5000)).toBe(true);
        expect(timer.getSleepHistory()).toEqual([1000]);
      } finally {
        await client.close();
      }
    });

    test("retries when connected but hierarchy is null, then succeeds", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const client = buildClient(timer, { connect: true, hierarchy: [null, { hierarchy: {} }] });
      try {
        expect(await client.verifyServiceReady(3, 1000, 5000)).toBe(true);
        expect(timer.getSleepHistory()).toEqual([1000]);
      } finally {
        await client.close();
      }
    });

    test("treats a thrown hierarchy request as a failed attempt", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const client = buildClient(timer, {
        connect: true,
        hierarchy: [new Error("hierarchy request failed"), { hierarchy: {} }],
      });
      try {
        expect(await client.verifyServiceReady(3, 1000, 5000)).toBe(true);
        expect(timer.getSleepHistory()).toEqual([1000]);
      } finally {
        await client.close();
      }
    });

    test("returns false after exhausting maxAttempts when hierarchy never becomes ready", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const client = buildClient(timer, { connect: true, hierarchy: [null] });
      try {
        expect(await client.verifyServiceReady(3, 1000, 5000)).toBe(false);
        // Three attempts, waiting only BETWEEN attempts (RetryExecutor semantics):
        // maxAttempts - 1 = 2 waits, no wasted trailing wait after the final failure.
        expect(timer.getSleepHistory()).toEqual([1000, 1000]);
      } finally {
        await client.close();
      }
    });

    test("returns false when the device never connects", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const client = buildClient(timer, { connect: false, hierarchy: [null] });
      try {
        expect(await client.verifyServiceReady(3, 1000, 5000)).toBe(false);
        expect(timer.getSleepHistory()).toEqual([1000, 1000]);
      } finally {
        await client.close();
      }
    });
  });
});
