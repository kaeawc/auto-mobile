import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  annotateHierarchyDiff,
  HIERARCHY_DIFF_STATE_KEY,
} from "../../src/daemon/streams/hierarchyStreamDiff";
import type {
  NodeAttributes,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../src/models/ViewHierarchyResult";

// Property-based companion to hierarchyStreamDiff.test.ts. The example suite pins
// a handful of tree shapes; these assert the counting/annotation invariants the
// diff promises over arbitrary generated tree pairs:
//   - the input frames are never mutated (the caller keeps `current` as the next
//     baseline);
//   - an identical frame is quiet (reflexivity) and no baseline annotates nothing;
//   - the summary counters agree exactly with the stamps left on the output tree
//     (every `added`/`changed` count is a real annotation and vice-versa);
//   - append/truncate is symmetric — the nodes counted `added` going base->extended
//     are exactly the nodes counted `removed` going extended->base;
//   - the signature folds capture-source spelling aliases and ignores attributes it
//     does not compare, so a re-spelled-but-equal frame stays quiet.
//
// A pinned seed keeps CI deterministic — see Backoff.property.test.ts for the
// rationale. On failure fast-check prints the seed and the shrunk counterexample.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 250 } as const;

// The wire attributes that the "changed" signature actually compares. Generated
// nodes draw their `$` keys from this set so a value change is a real, compared
// change (and so alias/junk properties can target the exact folded fields).
const SIGNATURE_KEYS = [
  "class",
  "text",
  "resource-id",
  "content-desc",
  "clickable",
  "enabled",
  "focused",
  "selected",
  "checked",
  "scrollable",
] as const;

// Values a captured attribute can take: strings, the boolean flags, small ints,
// and present-but-null (which the signature treats as absent). `\u0000` — the
// signature's field join separator — is deliberately reachable through the string
// generator; it can never cause a false pass here because every property compares
// either a tree against a structural clone of itself or the internal
// summary-vs-stamp bookkeeping, both invariant to any collision.
const attrValue = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.boolean(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constant(null),
);

const attrsArb: fc.Arbitrary<NodeAttributes> = fc.dictionary(
  fc.constantFrom(...SIGNATURE_KEYS),
  attrValue,
  { maxKeys: 6 },
);

const boundsArb = fc.record({
  left: fc.integer({ min: 0, max: 2000 }),
  top: fc.integer({ min: 0, max: 2000 }),
  right: fc.integer({ min: 0, max: 2000 }),
  bottom: fc.integer({ min: 0, max: 2000 }),
});

// A ViewHierarchyNode: always an object with `$`, an optional struct `bounds`, and
// (via letrec) a bounded array of child nodes. A childless node omits `node`
// entirely, matching how the example fixtures and the on-device converter shape a
// leaf. Depth/breadth are small so 250 runs stay well under the 100ms budget.
const nodeArb: fc.Arbitrary<ViewHierarchyNode> = fc.letrec<{ node: ViewHierarchyNode }>((rec) => ({
  node: fc
    .record({
      $: attrsArb,
      bounds: fc.option(boundsArb, { nil: undefined }),
      kids: fc.oneof(
        { maxDepth: 3, depthSize: "small" },
        fc.constant<ViewHierarchyNode[]>([]),
        fc.array(rec("node"), { maxLength: 3 }),
      ),
    })
    .map(({ $, bounds, kids }) => {
      const built: ViewHierarchyNode = { $ };
      if (bounds !== undefined) {
        built.bounds = bounds;
      }
      if (kids.length > 0) {
        built.node = kids;
      }
      return built;
    }),
})).node;

const hierarchyArb: fc.Arbitrary<ViewHierarchyResult> = nodeArb.map((node) => ({
  hierarchy: { node },
}));

function hierarchyOf(root: ViewHierarchyNode): ViewHierarchyResult {
  return { hierarchy: { node: root } };
}

// Mirror the module's array-or-bare-object-or-empty-`{}` child normalization so
// the test walkers agree with what `walk`/`markSubtreeAdded`/`countSubtree` see.
function childrenOf(node: ViewHierarchyNode): ViewHierarchyNode[] {
  const kids = node.node as unknown;
  if (!kids) {
    return [];
  }
  if (Array.isArray(kids)) {
    return kids;
  }
  return Object.keys(kids as object).length > 0 ? [kids as ViewHierarchyNode] : [];
}

function countNodes(node: ViewHierarchyNode): number {
  return childrenOf(node).reduce((sum, child) => sum + countNodes(child), 1);
}

// Every diffState marker stamped anywhere in the tree, in pre-order.
function collectStates(node: ViewHierarchyNode, acc: string[] = []): string[] {
  const state = node.$?.[HIERARCHY_DIFF_STATE_KEY];
  if (state !== undefined) {
    acc.push(String(state));
  }
  for (const child of childrenOf(node)) {
    collectStates(child, acc);
  }
  return acc;
}

describe("annotateHierarchyDiff (property-based)", () => {
  test("never mutates either input frame", () => {
    // The caller keeps `current` as the next baseline, so the diff must annotate a
    // clone only. Snapshot both inputs, run the diff, and assert both are byte-equal
    // afterward — in particular no diffState marker leaked onto an input node.
    fc.assert(
      fc.property(fc.option(hierarchyArb, { nil: null }), hierarchyArb, (previous, current) => {
        const previousBefore = structuredClone(previous);
        const currentBefore = structuredClone(current);
        annotateHierarchyDiff(previous, current);
        expect(previous).toEqual(previousBefore);
        expect(current).toEqual(currentBefore);
      }),
      RUN_OPTIONS,
    );
  });

  test("an identical frame is quiet and annotates nothing (reflexivity)", () => {
    fc.assert(
      fc.property(hierarchyArb, (current) => {
        const previous = structuredClone(current);
        const { hierarchy: out, summary } = annotateHierarchyDiff(previous, current);
        expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 0, removed: 0 });
        expect(collectStates(out.hierarchy.node!)).toEqual([]);
      }),
      RUN_OPTIONS,
    );
  });

  test("no baseline (null previous, or a previous with no root) annotates nothing", () => {
    const rootlessPrevious: ViewHierarchyResult = { hierarchy: {} };
    fc.assert(
      fc.property(
        fc.constantFrom<ViewHierarchyResult | null>(null, rootlessPrevious),
        hierarchyArb,
        (previous, current) => {
          const { hierarchy: out, summary } = annotateHierarchyDiff(previous, current);
          expect(summary).toEqual({ hasBaseline: false, added: 0, changed: 0, removed: 0 });
          expect(collectStates(out.hierarchy.node!)).toEqual([]);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("summary counters agree exactly with the stamps left on the output tree", () => {
    // Internal-consistency invariant over arbitrary pairs: every `added`/`changed`
    // the summary reports is a real annotation on the output, and there is no
    // annotation the summary failed to count. Removed nodes are absent from the
    // output by definition, so only added+changed are stampable.
    fc.assert(
      fc.property(hierarchyArb, hierarchyArb, (previous, current) => {
        const { hierarchy: out, summary } = annotateHierarchyDiff(previous, current);
        const states = collectStates(out.hierarchy.node!);
        const added = states.filter((s) => s === "added").length;
        const changed = states.filter((s) => s === "changed").length;
        // No marker other than the two documented states is ever stamped.
        expect(added + changed).toBe(states.length);
        expect(added).toBe(summary.added);
        expect(changed).toBe(summary.changed);
      }),
      RUN_OPTIONS,
    );
  });

  test("append/truncate is symmetric: added going one way equals removed going back", () => {
    // Build `extended` by appending extra subtrees AFTER a base root's existing
    // children. Positional matching keeps the shared prefix identical (changed 0),
    // so the appended nodes are the only delta:
    //   base -> extended : added === total nodes appended, removed 0
    //   extended -> base : removed === total nodes appended, added 0
    fc.assert(
      fc.property(nodeArb, fc.array(nodeArb, { maxLength: 3 }), (base, extras) => {
        const baseChildren = childrenOf(base);
        const extended: ViewHierarchyNode = {
          $: base.$,
          ...(base.bounds !== undefined ? { bounds: base.bounds } : {}),
          node: [...baseChildren, ...extras],
        };
        const appended = extras.reduce((sum, extra) => sum + countNodes(extra), 0);

        const forward = annotateHierarchyDiff(hierarchyOf(base), hierarchyOf(extended)).summary;
        expect(forward).toEqual({
          hasBaseline: true,
          added: appended,
          changed: 0,
          removed: 0,
        });

        const backward = annotateHierarchyDiff(hierarchyOf(extended), hierarchyOf(base)).summary;
        expect(backward).toEqual({
          hasBaseline: true,
          added: 0,
          changed: 0,
          removed: appended,
        });
      }),
      RUN_OPTIONS,
    );
  });

  test("re-spelling attributes to their aliases keeps a single-node frame quiet", () => {
    // A node captured with `class`/`resource-id`/`content-desc` and boolean flags,
    // then re-captured with the camelCase aliases and stringified booleans plus
    // arbitrary non-signature junk, describes the SAME element. If any alias were
    // dropped the frame would falsely mark `changed` on every re-capture.
    const aliasable = fc.record({
      cls: fc.string({ minLength: 1, maxLength: 8 }),
      resId: fc.string({ minLength: 1, maxLength: 8 }),
      desc: fc.string({ minLength: 1, maxLength: 8 }),
      clickable: fc.boolean(),
      enabled: fc.boolean(),
      text: fc.string({ maxLength: 8 }),
    });
    // Keys the signature never reads; changing/adding them must not mark `changed`.
    const junk = fc.dictionary(
      fc.constantFrom("index", "package", "test-tag", "view-id", "password"),
      fc.oneof(fc.string({ maxLength: 6 }), fc.boolean()),
      { maxKeys: 4 },
    );

    fc.assert(
      fc.property(aliasable, junk, (a, extra) => {
        const canonical: NodeAttributes = {
          class: a.cls,
          "resource-id": a.resId,
          "content-desc": a.desc,
          clickable: a.clickable,
          enabled: a.enabled,
          text: a.text,
        };
        const respelled: NodeAttributes = {
          className: a.cls,
          resourceId: a.resId,
          contentDesc: a.desc,
          clickable: String(a.clickable),
          enabled: String(a.enabled),
          text: a.text,
          ...extra,
        };
        const { summary } = annotateHierarchyDiff(
          hierarchyOf({ $: canonical }),
          hierarchyOf({ $: respelled }),
        );
        expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 0, removed: 0 });
      }),
      RUN_OPTIONS,
    );
  });

  test("a struct-bounds frame folds with its string-bounds spelling of equal coords", () => {
    // One source reports bounds as a struct on the node; another reports the
    // `bounds` string attribute "l,t,r,b". Equal coordinates must not read as a
    // change (issue: capture-source bounds spelling).
    fc.assert(
      fc.property(boundsArb, fc.string({ minLength: 1, maxLength: 8 }), (b, cls) => {
        const structForm: ViewHierarchyNode = { $: { class: cls }, bounds: b };
        const stringForm: ViewHierarchyNode = {
          $: { class: cls, bounds: `${b.left},${b.top},${b.right},${b.bottom}` },
        };
        const { summary } = annotateHierarchyDiff(hierarchyOf(structForm), hierarchyOf(stringForm));
        expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 0, removed: 0 });
      }),
      RUN_OPTIONS,
    );
  });
});
