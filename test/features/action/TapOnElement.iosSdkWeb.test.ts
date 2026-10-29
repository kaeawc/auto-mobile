import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { mergeIosSdkWebSnapshots } from "../../../src/features/observe/ios/iosSdkWebMerge";
import type { IosSdkWebSnapshot } from "../../../src/features/observe/ios/sdkWebViewBridge";
import type {
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../src/features/observe/ios/types";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { CtrlProxySdkWebActionResult } from "../../../src/features/observe/ios/types";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { buildObserveResult } from "../../helpers/observeFixture";
import {
  spyOnIosClientInstance,
  spyOnIosExistingInstance,
} from "../../helpers/iosCtrlProxyClientSpies";

const device = { name: "web-ios", deviceId: "web-ios-5162", platform: "ios" } as const;
const webViewBounds = { left: 0, top: 100, right: 390, bottom: 800 };

const raw: XCTestHierarchy = {
  packageName: "com.example.app",
  updatedAt: 1000,
  screenWidth: 390,
  screenHeight: 844,
  hierarchy: {
    className: "XCUIApplication",
    bounds: { left: 0, top: 0, right: 390, bottom: 844 },
    node: [{ className: "WKWebView", scrollable: "true", bounds: webViewBounds }],
  },
};

const snapshot: IosSdkWebSnapshot = {
  snapshotId: "s7",
  url: "https://fixture.local/checkout",
  elements: [
    {
      id: "e0",
      role: "button",
      label: "Pay",
      bounds: [10, 100, 120, 44],
      enabled: true,
      visible: true,
      focused: false,
    },
  ],
};

const converter = new CtrlProxyHierarchy({} as HierarchyDelegateContext);

afterEach(() => {
  displayTransitions.reset(device.deviceId);
  resetObserveCacheStore();
});

function harness(actionReply: CtrlProxySdkWebActionResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(1000);
  const client = new FakeIOSCtrlProxy(timer);
  client.setHierarchyData(raw);
  client.sdkWebSnapshotReply = {
    success: true,
    available: true,
    webViewId: "checkout",
    snapshot,
    webViews: [
      {
        webViewId: "checkout",
        allowedOrigins: ["https://fixture.local"],
        contentProcessAvailable: true,
      },
    ],
    totalTimeMs: 1,
  };
  client.sdkWebActionReplies.push(actionReply);
  const instance = spyOnIosClientInstance(client);
  const existing = spyOnIosExistingInstance(client);
  const convert = spyOn(client, "convertToViewHierarchyResult").mockImplementation((value) =>
    converter.convertToViewHierarchyResult(value),
  );
  const xctestTap = spyOn(client, "requestTapCoordinates");
  const tap = new TapOnElement(device, new FakeAdbClient(), {
    timer,
    tapStrategy: FakeTapStrategy.ios(),
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  const viewHierarchy = converter.convertToViewHierarchyResult(raw);
  mergeIosSdkWebSnapshots(viewHierarchy, [{ webViewId: "checkout", snapshot }]);
  const observe = new FakeObserveScreen();
  observe.setObserveResult(
    buildObserveResult({
      updatedAt: 1000,
      settled: true,
      screenSize: { width: 390, height: 844 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example.app", activityName: "", layoutSeqSum: 0 },
      viewHierarchy,
      backend: "sdk",
    }),
  );
  tap.observeScreen = observe;
  tap.awaitIdle = new FakeAwaitIdle();
  tap.window = new FakeWindow();
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
    effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
  });
  const run = () =>
    tap.execute({
      text: "Pay",
      action: "tap",
      retryIfNoChange: false,
      selectionStrategy: "first",
      searchUntil: { duration: 100 },
    });
  return {
    client,
    xctestTap,
    run,
    restore: () => {
      instance.mockRestore();
      existing.mockRestore();
      convert.mockRestore();
      xctestTap.mockRestore();
    },
  };
}

describe("tapOn routes merged DOM elements through the web view (#5162)", () => {
  test("an accepted click reports backend sdk and never taps through XCTest", async () => {
    const h = harness({
      success: true,
      available: true,
      result: { status: "accepted" },
      totalTimeMs: 2,
    });
    try {
      const result = await h.run();
      expect(result.success).toBe(true);
      expect(result.backend).toBe("sdk");
      expect(h.client.sdkWebActions).toEqual([
        { webViewId: "checkout", action: { click: { snapshotId: "s7", elementId: "e0" } } },
      ]);
      expect(h.xctestTap).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("a stale snapshot fails closed without an XCTest tap", async () => {
    const h = harness({
      success: false,
      available: true,
      result: { status: "rejected", reason: "stale_snapshot" },
      totalTimeMs: 1,
    });
    try {
      const outcome = await h.run().then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      expect(outcome.result?.success ?? false).toBe(false);
      expect(outcome.result?.error ?? String(outcome.error)).toContain("stale_snapshot");
      expect(h.xctestTap).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });
});
