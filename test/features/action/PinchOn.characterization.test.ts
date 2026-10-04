import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PinchOn } from "../../../src/features/action/PinchOn";
import type { ElementBounds, PinchOnOptions, ViewHierarchyResult } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";

const restores: Array<() => void> = [];
afterEach(() =>
  restores
    .splice(0)
    .reverse()
    .forEach((restore) => restore()),
);

function harness(platform: "android" | "ios", bounds: ElementBounds) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const android = new FakeCtrlProxy(timer);
  const ios = new FakeIOSCtrlProxy(timer);
  const adb = new FakeAdbExecutor();
  const observe = new FakeObserveScreen();
  const hierarchy: ViewHierarchyResult = {
    hierarchy: { node: [{ "resource-id": "target", bounds, clickable: true }] },
    screenWidth: 402,
    screenHeight: 874,
  };
  observe.setObserveResult({
    updatedAt: timer.now(),
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: hierarchy,
  });
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  window.configureActiveWindow({
    appId: "com.test.app",
    activityName: "MainActivity",
    layoutSeqSum: 123,
  });
  const androidSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    android as unknown as AndroidCtrlProxyClient,
  );
  const iosSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    ios as unknown as IOSCtrlProxyClient,
  );
  const managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
    isAvailable: async () => true,
  } as unknown as AndroidCtrlProxyManager);
  restores.push(
    () => androidSpy.mockRestore(),
    () => iosSpy.mockRestore(),
    () => managerSpy.mockRestore(),
  );
  const capture = new FakeHierarchyCapture(() => hierarchy, platform);
  const pinch = new PinchOn(
    { deviceId: `characterization-${platform}`, name: "Fake", platform },
    null,
    {
      timer,
      capture,
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    },
  );
  Object.assign(pinch, { observeScreen: observe, awaitIdle: new FakeAwaitIdle(), window, adb });
  return {
    pinch,
    android,
    ios,
    adb,
    capture,
    hierarchy,
    observe,
    history: () => (platform === "android" ? android.getPinchHistory() : ios.getPinchHistory()),
  };
}

const normal = { left: 0, top: 0, right: 393, bottom: 851 };
const geometryCases: Array<{ name: string; bounds: ElementBounds; options: PinchOnOptions }> = [
  { name: "default out", bounds: normal, options: { direction: "out" } },
  { name: "default in", bounds: normal, options: { direction: "in" } },
  { name: "scale only", bounds: normal, options: { direction: "out", scale: 2 } },
  {
    name: "infer start",
    bounds: normal,
    options: { direction: "out", distanceEnd: 101, scale: 3 },
  },
  {
    name: "infer end",
    bounds: normal,
    options: { direction: "in", distanceStart: 101, scale: 0.3 },
  },
  {
    name: "both distances override scale",
    bounds: normal,
    options: { direction: "out", distanceStart: 55, distanceEnd: 99, scale: 8 },
  },
  { name: "start only", bounds: normal, options: { direction: "out", distanceStart: 50 } },
  { name: "end only", bounds: normal, options: { direction: "in", distanceEnd: 50 } },
  {
    name: "correct out",
    bounds: normal,
    options: { direction: "out", distanceStart: 100, distanceEnd: 50 },
  },
  {
    name: "correct in",
    bounds: normal,
    options: { direction: "in", distanceStart: 50, distanceEnd: 100 },
  },
  {
    name: "equal out",
    bounds: normal,
    options: { direction: "out", distanceStart: 100, distanceEnd: 100 },
  },
  {
    name: "equal in",
    bounds: normal,
    options: { direction: "in", distanceStart: 100, distanceEnd: 100 },
  },
  {
    name: "clamp",
    bounds: normal,
    options: {
      direction: "out",
      distanceStart: 1,
      distanceEnd: 1000,
      duration: 10000,
      rotationDegrees: 45,
    },
  },
  {
    name: "clipped",
    bounds: { left: -50, top: -361, right: 855, bottom: 1456 },
    options: { direction: "in", duration: 1, rotationDegrees: 90 },
  },
  { name: "tiny", bounds: { left: 1, top: 1, right: 7, bottom: 7 }, options: { direction: "out" } },
];

type ExpectedGeometry = [
  centerX: number,
  centerY: number,
  distanceStart: number,
  distanceEnd: number,
  scale: number,
  duration: number,
  rotationDegrees: number,
  timeoutMs: number,
];
const geometryExpected: Record<string, Record<"android" | "ios", ExpectedGeometry>> = {
  "default out": {
    android: [197, 426, 78.60000000000001, 235.79999999999998, 2.9999999999999996, 300, 0, 5000],
    ios: [197, 426, 79, 236, 2.9873417721518987, 300, 0, 5000],
  },
  "default in": {
    android: [197, 426, 235.79999999999998, 78.60000000000001, 0.33333333333333337, 300, 0, 5000],
    ios: [197, 426, 236, 79, 0.3347457627118644, 300, 0, 5000],
  },
  "scale only": {
    android: [197, 426, 98.25, 196.5, 2, 300, 0, 5000],
    ios: [197, 426, 98, 197, 2.010204081632653, 300, 0, 5000],
  },
  "infer start": {
    android: [197, 426, 39.300000000000004, 101, 2.569974554707379, 300, 0, 5000],
    ios: [197, 426, 39, 101, 2.58974358974359, 300, 0, 5000],
  },
  "infer end": {
    android: [197, 426, 101, 39.300000000000004, 0.3891089108910892, 300, 0, 5000],
    ios: [197, 426, 101, 39, 0.38613861386138615, 300, 0, 5000],
  },
  "both distances override scale": {
    android: [197, 426, 55, 99, 1.8, 300, 0, 5000],
    ios: [197, 426, 55, 99, 1.8, 300, 0, 5000],
  },
  "start only": {
    android: [197, 426, 50, 235.79999999999998, 4.715999999999999, 300, 0, 5000],
    ios: [197, 426, 50, 236, 4.72, 300, 0, 5000],
  },
  "end only": {
    android: [197, 426, 235.79999999999998, 50, 0.21204410517387617, 300, 0, 5000],
    ios: [197, 426, 236, 50, 0.211864406779661, 300, 0, 5000],
  },
  "correct out": {
    android: [197, 426, 100, 150, 1.5, 300, 0, 5000],
    ios: [197, 426, 100, 150, 1.5, 300, 0, 5000],
  },
  "correct in": {
    android: [197, 426, 150, 100, 0.6666666666666666, 300, 0, 5000],
    ios: [197, 426, 150, 100, 0.6666666666666666, 300, 0, 5000],
  },
  "equal out": {
    android: [197, 426, 100, 150, 1.5, 300, 0, 5000],
    ios: [197, 426, 100, 150, 1.5, 300, 0, 5000],
  },
  "equal in": {
    android: [197, 426, 150, 100, 0.6666666666666666, 300, 0, 5000],
    ios: [197, 426, 150, 100, 0.6666666666666666, 300, 0, 5000],
  },
  clamp: {
    android: [197, 426, 39.300000000000004, 353.7, 8.999999999999998, 10000, 45, 12000],
    ios: [197, 426, 39, 354, 9.076923076923077, 10000, 45, 12000],
  },
  clipped: {
    android: [201, 437, 241.2, 80.4, 0.33333333333333337, 1, 90, 5000],
    ios: [201, 437, 241, 80, 0.33195020746887965, 1, 90, 5000],
  },
  tiny: { android: [4, 4, 5.4, 5.4, 1, 300, 0, 5000], ios: [4, 4, 5, 5, 1, 300, 0, 5000] },
};

for (const platform of ["android", "ios"] as const) {
  describe(`PinchOn exact geometry (${platform})`, () => {
    test.each(geometryCases)("$name", async ({ name, bounds, options }) => {
      const { pinch, history, adb, observe } = harness(platform, bounds);
      const result = await pinch.execute({ ...options, container: { elementId: "target" } });
      const [
        centerX,
        centerY,
        distanceStart,
        distanceEnd,
        scale,
        duration,
        rotationDegrees,
        timeoutMs,
      ] = geometryExpected[name][platform];
      const gesture = {
        centerX,
        centerY,
        distanceStart,
        distanceEnd,
        duration,
        rotationDegrees,
        timeoutMs,
      };
      expect(history()).toEqual([gesture]);
      expect(result).toStrictEqual({
        success: true,
        direction: options.direction,
        centerX,
        centerY,
        distanceStart,
        distanceEnd,
        duration,
        rotationDegrees,
        scale,
        targetType: "container",
        container: { elementId: "target" },
        warning: undefined,
        observation: observe.getConfiguredObserveResult(),
        a11yTotalTimeMs: duration,
        a11yGestureTimeMs: duration,
      });
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });
}

const autoCases: Array<{
  name: string;
  nodes: ViewHierarchyResult["hierarchy"]["node"];
  windows?: ViewHierarchyResult["windows"];
}> = [
  { name: "empty", nodes: [] },
  {
    name: "zero area",
    nodes: [
      { "resource-id": "zero", bounds: { left: 0, top: 0, right: 0, bottom: 0 }, clickable: true },
    ],
  },
  {
    name: "offscreen",
    nodes: [
      {
        "resource-id": "offscreen",
        bounds: { left: 500, top: 0, right: 700, bottom: 200 },
        clickable: true,
      },
    ],
  },
  {
    name: "small inert",
    nodes: [{ "resource-id": "inert", bounds: { left: 0, top: 0, right: 20, bottom: 20 } }],
  },
  {
    name: "large inert",
    nodes: [{ "resource-id": "large", bounds: { left: 0, top: 0, right: 300, bottom: 500 } }],
  },
  {
    name: "duplicate",
    nodes: [0, 1].map(() => ({
      "resource-id": "duplicate",
      bounds: { left: 0, top: 0, right: 200, bottom: 200 },
      clickable: true,
    })),
  },
  {
    name: "anonymous",
    nodes: [{ bounds: { left: 0, top: 0, right: 200, bottom: 200 }, clickable: true }],
  },
  {
    name: "sheet penalty",
    nodes: [
      {
        "resource-id": "map",
        bounds: { left: 0, top: 0, right: 200, bottom: 400 },
        clickable: true,
      },
      {
        "resource-id": "sheet",
        class: "BottomSheet",
        bounds: { left: 0, top: 474, right: 402, bottom: 874 },
        scrollable: true,
      },
    ],
  },
  {
    name: "window tie",
    nodes: [
      {
        "resource-id": "lower",
        bounds: { left: 0, top: 0, right: 200, bottom: 200 },
        clickable: true,
      },
    ],
    windows: [
      {
        windowLayer: 5,
        hierarchy: {
          node: {
            "resource-id": "upper",
            bounds: { left: 100, top: 100, right: 300, bottom: 300 },
            clickable: true,
          },
        },
      },
    ],
  },
];

type ExpectedTarget = [
  centerX: number,
  centerY: number,
  distanceStart: number,
  distanceEnd: number,
  scale: number,
  targetType: "screen" | "container",
  elementId: string | null,
  warning: string | null,
];
const autoExpected: Record<string, ExpectedTarget> = {
  empty: [201, 437, 80.4, 241.2, 2.9999999999999996, "screen", null, null],
  "zero area": [201, 437, 80.4, 241.2, 2.9999999999999996, "screen", null, null],
  offscreen: [201, 437, 80.4, 241.2, 2.9999999999999996, "screen", null, null],
  "small inert": [201, 437, 80.4, 241.2, 2.9999999999999996, "screen", null, null],
  "large inert": [150, 250, 60, 180, 3, "container", "large", null],
  duplicate: [100, 100, 40, 120, 3, "container", "duplicate", null],
  anonymous: [
    100,
    100,
    40,
    120,
    3,
    "container",
    null,
    "Auto-targeted element lacks a usable identifier; pinching within its bounds without container metadata.",
  ],
  "sheet penalty": [100, 200, 40, 120, 3, "container", "map", null],
  "window tie": [200, 200, 40, 120, 3, "container", "upper", null],
};

describe("PinchOn auto-target characterization", () => {
  test.each(autoCases)("$name", async ({ name, nodes, windows }) => {
    const { pinch, hierarchy, history, adb, observe } = harness("android", normal);
    hierarchy.hierarchy.node = nodes;
    hierarchy.windows = windows;
    const result = await pinch.execute({ direction: "out" });
    const [centerX, centerY, distanceStart, distanceEnd, scale, targetType, elementId, warning] =
      autoExpected[name];
    expect(history()).toEqual([
      {
        centerX,
        centerY,
        distanceStart,
        distanceEnd,
        duration: 300,
        rotationDegrees: 0,
        timeoutMs: 5000,
      },
    ]);
    expect(result).toStrictEqual({
      success: true,
      direction: "out",
      centerX,
      centerY,
      distanceStart,
      distanceEnd,
      scale,
      duration: 300,
      rotationDegrees: 0,
      targetType,
      container: elementId ? { elementId } : undefined,
      warning: warning ?? undefined,
      observation: observe.getConfiguredObserveResult(),
      a11yTotalTimeMs: 300,
      a11yGestureTimeMs: 300,
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("PinchOn validation characterization", () => {
  test.each([
    [{ scale: 0 }, "scale must be greater than 0"],
    [{ distanceStart: 0 }, "distanceStart must be greater than 0"],
    [{ distanceEnd: -1 }, "distanceEnd must be greater than 0"],
  ] as const)("returns exact failure for %j", async (extra, error) => {
    const { pinch, history, adb, capture } = harness("android", normal);
    const options = { direction: "out" as const, ...extra };
    expect(await pinch.execute(options)).toStrictEqual({
      success: false,
      direction: "out",
      distanceStart: options.distanceStart ?? 0,
      distanceEnd: options.distanceEnd ?? 0,
      duration: 0,
      scale: options.scale,
      rotationDegrees: undefined,
      centerX: 0,
      centerY: 0,
      targetType: "screen",
      container: undefined,
      error,
    });
    expect(history()).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(capture.requests).toEqual([]);
  });
});

test.each([
  [undefined, "android", "Pinch direction is required ('in' or 'out')"],
  [
    "out",
    "web",
    "pinch on elements is not supported on platform 'web'. Supported platforms: android, ios.",
  ],
] as const)(
  "preserves direction/platform validation priority: %s/%s",
  async (direction, platform, error) => {
    const { pinch, history, adb, capture } = harness("android", normal);
    Object.assign(pinch, { device: { deviceId: "unsupported-fake", name: "Fake", platform } });
    const options = { direction, scale: 0 } as unknown as PinchOnOptions;
    expect(await pinch.execute(options)).toStrictEqual({
      success: false,
      direction: direction ?? "in",
      distanceStart: 0,
      distanceEnd: 0,
      duration: 0,
      scale: 0,
      rotationDegrees: undefined,
      centerX: 0,
      centerY: 0,
      targetType: "screen",
      container: undefined,
      error,
    });
    expect(history()).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(capture.requests).toEqual([]);
  },
);
