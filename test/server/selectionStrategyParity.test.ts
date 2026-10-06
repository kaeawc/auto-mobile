import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ElementResolver } from "../../src/features/utility/ElementResolver";
import { VisualHighlightClient } from "../../src/features/debug/VisualHighlight";
import type { HighlightShape } from "../../src/models";
import type { PinchOnArgs } from "../../src/server/interactionToolTypes";
import {
  nestedElementContainerSchema,
  resolverSelectorSchema,
  resolverSelectionStrategySchema,
} from "../../src/server/elementSelectorSchemas";
import { highlightSchema, registerHighlightTools } from "../../src/server/highlightTools";
import {
  dragAndDropSchema,
  pinchOnSchema,
  sendKeysSchema,
  swipeOnSchema,
  tapAnySchema,
  tapOnSchema,
} from "../../src/server/interactionTools";
import { observeSchema, waitForSchema } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import nestedCapture from "../fixtures/android-focus/playground-text-field-pre-tap.json";
import type { ViewHierarchyResult } from "../../src/models";
import captureFixture from "../fixtures/observe/android-container-scope.json";

const strategies = ["first", "random", "unique", "invalid", "", null, 1];
const allStrategies = ["first", "random", "unique"];
const container = (selectionStrategy: unknown) => ({ elementId: "left", selectionStrategy });
const schemaCases: Array<{
  name: string;
  schema: z.ZodType;
  args: (strategy: unknown) => unknown;
  expected: string[];
}> = [
  {
    name: "canonical enum",
    schema: resolverSelectionStrategySchema,
    args: (s) => s,
    expected: allStrategies,
  },
  {
    name: "resolver selector (unused by tools)",
    schema: resolverSelectorSchema,
    args: (s) => ({ text: "Open", selectionStrategy: s }),
    expected: ["first", "random"],
  },
  {
    name: "tapOn",
    schema: tapOnSchema,
    args: (s) => ({ selector: { text: "Open" }, selectionStrategy: s }),
    expected: allStrategies,
  },
  {
    name: "tapAny",
    schema: tapAnySchema,
    args: (s) => ({ selectionStrategy: s }),
    expected: allStrategies,
  },
  ...["source", "target"].map((endpoint) => ({
    name: `dragAndDrop.${endpoint}`,
    schema: dragAndDropSchema,
    args: (s: unknown) => ({
      source: { text: "Open" },
      target: { text: "More" },
      [endpoint]: { text: "Open", selectionStrategy: s },
    }),
    expected: allStrategies,
  })),
  {
    name: "swipeOn.lookFor",
    schema: swipeOnSchema,
    args: (s) => ({ direction: "up", lookFor: { text: "Open", selectionStrategy: s } }),
    expected: allStrategies,
  },
  {
    name: "sendKeys",
    schema: sendKeysSchema,
    args: (s) => ({
      selector: { text: "Open" },
      commands: [{ action: "type", text: "value" }],
      selectionStrategy: s,
    }),
    expected: allStrategies,
  },
  {
    name: "highlight (additive unique)",
    schema: highlightSchema,
    args: (s) => ({ text: "Open", selectionStrategy: s }),
    expected: allStrategies,
  },
  {
    name: "waitFor legacy",
    schema: waitForSchema,
    args: (s) => ({ text: "Open", selectionStrategy: s }),
    expected: allStrategies,
  },
  {
    name: "waitFor DSL",
    schema: waitForSchema,
    args: (s) => ({ for: "appear", text: "Open", selectionStrategy: s }),
    expected: allStrategies,
  },
  {
    name: "waitFor absence",
    schema: waitForSchema,
    args: (s) => ({ absent: { text: "Open", selectionStrategy: s } }),
    expected: allStrategies,
  },
  {
    name: "observe.waitFor",
    schema: observeSchema,
    args: (s) => ({ waitFor: { text: "Open", selectionStrategy: s } }),
    expected: allStrategies,
  },
  ...["container", "sibling"].map((field) => ({
    name: `resolver selector.${field}`,
    schema: resolverSelectorSchema,
    args: (s: unknown) => ({ text: "Open", [field]: { text: "Scope", selectionStrategy: s } }),
    expected: ["first", "random"],
  })),
  ...["source", "target"].map((endpoint) => ({
    name: `dragAndDrop.${endpoint}.container`,
    schema: dragAndDropSchema,
    args: (s: unknown) => ({
      source: { text: "Open" },
      target: { text: "More" },
      [endpoint]: { text: "Open", container: { elementId: "left", container: container(s) } },
    }),
    expected: allStrategies,
  })),
  {
    name: "swipeOn.lookFor.container",
    schema: swipeOnSchema,
    args: (s) => ({ direction: "up", lookFor: { text: "Open", container: container(s) } }),
    expected: allStrategies,
  },
  {
    name: "waitFor textAny (strategy requires absence)",
    schema: waitForSchema,
    args: (s) => ({ textAny: ["Open"], selectionStrategy: s }),
    expected: [],
  },
  {
    name: "observe.waitFor.container",
    schema: observeSchema,
    args: (s) => ({ waitFor: { text: "Open", container: container(s) } }),
    expected: allStrategies,
  },
  {
    name: "container",
    schema: nestedElementContainerSchema,
    args: container,
    expected: allStrategies,
  },
  ...[
    { name: "tapOn", schema: tapOnSchema, base: { selector: { text: "Open" } } },
    { name: "tapAny", schema: tapAnySchema, base: {} },
    { name: "highlight", schema: highlightSchema, base: { text: "Open" } },
    { name: "swipeOn", schema: swipeOnSchema, base: { direction: "up" } },
    { name: "pinchOn", schema: pinchOnSchema, base: { direction: "in" } },
    {
      name: "sendKeys",
      schema: sendKeysSchema,
      base: { selector: { text: "Open" }, commands: [{ action: "type", text: "value" }] },
    },
    { name: "waitFor", schema: waitForSchema, base: { text: "Open" } },
  ].map(({ name, schema, base }) => ({
    name: `${name}.container`,
    schema,
    args: (s: unknown) => ({ ...base, container: { elementId: "left", container: container(s) } }),
    expected: allStrategies,
  })),
];

describe("selection strategy wire compatibility", () => {
  test.each(schemaCases)("$name accepts the pinned values", ({ schema, args, expected }) => {
    expect(strategies.filter((strategy) => schema.safeParse(args(strategy)).success)).toEqual(
      expected,
    );
  });

  test("pinchOn type and schema support recursive container strategies only", () => {
    const args = {
      direction: "in",
      container: {
        elementId: "left",
        selectionStrategy: "unique",
        container: { text: "Root", selectionStrategy: "first", index: 0 },
      },
    } satisfies PinchOnArgs;
    expect(pinchOnSchema.safeParse(args).success).toBe(true);
    for (const selectionStrategy of allStrategies) {
      expect(pinchOnSchema.safeParse({ ...args, selectionStrategy }).success).toBe(false);
    }
  });

  test.each([{ text: "" }, { elementId: "" }])(
    "highlight keeps legacy flat container %j valid",
    (legacy) => {
      expect(highlightSchema.safeParse({ text: "Open", container: legacy }).success).toBe(true);
    },
  );
});

describe("highlight resolver parity on a captured hierarchy", () => {
  afterEach(() => ToolRegistry.clearTools());

  test.each([false, true])("nested highlight shares tapOn's target (unique=%s)", async (unique) => {
    const capture = new FakeHierarchyCapture(
      () => nestedCapture.viewHierarchy as ViewHierarchyResult,
    );
    const snapshot = await capture.capture({ freshness: "fresh" });
    const target = snapshot.nodes.find(
      (node) =>
        node.actionable &&
        node.nodeKey &&
        node.parentIndex !== undefined &&
        snapshot.nodes[node.parentIndex].nodeKey &&
        snapshot.nodes[node.parentIndex].parentIndex !== undefined &&
        snapshot.nodes[snapshot.nodes[node.parentIndex].parentIndex!].nodeKey,
    )!;
    expect(target).toBeDefined();
    const parent = snapshot.nodes[target.parentIndex!];
    const outer = snapshot.nodes[parent.parentIndex!];
    const selector = {
      elementId: target.nodeKey!,
      selectionStrategy: unique ? ("unique" as const) : ("first" as const),
      container: {
        elementId: parent.nodeKey!,
        index: 0,
        selectionStrategy: "unique" as const,
        container: { elementId: outer.nodeKey!, index: 0, selectionStrategy: "unique" as const },
      },
    };
    tapOnSchema.parse({
      selector: { elementId: selector.elementId },
      container: selector.container,
      selectionStrategy: selector.selectionStrategy,
    });
    const tap = new ElementResolver().resolve(
      { id: snapshot.captureId, nodes: snapshot.nodes },
      selector,
      { action: "tap" },
    );
    expect(tap.error).toBeUndefined();
    expect(tap.chosen?.bounds).toBeDefined();
    const shapes: HighlightShape[] = [];
    registerHighlightTools({
      hierarchyCaptureFactory: () => capture,
      generateHighlightId: () => "parity",
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async (_id: string, shape: HighlightShape) => {
            shapes.push(shape);
            return { success: true };
          },
        }),
    });
    const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
      { deviceId: "capture", name: "Captured Android", platform: "android" },
      highlightSchema.parse(selector),
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
    const bounds = tap.chosen!.bounds!;
    expect(shapes).toEqual([
      {
        type: "circle",
        bounds: {
          x: bounds.left,
          y: bounds.top,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
        },
      },
    ]);
  });

  test("unindexed unique highlights the sole captured scoped target", async () => {
    const capture = new FakeHierarchyCapture(() => captureFixture.viewHierarchy);
    const shapes: HighlightShape[] = [];
    registerHighlightTools({
      hierarchyCaptureFactory: () => capture,
      generateHighlightId: () => "unique",
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async (_id: string, shape: HighlightShape) => {
            shapes.push(shape);
            return { success: true };
          },
        }),
    });
    const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
      { deviceId: "capture", name: "Captured Android", platform: "android" },
      highlightSchema.parse({
        elementId: "action",
        container: { elementId: "left", selectionStrategy: "unique" },
        selectionStrategy: "unique",
      }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
    expect(shapes).toEqual([{ type: "circle", bounds: { x: 20, y: 40, width: 200, height: 60 } }]);
  });

  test("ambiguous unique returns the existing resolver failure without drawing", async () => {
    const capture = new FakeHierarchyCapture(() => captureFixture.viewHierarchy);
    const snapshot = await capture.capture({ freshness: "fresh" });
    const selector = { elementId: "action", selectionStrategy: "unique" as const };
    const resolution = new ElementResolver().resolve(
      { id: snapshot.captureId, nodes: snapshot.nodes },
      selector,
      { action: "tap" },
    );
    expect(resolution.error).toContain("ambiguous");
    let additions = 0;
    registerHighlightTools({
      hierarchyCaptureFactory: () => capture,
      generateHighlightId: () => "ambiguous",
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async () => {
            additions++;
            return { success: true };
          },
        }),
    });
    const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
      { deviceId: "capture", name: "Captured Android", platform: "android" },
      highlightSchema.parse(selector),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ success: false, error: resolution.error });
    expect(additions).toBe(0);
  });
});
