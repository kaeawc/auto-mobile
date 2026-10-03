import { stringifyToolResponse } from "../utils/toolUtils";
import type { ToolEnvelopeView } from "../utils/toolEnvelopePayload";

export { readToolEnvelopePayload } from "../utils/toolEnvelopePayload";
export type { ToolEnvelopeView } from "../utils/toolEnvelopePayload";

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

/** Rewrite every representation from the same object so they cannot diverge. */
export function writeToolEnvelopePayload(
  view: ToolEnvelopeView,
  payload: Record<string, unknown>,
  serializedText?: string,
): void {
  if (view.hasStructured) {
    view.envelope.structuredContent = payload;
  }
  if (view.textPart) {
    view.textPart.text = serializedText ?? stringifyToolResponse(payload);
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
  envelope: ToolEnvelopeView["envelope"],
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
