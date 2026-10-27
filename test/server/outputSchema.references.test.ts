import { afterAll, beforeAll, expect, test } from "bun:test";
import { toJSONSchema, z } from "zod/v4";
import generatedDefinitions from "../../schemas/tool-definitions.json";
import { ToolRegistry, ToolRegistryClass } from "../../src/server/toolRegistry";
import { createMcpServer } from "../../src/server/index";
import { registerAllTools } from "../../src/server/registerAllTools";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { advertisedOutputSchema, jsonSchemaObjects } from "../helpers/advertisedOutputSchemas";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { applyJsonSchemaOverride, withJsonSchemaOverride } from "../../src/utils/schemaHelpers";
import { toAdvertisedJsonSchema } from "../../src/server/pipeline/advertisedSchema";
import {
  advertiseBoundsForCompact,
  BOUNDS_UNION_DESCRIPTION_PREFIX,
} from "../../src/server/compactBoundsAdvertisement";
import { resolveJsonSchemaReference } from "../../src/server/jsonSchemaReferences";

const restore = installHermeticServerFixture();
isolateToolRegistry();
afterAll(restore);
const outputTools = generatedDefinitions.filter((tool) => "outputSchema" in tool);
const errors = new Map<string, unknown>();
const rebuilt = new Map<string, Record<string, unknown> | undefined>();
const reversed = new Map<string, Record<string, unknown> | undefined>();
const inlineBytes = new Map<string, number>();
const collapsedBounds = new Map<string, Record<string, unknown>>();

beforeAll(() => {
  createMcpServer();
  registerAllTools({ daemonMode: true });
  const registry = new ToolRegistryClass(new FakeTimer());
  const reverseRegistry = new ToolRegistryClass(new FakeTimer());
  const tools = ToolRegistry.getEveryRegisteredTool();
  for (const tool of tools) {
    registry.setRegisteredToolForTesting(tool);
  }
  for (const tool of tools.toReversed()) {
    reverseRegistry.setRegisteredToolForTesting(tool);
  }
  for (const definition of registry.getToolDefinitions({ includeUnavailable: true })) {
    rebuilt.set(definition.name, definition.outputSchema);
    if (definition.outputSchema) {
      collapsedBounds.set(
        definition.name,
        advertiseBoundsForCompact(definition.outputSchema, false) as Record<string, unknown>,
      );
    }
    const schema = registry.getRegisteredTool(definition.name)?.outputSchema;
    if (schema) {
      inlineBytes.set(
        definition.name,
        JSON.stringify(advertisedOutputSchema(schema, "inline")).length,
      );
    }
  }
  for (const definition of reverseRegistry.getToolDefinitions({ includeUnavailable: true })) {
    reversed.set(definition.name, definition.outputSchema);
  }
  for (const tool of outputTools) {
    try {
      compileAjv2020(tool.outputSchema);
    } catch (error) {
      errors.set(tool.name, error);
    }
  }
});

test.each(outputTools)(
  "$name outputSchema has only resolvable document-local references",
  (tool) => {
    expect(errors.get(tool.name)).toBeUndefined();
    const root = tool.outputSchema;
    for (const node of jsonSchemaObjects(root)) {
      if (typeof node.$ref !== "string") {
        continue;
      }
      expect(node.$ref === "#" || node.$ref.startsWith("#/$defs/")).toBe(true);
      // Independent JSON Pointer lookup: never allow another tool to supply a target.
      let target: unknown = root;
      for (const token of node.$ref === "#" ? [] : node.$ref.slice(2).split("/")) {
        expect(target).toBeObject();
        const key = decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~");
        expect(Object.hasOwn(target as object, key)).toBe(true);
        target = (target as Record<string, unknown>)[key];
      }
      expect(target).toBeObject();
    }
  },
);

test.each(outputTools)(
  "$name outputSchema and definition names are stable across builds and registration orders",
  (tool) => {
    expect(rebuilt.get(tool.name)).toEqual(tool.outputSchema);
    expect(reversed.get(tool.name)).toEqual(tool.outputSchema);
  },
);

test.each(["observe", "tapOn", "launchApp", "pressButton", "terminateApp"])(
  "%s shares reused observation subtrees instead of expanding them inline",
  (name) => {
    const schema = rebuilt.get(name)!;
    expect(schema.$defs).toBeObject();
    expect(JSON.stringify(schema).length).toBeLessThan(inlineBytes.get(name)! * 0.8);
  },
);

test.each(["observe", "tapOn", "launchApp", "pressButton", "terminateApp"])(
  "%s compaction-off advertisement collapses every referenced bounds union",
  (name) => {
    const schema = collapsedBounds.get(name)!;
    const bounds = jsonSchemaObjects(schema).filter(
      (node) =>
        typeof node.description === "string" &&
        node.description.startsWith(BOUNDS_UNION_DESCRIPTION_PREFIX),
    );
    expect(bounds.length).toBeGreaterThan(0);
    for (const node of bounds) {
      const resolved = resolveJsonSchemaReference(schema, node);
      expect(resolved.type).toBe("object");
      expect(resolved.anyOf).toBeUndefined();
    }
  },
);

test("Zod ref conversion retains strict representability, cycle and override contracts", () => {
  const shared = z.object({ value: z.string() });
  withJsonSchemaOverride(shared, (schema) => {
    schema.minProperties = 1;
  });
  const schema = toJSONSchema(z.object({ left: shared, right: shared }), {
    reused: "ref",
    override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
  });
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  const draft7 = toJSONSchema(z.object({ left: shared, right: shared }), {
    reused: "ref",
    target: "draft-7",
  });
  expect(draft7.definitions).toBeObject();
  expect(draft7.$defs).toBeUndefined();
  expect(
    Object.values(schema.$defs ?? {}).some(
      (node) => typeof node === "object" && node.minProperties === 1,
    ),
  ).toBe(true);
  expect(() => toJSONSchema(z.date(), { reused: "ref" })).toThrow();
  const recursive: z.ZodType = z.lazy(() => z.object({ children: z.array(recursive) }));
  expect(JSON.stringify(toJSONSchema(recursive, { reused: "ref" }))).toContain('"$ref":"#"');
  expect(() => toJSONSchema(recursive, { reused: "ref", cycles: "throw" })).toThrow();
});

test("defaults behind reused refs stay optional at every schema level", () => {
  const defaulted = z.string().default("value");
  const shared = z.object({ first: defaulted, second: defaulted });
  const source = z.object({ left: shared, right: shared, first: defaulted, second: defaulted });
  const inline = toAdvertisedJsonSchema(source, { constrainAppIds: false });
  const referenced = toAdvertisedJsonSchema(source, { constrainAppIds: false, reused: "ref" });
  expect(referenced.required).toEqual(["left", "right"]);
  for (const value of [
    { left: {}, right: {} },
    { left: { first: 42 }, right: {} },
  ]) {
    expect(compileAjv2020(referenced)(value)).toBe(compileAjv2020(inline)(value));
  }
  expect(compileAjv2020(referenced)({ left: {}, right: {} })).toBe(true);
});
