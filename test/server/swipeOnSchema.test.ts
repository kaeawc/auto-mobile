import { expect, test } from "bun:test";
import type { SwipeOnOptions } from "../../src/models";
import { z } from "zod/v4";
import {
  swipeOnSchema,
  swipeOnHandler,
  setSwipeOnFactory,
  resetSwipeOnFactory,
} from "../../src/server/interactionTools";
import { applyJsonSchemaOverride } from "../../src/server/toolSchemaHelpers";
const scope = { elementId: "list", container: { text: "Panel", index: 0 } };
for (const field of ["container", "lookFor"] as const) {
  test(`${field} accepts a recursive scope and every selection strategy`, () => {
    for (const selectionStrategy of ["first", "random", "unique"]) {
      const selector = { text: "Target", container: scope, selectionStrategy };
      expect(swipeOnSchema.parse({ direction: "down", [field]: selector })[field]).toEqual(
        selector,
      );
    }
  });
  test.each([
    {},
    { elementId: "id", text: "Text" },
    { elementId: "id", selectionStrategy: "last" },
    ...[
      {},
      { elementId: "" },
      { text: "   " },
      { elementId: "id", index: -1 },
      { elementId: "id", index: 0.5 },
      { elementId: "id", unknown: true },
      { elementId: "id", selectionStrategy: "last" },
    ].map((container) => ({ elementId: "id", container })),
  ])(`${field} rejects malformed recursive selectors %j`, (selector) => {
    expect(swipeOnSchema.safeParse({ direction: "down", [field]: selector }).success).toBe(false);
  });
}
test("legacy screen, container, and lookFor shapes remain accepted", () => {
  for (const extra of [{}, { container: { text: "List" } }, { lookFor: { elementId: "target" } }]) {
    expect(swipeOnSchema.safeParse({ direction: "up", ...extra }).success).toBe(true);
  }
});
test("strategy requires a selector and belongs inside it", () => {
  expect(swipeOnSchema.safeParse({ direction: "down", selectionStrategy: "unique" }).success).toBe(
    false,
  );
  expect(
    swipeOnSchema.safeParse({ direction: "down", lookFor: { selectionStrategy: "unique" } })
      .success,
  ).toBe(false);
});
test("advertised schema retains recursive scope and strategy fields", () => {
  const output = z.toJSONSchema(swipeOnSchema, {
    override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
  });
  expect(output.$defs).toBeDefined();
  expect(output.properties?.lookFor).toMatchObject({
    anyOf: [
      {
        additionalProperties: false,
        properties: {
          container: { $ref: expect.stringContaining("#/$defs/") },
          selectionStrategy: { enum: ["first", "random", "unique"] },
        },
      },
      {
        additionalProperties: false,
        properties: {
          container: { $ref: expect.stringContaining("#/$defs/") },
          selectionStrategy: { enum: ["first", "random", "unique"] },
        },
      },
    ],
  });
});

test("handler forwards complete selectors and reports a structured resolution failure", async () => {
  const calls: SwipeOnOptions[] = [];
  setSwipeOnFactory(() => ({
    execute: async (options) => {
      calls.push(options);
      return {
        success: false,
        error: "Container level 2 ambiguous; Candidates: list",
        targetType: "element",
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        duration: 0,
      };
    },
  }));
  try {
    const scoped = {
      direction: "down",
      container: { ...scope, selectionStrategy: "unique" },
      lookFor: { text: "Target", container: { elementId: "row" }, selectionStrategy: "unique" },
    };
    const response = await swipeOnHandler(
      { name: "fake", deviceId: "swipe-schema-fake", platform: "android" },
      swipeOnSchema.parse(scoped),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(scoped);
    expect(response.isError).toBe(true);
  } finally {
    resetSwipeOnFactory();
  }
});
