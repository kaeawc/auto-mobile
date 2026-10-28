import type { ObserveResult } from "../../models/ObserveResult";
import type { ObserveResultCloner } from "../../features/observe/output/ObserveResultOutput";

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
  /**
   * The tool's embedded observation defaults to the compact skeleton
   * (`defaultsToSkeletonObservation` trait, #5872/#5886); `raw`/`project` opts out per call.
   * `observe` does not declare it: it owns the projection at the payload top level.
   */
  defaultsToSkeletonObservation?: boolean;
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
  /**
   * A plain `register()` tool's response (#13942). Only the hard-ceiling spill and
   * the `resourceLink` opt-in apply, each with its resource_link block. Observation
   * rendering, action-metadata compaction, `extras` stripping and the "always"
   * artifact mode belong to the device pipeline and are skipped, so a normal-sized
   * plain response leaves finalization unchanged.
   */
  plainTool?: boolean;
}
