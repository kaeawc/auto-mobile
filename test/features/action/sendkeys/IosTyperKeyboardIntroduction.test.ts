import { expect, test } from "bun:test";
import {
  IOS_KEYBOARD_INTRODUCTION_ERROR_CODE,
  IOS_KEYBOARD_INTRODUCTION_POLL_MS,
  IosTyper,
  type IosTyperDeps,
} from "../../../../src/features/action/sendkeys/IosTyper";
import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import { markPartialAfterMutation } from "../../../../src/features/action/sendkeys/ExecutorHelpers";
import { findIosKeyboardIntroduction } from "../../../../src/features/action/iosKeyboardIntroduction";
import {
  isViewHierarchyResult,
  type ViewHierarchyResult,
} from "../../../../src/models/ViewHierarchyResult";
import type { ObserveResult } from "../../../../src/models";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { buildObserveResult } from "../../../helpers/observeFixture";
import { typedObservation } from "../IosTypedTextTestHarness";
import capturedIntroduction from "../../../fixtures/ios-typed-text/continuous-path-introduction-iphone17-ios27-2.json";

// Captured on an iPhone 17 simulator (iOS 27.2) right after tapOn the Settings search field.
function introductionHierarchy(): ViewHierarchyResult {
  const hierarchy: unknown = structuredClone(capturedIntroduction);
  if (!isViewHierarchyResult(hierarchy)) {
    throw new Error("fixture is not a view hierarchy");
  }
  return hierarchy;
}

function introductionObservation(): ObserveResult {
  return buildObserveResult({
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    updatedAt: 1,
    viewHierarchy: introductionHierarchy(),
  });
}

function harness(options: { tapSent?: boolean; dismisses?: boolean } = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const taps: Array<{ x: number; y: number }> = [];
  const inserted: string[] = [];
  let value = "";
  const deps: IosTyperDeps = {
    session: new TypingSession(),
    timer,
    targetLayer: () => undefined,
    observer: {
      execute: async () =>
        taps.length > 0 && options.dismisses !== false
          ? typedObservation(value)
          : introductionObservation(),
    },
    clear: async () => ({ success: true }),
    insert: async (text) => {
      inserted.push(text);
      value += text;
      return { success: true };
    },
    withTextWarnings: (result) => result,
    markPartialAfterMutation,
    tapPoint: async (point) => {
      taps.push(point);
      return options.tapSent !== false;
    },
  };
  return { deps, timer, taps, inserted, typer: new IosTyper(deps) };
}

test("finds the captured introduction's Continue button centre", () => {
  expect(findIosKeyboardIntroduction(introductionHierarchy())).toEqual({ x: 201, y: 826 });
});

test("a hierarchy without the introduction has no dismiss point", () => {
  expect(findIosKeyboardIntroduction(typedObservation("").viewHierarchy!)).toBeUndefined();
});

test("sendKeys taps Continue once, then types into the focused field", async () => {
  const h = harness();
  const result = await h.typer.executeIosType("wallpaper", "insert");
  expect(result.success).toBe(true);
  expect(h.taps).toEqual([{ x: 201, y: 826 }]);
  expect(h.inserted).toEqual(["wallpaper"]);
  expect(h.timer.getSleepHistory()).toEqual([IOS_KEYBOARD_INTRODUCTION_POLL_MS]);
});

test.each([
  { name: "the tap was not sent", tapSent: false, dismisses: true, taps: 1 },
  { name: "the keyboard never appears", tapSent: true, dismisses: false, taps: 1 },
])("reports the introduction when $name", async ({ tapSent, dismisses, taps }) => {
  const h = harness({ tapSent, dismisses });
  const result = await h.typer.executeIosType("wallpaper", "insert");
  expect(result.success).toBe(false);
  expect(result.errorCode).toBe(IOS_KEYBOARD_INTRODUCTION_ERROR_CODE);
  expect(result.error).toContain('"slide to type" introduction');
  expect(result.error).not.toContain("no text field has focus");
  expect(h.taps).toHaveLength(taps);
  expect(h.inserted).toEqual([]);
  // Bounded wait: no polling when the tap was not sent, otherwise eight 250 ms polls (2 s).
  expect(h.timer.getSleepHistory()).toEqual(
    tapSent ? Array<number>(8).fill(IOS_KEYBOARD_INTRODUCTION_POLL_MS) : [],
  );
});

test("an explicit display is not tapped and gets the typed refusal", async () => {
  const h = harness();
  const result = await h.typer.executeIosType("wallpaper", "insert", undefined, "1");
  expect(result.errorCode).toBe(IOS_KEYBOARD_INTRODUCTION_ERROR_CODE);
  expect(h.taps).toEqual([]);
  expect(h.inserted).toEqual([]);
});
