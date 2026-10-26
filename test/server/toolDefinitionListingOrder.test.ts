import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolDefinitionListing } from "../../src/server/ToolDefinitionListing";
import type { RegisteredTool } from "../../src/server/toolRegistryTypes";

// #13943: tools/list must serialize byte-identically however tools were registered, so
// client list caches and LLM prompt caches stay stable.
const names = ["tapOn", "observe", "launchApp", "setToolEnabled", "swipeOn", "pressButton"];

const toolNamed = (name: string): RegisteredTool => ({
  name,
  description: `${name} tool`,
  schema: z.object({}),
  handler: async () => ({}),
  defaultEnabled: true,
  defaultDeclared: true,
});

const listing = (order: readonly string[]) =>
  new ToolDefinitionListing(
    () => order.map(toolNamed),
    () => true,
    () => ({ inputSchema: { type: "object", properties: {} }, outputSchema: undefined }),
  );

const rotations = (items: readonly string[]) =>
  items.map((_, i) => [...items.slice(i), ...items.slice(0, i)]);

describe("ToolDefinitionListing order", () => {
  test("serializes byte-identically for every registration order", () => {
    const baseline = JSON.stringify(listing(names).getToolDefinitions());
    for (const order of [...rotations(names), [...names].reverse()]) {
      expect(JSON.stringify(listing(order).getToolDefinitions())).toBe(baseline);
    }
  });

  test("lists tools sorted by name", () => {
    const listed = listing(names)
      .getToolDefinitions()
      .map((definition) => definition.name);
    expect(listed).toEqual([...names].sort());
  });
});
