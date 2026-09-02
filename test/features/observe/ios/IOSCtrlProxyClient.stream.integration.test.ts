import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import {
  startDeviceDataStreamSocketServer,
  stopDeviceDataStreamSocketServer,
} from "../../../../src/daemon/deviceDataStreamSocketServer";
import type { BootedDevice } from "../../../../src/models";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeSocket } from "../../../fakes/FakeNetServer";
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
    const server = await startDeviceDataStreamSocketServer(fakeTimer);
    const socket = new FakeSocket();
    await (
      server as unknown as {
        processLine(socket: FakeSocket, line: string): Promise<void>;
      }
    ).processLine(
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
  ): void => {
    (
      ctrlProxyClient as unknown as {
        pushHierarchyToObservationStream(
          hierarchy: { hierarchy: object },
          source: { screenWidth: number; screenHeight: number; screenScale: number },
        ): void;
      }
    ).pushHierarchyToObservationStream(
      { hierarchy: {} },
      { screenWidth, screenHeight, screenScale },
    );
  };

  const setStaleCache = (screenWidth: number, screenHeight: number, screenScale: number): void => {
    (
      ctrlProxyClient as unknown as {
        cachedHierarchy: {
          hierarchy: { screenWidth: number; screenHeight: number; screenScale: number };
          receivedAt: number;
          fresh: boolean;
        };
      }
    ).cachedHierarchy = {
      hierarchy: { screenWidth, screenHeight, screenScale },
      receivedAt: fakeTimer.now(),
      fresh: true,
    };
  };

  const receiveHierarchy = (data: Record<string, unknown>, requestId?: string): void => {
    (
      ctrlProxyClient as unknown as {
        processMessage(message: Record<string, unknown>): void;
      }
    ).processMessage({
      type: "hierarchy_update",
      ...(requestId ? { requestId } : {}),
      timestamp: fakeTimer.now(),
      data: { packageName: "com.example.ios", hierarchy: {}, ...data },
    });
  };

  test("derives geometry from the hierarchy being forwarded, not from the cache", async () => {
    await startStreamServer();
    const geometry = (
      ctrlProxyClient as unknown as {
        screenGeometry: {
          bind(): { captureSequence: number; width: number; height: number } | null;
        };
      }
    ).screenGeometry;

    forwardHierarchy(390, 844, 3);
    expect(geometry.bind()).toEqual({
      captureSequence: expect.any(Number),
      width: 1170,
      height: 2532,
    });

    setStaleCache(390, 844, 3);
    forwardHierarchy(320, 693, 3);

    const bound = geometry.bind();
    expect(bound).not.toBeNull();
    expect(bound?.width).toBe(960);
    expect(bound?.height).toBe(2079);
  });

  test("clears tracked geometry when the forwarded hierarchy reports none", async () => {
    await startStreamServer();
    const client = ctrlProxyClient as unknown as {
      screenGeometry: { bind(): unknown };
      pushHierarchyToObservationStream(hierarchy: { hierarchy: object }, source: object): void;
    };

    forwardHierarchy(390, 844, 3);
    expect(client.screenGeometry.bind()).not.toBeNull();

    setStaleCache(390, 844, 3);
    client.pushHierarchyToObservationStream({ hierarchy: {} }, {});
    expect(client.screenGeometry.bind()).toBeNull();
  });

  test("retains metadata when the observation-stream push is suppressed", async () => {
    await startStreamServer();
    const requestId = "req-suppressed-1";
    const client = ctrlProxyClient as unknown as {
      hierarchyObservationStreamSuppressions: Map<string, unknown>;
    };
    client.hierarchyObservationStreamSuppressions.set(
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

    expect(client.hierarchyObservationStreamSuppressions.has(requestId)).toBe(false);
    expect(ctrlProxyClient.getScreenScaleMetadata()).toEqual({
      nativeScale: 3.144,
      pixelWidth: 1179,
      pixelHeight: 2553,
    });
  });

  test("tracks canonical pixel geometry from native scale metadata", async () => {
    await startStreamServer();
    const geometry = (
      ctrlProxyClient as unknown as {
        screenGeometry: { bind(): { width: number; height: number } };
      }
    ).screenGeometry;

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
    expect(geometry.bind().width).toBe(1179);
    expect(geometry.bind().height).toBe(2553);
  });

  test("stamps screenshots from the request-time coordinate-space binding", async () => {
    const socket = await startStreamServer();
    const client = ctrlProxyClient as unknown as {
      screenGeometry: {
        bind(): {
          width: number;
          height: number;
          captureSequence: number;
          coordinateSpace?: "px";
          nativeScale?: number;
        };
      };
      reportedScaleMetadata: unknown;
      pushHierarchyToObservationStream(hierarchy: { hierarchy: object }, source: object): void;
      pushScreenshotToObservationStream(
        screenshot: string,
        width: number,
        height: number,
        rotation: undefined,
        captureSequence: number,
        coordinateSpace?: "px",
        nativeScale?: number,
      ): void;
    };

    client.pushHierarchyToObservationStream(
      { hierarchy: {} },
      {
        screenWidth: 375,
        screenHeight: 812,
        screenScale: 3,
        nativeScale: 3,
        pixelWidth: 1125,
        pixelHeight: 2436,
      },
    );
    const boundPx = client.screenGeometry.bind();
    expect(boundPx.coordinateSpace).toBe("px");
    expect(boundPx.nativeScale).toBe(3);

    client.reportedScaleMetadata = null;
    socket.reset();
    client.pushScreenshotToObservationStream(
      "c2hvdA==",
      boundPx.width,
      boundPx.height,
      undefined,
      boundPx.captureSequence,
      boundPx.coordinateSpace,
      boundPx.nativeScale,
    );
    const pxShot = socket
      .getWrittenMessages<{ type: string; coordinateSpace?: string; nativeScale?: number }>()
      .find((message) => message.type === "screenshot_update");
    expect(pxShot?.coordinateSpace).toBe("px");
    expect(pxShot?.nativeScale).toBe(3);

    client.pushHierarchyToObservationStream(
      { hierarchy: {} },
      { screenWidth: 320, screenHeight: 693, screenScale: 3 },
    );
    const boundLegacy = client.screenGeometry.bind();
    expect(boundLegacy.coordinateSpace).toBeUndefined();
    expect(boundLegacy.nativeScale).toBeUndefined();

    client.reportedScaleMetadata = {
      nativeScale: 3,
      pixelWidth: 960,
      pixelHeight: 2079,
    };
    socket.reset();
    client.pushScreenshotToObservationStream(
      "c2hvdA==",
      boundLegacy.width,
      boundLegacy.height,
      undefined,
      boundLegacy.captureSequence,
      boundLegacy.coordinateSpace,
      boundLegacy.nativeScale,
    );
    const legacyShot = socket
      .getWrittenMessages<{ type: string; coordinateSpace?: string; nativeScale?: number }>()
      .find((message) => message.type === "screenshot_update");
    expect(legacyShot?.coordinateSpace).toBeUndefined();
    expect(legacyShot?.nativeScale).toBeUndefined();
  });

  for (const [index, vector] of loadCoordinateMappingVectors().iosPointToPixel.entries()) {
    test(`maps live vector ${index} from points to canonical pixels`, async () => {
      await startStreamServer();
      const geometry = (
        ctrlProxyClient as unknown as {
          screenGeometry: { bind(): { width: number; height: number } };
        }
      ).screenGeometry;

      (
        ctrlProxyClient as unknown as {
          pushHierarchyToObservationStream(
            hierarchy: { hierarchy: object },
            source: Record<string, number>,
          ): void;
        }
      ).pushHierarchyToObservationStream(
        { hierarchy: {} },
        {
          screenWidth: vector.pointWidth,
          screenHeight: vector.pointHeight,
          ...(vector.scale === 0 ? {} : { screenScale: vector.scale }),
        },
      );

      expect(geometry.bind().width).toBe(vector.expectedPixelWidth);
      expect(geometry.bind().height).toBe(vector.expectedPixelHeight);
    });
  }
});
