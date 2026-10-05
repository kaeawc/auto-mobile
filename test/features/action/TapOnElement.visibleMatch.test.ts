import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type {
  ElementSelectionResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { hierarchyFingerprint } from "../../../src/utils/hierarchyFingerprint";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { iosFormsSwitch } from "../../fixtures/observe/ios-forms-switch";

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
});

const screen = { left: 0, top: 0, right: 402, bottom: 874 };
const offscreenRow = { left: 16, top: 870, right: 386, bottom: 948 };
const offscreenLabel = { left: 84, top: 889, right: 198, bottom: 910 };

function hierarchy(
  labelBounds = offscreenLabel,
  rowBounds = offscreenRow,
  tabBarTop?: number,
): ViewHierarchyResult {
  return {
    screenWidth: 402,
    screenHeight: 874,
    hierarchy: {
      node: {
        $: { class: "XCUIElementTypeWindow", bounds: screen },
        node: [
          {
            $: {
              class: "XCUIElementTypeScrollView",
              bounds: screen,
              clickable: true,
              scrollable: true,
            },
            node: [
              {
                $: { class: "XCUIElementTypeCell", bounds: rowBounds },
                node: [{ $: { class: "UILabel", text: "Forms & Input", bounds: labelBounds } }],
              },
            ],
          },
          ...(tabBarTop === undefined
            ? []
            : [
                {
                  $: {
                    class: "UITabBar",
                    bounds: { left: 0, top: tabBarTop, right: 402, bottom: 874 },
                  },
                },
              ]),
        ],
      },
    },
  };
}

function topClippedHierarchy(labelBottom: number, topInset?: number): ViewHierarchyResult {
  const viewport = { left: 0, top: 0, right: 466, bottom: 678 };
  const row = { left: 16, top: -37, right: 450, bottom: labelBottom };
  return {
    screenWidth: 466,
    screenHeight: 678,
    ...(topInset === undefined
      ? {}
      : { systemInsets: { top: topInset, bottom: 0, left: 0, right: 0 } }),
    hierarchy: {
      node: {
        $: { class: "XCUIElementTypeWindow", bounds: viewport },
        node: [
          {
            $: { class: "XCUIElementTypeScrollView", bounds: viewport, scrollable: true },
            node: [
              {
                $: { class: "XCUIElementTypeCell", bounds: row, clickable: true },
                node: [{ $: { class: "UILabel", text: "Forms & Input", bounds: row } }],
              },
            ],
          },
          {
            $: {
              class: "XCUIElementTypeStatusBar",
              bounds: { left: 0, top: 0, right: 466, bottom: 54 },
            },
          },
        ],
      },
    },
  };
}

async function run(
  platform: "ios" | "android",
  initial: ViewHierarchyResult,
  refreshed = initial,
  retryIfNoChange = false,
  textAny = false,
  transformSelection?: (selection: ElementSelectionResult) => ElementSelectionResult,
  text = "Forms & Input",
  observationScreenSize = { width: 402, height: 874 },
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tapStrategy = new FakeTapStrategy();
  tapStrategy.retryTapIfNoChange = retryIfNoChange;
  const tap = new TapOnElement(
    { name: "test-device", platform, deviceId: "test-device" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy,
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  if (transformSelection) {
    const find = tap.findElementInHierarchy.bind(tap);
    tap.findElementInHierarchy = (options, capture) => {
      const found = find(options, capture);
      return { ...found, selection: transformSelection(found.selection) };
    };
  }
  const observation: ObserveResult = {
    observationId: "visible-match",
    updatedAt: 1,
    screenSize: observationScreenSize,
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: initial,
  };
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = async (action) => ({
    ...(await action(recordObservationRead(observation))),
    observation,
  });
  tap.refreshViewHierarchy = async () => refreshed;
  tap.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.executeiOSTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap.execute({
    ...(textAny ? { textAny: [text] } : { text }),
    action: "tap",
    retryIfNoChange,
  });
  return { result, points, tap };
}

describe("tapOn visible matched element", () => {
  test("uses hierarchy dimensions when observation dimensions differ", async () => {
    const label = { left: 84, top: 389, right: 198, bottom: 400 };
    const row = { left: 16, top: 364, right: 386, bottom: 442 };
    const { result, points } = await run(
      "ios",
      hierarchy(label, row),
      hierarchy(label, row),
      false,
      false,
      undefined,
      "Forms & Input",
      { width: 100, height: 100 },
    );
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 394 }]);
  });

  test("iOS taps the control inside a labelled UISwitch row", async () => {
    const capture = iosFormsSwitch("true");
    const { result, points } = await run(
      "ios",
      capture,
      capture,
      false,
      false,
      undefined,
      "Enable Notifications",
    );
    expect(result.success).toBe(true);
    expect(points).toHaveLength(1);
    expect(points[0].x).toBeGreaterThanOrEqual(301);
    expect(points[0].x).toBeLessThan(364);
    expect(points[0].y).toBeGreaterThanOrEqual(296);
    expect(points[0].y).toBeLessThan(324);
    expect(result.selectedElement?.bounds).toMatchObject({
      left: 301,
      top: 296,
      right: 364,
      bottom: 324,
    });
  });
  for (const platform of ["ios", "android"] as const) {
    test(`${platform} refuses off-screen label promoted to full-screen container`, async () => {
      const initial = hierarchy(offscreenLabel, offscreenRow, 790);
      const selection = new ResolverElementSelector().selectByText(initial, "Forms & Input", {
        intentAction: "inspect",
        selectionIntent: "tap",
      });
      expect(selection.matchedElement?.bounds).toEqual(offscreenLabel);
      expect(selection.element?.bounds).toEqual(screen);

      const { result, points } = await run(platform, initial);
      expect(points).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Scroll it into view with swipeOn");
    });

    test(`${platform} uses the visible label after a refreshed hierarchy moves it on-screen`, async () => {
      const visibleLabel = { left: 84, top: 389, right: 198, bottom: 400 };
      const visibleRow = { left: 16, top: 364, right: 386, bottom: 442 };
      const { result, points } = await run(
        platform,
        hierarchy(),
        hierarchy(visibleLabel, visibleRow),
      );
      expect(result.success).toBe(true);
      expect(points).toEqual([{ x: 141, y: 394 }]);
      expect(result.selectedElement?.matchedElement?.bounds).toEqual(visibleLabel);
    });
  }

  test("iOS refuses the screen-visible strip of a label covered by the tab bar", async () => {
    const label = { left: 84, top: 850, right: 198, bottom: 900 };
    const row = { left: 16, top: 830, right: 386, bottom: 930 };
    const { result, points } = await run("ios", hierarchy(label, row, 790));
    expect(points).toEqual([]);
    expect(result.error).toContain("Scroll it into view with swipeOn");
  });

  test("textAny reports an off-screen match as actionable when no variant is visible", async () => {
    const initial = hierarchy();
    const { result, points } = await run("ios", initial, initial, false, true);
    expect(points).toEqual([]);
    expect(result.error).toContain("Scroll it into view with swipeOn");
  });

  test("iOS taps the visible intersection of a partly clipped label", async () => {
    const label = { left: 84, top: 850, right: 198, bottom: 900 };
    const row = { left: 16, top: 830, right: 386, bottom: 930 };
    const { result, points } = await run("ios", hierarchy(label, row));
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 862 }]);
  });

  for (const topInset of [54, undefined]) {
    test(`iOS refuses a row visible only under the status bar (${topInset === undefined ? "node bounds" : "system inset"})`, async () => {
      const { result, points } = await run("ios", topClippedHierarchy(40, topInset));
      expect(result.success).toBe(false);
      expect(points).toEqual([]);
      expect(result.error).toContain("Scroll it into view with swipeOn");
    });
  }

  test("iOS taps the part of a top-clipped row below the status bar", async () => {
    const { result, points } = await run("ios", topClippedHierarchy(80, 54));
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 233, y: 67 }]);
  });

  test("Android does not shrink the visible row by the top system inset", async () => {
    const { result, points } = await run("android", topClippedHierarchy(40, 54));
    expect(result.success).toBe(true);
    expect(points).toHaveLength(1);
    expect(points[0]?.y).toBeGreaterThanOrEqual(0);
    expect(points[0]?.y).toBeLessThan(40);
  });

  test("iOS keeps a matched status-bar control tappable", async () => {
    const viewport = { left: 0, top: 0, right: 466, bottom: 678 };
    const statusBar = { left: 0, top: 0, right: 466, bottom: 54 };
    const capture: ViewHierarchyResult = {
      screenWidth: 466,
      screenHeight: 678,
      systemInsets: { top: 54, bottom: 0, left: 0, right: 0 },
      hierarchy: {
        node: {
          $: { class: "XCUIElementTypeWindow", bounds: viewport },
          node: [
            {
              $: { class: "XCUIElementTypeStatusBar", bounds: statusBar, clickable: true },
              node: [
                {
                  $: {
                    class: "UILabel",
                    text: "Forms & Input",
                    bounds: { left: 84, top: 10, right: 198, bottom: 30 },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const { result, points } = await run("ios", capture);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 20 }]);
  });

  test("iOS keeps a tab bar's own matched label tappable", async () => {
    const label = { left: 84, top: 815, right: 198, bottom: 825 };
    const tab: ViewHierarchyResult = {
      screenWidth: 402,
      screenHeight: 874,
      hierarchy: {
        node: {
          $: { class: "XCUIElementTypeWindow", bounds: screen },
          node: [
            {
              $: { class: "UITabBar", bounds: { left: 0, top: 790, right: 402, bottom: 874 } },
              node: [
                {
                  $: {
                    class: "UITabBarButton",
                    clickable: true,
                    bounds: { left: 60, top: 800, right: 220, bottom: 850 },
                  },
                  node: [{ $: { class: "UILabel", text: "Forms & Input", bounds: label } }],
                },
              ],
            },
          ],
        },
      },
    };
    const { result, points } = await run("ios", tab);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 820 }]);
  });

  test("system insets leave an edge-to-edge matched label tappable", async () => {
    const label = { left: 84, top: 790, right: 198, bottom: 830 };
    const row = { left: 16, top: 770, right: 386, bottom: 850 };
    const capture = {
      ...hierarchy(label, row),
      systemInsets: { top: 0, bottom: 60, left: 0, right: 0 },
    };
    const { result, points } = await run("android", capture);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 810 }]);
  });

  for (const bounds of [{ left: 84, top: 389, right: 84, bottom: 400 }, undefined]) {
    test(`falls back to the action target when matched bounds are ${bounds ? "degenerate" : "missing"}`, async () => {
      const label = { left: 84, top: 389, right: 198, bottom: 400 };
      const row = { left: 16, top: 364, right: 386, bottom: 442 };
      const { result, points } = await run(
        "android",
        hierarchy(label, row),
        hierarchy(label, row),
        false,
        false,
        (selection) => ({
          ...selection,
          matchedElement: selection.matchedElement
            ? { ...selection.matchedElement, bounds: bounds! }
            : undefined,
        }),
      );
      expect(result.success).toBe(true);
      expect(points).toEqual([{ x: 201, y: 437 }]);
    });
  }

  test("iOS modal button remains tappable above a background window's tab bar", async () => {
    const label = { left: 84, top: 815, right: 198, bottom: 825 };
    const modal: ViewHierarchyResult = {
      hierarchy: {},
      screenWidth: 402,
      screenHeight: 874,
      windows: [
        {
          windowLayer: 2,
          hierarchy: {
            $: { class: "XCUIElementTypeWindow", bounds: screen },
            node: [
              {
                $: {
                  class: "XCUIElementTypeButton",
                  clickable: true,
                  bounds: { left: 60, top: 800, right: 220, bottom: 850 },
                },
                node: [{ $: { class: "UILabel", text: "Forms & Input", bounds: label } }],
              },
            ],
          },
        },
        {
          windowLayer: 1,
          hierarchy: {
            $: { class: "XCUIElementTypeWindow", bounds: screen },
            node: [
              { $: { class: "UITabBar", bounds: { left: 0, top: 790, right: 402, bottom: 874 } } },
            ],
          },
        },
      ],
    };
    const { result, points } = await run("ios", modal);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 820 }]);
  });

  test("iOS tab-bar item remains tappable when matched-node identity is lost", async () => {
    const label = { left: 84, top: 815, right: 198, bottom: 825 };
    const tab: ViewHierarchyResult = {
      screenWidth: 402,
      screenHeight: 874,
      hierarchy: {
        node: {
          $: { class: "XCUIElementTypeWindow", bounds: screen },
          node: [
            {
              $: { class: "UITabBar", bounds: { left: 0, top: 790, right: 402, bottom: 874 } },
              node: [
                {
                  $: {
                    class: "UITabBarButton",
                    clickable: true,
                    bounds: { left: 60, top: 800, right: 220, bottom: 850 },
                  },
                  node: [{ $: { class: "UILabel", text: "Forms & Input", bounds: label } }],
                },
              ],
            },
          ],
        },
      },
    };
    const { result, points } = await run("ios", tab, tab, false, false, (selection) => ({
      ...selection,
      matchedElement: selection.matchedElement
        ? { ...selection.matchedElement, bounds: { left: 85, top: 816, right: 197, bottom: 824 } }
        : undefined,
    }));
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 141, y: 820 }]);
  });

  test("Android ghost-tap retry keeps the point inside the matched label", async () => {
    const label = { left: 84, top: 389, right: 198, bottom: 400 };
    const row = { left: 16, top: 364, right: 386, bottom: 442 };
    const { points } = await run("android", hierarchy(label, row), hierarchy(label, row), true);
    expect(points).toEqual([
      { x: 141, y: 394 },
      { x: 141, y: 394 },
    ]);
  });

  test("Android ghost-tap retry re-resolves a point inside the refreshed label", async () => {
    const label = { left: 204, top: 389, right: 318, bottom: 400 };
    const row = { left: 196, top: 364, right: 386, bottom: 442 };
    const refreshed = hierarchy(label, row);
    const { result, points, tap } = await run("android", refreshed);
    expect(result.success).toBe(true);
    await tap.retryTapIfNoChange(
      hierarchyFingerprint(refreshed)!,
      { x: 141, y: 394 },
      "tap",
      0,
      result.element!,
      { text: "Forms & Input", action: "tap" },
      false,
      { width: 402, height: 874 },
    );
    expect(points).toEqual([
      { x: 261, y: 394 },
      { x: 261, y: 394 },
    ]);
  });
});
