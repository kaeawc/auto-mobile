import { describe, expect, it, spyOn } from "bun:test";
import {
  pushInitialObservationFramesForSubscriber,
  selectObservationStreamDevices,
  type ObservationStreamAndroidClient,
  type ObservationStreamDevice,
  type ObservationStreamIosClient,
} from "../../src/daemon/observationInitialFrame";
import {
  DefaultObservationInitialFrameCoordinator,
  INITIAL_FRAME_FRESHNESS_WINDOW_MS,
} from "../../src/daemon/observationInitialFrameCoordinator";
import type { InitialFrameSubscriber } from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
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
import { PassiveWorkPolicy, parsePassiveWorkSettings } from "../../src/daemon/PassiveWorkPolicy";

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
      initialFrameSubscriber?: InitialFrameSubscriber;
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class DeferredConnectionAndroidClient extends FakeAndroidInitialFrameClient {
  constructor(private readonly connect: () => Promise<boolean>) {
    super(true, {
      updatedAt: 1,
      packageName: "com.example",
      screenWidth: 100,
      screenHeight: 200,
      hierarchy: { text: "Android" },
    });
  }

  override ensureConnected(): Promise<boolean> {
    return this.connect();
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

  it("selects only owned or allowlisted devices for the observation stream", () => {
    const allowlisted: ObservationStreamDevice = {
      id: "ios-sim-2",
      name: "Allowlisted iPhone",
      platform: "ios",
    };
    const unowned: ObservationStreamDevice = {
      id: "ios-sim-3",
      name: "Unowned iPhone",
      platform: "ios",
    };
    const devices = [iosDevice, allowlisted, unowned];
    const skipped: ObservationStreamDevice[] = [];
    const policyFor = (env: NodeJS.ProcessEnv) =>
      new PassiveWorkPolicy(
        parsePassiveWorkSettings(env, "AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET"),
        (id) => id === iosDevice.id,
      );
    const select = (policy: PassiveWorkPolicy) =>
      selectObservationStreamDevices(devices, policy, (device) => skipped.push(device));

    expect(select(policyFor({})).map((device) => device.id)).toEqual([iosDevice.id]);
    expect(skipped.map((device) => device.id)).toEqual([allowlisted.id, unowned.id]);

    skipped.length = 0;
    expect(
      select(policyFor({ AUTOMOBILE_IOS_WARMUP_DEVICES: allowlisted.id })).map(
        (device) => device.id,
      ),
    ).toEqual([iosDevice.id, allowlisted.id]);
    expect(skipped.map((device) => device.id)).toEqual([unowned.id]);

    skipped.length = 0;
    expect(
      select(
        policyFor({
          AUTOMOBILE_IOS_WARMUP_DEVICES: allowlisted.id,
          AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET: "acceptance-secret",
        }),
      ),
    ).toEqual([]);
    expect(skipped.map((device) => device.id)).toEqual(devices.map((device) => device.id));
  });

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

  it("bounds simultaneous captures and eventually delivers frames for every device", async () => {
    const streamServer = new FakeObservationStreamServer();
    const devices = Array.from({ length: 5 }, (_, index): ObservationStreamDevice => ({
      id: `android-${index}`,
      name: `Pixel ${index}`,
      platform: "android",
    }));
    const gates = devices.map(() => deferred<boolean>());
    const starts = devices.map(() => deferred<void>());
    let active = 0;
    let peak = 0;
    let started = 0;

    const capture = pushInitialObservationFramesForSubscriber(null, devices, {
      streamServer,
      androidClientFactory: () => {
        const index = started++;
        return new DeferredConnectionAndroidClient(async () => {
          active++;
          peak = Math.max(peak, active);
          starts[index].resolve();
          const connected = await gates[index].promise;
          active--;
          return connected;
        });
      },
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    await starts[1].promise;
    expect(started).toBe(2);
    expect(peak).toBe(2);
    expect(streamServer.hierarchyUpdates).toHaveLength(0);

    gates[0].resolve(true);
    await starts[2].promise;
    expect(peak).toBe(2);
    gates[1].resolve(true);
    await starts[3].promise;
    gates[2].resolve(true);
    await starts[4].promise;
    gates[3].resolve(true);
    gates[4].resolve(true);
    await capture;

    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(streamServer.hierarchyUpdates.map((update) => update.deviceId).sort()).toEqual(
      devices.map((device) => device.id),
    );
    expect(streamServer.screenshotUpdates.map((update) => update.deviceId).sort()).toEqual(
      devices.map((device) => device.id),
    );
  });

  it("continues with remaining devices when one capture fails", async () => {
    const streamServer = new FakeObservationStreamServer();
    const devices = Array.from({ length: 3 }, (_, index): ObservationStreamDevice => ({
      id: `android-${index}`,
      name: `Pixel ${index}`,
      platform: "android",
    }));
    const clients = devices.map(
      (_, index) =>
        new DeferredConnectionAndroidClient(async () => {
          if (index === 0) {
            throw new Error("connection failed");
          }
          return true;
        }),
    );

    await pushInitialObservationFramesForSubscriber(null, devices, {
      streamServer,
      maxConcurrency: 1,
      androidClientFactory: (device) =>
        clients[devices.findIndex((item) => item.id === device.deviceId)],
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });

    expect(streamServer.hierarchyUpdates.map((update) => update.deviceId)).toEqual([
      "android-1",
      "android-2",
    ]);
    expect(streamServer.screenshotUpdates.map((update) => update.deviceId)).toEqual([
      "android-1",
      "android-2",
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

class FakeTargetedInitialFrameServer extends FakeObservationStreamServer {
  readonly deliveries = new Map<string, FakeObservationStreamServer>();
  readonly scopes = new Map<string, string | null>();

  register(id: string, scope: string | null): void {
    this.deliveries.set(id, new FakeObservationStreamServer(42));
    this.scopes.set(id, scope);
  }

  private destination(
    deviceId: string,
    target?: InitialFrameSubscriber,
  ): FakeObservationStreamServer | undefined {
    if (!target || target.signal.aborted) {
      return undefined;
    }
    const scope = this.scopes.get(target.subscriptionId);
    return scope === null || scope === deviceId
      ? this.deliveries.get(target.subscriptionId)
      : undefined;
  }

  override pushHierarchyUpdate(
    deviceId: string,
    hierarchy: ViewHierarchyResult,
    frameContext?: string,
    target?: InitialFrameSubscriber,
  ): number | null {
    return (
      this.destination(deviceId, target)?.pushHierarchyUpdate(deviceId, hierarchy, frameContext) ??
      null
    );
  }

  override pushScreenshotUpdate(
    deviceId: string,
    data: string,
    width: number,
    height: number,
    metadata?: Record<string, unknown>,
    options?: Parameters<FakeObservationStreamServer["pushScreenshotUpdate"]>[5],
  ): void {
    this.destination(deviceId, options?.initialFrameSubscriber)?.pushScreenshotUpdate(
      deviceId,
      data,
      width,
      height,
      metadata,
      options,
    );
  }
}

function coalescingHarness(maxConcurrency = 2) {
  const timer = new FakeTimer();
  const coordinator = new DefaultObservationInitialFrameCoordinator(timer, maxConcurrency);
  const server = new FakeTargetedInitialFrameServer();
  const devices: ObservationStreamDevice[] = Array.from({ length: 5 }, (_, i) => ({
    id: `device-${i}`,
    name: `Pixel ${i}`,
    platform: "android",
  }));
  const captures: string[] = [];
  const clients: DeferredConnectionAndroidClient[] = [];
  let connect: (id: string) => Promise<boolean> = async () => true;
  let nextSubscriber = 0;
  function request(
    scope: string | null = null,
    entitled = devices,
    allowed: (id: string) => boolean = () => true,
    maxConcurrency?: number,
  ) {
    const id = `pane-${nextSubscriber++}`;
    const controller = new AbortController();
    server.register(id, scope);
    const done = pushInitialObservationFramesForSubscriber(scope, entitled, {
      streamServer: server,
      coordinator,
      maxConcurrency,
      subscriber: { subscriptionId: id, signal: controller.signal },
      isDeviceAllowed: allowed,
      androidClientFactory: (device) => {
        captures.push(device.deviceId);
        const client = new DeferredConnectionAndroidClient(() => connect(device.deviceId));
        clients.push(client);
        return client;
      },
      iosClientFactory: () => {
        throw new Error("unexpected iOS client");
      },
    });
    return { controller, done, frames: server.deliveries.get(id)! };
  }
  return {
    timer,
    coordinator,
    server,
    devices,
    captures,
    clients,
    request,
    setConnect: (fn: typeof connect) => {
      connect = fn;
    },
  };
}

describe("coalesced subscriber initial frames", () => {
  it("captures each device once across N concurrent subscribers and replays only to a new pane", async () => {
    const h = coalescingHarness();
    const panes = Array.from({ length: 8 }, () => h.request());
    await Promise.all(panes.map((pane) => pane.done));
    expect(h.captures.sort()).toEqual(h.devices.map((device) => device.id));
    for (const pane of panes) {
      expect(pane.frames.hierarchyUpdates).toHaveLength(5);
      expect(pane.frames.screenshotUpdates).toHaveLength(5);
    }
    const cached = h.request();
    await cached.done;
    expect(h.captures).toHaveLength(5);
    expect(h.clients.every((client) => client.forwardedInitialHierarchies.length === 1)).toBe(true);
    expect(cached.frames.screenshotUpdates).toHaveLength(5);
    expect(panes[0].frames.screenshotUpdates).toHaveLength(5);
  });

  it("enforces scope and per-request ownership during shared and cached delivery", async () => {
    const h = coalescingHarness();
    const gate = deferred<boolean>();
    h.setConnect(() => gate.promise);
    const owner = h.request(null, h.devices.slice(0, 2));
    const scoped = h.request("device-1");
    const foreign = h.request(null, []);
    let allowed = true;
    const revoked = h.request("device-0", h.devices, () => allowed);
    allowed = false;
    gate.resolve(true);
    await Promise.all([owner.done, scoped.done, foreign.done, revoked.done]);
    expect(scoped.frames.screenshotUpdates.map((frame) => frame.deviceId)).toEqual(["device-1"]);
    expect(foreign.frames.hierarchyUpdates).toHaveLength(0);
    expect(foreign.frames.screenshotUpdates).toHaveLength(0);
    expect(revoked.frames.screenshotUpdates).toHaveLength(0);
    const cachedForeign = h.request(null, [h.devices[0]], () => false);
    const cachedScoped = h.request("device-1");
    await Promise.all([cachedForeign.done, cachedScoped.done]);
    expect(cachedForeign.frames.screenshotUpdates).toHaveLength(0);
    expect(cachedForeign.frames.hierarchyUpdates).toHaveLength(0);
    expect(cachedScoped.frames.screenshotUpdates.map((frame) => frame.deviceId)).toEqual([
      "device-1",
    ]);
    expect(h.captures).toHaveLength(2);
  });

  it("one disconnect does not cancel the shared capture or delivery to other waiters", async () => {
    const h = coalescingHarness();
    const gate = deferred<boolean>();
    h.setConnect(() => gate.promise);
    const gone = h.request("device-0");
    const live = h.request("device-0");
    gone.controller.abort();
    await gone.done;
    gate.resolve(true);
    await live.done;
    expect(h.captures).toEqual(["device-0"]);
    expect(gone.frames.screenshotUpdates).toHaveLength(0);
    expect(live.frames.hierarchyUpdates).toHaveLength(1);
    expect(live.frames.screenshotUpdates).toHaveLength(1);
  });

  it("drops queued captures with no waiters and discards ownerless in-flight results without caching", async () => {
    const h = coalescingHarness();
    const gate = deferred<boolean>();
    const completed = deferred<void>();
    h.setConnect(async () => {
      await gate.promise;
      completed.resolve();
      return true;
    });
    const gone = h.request();
    expect(h.captures).toEqual(["device-0", "device-1"]);
    gone.controller.abort();
    await gone.done;
    gate.resolve(true);
    await completed.promise;
    // Joining an ownerless flight still shares it, rather than launching a duplicate capture.
    const late = h.request("device-0");
    await late.done;
    expect(h.captures).toHaveLength(2);
    expect(gone.frames.hierarchyUpdates).toHaveLength(0);
    expect(gone.frames.screenshotUpdates).toHaveLength(0);
    const recapture = h.request("device-1");
    await recapture.done;
    expect(h.captures).toEqual(["device-0", "device-1", "device-1"]);
  });

  it("logs a failed shared capture for each waiter, continues other devices, and retries", async () => {
    const h = coalescingHarness();
    const gate = deferred<boolean>();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      h.setConnect(async (id) => {
        await gate.promise;
        if (id === "device-0") {
          throw new Error("capture failed");
        }
        return true;
      });
      const first = h.request(null, h.devices.slice(0, 2));
      const second = h.request("device-0");
      gate.resolve(true);
      await Promise.all([first.done, second.done]);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("Failed to push initial observation frame for device-0"),
        ),
      ).toHaveLength(2);
      expect(first.frames.screenshotUpdates.map((frame) => frame.deviceId)).toEqual(["device-1"]);
      h.setConnect(async () => true);
      const retry = h.request("device-0");
      await retry.done;
      expect(h.captures.filter((id) => id === "device-0")).toHaveLength(2);
      expect(retry.frames.screenshotUpdates).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("expires complete frames at the freshness boundary using FakeTimer", async () => {
    const h = coalescingHarness();
    await h.request("device-0").done;
    h.timer.advanceTime(INITIAL_FRAME_FRESHNESS_WINDOW_MS - 1);
    await h.request("device-0").done;
    expect(h.captures).toHaveLength(1);
    h.timer.advanceTime(1);
    await h.request("device-0").done;
    expect(h.captures).toHaveLength(2);
  });

  it("globally caps captures at two across disjoint and overlapping subscriber bursts", async () => {
    const h = coalescingHarness();
    const gates = h.devices.map(() => deferred<boolean>());
    const starts = h.devices.map(() => deferred<void>());
    let active = 0;
    let peak = 0;
    h.setConnect(async (id) => {
      const index = h.devices.findIndex((device) => device.id === id);
      active++;
      peak = Math.max(peak, active);
      starts[index].resolve();
      await gates[index].promise;
      active--;
      return true;
    });
    const first = h.request("device-0");
    const second = h.request("device-1");
    const all = h.request();
    expect(h.captures).toHaveLength(2);
    gates[0].resolve(true);
    await starts[2].promise;
    gates[1].resolve(true);
    await starts[3].promise;
    gates[2].resolve(true);
    await starts[4].promise;
    gates[3].resolve(true);
    gates[4].resolve(true);
    await Promise.all([first.done, second.done, all.done]);
    expect(peak).toBe(2);
    expect(h.captures).toHaveLength(5);
    expect(all.frames.screenshotUpdates).toHaveLength(5);
  });

  it("applies a dependency concurrency override to the global queue across subscribers", async () => {
    const h = coalescingHarness();
    const gate = deferred<boolean>();
    h.setConnect(() => gate.promise);
    const first = h.request(null, h.devices, () => true, 1);
    const second = h.request("device-4");
    expect(h.captures).toHaveLength(1);
    gate.resolve(true);
    await Promise.all([first.done, second.done]);
    expect(h.captures).toHaveLength(5);
    expect(second.frames.screenshotUpdates).toHaveLength(1);
  });

  it("honors a coordinator concurrency override and rejects invalid ranges", async () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => new DefaultObservationInitialFrameCoordinator(new FakeTimer(), value)).toThrow(
        RangeError,
      );
    }
    const h = coalescingHarness(1);
    const gate = deferred<boolean>();
    h.setConnect(() => gate.promise);
    const all = h.request();
    expect(h.captures).toHaveLength(1);
    gate.resolve(true);
    await all.done;
    expect(h.captures).toHaveLength(5);
  });

  it("does not replace newer client geometry when a live hierarchy arrives during initial capture", async () => {
    const h = coalescingHarness();
    let generation = 0;
    const streamServer = Object.assign(h.server, {
      getCurrentFrameContextGeneration: () => generation,
    });
    const screenshotStarted = deferred<void>();
    const screenshotGate = deferred<void>();
    class DelayedScreenshotClient extends DeferredConnectionAndroidClient {
      override async captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult> {
        screenshotStarted.resolve();
        await screenshotGate.promise;
        return { success: true, data: "shot" };
      }
    }
    const client = new DelayedScreenshotClient(async () => true);
    streamServer.register("pane", null);
    const done = pushInitialObservationFramesForSubscriber("device-0", h.devices, {
      streamServer,
      coordinator: h.coordinator,
      subscriber: { subscriptionId: "pane", signal: new AbortController().signal },
      androidClientFactory: () => client,
      iosClientFactory: () => {
        throw new Error("unexpected iOS");
      },
    });
    await screenshotStarted.promise;
    generation++;
    screenshotGate.resolve();
    await done;
    expect(client.forwardedInitialHierarchies).toHaveLength(0);
    expect(streamServer.deliveries.get("pane")?.screenshotUpdates).toHaveLength(1);
  });

  it("reports a shared screenshot exception once per waiter, still delivers hierarchy, and retries", async () => {
    const h = coalescingHarness();
    const screenshotGate = deferred<void>();
    let screenshots = 0;
    class RejectingScreenshotClient extends DeferredConnectionAndroidClient {
      override async captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult> {
        screenshots++;
        await screenshotGate.promise;
        throw new Error("screenshot failed");
      }
    }
    const client = new RejectingScreenshotClient(async () => true);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let captures = 0;
    const request = (id: string) => {
      h.server.register(id, null);
      return pushInitialObservationFramesForSubscriber("device-0", h.devices, {
        streamServer: h.server,
        coordinator: h.coordinator,
        subscriber: { subscriptionId: id, signal: new AbortController().signal },
        androidClientFactory: () => {
          captures++;
          return client;
        },
        iosClientFactory: () => {
          throw new Error("unexpected iOS");
        },
      });
    };
    try {
      const first = request("first");
      const second = request("second");
      screenshotGate.resolve();
      await Promise.all([first, second]);
      expect(screenshots).toBe(1);
      expect(warn.mock.calls).toHaveLength(2);
      for (const id of ["first", "second"]) {
        expect(h.server.deliveries.get(id)?.hierarchyUpdates).toHaveLength(1);
        expect(h.server.deliveries.get(id)?.screenshotUpdates).toHaveLength(0);
      }
      await request("retry");
      expect(captures).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not cache a connected request with no hierarchy or no screenshot", async () => {
    const androidDevice: ObservationStreamDevice = {
      id: "device",
      name: "Pixel",
      platform: "android",
    };
    const timer = new FakeTimer();
    const coordinator = new DefaultObservationInitialFrameCoordinator(timer);
    const server = new FakeTargetedInitialFrameServer();
    server.register("pane", null);
    const client = new FakeAndroidInitialFrameClient(true, null);
    let calls = 0;
    const deps = {
      streamServer: server,
      coordinator,
      subscriber: { subscriptionId: "pane", signal: new AbortController().signal },
      androidClientFactory: () => {
        calls++;
        return client;
      },
      iosClientFactory: () => {
        throw new Error("unexpected iOS");
      },
    };
    await pushInitialObservationFramesForSubscriber(null, [androidDevice], deps);
    await pushInitialObservationFramesForSubscriber(null, [androidDevice], deps);
    expect(calls).toBe(2);
    expect(server.deliveries.get("pane")?.screenshotUpdates).toHaveLength(0);
    const partial = new FakeAndroidInitialFrameClient(
      true,
      {
        updatedAt: 1,
        packageName: "app",
        hierarchy: {},
      },
      undefined,
      true,
      { success: false },
    );
    deps.androidClientFactory = () => {
      calls++;
      return partial;
    };
    await pushInitialObservationFramesForSubscriber(null, [androidDevice], deps);
    await pushInitialObservationFramesForSubscriber(null, [androidDevice], deps);
    expect(calls).toBe(4);
    expect(server.deliveries.get("pane")?.hierarchyUpdates).toHaveLength(2);
    const disconnected = new FakeAndroidInitialFrameClient(false, null);
    deps.androidClientFactory = () => {
      calls++;
      return disconnected;
    };
    await pushInitialObservationFramesForSubscriber(null, [androidDevice], deps);
    await pushInitialObservationFramesForSubscriber(null, [androidDevice], deps);
    expect(calls).toBe(6);
  });
});
