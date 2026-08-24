import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import {
  clickable,
  countStable,
  disappear,
  textEquals,
} from "../../../src/features/observe/ConditionPredicates";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";

/**
 * Unit tests for the declarative condition-predicate builders that back the
 * observe `waitFor` DSL and the standalone `waitForCondition` tool (issue #4398).
 *
 * `appear` / `disappear` are already covered in `WaitForCondition.test.ts`; this
 * file pins the remaining builders — `clickable`, `textEquals`, `countStable` —
 * as pure functions, driving each returned predicate directly (no poll loop, no
 * device, no DB). `stable` is deliberately NOT a predicate: the DSL routes it to
 * `RealSettleObserve` (whole-screen settle), so it has no builder here.
 */

/** Build an ObserveResult wrapping a single root node with the given children. */
function obs(children: Record<string, unknown>[]): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      hierarchy: {
        node: {
          "resource-id": "root",
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          node: children,
        },
      },
    },
  } as ObserveResult;
}

/** An ObserveResult with no hierarchy — the loop's screen-off / no-data shape. */
function emptyObs(): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
  } as ObserveResult;
}

function node(props: Record<string, unknown>): Record<string, unknown> {
  return { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, ...props };
}

describe("clickable predicate", () => {
  const finder = new DefaultElementFinder();

  test("matches when the selector's element is present AND clickable", () => {
    const predicate = clickable(finder, { elementId: "submit" });
    const evaluation = predicate(
      obs([node({ "resource-id": "submit", text: "Go", clickable: true })]),
    );
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement!["resource-id"]).toBe("submit");
  });

  test("accepts the string-typed clickable attribute ('true')", () => {
    const predicate = clickable(finder, { elementId: "submit" });
    const evaluation = predicate(
      obs([node({ "resource-id": "submit", text: "Go", clickable: "true" })]),
    );
    expect(evaluation.matched).toBe(true);
  });

  test("matches an element tappable via a 'click' accessibility action (clickable unset) — the iOS/tapOn signal", () => {
    const predicate = clickable(finder, { elementId: "submit" });
    const evaluation = predicate(
      obs([node({ "resource-id": "submit", text: "Go", actions: ["click"] })]),
    );
    expect(evaluation.matched).toBe(true);
  });

  test("does NOT match a present-but-not-clickable element, surfacing it as a candidate", () => {
    const predicate = clickable(finder, { elementId: "submit" });
    const evaluation = predicate(
      obs([node({ "resource-id": "submit", text: "Go", clickable: false })]),
    );
    expect(evaluation.matched).toBe(false);
    expect(evaluation.candidates!.some((c) => c["resource-id"] === "submit")).toBe(true);
  });

  test("does NOT match when the element is absent", () => {
    const predicate = clickable(finder, { elementId: "submit" });
    const evaluation = predicate(
      obs([node({ "resource-id": "other", text: "x", clickable: true })]),
    );
    expect(evaluation.matched).toBe(false);
  });

  test("no hierarchy reads as no-match, not a throw", () => {
    const predicate = clickable(finder, { elementId: "submit" });
    const evaluation = predicate(emptyObs());
    expect(evaluation.matched).toBe(false);
    expect(evaluation.candidates).toEqual([]);
  });

  test("only evaluates a matching element inside its container", () => {
    const predicate = clickable(finder, {
      elementId: "submit",
      container: { elementId: "checkout" },
    });
    const evaluation = predicate(
      obs([
        node({
          "resource-id": "other",
          node: [node({ "resource-id": "submit", clickable: true })],
        }),
        node({
          "resource-id": "checkout",
          node: [node({ "resource-id": "submit", clickable: false })],
        }),
      ]),
    );
    expect(evaluation.matched).toBe(false);
  });
});

describe("textEquals predicate", () => {
  const finder = new DefaultElementFinder();

  test("matches when the element located by elementId shows the expected text EXACTLY", () => {
    const predicate = textEquals(finder, { elementId: "counter" }, "5");
    const evaluation = predicate(obs([node({ "resource-id": "counter", text: "5" })]));
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement!.text).toBe("5");
  });

  test("does NOT match on a substring/partial text (exactness required)", () => {
    const predicate = textEquals(finder, { elementId: "counter" }, "5");
    const evaluation = predicate(obs([node({ "resource-id": "counter", text: "50" })]));
    expect(evaluation.matched).toBe(false);
    // The located element is surfaced so a timeout shows what value it was stuck on.
    expect(evaluation.candidates!.some((c) => c.text === "50")).toBe(true);
  });

  test("without an elementId, matches any element whose text equals the expected value exactly", () => {
    const predicate = textEquals(finder, {}, "Done");
    const evaluation = predicate(obs([node({ "resource-id": "label", text: "Done" })]));
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement!.text).toBe("Done");
  });

  test("does NOT match when the located element is absent", () => {
    const predicate = textEquals(finder, { elementId: "counter" }, "5");
    const evaluation = predicate(obs([node({ "resource-id": "other", text: "5" })]));
    expect(evaluation.matched).toBe(false);
  });

  test("does not use an exact-text match outside its container", () => {
    const predicate = textEquals(
      finder,
      { elementId: "counter", container: { elementId: "checkout" } },
      "5",
    );
    const evaluation = predicate(
      obs([
        node({ "resource-id": "other", node: [node({ "resource-id": "counter", text: "5" })] }),
        node({ "resource-id": "checkout", node: [node({ "resource-id": "counter", text: "4" })] }),
      ]),
    );
    expect(evaluation.matched).toBe(false);
  });
});

describe("countStable predicate", () => {
  const finder = new DefaultElementFinder();

  test("becomes stable once the matching-element count repeats for stableReads polls (default 2)", () => {
    const predicate = countStable(finder, { elementId: "row" });
    // Poll 1: 2 rows -> first read, run=1, not yet stable.
    const first = predicate(
      obs([node({ "resource-id": "row", text: "a" }), node({ "resource-id": "row", text: "b" })]),
    );
    expect(first.matched).toBe(false);
    // Poll 2: 3 rows -> count changed, run resets.
    const second = predicate(
      obs([
        node({ "resource-id": "row", text: "a" }),
        node({ "resource-id": "row", text: "b" }),
        node({ "resource-id": "row", text: "c" }),
      ]),
    );
    expect(second.matched).toBe(false);
    // Poll 3: still 3 rows -> count matches previous, run=2 >= 2 -> stable.
    const third = predicate(
      obs([
        node({ "resource-id": "row", text: "a" }),
        node({ "resource-id": "row", text: "b" }),
        node({ "resource-id": "row", text: "c" }),
      ]),
    );
    expect(third.matched).toBe(true);
    expect(third.candidates!.length).toBe(3);
  });

  test("honors an explicit stableReads (3 consecutive equal counts)", () => {
    const predicate = countStable(finder, { elementId: "row" }, { stableReads: 3 });
    const rows = obs([node({ "resource-id": "row", text: "a" })]);
    expect(predicate(rows).matched).toBe(false); // run=1
    expect(predicate(obs([node({ "resource-id": "row", text: "a" })])).matched).toBe(false); // run=2
    expect(predicate(obs([node({ "resource-id": "row", text: "a" })])).matched).toBe(true); // run=3
  });

  test("a fluctuating count never settles (relies on the loop's timeout)", () => {
    const predicate = countStable(finder, { elementId: "row" });
    expect(predicate(obs([node({ "resource-id": "row", text: "a" })])).matched).toBe(false);
    expect(
      predicate(
        obs([node({ "resource-id": "row", text: "a" }), node({ "resource-id": "row", text: "b" })]),
      ).matched,
    ).toBe(false);
    expect(predicate(obs([node({ "resource-id": "row", text: "a" })])).matched).toBe(false);
  });

  test("counts only matches in its container", () => {
    const predicate = countStable(finder, {
      elementId: "row",
      container: { elementId: "checkout" },
    });
    expect(
      predicate(
        obs([
          node({ "resource-id": "other", node: [node({ "resource-id": "row" })] }),
          node({ "resource-id": "checkout", node: [] }),
        ]),
      ).matched,
    ).toBe(false);
    expect(
      predicate(
        obs([
          node({
            "resource-id": "other",
            node: [node({ "resource-id": "row" }), node({ "resource-id": "row" })],
          }),
          node({ "resource-id": "checkout", node: [] }),
        ]),
      ).matched,
    ).toBe(true);
  });
});

describe("disappear predicate", () => {
  const finder = new DefaultElementFinder();

  test("treats a matching element outside its container as absent", () => {
    const predicate = disappear(finder, {
      elementId: "spinner",
      container: { elementId: "checkout" },
    });
    const evaluation = predicate(
      obs([
        node({ "resource-id": "other", node: [node({ "resource-id": "spinner" })] }),
        node({ "resource-id": "checkout", node: [] }),
      ]),
    );
    expect(evaluation.matched).toBe(true);
  });
});
