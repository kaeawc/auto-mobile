import { describe, expect, it } from "bun:test";
import {
  pushInitialObservationFramesForSubscriber,
  type ObservationStreamAndroidClient,
  type ObservationStreamDevice,
  type ObservationStreamIosClient,
} from "../../src/daemon/observationInitialFrame";
import type { ViewHierarchyResult } from "../../src/models";
import type {
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
} from "../../src/features/observe/android";
import type { ScreenshotCaptureResult } from "../../src/features/observe/ScreenshotBackoffScheduler";
import type {
  CtrlProxyHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxyScreenshotResult,
} from "../../src/features/observe/ios/types";
import { loadCoordinateMappingVectors } from "../parity/coordinateMappingGoldenVectors";

class FakeObservationStreamServer {
  constructor(private readonly captureSequence: number | null = null) {}

  readonly hierarchyUpdates: Array<{
    deviceId: string;
    hierarchy: ViewHierarchyResult;
    frameContext?: string;
  }> = [];
  readonly screenshotUpdates: ScreenshotUpdate[] = [];

  pushHierarchyUpdate(
    deviceId: string,
    hierarchy: ViewHierarchyResult,
    frameContext?: string,
  ): number | null {
    this.hierarchyUpdates.push({
      deviceId,
      hierarchy,
      ...(frameContext === undefined ? {} : { frameContext }),
    });
    return this.captureSequence;
  }

  pushScreenshotUpdate(
    deviceId: string,
    screenshotBase64: string,
    screenWidth: number,
    screenHeight: number,
    metadata?: Record<string, unknown>,
    options?: {
      captureSequence?: number;
      coordinateSpace?: "px";
      nativeScale?: number;
      frameContext?: string;
      rotation?: number;
    },
  ): void {
    const screenshotOptions =
      options?.captureSequence === undefined && options?.rotation === undefined
        ? undefined
        : options;
    this.screenshotUpdates.push({
      deviceId,
      screenshotBase64,
      screenWidth,
      screenHeight,
      ...(metadata === undefined ? {} : { metadata }),
      ...(options?.coordinateSpace === undefined
        ? {}
        : { coordinateSpace: options.coordinateSpace }),
      ...(options?.nativeScale === undefined ? {} : { nativeScale: options.nativeScale }),
      ...(screenshotOptions === undefined ? {} : { options: screenshotOptions }),
      ...(options?.frameContext === undefined ? {} : { frameContext: options.frameContext }),
    });
  }
}

interface ScreenshotUpdate {
  deviceId: string;
  screenshotBase64: string;
  screenWidth: number;
  screenHeight: number;
  metadata?: Record<string, unknown>;
  coordinateSpace?: "px";
  nativeScale?: number;
  options?: { captureSequence?: number; rotation?: number };
  frameContext?: string;
}

class FakeAndroidInitialFrameClient implements ObservationStreamAndroidClient {
  readonly latestHierarchyCalls: Array<{
    waitForFresh?: boolean;
    timeout?: number;
    skipWaitForFresh?: boolean;
  }> = [];
  readonly suppressedSyncHierarchyCalls: Array<{ timeoutMs?: number }> = [];
  readonly forwardedInitialHierarchies: Array<{
    hierarchy: ViewHierarchyResult;
    captureSequence: number | null;
  }> = [];
  observationScreenshotCallCount = 0;

  constructor(
    private readonly connected: boolean,
    private readonly latestHierarchy: AccessibilityHierarchy | null,
    private readonly syncHierarchy: AccessibilityHierarchy | null = latestHierarchy,
    private readonly latestHierarchyFresh: boolean = true,
    private readonly screenshot: ScreenshotCaptureResult = {
      success: true,
      data: "android-shot",
      screenshotMimeType: "image/jpeg",
      screenshotFormat: "jpeg",
      screenshotCaptureSource: "android_ctrlproxy_a11y",
      screenshotFallback: false,
    },
  ) {}

  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }

  async getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    _perf?: unknown,
    skipWaitForFresh?: boolean,
  ): Promise<AccessibilityHierarchyResponse> {
    this.latestHierarchyCalls.push({ waitForFresh, timeout, skipWaitForFresh });
    return {
      hierarchy: this.latestHierarchy,
      fresh: this.latestHierarchyFresh,
      updatedAt: this.latestHierarchy?.updatedAt,
    };
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    _perf?: unknown,
    _disableAllFiltering?: boolean,
    _signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: AccessibilityHierarchy } | null> {
    this.suppressedSyncHierarchyCalls.push({ timeoutMs });
    return this.syncHierarchy ? { hierarchy: this.syncHierarchy } : null;
  }

  convertToViewHierarchyResult(hierarchy: AccessibilityHierarchy): ViewHierarchyResult {
    return {
      hierarchy: { node: hierarchy.hierarchy },
      packageName: hierarchy.packageName,
      updatedAt: hierarchy.updatedAt,
      screenWidth: hierarchy.screenWidth,
      screenHeight: hierarchy.screenHeight,
      ...("frameContext" in hierarchy && typeof hierarchy.frameContext === "string"
        ? { frameContext: hierarchy.frameContext }
        : {}),
    };
  }

  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void {
    this.forwardedInitialHierarchies.push({ hierarchy, captureSequence });
  }

  async captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult> {
    this.observationScreenshotCallCount += 1;
    return this.screenshot;
  }
}

class FakeIosInitialFrameClient implements ObservationStreamIosClient {
  readonly syncHierarchyCalls: Array<{ timeoutMs?: number }> = [];
  readonly suppressedSyncHierarchyCalls: Array<{ timeoutMs?: number }> = [];
  readonly suppressedScreenshotCalls: Array<{ timeoutMs?: number }> = [];
  readonly forwardedInitialHierarchies: Array<{
    hierarchy: ViewHierarchyResult;
    captureSequence: number | null;
  }> = [];

  constructor(
    private readonly connected: boolean,
    private readonly latestHierarchy: CtrlProxyHierarchy | null,
    private readonly syncHierarchy: CtrlProxyHierarchy | null = latestHierarchy,
    private readonly screenshot: CtrlProxyScreenshotResult = {
      success: true,
      data: "ios-shot",
      format: "png",
    },
    private readonly latestHierarchyFresh: boolean = true,
  ) {}

  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }

  async getLatestHierarchy(): Promise<CtrlProxyHierarchyResponse> {
    return {
      hierarchy: this.latestHierarchy,
      fresh: this.latestHierarchyFresh,
      updatedAt: this.latestHierarchy?.updatedAt,
    };
  }

  async requestHierarchySync(
    _perf?: unknown,
    _disableAllFiltering?: boolean,
    _signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: CtrlProxyHierarchy } | null> {
    this.syncHierarchyCalls.push({ timeoutMs });
    return this.syncHierarchy ? { hierarchy: this.syncHierarchy } : null;
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    _perf?: unknown,
    _disableAllFiltering?: boolean,
    _signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: CtrlProxyHierarchy } | null> {
    this.suppressedSyncHierarchyCalls.push({ timeoutMs });
    return this.syncHierarchy ? { hierarchy: this.syncHierarchy } : null;
  }

  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult {
    const typedHierarchy = hierarchy as CtrlProxyHierarchy & {
      nativeScale?: number;
      pixelWidth?: number;
      pixelHeight?: number;
    };
    return {
      hierarchy: { node: { $: { text: typedHierarchy.hierarchy.text } } },
      packageName: typedHierarchy.packageName,
      updatedAt: typedHierarchy.updatedAt,
      screenWidth: typedHierarchy.screenWidth,
      screenHeight: typedHierarchy.screenHeight,
      screenScale: typedHierarchy.screenScale,
      // Additive #4548 scale metadata, mirroring the real converter's spread — so the daemon's
      // canonical-pixel path (#4549) is exercised when the runner supplied it.
      ...(typedHierarchy.nativeScale === undefined
        ? {}
        : { nativeScale: typedHierarchy.nativeScale }),
      ...(typedHierarchy.pixelWidth === undefined ? {} : { pixelWidth: typedHierarchy.pixelWidth }),
      ...(typedHierarchy.pixelHeight === undefined
        ? {}
        : { pixelHeight: typedHierarchy.pixelHeight }),
      rotation: typedHierarchy.rotation,
      ...("frameContext" in typedHierarchy && typeof typedHierarchy.frameContext === "string"
        ? { frameContext: typedHierarchy.frameContext }
        : {}),
    };
  }

  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void {
    this.forwardedInitialHierarchies.push({ hierarchy, captureSequence });
  }

  async requestScreenshot(): Promise<CtrlProxyScreenshotResult> {
    return this.screenshot;
  }

  async requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
  ): Promise<CtrlProxyScreenshotResult> {
    this.suppressedScreenshotCalls.push({ timeoutMs });
    return this.screenshot;
  }
}

describe("pushInitialObservationFramesForSubscriber", () => {
  const androidDevice: ObservationStreamDevice = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
  };
  const iosDevice: ObservationStreamDevice = {
    id: "ios-sim-1",
    name: "iPhone",
    platform: "ios",
  };

  it("pushes current Android hierarchy and screenshot after subscriber connects", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(true, {
      updatedAt: 123,
      packageName: "com.example",
      screenWidth: 1440,
      screenHeight: 3120,
      hierarchy: { text: "Home", bounds: { left: 0, top: 0, right: 1440, bottom: 3120 } },
    });

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.hierarchyUpdates).toEqual([
      {
        deviceId: androidDevice.id,
        hierarchy: {
          hierarchy: {
            node: { text: "Home", bounds: { left: 0, top: 0, right: 1440, bottom: 3120 } },
          },
          packageName: "com.example",
          updatedAt: 123,
          screenWidth: 1440,
          screenHeight: 3120,
        },
      },
    ]);
    expect(streamServer.screenshotUpdates).toEqual([
      {
        deviceId: androidDevice.id,
        screenshotBase64: "android-shot",
        screenWidth: 1440,
        screenHeight: 3120,
        metadata: {
          screenshotMimeType: "image/jpeg",
          screenshotFormat: "jpeg",
          screenshotCaptureSource: "android_ctrlproxy_a11y",
          screenshotFallback: false,
        },
      },
    ]);
    expect(androidClient.latestHierarchyCalls).toEqual([
      { waitForFresh: false, timeout: 3000, skipWaitForFresh: true },
    ]);
    expect(androidClient.suppressedSyncHierarchyCalls).toHaveLength(0);
    expect(androidClient.observationScreenshotCallCount).toBe(1);
  });

  it("binds the Android initial screenshot and later keepalives to its forwarded hierarchy", async () => {
    const streamServer = new FakeObservationStreamServer(41);
    const androidClient = new FakeAndroidInitialFrameClient(true, {
      updatedAt: 123,
      packageName: "com.example",
      screenWidth: 1440,
      screenHeight: 3120,
      hierarchy: { text: "Static screen" },
    });

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.screenshotUpdates[0].options).toEqual({ captureSequence: 41 });
    expect(androidClient.forwardedInitialHierarchies).toEqual([
      {
        hierarchy: streamServer.hierarchyUpdates[0].hierarchy,
        captureSequence: 41,
      },
    ]);
  });

  it("keeps Android initial-frame geometry fail-closed when no identity is assigned", async () => {
    const streamServer = new FakeObservationStreamServer(null);
    const androidClient = new FakeAndroidInitialFrameClient(true, {
      updatedAt: 123,
      packageName: "com.example",
      screenWidth: 1440,
      screenHeight: 3120,
      hierarchy: { text: "Legacy runner" },
    });

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.screenshotUpdates[0].options).toBeUndefined();
    expect(androidClient.forwardedInitialHierarchies[0].captureSequence).toBeNull();
  });

  it("forwards proven Android initial-frame contexts", async () => {
    const streamServer = new FakeObservationStreamServer(43);
    const androidClient = new FakeAndroidInitialFrameClient(
      true,
      {
        updatedAt: 123,
        packageName: "com.example",
        screenWidth: 1440,
        screenHeight: 3120,
        hierarchy: { text: "Home" },
        frameContext: "android-hierarchy",
      } as any,
      undefined,
      true,
      {
        success: true,
        data: "android-shot",
        frameContext: "android-hierarchy",
      },
    );

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.hierarchyUpdates[0].frameContext).toBe("android-hierarchy");
    expect(streamServer.screenshotUpdates[0].frameContext).toBe("android-hierarchy");
    expect(streamServer.screenshotUpdates[0].options).toMatchObject({ captureSequence: 43 });
  });

  it("omits the Android initial capture sequence when frame contexts conflict", async () => {
    const streamServer = new FakeObservationStreamServer(43);
    const androidClient = new FakeAndroidInitialFrameClient(
      true,
      {
        updatedAt: 123,
        packageName: "com.example",
        screenWidth: 1440,
        screenHeight: 3120,
        hierarchy: { text: "Screen A" },
        frameContext: "android-screen-a",
      } as any,
      undefined,
      true,
      {
        success: true,
        data: "android-shot",
        frameContext: "android-screen-b",
      },
    );

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.screenshotUpdates[0].options).toBeUndefined();
    expect(streamServer.screenshotUpdates[0].frameContext).toBe("android-screen-b");
  });

  it("pushes Android initial ADB fallback screenshots with fallback metadata", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(
      true,
      {
        updatedAt: 123,
        packageName: "com.example",
        screenWidth: 1440,
        screenHeight: 3120,
        hierarchy: { text: "Home", bounds: { left: 0, top: 0, right: 1440, bottom: 3120 } },
      },
      undefined,
      true,
      {
        success: true,
        data: "android-adb-shot",
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
        screenshotCaptureSource: "android_adb_screencap",
        screenshotFallback: true,
        screenshotFallbackReason: "websocket_unavailable",
      },
    );

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.screenshotUpdates).toEqual([
      {
        deviceId: androidDevice.id,
        screenshotBase64: "android-adb-shot",
        screenWidth: 1440,
        screenHeight: 3120,
        metadata: {
          screenshotMimeType: "image/png",
          screenshotFormat: "png",
          screenshotCaptureSource: "android_adb_screencap",
          screenshotFallback: true,
          screenshotFallbackReason: "websocket_unavailable",
        },
      },
    ]);
  });

  it("pushes Android initial CtrlProxy screenshots with performance metadata", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(
      true,
      {
        updatedAt: 123,
        packageName: "com.example",
        screenWidth: 1440,
        screenHeight: 3120,
        hierarchy: { text: "Home", bounds: { left: 0, top: 0, right: 1440, bottom: 3120 } },
      },
      undefined,
      true,
      {
        success: true,
        data: "android-shot",
        screenshotMimeType: "image/jpeg",
        screenshotFormat: "jpeg",
        screenshotCaptureSource: "android_ctrlproxy_a11y",
        screenshotFallback: false,
        screenshotCaptureDurationMs: 42,
        screenshotEncodeDurationMs: 7,
        screenshotByteLength: 1200,
        screenshotBase64Length: 1600,
      },
    );

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.screenshotUpdates).toEqual([
      {
        deviceId: androidDevice.id,
        screenshotBase64: "android-shot",
        screenWidth: 1440,
        screenHeight: 3120,
        metadata: {
          screenshotMimeType: "image/jpeg",
          screenshotFormat: "jpeg",
          screenshotCaptureSource: "android_ctrlproxy_a11y",
          screenshotFallback: false,
          screenshotCaptureDurationMs: 42,
          screenshotEncodeDurationMs: 7,
          screenshotByteLength: 1200,
          screenshotBase64Length: 1600,
        },
      },
    ]);
  });

  it("captures Android hierarchy without an automatic stream push when the initial cache is empty", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(true, null, {
      updatedAt: 789,
      packageName: "com.example",
      screenWidth: 720,
      screenHeight: 1280,
      hierarchy: { text: "Cold start" },
    });

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(androidClient.latestHierarchyCalls).toEqual([
      { waitForFresh: false, timeout: 3000, skipWaitForFresh: true },
    ]);
    expect(androidClient.suppressedSyncHierarchyCalls).toEqual([{ timeoutMs: 3000 }]);
    expect(androidClient.observationScreenshotCallCount).toBe(1);
    expect(streamServer.hierarchyUpdates[0].hierarchy.updatedAt).toBe(789);
    expect(streamServer.screenshotUpdates[0]).toMatchObject({
      deviceId: androidDevice.id,
      screenWidth: 720,
      screenHeight: 1280,
    });
  });

  it("does not seed Android subscribers from stale cached hierarchy", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(
      true,
      {
        updatedAt: 100,
        packageName: "com.example",
        screenWidth: 720,
        screenHeight: 1280,
        hierarchy: { text: "Stale" },
      },
      {
        updatedAt: 200,
        packageName: "com.example",
        screenWidth: 720,
        screenHeight: 1280,
        hierarchy: { text: "Fresh sync" },
      },
      false,
    );

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(androidClient.suppressedSyncHierarchyCalls).toEqual([{ timeoutMs: 3000 }]);
    expect(streamServer.hierarchyUpdates[0].hierarchy.updatedAt).toBe(200);
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toMatchObject({
      text: "Fresh sync",
    });
  });

  it("pushes iOS screenshot dimensions in pixels using screen scale", async () => {
    const streamServer = new FakeObservationStreamServer();
    const iosClient = new FakeIosInitialFrameClient(
      true,
      {
        updatedAt: 456,
        packageName: "com.example.ios",
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        rotation: 1,
        hierarchy: { text: "Home" },
      },
      undefined,
      { success: true, data: "ios-shot", format: "png", rotation: 1 },
    );

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.hierarchyUpdates).toHaveLength(1);
    expect(streamServer.hierarchyUpdates[0].deviceId).toBe(iosDevice.id);
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toEqual({
      $: { text: "Home" },
    });
    expect(streamServer.screenshotUpdates).toEqual([
      {
        deviceId: iosDevice.id,
        screenshotBase64: "ios-shot",
        screenWidth: 1170,
        screenHeight: 2532,
        metadata: {
          screenshotMimeType: "image/png",
          screenshotFormat: "png",
          screenshotCaptureSource: "ios_ctrlproxy",
          screenshotFallback: false,
        },
        options: { rotation: 1 },
      },
    ]);
    expect(iosClient.syncHierarchyCalls).toHaveLength(0);
    expect(iosClient.suppressedSyncHierarchyCalls).toHaveLength(0);
    expect(iosClient.suppressedScreenshotCalls).toEqual([{ timeoutMs: 3000 }]);
  });

  it("binds the iOS initial screenshot and later keepalives to its forwarded hierarchy", async () => {
    const streamServer = new FakeObservationStreamServer(42);
    const iosClient = new FakeIosInitialFrameClient(true, {
      updatedAt: 456,
      packageName: "com.example.ios",
      screenWidth: 390,
      screenHeight: 844,
      screenScale: 3,
      hierarchy: { text: "Static screen" },
    });

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.screenshotUpdates[0].options).toEqual({ captureSequence: 42 });
    expect(iosClient.forwardedInitialHierarchies).toEqual([
      {
        hierarchy: streamServer.hierarchyUpdates[0].hierarchy,
        captureSequence: 42,
      },
    ]);
  });

  it("keeps iOS initial-frame geometry fail-closed when no identity is assigned", async () => {
    const streamServer = new FakeObservationStreamServer(null);
    const iosClient = new FakeIosInitialFrameClient(true, {
      updatedAt: 456,
      packageName: "com.example.ios",
      screenWidth: 390,
      screenHeight: 844,
      screenScale: 3,
      hierarchy: { text: "Legacy runner" },
    });

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.screenshotUpdates[0].options).toBeUndefined();
    expect(iosClient.forwardedInitialHierarchies[0].captureSequence).toBeNull();
  });

  it("forwards proven iOS initial-frame contexts", async () => {
    const streamServer = new FakeObservationStreamServer(44);
    const iosClient = new FakeIosInitialFrameClient(
      true,
      {
        updatedAt: 456,
        packageName: "com.example.ios",
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        hierarchy: { text: "Home" },
        frameContext: "ios-hierarchy",
      } as any,
      undefined,
      { success: true, data: "ios-shot", format: "png", frameContext: "ios-hierarchy" },
    );

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.hierarchyUpdates[0].frameContext).toBe("ios-hierarchy");
    expect(streamServer.screenshotUpdates[0].frameContext).toBe("ios-hierarchy");
    expect(streamServer.screenshotUpdates[0].options).toMatchObject({ captureSequence: 44 });
  });

  it("omits the iOS initial capture sequence when frame contexts conflict", async () => {
    const streamServer = new FakeObservationStreamServer(44);
    const iosClient = new FakeIosInitialFrameClient(
      true,
      {
        updatedAt: 456,
        packageName: "com.example.ios",
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        hierarchy: { text: "Screen A" },
        frameContext: "ios-screen-a",
      } as any,
      undefined,
      { success: true, data: "ios-shot", format: "png", frameContext: "ios-screen-b" },
    );

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.screenshotUpdates[0].options).toBeUndefined();
    expect(streamServer.screenshotUpdates[0].frameContext).toBe("ios-screen-b");
  });

  it("captures iOS hierarchy synchronously when the initial cache is empty", async () => {
    const streamServer = new FakeObservationStreamServer();
    const iosClient = new FakeIosInitialFrameClient(true, null, {
      updatedAt: 987,
      packageName: "com.example.ios",
      screenWidth: 400,
      screenHeight: 800,
      screenScale: 2,
      hierarchy: { text: "Cold start" },
    });

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(iosClient.syncHierarchyCalls).toHaveLength(0);
    expect(iosClient.suppressedSyncHierarchyCalls).toEqual([{ timeoutMs: 3000 }]);
    expect(streamServer.hierarchyUpdates[0].hierarchy.updatedAt).toBe(987);
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toEqual({
      $: { text: "Cold start" },
    });
    expect(streamServer.screenshotUpdates[0]).toMatchObject({
      deviceId: iosDevice.id,
      screenWidth: 800,
      screenHeight: 1600,
    });
  });

  it("forwards the synchronous iOS hierarchy context when the initial cache is empty", async () => {
    const streamServer = new FakeObservationStreamServer();
    const iosClient = new FakeIosInitialFrameClient(true, null, {
      updatedAt: 789,
      packageName: "com.example",
      screenWidth: 390,
      screenHeight: 844,
      screenScale: 3,
      hierarchy: { text: "Cold start" },
      frameContext: "ios-sync",
    } as any);

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.hierarchyUpdates[0].frameContext).toBe("ios-sync");
  });

  it("does not seed iOS subscribers from stale cached hierarchy", async () => {
    const streamServer = new FakeObservationStreamServer();
    const iosClient = new FakeIosInitialFrameClient(
      true,
      {
        updatedAt: 100,
        packageName: "com.example.ios",
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        hierarchy: { text: "Stale" },
      },
      {
        updatedAt: 200,
        packageName: "com.example.ios",
        screenWidth: 390,
        screenHeight: 844,
        screenScale: 3,
        hierarchy: { text: "Fresh sync" },
      },
      { success: true, data: "ios-shot" },
      false,
    );

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(iosClient.syncHierarchyCalls).toHaveLength(0);
    expect(iosClient.suppressedSyncHierarchyCalls).toEqual([{ timeoutMs: 3000 }]);
    expect(streamServer.hierarchyUpdates[0].hierarchy.updatedAt).toBe(200);
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toEqual({
      $: { text: "Fresh sync" },
    });
  });

  it("honors a device-specific subscription filter", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(true, {
      updatedAt: 1,
      packageName: "com.example",
      screenWidth: 100,
      screenHeight: 200,
      hierarchy: { text: "Android" },
    });

    await pushInitialObservationFramesForSubscriber(androidDevice.id, [androidDevice, iosDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("filtered iOS device should not connect");
      },
    });

    expect(streamServer.hierarchyUpdates.map((update) => update.deviceId)).toEqual([
      androidDevice.id,
    ]);
    expect(streamServer.screenshotUpdates.map((update) => update.deviceId)).toEqual([
      androidDevice.id,
    ]);
  });

  describe("coordinate-mapping golden vectors: iOS point->pixel (issue #4547)", () => {
    // Cross-language golden suite, B0/B2 of the canonical-pixel campaign (#4547 -> #4549). Each
    // vector drives the daemon's REAL iOS screenshot-dimension publishing (getIosScreenshotDimensions
    // via pushInitialObservationFramesForSubscriber). Under #4549, when the runner supplies complete
    // scale metadata (nativeScale + reported pixelWidth/pixelHeight), the daemon publishes those
    // physical pixel dimensions DIRECTLY — the old points*screenScale multiply disappears — and
    // stamps coordinateSpace:"px". A row with scale=0 encodes a pre-#4548 runner (no metadata): the
    // daemon falls back to the legacy round(points * 1) point-space claim and does NOT stamp px.
    // (The per-element point->pixel bounds conversion these same vectors drive lives in
    // test/daemon/canonicalPixels.test.ts.)
    const vectors = loadCoordinateMappingVectors().iosPointToPixel;

    for (const [index, vector] of vectors.entries()) {
      const hasMetadata = vector.scale !== 0;
      it(`row ${index}: ${vector.pointWidth}x${vector.pointHeight} @ ${vector.scale || "no-metadata"} -> ${vector.expectedPixelWidth}x${vector.expectedPixelHeight} px${hasMetadata ? " (px-stamped)" : " (legacy)"}`, async () => {
        const streamServer = new FakeObservationStreamServer();
        const iosClient = new FakeIosInitialFrameClient(true, {
          updatedAt: 1,
          packageName: "com.example.ios",
          screenWidth: vector.pointWidth,
          screenHeight: vector.pointHeight,
          // A real runner reports nativeScale + the derived pixel dims. scale=0 == pre-#4548 runner:
          // no metadata, so the daemon takes the legacy path and never stamps px.
          ...(hasMetadata
            ? {
                screenScale: vector.scale,
                nativeScale: vector.scale,
                pixelWidth: vector.expectedPixelWidth,
                pixelHeight: vector.expectedPixelHeight,
              }
            : {}),
          hierarchy: { text: "Golden" },
        } as any);

        await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
          streamServer,
          androidClientFactory: () => {
            throw new Error("unexpected Android client");
          },
          iosClientFactory: () => iosClient,
        });

        expect(streamServer.screenshotUpdates[0]).toMatchObject({
          deviceId: iosDevice.id,
          screenWidth: vector.expectedPixelWidth,
          screenHeight: vector.expectedPixelHeight,
        });
        // The px declaration is gated on runner metadata: present == canonical pixels declared,
        // absent (legacy runner) == no field so the client keeps its point-space fallback.
        expect(streamServer.screenshotUpdates[0].coordinateSpace).toBe(
          hasMetadata ? "px" : undefined,
        );
        expect(streamServer.screenshotUpdates[0].nativeScale).toBe(
          hasMetadata ? vector.scale : undefined,
        );
      });
    }
  });

  it("does not push an initial frame when connection fails", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(false, {
      updatedAt: 1,
      packageName: "com.example",
      hierarchy: { text: "Home" },
    });

    await pushInitialObservationFramesForSubscriber(null, [androidDevice], {
      streamServer,
      androidClientFactory: () => androidClient,
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.hierarchyUpdates).toHaveLength(0);
    expect(streamServer.screenshotUpdates).toHaveLength(0);
    expect(androidClient.latestHierarchyCalls).toHaveLength(0);
  });
});
