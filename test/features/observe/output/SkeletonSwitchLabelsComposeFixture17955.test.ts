import type { SkeletonElement } from "../../../../src/models/ObserveResult";
import { expect, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import {
  projectSkeleton,
  projectSkeletonElement,
} from "../../../../src/features/observe/output/SkeletonProjection";
import {
  sanitizeObserveResult,
  diffObserveResult,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { stringifyToolResponse } from "../../../../src/utils/toolUtils";
import { skeletonElementSchema } from "../../../../src/server/toolOutputSchemas/elements";
import { composeControlShapesObservation } from "../../../helpers/composeControlShapesFixture17955";

function project(capture: "before" | "after" = "before") {
  const observation = composeControlShapesObservation(capture);
  observation.elements = new DefaultObserveElementCollector().collect(
    observation.viewHierarchy!,
    "android",
  );
  return {
    observation,
    projection: projectSkeleton(observation.elements!, observation.screenSize),
  };
}

const sliderRow: SkeletonElement = {
  bounds: [16, 1317, 1064, 1433],
  affordances: ["adjust"],
  elementId: "readout_less_slider",
  label: "Readout-less slider",
  range: { current: 0.5, min: 0, max: 1 },
};

test("captured flat and duplicate-id switches retain only their own labels and indexes", () => {
  const { projection } = project();
  const switches = projection.skeleton.filter((row) => row.affordances.includes("toggle"));
  const captured = composeControlShapesObservation("default").skeleton!.filter((row) =>
    row.affordances.includes("toggle"),
  );
  expect(switches).toEqual(captured);
  expect(switches.map((row) => row.label)).toEqual([
    "Flat Wi-Fi",
    "Flat Bluetooth",
    "Duplicate A",
    "Duplicate B",
    "Duplicate C",
  ]);
  expect(switches.slice(2).map((row) => row.index)).toEqual([0, 1, 2]);
});

test("both captured slider copies dedupe into one labelled adjustable range row", () => {
  const { observation, projection } = project();
  const copies = new SearchableHierarchy()
    .project(observation.viewHierarchy!)
    .filter((entry) => entry.nativeId === sliderRow.elementId);
  expect(copies).toHaveLength(2);
  expect(copies.map((entry) => entry.displayedLabel)).toEqual([sliderRow.label, sliderRow.label]);
  expect(projection.skeleton.filter((row) => row.elementId === sliderRow.elementId)).toEqual([
    sliderRow,
  ]);
  expect(skeletonElementSchema.safeParse(sliderRow).success).toBe(true);
  expect(projection.context?.some((row) => row.label === sliderRow.label)).toBe(true);
});

test("default compact and MCP text projections preserve range state", () => {
  const { observation } = project();
  const compact = sanitizeObserveResult(observation, {
    project: "skeleton",
    compact: true,
    dropElements: true,
  });
  expect(compact.skeleton).toContainEqual(sliderRow);
  const text = JSON.parse(stringifyToolResponse(compact));
  expect(text.skeleton).toContainEqual(sliderRow);
});

test("single-node diff projection and hierarchy diff preserve numeric range changes", () => {
  const { observation: before } = project();
  const { observation: after } = project("after");
  const slider = new SearchableHierarchy()
    .project(after.viewHierarchy!)
    .find((entry) => entry.nativeId === sliderRow.elementId)!;
  expect(projectSkeletonElement(slider.element!)?.range).toEqual({ current: 0.8, min: 0, max: 1 });
  const diff = diffObserveResult(before, after);
  expect(JSON.stringify(diff)).toContain("current:0.8,min:0.0,max:1.0");
});
