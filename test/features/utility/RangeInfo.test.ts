import { expect, test } from "bun:test";
import { isRangeWidget, parseRangeInfo } from "../../../src/features/utility/RangeInfo";
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
  expect(isRangeWidget(slider)).toBe(true);
  expect(projectSkeletonElement(slider)).toEqual({
    bounds: [0, 0, 100, 20],
    affordances: ["adjust"],
  });
  expect(isRangeWidget({ class: "android.view.View" })).toBe(false);
});

test("range state survives overlapping element categories in canonical affordance order", () => {
  const slider = {
    "resource-id": "range",
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
