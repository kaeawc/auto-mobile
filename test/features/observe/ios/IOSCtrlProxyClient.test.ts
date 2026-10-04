import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyClient, CtrlProxyHierarchy } from "../../../../src/features/observe/ios";
import {
  CtrlProxyServicePortChangedError,
  IOS_RUNNER_FEATURE_FLAGS,
  SdkCapabilityProbeSupersededError,
  getRequiredIosRunnerFeatureFlags,
} from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { BootedDevice, HighlightShape } from "../../../../src/models";
import { ActionableError } from "../../../../src/models/ActionableError";
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
import { FakeScreenshotBackoffScheduler } from "../../../fakes/FakeScreenshotBackoffScheduler";
import type { DeviceConnectionLostNotifier } from "../../../../src/features/observe/DeviceConnectionLostNotifier";
import { FakeIosSdkEventIngestor } from "../../../fakes/FakeIosSdkEventIngestor";
import { loadCoordinateMappingVectors } from "../../../parity/coordinateMappingGoldenVectors";
import { logger } from "../../../../src/utils/logger";
import {
  IOSCtrlProxyManager,
  type CtrlProxyIosManager,
} from "../../../../src/ctrlProxy/IOSCtrlProxyManager";
import { ForcedRestartBudget } from "../../../../src/ctrlProxy/ForcedRestartBudget";
import {
  DeviceDataStreamSocketServer,
  installDeviceDataStreamSocketServerForTesting,
} from "../../../../src/daemon/deviceDataStreamSocketServer";
import { SimCtlClient } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import { PortManager } from "../../../../src/utils/PortManager";
import { displayTransitions } from "../../../../src/features/observe/DisplayTransition";

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

  test("single-panel requestScreenshot uses the runner without invoking simctl", async () => {
    testDevice.displays = {
      panels: [{ key: "primary", role: "unknown", sizePx: { width: 1179, height: 2556 } }],
      postures: ["unknown"],
    };
    const runner = spyOn(ctrlProxyClient["screenshot"], "requestScreenshot").mockResolvedValue({
      success: true,
      data: "runner",
    });
    const simctl = spyOn(SimCtlClient.prototype, "screenshot").mockResolvedValue(Buffer.alloc(0));
    try {
      expect((await ctrlProxyClient.requestScreenshot()).data).toBe("runner");
      expect(runner).toHaveBeenCalledTimes(1);
      expect(simctl).not.toHaveBeenCalled();
    } finally {
      runner.mockRestore();
      simctl.mockRestore();
    }
  });

  test("a hierarchy cached before a Duo transition cannot select its old screenshot panel", async () => {
    testDevice.displays = {
      panels: [
        { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 } },
        { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 } },
      ],
      postures: ["closed", "opened"],
    };
    ctrlProxyClient["cachedHierarchy"] = {
      hierarchy: {
        updatedAt: 1,
        packageName: "com.example.app",
        hierarchy: {},
        pixelWidth: 1398,
        pixelHeight: 2034,
      },
      receivedAt: 0,
      fresh: true,
    };
    ctrlProxyClient["cachedHierarchyDisplayRevision"] = displayTransitions.revision(
      testDevice.deviceId,
    );
    displayTransitions.notifyTransition(testDevice.deviceId, "hinge changed");
    const runner = spyOn(ctrlProxyClient["screenshot"], "requestScreenshot").mockResolvedValue({
      success: true,
      data: "runner",
    });
    const simctl = spyOn(SimCtlClient.prototype, "screenshot").mockResolvedValue(Buffer.alloc(0));
    try {
      expect((await ctrlProxyClient.requestScreenshot()).data).toBe("runner");
      expect(runner).toHaveBeenCalledTimes(1);
      expect(simctl).not.toHaveBeenCalled();
    } finally {
      runner.mockRestore();
      simctl.mockRestore();
      displayTransitions.reset(testDevice.deviceId);
    }
  });

  afterEach(async function () {
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

  const createCapturingConnectionTimeoutWebSocketFactory = (
    timer: FakeTimer,
  ): {
    factory: (url: string) => FakeWebSocket;
    getSocket: () => FakeWebSocket | null;
    getCreatedSocketCount: () => number;
  } => {
    const sockets: FakeWebSocket[] = [];

    return {
      factory: (url: string) => {
        const socket = new FakeWebSocket(url, "timeout", 60000, timer);
        sockets.push(socket);
        return socket;
      },
      getSocket: () => sockets[sockets.length - 1] ?? null,
      getCreatedSocketCount: () => sockets.length,
    };
  };

  const createTrackedAbortSignal = (): {
    signal: AbortSignal;
    abort: (reason: unknown) => void;
    getListenerCount: () => number;
  } => {
    let aborted = false;
    let reason: unknown;
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const signal = {
      get aborted(): boolean {
        return aborted;
      },
      get reason(): unknown {
        return reason;
      },
      throwIfAborted(): void {
        if (aborted) {
          throw reason;
        }
      },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;

    return {
      signal,
      abort: (abortReason: unknown) => {
        aborted = true;
        reason = abortReason;
        const event = new Event("abort");
        for (const listener of [...listeners]) {
          if (typeof listener === "function") {
            listener(event);
          } else {
            listener.handleEvent(event);
          }
        }
      },
      getListenerCount: () => listeners.size,
    };
  };

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

  const flushMicrotasks = async (iterations: number = 5): Promise<void> => {
    for (let i = 0; i < iterations; i += 1) {
      await Promise.resolve();
    }
  };

  const respondToSdkCapabilityQuery = async (
    socket: CapturingWebSocket,
    available: boolean,
    bundleId?: string,
    minimumQueryCount: number = 1,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const requests = socket.sentMessages
        .map((message) => JSON.parse(message))
        .filter((payload) => payload.type === "get_sdk_capabilities");
      const request = requests.at(-1);
      if (request && requests.length >= minimumQueryCount) {
        socket.simulateMessage(
          JSON.stringify({
            type: "sdk_capabilities_result",
            requestId: request.requestId,
            success: true,
            available,
            bundleId,
            capabilities: available
              ? [
                  "hierarchy",
                  "network_mocking",
                  "network_error_simulation",
                  "database",
                  "highlight",
                ]
              : [],
            totalTimeMs: 1,
          }),
        );
        await flushMicrotasks();
        return request;
      }
      await Promise.resolve();
    }
    throw new Error("SDK capability query was not sent");
  };

  const waitForMessageType = async (
    socket: CapturingWebSocket,
    type: string,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const message = socket.sentMessages
        .map((payload) => JSON.parse(payload))
        .find((payload) => payload.type === type);
      if (message) {
        return message;
      }
      await Promise.resolve();
    }
    throw new Error(`${type} was not sent`);
  };

  describe("hierarchy cadence handshake sync", () => {
    let streamServer: DeviceDataStreamSocketServer;

    beforeEach(() => {
      streamServer = new DeviceDataStreamSocketServer("/fake/ios-cadence.sock", fakeTimer, {
        authorize: () => {},
      });
      installDeviceDataStreamSocketServerForTesting(streamServer);
    });

    afterEach(() => {
      installDeviceDataStreamSocketServerForTesting(null);
    });

    const cadenceMessages = (socket: CapturingWebSocket): Record<string, unknown>[] =>
      socket.sentMessages
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .filter((message) => message.type === "set_hierarchy_poll_interval");

    const connectCapturingClient = async (): Promise<{
      client: IOSCtrlProxyClient;
      socket: CapturingWebSocket;
    }> => {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      expect(socket).not.toBeNull();
      await waitForSocketOpen(socket);
      return { client, socket: socket as CapturingWebSocket };
    };

    test("does not sync cadence when the socket opens without a runner handshake", async () => {
      const { client, socket } = await connectCapturingClient();
      try {
        expect(cadenceMessages(socket)).toEqual([]);
      } finally {
        await client.close();
      }
    });

    test("syncs cadence once after a runner advertises the command", async () => {
      const { client, socket } = await connectCapturingClient();
      try {
        expect(cadenceMessages(socket)).toEqual([]);
        socket.simulateMessage(
          JSON.stringify({ type: "connected", supportedCommands: ["set_hierarchy_poll_interval"] }),
        );
        expect(cadenceMessages(socket)).toEqual([
          {
            type: "set_hierarchy_poll_interval",
            intervalMs: streamServer.getHierarchyIntervalMsForDevice(testDevice.deviceId),
          },
        ]);
      } finally {
        await client.close();
      }
    });

    test("skips cadence when the runner does not advertise the command", async () => {
      const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
      const { client, socket } = await connectCapturingClient();
      try {
        socket.simulateMessage(
          JSON.stringify({ type: "connected", supportedCommands: ["request_hierarchy"] }),
        );
        expect(cadenceMessages(socket)).toEqual([]);
        expect(infoSpy).toHaveBeenCalledWith(
          "[IOSCtrlProxyClient] Skipping hierarchy cadence sync; runner does not advertise set_hierarchy_poll_interval",
        );
      } finally {
        infoSpy.mockRestore();
        await client.close();
      }
    });

    test("logs a throwing cadence sync and finishes connected handling", async () => {
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      const cadenceSpy = spyOn(streamServer, "getHierarchyIntervalMsForDevice").mockImplementation(
        () => {
          throw new Error("cadence unavailable");
        },
      );
      const { client, socket } = await connectCapturingClient();
      try {
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["set_hierarchy_poll_interval", "get_sdk_capabilities"],
          }),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          "[IOSCtrlProxyClient] Hierarchy cadence sync failed: cadence unavailable",
          expect.any(Error),
        );
        expect(client.getCachedSupportedCommands()).toEqual([
          "get_sdk_capabilities",
          "set_hierarchy_poll_interval",
        ]);
        await waitForMessageType(socket, "get_sdk_capabilities");
      } finally {
        cadenceSpy.mockRestore();
        warnSpy.mockRestore();
        await client.close();
      }
    });
  });

  describe("connection lifecycle", function () {
    test.each([
      ["service_recovering", true],
      ["auto_setup_failed", false],
    ] as const)(
      "reports %s for runner exit during startup when recovery in flight is %s",
      async (reason, recovering) => {
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const manager = {
          isRunning: async () => false,
          setup: async () => ({
            success: false,
            message: "Failed to setup CtrlProxy",
            error: "iOS CtrlProxy runner exited during startup",
            recoveryInterrupted: true,
          }),
          isRecoveryInFlight: () => recovering,
        } as unknown as CtrlProxyIosManager;
        const client = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          createInstantFailureWebSocketFactory(timer),
          timer,
          () => manager,
          async () => [testDevice],
        );
        (client as any).autoReconnectEnabled = false;
        try {
          expect(await client.ensureConnected()).toBe(false);
          expect(
            (client as any).createHierarchyDelegateContext().getLastConnectFailure(),
          ).toMatchObject({
            reason,
            detail: "iOS CtrlProxy runner exited during startup",
          });
        } finally {
          await client.close();
        }
      },
    );

    test.each([
      ["service_recovering", true],
      ["auto_setup_failed", false],
    ] as const)(
      "reports %s for cancelled startup when recovery in flight is %s",
      async (reason, recovering) => {
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const manager = {
          isRunning: async () => false,
          setup: async () => ({
            success: false,
            message: "Failed to setup CtrlProxy",
            error: "iOS CtrlProxy startup was cancelled by stop()",
            recoveryInterrupted: true,
          }),
          isRecoveryInFlight: () => recovering,
        } as unknown as CtrlProxyIosManager;
        const client = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          createInstantFailureWebSocketFactory(timer),
          timer,
          () => manager,
          async () => [testDevice],
        );
        (client as any).autoReconnectEnabled = false;
        try {
          expect(await client.ensureConnected()).toBe(false);
          expect(
            (client as any).createHierarchyDelegateContext().getLastConnectFailure(),
          ).toMatchObject({
            reason,
            detail: "iOS CtrlProxy startup was cancelled by stop()",
          });
        } finally {
          await client.close();
        }
      },
    );

    test.each([
      ["simulator_not_booted", false, "unused"],
      ["auto_setup_failed", true, "runner install failed"],
    ] as const)("records %s from failed connection", async (reason, booted, message) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const manager = {
        isRunning: async () => false,
        setup: async () => ({ success: false, message }),
      } as unknown as CtrlProxyIosManager;
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(timer),
        timer,
        () => manager,
        async () => (booted ? [testDevice] : []),
      );
      (client as any).autoReconnectEnabled = false;
      try {
        expect(await client.ensureConnected()).toBe(false);
        const failure = (client as any).createHierarchyDelegateContext().getLastConnectFailure();
        expect(failure.reason).toBe(reason);
        if (booted) {
          expect(failure.detail).toBe(message);
        }
      } finally {
        await client.close();
      }
    });

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

    test("does not issue SDK-backed syncs when the foreground app has no SDK server", async function () {
      serverConfig.setNetworkMockableEnabled(true);
      const state = NetworkState.getInstance();
      state.addMock({
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
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: [
              "get_sdk_capabilities",
              "set_network_mock_rules",
              "set_network_error_simulation",
              "request_hierarchy",
            ],
          }),
        );
        await respondToSdkCapabilityQuery(socket, false);
        const result = await testClient.setNetworkErrorSimulation({
          enabled: false,
          errorType: null,
          limit: null,
          expiresAtEpochMs: null,
        });

        const sentTypes = socket.sentMessages.map((message) => JSON.parse(message).type);
        expect(result.success).toBe(false);
        expect(sentTypes.filter((type) => type === "get_sdk_capabilities")).toHaveLength(1);
        expect(sentTypes).not.toContain("set_network_mock_rules");
        expect(sentTypes).not.toContain("set_network_error_simulation");
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        await testClient.close();
      }
    });

    test("syncs SDK-backed state after capability detection", async function () {
      serverConfig.setNetworkMockableEnabled(true);
      const state = NetworkState.getInstance();
      state.startSimulation("tlsFailure", 20, 4);
      state.addMock({
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
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: [
              "get_sdk_capabilities",
              "set_network_mock_rules",
              "set_network_error_simulation",
            ],
          }),
        );
        await respondToSdkCapabilityQuery(socket, true, "com.example.sdk");

        const sync = socket.sentMessages.map((message) => JSON.parse(message));
        expect(sync).toContainEqual({
          type: "set_network_error_simulation",
          enabled: true,
          errorType: "tlsFailure",
          limit: 4,
          expiresAtEpochMs: expect.any(Number),
        });
        expect(sync).toContainEqual({
          type: "set_network_mock_rules",
          rules: [
            {
              mockId: "mock-1",
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
      } finally {
        await testClient.close();
      }
    });

    test("syncs mock rules for legacy runners that advertise the command", async function () {
      serverConfig.setNetworkMockableEnabled(true);
      const state = NetworkState.getInstance();
      state.addMock({
        host: "api\\.example\\.com",
        path: "/v1/items",
        method: "GET",
        limit: 1,
        remaining: 1,
        statusCode: 200,
        responseHeaders: {},
        responseBody: "{}",
        contentType: "application/json",
      });
      state.startSimulation("timeout", 10, 2);
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["set_network_mock_rules", "set_network_error_simulation"],
          }),
        );

        await waitForMessageType(socket, "set_network_mock_rules");
        const errorSimulation = await waitForMessageType(socket, "set_network_error_simulation");
        expect(errorSimulation).toMatchObject({
          enabled: true,
          errorType: "timeout",
          limit: 2,
        });
      } finally {
        await testClient.close();
      }
    });

    test("retries an SDK capability query after a transient failure", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["get_sdk_capabilities", "add_highlight"],
          }),
        );
        const firstRequest = await waitForMessageType(socket, "get_sdk_capabilities");
        socket.simulateMessage(
          JSON.stringify({
            type: "sdk_capabilities_result",
            requestId: firstRequest.requestId,
            success: false,
            available: false,
            capabilities: [],
            totalTimeMs: 1,
          }),
        );
        await flushMicrotasks();

        const capabilityPromise = (testClient as any).ensureSdkCapability("highlight");
        await respondToSdkCapabilityQuery(socket, true, "com.example.sdk", 2);

        expect(await capabilityPromise).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("rechecks an unavailable SDK after the negative capability cache expires", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["get_sdk_capabilities"],
          }),
        );
        await respondToSdkCapabilityQuery(socket, false);
        fakeTimer.advanceTime(5000);

        const capabilityPromise = (testClient as any).ensureSdkCapability("highlight");
        await respondToSdkCapabilityQuery(socket, false, undefined, 2);

        expect(await capabilityPromise).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("keeps generic hierarchy requests independent of SDK availability", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["request_hierarchy"],
          }),
        );

        const hierarchyPromise = testClient.requestHierarchySync(undefined, false, undefined, 1000);
        const hierarchyRequest = await waitForMessageType(socket, "request_hierarchy_if_stale");
        socket.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            requestId: hierarchyRequest.requestId,
            data: {
              updatedAt: 1,
              packageName: "com.apple.springboard",
              hierarchy: { text: "Home" },
            },
          }),
        );

        expect((await hierarchyPromise)?.hierarchy.packageName).toBe("com.apple.springboard");
        expect(socket.sentMessages.map((message) => JSON.parse(message).type)).not.toContain(
          "get_sdk_capabilities",
        );
      } finally {
        await testClient.close();
      }
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
            supportedCommands: ["get_sdk_capabilities", "set_network_error_simulation"],
          }),
        );
        await respondToSdkCapabilityQuery(socket!, true, "com.example.sdk");

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
          await Promise.resolve();
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
        expect(result.error).toContain("does not expose the AutoMobile SDK capability");
        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });

    test("preserves explicit SDK operations on released runners without negotiation", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["set_network_error_simulation"],
          }),
        );

        const resultPromise = testClient.setNetworkErrorSimulation({ enabled: false });
        let explicitRequest: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          explicitRequest = socket.sentMessages
            .map((message) => JSON.parse(message))
            .find(
              (message) =>
                message.type === "set_network_error_simulation" && message.requestId !== undefined,
            );
          if (explicitRequest) {
            break;
          }
          await Promise.resolve();
        }
        expect(explicitRequest).toBeDefined();
        socket.simulateMessage(
          JSON.stringify({
            type: "set_network_error_simulation_result",
            requestId: explicitRequest?.requestId,
            ok: true,
            totalTimeMs: 2,
          }),
        );

        expect((await resultPromise).success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("SDK capability transitions", function () {
    test("refreshes capabilities and syncs simulation after launching an SDK-enabled app", async function () {
      NetworkState.getInstance().startSimulation("timeout", 20, 2);
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: [
              "get_sdk_capabilities",
              "request_launch_app",
              "set_network_error_simulation",
            ],
          }),
        );
        await respondToSdkCapabilityQuery(socket, false);

        const launchPromise = testClient.requestLaunchApp("com.example.sdk");
        await flushMicrotasks();
        const launchRequest = socket.sentMessages
          .map((message) => JSON.parse(message))
          .find((payload) => payload.type === "request_launch_app");
        socket.simulateMessage(
          JSON.stringify({
            type: "launch_app_result",
            requestId: launchRequest.requestId,
            success: true,
            totalTimeMs: 3,
          }),
        );
        await flushMicrotasks();
        await respondToSdkCapabilityQuery(socket, true, "com.example.sdk", 2);

        expect((await launchPromise).success).toBe(true);
        expect(socket.sentMessages.map((message) => JSON.parse(message))).toContainEqual({
          type: "set_network_error_simulation",
          enabled: true,
          errorType: "timeout",
          limit: 2,
          expiresAtEpochMs: expect.any(Number),
        });
      } finally {
        await testClient.close();
      }
    });

    test("ignores a stale available result after the app transitions to SpringBoard", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await testClient.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: [
              "get_sdk_capabilities",
              "request_press_home",
              "set_network_error_simulation",
            ],
          }),
        );
        await flushMicrotasks();
        const capabilityRequest = socket.sentMessages
          .map((message) => JSON.parse(message))
          .find((payload) => payload.type === "get_sdk_capabilities");

        const homePromise = testClient.requestPressHome();
        await flushMicrotasks();
        const homeRequest = socket.sentMessages
          .map((message) => JSON.parse(message))
          .find((payload) => payload.type === "request_press_home");
        socket.simulateMessage(
          JSON.stringify({
            type: "press_home_result",
            requestId: homeRequest.requestId,
            success: true,
            totalTimeMs: 2,
          }),
        );
        socket.simulateMessage(
          JSON.stringify({
            type: "sdk_capabilities_result",
            requestId: capabilityRequest.requestId,
            success: true,
            available: true,
            bundleId: "com.example.previous",
            capabilities: ["network_error_simulation"],
            totalTimeMs: 1,
          }),
        );

        expect((await homePromise).success).toBe(true);
        await flushMicrotasks();
        expect(socket.sentMessages.map((message) => JSON.parse(message).type)).not.toContain(
          "set_network_error_simulation",
        );
      } finally {
        await testClient.close();
      }
    });
  });

  describe("getLatestHierarchy", function () {
    test("hierarchy failure exposes the runner error to observe without a cached fallback", async () => {
      const timer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, timer);
      try {
        await client.ensureConnected();
        const socket = getSocket()!;
        const before = timer.now();
        const pending = client.getLatestHierarchy(true, 1000);
        const request = await waitForMessageType(socket, "request_hierarchy");
        // Built from WebSocketResponse.error in
        // ios/control-proxy/Sources/CtrlProxyRewrite/Models/WebSocketResponse.swift; no data.
        const message = {
          type: "hierarchy_update",
          requestId: request.requestId,
          success: false,
          totalTimeMs: 17,
          error: "Command execution failed: Failed to get view hierarchy: boom",
        };
        socket.simulateMessage(JSON.stringify(message));
        expect(await pending).toMatchObject({
          hierarchy: null,
          fresh: false,
          unavailableReason: "unknown",
          unavailableDetail: message.error,
        });
        expect(timer.now()).toBe(before);
        expect(client["cachedHierarchy"]).toBeNull();
        expect(timer.getPendingTimeouts()).not.toContain(1000);
      } finally {
        await client.close();
      }
    });

    test.each([true, false])(
      "hierarchy failure with pending request=%p preserves cache and emits no hierarchy effects",
      async (hasPendingRequest) => {
        const timer = new FakeTimer(); // Manual clock: the response must settle without advancing it.
        const ingestor = new FakeIosSdkEventIngestor();
        const { factory, getSocket } = createCapturingWebSocketFactory(timer);
        const client = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          factory,
          timer,
          undefined,
          undefined,
          undefined,
          ingestor,
        );
        const cached = {
          hierarchy: { updatedAt: 1, packageName: "com.example.ios", hierarchy: { text: "old" } },
          receivedAt: 0,
          fresh: true,
        };
        client["cachedHierarchy"] = cached;
        const push = spyOn(client, "pushHierarchyToObservationStream").mockImplementation(() => {});
        const navigation = spyOn(client, "handleHierarchyUpdateForNavigation").mockImplementation(
          () => {},
        );
        const debug = spyOn(logger, "debug").mockImplementation(() => {});
        const updates: CtrlProxyHierarchy[] = [];
        const unsubscribe = client.onPushUpdate((hierarchy) => updates.push(hierarchy));
        const options: NonNullable<
          Parameters<(typeof client)["hierarchy"]["requestHierarchySync"]>[5]
        > = {
          failureSink: {},
        };
        const failureSink = options.failureSink!;
        try {
          await client.ensureConnected();
          const socket = getSocket()!;
          expect(socket.readyState).toBe(WebSocketState.OPEN);
          const before = timer.now();
          let requestId = "no-pending-hierarchy";
          const pending = hasPendingRequest
            ? client["hierarchy"].requestHierarchySync(
                undefined,
                false,
                undefined,
                1000,
                false,
                options,
              )
            : undefined;
          if (hasPendingRequest) {
            const request = await waitForMessageType(socket, "request_hierarchy_if_stale");
            expect(typeof request.requestId).toBe("string");
            requestId = String(request.requestId);
            expect(client["getRequestManager"]().isPending(requestId)).toBe(true);
            expect(timer.getPendingTimeouts()).toContain(1000);
          }
          // Built from WebSocketResponse.error in
          // ios/control-proxy/Sources/CtrlProxyRewrite/Models/WebSocketResponse.swift; no data.
          const message = {
            type: "hierarchy_update",
            requestId,
            success: false,
            totalTimeMs: 17,
            error: "Command execution failed: Failed to get view hierarchy: boom",
          };
          expect(() => socket.simulateMessage(JSON.stringify(message))).not.toThrow();
          if (hasPendingRequest) {
            expect(await pending).toBeNull();
            expect(failureSink.value).toEqual({ reason: "unknown", detail: message.error });
          } else {
            expect(debug).toHaveBeenCalledWith(
              `[RequestManager] No pending request found for id: ${requestId} (may have timed out)`,
            );
          }
          expect(client["getRequestManager"]().isPending(requestId)).toBe(false);
          expect(timer.getPendingTimeouts()).not.toContain(1000);
          expect(timer.now()).toBe(before);
          expect(client["cachedHierarchy"]).toBe(cached);
          expect(push).not.toHaveBeenCalled();
          expect(navigation).not.toHaveBeenCalled();
          expect(ingestor.layoutEvents).toEqual([]);
          expect(updates).toEqual([]);
        } finally {
          unsubscribe();
          push.mockRestore();
          navigation.mockRestore();
          debug.mockRestore();
          await client.close();
        }
      },
    );

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
        expect(sentMessage.type).toBe("request_hierarchy");

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
    test.each([undefined, false, true])(
      "should send swipe request with lockScreen=%s and return result",
      async function (lockScreen) {
        const testTimer = fakeTimer;

        const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
        const testClient = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          factory,
          testTimer,
        );

        try {
          const resultPromise = testClient.requestSwipe(100, 200, 100, 500, 300, 4200, undefined, {
            lockScreen,
          });
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
          expect(sentMessage.timeoutMs).toBe(4200);
          if (lockScreen === true) {
            expect(sentMessage.lockScreen).toBe(true);
          } else {
            expect(sentMessage).not.toHaveProperty("lockScreen");
          }

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
      },
    );

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
        type: "circle",

        bounds: {
          x: 10.2,
          y: 20.8,
          width: 100.4,
          height: 80.6,
        },
      };

      try {
        (testClient as any).sdkCapabilities = {
          bundleId: "com.example.sdk",
          capabilities: new Set(["highlight"]),
        };
        (testClient as any).sdkCapabilitiesKnown = true;
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
        type: "circle",
        bounds: {
          x: 10,
          y: 20,
          width: 100,
          height: 80,
        },
      };

      try {
        (testClient as any).sdkCapabilities = {
          bundleId: "com.example.sdk",
          capabilities: new Set(["highlight"]),
        };
        (testClient as any).sdkCapabilitiesKnown = true;
        const requestPromise = testClient.requestAddHighlight("highlight-1", shape, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const payload = commandPayloads(socket!).find(
          (message) => message.type === "add_highlight",
        );
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

  describe("SDK capability probe generation binding (#6896)", function () {
    const sdkCapabilityResult = (
      requestId: unknown,
      bundleId: string,
      capabilities: string[] = ["highlight"],
    ): string =>
      JSON.stringify({
        type: "sdk_capabilities_result",
        requestId,
        success: true,
        available: true,
        bundleId,
        capabilities,
        totalTimeMs: 1,
      });

    const foregroundHierarchyUpdate = (packageName: string): string =>
      JSON.stringify({
        type: "hierarchy_update",
        data: { updatedAt: 1, packageName, hierarchy: { text: packageName } },
      });

    const sdkCapabilityRequests = (socket: CapturingWebSocket): Record<string, unknown>[] =>
      socket.sentMessages
        .map((message) => JSON.parse(message))
        .filter((payload) => payload.type === "get_sdk_capabilities");

    const shape: HighlightShape = {
      type: "rect",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    };

    const connectWithSdkCommands = async (
      testClient: IOSCtrlProxyClient,
      getSocket: () => CapturingWebSocket | null,
    ): Promise<CapturingWebSocket> => {
      await testClient.ensureConnected();
      const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
      await waitForSocketOpen(socket);
      socket.simulateMessage(
        JSON.stringify({
          type: "connected",
          supportedCommands: ["get_sdk_capabilities", "add_highlight", "request_hierarchy"],
        }),
      );
      await waitForMessageType(socket, "get_sdk_capabilities");
      return socket;
    };

    test("rejects a pending highlight waiter as superseded when a hierarchy update completes a replacement-generation probe first", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const socket = await connectWithSdkCommands(testClient, getSocket);
        // App A's waiter joins the generation-1 probe that the handshake started.
        const highlightPromise = testClient.requestAddHighlight("highlight-a", shape, 2000);
        await flushMicrotasks();
        expect(sdkCapabilityRequests(socket)).toHaveLength(1);
        const probeA = sdkCapabilityRequests(socket)[0];

        // A foreground change to app B invalidates generation 1 and starts a generation-2 probe.
        socket.simulateMessage(foregroundHierarchyUpdate("com.example.b"));
        await flushMicrotasks();
        expect(sdkCapabilityRequests(socket)).toHaveLength(2);
        const probeB = sdkCapabilityRequests(socket)[1];

        // B's probe completes first and advertises highlight; then A's stale response lands.
        socket.simulateMessage(sdkCapabilityResult(probeB.requestId, "com.example.b"));
        await flushMicrotasks();
        socket.simulateMessage(sdkCapabilityResult(probeA.requestId, "com.example.a"));

        const result = await highlightPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("superseded");
        const sentTypes = socket.sentMessages.map((message) => JSON.parse(message).type);
        expect(sentTypes).not.toContain("add_highlight");
      } finally {
        await testClient.close();
      }
    });

    test("rejects the waiter as superseded even when only the replacement probe ever completes", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const socket = await connectWithSdkCommands(testClient, getSocket);
        const highlightPromise = testClient.requestAddHighlight("highlight-a", shape, 2000);
        await flushMicrotasks();

        socket.simulateMessage(foregroundHierarchyUpdate("com.example.b"));
        await flushMicrotasks();
        const probeB = sdkCapabilityRequests(socket)[1];
        socket.simulateMessage(sdkCapabilityResult(probeB.requestId, "com.example.b"));

        // Generation 1's probe never answers; its waiter must not borrow generation 2's result.
        fakeTimer.advanceTime(1000);
        await flushMicrotasks();

        const result = await highlightPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("superseded");
        const sentTypes = socket.sentMessages.map((message) => JSON.parse(message).type);
        expect(sentTypes).not.toContain("add_highlight");
      } finally {
        await testClient.close();
      }
    });

    test("throwing callers receive the typed superseded error", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const socket = await connectWithSdkCommands(testClient, getSocket);
        const waiter = (testClient as any).ensureSdkCapability("database", "com.example.a");
        await flushMicrotasks();

        socket.simulateMessage(foregroundHierarchyUpdate("com.example.b"));
        await flushMicrotasks();
        const [probeA, probeB] = sdkCapabilityRequests(socket);
        socket.simulateMessage(
          sdkCapabilityResult(probeB.requestId, "com.example.b", ["database"]),
        );
        await flushMicrotasks();
        socket.simulateMessage(
          sdkCapabilityResult(probeA.requestId, "com.example.a", ["database"]),
        );

        await expect(waiter).rejects.toBeInstanceOf(SdkCapabilityProbeSupersededError);
      } finally {
        await testClient.close();
      }
    });

    test("resolves a waiter from its own generation's probe result and sends the highlight", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const socket = await connectWithSdkCommands(testClient, getSocket);
        const highlightPromise = testClient.requestAddHighlight("highlight-a", shape, 2000);
        await flushMicrotasks();
        const probeA = sdkCapabilityRequests(socket)[0];
        socket.simulateMessage(sdkCapabilityResult(probeA.requestId, "com.example.a"));

        const highlightRequest = await waitForMessageType(socket, "add_highlight");
        expect(highlightRequest.id).toBe("highlight-a");
        socket.simulateMessage(
          JSON.stringify({
            type: "highlight_response",
            requestId: highlightRequest.requestId,
            success: true,
            error: null,
          }),
        );

        expect((await highlightPromise).success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("does not authorize a waiter from a same-generation probe that reports the capability missing", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const socket = await connectWithSdkCommands(testClient, getSocket);
        const highlightPromise = testClient.requestAddHighlight("highlight-a", shape, 2000);
        await flushMicrotasks();
        const probeA = sdkCapabilityRequests(socket)[0];
        socket.simulateMessage(
          sdkCapabilityResult(probeA.requestId, "com.example.a", ["hierarchy"]),
        );

        const result = await highlightPromise;
        expect(result.success).toBe(false);
        expect(result.error).not.toContain("superseded");
        const sentTypes = socket.sentMessages.map((message) => JSON.parse(message).type);
        expect(sentTypes).not.toContain("add_highlight");
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

  describe("requestSetHingeAngle", function () {
    test("sends the angle and resolves a typed runner result", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      try {
        const promise = testClient.requestSetHingeAngle(180);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket!, 1);
        const request = commandPayloads(socket!)[0];
        expect(request).toMatchObject({ type: "set_hinge_angle", angle: 180 });
        socket!.simulateMessage(
          JSON.stringify({
            type: "hinge_angle_result",
            requestId: request.requestId,
            success: true,
            angle: 180,
            totalTimeMs: 2,
          }),
        );
        expect(await promise).toEqual({
          success: true,
          angle: 180,
          error: undefined,
          totalTimeMs: 2,
        });
      } finally {
        await testClient.close();
      }
    });
  });

  describe("requestPressKey", function () {
    test("should send a discrete key chord and resolve the result", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = testClient.requestPressKey("tab", ["shift", "meta"], 5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMessage = commandPayloads(socket!)[0];
        expect(sentMessage).toMatchObject({
          type: "request_press_key",
          key: "tab",
          modifiers: ["shift", "meta"],
        });

        socket!.simulateMessage(
          JSON.stringify({
            type: "press_key_result",
            requestId: sentMessage.requestId,
            success: true,
            totalTimeMs: 2,
          }),
        );

        expect(await resultPromise).toMatchObject({ success: true, totalTimeMs: 2 });
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

        const hinge = await testClient.requestSetHingeAngle(130, 5000);
        expect(hinge).toMatchObject({ success: false, totalTimeMs: 0 });
        expect(hinge.error).toContain("does not support set_hinge_angle");

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

        const hingePromise = testClient.requestSetHingeAngle(130, 100);
        await waitForSentMessages(socket as CapturingWebSocket, 3);
        testTimer.advanceTime(100);
        expect(await hingePromise).toEqual({
          success: false,
          totalTimeMs: 100,
          error: "Set hinge angle timed out after 100ms",
        });

        const clipboardPromise = testClient.requestClipboard("get", undefined, 100);
        await waitForSentMessages(socket as CapturingWebSocket, 4);
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

    test("cancels an in-flight launch request with the caller's abort reason", async function () {
      const testTimer = fakeTimer;
      const controller = new AbortController();
      const cancellation = new Error("launch retarget cancelled");
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const resultPromise = testClient.requestLaunchApp(
          "com.apple.Preferences",
          5000,
          undefined,
          false,
          controller.signal,
        );
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const requestManager = (testClient as any).requestManager as {
          getPendingCount(): number;
        };
        expect(requestManager.getPendingCount()).toBe(1);

        controller.abort(cancellation);

        await expect(resultPromise).rejects.toBe(cancellation);
        expect(requestManager.getPendingCount()).toBe(0);
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

    test("rejects runner_busy as an ActionableError without retrying an action", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = testClient.requestPressBack(5000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        const commands = commandPayloads(socket!);
        expect(commands).toHaveLength(1);

        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: commands[0].requestId,
            success: false,
            error: "runner_busy",
            blockingCommandType: "request_set_text",
            blockingElapsedMs: 4200,
          }),
        );

        try {
          await resultPromise;
          throw new Error("Expected runner_busy to reject");
        } catch (error) {
          expect(error).toBeInstanceOf(ActionableError);
          expect((error as Error).message).toBe(
            "iOS runner is busy executing request_set_text for 4.2s; retry shortly",
          );
        }
        expect(commandPayloads(socket!)).toHaveLength(1);
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
    test("diagnostic reads reuse a resident socket without setup or hierarchy recovery", async () => {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
        () => {
          throw new Error("diagnostics must not resolve the manager");
        },
      );
      try {
        await client.connectWithoutSetup();
        const socket = getSocket()!;
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["request_hierarchy"],
            supportedFeatures: ["feature"],
          }),
        );
        const ensureConnected = spyOn(client, "ensureConnected").mockImplementation(() => {
          throw new Error("diagnostic hierarchy must not use auto-setup");
        });
        try {
          expect(await client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
          expect(await client.getSupportedFeaturesForDiagnostics()).toEqual(["feature"]);
          expect(await client.getRunnerIdentityForDiagnostics()).toEqual({
            commands: ["request_hierarchy"],
            features: ["feature"],
          });
          socket.simulateMessage(
            JSON.stringify({
              type: "connected",
              supportedCommands: ["request_hierarchy"],
            }),
          );
          expect(await client.getRunnerIdentityForDiagnostics()).toEqual({
            commands: ["request_hierarchy"],
            features: null,
          });
          const sentBeforeRead = socket.sentMessages.length;
          const pending = client.requestHierarchySyncForDiagnostics();
          await waitForSentMessages(socket, sentBeforeRead + 1);
          const request = JSON.parse(socket.sentMessages.at(-1)!) as { requestId: string };
          socket.simulateMessage(
            JSON.stringify({
              type: "hierarchy_update",
              requestId: request.requestId,
              data: { updatedAt: 1, packageName: "SpringBoard", hierarchy: {} },
            }),
          );
          expect((await pending)?.hierarchy.packageName).toBe("SpringBoard");
          expect(ensureConnected).not.toHaveBeenCalled();
          expect(client.isConnected()).toBe(true);
        } finally {
          ensureConnected.mockRestore();
        }
      } finally {
        await client.close();
      }
    });

    const diagnosticResident = () => {
      const timer = new FakeTimer();
      const manager = new FakeIOSCtrlProxyManager(timer);
      const sockets: FakeWebSocket[] = [];
      const modes: ("none" | "instant" | "timeout")[] = [];
      let lostConnections = 0;
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        (url) => {
          const socket = new FakeWebSocket(url, modes.shift() ?? "none", 60_000, timer);
          sockets.push(socket);
          socket.on("open", () => queueMicrotask(() => handshake(socket)));
          return socket;
        },
        timer,
        () => manager,
        undefined,
        {
          onDeviceConnectionLost: () => {
            lostConnections++;
          },
        },
        new FakeIosSdkEventIngestor(),
      );
      const handshake = (socket: FakeWebSocket) =>
        socket.simulateMessage(
          JSON.stringify({
            type: "connected",
            supportedCommands: ["request_hierarchy"],
            supportedFeatures: ["feature"],
          }),
        );
      const open = (socket: FakeWebSocket) => {
        socket.readyState = WebSocketState.OPEN;
        socket.emit("open");
        handshake(socket);
      };
      const state = () => ({
        inFlight: client["inFlightConnectPromise"],
        reconnect: client["reconnectTimeoutId"],
        autoReconnect: client["autoReconnectEnabled"],
        attempts: client["connectionAttempts"],
        lastAttempt: client["lastConnectionAttempt"],
        lastFailure: client.getLastConnectionFailureMessage(),
        restartToken: client["pendingRestartToken"],
        restartTimer: client["restartRearmTimeout"],
        commands: client["supportedCommands"],
        features: client["supportedFeatures"],
        lostConnections,
        budget: manager.getForcedRestartBudget().snapshot(),
      });
      return { client, timer, manager, sockets, modes, open, state };
    };

    test("diagnostic identity reads both fields on one isolated socket", async () => {
      const h = diagnosticResident();
      h.modes.push("timeout");
      try {
        const before = h.state();
        const identity = h.client.getRunnerIdentityForDiagnostics();
        await flushPromises();
        expect(h.sockets).toHaveLength(1);
        const socket = h.sockets[0]!;
        h.open(socket);
        expect(await identity).toEqual({ commands: ["request_hierarchy"], features: ["feature"] });
        await flushPromises();
        expect(h.sockets).toHaveLength(1);
        expect(socket.readyState).toBe(WebSocketState.CLOSED);
        expect(h.state()).toEqual(before);
        expect(h.manager.getExecutedOperations()).toEqual([]);
      } finally {
        await h.client.close();
      }
    });

    test("diagnostic dial cannot be joined by live ensureConnected or background reconnect", async () => {
      for (const connect of ["ensureConnected", "connectBackgroundWebSocket"] as const) {
        const h = diagnosticResident();
        h.modes.push("timeout", "timeout");
        try {
          const diagnostic = h.client.getSupportedCommandsForDiagnostics();
          await flushPromises();
          const ownerState = h.state();
          const live = h.client[connect]();
          await flushPromises();
          expect(h.sockets).toHaveLength(2);
          h.open(h.sockets[0]!);
          expect(await diagnostic).toEqual(["request_hierarchy"]);
          expect(h.client["inFlightConnectPromise"]).not.toBeNull();
          expect(h.client["autoReconnectEnabled"]).toBe(ownerState.autoReconnect);
          h.open(h.sockets[1]!);
          expect(await live).toBe(true);
          await flushPromises();
          expect(h.sockets[0]!.readyState).toBe(WebSocketState.CLOSED);
          expect(h.sockets[1]!.readyState).toBe(WebSocketState.OPEN);
          expect(h.manager.getExecutedOperations()).toEqual([]);
        } finally {
          await h.client.close();
        }
      }
    });

    test("diagnostic read leaves an already in-flight owner dial untouched", async () => {
      const h = diagnosticResident();
      h.modes.push("timeout", "none");
      try {
        const live = h.client.ensureConnected();
        await flushPromises();
        const before = h.state();
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(h.state()).toEqual(before);
        expect(h.sockets).toHaveLength(2);
        h.open(h.sockets[0]!);
        expect(await live).toBe(true);
        expect(h.client.isConnected()).toBe(true);
      } finally {
        await h.client.close();
      }
    });

    test("diagnostic read cannot fail an in-progress forced restart or its replacement socket", async () => {
      const h = diagnosticResident();
      let finishRestart!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishRestart = resolve;
      });
      const forceRestart = h.manager.forceRestart.bind(h.manager);
      const restart = spyOn(h.manager, "forceRestart").mockImplementation(async () => {
        await forceRestart();
        await gate;
      });
      const failRestart = spyOn(h.client, "failPendingRestart");
      try {
        const recovery = h.client["restartServiceIfBooted"](
          h.manager,
          h.manager.getForcedRestartBudget(),
        );
        await flushMicrotasks();
        const before = h.state();
        expect(before.restartToken).toBeDefined();
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(h.state()).toEqual(before);
        expect(failRestart).not.toHaveBeenCalled();
        finishRestart();
        await flushPromises();
        expect(h.client["restartReplacementSocket"]).toBe(h.sockets[1]);
        expect(h.client["restartRearmTimeout"]).not.toBeNull();
        h.timer.advanceTime(2000);
        expect(await recovery).toBe(true);
        expect(h.sockets[1]!.readyState).toBe(WebSocketState.OPEN);
        expect(h.manager.getForcedRestartBudget().snapshot()).toEqual({
          state: "idle",
          attempts: 0,
        });
        expect(failRestart).not.toHaveBeenCalled();
      } finally {
        restart.mockRestore();
        failRestart.mockRestore();
        await h.client.close();
      }
    });

    test("diagnostic read leaves runner setup in progress untouched", async () => {
      const h = diagnosticResident();
      h.modes.push("instant", "none", "none");
      let finishSetup!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishSetup = resolve;
      });
      const setup = h.manager.setup.bind(h.manager);
      const setupSpy = spyOn(h.manager, "setup").mockImplementation(async () => {
        await gate;
        return setup();
      });
      try {
        const live = h.client.ensureConnected();
        await flushPromises(10);
        expect(setupSpy).toHaveBeenCalledTimes(1);
        const before = h.state();
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(h.state()).toEqual(before);
        expect(setupSpy).toHaveBeenCalledTimes(1);
        finishSetup();
        expect(await live).toBe(true);
        expect(h.client.isConnected()).toBe(true);
        expect(h.sockets[2]!.readyState).toBe(WebSocketState.OPEN);
      } finally {
        setupSpy.mockRestore();
        await h.client.close();
      }
    });

    test("diagnostic read preserves a pending owner auto-reconnect timer which fires normally", async () => {
      const h = diagnosticResident();
      try {
        h.client["scheduleReconnect"]();
        const before = h.state();
        expect(before.reconnect).not.toBeNull();
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(h.state()).toEqual(before);
        h.timer.advanceTime(2000);
        await flushPromises();
        expect(h.sockets).toHaveLength(2);
        expect(h.client.isConnected()).toBe(true);
        expect(h.sockets[1]!.readyState).toBe(WebSocketState.OPEN);
      } finally {
        await h.client.close();
      }
    });

    test("diagnostic handshakes never cache on the resident and a later dead runner is unreachable", async () => {
      const h = diagnosticResident();
      try {
        const before = h.state();
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(h.state()).toEqual(before);
        expect(await h.client.getSupportedFeaturesForDiagnostics()).toEqual(["feature"]);
        expect(h.state()).toEqual(before);
        // Even a previous live-session cache cannot make a closed runner pass.
        h.client["supportedCommands"] = new Set(["old_command"]);
        h.client["supportedFeatures"] = new Set(["old_feature"]);
        const cachedState = h.state();
        h.modes.push("instant", "instant");
        expect(await h.client.getSupportedCommandsForDiagnostics()).toBeNull();
        expect(await h.client.getSupportedFeaturesForDiagnostics()).toBeNull();
        expect(h.state()).toEqual(cachedState);
        expect(h.manager.getExecutedOperations()).toEqual([]);
      } finally {
        await h.client.close();
      }
    });

    test("repeated failing doctor dials preserve the owner budget and last failure without cooldown", async () => {
      const h = diagnosticResident();
      try {
        h.modes.push("instant");
        expect(await h.client.connectWithoutSetup()).toBe(false);
        const before = h.state();
        expect(before.attempts).toBe(1);
        expect(before.lastFailure).toContain("Connection refused");
        for (let run = 0; run < 6; run++) {
          h.modes.push("instant");
          expect(await h.client.getSupportedCommandsForDiagnostics()).toBeNull();
          expect(h.state()).toEqual(before);
          expect(h.client.getReconnectStatus()).toBeNull();
        }
        expect(await h.client.ensureConnected()).toBe(true);
        expect(h.manager.getExecutedOperations()).toEqual([]);
      } finally {
        await h.client.close();
      }
    });

    test("diagnostic read preserves the disconnect event of a CLOSING resident socket", async () => {
      const h = diagnosticResident();
      try {
        expect(await h.client.connectWithoutSetup()).toBe(true);
        const socket = h.sockets[0]!;
        socket.readyState = WebSocketState.CLOSING;
        const close = spyOn(socket, "close");
        const before = h.state();
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(h.state()).toEqual(before);
        expect(close).not.toHaveBeenCalled();
        socket.readyState = WebSocketState.CLOSED;
        socket.emit("close");
        expect(h.state().lostConnections).toBe(1);
        expect(h.client["reconnectTimeoutId"]).not.toBeNull();
        close.mockRestore();
      } finally {
        await h.client.close();
      }
    });

    test("two concurrent diagnostic reads both get real isolated answers", async () => {
      const h = diagnosticResident();
      h.modes.push("timeout", "timeout");
      try {
        const before = h.state();
        const commands = h.client.getSupportedCommandsForDiagnostics();
        const features = h.client.getSupportedFeaturesForDiagnostics();
        await flushPromises();
        expect(h.sockets).toHaveLength(2);
        h.open(h.sockets[0]!);
        expect(await commands).toEqual(["request_hierarchy"]);
        h.open(h.sockets[1]!);
        expect(await features).toEqual(["feature"]);
        expect(h.state()).toEqual(before);
      } finally {
        await h.client.close();
      }
    });

    test.each(["identity", "commands", "features"] as const)(
      "aborting a diagnostic %s handshake closes the throwaway socket without advancing time",
      async (read) => {
        const timer = new FakeTimer();
        const sockets: FakeWebSocket[] = [];
        const client = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          (url) => {
            const socket = new FakeWebSocket(url, "none", 0, timer);
            sockets.push(socket);
            return socket;
          },
          timer,
          () => {
            throw new Error("diagnostics must not resolve the manager");
          },
        );
        const abort = new AbortController();
        const reason = new Error("doctor aborted during handshake");
        let settled = false;
        let rejection: unknown;
        const pending = (
          read === "identity"
            ? client.getRunnerIdentityForDiagnostics(abort.signal)
            : read === "commands"
              ? client.getSupportedCommandsForDiagnostics(abort.signal)
              : client.getSupportedFeaturesForDiagnostics(abort.signal)
        ).then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            settled = true;
            rejection = error;
          },
        );
        try {
          await flushPromises();
          expect(sockets).toHaveLength(1);
          expect(sockets[0]!.readyState).toBe(WebSocketState.OPEN);
          expect(settled).toBe(false);
          abort.abort(reason);
          await flushPromises();
          expect(settled).toBe(true);
          expect(rejection).toBe(reason);
          expect(sockets[0]!.readyState).toBe(WebSocketState.CLOSED);
          expect(timer.now()).toBe(0);
          expect(timer.getPendingTimeoutCount()).toBe(0);
          expect(timer.getPendingSleepCount()).toBe(0);
          await pending;
        } finally {
          await client.close();
        }
      },
    );

    test("doctor never changes resident autoReconnectEnabled on failure, thrown read or abort", async () => {
      for (const enabled of [true, false]) {
        const h = diagnosticResident();
        h.client["autoReconnectEnabled"] = enabled;
        try {
          h.modes.push("instant");
          const before = h.state();
          expect(await h.client.getSupportedCommandsForDiagnostics()).toBeNull();
          expect(h.state()).toEqual(before);
          const thrownRead = h.client["readForDiagnostics"](async () => {
            throw new Error("probe read failed");
          }, null).then(
            () => {
              throw new Error("diagnostic unexpectedly resolved");
            },
            (error: unknown) => error,
          );
          expect(await thrownRead).toEqual(new Error("probe read failed"));
          expect(h.state()).toEqual(before);
          h.modes.push("timeout");
          const abort = new AbortController();
          const pending = h.client.getSupportedCommandsForDiagnostics(abort.signal);
          const rejected = pending.then(
            () => {
              throw new Error("diagnostic unexpectedly resolved");
            },
            (error: unknown) => error,
          );
          await flushPromises();
          abort.abort(new Error("doctor aborted"));
          expect(await rejected).toEqual(new Error("doctor aborted"));
          expect(h.state()).toEqual(before);
          expect(h.manager.getExecutedOperations()).toEqual([]);
        } finally {
          await h.client.close();
        }
      }
    });

    test("closing a diagnostic observer never allocates or releases the resident port", async () => {
      const h = diagnosticResident();
      // Seed bookkeeping directly: no real port binding or listener in this test.
      PortManager["allocatedPorts"].set(testDevice.deviceId, serverPort);
      h.client["allocatedPort"] = serverPort;
      const allocate = spyOn(PortManager, "allocate");
      const release = spyOn(PortManager, "releaseIfAllocated");
      try {
        expect(await h.client.getSupportedCommandsForDiagnostics()).toEqual(["request_hierarchy"]);
        expect(allocate).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(PortManager.getPort(testDevice.deviceId)).toBe(serverPort);
        expect(h.client["allocatedPort"]).toBe(serverPort);
      } finally {
        allocate.mockRestore();
        release.mockRestore();
        await h.client.close();
        PortManager["allocatedPorts"].delete(testDevice.deviceId);
      }
    });

    test("connectWithoutSetup does not invoke automatic runner setup", async function () {
      const testTimer = fakeTimer;
      let serviceManagerFactoryCalls = 0;
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(testTimer),
        testTimer,
        () => {
          serviceManagerFactoryCalls++;
          throw new Error("automatic setup must not run");
        },
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        expect(await testClient.connectWithoutSetup()).toBe(false);
        expect(serviceManagerFactoryCalls).toBe(0);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup aborts an in-flight WebSocket handshake", async function () {
      const testTimer = new FakeTimer();
      const controller = new AbortController();
      const cancellation = new Error("readiness cancelled");
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createConnectionTimeoutWebSocketFactory(testTimer),
        testTimer,
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        const connection = testClient.connectWithoutSetup(controller.signal);
        await flushPromises();
        controller.abort(cancellation);

        await expect(connection).rejects.toBe(cancellation);
        expect((testClient as any).isConnecting).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup keeps a shared handshake alive when one caller aborts", async function () {
      const testTimer = new FakeTimer();
      const callerA = new AbortController();
      const cancellation = new Error("caller A cancelled");
      const { factory, getSocket, getCreatedSocketCount } =
        createCapturingConnectionTimeoutWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        const connectionA = testClient.connectWithoutSetup(callerA.signal);
        await flushPromises();
        const connectionB = testClient.connectWithoutSetup();
        await flushPromises();

        const socket = getSocket();
        expect(getCreatedSocketCount()).toBe(1);
        expect(socket?.readyState).toBe(WebSocketState.CONNECTING);

        callerA.abort(cancellation);
        await expect(connectionA).rejects.toBe(cancellation);
        expect(socket?.readyState).toBe(WebSocketState.CONNECTING);

        socket!.readyState = WebSocketState.OPEN;
        socket!.emit("open");
        testTimer.advanceTime(100);
        await expect(connectionB).resolves.toBe(true);
        expect((testClient as any).pendingConnectJoiners).toBe(0);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup keeps a shared handshake alive for ensureConnected", async function () {
      const testTimer = new FakeTimer();
      const callerA = new AbortController();
      const cancellation = new Error("caller A cancelled");
      const { factory, getSocket, getCreatedSocketCount } =
        createCapturingConnectionTimeoutWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        const connectionA = testClient.connectWithoutSetup(callerA.signal);
        await flushPromises();
        const connectionB = testClient.ensureConnected();
        await flushPromises();

        const socket = getSocket();
        expect(getCreatedSocketCount()).toBe(1);
        expect(socket?.readyState).toBe(WebSocketState.CONNECTING);

        callerA.abort(cancellation);
        await expect(connectionA).rejects.toBe(cancellation);
        expect(socket?.readyState).toBe(WebSocketState.CONNECTING);

        socket!.readyState = WebSocketState.OPEN;
        socket!.emit("open");
        testTimer.advanceTime(100);
        await expect(connectionB).resolves.toBe(true);
        expect((testClient as any).pendingConnectJoiners).toBe(0);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup keeps an automatic reconnect handshake alive when it aborts", async function () {
      const testTimer = new FakeTimer();
      const caller = new AbortController();
      const cancellation = new Error("readiness cancelled");
      const { factory, getSocket, getCreatedSocketCount } =
        createCapturingConnectionTimeoutWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );

      try {
        const initialConnection = testClient.connectWithoutSetup();
        await flushPromises();
        const initialSocket = getSocket();
        initialSocket!.readyState = WebSocketState.OPEN;
        initialSocket!.emit("open");
        await expect(initialConnection).resolves.toBe(true);

        initialSocket!.readyState = WebSocketState.CLOSED;
        initialSocket!.emit("close");
        testTimer.advanceTime(2000);
        await flushPromises();

        const reconnectSocket = getSocket();
        expect(getCreatedSocketCount()).toBe(2);
        expect(reconnectSocket?.readyState).toBe(WebSocketState.CONNECTING);

        const joiningConnection = testClient.connectWithoutSetup(caller.signal);
        await flushPromises();
        caller.abort(cancellation);

        await expect(joiningConnection).rejects.toBe(cancellation);
        expect(reconnectSocket?.readyState).toBe(WebSocketState.CONNECTING);

        reconnectSocket!.readyState = WebSocketState.OPEN;
        reconnectSocket!.emit("open");
        testTimer.advanceTime(100);
        await flushPromises();
        expect(testClient.isConnected()).toBe(true);
        expect((testClient as any).isConnecting).toBe(false);
        expect((testClient as any).pendingConnectJoiners).toBe(0);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup aborts the shared handshake after all callers cancel", async function () {
      const testTimer = new FakeTimer();
      const callerA = new AbortController();
      const callerB = new AbortController();
      const { factory, getSocket, getCreatedSocketCount } =
        createCapturingConnectionTimeoutWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        const connectionA = testClient.connectWithoutSetup(callerA.signal);
        await flushPromises();
        const connectionB = testClient.connectWithoutSetup(callerB.signal);
        await flushPromises();
        const socket = getSocket();

        callerA.abort(new Error("caller A cancelled"));
        await expect(connectionA).rejects.toThrow("caller A cancelled");
        expect(socket?.readyState).toBe(WebSocketState.CONNECTING);

        callerB.abort(new Error("caller B cancelled"));
        await expect(connectionB).rejects.toThrow("caller B cancelled");
        expect(socket?.readyState).toBe(WebSocketState.CLOSING);
        expect((testClient as any).isConnecting).toBe(false);

        const reconnect = testClient.connectWithoutSetup();
        await flushPromises();
        expect(getCreatedSocketCount()).toBe(2);
        const replacementSocket = getSocket();
        replacementSocket!.readyState = WebSocketState.OPEN;
        replacementSocket!.emit("open");
        await expect(reconnect).resolves.toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup ignores a signal already aborted before the call", async function () {
      const testTimer = new FakeTimer();
      const controller = new AbortController();
      const cancellation = new Error("already cancelled");
      const { factory, getCreatedSocketCount } =
        createCapturingConnectionTimeoutWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );
      controller.abort(cancellation);

      try {
        await expect(testClient.connectWithoutSetup(controller.signal)).rejects.toBe(cancellation);
        expect(getCreatedSocketCount()).toBe(0);
        expect((testClient as any).isConnecting).toBe(false);
        expect((testClient as any).pendingConnectJoiners).toBe(0);
      } finally {
        await testClient.close();
      }
    });

    test("connectWithoutSetup removes abort listeners after every settle path", async function () {
      const testTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingConnectionTimeoutWebSocketFactory(testTimer);
      const testClient = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        testTimer,
      );
      (testClient as any).autoReconnectEnabled = false;

      try {
        const resolved = createTrackedAbortSignal();
        const resolvedConnection = testClient.connectWithoutSetup(resolved.signal);
        await flushPromises();
        expect(resolved.getListenerCount()).toBe(1);
        const socket = getSocket();
        socket!.readyState = WebSocketState.OPEN;
        socket!.emit("open");
        await expect(resolvedConnection).resolves.toBe(true);
        expect(resolved.getListenerCount()).toBe(0);

        await testClient.close();

        const failed = createTrackedAbortSignal();
        const failedClient = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          createInstantFailureWebSocketFactory(testTimer),
          testTimer,
        );
        (failedClient as any).autoReconnectEnabled = false;
        const failedConnection = failedClient.connectWithoutSetup(failed.signal);
        expect(failed.getListenerCount()).toBe(1);
        await expect(failedConnection).resolves.toBe(false);
        expect(failed.getListenerCount()).toBe(0);
        await failedClient.close();

        const aborted = createTrackedAbortSignal();
        const abortedClient = IOSCtrlProxyClient.createForTesting(
          testDevice,
          serverPort,
          createConnectionTimeoutWebSocketFactory(testTimer),
          testTimer,
        );
        (abortedClient as any).autoReconnectEnabled = false;
        const abortedConnection = abortedClient.connectWithoutSetup(aborted.signal);
        await flushPromises();
        expect(aborted.getListenerCount()).toBe(1);
        const cancellation = new Error("cancelled");
        aborted.abort(cancellation);
        await expect(abortedConnection).rejects.toBe(cancellation);
        expect(aborted.getListenerCount()).toBe(0);
        await abortedClient.close();
      } finally {
        await testClient.close();
      }
    });

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

        const requestManager = testClient["getRequestManager"]();
        const cancel = spyOn(requestManager, "cancelAll");
        // Precondition: the request is genuinely in-flight before the port change.
        expect(requestManager.getPendingCount()).toBeGreaterThan(0);

        // Changing the service port on a live socket must FAIL the in-flight request
        // (cancelAll rejects it), not silently strand it in the pending map.
        testClient["updatePort"](serverPort + 1);
        expect(cancel).toHaveBeenCalledWith(expect.any(CtrlProxyServicePortChangedError));
        cancel.mockRestore();

        // cancelAll clears the pending map synchronously — nothing is stranded.
        expect(requestManager.getPendingCount()).toBe(0);
        await expect(inFlight).rejects.toThrow("CtrlProxy service port changed");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("caching", function () {
    test("ignores an older hierarchy push without replacing or restamping the cache", () => {
      const current: CtrlProxyHierarchy = {
        updatedAt: 6_000,
        packageName: "com.test.app",
        hierarchy: { text: "current" },
      };
      ctrlProxyClient["processMessage"]({ type: "hierarchy_update", data: current });
      const cached = ctrlProxyClient["cachedHierarchy"];
      const captureReceivedAt = cached?.captureReceivedAt;
      fakeTimer.advanceTime(100);
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        ctrlProxyClient["processMessage"]({
          type: "hierarchy_update",
          data: { ...current, updatedAt: 1_000, hierarchy: { text: "old" } },
        });

        expect(ctrlProxyClient["cachedHierarchy"]).toBe(cached);
        expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy.updatedAt).toBe(6_000);
        expect(ctrlProxyClient["cachedHierarchy"]?.captureReceivedAt).toBe(captureReceivedAt);
        expect(debug).toHaveBeenCalledWith(expect.stringContaining("pushed=1000 cached=6000"));
      } finally {
        debug.mockRestore();
      }
    });

    test("drops eight same-tree rebroadcasts despite solicited cache refreshes (#9259)", async () => {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const current: CtrlProxyHierarchy = {
        updatedAt: 20_000,
        packageName: "com.test.app",
        hierarchy: { text: "current" },
      };
      const stale = { ...current, updatedAt: 15_000, hierarchy: { text: "stale" } };
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await client.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        client["processMessage"]({ type: "hierarchy_update", data: current });
        for (let i = 0; i < 8; i++) {
          // A navigation invalidates the cache; its solicited response refreshes it.
          client.invalidateCache();
          const sentBefore = socket.sentMessages.length;
          const pending = client.requestHierarchySync(undefined, false, undefined, 1000);
          await waitForSentMessages(socket, sentBefore + 1);
          const request = JSON.parse(socket.sentMessages.at(-1)!) as { requestId: string };
          const refreshed = { ...current, updatedAt: current.updatedAt + i };
          socket.simulateMessage(
            JSON.stringify({
              type: "hierarchy_update",
              requestId: request.requestId,
              data: refreshed,
            }),
          );
          await pending;
          const cached = client["cachedHierarchy"];
          expect(cached?.hierarchy.updatedAt).toBe(refreshed.updatedAt);
          client["processMessage"]({ type: "hierarchy_update", data: stale });
          expect(client["cachedHierarchy"]).toBe(cached);
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        await client.close();
      }
    });

    test("accepts a ten-minute backward clock step and evaluates later pushes against it", () => {
      const current: CtrlProxyHierarchy = {
        updatedAt: 1_000_000,
        packageName: "com.test.app",
        hierarchy: { text: "current" },
      };
      const push = (data: CtrlProxyHierarchy) =>
        ctrlProxyClient["processMessage"]({ type: "hierarchy_update", data });
      push(current);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const stream = spyOn(ctrlProxyClient, "pushHierarchyToObservationStream");
      const backoff = spyOn(ctrlProxyClient, "startScreenshotBackoff");
      const listeners = spyOn(ctrlProxyClient, "notifyPushUpdateListeners");
      try {
        const stepped = { ...current, updatedAt: 400_000 };
        push(stepped);
        expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy).toBe(stepped);
        expect(stream).toHaveBeenCalledTimes(1);
        expect(backoff).toHaveBeenCalledTimes(1);
        expect(listeners).toHaveBeenCalledWith(stepped);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("pushed=400000 cached=1000000"));

        const newer = { ...stepped, updatedAt: 401_000 };
        push(newer);
        expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy).toBe(newer);
        const equal = { ...newer, hierarchy: { text: "equal" } };
        push(equal);
        expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy).toBe(equal);
        const cached = ctrlProxyClient["cachedHierarchy"];
        push({ ...equal, updatedAt: 400_000 });
        expect(ctrlProxyClient["cachedHierarchy"]).toBe(cached);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        stream.mockRestore();
        backoff.mockRestore();
        listeners.mockRestore();
      }
    });

    test("accepts the fifth advancing older push and resets the run on equal/newer acceptance", () => {
      const current: CtrlProxyHierarchy = {
        updatedAt: 20_000,
        packageName: "com.test.app",
        hierarchy: { text: "current" },
      };
      const push = (data: CtrlProxyHierarchy) =>
        ctrlProxyClient["processMessage"]({ type: "hierarchy_update", data });
      push(current);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        // Each accepted equal/newer push must break the run of four drops.
        let baseline = current.updatedAt;
        for (const updatedAt of [20_000, 21_000]) {
          for (let i = 0; i < 4; i++) {
            push({ ...current, updatedAt: 15_000 + i });
            expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy.updatedAt).toBe(baseline);
          }
          push({ ...current, updatedAt });
          baseline = updatedAt;
        }
        const older = { ...current, updatedAt: 16_004 };
        for (let i = 0; i < 4; i++) {
          push({ ...older, updatedAt: 16_000 + i });
          expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy.updatedAt).toBe(21_000);
        }
        expect(warn).not.toHaveBeenCalled();
        push(older);
        expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy).toBe(older);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("pushed=16004 cached=21000"));
        const cached = ctrlProxyClient["cachedHierarchy"];
        for (let i = 0; i < 4; i++) {
          push({ ...older, updatedAt: 15_000 + i });
          expect(ctrlProxyClient["cachedHierarchy"]).toBe(cached);
        }
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    test.each([12_000, 11_000])(
      "restarts an advancing older run at a non-advancing timestamp %i",
      (interruption) => {
        const current: CtrlProxyHierarchy = {
          updatedAt: 20_000,
          packageName: "com.test.app",
          hierarchy: { text: "current" },
        };
        const push = (updatedAt: number) =>
          ctrlProxyClient["processMessage"]({
            type: "hierarchy_update",
            data: { ...current, updatedAt },
          });
        push(current.updatedAt);
        const cached = ctrlProxyClient["cachedHierarchy"];
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          for (const updatedAt of [10_000, 11_000, 12_000, interruption]) {
            push(updatedAt);
            expect(ctrlProxyClient["cachedHierarchy"]).toBe(cached);
          }
          // The interruption is value one of the new run; four advances are needed.
          for (let i = 1; i < 4; i++) {
            push(interruption + i);
            expect(ctrlProxyClient["cachedHierarchy"]).toBe(cached);
          }
          expect(warn).not.toHaveBeenCalled();
          push(interruption + 4);
          expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy.updatedAt).toBe(interruption + 4);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(`pushed=${interruption + 4} cached=20000`),
          );
        } finally {
          warn.mockRestore();
        }
      },
    );

    test("a solicited cache replacement resets an advancing older run", async () => {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const current: CtrlProxyHierarchy = {
        updatedAt: 20_000,
        packageName: "com.test.app",
        hierarchy: { text: "current" },
      };
      const push = (updatedAt: number) =>
        client["processMessage"]({
          type: "hierarchy_update",
          data: { ...current, updatedAt },
        });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await client.ensureConnected();
        const socket = (await waitForSocket(getSocket)) as CapturingWebSocket;
        await waitForSocketOpen(socket);
        push(current.updatedAt);
        for (const updatedAt of [10_000, 11_000, 12_000, 13_000]) {
          push(updatedAt);
        }
        client.invalidateCache();
        const sentBefore = socket.sentMessages.length;
        const pending = client.requestHierarchySync(undefined, false, undefined, 1000);
        await waitForSentMessages(socket, sentBefore + 1);
        const request = JSON.parse(socket.sentMessages.at(-1)!) as { requestId: string };
        socket.simulateMessage(
          JSON.stringify({
            type: "hierarchy_update",
            requestId: request.requestId,
            data: current,
          }),
        );
        await pending;
        const cached = client["cachedHierarchy"];
        for (const updatedAt of [14_000, 15_000, 16_000, 17_000]) {
          push(updatedAt);
          expect(client["cachedHierarchy"]).toBe(cached);
        }
        expect(warn).not.toHaveBeenCalled();
        push(18_000);
        expect(client["cachedHierarchy"]?.hierarchy.updatedAt).toBe(18_000);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("pushed=18000 cached=20000"));
      } finally {
        warn.mockRestore();
        await client.close();
      }
    });

    test("drops a push exactly thirty seconds older but accepts one just beyond the gap", () => {
      const current: CtrlProxyHierarchy = {
        updatedAt: 100_000,
        packageName: "com.test.app",
        hierarchy: {},
      };
      ctrlProxyClient["processMessage"]({ type: "hierarchy_update", data: current });
      const cached = ctrlProxyClient["cachedHierarchy"];
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        ctrlProxyClient["processMessage"]({
          type: "hierarchy_update",
          data: { ...current, updatedAt: 70_000 },
        });
        expect(ctrlProxyClient["cachedHierarchy"]).toBe(cached);
        ctrlProxyClient["processMessage"]({
          type: "hierarchy_update",
          data: { ...current, updatedAt: 69_999 },
        });
        expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy.updatedAt).toBe(69_999);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    test("a newer hierarchy push replaces the cached capture and its receipt stamp", () => {
      const current: CtrlProxyHierarchy = {
        updatedAt: 2_000,
        packageName: "com.test.app",
        hierarchy: { text: "current" },
      };
      ctrlProxyClient["processMessage"]({ type: "hierarchy_update", data: current });
      fakeTimer.advanceTime(100);
      const newer = { ...current, updatedAt: 3_000, hierarchy: { text: "newer" } };
      ctrlProxyClient["processMessage"]({ type: "hierarchy_update", data: newer });

      expect(ctrlProxyClient["cachedHierarchy"]?.hierarchy).toBe(newer);
      expect(ctrlProxyClient["cachedHierarchy"]?.receivedAt).toBe(fakeTimer.now());
      expect(ctrlProxyClient["cachedHierarchy"]?.captureReceivedAt).toBe(fakeTimer.now());
    });

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

    test("retireInstance removes and closes the registered device client", async function () {
      IOSCtrlProxyClient.resetInstances();
      const created = IOSCtrlProxyClient.getInstance(testDevice);

      await IOSCtrlProxyClient.retireInstance(testDevice.deviceId);

      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBeNull();
      expect(created.isConnected()).toBe(false);
    });

    test("retiring during a pending screenshot leaves no reconnecting replacement", async function () {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      let restarts = 0;
      const restartBudget = new ForcedRestartBudget(fakeTimer);
      const manager = {
        getForcedRestartBudget: () => restartBudget,
        forceRestart: async () => {
          restarts += 1;
        },
      } as CtrlProxyIosManager;
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
        () => manager,
      );
      (
        IOSCtrlProxyClient as unknown as { instances: Map<string, IOSCtrlProxyClient> }
      ).instances.set(testDevice.deviceId, client);

      const screenshot = client.requestScreenshot(5_000);
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket as CapturingWebSocket);
      expect(commandPayloads(socket as CapturingWebSocket)[0]?.type).toBe("request_screenshot");
      const screenshotResult = screenshot.then(
        () => null,
        (error: unknown) => error,
      );
      await IOSCtrlProxyClient.retireInstance(testDevice.deviceId);
      expect(String(await screenshotResult)).toContain("WebSocket connection closed");
      const duringKill = IOSCtrlProxyClient.getInstance(testDevice);
      expect(duringKill).not.toBe(client);
      expect(await duringKill.ensureConnected()).toBe(false);
      expect(restarts).toBe(0);
    });

    test("a closed client refuses all dial and failure-escalation paths", async function () {
      let socketCreations = 0;
      let restarts = 0;
      const manager = {
        forceRestart: async () => {
          restarts += 1;
        },
      } as CtrlProxyIosManager;
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        {
          create: (url) => {
            socketCreations += 1;
            return new FakeWebSocket(url, "none", 0, fakeTimer);
          },
        },
        fakeTimer,
        () => manager,
      );
      await client.close();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        (client as unknown as { onConnectAttemptFailed(): void }).onConnectAttemptFailed();
      }
      expect(await client.ensureConnected()).toBe(false);
      expect(await client.connectWithoutSetup()).toBe(false);
      expect(socketCreations).toBe(0);
      expect(restarts).toBe(0);
    });

    test("retired lookup is inert even when no client existed before retirement", async function () {
      await IOSCtrlProxyClient.retireInstance(testDevice.deviceId);
      const retired = IOSCtrlProxyClient.getInstance(testDevice);
      expect(IOSCtrlProxyClient.getInstance(testDevice)).toBe(retired);
      expect(await retired.ensureConnected()).toBe(false);
      expect(IOSCtrlProxyClient.getExistingInstance(testDevice.deviceId)).toBeNull();
    });

    test("a fresh device start restores connection and failure escalation", async function () {
      let restarts = 0;
      const restartBudget = new ForcedRestartBudget(fakeTimer);
      const manager = {
        getForcedRestartBudget: () => restartBudget,
        forceRestart: async () => {
          restarts += 1;
        },
      } as CtrlProxyIosManager;
      await IOSCtrlProxyClient.retireInstance(testDevice.deviceId);
      const retired = IOSCtrlProxyClient.getInstance(testDevice);
      IOSCtrlProxyClient.resumeAfterDeviceStart(testDevice.deviceId);
      const fresh = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
        () => manager,
      );
      (
        IOSCtrlProxyClient as unknown as { instances: Map<string, IOSCtrlProxyClient> }
      ).instances.set(testDevice.deviceId, fresh);
      expect(IOSCtrlProxyClient.getInstance(testDevice, serverPort)).toBe(fresh);
      expect(fresh).not.toBe(retired);
      expect(await fresh.ensureConnected()).toBe(true);
      IOSCtrlProxyClient.resumeAfterDeviceStart(testDevice.deviceId);
      expect(IOSCtrlProxyClient.getInstance(testDevice, serverPort)).toBe(fresh);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        (fresh as unknown as { onConnectAttemptFailed(): void }).onConnectAttemptFailed();
      }
      await flushMicrotasks();
      expect(restarts).toBe(1);
      await fresh.close();
    });

    test("connection failure threshold restarts only the triggering booted simulator", async function () {
      const otherDevice: BootedDevice = {
        deviceId: "22222222-2222-2222-2222-222222222222",
        platform: "ios",
        name: "Other booted iPhone",
      };
      const managerCalls: Array<{ deviceId: string; action: string }> = [];
      const managerFor = (device: BootedDevice): CtrlProxyIosManager => {
        const budget = new ForcedRestartBudget(fakeTimer);
        return {
          getForcedRestartBudget: () => budget,
          forceRestart: async () => {
            managerCalls.push({ deviceId: device.deviceId, action: "forceRestart" });
          },
          setup: async () => {
            managerCalls.push({ deviceId: device.deviceId, action: "setup" });
            return { success: false, message: "fake runner unavailable" };
          },
        } as CtrlProxyIosManager;
      };
      const managers = new Map([
        [testDevice.deviceId, managerFor(testDevice)],
        [otherDevice.deviceId, managerFor(otherDevice)],
      ]);
      const factoryCalls: string[] = [];
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
        (device) => {
          factoryCalls.push(device.deviceId);
          return managers.get(device.deviceId)!;
        },
        async () => [testDevice, otherDevice],
      );
      factoryCalls.length = 0;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          (client as unknown as { onConnectAttemptFailed(): void }).onConnectAttemptFailed();
        }
        await flushMicrotasks();
        expect(managerCalls.filter((call) => call.action === "forceRestart")).toEqual([
          { deviceId: testDevice.deviceId, action: "forceRestart" },
        ]);
        expect([...new Set(factoryCalls)]).toEqual([testDevice.deviceId]);
        expect(managerCalls.some((call) => call.deviceId === otherDevice.deviceId)).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("manager startup and forced restart refuse a retired device", async function () {
      const manager = IOSCtrlProxyManager.createForTesting(testDevice, fakeTimer);
      IOSCtrlProxyManager.retireDevice(testDevice.deviceId);
      await expect(manager.start()).rejects.toThrow("being shut down");
      await expect(manager.forceRestart()).rejects.toThrow("being shut down");
    });

    test("intentional retirement cancels a reconnect scheduled before runner shutdown", async function () {
      const timer = new FakeTimer();
      let socketCreations = 0;
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        {
          create() {
            socketCreations += 1;
            throw new Error("retired client must not reconnect");
          },
        },
        timer,
      );
      (client as unknown as { scheduleReconnect(): void }).scheduleReconnect();

      await client.close();
      timer.advanceTime(5_000);
      await flushPromises();

      expect(socketCreations).toBe(0);
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

      test("retains metadata on receipt even when NO device-data stream server is running", function () {
        // No startStreamServer() here: the push early-returns with no server
        // (pushHierarchyToObservationStream ~2050), so a push-gated retention would leave this
        // null. Receipt-based retention must not.
        receiveHierarchy(fullMetadata);
        expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual(expectedFull);
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
