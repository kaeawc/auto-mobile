import { advertiseBoundsForCompact } from "./compactBoundsAdvertisement";
import {
  addSpillArtifactToAdvertisedOutputSchema,
  toAdvertisedJsonSchema,
} from "./pipeline/advertisedSchema";
import {
  type CachedToolDefinitionSchemas,
  type RegisteredTool,
  toolHasOutputSchema,
} from "./toolRegistryTypes";

export interface ToolDefinitionSchemas {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | undefined;
}

/**
 * The advertised JSON schemas of the registered tools, converted once per tool.
 *
 * A tool's schemas are a pure function of its Zod sources, which a lookup compares by identity,
 * and of the runtime flags the output cache is keyed by. Re-registering the same schemas (every
 * daemon test re-registers the device tools) or binding a session after an acquisition therefore
 * reuses the conversion instead of regenerating every tool; a replaced schema reconverts. Only a
 * flag toggle (`clear`) drops them all.
 */
export class ToolDefinitionSchemaCache {
  private readonly entries = new Map<string, CachedToolDefinitionSchemas>();
  private conversions = 0;

  /** How many per-tool input conversions this cache has performed. */
  get conversionCount(): number {
    return this.conversions;
  }

  get(
    tool: RegisteredTool,
    suppressOutputSchema: boolean,
    compactBounds: boolean,
  ): ToolDefinitionSchemas {
    let cached = this.entries.get(tool.name);
    if (
      !cached ||
      cached.sourceSchema !== tool.schema ||
      cached.sourceOutputSchema !== tool.outputSchema
    ) {
      this.conversions++;
      cached = {
        sourceSchema: tool.schema,
        sourceOutputSchema: tool.outputSchema,
        inputSchema: toAdvertisedJsonSchema(tool.schema, {
          constrainAppIds: true,
          anthropicSubset: true,
          exposeDeviceId: tool.name === "observe",
        }),
        outputSchemasByRuntimeFlags: new Map(),
      };
      this.entries.set(tool.name, cached);
    }

    const outputSchemaCacheKey = `${suppressOutputSchema}:${compactBounds}`;
    if (!cached.outputSchemasByRuntimeFlags.has(outputSchemaCacheKey)) {
      const outputSchema =
        toolHasOutputSchema(tool) && !suppressOutputSchema
          ? (advertiseBoundsForCompact(
              addSpillArtifactToAdvertisedOutputSchema(
                toAdvertisedJsonSchema(tool.outputSchema, {
                  constrainAppIds: false,
                  // Zod's per-conversion __schemaN definitions stay local to this tool.
                  reused: "ref",
                }),
              ),
              compactBounds,
            ) as Record<string, unknown>)
          : undefined;
      cached.outputSchemasByRuntimeFlags.set(outputSchemaCacheKey, outputSchema);
    }

    return {
      inputSchema: cached.inputSchema,
      outputSchema: cached.outputSchemasByRuntimeFlags.get(outputSchemaCacheKey),
    };
  }

  /** Forget one removed tool's conversions. */
  forget(name: string): void {
    this.entries.delete(name);
  }

  /** Forget every conversion. */
  clear(): void {
    this.entries.clear();
  }
}
