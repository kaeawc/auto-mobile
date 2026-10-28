import { isAlwaysLoadToolsEnabled } from "../config/alwaysLoadTools";
import type { DeviceReadOnlyArgShape } from "../daemon/deviceReadOnlyArgShapes";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import { serverConfig } from "../utils/ServerConfig";
import { RegisteredTool, ToolListingOptions, withItemsEnum } from "./toolRegistryTypes";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { TOOL_ANNOTATIONS } from "./toolAnnotations";
export class ToolDefinitionListing {
  constructor(
    private readonly getAllTools: (options: ToolListingOptions) => RegisteredTool[],
    private readonly isUserConfigurableTool: (name: string) => boolean,
    private readonly getCachedToolDefinitionSchemas: (
      tool: RegisteredTool,
      suppressOutputSchema: boolean,
      compactBounds: boolean,
    ) => {
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown> | undefined;
    },
  ) {}

  // Get tools in MCP format
  getToolDefinitions(options: ToolListingOptions = {}) {
    const alwaysLoad = isAlwaysLoadToolsEnabled();
    // When tool results are stripped of `structuredContent` (issue #2899), do not
    // advertise an `outputSchema` in `tools/list`: an MCP server that declares an
    // output schema is expected to return matching `structuredContent`, so keeping
    // both consistent avoids advertising output the finalize step will strip.
    const suppressOutputSchema =
      options.suppressOutputSchema ?? serverConfig.isToolResultsNoStructuredContentEnabled();
    // Bounds compaction is now an unconditional default, so the tuple arm is always
    // emitted and therefore always advertised — keeping the advertised shape in sync
    // with the wire (issue #2990), the same way `suppressOutputSchema` above keeps the
    // two in sync for the strip flag.
    const compactBounds = true;
    // Name order (code-unit, locale-independent) keeps tools/list byte-identical however tools
    // were registered, so client and prompt caches stay stable (#13943).
    const listedTools = [...this.getAllTools(options)].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const configurableToolNames = listedTools
      .filter((tool) => this.isUserConfigurableTool(tool.name))
      .map((tool) => tool.name)
      .sort();
    return listedTools.map((tool) => {
      const { inputSchema, outputSchema } = this.getCachedToolDefinitionSchemas(
        tool,
        suppressOutputSchema,
        compactBounds,
      );

      const definition: {
        name: string;
        title?: string;
        annotations?: ToolAnnotations;
        description: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        _meta?: {
          "anthropic/alwaysLoad"?: boolean;
          "automobile/debugOnly"?: boolean;
          "automobile/embeddedSdkOnly"?: boolean;
          "automobile/planOnly"?: boolean;
          "automobile/deviceReadOnly"?: boolean;
          "automobile/deviceResourceBudget"?: boolean;
          "automobile/deviceReadOnlyArgs"?: readonly DeviceReadOnlyArgShape[];
          ui?: { resourceUri: string };
        };
      } = {
        name: tool.name,
        ...TOOL_ANNOTATIONS[tool.name],
        description: tool.description,
        inputSchema,
      };
      // Keep the compact enabled-tool profile while making optional capabilities
      // discoverable through the always-listed selection control (#6797).
      // Copy the cached schema: availability can change between listings.
      definition.inputSchema = this.withConfigurableToolVocabulary(
        tool.name,
        inputSchema,
        configurableToolNames,
      );
      if (outputSchema) {
        definition.outputSchema = outputSchema;
      }
      if (alwaysLoad) {
        definition._meta = { ...definition._meta, "anthropic/alwaysLoad": true };
      }
      // The committed static catalog includes unavailable tools for schema
      // completeness. Preserve enough generated metadata for the proxy to
      // exclude plan-only tools after a live connection is available.
      if (tool.planOnly) {
        definition._meta = { ...definition._meta, "automobile/planOnly": true };
      }
      if (tool.debugOnly) {
        definition._meta = { ...definition._meta, "automobile/debugOnly": true };
      }
      if (tool.embeddedSdkOnly) {
        definition._meta = { ...definition._meta, "automobile/embeddedSdkOnly": true };
      }
      // Request-budget trait for processes that cannot load the registry (#15672).
      if (tool.deviceResourceBudget) {
        definition._meta = { ...definition._meta, "automobile/deviceResourceBudget": true };
      }
      // Read/control classification for the proxy (#10971) — additive; other clients ignore it.
      if (tool.deviceReadOnly === true) {
        definition._meta = { ...definition._meta, "automobile/deviceReadOnly": true };
      } else if (tool.deviceReadOnlyArgs?.length) {
        definition._meta = {
          ...definition._meta,
          "automobile/deviceReadOnlyArgs": tool.deviceReadOnlyArgs,
        };
      }
      // MCP Apps UI pointer (issue #4669) — additive; non-Apps hosts ignore it.
      if (tool.appUiResourceUri) {
        definition._meta = { ...definition._meta, ui: { resourceUri: tool.appUiResourceUri } };
      }
      return definition;
    });
  }

  /**
   * Decorate the advertised schema with the enum of tool names this listing
   * accepts, so a schema-driven client cannot build a call the handler rejects.
   *
   * Two fields carry that vocabulary: `setToolEnabled`'s `toolName`/`toolNames`
   * (#6797, #6869) and the `enableTools` array the device-acquisition tools
   * (`getAndroid`, `getApple`, `provisionDevice`) take so acquisition and
   * capability declaration are one call. `resolveRequestedEnableTools` rejects
   * every unknown or non-configurable name before any device work starts, so
   * advertising "any non-empty string" there both allowed schema-valid calls
   * that invocation refuses and hid the vocabulary of the one-call flow
   * (#6886 review). Detected by the field's presence rather than a hardcoded
   * tool list, so a future acquisition tool is covered by declaring the field.
   */
  private withConfigurableToolVocabulary(
    toolName: string,
    inputSchema: Record<string, unknown>,
    configurableToolNames: string[],
  ): Record<string, unknown> {
    const properties = inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) {
      return inputSchema;
    }
    if (toolName === SET_TOOL_ENABLED_TOOL_NAME) {
      return {
        ...inputSchema,
        properties: {
          ...properties,
          toolName: { ...properties.toolName, enum: configurableToolNames },
          // #6869 — the batch spelling carries the same vocabulary, so a
          // client declaring a whole toolset in one call reads the choices
          // from the field it is actually filling in.
          toolNames: withItemsEnum(properties.toolNames, configurableToolNames),
        },
      };
    }
    if (!properties.enableTools) {
      return inputSchema;
    }
    return {
      ...inputSchema,
      properties: {
        ...properties,
        enableTools: withItemsEnum(properties.enableTools, configurableToolNames),
      },
    };
  }
}
