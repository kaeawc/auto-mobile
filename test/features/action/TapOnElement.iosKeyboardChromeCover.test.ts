import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";

import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import {
  getImeOccluder,
  getImeOccluderForElement,
  getIosImeOccluder,
  tapPointOutsideIme,
} from "../../../src/features/observe/output/SkeletonProjection";

// Unmodified captured Forms keyboard and nested cart keyboard-shift screens.
const load = (path: string): ObserveResult =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures", path), "utf8")) as ObserveResult;
const forms = load("observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json");
const cart = load("ios/nested-selection/cart-a-item-42-focused-keyboard-shift.json");
const remove = (row: number): TapOnElementOptions => ({
  action: "tap",
  elementId: "remove",
  container: { elementId: `item_${row}`, container: { elementId: "cart_B" } },
  selectionStrategy: "unique",
  searchUntil: { duration: 100 },
});
const save: TapOnElementOptions = {
  action: "tap",
  text: "Save Changes",
  searchUntil: { duration: 100 },
};

function harness(observation: ObserveResult, platform: "ios" | "android" = "ios") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "iphone", platform, deviceId: "iphone" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: platform === "ios" ? FakeTapStrategy.ios() : new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => observation.viewHierarchy!;
  tap.testHooks.setIosCoordinateTap(async (_action, x, y) => {
    points.push({ x, y });
  });
  tap.executeAndroidTap = async (_action, { x, y }) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    effect: undefined,
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  return { tap, points };
}

async function tapOn(
  observation: ObserveResult,
  options: TapOnElementOptions,
  platform: "ios" | "android" = "ios",
) {
  const { tap, points } = harness(observation, platform);
  const projector = new SearchableHierarchy();
  const project = SearchableHierarchy.prototype.project;
  // Each invocation projects its immutable capture inside the test; repeated readers share its cache.
  const projection = spyOn(SearchableHierarchy.prototype, "project").mockImplementation(
    (hierarchy) => project.call(projector, hierarchy),
  );
  try {
    return { result: await tap.execute(options), points };
  } finally {
    projection.mockRestore();
  }
}

afterEach(() => AndroidCtrlProxyClient.resetInstances());
beforeAll(async () => {
  // Pay module/resolver warmup once; tests execute their complete scenarios themselves.
  await tapOn(forms, save);
  await tapOn(cart, remove(43));
});

test("captured Save Changes under the assistant bar refuses without dispatch", async () => {
  const { result, points } = await tapOn(forms, save);
  expect(result.success).toBe(false);
  expect(result.error).toContain("covered by the soft keyboard; dismiss the keyboard first.");
  expect(points).toEqual([]);
});

test("captured cart_B/item_44 Remove under keyboard chrome refuses without dispatch", async () => {
  const { result, points } = await tapOn(cart, remove(44));
  expect(result.success).toBe(false);
  expect(result.error).toContain("covered by the soft keyboard; dismiss the keyboard first.");
  expect(points).toEqual([]);
});

test("captured cart_B/item_43 Remove taps its strip above the assistant bar", async () => {
  const { result, points } = await tapOn(cart, remove(43));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 537 }]);
  expect(points[0].y).toBeLessThan(539);
});

test("PIN: captured control above the assistant bar retains its centre", async () => {
  const { result, points } = await tapOn(cart, remove(42));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 515 }]);
});

test("PIN: Android Save Changes retains its pre-change centre", async () => {
  const { result, points } = await tapOn(forms, save, "android");
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 201, y: 575 }]);
});

const collectedForms = new DefaultObserveElementCollector().collect(forms.viewHierarchy!, "ios")!;
const formsNodes = new SearchableHierarchy().project(forms.viewHierarchy!);

test("measured keys stay unchanged while app content is covered from the chrome top", () => {
  const measured = getImeOccluder(collectedForms)!;
  expect(measured.bounds).toEqual([4, 597, 399, 813]);
  const saveRow = collectedForms.clickable.find((element) => element.text === "Save Changes")!;
  const appCover = getIosImeOccluder(
    getImeOccluderForElement(collectedForms, saveRow)!,
    forms.screenSize,
  );
  expect(appCover.bounds).toEqual([0, 546, 402, 874]);
  expect(tapPointOutsideIme([16, 549, 386, 601], appCover.bounds)).toBeNull();
});

test("assistant-bar descendants retain the unextended key-union rectangle", () => {
  const prediction = formsNodes.find(
    (node) => node.className === "UIButton" && node.bounds?.left === 134 && node.bounds.top === 546,
  )!;
  const cover = getIosImeOccluder(
    getImeOccluderForElement(collectedForms, prediction.element!)!,
    forms.screenSize,
  );
  const assistant = formsNodes.find((node) => node.nativeId === "SystemInputAssistantView")!;
  const barCover = getIosImeOccluder(
    getImeOccluderForElement(collectedForms, assistant.element!)!,
    forms.screenSize,
  );
  expect(barCover.bounds).toEqual([0, 597, 402, 874]);
  expect(cover.bounds).toEqual([0, 597, 402, 874]);
  expect(tapPointOutsideIme([134, 546, 268, 590], cover.bounds)).toEqual({ x: 201, y: 568 });
});

const assistantVariants = (
  [
    ["90 percent width", [0, 546, 361.8, 590], 546],
    ["below 90 percent width", [0, 546, 361, 590], 590],
    ["one-point adjacency", [0, 545, 402, 589], 545],
    ["two-point gap", [0, 544, 402, 588], 590],
    ["zero height", [0, 590, 402, 590], 590],
  ] as const
).map(([name, frame, top]) => {
  const observation = structuredClone(forms);
  const nodes = new SearchableHierarchy().project(observation.viewHierarchy!);
  // Only the captured SystemInputAssistantView frame changes for width/abutment boundaries.
  const assistant = nodes.find((node) => node.nativeId === "SystemInputAssistantView");
  if (!assistant) {
    throw new Error("Expected input assistant");
  }
  const [left, frameTop, right, bottom] = frame;
  assistant.source.bounds = { left, top: frameTop, right, bottom };
  return {
    name,
    top,
    elements: new DefaultObserveElementCollector().collect(observation.viewHierarchy!, "ios")!,
  };
});

for (const { name, elements, top } of assistantVariants) {
  test(`assistant chrome qualification: ${name}`, () => {
    const measured = getImeOccluder(elements)!;
    expect(measured.bounds).toEqual([4, 597, 399, 813]);
    expect(getIosImeOccluder(measured, forms.screenSize).bounds).toEqual([0, top, 402, 874]);
  });
}
