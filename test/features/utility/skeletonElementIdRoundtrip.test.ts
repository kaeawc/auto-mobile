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

  test("content-identical duplicate nodes get distinct ordinal-suffixed ids that each resolve to their own node, not the other's", () => {
    // Two nodes with completely identical stable content (same class, no
    // text/content-desc/resource-id) — `assignStableViewIds` disambiguates them
    // with a `-2` ordinal suffix rather than colliding on one hash.
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

    const resultA = selector.selectByResourceId(viewHierarchy, idA);
    expect(resultA.element).not.toBeNull();
    expect(resultA.totalMatches).toBe(1);
    expect(resultA.element!.bounds).toEqual({ left: 0, top: 0, right: 40, bottom: 40 });

    const resultB = selector.selectByResourceId(viewHierarchy, idB);
    expect(resultB.element).not.toBeNull();
    expect(resultB.totalMatches).toBe(1);
    expect(resultB.element!.bounds).toEqual({ left: 0, top: 50, right: 40, bottom: 90 });
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
});
