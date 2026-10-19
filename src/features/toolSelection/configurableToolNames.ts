import { ActionableError } from "../../models/ActionableError";

/** Supplies the names of tools a session can enable or disable; implemented by the tool registry. */
export interface ConfigurableToolNameSource {
  getConfigurableToolNames(): string[];
}

let registered: ConfigurableToolNameSource | undefined;

export function registerConfigurableToolNameSource(
  source: ConfigurableToolNameSource | undefined,
): void {
  registered = source;
}

export function getConfigurableToolNames(): string[] {
  if (!registered) {
    throw new ActionableError(
      "No configurable tool name source is registered; the MCP tool registry has not been loaded.",
    );
  }
  return registered.getConfigurableToolNames();
}
