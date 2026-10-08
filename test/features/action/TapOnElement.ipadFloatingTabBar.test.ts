import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { clipIosChromeBounds } from "../../../src/features/action/swipeon/iosChromeInsets";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured on an iPad Pro 11-inch (M5) simulator, iOS 27.0, full-screen Playground (#10635).
// Both trees carry the floating tab bar items as root-level buttons inside the navigation
// bar's frame; the second one has the Demos list scrolled so rows sit under the bar.
const fixtureDir = join(import.meta.dir, "../../fixtures/ios");
const load = (name: string): ObserveResult =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as ObserveResult;
const discoverTab = load("ipad-ios27-floating-tab-bar-discover.json");
const demosScrolled = load("ipad-ios27-demos-row-under-navigation-bar.json");

afterEach(() => AndroidCtrlProxyClient.resetInstances());

async function tapOn(observation: ObserveResult, text: string) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "ipad", platform: "ios", deviceId: "ipad" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = async (action) => ({
    ...(await action(recordObservationRead(observation))),
    observation,
  });
  tap.refreshViewHierarchy = async () => observation.viewHierarchy!;
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
  return { result, points };
}

describe("iPad floating tab bar inside the navigation bar frame (#10635)", () => {
  test("tapOn a tab item taps its centre instead of refusing it as covered", async () => {
    const discover = await tapOn(discoverTab, "Discover");
    expect(discover.result.error).toBeUndefined();
    expect(discover.result.success).toBe(true);
    expect(discover.points).toEqual([{ x: 290, y: 54 }]);
  });

  test("tab items stay tappable while the navigation bar is collapsed over scrolled content", async () => {
    const demos = await tapOn(demosScrolled, "Demos");
    expect(demos.result.success).toBe(true);
    expect(demos.points).toEqual([{ x: 384, y: 54 }]);
  });

  test("a list row scrolled under the same navigation bar is still refused", async () => {
    const { result, points } = await tapOn(demosScrolled, "Network Tracking");
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Target "Network Tracking" is covered by the navigation bar; scroll it into view with swipeOn, then retry tapOn.',
    );
    expect(points).toEqual([]);
  });

  test("clipping exempts only the bar-level tab item, not scroll content at the same place", () => {
    const hierarchy = demosScrolled.viewHierarchy!;
    const screen = demosScrolled.screenSize!;
    const nodes = new SearchableHierarchy().project(hierarchy);
    const tab = nodes.find((node) => node.className === "UIButton" && node.label === "Files")!;
    const nav = nodes.find((node) => node.className === "UINavigationBar")!;
    const row = nodes.find((node) => node.label?.startsWith("Network Tracking,"))!;
    // A root-level button, not a navigation-bar descendant, inside the bar's frame.
    expect(tab.parentIndex).toBeUndefined();
    expect(tab.bounds!.top).toBeGreaterThanOrEqual(nav.bounds!.top);
    expect(tab.bounds!.bottom).toBeLessThanOrEqual(nav.bounds!.bottom);

    const tabClip = clipIosChromeBounds({
      bounds: tab.bounds!,
      hierarchy,
      screen,
      elements: [tab.element!],
      regions: ["navigation bar"],
      forTapTarget: true,
    });
    expect(tabClip).toEqual({ bounds: tab.bounds! });

    const rowClip = clipIosChromeBounds({
      bounds: row.bounds!,
      hierarchy,
      screen,
      elements: [row.element!],
      regions: ["navigation bar"],
      forTapTarget: true,
    });
    expect(rowClip).toEqual({ bounds: null, coveredBy: "navigation bar" });
  });
});
