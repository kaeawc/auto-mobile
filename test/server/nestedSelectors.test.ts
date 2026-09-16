import { beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  tapOnSchema,
  inputTextSchema,
  sendKeysSchema,
  dragAndDropSchema,
  swipeOnSchema,
  pinchOnSchema,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import {
  observeSchema,
  registerObserveTools,
  waitForObservation,
} from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { scopeToFocus } from "../../src/features/observe/output/ObserveScopeExperiments";
import { DefaultElementParser } from "../../src/features/utility/ElementParser";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import type { ObserveResult, ViewHierarchyNode } from "../../src/models";

const container = { elementId: "item_42", container: { elementId: "cart_A" } };
const query = { elementId: "remove", container, selectionStrategy: "unique" as const };
const cases = [
  [
    "tapOn",
    tapOnSchema,
    { selector: { elementId: "remove" }, container, selectionStrategy: "unique" },
  ],
  [
    "inputText",
    inputTextSchema,
    { selector: { elementId: "quantity" }, container, text: "3", selectionStrategy: "unique" },
  ],
  [
    "sendKeys",
    sendKeysSchema,
    {
      selector: { elementId: "quantity" },
      container,
      commands: [{ action: "clear" }],
      selectionStrategy: "unique",
    },
  ],
  [
    "dragAndDrop",
    dragAndDropSchema,
    { source: query, target: { elementId: "cart_B" }, selectionStrategy: "unique" },
  ],
  [
    "swipeOn",
    swipeOnSchema,
    {
      container,
      direction: "up",
      lookFor: { elementId: "remove", container: { elementId: "row" } },
      selectionStrategy: "unique",
    },
  ],
  ["pinchOn", pinchOnSchema, { container, direction: "in", selectionStrategy: "unique" }],
  ["observe", observeSchema, { scope: { focus: { query } }, waitFor: { for: "appear", query } }],
] as const;

const validators = new Map<string, ReturnType<Ajv2020["compile"]>>();
beforeAll(() => {
  registerObserveTools();
  registerInteractionTools();
  const definitions = ToolRegistry.getToolDefinitions({ includeUnavailable: true });
  for (const [name] of cases) {
    const schema = definitions.find((definition) => definition.name === name)!.inputSchema;
    validators.set(name, new Ajv2020({ strict: false }).compile(schema));
  }
});

describe("nested selector public contract", () => {
  test.each(cases)(
    "%s accepts the complete query in runtime and advertised schemas",
    (name, schema, input) => {
      expect(schema.safeParse(input).success).toBe(true);
      expect(validators.get(name)!(input)).toBe(true);
    },
  );

  test.each([inputTextSchema, sendKeysSchema])(
    "text scopes cannot fall through to the current focus %#",
    (schema) => {
      const input = { text: "3", commands: [{ action: "clear" }], container };
      // Use each schema's supported command field; the failure must be the
      // missing selector, not an unrelated unknown key.
      const data =
        schema === inputTextSchema
          ? { text: input.text, container }
          : { commands: input.commands, container };
      const result = schema.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes("require a target selector")),
        ).toBe(true);
      }
    },
  );

  test.each([
    { elementId: "row", text: "Row" },
    { elementId: "row", container: { elementId: "" } },
    { elementId: "row", container: { text: "Row", unknown: true } },
    { elementId: "row", index: -1 },
    { elementId: "row", index: 0.5 },
    { elementId: "row", container: {} },
  ])("malformed recursive selectors fail runtime and advertised validation %#", (badContainer) => {
    const input = { selector: { elementId: "remove" }, container: badContainer };
    expect(tapOnSchema.safeParse(input).success).toBe(false);
    expect(validators.get("tapOn")!(input)).toBe(false);
  });

  test("scoped absence has an additive unambiguous query form", () => {
    expect(observeSchema.safeParse({ waitFor: { for: "disappear", query } }).success).toBe(true);
    for (const input of [
      { waitFor: { for: "stable", query } },
      { waitFor: { for: "appear", query, elementId: "outside" } },
    ]) {
      expect(observeSchema.safeParse(input).success).toBe(false);
      expect(validators.get("observe")!(input)).toBe(false);
    }
  });
  test("semantic link activation rejects scopes it cannot preserve", () => {
    const input = { selector: { accessibilityLink: "terms" }, container };
    expect(tapOnSchema.safeParse(input).success).toBe(false);
    expect(validators.get("tapOn")!(input)).toBe(false);
  });
});

const node = (id: string, children: ViewHierarchyNode[] = []): ViewHierarchyNode => ({
  $: { "resource-id": id, bounds: { left: 0, top: 0, right: 50, bottom: 50 } },
  node: children,
});
const observation = (children: ViewHierarchyNode[], updatedAt: number): ObserveResult =>
  ({
    viewHierarchy: { hierarchy: { node: node("root", children) }, updatedAt },
    updatedAt,
  }) as ObserveResult;

describe("scoped observation and refreshed waits", () => {
  test.each(["full", "skeleton"] as const)(
    "%s output preserves scoped discovery without leaking peer elements",
    (project) => {
      const remove = node("remove");
      remove.$.clickable = "true";
      const input = observation(
        [
          node("cart_A", [node("item_42", [remove])]),
          node("cart_B", [node("item_42", [node("outside")])]),
        ],
        10,
      );
      input.elements = {
        clickable: [
          { "resource-id": "outside", bounds: { left: 0, top: 0, right: 50, bottom: 50 } },
        ],
        scrollable: [],
        text: [],
        media: [],
      };
      const response = finalizeToolResponse(
        { content: [{ type: "text", text: JSON.stringify(input) }], structuredContent: input },
        { name: "observe", args: { scope: { focus: { query } }, project } },
      );
      const payload = getStructuredPayload(response);
      expect(payload.observeScope?.focus?.levels).toHaveLength(3);
      expect(JSON.stringify(payload)).not.toContain("outside");
      if (project === "skeleton") {
        expect(payload.skeleton).toHaveLength(1);
      }
    },
  );

  test("discovery preserves ancestor counts and produces a reusable scoped query", () => {
    const input = observation(
      [
        node("cart_A", [node("item_42", [node("remove")])]),
        node("cart_B", [node("item_42", [node("remove")])]),
      ],
      10,
    );
    const scoped = scopeToFocus(input, { query });
    expect(scoped.focus.query).toEqual(query);
    expect(scoped.focus.levels?.map((level) => level.selector.elementId)).toEqual([
      "cart_A",
      "item_42",
      "remove",
    ]);
    expect(scoped.focus.levels?.map((level) => level.matchCount)).toEqual([1, 1, 1]);
    const roots = new DefaultElementParser().extractRootNodes(scoped.result.viewHierarchy!);
    expect(roots[0].$["resource-id"]).toBe("remove");
    expect(input.viewHierarchy?.hierarchy?.node?.$["resource-id"]).toBe("root");
  });

  test("a missing or ambiguous ancestor does not satisfy absence; every poll resolves anew", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observer = new FakeObserveScreen();
    observer.setObserveSequence([
      observation([node("cart_B")], 10),
      observation([node("cart_A"), node("cart_A")], 20),
      observation([node("cart_A", [node("item_42", [node("remove")])])], 30),
      observation([node("cart_A", [node("item_42")])], 40),
    ]);
    const result = await waitForObservation(
      observer,
      { for: "disappear", query, timeout: 1000, pollMs: 10 },
      undefined,
      false,
      timer,
    );
    expect(result.matched).toBe(true);
    expect(result.polls).toBe(4);
    expect(result.queryResult?.diagnostic).toMatchObject({ code: "target_not_found", level: 2 });
  });

  test("missing scopes time out with the failing level and no false absence", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observer = new FakeObserveScreen();
    observer.setObserveResult((index) => observation([node("cart_B")], 10 + index));
    const result = await waitForObservation(
      observer,
      { for: "disappear", query, timeout: 30, pollMs: 10 },
      undefined,
      false,
      timer,
    );
    expect(result.timedOut).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.queryResult?.diagnostic).toMatchObject({ code: "container_not_found", level: 0 });
  });
});
