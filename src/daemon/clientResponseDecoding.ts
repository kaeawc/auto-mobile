import { z } from "zod";
import { ActionableError } from "../models";
import { type BuildIdentity } from "./wire/buildIdentity";
import { type DaemonMethodCallOptions } from "./client";
import { DaemonBoundSessionLostError } from "./DaemonBoundSessionLostError";
import { isDaemonHandshakeFailure } from "./wire/daemonHandshake";
import { DaemonHandshakeMismatchError } from "./DaemonHandshakeMismatchError";
import { isDaemonShuttingDownFailure } from "./daemonShutdownOutcome";
import { DaemonShuttingDownError } from "./DaemonShuttingDownError";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "./deviceControlTransportFailure";
import type { LivenessOwnerHold } from "./livenessOwnerLease";
import { McpOverloadError, sanitizeMcpOverloadFailure } from "./wire/McpTimeoutError";
import {
  type TaskRelayFrame,
  type TaskRelayMethod,
  isRelayedJsonRpcError,
} from "./tasks/taskRelay";
import type { DaemonOptions, DaemonStatus } from "./types";
import {
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  daemonInstanceFromError,
  DaemonNotification,
  DaemonRequest,
  DaemonResponse,
  releasedSessionNotFoundFields,
  sanitizeBoundSessionLoss,
  sanitizeDaemonRequestFailureCause,
} from "./types";

export const daemonOptionsSchema = z.object({
  port: z.number().finite().optional(),
  host: z.string().optional(),
  strictPort: z.boolean().optional(),
  debug: z.boolean().optional(),
  debugPerf: z.boolean().optional(),
  planExecutionLockScope: z.enum(["session", "global"]).optional(),
  runnerReadinessTimeoutMs: z.number().finite().optional(),
  videoQualityPreset: z.string().optional(),
  videoTargetBitrateKbps: z.number().finite().optional(),
  videoMaxThroughputMbps: z.number().finite().optional(),
  videoFps: z.number().finite().optional(),
  videoFormat: z.string().optional(),
  videoMaxArchiveSizeMb: z.number().finite().optional(),
  toolOutputsDir: z.string().optional(),
  networkMockable: z.boolean().optional(),
  embeddedSdk: z.boolean().optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  dismissKeyboardAfterInput: z.boolean().optional(),
  eventAllMarkers: z.array(z.string()).optional(),
  eventAllMarkersCliOverride: z.boolean().optional(),
  noUiPerfMode: z.boolean().optional(),
  memPerfAudit: z.boolean().optional(),
  accessibilityAudit: z.boolean().optional(),
  accessibilityLevel: z.string().optional(),
  accessibilityFailureMode: z.string().optional(),
  accessibilityMinSeverity: z.string().optional(),
  accessibilityUseBaseline: z.boolean().optional(),
  predictiveUi: z.boolean().optional(),
  rawElementSearch: z.boolean().optional(),
  skipCtrlProxyDownload: z.boolean().optional(),
  toolCallRecording: z.boolean().optional(),
  noNavigationScreenshots: z.boolean().optional(),
  noWaitForPollingOverhead: z.boolean().optional(),
  noA11yIncludeNotImportantViews: z.boolean().optional(),
  noA11yReportViewIds: z.boolean().optional(),
  noA11yRetrieveInteractiveWindows: z.boolean().optional(),
  noOcclusion: z.boolean().optional(),
  observeResultIncludeElements: z.boolean().optional(),
  toolResultsNoStructuredContent: z.boolean().optional(),
  actionsDiffObserve: z.boolean().optional(),
  actionsNoObserve: z.boolean().optional(),
  actionsCompactMetadata: z.boolean().optional(),
}) satisfies z.ZodType<DaemonOptions>;

// Fails at compile time when DaemonOptions gains a field that ide/status would
// otherwise silently strip before startup-option reconciliation can inspect it.
export type DaemonOptionsSchemaCoversAllKeys =
  Exclude<keyof DaemonOptions, keyof typeof daemonOptionsSchema.shape> extends never ? true : never;

export const daemonOptionsSchemaCoversAllKeys: DaemonOptionsSchemaCoversAllKeys = true;

/** Bound on remembered cancelled request ids (issue #6384); oldest are evicted first. */
export const MAX_CANCELLED_REQUEST_IDS = 256;

/**
 * Let the daemon's deadline timer reject queue/forward work, unwind its promise
 * chain, and flush the terminal frame before our cancellation backstop. Two
 * seconds allow that deadline-handling latency plus the local socket round trip
 * (including request delivery before the daemon starts its budget). This is
 * headroom, not a hard latency guarantee under an event-loop stall. The proxy
 * wrappers add no fixed request timeout. Do not cap this at the socket idle
 * limit: a silent request above that limit already risks transport closure.
 */
export const DAEMON_RESPONSE_GRACE_MS = 2_000;

export const socketIdentityStatusSchema = z.object({
  unavailableSockets: z
    .array(
      z.object({
        code: z.literal("AUXILIARY_SOCKET_UNAVAILABLE"),
        holderPid: z.number().int().positive().optional(),
        holderVersion: z.string().optional(),
        holderVerified: z.boolean().optional(),
        name: z.string(),
        socketPath: z.string().min(1),
      }),
    )
    .optional(),
  reportedPidFilePath: z.string().min(1).optional(),
  reportedSocketPath: z.string().min(1).optional(),
  reportedSockets: z.record(z.string(), z.string().min(1)).optional(),
  launchNonce: z.string().optional(),
  processStartedAt: z.number().finite().optional(),
  dbPath: z.string().min(1).optional(),
  pid: z.number().int().positive().optional(),
  version: z.string().trim().min(1),
  buildId: z.string().optional(),
  entryScript: z.string().optional(),
  releaseVersion: z.string().optional(),
  startedAt: z.number().finite().optional(),
  processGenerationToken: z.string().optional(),
  processGenerationTokenUtc: z.string().optional(),
  activeProvisioning: z.boolean().optional(),
  structuredSessionNotFound: z.boolean().optional(),
  structuredToolErrorCodes: z.boolean().optional(),
  acceptanceCapabilityFingerprint: z.string().nullable().optional(),
});

export const socketOptionsStatusSchema = z.object({
  options: daemonOptionsSchema.optional(),
  effectiveDebug: z.boolean().optional(),
});

export function daemonLifecycleResponseError(response: DaemonResponse): Error | undefined {
  if (isDaemonHandshakeFailure(response.handshakeFailure)) {
    return new DaemonHandshakeMismatchError(
      response.handshakeFailure,
      response.error || "Daemon identity mismatch",
    );
  }
  if (isDaemonShuttingDownFailure(response.daemonShuttingDown)) {
    return new DaemonShuttingDownError(
      response.daemonShuttingDown.requestMayHaveDispatched === true,
    );
  }
  const overloadFailure = sanitizeMcpOverloadFailure(response.overloadFailure);
  if (overloadFailure) {
    return new McpOverloadError(
      response.error || "Daemon rejected overloaded MCP work",
      overloadFailure,
    );
  }
  return undefined;
}

export function daemonSessionResponseError(response: DaemonResponse): Error | undefined {
  const boundSessionLoss = sanitizeBoundSessionLoss(response.boundSessionLoss);
  if (boundSessionLoss) {
    return new DaemonBoundSessionLostError(boundSessionLoss);
  }
  const transportFailure = sanitizeDeviceControlTransportFailure(response.transportFailure);
  if (transportFailure) {
    return new DeviceControlTransportError(
      response.error || "Device-control transport failure",
      transportFailure,
    );
  }
  return undefined;
}

export function daemonFallbackResponseError(response: DaemonResponse): Error {
  const requestFailureCause = sanitizeDaemonRequestFailureCause(response.requestFailureCause);
  const cause = requestFailureCause ? new Error(requestFailureCause.message) : undefined;
  if (cause && requestFailureCause) {
    cause.name = requestFailureCause.name;
  }
  return new ActionableError(response.error || "Unknown error from daemon", { cause });
}

export const livenessOwnerHoldSchema = z.object({
  state: z.enum(["live", "suspect", "lapsed"]),
  remainingMs: z.number().finite().nonnegative(),
  holdRemainingMs: z.number().finite().nonnegative(),
});

/**
 * The owner's hold a `liveness_owner_conflict` refusal reports (#10701), when well-formed. A
 * challenger waits it out instead of guessing the daemon's lease from its own configuration.
 */
export function livenessOwnerHoldFromResponse(
  response: DaemonResponse,
): LivenessOwnerHold | undefined {
  const parsed = livenessOwnerHoldSchema.safeParse(response.result?.liveness);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The daemon's `releaseReason` on a session-not-found answer (#10730), as an error field, with its
 * `idle: true` for an idle-window release (#10832, #10972).
 */
export function releaseReasonField(response: DaemonResponse): {
  releaseReason?: string;
  idle?: true;
} {
  if (typeof response.releaseReason !== "string" || response.releaseReason.length === 0) {
    return {};
  }
  // Daemon and proxy versions always match, so the shared reason table reproduces daemon idle.
  return releasedSessionNotFoundFields(response.releaseReason);
}

/** A typed refusal's retry intent from a failed response (#11244), as error fields. */
export function typedRefusalResponseFields(
  response: DaemonResponse,
): Pick<DaemonResponse, "retryable" | "retryAfterMs" | "nextAction" | "details"> {
  return {
    ...(typeof response.retryable === "boolean" ? { retryable: response.retryable } : {}),
    ...(typeof response.retryAfterMs === "number" ? { retryAfterMs: response.retryAfterMs } : {}),
    ...(typeof response.nextAction === "string" ? { nextAction: response.nextAction } : {}),
    ...(response.details && typeof response.details === "object"
      ? { details: response.details }
      : {}),
  };
}

/** A request frame's Tasks relay (#4668): present only when the proxy relays the extension. */
export function taskRelayField(tasks: TaskRelayFrame | undefined): Pick<DaemonRequest, "tasks"> {
  return tasks === undefined ? {} : { tasks };
}

/** A relayed `tasks/*` request's JSON-RPC error (#4668), when the frame carried a well-formed one. */
export function relayedJsonRpcErrorField(
  response: DaemonResponse,
): Pick<DaemonResponse, "jsonRpcError"> {
  return isRelayedJsonRpcError(response.jsonRpcError)
    ? { jsonRpcError: response.jsonRpcError }
    : {};
}

/** The error a failed daemon response rejects with, carrying its structured code and details. */
export function daemonResponseError(response: DaemonResponse): Error {
  const error =
    daemonLifecycleResponseError(response) ??
    daemonSessionResponseError(response) ??
    daemonFallbackResponseError(response);
  // Preserve both top-level codes and the existing typed failure envelopes.
  const code = [
    response.code,
    response.handshakeFailure?.code,
    response.daemonShuttingDown?.code,
    response.overloadFailure?.code,
    response.boundSessionLoss?.code,
    response.transportFailure?.code,
  ].find((value) => value !== undefined);
  const daemonInstance = daemonInstanceFromError(response);
  if (daemonInstance !== undefined) {
    Object.assign(error, { daemonInstance });
  }
  if (code === undefined) {
    return error;
  }
  const livenessOwnerHold =
    code === DAEMON_LIVENESS_OWNER_CONFLICT_CODE
      ? livenessOwnerHoldFromResponse(response)
      : undefined;
  return Object.assign(error, {
    code,
    ...relayedJsonRpcErrorField(response),
    ...typedRefusalResponseFields(response),
    ...(livenessOwnerHold ? { livenessOwnerHold } : {}),
    ...releaseReasonField(response),
  });
}

export function toDaemonStatus(rawStatus: unknown, socketPath: string): DaemonStatus {
  const identityStatus = socketIdentityStatusSchema.safeParse(rawStatus);
  if (!identityStatus.success) {
    throw new ActionableError(
      "Daemon preflight failed: the socket owner returned no version identity; no device operation started. Restart the daemon from this client installation.",
    );
  }
  const optionsStatus = socketOptionsStatusSchema.safeParse(rawStatus);
  if (!optionsStatus.success) {
    throw new ActionableError(
      "Daemon preflight failed: the socket owner returned a valid identity but malformed startup options; no device operation started. Restart the daemon from this client installation.",
    );
  }
  const { releaseVersion, ...identity } = identityStatus.data;
  return {
    running: true,
    ...identity,
    socketPath,
    ...(optionsStatus.data.options ? { options: optionsStatus.data.options } : {}),
    ...(optionsStatus.data.effectiveDebug !== undefined
      ? { effectiveDebug: optionsStatus.data.effectiveDebug }
      : {}),
    ...(releaseVersion ? { assetVersion: releaseVersion } : {}),
  };
}

/** Per-call options of {@link DaemonClientLike.callTool}. */
export interface DaemonToolCallOptions {
  /** The MCP Tasks extension relay for this call (#4668); absent when the client did not declare it. */
  readonly tasks?: TaskRelayFrame;
}

export interface DaemonClientLike {
  connect(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  callTool(
    toolName: string,
    params: Record<string, any>,
    progressToken?: string | number,
    onRequestId?: (requestId: string) => void,
    signal?: AbortSignal,
    options?: DaemonToolCallOptions,
  ): Promise<any>;
  /**
   * Relay an MCP Tasks extension request to the daemon (#4668). Optional: a client without it
   * cannot reach the daemon's tasks, and the proxy answers those requests with an error.
   */
  relayTaskMethod?(
    method: TaskRelayMethod,
    params: Record<string, unknown>,
    tasks: TaskRelayFrame,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  readResource(
    uri: string,
    params?: Record<string, any>,
    options?: { signal?: AbortSignal },
  ): Promise<any>;
  callDaemonMethod(
    method: string,
    params: Record<string, any>,
    options?: DaemonMethodCallOptions,
  ): Promise<any>;
  /**
   * Optional daemon-push capability (issue #3223). Clients that cannot surface
   * server-pushed frames omit both members and the proxy skips notification
   * wiring entirely — so a client must implement both or neither.
   */
  onNotification?(handler: (notification: DaemonNotification) => void): () => void;
  subscribeToNotifications?(options?: { signal?: AbortSignal }): Promise<void>;
  onConnectionClosed?(handler: () => void): () => void;
}

export interface DaemonClientFactoryOptions {
  /**
   * `null` bypasses the normal compatibility handshake for daemon-owned
   * lifecycle RPCs that authenticate the target generation themselves.
   */
  clientIdentity?: { version: string; build: BuildIdentity } | null;
}

export type DaemonClientFactory = (options?: DaemonClientFactoryOptions) => DaemonClientLike;
