import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ViewHierarchyResult } from "../../../src/models";
import { assignStableViewIds } from "../../../src/features/observe/android/StableNodeIdentity";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

const captured: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
  readFileSync(`${import.meta.dir}/../../fixtures/observe/diff/scroll-before.json`, "utf8"),
);
const hierarchy = new SearchableHierarchy();
const resolver = new ElementResolver(() => 0);
const intent = { action: "inspect" as const };

const staleIdError =
  "Target not found: stale element id from an earlier observation. s2- ids are valid only for the observation that returned them. Re-observe and use the new id.";

describe("ElementResolver stale synthetic ids", () => {
  test("a captured sibling leaving the observation changes the survivor's id and reports recovery", () => {
    const before = structuredClone(captured.viewHierarchy);
    const after = structuredClone(captured.viewHierarchy);
    const parent = new SearchableHierarchy()
      .project(after)
      .find((node) => node.nativeId === "fab_add")!;
    expect(parent.source.node).toHaveLength(3);
    // Derive the after observation from the real capture by removing one Add
    // sibling, simulating that sibling scrolling offscreen; no fixture is invented.
    parent.source.node!.splice(0, 1);

    assignStableViewIds(before.hierarchy);
    assignStableViewIds(after.hierarchy);
    const beforeSnapshot = { id: "before", nodes: hierarchy.project(before) };
    const afterSnapshot = { id: "after", nodes: hierarchy.project(after) };
    const survivorBounds = { left: 272, top: 855, right: 335, bottom: 918 };
    const survivorBefore = beforeSnapshot.nodes.find(
      (node) => node.label === "Add" && node.bounds?.left === survivorBounds.left,
    )!;
    const survivorAfter = afterSnapshot.nodes.find(
      (node) => node.label === "Add" && node.bounds?.left === survivorBounds.left,
    )!;
    expect(survivorBefore.nodeKey).toBe("s2-3340048129449c01-2");
    expect(survivorAfter.nodeKey).toBe("s2-3340048129449c01");
    expect(survivorAfter.bounds).toEqual(survivorBounds);
    const oldSelector = {
      elementId: survivorBefore.nodeKey!,
      selectionStrategy: "unique" as const,
    };
    expect(resolver.resolve(beforeSnapshot, oldSelector, intent).chosen).toBe(survivorBefore);

    const stale = resolver.resolve(afterSnapshot, oldSelector, intent);
    expect(stale.chosen).toBeNull();
    expect(stale.candidates).toHaveLength(0);
    expect(stale.failureReason).toBe("not-found");
    expect(stale.error).toBe(staleIdError);
    expect(
      resolver.resolve(
        afterSnapshot,
        { elementId: survivorAfter.nodeKey!, selectionStrategy: "unique" },
        intent,
      ).chosen,
    ).toBe(survivorAfter);
  });

  test("native ids, non-synthetic s2 prefixes, text, and index misses keep their messages", () => {
    const snapshot = { id: "empty", nodes: [] };
    for (const selector of [
      { elementId: "missing-native-id" },
      { elementId: "s2-short" },
      { text: "s2-3340048129449c01" },
    ]) {
      expect(
        resolver.resolve(snapshot, { ...selector, selectionStrategy: "unique" }, intent).error,
      ).toBe("Target not found");
    }
    expect(
      resolver.resolve(
        snapshot,
        { elementId: "s2-3340048129449c01-2", selectionStrategy: "unique", index: 1 },
        intent,
      ).error,
    ).toBe("Target not found: index 1 is out of range or ineligible");
  });
});
