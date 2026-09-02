import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  iosDevice,
  createFakeDeviceManager,
  createFakeSession,
  createFakeDaemonState,
  sendRequest,
  sendRequestAfterConnect,
} from "./helpers/inputSocketHarness";

describe("UnixSocketServer input/swipe", () => {
  let socketPath: string;
  let server: UnixSocketServer;
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
  });

  test("routes Android coordinate swipes without forwarding through tools/call", async () => {
    const requestSwipe = mock(async () => ({ success: true }));
    const createMcpClient = mock(async () => {
      throw new Error("input/swipe should not create an MCP client");
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSwipe,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    expect(requestSwipe).toHaveBeenCalledWith(12.5, 34.25, 56.75, 78.5, 420, 1234);
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("LEGACY iOS swipe (no runner scale metadata) passes coordinates through unchanged", async () => {
    const requestDrag = mock(async () => ({ success: true }));
    const fetchHierarchy = mock(async () => ({ hierarchy: {} })); // success, no metadata => legacy
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestDrag,
      getScreenScaleMetadata: () => null,
      requestHierarchySyncWithoutObservationStreamPush: fetchHierarchy,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    expect(requestDrag).toHaveBeenCalledWith(20, 30, 80, 90, 0, 750, 0, 30_000);
  });

  test("canonical-pixel iOS swipe divides each endpoint by nativeScale before dispatch", async () => {
    // px frame (#4549): endpoints arrive in pixels, divided by nativeScale=3 to runner points.
    const requestDrag = mock(async () => ({ success: true }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestDrag,
      getScreenScaleMetadata: () => ({ nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 }),
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    expect(requestDrag).toHaveBeenCalledWith(100, 200, 300, 500, 0, 750, 0, 30_000);
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestSwipe = mock(async () => ({ success: true }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSwipe,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
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
        const socketSessionId = [
          ...(server as unknown as { sessions: Map<string, unknown> }).sessions.keys(),
        ][0];
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
    expect(requestSwipe).toHaveBeenCalledWith(1, 2, 3, 4, 300, 30_000);
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
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSwipe,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    fakeTimer.enableAutoAdvance();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSwipe,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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

    expect(zero.success).toBe(false);
    expect(zero.error).toBe("input/swipe durationMs must be between 1 and 60000 milliseconds");
    expect(tooLarge.success).toBe(false);
    expect(tooLarge.error).toBe("input/swipe durationMs must be between 1 and 60000 milliseconds");
  });
});
