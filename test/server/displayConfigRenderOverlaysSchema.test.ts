import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayConfigSchema } from "../../src/server/displayConfigTool";

interface ToolDefinition {
  name: string;
  inputSchema: { properties: Record<string, { minProperties?: number }> };
}

describe("displayConfig renderOverlays input schema (#19016)", () => {
  test("the published schema requires at least one overlay, as the runtime check does", () => {
    const definitions = JSON.parse(
      readFileSync(join(import.meta.dir, "../../schemas/tool-definitions.json"), "utf8"),
    ) as ToolDefinition[];
    const displayConfig = definitions.find((tool) => tool.name === "displayConfig");

    expect(displayConfig?.inputSchema.properties.renderOverlays?.minProperties).toBe(1);
  });

  test("an empty overlay object is refused and a single false overlay is accepted", () => {
    expect(displayConfigSchema.safeParse({ renderOverlays: {} }).success).toBe(false);
    expect(
      displayConfigSchema.safeParse({ renderOverlays: { blendedLayers: false } }).success,
    ).toBe(true);
  });
});
