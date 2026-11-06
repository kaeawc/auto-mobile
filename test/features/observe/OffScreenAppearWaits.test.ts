import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { MatchMode } from "../../../src/features/utility/ElementResolver";
import { appear, disappear } from "../../../src/features/observe/ConditionPredicates";
import { evaluateWaitForObservation } from "../../../src/features/observe/wait/WaitPredicates";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { createObserveResultForTest } from "./flatHierarchyBuilders";

const screenSize = { width: 400, height: 800 };

interface EditNode {
  top: number;
  left?: number;
  id?: string;
}

/** A 400x800 screen with "Edit" text nodes; a node at top 850 has no visible part (#17023). */
function editObservation(
  edits: EditNode[],
  size: ObserveResult["screenSize"] | undefined = screenSize,
): ObserveResult {
  return createObserveResultForTest({
    screenSize: size,
    viewHierarchy: {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 400, bottom: 800 },
          node: edits.map(({ top, left = 0, id }) => ({
            text: "Edit",
            ...(id === undefined ? {} : { "resource-id": id }),
            bounds: { left, top, right: left + 100, bottom: top + 40 },
          })),
        },
      },
    },
  });
}

const offScreen = editObservation([{ top: 850 }]);

function plainWaitFor(observation: ObserveResult): boolean {
  return evaluateWaitForObservation(new ElementResolver(), { text: "Edit" }, observation, {
    devicePlatform: "android",
    displayInventory: "single",
    modes: new Map<string, MatchMode>(),
    iosMultiPanel: false,
  }).matched;
}

describe("for: appear / disappear on a node entirely off screen (#17023)", () => {
  test("appear does not match it, agreeing with the plain waitFor", () => {
    expect(appear(new ElementResolver(), { text: "Edit" })(offScreen).matched).toBe(false);
    expect(plainWaitFor(offScreen)).toBe(false);
  });

  test("disappear treats it as gone", () => {
    expect(disappear(new ElementResolver(), { text: "Edit" })(offScreen).matched).toBe(true);
  });

  test("an elementId wait does not match it either", () => {
    const observation = editObservation([{ top: 850, id: "app:id/edit" }]);

    expect(appear(new ElementResolver(), { elementId: "app:id/edit" })(observation).matched).toBe(
      false,
    );
  });

  test("a node with any visible part still matches", () => {
    const partlyVisible = editObservation([{ top: 780 }]);

    expect(appear(new ElementResolver(), { text: "Edit" })(partlyVisible).matched).toBe(true);
    expect(disappear(new ElementResolver(), { text: "Edit" })(partlyVisible).matched).toBe(false);
    expect(plainWaitFor(partlyVisible)).toBe(true);
  });

  test("an unscoped wait takes another match that is on screen", () => {
    const observation = editObservation([{ top: 850 }, { top: 100, left: 200 }]);
    const evaluation = appear(new ElementResolver(), { text: "Edit" })(observation);

    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement?.bounds.left).toBe(200);
    expect(disappear(new ElementResolver(), { text: "Edit" })(observation).matched).toBe(false);
  });

  test("a scoped wait keeps the resolver's single choice", () => {
    const observation = editObservation([{ top: 850 }, { top: 100, left: 200 }]);
    const selector = { text: "Edit", selectionStrategy: "first" as const };

    expect(appear(new ElementResolver(), selector)(observation).matched).toBe(false);
  });

  test("with no usable screen size every bounded node stays eligible", () => {
    const unknown = editObservation([{ top: 850 }], { width: 0, height: 0 });

    expect(appear(new ElementResolver(), { text: "Edit" })(unknown).matched).toBe(true);
  });
});

/** Clickable rows at each `top`, each holding an "Edit" label with no bounds of its own. */
function rowsWithUnboundedEdit(tops: number[]): ObserveResult {
  return createObserveResultForTest({
    screenSize,
    viewHierarchy: {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 400, bottom: 800 },
          node: tops.map((top) => ({
            clickable: "true",
            bounds: { left: 0, top, right: 400, bottom: top + 60 },
            node: [{ text: "Edit" }],
          })),
        },
      },
    },
  });
}

describe("an unbounded alternative source is judged against its own match (#17042)", () => {
  test("appear takes the on-screen row when the resolver chose the off-screen one", () => {
    const observation = rowsWithUnboundedEdit([850, 100]);
    const evaluation = appear(new ElementResolver(), { text: "Edit" })(observation);

    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement?.bounds.top).toBe(100);
    expect(disappear(new ElementResolver(), { text: "Edit" })(observation).matched).toBe(false);
  });

  test("appear still refuses when every row is off screen", () => {
    const observation = rowsWithUnboundedEdit([850, 900]);

    expect(appear(new ElementResolver(), { text: "Edit" })(observation).matched).toBe(false);
    expect(disappear(new ElementResolver(), { text: "Edit" })(observation).matched).toBe(true);
  });

  test("a scoped wait keeps the resolver's single choice", () => {
    const observation = rowsWithUnboundedEdit([850, 100]);
    const selector = { text: "Edit", selectionStrategy: "first" as const };

    expect(appear(new ElementResolver(), selector)(observation).matched).toBe(false);
  });
});

describe("capture metadata sets the wait's screen size before the observation's (#17042)", () => {
  /** An "Edit" node at top 850 whose capture metadata and observation disagree on height. */
  function withHeights(metadataHeight: number, observationHeight: number): ObserveResult {
    const observation = editObservation([{ top: 850 }], { width: 400, height: observationHeight });
    return {
      ...observation,
      viewHierarchy: {
        ...observation.viewHierarchy!,
        screenWidth: 400,
        screenHeight: metadataHeight,
      },
    };
  }

  test("taller metadata puts the node on screen over a shorter observation size", () => {
    expect(appear(new ElementResolver(), { text: "Edit" })(withHeights(1000, 800)).matched).toBe(
      true,
    );
  });

  test("shorter metadata keeps the node off screen over a taller observation size", () => {
    expect(appear(new ElementResolver(), { text: "Edit" })(withHeights(800, 1000)).matched).toBe(
      false,
    );
  });
});
