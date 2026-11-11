import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import { expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import {
  TapAtCoordinate,
  resolveTapAtCoordinates,
} from "../../../src/features/action/TapAtCoordinate";
import { SwipeOn } from "../../../src/features/action/swipeon";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeGestureExecutor } from "../../fakes/FakeGestureExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { spatialPanelObservation } from "../../helpers/xrSpatialPanelFixture";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { assertXrDisplayInputSupported } from "../../../src/features/xr/xrSpatialPanelInput";

const device = { name: "fake", platform: "android", deviceId: "fake-spatial" } as const;
function setup(capture: boolean | "host-missing" = false) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  const xrDetector = new FakeAndroidXrDetector(true);
  const observation = spatialPanelObservation(capture);
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const tap = new TapOnElement(device, adb, {
    waitForCondition: new RealWaitForCondition(observe, timer),
    timer,
    xrDetector,
    accessibilityDetector: new FakeAccessibilityDetector(),
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
  });
  Object.assign(tap, { accessibilityService: service });
  tap.observeScreen = observe;
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => observation.viewHierarchy!;
  return { timer, adb, service, xrDetector, observation, tap };
}

for (const [text, bounds] of [
  ["Settings", { left: 2470, top: 96, right: 2672, bottom: 192 }],
  ["Item 3", { left: 96, top: 416, right: 2672, bottom: 528 }],
] as const) {
  for (const capture of [false, "host-missing"] as const) {
    test(`tapOn ${text} (capture=${capture}) verifies the captured Compose owner by bounds and descendant identity`, async () => {
      const { tap, service, adb, timer } = setup(capture);
      const result = await tap.execute({ action: "tap", text, searchUntil: { duration: 100 } });
      expect(result.success).toBe(true);
      expect(service.getNodeActionHistory()).toMatchObject([
        {
          action: "click",
          selector: undefined,
          expectedBounds: bounds,
          identityHints: { labelText: text },
        },
      ]);
      expect(service.getNodeActionHistory()).toHaveLength(1);
      expect(service.getTapHistory()).toEqual([]);
      expect(adb.getAllCommands()).toEqual([]);
      expect(timer.getSleepHistory().length).toBeGreaterThan(0);
    });
  }
}

test("tapAny shares the bounds and label verification for an Item 3 container", async () => {
  const { timer, adb, service, xrDetector, observation } = setup();
  const tap = new TapAnyElement(device, adb, {
    timer,
    xrDetector,
    accessibilityService: service,
    accessibilityDetector: new FakeAccessibilityDetector(),
  });
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.testHooks.setRefreshViewHierarchy(async () => observation.viewHierarchy!);
  const result = await tap.execute({ action: "tap", container: { text: "Item 3" } });
  expect(result.success).toBe(true);
  expect(service.getNodeActionHistory()).toMatchObject([
    {
      action: "click",
      selector: undefined,
      expectedBounds: { left: 96, top: 416, right: 2672, bottom: 528 },
      identityHints: { labelText: "Item 3" },
    },
  ]);
  expect(service.getNodeActionHistory()).toHaveLength(1);
  expect(service.getTapHistory()).toEqual([]);
  expect(adb.getAllCommands()).toEqual([]);
});

test("a label click can still follow captured ancestry after linking the duplicate roots", async () => {
  const { tap, observation, service } = setup();
  const label = new SearchableHierarchy()
    .project(observation.viewHierarchy!)
    .find((entry) => entry.properties.text === "Settings")!;
  await tap.executeAndroidTap("tap", { x: 2571, y: 144 }, 0, {
    element: { ...label.properties, bounds: label.bounds! },
    isTalkBackEnabled: false,
    options: { action: "tap", resolvedHierarchy: observation.viewHierarchy },
  });
  expect(service.getNodeActionHistory()[0]).toMatchObject({
    expectedBounds: { left: 2470, top: 96, right: 2672, bottom: 192 },
    identityHints: { labelText: "Settings" },
  });
});

for (const kind of ["incomplete", "duplicate-window"] as const) {
  test(`refuses a ${kind} capture without weakening uniqueness`, async () => {
    const { tap, observation, service } = setup();
    const hierarchy = observation.viewHierarchy!;
    if (kind === "incomplete") {
      hierarchy.ctrlProxyIncomplete = true;
    } else {
      const duplicate = structuredClone(hierarchy.windows!.find((window) => window.id === 93)!);
      duplicate.id = 999;
      Object.assign(duplicate.hierarchy!, { windowId: 999 });
      hierarchy.windows!.push(duplicate);
    }
    const result = await tap.execute({
      action: "tap",
      text: "Settings",
      searchUntil: { duration: 100 },
    });
    expect(result.success).toBe(false);
    expect(service.getNodeActionHistory()).toEqual([]);
    expect(service.getTapHistory()).toEqual([]);
  });
}

test.each([false, true, "host-missing"] as const)(
  "tapAt refuses SpatialPanel display input before dispatch (capture=%s)",
  async (capture) => {
    const { observation, timer, adb, xrDetector, service } = setup(capture);
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);
    const tap = new TapAtCoordinate(device, adb, { timer, xrDetector, androidClient: service });
    setFakeTapAtWindow(tap);
    tap.observeScreen = observe;
    const result = await tap.execute({ x: 1000, y: 1400 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("XR spatial-panel input injection is unsupported");
    expect(result.error).toContain(
      "tapOn/tapAny (accessibility node click) or keyboard focus keys",
    );
    expect(service.getTapHistory()).toEqual([]);
    expect(adb.getAllCommands()).toEqual([]);
  },
);

for (const capture of [false, true, "host-missing"] as const) {
  test.each([undefined, "0"])(
    `swipeOn screen target refuses SpatialPanel input (display=%s, capture=${capture})`,
    async (display) => {
      const { observation, timer, adb, xrDetector, service } = setup(capture);
      const gesture = new FakeGestureExecutor();
      const observe = new FakeObserveScreen();
      observe.setObserveResult(observation);
      const swipe = new SwipeOn(device, adb, {
        observeScreen: observe,
        timer,
        xrDetector,
        executeGesture: gesture,
        accessibilityService: service,
        lastRenderedObservation: () => observation,
        accessibilityDetector: new FakeAccessibilityDetector(),
      });
      swipe.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
        observation,
      });
      const result = await swipe.execute({ direction: "up", autoTarget: false, display });
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "display-input swipe scrolling is unsupported on XR spatial panels",
      );
      expect(gesture.getSwipeCalls()).toEqual([]);
      expect(adb.getAllCommands()).toEqual([]);
    },
  );
}

test.each([
  "non-XR",
  "one-task-aligned-window",
  "contained-panel",
  "no-task",
  "background-app",
] as const)("SpatialPanel refusal stays narrow: %s", (kind) => {
  const observation = spatialPanelObservation();
  const windows = observation.viewHierarchy!.windows!;
  const host = windows.find((window) => window.id === 92)!;
  const panel = windows.find((window) => window.id === 93)!;
  if (kind === "one-task-aligned-window") {
    panel.bounds = structuredClone(host.bounds);
    observation.viewHierarchy!.windows = [panel];
  }
  if (kind === "background-app") {
    observation.activeWindow!.appId = "com.example.foreground";
  }
  if (kind === "contained-panel") {
    panel.bounds = structuredClone(host.bounds);
  }
  if (kind === "no-task") {
    delete observation.backStack;
  }
  expect(() => assertXrDisplayInputSupported(observation, kind !== "non-XR")).not.toThrow();
});

test.each([false, true, "host-missing"] as const)(
  "tapAt native points and points outside the host also refuse SpatialPanel input (capture=%s)",
  (capture) => {
    const observation = spatialPanelObservation(capture);
    for (const pointSpace of [undefined, "native"] as const) {
      expect(() =>
        resolveTapAtCoordinates(
          { x: 0, y: 0, androidXr: true, pointSpace },
          observation,
          "android",
        ),
      ).toThrow("XR spatial-panel input injection is unsupported");
    }
  },
);

test("SpatialPanel refusal uses the current task package when activeWindow is absent", () => {
  const observation = spatialPanelObservation("host-missing");
  delete observation.activeWindow;
  observation.backStack!.tasks.reverse();
  expect(() => assertXrDisplayInputSupported(observation, true)).toThrow(
    "XR spatial-panel input injection is unsupported",
  );
});

test.each([false, true])("current task bounds decide SpatialPanel refusal: embedded=%s", (embedded) => {
  const observation = spatialPanelObservation();
  const backStack = observation.backStack!;
  const current = backStack.tasks.find((task) => task.id === backStack.currentTaskId)!;
  const panelBounds = { left: 0, top: 0, right: 3000, bottom: 3000 };
  const hostBounds = structuredClone(current.bounds);
  backStack.tasks = [
    { ...current, id: current.id + 1, bounds: embedded ? panelBounds : hostBounds },
    { ...current, bounds: embedded ? hostBounds : panelBounds },
  ];

  if (embedded) {
    expect(() => assertXrDisplayInputSupported(observation, true)).toThrow(
      "XR spatial-panel input injection is unsupported",
    );
  } else {
    expect(() => assertXrDisplayInputSupported(observation, true)).not.toThrow();
  }
});

test("SpatialPanel evidence does not depend on whether a task-aligned host has content", () => {
  const observation = spatialPanelObservation();
  const windows = observation.viewHierarchy!.windows!;
  windows.find((window) => window.id === 92)!.hierarchy = structuredClone(
    windows.find((window) => window.id === 93)!.hierarchy,
  );
  expect(() => assertXrDisplayInputSupported(observation, true)).toThrow(
    "XR spatial-panel input injection is unsupported",
  );
});

test("SpatialPanel evidence needs only application window geometry, not node content or windowing mode", () => {
  const observation = spatialPanelObservation("host-missing");
  const panel = observation.viewHierarchy!.windows!.find((window) => window.id === 105)!;
  delete panel.hierarchy;
  delete observation.backStack!.tasks.find(
    (task) => task.id === observation.backStack!.currentTaskId,
  )!.windowingMode;
  expect(() => assertXrDisplayInputSupported(observation, true)).toThrow(
    "XR spatial-panel input injection is unsupported",
  );
});

test("XR home space with no foreground app permits display input", () => {
  const observation = spatialPanelObservation("host-missing");
  observation.activeWindow!.appId = "com.android.systemui.xrhomeenv";
  expect(() => assertXrDisplayInputSupported(observation, true)).not.toThrow();
  delete observation.activeWindow;
  delete observation.backStack;
  expect(() => assertXrDisplayInputSupported(observation, true)).not.toThrow();
});
