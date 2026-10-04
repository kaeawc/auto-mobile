import { logger, type Logger } from "./logger";

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
export function readToolEnvelopePayload(
  response: unknown,
  onParseError?: (error: unknown) => void,
): ToolEnvelopeView | undefined {
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
    if (onParseError) {
      onParseError(error);
      return undefined;
    }
    // Expected: a plain-text tool response is not JSON, so there is no payload
    // to rewrite. Debug-level because it is a routine shape, not a failure.
    logger.debug(`[ToolEnvelopePayload] text part is not JSON: ${error}`);
    return undefined;
  }
  return undefined;
}

export type ToolResultInterpretation =
  | { kind: "payload"; payload: Record<string, unknown>; failure?: Record<string, unknown> }
  | { kind: "no-payload" }
  | { kind: "uninterpretable"; failure: { success: false; error: string } };

function isUnstructuredToolResult(envelope: Record<string, unknown>): boolean {
  if (!("content" in envelope) && !("structuredContent" in envelope)) {
    return true;
  }
  const content = envelope.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (part) =>
        part?.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string",
    )
  );
}

function toolErrorPayload(
  envelope: Record<string, unknown>,
  view: ToolEnvelopeView | undefined,
  toolName: string,
): Record<string, unknown> {
  const payload = view?.payload ?? envelope;
  if (payload.success === false) {
    return payload;
  }
  const textPart = Array.isArray(envelope.content)
    ? envelope.content.find((part) => part?.type === "text" && typeof part.text === "string")
    : undefined;
  return {
    ...payload,
    success: false,
    error:
      payload.error ??
      payload.message ??
      textPart?.text ??
      `Tool "${toolName}" returned failure status`,
  };
}

/**
 * Step handlers serialize object payloads, never plain-text successes. Keep the
 * reader's structured-first precedence and image-only successes, but fail closed
 * on text/other envelopes the step cannot interpret. Client logging can retain
 * its plain-text fallback by ignoring the uninterpretable failure.
 */
export function classifyToolResult(
  response: unknown,
  toolName: string,
  warningLogger: Pick<Logger, "warn"> | null = logger,
): ToolResultInterpretation {
  const failure = {
    success: false as const,
    error: `Tool "${toolName}" result could not be interpreted`,
  };
  if (!response || typeof response !== "object") {
    warningLogger?.warn(failure.error);
    return { kind: "uninterpretable", failure };
  }
  const envelope = response as Record<string, unknown>;
  let parseError: { parseError?: string } = {};
  const view = readToolEnvelopePayload(response, (error) => {
    // JSON.parse messages may quote device output. Retain the error type,
    // never the message or response body, in this unexpected-failure trace.
    parseError = { parseError: error instanceof Error ? error.name : "unknown" };
  });
  if (envelope.isError === true) {
    return {
      kind: "payload",
      payload: view?.payload ?? envelope,
      failure: toolErrorPayload(envelope, view, toolName),
    };
  }
  // Preserve the legacy unwrapped-success contract and direct failure details.
  if ("success" in envelope) {
    return { kind: "payload", payload: envelope };
  }
  if (view) {
    return { kind: "payload", payload: view.payload };
  }
  if (isUnstructuredToolResult(envelope)) {
    return { kind: "no-payload" };
  }
  warningLogger?.warn(failure.error, parseError);
  return { kind: "uninterpretable", failure };
}
