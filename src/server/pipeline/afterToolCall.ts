import { classifyToolResult } from "../../utils/toolEnvelopePayload";
import { BootedDevice, isViewHierarchyResult, type ViewHierarchyResult } from "../../models";
import { NavigationGraphManager } from "../../features/navigation/NavigationGraphManager";
import { UIStateExtractor } from "../../features/navigation/UIStateExtractor";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import { RealSettleObserve } from "../../features/observe/SettleObserve";
import type { SettleObserve } from "../../features/observe/interfaces/SettleObserve";
import { settleEmbeddedObservationInResponse } from "../embeddedObservationSettle";
import { serverConfig } from "../../utils/ServerConfig";
import { TelemetryRecorder } from "../../features/telemetry/TelemetryRecorder";
import { logger } from "../../utils/logger";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { type Timer } from "../../utils/SystemTimer";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { INTERNAL_MCP_SESSION_PARAM, INTERNAL_NO_DIFF_PARAM } from "../../daemon/wire/constants";
import { getToolCallRecorder } from "../../daemon/toolCallRecordingManager";
import { formatToolResultLog } from "../toolResultLog";
import { formatStructuredToolError } from "../../utils/formatStructuredToolError";
import {
  finalizeToolResponse,
  type ObservationArtifactWriter,
  type ObservationBaselineStore,
} from "../finalizeToolResponse";
import { getStructuredField, observationOfPayload } from "../../utils/toolUtils";
import { readToolEnvelopePayload } from "../../daemon/toolEnvelopePayload";
import { isMarkedToolFailure } from "../../utils/toolFailureSignal";
import { narrowInternalToolEnvelope } from "../../utils/internalToolPayloads";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactRetention,
} from "../toolOutputArtifactWriter";
import { getDefaultToolOutputsDir } from "../../utils/toolOutputArtifacts";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import { isClientCancelled } from "../../utils/AbortContext";
import { deleteInternalToolParams } from "../../daemon/wire/constants";
import type { ToolTraits } from "../toolRegistry";
import { isRecord } from "./isRecord";
import { redactToolSecrets } from "../../utils/redactToolSecrets";

interface AfterToolCallInput {
  name: string;
  traits?: ToolTraits;
  outputSchema: unknown;
  args: any;
  device: BootedDevice | undefined;
  internalCall: boolean;
  response: any;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
  signal?: AbortSignal;
  timer: Timer;
  toolStartMs: number;
}

interface AfterToolCallResult {
  durationMs: number;
  finalizedResponse: any;
}

export interface PlainToolFinalizeInput {
  name: string;
  outputSchema: unknown;
  args: unknown;
  response: unknown;
  timer: Timer;
}

export interface AfterToolCallHandler {
  handle(input: AfterToolCallInput): Promise<AfterToolCallResult>;
}

/** Finalizes a plain `register()` tool's response: hard ceiling and `resourceLink` only (#13942). */
export interface PlainToolFinalizer {
  finalizePlain(input: PlainToolFinalizeInput): unknown;
}

export function isToolResponseFailure(response: unknown): boolean {
  if (!isRecord(response)) {
    return false;
  }
  if (response.isError === true || response.success === false) {
    return true;
  }
  // getStructuredPayload also parses text; only explicit structured status belongs here.
  const structuredContent = response.structuredContent;
  if (isRecord(structuredContent) && typeof structuredContent.success === "boolean") {
    return structuredContent.success === false;
  }
  if (response.success === true) {
    return false;
  }
  return isMarkedToolFailure(response);
}

/**
 * Read an unprojected observation hierarchy from a completed tool envelope.
 *
 * `observe` returns the ObserveResult as its top-level structured payload,
 * while action tools nest the same snapshot under `.observation`. This runs
 * before `finalizeToolResponse`, so it preserves the raw hierarchy even when
 * the client-facing response uses the compact skeleton projection.
 */
function getObservedHierarchy(
  name: string,
  response: { structuredContent?: unknown; content?: unknown } | undefined,
): ViewHierarchyResult | undefined {
  const payload = readToolEnvelopePayload(response)?.payload;
  if (!isRecord(payload)) {
    return undefined;
  }

  const observation = observationOfPayload(name, payload);
  if (!isRecord(observation) || !isViewHierarchyResult(observation.viewHierarchy)) {
    return undefined;
  }
  return observation.viewHierarchy;
}

type ObservationArtifactWriterFactory = (
  outputDirectory: string,
  timer: Timer,
  retention?: ToolOutputArtifactRetention,
) => ObservationArtifactWriter;

export const AUTOMATIC_TOOL_OUTPUT_RETENTION: ToolOutputArtifactRetention = {
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxFiles: 500,
  overflowMinAgeMs: 60 * 60 * 1000,
};

function unwrapToolResponse(response: unknown, toolName: string): any {
  // Client calls permit unstructured text. Step executors enforce the strict
  // policy; logging keeps its existing fallback for uninterpretable envelopes.
  const result = classifyToolResult(response, toolName, null);
  return result.kind === "payload" && "success" in result.payload ? result.payload : response;
}

/**
 * Build the settle delegate the embedded-observation stability gate (#6866)
 * re-observes with. Injected so tests drive the gate on a FakeObserveScreen +
 * FakeTimer instead of a device.
 */
export type SettleObserveFactory = (
  device: BootedDevice,
  timer: Timer,
) => SettleObserve | undefined;

export class DefaultAfterToolCallHandler implements AfterToolCallHandler, PlainToolFinalizer {
  // One writer per (timer, resolved directory), built lazily through the factory.
  // The writer's directory-validation cache and 60s prune throttle are instance
  // state, so a writer per tool call defeated both (issue #10079). Keyed by timer
  // identity too because the writer captures its timer; production passes one.
  private readonly artifactWriters = new WeakMap<Timer, Map<string, ObservationArtifactWriter>>();

  constructor(
    private readonly createArtifactWriter: ObservationArtifactWriterFactory = (
      outputDirectory,
      timer,
      retention,
    ) => new JsonToolOutputArtifactWriter({ outputDirectory, timer, retention }),
    private readonly createSettleObserve: SettleObserveFactory = (device, timer) =>
      new RealSettleObserve(new RealObserveScreen(device), timer),
  ) {}

  private getArtifactWriter(outputDirectory: string, timer: Timer): ObservationArtifactWriter {
    let writersByDirectory = this.artifactWriters.get(timer);
    if (!writersByDirectory) {
      writersByDirectory = new Map();
      this.artifactWriters.set(timer, writersByDirectory);
    }
    const key = resolvePathFromDaemonLaunchWorkingDirectory(outputDirectory);
    let writer = writersByDirectory.get(key);
    if (!writer) {
      writer = this.createArtifactWriter(outputDirectory, timer, AUTOMATIC_TOOL_OUTPUT_RETENTION);
      writersByDirectory.set(key, writer);
    }
    return writer;
  }

  /** The writer for an agent-facing call; internal calls never spill. */
  private agentFacingArtifactWriter(
    internalCall: boolean,
    timer: Timer,
  ): ObservationArtifactWriter | undefined {
    if (internalCall) {
      return undefined;
    }
    return this.getArtifactWriter(
      serverConfig.getToolOutputsDir() ?? getDefaultToolOutputsDir(),
      timer,
    );
  }

  finalizePlain(input: PlainToolFinalizeInput): unknown {
    const { name, outputSchema, args, response, timer } = input;
    const internal = isRecord(args) && args[INTERNAL_NO_DIFF_PARAM] === true;
    // `plainTool` never reads the artifact mode: a configured output directory only
    // chooses where a spill lands, and only device tools artifact every response.
    return finalizeToolResponse(response, {
      name,
      outputSchema,
      args: isRecord(args) ? args : undefined,
      internal,
      plainTool: true,
      artifactWriter: this.agentFacingArtifactWriter(internal, timer),
    });
  }

  async handle(input: AfterToolCallInput): Promise<AfterToolCallResult> {
    const {
      name,
      traits,
      outputSchema,
      args,
      internalCall,
      device,
      response,
      sessionUuid,
      signal,
      timer,
      toolStartMs,
    } = input;

    // Unwrap the payload for result logging and finalization metadata.
    // Pipeline failure classification uses explicit status and the out-of-band mark.
    const unwrapped = unwrapToolResponse(response, name);

    const { toolSuccess, toolError } = logToolResponse(unwrapped, name, signal);

    // Issue #6866: a navigation-class action's embedded observation can be
    // captured before the destination screen finishes inflating, so the client's
    // first look misses a not-yet-attached child (the Settings `switchWidget`)
    // and the parent row's content-derived `s2-…` id changes on the next
    // observe. Gate that capture on hierarchy stability HERE — before the
    // session hierarchy cache, the diff baseline and the skeleton projection all
    // read it — so every downstream consumer sees the settled screen. In-place,
    // scroll and unknown classes are untouched and keep their current latency.
    //
    // Invoked unconditionally, including for `success: false`: the helper owns
    // that distinction and short-circuits a failed action to a plain
    // `settled: false` stamp WITHOUT re-observing, so guarding on the tool's
    // success here only made that stamp unreachable and left a failed action's
    // observation carrying no stability verdict at all.
    await settleEmbeddedObservationInResponse(response, {
      name,
      args: typeof args === "object" && args !== null ? args : undefined,
      internal: internalCall,
      signal,
      timer,
      createSettleObserve: () => (device ? this.createSettleObserve(device, timer) : undefined),
    });

    const durationMs = timer.now() - toolStartMs;

    // Typed envelope views (issues #2932 / #3222): the heterogeneous pipeline
    // hands back `any`, so narrow to the concrete tool payload via
    // `narrowInternalToolEnvelope` before reading. Unlike a raw unchecked cast,
    // this validates the envelope shape at runtime (a bad shape
    // yields `undefined`, matching `getStructuredField`'s existing behavior) and
    // keys the payload type off the tool name via `InternalToolPayloads`. Reading
    // a non-hoisted field off the envelope top level (`swipeEnvelope.found`) is a
    // compile error, and `getStructuredField`'s key is checked against the
    // payload — the stringly-typed dead-read footgun is gone.
    updateScrollPosition(input);
    const sessionManager = cacheObservedHierarchy(input);

    const baselineStore = observationBaselineStore(sessionUuid, sessionManager);
    const artifactMode = serverConfig.getToolOutputsDir() ? "always" : "oversized";
    const artifactWriter = this.agentFacingArtifactWriter(internalCall, timer);

    const finalizedResponse = finalizeToolResponse(response, {
      name,
      loudArtifactWrites: traits?.loudArtifactWrites,
      defaultsToSkeletonObservation: traits?.defaultsToSkeletonObservation,
      outputSchema,
      args,
      sessionUuid,
      baselineStore,
      actionsCompactMetadata: getToolSelectionContext()?.actionsCompactMetadata,
      internal: internalCall,
      artifactWriter,
      artifactMode,
      // A call the client cancelled or timed out has its response discarded by the
      // transport, so it must not advance the diff baseline or metadata snapshot
      // (#10081). A daemon-side abort (device loss, session release) does not
      // discard a completed success, which is still returned to the client, so only
      // a failure is treated as undelivered when the combined signal aborted.
      delivered: !isClientCancelled(signal) && (toolSuccess || !signal?.aborted),
    });

    recordCompletedToolCall(input, { durationMs, toolSuccess, toolError });

    return {
      durationMs,
      finalizedResponse,
    };
  }
}

function logToolResponse(
  unwrapped: ReturnType<typeof unwrapToolResponse>,
  name: string,
  signal?: AbortSignal,
) {
  const toolSuccess =
    unwrapped && typeof unwrapped === "object" && "success" in unwrapped
      ? unwrapped.success !== false
      : true;
  const toolError = toolResponseError(unwrapped);
  if (unwrapped && typeof unwrapped === "object" && "success" in unwrapped) {
    const resultLog = formatToolResultLog({
      toolName: name,
      success: unwrapped.success !== false,
      error: toolError ?? unwrapped.error,
      callerTimedOut: signal?.aborted ?? false,
    });
    logger[resultLog.level](resultLog.message);
  }

  return { toolSuccess, toolError };
}

function updateScrollPosition(input: AfterToolCallInput): void {
  const { name, args, response, sessionUuid } = input;
  if (name === "swipeOn" && args.lookFor) {
    const swipeEnvelope = narrowInternalToolEnvelope("swipeOn", response);
    if (
      getStructuredField(swipeEnvelope, "success") &&
      getStructuredField(swipeEnvelope, "found")
    ) {
      const scrollPosition = UIStateExtractor.createScrollPosition(args);
      if (scrollPosition) {
        const scrollNavManager = sessionUuid
          ? NavigationGraphManager.getInstanceForSession(sessionUuid)
          : NavigationGraphManager.getInstance();
        scrollNavManager.updateScrollPosition(scrollPosition);
      }
    }
  }
}

function cacheObservedHierarchy(input: AfterToolCallInput) {
  const { name, args, response, sessionUuid, shouldResolveDevice } = input;
  const sessionManager = defaultDaemonContext.sessionManager();
  if (
    shouldResolveDevice &&
    sessionUuid &&
    !(name === "observe" && args.display === "all") &&
    sessionManager
  ) {
    const observedHierarchy = getObservedHierarchy(name, response);
    if (observedHierarchy) {
      sessionManager.setLastHierarchy(sessionUuid, observedHierarchy);
    }
    // NOTE: there is deliberately no `screenshot` read here. Production
    // `observe` never emitted a `screenshot` payload field and the session
    // `lastScreenshot` slot had no reader, so the whole cache chain was dead
    // and was removed (issue #3221). If observe ever attaches a screenshot,
    // reintroduce the write together with a real consumer.
  }

  return sessionManager;
}

function observationBaselineStore(
  sessionUuid: string | undefined,
  sessionManager: ReturnType<typeof defaultDaemonContext.sessionManager>,
): ObservationBaselineStore | undefined {
  const baselineStore: ObservationBaselineStore | undefined =
    sessionUuid && sessionManager
      ? {
          get: (uuid) => sessionManager.getLastRenderedObservation(uuid),
          set: (uuid, observation, displayRevision) =>
            sessionManager.setLastRenderedObservation(uuid, observation, displayRevision),
          getActionMetadata: (uuid, deviceId) =>
            sessionManager.getLastActionMetadata(uuid, deviceId),
          setActionMetadata: (uuid, deviceId, blocks) =>
            sessionManager.setLastActionMetadata(uuid, deviceId, blocks),
          setDisplayRevision: (uuid, revision, key, generation) =>
            sessionManager.setLastRenderedDisplayRevision(uuid, revision, key, generation),
        }
      : undefined;
  return baselineStore;
}

function toolResponseError(unwrapped: ReturnType<typeof unwrapToolResponse>) {
  const toolError =
    unwrapped && typeof unwrapped === "object" && "error" in unwrapped
      ? (formatStructuredToolError(unwrapped.error) ?? String(unwrapped.error ?? ""))
      : null;
  return toolError;
}

function recordCompletedToolCall(
  input: AfterToolCallInput,
  result: {
    durationMs: number;
    toolSuccess: boolean;
    toolError: ReturnType<typeof toolResponseError>;
  },
) {
  const { args, name, toolStartMs, traits } = input;
  const { durationMs, toolSuccess, toolError } = result;
  const telemetryArgs: Record<string, unknown> = { ...args };
  deleteInternalToolParams(telemetryArgs);
  TelemetryRecorder.getInstance().recordToolCallEvent({
    timestamp: toolStartMs,
    toolName: name,
    durationMs,
    success: toolSuccess,
    error: toolError,
    // Telemetry leaves the process (IDE socket): credentials never ride along.
    args: typeof args === "object" ? redactToolSecrets(name, telemetryArgs) : null,
  });

  if (toolSuccess) {
    getToolCallRecorder({ connectionId: args[INTERNAL_MCP_SESSION_PARAM] })?.record(
      name,
      args,
      traits,
      getToolSelectionContext()?.toolCallRecording,
    );
  }
}
