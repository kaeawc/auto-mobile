import { describe, expect, test } from "bun:test";
import type { Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";

const hierarchy = { hierarchy: { node: [] } } as unknown as ViewHierarchyResult;
const observation = { viewHierarchy: hierarchy } as ObserveResult;

function toggle(checked: boolean | string): Element {
  return {
    text: "Wi-Fi",
    "resource-id": "android:id/switch_widget",
    checkable: "true",
    checked,
    clickable: "true",
    bounds: { left: 10, top: 10, right: 110, bottom: 60 },
  };
}

function createTap(
  initial: Element,
  afterTap = initial,
): { tap: TapOnElement; calls: () => number } {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const selector = new FakeElementSelector(initial);
  const tap = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer, elementSelector: selector },
  );
  (tap as any).adb.isScreenOn = async () => true;
  let tapCalls = 0;
  (tap as any).strategy = {
    isAccessibilityServiceEnabled: async () => false,
    shouldRunPreTapStability: () => false,
  };
  (tap as any).executeAndroidTap = async () => {
    tapCalls++;
    selector.setNextElement(afterTap);
  };
  (tap as any).prepareSelectionCapture = async () => null;
  (tap as any).captureTerminalObservationScreenshot = async () => {};
  (tap as any).recordDeferredPredictionOutcome = async () => {};
  (tap as any).selectionStateTracker.finalize = async () => [];
  (tap as any).deriveTapEffectAfterPostTapObservation = async (
    _previous: ObserveResult | null,
    current: ObserveResult,
  ) => ({
    effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    observation: current,
  });
  (tap as any).observedInteraction = async (block: (result: ObserveResult) => Promise<unknown>) => {
    const result = await block(observation);
    return { ...(result as object), observation };
  };
  return { tap, calls: () => tapCalls };
}

describe("tapOn ensureChecked", () => {
  test("skips an already-checked toggle without tapping", async () => {
    const { tap, calls } = createTap(toggle("true"));

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result).toMatchObject({ success: true, skipped: "already-checked" });
    expect(calls()).toBe(0);
  });

  test("taps an unchecked toggle and verifies the checked state", async () => {
    const { tap, calls } = createTap(toggle("false"), toggle("true"));

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls()).toBe(1);
  });

  test("returns a typed failure when the checked state does not change", async () => {
    const { tap, calls } = createTap(toggle("false"));

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("checked is now false");
    expect(calls()).toBe(1);
  });

  test("rejects a non-toggle and reports its affordances", async () => {
    const element = {
      ...toggle("false"),
      checkable: "false",
      text: "Airplane mode",
      clickable: "true",
    } as Element;
    const { tap, calls } = createTap(element);

    const result = await tap.execute({
      text: "Airplane mode",
      action: "tap",
      ensureChecked: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Airplane mode");
    expect(result.error).toContain("affordances: tap");
    expect(calls()).toBe(0);
  });
});
