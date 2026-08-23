import { describe, expect, test } from "bun:test";
import { toSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { SkeletonElement } from "../../../../src/models/ObserveResult";

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
  return skeleton.find((entry) => entry.id === id);
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
      expect(submit?.id).toBe("com.app:id/submit");
      expect(submit?.label).toBe("Submit");

      const row = findById(skeleton, "s-def456");
      expect(row).toBeDefined();
      // No resource-id: falls back to the stable view-id; no text: content-desc.
      expect(row?.label).toBe("Compose row");
    });
  });

  test("retains compact semantic links and a Compose owner test tag when present", () => {
    const composeText: Element = {
      bounds: bounds(0, 0, 200, 40),
      text: "Terms of Service",
      "test-tag": "legal-copy",
      "semantic-links": [{ text: "Terms of Service", occurrence: 0, start: 0, end: 16 }],
    };

    const skeleton = toSkeleton(makeElements({ text: [composeText] }));

    expect(skeleton).toEqual([
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
      const skeleton = toSkeleton(makeElements({ text: [el] }));
      // Kept as pure text (no clickable ancestor), but with no affordance.
      expect(skeleton).toHaveLength(1);
      expect(skeleton[0].affordances).toEqual([]);
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
    test("text nodes with no clickable ancestor are kept with empty affordances", () => {
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

      const skeleton = toSkeleton(makeElements({ text: [heading, body] }));

      expect(skeleton).toHaveLength(2);
      expect(skeleton.map((e) => e.label).sort()).toEqual(["Some paragraph", "Welcome"]);
      expect(skeleton.every((e) => e.affordances.length === 0)).toBe(true);
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
      expect(skeleton[0].id).toBe("row");
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

      const skeleton = toSkeleton(makeElements({ clickable: [card], text: [linkedText] }));

      expect(skeleton).toHaveLength(2);
      expect(skeleton.find((entry) => entry.testTag === "legal-copy")).toMatchObject({
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
      expect(skeleton[0].id).toBe("dup");
      expect(skeleton[0].label).toBe("Row");
      expect(skeleton[0].affordances).toEqual(["tap", "scroll"]);
    });
  });

  describe("empty input", () => {
    test("no elements yields an empty skeleton", () => {
      expect(toSkeleton(makeElements({}))).toEqual([]);
    });
  });
});
