import { spyOn } from "bun:test";
import { executionTracker } from "../../src/daemon/executionTracker";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import {
  createFakeDaemonState as createDrainDaemonState,
  createFakeSession as createDrainSession,
} from "./helpers/inputSocketHarness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { CtrlProxySyncedHierarchy } from "../../src/features/observe/ios/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { createAndroidTestClient } from "../helpers/androidCtrlProxyClientSpies";
import type { DragRequest } from "../../src/utils/interfaces/DragRequest";
import type { SwipeRequest } from "../../src/utils/interfaces/SwipeRequest";
import { createIosTestClient } from "../helpers/iosCtrlProxyClientSpies";
import {
  androidDevice,
  iosDevice,
  createFakeDeviceManager,
  createFakeSession,
  createFakeDaemonState,
  sendRequest,
  sendRequestAfterConnect,
} from "./helpers/inputSocketHarness";

async function emptySyncedHierarchy(): Promise<CtrlProxySyncedHierarchy> {
  return { hierarchy: { updatedAt: 0, packageName: "", hierarchy: {} } };
}

describe("UnixSocketServer input/swipe", () => {
  let socketPath: string;
  let server: UnixSocketServerHarness;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-swipe-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
    originalIosGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    mock.restore();
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    IOSCtrlProxyClient.clearInstanceRegistryForTesting();
    executionTracker.clearDaemonRestartPreparation();
    executionTracker.clearDaemonMaintenancePreparation();
  });

  test("routes Android coordinate swipes without forwarding through tools/call", async () => {
    const requestSwipe = mock(async (request: SwipeRequest) => {
      request.onDispatch?.();
      return { success: true, totalTimeMs: 0 };
    });
    const createMcpClient = mock(async () => {
      throw new Error("input/swipe should not create an MCP client");
    });
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(androidDevice, { requestSwipe }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    server.mcpClientFactory = createMcpClient;
    await server.start();

    const response = await sendRequest(
      socketPath,
      "input/swipe",
      {
        platform: "android",
        deviceId: "emulator-5554",
        startX: 12.5,
        startY: 34.25,
        endX: 56.75,
        endY: 78.5,
        durationMs: 420,
      },
      1234,
    );

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/swipe",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      start: { x: 12.5, y: 34.25 },
      end: { x: 56.75, y: 78.5 },
      durationMs: 420,
    });
    expect(requestSwipe).toHaveBeenCalledWith({
      x1: 12.5,
      y1: 34.25,
      x2: 56.75,
      y2: 78.5,
      duration: 420,
      timeoutMs: 1234,
      contextOptions: undefined,
      onDispatch: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("LEGACY iOS swipe (no runner scale metadata) passes coordinates through unchanged", async () => {
    const requestDrag = mock(async (request: DragRequest) => {
      request.onDispatch?.();
      return { success: true, totalTimeMs: 0 };
    });
    const fetchHierarchy = mock(emptySyncedHierarchy); // success, no metadata => legacy
    spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      createIosTestClient(iosDevice, {
        requestDrag,
        getScreenScaleMetadata: () => null,
        requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
      }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/swipe", {
      platform: "ios",
      deviceId: "ios-sim-1",
      startX: 20,
      startY: 30,
      endX: 80,
      endY: 90,
      durationMs: 750,
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/swipe",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      start: { x: 20, y: 30 },
      end: { x: 80, y: 90 },
      durationMs: 750,
    });
    expect(requestDrag).toHaveBeenCalledWith({
      x1: 20,
      y1: 30,
      x2: 80,
      y2: 90,
      pressDurationMs: 0,
      dragDurationMs: 750,
      holdDurationMs: 0,
      timeoutMs: 30_000,
      frameContext: undefined,
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("canonical-pixel iOS swipe divides each endpoint by nativeScale before dispatch", async () => {
    // px frame (#4549): endpoints arrive in pixels, divided by nativeScale=3 to runner points.
    const requestDrag = mock(async (request: DragRequest) => {
      request.onDispatch?.();
      return { success: true, totalTimeMs: 0 };
    });
    spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      createIosTestClient(iosDevice, {
        requestDrag,
        getScreenScaleMetadata: () => ({ nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 }),
      }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/swipe", {
      platform: "ios",
      deviceId: "ios-sim-1",
      startX: 300,
      startY: 600,
      endX: 900,
      endY: 1500,
      durationMs: 750,
    });

    expect(response.success).toBe(true);
    // Echoed endpoints stay in the client's px space; only the runner dispatch is converted.
    expect(response.result).toMatchObject({ start: { x: 300, y: 600 }, end: { x: 900, y: 1500 } });
    expect(requestDrag).toHaveBeenCalledWith({
      x1: 100,
      y1: 200,
      x2: 300,
      y2: 500,
      pressDurationMs: 0,
      dragDurationMs: 750,
      holdDurationMs: 0,
      timeoutMs: 30_000,
      frameContext: undefined,
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestSwipe = mock(async (request: SwipeRequest) => {
      request.onDispatch?.();
      return { success: true, totalTimeMs: 0 };
    });
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(androidDevice, { requestSwipe }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServerHarness(
      socketPath,
      createFakeDaemonState(autolockSessions, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequestAfterConnect(
      socketPath,
      {
        id: randomUUID(),
        type: "mcp_request",
        method: "input/swipe",
        params: {
          platform: "android",
          startX: 1,
          startY: 2,
          endX: 3,
          endY: 4,
        },
      },
      () => {
        const socketSessionId = server.sessionIds[0];
        mcpAutolockSessions.set(socketSessionId, session.sessionId);
      },
    );

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      start: { x: 1, y: 2 },
      end: { x: 3, y: 4 },
    });
    expect(requestSwipe).toHaveBeenCalledWith({
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      duration: 300,
      timeoutMs: 30_000,
      contextOptions: undefined,
      onDispatch: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  test("serializes concurrent swipes for the same device across socket clients", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestSwipe = mock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        fakeTimer.setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return { success: true, totalTimeMs: 0 };
    });
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(androidDevice, { requestSwipe }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    fakeTimer.enableAutoAdvance();
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const [first, second] = await Promise.all([
      sendRequest(socketPath, "input/swipe", {
        platform: "android",
        deviceId: "emulator-5554",
        startX: 1,
        startY: 1,
        endX: 2,
        endY: 2,
      }),
      sendRequest(socketPath, "input/swipe", {
        platform: "android",
        deviceId: "emulator-5554",
        startX: 3,
        startY: 3,
        endX: 4,
        endY: 4,
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requestSwipe).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails queued swipes before dispatch when queue wait exceeds timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>((resolve) => {
      releaseBlockingRequest = resolve;
    });
    const requestSwipe = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        await blockingPromise;
      }
      return { success: true, totalTimeMs: 0 };
    });
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(androidDevice, { requestSwipe }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const first = sendRequest(socketPath, "input/swipe", {
      platform: "android",
      deviceId: "emulator-5554",
      startX: 1,
      startY: 1,
      endX: 2,
      endY: 2,
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const second = sendRequest(
      socketPath,
      "input/swipe",
      {
        platform: "android",
        deviceId: "emulator-5554",
        startX: 3,
        startY: 3,
        endX: 4,
        endY: 4,
      },
      500,
    );

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    fakeTimer.advanceTime(600);
    releaseBlockingRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain("waiting in queue");
    expect(requestSwipe).toHaveBeenCalledTimes(1);
  });

  test("surfaces platform discovery failures before device targeting errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([], new Set()));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/swipe", {
      platform: "android",
      deviceId: "emulator-5554",
      startX: 1,
      startY: 1,
      endX: 2,
      endY: 2,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("Unable to discover booted android devices for input/swipe");
  });

  test("rejects missing and non-numeric coordinates with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/swipe", {
      platform: "android",
      startY: 10,
      endX: 20,
      endY: 30,
    });
    const nonNumeric = await sendRequest(socketPath, "input/swipe", {
      platform: "android",
      startX: "12",
      startY: 10,
      endX: 20,
      endY: 30,
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe(
      "input/swipe requires numeric startX, startY, endX, and endY params",
    );
    expect(nonNumeric.success).toBe(false);
    expect(nonNumeric.error).toBe(
      "input/swipe requires numeric startX, startY, endX, and endY params",
    );
  });

  test("rejects duration outside the supported bounds", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const zero = await sendRequest(socketPath, "input/swipe", {
      platform: "android",
      startX: 1,
      startY: 1,
      endX: 2,
      endY: 2,
      durationMs: 0,
    });
    const tooLarge = await sendRequest(socketPath, "input/swipe", {
      platform: "android",
      startX: 1,
      startY: 1,
      endX: 2,
      endY: 2,
      durationMs: 60_001,
    });
    const fractional = await sendRequest(socketPath, "input/swipe", {
      platform: "android",
      startX: 1,
      startY: 1,
      endX: 2,
      endY: 2,
      durationMs: 1.5,
    });

    expect(zero.success).toBe(false);
    expect(zero.error).toBe(
      "input/swipe durationMs must be integer milliseconds between 1 and 60000",
    );
    expect(tooLarge.success).toBe(false);
    expect(tooLarge.error).toBe(
      "input/swipe durationMs must be integer milliseconds between 1 and 60000",
    );
    expect(fractional.success).toBe(false);
    expect(fractional.error).toBe(
      "input/swipe durationMs must be integer milliseconds between 1 and 60000",
    );
  });
  test("tracks direct input until a session-loss drain can safely finish", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const deviceRequest = mock(async (request: SwipeRequest) => {
      request.signal?.throwIfAborted();
      request.onDispatch?.();
      sent = true;
      operationStarted.resolve();
      await releaseOperation.promise;
      return { success: true, totalTimeMs: 1 };
    });
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(androidDevice, {
        getScreenScaleMetadata: () => null,
        requestSwipe: deviceRequest,
      }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-swipe-after-dispatch-session";
    const sessions = new Map([
      [sessionId, createDrainSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServerHarness(socketPath, createDrainDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/swipe", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      startX: 1,
      startY: 2,
      endX: 3,
      endY: 4,
      durationMs: 300,
      sessionUuid: sessionId,
    });
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await drainMicrotasks(100);
    // Dispatch is latched exactly as in the real client; drain waits for its runner reply.
    expect(drained).toBe(false);
    releaseOperation.resolve();
    expect(await drain).toBe(true);
    const failure = await response;
    expect(failure.success).toBe(false);
    expect(failure.error).toContain("indeterminate");
    expect(sent).toBe(true);
    await deviceRequest.mock.results[0]!.value;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });

  test("a direct input cancelled before dispatch lets a session-loss drain finish at once and is never sent", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const deviceRequest = mock(async (request: SwipeRequest) => {
      operationStarted.resolve();
      await releaseOperation.promise;
      request.signal?.throwIfAborted();
      request.onDispatch?.();
      sent = true;
      return { success: true, totalTimeMs: 1 };
    });
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      createAndroidTestClient(androidDevice, {
        getScreenScaleMetadata: () => null,
        requestSwipe: deviceRequest,
      }),
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-swipe-before-dispatch-session";
    const sessions = new Map([
      [sessionId, createDrainSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServerHarness(socketPath, createDrainDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/swipe", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      startX: 1,
      startY: 2,
      endX: 3,
      endY: 4,
      durationMs: 300,
      sessionUuid: sessionId,
    });
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await drainMicrotasks(100);
    expect(drained).toBe(true);
    expect(await drain).toBe(true);
    expect((await response).success).toBe(false);
    releaseOperation.resolve();
    await expect(deviceRequest.mock.results[0]!.value).rejects.toThrow();
    await drainMicrotasks(100);
    expect(sent).toBe(false);
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });
});
