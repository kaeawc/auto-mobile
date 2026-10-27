import { ActionableError } from "../../models/ActionableError";
import type { InternalToolName, InternalToolPayloads } from "../../utils/internalToolPayloads";
import type { StructuredToolResponse } from "../../utils/toolUtils";
import type { ProgressCallback } from "../action/BaseVisualChange";

/** What a resolved tool exposes to its internal caller: only the name it was registered under. */
export interface InternalToolHandle {
  readonly name: string;
}

/**
 * The slice of the MCP tool registry that navigation replays and UI-state setup drive: resolve a
 * tool, then call it on behalf of the daemon rather than the agent. The features tier owns this
 * interface; the server's `ToolRegistry` satisfies it structurally and registers itself with
 * {@link registerInternalToolCaller} when it loads.
 */
export interface InternalToolCaller {
  getTool(name: string): InternalToolHandle | undefined;
  callInternal(
    tool: string | InternalToolHandle,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<unknown>;
  callInternalTyped<K extends InternalToolName>(
    name: K,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<StructuredToolResponse<InternalToolPayloads[K]> | undefined>;
}

let registered: InternalToolCaller | undefined;

export function registerInternalToolCaller(caller: InternalToolCaller | undefined): void {
  registered = caller;
}

function current(): InternalToolCaller {
  if (!registered) {
    throw new ActionableError(
      "No internal tool caller is registered; the MCP tool registry has not been loaded.",
    );
  }
  return registered;
}

/**
 * Default caller: resolves the registered one on every call, so it works for objects built
 * before the registry registered itself and keeps honouring method stubs installed later.
 */
export const registeredInternalToolCaller: InternalToolCaller = {
  getTool: (name) => current().getTool(name),
  callInternal: (tool, args, progress, signal) =>
    current().callInternal(tool, args, progress, signal),
  callInternalTyped: (name, args, progress, signal) =>
    current().callInternalTyped(name, args, progress, signal),
};
