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
import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";
import { createIosScreenSourceForTest, emptyViewHierarchyForTest } from "./iosStreamTestBuilders";
import { loadCoordinateMappingVectors } from "../../../parity/coordinateMappingGoldenVectors";

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
    ctrlProxyClient = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer,
    );
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
    const source = createIosScreenSourceForTest({ screenWidth, screenHeight, screenScale });
    ctrlProxyClient["pushHierarchyToObservationStream"](emptyViewHierarchyForTest(), source);
    return source;
  };

  const setStaleCache = (screenWidth: number, screenHeight: number, screenScale: number): void => {
    ctrlProxyClient["cachedHierarchy"] = {
      hierarchy: createIosScreenSourceForTest({ screenWidth, screenHeight, screenScale }),
      receivedAt: fakeTimer.now(),
      fresh: true,
    };
  };

  const receiveHierarchy = (data: Partial<XCTestHierarchy>, requestId?: string): void => {
    ctrlProxyClient["processMessage"]({
      type: "hierarchy_update",
      ...(requestId ? { requestId } : {}),
      timestamp: fakeTimer.now(),
      data: createIosScreenSourceForTest({
        packageName: "com.example.ios",
        hierarchy: {},
        ...data,
      }),
    });
  };

  test("derives geometry from the hierarchy being forwarded, not from the cache", async () => {
    await startStreamServer();
    const geometry = ctrlProxyClient["screenGeometry"];

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
    const client = ctrlProxyClient;

    forwardHierarchy(390, 844, 3);
    expect(client["screenGeometry"].bind()).not.toBeNull();

    setStaleCache(390, 844, 3);
    client["pushHierarchyToObservationStream"](
      emptyViewHierarchyForTest(),
      createIosScreenSourceForTest(),
    );
    expect(client["screenGeometry"].bind()).toBeNull();
  });

  test("retains metadata when the observation-stream push is suppressed", async () => {
    await startStreamServer();
    const requestId = "req-suppressed-1";
    const client = ctrlProxyClient;
    client["hierarchyObservationStreamSuppressions"].set(
      requestId,
      fakeTimer.setTimeout(() => {}, 10_000),
    );

    receiveHierarchy(
      {
        screenWidth: 375,
        screenHeight: 812,
        screenScale: 3,
        nativeScale: 3.144,
        pixelWidth: 1179,
        pixelHeight: 2553,
      },
      requestId,
    );

    expect(client["hierarchyObservationStreamSuppressions"].has(requestId)).toBe(false);
    expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual({
      nativeScale: 3.144,
      pixelWidth: 1179,
      pixelHeight: 2553,
    });
  });

  test("tracks canonical pixel geometry from native scale metadata", async () => {
    await startStreamServer();
    const geometry = ctrlProxyClient["screenGeometry"];

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
    expect(geometry.bind()?.width).toBe(1179);
    expect(geometry.bind()?.height).toBe(2553);
  });

  test("stamps screenshots from the request-time coordinate-space binding", async () => {
    const socket = await startStreamServer();
    const client = ctrlProxyClient;

    client["pushHierarchyToObservationStream"](
      emptyViewHierarchyForTest(),
      createIosScreenSourceForTest({
        screenWidth: 375,
        screenHeight: 812,
        screenScale: 3,
        nativeScale: 3,
        pixelWidth: 1125,
        pixelHeight: 2436,
      }),
    );
    const boundPx = client["screenGeometry"].bind();
    if (!boundPx) {
      throw new Error("expected a bound coordinate space");
    }
    expect(boundPx.coordinateSpace).toBe("px");
    expect(boundPx.nativeScale).toBe(3);

    client["reportedScaleMetadata"] = null;
    socket.reset();
    client["pushScreenshotToObservationStream"]({
      screenshotBase64: "c2hvdA==",
      screenWidth: boundPx.width,
      screenHeight: boundPx.height,
      metadata: undefined,
      captureSequence: boundPx.captureSequence,
      coordinateSpace: boundPx.coordinateSpace,
      nativeScale: boundPx.nativeScale,
    });
    const pxShot = socket
      .getWrittenMessages<{ type: string; coordinateSpace?: string; nativeScale?: number }>()
      .find((message) => message.type === "screenshot_update");
    expect(pxShot?.coordinateSpace).toBe("px");
    expect(pxShot?.nativeScale).toBe(3);

    client["pushHierarchyToObservationStream"](
      emptyViewHierarchyForTest(),
      createIosScreenSourceForTest({ screenWidth: 320, screenHeight: 693, screenScale: 3 }),
    );
    const boundLegacy = client["screenGeometry"].bind();
    if (!boundLegacy) {
      throw new Error("expected a bound coordinate space");
    }
    expect(boundLegacy.coordinateSpace).toBeUndefined();
    expect(boundLegacy.nativeScale).toBeUndefined();

    client["reportedScaleMetadata"] = {
      nativeScale: 3,
      pixelWidth: 960,
      pixelHeight: 2079,
    };
    socket.reset();
    client["pushScreenshotToObservationStream"]({
      screenshotBase64: "c2hvdA==",
      screenWidth: boundLegacy.width,
      screenHeight: boundLegacy.height,
      metadata: undefined,
      captureSequence: boundLegacy.captureSequence,
      coordinateSpace: boundLegacy.coordinateSpace,
      nativeScale: boundLegacy.nativeScale,
    });
    const legacyShot = socket
      .getWrittenMessages<{ type: string; coordinateSpace?: string; nativeScale?: number }>()
      .find((message) => message.type === "screenshot_update");
    expect(legacyShot?.coordinateSpace).toBeUndefined();
    expect(legacyShot?.nativeScale).toBeUndefined();
  });

  for (const [index, vector] of loadCoordinateMappingVectors().iosPointToPixel.entries()) {
    test(`maps live vector ${index} from points to canonical pixels`, async () => {
      await startStreamServer();
      const geometry = ctrlProxyClient["screenGeometry"];

      ctrlProxyClient["pushHierarchyToObservationStream"](
        emptyViewHierarchyForTest(),
        createIosScreenSourceForTest({
          screenWidth: vector.pointWidth,
          screenHeight: vector.pointHeight,
          ...(vector.scale === 0 ? {} : { screenScale: vector.scale }),
        }),
      );

      expect(geometry.bind()?.width).toBe(vector.expectedPixelWidth);
      expect(geometry.bind()?.height).toBe(vector.expectedPixelHeight);
    });
  }
});
