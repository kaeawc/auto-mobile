import type { CallToolResult } from "@modelcontextprotocol/server";
import { getStructuredPayload } from "../../src/utils/toolUtils";

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
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") {
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

/**
 * One own field of the response's `structuredContent`, or `undefined` when the
 * payload is absent or does not carry that key. Mirrors `getStructuredField`
 * for handler results, which resolve to `unknown` and so cannot be passed to it.
 */
export function toolField(response: unknown, key: string): unknown {
  if (!isRecord(response)) {
    return undefined;
  }
  const structured = response.structuredContent;
  if (!isRecord(structured) || !Object.hasOwn(structured, key)) {
    return undefined;
  }
  return structured[key];
}

/**
 * Payload of a handler result via `getStructuredPayload` (structuredContent, else the JSON text
 * block), or `undefined` when the result is not envelope-shaped.
 */
export function toolPayload(response: unknown): Record<string, unknown> | undefined {
  return isRecord(response) ? getStructuredPayload(response) : undefined;
}

/**
 * One entry of a JSON-schema `properties` bag, which the SDK types as `{}` and so
 * cannot be indexed by name. `undefined` when the bag or the key is absent.
 */
export function schemaProperty(properties: unknown, key: string): unknown {
  return Object.entries(isRecord(properties) ? properties : {}).find(([name]) => name === key)?.[1];
}

/** `description` of one JSON-schema property, or `undefined` when absent or not a string. */
export function schemaPropertyDescription(properties: unknown, key: string): string | undefined {
  const property = schemaProperty(properties, key);
  if (!isRecord(property) || typeof property.description !== "string") {
    return undefined;
  }
  return property.description;
}
