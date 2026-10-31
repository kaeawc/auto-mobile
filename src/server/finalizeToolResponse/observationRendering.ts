import {
  ObservationDisplayRenderer,
  copyDefinedFields,
  isObserveResult,
} from "../ObservationDisplayRenderer";
import {
  terminalScreenshotUnavailable,
  isTerminalScreenshotUnavailable,
} from "../../utils/PostActionCaptureContext";
import type { ObserveResult } from "../../models/ObserveResult";
import {
  sanitizeObserveResult,
  projectSanitizedObserveSkeleton,
  diffObserveResult,
  isSameObservationScreen,
  type SanitizeObserveConfig,
} from "../../features/observe/output/ObserveResultOutput";
import { buildObserveScopeConfig } from "../../features/observe/output/ObserveScopeExperiments";
import type { ObserveScopeInput } from "../../models/ObserveScope";
import { capLayoutWarnings } from "../../features/observe/audits/SafeAreaAuditor";
import {
  classifyObservationAction,
  type ObservationActionClass,
} from "../../features/action/observationActionClass";
import { serverConfig } from "../../utils/ServerConfig";
import {
  collectWindowTruncations,
  isHostOutputTruncationReason,
} from "../../features/observe/truncationReasons";
import { buildObservationScreenshotUri } from "../../daemon/observationResourceUris";
import { stripInternalObservationFields } from "../observationInternalFields";
import type { FinalizeToolResponseContext } from "./contracts";

/**
 * Resolve the observe output projection (issue #4388). An explicit per-call
 * `project` arg always wins; otherwise `raw: true` forces `"full"` (the raw tree
 * is the documented disambiguation escape hatch). The skeleton projection is now
 * the unconditional default (it superseded the retired
 * `observe-result-project-skeleton` flag), so absent an explicit override every
 * observe payload projects to the actionable-only skeleton.
 */
export function resolveObserveProjection(args?: Record<string, unknown>): "full" | "skeleton" {
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
 * Top-level metadata a hierarchy diff cannot derive for itself, but which a
 * diff-mode client needs with the same shape as a full observation. Sourced
 * from the raw (pre-sanitize) observation so projection never suppresses it.
 * Add a field here when it is a straight copy; the contract test walks this
 * list. `skeleton`, `context`, `keyboard`, `truncationReasons`, and `windowTruncations` are excluded
 * because they require projection or provenance merging.
 */
export const DIFF_PASSTHROUGH_METADATA_FIELDS = [
  "activeWindow",
  "freshness",
  "screenSize",
  "observationId",
  "deviceId",
  "display",
  "screenshotSettled",
  "screenshotSettledError",
  "screenshotOrientation",
  "screenshotImageSize",
  "screenshotPixelsPerNativeUnit",
  "screenshotScaleProvenance",
  "screenshotPath",
  "screenshotExpiresAt",
  "screenshotSource",
  "screenshotCaptureSource",
  "screenshotCapturedAt",
  "screenshotAgeMs",
  "screenshotFreshFailure",
  "screenshotFormat",
  "screenshotMimeType",
  "settled",
  "settleMs",
  "settlePolls",
  "accessibilityAuditSkipped",
] as const satisfies readonly (keyof ObserveResult)[];

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
    [terminalScreenshotUnavailable]?: boolean;
  },
  captureAttempted = observation.screenshotCaptureAttempted,
  unavailable = isTerminalScreenshotUnavailable(observation as ObserveResult),
): void {
  if (
    !unavailable &&
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
  hint?: string;
  fromScreen?: ObservationDiffScreenIdentity;
  toScreen?: ObservationDiffScreenIdentity;
}

export interface FinalizationState {
  ctx: FinalizeToolResponseContext;
  payload: Record<string, unknown>;
  cfg: SanitizeObserveConfig;
  sanitizedCopies: (source: ObserveResult) => { uncapped: ObserveResult; capped: ObserveResult };
  scopeConfig: ReturnType<typeof buildObserveScopeConfig>;
  scopeActive: boolean;
  noObserveEnabled: boolean;
  diffActive: boolean;
  canDiff: boolean;
  isObserveTool: boolean;
  sanitizedPayload?: Record<string, unknown>;
  hasArtifactableObservation: boolean;
  pendingBaselineUpdate?: { sessionUuid: string; observation: ObserveResult };
}

export function createFinalizationState(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): FinalizationState {
  const cfg: SanitizeObserveConfig = {
    // Elements are dropped by default; `--observe-result-include-elements` opts
    // back in. Bounds compaction is now an unconditional default.
    dropElements: !serverConfig.isObserveResultIncludeElementsEnabled(),
    compact: true,
  };
  const sanitizedObservations = new WeakMap<
    ObserveResult,
    { uncapped: ObserveResult; capped: ObserveResult }
  >();
  const sanitizedCopies = (source: ObserveResult) => {
    const existing = sanitizedObservations.get(source);
    if (existing) {
      return existing;
    }
    const uncapped = sanitizeObserveResult(
      source,
      { ...cfg, capLayoutWarnings: false },
      ctx.cloneObservation,
    );
    const capped = uncapped.layoutWarnings
      ? { ...uncapped, layoutWarnings: capLayoutWarnings(uncapped.layoutWarnings) }
      : uncapped;
    const copies = { uncapped, capped };
    sanitizedObservations.set(source, copies);
    return copies;
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
  const canDiff = canDiffInSession(diffActive, ctx);
  const isObserveTool = ctx.name === "observe";

  return {
    ctx,
    payload,
    cfg,
    sanitizedCopies,
    scopeConfig,
    scopeActive,
    noObserveEnabled,
    diffActive,
    canDiff,
    isObserveTool,
    hasArtifactableObservation: false,
  };
}

export function renderObservePayload(observeResult: ObserveResult, state: FinalizationState): void {
  const { ctx, sanitizedCopies, canDiff } = state;
  // `observe` always emits the full sanitized observation (no-observe never
  // strips the observe tool itself) and resets the diff baseline to it (#2761).

  const { uncapped, capped: sanitized } = sanitizedCopies(observeResult);
  if (canDiff && ctx.args?.display !== "all") {
    // Diff against the full sanitized tree, never the scoped/projected copy — the
    // next action must see real state, not what this observe payload was cropped
    // to (scope experiments #4344) or projected to (skeleton #4388).
    state.pendingBaselineUpdate = { sessionUuid: ctx.sessionUuid!, observation: sanitized };
  }
  // Served (agent-facing) copy: skeleton projection (#4388) and scope experiments
  // (#4344) are alternative croppings of the observe payload; both apply only to
  // the headline `observe` payload, never to embedded action observations. Skeleton
  // is the more aggressive projection (it replaces viewHierarchy/elements), so when
  // requested it wins. Its skeleton reads the original elements to retain
  // non-enumerable ancestry provenance even when elements are dropped from output.
  const served = new ObservationDisplayRenderer({
    cfg: state.cfg,
    scopeActive: state.scopeActive,
    scopeConfig: state.scopeConfig,
    cloneObservation: ctx.cloneObservation,
    resolveProjection: () => resolveObserveProjection(ctx.args),
  }).render(observeResult, uncapped, sanitized);
  attachObservationScreenshotUri(
    served,
    observeResult.screenshotCaptureAttempted,
    isTerminalScreenshotUnavailable(observeResult),
  );
  state.sanitizedPayload = served;
  state.hasArtifactableObservation = true;
}

export function renderActionPayload(state: FinalizationState): void {
  const { payload, noObserveEnabled } = state;
  if (noObserveEnabled) {
    // Output-only: the handler still computed the observation for success detection.
    const stripped = { ...payload };
    delete stripped.observation;
    stripped.observationDiff = {
      mode: "full",
      reason: "stripped_by_actions_no_observe",
    } satisfies ObservationDiffMetadata;
    state.sanitizedPayload = stripped;
    return;
  }
  if (isObserveResult(payload.observation)) {
    renderActionObservation(payload.observation, state);
  }
}

function renderActionObservation(rawObservation: ObserveResult, state: FinalizationState): void {
  const { ctx, payload, sanitizedCopies } = state;

  const { capped: sanitized } = sanitizedCopies(rawObservation);
  // Action observations default to the compact skeleton (issue #5872) — the
  // same response-shape control `observe` already has — so a client no longer
  // pays the full raw hierarchy on every tapOn/sendKeys/launchApp. Scoped to
  // the `defaultsToSkeletonObservation` trait (the tools that also expose the `raw`/`project`
  // opt-out), so the default and the escape hatch never diverge. The compact
  // form lands under the same `skeleton` key `observe` uses; `raw:true` /
  // `project:"full"` opts back into the raw `viewHierarchy`. Internal
  // tool-to-tool consumers always keep the full tree, while a computed diff
  // replaces the action observation only on the path that emits a diff.
  const servedObservation =
    !ctx.internal &&
    ctx.defaultsToSkeletonObservation === true &&
    resolveObserveProjection(ctx.args) === "skeleton"
      ? projectSanitizedObserveSkeleton(sanitized, rawObservation)
      : sanitized;
  const { observationOut, observationDiff, pendingBaselineUpdate } = resolveActionObservationDiff(
    rawObservation,
    sanitized,
    servedObservation,
    state,
  );
  state.pendingBaselineUpdate = pendingBaselineUpdate;
  if (observationOut && typeof observationOut === "object") {
    attachObservationScreenshotUri(
      observationOut as {
        deviceId?: string;
        observationId?: string;
        observationScreenshotResourceUri?: string;
        screenshotCaptureAttempted?: boolean;
      },
      rawObservation.screenshotCaptureAttempted,
      isTerminalScreenshotUnavailable(rawObservation),
    );
  }
  state.sanitizedPayload = {
    ...payload,
    observation: observationOut,
  };
  if (observationDiff) {
    state.sanitizedPayload.observationDiff = observationDiff;
  }
  state.hasArtifactableObservation = true;
}

function resolveActionObservationDiff(
  rawObservation: ObserveResult,
  sanitized: ObserveResult,
  servedObservation: ObserveResult,
  state: FinalizationState,
) {
  const { ctx, diffActive } = state;
  let pendingBaselineUpdate: FinalizationState["pendingBaselineUpdate"];
  let observationOut: unknown = servedObservation;
  let observationDiff: ObservationDiffMetadata | undefined;
  if (ctx.internal) {
    // Internal envelopes are consumed by in-process tool callers, not agents.
    // Keep them on the pre-diff/pre-strip shape without agent-facing metadata.
  } else if (!diffActive) {
    observationDiff = {
      mode: "full",
      reason: "disabled",
      hint: "Set --actions-diff-observe to receive diffs.",
    };
  } else if (!ctx.sessionUuid || !ctx.baselineStore) {
    observationDiff = {
      mode: "full",
      reason: "missing_session",
      hint: "pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
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
      ({ observationOut, observationDiff } = emitActionObservationDiff(
        { baseline, rawObservation, sanitized, servedObservation },
        state,
      ));
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
  return { observationOut, observationDiff, pendingBaselineUpdate };
}

function emitActionObservationDiff(
  {
    baseline,
    rawObservation,
    sanitized,
    servedObservation,
  }: {
    baseline: ObserveResult;
    rawObservation: ObserveResult;
    sanitized: ObserveResult;
    servedObservation: ObserveResult;
  },
  state: FinalizationState,
) {
  const { ctx, payload } = state;
  const diff = diffObserveResult(baseline, sanitized, {
    collapseKeyboard: servedObservation.skeleton !== undefined,
    skipStatusBar: servedObservation.skeleton !== undefined,
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
  const skeletonProjection =
    servedObservation.skeleton !== undefined
      ? servedObservation
      : projectSanitizedObserveSkeleton(sanitized, rawObservation);
  diff.skeleton = skeletonProjection.skeleton ?? [];
  // Issue #6256: a diff must not silently drop the state-readout
  // `context` alongside `skeleton`. `undefined`
  // (no surviving readout row) is dropped on serialization just like an
  // absent key, so no extra branch is needed here.
  diff.context = skeletonProjection.context;
  diff.keyboard = skeletonProjection.keyboard;
  Object.assign(diff, copyDefinedFields(rawObservation, DIFF_PASSTHROUGH_METADATA_FIELDS));
  // Issue #6601: nor may a diff silently drop the hierarchy's truncation
  // provenance — see resolveDiffTruncationReasons.
  diff.truncationReasons = resolveDiffTruncationReasons(
    baseline,
    servedObservation,
    rawObservation,
  );
  // Window attribution describes the current capture, unlike the merged flat reasons.
  const windowTruncations =
    servedObservation.windowTruncations ??
    collectWindowTruncations(rawObservation.viewHierarchy?.windows);
  Object.assign(diff, windowTruncations ? { windowTruncations } : {});
  const emitFull = shouldEmitFullActionObservation(payload, servedObservation, diff, ctx);
  const observationOut = emitFull ? servedObservation : dropDiffNodeLists(diff);
  const observationDiff: ObservationDiffMetadata = {
    mode: emitFull ? "full" : "diff",
    reason: emitFull ? "screen_changed" : "diff_emitted",
    fromScreen: observationScreenIdentity(baseline),
    toScreen: observationScreenIdentity(sanitized),
  };
  return { observationOut, observationDiff };
}

/** Skipped for a response the client will never receive (#10081). */
export function commitDeliveredBaseline(
  ctx: FinalizeToolResponseContext,
  pending: { sessionUuid: string; observation: ObserveResult } | undefined,
  display: {
    revision: number | undefined;
    key: string | undefined;
    generation: number | undefined;
  },
): void {
  if (ctx.delivered === false) {
    return;
  }
  if (pending) {
    ctx.baselineStore!.set(pending.sessionUuid, pending.observation, display.revision);
  } else if (ctx.sessionUuid && display.revision !== undefined) {
    ctx.baselineStore?.setDisplayRevision?.(
      ctx.sessionUuid,
      display.revision,
      display.key,
      display.generation,
    );
  }
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

/**
 * Owner decision on #11637 item 2: a diff always ships beside its `skeleton`
 * (#6221/#6242), which already lists every actionable node on the current
 * screen, so the added/removed node lists repeat it. Call after the emptiness /
 * replacement checks read them; `changed` stays because the skeleton cannot say
 * what moved from what.
 */
function dropDiffNodeLists(
  diff: ReturnType<typeof diffObserveResult>,
): Partial<ReturnType<typeof diffObserveResult>> {
  const wireDiff: Partial<typeof diff> = { ...diff };
  delete wireDiff.added;
  delete wireDiff.removed;
  return wireDiff;
}

function isEmptyObserveDiff(diff: ReturnType<typeof diffObserveResult>): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.displayChanged === undefined &&
    diff.fields === undefined
  );
}

/** Fewest replaced actionable rows that can read as a screen replacement. */
const MIN_REPLACED_ACTIONABLE_NODES = 3;

/**
 * Whether a same-screen-identity diff actually replaces the screen's actionable
 * content (#11638): sub-screens of one activity (Settings' `SubSettings`) share
 * an identity, so navigating between them would otherwise be emitted as a diff
 * of unrelated rows. At least half of the current actionable skeleton having
 * been both added and removed means the client needs the new screen, not a delta.
 */
function replacedMostActionableNodes(diff: ReturnType<typeof diffObserveResult>): boolean {
  const replaced = Math.min(diff.added.length, diff.removed.length);
  return replaced >= MIN_REPLACED_ACTIONABLE_NODES && replaced * 2 >= (diff.skeleton?.length ?? 0);
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
  return hasSameHierarchyPackage(baseline, next);
}

function hasSameHierarchyPackage(baseline: ObserveResult, next: ObserveResult): boolean {
  return (baseline.viewHierarchy?.packageName ?? "") === (next.viewHierarchy?.packageName ?? "");
}

function canDiffInSession(diffActive: boolean, ctx: FinalizeToolResponseContext): boolean {
  return diffActive && !!ctx.sessionUuid && !!ctx.baselineStore;
}

function shouldEmitFullActionObservation(
  payload: Record<string, unknown>,
  servedObservation: ObserveResult,
  diff: ReturnType<typeof diffObserveResult>,
  ctx: FinalizeToolResponseContext,
): boolean {
  const emitFull =
    (hasScreenChangedEffect(payload) && isEmptyObserveDiff(diff)) ||
    (servedObservation.skeleton !== undefined &&
      classifyObservationAction(ctx.name, ctx.args) !== "scroll" &&
      replacedMostActionableNodes(diff));
  return emitFull;
}
