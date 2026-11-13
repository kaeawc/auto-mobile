import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createFocusIdentity } from "../../../src/features/action/FocusIdentity";
import type { FocusPathEntry, FocusScreen } from "../../../src/features/action/FocusNavigate";
import type { FocusNavigateDirection } from "../../../src/features/action/FocusNavigateDirections";
import { findFocusedElement } from "../../../src/features/observe/HierarchyFocus";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

const BOUNDS = { left: 0, top: 400, right: 1920, bottom: 520 };

/**
 * One read of a one-slot control: nothing sits outside it, so only its label and, for a slider,
 * its `range-info` can change.
 */
function read(label: string, range?: string): { entry: FocusPathEntry; screen: FocusScreen } {
  const focused: Element = {
    bounds: BOUNDS,
    "resource-id": "slot",
    text: label,
    focusable: true,
    class: "android.widget.TextView",
    ...(range === undefined ? {} : { "range-info": range }),
  };
  return {
    entry: { bounds: BOUNDS, resourceId: "slot", text: label },
    screen: { focused, elements: [focused] },
  };
}

type Step = [label: string, pressed: FocusNavigateDirection | undefined, range?: string];

function keys(steps: readonly Step[]) {
  const identify = createFocusIdentity();
  return steps.map(([label, pressed, range]) => {
    const { entry, screen } = read(label, range);
    return identify(entry, screen, pressed);
  });
}

/** A slider step: the label and the extractor's `range-info` both carry the value. */
function slider(value: number, pressed?: FocusNavigateDirection): Step {
  return [`${value}%`, pressed, `current:${value}.0,min:0.0,max:100.0`];
}

describe("createFocusIdentity toggle detection (#17209)", () => {
  test("a label changed by right and changed back by left is an in-place toggle", () => {
    const ids = keys([slider(50), slider(51, "right"), slider(50, "left")]);
    expect(ids[2]).toMatchObject({ changedInPlace: true });
    expect(ids[2]?.key).toStartWith("adjustable|");
  });

  test("a toggle still counts when a refused press sits between the two changes", () => {
    const ids = keys([slider(50), slider(51, "right"), slider(51, "down"), slider(50, "left")]);
    expect(ids[3]).toMatchObject({ changedInPlace: true });
  });

  test("a label that comes back on the same press is a list moving, not a toggle", () => {
    const ids = keys([
      ["A", undefined],
      ["B", "down"],
      ["A", "down"],
      ["C", "down"],
    ]);
    expect(ids.map((id) => id.changedInPlace)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(new Set(ids.map((id) => id.key)).size).toBe(3);
  });

  test("a one-slot list scrolled down and back up is focus moving, not a toggle (#18255)", () => {
    const ids = keys([
      ["A", undefined],
      ["B", "down"],
      ["A", "up"],
      ["B", "down"],
      ["C", "down"],
    ]);
    expect(ids.map((id) => id.changedInPlace)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(ids.map((id) => id.key.startsWith("adjustable|"))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(new Set(ids.map((id) => id.key)).size).toBe(3);
  });

  test("a label round trip whose range-info stays put is not a toggle (#18255)", () => {
    const range = "current:0.0,min:0.0,max:100.0";
    const ids = keys([
      ["A", undefined, range],
      ["B", "down", range],
      ["A", "up", range],
    ]);
    expect(ids[2]?.changedInPlace).toBeUndefined();
    expect(ids[2]?.key).not.toStartWith("adjustable|");
  });

  test("a label round trip whose range-info does not come back is not a toggle (#18255)", () => {
    const ids = keys([
      slider(50),
      slider(51, "right"),
      ["50%", "left", "current:52.0,min:0.0,max:100.0"],
    ]);
    expect(ids[2]?.changedInPlace).toBeUndefined();
  });

  describe("a captured Playground slider (#17209)", () => {
    const parser = new DefaultElementParser();

    function capture(name: string): { entry: FocusPathEntry; screen: FocusScreen } {
      const hierarchy = JSON.parse(
        readFileSync(`test/fixtures/android-focus/${name}.json`, "utf8"),
      ) as ViewHierarchyResult;
      const focused = findFocusedElement(hierarchy, parser);
      const elements = parser.flattenViewHierarchy(hierarchy).map(({ element }) => element);
      const label = elements
        .map((element) => element["content-desc"])
        .find((desc) => typeof desc === "string" && desc.startsWith("Slider with value"));
      if (!focused || typeof label !== "string") {
        throw new Error(`${name} has no focused slider`);
      }
      return {
        entry: { bounds: focused.bounds, resourceId: "slider_control", descendantLabel: label },
        screen: { focused, elements },
      };
    }

    test("the value readout growing a pixel wider with its digits does not move the screen", () => {
      // The readout's bounds are [64,381][357,429] at 50% and [64,381][358,429] at 49%: the node is
      // as wide as its text, so a layout compared by full bounds read every press as a scroll and
      // focusNavigate walked the slider to max_steps.
      const identify = createFocusIdentity();
      const first = capture("playground-slider-value-50");
      const second = capture("playground-slider-value-49");
      identify(first.entry, first.screen);
      const after = identify(second.entry, second.screen, "down");
      expect(after.changedInPlace).toBe(true);
      expect(after.key).toStartWith("adjustable|");
    });
  });
});
