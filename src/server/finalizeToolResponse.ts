import type { ObserveResult, SkeletonElement } from "../models/ObserveResult";
import {
  sanitizeObserveResult,
  diffObserveResult,
  isSameObservationScreen,
  type SanitizeObserveConfig,
  type ObserveDiff,
} from "../features/observe/output/ObserveResultOutput";
import {
  applyObserveScopeExperiments,
  buildObserveScopeConfig,
} from "../features/observe/output/ObserveScopeExperiments";
import type { ObserveScopeInput } from "../models/ObserveScope";
import { capLayoutWarnings } from "../features/observe/audits/SafeAreaAuditor";
import {
  isInPlacePressButton,
  isNavigationPressButton,
} from "../features/action/pressButtonPolicy";
import { serverConfig } from "../utils/ServerConfig";
import { getStructuredPayload, stringifyToolResponse } from "../utils/toolUtils";
import { isSubmitImeAction } from "../models/ImeActionResult";

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

export type ObservationArtifactPayload = string;

export interface ObservationArtifactMetadata {
  artifact: {
    path: string;
    format: "json";
    payload: ObservationArtifactPayload;
    bytes: number;
    tool: string;
    /**
     * In-protocol companion to `path` (issue #5882). An `automobile:tool-output/…`
     * resource URI a client can read to fetch the spilled JSON in-band, so a
     * host filesystem path is never the only way to reach the raw payload.
     */
    resourceUri: string;
  };
}

export interface ObservationArtifactWriteInput {
  tool: string;
  payload: ObservationArtifactPayload;
  data: unknown;
}

export interface ObservationArtifactWriter {
  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata;
}

export type ObservationArtifactMode = "always" | "oversized";

export const DEFAULT_OBSERVATION_INLINE_MAX_BYTES = 64 * 1024;

const OBSERVE_WAIT_METADATA_KEYS = [
  "awaitedElement",
  "awaitDuration",
  "awaitTimeout",
  "matched",
  "settled",
  "timedOut",
  "polls",
  "waitMs",
  "matchedElement",
  "candidates",
] as const;

type ObservationActionClass = "navigation" | "inPlace" | "scroll" | "unknown";

function classifyObservationAction(
  name: string,
  args?: Record<string, unknown>,
): ObservationActionClass {
  switch (name) {
    case "tapOn":
    case "tapAny":
    case "homeScreen":
    case "recentApps":
    case "openLink":
      return "navigation";
    case "pressButton": {
      if (isNavigationPressButton(args?.button)) {
        return "navigation";
      }
      if (isInPlacePressButton(args?.button)) {
        return "inPlace";
      }
      return "unknown";
    }
    case "inputText":
      return isSubmitImeAction(args?.imeAction) ? "navigation" : "inPlace";
    case "clearText":
    case "selectAllText":
    case "keyboard":
    case "clipboard":
      return "inPlace";
    case "imeAction":
      return isSubmitImeAction(args?.action) ? "navigation" : "inPlace";
    case "swipeOn":
    case "dragAndDrop":
      return "scroll";
    default:
      return "unknown";
  }
}

/**
 * Action tools that embed a post-action observation AND expose the `raw`/`project`
 * response-shape control (issues #5872, #5886). Their embedded observation defaults
 * to the compact skeleton, opt-out-able per call. The default is scoped to exactly
 * the tools that carry the opt-out so the two never diverge: a tool that
 * skeletonizes by default but cannot be asked for the raw tree would be a silent
 * one-way door. #5872 shipped the first three; #5886 extends both the default and
 * the opt-out to every remaining observation-producing action tool, together.
 * Membership is bound to the advertised opt-out by an anti-divergence test
 * (test/server/tools/schema.integration.test.ts) so the two can never diverge in CI.
 * `observe` is not here — it owns the projection at the payload top level, not
 * under `.observation`.
 */
export const SKELETON_DEFAULT_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "tapOn",
  "inputText",
  "launchApp",
  "tapAny",
  "dragAndDrop",
  "clearText",
  "selectAllText",
  "pressButton",
  "systemTray",
  "swipeOn",
  "pinchOn",
  "openLink",
  "shake",
  "imeAction",
  "recentApps",
  "homeScreen",
  "rotate",
  "terminateApp",
  "biometricAuth",
]);

/**
 * Resolve the observe output projection (issue #4388). An explicit per-call
 * `project` arg always wins; otherwise `raw: true` forces `"full"` (the raw tree
 * is the documented disambiguation escape hatch). The skeleton projection is now
 * the unconditional default (it superseded the retired
 * `observe-result-project-skeleton` flag), so absent an explicit override every
 * observe payload projects to the actionable-only skeleton.
 */
function resolveObserveProjection(args?: Record<string, unknown>): "full" | "skeleton" {
  const explicit = args?.project;
  if (explicit === "full" || explicit === "skeleton") {
    return explicit;
  }
  if (args?.raw === true) {
    return "full";
  }
  return "skeleton";
}

/**
 * The `skeleton` to attach to a diff response (issue #6221 item 4.1), resolved
 * independently of whatever projection `servedObservation` happens to carry.
 * `servedObservation` only carries `.skeleton` when the tool defaults to it
 * (issue #5872's `SKELETON_DEFAULT_ACTION_TOOLS`) AND the resolved projection
 * is `"skeleton"` — a per-call `raw:true` / `project:"full"` request (or a
 * tool outside that set) leaves it `undefined`. Without this, exactly THOSE
 * modes would silently violate the always-usable-selector guarantee (PR #6242
 * review PRRT_kwDOP-GF5M6fq3iK): a diff with no skeleton, in the one case the
 * guarantee exists to prevent. So when `servedObservation.skeleton` is absent,
 * this re-projects one from the underlying (pre-sanitize) observation, which
 * still carries `.elements` regardless of what projection was requested.
 */
function resolveDiffSkeleton(
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
  cfg: SanitizeObserveConfig,
): SkeletonElement[] {
  if (servedObservation.skeleton) {
    return servedObservation.skeleton;
  }
  return sanitizeObserveResult(rawObservation, { ...cfg, project: "skeleton" }).skeleton ?? [];
}

/**
 * The `context` to attach to a diff response (issue #6256), resolved the same
 * way {@link resolveDiffSkeleton} resolves `skeleton` and for the same reason:
 * `diffObserveResult` never sees `context` (it is dropped from `sanitized`
 * before the diff runs), so without this a diff-mode response would carry the
 * actionable `skeleton` but silently drop every non-actionable state-readout
 * row — a timer countdown, a toggle's current-state text — leaving a client
 * unable to tell a failed input from a successful one purely from the diff.
 * Returns `undefined` (never an empty array) when no such row survives, so the
 * emitted diff omits `context` entirely rather than carrying a pointless `[]`
 * — matching how a full observation only ever carries `context` when it is
 * non-empty (see `projectSkeletonOnto`).
 */
function resolveDiffContext(
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
  cfg: SanitizeObserveConfig,
): SkeletonElement[] | undefined {
  if (servedObservation.context) {
    return servedObservation.context;
  }
  return sanitizeObserveResult(rawObservation, { ...cfg, project: "skeleton" }).context;
}

/**
 * The `activeWindow` and `freshness` to attach to a diff response (issue
 * #6258), resolved the same way {@link resolveDiffSkeleton} resolves
 * `skeleton`: `diffObserveResult` never sees either field (both are top-level
 * on the post-transition observation, not part of the hierarchy it diffs), so
 * without this a diff-mode `observation` would carry no `activeWindow`/no
 * `freshness` at all — while a full-mode `observation` carries both — leaving
 * a client unable to write one accessor for "what screen am I on / is this
 * fresh" across modes. Sourced from `rawObservation` (the pre-sanitize
 * observation) rather than `servedObservation` so it is populated
 * unconditionally, regardless of projection.
 */
function resolveDiffScreenState(
  rawObservation: ObserveResult,
): Pick<ObserveDiff, "activeWindow" | "freshness"> {
  return {
    activeWindow: rawObservation.activeWindow,
    freshness: rawObservation.freshness,
  };
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
  args?: Record<string, unknown>;
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
  /**
   * External-response artifact writer (issue #3480). When supplied for an
   * agent-facing call, the final post-transform observation payload is written
   * out-of-band and replaced with rich artifact metadata. Internal calls ignore
   * this writer so in-process consumers still receive full observations.
   */
  artifactWriter?: ObservationArtifactWriter;
  /**
   * Configured artifact mode keeps the historical "always artifact" behavior.
   * The automatic fallback only spills observations whose finalized inline JSON
   * is large enough to risk client-side truncation.
   */
  artifactMode?: ObservationArtifactMode;
}

type ObservationDiffMode = "diff" | "full";
type ObservationDiffReason =
  | "diff_emitted"
  | "missing_baseline"
  | "screen_changed"
  | "missing_session — pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations"
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
    // Elements are dropped by default; `--observe-result-include-elements` opts
    // back in. Bounds compaction is now an unconditional default.
    dropElements: !serverConfig.isObserveResultIncludeElementsEnabled(),
    compact: true,
  };

  // Progressive-disclosure scoping experiments (issue #4344), now always honored:
  // each dimension is intersected with the per-call `scope` request in
  // `buildObserveScopeConfig`, so with no `scope` arg this is a no-op. Agent-facing
  // only: internal tool-to-tool consumers read the full `.observation.viewHierarchy`,
  // so scoping (like the diff/strip transforms) is suppressed for `ctx.internal`.
  const scopeFlags = {
    focus: true,
    overview: true,
    region: true,
  };
  const scopeConfig = buildObserveScopeConfig(
    scopeFlags,
    ctx.args?.scope as ObserveScopeInput | undefined,
  );
  const scopeActive =
    !ctx.internal &&
    (scopeFlags.focus ||
      scopeFlags.overview ||
      scopeFlags.region ||
      (scopeConfig.gatedOff?.length ?? 0) > 0);

  // Internal tool-to-tool calls (#3053) always get the full sanitized observation:
  // the diff/strip transforms are for the agent-facing wire only, so an internal
  // consumer reading `.observation.viewHierarchy` off a finalized step envelope is
  // never handed a diff or a stripped payload.
  const noObserveEnabled = serverConfig.isActionsNoObserveEnabled() && !ctx.internal;
  // Precedence (#3026 / #2762): `--actions-no-observe` strips the embedded
  // observation entirely, so `--actions-diff-observe` is moot when both are on.
  const diffActive =
    serverConfig.isActionsDiffObserveEnabled() && !noObserveEnabled && !ctx.internal;
  const canDiff = diffActive && !!ctx.sessionUuid && !!ctx.baselineStore;
  const isObserveTool = ctx.name === "observe";

  // Locate the ObserveResult: the payload itself for `observe`, else `.observation`.
  let sanitizedPayload: Record<string, unknown> | undefined;
  let hasArtifactableObservation = false;
  let pendingBaselineUpdate: { sessionUuid: string; observation: ObserveResult } | undefined;
  if (isObserveTool && isObserveResult(payload)) {
    // `observe` always emits the full sanitized observation (no-observe never
    // strips the observe tool itself) and resets the diff baseline to it (#2761).
    const observeResult = payload as unknown as ObserveResult;
    const sanitized = sanitizeObserveResult(observeResult, cfg);
    if (canDiff) {
      // Diff against the full sanitized tree, never the scoped/projected copy — the
      // next action must see real state, not what this observe payload was cropped
      // to (scope experiments #4344) or projected to (skeleton #4388).
      pendingBaselineUpdate = { sessionUuid: ctx.sessionUuid!, observation: sanitized };
    }
    // Served (agent-facing) copy: skeleton projection (#4388) and scope experiments
    // (#4344) are alternative croppings of the observe payload; both apply only to
    // the headline `observe` payload, never to embedded action observations. Skeleton
    // is the more aggressive projection (it replaces viewHierarchy/elements), so when
    // requested it wins. It re-projects from the original payload so it still sees
    // `elements` even under --observe-result-drop-elements.
    let served: ObserveResult = sanitized;
    if (resolveObserveProjection(ctx.args) === "skeleton") {
      served = sanitizeObserveResult(observeResult, { ...cfg, project: "skeleton" });
      // Skeleton replaces the hierarchy, so scope's structural transforms cannot
      // run afterward. Preserve only the requested dimensions withheld by flags.
      if ((scopeConfig.gatedOff?.length ?? 0) > 0) {
        served = applyObserveScopeExperiments(served, {
          focus: false,
          overview: false,
          region: false,
          gatedOff: scopeConfig.gatedOff,
        });
      }
    } else if (scopeActive) {
      // Scope-then-cap (#5074): re-derive the served copy UNCAPPED so the scope
      // transforms see every warning, then cap the scoped result — an in-scope
      // warning is never lost to a cap taken against the full tree. The baseline
      // above stays the capped `sanitized` full tree.
      const uncapped = sanitizeObserveResult(observeResult, { ...cfg, capLayoutWarnings: false });
      served = applyObserveScopeExperiments(uncapped, scopeConfig);
      if (served.layoutWarnings) {
        served.layoutWarnings = capLayoutWarnings(served.layoutWarnings);
      }
    }
    sanitizedPayload = served as unknown as Record<string, unknown>;
    hasArtifactableObservation = true;
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
      // Action observations default to the compact skeleton (issue #5872) — the
      // same response-shape control `observe` already has — so a client no longer
      // pays the full raw hierarchy on every tapOn/inputText/launchApp. Scoped to
      // SKELETON_DEFAULT_ACTION_TOOLS (the tools that also expose the `raw`/`project`
      // opt-out), so the default and the escape hatch never diverge. The compact
      // form lands under the same `skeleton` key `observe` uses; `raw:true` /
      // `project:"full"` opts back into the raw `viewHierarchy`. Internal
      // tool-to-tool consumers always keep the full tree, while a computed diff
      // replaces the action observation only on the path that emits a diff.
      const servedObservation =
        !ctx.internal &&
        SKELETON_DEFAULT_ACTION_TOOLS.has(ctx.name) &&
        resolveObserveProjection(ctx.args) === "skeleton"
          ? sanitizeObserveResult(payload.observation as ObserveResult, {
              ...cfg,
              project: "skeleton",
            })
          : sanitized;
      let observationOut: unknown = servedObservation;
      let observationDiff: ObservationDiffMetadata | undefined;
      if (ctx.internal) {
        // Internal envelopes are consumed by in-process tool callers, not agents.
        // Keep them on the pre-diff/pre-strip shape without agent-facing metadata.
      } else if (!diffActive) {
        observationDiff = { mode: "full", reason: "disabled" };
      } else if (!ctx.sessionUuid || !ctx.baselineStore) {
        observationDiff = {
          mode: "full",
          reason:
            "missing_session — pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
          toScreen: observationScreenIdentity(sanitized),
        };
      } else if (!hasRenderableHierarchy(sanitized)) {
        const baseline = ctx.baselineStore.get(ctx.sessionUuid);
        observationDiff = {
          mode: "full",
          reason: "unrenderable_hierarchy",
          fromScreen: baseline ? observationScreenIdentity(baseline) : undefined,
          toScreen: observationScreenIdentity(sanitized),
        };
      } else {
        // canDiff is provably true here: not internal, diffActive, session +
        // baseline store present, and the hierarchy is renderable.
        // Emit a diff vs the baseline when it exists and the screen is unchanged;
        // otherwise fall back to the full observation (cross-screen diffs are
        // meaningless, and there is nothing to diff on the first action). Either
        // way, update the baseline to this observation so the next action diffs
        // against current state.
        const baseline = ctx.baselineStore!.get(ctx.sessionUuid!);
        if (!baseline) {
          observationDiff = {
            mode: "full",
            reason: "missing_baseline",
            toScreen: observationScreenIdentity(sanitized),
          };
        } else if (!hasRenderableHierarchy(baseline)) {
          observationDiff = {
            mode: "full",
            reason: "unrenderable_hierarchy",
            fromScreen: observationScreenIdentity(baseline),
            toScreen: observationScreenIdentity(sanitized),
          };
        } else if (
          shouldDiffObservation(baseline, sanitized, classifyObservationAction(ctx.name, ctx.args))
        ) {
          const diff = diffObserveResult(baseline, sanitized);
          // Always attach a usable selector surface alongside the diff (issue #6221
          // item 4.1): a client that gets a diff must never be left with no
          // `skeleton` to act on — including when the request is `raw:true` /
          // `project:"full"` (PR #6242 review PRRT_kwDOP-GF5M6fq3iK), where
          // `servedObservation` itself carries no skeleton. `diffObserveResult`
          // cannot compute this itself — `elements` is already dropped from
          // `sanitized` by the time it runs — so it is resolved here instead.
          diff.skeleton = resolveDiffSkeleton(
            servedObservation,
            payload.observation as ObserveResult,
            cfg,
          );
          // Issue #6256: a diff must not silently drop the state-readout
          // `context` alongside `skeleton` — see resolveDiffContext. `undefined`
          // (no surviving readout row) is dropped on serialization just like an
          // absent key, so no extra branch is needed here.
          diff.context = resolveDiffContext(
            servedObservation,
            payload.observation as ObserveResult,
            cfg,
          );
          // Issue #6258: a diff must not silently drop `activeWindow`/`freshness`
          // either — see resolveDiffScreenState. Both fields come through as
          // `undefined` when the underlying observation lacks them, which drops
          // out of the serialized diff the same way an absent key would.
          Object.assign(diff, resolveDiffScreenState(payload.observation as ObserveResult));
          const screenChangedWithEmptyDiff =
            hasScreenChangedEffect(payload) && isEmptyObserveDiff(diff);
          observationOut = screenChangedWithEmptyDiff ? servedObservation : diff;
          observationDiff = {
            mode: screenChangedWithEmptyDiff ? "full" : "diff",
            reason: screenChangedWithEmptyDiff ? "screen_changed" : "diff_emitted",
            fromScreen: observationScreenIdentity(baseline),
            toScreen: observationScreenIdentity(sanitized),
          };
        } else {
          observationOut = servedObservation;
          observationDiff = {
            mode: "full",
            reason: "screen_changed",
            fromScreen: observationScreenIdentity(baseline),
            toScreen: observationScreenIdentity(sanitized),
          };
        }
        pendingBaselineUpdate = { sessionUuid: ctx.sessionUuid!, observation: sanitized };
      }
      sanitizedPayload = {
        ...payload,
        observation: observationOut,
      };
      if (observationDiff) {
        sanitizedPayload.observationDiff = observationDiff;
      }
      hasArtifactableObservation = true;
    }
  }

  if (
    ctx.artifactWriter &&
    !ctx.internal &&
    hasArtifactableObservation &&
    sanitizedPayload &&
    shouldArtifactObservationPayload(ctx, sanitizedPayload)
  ) {
    if (isObserveTool) {
      // Keep compact wait status inline: without it, an artifacted `observe`
      // response hides whether the requested condition matched or timed out.
      sanitizedPayload = {
        ...pickObserveWaitMetadata(sanitizedPayload),
        ...writeObservationArtifact(ctx, sanitizedPayload),
      };
    } else {
      sanitizedPayload = {
        ...sanitizedPayload,
        observation: writeObservationArtifact(ctx, sanitizedPayload.observation),
      };
    }
  }

  if (artifactMode(ctx) === "always") {
    sanitizedPayload ??= artifactNonObservationPayload(ctx, payload);
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
  pendingBaselineUpdate &&
    ctx.baselineStore!.set(pendingBaselineUpdate.sessionUuid, pendingBaselineUpdate.observation);

  return response;
}

function pickObserveWaitMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    OBSERVE_WAIT_METADATA_KEYS.filter((key) => payload[key] !== undefined).map((key) => [
      key,
      payload[key],
    ]),
  );
}

function artifactMode(ctx: FinalizeToolResponseContext): ObservationArtifactMode {
  return ctx.artifactMode ?? "always";
}

function shouldArtifactObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): boolean {
  if (artifactMode(ctx) === "always") {
    return true;
  }

  return (
    Buffer.byteLength(stringifyToolResponse(payload), "utf8") > DEFAULT_OBSERVATION_INLINE_MAX_BYTES
  );
}

function writeObservationArtifact(
  ctx: FinalizeToolResponseContext,
  observationPayload: unknown,
): ObservationArtifactMetadata {
  return writeJsonArtifact(
    ctx,
    getObservationArtifactPayload(observationPayload),
    observationPayload,
  );
}

function getObservationArtifactPayload(observationPayload: unknown): ObservationArtifactPayload {
  if (
    observationPayload &&
    typeof observationPayload === "object" &&
    (observationPayload as Record<string, unknown>).isDiff === true
  ) {
    return "ObserveDiff";
  }
  return "ObserveResult";
}

function writeJsonArtifact(
  ctx: FinalizeToolResponseContext,
  payload: ObservationArtifactPayload,
  data: unknown,
): ObservationArtifactMetadata {
  return ctx.artifactWriter!.writeJsonArtifact({
    tool: ctx.name,
    payload,
    data,
  });
}

function artifactNonObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ctx.artifactWriter || ctx.internal) {
    return undefined;
  }

  switch (ctx.name) {
    case "executePlan":
      return artifactExecutePlanPayload(ctx, payload);
    case "getNetworkGraph":
      return artifactNetworkGraphPayload(ctx, payload);
    default:
      return undefined;
  }
}

function artifactExecutePlanPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let changed = false;
  const nextPayload: Record<string, unknown> = { ...payload };
  if (isRecord(payload.failedStep)) {
    const failureObservation = artifactPlanObservation(
      ctx,
      payload.failedStep.failureObservation,
      "ExecutePlanFailureObservation",
    );
    if (failureObservation) {
      nextPayload.failedStep = { ...payload.failedStep, failureObservation };
      changed = true;
    }
  }

  if (isRecord(payload.debug) && Array.isArray(payload.debug.steps)) {
    let debugChanged = false;
    const steps = payload.debug.steps.map((step) => {
      if (!isRecord(step) || !isRecord(step.details)) {
        return step;
      }

      let detailsChanged = false;
      let details = step.details;
      const stepObservation = artifactPlanObservation(
        ctx,
        details.stepObservation,
        "ExecutePlanDebugStepObservation",
      );
      if (stepObservation) {
        details = { ...details, stepObservation };
        detailsChanged = true;
      }

      const failureObservation = artifactPlanObservation(
        ctx,
        details.failureObservation,
        "ExecutePlanDebugFailureObservation",
      );
      if (failureObservation) {
        details = { ...details, failureObservation };
        detailsChanged = true;
      }

      if (!detailsChanged) {
        return step;
      }
      debugChanged = true;
      return { ...step, details };
    });

    if (debugChanged) {
      nextPayload.debug = { ...payload.debug, steps };
      changed = true;
    }
  }

  return changed ? nextPayload : undefined;
}

function artifactPlanObservation(
  ctx: FinalizeToolResponseContext,
  observation: unknown,
  payloadPrefix: string,
): Record<string, unknown> | undefined {
  if (!isRecord(observation)) {
    return undefined;
  }

  let changed = false;
  const next: Record<string, unknown> = { ...observation };
  if (observation.viewHierarchy !== undefined) {
    next.viewHierarchy = writeJsonArtifact(
      ctx,
      `${payloadPrefix}ViewHierarchy`,
      observation.viewHierarchy,
    );
    changed = true;
  }
  if (observation.rawViewHierarchy !== undefined) {
    next.rawViewHierarchy = writeJsonArtifact(
      ctx,
      `${payloadPrefix}RawViewHierarchy`,
      observation.rawViewHierarchy,
    );
    changed = true;
  }

  return changed ? next : undefined;
}

function artifactNetworkGraphPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.graph)) {
    return undefined;
  }

  return {
    ...payload,
    graph: writeJsonArtifact(ctx, "NetworkGraph", payload.graph),
    graphSummary: {
      hostCount: payload.graph.length,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  return OBSERVE_RESULT_MARKERS.some((key) => key in record);
}

function hasRenderableHierarchy(observation: ObserveResult): boolean {
  return !!observation.viewHierarchy?.hierarchy;
}

function hasScreenChangedEffect(payload: Record<string, unknown>): boolean {
  const effect = payload.effect;
  return (
    effect !== null &&
    typeof effect === "object" &&
    (effect as Record<string, unknown>).screenChanged === true
  );
}

function isEmptyObserveDiff(diff: ReturnType<typeof diffObserveResult>): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.fields === undefined
  );
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

function shouldDiffObservation(
  baseline: ObserveResult,
  next: ObserveResult,
  actionClass: ObservationActionClass,
): boolean {
  if (actionClass === "inPlace" || actionClass === "scroll") {
    return isSameStableMutationSurface(baseline, next);
  }
  return isSameObservationScreen(baseline, next);
}

function isSameStableMutationSurface(baseline: ObserveResult, next: ObserveResult): boolean {
  if (!hasSameWindowPackageSurface(baseline, next)) {
    return false;
  }

  return hasCompatibleStableMutationIdentity(baseline, next);
}

function hasCompatibleStableMutationIdentity(
  baseline: ObserveResult,
  next: ObserveResult,
): boolean {
  const baselineIdentity = baseline.screenIdentity;
  const nextIdentity = next.screenIdentity;
  if (!baselineIdentity || !nextIdentity) {
    return true;
  }

  return (
    baselineIdentity.platform === nextIdentity.platform &&
    baselineIdentity.source === nextIdentity.source &&
    baselineIdentity.key === nextIdentity.key
  );
}

function hasSameWindowPackageSurface(baseline: ObserveResult, next: ObserveResult): boolean {
  if ((baseline.activeWindow?.appId ?? "") !== (next.activeWindow?.appId ?? "")) {
    return false;
  }
  if ((baseline.activeWindow?.activityName ?? "") !== (next.activeWindow?.activityName ?? "")) {
    return false;
  }
  if ((baseline.viewHierarchy?.packageName ?? "") !== (next.viewHierarchy?.packageName ?? "")) {
    return false;
  }
  return true;
}
