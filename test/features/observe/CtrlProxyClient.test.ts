import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { CtrlProxyFocus } from "../../../src/features/observe/android/CtrlProxyFocus";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../src/utils/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BootedDevice, HighlightShape } from "../../../src/models";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  WebSocketState
} from "../../fakes/FakeWebSocket";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { DeviceConnectionLostNotifier } from "../../../src/features/observe/DeviceConnectionLostNotifier";
import { PortManager } from "../../../src/utils/PortManager";
import { installInMemoryNavManager } from "../../helpers/navigationTestHarness";
import type { HierarchySyncDiagnostics } from "../../../src/features/observe/android/types";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeLogger } from "../../fakes/FakeLogger";
import {
  startDeviceDataStreamSocketServer,
  stopDeviceDataStreamSocketServer,
} from "../../../src/daemon/deviceDataStreamSocketServer";
import { FakeSocket } from "../../fakes/FakeNetServer";
import { FakeScreenshotBackoffScheduler } from "../../../src/features/observe/ScreenshotBackoffScheduler";
import { CTRLPROXY_RATE_LIMITED_ERROR } from "../../../src/features/observe/android/screenshotFallbackReason";

describe("AndroidCtrlProxyClient", function() {
  let accessibilityServiceClient: AndroidCtrlProxyClient;
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  let fakeAdbFactory: FakeAdbClientFactory;
  const serverPort: number = 8765;

  beforeEach(async function() {
    // Create fake timer with auto-advance for async event flushing
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Create fake ADB instance
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    // Create test device
    testDevice = {
      deviceId: "test-device",
      platform: "android",
      isEmulator: true,
      name: "Test Device"
    };

    // Create FakeAdbClientFactory for AndroidCtrlProxyManager
    fakeAdbFactory = new FakeAdbClientFactory();

    // Reset singleton instances for clean test state
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();

    // Pass FakeAdbExecutor directly to createForTesting since it implements AdbExecutor
    accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createSuccessWebSocketFactory(),
      fakeTimer
    );
    AndroidCtrlProxyManager.getInstance(testDevice, fakeAdbFactory).clearAvailabilityCache();

    // Clear any cached hierarchy data to prevent cache contamination between tests (issue #72)
    accessibilityServiceClient.invalidateCache();
  });

  afterEach(async function() {
    // Clean up WebSocket connections
    if (accessibilityServiceClient) {
      await accessibilityServiceClient.close();
    }
    await stopDeviceDataStreamSocketServer();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  const createCapturingWebSocketFactory = (timer?: FakeTimer): {
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
      if (socket.sentMessages.length >= minCount) {
        return;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  const flushPromises = async (iterations: number = 5): Promise<void> => {
    for (let i = 0; i < iterations; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  test("discards a WebSocket that opens after close() so teardown cannot be undone", async () => {
    // Manual (non-auto-advancing) timer so the in-flight handshake stays pending
    // until we trigger `open` ourselves, and the connection timeout never fires.
    const manualTimer = new FakeTimer();
    let socket: FakeWebSocket | null = null;
    const factory = (url: string): WebSocket => {
      // "timeout" mode keeps the socket CONNECTING (the timer is never advanced).
      socket = new FakeWebSocket(url, "timeout", 60_000, manualTimer);
      return socket as unknown as WebSocket;
    };
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      factory,
      manualTimer,
    );
    try {
      const connectPromise = client.ensureConnected();
      await flushPromises(8); // let setupBeforeConnect + ws construction settle; open has NOT fired
      expect(socket).not.toBeNull();
      expect(client.isConnected()).toBe(false);

      // Shutdown teardown closes the client while the handshake is still in flight.
      await client.close();

      // The handshake now completes — `open` fires AFTER close().
      socket!.readyState = WebSocketState.OPEN;
      socket!.emit("open");
      await flushPromises(8);

      // The post-close open is discarded: no socket installed, connect resolves false.
      expect(client.isConnected()).toBe(false);
      await expect(connectPromise).resolves.toBe(false);
    } finally {
      await client.close();
    }
  });

  test("aborts a connect whose platform setup completes after close()", async () => {
    const manualTimer = new FakeTimer();
    let releaseForward!: () => void;
    const forwardGate = new Promise<void>(resolve => {
      releaseForward = resolve;
    });
    class GatedForwardAdb extends FakeAdbExecutor {
      override async executeCommand(
        command: string,
        timeoutMs?: number,
        maxBuffer?: number,
        noRetry?: boolean,
        signal?: AbortSignal,
      ) {
        if (command.includes("forward")) {
          await forwardGate; // hold setupBeforeConnect until the test releases it
        }
        return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
      }
    }
    const gatedAdb = new GatedForwardAdb();
    gatedAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    gatedAdb.setScreenState(true);
    let socket: FakeWebSocket | null = null;
    const factory = (url: string): WebSocket => {
      socket = new FakeWebSocket(url, "timeout", 60_000, manualTimer);
      return socket as unknown as WebSocket;
    };
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      gatedAdb,
      factory,
      manualTimer,
    );
    try {
      const connectPromise = client.ensureConnected();
      await flushPromises(8); // parked inside setupBeforeConnect; no socket yet
      expect(socket).toBeNull();

      // Shutdown teardown closes the client while port-forward setup is pending.
      await client.close();

      // Platform setup now finishes — after close().
      releaseForward();
      await flushPromises(8);

      // The connect aborts before creating a socket, so the loops cannot restart.
      expect(socket).toBeNull();
      expect(client.isConnected()).toBe(false);
      await expect(connectPromise).resolves.toBe(false);
    } finally {
      releaseForward();
      await client.close();
    }
  });

  const settleNavigationHierarchyInterleaving = async (timer: FakeTimer): Promise<void> => {
    // recordNavigationEvent commits its in-memory writes across several async
    // query hops before assigning currentScreen. Drain setImmediate + microtasks
    // so the navigation and hierarchy paths settle deterministically (#3063).
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await timer.advanceTimersByTimeAsync(1);
    }
  };

  const startSdkNavigationHierarchyInterleaving = async () => {
    NavigationGraphManager.resetInstance();
    const navHarness = await installInMemoryNavManager();
    const navManager = navHarness.manager;
    const testTimer = new FakeTimer();
    testTimer.enableAutoAdvance();
    const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
    const testClient = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      factory,
      testTimer
    );
    const resultPromise = testClient.getLatestHierarchy(true, 2000);
    const socket = await waitForSocket(getSocket);
    if (!socket) {
      throw new Error("Expected capturing CtrlProxy socket");
    }
    await waitForSocketOpen(socket);

    socket.simulateMessage(JSON.stringify({
      type: "navigation_event",
      event: {
        destination: "SdkHome",
        source: "SdkStart",
        arguments: {},
        metadata: {},
        timestamp: testTimer.now(),
        sequenceNumber: 1,
        applicationId: "com.example.sdk",
      }
    }));

    socket.simulateMessage(JSON.stringify({
      type: "hierarchy_update",
      timestamp: testTimer.now(),
      data: {
        updatedAt: testTimer.now(),
        packageName: "com.example.sdk",
        hierarchy: {
          "text": "SDK Home",
          "resource-id": "com.example.sdk:id/home",
        }
      }
    }));

    return { navHarness, navManager, resultPromise, testClient, testTimer };
  };

  interface ScreenshotUpdateMessage {
    type: string;
    deviceId?: string;
    screenshotBase64?: string;
    screenshotMimeType?: string;
    screenshotFormat?: string;
    screenshotCaptureSource?: string;
    screenshotFallback?: boolean;
    screenshotFallbackReason?: string | null;
    screenshotCaptureDurationMs?: number;
    screenshotEncodeDurationMs?: number;
    screenshotByteLength?: number;
    screenshotBase64Length?: number;
    captureSequence?: number;
  }

  const startStreamServerWithScreenshotSubscriber = async (): Promise<FakeSocket> => {
    await stopDeviceDataStreamSocketServer();
    const server = await startDeviceDataStreamSocketServer(fakeTimer);
    const socket = new FakeSocket();
    await (server as any).processLine(
      socket as any,
      JSON.stringify({
        id: "subscribe-screenshot-metadata-test",
        command: "subscribe",
        deviceId: testDevice.deviceId,
        screenshotIntervalMs: 250,
      })
    );
    socket.reset();
    return socket;
  };

  const getScreenshotUpdates = (socket: FakeSocket): ScreenshotUpdateMessage[] => {
    return socket.getWrittenMessages<ScreenshotUpdateMessage>()
      .filter(message => message.type === "screenshot_update");
  };

  const expectSingleScreenshotUpdate = (
    socket: FakeSocket,
    expected: Partial<ScreenshotUpdateMessage>
  ): void => {
    expect(getScreenshotUpdates(socket)).toEqual([expect.objectContaining(expected)]);
  };

  /** A minimal PNG whose IHDR declares the given pixel size, base64-encoded as CtrlProxy sends it. */
  const pngFrame = (width: number, height: number): string => {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer.toString("base64");
  };

  /** A hierarchy whose single window declares the given device screen size. */
  const hierarchyWithScreenSize = (width: number, height: number): any => ({
    packageName: "com.example.app",
    windows: [{ bounds: { left: 0, top: 0, right: width, bottom: height } }],
    hierarchy: { node: { $: { class: "Root" } } },
  });

  /**
   * Push a frame the way the client does. The declared geometry is NOT passed here: the Android
   * client reads it from its own screen-geometry cache, which is exactly the provenance under test.
   */
  const pushScreenshotThroughClient = (base64: string): void => {
    // Bind at push time the way the client binds at request time; the binding under test is
    // whatever the geometry cache currently vouches for.
    const binding = (accessibilityServiceClient as any).screenGeometry.bind() ?? undefined;
    (accessibilityServiceClient as any).pushScreenshotToObservationStream(
      base64,
      { screenshotMimeType: "image/png", screenshotFormat: "png" },
      binding
    );
  };

  const setAdbPngScreenshotResponse = (screenshotBase64: string = "png-base64"): void => {
    fakeAdb.setCommandResponse("screencap -p", {
      stdout: `${screenshotBase64}\n`,
      stderr: "",
    });
  };

  const forwardScreenshotBinding = (
    width: number = 1080,
    height: number = 2340
  ): { captureSequence: number; width: number; height: number } => {
    (accessibilityServiceClient as any).handleHierarchyUpdate(
      hierarchyWithScreenSize(width, height)
    );
    const binding = (accessibilityServiceClient as any).screenGeometry.bind();
    if (!binding) {
      throw new Error("Expected forwarded hierarchy to establish a screenshot binding");
    }
    return binding;
  };

  const startScreenshotBackoffAndFlush = async (): Promise<void> => {
    (accessibilityServiceClient as any).startScreenshotBackoff();
    await fakeTimer.advanceTimersByTimeAsync(0);
    await flushPromises();
  };

  const startScreenshotBackoffAndReadRequest = async (
    ctrlProxySocket: CapturingWebSocket
  ): Promise<{ requestId: string }> => {
    (accessibilityServiceClient as any).startScreenshotBackoff();
    await fakeTimer.advanceTimersByTimeAsync(0);
    await waitForSentMessages(ctrlProxySocket);
    return JSON.parse(ctrlProxySocket.sentMessages.at(-1)!) as { requestId: string };
  };

  const recreateClientForManualTimerTest = async (): Promise<void> => {
    await accessibilityServiceClient.close();
    AndroidCtrlProxyClient.resetInstances();
    fakeTimer = new FakeTimer();
    accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer
    );
    accessibilityServiceClient.invalidateCache();
  };

  const startCapturingBackoffStreamTest = async (): Promise<{
    streamSocket: FakeSocket;
    ctrlProxySocket: CapturingWebSocket;
  }> => {
    await accessibilityServiceClient.close();
    AndroidCtrlProxyClient.resetInstances();
    fakeTimer = new FakeTimer();
    const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
    accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      factory,
      fakeTimer
    );
    accessibilityServiceClient.invalidateCache();
    const streamSocket = await startStreamServerWithScreenshotSubscriber();

    await accessibilityServiceClient.ensureConnected();
    const ctrlProxySocket = await waitForSocket(getSocket) as CapturingWebSocket | null;
    await waitForSocketOpen(ctrlProxySocket);
    if (!ctrlProxySocket) {
      throw new Error("Expected capturing CtrlProxy socket");
    }

    return { streamSocket, ctrlProxySocket };
  };

  test("reports ADB screencap fallback screenshots as PNG fallback with reason", async () => {
    fakeAdb.setCommandResponse("screencap -p", {
      stdout: "png-base64\n",
      stderr: "",
    });

    const result = await (accessibilityServiceClient as any).captureScreenshotViaAdb("websocket_unavailable");

    expect(result).toMatchObject({
      success: true,
      data: "png-base64",
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "websocket_unavailable",
    });
  });

  test("reports websocket-unavailable backoff captures as ADB PNG fallback", async () => {
    await recreateClientForManualTimerTest();
    const streamSocket = await startStreamServerWithScreenshotSubscriber();
    const screenshotBase64 = pngFrame(1080, 2340);
    setAdbPngScreenshotResponse(screenshotBase64);
    const binding = forwardScreenshotBinding();
    streamSocket.reset();

    await startScreenshotBackoffAndFlush();

    expectSingleScreenshotUpdate(streamSocket, {
      screenshotBase64,
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "websocket_unavailable",
      captureSequence: binding.captureSequence,
    });
  });

  test("reports CtrlProxy backoff captures as JPEG non-fallback", async () => {
    const { streamSocket, ctrlProxySocket } = await startCapturingBackoffStreamTest();

    const request = await startScreenshotBackoffAndReadRequest(ctrlProxySocket);
    ctrlProxySocket.emit("message", JSON.stringify({
      type: "screenshot",
      requestId: request.requestId,
      data: "jpeg-base64",
      format: "jpeg",
      timestamp: 123,
      screenshotCaptureDurationMs: 42,
      screenshotEncodeDurationMs: 7,
      screenshotByteLength: 1200,
      screenshotBase64Length: 1600,
    }));
    await flushPromises();

    expectSingleScreenshotUpdate(streamSocket, {
      screenshotBase64: "jpeg-base64",
      screenshotMimeType: "image/jpeg",
      screenshotFormat: "jpeg",
      screenshotCaptureSource: "android_ctrlproxy_a11y",
      screenshotFallback: false,
      screenshotCaptureDurationMs: 42,
      screenshotEncodeDurationMs: 7,
      screenshotByteLength: 1200,
      screenshotBase64Length: 1600,
    });
  });

  test("reports unsupported a11y screenshots as emitted ADB PNG fallback frames", async () => {
    await recreateClientForManualTimerTest();
    const streamSocket = await startStreamServerWithScreenshotSubscriber();
    const screenshotBase64 = pngFrame(1080, 2340);
    setAdbPngScreenshotResponse(screenshotBase64);
    const binding = forwardScreenshotBinding();
    streamSocket.reset();
    (accessibilityServiceClient as any).a11yScreenshotSupported = false;

    await startScreenshotBackoffAndFlush();

    expectSingleScreenshotUpdate(streamSocket, {
      screenshotBase64,
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "a11y_screenshot_unsupported",
      captureSequence: binding.captureSequence,
    });
  });

  test("reports CtrlProxy screenshot errors as emitted ADB PNG fallback frames", async () => {
    const { streamSocket, ctrlProxySocket } = await startCapturingBackoffStreamTest();
    const screenshotBase64 = pngFrame(1080, 2340);
    setAdbPngScreenshotResponse(screenshotBase64);
    const binding = forwardScreenshotBinding();
    streamSocket.reset();

    const request = await startScreenshotBackoffAndReadRequest(ctrlProxySocket);
    ctrlProxySocket.emit("message", JSON.stringify({
      type: "screenshot_error",
      requestId: request.requestId,
      error: "Runner failed to capture screenshot",
    }));
    await flushPromises();

    expectSingleScreenshotUpdate(streamSocket, {
      screenshotBase64,
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "ctrlproxy_failed",
      captureSequence: binding.captureSequence,
    });
  });

  test("reports CtrlProxy screenshot timeout errors as emitted ADB PNG fallback frames", async () => {
    const { streamSocket, ctrlProxySocket } = await startCapturingBackoffStreamTest();
    setAdbPngScreenshotResponse();

    const request = await startScreenshotBackoffAndReadRequest(ctrlProxySocket);
    ctrlProxySocket.emit("message", JSON.stringify({
      type: "screenshot_error",
      requestId: request.requestId,
      error: "Screenshot timeout",
    }));
    await flushPromises();

    expectSingleScreenshotUpdate(streamSocket, {
      screenshotBase64: "png-base64",
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "ctrlproxy_timeout",
    });
  });

  test("reports CtrlProxy screenshot exceptions as emitted ADB PNG fallback frames", async () => {
    const { streamSocket, ctrlProxySocket } = await startCapturingBackoffStreamTest();
    const screenshotBase64 = pngFrame(1080, 2340);
    setAdbPngScreenshotResponse(screenshotBase64);
    const binding = forwardScreenshotBinding();
    streamSocket.reset();
    ctrlProxySocket.send = () => {
      throw new Error("boom");
    };

    await startScreenshotBackoffAndFlush();

    expectSingleScreenshotUpdate(streamSocket, {
      screenshotBase64,
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_adb_screencap",
      screenshotFallback: true,
      screenshotFallbackReason: "ctrlproxy_exception",
      captureSequence: binding.captureSequence,
    });
  });

  test("keeps an ADB fallback bound to the hierarchy present when the capture starts", async () => {
    await recreateClientForManualTimerTest();
    const streamSocket = await startStreamServerWithScreenshotSubscriber();
    const initialBinding = forwardScreenshotBinding();
    const screenshotBase64 = pngFrame(1080, 2340);
    streamSocket.reset();
    (accessibilityServiceClient as any).a11yScreenshotSupported = false;

    let resolveAdbCapture: ((result: { stdout: string; stderr: string }) => void) | null = null;
    const adbCapture = new Promise<{ stdout: string; stderr: string }>(resolve => {
      resolveAdbCapture = resolve;
    });
    spyOn(fakeAdb, "executeCommand").mockImplementation(async command => {
      if (command.includes("screencap -p")) {
        return await adbCapture as any;
      }
      return { stdout: "", stderr: "" } as any;
    });

    const capturePromise = accessibilityServiceClient.captureScreenshotForObservationStream();
    await flushPromises();

    const laterBinding = forwardScreenshotBinding();
    expect(laterBinding.captureSequence).toBeGreaterThan(initialBinding.captureSequence);
    resolveAdbCapture?.({ stdout: `${screenshotBase64}\n`, stderr: "" });
    const result = await capturePromise;

    expect(result).toMatchObject({
      success: true,
      data: screenshotBase64,
      captureBinding: initialBinding,
    });
  });

  describe("a11y screenshot support latch", function() {
    // Drives AndroidCtrlProxyClient.captureScreenshotForObservationStream() through the real socket:
    // each failed a11y screenshot increments a consecutive-failure counter; on the
    // A11Y_SCREENSHOT_MAX_FAILURES-th (=3) it latches a11yScreenshotSupported=false so every future
    // capture goes straight to ADB (no wasted a11y round-trips), and any success resets the counter.
    // Flip the constant 3->1 and two of the three tests below go red — the latch threshold is pinned,
    // not merely "eventually latches".
    const setupConnectedCapturingClient = async (): Promise<{
      client: AndroidCtrlProxyClient;
      socket: CapturingWebSocket;
    }> => {
      await accessibilityServiceClient.close();
      AndroidCtrlProxyClient.resetInstances();
      // Manual (non-auto-advance) timer: the per-request 3s screenshot timeout must NOT auto-fire and
      // preempt the wire frame we emit — we resolve each capture by socket, exactly as the backoff
      // stream tests above do.
      const localTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(localTimer);
      accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        localTimer
      );
      accessibilityServiceClient.invalidateCache();
      // ADB PNG fallback used whenever an a11y capture fails or the latch is set.
      setAdbPngScreenshotResponse();

      await accessibilityServiceClient.ensureConnected();
      const socket = await waitForSocket(getSocket) as CapturingWebSocket | null;
      await waitForSocketOpen(socket);
      if (!socket) {
        throw new Error("Expected capturing CtrlProxy socket");
      }
      return { client: accessibilityServiceClient, socket };
    };

    const countScreenshotRequests = (socket: CapturingWebSocket): number =>
      socket.sentMessages.filter(raw => {
        try {
          return JSON.parse(raw).type === "request_screenshot";
        } catch {
          return false;
        }
      }).length;

    const driveA11yScreenshot = async (
      client: AndroidCtrlProxyClient,
      socket: CapturingWebSocket,
      resolveWith: { kind: "error"; error?: string } | { kind: "success" }
    ): Promise<any> => {
      const before = countScreenshotRequests(socket);
      const capturePromise = (client as any).captureScreenshotForObservationStream() as Promise<any>;
      await waitForSentMessages(socket, socket.sentMessages.length + 1);
      const request = findSentMessage(socket, "request_screenshot");
      expect(countScreenshotRequests(socket)).toBe(before + 1);
      const frame = resolveWith.kind === "error"
        ? {
          type: "screenshot_error",
          requestId: request.requestId,
          error: resolveWith.error ?? "Runner failed to capture screenshot",
        }
        : { type: "screenshot", requestId: request.requestId, data: "jpeg-base64", format: "jpeg", timestamp: 1 };
      socket.emit("message", JSON.stringify(frame));
      await flushPromises();
      return capturePromise;
    };

    const findSentMessage = (socket: CapturingWebSocket, type: string): any => {
      for (let i = socket.sentMessages.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(socket.sentMessages[i]);
          if (parsed.type === type) { return parsed; }
        } catch {
          // skip non-JSON control frames
        }
      }
      throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
    };

    // Threshold-agnostic failure driver used only by the "eventually latches" test: it fails the
    // a11y capture when one is attempted, but tolerates a capture that already short-circuited to
    // ADB (so this test stays green whether the threshold is 3 or lower — the too-low case is what
    // the other two tests catch).
    const driveFailureTolerant = async (
      client: AndroidCtrlProxyClient,
      socket: CapturingWebSocket
    ): Promise<void> => {
      const before = countScreenshotRequests(socket);
      const capturePromise = (client as any).captureScreenshotForObservationStream() as Promise<any>;
      await flushPromises();
      if (countScreenshotRequests(socket) > before) {
        const request = findSentMessage(socket, "request_screenshot");
        socket.emit("message", JSON.stringify({
          type: "screenshot_error", requestId: request.requestId, error: "Runner failed to capture screenshot",
        }));
        await flushPromises();
      }
      await capturePromise;
    };

    test("latches to permanent ADB fallback after three consecutive a11y screenshot failures", async function() {
      const { client, socket } = await setupConnectedCapturingClient();

      await driveFailureTolerant(client, socket);
      await driveFailureTolerant(client, socket);
      await driveFailureTolerant(client, socket);

      expect((client as any).a11yScreenshotSupported).toBe(false);

      // Once latched, a further capture must NOT send another a11y request — it goes straight to ADB.
      const requestsBefore = countScreenshotRequests(socket);
      const result = await (client as any).captureScreenshotForObservationStream() as any;
      await flushPromises();
      expect(countScreenshotRequests(socket)).toBe(requestsBefore);
      expect(result.screenshotCaptureSource).toBe("android_adb_screencap");
    });

    test("keeps attempting a11y screenshots after only two consecutive failures", async function() {
      const { client, socket } = await setupConnectedCapturingClient();

      await driveA11yScreenshot(client, socket, { kind: "error" });
      await driveA11yScreenshot(client, socket, { kind: "error" });

      // Two failures is below the threshold: the latch must NOT be set yet...
      expect((client as any).a11yScreenshotSupported).not.toBe(false);
      // ...and the next capture must still ATTEMPT an a11y screenshot over the socket.
      const requestsBefore = countScreenshotRequests(socket);
      await driveA11yScreenshot(client, socket, { kind: "error" });
      expect(countScreenshotRequests(socket)).toBe(requestsBefore + 1);
    });

    test("resets the failure counter after a successful a11y screenshot", async function() {
      const { client, socket } = await setupConnectedCapturingClient();

      await driveA11yScreenshot(client, socket, { kind: "error" });
      await driveA11yScreenshot(client, socket, { kind: "error" });
      // A success (a wire "screenshot" frame the client actually handles) clears the counter.
      const success = await driveA11yScreenshot(client, socket, { kind: "success" });
      expect(success.success).toBe(true);
      expect((client as any).a11yScreenshotSupported).toBe(true);

      // Because the counter reset, two more failures still do not reach the latch threshold.
      await driveA11yScreenshot(client, socket, { kind: "error" });
      await driveA11yScreenshot(client, socket, { kind: "error" });
      expect((client as any).a11yScreenshotSupported).not.toBe(false);
    });

    test("does not count rate-limited screenshots as unsupported failures", async function() {
      const { client, socket } = await setupConnectedCapturingClient();

      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await driveA11yScreenshot(client, socket, {
          kind: "error",
          error: CTRLPROXY_RATE_LIMITED_ERROR,
        });
        expect(result.screenshotFallbackReason).toBe("ctrlproxy_rate_limited");
      }

      expect((client as any).a11yScreenshotFailures).toBe(0);
      expect((client as any).a11yScreenshotSupported).toBe(null);

      const next = await driveA11yScreenshot(client, socket, { kind: "error" });
      expect(next.screenshotFallbackReason).toBe("ctrlproxy_failed");
      expect((client as any).a11yScreenshotFailures).toBe(1);
      expect((client as any).a11yScreenshotSupported).not.toBe(false);
    });
  });

  test("allocates an Android forwarding port while skipping the iOS SDK hierarchy server port", async function() {
    await accessibilityServiceClient.close();
    AndroidCtrlProxyClient.resetInstances();
    PortManager.reset();

    const checkedPorts: number[] = [];
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: (port: number) => {
        checkedPorts.push(port);
        return port !== 8765;
      },
    });
    try {
      accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(),
        fakeTimer
      );

      expect(checkedPorts).toEqual([8765, 8767]);
      expect((accessibilityServiceClient as unknown as { getWebSocketUrl: () => string }).getWebSocketUrl()).toBe(
        "ws://127.0.0.1:8767/ws"
      );
    } finally {
      PortManager.setPortAvailabilityCheckerForTesting(null);
    }
  });

  test("setupPortForwarding reallocates while preserving Android's reserved ports", async function() {
    await accessibilityServiceClient.close();
    AndroidCtrlProxyClient.resetInstances();
    PortManager.reset();

    const unavailablePorts = new Set<number>();
    const checkedPorts: number[] = [];
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: (port: number) => {
        checkedPorts.push(port);
        return !unavailablePorts.has(port);
      },
    });
    try {
      accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(),
        fakeTimer
      );
      unavailablePorts.add(8765);

      await (accessibilityServiceClient as unknown as {
        setupPortForwarding: () => Promise<void>;
        getWebSocketUrl: () => string;
      }).setupPortForwarding();

      expect(checkedPorts).toEqual([8765, 8765, 8767]);
      expect(fakeAdb.getExecutedCommands()).toContain("forward --remove tcp:8767");
      expect(fakeAdb.getExecutedCommands()).toContain("forward tcp:8767 tcp:8765");
      expect((accessibilityServiceClient as unknown as { getWebSocketUrl: () => string }).getWebSocketUrl()).toBe(
        "ws://127.0.0.1:8767/ws"
      );
    } finally {
      PortManager.setPortAvailabilityCheckerForTesting(null);
    }
  });

  test("late invalidated-observer cleanup cannot release a replacement observer's port", async function() {
    await accessibilityServiceClient.close();
    AndroidCtrlProxyClient.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    try {
      const original = AndroidCtrlProxyClient.getInstance(testDevice, fakeAdbFactory);
      const originalPort = PortManager.getPort(testDevice.deviceId);
      original.invalidateForShutdownRecovery();

      const replacement = AndroidCtrlProxyClient.getInstance(testDevice, fakeAdbFactory);
      const replacementPort = PortManager.getPort(testDevice.deviceId);
      expect(replacementPort).not.toBe(originalPort);

      await original.close();
      expect(PortManager.getPort(testDevice.deviceId)).toBe(replacementPort);

      await replacement.close();
    } finally {
      PortManager.setPortAvailabilityCheckerForTesting(null);
      PortManager.reset();
    }
  });

  describe("connection lifecycle", function() {
    test("notifies the observation stream when the WebSocket connection closes", function() {
      const lostDeviceIds: string[] = [];
      const notifier: DeviceConnectionLostNotifier = {
        onDeviceConnectionLost: deviceId => {
          lostDeviceIds.push(deviceId);
        },
      };
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
        undefined,
        undefined,
        undefined,
        notifier
      );

      (testClient as any).onConnectionClosed();

      expect(lostDeviceIds).toEqual(["test-device"]);
    });
  });

  describe("getLatestHierarchy", function() {
    test("should return hierarchy data when WebSocket receives fresh data", async function() {
      const mockHierarchyData = {
        updatedAt: 1750934583218,
        packageName: "com.google.android.deskclock",
        hierarchy: {
          "text": "6:43 AM",
          "content-desc": "6:43 AM",
          "resource-id": "com.google.android.deskclock:id/digital_clock",
          "bounds": {
            left: 175,
            top: 687,
            right: 692,
            bottom: 973
          },
          "clickable": "false",
          "enabled": "true"
        }
      };

      // Use FakeTimer for fast, deterministic test execution
      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: mockHierarchyData
        }));

        const result = await resultPromise;

        expect(result).not.toBeNull();
        expect(result.hierarchy).not.toBeNull();
        expect(result.fresh).toBe(true);
        expect(result.updatedAt).toBe(1750934583218);
        expect(result.hierarchy!.updatedAt).toBe(1750934583218);
        expect(result.hierarchy!.packageName).toBe("com.google.android.deskclock");
        expect(result.hierarchy!.hierarchy.text).toBe("6:43 AM");
      } finally {
        await testClient.close();
      }
    });

    test("should return cached data when not waiting for fresh data", async function() {
      const mockHierarchyData = {
        updatedAt: 100, // Use timer-relative timestamp
        packageName: "com.google.android.deskclock",
        hierarchy: {
          text: "Cached Data",
          clickable: "true"
        }
      };

      const testTimer = new FakeTimer();
      // Don't use autoAdvance - we need to control time for polling
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        // First call to populate cache - use resolveWithFakeTimer for polling
        const firstResultPromise = testClient.getLatestHierarchy(true, 2000);

        // Wait for socket and send message (this happens in parallel with the promise)
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // Simulate message - this sets cachedHierarchy
        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: mockHierarchyData
        }));

        // Now advance time so the polling interval finds the fresh data
        await testTimer.resolvePromise(firstResultPromise);

        // Second call should return cached data immediately (no polling needed)
        testTimer.enableAutoAdvance(); // Now autoAdvance is fine
        const startTime = testTimer.now();
        const result = await testClient.getLatestHierarchy(false, 0);
        const duration = testTimer.now() - startTime;

        expect(result).not.toBeNull();
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Cached Data");
        expect(duration).toBeLessThan(500); // Should be fast since it's cached
      } finally {
        await testClient.close();
      }
    });

    test("should timeout when no data received within timeout period", async function() {
      // Use FakeWebSocket that connects successfully but sends no data
      // Use delayed mode with 1ms for fast execution

      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer
      );

      try {
        // Use a short timeout (50ms) to make test run fast
        const result = await testClient.getLatestHierarchy(true, 50);

        expect(result).not.toBeNull();
        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("should return fresh data when WebSocket push arrives after 100ms under contention (regression #2285)", async function() {
      // Pre-bug: default timeout was 100ms. When ADB pipe is busy (concurrent
      // screenshots, dumpsys, etc.), the WebSocket push routinely lands after
      // 100ms and getLatestHierarchy fell back to stale cache (~31% stale rate
      // in CI). Default is now 1000ms, matching the cache freshness TTL.
      const testTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        // Call without specifying a timeout so we exercise the default.
        const resultPromise = testClient.getLatestHierarchy(true);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // Simulate contended push delivery: advance 300ms of virtual time
        // before the push arrives. Past the old 100ms default — with the old
        // code the polling loop would already have cleared the interval and
        // resolved null, returning stale cache (here: no cache → null).
        await testTimer.advanceTimersByTimeAsync(300);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Contended push" }
          }
        }));

        const result = await testTimer.resolvePromise(resultPromise);

        expect(result.fresh).toBe(true);
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Contended push");
      } finally {
        await testClient.close();
      }
    });

    test("tracks concurrent suppressed hierarchy syncs independently", async function() {
      const testTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );
      const suppressionCount = (): number =>
        (testClient as unknown as {
          hierarchyObservationStreamSuppressions: Set<unknown>;
        }).hierarchyObservationStreamSuppressions.size;

      try {
        const firstRequest = testClient.requestHierarchySyncWithoutObservationStreamPush(
          undefined,
          false,
          undefined,
          3000
        );
        const secondRequest = testClient.requestHierarchySyncWithoutObservationStreamPush(
          undefined,
          false,
          undefined,
          3000
        );

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 2);

        expect(suppressionCount()).toBe(2);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: 100,
            packageName: "com.example",
            hierarchy: { text: "First sync" },
          },
        }));

        expect(suppressionCount()).toBe(1);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: 200,
            packageName: "com.example",
            hierarchy: { text: "Second sync" },
          },
        }));

        expect(suppressionCount()).toBe(0);

        const [firstResult, secondResult] = await Promise.all([
          testTimer.resolvePromise(firstRequest),
          testTimer.resolvePromise(secondRequest),
        ]);
        expect(firstResult?.hierarchy).not.toBeNull();
        expect(secondResult?.hierarchy).not.toBeNull();
      } finally {
        await testClient.close();
      }
    });

    test("should handle WebSocket connection failure gracefully", async function() {
      // Use FakeWebSocket with instant failure and FakeTimer for fast, reliable test execution
      // See issues #68 (timeout race condition) and #72 (cache contamination)

      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer
      );

      try {
        const result = await testClient.getLatestHierarchy(true, 1000);

        expect(result).not.toBeNull();
        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("should seed navigation graph from hierarchy updates", async function() {
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const navManager = navHarness.manager;

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.google.android.deskclock",
            hierarchy: {
              "text": "6:43 AM",
              "content-desc": "6:43 AM",
              "resource-id": "com.google.android.deskclock:id/digital_clock",
            }
          }
        }));

        await resultPromise;
        // HierarchyNavigationDetector debounces via setTimeout(100ms); in autoAdvance
        // mode the FakeTimer dispatches that via setImmediate, not as a microtask.
        // Drain setImmediate so the debounce callback runs, then drain microtasks so
        // the async setCurrentApp call inside recordHierarchyNavigation reaches its
        // first synchronous assignment (this.currentAppId = appId).
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        // With named-nodes-only feature, hierarchy updates alone don't create screens
        // They only update screens when there's an active SDK navigation event
        // or when the fingerprint is already correlated to a named node.
        // The app ID is still set from the package name.
        expect(navManager.getCurrentAppId()).toBe("com.google.android.deskclock");
        // Without SDK events (named nodes), currentScreen remains null
        expect(navManager.getCurrentScreen()).toBeNull();
      } finally {
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("should preserve SDK screen names when hierarchy updates follow navigation events", async function() {
      const { navHarness, navManager, resultPromise, testClient, testTimer } =
        await startSdkNavigationHierarchyInterleaving();

      try {
        await resultPromise;
        await settleNavigationHierarchyInterleaving(testTimer);

        expect(navManager.getCurrentScreen()).toBe("SdkHome");
      } finally {
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("skips the hierarchy-navigation detector for an SDK app after a navigation_event (#3068)", async function() {
      // Pins the sdkNavigationAppIds skip MECHANISM (layer 1), independent of the
      // NavigationGraphManager early-return (layer 2) that also protects the SDK
      // screen name. A navigation_event registers the app in sdkNavigationAppIds;
      // shouldUseHierarchyNavigation then returns false, so handleHierarchyUpdate
      // must NOT feed the following hierarchy_update to the detector. Spying on the
      // public detector's onHierarchyUpdate (rather than a private field) keeps the
      // test off internal state while still catching a regression of the skip.
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      // Eagerly construct the detector via the public getter so the spy is in
      // place before any hierarchy_update arrives.
      const detector = testClient.getHierarchyNavigationDetector();
      const onHierarchyUpdateSpy = spyOn(detector, "onHierarchyUpdate");

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "navigation_event",
          event: {
            destination: "SdkHome",
            source: "SdkStart",
            arguments: {},
            metadata: {},
            timestamp: testTimer.now(),
            sequenceNumber: 1,
            applicationId: "com.example.sdk",
          }
        }));

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.sdk",
            hierarchy: {
              "text": "SDK Home",
              "resource-id": "com.example.sdk:id/home",
            }
          }
        }));

        await resultPromise;
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        // The SDK app was registered by the navigation_event, so the following
        // hierarchy_update must be routed AROUND the detector.
        expect(onHierarchyUpdateSpy).not.toHaveBeenCalled();
      } finally {
        onHierarchyUpdateSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("feeds the hierarchy-navigation detector for a non-SDK app hierarchy_update (#3068)", async function() {
      // Negative control for the skip above: without a navigation_event the app is
      // NOT in sdkNavigationAppIds, so shouldUseHierarchyNavigation returns true and
      // the detector IS invoked. This proves the assertion above discriminates the
      // skip rather than always passing.
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      const detector = testClient.getHierarchyNavigationDetector();
      const onHierarchyUpdateSpy = spyOn(detector, "onHierarchyUpdate");

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.noneofthesdk",
            hierarchy: {
              "text": "Regular Home",
              "resource-id": "com.example.noneofthesdk:id/home",
            }
          }
        }));

        await resultPromise;
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        expect(onHierarchyUpdateSpy).toHaveBeenCalledTimes(1);
      } finally {
        onHierarchyUpdateSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("resolves build/device provenance on the hierarchy path for a non-SDK app (#4984)", async function() {
      // Apps without the AutoMobile SDK never emit navigation_event, so the hierarchy
      // path must kick off build-context resolution — otherwise every reach records
      // under the default/legacy build. Asserting requestPackageInfo is consulted
      // proves ensureBuildContext ran on this path.
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, testTimer);
      const pkgInfoSpy = spyOn(testClient, "requestPackageInfo").mockResolvedValue({ success: true, versionCode: 42 } as never);

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.nosdk",
            hierarchy: { "text": "Home", "resource-id": "com.example.nosdk:id/home" },
          }
        }));

        await resultPromise;
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        expect(pkgInfoSpy).toHaveBeenCalled();
        expect(pkgInfoSpy.mock.calls[0][0]).toBe("com.example.nosdk");
        // Content hashing runs on the INJECTED fake adb, never a real subprocess.
        expect(fakeAdb.wasCommandExecuted("pm path")).toBe(true);
      } finally {
        pkgInfoSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("does not apply a build context built from a failed package-info result (#4984)", async function() {
      // A transient package-info failure must NOT be persisted as version 0 — defer
      // instead, so a later event retries. setBuildContext must not be called.
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const setCtxSpy = spyOn(navHarness.manager, "setBuildContext");

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, testTimer);
      const pkgInfoSpy = spyOn(testClient, "requestPackageInfo").mockResolvedValue({ success: false } as never);

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.nosdk",
            hierarchy: { "text": "Home", "resource-id": "com.example.nosdk:id/home" },
          }
        }));

        await resultPromise;
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        expect(pkgInfoSpy).toHaveBeenCalled();
        // Failed metadata → deferred → no (bogus version-0) context applied.
        expect(setCtxSpy).not.toHaveBeenCalled();
      } finally {
        pkgInfoSpy.mockRestore();
        setCtxSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("releaseSessionBinding clears the binding and cached detector for the released session (#4984)", async function() {
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, testTimer);

      try {
        testClient.bindSession("session-A");
        expect(testClient.getBoundSessionId()).toBe("session-A");
        const detectorBoundToA = testClient.getHierarchyNavigationDetector();

        testClient.releaseSessionBinding("session-A");

        // Binding cleared and the cached detector dropped (recreated on next access),
        // so post-release events route to the unattributed global manager, not A's.
        expect(testClient.getBoundSessionId()).toBeNull();
        expect(testClient.getHierarchyNavigationDetector()).not.toBe(detectorBoundToA);

        // A non-matching release is a no-op once a new session has bound.
        testClient.bindSession("session-B");
        testClient.releaseSessionBinding("session-A");
        expect(testClient.getBoundSessionId()).toBe("session-B");
      } finally {
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("build-context resolution is deferred out-of-band, not run inline with the message handler (#2885/#4984)", async function() {
      // Regression guard for the macOS/Windows-CI-only #2885 failure: ensureBuildContext
      // must NOT call requestPackageInfo (a WS send + RequestManager timeout timer)
      // synchronously inside the WS message handler, or it reorders the barrier-tracked
      // nav write vs the socket-close cache invalidation on differently-scheduled runners.
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, testTimer);
      const pkgInfoSpy = spyOn(testClient, "requestPackageInfo").mockResolvedValue({ success: false } as never);

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "navigation_event",
          event: {
            destination: "Home", source: "Start", arguments: {}, metadata: {},
            timestamp: testTimer.now(), sequenceNumber: 1, applicationId: "com.example.app",
          }
        }));

        // Drain MICROTASKS only (never setImmediate): the deferred resolution is
        // dispatched on a macrotask, so if it ran inline requestPackageInfo would
        // already have fired here. It must not have.
        for (let i = 0; i < 5; i++) { await Promise.resolve(); }
        expect(pkgInfoSpy).not.toHaveBeenCalled();

        // Let getLatestHierarchy resolve, then allow macrotasks: the deferred
        // resolution now runs and consults requestPackageInfo out-of-band.
        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: { updatedAt: testTimer.now(), packageName: "com.example.app", hierarchy: { "text": "Home" } }
        }));
        await resultPromise;
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }
        expect(pkgInfoSpy).toHaveBeenCalled();
      } finally {
        pkgInfoSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("serializes navigation graph writes when WebSocket frames arrive back-to-back", async function() {
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, testTimer);
      let allowFirstWrite: (() => void) | undefined;
      const firstWriteAllowed = new Promise<void>(resolve => {
        allowFirstWrite = resolve;
      });
      const recordNavigationEvent = navHarness.manager.recordNavigationEvent.bind(navHarness.manager);
      const recordNavigationEventSpy = spyOn(navHarness.manager, "recordNavigationEvent")
        .mockImplementation(async event => {
          if (event.destination === "First") {
            await firstWriteAllowed;
          }
          await recordNavigationEvent(event);
        });

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "navigation_event",
          event: {
            destination: "First", source: "Start", arguments: {}, metadata: {},
            timestamp: testTimer.now(), sequenceNumber: 1, applicationId: "com.example.app",
          }
        }));
        socket!.simulateMessage(JSON.stringify({
          type: "navigation_event",
          event: {
            destination: "Second", source: "First", arguments: {}, metadata: {},
            timestamp: testTimer.now(), sequenceNumber: 2, applicationId: "com.example.app",
          }
        }));

        await flushPromises();
        expect(recordNavigationEventSpy).toHaveBeenCalledTimes(1);

        allowFirstWrite!();
        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: { updatedAt: testTimer.now(), packageName: "com.example.app", hierarchy: { "text": "Second" } }
        }));
        await resultPromise;
        await settleNavigationHierarchyInterleaving(testTimer);

        expect(recordNavigationEventSpy).toHaveBeenCalledTimes(2);
      } finally {
        recordNavigationEventSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("clears resolved build contexts on connection close so the next event re-resolves (#4984)", async function() {
      // While the WS has no client, a package_event has zero listeners, so an app can be
      // replaced unobserved. onConnectionClosed must invalidate cached contexts so the
      // next event after reconnect re-resolves the hash instead of using the stale build.
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, testTimer);
      const DIGEST = "a".repeat(64);
      fakeAdb.setCommandResponse("pm path", { stdout: "package:/a/base.apk", stderr: "" });
      fakeAdb.setCommandResponse("sha256sum", { stdout: `${DIGEST}  /a/base.apk`, stderr: "" });
      const pkgSpy = spyOn(testClient, "requestPackageInfo").mockResolvedValue({ success: true, versionCode: 5 } as never);
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 10; i++) { await new Promise<void>(r => setImmediate(r)); await testTimer.advanceTimersByTimeAsync(1); }
      };
      const navEvent = (dest: string): void => socket!.simulateMessage(JSON.stringify({
        type: "navigation_event",
        event: { destination: dest, source: "s", arguments: {}, metadata: {}, timestamp: testTimer.now(), sequenceNumber: 1, applicationId: "com.example.app" }
      }));
      let socket: Awaited<ReturnType<typeof waitForSocket>>;

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        navEvent("Home");
        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update", timestamp: testTimer.now(),
          data: { updatedAt: testTimer.now(), packageName: "com.example.app", hierarchy: { "text": "Home" } }
        }));
        await resultPromise;
        await settle();
        expect(pkgSpy).toHaveBeenCalledTimes(1); // resolved once

        navEvent("Details");
        await settle();
        expect(pkgSpy).toHaveBeenCalledTimes(1); // cached — no re-resolution

        // Connection drops (app may be replaced unobserved), then a later event arrives.
        (testClient as unknown as { onConnectionClosed: () => void }).onConnectionClosed();

        navEvent("Home2");
        await settle();
        expect(pkgSpy).toHaveBeenCalledTimes(2); // re-resolved after close
      } finally {
        pkgSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
      }
    });

    test("routes the navigation-graph write through the DB-write barrier for shutdown drain (#2885)", async function() {
      resetDbWriteBarrier();
      // The Android handler resolves getDbWriteBarrier() per write (#2912), so a
      // spy on the freshly-reset shared barrier observes the nav write's
      // registration. trackExisting (not track) proves the write is drain-covered
      // while #3506's unit guard proves its await continuation stays ahead of the
      // concurrent hierarchy path.
      const barrier = getDbWriteBarrier();
      const trackExistingSpy = spyOn(barrier, "trackExisting");
      const { navHarness, navManager, resultPromise, testClient, testTimer } =
        await startSdkNavigationHierarchyInterleaving();

      try {
        await resultPromise;
        await settleNavigationHierarchyInterleaving(testTimer);

        // The navigation write and the CtrlProxy-close cache invalidation both
        // register with the shared shutdown barrier.
        expect(trackExistingSpy).toHaveBeenCalledTimes(2);
        // Ordering still preserved: the write committed the SDK screen name.
        expect(navManager.getCurrentScreen()).toBe("SdkHome");
      } finally {
        trackExistingSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
        resetDbWriteBarrier();
      }
    });
  });

  describe("convertToViewHierarchyResult", function() {
    test("preserves Android snapshot truncation reasons", function() {
      const result = accessibilityServiceClient.convertToViewHierarchyResult({
        updatedAt: 1,
        packageName: "com.example",
        hierarchy: { text: "root" },
        truncationReasons: ["max_nodes", "cancelled"]
      });

      expect(result.truncationReasons).toEqual(["max_nodes", "cancelled"]);
    });

    test("should convert accessibility hierarchy to ViewHierarchyResult format", function() {
      const accessibilityHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.google.android.deskclock",
        intentChooserDetected: true,
        notificationPermissionDetected: true,
        contentHiddenRegions: [
          {
            bounds: { left: 0, top: 368, right: 1440, bottom: 2752 },
            reason: "compose-interop-no-hide-descendants",
            areaPercent: 79
          }
        ],
        hierarchy: {
          "text": "6:43 AM",
          "content-desc": "6:43 AM",
          "resource-id": "com.google.android.deskclock:id/digital_clock",
          "className": "android.widget.TextClock",
          "occlusionState": "partial",
          "occludedBy": "Debug menu",
          "occludedByViewId": "stable-debug-menu",
          "bounds": {
            left: 175,
            top: 687,
            right: 692,
            bottom: 973
          },
          "clickable": "false",
          "enabled": "true",
          "node": [
            {
              text: "Child Node",
              className: "android.widget.TextView",
              bounds: {
                left: 0,
                top: 0,
                right: 100,
                bottom: 50
              },
              clickable: "true"
            }
          ]
        }
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(accessibilityHierarchy);

      expect(result.hierarchy.text).toBe("6:43 AM");
      expect(result.hierarchy["content-desc"]).toBe("6:43 AM");
      expect(result.hierarchy.class).toBe("android.widget.TextClock");
      expect(result.hierarchy.className).toBe("android.widget.TextClock");
      expect(result.hierarchy.bounds).toEqual({
        left: 175,
        top: 687,
        right: 692,
        bottom: 973
      });
      expect(result.hierarchy.clickable).toBeUndefined();
      expect(result.hierarchy.enabled).toBe("true");
      expect(result.hierarchy.occlusionState).toBe("partial");
      expect(result.hierarchy.occludedBy).toBe("Debug menu");
      expect(result.hierarchy.occludedByViewId).toBe("stable-debug-menu");
      expect(result.intentChooserDetected).toBe(true);
      expect(result.notificationPermissionDetected).toBe(true);
      expect(result.contentHiddenRegions).toEqual([
        {
          bounds: { left: 0, top: 368, right: 1440, bottom: 2752 },
          reason: "compose-interop-no-hide-descendants",
          areaPercent: 79
        }
      ]);

      // Check child node conversion
      expect(typeof result.hierarchy.node).toBe("object");
      expect(result.hierarchy.node.text).toBe("Child Node");
      expect(result.hierarchy.node.class).toBe("android.widget.TextView");
      expect(result.hierarchy.node.className).toBe("android.widget.TextView");
      expect(result.hierarchy.node.bounds).toEqual({
        left: 0,
        top: 0,
        right: 100,
        bottom: 50
      });
      expect(result.hierarchy.node.clickable).toBe("true");
    });

    test("should handle single child node correctly", function() {
      const accessibilityHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: {
          text: "Parent",
          node: [
            {
              text: "Single Child",
              clickable: "true"
            }
          ]
        }
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(accessibilityHierarchy);

      expect(typeof result.hierarchy.node).toBe("object"); // Single child should not be in array
      expect(result.hierarchy.node.text).toBe("Single Child");
      expect(result.hierarchy.node.clickable).toBe("true");
    });

    test("retains the additive #4548 scale metadata reported by the runner", function() {
      const result = accessibilityServiceClient.convertToViewHierarchyResult({
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: { text: "root" },
        screenWidth: 1080,
        screenHeight: 2340,
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      } as any);

      expect(result.nativeScale).toBe(1);
      expect(result.pixelWidth).toBe(1080);
      expect(result.pixelHeight).toBe(2340);
    });

    test("omits the scale metadata keys for legacy payloads and for the runner's JSON nulls", function() {
      const base = {
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: { text: "root" },
        screenWidth: 1080,
        screenHeight: 2340,
      };

      // Pre-#4548 runner: fields absent entirely — the result shape must be byte-identical,
      // so the keys are ABSENT, not present-with-undefined.
      const legacy = accessibilityServiceClient.convertToViewHierarchyResult({ ...base } as any);
      expect("nativeScale" in legacy).toBe(false);
      expect("pixelWidth" in legacy).toBe(false);
      expect("pixelHeight" in legacy).toBe(false);

      // The runner serializes absent optionals as JSON null (encodeDefaults=true) when screen
      // dimensions are unavailable: nulls must be normalized away, never retained.
      const nulls = accessibilityServiceClient.convertToViewHierarchyResult({
        ...base,
        nativeScale: null,
        pixelWidth: null,
        pixelHeight: null,
      } as any);
      expect("nativeScale" in nulls).toBe(false);
      expect("pixelWidth" in nulls).toBe(false);
      expect("pixelHeight" in nulls).toBe(false);
    });

    test("omits ALL scale fields when the metadata tuple is partial or degenerate (all-or-nothing, matches retention)", function() {
      const base = {
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: { text: "root" },
        screenWidth: 1080,
        screenHeight: 2340,
      };
      // Each of these has nativeScale present but the tuple is incomplete or degenerate. The
      // converter must match the retention validator: NO scale fields, not a leaked partial.
      const partials = [
        { nativeScale: 1 }, // pixelWidth/pixelHeight missing
        { nativeScale: 1, pixelWidth: 1080 }, // pixelHeight missing
        { nativeScale: 0, pixelWidth: 1080, pixelHeight: 2340 },
        { nativeScale: -1, pixelWidth: 1080, pixelHeight: 2340 },
        { nativeScale: 1, pixelWidth: 0, pixelHeight: 2340 },
      ];
      for (const partial of partials) {
        const result = accessibilityServiceClient.convertToViewHierarchyResult({ ...base, ...partial } as any);
        expect("nativeScale" in result).toBe(false);
        expect("pixelWidth" in result).toBe(false);
        expect("pixelHeight" in result).toBe(false);
      }
    });

    test("carries scale metadata through the rootless (UIAutomator-fallback) early return", function() {
      // A ctrlProxyIncomplete payload with no hierarchy node takes the early return; #4549 must
      // still see the metadata off this route.
      const rootless = accessibilityServiceClient.convertToViewHierarchyResult({
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: undefined,
        ctrlProxyIncomplete: true,
        screenWidth: 1080,
        screenHeight: 2340,
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      } as any);

      expect(rootless.hierarchy.error).toBeDefined();
      expect(rootless.nativeScale).toBe(1);
      expect(rootless.pixelWidth).toBe(1080);
      expect(rootless.pixelHeight).toBe(2340);

      // And a rootless payload WITHOUT the fields still omits them (byte-identical legacy).
      const rootlessLegacy = accessibilityServiceClient.convertToViewHierarchyResult({
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: undefined,
        ctrlProxyIncomplete: true,
      } as any);
      expect("nativeScale" in rootlessLegacy).toBe(false);
      expect("pixelWidth" in rootlessLegacy).toBe(false);
      expect("pixelHeight" in rootlessLegacy).toBe(false);
    });

    test("should handle conversion errors gracefully", function() {
      // Create a hierarchy that will cause conversion issues
      const problematicHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: null as any
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(problematicHierarchy);

      expect(result.hierarchy.error).toContain("Accessibility hierarchy missing from accessibility service");
    });

    test("rewrites the runner's path-derived UUID view-ids into stable content ids at ingest (#3228)", function() {
      // The runner emits a positional UUID for id-less nodes; two captures of the
      // same row at different scroll offsets carry DIFFERENT UUIDs. Ingest must
      // rewrite them into content-derived ids so the row keeps one identity.
      const capture = (uuid: string, top: number) => ({
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: {
          "resource-id": "com.test.app:id/root",
          "view-id": "com.test.app:id/root",
          "node": [
            {
              "view-id": uuid,
              "content-desc": "Basic long press card",
              "bounds": { left: 42, top, right: 1038, bottom: top + 231 }
            }
          ]
        }
      });

      const before = accessibilityServiceClient.convertToViewHierarchyResult(
        capture("791e44df-05d9-5e5a-3ea7-c898eedcb939", 1404)
      );
      const after = accessibilityServiceClient.convertToViewHierarchyResult(
        capture("8eb00289-ddfa-18de-7fc7-480b4d13d8cf", 1079)
      );

      const beforeId = (before.hierarchy.node as any)["view-id"];
      const afterId = (after.hierarchy.node as any)["view-id"];
      expect(beforeId).toStartWith("s-");
      expect(afterId).toBe(beforeId);
      // Resource-id-backed view-ids pass through untouched.
      expect(before.hierarchy["view-id"]).toBe("com.test.app:id/root");
    });

    test("rewrites accessibility-focused mirror occlusion links against the emitted hierarchy ids", function() {
      const focusedUuid = "11111111-1111-4111-8111-111111111111";
      const occluderUuid = "22222222-2222-4222-8222-222222222222";
      const accessibilityHierarchy = {
        "updatedAt": 1750934583218,
        "packageName": "com.test.app",
        "hierarchy": {
          "resource-id": "com.test.app:id/root",
          "view-id": "com.test.app:id/root",
          "node": [
            {
              "view-id": focusedUuid,
              "text": "Covered",
              "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
              "occlusionState": "partial",
              "occludedBy": "unlabeled view",
              "occludedByViewId": occluderUuid,
            },
            {
              "view-id": occluderUuid,
              "bounds": { left: 0, top: 0, right: 50, bottom: 50 },
            },
          ],
        },
        "accessibility-focused-element": {
          "view-id": focusedUuid,
          "text": "Covered",
          "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
          "occlusionState": "partial",
          "occludedBy": "unlabeled view",
          "occludedByViewId": occluderUuid,
        },
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(accessibilityHierarchy);
      const hierarchyChildren = result.hierarchy.node as any[];
      const focusedNode = hierarchyChildren[0];
      const occluderNode = hierarchyChildren[1];
      const focusedMirror = result["accessibility-focused-element"] as any;

      expect(focusedNode.occludedByViewId).toBe(occluderNode["view-id"]);
      expect(focusedMirror["view-id"]).toBe(focusedNode["view-id"]);
      expect(focusedMirror.occludedByViewId).toBe(occluderNode["view-id"]);
      expect(focusedMirror.occludedByViewId).not.toBe(occluderUuid);
    });

  });

  describe("focus element conversion", function() {
    test("normalizes Android runner className while preserving the public compatibility alias", function() {
      const focus = new CtrlProxyFocus({} as any);

      const element = focus.convertAccessibilityNodeToElement({
        text: "Focused",
        className: "android.widget.Button",
        bounds: { left: 10, top: 20, right: 110, bottom: 70 },
      });

      expect(element?.class).toBe("android.widget.Button");
      expect(element?.className).toBe("android.widget.Button");
    });
  });

  describe("getAccessibilityHierarchy", function() {
    test("should return null when service is not available", async function() {

      // Configure service as not available
      fakeAdb.setCommandResponse("pm list packages", { stdout: "", stderr: "" });

      const result = await accessibilityServiceClient.getAccessibilityHierarchy();
      expect(result).toBeNull();
    });

    test("preserves a fresh delegate verdict instead of comparing the device timestamp to the host clock", async function() {
      const { factory, getSocket } = createCapturingWebSocketFactory(fakeTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer
      );
      const manager = AndroidCtrlProxyManager.getInstance(testDevice, fakeAdb);
      const availability = spyOn(manager, "isAvailable").mockResolvedValue(true);

      try {
        const resultPromise = testClient.getAccessibilityHierarchy();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: fakeTimer.now(),
          data: {
            // A real device may be behind the daemon host clock. The hierarchy
            // was verified by this WebSocket update, so its clock must not turn
            // the public result into a false stale observation.
            updatedAt: fakeTimer.now() - 60_000,
            packageName: "com.example.app",
            hierarchy: { text: "fresh from device" },
          },
        }));

        const result = await resultPromise;

        expect(result?.fresh).toBe(true);
      } finally {
        availability.mockRestore();
        await testClient.close();
      }
    });

    test("fresh-hierarchy wait fails fast — well under the timeout budget — when the screen is off", async function() {
      fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });

      // Screen off: the connection succeeds (so the fresh-data wait is actually entered), but no
      // hierarchy is ever pushed, so waitForFreshData can only exit via the periodic screen check
      // firing settleResolve(null) (CtrlProxyHierarchy.ts:737-740) or by burning the whole timeout.
      fakeAdb.setScreenState(false);

      // A manual (non-auto-advance) timer: waitForFreshData polls on a repeating setInterval, which
      // auto-advance models as a one-shot, so we drive virtual time explicitly and step past the
      // ~1s screen-check cadence ourselves.
      const manualTimer = new FakeTimer();
      const asleepClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(manualTimer),
        manualTimer
      );

      // A generous wait budget so the fast-fail signal is unmistakable: the screen-off exit lands
      // near the ~1s screen-check cadence, an order of magnitude below this ceiling. Asserting the
      // VIRTUAL time at resolution proves the fast fail BY ASSERTION — deleting the screen-off
      // settleResolve(null) makes the wait run to the full budget and the toBeLessThan below FAILS,
      // rather than the old test which only "passed" by never fast-failing and hanging to bun's real
      // timeout. waitForFresh=true with no pushed hierarchy forces the wait; a fresh client has no
      // recent-timeout cooldown, so shouldSkipWebSocketWait() does not short-circuit it.
      const budgetMs = 8000;
      try {
        let response: { hierarchy: unknown; fresh: boolean } | undefined;
        void asleepClient.getLatestHierarchy(true, budgetMs).then(r => { response = r; });

        // Let ensureConnected + the interval registration settle before advancing time.
        await flushPromises();

        for (let stepped = 0; stepped <= budgetMs + 500 && response === undefined; stepped += 250) {
          await manualTimer.advanceTimersByTimeAsync(250);
          await flushPromises();
        }
        const resolvedAtMs = manualTimer.now();

        expect(response).toBeDefined();
        expect(response!.hierarchy).toBeNull();
        expect(response!.fresh).toBe(false);
        expect(resolvedAtMs).toBeLessThan(budgetMs / 2);
      } finally {
        await asleepClient.close();
      }
    });
  });

  describe("package events", function() {
    test("should upsert package on added event", async function() {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const timestamp = timer.now();

      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        repo
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "package_event",
          timestamp,
          event: {
            action: "added",
            packageName: "com.example.new",
            userId: 0,
            isSystem: false
          }
        }));

        await flushPromises();

        const rows = await repo.listInstalledApps(testDevice.deviceId);
        expect(rows).toHaveLength(1);
        expect(rows[0].package_name).toBe("com.example.new");
        expect(rows[0].user_id).toBe(0);
        expect(rows[0].is_system).toBe(0);
        expect(rows[0].last_verified_at).toBe(timestamp);
      } finally {
        await testClient.close();
      }
    });

    test("should remove package for a single user on removed event", async function() {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const baseTime = timer.now();

      await repo.replaceInstalledApps(testDevice.deviceId, [
        {
          device_id: testDevice.deviceId,
          user_id: 0,
          package_name: "com.example.remove",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        },
        {
          device_id: testDevice.deviceId,
          user_id: 10,
          package_name: "com.example.remove",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        }
      ]);

      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        repo
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "package_event",
          timestamp: timer.now(),
          event: {
            action: "removed",
            packageName: "com.example.remove",
            userId: 0
          }
        }));

        await flushPromises();

        const rows = await repo.listInstalledApps(testDevice.deviceId);
        expect(rows.some(row => row.user_id === 0)).toBe(false);
        expect(rows.some(row => row.user_id === 10)).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("should remove package for all users when removedForAllUsers is true", async function() {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const baseTime = timer.now();

      await repo.replaceInstalledApps(testDevice.deviceId, [
        {
          device_id: testDevice.deviceId,
          user_id: 0,
          package_name: "com.example.all",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        },
        {
          device_id: testDevice.deviceId,
          user_id: 10,
          package_name: "com.example.all",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        }
      ]);

      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        repo
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "package_event",
          timestamp: timer.now(),
          event: {
            action: "removed",
            packageName: "com.example.all",
            userId: 0,
            removedForAllUsers: true
          }
        }));

        await flushPromises();

        const rows = await repo.listInstalledApps(testDevice.deviceId);
        expect(rows).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("highlight requests", function() {
    test("requestAddHighlight sends payload and resolves highlight response", async function() {
      const highlightTimer = new FakeTimer();
      // Don't use autoAdvance - we need to control time for the request timeout

      const { factory, getSocket } = createCapturingWebSocketFactory(highlightTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        highlightTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: {
          x: 10,
          y: 20,
          width: 100,
          height: 80
        },
        style: {
          strokeColor: "#FF0000",
          strokeWidth: 4
        }
      };

      try {
        // Start the request (don't await yet)
        const requestPromise = testClient.requestAddHighlight("highlight-1", shape, 2000);

        // Wait for socket to be created and open
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 2); // sync message + highlight request

        // Find the highlight request among sent messages (sync messages may precede it)
        const highlightMsg = socket!.sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);
        expect(payload.id).toBe("highlight-1");
        expect(payload.shape.bounds.width).toBe(100);

        // Simulate the response from the server
        socket!.simulateMessage(JSON.stringify({
          type: "highlight_response",
          requestId: payload.requestId,
          success: true,
          error: null
        }));

        // Advance time to process the response
        const result = await highlightTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

  });

  describe("error frame handling (issue #2985)", function() {
    test("a type:error frame correlated by requestId fails the awaiting request fast", async function() {
      // The Android runner now emits a structured `type:"error"` envelope on decode/handler
      // failures (issue #2985). Without a consumer branch the awaiter would hang to timeout; this
      // asserts the pending request resolves immediately with a failed result carrying the message.
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        style: { strokeColor: "#FF0000", strokeWidth: 4 }
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-err", shape, 2000);

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket as CapturingWebSocket, 2);

        const highlightMsg = (socket as CapturingWebSocket).sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);

        // Runner reports a structured error correlated by the request's id.
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: payload.requestId,
          success: false,
          error: "Malformed request: a numeric value is out of range or not representable.",
          timestamp: errorTimer.now()
        }));

        const result = await errorTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(false);
        expect(result.error).toContain("out of range");
      } finally {
        await testClient.close();
      }
    });

    test("unknown command errors are rewritten with Android runner upgrade guidance", async function() {
      const errorTimer = new FakeTimer();

      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        style: { strokeColor: "#FF0000", strokeWidth: 4 }
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-stale-runner", shape, 2000);

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket as CapturingWebSocket, 2);

        const highlightMsg = (socket as CapturingWebSocket).sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);

        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: payload.requestId,
          success: false,
          error: "Unknown command type: add_highlight",
          timestamp: errorTimer.now()
        }));

        const result = await errorTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(false);
        expect(result.error).toContain("add_highlight");
        expect(result.error).toContain("Android CtrlProxy APK");
        expect(result.error).toContain("older than this daemon");
        expect(result.error).toContain("AUTOMOBILE_CTRL_PROXY_APK_PATH");
        expect(result.error).not.toContain("AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED");
        expect(result.error).not.toContain("iOS CtrlProxy runner");
      } finally {
        await testClient.close();
      }
    });

    test("a type:error frame with a non-matching requestId does not disturb other requests", async function() {
      // A null/unknown requestId (e.g. an unparseable payload the runner couldn't correlate) must
      // be a safe no-op: it must not crash, and must not wrongly resolve an unrelated pending
      // request. Here an in-flight highlight request must survive a mismatched error frame and
      // still resolve normally from its own response.
      const errorTimer = new FakeTimer();

      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        style: { strokeColor: "#FF0000", strokeWidth: 4 }
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-keep", shape, 2000);

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket as CapturingWebSocket, 2);

        const highlightMsg = (socket as CapturingWebSocket).sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        const payload = JSON.parse(highlightMsg!);

        // Error frame for an unrelated / uncorrelated request — must be ignored.
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-other-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real response for our request still arrives and resolves it.
        socket!.simulateMessage(JSON.stringify({
          type: "highlight_response",
          requestId: payload.requestId,
          success: true,
          error: null
        }));

        const result = await errorTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("hierarchy error frame correlation (issue #3032)", function() {
    // request_hierarchy does NOT await through RequestManager — it blocks in
    // CtrlProxyHierarchy.waitForFreshData for a hierarchy_update push. Before #3032 a runner
    // type:"error" frame for a hierarchy requestId no-op'd in resolveError and the caller hung to
    // the waitForFreshData timeout. These tests assert the error frame now unblocks the hierarchy
    // wait fast, while remaining a safe no-op for uncorrelated ids.

    const findSentMessageOfType = (socket: CapturingWebSocket, type: string): any | undefined => {
      const raw = socket.sentMessages.find(m => {
        try { return JSON.parse(m).type === type; } catch { return false; }
      });
      return raw ? JSON.parse(raw) : undefined;
    };

    test("a type:error frame for an in-flight hierarchy requestId fails requestHierarchySync fast", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        // 10s hierarchy sync timeout — the whole point is to NOT wait for it.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();
        expect(hierarchyMsg.requestId).toBeDefined();

        // Runner reports a structured handler failure correlated to the hierarchy requestId.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: hierarchyMsg.requestId,
          success: false,
          error: "request_hierarchy handler failed: view hierarchy extraction threw",
          timestamp: errorTimer.now()
        }));

        // Fail fast: no timer advance toward the 10s timeout. Only flush microtasks/setImmediate.
        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        // Prove we did not sit through the timeout: virtually no fake time elapsed.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a type:error frame with an unknown requestId does not disturb an in-flight hierarchy sync", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();

        // Error frame for an uncorrelated id — must be a safe no-op for the hierarchy wait.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real hierarchy push for our request still arrives and resolves the sync normally.
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated error");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("hierarchy stale-nudge error frame correlation (issue #3061)", function() {
    // Sibling of #3032 for the request_hierarchy_if_stale nudge. That nudge is minted with a
    // `stale_` requestId from INSIDE waitForFreshData's interval callback (the "no push after 2s"
    // path). Before #3061 that id was never registered in pendingHierarchyRejectors, so a runner
    // type:"error" frame for the stale id no-op'd and the wait hung to timeout. These tests assert
    // the stale error frame now unblocks the enclosing hierarchy wait fast, while an uncorrelated
    // id during the stale window remains a safe no-op.

    const findSentMessageOfType = (socket: CapturingWebSocket, type: string): any | undefined => {
      const raw = socket.sentMessages.find(m => {
        try { return JSON.parse(m).type === type; } catch { return false; }
      });
      return raw ? JSON.parse(raw) : undefined;
    };

    // Drive the wait past the 2s stale-check window until the request_hierarchy_if_stale nudge is
    // actually sent. The nudge fires from inside waitForFreshData's interval callback, so it depends
    // on that interval being registered — which happens a few microtask turns after the sync's
    // request_hierarchy send. Rather than assume a fixed number of flushes (a microtask-ordering
    // flake vector), retry advancing time until the nudge appears. Total advance stays well under
    // the 10s sync timeout so a later "no timeout occurred" assertion remains valid.
    const driveUntilStaleNudge = async (socket: CapturingWebSocket, timer: FakeTimer): Promise<any> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await flushPromises();
        timer.advanceTime(2100);
        await flushPromises();
        const staleMsg = findSentMessageOfType(socket, "request_hierarchy_if_stale");
        if (staleMsg) {
          return staleMsg;
        }
      }
      return undefined;
    };

    test("a type:error frame for an in-flight request_hierarchy_if_stale nudge fails the sync fast", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        // 10s hierarchy sync timeout — the whole point is to NOT wait for it.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();

        // Drive the wait past the 2s stale-check window so the request_hierarchy_if_stale nudge is
        // sent from inside the interval callback (total advance < the 10s timeout).
        const staleMsg = await driveUntilStaleNudge(socket, errorTimer);
        expect(staleMsg).toBeDefined();
        expect(staleMsg.requestId).toBeDefined();
        expect(String(staleMsg.requestId).startsWith("stale_")).toBe(true);

        // Runner reports a structured handler failure correlated to the stale nudge's requestId.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: staleMsg.requestId,
          success: false,
          error: "request_hierarchy_if_stale handler failed: view hierarchy extraction threw",
          timestamp: errorTimer.now()
        }));

        // Fail fast: only flush microtasks/setImmediate, no advance toward the 10s timeout.
        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        // Prove we did not sit through the timeout: fake time stayed near the stale window.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a type:error frame with an unknown requestId does not disturb the stale-nudge wait", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        // Advance past the stale window so the stale nudge is minted and registered.
        const staleMsg = await driveUntilStaleNudge(socket, errorTimer);
        expect(staleMsg).toBeDefined();

        // Error frame for an uncorrelated id — must be a safe no-op for the stale-nudge wait.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real hierarchy push for our request still arrives and resolves the sync normally.
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated stale error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated stale error");
      } finally {
        await testClient.close();
      }
    });

    test("a stale-nudge error frame does NOT discard stale cache on the getLatestHierarchy path", async function() {
      // getLatestHierarchy (unlike requestHierarchySync) enters waitForFreshData with NO primary
      // requestId — its timeout is meant to gracefully fall through to the stale cache. The stale
      // nudge is therefore left uncorrelated there (gated on `requestId` in waitForFreshData). This
      // locks in that decision: an error frame for the stale id must be a safe no-op that preserves
      // the stale-cache return, NOT a rejection that propagates to null. Removing the `&& requestId`
      // gate would flip this assertion (the wait would reject and getLatestHierarchy would return
      // hierarchy:null).
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        // Prime the connection + cache via a sync that a push resolves quickly.
        const primePromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);
        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Stale cache preserved" }
          }
        }));
        await errorTimer.resolvePromise(primePromise);

        // Let time pass so the cached data is stale relative to the next wait's start; this forces
        // getLatestHierarchy(waitForFresh=true) into waitForFreshData and, on timeout, into the
        // stale-cache return path.
        errorTimer.advanceTime(500);

        const latestPromise = testClient.getLatestHierarchy(true, 3000);

        // Drive to the 2s stale window so the (uncorrelated) stale nudge is minted.
        await flushPromises();
        errorTimer.advanceTime(2100);
        await flushPromises();
        const staleMsg = findSentMessageOfType(socket, "request_hierarchy_if_stale");
        expect(staleMsg).toBeDefined();
        expect(String(staleMsg.requestId).startsWith("stale_")).toBe(true);

        // Error frame for the stale id — must be a safe no-op on this path.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: staleMsg.requestId,
          success: false,
          error: "request_hierarchy_if_stale handler failed: view hierarchy extraction threw",
          timestamp: errorTimer.now()
        }));

        // The wait falls through to its timeout and returns the STALE CACHE (not null).
        const result = await errorTimer.resolvePromise(latestPromise);
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Stale cache preserved");
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("runner error surfacing via diagnostics (issue #3062)", function() {
    // Follow-up to #3032 / #3061. Those made a correlated runner type:"error" frame fail the
    // hierarchy wait fast, but requestHierarchySync still collapsed the rejection to `null` —
    // indistinguishable from a plain timeout `null`. #3062 threads a per-call `diagnostics`
    // out-parameter so a caller can tell "runner reported a structured handler failure" (text
    // populated) apart from "the push never arrived" (timeout: null result, diagnostics untouched).

    const findSentMessageOfType = (socket: CapturingWebSocket, type: string): any | undefined => {
      const raw = socket.sentMessages.find(m => {
        try { return JSON.parse(m).type === type; } catch { return false; }
      });
      return raw ? JSON.parse(raw) : undefined;
    };

    const driveUntilStaleNudge = async (socket: CapturingWebSocket, timer: FakeTimer): Promise<any> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await flushPromises();
        timer.advanceTime(2100);
        await flushPromises();
        const staleMsg = findSentMessageOfType(socket, "request_hierarchy_if_stale");
        if (staleMsg) {
          return staleMsg;
        }
      }
      return undefined;
    };

    test("a correlated runner error populates diagnostics.runnerError while still returning null", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();
        expect(hierarchyMsg.requestId).toBeDefined();

        const runnerText = "request_hierarchy handler failed: view hierarchy extraction threw";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: hierarchyMsg.requestId,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        await flushPromises();
        const result = await syncPromise;

        // Contract unchanged: still null so existing callers keep working.
        expect(result).toBeNull();
        // But the runner text is now surfaced to the caller, distinct from a timeout.
        expect(diagnostics.runnerError).toBe(runnerText);
        // Fast-fail: no sitting through the 10s timeout.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a plain timeout leaves diagnostics.runnerError undefined (no misattribution)", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        // Short timeout; never deliver a push or an error frame -> genuine timeout.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 3000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).toBeNull();
        // Crucially: a timeout must NOT surface a runner error.
        expect(diagnostics.runnerError).toBeUndefined();
      } finally {
        await testClient.close();
      }
    });

    test("an uncorrelated error id leaves diagnostics.runnerError undefined and the push still resolves", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated error");
        expect(diagnostics.runnerError).toBeUndefined();
      } finally {
        await testClient.close();
      }
    });

    test("a correlated stale-nudge runner error also populates diagnostics.runnerError", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const staleMsg = await driveUntilStaleNudge(socket, errorTimer);
        expect(staleMsg).toBeDefined();
        expect(String(staleMsg.requestId).startsWith("stale_")).toBe(true);

        const runnerText = "request_hierarchy_if_stale handler failed: view hierarchy extraction threw";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: staleMsg.requestId,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        expect(diagnostics.runnerError).toBe(runnerText);
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("verifyServiceReady surfaces the runner error text in its terminal warn", async function() {
      // Consumption test: prove the diagnostics text actually reaches an observable, default-level
      // log line (not just the dropped per-attempt debug), attributing the deterministic handler
      // failure instead of an anonymous "no hierarchy". Spy on the module logger's warn.
      const errorTimer = new FakeTimer();
      const log = new FakeLogger();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        log
      );

      try {
        testClient.invalidateCache();
        // Single attempt so one correlated error frame drives it straight to the terminal warn.
        const verifyPromise = testClient.verifyServiceReady(1, 10, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();

        const runnerText = "request_hierarchy handler failed: view hierarchy extraction threw";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: hierarchyMsg.requestId,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        const ready = await errorTimer.resolvePromise(verifyPromise);

        expect(ready).toBe(false);
        const terminalWarn = log.at("warn").find(({ message }) => message.includes("Service not ready"));
        expect(terminalWarn?.message).toContain(runnerText);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("verifyServiceReady deterministic runner-error short-circuit (issue #3097)", function() {
    // Follow-up to #3062. That surfaced the runner's structured error text to verifyServiceReady
    // via diagnostics, but the method still retried to exhaustion even when every attempt failed
    // with the SAME deterministic runner handler error. #3097 short-circuits the retry loop once
    // byte-identical runner error text repeats on 2 consecutive attempts, while still granting one
    // retry after the FIRST error (bring-up failures can be transient) and resetting the streak
    // when a plain timeout intervenes (mixed signals are not evidence of determinism).

    const sentHierarchyRequests = (socket: CapturingWebSocket): any[] =>
      socket.sentMessages
        .map(m => {
          try { return JSON.parse(m); } catch { return null; }
        })
        .filter(m => m && m.type === "request_hierarchy");

    // Advance fake time in small steps (firing retry-delay sleeps and wait intervals) until the
    // Nth request_hierarchy frame has been sent — i.e. until the retry loop reaches attempt N.
    const advanceUntilHierarchyRequests = async (
      socket: CapturingWebSocket,
      timer: FakeTimer,
      minCount: number,
      stepMs: number = 250
    ): Promise<any[]> => {
      for (let i = 0; i < 40; i++) {
        const msgs = sentHierarchyRequests(socket);
        if (msgs.length >= minCount) {
          return msgs;
        }
        timer.advanceTime(stepMs);
        await flushPromises();
      }
      return sentHierarchyRequests(socket);
    };

    const simulateRunnerError = (
      socket: CapturingWebSocket,
      timer: FakeTimer,
      requestId: string,
      errorText: string
    ): void => {
      socket.simulateMessage(JSON.stringify({
        type: "error",
        requestId,
        success: false,
        error: errorText,
        timestamp: timer.now()
      }));
    };

    const createShortCircuitTestClient = (): {
      testClient: AndroidCtrlProxyClient;
      getSocket: () => CapturingWebSocket | null;
      timer: FakeTimer;
      log: FakeLogger;
    } => {
      const timer = new FakeTimer();
      const log = new FakeLogger();
      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        undefined,
        // Retry delays must run on the SAME fake timer so the test controls them.
        new DefaultRetryExecutor(timer),
        undefined,
        undefined,
        undefined,
        log
      );
      return { testClient, getSocket, timer, log };
    };

    test("identical runner error on 2 consecutive attempts short-circuits the remaining retries", async function() {
      const { testClient, getSocket, timer, log } = createShortCircuitTestClient();

      try {
        testClient.invalidateCache();
        const verifyPromise = testClient.verifyServiceReady(5, 500, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const runnerText = "request_hierarchy handler failed: view hierarchy extraction threw";

        // Attempt 1: correlated runner error.
        let msgs = await advanceUntilHierarchyRequests(socket, timer, 1);
        expect(msgs.length).toBe(1);
        simulateRunnerError(socket, timer, msgs[0].requestId, runnerText);
        await flushPromises();

        // Attempt 2: byte-identical runner error -> streak of 2 -> stop.
        msgs = await advanceUntilHierarchyRequests(socket, timer, 2);
        expect(msgs.length).toBe(2);
        simulateRunnerError(socket, timer, msgs[1].requestId, runnerText);

        const ready = await timer.resolvePromise(verifyPromise);

        expect(ready).toBe(false);
        // Short-circuited after 2 attempts: attempts 3-5 never sent a request.
        expect(sentHierarchyRequests(socket).length).toBe(2);
        const terminalWarn = log.at("warn").find(({ message }) => message.includes("Service not ready"));
        expect(terminalWarn?.message).toContain("short-circuited");
        expect(terminalWarn?.message).toContain("2/5 verification attempts");
        expect(terminalWarn?.message).toContain(runnerText);
      } finally {
        await testClient.close();
      }
    });

    test("a transient runner error on the first attempt still recovers on the retry", async function() {
      // The regression guard for the startup path this method exists to verify: ONE handler
      // error during bring-up must not conclude "deterministic" — the retry still runs and a
      // successful push flips the verification to ready.
      const { testClient, getSocket, timer, log } = createShortCircuitTestClient();

      try {
        testClient.invalidateCache();
        const verifyPromise = testClient.verifyServiceReady(5, 500, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // Attempt 1: correlated runner error (transient bring-up failure).
        let msgs = await advanceUntilHierarchyRequests(socket, timer, 1);
        expect(msgs.length).toBe(1);
        simulateRunnerError(socket, timer, msgs[0].requestId, "request_hierarchy handler failed: service still starting");
        await flushPromises();

        // Attempt 2: the service came up; deliver a fresh hierarchy push.
        msgs = await advanceUntilHierarchyRequests(socket, timer, 2);
        expect(msgs.length).toBe(2);
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: timer.now(),
          data: {
            updatedAt: timer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Service recovered" }
          }
        }));

        const ready = await timer.resolvePromise(verifyPromise);

        expect(ready).toBe(true);
        expect(log.at("warn").find(({ message }) => message.includes("Service not ready"))).toBeUndefined();
      } finally {
        await testClient.close();
      }
    });

    test("differing runner error texts never short-circuit (full retry budget)", async function() {
      const { testClient, getSocket, timer, log } = createShortCircuitTestClient();

      try {
        testClient.invalidateCache();
        const verifyPromise = testClient.verifyServiceReady(3, 500, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        for (let attempt = 1; attempt <= 3; attempt++) {
          const msgs = await advanceUntilHierarchyRequests(socket, timer, attempt);
          expect(msgs.length).toBe(attempt);
          simulateRunnerError(socket, timer, msgs[attempt - 1].requestId, `handler failed: distinct cause ${attempt}`);
          await flushPromises();
        }

        const ready = await timer.resolvePromise(verifyPromise);

        expect(ready).toBe(false);
        // All 3 attempts ran: varying error text is not treated as deterministic.
        expect(sentHierarchyRequests(socket).length).toBe(3);
        const terminalWarn = log.at("warn").find(({ message }) => message.includes("Service not ready"));
        expect(terminalWarn?.message).not.toContain("short-circuited");
        expect(terminalWarn?.message).toContain("after 3 verification attempts");
        expect(terminalWarn?.message).toContain("distinct cause 3");
      } finally {
        await testClient.close();
      }
    });

    test("a plain timeout between identical runner errors resets the streak", async function() {
      // error X -> timeout -> error X -> error X with maxAttempts=5: the timeout on attempt 2
      // breaks the streak, so the short-circuit lands after attempt 4 (streak rebuilt on 3+4),
      // not after attempt 3 (which a no-reset implementation would produce).
      const { testClient, getSocket, timer, log } = createShortCircuitTestClient();

      try {
        testClient.invalidateCache();
        // timeoutMs=1000 keeps the timed-out attempt below the 2000ms stale-nudge threshold.
        const verifyPromise = testClient.verifyServiceReady(5, 500, 1000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const runnerText = "request_hierarchy handler failed: view hierarchy extraction threw";

        // Attempt 1: runner error X.
        let msgs = await advanceUntilHierarchyRequests(socket, timer, 1);
        expect(msgs.length).toBe(1);
        simulateRunnerError(socket, timer, msgs[0].requestId, runnerText);
        await flushPromises();

        // Attempt 2: never answered -> plain timeout (advanceUntil... drives past the 1000ms
        // window while waiting for attempt 3's request). Streak resets.
        // Attempts 3 and 4: runner error X again -> streak rebuilt to 2 -> stop before attempt 5.
        msgs = await advanceUntilHierarchyRequests(socket, timer, 3);
        expect(msgs.length).toBe(3);
        simulateRunnerError(socket, timer, msgs[2].requestId, runnerText);
        await flushPromises();

        msgs = await advanceUntilHierarchyRequests(socket, timer, 4);
        expect(msgs.length).toBe(4);
        simulateRunnerError(socket, timer, msgs[3].requestId, runnerText);

        const ready = await timer.resolvePromise(verifyPromise);

        expect(ready).toBe(false);
        // 4 attempts, not 3 (timeout reset the streak) and not 5 (short-circuit stopped attempt 5).
        expect(sentHierarchyRequests(socket).length).toBe(4);
        const terminalWarn = log.at("warn").find(({ message }) => message.includes("Service not ready"));
        expect(terminalWarn?.message).toContain("short-circuited");
        expect(terminalWarn?.message).toContain("4/5 verification attempts");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("hierarchy ADB-broadcast fallback error frame correlation (issue #3089)", function() {
    // Last member of the #3032/#3061 waitForFreshData hang class. When the WebSocket
    // request_hierarchy send fails, requestHierarchySync falls back to an
    // `am broadcast ... EXTRACT_HIERARCHY --es uuid sync_<ts>_<id>` and then waits for a push.
    // Before #3089 that fallback wait registered NO rejector (it passed no requestId into
    // waitForFreshData), so a runner type:"error" frame echoing the broadcast uuid no-op'd and the
    // caller hung to the full timeout. These tests drive that fallback and assert the sync_ uuid now
    // correlates a runner error into a fast fail, while staying a safe no-op for uncorrelated ids and
    // for the getLatestHierarchy stale-cache path (which still registers no requestId).

    // A capturing socket that stays OPEN but throws when asked to SEND a request_hierarchy (or the
    // stale nudge) frame, forcing requestHierarchySync down its ADB-broadcast fallback branch. It
    // stays OPEN so the test can still deliver a simulated type:"error" frame back over the same
    // socket — modeling a WebSocket that momentarily could not accept a send but is still readable.
    class HierarchySendFailingWebSocket extends CapturingWebSocket {
      send(data: any): void {
        const str = data.toString();
        this.sentMessages.push(str);
        let parsed: any = null;
        try { parsed = JSON.parse(str); } catch { parsed = null; }
        if (parsed && (parsed.type === "request_hierarchy" || parsed.type === "request_hierarchy_if_stale")) {
          throw new Error("Simulated WebSocket send failure (forces ADB-broadcast fallback)");
        }
        // Any other frame: accept silently (base FakeWebSocket.send only checks OPEN and no-ops).
      }
    }

    const createSendFailingFactory = (timer?: FakeTimer): {
      factory: (url: string) => HierarchySendFailingWebSocket;
      getSocket: () => HierarchySendFailingWebSocket | null;
    } => {
      let socket: HierarchySendFailingWebSocket | null = null;
      return {
        factory: (url: string) => {
          socket = new HierarchySendFailingWebSocket(url, "none", 0, timer);
          return socket;
        },
        getSocket: () => socket
      };
    };

    // Poll the fake ADB command history until the EXTRACT_HIERARCHY broadcast fallback fires, then
    // return its `sync_` uuid. The fallback runs a few microtask turns after the request_hierarchy
    // send throws, so retry across setImmediate flushes rather than assuming a fixed ordering.
    const waitForBroadcastUuid = async (adb: FakeAdbExecutor): Promise<string | undefined> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const cmd = adb.getExecutedCommands().find(c => c.includes("EXTRACT_HIERARCHY"));
        if (cmd) {
          const match = cmd.match(/--es uuid (sync_[^\s"]+)/);
          if (match) {
            return match[1];
          }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      return undefined;
    };

    test("a type:error frame echoing the broadcast sync_ uuid fails requestHierarchySync fast", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createSendFailingFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        // 10s hierarchy sync timeout — the whole point is to NOT wait for it.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as HierarchySendFailingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // request_hierarchy send throws -> ADB-broadcast fallback mints and broadcasts the sync_ uuid.
        const uuid = await waitForBroadcastUuid(fakeAdb);
        expect(uuid).toBeDefined();
        expect(String(uuid).startsWith("sync_")).toBe(true);
        // Let waitForFreshData run so it registers the fast-fail rejector for the sync_ uuid.
        await flushPromises();

        // Runner reports a correlated handler failure echoing the broadcast uuid (issue #3089: the
        // EXTRACT_HIERARCHY handler emits a type:"error" frame keyed by the broadcast uuid on failure).
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: uuid,
          success: false,
          error: "Failed to extract hierarchy",
          timestamp: errorTimer.now()
        }));

        // Fail fast: no timer advance toward the 10s timeout. Only flush microtasks/setImmediate.
        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        // Prove we did not sit through the timeout: virtually no fake time elapsed.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a broadcast-fallback runner error populates diagnostics.runnerError (parity with #3062)", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createSendFailingFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as HierarchySendFailingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const uuid = await waitForBroadcastUuid(fakeAdb);
        expect(uuid).toBeDefined();
        await flushPromises();

        const runnerText = "Failed to extract hierarchy";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: uuid,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        await flushPromises();
        const result = await syncPromise;

        // Contract unchanged: still null so existing callers keep their stale-cache fallback.
        expect(result).toBeNull();
        // The runner text is surfaced to the caller, distinct from a plain timeout null.
        expect(diagnostics.runnerError).toBe(runnerText);
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("an uncorrelated error id during the broadcast fallback is a safe no-op; the push still resolves", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createSendFailingFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as HierarchySendFailingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const uuid = await waitForBroadcastUuid(fakeAdb);
        expect(uuid).toBeDefined();
        await flushPromises();

        // Error frame for an uncorrelated id — must be a safe no-op for the broadcast-fallback wait.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real hierarchy push for our request still arrives and resolves the sync normally.
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated broadcast error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated broadcast error");
      } finally {
        await testClient.close();
      }
    });

    test("a sync_-prefixed error frame does NOT disturb the getLatestHierarchy stale-cache path", async function() {
      // getLatestHierarchy never mints a broadcast sync_ uuid and enters waitForFreshData with NO
      // requestId — its timeout is meant to gracefully fall through to the stale cache. This locks in
      // that the #3089 correlation is scoped to requestHierarchySync: a sync_-shaped error frame is an
      // uncorrelated no-op here and must NOT reject the wait to null (which would discard the cache).
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        // Prime the connection + cache via a sync that a push resolves quickly.
        const primePromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);
        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Stale cache preserved" }
          }
        }));
        await errorTimer.resolvePromise(primePromise);

        // Let time pass so the cached data is stale relative to the next wait's start.
        errorTimer.advanceTime(500);

        const latestPromise = testClient.getLatestHierarchy(true, 3000);

        // Inject a sync_-shaped error frame — no rejector is registered for it on this path.
        await flushPromises();
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: `sync_${errorTimer.now()}_deadbeef`,
          success: false,
          error: "Failed to extract hierarchy",
          timestamp: errorTimer.now()
        }));

        // The wait falls through to its timeout and returns the STALE CACHE (not null).
        const result = await errorTimer.resolvePromise(latestPromise);
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Stale cache preserved");
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("bindSession", function() {
    afterEach(function() {
      NavigationGraphManager.resetInstance();
    });

    // Pins the session-isolation invariants a per-device client relies on. A
    // per-device CtrlProxy client is last-writer-wins: it is safe only because
    // the pool guarantees one live session per device at a time. These assertions
    // make a routing-semantics regression fail loudly instead of silently mixing
    // one session's navigation state into another's.
    test("is unbound (null) until a session is bound", function() {
      // The per-test client from beforeEach is created without a session bound.
      expect(accessibilityServiceClient.getBoundSessionId()).toBeNull();
    });

    test("is last-writer-wins: the most recently bound session is the active one", function() {
      accessibilityServiceClient.bindSession("session-A");
      expect(accessibilityServiceClient.getBoundSessionId()).toBe("session-A");

      // Rebinding (e.g. the device is reassigned to a new session) switches the
      // active session; the previous binding does not linger.
      accessibilityServiceClient.bindSession("session-B");
      expect(accessibilityServiceClient.getBoundSessionId()).toBe("session-B");
    });

    test("re-binding the same session is idempotent", function() {
      accessibilityServiceClient.bindSession("session-A");
      accessibilityServiceClient.bindSession("session-A");
      expect(accessibilityServiceClient.getBoundSessionId()).toBe("session-A");
    });
  });

  describe("capture provenance for screenshot geometry (issue #3348)", () => {
    // A screenshot may only claim capture-tracked geometry when the daemon actually received a
    // hierarchy carrying it. Claiming it otherwise lets the daemon stamp an older capture's
    // identity onto fresh pixels, and a control client would map a tap through stale bounds.

    test("binds an explicitly forwarded initial hierarchy for later static-screen screenshots", () => {
      let backoffStarts = 0;
      (accessibilityServiceClient as any).startScreenshotBackoff = () => { backoffStarts++; };

      accessibilityServiceClient.recordInitialObservationStreamHierarchy(
        hierarchyWithScreenSize(1080, 2340),
        41
      );

      expect((accessibilityServiceClient as any).screenGeometry.bind()).toEqual({
        captureSequence: 41,
        width: 1080,
        height: 2340,
      });
      expect(backoffStarts).toBe(1);
    });

    test("drops stale provenance when an initial hierarchy has no assigned identity", () => {
      const geometry = (accessibilityServiceClient as any).screenGeometry;
      geometry.update(1080, 2340);
      geometry.markForwarded(40);

      accessibilityServiceClient.recordInitialObservationStreamHierarchy(
        hierarchyWithScreenSize(1080, 2340),
        null
      );

      expect(geometry.bind()).toBeNull();
    });

    test("claims provenance after a hierarchy is forwarded to the observation stream", async () => {
      const socket = await startStreamServerWithScreenshotSubscriber();

      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(1080, 2340));
      pushScreenshotThroughClient(pngFrame(1080, 2340));

      const updates = getScreenshotUpdates(socket);
      expect(updates).toHaveLength(1);
      expect(updates[0].captureSequence).toBeGreaterThan(0);
    });

    test("claims no provenance when the hierarchy carrying new geometry was suppressed", async () => {
      const socket = await startStreamServerWithScreenshotSubscriber();

      // Establish a real capture first, so an unconditional claim would have an id to attach.
      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(1080, 2340));
      socket.reset();

      // The device changes resolution and that hierarchy's push is suppressed (explicit
      // initial-frame request). The screen-dimension cache still updates, so without the forwarded
      // flag the screenshot would vouch for geometry the daemon has never seen — and the daemon
      // would stamp the PREVIOUS capture's id onto these fresh pixels, which is exactly the
      // mis-pairing the identity exists to prevent.
      (accessibilityServiceClient as any).hierarchyObservationStreamSuppressions.add({
        timeoutHandle: fakeTimer.setTimeout(() => {}, 10_000),
      });
      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(720, 1560));
      pushScreenshotThroughClient(pngFrame(720, 1560));

      const updates = getScreenshotUpdates(socket);
      expect(updates).toHaveLength(1);
      expect(updates[0].captureSequence).toBeUndefined();
    });

    test("claims no provenance for fallback dimensions before any hierarchy arrives", async () => {
      const socket = await startStreamServerWithScreenshotSubscriber();

      // No hierarchy yet, so the client falls back to nominal dimensions with no provenance at all.
      pushScreenshotThroughClient(pngFrame(1080, 2340));

      const updates = getScreenshotUpdates(socket);
      expect(updates).toHaveLength(1);
      expect(updates[0].captureSequence).toBeUndefined();
    });

    test("binds a screenshot to the capture it was REQUESTED under across same-size navigation", async () => {
      // The variant no measurement can catch (issue #3348). A frame is requested while screen A is
      // current; screen B's hierarchy — IDENTICAL dimensions — is forwarded before the response
      // arrives. Labelling the frame with the newest capture would pair A's pixels with B's
      // hierarchy and let the desktop tap stale content.
      const socket = await startStreamServerWithScreenshotSubscriber();

      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(1080, 2340));
      const boundToScreenA = (accessibilityServiceClient as any).screenGeometry.bind();
      expect(boundToScreenA).not.toBeNull();

      // Screen B arrives and is forwarded while the frame is still in flight. Same resolution, so
      // the geometry cache is unchanged and the provenance stays valid — only the capture moves.
      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(1080, 2340));
      const currentAfterB = (accessibilityServiceClient as any).screenGeometry.bind();
      expect(currentAfterB.captureSequence).toBeGreaterThan(boundToScreenA.captureSequence);
      socket.reset();

      // The in-flight frame lands and is pushed with the binding taken at initiation.
      (accessibilityServiceClient as any).pushScreenshotToObservationStream(
        pngFrame(1080, 2340),
        { screenshotMimeType: "image/png", screenshotFormat: "png" },
        boundToScreenA
      );

      const updates = getScreenshotUpdates(socket);
      expect(updates).toHaveLength(1);
      expect(updates[0].captureSequence).toBe(boundToScreenA.captureSequence);
      expect(updates[0].captureSequence).not.toBe(currentAfterB.captureSequence);
    });

    test("drops provenance again when the device resolution changes", async () => {
      const socket = await startStreamServerWithScreenshotSubscriber();

      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(1080, 2340));
      pushScreenshotThroughClient(pngFrame(1080, 2340));
      expect(getScreenshotUpdates(socket)[0].captureSequence).toBeGreaterThan(0);
      socket.reset();

      // Resolution changes; the hierarchy carrying the new geometry is suppressed, so the fresh
      // pixels must not be paired with the previous capture.
      (accessibilityServiceClient as any).hierarchyObservationStreamSuppressions.add({
        timeoutHandle: fakeTimer.setTimeout(() => {}, 10_000),
      });
      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(720, 1560));
      pushScreenshotThroughClient(pngFrame(720, 1560));

      const updates = getScreenshotUpdates(socket);
      expect(updates).toHaveLength(1);
      expect(updates[0].captureSequence).toBeUndefined();
    });
  });

  describe("scale metadata retention (issue #4548)", () => {
    test("retains the runner's scale-1 metadata without changing the window-derived geometry", () => {
      (accessibilityServiceClient as any).handleHierarchyUpdate({
        ...hierarchyWithScreenSize(1080, 2340),
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      });

      expect(accessibilityServiceClient.getScreenScaleMetadata()).toEqual({
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      });
      // Retention-only (#4548): the tracked geometry still comes from the window bounds.
      const geometry = (accessibilityServiceClient as any).screenGeometry;
      expect(geometry.width).toBe(1080);
      expect(geometry.height).toBe(2340);
    });

    test("legacy hierarchy without the fields leaves metadata null and behavior unchanged", () => {
      (accessibilityServiceClient as any).handleHierarchyUpdate(hierarchyWithScreenSize(1080, 2340));

      expect(accessibilityServiceClient.getScreenScaleMetadata()).toBeNull();
      const geometry = (accessibilityServiceClient as any).screenGeometry;
      expect(geometry.width).toBe(1080);
      expect(geometry.height).toBe(2340);
    });

    test("a later hierarchy without the fields (or with runner nulls) resets metadata", () => {
      (accessibilityServiceClient as any).handleHierarchyUpdate({
        ...hierarchyWithScreenSize(1080, 2340),
        nativeScale: 1,
        pixelWidth: 1080,
        pixelHeight: 2340,
      });
      expect(accessibilityServiceClient.getScreenScaleMetadata()).not.toBeNull();

      // The runner serializes absent optionals as JSON null when dimensions are unavailable.
      (accessibilityServiceClient as any).handleHierarchyUpdate({
        ...hierarchyWithScreenSize(1080, 2340),
        nativeScale: null,
        pixelWidth: null,
        pixelHeight: null,
      });
      expect(accessibilityServiceClient.getScreenScaleMetadata()).toBeNull();
    });
  });

  describe("shared rate-limit floor accounting (issue #4927)", function() {
    test("one-shot requestScreenshot advances the shared floor clock so the stream scheduler coalesces around it", async function() {
      const localTimer = new FakeTimer();
      localTimer.enableAutoAdvance();
      const fakeScheduler = new FakeScreenshotBackoffScheduler();
      const { factory, getSocket } = createCapturingWebSocketFactory(localTimer);
      // Inject the fake scheduler via the test-only createForTesting seam (positional optionals).
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        localTimer,
        undefined, // installedAppsRepository
        undefined, // retryExecutor
        undefined, // crashEventSink
        undefined, // deviceConnectionLostNotifier
        undefined, // sdkEventIngestor
        undefined, // loggerInstance
        undefined, // certificateFileSystem
        fakeScheduler
      );
      client.invalidateCache();
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket) as CapturingWebSocket | null;
      await waitForSocketOpen(socket);
      if (!socket) {
        throw new Error("Expected capturing CtrlProxy socket");
      }

      // A one-shot capture (the observe / junit-runner path) must stamp the shared clock even
      // though it never runs the backoff scheduler itself. The stamp happens synchronously at the
      // moment the a11y request is sent, before any await, so it is observable as soon as the
      // request frame lands on the socket.
      expect(fakeScheduler.noteCaptureStartedCalls).toBe(0);
      const before = socket.sentMessages.length;
      const capture = client.requestScreenshot(500);
      await waitForSentMessages(socket, before + 1);

      const req = socket.sentMessages
        .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
        .reverse()
        .find(m => m && m.type === "request_screenshot");
      expect(req).toBeTruthy();
      expect(fakeScheduler.noteCaptureStartedCalls).toBe(1);

      // Resolve the request so the pending promise settles; the assertion above is the contract.
      socket.emit("message", JSON.stringify({
        type: "screenshot", requestId: req.requestId, data: "jpeg-base64", format: "jpeg", timestamp: 1,
      }));
      await capture.catch(() => undefined);

      await client.close();
    });
  });
});
