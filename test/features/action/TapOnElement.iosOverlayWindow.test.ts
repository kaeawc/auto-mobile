import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { IOS_WINDOW_LAYER_EXTRA } from "../../../src/features/observe/ios/iosWindowLayer";
import type { HierarchyDelegateContext } from "../../../src/features/observe/ios/types";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { iosFloatingOverlayOverSettings } from "../../fixtures/observe/iosOverlayWindow";

afterEach(() => AndroidCtrlProxyClient.resetInstances());

function captured(): ViewHierarchyResult {
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(
    iosFloatingOverlayOverSettings(),
  );
}

/** The same capture as a converter without window layers would have produced it. */
function withoutLayers(): ViewHierarchyResult {
  return JSON.parse(
    JSON.stringify(captured()).replaceAll(`"${IOS_WINDOW_LAYER_EXTRA}"`, '"unrelated"'),
  ) as ViewHierarchyResult;
}

async function tapElement(hierarchy: ViewHierarchyResult, elementId: string) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "overlay", platform: "ios", deviceId: "overlay" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const observation: ObserveResult = {
    observationId: "ios-overlay-window",
    updatedAt: 1,
    screenSize: { width: 402, height: 874 },
    viewHierarchy: hierarchy,
    systemInsets: hierarchy.systemInsets,
  };
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = async (action) => ({
    ...(await action(recordObservationRead(observation))),
    observation,
  });
  tap.refreshViewHierarchy = async () => hierarchy;
  tap.executeiOSTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap.execute({ elementId, action: "tap", searchUntil: { duration: 200 } });
  return { result, points };
}

describe("tapOn controls in a captured in-app iOS overlay window", () => {
  test("taps the overlay dismiss control drawn over the app's navigation bar", async () => {
    const { result, points } = await tapElement(captured(), "automobile-overlay-dismiss");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 372, y: 84 }]);
  });

  test("taps the centre of overlay buttons drawn over the app's toolbar", async () => {
    const close = await tapElement(captured(), "close-button");
    expect(close.result.success).toBe(true);
    expect(close.points).toEqual([{ x: 171, y: 802 }]);
  });

  test("without window layers the dismiss control reads as covered and is not tapped", async () => {
    const { result, points } = await tapElement(withoutLayers(), "automobile-overlay-dismiss");
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the navigation bar");
    expect(points).toEqual([]);
  });
});
