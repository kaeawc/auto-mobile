import { describe, expect, test } from "bun:test";
import {
  annotateHierarchyDiff,
  HIERARCHY_DIFF_STATE_KEY,
} from "../../src/daemon/hierarchyStreamDiff";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";

function node(
  attrs: Record<string, unknown>,
  children: ViewHierarchyNode[] = [],
): ViewHierarchyNode {
  return children.length > 0 ? { $: attrs, node: children } : { $: attrs };
}

function hierarchy(root: ViewHierarchyNode): ViewHierarchyResult {
  return { hierarchy: { node: root } };
}

/** Read the diff annotation stamped on a node's attributes, if any. */
function diffState(n: ViewHierarchyNode | undefined): unknown {
  return n?.$?.[HIERARCHY_DIFF_STATE_KEY];
}

describe("annotateHierarchyDiff", () => {
  test("tolerates a single child serialized as a bare object, not an array", () => {
    // The on-device XML→JSON emits `node` as an array for 2+ children but a bare object for a
    // single child (and can surface an empty `{}`). This once threw "{} is not iterable" and killed
    // the whole hierarchy push — leaving the interactive pane unable to arm on some devices.
    const singleChild = {
      $: { class: "Root" },
      node: { $: { class: "OnlyChild" } },
    } as unknown as ViewHierarchyNode;
    const empty = { $: { class: "Root" }, node: {} } as unknown as ViewHierarchyNode;

    // Both forms must be walked without throwing (across a first frame and a diff).
    expect(() => annotateHierarchyDiff(null, { hierarchy: { node: singleChild } })).not.toThrow();
    expect(() => annotateHierarchyDiff(null, { hierarchy: { node: empty } })).not.toThrow();

    // And they must be walked CORRECTLY: against a childless baseline, the single-child object is one
    // real added node, while the empty `{}` placeholder is ZERO children — not a phantom add.
    const childlessBaseline = {
      hierarchy: { node: { $: { class: "Root" } } as unknown as ViewHierarchyNode },
    };
    expect(
      annotateHierarchyDiff(childlessBaseline, { hierarchy: { node: singleChild } }).summary.added,
    ).toBe(1);
    expect(
      annotateHierarchyDiff(childlessBaseline, { hierarchy: { node: empty } }).summary.added,
    ).toBe(0);
  });

  test("first frame has no baseline and annotates nothing", () => {
    const current = hierarchy(node({ class: "Root" }, [node({ class: "Child", text: "a" })]));

    const { hierarchy: out, summary } = annotateHierarchyDiff(null, current);

    expect(summary).toEqual({ hasBaseline: false, added: 0, changed: 0, removed: 0 });
    expect(diffState(out.hierarchy.node)).toBeUndefined();
    expect(diffState(out.hierarchy.node?.node?.[0])).toBeUndefined();
  });

  test("unchanged frame annotates nothing but reports a baseline", () => {
    const build = () => hierarchy(node({ class: "Root" }, [node({ class: "Child", text: "a" })]));

    const { hierarchy: out, summary } = annotateHierarchyDiff(build(), build());

    expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 0, removed: 0 });
    expect(diffState(out.hierarchy.node)).toBeUndefined();
    expect(diffState(out.hierarchy.node?.node?.[0])).toBeUndefined();
  });

  test("a changed attribute marks the node changed", () => {
    const previous = hierarchy(node({ class: "Root" }, [node({ class: "Child", text: "old" })]));
    const current = hierarchy(node({ class: "Root" }, [node({ class: "Child", text: "new" })]));

    const { hierarchy: out, summary } = annotateHierarchyDiff(previous, current);

    expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 1, removed: 0 });
    expect(diffState(out.hierarchy.node)).toBeUndefined();
    expect(diffState(out.hierarchy.node?.node?.[0])).toBe("changed");
  });

  test("a bounds change marks the node changed", () => {
    const previous = hierarchy({
      $: { class: "Root" },
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    const current = hierarchy({
      $: { class: "Root" },
      bounds: { left: 0, top: 0, right: 20, bottom: 10 },
    });

    const { summary } = annotateHierarchyDiff(previous, current);

    expect(summary.changed).toBe(1);
  });

  test("an added subtree is fully annotated and counted", () => {
    const previous = hierarchy(node({ class: "Root" }, [node({ class: "A" })]));
    const current = hierarchy(
      node({ class: "Root" }, [node({ class: "A" }), node({ class: "B" }, [node({ class: "C" })])]),
    );

    const { hierarchy: out, summary } = annotateHierarchyDiff(previous, current);

    expect(summary).toEqual({ hasBaseline: true, added: 2, changed: 0, removed: 0 });
    expect(diffState(out.hierarchy.node?.node?.[0])).toBeUndefined();
    expect(diffState(out.hierarchy.node?.node?.[1])).toBe("added");
    expect(diffState(out.hierarchy.node?.node?.[1]?.node?.[0])).toBe("added");
  });

  test("a removed subtree is counted but not annotated (it is gone)", () => {
    const previous = hierarchy(
      node({ class: "Root" }, [node({ class: "A" }), node({ class: "B" }, [node({ class: "C" })])]),
    );
    const current = hierarchy(node({ class: "Root" }, [node({ class: "A" })]));

    const { summary } = annotateHierarchyDiff(previous, current);

    expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 0, removed: 2 });
  });

  test("does not mutate the input current hierarchy", () => {
    const previous = hierarchy(node({ class: "Root" }, [node({ class: "Child", text: "old" })]));
    const current = hierarchy(node({ class: "Root" }, [node({ class: "Child", text: "new" })]));

    annotateHierarchyDiff(previous, current);

    expect(diffState(current.hierarchy.node?.node?.[0])).toBeUndefined();
  });

  test("no baseline when the current frame has no root node", () => {
    const previous = hierarchy(node({ class: "Root" }));
    const current: ViewHierarchyResult = { hierarchy: {} };

    const { summary } = annotateHierarchyDiff(previous, current);

    expect(summary.hasBaseline).toBe(false);
  });
});

/**
 * The signature that decides "changed" folds capture-source spelling variants
 * (class/className, resource-id/resourceId, ...) to one canonical value. If any
 * alias is dropped, two frames that describe the same node with different
 * spellings would diverge and every node would be marked `changed` on every
 * frame. Each row diffs a node against a spelling-variant of itself and asserts
 * the frame is quiet (`changed === 0`). Run against the alias set in
 * hierarchyStreamDiff.ts — a failing row is a finding about the stringifier.
 */
describe("nodeSignature alias folding", () => {
  const aliasEquivalentRows: Array<{
    name: string;
    prev: ViewHierarchyNode;
    cur: ViewHierarchyNode;
  }> = [
    {
      name: "class and className are the same field",
      prev: node({ class: "android.widget.TextView" }),
      cur: node({ className: "android.widget.TextView" }),
    },
    {
      name: "resource-id and resourceId are the same field",
      prev: node({ "resource-id": "com.app:id/title" }),
      cur: node({ resourceId: "com.app:id/title" }),
    },
    {
      name: "content-desc and contentDesc are the same field",
      prev: node({ "content-desc": "Submit" }),
      cur: node({ contentDesc: "Submit" }),
    },
    {
      name: "a boolean flag and its string spelling compare equal",
      prev: node({ clickable: true }),
      cur: node({ clickable: "true" }),
    },
    {
      name: "an attribute present-but-null equals the same attribute absent",
      prev: node({ class: "X", text: null }),
      cur: node({ class: "X" }),
    },
    {
      name: "struct bounds and the string bounds fallback with equal coords fold together",
      prev: { $: { class: "X" }, bounds: { left: 0, top: 0, right: 10, bottom: 20 } },
      cur: node({ class: "X", bounds: "0,0,10,20" }),
    },
  ];

  for (const row of aliasEquivalentRows) {
    test(`treats a quiet frame as unchanged: ${row.name}`, () => {
      const { summary } = annotateHierarchyDiff(hierarchy(row.prev), hierarchy(row.cur));
      expect(summary).toEqual({ hasBaseline: true, added: 0, changed: 0, removed: 0 });
    });
  }

  // Sanity: the field IS compared — a genuine value change under either spelling
  // must still be seen, so the alias folding is not just ignoring the field.
  test("a real class change under the className spelling is still marked changed", () => {
    const { summary } = annotateHierarchyDiff(
      hierarchy(node({ className: "A" })),
      hierarchy(node({ className: "B" })),
    );
    expect(summary.changed).toBe(1);
  });
});
