import { expect, test } from "bun:test";
import { appear, disappear } from "../../../src/features/observe/ConditionPredicates";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import type { ObserveResult } from "../../../src/models";

const bounds = { left: 0, top: 0, right: 20, bottom: 20 };
const observation = (...nodes: object[]): ObserveResult =>
  ({
    viewHierarchy: { hierarchy: { node: nodes.map((node) => ({ bounds, ...node })) } },
  }) as ObserveResult;

test("positive waits lock contains mode when the first poll falls back from exact", () => {
  const modes: Array<string | undefined> = [];
  const elementResolver = new ElementResolver();
  const resolver = {
    resolve: (
      snapshot: Parameters<ElementResolver["resolve"]>[0],
      selector: Parameters<ElementResolver["resolve"]>[1],
      intent: Parameters<ElementResolver["resolve"]>[2],
    ) => {
      modes.push(intent.matchMode);
      return elementResolver.resolve(snapshot, selector, intent);
    },
  };
  const predicate = appear(resolver, { text: "Account" });
  expect(predicate(observation({ text: "Account settings" })).matched).toBe(true);
  expect(predicate(observation({ text: "Account settings" }, { text: "Account" })).matched).toBe(
    true,
  );
  expect(modes).toEqual([undefined, "contains"]);
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

test("textEquals compares original text rather than toggle display labels or promoted parents", async () => {
  const { textEquals } = await import("../../../src/features/observe/ConditionPredicates");
  const toggle = observation({
    "resource-id": "toggle",
    checkable: true,
    "content-desc": "Wi-Fi",
    text: "On",
  });
  expect(textEquals(new ElementResolver(), { elementId: "toggle" }, "On")(toggle).matched).toBe(
    true,
  );
  expect(textEquals(new ElementResolver(), { elementId: "toggle" }, "Wi-Fi")(toggle).matched).toBe(
    false,
  );
  const nested = observation({
    clickable: true,
    text: "Parent",
    node: [{ text: "Ready", bounds }],
  });
  expect(textEquals(new ElementResolver(), {}, "Ready")(nested).matched).toBe(true);
});
