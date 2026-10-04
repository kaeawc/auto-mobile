import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import {
  appear,
  clickable,
  countStable,
  disappear,
  textEquals,
} from "../../../src/features/observe/ConditionPredicates";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import type { ConditionResolver } from "../../../src/features/observe/ConditionPredicates";
import type { SearchableEntry } from "../../../src/features/utility/SearchableNode";

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
function obs(children: Record<string, unknown>[], rootBounds = true): ObserveResult {
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
          ...(rootBounds ? { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } : {}),
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
  const finder = new ElementResolver();

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

  test("reports a partial ID as a timeout candidate when the exact clickable ID is absent", () => {
    const evaluation = clickable(finder, { elementId: "submit" })(
      obs([node({ "resource-id": "submit_help", clickable: true })]),
    );
    expect(evaluation.matched).toBe(false);
    expect(evaluation.candidates?.map((candidate) => candidate["resource-id"])).toEqual([
      "submit_help",
    ]);
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

  test("does not borrow tap affordance from a promoted parent", () => {
    const predicate = clickable(finder, { text: "Submit" });
    const evaluation = predicate(
      obs([
        node({
          "resource-id": "row",
          clickable: true,
          node: [node({ text: "Submit", clickable: false })],
        }),
      ]),
    );
    expect(evaluation.matched).toBe(false);
  });
});

test("appear retains partial ID candidates for an exact ID miss", () => {
  const evaluation = appear(new ElementResolver(), { elementId: "submit" })(
    obs([node({ "resource-id": "submit_help" })]),
  );
  expect(evaluation.matched).toBe(false);
  expect(evaluation.candidates?.map((candidate) => candidate["resource-id"])).toContain(
    "submit_help",
  );
});

test("positive text appearance falls back to contains after exact matching", () => {
  const observation = obs([node({ text: "Submit now", clickable: true })]);
  expect(appear(new ElementResolver(), { text: "Submit" })(observation).matched).toBe(true);
  expect(clickable(new ElementResolver(), { text: "Submit" })(observation).matched).toBe(false);
  const stable = countStable(new ElementResolver(), { text: "Submit" });
  expect(stable(observation).candidates).toEqual([]);
});

test("positive text appearance prefers an exact node when it exists", () => {
  const evaluation = appear(new ElementResolver(), { text: "Account" })(
    obs([node({ text: "Account settings" }), node({ text: "Account" })]),
  );
  expect(evaluation.matched).toBe(true);
  expect(evaluation.matchedElement?.text).toBe("Account");
});

test("disappear does not treat a substring as a matching text node", () => {
  expect(
    disappear(new ElementResolver(), { text: "Account" })(obs([node({ text: "Account settings" })]))
      .matched,
  ).toBe(true);
});

test("text containers retain contains matching ahead of a later exact peer", () => {
  const evaluation = appear(new ElementResolver(), {
    elementId: "submit",
    container: { text: "Settings" },
  })(
    obs([
      node({ text: "Settings panel", node: [node({ "resource-id": "submit" })] }),
      node({ text: "Settings" }),
    ]),
  );
  expect(evaluation.matched).toBe(true);
  expect(evaluation.matchedElement?.["resource-id"]).toBe("submit");
});

test("appear reports the matching child rather than its promoted row", () => {
  const evaluation = appear(new ElementResolver(), { text: "Ready" })(
    obs([node({ clickable: true, node: [node({ text: "Ready" })] })]),
  );
  expect(evaluation.matched).toBe(true);
  expect(evaluation.matchedElement?.text).toBe("Ready");
  expect(evaluation.candidates?.[0]?.text).toBe("Ready");
});

test("appear uses a bounded scroll-only ancestor for bounds-less matching text", () => {
  const evaluation = appear(new ElementResolver(), { text: "Ghost" })(
    obs([node({ "resource-id": "list", scrollable: true, node: [{ text: "Ghost" }] })]),
  );
  expect(evaluation.matched).toBe(true);
  expect(evaluation.matchedElement?.["resource-id"]).toBe("list");
});

test("disappear waits until bounds-less matching text leaves its bounded scroll-only ancestor", () => {
  const predicate = disappear(new ElementResolver(), { text: "Ghost" });
  const present = obs([
    node({ "resource-id": "list", scrollable: true, node: [{ text: "Ghost" }] }),
  ]);
  expect(predicate(present).matched).toBe(false);
  expect(predicate(obs([node({ "resource-id": "list", scrollable: true })])).matched).toBe(true);
});

test("presence waits ignore matching nodes without bounds", () => {
  const observation = obs([{ "resource-id": "ghost", text: "Ghost" }], false);
  const resolver = new ElementResolver();
  expect(appear(resolver, { elementId: "ghost" })(observation).matched).toBe(false);
  expect(disappear(resolver, { elementId: "ghost" })(observation).matched).toBe(true);
  expect(appear(resolver, { text: "Ghost" })(observation).matched).toBe(false);
  expect(disappear(resolver, { text: "Ghost" })(observation).matched).toBe(true);
});

test("presence waits reject an unbounded chosen node from an inspect resolver", () => {
  const chosen = { textSources: {}, element: undefined, bounds: undefined } as SearchableEntry;
  const intents: Array<{ requireBounds?: boolean }> = [];
  const resolver: ConditionResolver = {
    resolve: (_snapshot, _selector, intent) => {
      intents.push(intent);
      return {
        chosen,
        matches: [{ node: chosen, kind: "native-id-exact" }],
        candidates: [chosen],
        matchMode: "exact",
      };
    },
  };
  const observation = obs([node({ "resource-id": "ghost" })]);
  expect(appear(resolver, { elementId: "ghost" })(observation)).toMatchObject({ matched: false });
  expect(disappear(resolver, { elementId: "ghost" })(observation)).toMatchObject({ matched: true });
  expect(intents.map((intent) => intent.requireBounds)).toEqual([true, true]);
});

describe("textEquals predicate", () => {
  const finder = new ElementResolver();

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

  test("does not ignore literal surrounding whitespace in an exact value", () => {
    const observation = obs([node({ "resource-id": "counter", text: " 5 " })]);
    expect(textEquals(finder, { elementId: "counter" }, "5")(observation).matched).toBe(false);
    expect(textEquals(finder, {}, "5")(observation).matched).toBe(false);
    expect(textEquals(finder, { elementId: "counter" }, " 5 ")(observation).matched).toBe(true);
  });

  test("without an elementId, matches any element whose text equals the expected value exactly", () => {
    const predicate = textEquals(finder, {}, "Done");
    const evaluation = predicate(obs([node({ "resource-id": "label", text: "Done" })]));
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement!.text).toBe("Done");
  });

  test("reports partial text as a timeout candidate when locator-less exact text is absent", () => {
    const evaluation = textEquals(finder, {}, "Ready")(obs([node({ text: "Ready soon" })]));
    expect(evaluation.matched).toBe(false);
    expect(evaluation.candidates?.map((candidate) => candidate.text)).toEqual(["Ready soon"]);
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

  test("textEquals retains contains matching for a text container", () => {
    const predicate = textEquals(
      finder,
      { elementId: "status", container: { text: "Settings" } },
      "Ready",
    );
    const evaluation = predicate(
      obs([
        node({ text: "Settings panel", node: [node({ "resource-id": "status", text: "Ready" })] }),
        node({ text: "Settings" }),
      ]),
    );
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement?.text).toBe("Ready");
  });
});

describe("countStable predicate", () => {
  const finder = new ElementResolver();

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
  const finder = new ElementResolver();

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

describe("scoped wait predicates", () => {
  const resolver = new ElementResolver(() => 0.9);
  const container = { elementId: "item_42", container: { elementId: "cart_A" } };
  const selector = { elementId: "remove", container, selectionStrategy: "unique" as const };
  const remove = () => node({ "resource-id": "remove", text: "Remove", clickable: true });
  const cart = (id: string, leaves: Record<string, unknown>[]) =>
    node({
      "resource-id": id,
      node: [
        {
          node: [
            node({ "resource-id": "item_42", node: [{ node: leaves }] }),
            node({ "resource-id": "item_73", node: [remove()] }),
          ],
        },
      ],
    });

  test("nested appear excludes other carts across anonymous wrappers", () => {
    const evaluation = appear(
      resolver,
      selector,
    )(obs([cart("cart_B", [remove()]), cart("cart_A", [remove()])]));
    expect(evaluation.matched).toBe(true);
    expect(evaluation.candidates).toHaveLength(1);
    expect(
      appear(resolver, selector)(obs([cart("cart_B", [remove()]), cart("cart_A", [])])).matched,
    ).toBe(false);
  });

  test("scoped disappear requires a resolved scope and ignores an outside leaf", () => {
    const predicate = disappear(resolver, selector);
    expect(predicate(obs([cart("cart_B", [remove()])])).matched).toBe(false);
    expect(predicate(obs([cart("cart_B", [remove()]), cart("cart_A", [])])).matched).toBe(true);
    expect(predicate(obs([cart("cart_A", [remove()])])).matched).toBe(false);
  });

  test("unique leaf ambiguity keeps polling with bounded target diagnostics", () => {
    const evaluation = appear(
      resolver,
      selector,
    )(obs([cart("cart_A", Array.from({ length: 8 }, remove))]));
    expect(evaluation.matched).toBe(false);
    expect(evaluation).toMatchObject({
      diagnostic: expect.stringContaining("Target ambiguous: 8 matches"),
    });
    expect(evaluation.candidates).toHaveLength(5);
  });

  test("unique outer container ambiguity is not proof of presence or absence", () => {
    const observation = obs([cart("cart_A", [remove()]), cart("cart_A", [])]);
    const evaluation = appear(resolver, selector)(observation);
    expect(evaluation.matched).toBe(false);
    expect(evaluation).toMatchObject({
      diagnostic: expect.stringContaining("Container level 1 ambiguous"),
    });
    expect(evaluation.candidates).toHaveLength(2);
    expect(disappear(resolver, selector)(observation).matched).toBe(false);
  });

  test("missing and indexed-out-of-range scopes block every scoped predicate", () => {
    for (const selected of [selector, { ...selector, container: { ...container, index: 9 } }]) {
      const observation = obs([
        cart("cart_B", [remove()]),
        ...("index" in selected.container ? [cart("cart_A", [remove()])] : []),
      ]);
      for (const predicate of [
        appear(resolver, selected),
        disappear(resolver, selected),
        clickable(resolver, selected),
        textEquals(resolver, selected, "Remove"),
      ]) {
        expect(predicate(observation).matched).toBe(false);
      }
      const stable = countStable(resolver, selected);
      expect(stable(observation).matched).toBe(false);
      expect(stable(observation).matched).toBe(false);
    }
  });

  test("unique textEquals and clickable do not pick one ambiguous leaf", () => {
    const observation = obs([cart("cart_A", [remove(), remove()])]);
    expect(clickable(resolver, selector)(observation).matched).toBe(false);
    expect(
      textEquals(resolver, { ...selector, text: "Remove" }, "Remove")(observation).matched,
    ).toBe(false);
  });

  test("per-level index overrides unique and explicit random selects a leaf", () => {
    const observation = obs([
      cart("cart_A", []),
      cart("cart_A", [remove(), node({ "resource-id": "remove", text: "Second" })]),
    ]);
    const indexed = {
      ...selector,
      container: { ...container, container: { elementId: "cart_A", index: 1 } },
    };
    expect(appear(resolver, indexed)(observation).matched).toBe(false);
    const random = { ...indexed, selectionStrategy: "random" as const };
    expect(appear(resolver, random)(observation).matchedElement?.text).toBe("Second");
  });

  test("legacy missing flat container disappear and unscoped appear stay compatible", () => {
    expect(
      disappear(resolver, { elementId: "remove", container: { elementId: "missing" } })(obs([]))
        .matched,
    ).toBe(true);
    expect(appear(resolver, { elementId: "remove" })(obs([remove(), remove()])).matched).toBe(true);
  });
});

test("disappear by hint succeeds once an Android field is filled", () => {
  const observation = obs([
    node({
      class: "android.widget.EditText",
      text: "5551234",
      "hint-text": "Phone",
      focusable: true,
    }),
  ]);
  const evaluation = disappear(new ElementResolver(), { text: "Phone" })(observation);
  expect(evaluation.matched).toBe(true);
});

test("appear by hint does not match a filled Android field", () => {
  const observation = obs([
    node({
      class: "android.widget.EditText",
      text: "5551234",
      "hint-text": "Phone",
      focusable: true,
    }),
  ]);
  expect(appear(new ElementResolver(), { text: "Phone" })(observation).matched).toBe(false);
});
