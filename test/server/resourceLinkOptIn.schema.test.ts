import { describe, expect, test } from "bun:test";
import definitions from "../../schemas/tool-definitions.json";

interface ToolDefinition {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
}

const tools: ToolDefinition[] = definitions;

describe("resourceLink opt-in schema (#13942)", () => {
  for (const name of ["getLogs", "exportPlan", "videoRecording"]) {
    test(`${name} advertises a boolean resourceLink with no $ref`, () => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties?.resourceLink).toMatchObject({ type: "boolean" });
      expect(JSON.stringify(tool?.inputSchema)).not.toContain("$ref");
    });
  }
});
