import { describe, expect, test } from "bun:test";
import {
  assignStableViewIds,
  GENERATED_VIEW_ID_PATTERN,
  STABLE_VIEW_ID_PREFIX,
} from "../../../../src/features/observe/android/StableNodeIdentity";

/**
 * Capture-layer stable node identity (issue #3228): the ingest pass that
 * rewrites the Android runner's positional (path-derived UUID) `view-id`s into
 * content-derived stable ids, so id-less rows keep their identity across a
 * scroll and `diffObserveResult`'s content-identity re-pair can collapse the
 * scroll cascade. Fixture-level acceptance (the #3132 scroll pair) is pinned
 * separately in `test/features/observe/output/stableIdentityScrollDiff.test.ts`.
 */

/** A fresh path-derived UUID the runner would emit for an id-less node. */
function generatedUuid(seed: string): string {
  // Any UUID-shaped lowercase hex string; vary by seed for uniqueness.
  const hex = (seed.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) >>> 0)
    .toString(16)
    .padStart(8, "0");
  return `${hex}-0000-4000-8000-00000000000${seed.length % 10}`;
}

function node(
  attrs: Record<string, unknown>,
  children?: Record<string, unknown>[],
): Record<string, unknown> {
  const n: Record<string, unknown> = { ...attrs };
  if (children && children.length > 0) {
    n.node = children.length === 1 ? children[0] : children;
  }
  return n;
}

describe("assignStableViewIds (#3228)", () => {
  test("rewrites a generated UUID view-id into a prefixed content hash", () => {
    const root = node({
      "view-id": generatedUuid("row"),
      "content-desc": "Basic long press card",
      bounds: { left: 0, top: 100, right: 500, bottom: 200 },
    });
    assignStableViewIds(root);
    const id = root["view-id"] as string;
    expect(id.startsWith(STABLE_VIEW_ID_PREFIX)).toBe(true);
    expect(GENERATED_VIEW_ID_PATTERN.test(id)).toBe(false);
  });

  test("leaves resource-id-backed and non-UUID view-ids untouched", () => {
    const withResourceId = node({
      "view-id": "com.example:id/button",
      "resource-id": "com.example:id/button",
    });
    const withCustom = node({ "view-id": "custom-id-shape" });
    const withoutViewId = node({ text: "no view-id at all" });
    for (const n of [withResourceId, withCustom, withoutViewId]) {
      const before = { ...n };
      assignStableViewIds(n);
      expect(n).toEqual(before);
    }
  });

  test("same content at a different position/state yields the SAME id (scroll survival)", () => {
    // The same row captured before and after a ~250px scroll: bounds moved, the
    // path-derived UUID changed, volatile extras/occlusion churned — but the
    // stable content is identical, so the assigned id must match.
    const before = node(
      {
        "view-id": generatedUuid("a"),
        bounds: { left: 42, top: 983, right: 1038, bottom: 1089 },
        extras: { traversalIndex: 7 },
        occlusionState: "partial",
      },
      [
        node({
          "view-id": generatedUuid("b"),
          text: "Item 42",
          bounds: { left: 60, top: 990, right: 900, bottom: 1080 },
        }),
      ],
    );
    const after = node(
      {
        "view-id": generatedUuid("c"),
        bounds: { left: 42, top: 658, right: 1038, bottom: 764 },
        extras: { traversalIndex: 3 },
      },
      [
        node({
          "view-id": generatedUuid("d"),
          text: "Item 42",
          bounds: { left: 60, top: 665, right: 900, bottom: 755 },
        }),
      ],
    );
    assignStableViewIds(before);
    assignStableViewIds(after);
    expect(before["view-id"]).toEqual(after["view-id"]);
    expect((before.node as Record<string, unknown>)["view-id"]).toEqual(
      (after.node as Record<string, unknown>)["view-id"],
    );
  });

  test("structurally distinct rows yield DIFFERENT ids (distinct rows never share)", () => {
    // Distinctness is structural: a differing resource-id / class / test-tag
    // anywhere in the subtree keeps the ancestors' ids distinct (#6230), even
    // though the volatile display text no longer participates in the rollup.
    const rowA = node({ "view-id": generatedUuid("a") }, [
      node({
        "view-id": generatedUuid("a1"),
        "resource-id": "com.example:id/first",
        text: "Item 1",
      }),
    ]);
    const rowB = node({ "view-id": generatedUuid("b") }, [
      node({
        "view-id": generatedUuid("b1"),
        "resource-id": "com.example:id/second",
        text: "Item 2",
      }),
    ]);
    assignStableViewIds(rowA);
    assignStableViewIds(rowB);
    expect(rowA["view-id"]).not.toEqual(rowB["view-id"]);
    // The leaf nodes themselves still differ by their own resource-id/text.
    expect((rowA.node as Record<string, unknown>)["view-id"]).not.toEqual(
      (rowB.node as Record<string, unknown>)["view-id"],
    );
  });

  test("a descendant's text/content-desc churn does NOT change an ancestor's id (#6230)", () => {
    // A row wrapping a live timer child whose label ticks between the skeleton
    // capture and the fresh capture a later tapOn resolves against. The row (and
    // any other ancestor) must keep its id so the emitted selector still matches;
    // only the timer leaf's own id may change, because its own content changed.
    const rowWith = (label: string): Record<string, unknown> =>
      node({ "view-id": generatedUuid("row"), "resource-id": "com.example:id/timerRow" }, [
        node({ "view-id": generatedUuid("static"), text: "Elapsed" }),
        node({ "view-id": generatedUuid("timer"), text: label }),
      ]);
    const before = rowWith("1 second");
    const after = rowWith("2 seconds");
    assignStableViewIds(before);
    assignStableViewIds(after);
    // Ancestor row id is stable across the descendant label tick…
    expect(before["view-id"]).toEqual(after["view-id"]);
    // …and the static sibling's own id is likewise stable…
    expect((before.node as Record<string, unknown>[])[0]["view-id"]).toEqual(
      (after.node as Record<string, unknown>[])[0]["view-id"],
    );
    // …while the timer leaf's OWN id changes, because its own text changed.
    expect((before.node as Record<string, unknown>[])[1]["view-id"]).not.toEqual(
      (after.node as Record<string, unknown>[])[1]["view-id"],
    );
  });

  test("canonical class and legacy className participate equivalently in identity", () => {
    const canonical = node({
      "view-id": generatedUuid("canonical"),
      class: "android.widget.ImageView",
    });
    const legacy = node({
      "view-id": generatedUuid("legacy"),
      className: "android.widget.ImageView",
    });
    const different = node({
      "view-id": generatedUuid("different"),
      class: "android.widget.TextView",
    });

    assignStableViewIds(canonical);
    assignStableViewIds(legacy);
    assignStableViewIds(different);

    expect(canonical["view-id"]).toEqual(legacy["view-id"]);
    expect(canonical["view-id"]).not.toEqual(different["view-id"]);
  });

  test("interaction-state flips (checked/focused) do not change identity", () => {
    const off = node({
      "view-id": generatedUuid("t"),
      "content-desc": "Wifi toggle",
      checked: "false",
    });
    const on = node({
      "view-id": generatedUuid("t"),
      "content-desc": "Wifi toggle",
      checked: "true",
      focused: "true",
    });
    assignStableViewIds(off);
    assignStableViewIds(on);
    expect(off["view-id"]).toEqual(on["view-id"]);
  });

  test("content-identical duplicates get document-order ordinal suffixes on EVERY member incl. the first (#6229)", () => {
    const spacer = () => node({ "view-id": generatedUuid("s"), bounds: {} });
    const root = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [
      spacer(),
      spacer(),
      spacer(),
    ]);
    assignStableViewIds(root);
    const children = root.node as Record<string, unknown>[];
    const ids = children.map((c) => c["view-id"] as string);
    expect(new Set(ids).size).toBe(3);
    // No member of a duplicate group takes the bare form: the first is `-1`,
    // reserving the bare `s-<hash>` for genuinely-unique content (issue #6229).
    expect(ids[0]).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-1$`));
    const base = ids[0].replace(/-1$/, "");
    expect(ids[1]).toBe(`${base}-2`);
    expect(ids[2]).toBe(`${base}-3`);
  });

  test("a content hash that occurs exactly once still gets the bare, un-suffixed id (#6229)", () => {
    // The bare form must remain the invariant for unique content — only
    // duplicate groups are ordinal-suffixed.
    const root = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [
      node({ "view-id": generatedUuid("only"), text: "Solo" }),
    ]);
    assignStableViewIds(root);
    const child = root.node as Record<string, unknown>;
    expect(child["view-id"]).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}$`));
  });

  test("uses a new namespace so a legacy bare id cannot select a post-upgrade singleton (#6229)", () => {
    const root = node({ "view-id": generatedUuid("root") }, [
      node({ "view-id": generatedUuid("only"), text: "Solo" }),
    ]);
    assignStableViewIds(root);
    const currentId = (root.node as Record<string, unknown>)["view-id"] as string;
    const legacyId = currentId.replace(STABLE_VIEW_ID_PREFIX, "s-");
    expect(currentId).toStartWith(STABLE_VIEW_ID_PREFIX);
    expect(currentId).not.toBe(legacyId);
  });

  test("removing the original of a duplicate pair does not reassign a bare id it collides with (#6229)", () => {
    // Capture 1: content-identical peers [A, B]. Under the fixed scheme A is
    // `s-H-1` (NOT bare) and B is `s-H-2`.
    const spacer = (seed: string) => node({ "view-id": generatedUuid(seed), bounds: {} });
    const before = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [
      spacer("a"),
      spacer("b"),
    ]);
    assignStableViewIds(before);
    const beforeIds = (before.node as Record<string, unknown>[]).map((c) => c["view-id"] as string);
    const idA = beforeIds[0];
    expect(idA).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-1$`));

    // Capture 2: A removed, B is the sole surviving node with that content. It
    // is reassigned the bare `s-H` (now unique) — which is NOT equal to the
    // `s-H-1` a caller observed for A, so the stale selector can no longer
    // silently land on B.
    const after = node({ "view-id": generatedUuid("root"), "resource-id": "" }, [spacer("b")]);
    assignStableViewIds(after);
    const survivorId = (after.node as Record<string, unknown>)["view-id"] as string;
    expect(survivorId).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}$`));
    expect(survivorId).not.toBe(idA);
    // The survivor's bare id is the same base hash, just without A's `-1`.
    expect(survivorId).toBe(idA.replace(/-1$/, ""));
  });

  test("is idempotent — a second pass changes nothing", () => {
    const root = node({ "view-id": generatedUuid("r") }, [
      node({ "view-id": generatedUuid("x"), text: "A" }),
      node({ "view-id": generatedUuid("y"), text: "A" }), // duplicate content
    ]);
    assignStableViewIds(root);
    const snapshot = JSON.parse(JSON.stringify(root));
    assignStableViewIds(root);
    expect(root).toEqual(snapshot);
  });

  test("rewrites occludedByViewId references when generated occluder ids are stabilized", () => {
    const occluderUuid = generatedUuid("overlay");
    const occluded = node({
      "view-id": generatedUuid("covered"),
      text: "Covered",
      occlusionState: "partial",
      occludedBy: "unlabeled view",
      occludedByViewId: occluderUuid,
    });
    const occluder = node({
      "view-id": occluderUuid,
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    const root = node({ "view-id": generatedUuid("root") }, [occluded, occluder]);

    assignStableViewIds(root);

    const children = root.node as Record<string, unknown>[];
    expect(children[0].occludedByViewId).toBe(children[1]["view-id"]);
    expect(GENERATED_VIEW_ID_PATTERN.test(children[0].occludedByViewId as string)).toBe(false);
  });

  test("handles single-object and array child slots plus non-object input", () => {
    const single = node({ "view-id": generatedUuid("p") }, [
      node({ "view-id": generatedUuid("c"), text: "only" }),
    ]);
    expect(Array.isArray(single.node)).toBe(false); // single child is an object, not an array
    assignStableViewIds(single);
    expect(
      ((single.node as Record<string, unknown>)["view-id"] as string).startsWith(
        STABLE_VIEW_ID_PREFIX,
      ),
    ).toBe(true);
    // Non-objects are ignored without throwing.
    assignStableViewIds(undefined);
    assignStableViewIds(null);
    assignStableViewIds("not a node");
  });

  test("a node's own text participates in identity (a text edit is a new identity, matching nodeKey semantics)", () => {
    const empty = node({ "view-id": generatedUuid("e"), text: "" });
    const typed = node({ "view-id": generatedUuid("e"), text: "SignOff3051" });
    assignStableViewIds(empty);
    assignStableViewIds(typed);
    expect(empty["view-id"]).not.toEqual(typed["view-id"]);
  });
});
