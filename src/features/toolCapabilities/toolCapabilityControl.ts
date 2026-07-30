export const SET_TOOL_CAPABILITY_TOOL_NAME = "setToolCapability";

/** Extract the persisted profile returned by the capability-control tool. */
export function capabilityProfileUuidFromToolResponse(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const item of content) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") {
      continue;
    }
    try {
      const sessionUuid = (JSON.parse(text) as { sessionUuid?: unknown }).sessionUuid;
      if (typeof sessionUuid === "string" && sessionUuid.trim().length > 0) {
        return sessionUuid;
      }
    } catch (error) {
      // Other text responses are not the control-tool result. Do not hide an
      // unexpected parser failure from a custom JSON implementation.
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  return undefined;
}
