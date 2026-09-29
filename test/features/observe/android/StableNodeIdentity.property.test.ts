import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assignStableViewIds,
  GENERATED_VIEW_ID_PATTERN,
} from "../../../../src/features/observe/android/StableNodeIdentity";

type AndroidNode = Record<string, unknown> & { node?: AndroidNode | AndroidNode[] };

const RUN_OPTIONS = { seed: 1_234_567, numRuns: 80 } as const;
const tinyContent = fc.constantFrom("a", "b", "", "x");
const optionalContent = fc.option(tinyContent, { nil: undefined });

function nodeArbitrary(depth: number): fc.Arbitrary<AndroidNode> {
  const fields = {
    "resource-id": optionalContent,
    "content-desc": optionalContent,
    text: optionalContent,
    "test-tag": optionalContent,
    class: fc.option(fc.constantFrom("View", "Text", "Row"), { nil: undefined }),
    bounds: fc.record({
      left: fc.integer({ min: 0, max: 100 }),
      top: fc.integer({ min: 0, max: 100 }),
      right: fc.integer({ min: 101, max: 200 }),
      bottom: fc.integer({ min: 101, max: 200 }),
    }),
  };

  if (depth === 0) {
    return fc.record(fields) as fc.Arbitrary<AndroidNode>;
  }
  return fc.record({
    ...fields,
    node: fc.option(fc.array(nodeArbitrary(depth - 1), { maxLength: 3 }), { nil: undefined }),
  }) as fc.Arbitrary<AndroidNode>;
}

const treeArbitrary = nodeArbitrary(3);

function childrenOf(node: AndroidNode): AndroidNode[] {
  if (!node.node) {
    return [];
  }
  return Array.isArray(node.node) ? node.node : [node.node];
}

function stampUniqueGeneratedIds(root: AndroidNode): void {
  let index = 0;
  const visit = (current: AndroidNode): void => {
    const hex = (index++).toString(16).padStart(8, "0");
    current["view-id"] = `${hex}-0000-4000-8000-000000000000`;
    for (const child of childrenOf(current)) {
      visit(child);
    }
  };
  visit(root);
}

function visit(root: AndroidNode, action: (node: AndroidNode) => void): void {
  action(root);
  for (const child of childrenOf(root)) {
    visit(child, action);
  }
}

function rewriteClone(tree: AndroidNode): AndroidNode {
  const clone = structuredClone(tree);
  assignStableViewIds(clone);
  return clone;
}

describe("assignStableViewIds properties", () => {
  test("rewritten view-ids are unique within each tree", () => {
    fc.assert(
      fc.property(treeArbitrary, (tree) => {
        stampUniqueGeneratedIds(tree);
        const before = new Map<AndroidNode, string>();
        visit(tree, (current) => before.set(current, current["view-id"] as string));
        assignStableViewIds(tree);
        const rewritten: string[] = [];
        visit(tree, (current) => {
          const original = before.get(current)!;
          if (GENERATED_VIEW_ID_PATTERN.test(original)) {
            rewritten.push(current["view-id"] as string);
          }
        });
        expect(new Set(rewritten).size).toBe(rewritten.length);
      }),
      RUN_OPTIONS,
    );
  });

  test("a second pass leaves every assigned view-id unchanged", () => {
    fc.assert(
      fc.property(treeArbitrary, (tree) => {
        stampUniqueGeneratedIds(tree);
        const first = rewriteClone(tree);
        const second = structuredClone(first);
        assignStableViewIds(second);
        const firstIds: string[] = [];
        const secondIds: string[] = [];
        visit(first, (current) => firstIds.push(current["view-id"] as string));
        visit(second, (current) => secondIds.push(current["view-id"] as string));
        expect(secondIds).toEqual(firstIds);
      }),
      RUN_OPTIONS,
    );
  });

  test("bounds changes leave assigned view-ids unchanged", () => {
    fc.assert(
      fc.property(treeArbitrary, (tree) => {
        stampUniqueGeneratedIds(tree);
        const original = structuredClone(tree);
        const shifted = structuredClone(tree);
        visit(shifted, (current) => {
          current.bounds = { left: -999, top: 777, right: 4444, bottom: -222 };
        });
        assignStableViewIds(original);
        assignStableViewIds(shifted);
        const originalIds: string[] = [];
        const shiftedIds: string[] = [];
        visit(original, (current) => originalIds.push(current["view-id"] as string));
        visit(shifted, (current) => shiftedIds.push(current["view-id"] as string));
        expect(shiftedIds).toEqual(originalIds);
      }),
      RUN_OPTIONS,
    );
  });
});
