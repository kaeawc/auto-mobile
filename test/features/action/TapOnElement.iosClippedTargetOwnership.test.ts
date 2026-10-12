import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import {
  SearchableHierarchy,
  type SearchableEntry,
} from "../../../src/features/utility/SearchableNode";
import type { ElementBounds, ObserveResult } from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured iPhone 17 nested-selection screen; off-scroll rows remain in accessibility (#11947).
const capture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../fixtures/ios/nested-selection/scroll-cart-duplicate-container-id.json",
    ),
    "utf8",
  ),
) as ObserveResult;

const remove = (row: number, cart = "cart_A"): TapOnElementOptions => ({
  action: "tap",
  elementId: "remove",
  container: { elementId: `item_${row}`, container: { elementId: cart } },
  strategy: "unique",
  // These captures never change: use the supported minimum instead of re-projecting four times.
  searchUntil: { duration: 100 },
});

function harness(observation: ObserveResult, platform: "ios" | "android" = "ios") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "iphone", platform, deviceId: "iphone" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: new FakeTapStrategy(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = async (action) => ({
    ...(await action(recordObservationRead(observation))),
    observation,
  });
  tap.refreshViewHierarchy = async () => observation.viewHierarchy!;
  tap.executeiOSTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
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

function moveFrame(node: SearchableEntry, bounds: ElementBounds): void {
  const { left, top, right, bottom } = bounds;
  node.source.bounds = [left, top, right, bottom];
}

function withDropFrame(bounds: ElementBounds): ObserveResult {
  const observation = structuredClone(capture);
  const nodes = new SearchableHierarchy().project(observation.viewHierarchy!);
  const drop = nodes.find((node) => node.nativeId === "drop_cart_A_item_42")!;
  const layer = nodes.find(
    (node) => node.parentIndex === drop.index && node.className === "CALayer",
  )!;
  // Only Drop A/42 and its CALayer change from [120,196,222,230] to the supplied frame.
  moveFrame(drop, bounds);
  moveFrame(layer, bounds);
  return observation;
}

// Prepare and project clones once, outside the per-test timing budget.
const covered = withDropFrame({ left: 307, top: 267, right: 392, bottom: 301 });
const partial = withDropFrame({ left: 340, top: 267, right: 402, bottom: 301 });
const reverseCovered = withDropFrame({ left: 12, top: 196, right: 112, bottom: 230 });
const sliver = structuredClone(capture);
const sliverNodes = new SearchableHierarchy().project(sliver.viewHierarchy!);
// Only cart_A UIScrollView changes from [12,267,390,477] to [12,267,390,461].
// The empty HostingScrollView twin is not an ancestor of the rows and stays unchanged.
moveFrame(
  sliverNodes.find((node) => node.nativeId === "cart_A" && node.className === "UIScrollView")!,
  {
    left: 12,
    top: 267,
    right: 390,
    bottom: 461,
  },
);
const siblingOverlap = structuredClone(capture);
const siblingNodes = new SearchableHierarchy().project(siblingOverlap.viewHierarchy!);
const item41 = siblingNodes.find(
  (node) => node.nativeId === "item_41" && siblingNodes[node.parentIndex!]?.nativeId === "cart_A",
)!;
const siblingRemove = siblingNodes.find(
  (node) => node.nativeId === "remove" && node.parentIndex === item41.index,
)!;
// Only cart_A/item_41 Remove and its CALayer change from [304,305,389,340] to [304,267,389,301].
moveFrame(siblingRemove, { left: 304, top: 267, right: 389, bottom: 301 });
moveFrame(
  siblingNodes.find(
    (node) => node.parentIndex === siblingRemove.index && node.className === "CALayer",
  )!,
  {
    left: 304,
    top: 267,
    right: 389,
    bottom: 301,
  },
);

const reverseOptions: TapOnElementOptions = { action: "tap", elementId: "reverse_cart_A" };

afterEach(() => AndroidCtrlProxyClient.resetInstances());
beforeAll(async () => {
  // Warm each distinct resolution path once; each test still runs its entire scenario afresh.
  await tapOn(capture, remove(40));
  await tapOn(capture, remove(47));
  await tapOn(capture, remove(45));
  await tapOn(sliver, remove(45));
  await tapOn(covered, remove(40));
  await tapOn(partial, remove(40));
  await tapOn(reverseCovered, reverseOptions);
  await tapOn(capture, remove(47), "android");
});

test("fully clipped cart_A/item_47 cannot tap cart_B's visible Remove", async () => {
  const { result, points } = await tapOn(capture, remove(47));
  expect(result.success).toBe(false);
  expect(result.error).toContain("no visible tap area");
  expect(points).toEqual([]);
});

test("fully clipped cart_A/item_46 is refused even without an actionable owner at its centre", async () => {
  const { result, points } = await tapOn(capture, remove(46));
  expect(result.success).toBe(false);
  expect(result.error).toContain("no visible tap area");
  expect(points).toEqual([]);
});

test("partially clipped item_45 taps only the centre of its visible region", async () => {
  const { result, points } = await tapOn(capture, remove(45));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 467 }]);
});

test("a scroll-clipped three-point sliver is refused", async () => {
  const { result, points } = await tapOn(sliver, remove(45));
  expect(result.success).toBe(false);
  expect(result.error).toContain("no visible tap area");
  expect(points).toEqual([]);
});

test("Drop A/42 owning the only reliable area is named without dispatching", async () => {
  const { result, points } = await tapOn(covered, remove(40));
  expect(result.success).toBe(false);
  expect(result.error).toContain('Target "Remove" is covered by "Drop A/42"');
  expect(result.error).toContain("UIButton at [307,267,392,301]");
  expect(result.error).toContain("swipeOn");
  expect(points).toEqual([]);
});

test("partial overlay moves the tap to the centre of the exclusively owned region", async () => {
  const { result, points } = await tapOn(partial, remove(40));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 322, y: 284 }]);
});

test("PIN: unobstructed cart_A/item_40 retains its captured centre", async () => {
  const { result, points } = await tapOn(capture, remove(40));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 284 }]);
});

test("PIN: unobstructed cart_B/item_41 retains its captured centre", async () => {
  const { result, points } = await tapOn(capture, remove(41, "cart_B"));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 568 }]);
});

test("PIN: overlapping siblings inside one scroll container do not imply overlay ownership", async () => {
  const { result, points } = await tapOn(siblingOverlap, remove(40));
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 284 }]);
});

test("PIN: a control without a scroll ancestor keeps its centre despite a sibling overlap", async () => {
  const { result, points } = await tapOn(reverseCovered, reverseOptions);
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 62, y: 213 }]);
});

test("PIN: Android retains the existing un-clipped captured-frame dispatch", async () => {
  const { result, points } = await tapOn(capture, remove(47), "android");
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 346, y: 552 }]);
});
