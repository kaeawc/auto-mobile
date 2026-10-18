import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * Shape-checking readers for MCP tool results in tests. Tool handlers return
 * `unknown`; these validate the shape at runtime and throw a descriptive error
 * on mismatch, replacing `(response as any).content[0].text` casts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows a handler result to a `CallToolResult` with a content array. */
export function readToolResponse(response: unknown): CallToolResult {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    throw new Error(
      `tool returned an invalid response (expected { content: [...] }): ${JSON.stringify(response)}`,
    );
  }
  return response as CallToolResult;
}

/** Text of the first content block; throws if it is absent or not a text block. */
export function toolText(response: unknown): string {
  const first: unknown = readToolResponse(response).content[0];
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error(`tool response has no text in content[0]: ${JSON.stringify(response)}`);
  }
  return first.text;
}

/** First content block's text parsed as JSON. */
export function toolJson(response: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(toolText(response));
  if (!isRecord(parsed)) {
    throw new Error(`tool response text is not a JSON object: ${toolText(response)}`);
  }
  return parsed;
}

/** `structuredContent` of the response; throws if absent. */
export function toolStructured(response: unknown): Record<string, unknown> {
  const structured = readToolResponse(response).structuredContent;
  if (!isRecord(structured)) {
    throw new Error(`tool response has no structuredContent: ${JSON.stringify(response)}`);
  }
  return structured;
}

/** Whether the response is flagged as an error (`isError === true`). */
export function toolIsError(response: unknown): boolean {
  return readToolResponse(response).isError === true;
}
