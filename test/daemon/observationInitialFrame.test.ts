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
  ScreenshotResult,
} from "../../src/features/observe/android";
import type {
  CtrlProxyHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxyScreenshotResult,
} from "../../src/features/observe/ios/types";

class FakeObservationStreamServer {
  readonly hierarchyUpdates: Array<{ deviceId: string; hierarchy: ViewHierarchyResult }> = [];
  readonly screenshotUpdates: Array<{
    deviceId: string;
    screenshotBase64: string;
    screenWidth: number;
    screenHeight: number;
  }> = [];

  pushHierarchyUpdate(deviceId: string, hierarchy: ViewHierarchyResult): void {
    this.hierarchyUpdates.push({ deviceId, hierarchy });
  }

  pushScreenshotUpdate(
    deviceId: string,
    screenshotBase64: string,
    screenWidth: number,
    screenHeight: number
  ): void {
    this.screenshotUpdates.push({ deviceId, screenshotBase64, screenWidth, screenHeight });
  }
}

class FakeAndroidInitialFrameClient implements ObservationStreamAndroidClient {
  readonly latestHierarchyCalls: Array<{
    waitForFresh?: boolean;
    timeout?: number;
    skipWaitForFresh?: boolean;
  }> = [];
  readonly suppressedSyncHierarchyCalls: Array<{ timeoutMs?: number }> = [];
  readonly suppressedScreenshotCalls: Array<{ timeoutMs?: number }> = [];

  constructor(
    private readonly connected: boolean,
    private readonly latestHierarchy: AccessibilityHierarchy | null,
    private readonly syncHierarchy: AccessibilityHierarchy | null = latestHierarchy,
    private readonly latestHierarchyFresh: boolean = true,
    private readonly screenshot: ScreenshotResult = { success: true, data: "android-shot" }
  ) {}

  async ensureConnected(): Promise<boolean> {
    return this.connected;
  }

  async getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    _perf?: unknown,
    skipWaitForFresh?: boolean
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
    timeoutMs?: number
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
    };
  }

  async requestScreenshotWithoutObservationStreamPush(timeoutMs?: number): Promise<ScreenshotResult> {
    this.suppressedScreenshotCalls.push({ timeoutMs });
    return this.screenshot;
  }
}

class FakeIosInitialFrameClient implements ObservationStreamIosClient {
  readonly syncHierarchyCalls: Array<{ timeoutMs?: number }> = [];
  readonly suppressedSyncHierarchyCalls: Array<{ timeoutMs?: number }> = [];
  readonly suppressedScreenshotCalls: Array<{ timeoutMs?: number }> = [];

  constructor(
    private readonly connected: boolean,
    private readonly latestHierarchy: CtrlProxyHierarchy | null,
    private readonly syncHierarchy: CtrlProxyHierarchy | null = latestHierarchy,
    private readonly screenshot: CtrlProxyScreenshotResult = { success: true, data: "ios-shot" },
    private readonly latestHierarchyFresh: boolean = true
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
    timeoutMs?: number
  ): Promise<{ hierarchy: CtrlProxyHierarchy } | null> {
    this.syncHierarchyCalls.push({ timeoutMs });
    return this.syncHierarchy ? { hierarchy: this.syncHierarchy } : null;
  }

  async requestHierarchySyncWithoutObservationStreamPush(
    _perf?: unknown,
    _disableAllFiltering?: boolean,
    _signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ hierarchy: CtrlProxyHierarchy } | null> {
    this.suppressedSyncHierarchyCalls.push({ timeoutMs });
    return this.syncHierarchy ? { hierarchy: this.syncHierarchy } : null;
  }

  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult {
    const typedHierarchy = hierarchy as CtrlProxyHierarchy;
    return {
      hierarchy: { node: { $: { text: typedHierarchy.hierarchy.text } } },
      packageName: typedHierarchy.packageName,
      updatedAt: typedHierarchy.updatedAt,
      screenWidth: typedHierarchy.screenWidth,
      screenHeight: typedHierarchy.screenHeight,
      screenScale: typedHierarchy.screenScale,
    };
  }

  async requestScreenshot(): Promise<CtrlProxyScreenshotResult> {
    return this.screenshot;
  }

  async requestScreenshotWithoutObservationStreamPush(timeoutMs?: number): Promise<CtrlProxyScreenshotResult> {
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
          hierarchy: { node: { text: "Home", bounds: { left: 0, top: 0, right: 1440, bottom: 3120 } } },
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
      },
    ]);
    expect(androidClient.latestHierarchyCalls).toEqual([
      { waitForFresh: false, timeout: 3000, skipWaitForFresh: true },
    ]);
    expect(androidClient.suppressedSyncHierarchyCalls).toHaveLength(0);
    expect(androidClient.suppressedScreenshotCalls).toEqual([{ timeoutMs: 3000 }]);
  });

  it("captures Android hierarchy without an automatic stream push when the initial cache is empty", async () => {
    const streamServer = new FakeObservationStreamServer();
    const androidClient = new FakeAndroidInitialFrameClient(
      true,
      null,
      {
        updatedAt: 789,
        packageName: "com.example",
        screenWidth: 720,
        screenHeight: 1280,
        hierarchy: { text: "Cold start" },
      }
    );

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
    expect(androidClient.suppressedScreenshotCalls).toEqual([{ timeoutMs: 3000 }]);
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
      false
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
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toMatchObject({ text: "Fresh sync" });
  });

  it("pushes iOS screenshot dimensions in pixels using screen scale", async () => {
    const streamServer = new FakeObservationStreamServer();
    const iosClient = new FakeIosInitialFrameClient(true, {
      updatedAt: 456,
      packageName: "com.example.ios",
      screenWidth: 390,
      screenHeight: 844,
      screenScale: 3,
      hierarchy: { text: "Home" },
    });

    await pushInitialObservationFramesForSubscriber(iosDevice.id, [iosDevice], {
      streamServer,
      androidClientFactory: () => {
        throw new Error("unexpected Android client");
      },
      iosClientFactory: () => iosClient,
    });

    expect(streamServer.hierarchyUpdates).toHaveLength(1);
    expect(streamServer.hierarchyUpdates[0].deviceId).toBe(iosDevice.id);
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toEqual({ $: { text: "Home" } });
    expect(streamServer.screenshotUpdates).toEqual([
      {
        deviceId: iosDevice.id,
        screenshotBase64: "ios-shot",
        screenWidth: 1170,
        screenHeight: 2532,
      },
    ]);
    expect(iosClient.syncHierarchyCalls).toHaveLength(0);
    expect(iosClient.suppressedSyncHierarchyCalls).toHaveLength(0);
    expect(iosClient.suppressedScreenshotCalls).toEqual([{ timeoutMs: 3000 }]);
  });

  it("captures iOS hierarchy synchronously when the initial cache is empty", async () => {
    const streamServer = new FakeObservationStreamServer();
    const iosClient = new FakeIosInitialFrameClient(
      true,
      null,
      {
        updatedAt: 987,
        packageName: "com.example.ios",
        screenWidth: 400,
        screenHeight: 800,
        screenScale: 2,
        hierarchy: { text: "Cold start" },
      }
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
    expect(streamServer.hierarchyUpdates[0].hierarchy.updatedAt).toBe(987);
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toEqual({ $: { text: "Cold start" } });
    expect(streamServer.screenshotUpdates[0]).toMatchObject({
      deviceId: iosDevice.id,
      screenWidth: 800,
      screenHeight: 1600,
    });
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
      false
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
    expect(streamServer.hierarchyUpdates[0].hierarchy.hierarchy.node).toEqual({ $: { text: "Fresh sync" } });
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

    expect(streamServer.hierarchyUpdates.map(update => update.deviceId)).toEqual([androidDevice.id]);
    expect(streamServer.screenshotUpdates.map(update => update.deviceId)).toEqual([androidDevice.id]);
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
