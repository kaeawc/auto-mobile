import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../src/models";
import { hierarchyChanged, hierarchyFingerprint } from "../../src/utils/hierarchyFingerprint";
import { computeHierarchyFingerprint } from "../../src/utils/scrollIdle";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
// Kept to 100 runs over shallow trees so each property stays well inside the 100ms budget.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 100 } as const;

const nodeArb: fc.Arbitrary<ViewHierarchyNode> = fc.letrec<{ node: ViewHierarchyNode }>((tie) => ({
  node: fc.record(
    {
      $: fc.record(
        {
          text: fc.string({ maxLength: 6 }),
          "resource-id": fc.constantFrom("", "id/a", "id/b"),
          clickable: fc.constantFrom("true", "false"),
        },
        { requiredKeys: ["text"] },
      ),
      node: fc.array(tie("node"), { maxLength: 3, depthIdentifier: "tree" }),
    },
    { requiredKeys: ["$"] },
  ),
})).node;

const treeArb = nodeArb.map((node) => ({ node }));

/** Capture metadata that differs between two captures of the same screen. */
const metadataArb = fc.record(
  {
    updatedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    receivedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    frameContext: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
    fresh: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: [] },
);

const withMetadata = (
  hierarchy: ViewHierarchyResult["hierarchy"],
  metadata: Partial<ViewHierarchyResult>,
): ViewHierarchyResult => ({ ...metadata, hierarchy: structuredClone(hierarchy) });

/** A genuinely different tree: the root gains a leaf whose text no generated node can have. */
const perturbTree = (
  hierarchy: ViewHierarchyResult["hierarchy"],
): ViewHierarchyResult["hierarchy"] => {
  const leaf: ViewHierarchyNode = { $: { text: "perturbed-leaf-sentinel" } };
  const root = structuredClone(hierarchy.node) ?? { $: {} };
  return { ...hierarchy, node: { ...root, node: [...(root.node ?? []), leaf] } };
};

describe("hierarchyFingerprint properties", () => {
  test("is invariant under capture metadata (updatedAt, receivedAt, frameContext, fresh)", () => {
    fc.assert(
      fc.property(treeArb, metadataArb, metadataArb, (tree, first, second) => {
        const a = withMetadata(tree, first);
        const b = withMetadata(tree, second);
        expect(hierarchyFingerprint(a)).toBe(hierarchyFingerprint(b));
        expect(hierarchyChanged(a, b)).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  test("discriminates a structurally different tree", () => {
    fc.assert(
      fc.property(treeArb, metadataArb, (tree, metadata) => {
        const before = withMetadata(tree, metadata);
        const after = withMetadata(perturbTree(tree), metadata);
        expect(hierarchyFingerprint(before)).not.toBe(hierarchyFingerprint(after));
        expect(hierarchyChanged(before, after)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  test("agrees with the scroll-idle fingerprint and the raw structural oracle", () => {
    fc.assert(
      fc.property(
        treeArb,
        treeArb,
        metadataArb,
        metadataArb,
        fc.boolean(),
        (treeA, treeB, metaA, metaB, sameTree) => {
          const a = withMetadata(treeA, metaA);
          const b = withMetadata(sameTree ? treeA : treeB, metaB);
          const sharedEqual = hierarchyFingerprint(a) === hierarchyFingerprint(b);
          const scrollEqual = computeHierarchyFingerprint(a) === computeHierarchyFingerprint(b);
          // The pre-#6477 scroll-idle definition: raw JSON equality of `.hierarchy`.
          const oracleEqual = JSON.stringify(a.hierarchy) === JSON.stringify(b.hierarchy);
          expect(sharedEqual).toBe(oracleEqual);
          expect(scrollEqual).toBe(oracleEqual);
          expect(hierarchyChanged(a, b)).toBe(!oracleEqual);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("reports unknown rather than unchanged when either side has no hierarchy", () => {
    const present: ViewHierarchyResult = { hierarchy: { node: { $: { text: "x" } } } };
    expect(hierarchyFingerprint(null)).toBeNull();
    expect(hierarchyFingerprint(undefined)).toBeNull();
    expect(hierarchyChanged(present, null)).toBeNull();
    expect(hierarchyChanged(undefined, present)).toBeNull();
    expect(computeHierarchyFingerprint(undefined)).toBe("");
  });

  test("returns null instead of throwing on an unserializable hierarchy", () => {
    const attributes: Record<string, unknown> = {};
    attributes.self = attributes;
    const cyclic: ViewHierarchyResult = { hierarchy: { node: { $: attributes } } };
    expect(hierarchyFingerprint(cyclic)).toBeNull();
  });
});
