import type { ObserveResult } from "../models/ObserveResult";
import {
  sanitizeObserveResult,
  diffObserveResult,
  isSameObservationScreen,
  type SanitizeObserveConfig,
} from "../features/observe/output/ObserveResultOutput";
import { serverConfig } from "../utils/ServerConfig";
import { getStructuredPayload, stringifyToolResponse } from "../utils/toolUtils";

/**
 * Read/write access to the per-session diff baseline — the "last observation
 * output to the agent" (#2761). Injected (interface + fake) so `finalizeToolResponse`
 * stays free of a direct `sessionManager`/`DaemonState` dependency; the call site
 * backs it with `SessionManager.setLastRenderedObservation` /
 * `getSessionCache(...).lastRenderedObservation`.
 */
export interface ObservationBaselineStore {
  get(sessionUuid: string): ObserveResult | undefined;
  set(sessionUuid: string, observation: ObserveResult): void;
}

/**
 * Context needed to finalize a tool response at the serialization chokepoint.
 * `name` selects where the `ObserveResult` lives (top-level for `observe`, else
 * `.observation`); `sessionUuid` keys the diff baseline. `baselineStore` enables
 * the `--actions-diff-observe` diff emit — when absent (or the flag is off) the
 * full sanitized observation is emitted, today's behavior. `--actions-no-observe`
 * (higher precedence) needs neither and strips the observation outright.
 */
export interface FinalizeToolResponseContext {
  name: string;
  sessionUuid?: string;
  baselineStore?: ObservationBaselineStore;
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
  const structuredPayload = getStructuredPayload<Record<string, unknown>>(envelope);
  const hasStructured = structuredPayload !== undefined;

  const textPart =
    Array.isArray(envelope.content) &&
    envelope.content[0]?.type === "text" &&
    typeof envelope.content[0].text === "string"
      ? envelope.content[0]
      : undefined;

  let payload: Record<string, unknown> | undefined;
  if (structuredPayload) {
    payload = structuredPayload;
  } else if (textPart) {
    try {
      const parsed = JSON.parse(textPart.text as string);
      if (parsed && typeof parsed === "object") {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — nothing to sanitize, leave the response as-is.
      return response;
    }
  }

  if (!payload) {
    return response;
  }

  const cfg: SanitizeObserveConfig = {
    dropElements: serverConfig.isObserveResultDropElementsEnabled(),
    compact: serverConfig.isObserveResultCompactEnabled(),
  };

  const noObserveEnabled = serverConfig.isActionsNoObserveEnabled();
  // Precedence (#3026 / #2762): `--actions-no-observe` strips the embedded
  // observation entirely, so `--actions-diff-observe` is moot when both are on.
  const diffActive = serverConfig.isActionsDiffObserveEnabled() && !noObserveEnabled;
  const canDiff = diffActive && !!ctx.sessionUuid && !!ctx.baselineStore;
  const isObserveTool = ctx.name === "observe";

  // Locate the ObserveResult: the payload itself for `observe`, else `.observation`.
  let sanitizedPayload: Record<string, unknown> | undefined;
  if (isObserveTool && isObserveResult(payload)) {
    // `observe` always emits the full sanitized observation (no-observe never
    // strips the observe tool itself) and resets the diff baseline to it (#2761).
    const sanitized = sanitizeObserveResult(payload as unknown as ObserveResult, cfg);
    if (canDiff) {
      ctx.baselineStore!.set(ctx.sessionUuid!, sanitized);
    }
    sanitizedPayload = sanitized as unknown as Record<string, unknown>;
  } else if (!isObserveTool && payload.observation !== undefined) {
    if (noObserveEnabled) {
      // `--actions-no-observe` (#2762/#3026): drop the embedded observation from
      // the served payload (output-only — the handler still computed it for its
      // own success detection). Wins over the diff flag: nothing left to diff.
      const stripped = { ...payload };
      delete stripped.observation;
      sanitizedPayload = stripped;
    } else if (isObserveResult(payload.observation)) {
      const sanitized = sanitizeObserveResult(payload.observation as ObserveResult, cfg);
      let observationOut: unknown = sanitized;
      if (canDiff) {
        // Emit a diff vs the baseline when it exists and the screen is unchanged;
        // otherwise fall back to the full observation (cross-screen diffs are
        // meaningless, and there is nothing to diff on the first action). Either
        // way, update the baseline to this observation so the next action diffs
        // against current state.
        const baseline = ctx.baselineStore!.get(ctx.sessionUuid!);
        if (baseline && isSameObservationScreen(baseline, sanitized)) {
          observationOut = diffObserveResult(baseline, sanitized);
        }
        ctx.baselineStore!.set(ctx.sessionUuid!, sanitized);
      }
      sanitizedPayload = {
        ...payload,
        observation: observationOut,
      };
    }
  }

  if (!sanitizedPayload) {
    return response;
  }

  // Rewrite both representations from the same object so they cannot diverge.
  if (hasStructured) {
    envelope.structuredContent = sanitizedPayload;
  }
  if (textPart) {
    textPart.text = stringifyToolResponse(sanitizedPayload);
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
