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

describe("UnixSocketServer input/tap", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-tap-${randomUUID()}.sock`);
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

  test("routes Android coordinate taps without forwarding through tools/call", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    const createMcpClient = mock(async () => {
      throw new Error("input/tap should not create an MCP client");
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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
      "input/tap",
      {
        platform: "android",
        deviceId: "emulator-5554",
        x: 12.5,
        y: 34.25,
        duration: 80,
      },
      1234,
    );

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/tap",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      coordinates: { x: 12.5, y: 34.25 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith(12.5, 34.25, 80, 1234);
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("rejects Android tap coordinates outside known canonical pixel bounds", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
      getScreenScaleMetadata: () => ({ nativeScale: 1, pixelWidth: 1080, pixelHeight: 2340 }),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const negative = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: -1,
      y: 100,
    });
    const oversized = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 100,
      y: 2340,
    });

    expect(negative.success).toBe(false);
    expect(negative.error).toContain("x=-1, y=100");
    expect(negative.error).toContain("x: 0..1079, y: 0..2339");
    expect(oversized.success).toBe(false);
    expect(oversized.error).toContain("x=100, y=2340");
    expect(oversized.error).toContain("x: 0..1079, y: 0..2339");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("LEGACY iOS tap: probe SUCCEEDS with no metadata -> pass through unchanged", async () => {
    // The probe returns a hierarchy (success) but it carries no scale metadata: a genuine pre-#4548
    // runner. The control client never got px bounds, so it sends points — pass through, no divide.
    const requestTapCoordinates = mock(async () => ({ success: true }));
    const fetchHierarchy = mock(async () => ({ hierarchy: {} }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: -50,
      y: 999999,
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({ coordinates: { x: -50, y: 999999 } });
    expect(fetchHierarchy).toHaveBeenCalledTimes(1); // it probed to learn the scale first
    expect(requestTapCoordinates).toHaveBeenCalledWith(-50, 999999, undefined, 30_000);
  });

  test("rejects an Android frameContext without a matching device observation", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 12.5,
      y: 34.25,
      frameContext: "screen-A",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("stale or unavailable");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("iOS tap: a confirmed-legacy device probes only ONCE across consecutive taps (#4549 D)", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    const fetchHierarchy = mock(async () => ({ hierarchy: {} })); // success, no metadata => legacy
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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

    await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 20,
      y: 30,
    });
    await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 40,
      y: 50,
    });

    expect(fetchHierarchy).toHaveBeenCalledTimes(1); // cached after the first confirms legacy
    expect(requestTapCoordinates).toHaveBeenCalledTimes(2);
  });

  test("iOS tap: a FAILED probe (no hierarchy) rejects the input instead of assuming legacy (#4549 C)", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    const fetchHierarchy = mock(async () => null); // not connected / timed out -> FAILURE
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Could not determine iOS screen scale");
    expect(requestTapCoordinates).not.toHaveBeenCalled(); // fail closed, no mis-dispatch
  });

  test("iOS tap: a THROWN probe rejects the input (#4549 C)", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    const fetchHierarchy = mock(async () => {
      throw new Error("ws disconnected");
    });
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("scale probe failed");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("iOS tap: the scale probe is charged against the gesture budget (#4549 B)", async () => {
    // The probe consumes 20s of the 30s budget; the gesture must get only the ~10s remainder, not a
    // fresh 30s (which would let probe + gesture run ~2x the declared budget).
    const requestTapCoordinates = mock(async () => ({ success: true }));
    let scale: { nativeScale: number; pixelWidth: number; pixelHeight: number } | null = null;
    const fetchHierarchy = mock(async () => {
      fakeTimer.advanceTime(20_000);
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return { hierarchy: {} };
    });
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(true);
    expect(requestTapCoordinates).toHaveBeenCalledWith(200, 300, undefined, 10_000);
  });

  test("iOS tap: a probe that consumes the whole budget fails with a timeout, not a full-budget gesture (#4549 B)", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    let scale: { nativeScale: number } | null = null;
    const fetchHierarchy = mock(async () => {
      fakeTimer.advanceTime(31_000); // exceeds the 30s budget
      scale = { nativeScale: 3 };
      return { hierarchy: {} };
    });
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(false);
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("canonical-pixel iOS tap divides by nativeScale (exact) before dispatch to the points-based runner", async () => {
    // The control client renders a px frame (#4549) and sends the tap in PIXELS; the daemon divides
    // EXACTLY by nativeScale so the XCUITest runner receives (fractional) points and the tap lands
    // at the same physical location. 1169/3 = 389.666..., 2531/3 = 843.666....
    const requestTapCoordinates = mock(async () => ({ success: true }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 1169,
      y: 2531,
    });

    expect(response.success).toBe(true);
    // The echoed coordinates stay in the client's px space; only the runner dispatch is converted.
    expect(response.result).toMatchObject({ coordinates: { x: 1169, y: 2531 } });
    const [x, y] = requestTapCoordinates.mock.calls[0];
    expect(x).toBeCloseTo(1169 / 3, 10);
    expect(y).toBeCloseTo(2531 / 3, 10);
  });

  test("iOS tap rejects coordinates outside bounds learned by the scale probe", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    let scale: { nativeScale: number; pixelWidth: number; pixelHeight: number } | null = null;
    const fetchHierarchy = mock(async () => {
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return { hierarchy: {} };
    });
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 1170,
      y: 100,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("x=1170, y=100");
    expect(response.error).toContain("x: 0..1169, y: 0..2531");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("iOS tap before ANY hierarchy fetches one first, then divides by the learned nativeScale", async () => {
    // Startup window: the control client's first tap arrives before the daemon received any
    // hierarchy, so #4548 receipt-based retention has not run and getScreenScaleMetadata() is null.
    // The daemon fetches a hierarchy (populating the scale via receipt), then converts.
    const requestTapCoordinates = mock(async () => ({ success: true }));
    let scale: { nativeScale: number; pixelWidth: number; pixelHeight: number } | null = null;
    const fetchHierarchy = mock(async () => {
      // Simulate #4548 receipt-based retention populating the scale during the fetch. The probe
      // SUCCEEDS (returns a hierarchy); the scale is now known.
      scale = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
      return { hierarchy: {} };
    });
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
      getScreenScaleMetadata: () => scale,
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 600,
      y: 900,
    });

    expect(response.success).toBe(true);
    expect(fetchHierarchy).toHaveBeenCalledTimes(1);
    // 600/3 = 200, 900/3 = 300 — NOT dispatched as 600/900 points (which would tap at 1/3 scale).
    expect(requestTapCoordinates).toHaveBeenCalledWith(200, 300, undefined, 30_000);
  });

  test("rejects an iOS frameContext without a matching device observation", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 20,
      y: 30,
      frameContext: "7",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("stale or unavailable");
    expect(requestTapCoordinates).not.toHaveBeenCalled();
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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
        method: "input/tap",
        params: {
          platform: "android",
          x: 1,
          y: 2,
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
      coordinates: { x: 1, y: 2 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith(1, 2, undefined, 30_000);
  });

  test("serializes concurrent taps for the same device across socket clients", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestTapCoordinates = mock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        fakeTimer.setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
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
      sendRequest(socketPath, "input/tap", {
        platform: "android",
        deviceId: "emulator-5554",
        x: 1,
        y: 1,
      }),
      sendRequest(socketPath, "input/tap", {
        platform: "android",
        deviceId: "emulator-5554",
        x: 2,
        y: 2,
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requestTapCoordinates).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails queued taps before dispatch when queue wait exceeds timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>((resolve) => {
      releaseBlockingRequest = resolve;
    });
    const requestTapCoordinates = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        await blockingPromise;
      }
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const first = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 1,
      y: 1,
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const second = sendRequest(
      socketPath,
      "input/tap",
      {
        platform: "android",
        deviceId: "emulator-5554",
        x: 2,
        y: 2,
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
    expect(requestTapCoordinates).toHaveBeenCalledTimes(1);
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

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 1,
      y: 1,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("Unable to discover booted android devices for input/tap");
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

    const missing = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      y: 10,
    });
    const nonNumeric = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      x: "12",
      y: 10,
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/tap requires numeric x and y params");
    expect(nonNumeric.success).toBe(false);
    expect(nonNumeric.error).toBe("input/tap requires numeric x and y params");
  });

  test("parseInputTapParams rejects non-finite x/y/duration, matching swipe (#3615)", () => {
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    // ±Infinity cannot survive a JSON round-trip (stringify -> null, parse rejects the
    // literal), so it only reaches the parser from a non-JSON in-process caller. Exercise
    // parseInputTapParams directly with the raw floats the parser is responsible for.
    const parseTap = (args: Record<string, unknown>): unknown =>
      (server as unknown as { parseInputTapParams(params: unknown): unknown }).parseInputTapParams(
        args,
      );

    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(() => parseTap({ platform: "android", x: bad, y: 10 })).toThrow(
        "input/tap requires numeric x and y params",
      );
      expect(() => parseTap({ platform: "android", x: 5, y: bad })).toThrow(
        "input/tap requires numeric x and y params",
      );
    }
    expect(() => parseTap({ platform: "android", x: 5, y: 10, duration: Infinity })).toThrow(
      "input/tap duration must be numeric when provided",
    );

    // Finite values still parse successfully (no over-rejection regression).
    expect(parseTap({ platform: "android", x: 5, y: 10, duration: 200 })).toMatchObject({
      platform: "android",
      x: 5,
      y: 10,
      duration: 200,
    });
  });

  test("accepts optional frameContext on every non-pointer input contract", () => {
    const target = server as unknown as {
      parseInputTypeTextParams(value: unknown): { frameContext?: string };
      parseInputPressButtonParams(value: unknown): { frameContext?: string };
      parseInputKeyParams(value: unknown): { frameContext?: string };
    };

    expect(
      target.parseInputTypeTextParams({ platform: "android", text: "x", frameContext: "frame-A" })
        .frameContext,
    ).toBe("frame-A");
    expect(
      target.parseInputPressButtonParams({
        platform: "android",
        button: "home",
        frameContext: "frame-A",
      }).frameContext,
    ).toBe("frame-A");
    expect(
      target.parseInputKeyParams({ platform: "android", key: "enter", frameContext: "frame-A" })
        .frameContext,
    ).toBe("frame-A");
  });
});
