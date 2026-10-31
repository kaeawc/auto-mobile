import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

const restore = installHermeticServerFixture();
const fixture = new McpTestFixture();
const name = "__output_schema_refs__";
let valid = true;
let advertised: unknown;

beforeAll(async () => {
  const shared = z.object({ value: z.string() });
  ToolRegistry.register(name, "Reference validation probe", z.object({}), {
    handler: async () =>
      createStructuredToolResponse({ left: { value: "ok" }, right: { value: valid ? "ok" : 42 } }),
    defaultEnabled: true,
    outputSchema: z.object({ left: shared, right: shared }),
  });
  await fixture.setup();
  const result = await fixture.client.listTools();
  advertised = result.tools.find((tool) => tool.name === name)?.outputSchema;
  // Warm the request path outside the unit timing budget.
  await fixture.client.callTool({ name, arguments: {} });
});

afterAll(async () => {
  await fixture.teardown();
  restore();
});

test("installed MCP Client resolves #/$defs references for structuredContent", async () => {
  expect(JSON.stringify(advertised)).toContain('"$ref":"#/$defs/');
  const response = await fixture.client.callTool({ name, arguments: {} });
  expect(response.structuredContent).toEqual({ left: { value: "ok" }, right: { value: "ok" } });
});

test("installed MCP Client rejects invalid content through the same local reference", async () => {
  valid = false;
  try {
    await expect(fixture.client.callTool({ name, arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    );
  } finally {
    valid = true;
  }
});
