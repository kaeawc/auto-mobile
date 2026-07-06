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
  /**
   * Internal tool-to-tool invocation guard (issue #3053). PlanExecutor calls the
   * wrapped `tool.handler` (so this hook runs) with an injected `sessionUuid`, so a
   * plan step's envelope would otherwise be diffed (`--actions-diff-observe`) or
   * stripped (`--actions-no-observe`). A current or future internal consumer that
   * reads `.observation.viewHierarchy` off that finalized envelope must always find
   * the full observation. When `true`, finalize emits the full sanitized
   * observation regardless of the action-output flags — never a diff, never
   * stripped — and never touches the agent-facing diff baseline. Sanitization
   * (#2758) still applies; only the agent-facing diff/strip is suppressed.
   */
  internal?: boolean;
}

type ObservationDiffMode = "diff" | "full";
type ObservationDiffReason =
  | "diff_emitted"
  | "missing_baseline"
  | "screen_changed"
  | "missing_session"
  | "unrenderable_hierarchy"
  | "disabled"
  | "stripped_by_actions_no_observe";

interface ObservationDiffScreenIdentity {
  activeWindow?: ObserveResult["activeWindow"];
  hierarchyPackageName?: string;
  screenIdentity?: ObserveResult["screenIdentity"];
}

interface ObservationDiffMetadata {
  mode: ObservationDiffMode;
  reason: ObservationDiffReason;
  fromScreen?: ObservationDiffScreenIdentity;
  toScreen?: ObservationDiffScreenIdentity;
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

  // Internal tool-to-tool calls (#3053) always get the full sanitized observation:
  // the diff/strip transforms are for the agent-facing wire only, so an internal
  // consumer reading `.observation.viewHierarchy` off a finalized step envelope is
  // never handed a diff or a stripped payload.
  const noObserveEnabled = serverConfig.isActionsNoObserveEnabled() && !ctx.internal;
  // Precedence (#3026 / #2762): `--actions-no-observe` strips the embedded
  // observation entirely, so `--actions-diff-observe` is moot when both are on.
  const diffActive = serverConfig.isActionsDiffObserveEnabled() && !noObserveEnabled && !ctx.internal;
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
      stripped.observationDiff = {
        mode: "full",
        reason: "stripped_by_actions_no_observe",
      } satisfies ObservationDiffMetadata;
      sanitizedPayload = stripped;
    } else if (isObserveResult(payload.observation)) {
      const sanitized = sanitizeObserveResult(payload.observation as ObserveResult, cfg);
      let observationOut: unknown = sanitized;
      let observationDiff: ObservationDiffMetadata | undefined;
      if (ctx.internal) {
        // Internal envelopes are consumed by in-process tool callers, not agents.
        // Keep them on the pre-diff/pre-strip shape without agent-facing metadata.
      } else if (!diffActive) {
        observationDiff = { mode: "full", reason: "disabled" };
      } else if (!ctx.sessionUuid || !ctx.baselineStore) {
        observationDiff = { mode: "full", reason: "missing_session", toScreen: observationScreenIdentity(sanitized) };
      } else if (!hasRenderableHierarchy(sanitized)) {
        const baseline = ctx.baselineStore.get(ctx.sessionUuid);
        observationDiff = {
          mode: "full",
          reason: "unrenderable_hierarchy",
          fromScreen: baseline ? observationScreenIdentity(baseline) : undefined,
          toScreen: observationScreenIdentity(sanitized),
        };
      } else if (canDiff) {
        // Emit a diff vs the baseline when it exists and the screen is unchanged;
        // otherwise fall back to the full observation (cross-screen diffs are
        // meaningless, and there is nothing to diff on the first action). Either
        // way, update the baseline to this observation so the next action diffs
        // against current state.
        const baseline = ctx.baselineStore!.get(ctx.sessionUuid!);
        if (!baseline) {
          observationDiff = { mode: "full", reason: "missing_baseline", toScreen: observationScreenIdentity(sanitized) };
        } else if (!hasRenderableHierarchy(baseline)) {
          observationDiff = {
            mode: "full",
            reason: "unrenderable_hierarchy",
            fromScreen: observationScreenIdentity(baseline),
            toScreen: observationScreenIdentity(sanitized),
          };
        } else if (isSameObservationScreen(baseline, sanitized)) {
          observationOut = diffObserveResult(baseline, sanitized);
          observationDiff = {
            mode: "diff",
            reason: "diff_emitted",
            fromScreen: observationScreenIdentity(baseline),
            toScreen: observationScreenIdentity(sanitized),
          };
        } else {
          observationDiff = {
            mode: "full",
            reason: "screen_changed",
            fromScreen: observationScreenIdentity(baseline),
            toScreen: observationScreenIdentity(sanitized),
          };
        }
        ctx.baselineStore!.set(ctx.sessionUuid!, sanitized);
      }
      sanitizedPayload = {
        ...payload,
        observation: observationOut,
      };
      if (observationDiff) {
        sanitizedPayload.observationDiff = observationDiff;
      }
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
 * an object carrying observe-specific fields. Hierarchy collection can fail
 * while the rest of observe still completes, so `viewHierarchy` is only one
 * marker; debug-perf fields on hierarchy-less observations must still be
 * stripped at the wire boundary.
 */
const OBSERVE_RESULT_MARKERS: ReadonlyArray<string> = [
  "updatedAt",
  "screenSize",
  "systemInsets",
  "viewHierarchy",
  "rawViewHierarchy",
  "elements",
  "perfTiming",
  "perfTimingTruncated",
  "gfxMetrics",
  "performanceAudit",
  "accessibilityAudit",
  "freshness",
];

function isObserveResult(value: unknown): value is ObserveResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return OBSERVE_RESULT_MARKERS.some(key => key in record);
}

function hasRenderableHierarchy(observation: ObserveResult): boolean {
  return !!observation.viewHierarchy?.hierarchy;
}

function observationScreenIdentity(observation: ObserveResult): ObservationDiffScreenIdentity {
  const identity: ObservationDiffScreenIdentity = {};
  if (observation.activeWindow) {
    identity.activeWindow = observation.activeWindow;
  }
  if (observation.viewHierarchy?.packageName) {
    identity.hierarchyPackageName = observation.viewHierarchy.packageName;
  }
  if (observation.screenIdentity) {
    identity.screenIdentity = observation.screenIdentity;
  }
  return identity;
}
