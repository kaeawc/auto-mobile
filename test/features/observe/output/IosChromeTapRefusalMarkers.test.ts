import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../../src/features/action/TapOnElement";
import { recordObservationRead } from "../../../../src/features/observe/observationReadScope";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { projectSanitizedObserveSkeleton } from "../../../../src/features/observe/output/ObserveResultOutput";
import { projectSkeletonReplayRows } from "../../../../src/features/observe/output/SkeletonProjection";
import { getSearchableEntries } from "../../../../src/features/observe/output/elementProvenance";
import {
  SearchableHierarchy,
  isImeKeyEntry,
} from "../../../../src/features/utility/SearchableNode";
import { visibleTapBounds } from "../../../../src/features/utility/ElementGeometry";
import { contains } from "../../../../src/features/observe/ApplicationWindowCover";
import {
  createIosVisibleTapContext,
  iosVisibleTapArea,
  resolveIosOwnedTapPoint,
} from "../../../../src/features/action/iosTapTargetOwnership";
import * as iosTapTargetOwnership from "../../../../src/features/action/iosTapTargetOwnership";
import type { ObserveResult, SkeletonElement, ViewHierarchyResult } from "../../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../../src/vision";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Captured iPad (iOS 27) Demos list scrolled so one row sits under the navigation bar.
// Used unmodified.
const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/ios/ipad-ios27-demos-row-under-navigation-bar.json"),
    "utf8",
  ),
) as ObserveResult;

const elements = new DefaultObserveElementCollector().collect(capture.viewHierarchy!, "ios")!;

const rawHierarchy = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/ios-duo/issue8379-demos-raw-hierarchy.json"),
    "utf8",
  ),
) as ViewHierarchyResult;
const rawCapture = { viewHierarchy: rawHierarchy };
const rawElements = new DefaultObserveElementCollector().collect(rawCapture.viewHierarchy, "ios")!;
const keyboardCapture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../fixtures/ios/nested-selection/cart-a-item-44-quantity-focused.json",
    ),
    "utf8",
  ),
) as ObserveResult;
const keyboardElements = new DefaultObserveElementCollector().collect(
  keyboardCapture.viewHierarchy!,
  "ios",
)!;
const keyboardSource = { ...keyboardCapture, elements: keyboardElements };

const nodes = getSearchableEntries(elements)!;
const context = createIosVisibleTapContext(nodes, capture.screenSize!, capture.viewHierarchy);
const source = { ...capture, elements };
const unmarked = projectSkeleton(elements, capture.screenSize);
const android = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../fixtures/android-settings/open-by-default-radio-rows.observe.json",
    ),
    "utf8",
  ),
) as ObserveResult;
const androidElements = new DefaultObserveElementCollector().collect(
  android.viewHierarchy!,
  "android",
)!;

// Same harness as test/features/action/TapOnElement.iosClippedTargetOwnership.test.ts.
async function tapOn(text: string) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "ipad", platform: "ios", deviceId: "ipad" },
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
    ...(await action(recordObservationRead(capture))),
    observation: capture,
  });
  tap.refreshViewHierarchy = async () => capture.viewHierarchy!;
  tap.executeiOSTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  // The immutable capture is projected once at module scope, like the collector.
  const project = SearchableHierarchy.prototype.project;
  const projection = spyOn(SearchableHierarchy.prototype, "project").mockImplementation(
    function (hierarchy) {
      return hierarchy === capture.viewHierarchy ? nodes : project.call(this, hierarchy);
    },
  );
  try {
    const result = await tap.execute({ action: "tap", text, searchUntil: { duration: 100 } });
    return { result, points };
  } finally {
    projection.mockRestore();
  }
}

function skeletonRow(top: number) {
  // The production call: ObserveResultOutput.projectSkeletonOnto for an iOS observation.
  const projection = projectSkeleton(elements, capture.screenSize, undefined, {
    ios: true,
    iosHierarchy: capture.viewHierarchy,
  });
  const find = (rows: typeof projection.skeleton) =>
    rows.find((row) => row.bounds[1] === top && row.bounds[0] === 20 && row.bounds[2] === 814);
  return { actionable: find(projection.skeleton), context: find(projection.context) };
}

const marked = () =>
  projectSkeleton(elements, capture.screenSize, undefined, {
    ios: true,
    iosHierarchy: capture.viewHierarchy,
  });
const production = () => projectSanitizedObserveSkeleton(source, source);
const rowKey = (row: SkeletonElement) => `${row.elementId}|${row.bounds.join(",")}|${row.label}`;

function expectCapturedMarkers(projection: {
  skeleton?: SkeletonElement[];
  context?: SkeletonElement[];
}) {
  const skeleton = projection.skeleton!;
  const contextRows = projection.context!;
  for (const bounds of [
    [20, 2, 814, 80],
    [20, -76, 814, 2],
    [45, 26, 74, 55],
    [46, -50, 74, -23],
  ]) {
    const sameBounds = (row: SkeletonElement) => row.bounds.every((edge, i) => edge === bounds[i]);
    expect(skeleton.filter(sameBounds)).toEqual([]);
    const kept = contextRows.filter(sameBounds);
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) {
      expect(row.occluded).toBe(true);
      expect(row.affordances).toEqual([]);
    }
  }
  const navigation = nodes.find((node) => node.className === "UINavigationBar")!;
  expect(navigation).toBeDefined();
  const firstBelow = skeleton.find(
    (row) =>
      row.bounds[0] === 20 && row.bounds[2] === 814 && row.bounds[1] >= navigation.bounds!.bottom,
  )!;
  expect(firstBelow.bounds).toEqual([20, 97, 814, 138]);
  expect(firstBelow.affordances).toContain("tap");
  expect(firstBelow.occluded).toBeUndefined();
  // Captured floating tab controls sit over the navigation bar and remain exempt.
  for (const label of ["Discover", "Demos", "Files", "Settings"]) {
    const control = skeleton.find((row) => row.label === label && row.bounds[1] === 36)!;
    expect(control.affordances).toContain("tap");
    expect(control.occluded).toBeUndefined();
  }
}

test("bar-covered rows and off-screen images are kept occluded, while neighbours and chrome controls stay actionable", () => {
  expectCapturedMarkers(marked());
});

test.each([
  { name: "missing", screen: undefined },
  { name: "zero-sized", screen: { width: 0, height: 0 } },
])("raw capture preserves scroll-clipped cpu.fill with a $name screen", ({ screen }) => {
  const output = projectSkeleton(rawElements, screen, undefined, {
    ios: true,
    iosHierarchy: rawCapture.viewHierarchy,
  });
  const cpu = (row: SkeletonElement) =>
    row.elementId === "cpu.fill" && row.bounds.join(",") === "46,676,74,704";
  expect(output.skeleton.find(cpu)).toBeUndefined();
  const row = output.context.find(cpu);
  expect(row?.label).toBe("Cpu Chip, Filled");
  expect(row?.occluded).toBe(true);
  expect(row?.affordances).toEqual([]);
});

test.each([
  { name: "missing", screen: undefined },
  { name: "zero-sized", screen: { width: 0, height: 0 } },
])("iPad scroll clipping and exposed neighbour survive a $name screen", ({ screen }) => {
  const output = projectSkeleton(elements, screen, undefined, {
    ios: true,
    iosHierarchy: capture.viewHierarchy,
  });
  const biometrics = (row: SkeletonElement) => row.bounds.join(",") === "20,-76,814,2";
  expect(output.skeleton.find(biometrics)).toBeUndefined();
  const clipped = output.context.find(
    (row) => biometrics(row) && row.label === "Biometrics, Test biometric override injection",
  );
  expect(clipped?.label).toBe("Biometrics, Test biometric override injection");
  expect(clipped?.occluded).toBe(true);
  expect(clipped?.affordances).toEqual([]);
  const neighbour = output.skeleton.find((row) => row.bounds.join(",") === "20,97,814,138");
  expect(neighbour?.affordances).toContain("tap");
  expect(neighbour?.occluded).toBeUndefined();
});

test("production keyboard cover excludes the off-screen remainder of AdditionalDimmingOverlay", () => {
  const output = projectSanitizedObserveSkeleton(keyboardSource, keyboardSource);
  const overlay = (row: SkeletonElement) =>
    row.elementId === "AdditionalDimmingOverlay" && row.bounds.join(",") === "-120,601,522,851";
  expect(output.skeleton?.find(overlay)).toBeUndefined();
  const covered = output.context?.find(overlay);
  expect(covered?.occluded).toBe(true);
  expect(covered?.affordances).toEqual([]);
  const neighbour = output.skeleton?.find(
    (row) => row.label === "item_47 qty" && row.bounds.join(",") === "12,535,296,569",
  );
  expect(neighbour?.affordances).toContain("tap");
  expect(neighbour?.occluded).toBeUndefined();
});

test("production skeleton threads the captured hierarchy and preserves the same markers and neighbours", () => {
  const factory = spyOn(iosTapTargetOwnership, "createIosVisibleTapContext");
  try {
    expectCapturedMarkers(production());
    expect(factory.mock.calls).toHaveLength(1);
    expect(factory.mock.calls[0][0]).toBe(nodes);
    expect(factory.mock.calls[0][1]).toBe(capture.screenSize);
    expect(factory.mock.calls[0][2]).toBe(capture.viewHierarchy);
  } finally {
    factory.mockRestore();
  }
});

test("collector projection preserves the tap projection order, ancestry and source identity", () => {
  const projected = new SearchableHierarchy().project(capture.viewHierarchy!);
  expect(projected.length).toBe(nodes.length);
  for (const [i, node] of nodes.entries()) {
    expect([node.index, node.parentIndex, node.rootGroup, node.windowRank]).toEqual([
      projected[i].index,
      projected[i].parentIndex,
      projected[i].rootGroup,
      projected[i].windowRank,
    ]);
    expect(node.source).toBe(projected[i].source);
  }
});

test("every captured tappable non-keyboard row agrees with shared visible-area and ownership admission", () => {
  const { rowsBySource } = projectSkeletonReplayRows(elements, unmarked);
  const byRow = new Map<SkeletonElement, (typeof nodes)[number]>();
  for (const [sourceNode, row] of rowsBySource) {
    const node = nodes.find((entry) => entry.source === sourceNode)!;
    if (!byRow.has(row)) {
      byRow.set(row, node);
    }
  }
  const output = production();
  const occluded = new Set(output.context?.filter((row) => row.occluded).map(rowKey));
  let checked = 0;
  for (const row of unmarked.skeleton.filter((row) => row.affordances.includes("tap"))) {
    const target = byRow.get(row)!;
    expect(target).toBeDefined();
    if (isImeKeyEntry(target)) {
      continue;
    }
    const screenBounds = visibleTapBounds(target.bounds!, capture.screenSize);
    const bounds =
      screenBounds &&
      iosVisibleTapArea({
        bounds: screenBounds,
        matched: target.element!,
        target: target.element!,
        nodes,
        context,
      });
    const point = bounds && {
      x: Math.floor((bounds.left + bounds.right) / 2),
      y: Math.floor((bounds.top + bounds.bottom) / 2),
    };
    const refused =
      !bounds ||
      !!resolveIosOwnedTapPoint({
        nodes,
        target,
        matched: [target],
        screen: capture.screenSize,
        visibleBounds: bounds,
        candidates: [point],
        isValid: (candidate): candidate is { x: number; y: number } =>
          candidate !== null && contains(bounds, candidate.x, candidate.y),
      }).coveredBy;
    expect(occluded.has(rowKey(row))).toBe(refused);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
});

test("Android skeleton and context ignore an iOS hierarchy when iOS is not enabled", () => {
  expect(
    projectSkeleton(androidElements, android.screenSize, android.viewHierarchy, {
      iosHierarchy: capture.viewHierarchy,
    }),
  ).toEqual(projectSkeleton(androidElements, android.screenSize, android.viewHierarchy));
});

test.each([
  {
    name: "row under the navigation bar",
    text: "Network Tracking, Test network request monitoring",
    top: 2,
    refusal: "covered by the navigation bar",
  },
  {
    name: "row with 2 pt left on screen",
    text: "Biometrics, Test biometric override injection",
    top: -76,
    refusal: "no visible tap area",
  },
])(
  "observe does not advertise tap on a $name that tapOn refuses",
  async ({ text, top, refusal }) => {
    const { result, points } = await tapOn(text);
    // tapOn's verdict on the captured screen (holds on main).
    expect(result.success).toBe(false);
    expect(result.error).toContain(refusal);
    expect(points).toEqual([]);

    // Observe must agree: no actionable row, and the context row carries the marker.
    const { actionable, context } = skeletonRow(top);
    expect(actionable?.affordances ?? []).toEqual([]);
    expect(context?.occluded).toBe(true);
  },
);
