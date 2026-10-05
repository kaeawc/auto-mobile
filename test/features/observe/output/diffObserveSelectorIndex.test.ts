import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../../src/features/utility/ResolverElementSelector";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { diffObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import * as skeletonProjection from "../../../../src/features/observe/output/SkeletonProjection";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { observeDiffSelectorSchema } from "../../../../src/server/toolOutputSchemas";
import { parseBounds } from "../../../../src/utils/bounds";
import { androidControlObservation } from "../../../helpers/androidDisabledControlCapture";

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

// Structural counting regression: use the existing captured-node builder, then
// mirror CtrlProxy's separately serialized merged root and window root.
function mirroredAndroidPair(labelOnly: boolean, count = 1) {
  const baseline = androidControlObservation();
  delete baseline.elements;
  const original = parser.extractRootNodes(baseline.viewHierarchy!)[0];
  const nodes: ViewHierarchyNode[] = [];
  for (let index = 0; index < count; index++) {
    const node = structuredClone(original);
    delete node.node;
    delete node["view-id"];
    node.text = "Mirrored control";
    node["resource-id"] = "mirrored-control";
    node.bounds = { left: 10, top: 100 + index * 100, right: 60, bottom: 150 + index * 100 };
    if (labelOnly) {
      delete node["resource-id"];
      delete node["view-id"];
    }
    nodes.push(node);
  }
  const root: ViewHierarchyNode = { node: nodes };
  baseline.viewHierarchy!.hierarchy = { node: root };
  const windowRoot = structuredClone(root);
  if (!labelOnly) {
    for (const node of windowRoot.node!) {
      node["view-id"] = node["resource-id"];
    }
  }
  baseline.viewHierarchy!.windows = [{ id: 1, type: 1, hierarchy: windowRoot }];
  const next = structuredClone(baseline);
  for (const entry of new SearchableHierarchy().project(next.viewHierarchy!)) {
    if (entry.properties.text === "Mirrored control") {
      entry.source.selected = true;
    }
  }
  return { baseline, next };
}

describe("merged Android roots and window copies (#9804)", () => {
  for (const labelOnly of [false, true]) {
    const kind = labelOnly ? "label-only" : "elementId";
    test(`a unique ${kind} match carries neither replay field and skips skeleton projection`, () => {
      const { baseline, next } = mirroredAndroidPair(labelOnly);
      const matches = new SearchableHierarchy()
        .project(next.viewHierarchy!)
        .filter((entry) => entry.properties.text === "Mirrored control");
      expect(matches).toHaveLength(2);
      expect(matches[0].source).not.toBe(matches[1].source);
      const spy = spyOn(skeletonProjection, "projectSkeleton");
      try {
        const diff = diffObserveResult(baseline, next);
        expect(diff.changed).toHaveLength(1);
        for (const { selector } of diff.changed) {
          expect(selector).toBeDefined();
          expect(selector).not.toHaveProperty("index");
          expect(selector).not.toHaveProperty("ambiguous");
        }
        expect(spy).toHaveBeenCalledTimes(0);
      } finally {
        spy.mockRestore();
      }
    });

    test(`six distinct ${kind} matches retain skeleton indexes across window copies`, () => {
      const { baseline, next } = mirroredAndroidPair(labelOnly, 6);
      const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "android");
      const rows = projectSkeleton(elements!, next.screenSize).skeleton;
      expect(rows).toHaveLength(6);
      const diff = diffObserveResult(baseline, next);
      expect(diff.changed).toHaveLength(6);
      for (const [position, { selector }] of diff.changed.entries()) {
        expect(selector!.index).toBe(rows[position % 6].index);
        expect(selector!.index).toBe(position % 6);
        expect(selector).not.toHaveProperty("ambiguous");
      }
    });

    test(`identical ${kind} siblings remain genuinely ambiguous across window copies`, () => {
      const { baseline, next } = mirroredAndroidPair(labelOnly, 2);
      for (const observation of [baseline, next]) {
        const nodes = parser.extractRootNodes(observation.viewHierarchy!)[0].node!;
        nodes[1].bounds = structuredClone(nodes[0].bounds);
        const windowNodes = observation.viewHierarchy!.windows![0].hierarchy!.node!;
        windowNodes[1].bounds = structuredClone(windowNodes[0].bounds);
      }
      const selectors = diffObserveResult(baseline, next).changed.map(({ selector }) => selector);
      expect(selectors).toHaveLength(2);
      for (const selector of selectors) {
        expect(selector).not.toHaveProperty("index");
        expect(selector).toHaveProperty("ambiguous", true);
      }
    });
  }

  test("a shared source does not absorb a distinct identical node in another window", () => {
    const { baseline, next } = mirroredAndroidPair(false);
    for (const observation of [baseline, next]) {
      const hierarchy = observation.viewHierarchy!;
      const root = parser.extractRootNodes(hierarchy)[0];
      hierarchy.windows = [
        { id: 1, type: 1, hierarchy: root },
        { id: 2, type: 1, hierarchy: structuredClone(root) },
      ];
    }
    const selector = diffObserveResult(baseline, next).changed[0].selector;
    expect(selector).not.toHaveProperty("index");
    expect(selector).toHaveProperty("ambiguous", true);
  });

  test("mirrored inert descendants preserve tap-ancestor ambiguity", () => {
    const { baseline, next } = mirroredAndroidPair(false, 2);
    for (const observation of [baseline, next]) {
      const hierarchy = observation.viewHierarchy!;
      for (const root of [
        parser.extractRootNodes(hierarchy)[0],
        hierarchy.windows![0].hierarchy!,
      ]) {
        const [parent, child] = root.node!;
        parent.clickable = true;
        child.clickable = false;
        delete child.actions;
        root.node = [parent];
        parent.node = [child];
      }
    }
    const selectors = diffObserveResult(baseline, next).changed.map(({ selector }) => selector);
    expect(selectors).toHaveLength(2);
    for (const selector of selectors) {
      expect(selector).not.toHaveProperty("index");
      expect(selector).toHaveProperty("ambiguous", true);
    }
  });
});

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

describe("review regressions", () => {
  test("empty and stable polling diffs never project selector candidates", () => {
    const spy = spyOn(SearchableHierarchy.prototype, "project");
    try {
      for (let poll = 0; poll < 3; poll++) {
        const diff = diffObserveResult(capture, structuredClone(capture));
        expect(diff.changed).toEqual([]);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
      }
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("several changed duplicates project the skeleton exactly once", () => {
    const next = structuredClone(capture);
    duplicates(next).forEach((node) => {
      node.selected = true;
    });
    const spy = spyOn(skeletonProjection, "projectSkeleton");
    try {
      expect(
        diffObserveResult(capture, next).changed.filter(({ changes }) => changes.selected),
      ).toHaveLength(2);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("tap-promoted inert duplicates explicitly declare ambiguity", () => {
    const baseline = structuredClone(capture);
    duplicates(baseline)[1].clickable = false;
    const selector = changedPair(baseline).selector;
    expect(selector.index).toBeUndefined();
    expect(selector).toHaveProperty("ambiguous", true);
    expect(changedPair(baseline, 1).selector).toHaveProperty("ambiguous", true);
    expect(observeDiffSelectorSchema.parse(selector)).toHaveProperty("ambiguous", true);
  });

  test("toggle-only ancestors make inert matching children promotable", () => {
    const baseline = structuredClone(capture);
    const [parent, child] = duplicates(baseline);
    const sibling = structuredClone(child);
    const b = parseBounds(sibling.bounds)!;
    sibling.bounds = [b.left + 50, b.top, b.right + 50, b.bottom];
    const children = parent.node;
    parent.node = [...(Array.isArray(children) ? children : children ? [children] : []), sibling];
    // Strip other ancestors' tap evidence, retaining the captured toggle parent.
    const entries = new SearchableHierarchy().project(baseline.viewHierarchy!);
    let ancestor = entries.find((entry) => entry.source === parent)!.parentIndex;
    while (ancestor !== undefined) {
      entries[ancestor].source.clickable = false;
      entries[ancestor].source.checkable = false;
      delete entries[ancestor].source.actions;
      ancestor = entries[ancestor].parentIndex;
    }
    parent.clickable = false;
    parent.checkable = true;
    child.clickable = false;
    const selector = changedPair(baseline).selector;
    expect(selector.index).toBeUndefined();
    expect(selector).toHaveProperty("ambiguous", true);
    expect(changedPair(baseline, 1).selector).toHaveProperty("ambiguous", true);
  });

  test("unique changed selectors do not request a skeleton projection", () => {
    const baseline = structuredClone(capture);
    duplicates(baseline)[1]["resource-id"] = "unique-image";
    const spy = spyOn(skeletonProjection, "projectSkeleton");
    try {
      expect(changedPair(baseline).selector.index).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("unique selectors and emitted indexes carry no ambiguity marker", () => {
    expect(changedPair(capture).selector.index).toBe(1);
    expect(changedPair(capture).selector).not.toHaveProperty("ambiguous");
    const baseline = structuredClone(capture);
    duplicates(baseline)[1]["resource-id"] = "unique-image";
    const selector = changedPair(baseline).selector;
    expect(selector.index).toBeUndefined();
    expect(selector).not.toHaveProperty("ambiguous");
  });

  test("a promoted child with an id does not poison another id-less label group", () => {
    const baseline = structuredClone(capture);
    const [parent, child] = duplicates(baseline);
    const sibling = structuredClone(child);
    const b = parseBounds(sibling.bounds)!;
    sibling.bounds = [b.left + 50, b.top, b.right + 50, b.bottom];
    delete parent["resource-id"];
    delete parent["view-id"];
    delete sibling["resource-id"];
    delete sibling["view-id"];
    parent.text = "Shared label";
    sibling.text = "Shared label";
    child.text = "Shared label";
    child.clickable = false;
    const children = parent.node;
    parent.node = [...(Array.isArray(children) ? children : children ? [children] : []), sibling];
    const next = structuredClone(baseline);
    for (const root of parser.extractRootNodes(next.viewHierarchy!)) {
      parser.traverseNode(root, (node) => {
        if (node.text === "Shared label" && node.className === "UIButton") {
          node.selected = true;
        }
      });
    }
    const selector = diffObserveResult(baseline, next).changed.find(
      ({ changes }) => changes.selected,
    )!.selector!;
    expect(selector.index).toBe(1);
    expect(selector).not.toHaveProperty("ambiguous");
  });

  test("identical captured rows merge before duplicate indexes are assigned", () => {
    const baseline = structuredClone(capture);
    const [parent, child] = duplicates(baseline);
    child.bounds = structuredClone(parent.bounds);
    parent.text = "Merged match";
    child.text = "Merged match";
    const { next, selector } = changedPair(baseline);
    const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "ios");
    const rows = projectSkeleton(elements!, next.screenSize).skeleton.filter(
      (row) => row.elementId === resourceId,
    );
    expect(rows).toHaveLength(1);
    expect(selector.index).toBe(rows[0].index);
    expect(selector.index).toBeUndefined();
    expect(selector).toHaveProperty("ambiguous", true);
  });

  test("captured keyboard occlusion uses the skeleton's final duplicate set", () => {
    const hierarchy = JSON.parse(
      readFileSync(
        `${import.meta.dir}/../../../fixtures/android-ime-window/playground-gboard-api36.json`,
        "utf8",
      ),
    );
    const baseline: ObserveResult = {
      viewHierarchy: hierarchy,
      screenSize: { width: 1080, height: 2400 },
    };
    const nodes: ViewHierarchyNode[] = [];
    for (const root of parser.extractRootNodes(hierarchy)) {
      parser.traverseNode(root, (node) => {
        if (node.clickable === "true") {
          nodes.push(node);
        }
      });
    }
    for (const node of nodes.slice(0, 3)) {
      node["resource-id"] = "com.automobile.playground:id/keyboard_duplicate";
    }
    nodes[2].bounds = [100, 1800, 110, 1810];
    const next = structuredClone(baseline);
    for (const root of parser.extractRootNodes(next.viewHierarchy!)) {
      let changed = false;
      parser.traverseNode(root, (node) => {
        if (!changed && node["resource-id"] === "com.automobile.playground:id/keyboard_duplicate") {
          node.selected = true;
          changed = true;
        }
      });
    }
    const selector = diffObserveResult(baseline, next).changed.find(
      ({ changes }) => changes.selected,
    )!.selector!;
    const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "android");
    const rows = projectSkeleton(elements!, next.screenSize).skeleton.filter(
      (row) => row.elementId === "com.automobile.playground:id/keyboard_duplicate",
    );
    expect(rows).toHaveLength(2);
    expect(selector.index).toBe(rows[0].index);
  });

  test("captured keyboard collapse keeps an app/keycap label unique", () => {
    const hierarchy = JSON.parse(
      readFileSync(
        `${import.meta.dir}/../../../fixtures/android-ime-window/playground-gboard-api36.json`,
        "utf8",
      ),
    );
    const baseline: ObserveResult = {
      viewHierarchy: hierarchy,
      screenSize: { width: 1080, height: 2400 },
    };
    const nodes: ViewHierarchyNode[] = [];
    for (const root of parser.extractRootNodes(hierarchy)) {
      parser.traverseNode(root, (node) => {
        if (node.clickable === "true") {
          nodes.push(node);
        }
      });
    }
    const app = nodes[0];
    delete app["resource-id"];
    delete app["view-id"];
    app.text = "q";
    const next = structuredClone(baseline);
    const nextNodes: ViewHierarchyNode[] = [];
    for (const root of parser.extractRootNodes(next.viewHierarchy!)) {
      parser.traverseNode(root, (node) => {
        if (node.text === "q") {
          nextNodes.push(node);
        }
      });
    }
    nextNodes[0].selected = true;
    const selector = diffObserveResult(baseline, next).changed.find(
      ({ changes }) => changes.selected,
    )!.selector!;
    const elements = new DefaultObserveElementCollector().collect(next.viewHierarchy!, "android");
    const rows = projectSkeleton(elements!, next.screenSize).skeleton.filter(
      (row) => row.label === "q",
    );
    expect(rows).toHaveLength(1);
    expect(selector.index).toBe(rows[0].index);
    expect(selector.index).toBeUndefined();
    expect(selector).not.toHaveProperty("ambiguous");
  });
});
