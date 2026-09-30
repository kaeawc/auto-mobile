import { logger } from "./logger";

/**
 * The two representations an MCP tool envelope may carry for the same payload:
 * `structuredContent` and the serialized text content part. They must never
 * disagree on the wire, so every post-handler rewrite reads through
 * {@link readToolEnvelopePayload} and writes through
 * `writeToolEnvelopePayload`.
 */
export interface ToolEnvelopeView {
  payload: Record<string, unknown>;
  hasStructured: boolean;
  textPart?: { type?: string; text?: string };
  envelope: ToolEnvelopeObject;
}

interface ToolEnvelopeObject {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  success?: boolean;
  error?: string;
}

/**
 * Locate the JSON payload of a tool envelope. Prefers `structuredContent`,
 * falling back to the first serialized JSON-object text part for tools that
 * returned text only. A leading image part does not hide a later text part.
 * Returns `undefined` when neither representation is an object payload.
 */
export function readToolEnvelopePayload(response: unknown): ToolEnvelopeView | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const envelope = response as ToolEnvelopeView["envelope"];
  const structuredContent = envelope.structuredContent;
  const structuredPayload =
    structuredContent && typeof structuredContent === "object"
      ? (structuredContent as Record<string, unknown>)
      : undefined;
  const textPart = Array.isArray(envelope.content)
    ? envelope.content.find((part) => part?.type === "text" && typeof part.text === "string")
    : undefined;

  if (structuredPayload) {
    return { payload: structuredPayload, hasStructured: true, textPart, envelope };
  }
  if (!textPart) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(textPart.text as string);
    if (parsed && typeof parsed === "object") {
      return {
        payload: parsed as Record<string, unknown>,
        hasStructured: false,
        textPart,
        envelope,
      };
    }
  } catch (error) {
    // Expected: a plain-text tool response is not JSON, so there is no payload
    // to rewrite. Debug-level because it is a routine shape, not a failure.
    logger.debug(`[ToolEnvelopePayload] text part is not JSON: ${error}`);
    return undefined;
  }
  return undefined;
}
