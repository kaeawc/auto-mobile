import { describe, expect, spyOn, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { prepareTargetDisplayAction } from "../../../src/features/action/TargetDisplayAction";
import { ActionableError } from "../../../src/models/ActionableError";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import type { BaseActionResult } from "../../../src/models/BaseActionResult";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { observation, setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";

const device: BootedDevice = {
  deviceId: "typed-display-fence",
  name: "fake",
  platform: "android",
  displays: {
    panels: [{ key: "inner", role: "inner", sizePx: { width: 100, height: 200 } }],
    postures: [],
  },
};
const cases = [
  { label: "one transition", count: 1, prior: true, stamp: 7 },
  { label: "two transitions", count: 2, prior: true, stamp: 7 },
  { label: "no transition", count: 0, prior: true, stamp: 7 },
  { label: "capture-start stamp", count: 1, prior: true, stamp: 5 },
  { label: "no prior observation", count: 1, prior: false, stamp: 7 },
];
type Scenario = (typeof cases)[number];

function harness(scenario: Scenario, platform: "android" | "ios" = "android") {
  const transitions = new FakeDisplayTransitionReader();
  const screen = {
    ...observation(100, 200),
    displayRevision: 41,
    display: { key: "inner", role: "inner", posture: "opened", generation: scenario.stamp },
  } as ObserveResult;
  const observe = new FakeObserveScreen();
  observe.setObserveResult(screen);
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", {
    stdout: 'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 100 x 200}',
    stderr: "",
  });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const targetDevice = { ...device, platform };
  const deps = {
    timer,
    displayTransitions: transitions,
    renderedDisplayRevision: () => (scenario.prior ? 41 : undefined),
    renderedDisplayGeneration: () => (scenario.prior ? screen.display.generation : undefined),
  };
  return { transitions, screen, observe, adb, timer, targetDevice, deps };
}

function assertStale(error: unknown, observed: number, current: number, knownPanel = true) {
  expect(error).toBeInstanceOf(ActionableError);
  expect(error).toBeInstanceOf(StaleDisplayError);
  if (!(error instanceof StaleDisplayError)) {
    throw new Error("Expected StaleDisplayError");
  }
  expect(error.details).toEqual({
    observedGeneration: observed,
    currentGeneration: current,
    ...(knownPanel ? { currentDisplayKey: "cover" } : {}),
    retry: "observe",
  });
  expect(error.message).toContain(`observed generation ${observed}, current generation ${current}`);
  expect(error.message).toContain("Re-observe");
}
function assertResult(result: BaseActionResult, observed: number, current: number) {
  expect(result.success).toBe(false);
  expect(result.staleDisplay).toEqual({
    observedGeneration: observed,
    currentGeneration: current,
    currentDisplayKey: "cover",
    retry: "observe",
  });
  expect(result.error).toContain(`observed generation ${observed}, current generation ${current}`);
  expect(result.error).toStartWith("Display changed since these coordinates were chosen");
  expect(result.error).toContain('Re-observe display "cover"');
}
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a stale-display rejection");
}

describe("typed BaseVisualChange fences A/B/C", () => {
  for (const site of ["A", "B", "C"] as const) {
    test.each(cases)(`${site}: $label`, async (scenario) => {
      const h = harness(scenario);
      const action = new BaseVisualChange(
        h.targetDevice,
        h.adb,
        h.timer,
        h.deps.renderedDisplayRevision,
        h.deps,
      );
      action.observeScreen = h.observe;
      let calls = 0;
      const transition = () => h.transitions.transition(scenario.count);
      if (site === "A" && scenario.count) {
        transition();
      }
      if (site === "B") {
        spyOn(h.observe, "getMostRecentCachedObserveResult").mockImplementation(async () => {
          if (scenario.count) {
            transition();
          }
          return h.screen;
        });
      }
      if (site === "C") {
        spyOn(h.adb, "getDeviceTimestampMs").mockImplementation(async () => {
          if (scenario.count) {
            transition();
          }
          return h.timer.now();
        });
      }
      const run = () =>
        action.observedInteraction(
          async () => {
            calls++;
            return { success: true };
          },
          {
            changeExpected: false,
            skipUiStability: true,
            predictionContext: { toolName: "tapOn", toolArgs: {} },
          },
        );
      const fenced = scenario.count > 0 && (site !== "A" || scenario.prior);
      if (fenced) {
        assertStale(
          await rejection(run),
          scenario.prior ? h.screen.display.generation : 7,
          7 + scenario.count,
        );
        expect(calls).toBe(0);
      } else {
        expect((await run()).success).toBe(true);
        expect(calls).toBe(1);
      }
    });
  }
});

describe("typed TapAtCoordinate fences D/E/F", () => {
  for (const site of [
    "D",
    "E",
    "F-pre-dispatch",
    "F-fresh-retry",
    "F-second-android",
    "F-second-ios",
  ] as const) {
    test.each(cases)(`${site}: $label`, async (scenario) => {
      const h = harness(scenario, site === "F-second-ios" ? "ios" : "android");
      let dispatches = 0;
      const transition = () => {
        if (scenario.count) {
          h.transitions.transition(scenario.count);
        }
      };
      const references = new SnapshotReferenceStore(new CountingIdGenerator("fence"));
      if (site === "F-pre-dispatch") {
        spyOn(references, "staleReason").mockImplementation(() => {
          transition();
          return undefined;
        });
      }
      const dispatch = async () => {
        dispatches++;
        if (site.startsWith("F-second") && dispatches === 1) {
          transition();
        }
        if (site === "F-fresh-retry" && dispatches === 1) {
          throw new ActionableError(
            "Stale frame context for input/tap; observe a fresh frame before retrying",
          );
        }
      };
      const client = { requestTapCoordinates: async () => ({ success: true }) };
      const action = new TapAtCoordinate(h.targetDevice, h.adb, {
        ...h.deps,
        snapshotReferences: references,
        androidClient: client,
        iosClient: client,
        dispatchAndroidCoordinateTap: dispatch,
        dispatchIosCoordinateTap: dispatch,
        invalidateIosCache: () => {},
      });
      setFakeTapAtWindow(action);
      action.observeScreen = h.observe;
      h.observe.setObserveResult((index) => {
        if ((site === "E" && index === 0) || (site === "F-fresh-retry" && index === 1)) {
          transition();
        }
        return {
          ...h.screen,
          viewHierarchy: {
            ...h.screen.viewHierarchy!,
            frameContext: index === 0 ? "epoch:1" : "epoch:2",
          },
        };
      });
      if (site === "D") {
        transition();
      }
      const result = await action.execute({
        x: 20,
        y: 30,
        ...(site.startsWith("F-second") ? { action: "doubleTap" as const } : {}),
        ...(site === "F-pre-dispatch" ? { snapshotId: "fake-reference" } : {}),
      });
      const fenced = scenario.count > 0 && (site !== "D" || scenario.prior);
      if (fenced) {
        assertResult(result, scenario.prior ? h.screen.display.generation : 7, 7 + scenario.count);
      } else {
        expect(result.success).toBe(true);
        expect(result.staleDisplay).toBeUndefined();
      }
      expect(dispatches).toBe(
        fenced
          ? site === "F-fresh-retry" || site.startsWith("F-second")
            ? 1
            : 0
          : site === "F-fresh-retry" || site.startsWith("F-second")
            ? 2
            : 1,
      );
    });
  }
});

describe("typed explicit-display fences G", () => {
  for (const site of [
    "caller",
    "resolving-android",
    "resolving-ios",
    "panel-mismatch",
    "logical-id",
    "dispatch",
  ] as const) {
    test.each(cases)(`G-${site}: $label`, async (scenario) => {
      const h = harness(scenario, site === "resolving-ios" ? "ios" : "android");
      // No full caller revision skips G's caller check, but targeting still needs a prior panel.
      const previous = () => ({
        display: {
          key: "inner",
          generation: scenario.prior ? h.screen.display.generation : undefined,
        },
        displayRevision: scenario.prior ? 41 : undefined,
      });
      if (site === "caller" && scenario.count) {
        h.transitions.transition(scenario.count);
      }
      h.observe.setObserveResult(() => {
        if (site.startsWith("resolving") && scenario.count) {
          h.transitions.transition(scenario.count);
        }
        return site === "panel-mismatch" && scenario.count
          ? { ...h.screen, display: { ...h.screen.display, key: "cover" } }
          : h.screen;
      });
      if (site === "logical-id") {
        spyOn(h.adb, "executeCommand").mockImplementation(async () => {
          if (scenario.count) {
            h.transitions.transition(scenario.count);
          }
          return {
            stdout:
              'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 100 x 200}',
            stderr: "",
          };
        });
      }
      const run = async () => {
        const target = await prepareTargetDisplayAction(
          h.targetDevice,
          "inner",
          h.observe,
          h.adb,
          previous,
          undefined,
          h.transitions,
        );
        if (site === "dispatch" && scenario.count) {
          h.transitions.transition(scenario.count);
        }
        target.assertCurrent();
        return target;
      };
      const fenced = scenario.count > 0 && (site !== "caller" || scenario.prior);
      if (fenced) {
        // A mismatching observation may precede a tracker notification; report the current tracker as-is.
        const current = site === "panel-mismatch" ? 7 : 7 + scenario.count;
        const error = await rejection(run);
        if (site === "panel-mismatch") {
          expect(error).toBeInstanceOf(StaleDisplayError);
          if (error instanceof StaleDisplayError) {
            expect(error.details).toEqual({
              observedGeneration: scenario.prior ? scenario.stamp : 7,
              currentGeneration: 7,
              currentDisplayKey: "inner",
              retry: "observe",
            });
          }
        } else {
          assertStale(error, scenario.prior ? h.screen.display.generation : 7, current);
        }
      } else {
        expect((await run()).observation.display.key).toBe("inner");
      }
    });
  }
  test("G still requires observation of the requested panel", async () => {
    const h = harness(cases[4]);
    await expect(
      prepareTargetDisplayAction(
        device,
        "inner",
        h.observe,
        h.adb,
        () => undefined,
        undefined,
        h.transitions,
      ),
    ).rejects.toThrow(
      'Coordinates for display "inner" require a prior observation of that panel. Re-observe display "inner" and retry.',
    );
  });
  test("a push without a newly observed panel omits currentDisplayKey", async () => {
    const h = harness(cases[0]);
    h.transitions.transition(1, false);
    const action = new BaseVisualChange(
      device,
      h.adb,
      h.timer,
      h.deps.renderedDisplayRevision,
      h.deps,
    );
    assertStale(
      await rejection(() =>
        action.observedInteraction(async () => ({ success: true }), {
          changeExpected: false,
          predictionContext: { toolName: "tapOn", toolArgs: {} },
        }),
      ),
      7,
      8,
      false,
    );
  });
});

// Exercise the real action catch boundaries, rather than just the shared result helper.
describe("coordinate-action catches preserve the typed refusal", () => {
  for (const name of ["tapOn", "tapAny", "swipeOn", "dragAndDrop", "pinchOn"] as const) {
    test(`${name} returns A's canonical failure`, async () => {
      const h = harness(cases[0], "ios");
      h.transitions.transition(2);
      const result = await caughtAction(name, h);
      assertResult(result, 7, 9);
    });
  }
});

async function caughtAction(
  name: "tapOn" | "tapAny" | "swipeOn" | "dragAndDrop" | "pinchOn",
  h: ReturnType<typeof harness>,
): Promise<BaseActionResult> {
  switch (name) {
    case "tapOn": {
      const action = new TapOnElement(h.targetDevice, h.adb, h.deps);
      action.observeScreen = h.observe;
      return action.execute({ action: "tap", text: "Target" });
    }
    case "tapAny": {
      const action = new TapAnyElement(h.targetDevice, h.adb, h.deps);
      action.observeScreen = h.observe;
      return action.execute({ action: "tap" });
    }
    case "swipeOn": {
      const action = new SwipeOn(h.targetDevice, h.adb as unknown as AdbClient, h.deps);
      action.observeScreen = h.observe;
      return action.execute({ direction: "up", autoTarget: false });
    }
    case "dragAndDrop": {
      const action = new DragAndDrop(
        h.targetDevice,
        h.adb as unknown as AdbClient,
        h.timer,
        h.deps,
      );
      action.observeScreen = h.observe;
      return action.execute({ source: { text: "Source" }, target: { text: "Target" } });
    }
    case "pinchOn": {
      const action = new PinchOn(h.targetDevice, h.adb as unknown as AdbClient, {
        ...h.deps,
        capture: new FakeHierarchyCapture(async () => h.screen.viewHierarchy!),
      });
      action.observeScreen = h.observe;
      return action.execute({ direction: "in" });
    }
  }
}

describe("explicit-display action catches", () => {
  for (const name of ["tapAt", "tapOn", "swipeOn", "dragAndDrop", "pinchOn", "sendKeys"] as const) {
    test(`G: ${name} preserves stale details`, async () => {
      const h = harness(cases[0]);
      h.transitions.transition(2);
      assertResult(await caughtExplicitAction(name, h), 7, 9);
      expect(h.adb.getExecutedCommands()).toEqual([]);
    });
  }
  test("G: sendKeys preserves a fence after resolving and before command dispatch", async () => {
    const h = harness(cases[0]);
    const action = new SendKeys(h.targetDevice, new FakeAdbClientFactory(h.adb), {
      timer: h.timer,
      displayTransitions: h.transitions,
      observer: h.observe,
      lastRenderedObservation: () => h.screen,
      timestampProvider: {
        now: async () => {
          h.transitions.transition(2);
          return 0;
        },
      },
    });
    const result = await action.execute(
      [{ action: "key", key: "enter" }],
      undefined,
      undefined,
      undefined,
      "inner",
    );
    assertResult(result, 7, 9);
    expect(result.commands[0]?.staleDisplay).toEqual(result.staleDisplay);
    expect(h.adb.getExecutedCommands().some((cmd) => cmd.includes("keyevent"))).toBe(false);
  });
});

async function caughtExplicitAction(
  name: "tapAt" | "tapOn" | "swipeOn" | "dragAndDrop" | "pinchOn" | "sendKeys",
  h: ReturnType<typeof harness>,
): Promise<BaseActionResult> {
  const deps = { ...h.deps, lastRenderedObservation: () => h.screen };
  const client = { requestTapCoordinates: async () => ({ success: true }) };
  switch (name) {
    case "tapAt": {
      const action = new TapAtCoordinate(h.targetDevice, h.adb, {
        ...deps,
        androidClient: client,
        iosClient: client,
      });
      action.observeScreen = h.observe;
      return action.execute({ x: 1, y: 2, display: "inner" });
    }
    case "tapOn": {
      const action = new TapOnElement(h.targetDevice, h.adb, deps);
      action.observeScreen = h.observe;
      return action.execute({ action: "tap", text: "Target", display: "inner" });
    }
    case "swipeOn": {
      const action = new SwipeOn(h.targetDevice, h.adb as unknown as AdbClient, deps);
      action.observeScreen = h.observe;
      return action.execute({ direction: "up", display: "inner" });
    }
    case "dragAndDrop": {
      const action = new DragAndDrop(h.targetDevice, h.adb as unknown as AdbClient, h.timer, deps);
      action.observeScreen = h.observe;
      return action.execute({
        source: { text: "Source" },
        target: { text: "Target" },
        display: "inner",
      });
    }
    case "pinchOn": {
      const action = new PinchOn(h.targetDevice, h.adb as unknown as AdbClient, deps);
      action.observeScreen = h.observe;
      return action.execute({ direction: "in", display: "inner" });
    }
    case "sendKeys": {
      const action = new SendKeys(h.targetDevice, new FakeAdbClientFactory(h.adb), {
        ...deps,
        observer: h.observe,
      });
      return action.execute(
        [{ action: "key", key: "enter" }],
        undefined,
        undefined,
        undefined,
        "inner",
      );
    }
  }
}

describe("tapOn fresh hierarchy transition fence", () => {
  test.each(cases)("extra preparation fence: $label", async (scenario) => {
    const h = harness(scenario);
    const captured = { ...h.screen.viewHierarchy!, screenWidth: 200, screenHeight: 100 };
    const action = new TapOnElement(h.targetDevice, h.adb, {
      ...h.deps,
      hierarchyCapture: new FakeHierarchyCapture(async () => captured),
    });
    spyOn(h.transitions, "checkIdentity").mockImplementation(() => {
      if (scenario.count) {
        h.transitions.transition(scenario.count);
        return true;
      }
      return false;
    });
    const run = () => action.refreshViewHierarchy(10, h.screen.screenSize);
    if (scenario.count) {
      assertStale(
        await rejection(run),
        scenario.prior ? h.screen.display.generation : 7,
        7 + scenario.count,
      );
    } else {
      expect(await run()).toEqual(captured);
    }
  });
});
