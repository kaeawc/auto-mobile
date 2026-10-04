import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
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
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ActionableError } from "../../../src/models/ActionableError";
import { KeyboardOcclusionError } from "../../../src/models/KeyboardOcclusionError";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import {
  capturedBounds,
  iosKeyboardCapture,
  iosKeyboardTabbarHierarchy,
} from "../../fixtures/observe/iosKeyboardTabbar";

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
  } = {},
) {
  const hierarchy = fixture ?? imeOcclusionHierarchy(withIme);
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
  if (action === "focus") {
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
  const selector = new FakeElementSelector(element);
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
    elementSelector: selector,
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
      return { ...(await action(observation)), observation };
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
    { ...(elementId ? { elementId } : { text: label }), action, display },
    undefined,
    undefined,
    throwOnKeyboardOcclusion ? { throwOnKeyboardOcclusion: true } : undefined,
  );
  return { result, points, actionError };
}

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
