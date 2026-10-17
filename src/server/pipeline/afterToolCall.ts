import { classifyToolResult } from "../../utils/toolEnvelopePayload";
import { BootedDevice, type ViewHierarchyResult } from "../../models";
import { NavigationGraphManager } from "../../features/navigation/NavigationGraphManager";
import { UIStateExtractor } from "../../features/navigation/UIStateExtractor";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import { RealSettleObserve } from "../../features/observe/SettleObserve";
import type { SettleObserve } from "../../features/observe/interfaces/SettleObserve";
import { settleEmbeddedObservationInResponse } from "../embeddedObservationSettle";
import { serverConfig } from "../../utils/ServerConfig";
import { TelemetryRecorder } from "../../features/telemetry/TelemetryRecorder";
import { logger } from "../../utils/logger";
import { DaemonState } from "../../daemon/daemonState";
import { type Timer } from "../../utils/SystemTimer";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { INTERNAL_MCP_SESSION_PARAM } from "../../daemon/constants";
import { getToolCallRecorder } from "../toolCallRecordingManager";
import { formatToolResultLog } from "../toolResultLog";
import { formatStructuredToolError } from "../../utils/formatStructuredToolError";
import {
  finalizeToolResponse,
  type ObservationArtifactWriter,
  type ObservationBaselineStore,
} from "../finalizeToolResponse";
import { getStructuredField } from "../../utils/toolUtils";
import { readToolEnvelopePayload } from "../toolEnvelopePayload";
import { isMarkedToolFailure } from "../../utils/toolFailureSignal";
import { narrowInternalToolEnvelope } from "../internalToolPayloads";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactRetention,
} from "../toolOutputArtifactWriter";
import { getDefaultToolOutputsDir } from "../../utils/toolOutputArtifacts";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import { isClientCancelled } from "../../utils/AbortContext";
import { deleteInternalToolParams } from "../../daemon/constants";
import type { ToolTraits } from "../toolRegistry";
import { isRecord } from "./isRecord";

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

export interface AfterToolCallHandler {
  handle(input: AfterToolCallInput): Promise<AfterToolCallResult>;
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

function isViewHierarchyResult(value: unknown): value is ViewHierarchyResult {
  return isRecord(value) && isRecord(value.hierarchy);
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

  const observation = name === "observe" ? payload : payload.observation;
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

export class DefaultAfterToolCallHandler implements AfterToolCallHandler {
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
      shouldResolveDevice,
      signal,
      timer,
      toolStartMs,
    } = input;

    // Unwrap the payload for result logging and finalization metadata.
    // Pipeline failure classification uses explicit status and the out-of-band mark.
    const unwrapped = unwrapToolResponse(response, name);

    const toolSuccess =
      unwrapped && typeof unwrapped === "object" && "success" in unwrapped
        ? unwrapped.success !== false
        : true;
    const toolError =
      unwrapped && typeof unwrapped === "object" && "error" in unwrapped
        ? (formatStructuredToolError(unwrapped.error) ?? String(unwrapped.error ?? ""))
        : null;
    if (unwrapped && typeof unwrapped === "object" && "success" in unwrapped) {
      const resultLog = formatToolResultLog({
        toolName: name,
        success: unwrapped.success !== false,
        error: toolError ?? unwrapped.error,
        callerTimedOut: signal?.aborted ?? false,
      });
      logger[resultLog.level](resultLog.message);
    }

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

    if (
      shouldResolveDevice &&
      sessionUuid &&
      !(name === "observe" && args.display === "all") &&
      DaemonState.getInstance().isInitialized()
    ) {
      const sessionManager = DaemonState.getInstance().getSessionManager();
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

    const baselineStore: ObservationBaselineStore | undefined =
      sessionUuid && DaemonState.getInstance().isInitialized()
        ? {
            get: (uuid) =>
              DaemonState.getInstance().getSessionManager().getLastRenderedObservation(uuid),
            set: (uuid, observation, displayRevision) =>
              DaemonState.getInstance()
                .getSessionManager()
                .setLastRenderedObservation(uuid, observation, displayRevision),
            getActionMetadata: (uuid, deviceId) =>
              DaemonState.getInstance().getSessionManager().getLastActionMetadata(uuid, deviceId),
            setActionMetadata: (uuid, deviceId, blocks) =>
              DaemonState.getInstance()
                .getSessionManager()
                .setLastActionMetadata(uuid, deviceId, blocks),
            setDisplayRevision: (uuid, revision, key, generation) =>
              DaemonState.getInstance()
                .getSessionManager()
                .setLastRenderedDisplayRevision(uuid, revision, key, generation),
          }
        : undefined;
    const configuredArtifactDirectory = serverConfig.getToolOutputsDir();
    const artifactMode = configuredArtifactDirectory ? "always" : "oversized";
    const artifactDirectory = configuredArtifactDirectory ?? getDefaultToolOutputsDir();
    const artifactWriter = !internalCall
      ? this.getArtifactWriter(artifactDirectory, timer)
      : undefined;

    const finalizedResponse = finalizeToolResponse(response, {
      name,
      loudArtifactWrites: traits?.loudArtifactWrites,
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

    const telemetryArgs = { ...args };
    deleteInternalToolParams(telemetryArgs);
    TelemetryRecorder.getInstance().recordToolCallEvent({
      timestamp: toolStartMs,
      toolName: name,
      durationMs,
      success: toolSuccess,
      error: toolError,
      args: typeof args === "object" ? telemetryArgs : null,
    });

    if (toolSuccess) {
      getToolCallRecorder({ connectionId: args[INTERNAL_MCP_SESSION_PARAM] })?.record(name, args);
    }

    return {
      durationMs,
      finalizedResponse,
    };
  }
}
