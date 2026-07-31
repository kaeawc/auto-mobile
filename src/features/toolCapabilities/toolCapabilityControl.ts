export const SET_TOOL_CAPABILITY_TOOL_NAME = "setToolCapability";

function textContent(response: unknown): string[] {
  if (!response || typeof response !== "object") {
    return [];
  }
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap(item => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") {
      return [];
    }
    const text = (item as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
}

function sessionUuidFromJson(text: string): string | undefined {
  try {
    const sessionUuid = (JSON.parse(text) as { sessionUuid?: unknown }).sessionUuid;
    return typeof sessionUuid === "string" && sessionUuid.trim().length > 0 ? sessionUuid : undefined;
  } catch (error) {
    // Other text responses are not the control-tool result. Do not hide an
    // unexpected parser failure from a custom JSON implementation.
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return undefined;
  }
}

/** Extract the persisted profile returned by the capability-control tool. */
export function capabilityProfileUuidFromToolResponse(response: unknown): string | undefined {
  return textContent(response)
    .map(sessionUuidFromJson)
    .find((sessionUuid): sessionUuid is string => sessionUuid !== undefined);
}
