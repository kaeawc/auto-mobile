import { describe, expect, test } from "bun:test";
import definitions from "../../schemas/tool-definitions.json";

interface ToolDefinition {
  name: string;
  inputSchema: { properties?: Record<string, { type?: string }> };
}

const tools =
  (definitions as unknown as { tools?: ToolDefinition[] }).tools ??
  (definitions as unknown as ToolDefinition[]);

describe("resourceLink opt-in schema (#13942)", () => {
  for (const name of ["getLogs", "exportPlan"]) {
    test(`${name} advertises a boolean resourceLink with no $ref`, () => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties?.resourceLink?.type).toBe("boolean");
      expect(JSON.stringify(tool?.inputSchema)).not.toContain("$ref");
    });
  }
});
