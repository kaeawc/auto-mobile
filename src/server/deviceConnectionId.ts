import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

/** Device-pin identity only; ownership and autolock retain their existing caller identity. */
export function deviceConnectionIdFor(): string | undefined {
  const context = getToolSelectionContext();
  return [
    context?.autolockMcpSessionId,
    context?.callerMcpSessionId,
    context?.deviceConnectionKey,
  ].find((id): id is string => typeof id === "string" && id.trim().length > 0);
}
