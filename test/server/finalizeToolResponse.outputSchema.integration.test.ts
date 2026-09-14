import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { createMcpServer } from "../../src/server/index";
import {
  DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
  finalizeToolResponse,
  type ObservationArtifactMetadata,
  type ObservationArtifactWriteInput,
  type ObservationArtifactWriter,
} from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

class FakeArtifactWriter implements ObservationArtifactWriter {
  writeJsonArtifact(_input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    return {
      artifact: {
        path: "/tmp/auto-mobile/output-schema-contract.json",
        format: "json",
        payload: "ToolResponse",
        bytes: 1,
        tool: "contract",
        resourceUri: "automobile:tool-output/output-schema-contract.json",
      },
    };
  }
}

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
createMcpServer();

// Non-object output schemas have no top-level required field contract to preserve.
// This representative roster deliberately includes every advertised registered
// ZodObject schema with required fields.
const OBJECT_OUTPUT_TOOLS = ToolRegistry.getToolDefinitions()
  .map((definition) => ToolRegistry.getRegisteredTool(definition.name))
  .filter((tool): tool is NonNullable<typeof tool> => tool?.outputSchema !== undefined)
  .map((tool) => ({ tool, requiredKeys: requiredTopLevelKeys(tool.outputSchema) }))
  .filter(({ requiredKeys }) => requiredKeys.length > 0);

describe("spilled output-schema residue contract (#6950)", () => {
  test("covers multiple registered object output schemas", () => {
    expect(OBJECT_OUTPUT_TOOLS.length).toBeGreaterThan(1);
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
    expect(
      new Ajv2020({ strict: false }).compile(generatedSchema!)(finalized.structuredContent),
    ).toBe(true);
  });

  test.each(
    OBJECT_OUTPUT_TOOLS.map(({ tool, requiredKeys }) => [tool.name, tool, requiredKeys] as const),
  )(
    "%s preserves every required top-level output field after a spill",
    (_name, tool, requiredKeys) => {
      const shape = (tool.outputSchema as ObjectOutputSchema).shape;
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
    },
  );
});
