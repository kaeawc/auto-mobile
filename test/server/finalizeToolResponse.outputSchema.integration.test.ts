import { z } from "zod/v4";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ValidateFunction } from "ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { advertisedOutputSchema } from "../helpers/advertisedOutputSchemas";
import {
  OUTPUT_SCHEMA_FIXTURES,
  finalizedSchemaFixture,
  invalidSchemaFixtures,
} from "../helpers/outputSchemaFixtureCases";
import { addSpillArtifactToAdvertisedOutputSchema } from "../../src/server/pipeline/advertisedSchema";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { createMcpServer } from "../../src/server/index";
import {
  DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
  finalizeToolResponse,
} from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";

const restoreTools = preserveToolRegistry();
afterAll(restoreTools);

beforeEach(() => {
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
});

afterEach(() => {
  PlatformDeviceManagerFactory.reset();
});

type ObjectOutputSchema = {
  shape: Record<string, { isOptional(): boolean }>;
};

type ZodFieldSchema = {
  def?: {
    type?: string;
    entries?: Record<string, unknown>;
    values?: readonly unknown[];
    element?: unknown;
    shape?: Record<string, unknown>;
    options?: readonly unknown[];
    out?: unknown;
  };
};

function requiredTopLevelKeys(schema: unknown): string[] {
  const shape = (schema as Partial<ObjectOutputSchema> | undefined)?.shape;
  if (!shape || typeof shape !== "object") {
    return [];
  }
  return Object.entries(shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);
}

/** Minimal valid value for the Zod types used by registered object output schemas. */
function minimalFieldValue(schema: unknown): unknown {
  const definition = (schema as ZodFieldSchema).def;
  switch (definition?.type) {
    case "string":
      return "value";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "enum":
      return Object.values(definition.entries ?? {})[0];
    case "literal":
      return definition.values?.[0];
    case "array":
      return [];
    case "record":
      return {};
    case "object":
      return Object.fromEntries(
        Object.entries(definition.shape ?? {})
          .filter(([, field]) => !(field as { isOptional?: () => boolean }).isOptional?.())
          .map(([key, field]) => [key, minimalFieldValue(field)]),
      );
    case "union":
      return minimalFieldValue(definition.options?.[0]);
    case "pipe":
      return minimalFieldValue(definition.out);
    default:
      return null;
  }
}

// Populate the singleton before test collection, matching schema.integration.test.ts.
PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
try {
  createMcpServer();
} finally {
  PlatformDeviceManagerFactory.reset();
}

// Non-object output schemas have no top-level required field contract to preserve.
// This representative roster deliberately includes every advertised registered
// ZodObject schema with required fields.
const OBJECT_OUTPUT_TOOLS = ToolRegistry.getToolDefinitions()
  .map((definition) => ToolRegistry.getRegisteredTool(definition.name))
  .filter((tool): tool is NonNullable<typeof tool> => tool?.outputSchema !== undefined)
  .map((tool) => ({ tool, requiredKeys: requiredTopLevelKeys(tool.outputSchema) }))
  .filter(({ requiredKeys }) => requiredKeys.length > 0);

const fixtureValidators = new Map<
  string,
  {
    inline: ValidateFunction;
    referenced: ValidateFunction;
    sdk: JsonSchemaValidator<unknown>;
    cfworker: JsonSchemaValidator<unknown>;
  }
>();
const finalizedFixtures = new Map<string, Record<string, unknown>>();
const residueValidators = new Map<
  string,
  { inline: ValidateFunction; referenced: ValidateFunction }
>();
// Compiles two Ajv validators per registered tool plus every fixture, so the
// cost grows with the registry and crosses bun's 5s hook default on a loaded
// runner.
const VALIDATOR_COMPILE_TIMEOUT_MS = 30_000;
beforeAll(() => {
  const sdk = new AjvJsonSchemaValidator();
  const cfworker = new CfWorkerJsonSchemaValidator();
  for (const definition of ToolRegistry.getToolDefinitions({ includeUnavailable: true })) {
    const source = ToolRegistry.getRegisteredTool(definition.name)?.outputSchema;
    if (definition.outputSchema && source) {
      residueValidators.set(definition.name, {
        inline: compileAjv2020(advertisedOutputSchema(source, "inline")),
        referenced: compileAjv2020(definition.outputSchema),
      });
    }
  }
  for (const fixture of OUTPUT_SCHEMA_FIXTURES) {
    if (!fixtureValidators.has(fixture.name)) {
      const registered = ToolRegistry.getRegisteredTool(fixture.name)!;
      const schema = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
        (tool) => tool.name === fixture.name,
      )!.outputSchema!;
      fixtureValidators.set(fixture.name, {
        inline: compileAjv2020(advertisedOutputSchema(registered.outputSchema!, "inline")),
        referenced: compileAjv2020(schema),
        sdk: sdk.getValidator(schema),
        cfworker: cfworker.getValidator(schema),
      });
    }
    for (const project of ["full", "skeleton"] as const) {
      finalizedFixtures.set(
        `${fixture.label}:${project}`,
        finalizedSchemaFixture(fixture, project),
      );
    }
  }
}, VALIDATOR_COMPILE_TIMEOUT_MS);

describe("referenced output schemas preserve captured structuredContent validation", () => {
  for (const project of ["full", "skeleton"] as const) {
    test.each(OUTPUT_SCHEMA_FIXTURES)(
      `$label (${project}) has identical inline, ref, SDK Ajv and cfworker verdicts`,
      (fixture) => {
        const payload = finalizedFixtures.get(`${fixture.label}:${project}`)!;
        const validators = fixtureValidators.get(fixture.name)!;
        expect(validators.inline(payload), JSON.stringify(validators.inline.errors)).toBe(true);
        for (const [value, expected] of [
          [payload, true],
          ...invalidSchemaFixtures(fixture.name, payload).map((mutant) => [mutant, false] as const),
        ] as const) {
          const oldVerdict = validators.inline(value);
          expect(oldVerdict).toBe(expected);
          expect(validators.referenced(value)).toBe(oldVerdict);
          expect(validators.sdk(value).valid).toBe(oldVerdict);
          expect(validators.cfworker(value).valid).toBe(oldVerdict);
        }
      },
    );
  }
});

test("spill advertisement visits every referenced response arm without adding nested artifacts", () => {
  const strictArm = () => ({
    type: "object",
    properties: { nested: { type: "object", additionalProperties: false } },
    additionalProperties: false,
  });
  const schema = {
    anyOf: [{ $ref: "#/$defs/left" }, { oneOf: [{ $ref: "#/$defs/right" }] }],
    $defs: { left: strictArm(), right: strictArm() },
  };
  addSpillArtifactToAdvertisedOutputSchema(schema);
  expect(schema.anyOf[0]).toHaveProperty("properties.artifact");
  expect(schema.anyOf[1]).toHaveProperty("oneOf.0.properties.artifact");
  for (const arm of Object.values(schema.$defs)) {
    expect(arm.properties).not.toHaveProperty("artifact");
  }
  expect(schema.anyOf[0]).not.toHaveProperty("properties.nested.properties.artifact");
});

test("spill response overrides do not loosen a definition also used by a nested observation", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    anyOf: [
      { $ref: "#/$defs/arm" },
      {
        type: "object",
        properties: { observation: { $ref: "#/$defs/arm" } },
        required: ["observation"],
        additionalProperties: false,
      },
    ],
    $defs: {
      arm: {
        type: "object",
        properties: { success: { type: "boolean" } },
        required: ["success"],
        additionalProperties: false,
      },
    },
  };
  addSpillArtifactToAdvertisedOutputSchema(schema);
  const validate = compileAjv2020(schema);
  expect(validate({ observation: { success: true } })).toBe(true);
  expect(validate({ observation: { success: true, artifact: {} } })).toBe(false);
});

describe("spilled output-schema residue contract (#6950)", () => {
  test("covers multiple registered object output schemas", () => {
    expect(OBJECT_OUTPUT_TOOLS.length).toBeGreaterThan(1);
    const names = OBJECT_OUTPUT_TOOLS.map(({ tool }) => tool.name);
    for (const name of [
      "wakeAndUnlock",
      "pressButton",
      "launchApp",
      "terminateApp",
      "getDeviceState",
      "setDeviceState",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).toContain("rotate");
    expect(names).toContain("setPosture");
  });

  test("advertises the optional artifact added to a spilled setUIState response", () => {
    const generatedSchema = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
      (definition) => definition.name === "setUIState",
    )?.outputSchema as
      | {
          properties?: Record<string, unknown>;
          required?: string[];
        }
      | undefined;
    const tool = ToolRegistry.getRegisteredTool("setUIState");
    expect(generatedSchema).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();

    const finalized = finalizeToolResponse(
      createStructuredToolResponse({
        success: true,
        fields: [],
        totalAttempts: 1,
        padding: "x".repeat(DEFAULT_OBSERVATION_INLINE_MAX_BYTES + 1_024),
      }),
      {
        name: "setUIState",
        outputSchema: tool!.outputSchema,
        artifactMode: "oversized",
        artifactWriter: new FakeArtifactWriter(),
      },
    );

    expect(generatedSchema!.properties?.artifact).toBeDefined();
    expect(generatedSchema!.required).not.toContain("artifact");
    expect(compileAjv2020(generatedSchema!)(finalized.structuredContent)).toBe(true);
  });

  test.each(
    OBJECT_OUTPUT_TOOLS.map(({ tool, requiredKeys }) => [tool.name, tool, requiredKeys] as const),
  )(
    "%s preserves every required top-level output field after a spill",
    (_name, tool, requiredKeys) => {
      if (!(tool.outputSchema instanceof z.ZodObject)) {
        throw new Error("Expected object output schema");
      }
      const shape = tool.outputSchema.shape;
      const payload = Object.fromEntries(
        requiredKeys.map((key) => [key, minimalFieldValue(shape[key])]),
      );
      expect(
        (tool.outputSchema as { safeParse(value: unknown): { success: boolean } }).safeParse(
          payload,
        ).success,
      ).toBe(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          ...payload,
          padding: "x".repeat(DEFAULT_OBSERVATION_INLINE_MAX_BYTES + 1_024),
        }),
        {
          name: tool.name,
          outputSchema: tool.outputSchema,
          artifactMode: "oversized",
          artifactWriter: new FakeArtifactWriter(),
        },
      );

      const residue = finalized.structuredContent as Record<string, unknown>;
      for (const key of requiredKeys) {
        expect(residue[key]).toBe(payload[key]);
      }
      expect(residue.padding).toBeUndefined();
      const validators = residueValidators.get(tool.name)!;
      // These minimal synthetic payloads preserve the runtime-required fields;
      // parity also covers wire overrides that require additional metadata.
      expect(validators.referenced(residue)).toBe(validators.inline(residue));
    },
  );
});
