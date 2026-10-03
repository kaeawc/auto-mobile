import { expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  dragAndDropSchema,
  dragAndDropHandler,
  setDragAndDropFactory,
  resetDragAndDropFactory,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { applyJsonSchemaOverride } from "../../src/server/toolSchemaHelpers";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { DragAndDropOptions } from "../../src/models";

const container = { elementId: "item_42", container: { text: "Cart", index: 0 } };
const endpoints = { source: { elementId: "remove" }, target: { text: "Drop" } };
for (const endpoint of ["source", "target"] as const) {
  test(`${endpoint} accepts its own recursive scope and every resolver strategy`, () => {
    for (const selectionStrategy of ["first", "random", "unique"]) {
      const selector = { ...endpoints[endpoint], container, selectionStrategy };
      expect(dragAndDropSchema.parse({ ...endpoints, [endpoint]: selector })[endpoint]).toEqual(
        selector,
      );
    }
  });
  test.each([
    {},
    { elementId: "remove", text: "Remove" },
    { elementId: "remove", unknown: true },
    { elementId: "remove", selectionStrategy: "last" },
    ...[
      {},
      { elementId: "" },
      { text: "   " },
      { elementId: "cart", unknown: true },
      { elementId: "cart", text: "Cart" },
      { elementId: "cart", index: -1 },
      { elementId: "cart", index: 0.5 },
      { elementId: "cart", selectionStrategy: "last" },
    ].map((outer) => ({ elementId: "remove", container: { elementId: "item", container: outer } })),
  ])(`${endpoint} rejects malformed or unsupported endpoint %j`, (selector) => {
    expect(dragAndDropSchema.safeParse({ ...endpoints, [endpoint]: selector }).success).toBe(false);
  });
}
test("scope and strategy belong to endpoints, not the top-level options", () => {
  for (const extra of [{ container }, { selectionStrategy: "unique" }]) {
    expect(dragAndDropSchema.safeParse({ ...endpoints, ...extra }).success).toBe(false);
  }
});
test("JSON schema retains strict endpoint alternatives and bounded recursive definitions", () => {
  const output = z.toJSONSchema(dragAndDropSchema, {
    override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
  });
  expect(output.$defs).toBeDefined();
  for (const endpoint of ["source", "target"]) {
    expect(output.properties?.[endpoint]).toMatchObject({
      anyOf: [
        {
          additionalProperties: false,
          required: ["elementId"],
          properties: {
            container: { $ref: expect.stringContaining("#/$defs/") },
            selectionStrategy: { enum: ["first", "random", "unique"] },
          },
        },
        {
          additionalProperties: false,
          required: ["text"],
          properties: {
            container: { $ref: expect.stringContaining("#/$defs/") },
            selectionStrategy: { enum: ["first", "random", "unique"] },
          },
        },
      ],
    });
  }
  registerInteractionTools();
  const advertised = ToolRegistry.getToolDefinitions().find(
    (tool) => tool.name === "dragAndDrop",
  )?.inputSchema;
  expect(advertised).toMatchObject({
    properties: { source: output.properties?.source, target: output.properties?.target },
  });
  expect(JSON.stringify(advertised).length).toBeLessThan(15000);
});
test("handler forwards both complete endpoints after schema parsing", async () => {
  const calls: DragAndDropOptions[] = [];
  setDragAndDropFactory(() => ({
    execute: async (options) => {
      calls.push(options);
      return {
        success: false,
        duration: 0,
        distance: 0,
        error: "dragAndDrop target: Target ambiguous",
      };
    },
  }));
  try {
    const scoped = {
      source: { ...endpoints.source, container, selectionStrategy: "unique" },
      target: {
        ...endpoints.target,
        container: { elementId: "destination" },
        selectionStrategy: "random",
      },
    };
    const response = await dragAndDropHandler(
      { name: "fake", deviceId: "fake-drag-handler", platform: "android" },
      dragAndDropSchema.parse(scoped),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(scoped);
    expect(response).toMatchObject({ isError: true });
  } finally {
    resetDragAndDropFactory();
  }
});
