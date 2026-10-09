import { installHermeticServerFixture } from "../../helpers/hermeticServerFixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerBarrierTools } from "../../../src/server/barrierTools";
import { registerCriticalSectionTools } from "../../../src/server/criticalSectionTools";
import { createMcpServer } from "../../../src/server";
import { ToolRegistry } from "../../../src/server/toolRegistry";

let ADVERTISED_TOOLS: ReturnType<typeof ToolRegistry.getToolDefinitions>;
const ROOT_FORBIDDEN_KEYWORDS = ["anyOf", "allOf", "oneOf", "not", "if", "then", "else"];
const NESTED_FORBIDDEN_KEYWORDS = ["oneOf", "not", "if", "then", "else"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findInNameMap(
  map: Record<string, unknown>,
  forbiddenKeywords: readonly string[],
  path: string,
): string | undefined {
  for (const [name, subschema] of Object.entries(map)) {
    const found = findForbiddenSchemaKeyword(subschema, forbiddenKeywords, `${path}.${name}`);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Keywords whose object value maps arbitrary names (not keywords) to subschemas. */
const NAME_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * Walk a JSON schema looking for forbidden keywords. Keys under a name-map keyword such as
 * `properties` are property names (a tool may declare a property called `not`), so only their
 * subschemas are inspected, never the names themselves.
 */
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
    const found =
      NAME_MAP_KEYWORDS.has(key) && isPlainObject(nestedValue)
        ? findInNameMap(nestedValue, forbiddenKeywords, `${path}.${key}`)
        : findForbiddenSchemaKeyword(nestedValue, forbiddenKeywords, `${path}.${key}`);
    if (found) {
      return found;
    }
  }
  return undefined;
}

describe("findForbiddenSchemaKeyword", () => {
  test("ignores a property named like a keyword but flags the real keyword", () => {
    const named = {
      type: "object",
      properties: { not: { type: "string" }, if: { type: "number" } },
    };
    expect(findForbiddenSchemaKeyword(named, NESTED_FORBIDDEN_KEYWORDS, "t")).toBeUndefined();
    const nested = { type: "object", properties: { a: { not: { type: "string" } } } };
    expect(findForbiddenSchemaKeyword(nested, NESTED_FORBIDDEN_KEYWORDS, "t")).toBe(
      "t.properties.a.not",
    );
    const inAnyOf = { anyOf: [{ properties: { not: { oneOf: [] } } }] };
    expect(findForbiddenSchemaKeyword(inAnyOf, NESTED_FORBIDDEN_KEYWORDS, "t")).toBe(
      "t.anyOf[0].properties.not.oneOf",
    );
  });
});

describe("Anthropic input_schema subset", () => {
  let restoreHermeticServer: () => void;

  beforeAll(() => {
    restoreHermeticServer = installHermeticServerFixture();
    createMcpServer();
    registerCriticalSectionTools();
    registerBarrierTools();
    ADVERTISED_TOOLS = ToolRegistry.getToolDefinitions({ includeUnavailable: true });
  });

  afterAll(() => restoreHermeticServer());

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
