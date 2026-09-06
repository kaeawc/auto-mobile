import { describe, expect, test } from "bun:test";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { DefaultTextMatcher } from "../../../src/features/utility/TextMatcher";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { assignStableViewIds } from "../../../src/features/observe/android/StableNodeIdentity";
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
      expect(id).toMatch(/^s-[0-9a-f]{16}(-\d+)?$/);
    }
    expect(new Set(stableIds).size).toBe(stableIds.length);

    const skeleton = toSkeleton(makeElements({ clickable: elements }));
    expect(skeleton).toHaveLength(3);

    // Round-trip: feed each skeleton elementId back into the exact selector
    // path tapOn uses, against the SAME hierarchy, and assert it resolves to
    // the one element it was derived from — not any other row.
    for (const entry of skeleton) {
      expect(entry.elementId).toMatch(/^s-[0-9a-f]{16}(-\d+)?$/);
      const result = selector.selectByResourceId(viewHierarchy, entry.elementId!);
      expect(result.element).not.toBeNull();
      expect(result.totalMatches).toBe(1);
      const b = result.element!.bounds;
      expect([b.left, b.top, b.right, b.bottom]).toEqual(entry.bounds);
      expect(result.element!["content-desc"]).toBe(entry.label!);
    }
  });

  test("content-identical duplicate nodes get distinct ids, but BOTH the bare first-occurrence id and its ordinal-suffixed peer are rejected as capture-local", () => {
    // Two nodes with completely identical stable content (same class, no
    // text/content-desc/resource-id) — `assignStableViewIds` disambiguates them
    // with a `-2` ordinal suffix rather than colliding on one hash. The FIRST
    // occurrence gets the bare `s-<hash>` id (implicitly ordinal 1) - that
    // bare/ordinal split is assigned by document order AT CAPTURE TIME (see
    // `StableNodeIdentity.ts`), so BOTH forms are capture-local whenever a
    // duplicate exists: an insert or reorder before a later capture can hand
    // the bare id to a different node entirely. Resolving either form here
    // would therefore risk silently acting on the wrong element - worse than
    // a clear failure (issue #6218 review threads PRRT_kwDOP-GF5M6foer0 and
    // follow-up PRRT_kwDOP-GF5M6fomf-).
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

    // Deterministic, cleanly disambiguated — not the same value.
    expect(idA).not.toBe(idB);
    expect(idA.startsWith("s-")).toBe(true);
    expect(idB).toBe(`${idA}-2`);

    // Both the bare first-occurrence id and its ordinal-suffixed peer are
    // rejected outright, not resolved - neither is safe to trust across a
    // capture boundary while a content-identical duplicate exists.
    expect(() => selector.selectByResourceId(viewHierarchy, idA)).toThrow(/ambiguous/i);
    expect(() => selector.selectByResourceId(viewHierarchy, idB)).toThrow(/ambiguous/i);
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
    expect(id).toMatch(/^s-[0-9a-f]{16}$/);

    const result = selector.selectByResourceId(viewHierarchy, id);
    expect(result.element).not.toBeNull();
    expect(result.totalMatches).toBe(1);
    expect(result.element!["content-desc"]).toBe("solo-row");
  });

  test("a real bare Compose resource-id shaped like a synthetic id (s-a / s-a-2) is never misclassified as ambiguous", () => {
    // Review thread PRRT_kwDOP-GF5M6fomgA: `SYNTHETIC_STABLE_VIEW_ID_PATTERN`
    // must require the producer's EXACT hash width, not merely the `s-`
    // prefix, or a real short Compose testTag colliding with that prefix
    // would be wrongly rejected as an ambiguous synthetic ordinal.
    const rawRoot = {
      node: [
        {
          class: "androidx.compose.ui.platform.ComposeView",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "resource-id": "s-a",
          clickable: "true",
        },
        {
          class: "androidx.compose.ui.platform.ComposeView",
          bounds: { left: 0, top: 60, right: 100, bottom: 110 },
          "resource-id": "s-a-2",
          clickable: "true",
        },
      ],
    };
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const result = selector.selectByResourceId(viewHierarchy, "s-a-2");
    expect(result.element).not.toBeNull();
    expect(result.totalMatches).toBe(1);
    expect(result.element!.bounds).toEqual({ left: 0, top: 60, right: 100, bottom: 110 });

    const resultBase = selector.selectByResourceId(viewHierarchy, "s-a");
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
    expect(originalIdB).toMatch(/^s-[0-9a-f]{16}-2$/);

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
    // Same base hash for all three (content-identical) - inserted node now
    // owns the un-suffixed base id, and A/B ordinals both shifted by one.
    expect(reorderedIds[0]).toBe(originalIdB.replace(/-2$/, ""));
    expect(reorderedIds[1]).toBe(originalIdB);
    expect(reorderedIds[2]).toBe(`${originalIdB.replace(/-2$/, "")}-3`);

    const reorderedViewHierarchy: ViewHierarchyResult = { hierarchy: reordered };

    // The id that used to mean "B" now happens to match "A" (the inserted
    // node's document order) - this MUST be rejected, not silently tapped.
    expect(() => selector.selectByResourceId(reorderedViewHierarchy, originalIdB)).toThrow(
      /ambiguous/i,
    );
  });

  test("identical controls in two distinct, uniquely-identified containers resolve via tapOn({elementId, container}) instead of being rejected as ambiguous", () => {
    // Review thread PRRT_kwDOP-GF5M6fouI_: the ambiguity check must be scoped
    // to the RESOLVED container, not the whole capture. Two containers each
    // hold one content-identical target node - globally ambiguous (2 nodes
    // share the base hash), but each container's own subtree contains only
    // ONE of them, so a `container`-scoped selector must resolve cleanly.
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

    // Same base content hash, disambiguated globally by document order - the
    // first (container1's) is bare, the second (container2's) is suffixed.
    expect(idInContainer1).toMatch(/^s-[0-9a-f]{16}$/);
    expect(idInContainer2).toBe(`${idInContainer1}-2`);

    // Without a container, this is genuinely globally ambiguous.
    expect(() => selector.selectByResourceId(viewHierarchy, idInContainer1)).toThrow(/ambiguous/i);

    // Scoped to its OWN container, each resolves cleanly - the peer outside
    // the container does not block or misdirect resolution inside it.
    const resultInContainer1 = selector.selectByResourceId(viewHierarchy, idInContainer1, {
      container: { elementId: "com.app:id/container1" },
    });
    expect(resultInContainer1.element).not.toBeNull();
    expect(resultInContainer1.totalMatches).toBe(1);
    expect(resultInContainer1.element!.bounds).toEqual({
      left: 10,
      top: 10,
      right: 90,
      bottom: 40,
    });

    const resultInContainer2 = selector.selectByResourceId(viewHierarchy, idInContainer2, {
      container: { elementId: "com.app:id/container2" },
    });
    expect(resultInContainer2.element).not.toBeNull();
    expect(resultInContainer2.totalMatches).toBe(1);
    expect(resultInContainer2.element!.bounds).toEqual({
      left: 10,
      top: 210,
      right: 90,
      bottom: 240,
    });

    // The peer's id, scoped to the WRONG container, correctly finds nothing -
    // not a misdirected match onto that container's own (different) node.
    const wrongContainerResult = selector.selectByResourceId(viewHierarchy, idInContainer2, {
      container: { elementId: "com.app:id/container1" },
    });
    expect(wrongContainerResult.element).toBeNull();
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
    const collidingId = "s-9fb4b913ae97b1c1";

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

  test("a real bare id (view-id: 's-a') that does not match the strict synthetic shape is treated as a plain resource-id, not a synthetic ordinal (review thread PRRT_kwDOP-GF5M6fo2Ip)", () => {
    // Review thread PRRT_kwDOP-GF5M6fo2Ip: recognition of a synthetic id must
    // be gated on the STRICT producer shape (`syntheticStableViewIdBase`)
    // everywhere a selector is matched against `view-id`, not merely on an
    // `s-` prefix. "s-a" is far short of the producer's 16-hex-character
    // hash, so it must never trigger the synthetic view-id fallback: a
    // separate node whose `view-id` merely happens to equal "s-a" (with no
    // matching `resource-id` of its own) must NOT be treated as a match.
    const rawRoot = {
      node: [
        {
          class: "android.widget.Button",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          "resource-id": "s-a",
          text: "Real Short Id",
          clickable: "true",
        },
        {
          class: "android.view.View",
          bounds: { left: 0, top: 100, right: 300, bottom: 300 }, // much larger
          clickable: "true",
          "view-id": "s-a", // superficially resembles the prefix, wrong shape
        },
      ],
    };
    const viewHierarchy: ViewHierarchyResult = { hierarchy: rawRoot };

    const result = selector.selectByResourceId(viewHierarchy, "s-a");
    expect(result.element).not.toBeNull();
    expect(result.totalMatches).toBe(1);
    expect(result.element!.text).toBe("Real Short Id");
    expect(result.element!.bounds).toEqual({ left: 0, top: 0, right: 100, bottom: 50 });
  });
});
