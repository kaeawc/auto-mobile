import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { getSearchableEntries } from "../../../../src/features/observe/output/elementProvenance";
import {
  createIosVisibleTapContext,
  iosVisibleTapArea,
  resolveIosOwnedTapPoint,
} from "../../../../src/features/action/iosTapTargetOwnership";
import { visibleTapBounds } from "../../../../src/features/utility/ElementGeometry";
import { contains } from "../../../../src/features/observe/ApplicationWindowCover";
import {
  SearchableHierarchy,
  type SearchableEntry,
} from "../../../../src/features/utility/SearchableNode";
import type { ElementBounds, ObserveResult, SkeletonElement } from "../../../../src/models";

const capture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../fixtures/ios/nested-selection/scroll-cart-duplicate-container-id.json",
    ),
    "utf8",
  ),
) as ObserveResult;
function withDropFrame(bounds: ElementBounds): ObserveResult {
  const observation = structuredClone(capture);
  const nodes = new SearchableHierarchy().project(observation.viewHierarchy!);
  const drop = nodes.find((node) => node.nativeId === "drop_cart_A_item_42")!;
  // Only captured Drop A/42 and its CALayer move over item_40's Remove.
  for (const node of [
    drop,
    nodes.find((node) => node.parentIndex === drop.index && node.className === "CALayer")!,
  ]) {
    node.source.bounds = { ...bounds };
  }
  return observation;
}
const covered = withDropFrame({ left: 307, top: 267, right: 392, bottom: 301 });
const partial = withDropFrame({ left: 340, top: 267, right: 402, bottom: 301 });
const sibling = structuredClone(capture);
const siblingNodes = new SearchableHierarchy().project(sibling.viewHierarchy!);
const item41 = siblingNodes.find(
  (node) => node.nativeId === "item_41" && siblingNodes[node.parentIndex!]?.nativeId === "cart_A",
)!;
const siblingRemove = siblingNodes.find(
  (node) => node.nativeId === "remove" && node.parentIndex === item41.index,
)!;
// Only captured cart_A/item_41 Remove and its CALayer move over item_40's Remove.
for (const node of [
  siblingRemove,
  siblingNodes.find(
    (node) => node.parentIndex === siblingRemove.index && node.className === "CALayer",
  )!,
]) {
  node.source.bounds = { left: 304, top: 267, right: 389, bottom: 301 };
}
const collect = (observation: ObserveResult) =>
  new DefaultObserveElementCollector().collect(observation.viewHierarchy!, "ios")!;
const elements = collect(capture);
const coveredElements = collect(covered);
const partialElements = collect(partial);
const siblingElements = collect(sibling);
const tapContext = createIosVisibleTapContext(
  getSearchableEntries(elements)!,
  capture.screenSize!,
  capture.viewHierarchy,
);
const unmarked = projectSkeleton(elements, capture.screenSize);
const enabled = () => projectSkeleton(elements, capture.screenSize, undefined, { ios: true });
function rowAt(rows: readonly SkeletonElement[], top: number): SkeletonElement | undefined {
  return rows.find((row) => row.elementId === "remove" && row.bounds[1] === top);
}
function refuses(nodes: readonly SearchableEntry[], target: SearchableEntry): boolean {
  const screenBounds = target.bounds && visibleTapBounds(target.bounds, capture.screenSize);
  if (!screenBounds) {
    return true;
  }
  const bounds = iosVisibleTapArea({
    bounds: screenBounds,
    matched: target.element!,
    target: target.element!,
    nodes,
    context: tapContext,
  });
  if (!bounds) {
    return true;
  }
  const point = {
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
  return !!resolveIosOwnedTapPoint({
    nodes,
    target,
    matched: [target],
    screen: capture.screenSize,
    visibleBounds: bounds,
    candidates: [point],
    isValid: (candidate): candidate is { x: number; y: number } =>
      candidate !== null && contains(bounds, candidate.x, candidate.y),
  }).coveredBy;
}

beforeAll(() => {
  // Warm the shared projection/JIT; per-scenario projection remains in each test.
  enabled();
});

test("fully scroll-clipped Remove rows move to context while exposed rows stay actionable", () => {
  const projection = enabled();
  for (const top of [497, 535]) {
    const row = rowAt(projection.context, top);
    expect(row?.occluded).toBe(true);
    expect(row?.affordances).toEqual([]);
  }
  for (const top of [267, 458]) {
    const row = rowAt(projection.skeleton, top);
    expect(row?.affordances).toContain("tap");
    expect(row?.occluded).toBeUndefined();
  }
});

test("fully covered Remove is marked but a partially owned Remove remains actionable", () => {
  const full = projectSkeleton(coveredElements, capture.screenSize, undefined, { ios: true });
  expect(rowAt(full.context, 267)?.occluded).toBe(true);
  expect(rowAt(full.context, 267)?.affordances).toEqual([]);
  const exposed = projectSkeleton(partialElements, capture.screenSize, undefined, { ios: true });
  expect(rowAt(exposed.skeleton, 267)?.affordances).toContain("tap");
  expect(rowAt(exposed.skeleton, 267)?.occluded).toBeUndefined();
});

test("every captured Remove marker agrees with the shared tap admission verdict", () => {
  const nodes = getSearchableEntries(elements)!;
  const projection = enabled();
  const rows = [...projection.skeleton, ...projection.context].filter(
    (row) => row.elementId === "remove",
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const target = nodes.find(
      (node) => node.nativeId === "remove" && node.bounds?.top === row.bounds[1],
    )!;
    expect(target).toBeDefined();
    expect(row.occluded === true).toBe(refuses(nodes, target));
  }
});

test("PIN: default projection matches the disabled iOS option and keeps clipped Remove rows tappable", () => {
  expect(projectSkeleton(elements, capture.screenSize, undefined, { ios: false })).toEqual(
    unmarked,
  );
  expect([...unmarked.skeleton, ...unmarked.context].some((row) => row.occluded)).toBe(false);
  for (const top of [497, 535]) {
    expect(rowAt(unmarked.skeleton, top)?.affordances).toContain("tap");
  }
});

test("PIN: duplicate numbering of still-actionable Remove rows is unchanged", () => {
  for (const row of enabled().skeleton.filter((row) => row.elementId === "remove")) {
    expect(row.index).toBe(rowAt(unmarked.skeleton, row.bounds[1])?.index);
  }
});

test("later-drawn sibling marks the kept Remove at the shared frame", () => {
  const projection = projectSkeleton(siblingElements, capture.screenSize, undefined, { ios: true });
  const earlier = rowAt(projection.context, 267);
  expect(earlier?.occluded).toBe(true);
  expect(earlier?.affordances).toEqual([]);
  // Existing same-id/frame dedup keeps the first source. Its target is the earlier sibling.
  expect(rowAt(projection.skeleton, 267)).toBeUndefined();
});

test("unmapped rows preserve the default projection", () => {
  // Descriptor copies intentionally have no source/projection metadata, not a new hierarchy.
  const detached = structuredClone(elements);
  expect(projectSkeleton(detached, capture.screenSize, undefined, { ios: true })).toEqual(
    projectSkeleton(detached, capture.screenSize),
  );
});
