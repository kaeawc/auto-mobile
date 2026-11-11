import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  focusedDescendantLabel,
  labelFocusedElement,
} from "../../../../src/features/observe/output/focusedElementLabel";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { findFocusedElement } from "../../../../src/features/observe/HierarchyFocus";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult, SkeletonElement } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import captured from "../../../fixtures/android-tv-compose-focused-card/observe-focused-card.json";

// #18028: the captured focusedElement of a Compose TV card and its skeleton row. The wire's compact
// bounds tuple is read back into the object form the projection labels before compacting.
const [left, top, right, bottom] = captured.focusedElement.bounds;
const focused: Element = { ...captured.focusedElement, bounds: { left, top, right, bottom } };
const rows = captured.skeleton_trending_card_2 as SkeletonElement[];
// The excerpt omits the card's child node; its text is the row's hoisted label, at the card bounds.
const child: Element = { bounds: focused.bounds, text: rows[0].label };

/** The captured Leanback row with an ImageCardView focused; its title is a child TextView. */
function leanbackObservation(): ObserveResult {
  const { viewHierarchy } = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/android-focus/leanback-row-content-focused.json", import.meta.url),
      "utf8",
    ),
  ) as { viewHierarchy: ViewHierarchyResult };
  return {
    updatedAt: 1,
    observationId: "leanback-row-content-focused",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 1920, height: 1080 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, "android"),
    focusedElement: findFocusedElement(viewHierarchy, new DefaultElementParser()) ?? undefined,
  };
}

describe("observe focusedElement label from its child text (#18028)", () => {
  test("the captured Compose card takes its skeleton row's label", () => {
    expect(focused.text).toBeUndefined();
    expect(focusedDescendantLabel(focused, rows, [child])).toBe("Trending card 2");
  });

  test("a row at other bounds or with another id is not the focused card", () => {
    const moved = rows.map((row) => ({
      ...row,
      bounds: [912, 214, 1312, 434] as typeof row.bounds,
    }));
    const otherId = rows.map((row) => ({ ...row, elementId: "s2-54a37556722ca76a-8" }));
    expect(focusedDescendantLabel(focused, moved, [child])).toBeUndefined();
    expect(focusedDescendantLabel(focused, otherId, [child])).toBeUndefined();
  });

  test("a row label no element inside the card shows, such as a field's hint, is not used", () => {
    expect(focusedDescendantLabel(focused, rows, [])).toBeUndefined();
    const field = { ...focused, actions: ["set_text"] };
    expect(focusedDescendantLabel(field, rows, [child])).toBeUndefined();
  });

  test("an element with its own text keeps it and gets no descendantLabel", () => {
    const out = { updatedAt: 1, focusedElement: { ...focused, text: "Play" } } as ObserveResult;
    labelFocusedElement(out, rows, [child]);
    expect(out.focusedElement).not.toHaveProperty("descendantLabel");
  });

  test("default skeleton observe labels a focused Leanback card from its title", () => {
    const observation = leanbackObservation();
    expect(observation.focusedElement?.text).toBeUndefined();
    const out = sanitizeObserveResult(observation, {
      project: "skeleton",
      compact: true,
      dropElements: true,
    });
    expect(out.focusedElement?.descendantLabel).toBe("Featured 01");
    const row = out.skeleton?.find((entry) => entry.label === "Featured 01");
    expect(JSON.stringify(out.focusedElement?.bounds)).toBe(JSON.stringify(row?.bounds));
  });

  test("project full labels it the same way", () => {
    const out = sanitizeObserveResult(leanbackObservation(), {
      project: "full",
      compact: true,
      dropElements: false,
    });
    expect(out.focusedElement?.descendantLabel).toBe("Featured 01");
  });
});
