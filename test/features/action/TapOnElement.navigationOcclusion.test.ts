import { afterEach, describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  coveredNavigationRow,
  partialNavigationRow,
  visibleNavigationRow,
  navigationScreen,
  syntheticNavigationHierarchy,
} from "../../fixtures/observe/iosNavigationOcclusion";

afterEach(() => AndroidCtrlProxyClient.resetInstances());

async function run(
  initial: ViewHierarchyResult,
  {
    platform = "ios",
    text = "Forms & Input",
    refreshed = initial,
  }: { platform?: "ios" | "android"; text?: string; refreshed?: ViewHierarchyResult } = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "synthetic", platform, deviceId: "synthetic" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const observation: ObserveResult = {
    observationId: "synthetic-navigation",
    updatedAt: 1,
    screenSize: navigationScreen,
    viewHierarchy: initial,
    systemInsets: initial.systemInsets,
  };
  const points: Array<{ x: number; y: number }> = [];
  let refreshes = 0;
  tap.observedInteraction = async (action) => ({ ...(await action(observation)), observation });
  tap.refreshViewHierarchy = async () => {
    refreshes++;
    return refreshed;
  };
  tap.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
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
  const result = await tap.execute({ text, action: "tap", searchUntil: { duration: 200 } });
  return { result, points, refreshes };
}

describe("tapOn synthetic iOS navigation occlusion (#9096)", () => {
  test("fully exposed row keeps its centre; partial row uses the exposed centre", async () => {
    const exposed = await run(syntheticNavigationHierarchy(visibleNavigationRow));
    expect(exposed.result.success).toBe(true);
    expect(exposed.points).toEqual([{ x: 201, y: 159 }]);
    const partial = await run(syntheticNavigationHierarchy(partialNavigationRow));
    expect(partial.result.success).toBe(true);
    expect(partial.points).toEqual([{ x: 201, y: 152 }]);
    const coveredCentre = await run(
      syntheticNavigationHierarchy({ ...partialNavigationRow, top: 90, bottom: 130 }),
    );
    expect(coveredCentre.result.success).toBe(true);
    expect(coveredCentre.points).toEqual([{ x: 201, y: 123 }]);
  });

  test("fully covered row fails with the navigation-bar error after polling, without a tap", async () => {
    const { result, points, refreshes } = await run(syntheticNavigationHierarchy());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Target "Forms & Input" is covered by the navigation bar');
    expect(points).toEqual([]);
    expect(refreshes).toBeGreaterThan(0);
    const labelled = syntheticNavigationHierarchy();
    labelled.hierarchy.node!.node![0].node![0].node![0].$.bounds = {
      left: 16,
      top: 50,
      right: 386,
      bottom: 72,
    };
    const label = await run(labelled);
    expect(label.result.error).toContain("covered by the navigation bar");
    expect(label.points).toEqual([]);
  });

  test("polling recovers when a covered row moves into view", async () => {
    const { result, points, refreshes } = await run(syntheticNavigationHierarchy(), {
      refreshed: syntheticNavigationHierarchy(visibleNavigationRow),
    });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 201, y: 159 }]);
    expect(refreshes).toBe(1);
  });

  test("navigation button stays tappable while the app row beneath it is refused", async () => {
    const hierarchy = syntheticNavigationHierarchy(coveredNavigationRow, { navButton: true });
    const button = await run(hierarchy, { text: "Back" });
    expect(button.result.success).toBe(true);
    expect(button.points).toEqual([{ x: 48, y: 89 }]);
    const row = await run(hierarchy);
    expect(row.result.error).toContain("covered by the navigation bar");
    expect(row.points).toEqual([]);
  });

  test("Android keeps the same covered geometry tappable; only iOS clips it", async () => {
    const hierarchy = syntheticNavigationHierarchy();
    const android = await run(hierarchy, { platform: "android" });
    expect(android.result.success).toBe(true);
    expect(android.points).toEqual([{ x: 201, y: 70 }]);
    expect((await run(hierarchy)).points).toEqual([]);
  });
});
