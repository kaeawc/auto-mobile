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

const duplicateNode = (depth: number): fc.Arbitrary<AndroidNode> => {
  const fields = {
    text: fc.constantFrom("a", "b", ""),
    "content-desc": fc.constant(""),
    "test-tag": fc.constant(""),
    class: fc.constant("View"),
  };
  if (depth === 0) {
    return fc.record(fields) as fc.Arbitrary<AndroidNode>;
  }
  return fc.record({
    ...fields,
    node: fc.option(fc.array(duplicateNode(depth - 1), { maxLength: 2 }), { nil: undefined }),
  }) as fc.Arbitrary<AndroidNode>;
};

const duplicateHeavy = duplicateNode(2);

const viewIdArb = fc.oneof(
  fc.constant("12345678-1234-1234-1234-123456789abc"),
  fc.constant("com.example:id/title"),
  fc.constant("compose:submit"),
  fc.constant("s2-0123456789abcdef"),
  fc.stringMatching(/^s2-[0-9a-f]{15}$/),
  fc.constant("s-a"),
);

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

function allNodes(root: AndroidNode): AndroidNode[] {
  const result: AndroidNode[] = [];
  visit(root, (current) => result.push(current));
  return result;
}

function idsByMarker(root: AndroidNode): Map<string, string> {
  return new Map(
    allNodes(root).map((current) => [current.marker as string, current["view-id"] as string]),
  );
}

function baseOf(id: string): string | undefined {
  return /^s2-([0-9a-f]{16})(?:~[0-9a-f]{8}|-\d+)?$/.exec(id)?.[1];
}

function markNodes(root: AndroidNode): void {
  allNodes(root).forEach((current, index) => {
    current.marker = `node-${index}`;
  });
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

  test("bare ids are emitted exactly for singleton structural bases", () => {
    fc.assert(
      fc.property(duplicateHeavy, (tree) => {
        markNodes(tree);
        stampUniqueGeneratedIds(tree);
        assignStableViewIds(tree);
        const nodes = allNodes(tree);
        const baseCounts = new Map<string, number>();
        for (const current of nodes) {
          const base = baseOf(current["view-id"] as string);
          expect(base).toBeDefined();
          baseCounts.set(base!, (baseCounts.get(base!) ?? 0) + 1);
        }
        for (const current of nodes) {
          const id = current["view-id"] as string;
          const base = baseOf(id)!;
          expect(/^s2-[0-9a-f]{16}$/.test(id)).toBe(baseCounts.get(base) === 1);
          if (baseCounts.get(base)! > 1) {
            expect(/(?:~[0-9a-f]{8}|-\d+)$/.test(id)).toBe(true);
          }
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("interaction flags and extras do not change ids", () => {
    fc.assert(
      fc.property(treeArbitrary, (tree) => {
        markNodes(tree);
        stampUniqueGeneratedIds(tree);
        const changed = structuredClone(tree);
        for (const current of allNodes(changed)) {
          current.focused = !current.focused;
          current.checked = !current.checked;
          current.selected = !current.selected;
          current.enabled = !current.enabled;
          current.extras = { arbitrary: "changed", marker: current.marker };
        }
        assignStableViewIds(tree);
        assignStableViewIds(changed);
        expect(idsByMarker(changed)).toEqual(idsByMarker(tree));
      }),
      RUN_OPTIONS,
    );
  });

  test("reordering structurally distinct siblings preserves each id", () => {
    fc.assert(
      fc.property(duplicateHeavy, (tree) => {
        markNodes(tree);
        stampUniqueGeneratedIds(tree);
        const baseline = structuredClone(tree);
        assignStableViewIds(baseline);
        const before = idsByMarker(baseline);
        const changed = structuredClone(tree);
        const siblings = childrenOf(changed);
        const bases = allNodes(baseline).map((current) => baseOf(current["view-id"] as string));
        const baseCounts = new Map<string | undefined, number>();
        for (const base of bases) {
          baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
        }
        const siblingBases = siblings.map((sibling) => {
          const marker = sibling.marker as string;
          return baseOf(before.get(marker) ?? "");
        });
        if (
          new Set(siblingBases).size !== siblingBases.length ||
          siblingBases.some((base) => baseCounts.get(base)! > 1)
        ) {
          return;
        }
        changed.node = [...siblings].reverse();
        assignStableViewIds(changed);
        const after = idsByMarker(changed);
        for (const sibling of siblings) {
          const marker = sibling.marker as string;
          expect(after.get(marker)).toBe(before.get(marker));
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("only UUID-shaped view-ids are rewritten", () => {
    fc.assert(
      fc.property(fc.array(viewIdArb, { minLength: 1, maxLength: 5 }), (viewIds) => {
        const tree: AndroidNode = { node: [] };
        const nodes = viewIds.map((id) => ({ "view-id": id, text: "same" }) as AndroidNode);
        tree.node = nodes;
        assignStableViewIds(tree);
        nodes.forEach((current, index) => {
          if (GENERATED_VIEW_ID_PATTERN.test(viewIds[index]!)) {
            expect(current["view-id"]).toMatch(/^s2-[0-9a-f]{16}/);
          } else {
            expect(current["view-id"]).toBe(viewIds[index]);
          }
        });
      }),
      RUN_OPTIONS,
    );
  });

  test("mutating one node's text changes no other node's structural base", () => {
    fc.assert(
      fc.property(duplicateHeavy, (tree) => {
        markNodes(tree);
        stampUniqueGeneratedIds(tree);
        const beforeTree = structuredClone(tree);
        const afterTree = structuredClone(tree);
        const beforeNodes = allNodes(beforeTree);
        if (beforeNodes.length < 2) {
          return;
        }
        const targetIndex = beforeNodes.length - 1;
        const targetMarker = beforeNodes[targetIndex]!.marker;
        const afterNodes = allNodes(afterTree);
        afterNodes[targetIndex]!.text = "mutated-new-text";
        assignStableViewIds(beforeTree);
        assignStableViewIds(afterTree);
        const before = idsByMarker(beforeTree);
        const after = idsByMarker(afterTree);
        for (const [marker, id] of before) {
          if (marker !== targetMarker) {
            expect(baseOf(after.get(marker)!)).toBe(baseOf(id));
          }
        }
      }),
      RUN_OPTIONS,
    );
  });
});
