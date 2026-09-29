import { beforeAll, describe, expect, test } from "bun:test";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";

type JsonSchema = Record<string, unknown>;

// `keyboard` belongs to the separately owned IME lane; keep this strictness
// sweep from changing that lane's contract in the observe schema fix.
const STRICTNESS_ALLOWLIST: Readonly<Record<string, string>> = {
  keyboard: "IME schema is owned by a separate implementation lane",
};

function exampleForSchema(schema: JsonSchema, depth = 0): unknown {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if ("const" in schema) {
    return schema.const;
  }
  for (const branchKey of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[branchKey];
    if (Array.isArray(branches) && branches.length > 0) {
      return exampleForSchema(branches[0] as JsonSchema, depth + 1);
    }
  }

  switch (schema.type) {
    case "object": {
      const properties = schema.properties as Record<string, JsonSchema> | undefined;
      const required = Array.isArray(schema.required) ? schema.required : [];
      return Object.fromEntries(
        required.flatMap((key) => {
          if (typeof key !== "string" || !properties?.[key]) {
            return [];
          }
          const value = exampleForSchema(properties[key], depth + 1);
          return value === undefined ? [] : [[key, value]];
        }),
      );
    }
    case "array": {
      const itemSchema = schema.items as JsonSchema | undefined;
      if (!itemSchema) {
        return [];
      }
      const item = exampleForSchema(itemSchema, depth + 1);
      return item === undefined
        ? []
        : Array.from({ length: Number(schema.minItems ?? 0) }, () => item);
    }
    case "string":
      return "probe";
    case "number":
    case "integer":
      return Number(schema.minimum ?? 0);
    case "boolean":
      return false;
    default:
      return undefined;
  }
}

describe("advertised tool input strictness", () => {
  beforeAll(() => {
    createMcpServer();
  });

  test("every tool advertising additionalProperties:false rejects an unknown root key", () => {
    const registered = new Map(
      ToolRegistry.getAllTools({ includeUnavailable: true }).map((tool) => [tool.name, tool]),
    );
    const advertised = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).filter(
      (definition) => definition.inputSchema.additionalProperties === false,
    );
    const mismatches: string[] = [];

    expect(advertised.length).toBeGreaterThan(0);

    for (const definition of advertised) {
      if (definition.name in STRICTNESS_ALLOWLIST) {
        continue;
      }

      const tool = registered.get(definition.name);
      expect(tool, `${definition.name} must have a registered runtime schema`).toBeDefined();
      if (!tool) {
        continue;
      }

      const input = {
        ...(exampleForSchema(definition.inputSchema) as Record<string, unknown>),
        __strictnessProbe: true,
      };
      const result = tool.schema.safeParse(input);
      if (result.success) {
        mismatches.push(`${definition.name}: accepted the unknown key`);
      } else {
        const issues = JSON.stringify(result.error.issues);
        if (
          !issues.includes('"code":"unrecognized_keys"') ||
          !issues.includes('"__strictnessProbe"')
        ) {
          mismatches.push(`${definition.name}: did not report the probe as unrecognized`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
