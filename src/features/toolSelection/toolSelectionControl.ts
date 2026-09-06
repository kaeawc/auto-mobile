export const SET_TOOL_ENABLED_TOOL_NAME = "setToolEnabled";

/**
 * The daemon IDE-socket method (src/daemon/socketServer.ts, `ide/setSessionToolEnabled` case)
 * that grants a tool for a session over the direct IDE socket channel. Rejections raised on that
 * channel (`ide/setKeyValue`, `ide/removeKeyValue`, `ide/clearKeyValueFile`) must name THIS method
 * in their remediation, not the MCP `setToolEnabled` tool — a caller on the socket channel has no
 * way to invoke an MCP tool (issue #6259).
 */
export const IDE_SET_SESSION_TOOL_ENABLED_METHOD = "ide/setSessionToolEnabled";

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
