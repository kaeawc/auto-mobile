import { describe, expect, test } from "bun:test";
import generatedDefinitions from "../../schemas/tool-definitions.json";
import { SKELETON_DEFAULT_ACTION_TOOLS } from "../../src/server/finalizeToolResponse";

// Import the generated contract directly: no registry, DB, daemon or device setup.
const definitions: readonly {
  name: string;
  inputSchema: {
    properties?: Record<string, { description?: string; [keyword: string]: unknown } | undefined>;
  };
}[] = generatedDefinitions;

const exemptions = {
  observe: "Owns projection at the payload top level, rather than under .observation.",
};

const advertisers = definitions.filter((definition) =>
  definition.inputSchema.properties?.project?.description?.includes("'skeleton' (default)"),
);

describe("skeleton default schema drift", () => {
  test.each(["hitTest", "setPosture"])("%s has no generated observation controls", (name) => {
    const definition = definitions.find((definition) => definition.name === name);
    expect(definition).toBeDefined();
    expect(definition!.inputSchema.properties).not.toHaveProperty("raw");
    expect(definition!.inputSchema.properties).not.toHaveProperty("project");
  });

  test("observation control properties match the action set regardless of descriptions", () => {
    const names = definitions
      .filter(
        ({ inputSchema }) =>
          Object.hasOwn(inputSchema.properties ?? {}, "raw") &&
          Object.hasOwn(inputSchema.properties ?? {}, "project"),
      )
      .map(({ name }) => name)
      .filter((name) => !Object.hasOwn(exemptions, name))
      .sort();
    expect(names).toEqual([...SKELETON_DEFAULT_ACTION_TOOLS].sort());
  });
  test("every advertised skeleton default is implemented or explicitly exempted", () => {
    expect(advertisers.length).toBeGreaterThan(0);
    expect(
      advertisers
        .map(({ name }) => name)
        .filter((name) => !Object.hasOwn(exemptions, name))
        .sort(),
    ).toEqual([...SKELETON_DEFAULT_ACTION_TOOLS].sort());
  });

  test("exemptions still advertise a skeleton default and remain outside the action set", () => {
    for (const name of Object.keys(exemptions)) {
      expect(advertisers.some((definition) => definition.name === name)).toBe(true);
      expect(SKELETON_DEFAULT_ACTION_TOOLS.has(name)).toBe(false);
    }
  });

  test("every skeleton-default action advertises both raw and project controls", () => {
    expect(SKELETON_DEFAULT_ACTION_TOOLS.size).toBeGreaterThan(0);
    for (const name of SKELETON_DEFAULT_ACTION_TOOLS) {
      const properties = definitions.find((definition) => definition.name === name)?.inputSchema
        .properties;
      expect(properties).toHaveProperty("raw");
      expect(properties).toHaveProperty("project");
    }
  });
});
