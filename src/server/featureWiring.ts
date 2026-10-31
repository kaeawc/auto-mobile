import { registerInternalToolCaller } from "../features/navigation/InternalToolCaller";
import { registerConfigurableToolNameSource } from "../features/toolSelection/configurableToolNames";
import { ToolRegistry } from "./toolRegistry";

/**
 * Registers the tool registry with the feature-tier ports that need it (internal tool calls and
 * the configurable tool names). toolRegistry.ts imports this module for the side effect; the
 * `ToolRegistry` binding is only read when a port is called, so the import cycle is harmless.
 */
registerInternalToolCaller({
  getTool: (name) => ToolRegistry.getTool(name),
  // A handle came from getTool(), so re-resolving it by name yields the same registered tool.
  callInternal: (tool, args, progress, signal) =>
    ToolRegistry.callInternal(typeof tool === "string" ? tool : tool.name, args, progress, signal),
  callInternalTyped: (name, args, progress, signal) =>
    ToolRegistry.callInternalTyped(name, args, { progress, signal }),
});
registerConfigurableToolNameSource({
  getConfigurableToolNames: () => ToolRegistry.getConfigurableToolNames(),
});
