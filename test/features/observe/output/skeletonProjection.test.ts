import { describe, expect, test } from "bun:test";
import {
  toSkeleton,
  projectSkeleton,
} from "../../../../src/features/observe/output/SkeletonProjection";
import { setElementProvenance } from "../../../../src/features/observe/output/elementProvenance";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { DefaultElementSelector } from "../../../../src/features/utility/DefaultElementSelector";
import { tapOnSchema } from "../../../../src/server/interactionTools";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { SkeletonElement } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import scrollBeforeFixture from "../../../fixtures/observe/diff/scroll-before.json";

type ObserveElements = NonNullable<ObserveResult["elements"]>;

/**
 * Build the flattened `elements` block `toSkeleton` consumes. Categories overlap
 * on real captures (a clickable node that carries text is in both `clickable`
 * and `text`); the fixtures below mirror that so the merge/dedup path is
 * exercised, not bypassed.
 */
function makeElements(partial: Partial<ObserveElements>): ObserveElements {
  return {
    clickable: partial.clickable ?? [],
    scrollable: partial.scrollable ?? [],
    text: partial.text ?? [],
    media: partial.media ?? [],
  };
}

function bounds(left: number, top: number, right: number, bottom: number): Element["bounds"] {
  return { left, top, right, bottom };
}

function findById(skeleton: SkeletonElement[], id: string): SkeletonElement | undefined {
  return skeleton.find((entry) => entry.elementId === id);
}

describe("toSkeleton — acceptance criteria", () => {
  describe("AC2: id/label precedence maps onto the tapOn selector union", () => {
    test("id prefers resource-id, else view-id; label prefers text, else content-desc", () => {
      const resourceIdNode: Element = {
        bounds: bounds(0, 0, 100, 50),
        "resource-id": "com.app:id/submit",
        "view-id": "s-abc123",
        text: "Submit",
        "content-desc": "Submit button",
        clickable: "true",
      };
      const viewIdOnlyNode: Element = {
        bounds: bounds(0, 60, 100, 110),
        "view-id": "s-def456",
        "content-desc": "Compose row",
        clickable: "true",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [resourceIdNode, viewIdOnlyNode] }));

      const submit = findById(skeleton, "com.app:id/submit");
      expect(submit).toBeDefined();
      // resource-id wins over view-id; text wins over content-desc.
      expect(submit?.elementId).toBe("com.app:id/submit");
      expect(submit?.label).toBe("Submit");

      const row = findById(skeleton, "s-def456");
      expect(row).toBeDefined();
      // No resource-id: falls back to the stable view-id; no text: content-desc.
      expect(row?.label).toBe("Compose row");
    });

    test("a skeleton entry's elementId round-trips through tapOnSelectorSchema (issue #6153)", () => {
      const node: Element = {
        bounds: bounds(0, 0, 100, 50),
        "resource-id": "com.app:id/submit",
        text: "Submit",
        clickable: "true",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [node] }));
      const entry = skeleton[0];
      expect(entry.elementId).toBe("com.app:id/submit");
      // No stray `id` key survives the rename.
      expect((entry as Record<string, unknown>).id).toBeUndefined();

      // The docs promise a skeleton entry's elementId is "directly usable as a
      // tapOn selector" — verify that promise against the real selector schema.
      const parsed = tapOnSchema.parse({
        platform: "android",
        selector: { elementId: entry.elementId },
      });
      expect(parsed.selector).toEqual({ elementId: "com.app:id/submit" });
    });
  });

  test("retains compact semantic links and a Compose owner test tag when present, in context (issue #6221 item 1)", () => {
    const composeText: Element = {
      bounds: bounds(0, 0, 200, 40),
      text: "Terms of Service",
      "test-tag": "legal-copy",
      "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
    };

    const { skeleton, context } = projectSkeleton(makeElements({ text: [composeText] }));

    // Zero affordances -> never in the actionable-only skeleton (issue #6221 item 1).
    expect(skeleton).toEqual([]);
    expect(context).toEqual([
      {
        bounds: [0, 0, 200, 40],
        label: "Terms of Service",
        testTag: "legal-copy",
        semanticLinks: [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
        affordances: [],
      },
    ]);
  });

  describe("AC3: affordance derivation across boolean | string inputs", () => {
    const cases: Array<{
      name: string;
      attr: Partial<Element>;
      expected: SkeletonElement["affordances"];
    }> = [
      { name: "clickable", attr: { clickable: true }, expected: ["tap"] },
      { name: "clickable string", attr: { clickable: "true" }, expected: ["tap"] },
      { name: "long-clickable", attr: { "long-clickable": true }, expected: ["long-press"] },
      {
        name: "long-clickable string",
        attr: { "long-clickable": "true" },
        expected: ["long-press"],
      },
      { name: "scrollable", attr: { scrollable: true }, expected: ["scroll"] },
      { name: "scrollable string", attr: { scrollable: "true" }, expected: ["scroll"] },
      { name: "checkable", attr: { checkable: true }, expected: ["toggle"] },
      { name: "checkable string", attr: { checkable: "true" }, expected: ["toggle"] },
      {
        name: "input via EditText class",
        attr: { focusable: "true", class: "android.widget.EditText" },
        expected: ["input"],
      },
      {
        name: "input via input-type",
        attr: { focusable: true, "input-type": "textEmailAddress" },
        expected: ["input"],
      },
    ];

    for (const { name, attr, expected } of cases) {
      test(`derives ${name}`, () => {
        const el: Element = { bounds: bounds(0, 0, 10, 10), "resource-id": "n", ...attr };
        const category = attr.scrollable ? "scrollable" : "clickable";
        const skeleton = toSkeleton(makeElements({ [category]: [el] } as Partial<ObserveElements>));
        expect(skeleton).toHaveLength(1);
        expect(skeleton[0].affordances).toEqual(expected);
      });
    }

    test("tap derives from accessibility actions when the clickable boolean is absent", () => {
      // Compose / iOS captures carry `actions:["click"]` with no `clickable`
      // attribute; the collector still buckets them as clickable, and `tapOn`
      // acts on them — so the skeleton must expose `tap`.
      const composeButton: Element = {
        bounds: bounds(0, 0, 100, 50),
        "resource-id": "compose-btn",
        actions: ["click"],
      };
      const skeleton = toSkeleton(makeElements({ clickable: [composeButton] }));
      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].affordances).toEqual(["tap"]);
    });

    test("long-press derives from actions 'long_click' and from longClickable (iOS)", () => {
      const viaAction: Element = {
        bounds: bounds(0, 0, 10, 10),
        "resource-id": "a",
        actions: ["click", "long_click"],
      };
      const viaCamelCase: Element = {
        bounds: bounds(0, 20, 10, 30),
        "resource-id": "b",
        longClickable: "true",
      };
      const skeleton = toSkeleton(makeElements({ clickable: [viaAction, viaCamelCase] }));
      expect(findById(skeleton, "a")?.affordances).toEqual(["tap", "long-press"]);
      expect(findById(skeleton, "b")?.affordances).toEqual(["long-press"]);
    });

    test("an actions-only clickable with no label is kept (not dropped as inert)", () => {
      const el: Element = { bounds: bounds(0, 0, 10, 10), actions: ["click"] };
      const skeleton = toSkeleton(makeElements({ clickable: [el] }));
      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].affordances).toEqual(["tap"]);
    });

    test("focusable alone (no EditText class, no input-type) is not input", () => {
      const el: Element = {
        bounds: bounds(0, 0, 10, 10),
        "resource-id": "label",
        focusable: "true",
        class: "android.widget.TextView",
        text: "Heading",
      };
      const { skeleton, context } = projectSkeleton(makeElements({ text: [el] }));
      // Kept as pure text (no clickable ancestor), but with no affordance —
      // so it lands in `context`, not the actionable-only `skeleton` (issue
      // #6221 item 1).
      expect(skeleton).toHaveLength(0);
      expect(context).toHaveLength(1);
      expect(context[0].affordances).toEqual([]);
    });

    test("checkable carries checked; non-checkable never does", () => {
      const checkedOn: Element = {
        bounds: bounds(0, 0, 10, 10),
        "resource-id": "toggle-on",
        checkable: "true",
        checked: "true",
        clickable: "true",
      };
      const checkedOff: Element = {
        bounds: bounds(0, 20, 10, 30),
        "resource-id": "toggle-off",
        checkable: true,
        checked: false,
      };
      const plainTap: Element = {
        bounds: bounds(0, 40, 10, 50),
        "resource-id": "plain",
        clickable: "true",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [checkedOn, checkedOff, plainTap] }));

      expect(findById(skeleton, "toggle-on")?.checked).toBe(true);
      expect(findById(skeleton, "toggle-on")?.affordances).toEqual(["tap", "toggle"]);
      expect(findById(skeleton, "toggle-off")?.checked).toBe(false);
      expect(findById(skeleton, "toggle-off")?.affordances).toEqual(["toggle"]);
      expect(findById(skeleton, "plain")).toBeDefined();
      expect("checked" in (findById(skeleton, "plain") as SkeletonElement)).toBe(false);
    });

    test("multiple affordances emit in canonical order tap,long-press,input,scroll,toggle", () => {
      const kitchenSink: Element = {
        bounds: bounds(0, 0, 10, 10),
        "resource-id": "everything",
        clickable: "true",
        "long-clickable": "true",
        focusable: "true",
        "input-type": "text",
        scrollable: "true",
        checkable: "true",
      };
      const skeleton = toSkeleton(makeElements({ clickable: [kitchenSink] }));
      expect(skeleton[0].affordances).toEqual(["tap", "long-press", "input", "scroll", "toggle"]);
    });
  });

  describe("AC4: pure-text screens still surface their text", () => {
    test("text nodes with no clickable ancestor are kept with empty affordances, in context (issue #6221 item 1)", () => {
      const heading: Element = {
        bounds: bounds(0, 0, 200, 40),
        text: "Welcome",
        "resource-id": "title",
      };
      const body: Element = {
        bounds: bounds(0, 50, 200, 200),
        text: "Some paragraph",
        "view-id": "s-body",
      };

      const { skeleton, context } = projectSkeleton(makeElements({ text: [heading, body] }));

      // Zero-affordance rows never appear in the actionable-only skeleton.
      expect(skeleton).toHaveLength(0);
      expect(context).toHaveLength(2);
      expect(context.map((e) => e.label).sort()).toEqual(["Some paragraph", "Welcome"]);
      expect(context.every((e) => e.affordances.length === 0)).toBe(true);
    });

    test("text with a clickable ancestor is dropped (represented by the clickable row)", () => {
      const row: Element = {
        bounds: bounds(0, 0, 300, 80),
        "resource-id": "row",
        text: "Settings",
        clickable: "true",
      };
      const innerLabel: Element = {
        bounds: bounds(20, 20, 120, 60), // strictly inside the row
        text: "Settings",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [row], text: [row, innerLabel] }));

      // The clickable row survives; the redundant inner label is suppressed.
      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].elementId).toBe("row");
      expect(skeleton[0].affordances).toEqual(["tap"]);
    });

    test("linked text with a clickable ancestor remains discoverable", () => {
      const card: Element = {
        bounds: bounds(0, 0, 300, 80),
        "resource-id": "card",
        clickable: "true",
      };
      const linkedText: Element = {
        bounds: bounds(20, 20, 120, 60),
        text: "Terms of Service",
        "test-tag": "legal-copy",
        "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
      };

      const { skeleton, context } = projectSkeleton(
        makeElements({ clickable: [card], text: [linkedText] }),
      );

      // The clickable card is actionable (in skeleton); the linked text has no
      // affordance of its own and lands in context (issue #6221 item 1) —
      // still discoverable via its semantic link, per AC4.
      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].elementId).toBe("card");
      expect(context).toHaveLength(1);
      expect(context.find((entry) => entry.testTag === "legal-copy")).toMatchObject({
        label: "Terms of Service",
        semanticLinks: [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
      });
    });
  });

  describe("AC6: bounds emitted as the CompactBounds tuple", () => {
    test("bounds is a [left, top, right, bottom] tuple", () => {
      const el: Element = {
        bounds: bounds(11, 22, 333, 444),
        "resource-id": "n",
        clickable: "true",
      };
      const skeleton = toSkeleton(makeElements({ clickable: [el] }));
      expect(skeleton[0].bounds).toEqual([11, 22, 333, 444]);
    });
  });

  describe("dedup of identical (id, label, bounds) triples", () => {
    test("collapses identical triples to one entry, union of affordances", () => {
      const base = { bounds: bounds(0, 0, 100, 50), "resource-id": "dup", text: "Row" };
      const a: Element = { ...base, clickable: "true" };
      const b: Element = { ...base, clickable: "true" };
      const c: Element = { ...base, scrollable: "true" };

      const skeleton = toSkeleton(makeElements({ clickable: [a, b], scrollable: [c] }));

      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].elementId).toBe("dup");
      expect(skeleton[0].label).toBe("Row");
      expect(skeleton[0].affordances).toEqual(["tap", "scroll"]);
    });
  });

  describe("AC1 (#5869): hoist descendant text onto a labelless clickable container", () => {
    test("a clickable row with no own text takes its descendant text as label + sublabel", () => {
      // The standard Android `clickable container > TextView` preference row:
      // the container is clickable but carries no text of its own; the visible
      // title/summary live on descendant TextViews strictly inside it.
      const row: Element = {
        bounds: bounds(0, 200, 1080, 400),
        "view-id": "s-53a78106563f5449",
        clickable: "true",
      };
      const title: Element = {
        bounds: bounds(72, 240, 600, 300),
        text: "Network & internet",
      };
      const summary: Element = {
        bounds: bounds(72, 310, 600, 360),
        text: "Mobile, Wi-Fi, hotspot",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [row], text: [title, summary] }));

      // Only the container row survives; its inner labels are folded in.
      const entry = findById(skeleton, "s-53a78106563f5449");
      expect(entry).toBeDefined();
      expect(entry?.affordances).toEqual(["tap"]);
      expect(entry?.label).toBe("Network & internet");
      expect(entry?.sublabel).toBe("Mobile, Wi-Fi, hotspot");
      // The two inner text nodes are not emitted as separate rows.
      expect(skeleton).toHaveLength(1);
    });

    test("primary label is the top-most descendant; remaining texts join into sublabel", () => {
      const row: Element = {
        bounds: bounds(0, 0, 1080, 300),
        "view-id": "s-multi",
        clickable: "true",
      };
      // Deliberately out of document order to prove positional (top,left) sort.
      const third: Element = { bounds: bounds(72, 200, 600, 260), text: "Third" };
      const first: Element = { bounds: bounds(72, 20, 600, 80), text: "First" };
      const second: Element = { bounds: bounds(72, 110, 600, 170), text: "Second" };

      const skeleton = toSkeleton(makeElements({ clickable: [row], text: [third, first, second] }));

      const entry = findById(skeleton, "s-multi");
      expect(entry?.label).toBe("First");
      expect(entry?.sublabel).toBe("Second, Third");
    });
  });

  describe("AC2 (#5869): descendant state text is preserved, not dropped", () => {
    test("a clickable row with its own label folds descendant state text into sublabel", () => {
      // Clock alarm row: the row is clickable and labelled (the time), and the
      // schedule lives on a non-clickable descendant TextView. Previously the
      // schedule was dropped from the skeleton entirely.
      const alarmRow: Element = {
        bounds: bounds(0, 0, 1080, 240),
        "resource-id": "com.android.deskclock:id/alarm_item",
        text: "7:00 AM",
        clickable: "true",
      };
      const daysOfWeek: Element = {
        bounds: bounds(72, 140, 600, 200),
        "resource-id": "com.android.deskclock:id/days_of_week",
        text: "Mon, Tue, Wed, Thu, Fri",
      };

      const skeleton = toSkeleton(
        makeElements({ clickable: [alarmRow], text: [alarmRow, daysOfWeek] }),
      );

      const entry = findById(skeleton, "com.android.deskclock:id/alarm_item");
      expect(entry?.label).toBe("7:00 AM");
      expect(entry?.sublabel).toBe("Mon, Tue, Wed, Thu, Fri");
      // The schedule text is not lost, and not emitted as a separate row.
      expect(skeleton).toHaveLength(1);
    });

    test("descendant text equal to the container's own label is not duplicated into sublabel", () => {
      const row: Element = {
        bounds: bounds(0, 0, 300, 80),
        "resource-id": "row",
        text: "Settings",
        clickable: "true",
      };
      const innerLabel: Element = {
        bounds: bounds(20, 20, 120, 60),
        text: "Settings",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [row], text: [row, innerLabel] }));

      const entry = findById(skeleton, "row");
      expect(entry?.label).toBe("Settings");
      expect("sublabel" in (entry as SkeletonElement)).toBe(false);
      expect(skeleton).toHaveLength(1);
    });
  });

  describe("AC1 (#5869): hoist targets the smallest clickable ancestor", () => {
    test("descendant text is hoisted onto the innermost clickable container", () => {
      const outerCard: Element = {
        bounds: bounds(0, 0, 1080, 500),
        "view-id": "s-outer",
        clickable: "true",
      };
      const innerRow: Element = {
        bounds: bounds(20, 20, 1060, 240),
        "view-id": "s-inner",
        clickable: "true",
      };
      const label: Element = {
        bounds: bounds(72, 60, 600, 120),
        text: "Inner label",
      };

      const skeleton = toSkeleton(
        makeElements({ clickable: [outerCard, innerRow], text: [label] }),
      );

      // The text belongs to the innermost enclosing clickable, not the outer card.
      expect(findById(skeleton, "s-inner")?.label).toBe("Inner label");
      expect(findById(skeleton, "s-outer")?.label).toBeUndefined();
    });

    test("a nested clickable child's own text is not swallowed into the parent", () => {
      // A clickable parent with no own text, enclosing a clickable child that
      // carries its own text. The child owns a `tap` affordance, so it is not a
      // hoist candidate — its label stays on the child, and the parent is not
      // relabelled from it.
      const parentCard: Element = {
        bounds: bounds(0, 0, 1080, 300),
        "view-id": "s-parent",
        clickable: "true",
      };
      const childButton: Element = {
        bounds: bounds(800, 40, 1040, 160),
        "resource-id": "child-btn",
        text: "OK",
        clickable: "true",
      };

      const skeleton = toSkeleton(
        // The child, carrying text, appears in both categories on a real capture.
        makeElements({ clickable: [parentCard, childButton], text: [childButton] }),
      );

      expect(findById(skeleton, "child-btn")?.label).toBe("OK");
      expect(findById(skeleton, "child-btn")?.affordances).toEqual(["tap"]);
      // The parent keeps no label hoisted from the child's own text.
      const parent = findById(skeleton, "s-parent");
      expect(parent?.label).toBeUndefined();
      expect("sublabel" in (parent as SkeletonElement)).toBe(false);
    });
  });

  describe("#5881: window/root provenance gates hoisting and suppression", () => {
    // Tag an element with a root/window group and its Euler interval so the
    // projection can restrict hoisting/suppression to true tree ancestry.
    const withProvenance = (el: Element, group: number, enter: number, exit: number): Element => {
      setElementProvenance(el, { group, enter, exit });
      return el;
    };

    test("cross-window text is NOT hoisted onto a clickable in a lower window (mislabel fixed)", () => {
      // An underlying clickable in the base window (group 0) with no own text.
      const underlying = withProvenance(
        { bounds: bounds(0, 0, 300, 100), "view-id": "s-underlying", clickable: "true" },
        0,
        0,
        0,
      );
      // Overlay text in a topmost dialog window (group 1) that geometrically —
      // but not by ancestry — sits inside the underlying clickable.
      const overlayText = withProvenance(
        { bounds: bounds(20, 20, 280, 80), text: "Permission required" },
        1,
        1,
        1,
      );

      const skeleton = toSkeleton(makeElements({ clickable: [underlying], text: [overlayText] }));

      // The underlying action keeps its own (absent) label — not relabelled from
      // the unrelated overlay text in another window.
      expect(findById(skeleton, "s-underlying")?.label).toBeUndefined();
    });

    test("cross-window text is NOT suppressed by a clickable in a lower window", () => {
      const underlying = withProvenance(
        { bounds: bounds(0, 0, 300, 100), "view-id": "s-underlying", clickable: "true" },
        0,
        0,
        0,
      );
      const overlayText = withProvenance(
        { bounds: bounds(20, 20, 280, 80), text: "Permission required" },
        1,
        1,
        1,
      );

      const { context } = projectSkeleton(
        makeElements({ clickable: [underlying], text: [overlayText] }),
      );

      // The overlay text survives as its own affordance-less row in `context`
      // (issue #6221 item 1) — the clickable-ancestor suppression no longer
      // crosses the window boundary.
      const overlay = context.find((entry) => entry.label === "Permission required");
      expect(overlay).toBeDefined();
      expect(overlay?.affordances).toEqual([]);
    });

    test("same-window descendant text IS still hoisted (geometry gate is ancestry, not window count)", () => {
      // Identical geometry to the cross-window case, but now a genuine descendant
      // in the same group — proving it is ancestry, not bounds, that gates.
      const container = withProvenance(
        { bounds: bounds(0, 0, 300, 100), "view-id": "s-row", clickable: "true" },
        0,
        0,
        1,
      );
      const innerText = withProvenance(
        { bounds: bounds(20, 20, 280, 80), text: "Permission required" },
        0,
        1,
        1,
      );

      const skeleton = toSkeleton(makeElements({ clickable: [container], text: [innerText] }));

      expect(findById(skeleton, "s-row")?.label).toBe("Permission required");
      // Folded in, not emitted as a separate row.
      expect(skeleton).toHaveLength(1);
    });

    test("exact-fill descendant is hoisted onto its proven parent (no geometry >= relaxation)", () => {
      // A clickable card whose genuine descendant fills it exactly (identical
      // bounds — a match_parent child). Strict geometric containment (`>`) rejects
      // it; true tree ancestry hoists it. Mirrors the checked-in scroll-before
      // fixture's `long_press_card`.
      const card = withProvenance(
        {
          bounds: bounds(42, 1404, 1038, 1635),
          "resource-id": "long_press_card",
          clickable: "true",
          "long-clickable": "true",
        },
        0,
        0,
        3,
      );
      const exactFill = withProvenance(
        { bounds: bounds(42, 1404, 1038, 1635), "content-desc": "Basic long press card" },
        0,
        1,
        1,
      );
      const inner1 = withProvenance(
        { bounds: bounds(84, 1446, 381, 1509), text: "Long press me" },
        0,
        2,
        2,
      );
      const inner2 = withProvenance(
        { bounds: bounds(84, 1530, 334, 1593), text: "Hold to trigger" },
        0,
        3,
        3,
      );

      const skeleton = toSkeleton(
        makeElements({ clickable: [card], text: [exactFill, inner1, inner2] }),
      );

      const entry = findById(skeleton, "long_press_card");
      expect(entry?.affordances).toEqual(["tap", "long-press"]);
      // The exact-fill child becomes the label (top-most by reading order).
      expect(entry?.label).toBe("Basic long press card");
      expect(entry?.sublabel).toBe("Long press me, Hold to trigger");
      // The exact-fill descendant is not emitted as its own affordance-less row.
      expect(skeleton).toHaveLength(1);
    });

    test("a bounds-less wrapper does not leak a preceding sibling's ancestry to its descendants", () => {
      // Regression for the ancestor-stack skipped-sibling bug (Codex P1): a
      // clickable sibling followed by a bounds-less wrapper whose descendant text
      // sits at disjoint bounds. The text is NOT a tree descendant of the
      // clickable, and geometry does not contain it either — so it must not be
      // hoisted onto the clickable.
      const viewHierarchy = {
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 1080 },
            node: [
              {
                "resource-id": "clickable-a",
                clickable: "true",
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              },
              {
                // Bounds-less wrapper (skipped by parseNodeBounds) — its child
                // must reparent to the root, not to `clickable-a`.
                node: {
                  text: "Faraway",
                  bounds: { left: 200, top: 200, right: 250, bottom: 250 },
                },
              },
            ],
          },
        },
      } as unknown as NonNullable<ObserveResult["viewHierarchy"]>;

      const elements = new DefaultObserveElementCollector().collect(viewHierarchy, "android");
      const { skeleton, context } = projectSkeleton(elements!);

      // The clickable is not mislabelled from the disjoint faraway text...
      expect(findById(skeleton, "clickable-a")?.label).toBeUndefined();
      // ...and the faraway text survives as its own row, in `context` (zero
      // affordances — issue #6221 item 1).
      expect(context.some((entry) => entry.label === "Faraway")).toBe(true);
    });

    test("end-to-end: the real collector emits provenance that hoists the exact-fill descendant", () => {
      const elements = new DefaultObserveElementCollector().collect(
        scrollBeforeFixture.viewHierarchy as NonNullable<ObserveResult["viewHierarchy"]>,
        "android",
      );
      expect(elements).toBeDefined();

      const skeleton = toSkeleton(elements!);
      const card = skeleton.find((entry) => entry.elementId === "long_press_card");
      expect(card).toBeDefined();
      // Without ancestry provenance the exact-fill child is dropped and the card
      // stays label:null; with it, the label lands on the tappable row.
      expect(card?.label).toBe("Basic long press card");
      expect(card?.sublabel).toContain("Long press me");
      expect(card?.sublabel).toContain("Hold to trigger");
    });
  });

  describe("empty input", () => {
    test("no elements yields an empty skeleton", () => {
      expect(toSkeleton(makeElements({}))).toEqual([]);
    });
  });

  describe("#6221 item 2: duplicate-id disambiguator", () => {
    test("unique-id entries never carry an index", () => {
      const a: Element = { bounds: bounds(0, 0, 10, 10), "resource-id": "a", clickable: "true" };
      const b: Element = { bounds: bounds(0, 20, 10, 30), "resource-id": "b", clickable: "true" };

      const skeleton = toSkeleton(makeElements({ clickable: [a, b] }));

      expect(skeleton).toHaveLength(2);
      for (const entry of skeleton) {
        expect("index" in entry).toBe(false);
      }
    });

    test("a repeated id gets a per-entry index ranked by provenance hierarchy order", () => {
      const withProvenance = (el: Element, enter: number): Element => {
        setElementProvenance(el, { group: 0, enter, exit: enter });
        return el;
      };
      // Deliberately out of array order to prove ranking follows hierarchy
      // order (provenance.enter), not array position or geometry.
      const third = withProvenance(
        { bounds: bounds(0, 400, 100, 450), "resource-id": "dup", clickable: "true" },
        5,
      );
      const first = withProvenance(
        { bounds: bounds(0, 0, 100, 50), "resource-id": "dup", clickable: "true" },
        1,
      );
      const second = withProvenance(
        { bounds: bounds(0, 200, 100, 250), "resource-id": "dup", clickable: "true" },
        3,
      );
      const unrelated = withProvenance(
        { bounds: bounds(0, 600, 100, 650), "resource-id": "solo", clickable: "true" },
        7,
      );

      const skeleton = toSkeleton(makeElements({ clickable: [third, first, second, unrelated] }));

      const byBoundsTop = (a: SkeletonElement, b: SkeletonElement) => a.bounds[1] - b.bounds[1];
      const dupEntries = skeleton.filter((e) => e.elementId === "dup").sort(byBoundsTop);
      expect(dupEntries.map((e) => e.index)).toEqual([0, 1, 2]);
      expect(findById(skeleton, "solo")?.index).toBeUndefined();
    });

    test("the emitted index is verbatim usable by tapOn's own index resolution (ordering contract)", () => {
      // Three rows sharing a resource-id, built through the REAL collector so
      // provenance.enter is the real DFS counter — the same one
      // ElementFinder.findElementsByResourceId walks for an explicit index.
      const viewHierarchy = {
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
            node: [
              {
                "resource-id": "com.example:id/onoff",
                clickable: "true",
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              },
              {
                "resource-id": "com.example:id/onoff",
                clickable: "true",
                bounds: { left: 0, top: 200, right: 100, bottom: 300 },
              },
              {
                "resource-id": "com.example:id/onoff",
                clickable: "true",
                bounds: { left: 0, top: 400, right: 100, bottom: 500 },
              },
            ],
          },
        },
      } as unknown as NonNullable<ObserveResult["viewHierarchy"]>;

      const elements = new DefaultObserveElementCollector().collect(viewHierarchy, "android");
      const skeleton = toSkeleton(elements!);
      const dupEntries = skeleton
        .filter((e) => e.elementId === "com.example:id/onoff")
        .sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
      expect(dupEntries).toHaveLength(3);
      expect(dupEntries.map((e) => e.index)).toEqual([0, 1, 2]);

      const selector = new DefaultElementSelector();
      for (const entry of dupEntries) {
        const result = selector.selectByResourceId(
          viewHierarchy as unknown as ViewHierarchyResult,
          "com.example:id/onoff",
          { index: entry.index },
        );
        expect(result.element).not.toBeNull();
        const chosenBounds = result.element?.bounds;
        expect([
          chosenBounds?.left,
          chosenBounds?.top,
          chosenBounds?.right,
          chosenBounds?.bottom,
        ]).toEqual(entry.bounds);
      }
    });
  });

  describe("#6221 item 3: identifying descendant text is not dropped from a generic own label", () => {
    test("a leading-space generic own label folds in the identifying descendant text, trimmed", () => {
      // Mirrors the dogfood repro: an alarm row whose own text/content-desc
      // template dropped the time (" Alarm", leading space) while a sibling
      // digital_clock descendant still carries the real distinguishing text,
      // and a schedule descendant carries secondary state.
      const row: Element = {
        bounds: bounds(0, 0, 1080, 240),
        "resource-id": "com.google.android.deskclock:id/alarm_item",
        "content-desc": " Alarm",
        clickable: "true",
      };
      const digitalClock: Element = {
        bounds: bounds(72, 20, 400, 80),
        "resource-id": "com.google.android.deskclock:id/digital_clock",
        text: "8:30 AM",
      };
      const daysOfWeek: Element = {
        bounds: bounds(72, 140, 600, 200),
        "resource-id": "com.google.android.deskclock:id/days_of_week",
        text: "Mon, Tue, Wed, Thu, Fri",
      };

      const skeleton = toSkeleton(
        makeElements({ clickable: [row], text: [digitalClock, daysOfWeek] }),
      );

      const entry = findById(skeleton, "com.google.android.deskclock:id/alarm_item");
      expect(entry?.label).toBe("8:30 AM Alarm");
      expect(entry?.sublabel).toBe("Mon, Tue, Wed, Thu, Fri");
      // No leading/trailing whitespace anywhere in the emitted strings.
      expect(entry?.label).not.toMatch(/^\s|\s$/);
      expect(entry?.sublabel).not.toMatch(/^\s|\s$/);
    });

    test("a clean (non-templated) own label is left alone; descendant text still folds into sublabel", () => {
      // The "good" sibling row from the same repro: own text is already
      // complete ("6:45 AM Alarm", no stray whitespace), so nothing is
      // rewritten — this must keep working exactly as before (AC2 #5869).
      const row: Element = {
        bounds: bounds(0, 0, 1080, 240),
        "resource-id": "com.google.android.deskclock:id/alarm_item",
        text: "6:45 AM Alarm",
        clickable: "true",
      };
      const notScheduled: Element = {
        bounds: bounds(72, 140, 600, 200),
        "resource-id": "com.google.android.deskclock:id/status",
        text: "Not scheduled",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [row], text: [notScheduled] }));

      const entry = findById(skeleton, "com.google.android.deskclock:id/alarm_item");
      expect(entry?.label).toBe("6:45 AM Alarm");
      expect(entry?.sublabel).toBe("Not scheduled");
    });

    test("an ordinary single-word own label is NOT clobbered by descendant state text", () => {
      // Regression guard: a clean, non-templated single-word label ("Wi-Fi")
      // must still route descendant text to sublabel, not get rewritten just
      // because it happens to be short/generic-looking.
      const row: Element = {
        bounds: bounds(0, 0, 1080, 240),
        "resource-id": "wifi-row",
        text: "Wi-Fi",
        clickable: "true",
      };
      const state: Element = {
        bounds: bounds(72, 140, 600, 200),
        "resource-id": "wifi-state",
        text: "Connected",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [row], text: [state] }));

      const entry = findById(skeleton, "wifi-row");
      expect(entry?.label).toBe("Wi-Fi");
      expect(entry?.sublabel).toBe("Connected");
    });

    test("a leading-space own label with no hoist candidates is still trimmed", () => {
      const row: Element = {
        bounds: bounds(0, 0, 1080, 240),
        "resource-id": "lonely-row",
        "content-desc": " Alarm",
        clickable: "true",
      };

      const skeleton = toSkeleton(makeElements({ clickable: [row] }));

      const entry = findById(skeleton, "lonely-row");
      expect(entry?.label).toBe("Alarm");
    });
  });

  describe("projectSkeleton — actionable-only skeleton + context (issue #6221 item 1)", () => {
    test("zero-affordance entries are absent from skeleton and present in context", () => {
      const title: Element = {
        bounds: bounds(0, 0, 1080, 120),
        "resource-id": "com.google.android.deskclock:id/action_bar_title",
        text: "Alarm",
      };
      const addButton: Element = {
        bounds: bounds(900, 1800, 1080, 1980),
        "resource-id": "com.google.android.deskclock:id/fab",
        "content-desc": "Add alarm",
        clickable: "true",
      };

      const { skeleton, context } = projectSkeleton(
        makeElements({ clickable: [addButton], text: [title] }),
      );

      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].elementId).toBe("com.google.android.deskclock:id/fab");
      expect(skeleton.every((entry) => entry.affordances.length > 0)).toBe(true);

      expect(context).toHaveLength(1);
      expect(context[0].elementId).toBe("com.google.android.deskclock:id/action_bar_title");
      expect(context[0].affordances).toEqual([]);
    });

    test("the com.android.systemui status-bar block collapses to a single context entry", () => {
      const clock: Element = {
        bounds: bounds(30, 10, 120, 60),
        "resource-id": "com.android.systemui:id/clock",
        text: "7:09",
      };
      const wifi: Element = {
        bounds: bounds(900, 10, 950, 60),
        "resource-id": "com.android.systemui:id/wifi_signal",
        "content-desc": "Wifi signal full.",
      };
      const battery: Element = {
        bounds: bounds(960, 10, 1050, 60),
        "resource-id": "com.android.systemui:id/battery",
        "content-desc": "Battery charging, 100 percent.",
      };
      // Non-systemui zero-affordance entry — must NOT be folded into the
      // systemui summary, and must survive as its own context row.
      const screenTitle: Element = {
        bounds: bounds(0, 100, 1080, 200),
        "resource-id": "com.google.android.deskclock:id/action_bar_title",
        text: "Alarm",
      };

      const { skeleton, context } = projectSkeleton(
        makeElements({ text: [clock, wifi, battery, screenTitle] }),
      );

      expect(skeleton).toEqual([]);
      // ONE collapsed systemui entry + the unrelated screen title, not four
      // separate systemui rows (issue #6221 item 1).
      expect(context).toHaveLength(2);

      const summary = context.find((entry) => entry.elementId?.startsWith("com.android.systemui"));
      expect(summary).toBeDefined();
      expect(summary?.affordances).toEqual([]);
      expect(summary?.label).toContain("7:09");
      expect(summary?.label).toContain("Wifi signal full.");
      expect(summary?.label).toContain("Battery charging, 100 percent.");
      // The summary's bounds enclose every collapsed entry.
      expect(summary?.bounds).toEqual([30, 10, 1050, 60]);

      const title = context.find((entry) => entry.label === "Alarm");
      expect(title).toBeDefined();
      expect(title?.elementId).toBe("com.google.android.deskclock:id/action_bar_title");
    });

    test("notification-shade rows under the same com.android.systemui namespace are NEVER folded into the status-bar summary (PR #6242 review PRRT_kwDOP-GF5M6fq3iH)", () => {
      // The notification shade lives under the same `com.android.systemui`
      // namespace as the status bar (see test/server/systemTray.test.ts's
      // `notification_row_1` fixture), but its rows are ACTIONABLE and must stay
      // individually tappable — never collapsed into the synthetic status-bar
      // summary just because the id shares a package prefix.
      const clock: Element = {
        bounds: bounds(30, 10, 120, 60),
        "resource-id": "com.android.systemui:id/clock",
        text: "7:09",
      };
      const notificationRow: Element = {
        bounds: bounds(0, 200, 1080, 300),
        "resource-id": "com.android.systemui:id/notification_row_1",
        text: "New message from Alex",
        clickable: "true",
      };
      // A zero-affordance systemui node that is NOT status-bar chrome (e.g. a
      // notification title/summary line inside the shade) must also survive as
      // its own context row rather than being swept into the status-bar summary.
      const notificationTitle: Element = {
        bounds: bounds(0, 300, 1080, 340),
        "resource-id": "com.android.systemui:id/notification_stack_scroller",
        text: "1 new notification",
      };

      const { skeleton, context } = projectSkeleton(
        makeElements({ clickable: [notificationRow], text: [clock, notificationTitle] }),
      );

      // The notification row is actionable and keeps its own id/bounds intact.
      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].elementId).toBe("com.android.systemui:id/notification_row_1");
      expect(skeleton[0].label).toBe("New message from Alex");
      expect(skeleton[0].bounds).toEqual([0, 200, 1080, 300]);

      // Only the clock collapses into the status-bar summary; the shade's own
      // zero-affordance node stays a separate, uncollapsed context entry.
      expect(context).toHaveLength(2);
      const summary = context.find(
        (entry) => entry.elementId === "com.android.systemui:status-bar-summary",
      );
      expect(summary?.label).toBe("Status bar: 7:09");
      const shadeText = context.find((entry) => entry.label === "1 new notification");
      expect(shadeText).toBeDefined();
      expect(shadeText?.elementId).toBe("com.android.systemui:id/notification_stack_scroller");
    });

    test("actionable entries with duplicate ids keep their #6238 index/label in the filtered actionable set", () => {
      // Four alarm rows sharing one resource-id, mixed in with a zero-affordance
      // systemui block — the duplicate-index disambiguator (issue #6221 item 2)
      // must still apply correctly once the non-actionable entries are filtered
      // out into `context`.
      const makeAlarmRow = (top: number, time: string): Element => ({
        bounds: bounds(0, top, 1080, top + 200),
        "resource-id": "com.google.android.deskclock:id/digital_clock",
        text: time,
        clickable: "true",
      });
      const rows = [
        makeAlarmRow(300, "6:45 AM"),
        makeAlarmRow(500, "8:30 AM"),
        makeAlarmRow(700, "9:00 AM"),
      ];
      // Outside every alarm row's bounds (0-30 vs rows starting at 300) so the
      // clock is not geometrically suppressed as text-with-a-clickable-ancestor —
      // that suppression is a separate, unrelated concern from this test.
      const clock: Element = {
        bounds: bounds(30, 10, 120, 60),
        "resource-id": "com.android.systemui:id/clock",
        text: "7:09",
      };

      const { skeleton, context } = projectSkeleton(
        makeElements({ clickable: rows, text: [clock] }),
      );

      expect(skeleton).toHaveLength(3);
      expect(
        skeleton.every(
          (entry) => entry.elementId === "com.google.android.deskclock:id/digital_clock",
        ),
      ).toBe(true);
      // Every duplicate carries a distinct index, ranked by hierarchy order —
      // same guarantee as before the actionable/context split (issue #6238).
      const indexes = skeleton.map((entry) => entry.index).sort();
      expect(indexes).toEqual([0, 1, 2]);
      expect(new Set(skeleton.map((entry) => entry.label))).toEqual(
        new Set(["6:45 AM", "8:30 AM", "9:00 AM"]),
      );

      // The systemui entry collapses into context and never consumes/interferes
      // with the actionable duplicate-index assignment.
      expect(context).toHaveLength(1);
      expect(context[0].index).toBeUndefined();
    });
  });
});
