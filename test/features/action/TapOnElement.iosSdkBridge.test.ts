import { readFreshPlatformHierarchy } from "../../../src/features/action/tapHierarchyRead";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { createIosSdkBridgeReader } from "../../../src/features/observe/ios/IosSdkBridgeReader";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { mergeIosSdkObservation } from "../../../src/features/observe/ios/iosSdkObservationMerge";
import type { IosSdkObservation } from "../../../src/features/observe/ios/sdkObservationBridge";
import type {
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../src/features/observe/ios/types";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { CtrlProxySdkActionResult } from "../../../src/features/observe/ios/types";
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

const device = { name: "bridge-ios", deviceId: "bridge-ios-5159", platform: "ios" } as const;
const saveBounds = { left: 10, top: 200, right: 90, bottom: 260 };

const raw: XCTestHierarchy = {
  packageName: "com.example.app",
  updatedAt: 1000,
  screenWidth: 390,
  screenHeight: 844,
  hierarchy: {
    className: "XCUIApplication",
    bounds: { left: 0, top: 0, right: 390, bottom: 844 },
    node: [
      {
        text: "Native",
        clickable: "true",
        enabled: "true",
        bounds: { left: 10, top: 100, right: 90, bottom: 160 },
      },
    ],
  },
};

const bridgeObservation: IosSdkObservation = {
  captureIdentity: 41,
  orientation: "portrait",
  coordinateSpace: "screen",
  bounds: { left: 0, top: 0, right: 390, bottom: 844 },
  root: {
    id: "save",
    role: "button",
    label: "Save",
    value: "Save",
    bounds: saveBounds,
    enabled: true,
    visible: true,
    focused: false,
    children: [],
  },
  capabilities: [],
};

const converter = new CtrlProxyHierarchy({} as HierarchyDelegateContext);

afterEach(() => {
  displayTransitions.reset(device.deviceId);
  resetObserveCacheStore();
});

function harness(actionReply: CtrlProxySdkActionResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(1000);
  const client = new FakeIOSCtrlProxy(timer);
  client.setHierarchyData(raw);
  client.observationBridgeState = {
    status: "available",
    schemaVersion: 1,
    supportedActions: ["tap"],
  };
  client.sdkObservationReply = {
    success: true,
    available: true,
    observation: bridgeObservation,
    totalTimeMs: 1,
  };
  client.sdkActionReplies.push(actionReply);
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
  mergeIosSdkObservation(viewHierarchy, bridgeObservation);
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
      elementId: "save",
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

describe("tapOn routes SDK bridge nodes through the bridge (#5159)", () => {
  test("an accepted bridge tap reports backend sdk and never taps through XCTest", async () => {
    const h = harness({
      success: true,
      available: true,
      result: { status: "accepted", durationMs: 2, nextObservationIdentity: 42 },
      totalTimeMs: 3,
    });
    try {
      const result = await h.run();
      expect(result.success).toBe(true);
      expect(result.backend).toBe("sdk");
      expect(result.fallbackReason).toBeUndefined();
      expect(h.client.sdkActions).toEqual([
        { tap: { observationIdentity: 41, elementId: "save" } },
      ]);
      expect(h.xctestTap).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an unsupported action falls back to the XCTest tap and says why", async () => {
    const h = harness({
      success: false,
      available: true,
      result: { status: "rejected", reason: "unsupported_action", durationMs: 0 },
      error: "unsupported_action",
      totalTimeMs: 1,
    });
    try {
      const result = await h.run();
      expect(result.backend).toBe("xctest");
      expect(result.fallbackReason).toBe("unsupported");
      expect(h.xctestTap).toHaveBeenCalledTimes(1);
    } finally {
      h.restore();
    }
  });

  test("a stale observation fails closed without an XCTest tap", async () => {
    const h = harness({
      success: false,
      available: true,
      result: { status: "rejected", reason: "stale_observation", durationMs: 0 },
      error: "stale_observation",
      totalTimeMs: 1,
    });
    try {
      const outcome = await h.run().then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      expect(outcome.result?.success ?? false).toBe(false);
      const message = outcome.result?.error ?? String(outcome.error);
      expect(message).toContain("stale_observation");
      expect(h.xctestTap).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });
});

test("tap hierarchy read gives stalled bridge discovery only the search time remaining", async () => {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const client = new FakeIOSCtrlProxy(timer);
  client.setHierarchyData(raw);
  const instance = spyOnIosClientInstance(client);
  const convert = spyOn(client, "convertToViewHierarchyResult").mockImplementation((value) =>
    converter.convertToViewHierarchyResult(value),
  );
  const sync = spyOn(client, "requestHierarchySync").mockImplementation(async () => {
    timer.setCurrentTime(1060);
    return { hierarchy: raw, totalTimeMs: 60 };
  });
  let discoveryTimeout: number | undefined;
  let snapshots = 0;
  const reader = createIosSdkBridgeReader({
    timer,
    enabled: () => true,
    client: () => ({
      getObservationBridgeStateForIos: async (_appId, timeoutMs) => {
        discoveryTimeout = timeoutMs;
        timer.setCurrentTime(timer.now() + (timeoutMs ?? 2000));
        throw new Error("discovery timed out");
      },
      requestSdkObservationForIos: async () => {
        snapshots++;
        return { success: false, available: false, totalTimeMs: 0 };
      },
      requestSdkActionForIos: async () => {
        throw new Error("not used");
      },
    }),
  });
  try {
    const result = await readFreshPlatformHierarchy(
      {
        device,
        timer,
        adb: new FakeAdbClient(),
        androidService: new FakeCtrlProxy(timer),
        viewHierarchy: new ViewHierarchy(device, new FakeAdbClientFactory(), null, { timer }),
        prepareForResponse: (hierarchy) => hierarchy,
        actionLabel: "tapOn",
        sdkBridge: reader,
        sdkWeb: { snapshots: async () => [] },
      },
      { timeoutMs: 100, forceCapture: false },
    );
    expect(result).not.toBeNull();
    expect(discoveryTimeout).toBe(40);
    expect(snapshots).toBe(0);
    expect(timer.now()).toBe(1100);
  } finally {
    instance.mockRestore();
    convert.mockRestore();
    sync.mockRestore();
  }
});
