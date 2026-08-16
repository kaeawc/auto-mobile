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
  createFakeDaemonState,
  sendRequest,
} from "./helpers/inputSocketHarness";

/**
 * The streaming-gesture wire (issue: streaming gesture input). A live drag is one `input/gestureStart`,
 * many `input/gestureMove`, and one `input/gestureEnd` sharing a gestureId; the daemon forwards each
 * to the Android runner's continued-gesture path. Android-only, frame-identity-free.
 */
describe("UnixSocketServer input/gesture*", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-gesture-${randomUUID()}.sock`);
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

  function mockAndroidGestures() {
    const requestGestureStart = mock(async () => ({ success: true }));
    const requestGestureMove = mock(async () => ({ success: true }));
    const requestGestureEnd = mock(async () => ({ success: true }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestGestureStart,
      requestGestureMove,
      requestGestureEnd,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    return { requestGestureStart, requestGestureMove, requestGestureEnd };
  }

  test("forwards start, move, and end frames to the Android continued-gesture path", async () => {
    const { requestGestureStart, requestGestureMove, requestGestureEnd } = mockAndroidGestures();
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const start = await sendRequest(socketPath, "input/gestureStart", {
      platform: "android",
      deviceId: "emulator-5554",
      gestureId: "g1",
      x: 100.5,
      y: 200.25,
    }, 1234);
    const move = await sendRequest(socketPath, "input/gestureMove", {
      platform: "android",
      deviceId: "emulator-5554",
      gestureId: "g1",
      x: 100.5,
      y: 400,
    }, 1234);
    const end = await sendRequest(socketPath, "input/gestureEnd", {
      platform: "android",
      deviceId: "emulator-5554",
      gestureId: "g1",
      x: 100.5,
      y: 500,
    }, 1234);

    expect(start.success).toBe(true);
    expect(start.result).toEqual({
      action: "input/gestureStart",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      gestureId: "g1",
      point: { x: 100.5, y: 200.25 },
    });
    expect(requestGestureStart).toHaveBeenCalledWith("g1", 100.5, 200.25, 1234);

    expect(move.success).toBe(true);
    expect(requestGestureMove).toHaveBeenCalledWith("g1", 100.5, 400, 1234);

    expect(end.success).toBe(true);
    expect(end.result).toMatchObject({ action: "input/gestureEnd", gestureId: "g1", cancel: false });
    expect(requestGestureEnd).toHaveBeenCalledWith("g1", 100.5, 500, false, 1234);
  });

  test("carries the cancel flag through on end", async () => {
    const { requestGestureEnd } = mockAndroidGestures();
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const end = await sendRequest(socketPath, "input/gestureEnd", {
      platform: "android",
      deviceId: "emulator-5554",
      gestureId: "g2",
      x: 10,
      y: 20,
      cancel: true,
    });

    expect(end.success).toBe(true);
    expect(end.result).toMatchObject({ cancel: true });
    expect(requestGestureEnd).toHaveBeenCalledWith("g2", 10, 20, true, 30_000);
  });

  test("rejects iOS: streaming gestures are Android-only", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/gestureStart", {
      platform: "ios",
      deviceId: "ios-sim-1",
      gestureId: "g1",
      x: 1,
      y: 2,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("input/gestureStart is only supported on platform 'android'");
  });

  test("rejects a missing gestureId and non-numeric coordinates", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const noId = await sendRequest(socketPath, "input/gestureStart", {
      platform: "android",
      x: 1,
      y: 2,
    });
    const badCoord = await sendRequest(socketPath, "input/gestureMove", {
      platform: "android",
      gestureId: "g1",
      x: "1",
      y: 2,
    });

    expect(noId.success).toBe(false);
    expect(noId.error).toBe("input/gestureStart requires a non-empty gestureId");
    expect(badCoord.success).toBe(false);
    expect(badCoord.error).toBe("input/gestureMove requires numeric x and y params");
  });

  test("serializes gesture frames for the same device (gesture ordering)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => {
        fakeTimer.setTimeout(resolve, 20);
      });
      inFlight -= 1;
      return { success: true };
    };
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestGestureStart: mock(track),
      requestGestureMove: mock(track),
      requestGestureEnd: mock(track),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    fakeTimer.enableAutoAdvance();
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const results = await Promise.all([
      sendRequest(socketPath, "input/gestureStart", { platform: "android", deviceId: "emulator-5554", gestureId: "g1", x: 0, y: 0 }),
      sendRequest(socketPath, "input/gestureMove", { platform: "android", deviceId: "emulator-5554", gestureId: "g1", x: 0, y: 10 }),
      sendRequest(socketPath, "input/gestureEnd", { platform: "android", deviceId: "emulator-5554", gestureId: "g1", x: 0, y: 20 }),
    ]);

    expect(results.every(r => r.success)).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });
});
