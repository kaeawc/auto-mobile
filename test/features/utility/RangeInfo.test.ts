import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { toSearchable } from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { composeControlShapesObservation } from "../../helpers/composeControlShapesFixture17955";
import { isAdjustableRangeWidget, parseRangeInfo } from "../../../src/features/utility/RangeInfo";
import {
  projectSkeleton,
  projectSkeletonElement,
} from "../../../src/features/observe/output/SkeletonProjection";

test.each([
  ["current:0.5,min:0.0,max:1.0", { current: 0.5, min: 0, max: 1 }],
  ["max:10, min:-10, current: -2.5", { current: -2.5, min: -10, max: 10 }],
  ["current:0,min:0,max:0", { current: 0, min: 0, max: 0 }],
] as const)("parses finite range tokens %s", (raw, expected) => {
  expect(parseRangeInfo(raw)).toEqual(expected);
});

test.each([
  undefined,
  null,
  5,
  "",
  "current:NaN,min:0,max:1",
  "current:Infinity,min:0,max:1",
  "current:1,min:0,max:1e999",
  "current:0.5,min:0",
  "current:,min:0,max:1",
  "current:0.5,min:0,max:1,extra:2",
  "current:0.5,min:0,max:1,current:0.7",
  "current:0.5:min:0,max:1",
  "current:-1,min:0,max:1",
  "current:2,min:0,max:1",
  "current:0,min:1,max:0",
])("rejects malformed range %s", (raw) => {
  expect(parseRangeInfo(raw)).toBeUndefined();
});

test("SeekBar class supplies adjust without fabricating numeric state", () => {
  const slider = {
    class: "android.widget.SeekBar",
    bounds: { left: 0, top: 0, right: 100, bottom: 20 },
  };
  expect(isAdjustableRangeWidget(slider)).toBe(true);
  expect(projectSkeletonElement(slider)).toEqual({
    bounds: [0, 0, 100, 20],
    affordances: ["adjust"],
  });
  expect(isAdjustableRangeWidget({ class: "android.view.View" })).toBe(false);
});

test("range state survives overlapping element categories in canonical affordance order", () => {
  const slider = {
    "resource-id": "range",
    class: "android.widget.SeekBar",
    "range-info": "current:0.5,min:0,max:1",
    text: "Volume",
    clickable: true,
    scrollable: true,
    checkable: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 20 },
  };
  expect(
    projectSkeleton({ clickable: [slider], scrollable: [slider], text: [slider], media: [] })
      .skeleton,
  ).toEqual([
    {
      elementId: "range",
      label: "Volume",
      bounds: [0, 0, 100, 20],
      affordances: ["tap", "scroll", "toggle", "adjust"],
      checked: false,
      range: { current: 0.5, min: 0, max: 1 },
    },
  ]);
});

// Collected once at load: the captured trees are large, and each test only reads the result.
const playgroundIndicators = new DefaultObserveElementCollector().collect(
  JSON.parse(
    readFileSync(
      new URL("../../fixtures/android-focus/playground-slider-value-49.json", import.meta.url),
      "utf8",
    ),
  ) as ViewHierarchyResult,
  "android",
);
const playgroundProjection = projectSkeleton(playgroundIndicators);
const composeObservation = composeControlShapesObservation();
const composeProjection = projectSkeleton(
  new DefaultObserveElementCollector().collect(composeObservation.viewHierarchy!, "android"),
);

test("a captured passive ProgressBar keeps its range without an adjust affordance", () => {
  const { skeleton, context = [] } = playgroundProjection;
  for (const id of ["linear_progress_indicator", "circular_progress_indicator"]) {
    expect(skeleton.find((row) => row.elementId === id)).toBeUndefined();
    const row = context.find((candidate) => candidate.elementId === id);
    expect(row?.range).toEqual({ current: 0.49, min: 0, max: 1 });
    expect(row?.affordances).toEqual([]);
  }
  const slider = skeleton.find((row) => row.elementId === "slider_control");
  expect(slider?.affordances).toContain("adjust");
});

test("a captured passive ProgressBar is neither adjustable nor clickable", () => {
  const indicator = playgroundIndicators.text.find(
    (element) => element["resource-id"] === "linear_progress_indicator",
  )!;
  expect(indicator["range-info"]).toBe("current:0.49,min:0.0,max:1.0");
  expect(isAdjustableRangeWidget(indicator)).toBe(false);
  const searchable = toSearchable(indicator);
  expect(searchable.affordances).not.toContain("adjust");
  expect(searchable.categories.clickable).toBe(false);
  expect(searchable.actionable).toBe(false);
});

test("the captured Compose Slider still gets adjust", () => {
  const slider = composeProjection.skeleton.find((row) => row.elementId === "readout_less_slider");
  expect(slider?.affordances).toEqual(["adjust"]);
  expect(slider?.range).toEqual({ current: 0.5, min: 0, max: 1 });
});
