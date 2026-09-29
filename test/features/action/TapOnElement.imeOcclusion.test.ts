import { describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import type { ObserveResult } from "../../../src/models";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  imeOcclusionHierarchy,
  sharedBoundsImeHierarchy,
} from "../../fixtures/observe/imeOcclusion";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

async function executeAt(
  label: string,
  withIme = true,
  platform: "android" | "ios" = "android",
  sameRoot = false,
  fixture?: ViewHierarchyResult,
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
  const source =
    hierarchy.hierarchy.node?.node?.find((node) => node.$?.text === label) ??
    hierarchy.windows?.[0]?.hierarchy.node?.node?.find((node) => node.$?.text === label);
  if (!source?.$?.bounds) {
    throw new Error(`Missing fixture node ${label}`);
  }
  const element = new DefaultElementParser().parseNodeBounds(source);
  if (!element) {
    throw new Error(`Invalid fixture bounds for ${label}`);
  }
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = Object.assign(new FakeAdbExecutor(), {
    spawn: async () => {
      throw new Error("Unexpected ADB spawn");
    },
  }) as AdbExecutor;
  const tap = new TapOnElement({ name: "test-device", platform, deviceId: "emulator-5554" }, adb, {
    timer,
    elementSelector: new FakeElementSelector(element),
    tapStrategy: new FakeTapStrategy(),
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  const observation: ObserveResult = {
    observationId: "ime-test",
    updatedAt: 1,
    screenSize: { width: 400, height: 240 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: hierarchy,
  };
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = async (action) => ({
    ...(await action(observation)),
    observation,
  });
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
  const result = await tap.execute({ text: label, action: "tap" });
  return { result, points };
}

describe("tapOn Android IME occlusion", () => {
  test("refuses text-selected app content behind an anonymous equal-bounds IME key", async () => {
    const { result, points } = await executeAt(
      "Continue as Guest",
      true,
      "android",
      false,
      sharedBoundsImeHierarchy(),
    );
    expect(points).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the soft keyboard");
  });

  test("allows a genuinely selected equal-bounds IME key", async () => {
    const { result, points } = await executeAt(
      "Q",
      true,
      "android",
      false,
      sharedBoundsImeHierarchy(),
    );
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 175 }]);
  });

  test("fully covered app element fails without dispatching a tap", async () => {
    const { result, points } = await executeAt("Continue as Guest");
    expect(points).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by the soft keyboard");
  });

  test("also protects an app sibling when the IME subtree shares its root group", async () => {
    const { result, points } = await executeAt("Continue as Guest", true, "android", true);
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
    const { result, points } = await executeAt("Continue as Guest", false);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 175 }]);
  });

  test("iOS does not apply Android IME occlusion", async () => {
    const { result, points } = await executeAt("Continue as Guest", true, "ios");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 200, y: 175 }]);
  });
});
