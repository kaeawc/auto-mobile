import { describe, expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import { waitForSchema } from "../../../src/features/observe/wait/WaitForSchemas";
import { evaluateWaitForObservation } from "../../../src/features/observe/wait/WaitPredicates";
import { ElementResolver, type MatchMode } from "../../../src/features/utility/ElementResolver";
import { expectationQuery } from "../../../src/utils/plan/stepExpectations";
import { createObserveResultForTest } from "../../features/observe/flatHierarchyBuilders";

// textEquals / textContains expectations compare what the element shows, not a content
// description that happens to carry the expected value (#16875).

const screenSize = { width: 400, height: 800 };

function counter(text: string, contentDescription?: string): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { bounds: { left: 0, top: 0, right: 400, bottom: 800 } },
        node: [
          {
            $: {
              class: "android.widget.TextView",
              "resource-id": "example.app:id/counter",
              "test-tag": "counter_value",
              text,
              ...(contentDescription === undefined ? {} : { "content-desc": contentDescription }),
              bounds: { left: 20, top: 100, right: 220, bottom: 160 },
            },
          },
        ],
      },
    },
    screenWidth: 400,
    screenHeight: 800,
  };
}

function holds(expectation: Record<string, unknown>, hierarchy: ViewHierarchyResult): boolean {
  const query = expectationQuery(expectation);
  if (query.kind !== "evaluate") {
    throw new Error(`expected an evaluable expectation, got ${query.kind}`);
  }
  // The executor parses the waitFor through the observe schema, so this does too.
  const waitFor = waitForSchema.parse(query.waitFor);
  return evaluateWaitForObservation(
    new ElementResolver(),
    waitFor,
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
  ).matched;
}

const selectors = [
  ["testTag", { testTag: "counter_value" }],
  ["id", { resourceId: "example.app:id/counter" }],
] as const;

describe("textEquals / textContains expectations compare the displayed text (#16875)", () => {
  test.each(selectors)(
    "textEquals by %s fails when only the content description matches",
    (_, selector) => {
      expect(
        holds({ type: "textEquals", selector, text: "Ready" }, counter("Wrong", "Ready")),
      ).toBe(false);
    },
  );

  test.each(selectors)("textEquals by %s passes when the displayed text matches", (_, selector) => {
    expect(holds({ type: "textEquals", selector, text: "Ready" }, counter("Ready", "Wrong"))).toBe(
      true,
    );
  });

  test.each(selectors)(
    "textContains by %s fails when only the content description contains it",
    (_, selector) => {
      expect(
        holds({ type: "textContains", selector, text: "Rea" }, counter("Wrong", "Ready now")),
      ).toBe(false);
    },
  );

  test.each(selectors)(
    "textContains by %s passes when the displayed text contains it",
    (_, selector) => {
      expect(
        holds({ type: "textContains", selector, text: "Rea" }, counter("Ready now", "Wrong")),
      ).toBe(true);
    },
  );

  test("a textEquals without a selector ignores content descriptions too", () => {
    expect(holds({ type: "textEquals", text: "Ready" }, counter("Wrong", "Ready"))).toBe(false);
    expect(holds({ type: "textEquals", text: "Ready" }, counter("Ready"))).toBe(true);
  });

  test("elementVisible still matches selector.text against any text source", () => {
    expect(
      holds(
        { type: "elementVisible", selector: { testTag: "counter_value", text: "Ready" } },
        counter("Wrong", "Ready"),
      ),
    ).toBe(true);
  });

  test("a displayed regex wait keeps the resolver's case and quote folding", () => {
    const matches = (text: string, hierarchy: ViewHierarchyResult) =>
      evaluateWaitForObservation(
        new ElementResolver(),
        waitForSchema.parse({
          testTag: "counter_value",
          text,
          textMatch: "regex",
          textSource: "displayed",
        }),
        createObserveResultForTest({
          screenSize,
          viewHierarchy: hierarchy,
          elements: new ObserveElementsBuilder().build(hierarchy, "android"),
        }),
        {
          devicePlatform: "android",
          displayInventory: "single",
          modes: new Map(),
          iosMultiPanel: false,
        },
      ).matched;
    expect(matches("^ready$", counter("Ready"))).toBe(true);
    expect(matches("^it's on$", counter("It\u2019s on"))).toBe(true);
    expect(matches("^ready$", counter("Wrong", "Ready"))).toBe(false);
  });

  test("the observe schema refuses textSource without text", () => {
    expect(waitForSchema.safeParse({ testTag: "a", textSource: "displayed" }).success).toBe(false);
    expect(waitForSchema.safeParse({ text: "a", textSource: "displayed" }).success).toBe(true);
    expect(
      waitForSchema.safeParse({ for: "appear", text: "a", textSource: "displayed" }).success,
    ).toBe(false);
  });
});
