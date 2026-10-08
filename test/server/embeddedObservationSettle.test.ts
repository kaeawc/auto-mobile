import { StaleDisplayError } from "../../src/models/StaleDisplayError";
import { nodeAttributes } from "../../src/models/ViewHierarchyResult";
import { readToolEnvelopePayload } from "../../src/server/toolEnvelopePayload";
import {
  deferTerminalScreenshot,
  hasPendingTerminalScreenshot,
  runWithPostActionCaptureScope,
} from "../../src/utils/PostActionCaptureContext";
import type { SettleObserve } from "../../src/features/observe/interfaces/SettleObserve";
import { describe, expect, spyOn, test } from "bun:test";
import type { ObserveResult } from "../../src/models/ObserveResult";
import {
  EMBEDDED_OBSERVATION_SETTLE_FENCE_MARGIN_MS,
  EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS,
  EMBEDDED_OBSERVATION_SETTLE_POLL_MS,
  settleEmbeddedObservation,
  settleEmbeddedObservationInResponse,
} from "../../src/server/embeddedObservationSettle";
import { RealSettleObserve } from "../../src/features/observe/SettleObserve";
import { assignStableViewIds } from "../../src/features/observe/android/StableNodeIdentity";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ObserveScreenExecuteOptions } from "../../src/features/observe/interfaces/ObserveScreen";
import { hierarchyUpdatedAtToMillis } from "../../src/features/observe/observeTimestamp";
import { logger } from "../../src/utils/logger";
import {
  deviceLikeAndroidHierarchy,
  DEVICE_CAPTURE_TIME,
} from "../helpers/deviceLikeAndroidHierarchy";
import { createObserveScreenForTest } from "../features/observe/observeScreenTestBuilders";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeDeviceStateCollector } from "../fakes/FakeDeviceStateCollector";
import { resetObserveCacheStore } from "../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { createDeviceHierarchyCapture } from "../../src/features/observe/DeviceHierarchyCapture";
import type { AccessibilityHierarchy } from "../../src/features/observe/android/types";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { buildObservationScreenshotUri } from "../../src/server/observationResourceUris";
import { FakeScreenshotStateStore } from "../fakes/FakeScreenshotStateStore";

/**
 * Unit coverage for the navigation-class embedded-observation settle gate
 * (issue #6866). Everything runs on FakeObserveScreen + FakeTimer: no device,
 * no DB, no real clock.
 */

/** Airplane-mode row as Android inflates it: first without, then with, the switch child. */
const AIRPLANE_ROW_HALF_INFLATED = {
  class: "android.widget.LinearLayout",
  "resource-id": "android:id/list_container",
  node: {
    class: "android.widget.RelativeLayout",
    "view-id": "1f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
    node: {
      class: "android.widget.TextView",
      "resource-id": "android:id/title",
      text: "Airplane mode",
      "view-id": "2f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
    },
  },
};

const AIRPLANE_ROW_INFLATED = {
  class: "android.widget.LinearLayout",
  "resource-id": "android:id/list_container",
  node: {
    class: "android.widget.RelativeLayout",
    "view-id": "1f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
    node: [
      {
        class: "android.widget.TextView",
        "resource-id": "android:id/title",
        text: "Airplane mode",
        "view-id": "2f0e3dad-9990-4fb4-a5c3-7f2a1b0c9d8e",
      },
      {
        class: "android.widget.Switch",
        "resource-id": "com.android.settings:id/switchWidget",
        checkable: "true",
        checked: "false",
        "view-id": "com.android.settings:id/switchWidget",
      },
    ],
  },
};

function obs(node: Record<string, unknown>, updatedAt: number): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: {
      appId: "com.android.settings",
      activityName: ".SubSettings",
      layoutSeqSum: 1,
    },
    viewHierarchy: {
      packageName: "com.android.settings",
      hierarchy: { node: structuredClone(node) as any },
      updatedAt,
    },
  } as ObserveResult;
}

/** The content-derived `s2-…` id the skeleton projection would emit for the row. */
function airplaneRowStableId(observation: ObserveResult): string {
  const root = structuredClone(observation.viewHierarchy!.hierarchy) as Record<string, unknown>;
  assignStableViewIds(root);
  return ((root.node as any).node as Record<string, unknown>)["view-id"] as string;
}

function settleFor(fake: FakeObserveScreen, timer: FakeTimer): RealSettleObserve {
  return new RealSettleObserve(fake, timer);
}

/** An unchanged cache keeps its timestamp; only fresh extraction advances it. */
class ScreenshotSettleScreen extends FakeObserveScreen {
  private cached: ObserveResult;
  readonly screenshots: FakeScreenshotStateStore;

  constructor(
    private readonly action: ObserveResult,
    timer: FakeTimer,
    private readonly settledScreenshot = true,
  ) {
    super();
    this.cached = action;
    this.setObserveResult(action);
    this.screenshots = new FakeScreenshotStateStore(timer);
  }

  override async execute(options: ObserveScreenExecuteOptions = {}): Promise<ObserveResult> {
    await super.execute(options);
    if (options.requireFreshExtraction || options.freshness === "fresh") {
      const timestamp = Number(this.cached.updatedAt) + 1;
      this.cached = {
        ...obs(AIRPLANE_ROW_INFLATED, timestamp),
        platform: this.action.platform,
        deviceId: this.action.deviceId,
        observationId: `settle-${timestamp}`,
        display: this.action.display,
        screenshotCaptureAttempted: false,
      };
    }
    return this.cached;
  }

  override async captureScreenshot(
    perf?: Parameters<FakeObserveScreen["captureScreenshot"]>[0],
    signal?: AbortSignal,
    observation?: ObserveResult,
  ): Promise<void> {
    await super.captureScreenshot(perf, signal, observation);
    if (!observation) {
      throw new Error("Expected the adopted observation");
    }
    observation.screenshotCaptureAttempted = true;
    const path = `/fake/${observation.observationId}.png`;
    this.screenshots.updateForObservation(observation.deviceId, observation.observationId, path);
    if (this.settledScreenshot) {
      Object.assign(observation, {
        screenshotPath: path,
        screenshotSettled: true,
        screenshotSource: "fresh",
        screenshotCapturedAt: "2026-10-04T12:00:01.000Z",
        screenshotImageSize: observation.screenSize,
      });
    }
  }
}

function screenshotAction(platform: "android" | "ios" = "android"): ObserveResult {
  return {
    ...obs(AIRPLANE_ROW_HALF_INFLATED, 10),
    platform,
    deviceId: `screenshot-${platform}`,
    observationId: "action-capture",
    screenshotCaptureAttempted: true,
    screenshotPath: "/fake/action.png",
    screenshotSettled: true,
    screenshotCapturedAt: "2026-10-04T12:00:00.000Z",
  };
}

describe("embedded settle screenshot evidence", () => {
  test.each([
    { platform: "android" as const, display: undefined },
    { platform: "ios" as const, display: undefined },
    { platform: "android" as const, display: "external" },
    { platform: "ios" as const, display: "external" },
  ])(
    "captures once for the adopted $platform observation (display: $display)",
    async (scenario) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const action = screenshotAction(scenario.platform);
      if (scenario.display) {
        action.display = {
          key: "external-key",
          role: "external",
          posture: "unknown",
          generation: 2,
        };
      }
      const fake = new ScreenshotSettleScreen(action, timer);
      const response = createStructuredToolResponse({ success: true, observation: action });
      await settleEmbeddedObservationInResponse(response, {
        name: "tapOn",
        args: { display: scenario.display },
        internal: false,
        createSettleObserve: () => settleFor(fake, timer),
      });
      const adopted = response.structuredContent!.observation;
      expect(adopted.settled).toBe(true);
      expect(adopted.observationId).not.toBe(action.observationId);
      expect(fake.getCaptureScreenshotCallCount()).toBe(1);
      expect(fake.getCapturedScreenshotObservations()[0]?.observationId).toBe(
        adopted.observationId,
      );
      expect(adopted.screenshotCaptureAttempted).toBe(true);
      expect(adopted.screenshotPath).toBe(`/fake/${adopted.observationId}.png`);
      expect(adopted.screenshotCapturedAt).toBe("2026-10-04T12:00:01.000Z");
      expect(adopted.screenshotSettled).toBe(true);
      expect(fake.getExecuteOptions().every((option) => option.skipScreenshot === true)).toBe(true);
      expect(
        fake.getExecuteOptions().every((option) => option.display === action.display?.key),
      ).toBe(true);
      const finalized = finalizeToolResponse(response, { name: "tapOn" });
      const emitted = finalized.structuredContent!.observation;
      expect(emitted.observationScreenshotResourceUri).toBe(
        buildObservationScreenshotUri(action.deviceId, adopted.observationId),
      );
      expect(emitted.screenshotPath).toBe(adopted.screenshotPath);
    },
  );

  test("disabled screenshots adopt the hierarchy without capturing", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = screenshotAction();
    action.screenshotCaptureAttempted = false;
    delete action.screenshotPath;
    const fake = new ScreenshotSettleScreen(action, timer);
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: settleFor(fake, timer),
    });
    expect(result.settled).toBe(true);
    expect(result.observation.screenshotPath).toBeUndefined();
    expect(result.observation.screenshotCaptureAttempted).toBe(false);
    expect(fake.getCaptureScreenshotCallCount()).toBe(0);
  });

  test("a timeout with no adoptable capture keeps the action screenshot", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = screenshotAction();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 5));
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: settleFor(fake, timer),
    });
    expect(result.observation).toBe(action);
    expect(result.settled).toBe(false);
    expect(fake.getCaptureScreenshotCallCount()).toBe(0);
  });

  test("a handler-settled response keeps its screenshot without another capture", async () => {
    const timer = new FakeTimer();
    const action = screenshotAction();
    const fake = new ScreenshotSettleScreen(action, timer);
    const response = createStructuredToolResponse({
      success: true,
      settled: true,
      observation: action,
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });
    expect(response.structuredContent!.observation.screenshotPath).toBe(action.screenshotPath);
    expect(fake.getExecuteCallCount()).toBe(0);
    expect(fake.getCaptureScreenshotCallCount()).toBe(0);
  });

  test("an adoptable timeout captures evidence without changing its unsettled verdict", async () => {
    const timer = new FakeTimer();
    const action = screenshotAction();
    const fake = new ScreenshotSettleScreen(action, timer);
    const settle = settleFor(fake, timer);
    const destination = {
      ...obs(AIRPLANE_ROW_INFLATED, 20),
      deviceId: action.deviceId,
      observationId: "timeout-destination",
      screenshotCaptureAttempted: false,
    };
    const execute = spyOn(settle, "execute").mockResolvedValue({
      observation: destination,
      settled: false,
      polls: 2,
      waitMs: 1000,
      terminalReason: "timeout",
    });
    try {
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: action,
        settleObserve: settle,
      });
      expect(result.settled).toBe(false);
      expect(result.observation.observationId).toBe(destination.observationId);
      expect(result.observation.screenshotPath).toBe("/fake/timeout-destination.png");
      expect(fake.getCaptureScreenshotCallCount()).toBe(1);
    } finally {
      execute.mockRestore();
    }
  });

  test("a twice-failed terminal capture keeps the chosen hierarchy without failing the completed action", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = screenshotAction();
    const fake = new ScreenshotSettleScreen(action, timer);
    fake.setFailureMode("captureScreenshot", new Error("capture cancelled"));
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: action,
        settleObserve: settleFor(fake, timer),
      });
      expect(result.observation.observationId).not.toBe(action.observationId);
      expect(result.settled).toBe(true);
      expect(result.observation.screenshotPath).toBeUndefined();
      expect(result.observation.screenshotCaptureAttempted).toBe(true);
      expect(fake.getCaptureScreenshotCallCount()).toBe(2);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });
});

/** Model CtrlProxy's rejected-cache wait; only a sync can read past the initial still frame. */
class StillFrameObserveScreen extends FakeObserveScreen {
  private cached: ObserveResult;

  constructor(
    captured: ObserveResult,
    private readonly timer: FakeTimer,
  ) {
    super();
    this.cached = captured;
  }

  override async execute(options: ObserveScreenExecuteOptions = {}): Promise<ObserveResult> {
    const next = await super.execute(options);
    const cachedMs = hierarchyUpdatedAtToMillis(this.cached.viewHierarchy) ?? 0;
    if ((options.minTimestamp ?? 0) > cachedMs) {
      // Selected panels use a routed synchronous capture, independently of the push wait.
      if (!options.skipWaitForFresh && options.display === undefined) {
        await this.timer.sleep(options.timeoutMs ?? 1000);
        return this.cached;
      }
      // Simulate device work without using the wall clock. Sync really re-extracts the tree.
      await this.timer.sleep(
        Math.min(EMBEDDED_OBSERVATION_SETTLE_POLL_MS / 2, options.timeoutMs ?? 1000),
      );
    }
    this.cached = next;
    return next;
  }
}

function deviceLikeObserveScreen(h: Awaited<ReturnType<typeof deviceLikeAndroidHierarchy>>) {
  return createObserveScreenForTest(
    h.device,
    new FakeAdbClientFactory(h.adb),
    {
      viewHierarchy: h.viewHierarchy,
      cacheStore: new FakeObserveCacheStore(h.timer),
      deviceStateCollector: new FakeDeviceStateCollector(false) as never,
      hierarchyCapture: createDeviceHierarchyCapture(h.device, {
        timer: h.timer,
        syncClientFactory: () => ({
          requestHierarchySync: (...args) => h.hierarchy.requestHierarchySync(...args),
          convertToViewHierarchyResult: (value) =>
            h.hierarchy.convertToViewHierarchyResult(value as AccessibilityHierarchy),
        }),
      }),
    },
    h.timer,
  );
}

describe("embedded settle on a still Android frame (#9579)", () => {
  test.each([
    {
      name: "default floor-bearing observe stays cached",
      floor: DEVICE_CAPTURE_TIME,
      extractions: 0,
    },
    {
      name: "requireFreshExtraction alone extracts with a floor",
      floor: DEVICE_CAPTURE_TIME,
      extractions: 1,
      requireFreshExtraction: true,
    },
    {
      name: "requireFreshExtraction without a floor stays cached",
      floor: 0,
      extractions: 0,
      requireFreshExtraction: true,
    },
  ])("Android observe cache policy: $name", async (scenario) => {
    const h = await deviceLikeAndroidHierarchy();
    const screen = deviceLikeObserveScreen(h);
    try {
      const result = await screen.execute({
        minTimestamp: scenario.floor,
        ...("requireFreshExtraction" in scenario
          ? { requireFreshExtraction: scenario.requireFreshExtraction }
          : {}),
        // Leave skipWaitForFresh omitted to exercise ObserveScreen's default.
        skipScreenshot: true,
        skipBackStack: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
      });
      expect(h.extractions()).toBe(scenario.extractions);
      expect(result.viewHierarchy?.updatedAt).toBe(DEVICE_CAPTURE_TIME + scenario.extractions);
      expect(result.freshness?.verified).toBe(scenario.extractions === 1);
      expect(h.reads.map((read) => read.floor)).toEqual([scenario.floor]);
    } finally {
      h.restore();
      resetObserveCacheStore();
      displayTransitions.reset(h.device.deviceId);
    }
  });

  test.each([
    { name: "still", label: () => "Still screen", extractions: 2, elapsed: 190, settled: true },
    {
      name: "changing then stable",
      label: (n: number) => (n < 2 ? "Loading" : "Ready"),
      extractions: 3,
      elapsed: 360,
      settled: true,
    },
    {
      name: "never stable",
      label: (n: number) => `Frame ${n}`,
      extractions: 6,
      elapsed: 1000,
      settled: false,
    },
    {
      name: "explicit display",
      label: () => "Still screen",
      extractions: 2,
      elapsed: 190,
      settled: true,
      routed: true,
      pinned: false,
    },
    {
      name: "pinned display",
      label: () => "Still screen",
      extractions: 2,
      elapsed: 190,
      settled: true,
      routed: true,
      pinned: true,
    },
  ])("real Android cache through ObserveScreen: $name", async (scenario) => {
    const h = await deviceLikeAndroidHierarchy(scenario.label);
    const routed = "routed" in scenario;
    const screen = deviceLikeObserveScreen(h);
    const recomposition = spyOn(screen, "processRecomposition").mockResolvedValue(undefined);
    const warning = spyOn(logger, "warn");
    const started = h.timer.now();
    try {
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: {
          ...obs(AIRPLANE_ROW_INFLATED, DEVICE_CAPTURE_TIME),
          display: {
            key: "0",
            role: "unknown",
            posture: "unknown",
            generation: 0,
            pinned: "pinned" in scenario && scenario.pinned,
          },
        },
        args: routed && !scenario.pinned ? { display: "0" } : undefined,
        settleObserve: new RealSettleObserve(screen, h.timer),
      });
      expect(result.settled).toBe(scenario.settled);
      expect(h.extractions()).toBe(scenario.extractions);
      expect(h.reads.every((read) => read.fresh === true)).toBe(true);
      expect(h.reads.map((read) => read.updatedAt)).toEqual(
        routed
          ? []
          : Array.from({ length: scenario.extractions }, (_, n) => DEVICE_CAPTURE_TIME + n + 1),
      );
      // Still inclusive after the first post-action read, but each result must
      // come from a separate request_hierarchy, never from its cached copy.
      expect(h.reads.slice(0, 2).map((read) => read.floor)).toEqual(
        routed ? [] : [DEVICE_CAPTURE_TIME + 1, DEVICE_CAPTURE_TIME + 1],
      );
      expect(result.observation.freshness?.verified).toBe(true);
      expect(result.observation.display?.key).toBe("0");
      expect(h.timer.now() - started).toBe(scenario.elapsed);
      expect(h.timer.getSleepHistory()).toEqual(
        scenario.settled
          ? Array(scenario.extractions - 1).fill(150)
          : [150, 150, 150, 150, 150, 130],
      );
      expect(h.displayIds).toEqual(Array(scenario.extractions).fill(routed ? 0 : undefined));
      expect(warning).not.toHaveBeenCalled();
    } finally {
      recomposition.mockRestore();
      warning.mockRestore();
      h.restore();
      resetObserveCacheStore();
      displayTransitions.reset(h.device.deviceId);
    }
  });

  test("real Android cache resumes after a finishing capture contradicts the stable pair", async () => {
    const h = await deviceLikeAndroidHierarchy((n) => (n <= 2 ? "A" : "B"));
    const screen = deviceLikeObserveScreen(h);
    const recomposition = spyOn(screen, "processRecomposition").mockResolvedValue(undefined);
    const collect = spyOn(screen, "collectDeferredBackStack").mockResolvedValue(true);
    const started = h.timer.now();
    try {
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: obs(AIRPLANE_ROW_INFLATED, DEVICE_CAPTURE_TIME),
        settleObserve: new RealSettleObserve(screen, h.timer),
      });
      expect(result.settled).toBe(true);
      expect(h.extractions()).toBe(5);
      expect(result.observation.viewHierarchy?.updatedAt).toBe(DEVICE_CAPTURE_TIME + 5);
      expect(JSON.stringify(result.observation.viewHierarchy?.hierarchy)).toContain('"B"');
      expect(h.reads.every((read) => read.fresh === true)).toBe(true);
      expect(h.reads.map((read) => read.floor)).toEqual(
        [1, 1, 2, 3, 4].map((n) => DEVICE_CAPTURE_TIME + n),
      );
      expect(h.timer.now() - started).toBe(400);
      expect(recomposition.mock.calls.map(([observation]) => observation)).toEqual([
        result.observation,
      ]);
      expect(collect).toHaveBeenCalledTimes(2);
    } finally {
      collect.mockRestore();
      recomposition.mockRestore();
      h.restore();
      resetObserveCacheStore();
      displayTransitions.reset(h.device.deviceId);
    }
  });

  test("syncs past the action capture, then settles without waiting for a nonexistent push", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const captured = obs(AIRPLANE_ROW_INFLATED, 10);
    captured.display = { key: "0", role: "unknown", posture: "unknown", generation: 0 };
    const fresh = { ...obs(AIRPLANE_ROW_INFLATED, 20), display: captured.display };
    const fake = new StillFrameObserveScreen(captured, timer);
    fake.setObserveResult(fresh);
    const warning = spyOn(logger, "warn");
    try {
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: captured,
        settleObserve: settleFor(fake, timer),
      });
      expect(result.settled).toBe(true);
      expect(result.observation.viewHierarchy?.updatedAt).toBe(20);
      expect(fake.getExecuteMinTimestamps()).toEqual([11, 20]);
      expect(timer.getSleepHistory()).toEqual([75, 150]);
      expect(timer.now()).toBe(225);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test("waits through changes until two consecutive equal captures", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const fake = new StillFrameObserveScreen(captured, timer);
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_HALF_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });
    expect(result.settled).toBe(true);
    expect(fake.getExecuteCallCount()).toBe(3);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(40);
    expect(timer.getSleepHistory()).toEqual([75, 150, 150]);
    expect(timer.now()).toBe(375);
  });

  test("times out honestly when fresh captures never stabilize", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const fake = new StillFrameObserveScreen(captured, timer);
    fake.setObserveResult((index) =>
      obs(index % 2 ? AIRPLANE_ROW_INFLATED : AIRPLANE_ROW_HALF_INFLATED, 20 + index),
    );
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });
    expect(result.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(7);
    expect(timer.now()).toBe(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
    expect(timer.getSleepHistory()).toEqual([75, 150, 150, 150, 150, 150, 150, 25]);
  });

  test("the action frame alone cannot prove stability even if sync returns it", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const captured = obs(AIRPLANE_ROW_INFLATED, 10);
    const fake = new StillFrameObserveScreen(captured, timer);
    fake.setObserveResult(captured);
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });
    expect(result.settled).toBe(false);
    expect(fake.getExecuteMinTimestamps().every((floor) => floor === 11)).toBe(true);
  });

  test.each([false, true])(
    "routed polls ignore an unverified other panel (pinned: %s)",
    async (pinned) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const captured = obs(AIRPLANE_ROW_INFLATED, 10);
      captured.display = {
        key: "outside",
        role: "cover",
        posture: "closed",
        generation: 2,
        pinned,
      };
      const other = obs(AIRPLANE_ROW_INFLATED, 20);
      other.display = { key: "inside", role: "inner", posture: "opened", generation: 2 };
      // ObserveScreen rejects a misrouted capture; it cannot advance the settle predicate.
      other.freshness = { isFresh: false, verified: false };
      const target = { ...obs(AIRPLANE_ROW_INFLATED, 30), display: captured.display };
      const fake = new FakeObserveScreen();
      fake.setObserveSequence([other, target, target]);
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: captured,
        args: pinned ? undefined : { display: "cover" },
        settleObserve: settleFor(fake, timer),
      });
      expect(result.settled).toBe(true);
      expect(result.observation.display?.key).toBe("outside");
      expect(result.observation.viewHierarchy?.updatedAt).toBe(30);
      expect(fake.getExecuteOptions().every((options) => options.display === "outside")).toBe(true);
      expect(fake.getExecuteCallCount()).toBe(3);
      expect(timer.getSleepHistory()).toEqual([150, 150]);
    },
  );
});

describe("settleEmbeddedObservation (#6866)", () => {
  test("navigation-class capture is replaced by the settled hierarchy and marked settled", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    fake.setDeferredBackStack({ depth: 0, activities: [], tasks: [], capturedAt: 999 });
    const halfInflated = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: halfInflated,
      settleObserve: settleFor(fake, timer),
    });

    expect(fake.getExecuteOptions().every((o) => o.skipBackStack === true)).toBe(true);
    expect(fake.getCollectDeferredBackStackCallCount()).toBe(1);
    expect(outcome.observation.backStack?.capturedAt).toBe(999);
    expect(outcome.settled).toBe(true);
    // The switch child — the only carrier of toggle/checked — is now present.
    const children = (outcome.observation.viewHierarchy!.hierarchy.node as any).node.node;
    expect(Array.isArray(children)).toBe(true);
    expect(children[1]["resource-id"]).toBe("com.android.settings:id/switchWidget");
  });

  test("elementId stability: the settled row id equals the id a later observe emits", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const halfInflated = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    // Precondition: the half-inflated capture hashes to a DIFFERENT id — that
    // is the client-visible symptom reported in #6866.
    const laterObserve = obs(AIRPLANE_ROW_INFLATED, 99);
    expect(airplaneRowStableId(halfInflated)).not.toBe(airplaneRowStableId(laterObserve));

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: halfInflated,
      settleObserve: settleFor(fake, timer),
    });

    expect(airplaneRowStableId(outcome.observation)).toBe(airplaneRowStableId(laterObserve));
  });

  test("metadata only the action could attach survives the replacement", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    // Written onto the capture by the action pipeline, never by ObserveScreen.
    (captured as any).gfxMetrics = { totalFrames: 12 };
    (captured as any).selectedElements = [{ text: "Airplane mode" }];

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    expect((outcome.observation as any).gfxMetrics).toEqual({ totalFrames: 12 });
    expect((outcome.observation as any).selectedElements).toEqual([{ text: "Airplane mode" }]);
    // ...while the hierarchy itself is the settled one, not the half-inflated one.
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any).node.node.length).toBe(2);
  });

  test("the action's wait timeout reason survives replacing its capture", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);
    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const timeoutReason =
      'Timed out after 5000 ms waiting for posture "closed"; last observed posture "opened"';
    captured.timeoutReason = timeoutReason;
    captured.timedOut = true;
    captured.awaitTimeout = true;

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.observation).not.toBe(captured);
    expect(outcome.settled).toBe(true);
    expect(outcome.observation.timeoutReason).toBe(timeoutReason);
    expect(outcome.observation.timedOut).toBe(true);
    expect(outcome.observation.awaitTimeout).toBe(true);
  });

  test("in-place actions keep the single capture and report settled:false", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 20));

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "inPlace",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("scroll and unknown classes are likewise not gated", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 20));
    for (const actionClass of ["scroll", "unknown"] as const) {
      const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
      const outcome = await settleEmbeddedObservation({
        actionClass,
        observation: captured,
        settleObserve: settleFor(fake, timer),
      });
      expect(outcome.settled).toBe(false);
      expect(outcome.observation).toBe(captured);
    }
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a never-stable screen reports settled:false within the bound", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A ticking label: never two structurally-equal consecutive reads.
    fake.setObserveResult((index) =>
      obs(
        {
          class: "android.widget.TextView",
          "resource-id": "android:id/clock",
          text: `0:0${index}`,
        },
        20 + index * 10,
      ),
    );

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(timer.now()).toBeLessThan(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS * 3);
  });

  test("the settle loop is forced strictly past the capture the action already holds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: settleFor(fake, timer),
    });

    // First poll floors at capture.updatedAt + 1 so a still-fresh cache entry
    // for the half-inflated tree cannot be served back as the settled answer.
    expect(fake.getExecuteMinTimestamps()[0]).toBe(11);
  });

  test("a settle failure degrades to the original capture rather than failing the tool", async () => {
    const timer = new FakeTimer();
    const fake = new FakeObserveScreen();
    fake.setFailureMode("execute", new Error("ctrlproxy read failed"));

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
  });

  test("a cancelled request returns the original observation without starting a capture", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(obs(AIRPLANE_ROW_INFLATED, 20));

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    // The action already ran; turning its completed result into an error would
    // invite a client retry, i.e. a second tap.
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
      signal: controller.signal,
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
    expect(fake.getExecuteCallCount()).toBe(0);
    expect(fake.getCaptureScreenshotCallCount()).toBe(0);
  });
});

describe("settleEmbeddedObservationInResponse (#6866)", () => {
  function tapOnResponse(observation: ObserveResult) {
    return createStructuredToolResponse({ success: true, action: "tap", observation });
  }

  test("rewrites BOTH representations with the settled observation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const response = tapOnResponse(obs(AIRPLANE_ROW_HALF_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    const structured = response.structuredContent as Record<string, any>;
    expect(structured.observation.settled).toBe(true);
    const fromText = JSON.parse(response.content[0].text);
    expect(fromText.observation.settled).toBe(true);
    expect(fromText.observation.viewHierarchy.hierarchy.node.node.node.length).toBe(2);
  });

  test("stamps settled:false on a non-gated action without observing", async () => {
    const fake = new FakeObserveScreen();
    const response = tapOnResponse(obs(AIRPLANE_ROW_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "sendKeys",
      args: { commands: [{ action: "clear" }] },
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(false);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("internal tool-to-tool calls are left alone", async () => {
    const fake = new FakeObserveScreen();
    const response = tapOnResponse(obs(AIRPLANE_ROW_HALF_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: true,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBeUndefined();
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a failed action is not re-observed", async () => {
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({
      success: false,
      error: "element not found",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect(fake.getExecuteCallCount()).toBe(0);
    // ...but the verdict is still stamped: the capture exists and was never
    // stability-checked, and the contract says every action observation carries
    // a boolean.
    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(false);
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(false);
  });

  test("a handler's own settled:true verdict is never downgraded", async () => {
    // `systemTray({action: "tap"})` already polls for a changed hierarchy that
    // stays structurally stable and publishes the verdict at the payload top
    // level. It is not one of the classified action tools, so the gate would
    // otherwise stamp `settled: false` onto the very capture that verdict
    // describes -- two contradictory answers in one response.
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({
      success: true,
      message: "Tapped notification",
      settled: true,
      observation: obs(AIRPLANE_ROW_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "systemTray",
      args: { action: "tap" },
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(true);
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(true);
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("a handler's own settled:false verdict is not promoted either", async () => {
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({
      success: true,
      message: "Tapped notification; effect not yet settled",
      settled: false,
      observation: obs(AIRPLANE_ROW_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "systemTray",
      args: { action: "tap" },
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(false);
  });

  test("a handler's own settled:true skips the navigation gate entirely", async () => {
    // `openLink`'s integrated `waitFor`/`settled` gate ALREADY proved this
    // capture stable. Running the navigation gate on top of it would spend a
    // second settle budget on a screen that is done moving and -- on a screen
    // that never reaches structural stability -- would time out, adopt a later
    // frame, and stamp `observation.settled: false` underneath the payload-level
    // `settled: true` the handler published. One response, two contradictory
    // verdicts. So the gate does not run at all.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A ticking clock: if the gate DID run it would never see two structurally
    // equal reads, time out, and adopt the newest frame.
    fake.setObserveResult((index) =>
      obs(
        {
          class: "android.widget.TextView",
          "resource-id": "android:id/clock",
          text: `0:0${index}`,
        },
        20 + index * 10,
      ),
    );

    const handlerObservation = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const response = createStructuredToolResponse({
      success: true,
      settled: true,
      observation: handlerObservation,
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "openLink",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    const structured = response.structuredContent as Record<string, any>;
    expect(fake.getExecuteCallCount()).toBe(0);
    expect(structured.settled).toBe(true);
    expect(structured.observation.settled).toBe(true);
    // The handler's own capture is what is handed back, untouched.
    expect(structured.observation.viewHierarchy.hierarchy.node["resource-id"]).toBe(
      "android:id/list_container",
    );
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(true);
  });

  test("no embedded observation is a no-op", async () => {
    const fake = new FakeObserveScreen();
    const response = createStructuredToolResponse({ success: true });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, new FakeTimer()),
    });

    expect(response.structuredContent).toEqual({ success: true });
    expect(fake.getExecuteCallCount()).toBe(0);
  });

  test("no settle delegate (device unresolved) leaves the response untouched", async () => {
    const response = tapOnResponse(obs(AIRPLANE_ROW_HALF_INFLATED, 10));
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => undefined,
    });

    expect((response.structuredContent as Record<string, any>).observation.settled).toBeUndefined();
  });
});

describe("settleEmbeddedObservation adoption guard (#6866)", () => {
  test.each([
    "missing hierarchy",
    "error hierarchy",
    "stale",
    "unverified",
    "older timestamp",
    "missing timestamp",
  ])("a rejected %s capture cannot report the original observation settled", async (reason) => {
    const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const settled = obs(AIRPLANE_ROW_INFLATED, 11);
    switch (reason) {
      case "missing hierarchy":
        delete settled.viewHierarchy;
        break;
      case "error hierarchy":
        settled.viewHierarchy!.hierarchy = { error: "capture unavailable" };
        break;
      case "stale":
        settled.freshness = { isFresh: false };
        break;
      case "unverified":
        settled.freshness = { isFresh: true, verified: false };
        break;
      case "older timestamp":
        settled.viewHierarchy!.updatedAt = 9;
        break;
      case "missing timestamp":
        delete settled.viewHierarchy!.updatedAt;
        break;
    }
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: { execute: async () => ({ observation: settled, settled: true, polls: 2 }) },
    });

    expect(result.observation).toBe(action);
    expect(result.settled).toBe(false);
  });

  test("a fallback capture OLDER than the action's own is never adopted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Every poll serves a pre-tap cache entry: older than the capture the action
    // already holds, so `pollObserveUntil` admits none of them and falls back to
    // the last raw read on timeout.
    fake.setObserveResult(obs(AIRPLANE_ROW_HALF_INFLATED, 50));

    const captured = obs(AIRPLANE_ROW_INFLATED, 100);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
  });

  test("an explicitly stale fallback capture is never adopted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Newer by device clock, but ObserveScreen retracted its freshness (a
    // wrong-window capture, #5867). It is not evidence the gate may promote.
    fake.setObserveResult({
      ...obs(AIRPLANE_ROW_HALF_INFLATED, 200),
      freshness: { isFresh: false, category: "window_identity" },
    } as ObserveResult);

    const captured = obs(AIRPLANE_ROW_INFLATED, 100);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).toBe(captured);
  });

  test("a trustworthy newer frame is still adopted on timeout, flagged unsettled", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // A ticking clock: never two structurally-equal reads, but every read is a
    // genuine post-action capture. The newest one beats the half-inflated tree
    // the action holds, so the gate hands it back — honestly unsettled.
    fake.setObserveResult((index) =>
      obs(
        {
          class: "android.widget.TextView",
          "resource-id": "android:id/clock",
          text: `0:0${index}`,
        },
        20 + index * 10,
      ),
    );

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(false);
    expect(outcome.observation).not.toBe(captured);
    expect((outcome.observation.viewHierarchy!.hierarchy.node as any)["resource-id"]).toBe(
      "android:id/clock",
    );
  });
});

describe("settleEmbeddedObservation abort fence (#9880)", () => {
  const FENCE_MS =
    EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS + EMBEDDED_OBSERVATION_SETTLE_FENCE_MARGIN_MS;

  /** FakeTimer auto-advance does not list timeouts as pending, so log arm/clear explicitly. */
  class FenceRecordingTimer extends FakeTimer {
    readonly armed: Array<{ ms: number; handle: NodeJS.Timeout }> = [];
    readonly cleared: NodeJS.Timeout[] = [];

    override setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
      const handle = super.setTimeout(callback, ms);
      this.armed.push({ ms, handle });
      return handle;
    }

    override clearTimeout(handle: NodeJS.Timeout): void {
      this.cleared.push(handle);
      super.clearTimeout(handle);
    }

    /** Delays of armed timeouts that were never cleared. */
    uncleared(): number[] {
      return this.armed.filter((t) => !this.cleared.includes(t.handle)).map((t) => t.ms);
    }
  }

  function tickingClock(index: number): ObserveResult {
    return obs(
      { class: "android.widget.TextView", "resource-id": "android:id/clock", text: `0:0${index}` },
      20 + index * 10,
    );
  }

  /** The root node's `text`, read through the typed hierarchy accessor. */
  function rootText(observation: ObserveResult): unknown {
    return nodeAttributes(observation.viewHierarchy!.hierarchy.node!)["text"];
  }

  /** Records the signal and the fence timers armed while the loop runs. */
  function recordingSettle(
    inner: SettleObserve,
    timer: FenceRecordingTimer,
  ): { settle: SettleObserve; signals: AbortSignal[]; pendingAtStart: number[][] } {
    const signals: AbortSignal[] = [];
    const pendingAtStart: number[][] = [];
    const settle: SettleObserve = {
      captureScreenshot: inner.captureScreenshot?.bind(inner),
      execute: async (options) => {
        pendingAtStart.push(timer.uncleared());
        if (options.signal) {
          signals.push(options.signal);
        }
        return inner.execute(options);
      },
    };
    return { settle, signals, pendingAtStart };
  }

  test("a never-settling screen ends through the loop budget: newest capture, cached, no warning", async () => {
    const timer = new FenceRecordingTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(tickingClock);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const recorded = recordingSettle(settleFor(fake, timer), timer);
      const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
      const outcome = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: captured,
        settleObserve: recorded.settle,
        timer,
      });

      // The fence is armed on the injected timer strictly after the loop budget.
      expect(recorded.pendingAtStart).toEqual([[FENCE_MS]]);
      expect(FENCE_MS).toBeGreaterThan(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
      expect(timer.now()).toBe(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
      expect(recorded.signals[0].aborted).toBe(false);

      const lastIndex = fake.getExecuteCallCount() - 1;
      const returnedText = rootText(outcome.observation);
      expect(outcome.settled).toBe(false);
      expect(outcome.observation).not.toBe(captured);
      expect(returnedText).toBe(rootText(tickingClock(lastIndex)));
      const cached = fake.getCacheObserveResultObservations();
      expect(cached).toHaveLength(1);
      expect(rootText(cached[0])).toBe(returnedText);
      expect(warn).not.toHaveBeenCalled();
      expect(timer.uncleared().filter((ms) => ms === FENCE_MS)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a screen that settles early returns then and leaves no timer pending", async () => {
    const timer = new FenceRecordingTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_HALF_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);
    const recorded = recordingSettle(settleFor(fake, timer), timer);
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: recorded.settle,
      timer,
    });

    expect(outcome.settled).toBe(true);
    expect(timer.now()).toBeLessThan(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
    expect(recorded.signals[0].aborted).toBe(false);
    expect(timer.uncleared().filter((ms) => ms === FENCE_MS)).toEqual([]);
  });

  test("a caller cancel mid-poll aborts promptly with the caller's reason, not the fence's", async () => {
    const timer = new FenceRecordingTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveResult(tickingClock);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    timer.setTimeout(() => controller.abort(reason), 300);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const recorded = recordingSettle(settleFor(fake, timer), timer);
      const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
      const outcome = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: captured,
        settleObserve: recorded.settle,
        signal: controller.signal,
        timer,
      });

      expect(outcome.observation).toBe(captured);
      expect(outcome.settled).toBe(false);
      expect(timer.now()).toBeLessThan(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
      expect(recorded.signals[0].aborted).toBe(true);
      expect(recorded.signals[0].reason).toBe(reason);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(timer.uncleared().filter((ms) => ms === FENCE_MS)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("the fence still bounds a read that hangs past the loop budget", async () => {
    const timer = new FenceRecordingTimer();
    let seen: AbortSignal | undefined;
    const hung: SettleObserve = {
      execute: (options) =>
        new Promise((_resolve, reject) => {
          seen = options.signal;
          options.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        }),
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
      const pending = settleEmbeddedObservation({
        actionClass: "navigation",
        observation: captured,
        settleObserve: hung,
        timer,
      });
      timer.advanceTime(FENCE_MS - 1);
      expect(seen?.aborted).toBe(false);
      timer.advanceTime(1);
      const outcome = await pending;

      expect(seen?.aborted).toBe(true);
      expect(outcome.observation).toBe(captured);
      expect(outcome.settled).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(timer.uncleared().filter((ms) => ms === FENCE_MS)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("settleEmbeddedObservation stale-state clearing (#6866)", () => {
  test("screen state the settled capture no longer reports does not survive", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // ObserveScreen re-derives these from EVERY hierarchy and writes `undefined`
    // when the destination has no focused node / no chooser — exactly the shape
    // the settle poll hands back here.
    const settledFrame = {
      ...obs(AIRPLANE_ROW_INFLATED, 20),
      focusedElement: undefined,
      accessibilityFocusedElement: undefined,
      intentChooserDetected: undefined,
      notificationPermissionDetected: undefined,
    } as ObserveResult;
    fake.setObserveSequence([settledFrame, { ...settledFrame, updatedAt: 30 } as ObserveResult]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    (captured as any).focusedElement = { text: "Search", bounds: { left: 0, top: 0 } };
    (captured as any).accessibilityFocusedElement = { text: "Search" };
    (captured as any).intentChooserDetected = true;
    (captured as any).notificationPermissionDetected = true;
    (captured as any).error = "partial hierarchy";
    (captured as any).errors = [{ phase: "hierarchy", message: "partial hierarchy" }];
    // ...while genuinely action-authored metadata still has to survive.
    (captured as any).gfxMetrics = { totalFrames: 12 };

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    expect("focusedElement" in outcome.observation).toBe(false);
    expect("accessibilityFocusedElement" in outcome.observation).toBe(false);
    expect("intentChooserDetected" in outcome.observation).toBe(false);
    expect("notificationPermissionDetected" in outcome.observation).toBe(false);
    expect("error" in outcome.observation).toBe(false);
    expect("errors" in outcome.observation).toBe(false);
    expect((outcome.observation as any).gfxMetrics).toEqual({ totalFrames: 12 });
  });

  test("no capture-derived field outside the action whitelist survives adoption", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // An iOS destination with no identity signals: ObserveScreen assigns
    // `screenIdentity` the value `undefined` rather than omitting it, and the
    // settle poll always passes `skipAccessibilityAudit: true`, so neither of
    // these is defined on the settled capture.
    const settledFrame = {
      ...obs(AIRPLANE_ROW_INFLATED, 20),
      screenIdentity: undefined,
    } as ObserveResult;
    fake.setObserveSequence([settledFrame, { ...settledFrame, updatedAt: 30 } as ObserveResult]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    (captured as any).screenIdentity = {
      platform: "ios",
      source: "heuristic",
      confidence: "high",
      key: "origin-screen",
      components: {},
    };
    (captured as any).rawViewHierarchy = { xcuitest: "{}", source: "xcuitest" };
    (captured as any).observeScope = { mode: "scoped" };
    (captured as any).recompositionSummary = { total: 3 };
    // ...while genuinely action-authored metadata still has to survive.
    (captured as any).gfxMetrics = { totalFrames: 12 };
    (captured as any).selectedElements = [{ text: "Airplane mode" }];

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    // A stale `screenIdentity` would let diff mode read a cross-screen
    // transition as same-screen.
    expect("screenIdentity" in outcome.observation).toBe(false);
    expect("rawViewHierarchy" in outcome.observation).toBe(false);
    expect("observeScope" in outcome.observation).toBe(false);
    expect("recompositionSummary" in outcome.observation).toBe(false);
    expect((outcome.observation as any).gfxMetrics).toEqual({ totalFrames: 12 });
    expect((outcome.observation as any).selectedElements).toEqual([{ text: "Airplane mode" }]);
  });
});

describe("settleEmbeddedObservation accessibility audit (#6890)", () => {
  /** The shape `AccessibilityAuditor.run` attaches, trimmed to what matters here. */
  const auditOfTheHalfInflatedTree = {
    screenId: "com.android.settings/.SubSettings#half",
    violations: [{ ruleId: "touch-target-size", elementId: "2f0e3dad" }],
    summary: { passed: false, bySeverity: { error: 1, warning: 0 } },
  };

  test("an adopted settled capture never carries the audit of the capture it replaced", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // The settle poll always passes `skipAccessibilityAudit: true`, so no poll
    // result ever carries an audit of its own.
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const captured = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    (captured as any).accessibilityAudit = auditOfTheHalfInflatedTree;

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    // Its elements, violations, fingerprint and screen id all describe the
    // half-inflated tree that is no longer being returned.
    expect("accessibilityAudit" in outcome.observation).toBe(false);
    // ...and its absence is explained rather than silent: an audit the caller
    // explicitly asked for must not simply evaporate.
    expect(outcome.observation.accessibilityAuditSkipped).toBe("settled_capture_adopted");
  });

  test("an audit survives when the settled capture is NOT adopted", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    // Every poll serves a pre-action cache entry, so nothing is adoptable and
    // the action's own capture — the one the audit describes — is handed back.
    fake.setObserveResult(obs(AIRPLANE_ROW_HALF_INFLATED, 5));

    const captured = obs(AIRPLANE_ROW_INFLATED, 100);
    (captured as any).accessibilityAudit = auditOfTheHalfInflatedTree;

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: captured,
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.observation).toBe(captured);
    expect(outcome.settled).toBe(false);
    expect(outcome.observation.accessibilityAudit).toEqual(auditOfTheHalfInflatedTree as any);
    expect(outcome.observation.accessibilityAuditSkipped).toBeUndefined();
  });

  test("no marker is added when no audit was requested", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(AIRPLANE_ROW_INFLATED, 20),
      obs(AIRPLANE_ROW_INFLATED, 30),
      obs(AIRPLANE_ROW_INFLATED, 40),
    ]);

    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: settleFor(fake, timer),
    });

    expect(outcome.settled).toBe(true);
    expect("accessibilityAuditSkipped" in outcome.observation).toBe(false);
  });
});

describe("settle poll cost (#6890 review)", () => {
  test("every poll skips the performance audit, not just the screenshot and a11y audit", async () => {
    // The performance audit drives up to three synthetic touches plus ADB and
    // DB work that honours none of this gate's one-second budget. Running it
    // per poll on the hot path of every navigation action would perturb the
    // very screen being settled and corrupt the measurement.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
      settleObserve: settleFor(fake, timer),
    });

    const options = fake.getExecuteOptions();
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.skipPerformanceAudit === true)).toBe(true);
    expect(options.every((option) => option.skipRecompositionTracking === true)).toBe(true);
    expect(options.every((option) => option.skipScreenshot === true)).toBe(true);
    expect(options.every((option) => option.skipAccessibilityAudit === true)).toBe(true);
    expect(fake.getProcessRecompositionCallCount()).toBe(1);
  });
});

describe("handler settle verdicts skip the generic gate (#6890 review)", () => {
  test("a handler's own settled:false also skips the navigation gate", async () => {
    // `openLink` runs its own integrated `waitFor` settle and publishes the
    // verdict at the payload top level. When that wait TIMES OUT it publishes
    // `settled: false` -- still a verdict about this capture. Running the
    // generic gate on top of it would re-observe, possibly adopt a later frame,
    // and stamp `observation.settled: true` underneath the payload-level
    // `settled: false`, with the handler's wait metadata now describing a
    // capture that is no longer there.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const handlerObservation = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    const response = createStructuredToolResponse({
      success: true,
      settled: false,
      awaitTimeout: true,
      observation: handlerObservation,
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "openLink",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    const structured = response.structuredContent as Record<string, any>;
    expect(fake.getExecuteCallCount()).toBe(0);
    expect(structured.settled).toBe(false);
    expect(structured.observation.settled).toBe(false);
    // The handler's own capture is what is handed back, untouched.
    expect(structured.observation.viewHierarchy.hierarchy.node["resource-id"]).toBe(
      "android:id/list_container",
    );
    expect(JSON.parse(response.content[0].text).observation.settled).toBe(false);
  });

  test("a handler verdict is still absent when the payload's settled is not a boolean", async () => {
    // Only a real boolean is a verdict. A payload that carries no `settled`
    // (every ordinary action tool) must still be gated.
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(AIRPLANE_ROW_INFLATED, 20), obs(AIRPLANE_ROW_INFLATED, 30)]);

    const response = createStructuredToolResponse({
      success: true,
      action: "tap",
      observation: obs(AIRPLANE_ROW_HALF_INFLATED, 10),
    });
    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: {},
      internal: false,
      createSettleObserve: () => settleFor(fake, timer),
    });

    expect(fake.getExecuteCallCount()).toBeGreaterThan(0);
    expect((response.structuredContent as Record<string, any>).observation.settled).toBe(true);
  });
});

describe("explicit-display embedded observation", () => {
  test("settle polls use the action's resolved panel instead of its role selector", async () => {
    const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    action.display = { key: "external-key", role: "external", posture: "unknown", generation: 2 };
    const settled = obs(AIRPLANE_ROW_INFLATED, 11);
    settled.display = { ...action.display };
    let requestedDisplay: string | undefined;
    const response = createStructuredToolResponse({ success: true, observation: action });
    const timer = new FakeTimer();

    await settleEmbeddedObservationInResponse(response, {
      name: "tapOn",
      args: { display: "external" },
      internal: false,
      timer,
      createSettleObserve: () => ({
        execute: async (options) => {
          requestedDisplay = options?.display;
          return { observation: settled, settled: true, polls: 2 };
        },
      }),
    });

    expect(requestedDisplay).toBe("external-key");
    const payload = JSON.parse(response.content[0].text);
    expect(payload.observation).toEqual({ ...settled, settled: true, settleMs: 0, settlePolls: 2 });
    expect(payload.observation.display).not.toHaveProperty("pinned");
  });

  test.each(["internal-key", undefined])(
    "an unpinned capture cannot be replaced by panel %s",
    async (key) => {
      const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
      action.display = { key: "external-key", role: "external", posture: "unknown", generation: 2 };
      const settled = obs(AIRPLANE_ROW_INFLATED, 11);
      if (key !== undefined) {
        settled.display = { key, role: "inner", posture: "unknown", generation: 2 };
      }
      let requestedDisplay: string | undefined;
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: action,
        args: { display: "external" },
        settleObserve: {
          execute: async (options) => {
            requestedDisplay = options?.display;
            return { observation: settled, settled: true, polls: 2 };
          },
        },
      });

      expect(result.observation).toBe(action);
      expect(result.settled).toBe(false);
      expect(requestedDisplay).toBe("external-key");
    },
  );

  test("a single-display action without a selector retains default polling and adopts its newer capture", async () => {
    const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    action.display = { key: "0", role: "unknown", posture: "unknown", generation: 0 };
    const settled = obs(AIRPLANE_ROW_INFLATED, 11);
    settled.display = { ...action.display };
    let requestedDisplay: string | undefined = "unexpected";
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: {
        execute: async (options) => {
          requestedDisplay = options?.display;
          return { observation: settled, settled: true, polls: 2 };
        },
      },
    });

    expect(requestedDisplay).toBeUndefined();
    expect(result.observation).toEqual(settled);
    expect(result.settled).toBe(true);
  });

  test("default polling adopts a focused panel capture after a posture-default action capture", async () => {
    const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    action.platform = "android";
    action.display = { key: "outside", role: "cover", posture: "closed", generation: 2 };
    action.selectedElements = [];
    const settled = obs(AIRPLANE_ROW_INFLATED, 11);
    settled.platform = "android";
    settled.display = { key: "inside", role: "inner", posture: "opened", generation: 2 };
    let requestedDisplay: string | undefined = "unexpected";
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: {
        execute: async (options) => {
          requestedDisplay = options?.display;
          return { observation: settled, settled: true, polls: 2 };
        },
      },
    });

    expect(requestedDisplay).toBeUndefined();
    expect(result.observation).toEqual({ ...settled, selectedElements: [] });
    expect(result.settled).toBe(true);
  });

  test.each([false, true])(
    "default iOS polling adopts a capture with a changed fallback key (reverse: %s)",
    async (reverse) => {
      const action = obs({ class: "XCUIElementTypeStaticText", label: "Loading" }, 10);
      action.platform = "ios";
      action.activeWindow = { appId: "com.example.app" };
      action.screenSize = reverse ? { width: 1170, height: 2532 } : { width: 0, height: 0 };
      action.viewHierarchy!.packageName = "com.example.app";
      action.display = {
        key: reverse ? "main-panel" : "0",
        role: "unknown",
        posture: "unknown",
        generation: 0,
      };
      const settled = obs({ class: "XCUIElementTypeStaticText", label: "Ready" }, 11);
      settled.platform = "ios";
      settled.activeWindow = { appId: "com.example.app" };
      settled.screenSize = reverse ? { width: 0, height: 0 } : { width: 1170, height: 2532 };
      settled.viewHierarchy!.packageName = "com.example.app";
      settled.display = {
        key: reverse ? "0" : "main-panel",
        role: "unknown",
        posture: "unknown",
        generation: 0,
      };
      const result = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: action,
        settleObserve: {
          execute: async (options) => {
            expect(options?.display).toBeUndefined();
            return { observation: settled, settled: true, polls: 2 };
          },
        },
      });

      expect(result.observation).toEqual(settled);
      expect(result.settled).toBe(true);
    },
  );
});

describe("session-pinned embedded observation", () => {
  test("settle polls retain the pinned panel and additive selection marker", async () => {
    const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    action.display = {
      key: "outside",
      role: "cover",
      posture: "closed",
      generation: 2,
      pinned: true,
    };
    const settled = obs(AIRPLANE_ROW_INFLATED, 11);
    settled.display = { key: "outside", role: "cover", posture: "closed", generation: 2 };
    let requestedDisplay: string | undefined;
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: {
        execute: async (options) => {
          requestedDisplay = options?.display;
          return { observation: settled, settled: true, polls: 2 };
        },
      },
    });
    expect(requestedDisplay).toBe("outside");
    expect(result.observation.display).toEqual({ ...settled.display, pinned: true });
    expect(settled.display).not.toHaveProperty("pinned");
  });

  test("a settle capture from another panel cannot replace the pinned capture", async () => {
    const action = obs(AIRPLANE_ROW_HALF_INFLATED, 10);
    action.display = {
      key: "outside",
      role: "cover",
      posture: "closed",
      generation: 2,
      pinned: true,
    };
    const settled = obs(AIRPLANE_ROW_INFLATED, 11);
    settled.display = { key: "inside", role: "inner", posture: "opened", generation: 2 };
    const result = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: action,
      settleObserve: { execute: async () => ({ observation: settled, settled: true, polls: 2 }) },
    });
    expect(result.observation).toBe(action);
    expect(result.settled).toBe(false);
  });
});

describe("pending terminal screenshot finalization", () => {
  function action() {
    const result = screenshotAction();
    delete result.screenshotPath;
    delete result.screenshotSource;
    delete result.screenshotCapturedAt;
    result.screenshotCaptureAttempted = false;
    return result;
  }

  test.each(["stale", "unverified", "unusable", "older", "incomparable", "wrong-panel"])(
    "keep %s captures once after the gate decides",
    async (reason) => {
      const original = action();
      original.display = { key: "panel", role: "external", posture: "unknown", generation: 1 };
      const candidate = {
        ...original,
        observationId: "candidate",
        updatedAt: 20,
        viewHierarchy: { ...original.viewHierarchy!, updatedAt: 20 },
      };
      if (reason === "stale") {
        candidate.freshness = { isFresh: false };
      }
      if (reason === "unverified") {
        candidate.freshness = { isFresh: true, verified: false };
      }
      if (reason === "unusable") {
        candidate.viewHierarchy = undefined;
      }
      if (reason === "older") {
        candidate.viewHierarchy!.updatedAt = 9;
      }
      if (reason === "incomparable") {
        candidate.viewHierarchy!.updatedAt = undefined;
      }
      if (reason === "wrong-panel") {
        candidate.display = { ...original.display, key: "other" };
      }
      const events: string[] = [];
      const delegate: SettleObserve = {
        execute: async () => {
          events.push("decision");
          return {
            observation: candidate,
            settled: true,
            polls: 2,
            waitMs: 0,
            terminalReason: "settled",
          };
        },
      };
      await runWithPostActionCaptureScope(undefined, async () => {
        deferTerminalScreenshot(original, async (chosen) => {
          events.push("capture");
          chosen.screenshotPath = "/fake/kept.png";
        });
        const outcome = await settleEmbeddedObservation({
          actionClass: "navigation",
          observation: original,
          args: { display: "external" },
          settleObserve: delegate,
        });
        expect(outcome.observation).toBe(original);
        expect(outcome.observation.screenshotPath).toBe("/fake/kept.png");
        expect(events).toEqual(["decision", "capture"]);
        expect(hasPendingTerminalScreenshot(original)).toBe(false);
      });
    },
  );

  test.each(["error", "deadline"])(
    "poll %s finalizes once when caller is not aborted",
    async (reason) => {
      const original = action();
      const controller = new AbortController();
      let captures = 0;
      await runWithPostActionCaptureScope(controller.signal, async () => {
        deferTerminalScreenshot(original, async (chosen) => {
          captures++;
          chosen.screenshotPath = "/fake/kept.png";
        });
        const outcome = await settleEmbeddedObservation({
          actionClass: "navigation",
          observation: original,
          signal: controller.signal,
          settleObserve: {
            execute: async () => {
              throw new DOMException(reason, reason === "deadline" ? "TimeoutError" : "Error");
            },
          },
        });
        expect(controller.signal.aborted).toBe(false);
        expect(outcome.observation.screenshotPath).toBe("/fake/kept.png");
        expect(outcome.settled).toBe(false);
        expect(captures).toBe(1);
      });
    },
  );

  test("caller cancellation during polling drops pending capture", async () => {
    const original = action();
    const controller = new AbortController();
    let captures = 0;
    await runWithPostActionCaptureScope(controller.signal, async () => {
      deferTerminalScreenshot(original, async () => {
        captures++;
      });
      const outcome = await settleEmbeddedObservation({
        actionClass: "navigation",
        observation: original,
        signal: controller.signal,
        settleObserve: {
          execute: async () => {
            controller.abort();
            throw new DOMException("cancelled", "AbortError");
          },
        },
      });
      expect(outcome.observation).toBe(original);
      expect(outcome.settled).toBe(false);
      expect(captures).toBe(0);
      expect(hasPendingTerminalScreenshot(original)).toBe(false);
    });
    expect(captures).toBe(0);
  });

  test.each(["retry succeeds", "both fail", "cancel before retry"])(
    "adopt capture: %s",
    async (mode) => {
      const original = action();
      const chosen = {
        ...original,
        observationId: "chosen",
        updatedAt: 20,
        viewHierarchy: { ...original.viewHierarchy!, updatedAt: 20 },
      };
      const controller = new AbortController();
      const capturedIds: string[] = [];
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await runWithPostActionCaptureScope(controller.signal, async () => {
          deferTerminalScreenshot(original, async () => {
            throw new Error("must use chosen seam");
          });
          const outcome = await settleEmbeddedObservation({
            actionClass: "navigation",
            observation: original,
            signal: controller.signal,
            settleObserve: {
              execute: async () => ({
                observation: chosen,
                settled: true,
                polls: 2,
                waitMs: 0,
                terminalReason: "settled",
              }),
              captureScreenshot: async (frame) => {
                capturedIds.push(frame.observationId);
                if (mode === "cancel before retry") {
                  controller.abort();
                }
                if (capturedIds.length === 1 || mode !== "retry succeeds") {
                  throw new Error("capture failed");
                }
                frame.screenshotPath = "/fake/chosen.png";
              },
            },
          });
          expect(outcome.observation.observationId).toBe("chosen");
          expect(outcome.observation.screenshotCaptureAttempted).toBe(true);
          expect(capturedIds).toEqual(
            mode === "cancel before retry" ? ["chosen"] : ["chosen", "chosen"],
          );
          expect(outcome.observation.screenshotPath).toBe(
            mode === "retry succeeds" ? "/fake/chosen.png" : undefined,
          );
          const emitted = finalizeToolResponse(
            createStructuredToolResponse({ success: true, observation: outcome.observation }),
            { name: "tapOn" },
          );
          expect(
            emitted.structuredContent!.observation.observationScreenshotResourceUri !== undefined,
          ).toBe(mode === "retry succeeds");
          expect(warning).toHaveBeenCalledTimes(mode === "both fail" ? 2 : 1);
        });
      } finally {
        warning.mockRestore();
      }
    },
  );
});

test("explicit-display terminal capture failure degrades the chosen frame without throwing", async () => {
  const original = screenshotAction();
  original.display = { key: "external", role: "external", posture: "unknown", generation: 1 };
  delete original.screenshotPath;
  const chosen = {
    ...original,
    observationId: "chosen",
    updatedAt: 20,
    viewHierarchy: { ...original.viewHierarchy!, updatedAt: 20 },
  };
  let attempts = 0;
  await runWithPostActionCaptureScope(undefined, async () => {
    deferTerminalScreenshot(original, async () => {});
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: original,
      args: { display: "external" },
      settleObserve: {
        execute: async () => ({
          observation: chosen,
          settled: true,
          polls: 2,
          waitMs: 0,
          terminalReason: "settled",
        }),
        captureScreenshot: async () => {
          attempts++;
          throw new Error("display capture failed");
        },
      },
    });
    expect(attempts).toBe(2);
    expect(outcome.observation.observationId).toBe("chosen");
    expect(outcome.observation.screenshotPath).toBeUndefined();
    expect(outcome.settled).toBe(false);
    expect(outcome.observation.freshness?.warning).toContain("terminal screenshot/audit failed");
  });
});

test("single terminal capture produces the audit for the chosen frame", async () => {
  const original = screenshotAction();
  delete original.screenshotPath;
  const chosen = {
    ...original,
    observationId: "audit-chosen",
    updatedAt: 20,
    viewHierarchy: { ...original.viewHierarchy!, updatedAt: 20 },
    accessibilityAuditSkipped: "settled_capture_adopted" as const,
  };
  let captures = 0;
  const audit = { frame: "audit-chosen" };
  await runWithPostActionCaptureScope(undefined, async () => {
    deferTerminalScreenshot(original, async () => {
      throw new Error("wrong frame");
    });
    const outcome = await settleEmbeddedObservation({
      actionClass: "navigation",
      observation: original,
      settleObserve: {
        execute: async () => ({
          observation: chosen,
          settled: true,
          polls: 2,
          waitMs: 0,
          terminalReason: "settled",
        }),
        captureScreenshot: async (frame) => {
          captures++;
          frame.screenshotPath = "/fake/audit-chosen.png";
          Object.assign(frame, { accessibilityAudit: audit });
        },
      },
    });
    expect(captures).toBe(1);
    expect(outcome.observation.accessibilityAudit).toEqual(audit);
    expect(outcome.observation.accessibilityAuditSkipped).toBeUndefined();
  });
});

test.each([
  "adopt",
  "keep",
  "poll error",
  "capture error",
  "cancel",
  "display",
  "failed",
  "handler settled",
  "in-place",
  "internal",
  "observe",
  "no device",
  "no envelope",
])("disabled screenshot and audit policy captures zero on %s", async (path) => {
  const original = screenshotAction();
  original.screenshotCaptureAttempted = false;
  delete original.screenshotPath;
  const candidate = {
    ...original,
    observationId: "disabled-candidate",
    updatedAt: 20,
    viewHierarchy: { ...original.viewHierarchy!, updatedAt: 20 },
  };
  if (path === "keep") {
    candidate.freshness = { isFresh: false };
  }
  const controller = new AbortController();
  let captures = 0;
  const delegate: SettleObserve = {
    execute: async () => {
      if (path === "cancel") {
        controller.abort();
      }
      if (path === "poll error" || path === "cancel") {
        throw new Error("poll failed");
      }
      return {
        observation: candidate,
        settled: true,
        polls: 2,
        waitMs: 0,
        terminalReason: "settled",
      };
    },
    captureScreenshot: async () => {
      captures++;
      throw new Error("capture should not run");
    },
  };
  const response =
    path === "no envelope"
      ? undefined
      : createStructuredToolResponse({
          success: path !== "failed",
          observation: original,
          ...(path === "handler settled" ? { settled: true } : {}),
        });
  await runWithPostActionCaptureScope(controller.signal, async () => {
    await settleEmbeddedObservationInResponse(response, {
      name: path === "in-place" ? "sendKeys" : path === "observe" ? "observe" : "tapOn",
      args: path === "display" ? { display: "external" } : {},
      internal: path === "internal",
      signal: controller.signal,
      createSettleObserve: () => (path === "no device" ? undefined : delegate),
    });
    expect(hasPendingTerminalScreenshot(original)).toBe(false);
  });
  expect(captures).toBe(0);
});

const captureFailurePaths = [
  "rejected gate",
  "thrown settle",
  "failed action",
  "handler settled",
  "no settle observe",
  "not gated",
  "adopt",
  "finally bypass",
] as const;
describe("explicit-display deferred terminal capture failure", () => {
  test.each(captureFailurePaths)(
    "%s preserves warning and stale display in structured and text envelopes",
    async (path) => {
      for (const textOnly of [false, true]) {
        const action = obs({}, 10);
        action.deviceId = "fake-device";
        action.observationId = "action";
        action.display = {
          key: "panel",
          role: "external",
          posture: "unknown",
          generation: 1,
          pinned: true,
        };
        action.freshness = { isFresh: true, warning: "existing warning" };
        const chosen = {
          ...action,
          observationId: "adopted",
          viewHierarchy: { ...action.viewHierarchy, updatedAt: 20 },
        };
        const error = new StaleDisplayError({
          observedGeneration: 1,
          currentGeneration: 2,
          currentDisplayKey: "panel",
          retry: "observe",
        });
        const capture = async () => {
          throw error;
        };
        const settle: SettleObserve = {
          async execute() {
            if (path === "thrown settle") {
              throw new Error("settle unavailable");
            }
            return {
              observation:
                path === "rejected gate" ? { ...chosen, freshness: { isFresh: false } } : chosen,
              settled: true,
              polls: 2,
              waitMs: 0,
              terminalReason: "settled",
            };
          },
          captureScreenshot: capture,
        };
        const initial = {
          success: path !== "failed action",
          observation: action,
          marker: "intact",
          ...(path === "handler settled" ? { settled: true } : {}),
        };
        const response = textOnly
          ? { content: [{ type: "text", text: JSON.stringify(initial) }] }
          : createStructuredToolResponse(initial);
        await runWithPostActionCaptureScope(undefined, async () => {
          deferTerminalScreenshot(action, capture);
          await settleEmbeddedObservationInResponse(response, {
            name:
              path === "not gated"
                ? "captureProbe"
                : path === "finally bypass"
                  ? "observe"
                  : "tapOn",
            args: {},
            internal: false,
            createSettleObserve: () => (path === "no settle observe" ? undefined : settle),
          });
          const result = readToolEnvelopePayload(response)!.payload;
          const final = result.observation as ObserveResult;
          expect(final.freshness?.warning).toBe(
            "existing warning; Post-action terminal screenshot/audit failed; retaining the chosen observation",
          );
          expect(final.settled).toBe(false);
          expect(result.staleDisplay).toEqual(error.details);
          expect(result.marker).toBe("intact");
          expect(result.success).toBe(initial.success);
          expect(final.observationId).toBe(path === "adopt" ? "adopted" : "action");
          if (path === "handler settled") {
            expect(result.settled).toBe(true);
          }
        });
      }
    },
  );

  test.each([
    "implicit",
    "cancelled",
    "successful",
    "existing stale display",
    "args display",
    "generic failure",
  ] as const)("capture failure pin: %s", async (mode) => {
    const action = obs({}, 10);
    action.deviceId = "fake-device";
    action.observationId = "action";
    if (mode !== "implicit" && mode !== "args display") {
      action.display = {
        key: "panel",
        role: "external",
        posture: "unknown",
        generation: 1,
        pinned: true,
      };
    }
    const controller = new AbortController();
    const error = new StaleDisplayError({
      observedGeneration: 1,
      currentGeneration: 2,
      retry: "observe",
    });
    const response = createStructuredToolResponse({
      success: true,
      observation: action,
      ...(mode === "existing stale display" ? { staleDisplay: { existing: true } } : {}),
    });
    await runWithPostActionCaptureScope(controller.signal, async () => {
      deferTerminalScreenshot(action, async () => {
        if (mode === "successful") {
          return;
        }
        if (mode === "cancelled") {
          controller.abort();
        }
        throw mode === "generic failure" ? new Error("capture failed") : error;
      });
      await settleEmbeddedObservationInResponse(response, {
        name: "tapOn",
        args: mode === "args display" ? { display: "panel" } : {},
        internal: false,
        signal: controller.signal,
        createSettleObserve: () => undefined,
      });
      const result = readToolEnvelopePayload(response)!.payload;
      const final = result.observation as ObserveResult;
      const warns = ["existing stale display", "args display", "generic failure"].includes(mode);
      expect(!!final.freshness?.warning).toBe(warns);
      if (warns) {
        expect(final.settled).toBe(false);
      }
      expect(result.staleDisplay).toEqual(
        mode === "existing stale display"
          ? { existing: true }
          : mode === "args display"
            ? error.details
            : undefined,
      );
    });
  });
});
