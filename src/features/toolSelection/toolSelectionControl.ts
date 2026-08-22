export const SET_TOOL_ENABLED_TOOL_NAME = "setToolEnabled";

function textContent(response: unknown): string[] {
  if (!response || typeof response !== "object") {
    return [];
  }
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
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
    return typeof sessionUuid === "string" && sessionUuid.trim().length > 0
      ? sessionUuid
      : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return undefined;
  }
}

export function toolSelectionProfileUuidFromResponse(response: unknown): string | undefined {
  return textContent(response)
    .map(sessionUuidFromJson)
    .find((sessionUuid): sessionUuid is string => sessionUuid !== undefined);
}
