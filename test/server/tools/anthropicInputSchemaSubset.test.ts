import { describe, expect, test } from "bun:test";
import { registerBarrierTools } from "../../../src/server/barrierTools";
import { registerCriticalSectionTools } from "../../../src/server/criticalSectionTools";
import { createMcpServer } from "../../../src/server";
import { ToolRegistry } from "../../../src/server/toolRegistry";

// Populate at module scope because test definitions are collected before hooks
// run. The daemon-only tools are included to cover the generator's complete
// 88-tool catalog rather than this test process's stdio-only default registry.
createMcpServer();
registerCriticalSectionTools();
registerBarrierTools();
const ADVERTISED_TOOLS = ToolRegistry.getToolDefinitions({ includeUnavailable: true });
const ROOT_FORBIDDEN_KEYWORDS = ["anyOf", "allOf", "oneOf", "not", "if", "then", "else"];
const NESTED_FORBIDDEN_KEYWORDS = ["oneOf", "not", "if", "then", "else"];

function findForbiddenSchemaKeyword(
  value: unknown,
  forbiddenKeywords: readonly string[],
  path: string,
): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenSchemaKeyword(item, forbiddenKeywords, `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenKeywords.includes(key)) {
      return `${path}.${key}`;
    }
    const found = findForbiddenSchemaKeyword(nestedValue, forbiddenKeywords, `${path}.${key}`);
    if (found) {
      return found;
    }
  }
  return undefined;
}

describe("Anthropic input_schema subset", () => {
  test("normalizes every advertised tool input schema", () => {
    expect(ADVERTISED_TOOLS).toHaveLength(88);

    for (const tool of ADVERTISED_TOOLS) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type, `${tool.name} inputSchema must be an object`).toBe("object");
      for (const keyword of ROOT_FORBIDDEN_KEYWORDS) {
        expect(
          schema[keyword],
          `${tool.name} inputSchema has unsupported root ${keyword}`,
        ).toBeUndefined();
      }
      expect(
        findForbiddenSchemaKeyword(schema, NESTED_FORBIDDEN_KEYWORDS, tool.name),
        `${tool.name} inputSchema has an unsupported nested keyword`,
      ).toBeUndefined();
    }
  });
});
