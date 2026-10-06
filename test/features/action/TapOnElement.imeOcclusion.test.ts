import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { TapOnElement, tapFocusFailure } from "../../../src/features/action/TapOnElement";
import type { ElementBounds, ObserveResult } from "../../../src/models";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import {
  imeOcclusionHierarchy,
  sharedBoundsImeHierarchy,
} from "../../fixtures/observe/imeOcclusion";
import {
  syntheticNavigationHierarchy,
  navigationScreen,
} from "../../fixtures/observe/iosNavigationOcclusion";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ActionableError } from "../../../src/models/ActionableError";
import { KeyboardOcclusionError } from "../../../src/models/KeyboardOcclusionError";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import {
  capturedBounds,
  iosKeyboardCapture,
  iosKeyboardTabbarHierarchy,
} from "../../fixtures/observe/iosKeyboardTabbar";

import capturedIme from "../../fixtures/android-ime-window/playground-gboard-api36.json";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import * as skeletonProjection from "../../../src/features/observe/output/SkeletonProjection";

const capturedImeHierarchy = () =>
  new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    structuredClone(capturedIme) as AccessibilityHierarchy,
  );

test.each(["Demos", "Slides", "Settings", "Password"])(
  "captured %s under the full IME window refuses without dispatch",
  async (label) => {
    const { result, points } = await executeAt(label, {
      fixture: capturedImeHierarchy(),
      screenSize: { width: 1080, height: 2400 },
      realSelector: true,
      index: label === "Settings" ? 1 : undefined,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      `Failed to perform tap on element: Target "${label}" is covered by the soft keyboard; dismiss the keyboard first.`,
    );
    expect(points).toEqual([]);
  },
);

test("pre-dispatch window check refuses an unsafe point in the captured IME navigation strip", async () => {
  const safePoint = spyOn(skeletonProjection, "tapPointOutsideIme").mockReturnValue({
    x: 403,
    y: 2305,
  });
  try {
    const { result, points } = await executeAt("Demos", {
      fixture: capturedImeHierarchy(),
      screenSize: { width: 1080, height: 2400 },
      realSelector: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Target "Demos" is covered by the soft keyboard; dismiss the keyboard first.',
    );
    expect(points).toEqual([]);
  } finally {
    safePoint.mockRestore();
  }
});

test("visible-match fallback also refuses a candidate inside the IME before dispatch", async () => {
  const safePoint = spyOn(skeletonProjection, "tapPointOutsideIme")
    .mockReturnValueOnce({ x: 200, y: 140 })
    .mockReturnValueOnce({ x: 200, y: 175 });
  try {
    const { result, points } = await executeAt("Partly Covered", {
      matchedBounds: { left: 100, top: 145, right: 300, bottom: 170 },
    });
    expect(safePoint).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Target "Partly Covered" is covered by the soft keyboard; dismiss the keyboard first.',
    );
    expect(points).toEqual([]);
  } finally {
    safePoint.mockRestore();
  }
});

test("partial app target uses the exposed rectangle above the full IME frame", async () => {
  // No captured Playground row straddles y=1517. Extend the existing IME helper's
  // window metadata so the frame starts above the accessible key at y=150.
  const hierarchy = imeOcclusionHierarchy();
  Object.assign(hierarchy.windows![0], {
    type: 2,
    bounds: { left: 0, top: 140, right: 400, bottom: 240 },
  });
  const { result, points } = await executeAt("Partly Covered", {
    fixture: hierarchy,
    realSelector: true,
  });
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 200, y: 135 }]);
  expect(points[0].y).toBeGreaterThanOrEqual(130);
  expect(points[0].y).toBeLessThan(140);
});

test("tapOn preserves a linked window above the IME even where their rectangles overlap", async () => {
  const hierarchy = imeOcclusionHierarchy();
  const app = hierarchy.hierarchy.node!;
  const keyboard = hierarchy.windows![0].hierarchy!.node!;
  const upper = {
    $: {
      text: "Above IME Window",
      clickable: true,
      bounds: { left: 100, top: 160, right: 300, bottom: 190 },
    },
  };
  hierarchy.hierarchy.node = { $: {}, node: [app, keyboard, upper] };
  hierarchy.windows = [
    { windowLayer: 0, hierarchy: { node: app } },
    {
      windowLayer: 1,
      type: 2,
      bounds: { left: 0, top: 150, right: 400, bottom: 240 },
      hierarchy: { node: keyboard },
    },
    { windowLayer: 2, hierarchy: { node: upper } },
  ];
  const { result, points } = await executeAt("Above IME Window", {
    fixture: hierarchy,
    realSelector: true,
  });
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 200, y: 175 }]);
});

async function executeAt(
  label: string,
  {
    withIme = true,
    platform = "android",
    sameRoot = false,
    fixture,
    anonymous = false,
    screenSize,
    matchedBounds,
    elementId,
    action = "tap",
    throwOnKeyboardOcclusion = false,
    display,
    missing = false,
    selectionError,
    editable = true,
    realSelector = false,
    selectionStrategy,
    index,
  }: {
    withIme?: boolean;
    platform?: "android" | "ios";
    sameRoot?: boolean;
    fixture?: ViewHierarchyResult;
    anonymous?: boolean;
    screenSize?: ObserveResult["screenSize"];
    matchedBounds?: ElementBounds;
    elementId?: string;
    action?: "tap" | "focus";
    throwOnKeyboardOcclusion?: boolean;
    display?: string;
    missing?: boolean;
    selectionError?: ActionableError;
    editable?: boolean;
    realSelector?: boolean;
    selectionStrategy?: "unique";
    index?: number;
  } = {},
) {
  const hierarchy = fixture ?? imeOcclusionHierarchy(withIme);
  if (display !== undefined) {
    hierarchy.displayId = Number(display);
  }
  const keyboard = hierarchy.windows?.[0]?.hierarchy.node;
  if (keyboard && platform === "ios") {
    keyboard.$ = { class: "UIKeyboard" };
    const key = keyboard.node?.[0];
    if (key?.$) {
      key.$ = { ...key.$, class: "UIKeyboardKey", "resource-id": undefined };
    }
  }
  if (keyboard && sameRoot) {
    hierarchy.hierarchy.node?.node?.push(keyboard);
    hierarchy.windows = [];
  }
  const source = new DefaultElementParser()
    .flattenViewHierarchy(hierarchy, { includeWindows: true })
    .find(({ element }) => element.text === label)?.element;

  if (!source?.bounds) {
    throw new Error(`Missing fixture node ${label}`);
  }
  const element = source;
  if (action === "focus" && editable) {
    element.class = "android.widget.EditText";
  }
  if (anonymous) {
    delete element.text;
    delete element["content-desc"];
    delete element["resource-id"];
  }
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = Object.assign(new FakeAdbExecutor(), {
    spawn: async () => {
      throw new Error("Unexpected ADB spawn");
    },
  }) as AdbExecutor;
  const selector = new FakeElementSelector(missing ? null : element);
  if (selectionError) {
    selector.selectByText = () => {
      throw selectionError;
    };
  }
  const observeScreen = new FakeObserveScreen();
  const transitions = new FakeDisplayTransitionReader();
  if (matchedBounds) {
    selector.nextMatchedElement = { ...element, bounds: matchedBounds };
  }
  const tap = new TapOnElement({ name: "test-device", platform, deviceId: "emulator-5554" }, adb, {
    timer,
    hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, platform),
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    elementSelector: realSelector ? undefined : selector,
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    tapStrategy: new FakeTapStrategy(),
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  tap.observeScreen = observeScreen;
  const observation: ObserveResult = {
    observationId: "ime-test",
    updatedAt: 1,
    screenSize:
      screenSize ??
      (hierarchy.screenWidth && hierarchy.screenHeight
        ? { width: hierarchy.screenWidth, height: hierarchy.screenHeight }
        : { width: 400, height: 240 }),
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: hierarchy,
    display: { key: "0", role: "unknown", posture: "unknown", generation: transitions.generation },
    displayRevision: transitions.fullRevision,
  };
  observeScreen.setObserveResult(observation);
  const points: Array<{ x: number; y: number }> = [];
  let actionError: unknown;
  tap.observedInteraction = async (action) => {
    try {
      return { ...(await action(recordObservationRead(observation))), observation };
    } catch (error) {
      actionError = error;
      throw error;
    }
  };
  tap.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.executeiOSTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.prepareSelectionCapture = async () => null;
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap.execute(
    {
      ...(elementId ? { elementId } : { text: label }),
      action,
      display,
      selectionStrategy,
      index,
      searchUntil: { duration: 100 },
    },
    undefined,
    undefined,
    throwOnKeyboardOcclusion ? { throwOnKeyboardOcclusion: true } : undefined,
  );
  return { result, points, actionError };
}

describe("internal typed focus failures", () => {
  for (const display of [undefined, "0"]) {
    test(`${display ?? "default"}: target not-found is marked without changing JSON output`, async () => {
      const { result, points } = await executeAt("Above Keyboard", {
        action: "focus",
        withIme: false,
        missing: true,
        display,
      });
      const original = "Element not found with provided text 'Above Keyboard'";
      expect(result.error).toBe(
        display ? original : `Failed to perform tap on element: ${original}`,
      );
      expect(result[tapFocusFailure]).toBe("not-found");
      expect(Object.getOwnPropertyDescriptor(result, tapFocusFailure)?.enumerable).toBe(false);
      expect(JSON.stringify(result)).not.toContain("not-found");
      expect(points).toEqual([]);
    });

    test(`${display ?? "default"}: stale s2 not-found receives the same marker`, async () => {
      const { result, points } = await executeAt("Above Keyboard", {
        action: "focus",
        withIme: false,
        missing: true,
        elementId: "s2-stale",
        display,
      });
      expect(result[tapFocusFailure]).toBe("not-found");
      expect(result.error).toContain("Element not found with provided elementId 's2-stale'");
      expect(points).toEqual([]);
    });

    test(`${display ?? "default"}: off-screen-but-present target is marked`, async () => {
      const fixture = imeOcclusionHierarchy(false);
      fixture.hierarchy.node!.node![2].$.bounds = { left: 100, top: 300, right: 300, bottom: 350 };
      const { result, points } = await executeAt("Above Keyboard", {
        action: "focus",
        fixture,
        display,
      });
      expect(result[tapFocusFailure]).toBe("no-visible-tap-area");
      expect(result.error).toContain("no visible tap area");
      expect(points).toEqual([]);
    });
  }

  test("strict real-selector not-found retains its diagnostic and gets a typed marker", async () => {
    const { result, points } = await executeAt("Above Keyboard", {
      action: "focus",
      realSelector: true,
      elementId: "s2-stale",
      selectionStrategy: "unique",
      withIme: false,
    });
    expect(result.error).toBe("Failed to perform tap on element: Target not found");
    expect(result[tapFocusFailure]).toBe("not-found");
    expect(points).toEqual([]);
  });

  test("strict real-selector ambiguity gets no focus-failure marker", async () => {
    const fixture = imeOcclusionHierarchy(false);
    fixture.hierarchy.node!.node = [20, 80].map((top) => ({
      $: {
        text: "Phone",
        class: "android.widget.EditText",
        clickable: true,
        bounds: { left: 100, top, right: 300, bottom: top + 30 },
      },
    }));
    const { result, points } = await executeAt("Phone", {
      action: "focus",
      fixture,
      realSelector: true,
      selectionStrategy: "unique",
    });
    expect(result.error).toContain("Target ambiguous: 2 matches");
    expect(result[tapFocusFailure]).toBeUndefined();
    expect(points).toEqual([]);
  });

  test("display real-selector non-editable match gets no focus-failure marker", async () => {
    const { result, points } = await executeAt("Above Keyboard", {
      action: "focus",
      editable: false,
      realSelector: true,
      withIme: false,
      display: "0",
    });
    expect(result.error).toContain("not an editable input");
    expect(result[tapFocusFailure]).toBeUndefined();
    expect(points).toEqual([]);
  });

  test("navigation-bar focus failure is marked at the visibility source", async () => {
    const { result, points } = await executeAt("Forms & Input", {
      action: "focus",
      platform: "ios",
      fixture: syntheticNavigationHierarchy(),
      screenSize: navigationScreen,
    });
    expect(result[tapFocusFailure]).toBe("navigation-bar");
    expect(result.error).toBe(
      'Failed to perform tap on element: Target "Forms & Input" is covered by the navigation bar; scroll it into view with swipeOn, then retry tapOn.',
    );
    expect(points).toEqual([]);
  });

  test("ambiguous focus error is unmarked", async () => {
    const { result } = await executeAt("Above Keyboard", {
      action: "focus",
      selectionError: new ActionableError("Target ambiguous: 2 matches"),
    });
    expect(result[tapFocusFailure]).toBeUndefined();
    expect(result.error).toBe("Failed to perform tap on element: Target ambiguous: 2 matches");
  });

  test("non-editable and keyboard-occluded focus failures are unmarked", async () => {
    const notEditable = await executeAt("Above Keyboard", { action: "focus", editable: false });
    expect(notEditable.result[tapFocusFailure]).toBeUndefined();
    expect(notEditable.result.error).toContain("not an editable input");
    const keyboard = await executeAt("Continue as Guest", { action: "focus" });
    expect(keyboard.result[tapFocusFailure]).toBeUndefined();
    expect(keyboard.result.error).toContain("covered by the soft keyboard");
  });

  test("ordinary tap not-found carries no focus marker", async () => {
    const { result } = await executeAt("Above Keyboard", { missing: true, withIme: false });
    expect(result[tapFocusFailure]).toBeUndefined();
  });
});

describe("tapOn Android IME occlusion", () => {
  test("refuses text-selected app content behind an anonymous equal-bounds IME key", async () => {
    const { result, points } = await executeAt("Continue as Guest", {
      fixture: sharedBoundsImeHierarchy(),
    });
    expect(points).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the soft keyboard");
  });

  test("allows a genuinely selected equal-bounds IME key", async () => {
    const { result, points } = await executeAt("Q", { fixture: sharedBoundsImeHierarchy() });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 175 }]);
  });

  test("fully covered app element fails without dispatching a tap", async () => {
    const { result, points, actionError } = await executeAt("Continue as Guest");
    expect(actionError).toBeInstanceOf(KeyboardOcclusionError);
    expect(points).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the soft keyboard");
  });

  test("Android focus returns the pre-PR structured IME failure by default", async () => {
    const { result, points } = await executeAt("Continue as Guest", { action: "focus" });
    expect(result).toEqual({
      success: false,
      action: "tap",
      searchUntil: { durationMs: 0, requestCount: 0, changeCount: 0 },
      error:
        'Failed to perform tap on element: Target "Continue as Guest" is covered by the soft keyboard; dismiss the keyboard first.',
      element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
    });
    expect(points).toEqual([]);
  });

  test("Android focus opt-in throws the typed IME refusal without warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(
        executeAt("Continue as Guest", {
          action: "focus",
          throwOnKeyboardOcclusion: true,
        }),
      ).rejects.toBeInstanceOf(KeyboardOcclusionError);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("Android display focus opt-in preserves the typed IME refusal", async () => {
    await expect(
      executeAt("Continue as Guest", {
        action: "focus",
        display: "0",
        throwOnKeyboardOcclusion: true,
      }),
    ).rejects.toBeInstanceOf(KeyboardOcclusionError);
  });

  test("Android display focus without opt-in keeps its failure result", async () => {
    const { result, points } = await executeAt("Continue as Guest", {
      action: "focus",
      display: "0",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the soft keyboard");
    expect(points).toEqual([]);
  });

  test("uses the caller text selector when the matched element has no label", async () => {
    const { result, points } = await executeAt("Continue as Guest", { anonymous: true });
    expect(points).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('"Continue as Guest"');
  });

  test("also protects an app sibling when the IME subtree shares its root group", async () => {
    const { result, points } = await executeAt("Continue as Guest", { sameRoot: true });
    expect(points).toEqual([]);
    expect(result.error).toContain("covered by the soft keyboard");
  });

  test("partially covered element taps in its visible region", async () => {
    const { result, points } = await executeAt("Partly Covered");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 140 }]);
  });

  test("uncovered element taps normally", async () => {
    const { result, points } = await executeAt("Above Keyboard");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 35 }]);
  });

  test("without an IME the covered-position element taps normally", async () => {
    const { result, points } = await executeAt("Continue as Guest", { withIme: false });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 175 }]);
  });

  test("iOS also refuses app content covered by the keyboard", async () => {
    const { result, points } = await executeAt("Continue as Guest", { platform: "ios" });
    expect(result.success).toBe(false);
    expect(points).toEqual([]);
    expect(result.error).toContain("covered by the soft keyboard; dismiss the keyboard first.");
  });
});

async function executeCaptured(label: string, hierarchy = iosKeyboardTabbarHierarchy()) {
  return executeAt(label, {
    platform: "ios",
    fixture: hierarchy,
    screenSize: iosKeyboardCapture.screenSize,
  });
}

const center = (row: typeof iosKeyboardCapture.demos) => ({
  x: Math.floor((row.bounds[0] + row.bounds[2]) / 2),
  y: Math.floor((row.bounds[1] + row.bounds[3]) / 2),
});

describe("iOS captured keyboard bottom strip (#9020)", () => {
  test("Demos fails with an actionable keyboard error and no dispatched tap", async () => {
    const { result, points, actionError } = await executeCaptured("Demos");
    expect(actionError).toBeInstanceOf(ActionableError);
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Target "Demos" is covered by the soft keyboard; dismiss the keyboard first.',
    );
    expect(points).toEqual([]);
  });

  test("uses observation screen size when hierarchy dimensions are absent", async () => {
    const hierarchy = iosKeyboardTabbarHierarchy();
    delete hierarchy.screenWidth;
    delete hierarchy.screenHeight;
    const { result, points } = await executeCaptured("Demos", hierarchy);
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the soft keyboard");
    expect(points).toEqual([]);
  });

  test("display-name field and predictions above the keyboard keep their centres", async () => {
    for (const row of [iosKeyboardCapture.displayName, iosKeyboardCapture.predictions]) {
      const { result, points } = await executeCaptured(row.label!);
      expect(result.success).toBe(true);
      expect(points).toEqual([center(row)]);
    }
  });

  test("standalone UIKeyboardKey is still tappable", async () => {
    const { result, points } = await executeCaptured("Q");
    expect(result.success).toBe(true);
    expect(points).toEqual([center(iosKeyboardCapture.ime)]);
  });

  test("buttons under UIKeyboard are exempt by provenance", async () => {
    for (const row of [iosKeyboardCapture.emoji, iosKeyboardCapture.dictate]) {
      const { result, points } = await executeCaptured(
        row.label!,
        iosKeyboardTabbarHierarchy(true),
      );
      expect(result.success).toBe(true);
      expect(points).toEqual([center(row)]);
    }
  });

  test("untagged Emoji and Dictate cannot be safely exempted by label", async () => {
    for (const row of [iosKeyboardCapture.emoji, iosKeyboardCapture.dictate]) {
      const { result, points } = await executeCaptured(row.label!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("covered by the soft keyboard");
      expect(points).toEqual([]);
    }
  });

  test("partially covered iOS target taps the largest visible region", async () => {
    const hierarchy = iosKeyboardTabbarHierarchy();
    const bounds = capturedBounds(iosKeyboardCapture.demos);
    const keyboardTop = iosKeyboardCapture.ime.bounds[1];
    // Synthetic partial target: its centre is covered, but its top is exposed.
    bounds.top = keyboardTop - (bounds.bottom - keyboardTop) / 2;
    hierarchy.hierarchy.node!.node![0].$.bounds = bounds;
    const { result, points } = await executeCaptured("Demos", hierarchy);
    expect(result.success).toBe(true);
    expect(points).toEqual([
      { x: center(iosKeyboardCapture.demos).x, y: Math.floor((bounds.top + keyboardTop) / 2) },
    ]);
  });
});

// A promoted target's ordinary safe point can be outside its matched visible bounds.
// The fallback must subtract the keyboard again instead of tapping the clipped centre.
test("iOS visible-match fallback also avoids the docked keyboard", async () => {
  const hierarchy = iosKeyboardTabbarHierarchy();
  const original = capturedBounds(iosKeyboardCapture.demos);
  hierarchy.hierarchy.node!.node![0].$.bounds = { ...original, top: 0 };
  const keyboardTop = iosKeyboardCapture.ime.bounds[1];
  const visible = { ...original, top: keyboardTop - (original.bottom - keyboardTop) / 2 };
  const { result, points } = await executeAt("Demos", {
    platform: "ios",
    fixture: hierarchy,
    screenSize: iosKeyboardCapture.screenSize,
    matchedBounds: visible,
  });
  expect(result.success).toBe(true);
  expect(points).toEqual([
    { x: center(iosKeyboardCapture.demos).x, y: Math.floor((visible.top + keyboardTop) / 2) },
  ]);
});

test("iOS elementId selection behind the docked keyboard dispatches no tap", async () => {
  const { result, points, actionError } = await executeAt("Demos", {
    platform: "ios",
    fixture: iosKeyboardTabbarHierarchy(),
    screenSize: iosKeyboardCapture.screenSize,
    elementId: iosKeyboardCapture.demos.elementId,
  });
  expect(actionError).toBeInstanceOf(ActionableError);
  expect(result.success).toBe(false);
  expect(result.error).toContain("covered by the soft keyboard");
  expect(points).toEqual([]);
});

// No existing captured fixture contains a dialog over a list: build this tree inline.
function dialogOverRow(
  cover = { left: 40, top: 100, right: 360, bottom: 200 },
  type = 1,
): ViewHierarchyResult {
  const row = {
    text: "Row 5",
    "resource-id": "app:id/row5",
    clickable: true,
    bounds: { left: 0, top: 120, right: 400, bottom: 180 },
    occlusionState: "partial",
    occludedBy: "Dialog",
    occludedByViewId: "app:id/dialog",
  };
  const dialog = { text: "Dialog", "resource-id": "app:id/dialog", clickable: true, bounds: cover };
  return {
    hierarchy: { node: [row, dialog] },
    screenWidth: 400,
    screenHeight: 240,
    windows: [
      { type: 1, windowLayer: 0, hierarchy: row },
      { type, windowLayer: 1, hierarchy: dialog },
    ],
  };
}

describe("Android application window tap occlusion", () => {
  test("partly covered Row 5 taps an exposed point", async () => {
    const { result, points } = await executeAt("Row 5", {
      fixture: dialogOverRow(),
      realSelector: true,
    });
    expect(result.success).toBe(true);
    expect(points).toHaveLength(1);
    expect(points[0].x < 40 || points[0].x >= 360).toBe(true);
    expect(points[0].y).toBe(150);
  });
  test("fully covered row fails with a typed refusal naming the cover", async () => {
    const { result, points, actionError } = await executeAt("Row 5", {
      fixture: dialogOverRow({ left: 0, top: 100, right: 400, bottom: 200 }),
      realSelector: true,
    });
    expect(points).toEqual([]);
    expect(result.success).toBe(false);
    expect(actionError?.constructor.name).toBe("TapTargetUnavailableError");
    expect(result.error).toContain("Dialog");
  });
  test("no covering window preserves the centre", async () => {
    const { result, points } = await executeAt("Row 5", {
      fixture: dialogOverRow({ left: 0, top: 0, right: 400, bottom: 100 }),
      realSelector: true,
    });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 150 }]);
  });
  test("system covering window preserves the centre", async () => {
    const { result, points } = await executeAt("Row 5", {
      fixture: dialogOverRow(undefined, 3),
      realSelector: true,
    });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 150 }]);
  });
});
