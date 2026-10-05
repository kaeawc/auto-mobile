import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../../src/features/utility/ResolverElementSelector";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { diffObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { parseBounds } from "../../../../src/utils/bounds";

// Real iOS capture: the Discover button precedes its smaller Search image;
// both are clickable and have resource-id="magnifyingglass". No invented tree.
const capture = JSON.parse(
  readFileSync(
    `${import.meta.dir}/../../../fixtures/observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json`,
    "utf8",
  ),
) as ObserveResult;
const resourceId = "magnifyingglass";
const parser = new DefaultElementParser();

function duplicates(observation: ObserveResult): ViewHierarchyNode[] {
  const matches: ViewHierarchyNode[] = [];
  for (const root of parser.extractRootNodes(observation.viewHierarchy!)) {
    parser.traverseNode(root, (node) => {
      if (node["resource-id"] === resourceId) {
        matches.push(node);
      }
    });
  }
  expect(matches.length).toBeGreaterThan(0);
  return matches;
}

function changedPair(baseline: ObserveResult, occurrence = 0) {
  const next = structuredClone(baseline);
  const changed = duplicates(next)[occurrence];
  // Only a state attribute changes; identity, bounds and hierarchy stay captured.
  changed.selected = true;
  const diff = diffObserveResult(baseline, next);
  const entry = diff.changed.find(({ changes }) => changes.selected);
  expect(entry).toBeDefined();
  return { next, changed, selector: entry!.selector! };
}

function expectReplay(baseline: ObserveResult, expectedIndex: number | undefined) {
  const { next, changed, selector } = changedPair(baseline);
  const bounds = parseBounds(changed.bounds)!;
  const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "ios");
  const rows = projectSkeleton(elements!, next.screenSize).skeleton;
  const row = rows.find(
    (row) =>
      row.elementId === selector.elementId &&
      JSON.stringify(row.bounds) ===
        JSON.stringify([bounds.left, bounds.top, bounds.right, bounds.bottom]),
  );
  expect(row).toBeDefined();
  expect(selector.index).toBe(expectedIndex);
  expect(selector.index).toBe(row!.index);
  const resolved = new ResolverElementSelector().selectByResourceId(
    next.viewHierarchy!,
    selector.elementId!,
    { index: selector.index },
  );
  expect(resolved.element?.bounds).toEqual(bounds);
  if (selector.index !== undefined) {
    expect(resolved.indexInMatches).toBe(selector.index);
  }
}

describe("diff selector replay indexes (#9693)", () => {
  test("captured larger-first duplicates agree with skeleton and resolver", () => {
    const baseline = structuredClone(capture);
    expect(duplicates(baseline)).toHaveLength(2);
    expectReplay(baseline, 1);
  });

  test("equal-area duplicates retain hierarchy order", () => {
    const baseline = structuredClone(capture);
    const [large, small] = duplicates(baseline);
    const a = parseBounds(large.bounds)!;
    const b = parseBounds(small.bounds)!;
    // Keep the captured nodes; give the child its parent's area at its own origin.
    small.bounds = [b.left, b.top, b.left + a.right - a.left, b.top + a.bottom - a.top];
    expectReplay(baseline, 0);
  });

  test("a unique captured selector has no index", () => {
    const baseline = structuredClone(capture);
    duplicates(baseline)[1]["resource-id"] = "search-image-only";
    expectReplay(baseline, undefined);
  });

  test("duplicate id-less labels use the same area rank", () => {
    const baseline = structuredClone(capture);
    for (const node of duplicates(baseline)) {
      // Switch only the captured identity fields to exercise text selection.
      delete node["resource-id"];
      delete node["view-id"];
      node.text = "Discover duplicate replay";
    }
    const next = structuredClone(baseline);
    const changed = parser.extractRootNodes(next.viewHierarchy!).flatMap((root) => {
      const nodes: ViewHierarchyNode[] = [];
      parser.traverseNode(root, (node) => {
        if (node.text === "Discover duplicate replay" && node.className === "UIButton") {
          nodes.push(node);
        }
      });
      return nodes;
    })[0];
    changed.selected = true;
    const selector = diffObserveResult(baseline, next).changed.find(
      ({ changes }) => changes.selected,
    )!.selector!;
    const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "ios");
    const row = projectSkeleton(elements!, next.screenSize).skeleton.find(
      (row) => row.label === "Discover duplicate replay" && row.bounds[0] === 25,
    )!;
    expect(selector.index).toBe(1);
    expect(selector.index).toBe(row.index);
    expect(
      new ResolverElementSelector().selectByText(next.viewHierarchy!, selector.label!, {
        index: selector.index,
        partialMatch: false,
      }).element?.bounds,
    ).toEqual(parseBounds(changed.bounds));
  });

  test("a captured topmost window outranks a smaller main-tree duplicate", () => {
    const baseline = JSON.parse(
      readFileSync(
        `${import.meta.dir}/../../../fixtures/android-enabled/playground-disabled-control-api36.json`,
        "utf8",
      ),
    ) as ObserveResult;
    const hierarchy = baseline.viewHierarchy!;
    const main: ViewHierarchyNode[] = [];
    for (const root of parser.extractRootNodes(hierarchy)) {
      parser.traverseNode(root, (node) => {
        if (node.clickable === "true") {
          main.push(node);
        }
      });
    }
    const lower = main[0];
    lower["resource-id"] = resourceId;
    // No captured cross-window duplicate with distinct areas was found.
    // Clone this captured button into the captured status-bar window; its
    // larger area must lose to window rank, not win by hierarchy position.
    const upper = structuredClone(lower);
    const bounds = parseBounds(upper.bounds)!;
    upper.bounds = [bounds.left, bounds.top, bounds.right, bounds.bottom + 100];
    const windowRoot = parser.extractWindowRootGroups(hierarchy, "topmost-first")[0][0];
    const children = windowRoot.node;
    windowRoot.node = [...(Array.isArray(children) ? children : children ? [children] : []), upper];
    const { next, changed, selector } = changedPair(baseline);
    const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "android");
    const rows = projectSkeleton(elements!, next.screenSize).skeleton.filter(
      (row) => row.elementId === resourceId,
    );
    expect(rows).toHaveLength(2);
    expect(selector.index).toBe(1);
    expect(rows.find((row) => row.bounds[3] === bounds.bottom)!.index).toBe(selector.index);
    expect(
      new ResolverElementSelector().selectByResourceId(next.viewHierarchy!, resourceId, {
        index: selector.index,
      }).element?.bounds,
    ).toEqual(parseBounds(changed.bounds));
  });

  test("a promoted inert duplicate suppresses the group's replay index", () => {
    const baseline = structuredClone(capture);
    // #9693 / #7627: the matching child is promoted to its clickable parent
    // by resolution, but excluded from skeleton duplicate accounting.
    const [parent, inert] = duplicates(baseline);
    // Retain two selectable matches so omission tests the unsafe-group check,
    // rather than merely the unique-selector rule after dropping the child.
    const sibling = structuredClone(inert);
    const bounds = parseBounds(sibling.bounds)!;
    sibling.bounds = [bounds.left + 50, bounds.top, bounds.right + 50, bounds.bottom];
    const children = parent.node;
    parent.node = [...(Array.isArray(children) ? children : children ? [children] : []), sibling];
    inert.clickable = false;
    const { next, selector } = changedPair(baseline);
    const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "ios");
    expect(
      projectSkeleton(elements!, next.screenSize).skeleton.filter(
        (row) => row.elementId === resourceId,
      ),
    ).toHaveLength(2);
    const promoted = new ResolverElementSelector().selectByResourceId(
      next.viewHierarchy!,
      resourceId,
      { index: 2 },
    );
    expect(promoted.totalMatches).toBe(3);
    expect(promoted.element?.bounds).toEqual(parseBounds(parent.bounds));
    expect(selector.index).toBeUndefined();
    expect(changedPair(baseline, 1).selector.index).toBeUndefined();
  });

  test("an offscreen changed duplicate has no replay index", () => {
    const baseline = structuredClone(capture);
    const small = duplicates(baseline)[1];
    const bounds = parseBounds(small.bounds)!;
    // Shift the captured child below the viewport, preserving its size.
    small.bounds = [bounds.left, 1000, bounds.right, 1000 + bounds.bottom - bounds.top];
    expect(changedPair(baseline, 1).selector.index).toBeUndefined();
  });

  test("a changed node without affordances has no replay index", () => {
    const baseline = structuredClone(capture);
    duplicates(baseline)[0].clickable = false;
    expect(changedPair(baseline).selector.index).toBeUndefined();
    // The inert parent also cannot consume its actionable child's position.
    expect(changedPair(baseline, 1).selector.index).toBeUndefined();
  });

  test("a changed unbounded duplicate has no replay index", () => {
    const baseline = structuredClone(capture);
    delete duplicates(baseline)[0].bounds;
    expect(changedPair(baseline).selector.index).toBeUndefined();
  });
});
