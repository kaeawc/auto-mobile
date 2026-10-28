import { internalMcpSessionId } from "./internalToolParams";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

/** Device-pin identity only; ownership and autolock retain their existing caller identity. */
export function deviceConnectionIdFor(args: object): string | undefined {
  const context = getToolSelectionContext();
  return [
    internalMcpSessionId(args),
    context?.callerMcpSessionId,
    context?.deviceConnectionKey,
  ].find((id): id is string => typeof id === "string" && id.trim().length > 0);
}
