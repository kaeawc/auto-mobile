import { describe, expect, test } from "bun:test";
import type { SkeletonElement, ViewHierarchyResult } from "../../../../src/models";
import { findProjectedTextRow } from "../../../../src/features/observe/wait/WaitProjectedText";
import { evaluateWaitForObservation } from "../../../../src/features/observe/wait/WaitPredicates";
import { ObserveElementsBuilder } from "../../../../src/features/observe/ObserveElementsBuilder";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import type { MatchMode } from "../../../../src/features/utility/ElementResolver";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

const screenSize = { width: 400, height: 800 };

const row = (label: string, bounds: SkeletonElement["bounds"], sublabel?: string) => ({
  label,
  bounds,
  affordances: [],
  ...(sublabel === undefined ? {} : { sublabel }),
});

const loadedRow = row("Loaded 95 bytes", [120, 210, 281, 236]);

const hierarchyWith = (nodes: object[]): ViewHierarchyResult => ({
  hierarchy: {
    node: {
      $: { bounds: { left: 0, top: 0, right: 400, bottom: 800 } },
      node: nodes,
    },
  },
  screenWidth: 400,
  screenHeight: 800,
});

const loadButton = {
  $: {
    text: "Load quote",
    "resource-id": "load-quote",
    clickable: "true",
    bounds: { left: 20, top: 100, right: 380, bottom: 160 },
  },
};

describe("findProjectedTextRow", () => {
  test("matches a context row by contains when no row matches exactly", () => {
    const element = findProjectedTextRow(
      { text: "Loaded" },
      { screenSize, skeleton: [], context: [loadedRow] },
    );

    expect(element?.text).toBe("Loaded 95 bytes");
    expect(element?.bounds).toEqual({ left: 120, top: 210, right: 281, bottom: 236 });
  });

  test("searches skeleton rows too", () => {
    const tappable = { ...row("Retry", [0, 0, 100, 40]), affordances: ["tap" as const] };

    expect(
      findProjectedTextRow({ text: "retry" }, { screenSize, skeleton: [tappable] })?.text,
    ).toBe("Retry");
  });

  test("prefers an exact row over an earlier contains row", () => {
    const element = findProjectedTextRow(
      { text: "Loaded" },
      { screenSize, context: [loadedRow, row("Loaded", [0, 300, 100, 340])] },
    );

    expect(element?.bounds.top).toBe(300);
  });

  test("honours textMatch exact and regex", () => {
    const observation = { screenSize, context: [loadedRow] };

    expect(findProjectedTextRow({ text: "Loaded", textMatch: "exact" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "^loaded \\d+ bytes$", textMatch: "regex" }, observation)?.text,
    ).toBe("Loaded 95 bytes");
  });

  test("matches sublabel text and textAny variants", () => {
    const observation = { screenSize, context: [row("Status", [0, 0, 200, 40], "Done, 3 items")] };

    expect(findProjectedTextRow({ textAny: ["Failed", "3 items"] }, observation)?.text).toBe(
      "Status",
    );
  });

  test("ignores rows with no visible part on screen", () => {
    const offscreen = row("Loaded 95 bytes", [500, 210, 600, 236]);

    expect(
      findProjectedTextRow({ text: "Loaded" }, { screenSize, context: [offscreen] }),
    ).toBeNull();
  });

  test("leaves compound, container and layer waits to the hierarchy search", () => {
    const observation = { screenSize, context: [loadedRow] };

    expect(findProjectedTextRow({ text: "Loaded", elementId: "status" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "Loaded", container: { elementId: "list" } }, observation),
    ).toBeNull();
    expect(findProjectedTextRow({ text: "Loaded", layer: "app" }, observation)).toBeNull();
    expect(findProjectedTextRow({ elementId: "status" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "Loaded", selectionStrategy: "unique" }, observation),
    ).toBeNull();
  });

  test("projects collected elements when the observation carries no rows", () => {
    const hierarchy = hierarchyWith([
      loadButton,
      { $: { text: "Loaded 95 bytes", bounds: { left: 120, top: 210, right: 281, bottom: 236 } } },
    ]);
    const elements = new ObserveElementsBuilder().build(hierarchy, "android");

    expect(findProjectedTextRow({ text: "Loaded" }, { screenSize, elements })?.text).toBe(
      "Loaded 95 bytes",
    );
  });
});

describe("evaluateWaitForObservation text over projected rows", () => {
  test("keeps the hierarchy's off-screen verdict over a hoisted row label", () => {
    const hierarchy = hierarchyWith([
      {
        $: { clickable: "true", bounds: { left: 0, top: 0, right: 400, bottom: 900 } },
        node: [{ $: { text: "Loaded", bounds: { left: 0, top: 850, right: 100, bottom: 890 } } }],
      },
    ]);
    const result = evaluateWaitForObservation(
      new ElementResolver(),
      { text: "Loaded" },
      createObserveResultForTest({
        screenSize,
        viewHierarchy: hierarchy,
        elements: new ObserveElementsBuilder().build(hierarchy, "android"),
      }),
      {
        devicePlatform: "android",
        displayInventory: "single",
        modes: new Map<string, MatchMode>(),
        iosMultiPanel: false,
      },
    );

    expect(result.matched).toBe(false);
  });

  const evaluate = (context?: SkeletonElement[]) =>
    evaluateWaitForObservation(
      new ElementResolver(),
      { text: "Loaded" },
      createObserveResultForTest({
        screenSize,
        viewHierarchy: hierarchyWith([loadButton]),
        skeleton: [],
        ...(context === undefined ? {} : { context }),
      }),
      {
        devicePlatform: "ios",
        displayInventory: "single",
        modes: new Map<string, MatchMode>(),
        iosMultiPanel: false,
      },
    );

  test("matches text reported only in context", () => {
    const result = evaluate([loadedRow]);

    expect(result.matched).toBe(true);
    expect(result.awaitedElement?.text).toBe("Loaded 95 bytes");
  });

  test("does not match when neither the hierarchy nor the rows carry the text", () => {
    expect(evaluate().matched).toBe(false);
  });
});
