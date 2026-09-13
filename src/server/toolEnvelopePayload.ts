import { getStructuredPayload, stringifyToolResponse } from "../utils/toolUtils";
import { logger } from "../utils/logger";

/**
 * The two representations an MCP tool envelope may carry for the same payload:
 * `structuredContent` and the serialized `content[0].text`. They must never
 * disagree on the wire, so every post-handler rewrite reads through
 * {@link readToolEnvelopePayload} and writes through
 * {@link writeToolEnvelopePayload}.
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
 * The payload fields `createStructuredToolResponse` copies onto the ENVELOPE
 * beside `content`/`structuredContent`, with the primitive type the envelope
 * declares for each. They are a third representation of the same payload, so a
 * rewrite that changes one of them must move all three together — bounding only
 * `structuredContent` once left a 70 KB `error` hoisted at the top level, over
 * the very ceiling the rewrite existed to enforce (#6870).
 */
const HOISTED_ENVELOPE_FIELDS = {
  success: "boolean",
  error: "string",
} as const;

/**
 * Locate the JSON payload of a tool envelope. Prefers `structuredContent`,
 * falling back to the serialized text part for tools that returned text only.
 * Returns `undefined` for anything else (image parts, non-JSON text, a
 * non-object response) so callers can no-op safely.
 */
export function readToolEnvelopePayload(response: unknown): ToolEnvelopeView | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const envelope = response as ToolEnvelopeView["envelope"];
  const structuredPayload = getStructuredPayload<Record<string, unknown>>(envelope);
  const textPart =
    Array.isArray(envelope.content) &&
    envelope.content[0]?.type === "text" &&
    typeof envelope.content[0].text === "string"
      ? envelope.content[0]
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

/** Rewrite every representation from the same object so they cannot diverge. */
export function writeToolEnvelopePayload(
  view: ToolEnvelopeView,
  payload: Record<string, unknown>,
): void {
  if (view.hasStructured) {
    view.envelope.structuredContent = payload;
  }
  if (view.textPart) {
    view.textPart.text = stringifyToolResponse(payload);
  }
  syncHoistedEnvelopeFields(view.envelope, payload);
}

/**
 * Re-mirror the hoisted `success`/`error` from the payload that was just
 * written.
 *
 * Only fields the envelope ALREADY hoists are touched, so this never invents a
 * top-level field on an envelope whose producer did not hoist one. A payload
 * value the hoisted field cannot represent — `error` replaced by the
 * `{ _truncated, bytes }` marker of an over-ceiling spill — drops the hoist
 * rather than putting a non-string there: `structuredContent` stays the single
 * source of truth, and the hoisted `success: false` still carries the failure
 * signal a client acts on.
 */
function syncHoistedEnvelopeFields(
  envelope: ToolEnvelopeObject,
  payload: Record<string, unknown>,
): void {
  const target = envelope as Record<string, unknown>;
  for (const [field, primitive] of Object.entries(HOISTED_ENVELOPE_FIELDS)) {
    if (!(field in target)) {
      continue;
    }
    if (typeof payload[field] === primitive) {
      target[field] = payload[field];
    } else {
      delete target[field];
    }
  }
}
