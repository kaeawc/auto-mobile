import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type {
  ObserveResult,
  ScrollableCandidate,
  SwipeDirection,
  SwipeOnOptions,
} from "../../../../src/models";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";
import { frame, harness } from "./displaySwipeHarness";

const displaySwipe: SwipeOnOptions = { direction: "up", display: "external" };
const real = { "resource-id": "real", bounds: "[40,70][140,170]", scrollable: "true" };
const decoy = { "resource-id": "decoy", bounds: "[5,10][75,90]", scrollable: "true" };
type ScrollableNode = Record<string, string>;

function tree({
  observation,
  nodes,
}: {
  observation: ObserveResult;
  nodes: ScrollableNode[];
}): ObserveResult {
  return {
    ...observation,
    viewHierarchy: {
      ...observation.viewHierarchy,
      hierarchy: {
        node: [observation.viewHierarchy?.hierarchy.node, ...nodes.map(($) => ({ $ }))],
      },
    },
  };
}

function optionsHarness({
  nodes = [real],
  ...options
}: Parameters<typeof harness>[0] & {
  nodes?: ScrollableNode[];
} = {}) {
  const defaultObservation = tree({
    observation: {
      ...frame({ key: "internal" }),
      screenSize: { width: 100, height: 100 },
      systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    nodes: [decoy],
  });
  const h = harness({
    ...options,
    observationFor: ({ display, observation }) =>
      display ? tree({ observation, nodes }) : defaultObservation,
  });
  const cached = spyOn(h.observe, "getMostRecentCachedObserveResult").mockResolvedValue(
    defaultObservation,
  );
  return { ...h, cached };
}

afterEach(() => mock.restore());

const directions: Array<{ direction: SwipeDirection; coordinates: number[] }> = [
  { direction: "up", coordinates: [90, 150, 90, 90] },
  { direction: "down", coordinates: [90, 90, 90, 150] },
  { direction: "left", coordinates: [120, 120, 60, 120] },
  { direction: "right", coordinates: [60, 120, 120, 120] },
];

for (const route of ["ctrlproxy", "adb"] as const) {
  for (const { direction, coordinates } of directions) {
    test(`autoTarget selects targeted tree: ${route}, ${direction}`, async () => {
      const h = optionsHarness({ route });
      const result = await h.action.execute({ ...displaySwipe, direction, autoTarget: true });
      expect(result).toMatchObject({ success: true, targetType: "element" });
      const { x1, y1, x2, y2 } = h.legs()[0];
      expect([x1, y1, x2, y2]).toEqual(coordinates);
      expect(result.warning).toBe(
        'Auto-targeted scrollable container (elementId="real"). Set autoTarget: false to force full-screen swipes.',
      );
      expect(result.scrollableCandidates).toEqual([{ elementId: "real" }]);
      expect(h.cached).not.toHaveBeenCalled();
      expect(h.observe.getExecuteOptions().every((option) => option.display === "external")).toBe(
        true,
      );
      if (route === "ctrlproxy") {
        expect(h.ctrl.getSwipeHistory()[0].displayId).toBe(2);
        expect(h.commands()).toEqual([]);
      } else {
        expect(h.commands()).toEqual([
          `shell input touchscreen -d 2 swipe ${coordinates.join(" ")} 300`,
        ]);
        expect(h.ctrl.getSwipeHistory()).toEqual([]);
      }
    });
  }
  for (const available of [false, true]) {
    test(`selector uses targeted dimensions and ${available ? "available" : "zero"} insets via ${route}`, async () => {
      const full = {
        ...real,
        "resource-id": "full",
        bounds: available ? "[30,60][190,180]" : "[0,0][200,200]",
      };
      const h = optionsHarness({ route, available, nodes: [full, real] });
      const result = await h.action.execute({ ...displaySwipe, autoTarget: true });
      expect(result.success).toBe(true);
      expect(result.warning).toContain('elementId="real"');
      expect(h.legs()[0]).toMatchObject({ x1: 90, y1: 150, x2: 90, y2: 90 });
      expect(result.scrollableCandidates?.map((candidate) => candidate.elementId)).toEqual([
        "full",
        "real",
      ]);
    });
  }
  const outcomes: Array<{
    name: string;
    nodes: ScrollableNode[];
    warning?: string;
    candidates?: ScrollableCandidate[];
  }> = [
    { name: "no scrollables", nodes: [] },
    {
      name: "direction mismatch",
      nodes: [{ ...real, bounds: "[20,70][180,90]", orientation: "horizontal" }],
      warning:
        "Scrollable containers found but none matched the swipe direction; swiping the screen. Set autoTarget: false to force screen swipes.",
      candidates: [{ elementId: "real" }],
    },
    {
      name: "no identifier",
      nodes: [{ bounds: real.bounds, scrollable: "true", class: "android.widget.ScrollView" }],
      warning:
        "Auto-targeted scrollable container lacks a usable identifier; swiping within its bounds without container metadata.",
      candidates: [{ className: "android.widget.ScrollView" }],
    },
  ];
  for (const entry of outcomes) {
    test(`autoTarget ${entry.name} via ${route}`, async () => {
      const h = optionsHarness({ route, nodes: entry.nodes });
      const result = await h.action.execute({ ...displaySwipe, autoTarget: true });
      expect(result).toMatchObject({
        success: true,
        targetType: entry.name === "no identifier" ? "element" : "screen",
        x1: entry.name === "no identifier" ? 90 : 100,
        y1: 160,
        x2: entry.name === "no identifier" ? 90 : 100,
        y2: entry.name === "no identifier" ? 80 : 40,
      });
      expect(result.warning).toBe(entry.warning);
      expect(result.scrollableCandidates).toEqual(entry.candidates);
      expect(h.cached).not.toHaveBeenCalled();
    });
  }
  for (const autoTarget of [undefined, false]) {
    test(`autoTarget ${autoTarget} preserves plain display swipe via ${route}`, async () => {
      const h = optionsHarness({ route });
      const result = await h.action.execute({ ...displaySwipe, autoTarget });
      expect(result).toMatchObject({
        success: true,
        targetType: "screen",
        x1: 100,
        y1: 160,
        x2: 100,
        y2: 40,
      });
      expect(result.warning).toBeUndefined();
      expect(result.scrollableCandidates).toBeUndefined();
      expect(h.cached).not.toHaveBeenCalled();
    });
  }
  test(`explicit container ignores autoTarget via ${route}`, async () => {
    const selector = spyOn(AutoTargetSelector.prototype, "selectAutoTargetScrollable");
    const h = optionsHarness({
      route,
      nodes: [real, { ...real, "resource-id": "explicit", bounds: "[80,80][120,120]" }],
    });
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      container: { elementId: "explicit" },
    });
    expect(result).toMatchObject({
      success: true,
      targetType: "element",
      x1: 100,
      y1: 112,
      x2: 100,
      y2: 88,
    });
    expect(result.warning).toBeUndefined();
    expect(result.scrollableCandidates).toBeUndefined();
    expect(selector).not.toHaveBeenCalled();
  });
  for (const includeSystemInsets of [false, true]) {
    test(`autoTarget composes with includeSystemInsets=${includeSystemInsets} via ${route}`, async () => {
      const h = optionsHarness({
        route,
        available: true,
        nodes: [{ ...real, bounds: "[0,0][160,160]" }],
      });
      const result = await h.action.execute({
        ...displaySwipe,
        autoTarget: true,
        includeSystemInsets,
      });
      expect(result.success).toBe(true);
      expect(h.legs()[0]).toMatchObject(
        includeSystemInsets
          ? { x1: 80, y1: 128, x2: 80, y2: 32 }
          : { x1: 95, y1: 140, x2: 95, y2: 80 },
      );
    });
  }
}

const routes: Array<{
  capability: "ctrlproxy" | "adb";
  scrollMode?: "adb" | "a11y";
  expected: "ctrlproxy" | "adb";
  boomerang?: boolean;
}> = [
  { capability: "ctrlproxy", scrollMode: "adb", expected: "adb" },
  { capability: "ctrlproxy", scrollMode: "a11y", expected: "ctrlproxy" },
  { capability: "ctrlproxy", expected: "ctrlproxy" },
  { capability: "adb", expected: "adb" },
  { capability: "adb", scrollMode: "adb", expected: "adb" },
  { capability: "ctrlproxy", scrollMode: "adb", expected: "adb", boomerang: true },
  { capability: "ctrlproxy", scrollMode: "a11y", expected: "ctrlproxy", boomerang: true },
];
for (const entry of routes) {
  test(`display route ${JSON.stringify(entry)}`, async () => {
    const h = optionsHarness({ route: entry.capability });
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      scrollMode: entry.scrollMode,
      boomerang: entry.boomerang,
      speed: "fast",
      apexPause: entry.boomerang ? 25 : undefined,
    });
    expect(result.success).toBe(true);
    const count = entry.boomerang ? 2 : 1;
    expect(h.legs()).toHaveLength(count);
    expect(h.legs()[0]).toMatchObject({ x1: 90, y1: 150, x2: 90, y2: 90, duration: 100 });
    expect(h.commands()).toHaveLength(entry.expected === "adb" ? count : 0);
    expect(h.ctrl.getSwipeHistory()).toHaveLength(entry.expected === "ctrlproxy" ? count : 0);
    expect(h.ctrl.getSwipeHistory().every((leg) => leg.displayId === 2)).toBe(true);
    expect(
      h.commands().every((command) => command.startsWith("shell input touchscreen -d 2 swipe ")),
    ).toBe(true);
    if (entry.boomerang) {
      expect(h.legs()[1]).toMatchObject({ x1: 90, y1: 90, x2: 90, y2: 150, duration: 100 });
      expect(h.timer.getSleepHistory()).toEqual([25]);
    }
  });
}

for (const lookFor of [undefined, { text: "Found", maxTime: 3000 }]) {
  test(`a11y requires non-default display capability, search=${!!lookFor}`, async () => {
    const h = optionsHarness({ route: "adb" });
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      scrollMode: "a11y",
      lookFor,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("gesture_display_id_v1");
    expect(result.error).toContain("a11y");
    expect(h.legs()).toEqual([]);
  });
}

for (const lookFor of [undefined, { text: "Found", maxTime: 3000 }]) {
  test(`a11y failure has no adb fallback, search=${!!lookFor}`, async () => {
    const h = optionsHarness();
    h.ctrl.setSwipeResult({ success: false, error: "CtrlProxy display dispatch failed" });
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      scrollMode: "a11y",
      lookFor,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("CtrlProxy display dispatch failed");
    expect(h.ctrl.getSwipeHistory()).toHaveLength(1);
    expect(h.commands()).toEqual([]);
  });
}

for (const scrollMode of ["adb", "a11y"] as const) {
  test(`boomerang ${scrollMode} rechecks fence before return`, async () => {
    const h = optionsHarness();
    h.afterSwipe(h.flip);
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      scrollMode,
      boomerang: true,
    });
    expect(result.success).toBe(false);
    expect(result.staleDisplay?.retry).toBe("observe");
    expect(h.legs()).toHaveLength(1);
  });
  for (const stopAfter of [1, 2]) {
    test(`search ${scrollMode} fence flips after ${stopAfter} dispatches`, async () => {
      const h = optionsHarness({ foundAfter: stopAfter });
      h.afterSwipe(() => {
        if (h.legs().length === stopAfter) {
          h.flip();
        }
      });
      const result = await h.action.execute({
        ...displaySwipe,
        autoTarget: true,
        scrollMode,
        lookFor: { text: "Found", maxTime: 3000 },
      });
      expect(result.success).toBe(false);
      expect(result.staleDisplay).toEqual({
        observedGeneration: 1,
        currentGeneration: 2,
        currentDisplayKey: "internal",
        retry: "observe",
      });
      expect(result.error).not.toContain("not found");
      expect(h.legs()).toHaveLength(stopAfter);
    });
  }
  test(`lookFor ignores autoTarget and observes only selected display via ${scrollMode}`, async () => {
    const selector = spyOn(AutoTargetSelector.prototype, "selectAutoTargetScrollable");
    const h = optionsHarness({ foundAfter: 2 });
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      scrollMode,
      lookFor: { text: "Found", maxTime: 3000 },
    });
    expect(result).toMatchObject({ success: true, found: true, scrollIterations: 2 });
    expect(result.warning).toBeUndefined();
    expect(h.legs()).toHaveLength(2);
    expect(h.legs()[0]).toMatchObject({ x1: 90, y1: 160, x2: 90, y2: 80 });
    expect(selector).not.toHaveBeenCalled();
    expect(h.observe.getExecuteOptions().every((options) => options.display === "external")).toBe(
      true,
    );
    expect(h.cached).not.toHaveBeenCalled();
  });
}

test("no display retains legacy autoTarget and gesture dispatch", async () => {
  const h = optionsHarness();
  const result = await h.action.execute({ direction: "up", autoTarget: true });
  expect(result.success).toBe(true);
  expect(result.warning).toContain('elementId="decoy"');
  expect(h.cached).toHaveBeenCalled();
  expect(h.gesture.getSwipeCalls()).toEqual([
    {
      x1: 40,
      y1: 82,
      x2: 40,
      y2: 18,
      options: { duration: 300, scrollMode: undefined, displayFence: undefined },
    },
  ]);
  expect(h.legs()).toEqual([]);
  expect(h.observe.getExecuteOptions().every((options) => options.display === undefined)).toBe(
    true,
  );
});

const unsupported: Array<Partial<SwipeOnOptions>> = [
  { lookFor: { text: "Found" } },
  { includeSystemInsets: false },
  { focusTarget: true },
  { autoTarget: true },
  { scrollMode: "adb" },
];
for (const extra of unsupported) {
  test(`iOS rejects ${Object.keys(extra)[0]} before observes or dispatch`, async () => {
    const h = optionsHarness({ platform: "ios" });
    const result = await h.action.execute({ ...displaySwipe, ...extra });
    expect(result.success).toBe(false);
    expect(result.error).toBe(`${Object.keys(extra)[0]} is not supported with \`display\` yet`);
    expect(h.observe.getExecuteCallCount()).toBe(0);
    expect(h.legs()).toEqual([]);
  });
}
for (const focusTarget of [false, true]) {
  test(`Android rejects focusTarget=${focusTarget} before observes or dispatch`, async () => {
    const h = optionsHarness();
    const result = await h.action.execute({ ...displaySwipe, focusTarget });
    expect(result.error).toBe("focusTarget is not supported with `display` yet");
    expect(h.observe.getExecuteCallCount()).toBe(0);
    expect(h.legs()).toEqual([]);
  });
}

for (const route of ["ctrlproxy", "adb"] as const) {
  test(`autoTarget rejects a mismatched initial display capture via ${route}`, async () => {
    const h = optionsHarness({ route });
    h.wrongPanel();
    const result = await h.action.execute({ ...displaySwipe, autoTarget: true });
    expect(result.success).toBe(false);
    expect(result.staleDisplay?.retry).toBe("observe");
    expect(h.legs()).toEqual([]);
    expect(h.cached).not.toHaveBeenCalled();
  });
  test(`autoTarget uses the legacy content-direction interpretation via ${route}`, async () => {
    const h = optionsHarness({ route });
    const result = await h.action.execute({
      ...displaySwipe,
      autoTarget: true,
      gestureType: "scrollTowardsDirection",
    });
    expect(result.success).toBe(true);
    expect(h.legs()[0]).toMatchObject({ x1: 90, y1: 90, x2: 90, y2: 150 });
  });
}

for (const route of ["ctrlproxy", "adb"] as const) {
  test(`auto-target screen fallback respects available selected-display insets via ${route}`, async () => {
    const h = optionsHarness({ route, available: true, nodes: [] });
    const result = await h.action.execute({ ...displaySwipe, autoTarget: true });
    expect(result).toMatchObject({ targetType: "screen", x1: 110, y1: 156, x2: 110, y2: 84 });
  });

  test(`unnamed selected-display auto-target reports unchanged hierarchy via ${route}`, async () => {
    const h = optionsHarness({
      route,
      available: true,
      unchanged: true,
      foundAfter: 99,
      nodes: [{ bounds: real.bounds, scrollable: "true", class: "android.widget.ScrollView" }],
    });
    h.useRealObservedInteraction();
    const result = await h.action.execute({ ...displaySwipe, autoTarget: true });
    expect(result).toMatchObject({
      success: true,
      targetType: "element",
      x1: 90,
      y1: 160,
      x2: 90,
      y2: 80,
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    });
    expect(result.warning).toContain("inside the scrollable");
  });
}
