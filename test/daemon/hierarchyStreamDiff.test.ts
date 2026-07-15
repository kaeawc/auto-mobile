import { describe, expect, test } from "bun:test";
import {
  annotateHierarchyDiff,
  HIERARCHY_DIFF_STATE_KEY,
} from "../../src/daemon/hierarchyStreamDiff";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";

function node(
  attrs: Record<string, unknown>,
  children: ViewHierarchyNode[] = []
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
    const previous = hierarchy({ $: { class: "Root" }, bounds: { left: 0, top: 0, right: 10, bottom: 10 } });
    const current = hierarchy({ $: { class: "Root" }, bounds: { left: 0, top: 0, right: 20, bottom: 10 } });

    const { summary } = annotateHierarchyDiff(previous, current);

    expect(summary.changed).toBe(1);
  });

  test("an added subtree is fully annotated and counted", () => {
    const previous = hierarchy(node({ class: "Root" }, [node({ class: "A" })]));
    const current = hierarchy(
      node({ class: "Root" }, [node({ class: "A" }), node({ class: "B" }, [node({ class: "C" })])])
    );

    const { hierarchy: out, summary } = annotateHierarchyDiff(previous, current);

    expect(summary).toEqual({ hasBaseline: true, added: 2, changed: 0, removed: 0 });
    expect(diffState(out.hierarchy.node?.node?.[0])).toBeUndefined();
    expect(diffState(out.hierarchy.node?.node?.[1])).toBe("added");
    expect(diffState(out.hierarchy.node?.node?.[1]?.node?.[0])).toBe("added");
  });

  test("a removed subtree is counted but not annotated (it is gone)", () => {
    const previous = hierarchy(
      node({ class: "Root" }, [node({ class: "A" }), node({ class: "B" }, [node({ class: "C" })])])
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
