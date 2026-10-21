import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

/** Device-pin identity only; ownership and autolock retain their existing caller identity. */
export function deviceConnectionIdFor(args: { __mcpSessionId?: unknown }): string | undefined {
  const context = getToolSelectionContext();
  return [args.__mcpSessionId, context?.callerMcpSessionId, context?.deviceConnectionKey].find(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
}
