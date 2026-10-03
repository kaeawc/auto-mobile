import { expect, test } from "bun:test";
import {
  appendSwipeScope,
  scopedSearchDescription,
  requiresUniqueScope,
  bindSwipeScope,
  usesScopedSwipeContainer,
  usesScopedSwipeLookFor,
  resolveSwipeLookFor,
} from "../../../../src/features/action/swipeon/swipeSelectorScopes";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import {
  toSearchable,
  type SearchableEntry,
} from "../../../../src/features/utility/SearchableNode";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { Element, SwipeOnOptions } from "../../../../src/models";

// Same typed toSearchable fixture pattern as ElementSearchDebugContext.test.ts.
function entry(text: string, index: number, parentIndex?: number): SearchableEntry {
  const bounds = { left: 0, top: 0, right: 20, bottom: 20 };
  const element: Element = { text, bounds, clickable: true };
  return {
    ...toSearchable(element),
    source: { bounds },
    properties: element,
    element,
    depth: parentIndex === undefined ? 0 : 1,
    index,
    parentIndex,
    rootGroup: 0,
    windowRank: 0,
  };
}

const options = (overrides: Partial<SwipeOnOptions> = {}): SwipeOnOptions => ({
  direction: "up",
  ...overrides,
});

test("appendSwipeScope retains unscoped identity and appends outermost ancestor immutably", () => {
  const swipe = { text: "swipe" };
  expect(appendSwipeScope(undefined, undefined)).toBeUndefined();
  expect(appendSwipeScope(undefined, swipe)).toBe(swipe);
  const scope = { text: "leaf", container: { text: "parent" } };
  const before = structuredClone(scope);
  expect(appendSwipeScope(scope, swipe)).toEqual({
    text: "leaf",
    container: { text: "parent", container: swipe },
  });
  expect(appendSwipeScope(scope, undefined)).toEqual({
    text: "leaf",
    container: { text: "parent", container: undefined },
  });
  expect(scope).toEqual(before);
  expect(swipe).toEqual({ text: "swipe" });
});

test("description is outermost first, prefers elementId, and hides plain unscoped containers", () => {
  expect(scopedSearchDescription(options())).toBe("");
  expect(scopedSearchDescription(options({ container: { text: "plain" } }))).toBe("");
  expect(
    scopedSearchDescription(
      options({
        container: { elementId: "a", text: "ignored", index: 0 },
        lookFor: { text: "target", container: { text: "b" } },
      }),
    ),
  ).toBe(' within container scope "a" > "b"');
  expect(
    scopedSearchDescription(options({ lookFor: { text: "target", selectionStrategy: "unique" } })),
  ).toBe("");
});

test("unique scope is required by target or any ancestor and not other strategies", () => {
  expect(requiresUniqueScope({ selectionStrategy: "unique" })).toBe(true);
  expect(requiresUniqueScope({ container: { text: "a", selectionStrategy: "unique" } })).toBe(true);
  expect(
    requiresUniqueScope({
      container: { text: "a", container: { text: "b", selectionStrategy: "unique" } },
    }),
  ).toBe(true);
  expect(requiresUniqueScope({})).toBe(false);
  expect(
    requiresUniqueScope({
      selectionStrategy: "random",
      container: { text: "a", selectionStrategy: "random" },
    }),
  ).toBe(false);
});

test("binding missing elements preserves nodes; matching requires object identity", () => {
  const nodes = [entry("scope", 0)];
  for (const element of [undefined, { ...nodes[0].element }]) {
    const bound = bindSwipeScope(nodes, element);
    expect(bound.nodes).toBe(nodes);
    expect(bound.container).toBeUndefined();
  }
});

test("binding only copies the selected node without mutating the input", () => {
  const nodes = [entry("scope", 0), entry("target", 1, 0)];
  const before = structuredClone(nodes);
  const bound = bindSwipeScope(nodes, nodes[0].element);
  expect(bound.container).toEqual({ elementId: "swipe-resolved-scope" });
  expect(bound.nodes[0]).toEqual({ ...nodes[0], nodeKey: "swipe-resolved-scope" });
  expect(bound.nodes[0]).not.toBe(nodes[0]);
  expect(bound.nodes[1]).toBe(nodes[1]);
  expect(nodes).toEqual(before);
});

test("binding avoids nativeId and nodeKey collisions including multiple underscores", () => {
  for (const field of ["nativeId", "nodeKey"] as const) {
    const nodes = [
      entry("scope", 0),
      { ...entry("collision", 1), [field]: "swipe-resolved-scope" },
    ];
    expect(bindSwipeScope(nodes, nodes[0].element).container).toEqual({
      elementId: "swipe-resolved-scope_",
    });
  }
  const nodes = [
    entry("scope", 0),
    { ...entry("a", 1), nativeId: "swipe-resolved-scope" },
    { ...entry("b", 2), nodeKey: "swipe-resolved-scope_" },
    { ...entry("c", 3), nativeId: "swipe-resolved-scope__" },
  ];
  expect(bindSwipeScope(nodes, nodes[0].element).container).toEqual({
    elementId: "swipe-resolved-scope___",
  });
});

test("container scoping recognizes index, strategy, and nesting; lookFor ignores index", () => {
  expect(usesScopedSwipeContainer(undefined)).toBe(false);
  expect(usesScopedSwipeContainer({ text: "plain" })).toBe(false);
  for (const container of [
    { text: "a", index: 0 },
    { text: "a", selectionStrategy: "random" as const },
    { text: "a", container: { text: "b" } },
  ]) {
    expect(usesScopedSwipeContainer(container)).toBe(true);
  }
  expect(usesScopedSwipeLookFor(undefined)).toBe(false);
  expect(usesScopedSwipeLookFor({ text: "plain" })).toBe(false);
  expect(usesScopedSwipeLookFor({ selectionStrategy: "random" })).toBe(true);
  expect(usesScopedSwipeLookFor({ container: { text: "b" } })).toBe(true);
  // lookFor's public type omits index; an extra runtime field alone does not enable scoping.
  const indexed = { text: "a", index: 0 };
  expect(usesScopedSwipeLookFor(indexed)).toBe(false);
});

const resolver = new ElementResolver(() => 0);
function resolve(
  nodes: readonly SearchableEntry[],
  lookFor: NonNullable<SwipeOnOptions["lookFor"]>,
  container?: SwipeOnOptions["container"],
  containerElement?: Element,
) {
  return resolveSwipeLookFor({
    nodes,
    lookFor,
    container,
    containerElement,
    resolver,
    id: "test-frame",
  });
}

test("real resolver returns source element or null for empty, absent target and missing scope", () => {
  const nodes = [entry("target", 0)];
  expect(resolve(nodes, {})).toBeNull();
  expect(resolve(nodes, { text: "", elementId: "" })).toBeNull();
  expect(resolve(nodes, { text: "target" })).toBe(nodes[0].element);
  expect(resolve(nodes, { text: "missing" })).toBeNull();
  expect(resolve(nodes, { text: "missing", selectionStrategy: "unique" })).toBeNull();
  expect(resolve(nodes, { text: "target", container: { text: "missing" } })).toBeNull();
  expect(resolve([{ ...nodes[0], nativeId: "target-id" }], { elementId: "target-id" })).toBe(
    nodes[0].element,
  );
  // A resolved node without its source element returns null.
  expect(resolve([{ ...nodes[0], element: undefined }], { text: "target" })).toBeNull();
});

test("ambiguous unique target or ancestor scope throws ActionableError", () => {
  const nodes = [
    entry("scope", 0),
    entry("target", 1, 0),
    entry("scope", 2),
    entry("target", 3, 2),
  ];
  expect(() => resolve(nodes, { text: "target", selectionStrategy: "unique" })).toThrow(
    ActionableError,
  );
  expect(() =>
    resolve(
      nodes,
      { text: "target", container: { text: "scope", selectionStrategy: "unique" } },
      { text: "scope" },
      nodes[0].element,
    ),
  ).toThrow(ActionableError);
});

test("bound container pins a nonunique selection to the already selected node", () => {
  const nodes = [
    entry("scope", 0),
    entry("target", 1, 0),
    entry("scope", 2),
    entry("target", 3, 2),
  ];
  expect(
    resolve(
      nodes,
      { text: "target" },
      { text: "scope", selectionStrategy: "random" },
      nodes[2].element,
    ),
  ).toBe(nodes[3].element);
  expect(resolve(nodes, { text: "target" }, { text: "scope" })).toBe(nodes[1].element);
  expect(
    resolve(
      nodes,
      { text: "target", selectionStrategy: "unique" },
      { text: "scope", index: 1 },
      nodes[0].element,
    ),
  ).toBe(nodes[3].element);
  expect(nodes[2].nodeKey).toBeUndefined();
});

test("other resolver errors are surfaced rather than swallowed", () => {
  expect(() => resolve([entry("target", 0)], { text: " " })).toThrow(ActionableError);
  // Invalid regex container IDs become missing-container errors and are swallowed as null.
  expect(
    resolve([entry("target", 0)], {
      text: "target",
      container: { elementId: "target", match: "regex" },
    }),
  ).toBeNull();
});
