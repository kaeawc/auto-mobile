import { expect, test } from "bun:test";
import { appear, disappear, countStable } from "../../../src/features/observe/ConditionPredicates";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import type { ObserveResult } from "../../../src/models";

const bounds = { left: 0, top: 0, right: 20, bottom: 20 };
const observation = (...nodes: object[]): ObserveResult =>
  ({
    viewHierarchy: { hierarchy: { node: nodes.map((node) => ({ bounds, ...node })) } },
  }) as ObserveResult;

test("positive waits fall back once and keep the same mode across later polls", () => {
  const predicate = countStable(new ElementResolver(), { text: "Account" });
  expect(predicate(observation({ text: "Account settings" })).matched).toBe(false);
  const next = predicate(observation({ text: "Account settings" }, { text: "Account" }));
  expect(next.candidates).toHaveLength(2);
  expect(next.matched).toBe(false);
});

test("exact-first wait does not switch to contains if the exact label later disappears", () => {
  const predicate = appear(new ElementResolver(), { text: "Account" });
  expect(predicate(observation({ text: "Account" }, { text: "Account settings" })).matched).toBe(
    true,
  );
  expect(predicate(observation({ text: "Account settings" })).matched).toBe(false);
});

test("negative predicates never substring-fallback", () => {
  expect(
    disappear(new ElementResolver(), { text: "Account" })(observation({ text: "Account settings" }))
      .matched,
  ).toBe(true);
});

test("wait predicates use namespace IDs and observed node keys without substring collisions", () => {
  const resolver = new ElementResolver();
  const capture = observation(
    { "resource-id": "app:id/login_help" },
    { "resource-id": "app:id/login" },
    { "view-id": "s-captured" },
  );
  expect(appear(resolver, { elementId: "login" })(capture).matchedElement?.["resource-id"]).toBe(
    "app:id/login",
  );
  expect(appear(resolver, { elementId: "s-captured" })(capture).matched).toBe(true);
  expect(appear(resolver, { elementId: "log" })(capture).matched).toBe(false);
});

test("an editable iOS value displayed by observe is searchable by a wait", () => {
  const capture = observation({
    class: "XCUIElementTypeTextField",
    actions: ["set_text"],
    value: "Don’t panic",
    text: "Placeholder",
  });
  expect(appear(new ElementResolver(), { text: "Don't panic" })(capture).matched).toBe(true);
});
