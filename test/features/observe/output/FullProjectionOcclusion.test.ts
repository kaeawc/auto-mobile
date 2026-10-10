import { describe, expect, test } from "bun:test";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import {
  capturedFloatingCoverHierarchy,
  observationOf,
} from "../../../helpers/prototypeWindowCapture";

// project:"full" carries the skeleton's `occluded` signal for rows an AutoMobile prototype window
// fully covers (#10715), on the captured floating prototype over the Playground buttons
// (test/fixtures/android-overlay-window/). button_elevated lies fully under the prototype;
// button_regular only has its right edge under it; button_text is above it.

function fullObservation(): ObserveResult {
  return {
    ...observationOf(capturedFloatingCoverHierarchy()),
    screenSize: { width: 1080, height: 2400 },
  };
}

function clickableById(out: ObserveResult, id: string) {
  return out.elements!.clickable.find((element) => element["resource-id"] === id);
}

function findNodes(
  node: ViewHierarchyNode | ViewHierarchyNode[] | undefined,
  id: string,
): ViewHierarchyNode[] {
  const nodes = Array.isArray(node) ? node : node ? [node] : [];
  return nodes.flatMap((child) => [
    ...(child["resource-id" as keyof ViewHierarchyNode] === id ? [child] : []),
    ...findNodes(child.node, id),
  ]);
}

describe("full projection marks rows under an AutoMobile prototype (#10715)", () => {
  test("a fully covered row is occluded with its actions removed", () => {
    const out = sanitizeObserveResult(fullObservation(), { project: "full", compact: true });
    const covered = clickableById(out, "button_elevated");
    expect(covered).toMatchObject({ occluded: true });
    expect(covered).not.toHaveProperty("actions");
  });

  test("the hierarchy node of the covered row is marked too, in every window copy", () => {
    const out = sanitizeObserveResult(fullObservation(), { project: "full", compact: true });
    const nodes = [
      ...findNodes(out.viewHierarchy!.hierarchy?.node, "button_elevated"),
      ...(out.viewHierarchy!.windows ?? []).flatMap((window) =>
        findNodes(window.hierarchy, "button_elevated"),
      ),
    ];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node).toMatchObject({ occluded: true });
      expect(node).not.toHaveProperty("actions");
    }
  });

  test("partially covered and uncovered rows stay actionable and unmarked", () => {
    const out = sanitizeObserveResult(fullObservation(), { project: "full", compact: true });
    for (const id of ["button_regular", "button_text"]) {
      const row = clickableById(out, id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("occluded");
      expect(row!["actions"]).toContain("click");
    }
  });

  test("agrees with the skeleton: the same rows are occluded in both projections", () => {
    const observation = fullObservation();
    const full = sanitizeObserveResult(observation, { project: "full", compact: true });
    const skeleton = sanitizeObserveResult(observation, { project: "skeleton", compact: true });
    const skeletonRow = [...skeleton.skeleton!, ...(skeleton.context ?? [])].find(
      (row) => row.label === "Elevated Button",
    );
    expect(skeletonRow).toMatchObject({ occluded: true });
    expect(clickableById(full, "button_elevated")).toMatchObject({ occluded: true });
  });

  test("the source observation is not mutated", () => {
    const observation = fullObservation();
    sanitizeObserveResult(observation, { project: "full", compact: true });
    const source = observation.elements!.clickable.find(
      (element) => element["resource-id"] === "button_elevated",
    );
    expect(source).not.toHaveProperty("occluded");
    expect(source!["actions"]).toContain("click");
  });
});
