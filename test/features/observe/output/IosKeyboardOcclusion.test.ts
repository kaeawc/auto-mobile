import { describe, expect, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import {
  projectSkeleton,
  tapPointOutsideIme,
} from "../../../../src/features/observe/output/SkeletonProjection";
import type { SkeletonElement } from "../../../../src/models/ObserveResult";
import {
  iosKeyboardMinimizedHierarchy,
  iosKeyboardVisibleHierarchy,
} from "../../../fixtures/observe/iosKeyboardStates";

/**
 * Soft-keyboard coverage of iOS skeleton rows, on the captured Playground
 * keyboard states (issues #10027 / #10028). `ios-keyboard-visible` is the Forms
 * screen on 402x874 with the UIKeyboard container at [0,590,402,816] and key
 * union [4,597,399,813] (docked occluder [0,597,402,874]);
 * `ios-keyboard-minimized` parks the keyboard at [0,918,402,1144].
 */
const SCREEN = { width: 402, height: 874 };
const DOCKED_KEYBOARD = [0, 597, 402, 874] as const;

function project(hierarchy: typeof iosKeyboardVisibleHierarchy, viewport = SCREEN) {
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios");
  expect(elements).toBeDefined();
  return projectSkeleton(elements!, viewport);
}

function centreInside(row: SkeletonElement, box: readonly number[]): boolean {
  const x = (row.bounds[0] + row.bounds[2]) / 2;
  const y = (row.bounds[1] + row.bounds[3]) / 2;
  return x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
}

function labelled(rows: readonly SkeletonElement[], label: string): SkeletonElement | undefined {
  return rows.find((row) => row.label === label);
}

describe("iOS skeleton rows covered by the visible soft keyboard (#10028)", () => {
  const projection = project(iosKeyboardVisibleHierarchy);
  const appRows = projection.skeleton.filter((row) => row.elementId !== "<ime>");

  test("keeps the single <ime> row and reports the keyboard", () => {
    expect(projection.skeleton.filter((row) => row.elementId === "<ime>")).toHaveLength(1);
    expect(projection.keyboard).toEqual({ visible: true, package: "com.apple.keyboard" });
  });

  test("no actionable app row has its centre behind the keyboard", () => {
    expect(appRows.filter((row) => centreInside(row, DOCKED_KEYBOARD))).toEqual([]);
  });

  test("the tab bar and its items move to context as occluded with no affordances", () => {
    for (const label of ["Tab Bar", "Discover", "Demos", "Files", "Settings"]) {
      const row = labelled(projection.context, label);
      expect(row?.occluded).toBe(true);
      expect(row?.affordances).toEqual([]);
    }
    // The tab bar band [0,791,402,874] is gone from the actionable rows.
    expect(appRows.filter((row) => row.bounds[1] >= 791)).toEqual([]);
  });

  test("every occluded row is fully covered by the keyboard rectangle", () => {
    const occluded = projection.context.filter((row) => row.occluded);
    expect(occluded.length).toBeGreaterThan(0);
    for (const row of occluded) {
      expect(tapPointOutsideIme(row.bounds, [...DOCKED_KEYBOARD])).toBeNull();
    }
    expect(projection.skeleton.some((row) => row.occluded)).toBe(false);
  });

  test("rows above the keyboard and a row only partly covered keep their tap", () => {
    // Save Changes [16,549,386,601] reaches 4pt into the keyboard but its centre is clear.
    for (const label of ["Save Changes", "Personal Information", "Theme, System"]) {
      const row = labelled(projection.skeleton, label);
      expect(row?.affordances).toContain("tap");
      expect(row?.occluded).toBeUndefined();
    }
  });

  test("without a viewport the visible keyboard marks nothing, as before", () => {
    const elements = new DefaultObserveElementCollector().collect(
      iosKeyboardVisibleHierarchy,
      "ios",
    );
    const unmarked = projectSkeleton(elements!);
    expect(unmarked.skeleton.some((row) => row.occluded)).toBe(false);
    expect(unmarked.context.some((row) => row.occluded)).toBe(false);
    expect(unmarked.keyboard).toEqual({ visible: true, package: "com.apple.keyboard" });
  });
});

describe("iOS skeleton with the keyboard parked off screen (#10027, #10028)", () => {
  const projection = project(iosKeyboardMinimizedHierarchy);

  test("reports no keyboard and no <ime> row", () => {
    expect(projection.keyboard).toBeUndefined();
    expect(projection.skeleton.some((row) => row.elementId === "<ime>")).toBe(false);
  });

  test("marks no row as covered, including the rows that sit at the bottom edge", () => {
    expect([...projection.skeleton, ...projection.context].some((row) => row.occluded)).toBe(false);
    for (const label of ["Manage Storage", "Clear Cache", "About", "Version"]) {
      expect(labelled(projection.skeleton, label)?.affordances).toContain("tap");
    }
  });

  test("an unusable viewport keeps the evidence-only reading instead of guessing parked", () => {
    const elements = new DefaultObserveElementCollector().collect(
      iosKeyboardMinimizedHierarchy,
      "ios",
    );
    const unknown = projectSkeleton(elements!, { width: 0, height: 0 });
    expect(unknown.keyboard).toEqual({ visible: true, package: "com.apple.keyboard" });
  });
});
