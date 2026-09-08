import { describe, expect, test } from "bun:test";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { DefaultTextMatcher } from "../../../src/features/utility/TextMatcher";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import {
  assignStableViewIds,
  STABLE_VIEW_ID_PREFIX,
} from "../../../src/features/observe/android/StableNodeIdentity";
import { toSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import type { ViewHierarchyResult } from "../../../src/models";
import type { Element } from "../../../src/models/Element";
import type { ObserveResult } from "../../../src/models/ObserveResult";

/**
 * Round-trip coverage for issue #6218: the skeleton projection emits an
 * `s-<hash>` content-derived id (`assignStableViewIds`, #3228) as the SOLE
 * `elementId` for a node with no `resource-id`/`text`. `tapOn`/`inputText`
 * resolve `elementId` through `DefaultElementSelector.selectByResourceId` →
 * `DefaultElementFinder`, which previously only ever compared against
 * `resource-id` — so a skeleton-emitted `s-<hash>` id could never match
 * anything, despite the tool docs promising it is "directly usable as a
 * tapOn selector". `ElementFinder` now also matches an `s-`-prefixed
 * `elementId` against the node's `view-id` field.
 */

type ObserveElements = NonNullable<ObserveResult["elements"]>;

function makeElements(partial: Partial<ObserveElements>): ObserveElements {
  return {
    clickable: partial.clickable ?? [],
    scrollable: partial.scrollable ?? [],
    text: partial.text ?? [],
    media: partial.media ?? [],
  };
}

/** Shape `assignStableViewIds` rewrites: the runner's generated path UUID. */
function generatedViewId(seed: string): string {
  // Deterministic-looking but distinct per seed; only the shape (UUID) matters.
  const hex = Buffer.from(seed.padEnd(16, "0")).toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const parser = new DefaultElementParser();
const textMatcher = new DefaultTextMatcher();
const finder = new DefaultElementFinder(parser, textMatcher);
const selector = new DefaultElementSelector(finder);

describe("skeleton elementId round-trips through tapOn's ElementSelector (issue #6218)", () => {
  test("an s-<hash> elementId resolves back to the exact id-less element it was derived from", () => {
    // Three id-less, text-less nodes distinguished only by content-desc — the
    // "12/16 elements have no stable selector" dogfood scenario from the issue.
    const rawRoot = {
      node: [
        {
          class: "android.widget.ImageButton",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "content-desc": "row-alpha",
          clickable: "true",
          "view-id": generatedViewId("alpha"),
        },
        {
          class: "android.widget.ImageButton",
          bounds: { left: 0, top: 60, right: 100, bottom: 110 },
          "content-desc": "row-beta",
          clickable: "true",
          "view-id": generatedViewId("beta"),
        },
        {
          class: "android.widget.ImageButton",
          bounds: { left: 0, top: 120, right: 100, bottom: 170 },
          "content-desc": "row-gamma",
          clickable: "true",
          "view-id": generatedViewId("gamma"),
        },
      ],
    };

    // Ingest-time rewrite: generated path UUIDs -> content-derived `s-<hash>` ids.
    assignStableViewIds(rawRoot);
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const rawNodes = rawRoot.node;
    const elements = rawNodes.map((node) => parser.parseNodeBounds(node as never) as Element);

    // Every synthetic id is stable-shaped and unique.
    const stableIds = elements.map((el) => el["view-id"]);
    for (const id of stableIds) {
      expect(id).toMatch(/^s2-[0-9a-f]{16}(-\d+)?$/);
    }
    expect(new Set(stableIds).size).toBe(stableIds.length);

    const skeleton = toSkeleton(makeElements({ clickable: elements }));
    expect(skeleton).toHaveLength(3);

    // Round-trip: feed each skeleton elementId back into the exact selector
    // path tapOn uses, against the SAME hierarchy, and assert it resolves to
    // the one element it was derived from — not any other row.
    for (const entry of skeleton) {
      expect(entry.elementId).toMatch(/^s2-[0-9a-f]{16}(-\d+)?$/);
      const result = selector.selectByResourceId(viewHierarchy, entry.elementId!);
      expect(result.element).not.toBeNull();
      expect(result.totalMatches).toBe(1);
      const b = result.element!.bounds;
      expect([b.left, b.top, b.right, b.bottom]).toEqual(entry.bounds);
      expect(result.element!["content-desc"]).toBe(entry.label!);
    }
  });

  test("content-identical duplicate nodes get distinct ordinal ids (NO bare form) and both are rejected as capture-local", () => {
    // Two nodes with completely identical stable content (same class, no
    // text/content-desc/resource-id) — `assignStableViewIds` disambiguates them
    // with document-order ordinals. Under the #6229 fix EVERY member of a
    // duplicate group is suffixed, so the first is `s-<hash>-1` (NOT bare) and
    // the second is `s-<hash>-2`; the bare form is reserved for unique content.
    // Both ordinal forms are still capture-local whenever a duplicate exists,
    // so resolving either while both peers are present risks silently acting on
    // the wrong element — worse than a clear failure (issue #6218 review
    // threads PRRT_kwDOP-GF5M6foer0 and follow-up PRRT_kwDOP-GF5M6fomf-).
    const nodeA = {
      class: "android.view.View",
      bounds: { left: 0, top: 0, right: 40, bottom: 40 },
      clickable: "true",
      "view-id": generatedViewId("dup-a"),
    };
    const nodeB = {
      class: "android.view.View",
      bounds: { left: 0, top: 50, right: 40, bottom: 90 },
      clickable: "true",
      "view-id": generatedViewId("dup-b"),
    };
    const rawRoot = { node: [nodeA, nodeB] };

    assignStableViewIds(rawRoot);
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const idA = (nodeA as Record<string, unknown>)["view-id"] as string;
    const idB = (nodeB as Record<string, unknown>)["view-id"] as string;

    // Deterministic, cleanly disambiguated — neither is the bare form.
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^s2-[0-9a-f]{16}-1$/);
    expect(idB).toBe(`${idA.replace(/-1$/, "")}-2`);

    // Both ordinal forms are rejected outright, not resolved - neither is safe
    // to trust across a capture boundary while a content-identical duplicate
    // exists.
    expect(() => selector.selectByResourceId(viewHierarchy, idA)).toThrow(/ambiguous/i);
    expect(() => selector.selectByResourceId(viewHierarchy, idB)).toThrow(/ambiguous/i);
  });

  test("a suffixed id observed for a duplicate does NOT retarget the content-identical survivor after the original is removed (issue #6229)", () => {
    // Capture 1: content-identical peers [A, B]. A is `s-<hash>-1`, B is
    // `s-<hash>-2` — A is NOT bare, which is the crux of the #6229 fix.
    const makeDup = (seedA: string, seedB: string) => ({
      node: [
        {
          class: "android.view.View",
          bounds: { left: 0, top: 0, right: 40, bottom: 40 },
          clickable: "true",
          "view-id": generatedViewId(seedA),
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 50, right: 40, bottom: 90 },
          clickable: "true",
          "view-id": generatedViewId(seedB),
        },
      ],
    });
    const original = makeDup("orig-a", "orig-b");
    assignStableViewIds(original);
    const observedIdForA = (original.node[0] as Record<string, unknown>)["view-id"] as string;
    expect(observedIdForA).toMatch(/^s2-[0-9a-f]{16}-1$/);

    // Capture 2: A removed; B is the sole surviving content-identical node and
    // is reassigned the bare `s-<hash>` (now unique). A `tapOn` keyed on A's
    // observed `s-<hash>-1` must NOT silently land on B — it finds nothing.
    const afterRemoval = {
      node: [
        {
          class: "android.view.View",
          bounds: { left: 0, top: 50, right: 40, bottom: 90 },
          clickable: "true",
          "view-id": generatedViewId("orig-b"),
        },
      ],
    };
    assignStableViewIds(afterRemoval);
    const survivorId = (afterRemoval.node[0] as Record<string, unknown>)["view-id"] as string;
    expect(survivorId).toMatch(/^s2-[0-9a-f]{16}$/);
    expect(survivorId).not.toBe(observedIdForA);

    const result = selector.selectByResourceId(
      { hierarchy: afterRemoval } as ViewHierarchyResult,
      observedIdForA,
    );
    expect(result.element).toBeNull();
    expect(result.totalMatches).toBe(0);
  });

  test("a bare s-<hash> id with no content-identical peer still resolves normally", () => {
    // The common case (P1 follow-up): a UNIQUE base hash must keep resolving
    // even though the bare form is now also subject to the ambiguity check.
    const rawRoot = {
      node: [
        {
          class: "android.widget.ImageButton",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "content-desc": "solo-row",
          clickable: "true",
          "view-id": generatedViewId("solo"),
        },
      ],
    };
    assignStableViewIds(rawRoot);
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };
    const id = (rawRoot.node[0] as Record<string, unknown>)["view-id"] as string;
    expect(id).toMatch(/^s2-[0-9a-f]{16}$/);

    const result = selector.selectByResourceId(viewHierarchy, id);
    expect(result.element).not.toBeNull();
    expect(result.totalMatches).toBe(1);
    expect(result.element!["content-desc"]).toBe("solo-row");
  });

  test("rejects a detectable legacy bare duplicate id instead of treating it as a current singleton", () => {
    // Before #6229, a duplicate family's first member was bare and later
    // members started at -2. The new producer reserves -1 for that first
    // member, so this missing `-1` shape is an explicit legacy signature. It
    // must not silently resolve as if the bare id meant unique content.
    const legacyBase = "s-0123456789abcdef";
    const rawRoot = {
      node: [
        {
          class: "android.view.ViewGroup",
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          clickable: "true",
          "view-id": legacyBase,
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 110, right: 100, bottom: 160 },
          clickable: "true",
          "view-id": `${legacyBase}-2`,
        },
      ],
    };
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    expect(selector.selectByResourceId(viewHierarchy, legacyBase).element).toBeNull();
    // Container lookup shares the same selector contract and must not resolve
    // the legacy bare node before the target's ambiguity guard runs.
    expect(
      selector.selectByResourceId(viewHierarchy, "missing-target", {
        container: { elementId: legacyBase },
      }).element,
    ).toBeNull();
  });

  test("a real bare Compose resource-id shaped like a synthetic id is never misclassified as ambiguous", () => {
    // Review thread PRRT_kwDOP-GF5M6fomgA: `SYNTHETIC_STABLE_VIEW_ID_PATTERN`
    // must require the producer's EXACT hash width, not merely the stable
    // prefix, or a real short Compose testTag colliding with that prefix
    // would be wrongly rejected as an ambiguous synthetic ordinal.
    const rawRoot = {
      node: [
        {
          class: "androidx.compose.ui.platform.ComposeView",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "resource-id": `${STABLE_VIEW_ID_PREFIX}a`,
          clickable: "true",
        },
        {
          class: "androidx.compose.ui.platform.ComposeView",
          bounds: { left: 0, top: 60, right: 100, bottom: 110 },
          "resource-id": `${STABLE_VIEW_ID_PREFIX}a-2`,
          clickable: "true",
        },
      ],
    };
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const result = selector.selectByResourceId(viewHierarchy, `${STABLE_VIEW_ID_PREFIX}a-2`);
    expect(result.element).not.toBeNull();
    expect(result.totalMatches).toBe(1);
    expect(result.element!.bounds).toEqual({ left: 0, top: 60, right: 100, bottom: 110 });

    const resultBase = selector.selectByResourceId(viewHierarchy, `${STABLE_VIEW_ID_PREFIX}a`);
    expect(resultBase.element).not.toBeNull();
    expect(resultBase.totalMatches).toBe(1);
    expect(resultBase.element!.bounds).toEqual({ left: 0, top: 0, right: 100, bottom: 50 });
  });

  test("an ordinal id from an earlier capture does not silently resolve to the wrong node after an insert shifts the ordinals", () => {
    // The exact P1 scenario: content-identical controls [A, B] where B was
    // observed as `s-<hash>-2`. Inserting an identical control before them in
    // a later capture shifts the ordinals: A becomes `s-<hash>-2` and B
    // becomes `s-<hash>-3`. Resolving the ORIGINAL `s-<hash>-2` id (which
    // meant B) against the reordered capture must NOT silently act on A.
    const original = {
      node: [
        {
          class: "android.view.View",
          bounds: { left: 0, top: 0, right: 40, bottom: 40 },
          clickable: "true",
          "view-id": generatedViewId("orig-a"),
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 50, right: 40, bottom: 90 },
          clickable: "true",
          "view-id": generatedViewId("orig-b"),
        },
      ],
    };
    assignStableViewIds(original);
    const originalIdB = (original.node[1] as Record<string, unknown>)["view-id"] as string;
    expect(originalIdB).toMatch(/^s2-[0-9a-f]{16}-2$/);

    const reordered = {
      node: [
        {
          class: "android.view.View",
          bounds: { left: 0, top: -50, right: 40, bottom: -10 },
          clickable: "true",
          "view-id": generatedViewId("inserted-c"),
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 0, right: 40, bottom: 40 },
          clickable: "true",
          "view-id": generatedViewId("orig-a-2"),
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 50, right: 40, bottom: 90 },
          clickable: "true",
          "view-id": generatedViewId("orig-b-2"),
        },
      ],
    };
    assignStableViewIds(reordered);
    const reorderedIds = (reordered.node as Record<string, unknown>[]).map(
      (n) => n["view-id"] as string,
    );
    // Same base hash for all three (content-identical) - every member is
    // ordinal-suffixed (no bare form for a duplicate group, issue #6229), and
    // the inserted node now owns `-1` while A/B ordinals both shifted by one.
    const reorderedBase = originalIdB.replace(/-2$/, "");
    expect(reorderedIds[0]).toBe(`${reorderedBase}-1`);
    expect(reorderedIds[1]).toBe(originalIdB);
    expect(reorderedIds[2]).toBe(`${reorderedBase}-3`);

    const reorderedViewHierarchy: ViewHierarchyResult = { hierarchy: reordered };

    // The id that used to mean "B" now happens to match "A" (the inserted
    // node's document order) - this MUST be rejected, not silently tapped.
    expect(() => selector.selectByResourceId(reorderedViewHierarchy, originalIdB)).toThrow(
      /ambiguous/i,
    );
  });

  test("an ordinal id for identical controls in two containers is rejected as ambiguous even WITH a container selector (issue #6229, review thread PRRT_kwDOP-GF5M6f1gS0)", () => {
    // Ordinals are assigned by GLOBAL document order (`assignStableViewIds`),
    // but the ambiguity guard used to count only within the resolved container
    // (review thread PRRT_kwDOP-GF5M6fouI_). That was unsound: a content-
    // identical peer OUTSIDE the container still makes an in-container ordinal
    // capture-local, because removing the in-container original globally
    // re-ordinals the id onto a surviving peer. A single fresh capture cannot
    // tell a genuine "one identical target per container" layout apart from a
    // post-removal reassignment, so the guard now counts over the WHOLE capture
    // and rejects a globally-ambiguous ordinal even when a container isolates a
    // single peer. The caller must disambiguate with text/content-desc/bounds.
    const container1 = {
      class: "android.view.ViewGroup",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      "resource-id": "com.app:id/container1",
      node: [
        {
          class: "android.view.View",
          bounds: { left: 10, top: 10, right: 90, bottom: 40 },
          clickable: "true",
          "view-id": generatedViewId("target-in-container-1"),
        },
      ],
    };
    const container2 = {
      class: "android.view.ViewGroup",
      bounds: { left: 0, top: 200, right: 100, bottom: 300 },
      "resource-id": "com.app:id/container2",
      node: [
        {
          class: "android.view.View",
          bounds: { left: 10, top: 210, right: 90, bottom: 240 },
          clickable: "true",
          "view-id": generatedViewId("target-in-container-2"),
        },
      ],
    };
    const rawRoot = { node: [container1, container2] };
    assignStableViewIds(rawRoot);
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const idInContainer1 = (container1.node[0] as Record<string, unknown>)["view-id"] as string;
    const idInContainer2 = (container2.node[0] as Record<string, unknown>)["view-id"] as string;

    // Same base content hash, disambiguated globally by document order - both
    // are ordinal-suffixed (no bare form for a duplicate group, issue #6229):
    // container1's is `-1`, container2's is `-2`.
    expect(idInContainer1).toMatch(/^s2-[0-9a-f]{16}-1$/);
    expect(idInContainer2).toBe(`${idInContainer1.replace(/-1$/, "")}-2`);

    // Without a container, this is genuinely globally ambiguous.
    expect(() => selector.selectByResourceId(viewHierarchy, idInContainer1)).toThrow(/ambiguous/i);

    // Scoped to its OWN container, it is STILL rejected: the peer in the other
    // container keeps the ordinal capture-local, so the guard cannot safely
    // resolve it. (Previously this resolved cleanly, which is exactly the
    // silent-retarget vector #6229 targets once a peer is removed.)
    expect(() =>
      selector.selectByResourceId(viewHierarchy, idInContainer1, {
        container: { elementId: "com.app:id/container1" },
      }),
    ).toThrow(/ambiguous/i);
    expect(() =>
      selector.selectByResourceId(viewHierarchy, idInContainer2, {
        container: { elementId: "com.app:id/container2" },
      }),
    ).toThrow(/ambiguous/i);
  });

  test("a suffixed id does NOT silently retarget a content-identical peer in ANOTHER container after the original is removed (issue #6229, review thread PRRT_kwDOP-GF5M6f1gS0)", () => {
    // Cross-container retarget: content-identical [A, B] in container c1 and an
    // identical C in c2. Capture 1 assigns global ordinals A=`-1`, B=`-2`,
    // C=`-3`. A caller observes A as `s-H-1` and scopes a later tapOn to c1.
    // A is then removed; global re-ordinaling makes surviving B the new `s-H-1`
    // (and C `s-H-2`). A container-local ambiguity count would see only B in c1
    // and silently land the caller's stale `s-H-1` on B - a content-identical
    // peer the caller never selected. The whole-capture count sees B AND C and
    // rejects it as ambiguous instead.
    const buildRow = (tag: string) => ({
      class: "android.view.View",
      "content-desc": "identical-row",
      clickable: "true",
      "view-id": generatedViewId(tag),
    });
    const makeHierarchy = (rows1: unknown[], rows2: unknown[]) => {
      const c1 = {
        class: "android.view.ViewGroup",
        "resource-id": "com.app:id/c1",
        node: rows1,
      };
      const c2 = {
        class: "android.view.ViewGroup",
        "resource-id": "com.app:id/c2",
        node: rows2,
      };
      const root = { node: [c1, c2] };
      assignStableViewIds(root);
      return root;
    };

    // Capture 1: [A, B] in c1, C in c2.
    const capture1 = makeHierarchy([buildRow("A"), buildRow("B")], [buildRow("C")]);
    const c1Cap1 = (capture1.node[0] as Record<string, unknown>).node as Record<string, unknown>[];
    const observedIdForA = c1Cap1[0]["view-id"] as string;
    // A is a member of a duplicate group, so it is ordinal-suffixed (never bare).
    expect(observedIdForA).toMatch(/^s2-[0-9a-f]{16}-1$/);

    // Capture 2: A removed. c1 now holds only B; c2 still holds C. B and C are
    // content-identical, so both are re-ordinaled globally (B=`-1`, C=`-2`).
    const capture2 = makeHierarchy([buildRow("B")], [buildRow("C")]);
    const c1Cap2 = (capture2.node[0] as Record<string, unknown>).node as Record<string, unknown>[];
    const survivorIdInC1 = c1Cap2[0]["view-id"] as string;
    // The surviving in-c1 peer inherits the exact string the caller observed.
    expect(survivorIdInC1).toBe(observedIdForA);

    const viewHierarchy: ViewHierarchyResult = { hierarchy: capture2 };

    // Resolving the caller's stale `s-H-1` scoped to c1 must NOT land on B: the
    // still-present identical C in c2 keeps the ordinal capture-local, so the
    // guard raises ambiguity rather than silently retargeting the wrong peer.
    expect(() =>
      selector.selectByResourceId(viewHierarchy, observedIdForA, {
        container: { elementId: "com.app:id/c1" },
      }),
    ).toThrow(/ambiguous/i);

    // Same rejection without a container - globally ambiguous either way.
    expect(() => selector.selectByResourceId(viewHierarchy, observedIdForA)).toThrow(/ambiguous/i);
  });

  test("a real resource-id colliding with a synthetic ordinal OUTSIDE the container does not suppress ambiguity INSIDE it (issue #6229, review thread PRRT_kwDOP-GF5M6f2X6J)", () => {
    // c1 holds two content-identical peers, so BOTH are ordinal-suffixed (no
    // bare form for a duplicate group) and c1 is genuinely ambiguous on its
    // own. c2 holds an unrelated node whose REAL `resource-id` happens to
    // equal c1's first peer's synthetic ordinal string. The ambiguity guard's
    // internal real-id bypass previously checked the WHOLE capture for that
    // bypass (not just the active container scope), so this collision in c2
    // made it treat the c1 target as "backed by a real id" and skip the
    // ambiguity error entirely - even though the container selector scopes
    // resolution to c1, where no real id exists and the peer is genuinely
    // ambiguous. Duplicate COUNTING stays global (per the tests above); only
    // the bypass must stay scoped to the active container.
    const buildRow = (tag: string) => ({
      class: "android.view.View",
      "content-desc": "identical-row",
      clickable: "true",
      "view-id": generatedViewId(tag),
    });
    const c1 = {
      class: "android.view.ViewGroup",
      "resource-id": "com.app:id/c1",
      node: [buildRow("A"), buildRow("B")],
    };
    const decoy = {
      class: "android.view.View",
      bounds: { left: 0, top: 400, right: 100, bottom: 450 },
      "content-desc": "decoy-node",
      "view-id": generatedViewId("decoy"),
    };
    const c2 = {
      class: "android.view.ViewGroup",
      "resource-id": "com.app:id/c2",
      node: [decoy],
    };
    const rawRoot = { node: [c1, c2] };
    assignStableViewIds(rawRoot);

    const idInContainer1 = (c1.node[0] as Record<string, unknown>)["view-id"] as string;
    expect(idInContainer1).toMatch(/^s2-[0-9a-f]{16}-1$/);

    // Give the node OUTSIDE c1 a real resource-id equal to that exact ordinal
    // string - a collision `assignStableViewIds` cannot itself produce, since
    // real resource-ids and synthetic ids live in separate fields, but the
    // ambiguity guard's bypass reads the `resource-id` field independently of
    // scope.
    (decoy as Record<string, unknown>)["resource-id"] = idInContainer1;

    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    // Container-scoped to c1: no real id backs `idInContainer1` there, and c1
    // has two content-identical peers, so this must be rejected as
    // ambiguous - the real id colliding in c2 must not leak in and suppress
    // that rejection.
    expect(() =>
      selector.selectByResourceId(viewHierarchy, idInContainer1, {
        container: { elementId: "com.app:id/c1" },
      }),
    ).toThrow(/ambiguous/i);

    // Without a container, the whole capture IS the active scope, so the
    // real id in c2 legitimately wins - this is existing, intentional
    // behavior (review threads PRRT_kwDOP-GF5M6fo13g, PRRT_kwDOP-GF5M6fo2Iq)
    // and must be unaffected by this fix.
    const result = selector.selectByResourceId(viewHierarchy, idInContainer1);
    expect(result.element).not.toBeNull();
    expect(result.element!["content-desc"]).toBe("decoy-node");
  });

  test("recomputing the synthetic id over a fresh capture of the same hierarchy is deterministic", () => {
    const buildRoot = () => ({
      node: [
        {
          class: "android.widget.TextView",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "content-desc": "fresh-capture-node",
          clickable: "true",
          "view-id": generatedViewId("fresh"),
        },
      ],
    });

    const firstCapture = buildRoot();
    const secondCapture = buildRoot();
    assignStableViewIds(firstCapture);
    assignStableViewIds(secondCapture);

    const firstId = (firstCapture.node[0] as Record<string, unknown>)["view-id"];
    const secondId = (secondCapture.node[0] as Record<string, unknown>)["view-id"];
    expect(firstId).toBe(secondId as string);

    // The id emitted from capture 1's skeleton resolves against capture 2's
    // (freshly re-observed) hierarchy — the exact cross-capture scenario
    // between an `observe` and a subsequent `tapOn`.
    const skeleton = toSkeleton(
      makeElements({
        clickable: [parser.parseNodeBounds(firstCapture.node[0] as never) as Element],
      }),
    );
    const result = selector.selectByResourceId(
      { hierarchy: secondCapture } as ViewHierarchyResult,
      skeleton[0].elementId!,
    );
    expect(result.element).not.toBeNull();
    expect(result.element!["content-desc"]).toBe("fresh-capture-node");
  });

  test("a real resource-id elementId is unaffected by the stable-view-id fallback", () => {
    const rawRoot = {
      node: [
        {
          class: "android.widget.Button",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "resource-id": "com.app:id/submit",
          text: "Submit",
          clickable: "true",
        },
      ],
    };
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };
    const result = selector.selectByResourceId(viewHierarchy, "com.app:id/submit");
    expect(result.element).not.toBeNull();
    expect(result.element!.text).toBe("Submit");
  });

  describe("real resource-id takes precedence over a colliding synthetic view-id (review threads PRRT_kwDOP-GF5M6fo13g, PRRT_kwDOP-GF5M6fo2Iq, PRRT_kwDOP-GF5M6fo2Ip)", () => {
    // A resource-id shaped exactly like a synthetic hash - so it also matches
    // `syntheticStableViewIdBase` - is the sharpest test of precedence: a real
    // field match must win even when it superficially resembles the
    // synthetic shape.
    const collidingId = `${STABLE_VIEW_ID_PREFIX}9fb4b913ae97b1c1`;

    test("a real resource-id control is selected over a smaller id-less node sharing the same synthetic view-id, regardless of relative area", () => {
      // Previously the matcher UNIONED resource-id matches and synthetic
      // view-id matches, then area-sorted ascending - so the SMALLER
      // synthetic node would win over the explicitly-named resource
      // control. The real control here is deliberately much LARGER, so the
      // old area-sort would have picked the wrong (smaller) node first.
      const rawRoot = {
        node: [
          {
            class: "android.view.View",
            bounds: { left: 10, top: 10, right: 20, bottom: 20 }, // small
            clickable: "true",
            "view-id": collidingId,
          },
          {
            class: "android.widget.Button",
            bounds: { left: 0, top: 100, right: 200, bottom: 300 }, // large
            clickable: "true",
            "resource-id": collidingId,
            text: "Real Control",
          },
        ],
      };
      const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

      const result = selector.selectByResourceId(viewHierarchy, collidingId);
      expect(result.element).not.toBeNull();
      expect(result.totalMatches).toBe(1);
      expect(result.element!.text).toBe("Real Control");
      expect(result.element!.bounds).toEqual({ left: 0, top: 100, right: 200, bottom: 300 });
    });

    test("cross-window: a window's real resource-id match wins over a main-root stable-id match", () => {
      const rawRoot = {
        node: [
          {
            class: "android.view.View",
            bounds: { left: 0, top: 0, right: 50, bottom: 50 },
            clickable: "true",
            "view-id": collidingId,
          },
        ],
      };
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: rawRoot,
        windows: [
          {
            windowLayer: 1,
            hierarchy: {
              node: [
                {
                  class: "android.widget.Button",
                  bounds: { left: 0, top: 0, right: 80, bottom: 80 },
                  clickable: "true",
                  "resource-id": collidingId,
                  text: "Window Control",
                },
              ],
            },
          },
        ],
      } as ViewHierarchyResult;

      const result = selector.selectByResourceId(viewHierarchy, collidingId);
      expect(result.element).not.toBeNull();
      expect(result.totalMatches).toBe(1);
      expect(result.element!.text).toBe("Window Control");
    });

    test("findClickableSiblingsOfResourceId does not exclude a decoy synthetic-view-id sibling as if it were the real resource-id match", () => {
      // The real anchor (non-clickable) carries the resource-id; a separate,
      // CLICKABLE decoy node merely shares that string as its `view-id`.
      // Precedence means the decoy is NOT the id match, so it must surface as
      // a clickable sibling of the real anchor - previously it was unioned in
      // as a (false) match and silently excluded from the sibling results.
      const rawRoot = {
        node: [
          {
            class: "android.view.ViewGroup",
            bounds: { left: 0, top: 0, right: 200, bottom: 100 },
            node: [
              {
                class: "android.widget.ImageButton",
                bounds: { left: 0, top: 0, right: 50, bottom: 50 },
                clickable: "true",
                "view-id": collidingId, // decoy - not a real resource-id
              },
              {
                class: "android.view.View",
                bounds: { left: 60, top: 0, right: 110, bottom: 50 },
                "resource-id": collidingId, // real match, not clickable
              },
            ],
          },
        ],
      };
      const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

      const siblings = finder.findClickableSiblingsOfResourceId(viewHierarchy, collidingId);
      expect(siblings).toHaveLength(1);
      expect(siblings[0].bounds).toEqual({ left: 0, top: 0, right: 50, bottom: 50 });
    });

    test("the container path (findContainerNode) selects the real resource-id container, not a decoy sharing its view-id", () => {
      const rawRoot = {
        node: [
          {
            class: "android.view.ViewGroup",
            bounds: { left: 0, top: 0, right: 50, bottom: 50 },
            "view-id": collidingId, // decoy container - not a real resource-id
          },
          {
            class: "android.view.ViewGroup",
            bounds: { left: 100, top: 100, right: 300, bottom: 300 },
            "resource-id": collidingId, // the real, intended container
          },
        ],
      };
      const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

      const containerNode = finder.findContainerNode(viewHierarchy, { elementId: collidingId });
      expect(containerNode).not.toBeNull();
      const parsed = parser.parseNodeBounds(containerNode as never);
      expect(parsed!.bounds).toEqual({ left: 100, top: 100, right: 300, bottom: 300 });
    });
  });

  test("a real bare id with the stable prefix but no synthetic shape is treated as a plain resource-id, not a synthetic ordinal (review thread PRRT_kwDOP-GF5M6fo2Ip)", () => {
    // Review thread PRRT_kwDOP-GF5M6fo2Ip: recognition of a synthetic id must
    // be gated on the STRICT producer shape (`syntheticStableViewIdBase`)
    // everywhere a selector is matched against `view-id`, not merely on an
    // stable prefix. The short value is far short of the producer's 16-hex-character
    // hash, so it must never trigger the synthetic view-id fallback: a
    // separate node whose `view-id` merely happens to equal "s-a" (with no
    // matching `resource-id` of its own) must NOT be treated as a match.
    const rawRoot = {
      node: [
        {
          class: "android.widget.Button",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "resource-id": `${STABLE_VIEW_ID_PREFIX}a`,
          text: "Real Short Id",
          clickable: "true",
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 100, right: 300, bottom: 300 }, // much larger
          clickable: "true",
          "view-id": `${STABLE_VIEW_ID_PREFIX}a`, // superficially resembles the prefix, wrong shape
        },
      ],
    };
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const result = selector.selectByResourceId(viewHierarchy, `${STABLE_VIEW_ID_PREFIX}a`);
    expect(result.element).not.toBeNull();
    expect(result.totalMatches).toBe(1);
    expect(result.element!.text).toBe("Real Short Id");
    expect(result.element!.bounds).toEqual({ left: 0, top: 0, right: 100, bottom: 50 });
  });
});
