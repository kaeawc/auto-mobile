import type { DisplayObservation, ObserveResult } from "../models/ObserveResult";
import {
  isTerminalScreenshotUnavailable,
  terminalScreenshotUnavailable,
} from "../utils/PostActionCaptureContext";
import { buildObservationScreenshotUri } from "./observationResourceUris";
import { stripInternalObservationFields } from "./observationInternalFields";
import {
  collectWindowTruncations,
  isHostOutputTruncationReason,
} from "../features/observe/truncationReasons";
import {
  diffObserveResult,
  projectSanitizedObserveSkeleton,
  sanitizeObserveResult,
  type ObserveResultCloner,
  type SanitizeObserveConfig,
} from "../features/observe/output/ObserveResultOutput";
import { readToolEnvelopePayload, writeToolEnvelopePayload } from "./toolEnvelopePayload";
import { ToolResponseSerialization, exceedsInlineLimit } from "./finalizeShared";
import { artifactMode, spillOversizedPayload } from "./finalizeInlineLimit";
import {
  artifactNonObservationPayload,
  isObserveDiff,
  writeObservationArtifact,
  writeObserveDiffBodyArtifact,
} from "./finalizeArtifactWriters";
import {
  canCompactActionMetadata,
  commitDeliveredActionMetadata,
  commitDeliveredBaseline,
  compactActionMetadata,
  pickObserveWaitMetadata,
} from "./finalizeActionMetadata";
import {
  applyObserveScopeExperiments,
  applyObserveScopeToSkeleton,
  buildObserveScopeConfig,
} from "../features/observe/output/ObserveScopeExperiments";
import { serverConfig } from "../utils/ServerConfig";
import { capLayoutWarnings } from "../features/observe/audits/SafeAreaAuditor";
import type { ObserveScopeInput } from "../models/ObserveScope";
import { observationOfPayload } from "../utils/toolUtils";
import {
  dropDiffNodeLists,
  hasRenderableHierarchy,
  hasScreenChangedEffect,
  isEmptyObserveDiff,
  isObserveResult,
  observationScreenIdentity,
  replacedMostActionableNodes,
  shouldDiffObservation,
} from "./observationDiffPredicates";
import { classifyObservationAction } from "../features/action/observationActionClass";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/**
 * Read/write access to per-session diff/metadata baselines and the display revision
 * of the last observation output to the agent. Injected (interface + fake) so `finalizeToolResponse`
 * stays free of a direct `sessionManager`/`DaemonState` dependency; the call site
 * backs it with `SessionManager.setLastRenderedObservation` /
 * `getSessionCache(...).lastRenderedObservation`.
 */
export interface ObservationBaselineStore {
  get(sessionUuid: string): ObserveResult | undefined;
  set(sessionUuid: string, observation: ObserveResult, displayRevision?: number): void;
  /** Last inline-sent blocks for the current device; a different device returns undefined. */
  getActionMetadata?(
    sessionUuid: string,
    deviceId: string,
  ): Readonly<Record<string, unknown>> | undefined;
  /** Replaces the current device snapshot, including an empty device-switch invalidation. */
  setActionMetadata?(sessionUuid: string, deviceId: string, blocks: Record<string, unknown>): void;
  setDisplayRevision?(
    sessionUuid: string,
    revision: number,
    key?: string,
    generation?: number,
  ): void;
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
   * Finalization also supplies its cached complete JSON here, sharing the
   * structured-content size probe with the artifact writer. Callers without a
   * cached rendering can omit this and pass `data` alone.
   */
  serialized?: string;
}

export interface ObservationArtifactWriter {
  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata;
}

export type ObservationArtifactMode = "always" | "oversized";

/**
 * Action tools that embed a post-action observation AND expose the `raw`/`project`
 * response-shape control (issues #5872, #5886). Their embedded observation defaults
 * to the compact skeleton, opt-out-able per call. The default is scoped to exactly
 * the tools that carry the opt-out so the two never diverge: a tool that
 * skeletonizes by default but cannot be asked for the raw tree would be a silent
 * one-way door. #5872 shipped the first three; #5886 extends both the default and
 * the opt-out to every remaining observation-producing action tool, together.
 * Membership is checked in both directions against advertised defaults/opt-outs
 * by test/server/skeletonDefaultDrift.test.ts, with explicit exemptions for
 * tools whose payloads do not embed an observation.
 * `observe` is not here — it owns the projection at the payload top level, not
 * under `.observation`.
 */
export const SKELETON_DEFAULT_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "tapOn",
  "tapAt",
  "sendKeys",
  "launchApp",
  "tapAny",
  "dragAndDrop",
  "dragPath",
  "selectAllText",
  "pressButton",
  "systemTray",
  "swipeOn",
  "swipeAt",
  "pinchOn",
  "multiTouch",
  "openLink",
  "shake",
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
  /** The tool is read-only, so its artifact write failure stays loud (`loudArtifactWrites` trait). */
  loudArtifactWrites?: boolean;
  /** Injectable JSON clone boundary for deterministic clone-count tests. */
  cloneObservation?: ObserveResultCloner;
  /**
   * Registered tool output contract. Required top-level object fields remain in
   * a bounded inline residue when the complete response spills to an artifact.
   */
  outputSchema?: unknown;
  args?: Record<string, unknown>;
  sessionUuid?: string;
  baselineStore?: ObservationBaselineStore;
  /** Connection preference takes precedence over the effective daemon default. */
  actionsCompactMetadata?: boolean;
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
  /**
   * Whether this response will actually be handed to the client (issue #10081).
   * `false` when the request was already cancelled or timed out, so the response
   * is thrown away. A discarded response must not advance the diff baseline, the
   * display revision or the "last inline-sent" action-metadata snapshot: the next
   * delivered response would otherwise be reduced against blocks the client never
   * received. Reads are unaffected. Defaults to `true`.
   */
  delivered?: boolean;
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

export interface ObservationDiffScreenIdentity {
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
  ctx = withSerializedArtifacts(ctx, serialization);
  const payload = envelopeView.payload;
  const hasStructured = envelopeView.hasStructured;

  const stage = createObservationStage(ctx, payload);
  const renderedDisplay = renderedDisplayFacts(stage);
  const observation = finalizeObservation(stage);
  let sanitizedPayload = artifactServedPayload(stage, observation, hasStructured, serialization);

  sanitizedPayload = boundOversizedPayload(
    ctx,
    sanitizedPayload ?? payload,
    sanitizedPayload,
    hasStructured,
    serialization,
  );

  // Artifacts retain complete metadata. Compact only the residue delivered inline,
  // and preserve the original envelope when compaction has nothing to remove.
  if (canCompactActionMetadata(ctx, payload, envelopeView.envelope)) {
    const inlinePayload = sanitizedPayload ?? payload;
    const compacted = compactActionMetadata(inlinePayload, ctx);
    if (compacted !== inlinePayload) {
      sanitizedPayload = compacted;
    }
  }

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
  commitDeliveredActionMetadata(ctx, payload, sanitizedPayload);
  commitDeliveredBaseline(ctx, observation.pendingBaselineUpdate, renderedDisplay);

  return response;
}

/** The served payload after the observation (and, in `always` mode, the response) spills to artifacts. */
function artifactServedPayload(
  stage: ObservationStage,
  observation: ObservationOutcome,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): Record<string, unknown> | undefined {
  const { ctx, payload } = stage;
  let sanitizedPayload = observation.sanitizedPayload;
  if (
    ctx.artifactWriter &&
    !ctx.internal &&
    observation.hasArtifactableObservation &&
    sanitizedPayload &&
    shouldArtifactObservationPayload(ctx, sanitizedPayload, hasStructured, serialization)
  ) {
    sanitizedPayload = artifactObservationPayload(stage, sanitizedPayload);
  }

  if (artifactMode(ctx) === "always") {
    sanitizedPayload ??= artifactWriteOrInline(
      ctx,
      "response",
      () => artifactNonObservationPayload(ctx, payload),
      undefined,
    );
  }
  return sanitizedPayload;
}

/** Routes artifact writes through the one serialization this response shares with its envelope. */
function withSerializedArtifacts(
  ctx: FinalizeToolResponseContext,
  serialization: ToolResponseSerialization,
): FinalizeToolResponseContext {
  const artifactWriter = ctx.artifactWriter;
  if (!artifactWriter) {
    return ctx;
  }
  return {
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

/** Everything the observation-shaping steps of one finalize call share. */
interface ObservationStage {
  readonly ctx: FinalizeToolResponseContext;
  readonly payload: Record<string, unknown>;
  readonly cfg: SanitizeObserveConfig;
  /** Sanitized copies of one source observation, uncapped and capped, computed once. */
  readonly sanitizedCopies: (source: ObserveResult) => {
    uncapped: ObserveResult;
    capped: ObserveResult;
  };
  readonly scopeConfig: ReturnType<typeof buildObserveScopeConfig>;
  readonly scopeActive: boolean;
  readonly noObserveEnabled: boolean;
  readonly diffActive: boolean;
  readonly canDiff: boolean;
  readonly isObserveTool: boolean;
}

/** What the observation-shaping steps decided about the served payload. */
interface ObservationOutcome {
  sanitizedPayload: Record<string, unknown> | undefined;
  hasArtifactableObservation: boolean;
  pendingBaselineUpdate: { sessionUuid: string; observation: ObserveResult } | undefined;
}

/**
 * Progressive-disclosure scoping experiments (issue #4344), now always honored: each dimension is
 * intersected with the per-call `scope` request in `buildObserveScopeConfig`, so with no `scope`
 * arg this is a no-op. Agent-facing only: internal tool-to-tool consumers read the full
 * `.observation.viewHierarchy`, so scoping (like the diff/strip transforms) is suppressed for
 * `ctx.internal`.
 */
function resolveObservationScope(ctx: FinalizeToolResponseContext) {
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
  return { scopeConfig, scopeActive };
}

function createObservationStage(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
): ObservationStage {
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

  const { scopeConfig, scopeActive } = resolveObservationScope(ctx);

  // Internal tool-to-tool calls (#3053) always get the full sanitized observation:
  // the diff/strip transforms are for the agent-facing wire only, so an internal
  // consumer reading `.observation.viewHierarchy` off a finalized step envelope is
  // never handed a diff or a stripped payload.
  const noObserveEnabled = serverConfig.isActionsNoObserveEnabled() && !ctx.internal;
  // Precedence (#3026 / #2762): `--actions-no-observe` strips the embedded
  // observation entirely, so `--actions-diff-observe` is moot when both are on.
  const diffActive =
    serverConfig.isActionsDiffObserveEnabled() && !noObserveEnabled && !ctx.internal;
  return {
    ctx,
    payload,
    cfg,
    sanitizedCopies,
    scopeConfig,
    scopeActive,
    noObserveEnabled,
    diffActive,
    canDiff: diffActive && !!ctx.sessionUuid && !!ctx.baselineStore,
    isObserveTool: ctx.name === "observe",
  };
}

/** The display facts the delivered baseline is keyed by. */
function renderedDisplayFacts(stage: ObservationStage) {
  const renderedObservation = observationOfPayload(stage.ctx.name, stage.payload);
  const rendered = isObserveResult(renderedObservation) ? renderedObservation : undefined;
  return {
    key: rendered?.display?.key,
    generation: rendered?.display?.generation,
    revision: deliveredDisplayRevision(stage, rendered),
  };
}

function deliveredDisplayRevision(
  stage: ObservationStage,
  rendered: ObserveResult | undefined,
): number | undefined {
  const { ctx, isObserveTool, noObserveEnabled } = stage;
  const eligible =
    !ctx.internal &&
    !(isObserveTool && ctx.args?.display === "all") &&
    (isObserveTool || !noObserveEnabled);
  return eligible && typeof rendered?.displayRevision === "number"
    ? rendered.displayRevision
    : undefined;
}

/** Locate the ObserveResult: the payload itself for `observe`, else `.observation`. */
function finalizeObservation(stage: ObservationStage): ObservationOutcome {
  const { payload, isObserveTool } = stage;
  if (isObserveTool && isObserveResult(payload)) {
    return finalizeObserveResult(stage, payload);
  }
  if (!isObserveTool && payload.observation !== undefined) {
    return finalizeActionObservation(stage);
  }
  return {
    sanitizedPayload: undefined,
    hasArtifactableObservation: false,
    pendingBaselineUpdate: undefined,
  };
}

function finalizeObserveResult(
  stage: ObservationStage,
  observeResult: ObserveResult,
): ObservationOutcome {
  const { ctx } = stage;
  // `observe` always emits the full sanitized observation (no-observe never
  // strips the observe tool itself) and resets the diff baseline to it (#2761).
  const { uncapped, capped: sanitized } = stage.sanitizedCopies(observeResult);
  // Diff against the full sanitized tree, never the scoped/projected copy — the
  // next action must see real state, not what this observe payload was cropped
  // to (scope experiments #4344) or projected to (skeleton #4388).
  const pendingBaselineUpdate =
    stage.canDiff && ctx.args?.display !== "all"
      ? { sessionUuid: ctx.sessionUuid!, observation: sanitized }
      : undefined;
  let served = serveObserveHeadline(stage, observeResult, uncapped, sanitized);
  if (observeResult.displays) {
    served = {
      ...served,
      displays: observeResult.displays.map((entry) =>
        serveDisplayObservation(stage, observeResult, entry),
      ),
    };
  }
  attachObservationScreenshotUri(
    served,
    observeResult.screenshotCaptureAttempted,
    isTerminalScreenshotUnavailable(observeResult),
  );
  return { sanitizedPayload: served, hasArtifactableObservation: true, pendingBaselineUpdate };
}

/**
 * Served (agent-facing) copy: skeleton projection (#4388) and scope experiments (#4344) are
 * alternative croppings of the observe payload; both apply only to the headline `observe` payload,
 * never to embedded action observations. Skeleton is the more aggressive projection (it replaces
 * viewHierarchy/elements), so when requested it wins. Its skeleton reads the original elements to
 * retain non-enumerable ancestry provenance even when elements are dropped from output.
 */
function serveObserveHeadline(
  stage: ObservationStage,
  observeResult: ObserveResult,
  uncapped: ObserveResult,
  sanitized: ObserveResult,
): ObserveResult {
  const { ctx, scopeActive, scopeConfig } = stage;
  if (resolveObserveProjection(ctx.args) === "skeleton") {
    const projected = projectSanitizedObserveSkeleton(sanitized, observeResult);
    // Skeleton replaces the hierarchy, so FOCUS/REGION run on the full uncapped
    // tree and the skeleton keeps only the rows that survive them.
    return scopeActive ? applyObserveScopeToSkeleton(projected, uncapped, scopeConfig) : projected;
  }
  if (!scopeActive) {
    return sanitized;
  }
  // Scope-then-cap (#5074): use the already-sanitized UNCAPPED copy so the scope
  // transforms see every warning, then cap the scoped result — an in-scope
  // warning is never lost to a cap taken against the full tree. The baseline
  // stays the capped `sanitized` full tree.
  let served = applyObserveScopeExperiments(uncapped, scopeConfig);
  // A no-op scope returns its input. Keep subsequent output-only metadata
  // off the cached baseline when capped and uncapped are the same object.
  if (served === uncapped) {
    served = { ...served };
  }
  if (served.layoutWarnings) {
    served.layoutWarnings = capLayoutWarnings(served.layoutWarnings);
  }
  return served;
}

function serveDisplayObservation(
  stage: ObservationStage,
  observeResult: ObserveResult,
  entry: NonNullable<ObserveResult["displays"]>[number],
): DisplayObservation {
  const { ctx, cfg, scopeActive, scopeConfig } = stage;
  const source: ObserveResult = {
    observationId: observeResult.observationId,
    updatedAt: observeResult.updatedAt,
    ...entry,
    systemInsets: entry.systemInsets ?? observeResult.systemInsets,
  };
  let panel = sanitizeObserveResult(source, cfg, ctx.cloneObservation);
  if (resolveObserveProjection(ctx.args) === "skeleton") {
    const projected = projectSanitizedObserveSkeleton(panel, source);
    panel = scopeActive ? applyObserveScopeToSkeleton(projected, panel, scopeConfig) : projected;
  } else if (scopeActive) {
    panel = applyObserveScopeExperiments(panel, scopeConfig);
  }
  return {
    display: panel.display,
    screenSize: panel.screenSize,
    freshness: entry.freshness,
    ...copyDefinedFields(panel, [
      "viewHierarchy",
      "skeleton",
      "context",
      "keyboard",
      "truncationReasons",
      "windowTruncations",
      "screenshotPath",
      "screenshotExpiresAt",
      "observeScope",
    ]),
  } satisfies DisplayObservation;
}

/** An action tool's embedded `.observation`: stripped, or sanitized and optionally diffed. */
function finalizeActionObservation(stage: ObservationStage): ObservationOutcome {
  const { payload } = stage;
  if (stage.noObserveEnabled) {
    // `--actions-no-observe` (#2762/#3026): drop the embedded observation from
    // the served payload (output-only — the handler still computed it for its
    // own success detection). Wins over the diff flag: nothing left to diff.
    const stripped = { ...payload };
    delete stripped.observation;
    stripped.observationDiff = {
      mode: "full",
      reason: "stripped_by_actions_no_observe",
    } satisfies ObservationDiffMetadata;
    return {
      sanitizedPayload: stripped,
      hasArtifactableObservation: false,
      pendingBaselineUpdate: undefined,
    };
  }
  if (!isObserveResult(payload.observation)) {
    return {
      sanitizedPayload: undefined,
      hasArtifactableObservation: false,
      pendingBaselineUpdate: undefined,
    };
  }
  const rawObservation = payload.observation as ObserveResult;
  const { capped: sanitized } = stage.sanitizedCopies(rawObservation);
  // Action observations default to the compact skeleton (issue #5872) — the
  // same response-shape control `observe` already has — so a client no longer
  // pays the full raw hierarchy on every tapOn/sendKeys/launchApp. Scoped to
  // SKELETON_DEFAULT_ACTION_TOOLS (the tools that also expose the `raw`/`project`
  // opt-out), so the default and the escape hatch never diverge. The compact
  // form lands under the same `skeleton` key `observe` uses; `raw:true` /
  // `project:"full"` opts back into the raw `viewHierarchy`. Internal
  // tool-to-tool consumers always keep the full tree, while a computed diff
  // replaces the action observation only on the path that emits a diff.
  const servedObservation =
    !stage.ctx.internal &&
    SKELETON_DEFAULT_ACTION_TOOLS.has(stage.ctx.name) &&
    resolveObserveProjection(stage.ctx.args) === "skeleton"
      ? projectSanitizedObserveSkeleton(sanitized, rawObservation)
      : sanitized;
  const diffed = resolveActionObservationDiff(stage, sanitized, servedObservation, rawObservation);
  if (diffed.observationOut && typeof diffed.observationOut === "object") {
    attachObservationScreenshotUri(
      diffed.observationOut as {
        deviceId?: string;
        observationId?: string;
        observationScreenshotResourceUri?: string;
        screenshotCaptureAttempted?: boolean;
      },
      rawObservation.screenshotCaptureAttempted,
      isTerminalScreenshotUnavailable(rawObservation),
    );
  }
  const sanitizedPayload: Record<string, unknown> = {
    ...payload,
    observation: diffed.observationOut,
  };
  if (diffed.observationDiff) {
    sanitizedPayload.observationDiff = diffed.observationDiff;
  }
  return {
    sanitizedPayload,
    hasArtifactableObservation: true,
    pendingBaselineUpdate: diffed.pendingBaselineUpdate,
  };
}

interface ActionObservationDiff {
  observationOut: unknown;
  observationDiff: ObservationDiffMetadata | undefined;
  pendingBaselineUpdate?: { sessionUuid: string; observation: ObserveResult };
}

function resolveActionObservationDiff(
  stage: ObservationStage,
  sanitized: ObserveResult,
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
): ActionObservationDiff {
  const { ctx } = stage;
  if (ctx.internal) {
    // Internal envelopes are consumed by in-process tool callers, not agents.
    // Keep them on the pre-diff/pre-strip shape without agent-facing metadata.
    return { observationOut: servedObservation, observationDiff: undefined };
  }
  if (!stage.diffActive) {
    return {
      observationOut: servedObservation,
      observationDiff: {
        mode: "full",
        reason: "disabled",
        hint: "Set --actions-diff-observe to receive diffs.",
      },
    };
  }
  if (!ctx.sessionUuid || !ctx.baselineStore) {
    return {
      observationOut: servedObservation,
      observationDiff: {
        mode: "full",
        reason: "missing_session",
        hint: "pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
        toScreen: observationScreenIdentity(sanitized),
      },
    };
  }
  if (!hasRenderableHierarchy(sanitized)) {
    const baseline = ctx.baselineStore.get(ctx.sessionUuid);
    return {
      observationOut: servedObservation,
      observationDiff: {
        mode: "full",
        reason: "unrenderable_hierarchy",
        fromScreen: baseline ? observationScreenIdentity(baseline) : undefined,
        toScreen: observationScreenIdentity(sanitized),
      },
    };
  }
  // canDiff is provably true here: not internal, diffActive, session +
  // baseline store present, and the hierarchy is renderable.
  // Emit a diff vs the baseline when it exists and the screen is unchanged;
  // otherwise fall back to the full observation (cross-screen diffs are
  // meaningless, and there is nothing to diff on the first action). Either
  // way, update the baseline to this observation so the next action diffs
  // against current state.
  const baseline = ctx.baselineStore.get(ctx.sessionUuid);
  return {
    ...diffAgainstBaseline(stage, baseline, sanitized, servedObservation, rawObservation),
    pendingBaselineUpdate: { sessionUuid: ctx.sessionUuid, observation: sanitized },
  };
}

function diffAgainstBaseline(
  stage: ObservationStage,
  baseline: ObserveResult | undefined,
  sanitized: ObserveResult,
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
): ActionObservationDiff {
  const { ctx } = stage;
  if (!baseline) {
    return {
      observationOut: servedObservation,
      observationDiff: {
        mode: "full",
        reason: "missing_baseline",
        toScreen: observationScreenIdentity(sanitized),
      },
    };
  }
  if (!hasRenderableHierarchy(baseline)) {
    return {
      observationOut: servedObservation,
      observationDiff: {
        mode: "full",
        reason: "unrenderable_hierarchy",
        fromScreen: observationScreenIdentity(baseline),
        toScreen: observationScreenIdentity(sanitized),
      },
    };
  }
  if (!shouldDiffObservation(baseline, sanitized, classifyObservationAction(ctx.name, ctx.args))) {
    return {
      observationOut: servedObservation,
      observationDiff: {
        mode: "full",
        reason: "screen_changed",
        fromScreen: observationScreenIdentity(baseline),
        toScreen: observationScreenIdentity(sanitized),
      },
    };
  }
  return emitObservationDiff(stage, baseline, sanitized, servedObservation, rawObservation);
}

function emitObservationDiff(
  stage: ObservationStage,
  baseline: ObserveResult,
  sanitized: ObserveResult,
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
): ActionObservationDiff {
  const { ctx, payload } = stage;
  const skeletonServed = servedObservation.skeleton !== undefined;
  const diff = diffObserveResult(baseline, sanitized, {
    collapseKeyboard: skeletonServed,
    skipStatusBar: skeletonServed,
    layoutWarningsDiffMode: skeletonServed ? "perEntry" : "full",
    projectAddedRemoved: skeletonServed,
  });
  // Always attach a usable selector surface alongside the diff (issue #6221
  // item 4.1): a client that gets a diff must never be left with no
  // `skeleton` to act on — including when the request is `raw:true` /
  // `project:"full"` (PR #6242 review PRRT_kwDOP-GF5M6fq3iK), where
  // `servedObservation` itself carries no skeleton. `diffObserveResult`
  // cannot compute this itself — `elements` is already dropped from
  // `sanitized` by the time it runs — so it is resolved here instead.
  const skeletonProjection = skeletonServed
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
  attachDiffTruncation(diff, baseline, servedObservation, rawObservation);
  const emitFull =
    (hasScreenChangedEffect(payload) && isEmptyObserveDiff(diff)) ||
    (skeletonServed &&
      classifyObservationAction(ctx.name, ctx.args) !== "scroll" &&
      replacedMostActionableNodes(diff));
  return {
    observationOut: emitFull ? servedObservation : dropDiffNodeLists(diff),
    observationDiff: {
      mode: emitFull ? "full" : "diff",
      reason: emitFull ? "screen_changed" : "diff_emitted",
      fromScreen: observationScreenIdentity(baseline),
      toScreen: observationScreenIdentity(sanitized),
    },
  };
}

function attachDiffTruncation(
  diff: ReturnType<typeof diffObserveResult>,
  baseline: ObserveResult,
  servedObservation: ObserveResult,
  rawObservation: ObserveResult,
): void {
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
}

/** Spills the observation of a served payload to an artifact, keeping only a reference inline. */
function artifactObservationPayload(
  stage: ObservationStage,
  sanitizedPayload: Record<string, unknown>,
): Record<string, unknown> {
  const { ctx } = stage;
  if (stage.isObserveTool) {
    // Keep compact wait status inline: without it, an artifacted `observe`
    // response hides whether the requested condition matched or timed out.
    return {
      ...pickObserveWaitMetadata(sanitizedPayload),
      ...writeObservationArtifact(ctx, sanitizedPayload),
    };
  }
  const inlinePayload = sanitizedPayload;
  const observation = inlinePayload.observation;
  return artifactWriteOrInline(
    ctx,
    "observation",
    () => ({
      ...inlinePayload,
      observation:
        isObserveDiff(observation) && resolveObserveProjection(ctx.args) !== "full"
          ? writeObserveDiffBodyArtifact(ctx, observation)
          : writeObservationArtifact(ctx, observation),
    }),
    inlinePayload,
  );
}

/**
 * Hard ceiling (issue #6870). Spilling `observation` bounds only the
 * observation: `observationDiff` rides at the TOP level beside it, and so does
 * every other tool field, so a response could still be handed to the client
 * far over the inline limit — which a one-shot `--cli` transport then cut
 * mid-string into unparseable JSON. With a writer available, spill whatever
 * residue is still oversized and keep only the headline fields inline, so the
 * client always gets complete, parseable JSON plus a pointer to the rest.
 */
function boundOversizedPayload(
  ctx: FinalizeToolResponseContext,
  boundedCandidate: Record<string, unknown>,
  sanitizedPayload: Record<string, unknown> | undefined,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): Record<string, unknown> | undefined {
  if (
    !ctx.artifactWriter ||
    ctx.internal ||
    !exceedsInlineLimit(boundedCandidate, hasStructured, serialization)
  ) {
    return sanitizedPayload;
  }
  try {
    return spillOversizedPayload(ctx, boundedCandidate, hasStructured, serialization);
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
    return sanitizedPayload;
  }
}

/**
 * Run an artifact write whose failure must not erase a completed action (#10080).
 *
 * For a tool that can mutate the device the action has already run, so throwing
 * here would return `isError` for work that happened and invite a duplicate retry
 * (the same rule the hard-ceiling spill follows, #6870). On failure warn and serve
 * `inline` instead. Read-only tools keep the loud failure.
 */
function artifactWriteOrInline<T>(
  ctx: FinalizeToolResponseContext,
  what: string,
  write: () => T,
  inline: T,
): T {
  if (ctx.loudArtifactWrites === true) {
    return write();
  }
  try {
    return write();
  } catch (error) {
    logger.warn(
      `finalizeToolResponse: could not write the ${what} artifact for ${ctx.name}; serving it inline: ${errorMessage(error)}`,
      error,
    );
    return inline;
  }
}

function shouldArtifactObservationPayload(
  ctx: FinalizeToolResponseContext,
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): boolean {
  if (artifactMode(ctx) === "always") {
    return true;
  }

  // Measures the whole served payload — `observationDiff` and every other
  // top-level field included — not just the observation subtree.
  return exceedsInlineLimit(payload, hasStructured, serialization);
}
