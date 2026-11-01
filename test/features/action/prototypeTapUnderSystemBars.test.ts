import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import {
  isOwnPrototypeNode,
  resolvePrototypeTapUnderSystemBar,
} from "../../../src/features/action/prototypeTapUnderSystemBars";
import type { ObservationInsets } from "../../../src/models/ObservationInsets";
import { TapPointPlanner } from "../../../src/features/action/tapPointPlanner";
import { PROTOTYPE_WINDOW_MARKER_ID } from "../../../src/features/prototype/prototypeHostControls";
import { FakeElementGeometry } from "../../fakes/FakeElementGeometry";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakePrototypeAgentClient } from "../../fakes/FakePrototypeAgentClient";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models/ViewHierarchyResult";

// Geometry from the #10086 device run: 1080x2400, 136 px status bar, 63 px gesture bar.
const fullScreen = { left: 0, top: 0, right: 1080, bottom: 2400 };

// `tappableElement` is the part of the bars that takes touches: the bar height on three-button
// navigation, 0 at the bottom on gesture navigation (#10156). Omitted: the capture cannot say.
const typedInsets = (
  visible: { top: number; bottom: number },
  tappableBottom?: number,
): ObservationInsets => ({
  available: true,
  source: "android-window-metrics",
  units: "physical-pixels",
  systemBars: {
    visible: { ...visible, left: 0, right: 0 },
    stable: { top: 136, bottom: 63, left: 0, right: 0 },
  },
  ...(tappableBottom === undefined
    ? {}
    : { tappableElement: { top: 136, bottom: tappableBottom, left: 0, right: 0 } }),
});

/** A capture on three-button navigation: the 63 px bottom bar is tappable. */
const threeButton = () => capture({ insets: typedInsets({ top: 136, bottom: 63 }, 63) });
/** A capture on gesture navigation: the 63 px bottom bar is not tappable. */
const gesture = () => capture({ insets: typedInsets({ top: 136, bottom: 63 }, 0) });

function iosCapture(top = 0, bottom = 40) {
  const control = {
    class: "UIButton",
    "resource-id": "top-control",
    bounds: { left: 100, top, right: 200, bottom },
    clickable: true,
  };
  const appControl = { ...control, "resource-id": "app-control" };
  const hierarchy: ViewHierarchyResult = {
    packageName: "dev.jasonpearson.ProtoViewer",
    screenWidth: 402,
    screenHeight: 874,
    systemInsets: { top: 59, bottom: 34, left: 0, right: 0 },
    insets: {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 59, bottom: 34, left: 0, right: 0 },
      systemChrome: {
        visibility: "visible",
        statusBar: "visible",
        source: "ios-status-bar-manager",
      },
    },
    hierarchy: {
      node: createFlatNodeForTest({
        class: "XCUIApplication",
        node: [
          createFlatNodeForTest({ class: "UIWindow", node: [appControl] }),
          createFlatNodeForTest({
            class: "UIWindow",
            node: [createFlatNodeForTest({ "resource-id": PROTOTYPE_WINDOW_MARKER_ID }), control],
          }),
        ],
      }),
    },
  };
  const planner = new TapPointPlanner({
    device: { name: "fake iPhone", deviceId: "fake-ios", platform: "ios" },
    geometry: () => new FakeElementGeometry(),
    strategy: () => FakeTapStrategy.ios(),
  });
  return { hierarchy, control, appControl, planner };
}

function capture(overrides: Partial<ViewHierarchyResult> = {}): ViewHierarchyResult {
  return {
    packageName: "dev.jasonpearson.automobile.playground",
    screenWidth: 1080,
    screenHeight: 2400,
    systemInsets: { top: 136, bottom: 63, left: 0, right: 0 },
    insets: typedInsets({ top: 136, bottom: 63 }),
    hierarchy: { node: createFlatNodeForTest({ bounds: fullScreen }) },
    ...overrides,
  } as ViewHierarchyResult;
}

function resolve(
  point: { x: number; y: number },
  options: {
    bounds?: { left: number; top: number; right: number; bottom: number };
    owned?: boolean;
    hierarchy?: ViewHierarchyResult | undefined;
  } = {},
) {
  return resolvePrototypeTapUnderSystemBar({
    hierarchy: "hierarchy" in options ? options.hierarchy : capture(),
    ownedByPrototype: options.owned ?? true,
    bounds: options.bounds ?? {
      left: point.x - 40,
      top: point.y - 20,
      right: point.x + 40,
      bottom: point.y + 20,
    },
    point,
  });
}

describe("resolvePrototypeTapUnderSystemBar (#10086)", () => {
  test("a control wholly in the navigation bar band is refused and the bar named", () => {
    const bounds = { left: 578, top: 2340, right: 658, bottom: 2380 };
    expect(resolve({ x: 618, y: 2360 }, { bounds, hierarchy: threeButton() })).toEqual({
      kind: "refuse",
      bar: "navigation bar",
    });
  });

  test("a control wholly in the status bar band is refused and the bar named", () => {
    expect(resolve({ x: 370, y: 44 })).toEqual({ kind: "refuse", bar: "status bar" });
  });

  test("the strip just above the navigation bar is reachable, the first bar pixel is not", () => {
    const point = { x: 618, y: 2336 };
    expect(resolve(point, { bounds: { left: 578, top: 2336, right: 658, bottom: 2337 } })).toEqual({
      kind: "proceed",
      point,
    });
    expect(
      resolve(
        { x: 618, y: 2337 },
        { bounds: { left: 578, top: 2337, right: 658, bottom: 2338 }, hierarchy: threeButton() },
      ),
    ).toEqual({ kind: "refuse", bar: "navigation bar" });
  });

  test("a point inside the safe area is untouched", () => {
    expect(resolve({ x: 500, y: 1200 })).toEqual({ kind: "proceed", point: { x: 500, y: 1200 } });
    expect(
      resolve({ x: 500, y: 136 }, { bounds: { left: 460, top: 136, right: 540, bottom: 200 } }),
    ).toEqual({ kind: "proceed", point: { x: 500, y: 136 } });
  });

  test("an element that is not the prototype's is never judged", () => {
    expect(resolve({ x: 618, y: 2356 }, { owned: false })).toEqual({
      kind: "proceed",
      point: { x: 618, y: 2356 },
    });
  });

  test("a control straddling the bar edge is tapped in the part outside the bar", () => {
    // Both controls have their own tap point inside a band while a visible part is reachable.
    const bounds = { left: 460, top: 100, right: 540, bottom: 200 };
    expect(resolve({ x: 500, y: 100 }, { bounds })).toEqual({
      kind: "proceed",
      point: { x: 500, y: 168 },
    });
    const bottomEdge = { left: 460, top: 2300, right: 540, bottom: 2400 };
    expect(resolve({ x: 500, y: 2350 }, { bounds: bottomEdge })).toEqual({
      kind: "proceed",
      point: { x: 500, y: 2318 },
    });
  });

  test("hidden bars do not count: visible insets are used, not the stable or gesture alias", () => {
    const hidden = capture({
      insets: typedInsets({ top: 0, bottom: 0 }),
      systemInsets: { top: 168, bottom: 84, left: 78, right: 78 },
    });
    expect(resolve({ x: 618, y: 2356 }, { hierarchy: hidden })).toEqual({
      kind: "proceed",
      point: { x: 618, y: 2356 },
    });
    expect(resolve({ x: 370, y: 44 }, { hierarchy: hidden })).toEqual({
      kind: "proceed",
      point: { x: 370, y: 44 },
    });
  });

  test("without typed visibility a point in the legacy band proceeds with a warning", () => {
    const legacyOnly = capture({ insets: undefined });
    const decision = resolve({ x: 618, y: 2356 }, { hierarchy: legacyOnly });
    expect(decision.kind).toBe("proceed");
    expect(decision.kind === "proceed" && decision.warning).toContain("does not say whether");
    const unavailable = capture({
      insets: { ...typedInsets({ top: 136, bottom: 63 }), available: false },
    });
    expect(resolve({ x: 618, y: 2356 }, { hierarchy: unavailable }).kind).toBe("proceed");
    // Inside the safe area there is nothing to warn about.
    expect(resolve({ x: 500, y: 1200 }, { hierarchy: legacyOnly })).toEqual({
      kind: "proceed",
      point: { x: 500, y: 1200 },
    });
  });

  test("a capture without insets or screen height cannot prove a bar", () => {
    const none = capture({ insets: undefined, systemInsets: undefined });
    expect(resolve({ x: 618, y: 2356 }, { hierarchy: none })).toEqual({
      kind: "proceed",
      point: { x: 618, y: 2356 },
    });
    const noHeight = capture({ screenHeight: undefined });
    expect(resolve({ x: 618, y: 2356 }, { hierarchy: noHeight }).kind).toBe("proceed");
    expect(resolve({ x: 1, y: 1 }, { hierarchy: undefined }).kind).toBe("proceed");
  });
});

describe("the navigation bar band by navigation mode (#10156)", () => {
  // The #10156 device run: the control row [2287, 2400] on a 2400 px screen with the bar at 2337.
  const row = { left: 621, top: 2287, right: 701, bottom: 2400 };
  const underBar = { left: 621, top: 2340, right: 701, bottom: 2390 };

  test("a gesture navigation bar does not stop a tap on a control wholly inside it", () => {
    const decision = resolve({ x: 661, y: 2365 }, { bounds: underBar, hierarchy: gesture() });
    expect(decision).toMatchObject({ kind: "proceed", point: { x: 661, y: 2365 } });
    expect(decision.kind === "proceed" && decision.warning).toContain("gesture navigation bar");
    expect(decision.kind === "proceed" && decision.warning).toContain("awaitEvent");
  });

  test("a three-button navigation bar still refuses a control wholly inside it", () => {
    expect(resolve({ x: 661, y: 2365 }, { bounds: underBar, hierarchy: threeButton() })).toEqual({
      kind: "refuse",
      bar: "navigation bar",
    });
  });

  test("without tappableElement the mode is unknown: tap with the unverified warning", () => {
    const decision = resolve({ x: 661, y: 2365 }, { bounds: underBar });
    expect(decision).toMatchObject({ kind: "proceed", point: { x: 661, y: 2365 } });
    expect(decision.kind === "proceed" && decision.warning).toContain("does not say whether");
  });

  test("the reported row is tapped in its part above the bar on every navigation mode", () => {
    const point = { x: 661, y: 2343 };
    for (const hierarchy of [gesture(), threeButton(), capture()]) {
      expect(resolve(point, { bounds: row, hierarchy })).toEqual({
        kind: "proceed",
        point: { x: 661, y: 2312 },
      });
    }
  });

  test("the status bar keeps refusing whatever the navigation mode", () => {
    expect(resolve({ x: 370, y: 44 }, { hierarchy: gesture() })).toEqual({
      kind: "refuse",
      bar: "status bar",
    });
  });

  test("hidden bars still win over the gesture rule", () => {
    const hidden = capture({ insets: typedInsets({ top: 0, bottom: 0 }, 0) });
    expect(resolve({ x: 661, y: 2365 }, { bounds: underBar, hierarchy: hidden })).toEqual({
      kind: "proceed",
      point: { x: 661, y: 2365 },
    });
  });
});

describe("isOwnPrototypeNode (#10086)", () => {
  const prototypeControl: ViewHierarchyNode = { bounds: fullScreen };
  const appControl: ViewHierarchyNode = { bounds: fullScreen };
  const windows = (packageName: string, type = 4) => [
    {
      id: 2,
      type,
      packageName,
      bounds: fullScreen,
      hierarchy: createFlatNodeForTest({ bounds: fullScreen, node: [prototypeControl] }),
    },
  ];

  test("only a node inside an own prototype window's tree belongs to the prototype", () => {
    const hierarchy = capture({ windows: windows(CTRL_PROXY_PACKAGE) });
    expect(isOwnPrototypeNode(hierarchy, prototypeControl)).toBe(true);
    expect(isOwnPrototypeNode(hierarchy, appControl)).toBe(false);
    expect(isOwnPrototypeNode(hierarchy, undefined)).toBe(false);
    expect(isOwnPrototypeNode(undefined, prototypeControl)).toBe(false);
  });

  test("another package's prototype window and application windows do not own the node", () => {
    expect(
      isOwnPrototypeNode(
        capture({ windows: windows("com.example.screenreader") }),
        prototypeControl,
      ),
    ).toBe(false);
    expect(
      isOwnPrototypeNode(capture({ windows: windows(CTRL_PROXY_PACKAGE, 1) }), prototypeControl),
    ).toBe(false);
  });
});

describe("iOS prototype status-bar taps (#16175)", () => {
  test("agent status is never read for app controls or non-tap actions", async () => {
    const { hierarchy, control, appControl } = iosCapture();
    const agent = new FakePrototypeAgentClient();
    const planner = new TapPointPlanner({
      device: { name: "fake iPhone", deviceId: "fake-ios", platform: "ios" },
      geometry: () => new FakeElementGeometry(),
      strategy: () => FakeTapStrategy.ios(),
      prototypeAgents: { get: () => agent },
    });
    expect(await planner.prototypeTapHierarchy(hierarchy, appControl, "tap")).toBe(hierarchy);
    for (const action of ["longPress", "doubleTap", "focus"] as const) {
      expect(await planner.prototypeTapHierarchy(hierarchy, control, action)).toBe(hierarchy);
    }
    expect(agent.requests).toEqual([]);
  });

  test("ownership uses the agent's window marker, preserving node identity", () => {
    const { hierarchy, control, appControl } = iosCapture();
    expect(isOwnPrototypeNode(hierarchy, control)).toBe(true);
    expect(isOwnPrototypeNode(hierarchy, appControl)).toBe(false);
    expect(isOwnPrototypeNode(hierarchy, { ...control })).toBe(false);
  });

  test("the planner refuses a prototype control wholly above the captured status-bar edge", () => {
    const { hierarchy, control, planner } = iosCapture();
    expect(planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 20 })).toEqual({
      kind: "refuse",
      bar: "status bar",
    });
  });

  test("the planner refuses a control whose clipped viewport is wholly under the status bar", () => {
    const { hierarchy, control, planner } = iosCapture(0, 200);
    const clippedBounds = { left: 100, top: 0, right: 200, bottom: 50 };
    expect(
      planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 20 }, clippedBounds),
    ).toEqual({ kind: "refuse", bar: "status bar" });
  });

  test("the planner moves a partially covered control into its reachable part", () => {
    const { hierarchy, control, planner } = iosCapture(40, 70);
    expect(planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 55 })).toEqual({
      kind: "proceed",
      point: { x: 150, y: 64 },
    });
  });

  test("a below-bar prototype control proceeds unchanged, including the exact bar edge", () => {
    for (const top of [59, 160]) {
      const { hierarchy, control, planner } = iosCapture(top, top + 40);
      const point = { x: 150, y: top };
      expect(planner.prototypeBarTapDecision(hierarchy, control, point)).toEqual({
        kind: "proceed",
        point,
      });
    }
  });

  test("an app control at the same position is never judged as prototype-owned", () => {
    const { hierarchy, appControl, planner } = iosCapture();
    const point = { x: 150, y: 20 };
    expect(planner.prototypeBarTapDecision(hierarchy, appControl, point)).toEqual({
      kind: "proceed",
      point,
    });
  });

  test("unknown visibility keeps the unverified warning with no guessed status-bar height", () => {
    const { hierarchy, control, planner } = iosCapture();
    delete hierarchy.insets?.systemChrome;
    const decision = planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 20 });
    expect(decision).toMatchObject({ kind: "proceed", point: { x: 150, y: 20 } });
    expect(decision.kind === "proceed" && decision.warning).toContain("does not say whether");
  });

  test("legacy-only or unavailable iOS captures retain the unverified warning", () => {
    for (const unavailable of [false, true]) {
      const { hierarchy, control, planner } = iosCapture();
      hierarchy.insets = unavailable
        ? { available: false, source: "unavailable", units: "unknown" }
        : undefined;
      const decision = planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 20 });
      expect(decision).toMatchObject({ kind: "proceed", point: { x: 150, y: 20 } });
      expect(decision.kind === "proceed" && decision.warning).toContain("does not say whether");
    }
  });

  test("without any captured inset no status-bar height is invented", () => {
    const { hierarchy, control, planner } = iosCapture();
    delete hierarchy.insets;
    delete hierarchy.systemInsets;
    const decision = planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 20 });
    expect(decision).toMatchObject({
      kind: "proceed",
      point: { x: 150, y: 20 },
    });
    expect(decision.kind === "proceed" && decision.warning).toContain("does not say whether");
  });

  test("a captured hidden status bar does not use the safe-area height as a visible bar", () => {
    const { hierarchy, control, planner } = iosCapture();
    hierarchy.insets = {
      ...hierarchy.insets,
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      systemChrome: {
        visibility: "hidden",
        statusBar: "hidden",
        source: "ios-status-bar-manager",
      },
    };
    expect(planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 20 })).toEqual({
      kind: "proceed",
      point: { x: 150, y: 20 },
    });
  });

  test("the iOS bottom safe area is not treated as a touch-consuming navigation bar", () => {
    const { hierarchy, control, planner } = iosCapture(850, 874);
    expect(planner.prototypeBarTapDecision(hierarchy, control, { x: 150, y: 862 })).toEqual({
      kind: "proceed",
      point: { x: 150, y: 862 },
    });
  });

  test("the Android planner still refuses a known status-bar tap", async () => {
    const node = {
      bounds: { left: 100, top: 0, right: 200, bottom: 40 },
      "resource-id": "android-control",
    };
    const hierarchy = capture({
      windows: [{ type: 4, packageName: CTRL_PROXY_PACKAGE, hierarchy: { node: [node] } }],
    });
    const agent = new FakePrototypeAgentClient();
    const planner = new TapPointPlanner({
      device: { name: "fake Android", deviceId: "fake-android", platform: "android" },
      geometry: () => new FakeElementGeometry(),
      strategy: () => new FakeTapStrategy(),
      prototypeAgents: { get: () => agent },
    });
    expect(await planner.prototypeTapHierarchy(hierarchy, node, "tap")).toBe(hierarchy);
    expect(agent.requests).toEqual([]);
    expect(planner.prototypeBarTapDecision(hierarchy, node, { x: 150, y: 20 })).toEqual({
      kind: "refuse",
      bar: "status bar",
    });
  });
});
