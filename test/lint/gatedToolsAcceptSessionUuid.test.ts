import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../src/server";
import { ToolRegistry } from "../../src/server/toolRegistry";

/**
 * Gated tools are callable from the CLI after it enables them. The CLI forwards
 * a user-supplied --session-uuid to every non-acquisition tool, so their schemas
 * must retain that optional field rather than rejecting it as an unknown key.
 */

const SESSION_UUID_SCHEMA_ALLOWLIST = new Set([
  // Acquires and mints a new session, so the CLI deliberately drops an input session UUID.
  "provisionDevice",
]);

function collectSchemaShapes(schema: any): Record<string, any>[] {
  const definition = schema?._def;
  if (!definition) {
    return [];
  }
  if (definition.shape) {
    return [definition.shape];
  }
  const options = definition.options ?? definition.out?._def?.options;
  if (Array.isArray(options)) {
    return options.flatMap((option: any) => collectSchemaShapes(option));
  }
  return definition.out ? collectSchemaShapes(definition.out) : [];
}

describe("gated tool session UUID schemas", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerMcpTools(false);
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("every independently callable gated tool accepts sessionUuid or explains why it cannot", () => {
    const missingSessionUuid = ToolRegistry.getAllTools({ includeUnavailable: true })
      .filter((tool) => !tool.hidden && !tool.defaultEnabled)
      .filter((tool) => !tool.planOnly)
      .filter((tool) => !SESSION_UUID_SCHEMA_ALLOWLIST.has(tool.name))
      .filter((tool) => {
        const shapes = collectSchemaShapes(tool.schema);
        return shapes.length === 0 || shapes.some((shape) => !("sessionUuid" in shape));
      })
      .map((tool) => tool.name);

    expect(missingSessionUuid).toEqual([]);
  });
});
