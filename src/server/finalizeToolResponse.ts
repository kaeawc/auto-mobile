import type { ObserveResult } from "../models/ObserveResult";
import { sanitizeObserveResult, type SanitizeObserveConfig } from "../features/observe/output/ObserveResultOutput";
import { serverConfig } from "../utils/ServerConfig";
import { stringifyToolResponse } from "../utils/toolUtils";

/**
 * Context needed to finalize a tool response at the serialization chokepoint.
 * `name` selects where the `ObserveResult` lives (top-level for `observe`, else
 * `.observation`); `sessionUuid` is accepted for symmetry with the call site and
 * future per-session gating, though the current sanitize config is global.
 */
export interface FinalizeToolResponseContext {
  name: string;
  sessionUuid?: string;
}

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

  const envelope = response as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };

  // Prefer structuredContent; fall back to the serialized text part when a tool
  // returned text only. Anything else (image parts, non-JSON text) is left alone.
  const hasStructured =
    envelope.structuredContent !== undefined &&
    envelope.structuredContent !== null &&
    typeof envelope.structuredContent === "object";

  const textPart =
    Array.isArray(envelope.content) &&
    envelope.content[0]?.type === "text" &&
    typeof envelope.content[0].text === "string"
      ? envelope.content[0]
      : undefined;

  let payload: Record<string, unknown> | undefined;
  if (hasStructured) {
    payload = envelope.structuredContent as Record<string, unknown>;
  } else if (textPart) {
    try {
      const parsed = JSON.parse(textPart.text as string);
      if (parsed && typeof parsed === "object") {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — nothing to sanitize. Still fall through so the
      // structuredContent strip below runs (a no-op when it is absent).
    }
  }

  if (payload) {
    const cfg: SanitizeObserveConfig = {
      dropElements: serverConfig.isObserveResultDropElementsEnabled(),
    };

    // Locate the ObserveResult: the payload itself for `observe`, else `.observation`.
    let sanitizedPayload: Record<string, unknown> | undefined;
    if (ctx.name === "observe" && isObserveResult(payload)) {
      sanitizedPayload = sanitizeObserveResult(payload as unknown as ObserveResult, cfg) as unknown as Record<string, unknown>;
    } else if (isObserveResult(payload.observation)) {
      sanitizedPayload = {
        ...payload,
        observation: sanitizeObserveResult(payload.observation as ObserveResult, cfg),
      };
    }

    // Rewrite both representations from the same object so they cannot diverge.
    if (sanitizedPayload) {
      if (hasStructured) {
        envelope.structuredContent = sanitizedPayload;
      }
      if (textPart) {
        textPart.text = stringifyToolResponse(sanitizedPayload);
      }
    }
  }

  // Strip `structuredContent` when the gate is enabled (issue #2899). This runs
  // AFTER the sanitize step, so `content[0].text` already carries the sanitized
  // payload and remains the single source of truth — dropping the redundant
  // duplicate halves the wire payload with no information loss. Applies to every
  // envelope shape (observe, action, and plain payloads alike); the matching
  // `outputSchema` is dropped from `tools/list` so the server never advertises
  // structured output it will not return.
  if (serverConfig.isToolResultsNoStructuredContentEnabled() && "structuredContent" in envelope) {
    delete envelope.structuredContent;
  }

  return response;
}

/**
 * A value is treated as an `ObserveResult` for sanitization purposes when it is
 * an object carrying a `viewHierarchy`. This is intentionally lax: sanitize is a
 * safe no-op on a result with no hierarchy/elements/perf, but requiring the
 * marker field avoids cloning arbitrary success payloads for nothing.
 */
function isObserveResult(value: unknown): value is ObserveResult {
  return (
    !!value &&
    typeof value === "object" &&
    "viewHierarchy" in (value as Record<string, unknown>)
  );
}
