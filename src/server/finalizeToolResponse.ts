import { ToolResponseSerialization } from "./ToolResponseSerialization";
import { ObservationDisplayRenderer, isObserveResult } from "./ObservationDisplayRenderer";
import { readToolEnvelopePayload, writeToolEnvelopePayload } from "../daemon/toolEnvelopePayload";
import { appendArtifactResourceLinks } from "./finalizeToolResponse/artifactResourceLinks";
import type { FinalizeToolResponseContext } from "./finalizeToolResponse/contracts";
import {
  createFinalizationState,
  renderObservePayload,
  renderActionPayload,
  commitDeliveredBaseline,
} from "./finalizeToolResponse/observationRendering";
import {
  artifactRenderedPayload,
  boundRenderedPayload,
} from "./finalizeToolResponse/responseArtifacts";
import {
  compactRenderedPayload,
  commitDeliveredActionMetadata,
} from "./finalizeToolResponse/actionMetadata";

export type {
  ObservationBaselineStore,
  ObservationArtifactPayload,
  ObservationArtifactMetadata,
  ObservationArtifactWriteInput,
  ObservationArtifactWriter,
  FinalizeToolResponseContext,
} from "./finalizeToolResponse/contracts";
export { DEFAULT_OBSERVATION_INLINE_MAX_BYTES } from "./finalizeToolResponse/responseArtifacts";
export { DIFF_PASSTHROUGH_METADATA_FIELDS } from "./finalizeToolResponse/observationRendering";

/**
 * Single post-handler serialization hook (issue #2758). Handlers pre-serialize
 * via `createStructuredToolResponse` into an MCP envelope
 * `{ content: [{ type: "text", text }], structuredContent }`. This runs once at
 * `toolRegistry.ts` return and shrinks the one `ObserveResult` the payload may
 * carry, rewriting BOTH representations so the wire text and `structuredContent`
 * never disagree.
 *
 * Output-only: `sanitizeObserveResult` deep-clones, so the handler's in-memory
 * result (and anything already cached from it, e.g. `lastHierarchy`) is
 * untouched. Non-envelope, image, non-JSON-text, and non-observe payloads pass
 * through unchanged — a safe no-op.
 */
export function finalizeToolResponse<T>(response: T, ctx: FinalizeToolResponseContext): T {
  if (!response || typeof response !== "object") {
    return response;
  }

  // Prefer structuredContent; fall back to the serialized text part when a tool
  // returned text only. Anything else (image parts, non-JSON text) is left alone.
  const envelopeView = readToolEnvelopePayload(response);
  if (!envelopeView) {
    return response;
  }
  const serialization = new ToolResponseSerialization();
  const artifactWriter = ctx.artifactWriter;
  if (artifactWriter) {
    ctx = {
      ...ctx,
      artifactWriter: {
        writeJsonArtifact: (input) =>
          artifactWriter.writeJsonArtifact({
            ...input,
            serialized: input.serialized ?? serialization.artifact(input.data),
          }),
      },
    };
  }
  const payload = envelopeView.payload;
  // Internal callers and an explicit includeExtras opt-in keep accessibility
  // `extras` in structuredContent; every other delivery strips them like the text.
  const hasStructured = envelopeView.hasStructured && keepsStructuredExtras(ctx);

  const state = createFinalizationState(ctx, payload);
  const { isObserveTool } = state;
  const renderedDisplay = ObservationDisplayRenderer.displayMetadata(state);
  if (isObserveTool && isObserveResult(payload)) {
    renderObservePayload(payload, state);
  } else if (!isObserveTool && payload.observation !== undefined) {
    renderActionPayload(state);
  }
  let sanitizedPayload = artifactRenderedPayload(state, hasStructured, serialization);
  sanitizedPayload = boundRenderedPayload(
    ctx,
    payload,
    sanitizedPayload,
    hasStructured,
    serialization,
  );

  // Artifacts retain complete metadata. Compact only the residue delivered inline,
  // and preserve the original envelope when compaction has nothing to remove.
  sanitizedPayload = compactRenderedPayload(ctx, payload, envelopeView.envelope, sanitizedPayload);

  // Only rebuild when the cached complete and stripped renderings differ. This
  // also covers non-observation payloads that otherwise take the early exit.
  sanitizedPayload = stripStructuredExtras(ctx, envelopeView, serialization, sanitizedPayload);

  if (!sanitizedPayload) {
    commitDeliveredActionMetadata(ctx, payload, payload);
    return response;
  }

  // Rewrite both representations from the same object so they cannot diverge.
  writeToolEnvelopePayload(
    envelopeView,
    sanitizedPayload,
    envelopeView.textPart ? serialization.text(sanitizedPayload) : undefined,
  );
  appendArtifactResourceLinks(envelopeView.envelope, sanitizedPayload, ctx.internal === true);
  commitDeliveredActionMetadata(ctx, payload, sanitizedPayload);
  commitDeliveredBaseline(ctx, state.pendingBaselineUpdate, renderedDisplay);

  return response;
}

function keepsStructuredExtras(ctx: FinalizeToolResponseContext): boolean {
  return ctx.internal === true || ctx.args?.includeExtras === true;
}

/** Strip extras from the delivered structuredContent unless the caller opted in. */
function stripStructuredExtras(
  ctx: FinalizeToolResponseContext,
  view: { payload: Record<string, unknown>; hasStructured: boolean },
  serialization: ToolResponseSerialization,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!view.hasStructured || keepsStructuredExtras(ctx)) {
    return current;
  }
  const delivered = current ?? view.payload;
  const stripped = serialization.stripExtras(delivered);
  return stripped === delivered ? current : stripped;
}
