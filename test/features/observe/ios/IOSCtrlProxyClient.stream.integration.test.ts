import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import {
  DeviceDataStreamSocketServer,
  installDeviceDataStreamSocketServerForTesting,
  stopDeviceDataStreamSocketServer,
} from "../../../../src/daemon/deviceDataStreamSocketServer";
import type { BootedDevice } from "../../../../src/models";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeSocket } from "../../../fakes/FakeNetServer";
import { loadCoordinateMappingVectors } from "../../../parity/coordinateMappingGoldenVectors";
import { coordinateSpaceFrameSchema } from "../../../helpers/wireMessageSchemas";

describe("IOSCtrlProxyClient observation-stream provenance", () => {
  let ctrlProxyClient: IOSCtrlProxyClient;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };
    IOSCtrlProxyClient.resetInstances();
    ctrlProxyClient = IOSCtrlProxyClient.createForTesting(testDevice, 8765, {
      wsFactory: createSuccessWebSocketFactory(fakeTimer),
      timer: fakeTimer,
    });
  });

  afterEach(async () => {
    await ctrlProxyClient.close();
    await stopDeviceDataStreamSocketServer();
  });

  const startStreamServer = async (): Promise<FakeSocket> => {
    await stopDeviceDataStreamSocketServer();
    const server = new DeviceDataStreamSocketServer("/fake/device-data-stream.sock", fakeTimer, {
      authorize: () => {},
    });
    installDeviceDataStreamSocketServerForTesting(server);
    const socket = new FakeSocket();
    await server.dispatchLineForTesting(
      socket,
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

  const forwardHierarchy = (
    screenWidth: number,
    screenHeight: number,
    screenScale: number,
  ): { captureSequence?: number } => {
    const source: XCTestHierarchy = {
      updatedAt: 0,
      packageName: "com.example.ios",
      hierarchy: {},
      screenWidth,
      screenHeight,
      screenScale,
    };
    ctrlProxyClient.testHooks.pushHierarchyToObservationStream({ hierarchy: {} }, source);
    return source;
  };

  const setStaleCache = (screenWidth: number, screenHeight: number, screenScale: number): void => {
    ctrlProxyClient.testHooks.cachedHierarchy = {
      hierarchy: {
        updatedAt: 0,
        packageName: "com.example.ios",
        hierarchy: {},
        screenWidth,
        screenHeight,
        screenScale,
      },
      receivedAt: fakeTimer.now(),
      fresh: true,
    };
  };

  const receiveHierarchy = (data: Record<string, unknown>, requestId?: string): void => {
    ctrlProxyClient.testHooks.processMessage({
      type: "hierarchy_update",
      ...(requestId ? { requestId } : {}),
      timestamp: fakeTimer.now(),
      data: { updatedAt: 0, packageName: "com.example.ios", hierarchy: {}, ...data },
    });
  };

  test("derives geometry from the hierarchy being forwarded, not from the cache", async () => {
    await startStreamServer();
    const geometry = ctrlProxyClient.testHooks.screenGeometry;

    const forwarded = forwardHierarchy(390, 844, 3);
    expect(geometry.bind()).toEqual({
      captureSequence: expect.any(Number),
      width: 1170,
      height: 2532,
    });
    expect(forwarded.captureSequence).toBe(geometry.bind()?.captureSequence);

    setStaleCache(390, 844, 3);
    forwardHierarchy(320, 693, 3);

    const bound = geometry.bind();
    expect(bound).not.toBeNull();
    expect(bound?.width).toBe(960);
    expect(bound?.height).toBe(2079);
  });

  test("clears tracked geometry when the forwarded hierarchy reports none", async () => {
    await startStreamServer();
    const client = ctrlProxyClient.testHooks;

    forwardHierarchy(390, 844, 3);
    expect(client.screenGeometry.bind()).not.toBeNull();

    setStaleCache(390, 844, 3);
    client.pushHierarchyToObservationStream(
      { hierarchy: {} },
      { updatedAt: 0, packageName: "com.example.ios", hierarchy: {} },
    );
    expect(client.screenGeometry.bind()).toBeNull();
  });

  test("retains metadata when the observation-stream push is suppressed", async () => {
    await startStreamServer();
    const requestId = "req-suppressed-1";
    ctrlProxyClient
      .getObservationStreamTestHooks()
      .suppressHierarchyObservationStreamPush(requestId, 10_000);

    receiveHierarchy(
      {
        updatedAt: 0,
        packageName: "com.example.ios",
        hierarchy: {},
        screenWidth: 375,
        screenHeight: 812,
        screenScale: 3,
        nativeScale: 3.144,
        pixelWidth: 1179,
        pixelHeight: 2553,
      },
      requestId,
    );

    expect(ctrlProxyClient.getObservationStreamTestHooks().suppressedRequestIds()).not.toContain(
      requestId,
    );
    expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual({
      nativeScale: 3.144,
      pixelWidth: 1179,
      pixelHeight: 2553,
    });
  });

  test("tracks canonical pixel geometry from native scale metadata", async () => {
    await startStreamServer();
    const geometry = ctrlProxyClient.testHooks.screenGeometry;

    receiveHierarchy({
      screenWidth: 375,
      screenHeight: 812,
      screenScale: 3,
      nativeScale: 3.144,
      pixelWidth: 1179,
      pixelHeight: 2553,
    });

    expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual({
      nativeScale: 3.144,
      pixelWidth: 1179,
      pixelHeight: 2553,
    });
    const bound = geometry.bind();
    if (!bound) {
      throw new Error("Expected canonical pixel geometry");
    }
    expect(bound.width).toBe(1179);
    expect(bound.height).toBe(2553);
  });

  test("stamps screenshots from the request-time coordinate-space binding", async () => {
    const socket = await startStreamServer();
    const client = ctrlProxyClient.testHooks;

    client.pushHierarchyToObservationStream(
      { hierarchy: {} },
      {
        updatedAt: 0,
        packageName: "com.example.ios",
        hierarchy: {},
        screenWidth: 375,
        screenHeight: 812,
        screenScale: 3,
        nativeScale: 3,
        pixelWidth: 1125,
        pixelHeight: 2436,
      },
    );
    const boundPx = client.screenGeometry.bind();
    if (!boundPx) {
      throw new Error("Expected pixel geometry");
    }
    expect(boundPx.coordinateSpace).toBe("px");
    expect(boundPx.nativeScale).toBe(3);

    client.retainScaleMetadataFrom(null);
    socket.reset();
    client.pushScreenshotToObservationStream({
      screenshotBase64: "c2hvdA==",
      screenWidth: boundPx.width,
      screenHeight: boundPx.height,
      metadata: undefined,
      captureSequence: boundPx.captureSequence,
      coordinateSpace: boundPx.coordinateSpace,
      nativeScale: boundPx.nativeScale,
    });
    const pxShot = socket
      .getWrittenMessages(coordinateSpaceFrameSchema)
      .find((message) => message.type === "screenshot_update");
    expect(pxShot?.coordinateSpace).toBe("px");
    expect(pxShot?.nativeScale).toBe(3);

    client.pushHierarchyToObservationStream(
      { hierarchy: {} },
      {
        updatedAt: 0,
        packageName: "com.example.ios",
        hierarchy: {},
        screenWidth: 320,
        screenHeight: 693,
        screenScale: 3,
      },
    );
    const boundLegacy = client.screenGeometry.bind();
    if (!boundLegacy) {
      throw new Error("Expected legacy geometry");
    }
    expect(boundLegacy.coordinateSpace).toBeUndefined();
    expect(boundLegacy.nativeScale).toBeUndefined();

    client.retainScaleMetadataFrom({
      nativeScale: 3,
      pixelWidth: 960,
      pixelHeight: 2079,
    });
    socket.reset();
    client.pushScreenshotToObservationStream({
      screenshotBase64: "c2hvdA==",
      screenWidth: boundLegacy.width,
      screenHeight: boundLegacy.height,
      metadata: undefined,
      captureSequence: boundLegacy.captureSequence,
      coordinateSpace: boundLegacy.coordinateSpace,
      nativeScale: boundLegacy.nativeScale,
    });
    const legacyShot = socket
      .getWrittenMessages(coordinateSpaceFrameSchema)
      .find((message) => message.type === "screenshot_update");
    expect(legacyShot?.coordinateSpace).toBeUndefined();
    expect(legacyShot?.nativeScale).toBeUndefined();
  });

  for (const [index, vector] of loadCoordinateMappingVectors().iosPointToPixel.entries()) {
    test(`maps live vector ${index} from points to canonical pixels`, async () => {
      await startStreamServer();
      const geometry = ctrlProxyClient.testHooks.screenGeometry;

      ctrlProxyClient.testHooks.pushHierarchyToObservationStream(
        { hierarchy: {} },
        {
          updatedAt: 0,
          packageName: "com.example.ios",
          hierarchy: {},
          screenWidth: vector.pointWidth,
          screenHeight: vector.pointHeight,
          ...(vector.scale === 0 ? {} : { screenScale: vector.scale }),
        },
      );

      const bound = geometry.bind();
      if (!bound) {
        throw new Error("Expected vector geometry");
      }
      expect(bound.width).toBe(vector.expectedPixelWidth);
      expect(bound.height).toBe(vector.expectedPixelHeight);
    });
  }
});
