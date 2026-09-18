import type { ObserveResult, SkeletonElement } from "../models/ObserveResult";
import {
  sanitizeObserveResult,
  diffObserveResult,
  isSameObservationScreen,
  type SanitizeObserveConfig,
} from "../features/observe/output/ObserveResultOutput";
import {
  applyObserveScopeExperiments,
  buildObserveScopeConfig,
} from "../features/observe/output/ObserveScopeExperiments";
import type { ObserveScopeInput } from "../models/ObserveScope";
import { z } from "zod/v4";
import { capLayoutWarnings } from "../features/observe/audits/SafeAreaAuditor";
import {
  classifyObservationAction,
  type ObservationActionClass,
} from "../features/action/observationActionClass";
import { serverConfig } from "../utils/ServerConfig";
import { stringifyToolResponse } from "../utils/toolUtils";
import { readToolEnvelopePayload, writeToolEnvelopePayload } from "./toolEnvelopePayload";
import { boundStructuredField, truncateBodyText } from "../utils/truncateBodyText";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { isDeviceSessionAcquisitionTool } from "./deviceSessionResult";
import { isHostOutputTruncationReason } from "../features/observe/truncationReasons";
import { buildObservationScreenshotUri } from "./observationResourceUris";
import { stripInternalObservationFields } from "./observationInternalFields";

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
  /**
   * Exact bytes to persist, for a caller that has already rendered `data` and
   * must store precisely what it rendered — the CLI, whose pretty-printed
   * output is the thing it measured and whose reported byte count has to match
   * the file on disk (#6870).
   *
   * NOT a serialization strategy hook: the writer already persists `data`
   * completely (see `serializeArtifactContent`), so a caller that just wants the
   * whole payload written should omit this and pass `data` alone.
   */
  serialized?: string;
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
  "sendKeys",
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
 * Top-level metadata a hierarchy diff cannot derive for itself, but which a
 * diff-mode client needs with the same shape as a full observation. Sourced
 * from the raw (pre-sanitize) observation so projection never suppresses it.
 * Add a field here when it is a straight copy; the contract test walks this
 * list. `skeleton`, `context`, `keyboard`, and `truncationReasons` are excluded
 * because they require their existing fallback re-projection logic.
 */
export const DIFF_PASSTHROUGH_METADATA_FIELDS = [
  "activeWindow",
  "freshness",
  "observationId",
  "deviceId",
  "settled",
  "accessibilityAuditSkipped",
] as const satisfies readonly (keyof ObserveResult)[];

/**
 * Copy only defined fields so absent metadata remains absent from the emitted
 * diff and serializes exactly as it does in full mode.
 */
function copyDefinedFields<T extends object, K extends keyof T>(
  source: T,
  fields: readonly K[],
): Partial<Pick<T, K>> {
  const metadata: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) {
      Object.assign(metadata, { [field]: value });
    }
  }
  return metadata;
}

/**
 * Stamp the fully-encoded observation-scoped screenshot resource URI onto an
 * emitted observation or diff (issue #7018). The observe path resolves the
 * concrete device internally and mints an `observationId`, but the caller could
 * not previously construct the `automobile:observation/{deviceId}/{observationId}/screenshot`
 * URI because the resolved `deviceId` never reached the wire. With both now
 * present, build the URI through the SAME shared encoder the resource template
 * registration uses, so it is guaranteed to round-trip back to that resource.
 * A no-op when either identity is missing (e.g. a recorded capture that predates
 * `deviceId`) or the capture was explicitly skipped. Older recorded captures
 * predate `screenshotCaptureAttempted`, so only an explicit `false` suppresses
 * the URI. The capture signal is internal-only and is removed before serving.
 */
function attachObservationScreenshotUri(
  observation: {
    deviceId?: string;
    observationId?: string;
    observationScreenshotResourceUri?: string;
    screenshotCaptureAttempted?: boolean;
  },
  captureAttempted = observation.screenshotCaptureAttempted,
): void {
  if (
    captureAttempted !== false &&
    typeof observation.deviceId === "string" &&
    observation.deviceId.length > 0 &&
    typeof observation.observationId === "string" &&
    observation.observationId.length > 0
  ) {
    observation.observationScreenshotResourceUri = buildObservationScreenshotUri(
      observation.deviceId,
      observation.observationId,
    );
  } else {
    delete observation.observationScreenshotResourceUri;
  }
  stripInternalObservationFields(observation);
}

/**
 * The `truncationReasons` to attach to a diff response (issue #6601): a diff
 * replaces the projected observation outright, so the provenance the skeleton
 * projection lifted out of `viewHierarchy` — and, under `project:"full"`, the
 * `viewHierarchy.truncationReasons` that never needed lifting — would be
 * dropped with the observation it replaced. Resolved from the served projection
 * first and otherwise from the raw observation's hierarchy, so the field is
 * populated in every projection mode.
 *
 * Also folds in the BASELINE's own truncation provenance (issue #6933): the
 * baseline this diffs against was stored capped (e.g. 70 rows trimmed to 64),
 * so a subsequent capture that has since fallen below the cap carries no
 * truncation reason of its own even though the diff still can't tell whether
 * rows past the baseline's cap were added, removed, or unchanged. Without this,
 * that transition silently reports a partial removal count with no warning.
 * Reasons are de-duplicated (the same `max_children[...]` reason can appear on
 * both sides) and `undefined` (nothing was ever truncated) serializes away
 * exactly like an absent key.
 */
function resolveDiffTruncationReasons(
  baseline: ObserveResult,
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
): string[] | undefined {
  const baselineReasons = baseline.truncationReasons ?? baseline.viewHierarchy?.truncationReasons;
  const rawReasons = rawObservation.viewHierarchy?.truncationReasons;
  const currentReasons = servedObservation.truncationReasons
    ? [
        ...servedObservation.truncationReasons,
        ...(rawReasons?.filter(isHostOutputTruncationReason) ?? []),
      ]
    : rawReasons;
  const merged = [...(baselineReasons ?? []), ...(currentReasons ?? [])];
  const deduped = Array.from(new Set(merged));
  return deduped.length > 0 ? deduped : undefined;
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
  /**
   * Registered tool output contract. Required top-level object fields remain in
   * a bounded inline residue when the complete response spills to an artifact.
   */
  outputSchema?: unknown;
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

  // Prefer structuredContent; fall back to the serialized text part when a tool
  // returned text only. Anything else (image parts, non-JSON text) is left alone.
  const envelopeView = readToolEnvelopePayload(response);
  if (!envelopeView) {
    return response;
  }
  const payload = envelopeView.payload;
  const hasStructured = envelopeView.hasStructured;

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
    attachObservationScreenshotUri(served);
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
          const diff = diffObserveResult(baseline, sanitized, {
            collapseKeyboard: servedObservation.skeleton !== undefined,
            layoutWarningsDiffMode: servedObservation.skeleton !== undefined ? "perEntry" : "full",
            projectAddedRemoved: servedObservation.skeleton !== undefined,
          });
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
          diff.keyboard =
            servedObservation.skeleton !== undefined
              ? servedObservation.keyboard
              : sanitizeObserveResult(payload.observation as ObserveResult, {
                  ...cfg,
                  project: "skeleton",
                }).keyboard;
          Object.assign(
            diff,
            copyDefinedFields(
              payload.observation as ObserveResult,
              DIFF_PASSTHROUGH_METADATA_FIELDS,
            ),
          );
          // Issue #6601: nor may a diff silently drop the hierarchy's truncation
          // provenance — see resolveDiffTruncationReasons.
          diff.truncationReasons = resolveDiffTruncationReasons(
            baseline,
            servedObservation,
            payload.observation as ObserveResult,
          );
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
      if (observationOut && typeof observationOut === "object") {
        attachObservationScreenshotUri(
          observationOut as {
            deviceId?: string;
            observationId?: string;
            observationScreenshotResourceUri?: string;
            screenshotCaptureAttempted?: boolean;
          },
          (payload.observation as ObserveResult).screenshotCaptureAttempted,
        );
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
    shouldArtifactObservationPayload(ctx, sanitizedPayload, hasStructured)
  ) {
    if (isObserveTool) {
      // Keep compact wait status inline: without it, an artifacted `observe`
      // response hides whether the requested condition matched or timed out.
      sanitizedPayload = {
        ...pickObserveWaitMetadata(sanitizedPayload),
        ...writeObservationArtifact(ctx, sanitizedPayload),
      };
    } else {
      const observation = sanitizedPayload.observation;
      sanitizedPayload = {
        ...sanitizedPayload,
        observation: isObserveDiff(observation)
          ? writeObserveDiffBodyArtifact(ctx, observation)
          : writeObservationArtifact(ctx, observation),
      };
    }
  }

  if (artifactMode(ctx) === "always") {
    sanitizedPayload ??= artifactNonObservationPayload(ctx, payload);
  }

  // Hard ceiling (issue #6870). Spilling `observation` bounds only the
  // observation: `observationDiff` rides at the TOP level beside it, and so does
  // every other tool field, so a response could still be handed to the client
  // far over the inline limit — which a one-shot `--cli` transport then cut
  // mid-string into unparseable JSON. With a writer available, spill whatever
  // residue is still oversized and keep only the headline fields inline, so the
  // client always gets complete, parseable JSON plus a pointer to the rest.
  const boundedCandidate = sanitizedPayload ?? payload;
  if (ctx.artifactWriter && !ctx.internal && exceedsInlineLimit(boundedCandidate, hasStructured)) {
    try {
      sanitizedPayload = spillOversizedPayload(ctx, boundedCandidate, hasStructured);
    } catch (error) {
      // The operation itself already succeeded; only the spill failed (a full or
      // read-only tool-output directory). Throwing here would return NO result
      // for work the device has already done, which for a side-effecting tool
      // invites a duplicate retry. Fall back to the pre-#6870 behaviour — serve
      // the payload un-spilled — and leave a trace, since the response then
      // exceeds the ceiling. The `--cli` renderer still refuses to cut JSON
      // mid-string and emits its own truncation notice instead.
      logger.warn(
        `finalizeToolResponse: could not spill the oversized ${ctx.name} response: ${errorMessage(error)}`,
        error,
      );
    }
  }

  if (!sanitizedPayload) {
    return response;
  }

  // Rewrite both representations from the same object so they cannot diverge.
  writeToolEnvelopePayload(envelopeView, sanitizedPayload);
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

/**
 * The fields kept inline when an oversized residue is spilled wholesale (#6870).
 *
 * A client that gets only an artifact pointer still has to know whether the tool
 * succeeded and, if not, why — reading the spilled file to learn that a tap
 * failed would be a worse contract than the oversized payload it replaced.
 */
const INLINE_RESIDUE_KEYS = ["success", "error", ...OBSERVE_WAIT_METADATA_KEYS] as const;
const DEVICE_SESSION_RESIDUE_KEYS = ["sessionUuid", "sessionId"] as const;

/**
 * Per-field cap on what a retained residue field may contribute (#6870).
 *
 * The retained fields are headlines, not payloads, but nothing stops one of them
 * from being huge on its own: a stack trace lands in `error`, and a `countStable`
 * wait that never matched returns every candidate it saw. Copying such a field
 * back verbatim would blow the very ceiling the spill exists to enforce. At
 * {@link INLINE_RESIDUE_KEYS}.length plus the two device-session fields caps the
 * largest acquisition residue at ~48 KB,
 * comfortably inside {@link DEFAULT_OBSERVATION_INLINE_MAX_BYTES} once the
 * artifact envelope is added.
 */
const INLINE_RESIDUE_FIELD_LIMIT = 4 * 1024;

/**
 * Keep the headline fields inline, each bounded: an oversized string is cut to
 * the cap (still a string, so `error` stays readable), and an oversized
 * structure is replaced with the canonical `{ _truncated, bytes }` marker. The
 * complete value is always in the artifact the caller writes alongside this.
 */
function pickInlineResidue(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const requiredArrayKeys = new Set(requiredOutputSchemaArrayKeys(ctx.outputSchema));
  return Object.fromEntries(
    inlineResidueKeys(ctx)
      .filter((key) => payload[key] !== undefined)
      .map((key) => [key, boundResidueField(payload[key], requiredArrayKeys.has(key))]),
  );
}

/**
 * Replace an over-ceiling payload with its artifact pointer plus a bounded
 * residue of the headline fields.
 */
function spillOversizedPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  hasStructured: boolean,
): Record<string, unknown> {
  // No `serialized` override: the writer persists `data` complete (extras
  // included), so every spill path — this one and the observation-only one above
  // — produces the same complete artifact without per-call-site plumbing.
  const artifact = writeJsonArtifact(ctx, "ToolResponse", payload);
  const spilled = { ...pickInlineResidue(ctx, payload), ...artifact };
  // The per-field cap is counted in UTF-16 code units, so multi-byte text can
  // still serialize past the ceiling across every retained field. Fall back to
  // markers-only, whose size does not depend on the input at all.
  return exceedsInlineLimit(spilled, hasStructured)
    ? { ...markerResidue(ctx, payload), ...artifact }
    : spilled;
}

function inlineResidueKeys(ctx: FinalizeToolResponseContext): readonly string[] {
  const fixedKeys = isDeviceSessionAcquisitionTool(ctx.name)
    ? [...INLINE_RESIDUE_KEYS, ...DEVICE_SESSION_RESIDUE_KEYS]
    : INLINE_RESIDUE_KEYS;
  return [...new Set([...fixedKeys, ...requiredOutputSchemaKeys(ctx.outputSchema)])];
}

/**
 * Finds required top-level fields on an output Zod object without treating an
 * absent or non-object schema as an error. Zod v4 keeps `.passthrough()` and
 * refinements on ZodObject itself; pipes and transparent wrappers may instead
 * expose their output or unwrapped schema separately.
 */
function requiredOutputSchemaKeys(schema: unknown): readonly string[] {
  const objectSchema = unwrapOutputObjectSchema(schema);
  if (!objectSchema) {
    return [];
  }
  return Object.entries(objectSchema.shape)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional())
    .map(([key]) => key);
}

/** Required output fields whose declared value is an array. */
function requiredOutputSchemaArrayKeys(schema: unknown): readonly string[] {
  const objectSchema = unwrapOutputObjectSchema(schema);
  if (!objectSchema) {
    return [];
  }
  return Object.entries(objectSchema.shape)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional() && fieldSchema instanceof z.ZodArray)
    .map(([key]) => key);
}

function unwrapOutputObjectSchema(schema: unknown): z.ZodObject | undefined {
  let candidate = schema;
  const seen = new Set<unknown>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof z.ZodObject) {
      return candidate;
    }
    if (candidate instanceof z.ZodPipe) {
      candidate = candidate.out;
      continue;
    }
    const unwrap = (candidate as { unwrap?: unknown }).unwrap;
    candidate = typeof unwrap === "function" ? unwrap.call(candidate) : undefined;
  }
  return undefined;
}

/**
 * The last-resort residue: non-scalar fields are replaced with the
 * `{ _truncated, bytes }` marker, except arrays become empty arrays to retain
 * their declared schema shape. The inline size is therefore a fixed function of
 * the field COUNT rather than of the payload. Scalars (a `success` boolean, a
 * `polls` count) are the headline a client actually acts on and are always tiny.
 */
function markerResidue(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    inlineResidueKeys(ctx)
      .filter((key) => payload[key] !== undefined)
      .map((key) => [
        key,
        Array.isArray(payload[key])
          ? []
          : typeof payload[key] === "object" || typeof payload[key] === "string"
            ? boundStructuredField(payload[key], false, 0)
            : payload[key],
      ]),
  );
}

function boundResidueField(value: unknown, preserveArrayShape: boolean = false): unknown {
  if (typeof value === "string") {
    return value.length <= INLINE_RESIDUE_FIELD_LIMIT
      ? value
      : `${truncateBodyText(value, INLINE_RESIDUE_FIELD_LIMIT)}${RESIDUE_TRUNCATION_SUFFIX}`;
  }
  if (preserveArrayShape && Array.isArray(value)) {
    return boundResidueArray(value);
  }
  return boundStructuredField(value, false, INLINE_RESIDUE_FIELD_LIMIT);
}

function boundResidueArray(value: unknown[]): unknown[] {
  if (boundStructuredField(value, false, INLINE_RESIDUE_FIELD_LIMIT) === value) {
    return value;
  }

  // Required array fields must remain arrays after a #6950/#6981 spill, unlike
  // boundStructuredField's telemetry marker behavior; retain real prefix values
  // only, because the artifact already contains the complete untruncated array.
  let low = 0;
  let high = value.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    const serialized = JSON.stringify(value.slice(0, end));
    if (serialized !== undefined && serialized.length <= INLINE_RESIDUE_FIELD_LIMIT) {
      low = end;
    } else {
      high = end - 1;
    }
  }
  return value.slice(0, low);
}

/** Marks a residue string as cut, so a client never reads a partial value as whole. */
const RESIDUE_TRUNCATION_SUFFIX = "… [truncated; complete value in the tool-output artifact]";

function artifactMode(ctx: FinalizeToolResponseContext): ObservationArtifactMode {
  return ctx.artifactMode ?? "always";
}

/** Whether the payload, as the client will actually receive it, is over the ceiling. */
function exceedsInlineLimit(payload: Record<string, unknown>, hasStructured: boolean): boolean {
  return emittedByteLength(payload, hasStructured) > DEFAULT_OBSERVATION_INLINE_MAX_BYTES;
}

/**
 * Bytes this payload will actually put on the wire (#6870 review).
 *
 * The text part is rendered with `stringifyToolResponse`, whose replacer drops
 * every property named `extras`. But `structuredContent` is assigned the
 * UNSTRIPPED payload object and is serialized by the transport with a plain
 * `JSON.stringify`, extras included. Measuring only the stripped rendering let a
 * result whose bulk is accessibility `extras` measure as a handful of bytes and
 * sail straight past the hard ceiling while 70 KB of structured content went to
 * the client. Measure the larger of the two renderings, so the gate bounds
 * whichever representation is actually emitted.
 */
function emittedByteLength(payload: Record<string, unknown>, hasStructured: boolean): number {
  const strippedBytes = Buffer.byteLength(stringifyToolResponse(payload), "utf8");
  if (!hasStructured) {
    return strippedBytes;
  }
  return Math.max(strippedBytes, structuredByteLength(payload, strippedBytes));
}

function structuredByteLength(payload: Record<string, unknown>, fallback: number): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch (error) {
    // A payload the transport itself cannot serialize (a cycle, a BigInt) has no
    // structured byte count to compare against; the stripped rendering is the
    // only measurement available. Safe to swallow: this is sizing, not delivery.
    logger.debug(`finalizeToolResponse: structured payload is not measurable: ${error}`);
    return fallback;
  }
}

function shouldArtifactObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  hasStructured: boolean,
): boolean {
  if (artifactMode(ctx) === "always") {
    return true;
  }

  // Measures the whole served payload — `observationDiff` and every other
  // top-level field included — not just the observation subtree.
  return exceedsInlineLimit(payload, hasStructured);
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

/**
 * Keep a diff's compact selector surface and capture metadata inline; only its
 * potentially unbounded body belongs in the artifact (#7217).
 */
function writeObserveDiffBodyArtifact(
  ctx: FinalizeToolResponseContext,
  observation: Record<string, unknown>,
): Record<string, unknown> {
  const { added, removed, changed, fields, ...inline } = observation;
  const body: Record<string, unknown> = { isDiff: true, added, removed, changed };
  if (fields !== undefined) {
    body.fields = fields;
  }
  return { ...inline, ...writeObservationArtifact(ctx, body) };
}

function isObserveDiff(observation: unknown): observation is Record<string, unknown> {
  return (
    observation !== null &&
    typeof observation === "object" &&
    (observation as Record<string, unknown>).isDiff === true
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
