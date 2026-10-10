import { shapeToolCallError } from "../server/shapeToolCallError";
import type { SessionRecoveryAssignmentDetails } from "../models/SessionRecoveryAssignmentError";
import { readToolEnvelopePayload } from "../server/toolEnvelopePayload";
import {
  isDeviceControlTargetOwnerValid,
  isDeviceControlRoutingSessionValid,
} from "./deviceControlSessionValidity";
import { runWithToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { runWithAbortSignal } from "../utils/AbortContext";
import { createServer, Server as NetServer, Socket } from "node:net";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ensureSecureDir, secureFile } from "../utils/filesystem/securePermissions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPReconnectionOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dropMcpRecording } from "../server/mcpRecordingManager";
import { isToolUnavailableWireError } from "../server/toolUnavailableError";
import { logger } from "../utils/logger";
import type { RefusedOwnedSessionRestore } from "./devicePool";
import { GestureOwnershipRegistry } from "./gestureOwnership";
import { resolveMcpRequestTimeoutMs, ProgressExtendableDeadline } from "./mcpRequestTimeout";
import { McpOverloadError, McpTimeoutError, MCP_QUEUE_TIMEOUT_ERROR_CODE } from "./McpTimeoutError";
import { DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { isDebugModeEnabled } from "../utils/debug";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  BOUND_SESSION_LOSS_CODE,
  DaemonNotification,
  DaemonRequest,
  DaemonResponse,
  PROGRESS_NOTIFICATION_METHOD,
  RESOURCE_SUBSCRIBE_METHOD,
  RESOURCE_UNSUBSCRIBE_METHOD,
  SessionContext,
  type BoundSessionLoss,
  boundSessionLossMessage,
  type DaemonRequestFailureCause,
  type DaemonOptions,
} from "./types";
import {
  SOCKET_PATH,
  DAEMON_HANDSHAKE_ENABLED,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_RELEASED_SESSION_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  DAEMON_ONE_SHOT_CLI_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  DAEMON_VERSION,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
  DAEMON_RPC_SOCKET_PEER_END_FLUSH_GRACE_MS,
} from "./constants";
import {
  isHostInventoryCall,
  resolveSocketAdmissionLane,
  SocketRequestAdmissionQueue,
} from "./socketRequestAdmission";
import {
  daemonShuttingDownFailure,
  daemonShuttingDownFailureFromToolResult,
  isDaemonShuttingDownToolResult,
} from "./daemonShutdownOutcome";
import {
  registerLiveDeadline,
  unregisterLiveDeadline,
  getLiveTextRequestState,
} from "./liveDeadlineRegistry";
import {
  DaemonSocketReachability,
  type DaemonSocketReachabilityLike,
} from "./daemonSocketReachability";
import { isProcessRunning, readPidFileDataSync } from "./daemonFiles";
import { tryAcquireExclusiveLock, releaseExclusiveLock } from "../utils/fileLock";
import {
  ListChangedBroadcaster,
  ResourceUpdatedBroadcaster,
  RESOURCE_UPDATED_NOTIFICATION_METHOD,
  type ResourceUpdateTargets,
  LIST_CHANGED_NOTIFICATION_METHODS,
  type ListChangedKind,
} from "../server/listChangedBroadcast";
import {
  SessionReleaseBroadcaster,
  SESSION_RELEASED_NOTIFICATION_METHOD,
} from "../server/sessionReleaseBroadcast";
import {
  toolSelectionProfileUuidFromResponse,
  IDE_SET_SESSION_TOOL_ENABLED_METHOD,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../features/toolSelection/toolSelectionControl";
import {
  evaluateClientHandshake,
  extractClientHandshake,
  type DaemonSelfIdentity,
} from "./daemonHandshake";
import { InputText, type AppendKeyEventValidator } from "../features/action/InputText";
import { imeActionFailedAfterTextEntered } from "../features/action/imeActionFailedAfterTextEntered";
import { getCurrentBuildIdentity } from "./buildIdentity";
import { DaemonState } from "./daemonState";
import { isDeviceInventoryTool } from "./daemonMcpProxy";
import { DaemonStateAccess, handleDaemonRequest } from "./daemonRequestHandlers";
import { deviceIncarnationToken } from "../utils/deviceIncarnation";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES, OutboundWriteGuard } from "./outboundWriteGuard";
import { type IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import type { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import type { FeatureFlagKey } from "../features/featureFlags/FeatureFlagDefinitions";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "../features/toolSelection/SessionToolSelectionService";
import { assertToolEnabledForAnySession } from "../features/toolSelection/toolSelectionPolicy";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import {
  assertInputRequesterHoldsDevice,
  deviceAlreadyAssignedToAnotherSessionError,
  InputDeviceOwnedError,
  parseInputRequesterSessionUuid,
} from "./inputDeviceOwnership";
import { ToolRegistry } from "../server/toolRegistry";
import { provisionCancellationOutcomes } from "../server/provisionCancellationOutcomes";
import { PROVISION_DEVICE_SETTLEMENT_WAIT_MS } from "../server/deviceTools";

/** Slack after the handler's settlement wait for it to finish rollback and build its result. */
const PROVISION_CANCELLATION_OUTCOME_GRACE_MS = 2_000;
import { preferenceSetWarning, validateTypeForPlatform } from "../server/storageTools";
import {
  clearAndroidKeyValueFileDirect,
  directFileFallbackRelaunchWarning,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
  withAndroidSharedPreferencesInspectionFallback,
} from "../features/storage/AndroidSharedPreferencesKeyValueFile";
import { rethrowForRouteWithoutUserId } from "../features/preferences/resolveAndroidPreferencesUser";
import {
  IOS_CTRL_PROXY_APP_HASH,
  resolveApkChecksum,
  resolveApkUrl,
  resolveAssetVersion,
  resolveIpaChecksum,
  resolveIpaUrl,
  resolvePinnedVersion,
} from "../constants/release";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { BootedDeviceDiscoveryIncompleteError } from "../devices/deviceBootService";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { PressButton } from "../features/action/PressButton";
import {
  INPUT_KEY_IOS_UNSUPPORTED_ERROR,
  InputKey,
  SUPPORTED_INPUT_KEYS,
  isInputKeyName,
  type InputKeyName,
} from "../features/action/InputKey";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { canonicalPixelsToPoints } from "./canonicalPixels";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { indeterminateTapError } from "../features/action/coordinateTapDispatch";
import { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { KeyValueType, PreferenceStoreResolution } from "../features/storage/storageTypes";
import type {
  AppendTextFailureSource,
  BootedDevice,
  ImeAction,
  ScreenScaleMetadata,
} from "../models";
import type { DeviceService } from "../features/observe/DeviceService";
import { executionTracker } from "../server/executionTracker";
import {
  DAEMON_COMPLETE_MAINTENANCE_METHOD,
  DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
  DAEMON_REPUBLISH_IDENTITY_METHOD,
  DAEMON_PREPARE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_RESTART_METHOD,
  DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
  type AcceptanceSessionRestartScope,
  type DaemonAcceptanceRestartCommit,
  type DaemonAcceptanceRestartRelease,
  type DaemonAcceptanceSessionRestart,
  type DaemonAdmittedRestart,
  type DaemonMaintenancePreparation,
  type DaemonRestartPreparation,
} from "./daemonRestartAdmission";
import {
  daemonLiveAcceptanceScopedCapabilityMatches,
  type DaemonGenerationIdentity,
} from "./liveAcceptanceCapability";
import { daemonGenerationMatches } from "./processGeneration";
import {
  processGenerationRecordFields,
  recordedProcessGenerationToken,
} from "./processGenerationFields";
import { CONTROL_SOCKET_MAX_FRAME_BYTES, LineFramer } from "./socketServer/LineFramer";
import {
  createDeviceSessionErrorResolver,
  DeviceSessionSupersededByRestoreError,
} from "./deviceSessionResolver";
import {
  DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
  DeviceControlTransportError,
  deviceControlToolName,
  isDeviceControlTransportRequest,
  isReplaySafeAfterResponseClosure,
  isLoopbackTransportFailure,
  loopbackMcpFetch,
  type DeviceControlTransportFailure,
  type DeviceControlTransportPhase,
} from "./deviceControlTransportFailure";

export const MCP_FORWARD_START_HEADROOM_MS = 100;
/**
 * How many times one forward may follow its route to a different execution key before it
 * fails. Each hop releases the previous key first, so this only bounds route churn; it is
 * not what prevents the crossed-route deadlock (issue #6388).
 */
export const MAX_MCP_FORWARD_REROUTES = 3;
const MCP_OVERLOAD_RETRY_AFTER_MS = 250;
const STARTUP_PROBE_METHODS = new Set(["ide/status", "ide/ping"]);

function socketRequestId(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function isDaemonSocketRequest(parsed: unknown): parsed is DaemonRequest {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const request = parsed as Record<string, unknown>;
  return (
    typeof request.id === "string" &&
    typeof request.method === "string" &&
    (request.type === "mcp_request" || request.type === "daemon_request")
  );
}

function requestFailureCause(
  error: unknown,
  requestSignal?: AbortSignal,
): DaemonRequestFailureCause | undefined {
  const cause = requestSignal?.aborted
    ? requestSignal.reason
    : error instanceof McpTimeoutError
      ? error
      : undefined;
  if (cause === undefined) {
    return undefined;
  }
  return {
    name: cause instanceof Error ? cause.name : "Error",
    message: errorMessage(cause),
  };
}

class ClientRequestCancellation extends ActionableError {}

const EXPECTED_PEER_CLOSE_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ECONNABORTED",
]);
function isExpectedPeerClose(error: Error): boolean {
  return (
    "code" in error && typeof error.code === "string" && EXPECTED_PEER_CLOSE_CODES.has(error.code)
  );
}
function isClientForwardCancellation(
  signal: AbortSignal | undefined,
  cause: DaemonRequestFailureCause | undefined,
): boolean {
  return (
    signal?.aborted === true &&
    (cause?.message === "Daemon MCP client disconnected" ||
      signal.reason instanceof ClientRequestCancellation)
  );
}

function logRequestFailureCause(cause: DaemonRequestFailureCause | undefined): void {
  if (cause) {
    logger.error(`Original MCP request failure cause: ${cause.name}: ${cause.message}`);
  }
}

const JSONRPC_INVALID_PARAMS = -32602;

export function mcpRequestFailureDetails(
  error: unknown,
  cause: DaemonRequestFailureCause | undefined,
): Pick<DaemonResponse, "code" | "overloadFailure" | "requestFailureCause"> {
  return {
    ...(error instanceof McpOverloadError ? { overloadFailure: error.failure } : {}),
    ...(error instanceof McpTimeoutError && error.code ? { code: error.code } : {}),
    // Keep the daemon MCP server's invalid-params verdict (e.g. a malformed
    // resource URI) so the proxy can return -32602 instead of -32603.
    ...(error instanceof McpError && "code" in error && error.code === JSONRPC_INVALID_PARAMS
      ? { code: JSONRPC_INVALID_PARAMS }
      : {}),
    ...(isToolUnavailableWireError(error) ? { code: DAEMON_TOOL_UNAVAILABLE_CODE } : {}),
    ...(error instanceof InputDeviceOwnedError ? { code: error.code } : {}),
    ...(cause ? { requestFailureCause: cause } : {}),
  };
}

function resolveIdentityStartedAt(value: number | undefined, timer: Timer): number {
  return value === undefined ? timer.now() : value;
}

function snapshotDaemonOptions(options: DaemonOptions | undefined): DaemonOptions {
  return structuredClone(options ?? {});
}

const MCP_CLIENT_IDLE_CLOSE_MS = 5 * 60 * 1000;
const MCP_SESSION_TERMINATION_TIMEOUT_MS = 2_000;
const DEVICE_ACQUISITION_TOOL_NAMES = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
]);
/**
 * Maintenance spans separate control RPCs (and, for restart-admitted, separate
 * client processes), so it cannot be tied to one socket. Bound the global
 * execution fence instead: the default live-acceptance platform budget is just
 * under nine minutes, leaving a one-minute margin for valid fault/repair work.
 */
export const DAEMON_MAINTENANCE_ADMISSION_TTL_MS = 10 * 60 * 1000;
/**
 * Acceptance crash admission only spans generation revalidation and SIGKILL.
 * Keep enough margin for a loaded process-table scan while bounding an
 * abandoned process-global tool fence.
 */
export const DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS = 15_000;
/** Keep shutdown bounded if a request handler ignores its disconnected peer. */
const DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS = 1_000;
/** Keep shutdown bounded if a client cannot flush a release notification. */
const DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS = 1_000;
export class DaemonSocketQueueOverflowError extends Error {
  readonly reason = "queue_overflow";

  constructor(
    readonly queuedBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Daemon RPC socket queued bytes exceeded ${limitBytes}`);
    this.name = "DaemonSocketQueueOverflowError";
  }
}

/**
 * The loopback MCP HTTP server answers an unknown `mcp-session-id` with 404
 * before the request reaches any handler, so the forward provably never ran and
 * a replay on a fresh client cannot repeat a device action. Match the SDK's
 * structured status code rather than the shared "Session not found" wording,
 * which other lifecycles also use (issue #6383).
 */
function isExpiredLoopbackMcpSession(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

class ReleasedBoundSessionError extends Error {
  constructor(readonly failure: BoundSessionLoss) {
    super(boundSessionLossMessage(failure));
    this.name = "ReleasedBoundSessionError";
  }
}

/**
 * Bound on the observation-only liveness probe a LOCK-LESS bind runs against an
 * existing socket before it would unlink it (issue #6232). Kept short — it only
 * needs to answer "is a daemon accepting right now?" — and matches the sibling
 * probe timeouts in {@link DaemonManager}.
 */
const SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS = 1_000;

/**
 * Seams governing whether a socket bind may reclaim an EXISTING socket file
 * (issue #6232).
 *
 * Every launch path must prove an existing socket is stale before unlinking it.
 * A startup lock coordinates cooperating managers, but does not prove that a
 * direct daemon does not still own the socket.
 */
export interface SocketBindGuardOptions {
  /**
   * Observation-only reachability probe used by every bind. Injected so a
   * test can drive the live/stale outcome deterministically without a real
   * socket; defaults to the real {@link DaemonSocketReachability}.
   */
  reachability?: DaemonSocketReachabilityLike;
  /**
   * Observation-only owner-liveness check used by every bind to
   * disambiguate a NOT-reachable probe (issue #6232). A probe that fails to
   * connect is NOT proof the socket is dead — a live daemon can transiently
   * refuse or time out under an accept backlog or mid-startup (see
   * {@link DaemonManager.status}). Consulting whether a live process is still
   * recorded as the socket's owner lets the guard fail CLOSED on that
   * inconclusive case instead of unlinking a live daemon's socket. Injected so a
   * test can drive the outcome deterministically without a real PID file;
   * defaults to reading the daemon PID record.
   */
  ownerLiveness?: SocketOwnerLiveness;
  /**
   * Cross-process lock held across the whole probe → reclaim → `listen()`
   * sequence so two concurrent binders cannot both reclaim/unlink the same
   * socket path (issue #6232, W5). The reachability probe and owner-liveness
   * checks are observation-only: two lock-less `start()` calls over a
   * genuinely-dead ownerless socket can BOTH pass them, then one binds while
   * the other unlinks the freshly-bound path in the gap before its own
   * `listen()`. Serializing the sequence on a single shared lock closes that
   * TOCTOU: the loser cannot enter the reclaim window until the winner has
   * bound, at which point its probe sees a reachable socket and it refuses.
   * Injected so a test can drive contention deterministically; defaults to the
   * canonical {@link tryAcquireExclusiveLock} primitive keyed on a lock file
   * beside the socket path.
   */
  bindLock?: SocketReclaimLock;
}

/**
 * The cross-process lock guarding the reclaim → bind sequence (issue #6232, W5).
 * A non-blocking single attempt: {@link acquire} returns false when another live
 * process already holds it (a concurrent bind is in flight), and the caller then
 * fails CLOSED rather than racing it. {@link release} drops the lock once the
 * socket is bound (or the bind fails), so the window it covers is only the brief
 * reclaim-and-listen interval, never the daemon's whole lifetime.
 */
export interface SocketReclaimLock {
  acquire(): boolean;
  release(): void;
}

/**
 * Default {@link SocketReclaimLock}: the canonical `O_EXCL` file lock
 * ({@link tryAcquireExclusiveLock}) on `<socketPath>.bind.lock`. Deterministic
 * per socket path so every binder — manager-launched or hand-launched —
 * contends on the same file, and distinct from both the socket itself and the
 * `DaemonManager` startup lock. A per-instance owner token makes release
 * incarnation-aware, and a lock left by a crashed holder is reclaimed on the
 * next attempt via the primitive's dead-PID check.
 */
function defaultSocketReclaimLock(socketPath: string, ownerToken: string): SocketReclaimLock {
  const lockFilePath = `${socketPath}.bind.lock`;
  return {
    acquire: () => tryAcquireExclusiveLock(lockFilePath, { ownerToken }),
    release: () => releaseExclusiveLock(lockFilePath, process.pid, ownerToken),
  };
}

/**
 * Observation-only check for whether a live daemon process (other than this one)
 * is still recorded as the control socket's owner (issue #6232). Reads the PID
 * record only — it never touches the socket file, so it introduces no new
 * destructive actor on the path.
 */
export interface SocketOwnerLiveness {
  getOwnerStatus(): SocketOwnerStatus;
}

export type SocketOwnerStatus = "live" | "dead" | "unknown";

/**
 * Default {@link SocketOwnerLiveness}: only a recorded foreign PID that is
 * positively dead proves the socket reclaimable. Missing or self-overwritten
 * records are unknown, never permission to unlink.
 *
 * IMPORTANT: this default reads the CURRENT on-disk record. A caller that
 * overwrites the shared PID file with its own record BEFORE it reaches the bind
 * guard (as `Daemon.start()` does via its early-owner record) MUST NOT rely on
 * this default — by then the file names the caller, so a live sibling reads back
 * as `pid === process.pid` and this returns `false`, which would authorize
 * unlinking the live socket. Such a caller injects an
 * {@link import("./incumbentOwnerGuard").IncumbentOwnerGuard}-backed liveness that
 * consults an incumbent snapshot captured before the overwrite (issue #6232).
 */
const defaultSocketOwnerLiveness: SocketOwnerLiveness = {
  getOwnerStatus(): SocketOwnerStatus {
    const pidData = readPidFileDataSync();
    if (!pidData || pidData.pid === process.pid) {
      return "unknown";
    }
    return isProcessRunning(pidData.pid, { debugLog: logger.debug }) ? "live" : "dead";
  },
};

/**
 * Resolve {@link SocketBindGuardOptions} to their concrete defaults (issue #6232).
 * Kept out of the constructor so its `??` fallbacks do not add to the
 * constructor's already-at-threshold complexity.
 */
function resolveSocketBindGuard(
  bindGuard: SocketBindGuardOptions,
  socketPath: string,
  bindLockOwnerToken: string,
): {
  reachability: DaemonSocketReachabilityLike;
  ownerLiveness: SocketOwnerLiveness;
  bindLock: SocketReclaimLock;
} {
  return {
    reachability: bindGuard.reachability ?? new DaemonSocketReachability(),
    ownerLiveness: bindGuard.ownerLiveness ?? defaultSocketOwnerLiveness,
    bindLock: bindGuard.bindLock ?? defaultSocketReclaimLock(socketPath, bindLockOwnerToken),
  };
}

/**
 * Unix Socket Server that proxies requests to the HTTP MCP server
 *
 * Responsibilities:
 * - Listen on Unix socket for CLI client connections
 * - Parse incoming DaemonRequest messages
 * - Forward tool calls to local HTTP MCP server
 * - Return DaemonResponse to clients
 * - Manage concurrent client sessions
 *
 * JUnit uses one Unix socket per thread (`DaemonSocketClientManager` ThreadLocal) for parallel
 * tests. Each MCP HTTP client owns one Streamable HTTP session, so concurrent calls on the same
 * client are unsafe. MCP forwards are serialized by target key below, and each key gets its own
 * MCP client so independent devices/sessions can run concurrently.
 *
 * The SDK's Streamable HTTP client may auto-reopen a standalone GET (SSE) after a disconnect.
 * The server transport allows only one such stream per session; a second GET while the first
 * is still mapped returns 409 and tears down the session. We disable that auto-reconnect here;
 * stale sessions are recovered via `getMcpClient()` + the loopback 404 retry.
 */
/** Matches SDK defaults except `maxRetries`, which must stay 0 to avoid duplicate GET SSE. */
const DAEMON_LOOPBACK_STREAMABLE_HTTP_RECONNECTION: StreamableHTTPReconnectionOptions = {
  initialReconnectionDelay: 1000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 0,
};

interface SocketFileIdentity {
  dev: number;
  ino: number;
}

interface PendingSocketRequest {
  id: string;
  sessionId: string;
  socket: Socket;
  admitted: boolean;
  terminal: boolean;
  /** Control frames do not earn an idle exemption; ordinary work has a bounded live deadline. */
  idleDeadline?: ProgressExtendableDeadline;
}

/**
 * Creates the MCP HTTP client the daemon forwards `tools/call` requests through.
 * Injected so tests can substitute a fake without monkeypatching a private method
 * by name (a name-based patch silently no-ops if the internal creator is renamed,
 * leaving forwarding dead but the suite green).
 */
export type McpClientFactory = (
  boundSessionUuid?: string,
  toolSelectionProfileUuid?: string,
  releasedSessionUuid?: string,
) => Promise<Client>;

/**
 * The narrow append-text surface `input/typeText mode:"append"` needs.
 *
 * Exactly one method, deliberately: the daemon never wants the observe round trip
 * or the replace-shaped modes {@link InputText} also exposes, and a narrow seam is
 * what lets a test inject a fake adb instead of shelling out.
 */
export interface AppendTextInput {
  appendText(
    text: string,
    timeoutMs?: number,
    beforeKeyEvent?: AppendKeyEventValidator,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    error?: string;
    charsSent?: number;
    /**
     * Who produced a failure -- see {@link AppendTextFailureSource}. Absent
     * means the helper. The self-heal in
     * {@link UnixSocketServer.executeAndroidAppendText} keys on this rather than
     * on `charsSent === 0`, which cannot tell the two apart.
     */
    failureSource?: AppendTextFailureSource;
  }>;
}

interface CachedAppendTextInput {
  input: AppendTextInput;
  /**
   * Pool connection epoch this helper was built for (see
   * `utils/deviceIncarnation.ts`). `undefined` means no pool could answer, in
   * which case the entry is still reused -- {@link
   * UnixSocketServer.evictDeviceInputCache} and the append self-heal are the
   * safeguards, not a rebuild on every keystroke.
   */
  incarnationToken: string | undefined;
}

interface BoundMcpClient {
  clientKey: string;
  executionKey: string;
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  requiresLiveDaemonSession: boolean;
}

/**
 * Bounds how long a forward may park on another forward's execution-key chain. Without it a
 * waiter is only timed out after it acquires the key, so a stuck holder parks it (and its
 * socket's admission queue) forever (issue #6388).
 */
interface McpForwardChainWait {
  /** Milliseconds this waiter may still spend waiting, read at each acquisition. */
  remainingMs: () => number;
  /** Error to reject with once that budget is spent. */
  timeoutError: (executionKey: string) => Error;
}

/** One keyed attempt either ran the forward or found its route moved to another key. */
type McpForwardAttempt<T> =
  | { kind: "done"; value: T }
  | { kind: "reroute"; route: McpForwardRoute };

/** Recovery lookup is optional only for older socket-state fakes. */
interface SocketDaemonStateAccess extends DaemonStateAccess {
  getSessionManager(): ReturnType<DaemonStateAccess["getSessionManager"]> & {
    isReleasedSessionInRestartRecoveryWindow?(sessionId: string): Promise<boolean>;
  };
  getDevicePool(): ReturnType<DaemonStateAccess["getDevicePool"]> & {
    getDevice?(deviceId: string): { autolockSessionId?: string | null } | null | undefined;
    resolveOwnedDeviceSessionForMcpSession?(
      mcpSessionId: string | undefined,
      deviceId: string,
    ): string | undefined;
  };
}

/** Classifies one tools/call argument set as a device read (`deviceReadOnly`). */
export type DeviceReadToolCallClassifier = (toolName: string, args: unknown) => boolean;

const registeredDeviceReadClassifier: DeviceReadToolCallClassifier = (toolName, args) =>
  ToolRegistry.getRegisteredTool(toolName)?.isDeviceReadOnlyCall?.(args) === true;

/**
 * Suffix of a device's read lane (#10969). A watcher's read of a device another session holds
 * runs on the read path, which has no device side effects there, so it never queues behind the
 * holder's control calls on `device:<id>`. Reads still serialize among themselves.
 */
const MCP_FORWARD_READ_LANE_SUFFIX = ":read";
const MCP_FORWARD_DEVICE_KEY_PREFIX = "device:";

interface McpForwardRoute {
  /** Serializes work that targets the same physical device or session. */
  executionKey: string;
  /** Owns the loopback MCP transport and its session-local tool-selection profile. */
  clientKey: string;
  /** Replayed when this transport needs to establish a fresh MCP session. */
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  releasedSessionUuid?: string;
}

interface DeviceControlTransportIdentity {
  sessionUuid?: string;
  sessionIncarnation?: object;
  routingSessionUuid?: string;
  routingSessionIncarnation?: object;
  deviceId?: string;
  deviceSessionUuid?: string;
  deviceLabelResolved?: boolean;
}

interface McpForwardRecoveryContext {
  request: DaemonRequest;
  route: McpForwardRoute;
  socketSessionId: string;
  /** Aborted when the Unix-socket client that owns this forward disconnects. */
  signal?: AbortSignal;
  totalTimeoutMs: number;
  /**
   * Mutable: a progress notification for THIS request extends `.value`, up to
   * its own bounded ceiling (issue #6222 review, P1). Every consumer must
   * read `.value` live rather than caching it, so a pre-flight budget check
   * made after progress has already extended the deadline sees the extended
   * value, not the original one.
   */
  deadline: ProgressExtendableDeadline;
}

interface DeviceControlTransportRecoveryContext extends McpForwardRecoveryContext {
  phase: DeviceControlTransportPhase;
  identity: DeviceControlTransportIdentity;
  failedClient?: Client;
}

const isNonBlankSessionUuid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function assertSocketInputNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Owner context the socket path hands to an `input/*` handler (#10006). */
interface InputRequestContext {
  /** Aborts on socket close and on `daemon/cancelRequest` for this frame. */
  signal?: AbortSignal;
  /** When the frame was received; the whole budget, socket queue wait included, runs from here. */
  receivedAtMs?: number;
  /**
   * The device session the frame acts for (#10698), resolved only when the target device is held;
   * undefined for a sessionless frame.
   */
  requester?: () => string | undefined;
}

/** Owner fence and device-key wait bound for one tracked `input/*` execution. */
interface InputDeviceGate {
  ownerSignal?: AbortSignal;
  chainWait?: McpForwardChainWait;
  /** Who sent the frame; only the device's holder may drive a held device (#10698). */
  requester?: () => string | undefined;
}

/** Wire method name for each streamed-gesture frame kind (issue: streaming gesture input). */
const GESTURE_FRAME_METHODS = {
  start: "input/gestureStart",
  move: "input/gestureMove",
  end: "input/gestureEnd",
} as const;

/** Timeout for the best-effort cancelling `gestureEnd` issued when a socket owning a gesture closes. */
const OWNED_GESTURE_CANCEL_TIMEOUT_MS = 5000;

/**
 * The narrow key-value mutation surface the `ide/*` handlers need from a
 * platform CtrlProxy client. Both AndroidCtrlProxyClient and IOSCtrlProxyClient
 * satisfy it structurally (#4708).
 */
interface KeyValueMutationClient {
  setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string,
    type: KeyValueType,
  ): Promise<PreferenceStoreResolution | void>;
  removePreference(
    packageName: string,
    fileName: string,
    key: string,
  ): Promise<PreferenceStoreResolution | void>;
  clearPreferenceStore(
    packageName: string,
    fileName: string,
  ): Promise<PreferenceStoreResolution | void>;
}

/**
 * Preserve the normal failed socket envelope while carrying append progress for
 * a client that can safely retry only the unsent suffix.
 */
class InputTypeTextAppendError extends Error {
  constructor(
    message: string,
    readonly charsSent: number,
  ) {
    super(message);
    this.name = "InputTypeTextAppendError";
  }
}

class McpClientReconnectDeadlineError extends Error {
  constructor() {
    super("MCP client reconnect exceeded the request deadline");
    this.name = "McpClientReconnectDeadlineError";
  }
}

export interface SocketFrameTraceEvent {
  event:
    | "frame_parsed"
    | "admission_requested"
    | "admission_granted"
    | "callTool_entered"
    | "callTool_settled"
    | "response_write_started"
    | "response_write_returned"
    | "response_write_callback"
    | "socket_drain"
    | "socket_pause"
    | "socket_end"
    | "socket_close"
    | "socket_finish";
  atMs: number;
  wallMs: number;
  requestId: string;
  deviceId?: string;
  error?: string;
  byteLength?: number;
  writableLengthAfterWrite?: number;
  writableLengthInCallback?: number;
  hadError?: boolean;
}

interface ProfileReaffirmForwardRouteOptions {
  args: unknown;
  socketSessionId: string;
  toolName: unknown;
  sessionUuid: string;
  toolSelectionProfileUuid: string | undefined;
  scopedKey: string | undefined;
  boundRoute: McpForwardRoute | undefined;
}

interface AndroidAppendTextOptions {
  targetDevice: BootedDevice;
  text: string;
  deadline: number;
  totalTimeoutMs: number;
  frameContext: string | undefined;
  client: AndroidCtrlProxyClient;
  signal?: AbortSignal;
}

type InputTargetAction =
  | "input/tap"
  | "input/swipe"
  | "input/typeText"
  | "input/pressButton"
  | "input/key"
  | "input/gestureStart"
  | "input/gestureMove"
  | "input/gestureEnd";

export class UnixSocketServer {
  private server: NetServer | null = null;
  private serverClosePromise: Promise<void> | null = null;
  private closing = false;
  private acceptingRequests = false;
  /** Largest inbound frame a control-socket peer may send; tests lower it. */
  private readonly maxInboundFrameBytes = CONTROL_SOCKET_MAX_FRAME_BYTES;
  private lifecycleGeneration = 0;
  private socketFileIdentity: SocketFileIdentity | null = null;
  private readonly adbClientFactory: AdbClientFactory;
  private sessions: Map<string, SessionContext> = new Map();
  /** Live client sockets by session ID, for server-pushed notification frames (issue #3223). */
  private clientSockets: Map<string, Socket> = new Map();
  private acceptedClientConnections = 0;
  /** Per-socket outbound byte bound and stall watchdog (issue #10176). */
  private readonly outboundWriteGuards = new WeakMap<Socket, OutboundWriteGuard>();
  private readonly backpressuredSocketIdle = new WeakMap<
    Socket,
    { start: () => void; refresh: () => void; responseFlushed: () => void }
  >();
  /** Request handlers that can continue after their client socket is destroyed. */
  private activeRequestHandlers: Set<Promise<void>> = new Set();
  /** Parsed requests awaiting their one terminal response to flush, including queued requests. */
  private pendingSocketRequests = new Set<PendingSocketRequest>();
  /** Socket sessions that opted in to server-pushed notifications. */
  private notificationSubscribers: Set<string> = new Set();
  private readonly resourceSubscriptions = new Map<string, Set<string>>();
  /**
   * The session that owned each resolved input target at resolution time, so a rebind between
   * resolution and execution cannot leave the input running as an unowned call (#9958).
   */
  private readonly inputTargetOwners = new WeakMap<BootedDevice, string>();
  private resourceUpdatedUnsubscribe: (() => void) | null = null;
  /** Session-release frames written but not yet flushed to their client sockets. */
  private pendingSessionReleaseWrites: Set<Promise<void>> = new Set();
  private listChangedUnsubscribe: (() => void) | null = null;
  private sessionReleaseUnsubscribe: (() => void) | null = null;
  private socketPath: string;
  private mcpEndpoint: string;
  private daemonState: SocketDaemonStateAccess;
  private mcpClients: Map<string, Client> = new Map();
  private mcpClientPromises: Map<string, Promise<Client>> = new Map();
  /**
   * The loopback MCP client that a socket transport most recently bound with a
   * device session. Follow-up requests can omit their session UUID, so reuse
   * this client to preserve the selected tool-selection profile.
   */
  private boundMcpClientKeysBySocketSession: Map<string, BoundMcpClient> = new Map();
  /** Promise tails that serialize MCP HTTP forwards only within the same execution target. */
  private mcpForwardTails: Map<string, Promise<void>> = new Map();
  /** Direct device forwards that need cleanup after every successor tail has settled. */
  private mcpForwardIdleCloseKeys: Map<string, Set<string>> = new Map();
  /** Active forwards by loopback MCP client, which can differ from the execution target. */
  private activeMcpClientForwardCounts: Map<string, number> = new Map();
  private mcpClientIdleTimers: Map<string, NodeJS.Timeout> = new Map();
  private timer: Timer;
  private readonly onFrameTrace?: (event: SocketFrameTraceEvent) => void;
  private readonly idGenerator: IdGenerator;
  /**
   * The daemon-generated key ({@link INTERNAL_LIVE_DEADLINE_KEY_PARAM}) last forwarded with each
   * tools/call request. It is the only identity both this layer and the tool handler share for one
   * call, so a cancelled provisionDevice publishes its outcome under it (#11065: no operationId).
   */
  private readonly forwardedCallKeys = new WeakMap<DaemonRequest, string>();
  /** Observation-only liveness probe used before an existing socket's reclaim (issue #6232). */
  private readonly socketReachability: DaemonSocketReachabilityLike;
  /** Observation-only owner check that fails every bind closed on an inconclusive probe (issue #6232). */
  private readonly socketOwnerLiveness: SocketOwnerLiveness;
  /** Cross-process lock serializing the reclaim → bind sequence against a concurrent binder (issue #6232, W5). */
  private readonly socketReclaimLock: SocketReclaimLock;
  private featureFlagService: FeatureFlagService | null;
  private readonly handshakeEnforced: boolean;
  private readonly daemonIdentity: DaemonSelfIdentity;
  private readonly identityStartedAt: number;
  private readonly processGenerationToken: string | undefined;
  private readonly startupOptions: DaemonOptions;
  private readonly onRepublishIdentity?: () => Promise<boolean>;
  private readonly identityDbPath?: string;
  private readonly identityPidFilePath?: string;
  private readonly startupCompletion?: Promise<void>;
  private startupCompleted = false;
  private readonly identitySockets?: Record<string, string>;
  private readonly identityProcessStartedAt?: number;
  private identityRepublishInFlight?: Promise<{ accepted: boolean; reason?: string }>;
  private readonly onRestartAccepted?: () => void;
  private readonly liveAcceptanceStartupSecret: string | undefined;
  private readonly acceptanceDiscoveryCapability: string | undefined;
  private maintenanceAdmissionToken: string | undefined;
  private maintenanceAdmissionExpiresAt: number | undefined;
  private maintenanceAdmissionExpiryTimer: NodeJS.Timeout | undefined;
  private maintenanceAdmissionAbortController: AbortController | undefined;
  private maintenanceRestartConsumed = false;
  private acceptanceRestartAdmissionToken: string | undefined;
  private acceptanceRestartAdmissionOwnerSessionId: string | undefined;
  private acceptanceRestartAdmissionCommitted = false;
  private acceptanceRestartAdmissionExpiresAt: number | undefined;
  private acceptanceRestartAdmissionExpiryTimer: NodeJS.Timeout | undefined;
  private readonly sessionToolSelectionService?: Pick<
    SessionToolSelectionService,
    "isEnabled" | "setEnabled"
  >;
  /** Forwarded MCP requests are cancelled when their owner socket disconnects. */
  private readonly mcpRequestAbortControllers = new Map<string, Set<AbortController>>();
  /**
   * Factory that `getMcpClient()` calls to open the loopback MCP HTTP client.
   * Defaults to the real {@link createMcpClient}; tests assign a fake here to
   * exercise forwarding without a live HTTP endpoint.
   */
  /** Test seam: the per-args `deviceReadOnly` classification behind the read lane (#10969). */
  deviceReadToolCallClassifier: DeviceReadToolCallClassifier = registeredDeviceReadClassifier;

  mcpClientFactory: McpClientFactory = (
    sessionUuid,
    toolSelectionProfileUuid,
    releasedSessionUuid,
  ) => this.createMcpClient(sessionUuid, toolSelectionProfileUuid, releasedSessionUuid);

  /** Connection recording teardown seam, like the injectable factories below. */
  releaseMcpRecording: (connectionId: string) => void = dropMcpRecording;

  /**
   * Factory for the Android append-text helper behind `input/typeText mode:"append"`.
   *
   * Defaults to the real {@link InputText} bound to the default adb client factory and
   * this server's timer; tests assign a fake so the append path is exercised without
   * shelling out to a real `adb` (and so a stalled subprocess can be simulated).
   */
  appendTextFactory: (device: BootedDevice) => AppendTextInput = (device) =>
    new InputText(device, defaultAdbClientFactory, undefined, this.timer);

  /**
   * Per-device append helpers, cached so the API-level probe (`adb shell getprop`)
   * runs once per device instead of once PER KEYSTROKE — an interactive client
   * sends one `input/typeText` per key press, and a fresh {@link InputText} would
   * re-pay that round trip every time (issue #1099 tracks interactive latency).
   *
   * Evicted alongside the device's idle MCP-client close ({@link closeIdleMcpClient},
   * same per-device key, same idle window), so a device that re-appears under the
   * same id with a different image re-probes rather than trusting a stale API level.
   */
  private appendTextInputs: Map<string, CachedAppendTextInput> = new Map();

  /**
   * Device ids whose iOS runner a scale probe CONFIRMED report no scale metadata (a genuine
   * pre-#4548 runner). Cached so subsequent legacy taps skip the hierarchy-sync round trip (#4549).
   * A probe FAILURE is never cached (it must re-probe); the entry is dropped the moment metadata
   * appears, so a runner upgrade is not pinned to the stale legacy verdict.
   */
  private confirmedLegacyScaleDevices: Set<string> = new Set();

  /**
   * Streamed gestures currently open on a device, keyed by the SOCKET session that started them,
   * then by `${deviceId}::${gestureId}`. A `gestureStart` the runner accepts records its owning
   * socket here and the matching `gestureEnd` clears it. The runner deliberately parks a continued
   * stroke while it waits, with no duration ceiling, so a socket that closes/errors before sending
   * its end (desktop crash, timeout, disconnect) would leave the on-device touch and the runner's
   * registry entry live indefinitely; {@link GestureOwnershipRegistry} issues a cancelling end for
   * each on socket teardown, and for a start acked after its socket already closed (#10005).
   */
  private readonly ownedGestures = new GestureOwnershipRegistry({
    isSocketLive: (socketSessionId) => this.clientSockets.has(socketSessionId),
    cancelGesture: (targetDevice, gestureId) => this.cancelGestureOnDevice(targetDevice, gestureId),
  });

  constructor(
    socketPath: string = SOCKET_PATH,
    mcpEndpoint: string,
    daemonState: SocketDaemonStateAccess = DaemonState.getInstance(),
    timer: Timer = defaultTimer,
    featureFlagService: FeatureFlagService | null = null,
    handshakeConfig: {
      identity?: DaemonSelfIdentity;
      identityStartedAt?: number;
      processGenerationToken?: string;
      startupOptions?: DaemonOptions;
      enforce?: boolean;
      onRepublishIdentity?: () => Promise<boolean>;
      dbPath?: string;
      pidFilePath?: string;
      startupCompletion?: Promise<void>;
      sockets?: Record<string, string>;
      processStartedAt?: number;
      onRestartAccepted?: () => void;
      liveAcceptanceStartupSecret?: string;
      acceptanceDiscoveryCapability?: string;
      sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled">;
      onFrameTrace?: (event: SocketFrameTraceEvent) => void;
    } = {},
    idGenerator: IdGenerator = defaultIdGenerator,
    bindGuard: SocketBindGuardOptions = {},
    adbClientFactory: AdbClientFactory = defaultAdbClientFactory,
  ) {
    this.socketPath = socketPath;
    this.mcpEndpoint = mcpEndpoint;
    this.daemonState = daemonState;
    this.timer = timer;
    this.onFrameTrace = handshakeConfig.onFrameTrace;
    this.idGenerator = idGenerator;
    // The reclaim lock's per-instance owner token comes from the module default
    // generator, NOT the injected `idGenerator` — that one is reserved for socket
    // SESSION ids, and consuming it here would shift every session id a test
    // pins to the injected sequence.
    const resolvedBindGuard = resolveSocketBindGuard(
      bindGuard,
      socketPath,
      defaultIdGenerator.next(),
    );
    this.socketReachability = resolvedBindGuard.reachability;
    this.socketOwnerLiveness = resolvedBindGuard.ownerLiveness;
    this.socketReclaimLock = resolvedBindGuard.bindLock;
    this.adbClientFactory = adbClientFactory;
    this.featureFlagService = featureFlagService;
    this.handshakeEnforced = handshakeConfig.enforce ?? DAEMON_HANDSHAKE_ENABLED;
    this.sessionToolSelectionService = handshakeConfig.sessionToolSelectionService;
    this.daemonIdentity = handshakeConfig.identity ?? {
      version: DAEMON_VERSION,
      build: getCurrentBuildIdentity(),
    };
    this.identityStartedAt = resolveIdentityStartedAt(
      handshakeConfig.identityStartedAt,
      this.timer,
    );
    this.processGenerationToken = handshakeConfig.processGenerationToken;
    this.startupOptions = snapshotDaemonOptions(handshakeConfig.startupOptions);
    this.onRepublishIdentity = handshakeConfig.onRepublishIdentity;
    this.identityDbPath = handshakeConfig.dbPath;
    this.identityPidFilePath = handshakeConfig.pidFilePath;
    this.startupCompletion = handshakeConfig.startupCompletion;
    this.observeStartupCompletion();
    this.identitySockets = handshakeConfig.sockets;
    this.identityProcessStartedAt = handshakeConfig.processStartedAt;
    this.onRestartAccepted = handshakeConfig.onRestartAccepted;
    this.liveAcceptanceStartupSecret = handshakeConfig.liveAcceptanceStartupSecret;
    this.acceptanceDiscoveryCapability = handshakeConfig.acceptanceDiscoveryCapability;
    logger.info(`UnixSocketServer initialized with endpoint: "${mcpEndpoint}"`);
    if (!mcpEndpoint) {
      logger.error("ERROR: mcpEndpoint is empty or undefined!");
    }
  }

  private observeStartupCompletion(): void {
    void this.startupCompletion?.then(
      () => {
        this.startupCompleted = true;
      },
      (error: unknown) => {
        logger.debug(`Daemon startup completion rejected: ${errorMessage(error)}`);
      },
    );
  }

  /**
   * Start the Unix socket server
   */
  async start(): Promise<void> {
    this.closing = false;
    this.acceptingRequests = true;
    this.serverClosePromise = null;
    this.lifecycleGeneration += 1;
    // Owner-only (0o700) socket directory so the control socket is not
    // world-traversable. On macOS socket-file permission bits are not reliably
    // enforced on connect(), so the containing directory's mode is the primary
    // access control (issue #4750).
    await ensureSecureDir(path.dirname(this.socketPath));

    // Hold a single cross-process lock across the whole reclaim → `listen()`
    // sequence (issue #6232, W5). The reachability/owner checks below are
    // observation-only, so two concurrent binders can BOTH judge a stale socket
    // reclaimable and then race unlink-vs-listen, leaving the winner bound to an
    // fd whose pathname the loser deleted. Serializing on `<socket>.bind.lock`
    // makes the sequence atomic: a losing binder cannot enter the reclaim window
    // until the winner has bound, at which point its own probe sees a reachable
    // socket and it refuses. A live holder means another launch is mid-bind, so
    // fail CLOSED rather than racing it (recoverable via `--daemon restart`).
    // A stale lock from a crashed holder is reclaimed by the primitive's dead-PID
    // check on the next attempt.
    if (!this.socketReclaimLock.acquire()) {
      throw new ActionableError(
        `Refusing to bind: another AutoMobile process is currently reclaiming or binding the daemon socket ${this.socketPath}. ` +
          "Two concurrent launches cannot bind the same socket; let the in-flight one finish, then re-observe, or run `--daemon restart`.",
      );
    }
    try {
      // Reclaim any existing socket file before listen(). Under this reclaim lock
      // the unlink is exclusive across processes. A LOCK-LESS bind — a
      // hand-launched daemon that bypassed the manager — must still NOT unlink a
      // live sibling's socket: doing so bricks every existing client (issue #6232,
      // the #6140 failure mode via a bypassed launch path). So probe first and
      // refuse when a live daemon still owns it.
      if (existsSync(this.socketPath)) {
        await this.reclaimExistingSocketBeforeBind();
      }

      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      // Fan list-changed events out to subscribed socket clients (issue #3223).
      // Subscribed here (not in the daemon) so a socket-server recreation during
      // recovery re-wires itself; close() unsubscribes symmetrically.
      this.listChangedUnsubscribe?.();
      this.listChangedUnsubscribe = ListChangedBroadcaster.subscribe((kind) => {
        this.broadcastListChanged(kind);
      });

      this.resourceUpdatedUnsubscribe?.();
      this.resourceUpdatedUnsubscribe = ResourceUpdatedBroadcaster.subscribe((resolveTargets) => {
        this.broadcastResourceUpdated(resolveTargets);
      });

      // Fan session-release events out to subscribed proxy clients (issue #4610),
      // so a proxy clears its remembered binding on a real release instead of the
      // replay-TTL guess. Subscribed here (not in the daemon) for the same
      // recovery-rewire reason as list-changed; close() unsubscribes symmetrically.
      this.sessionReleaseUnsubscribe?.();
      this.sessionReleaseUnsubscribe = SessionReleaseBroadcaster.subscribe(
        (sessionId, reason, snapshot, extras) => {
          this.clearBoundMcpClientsForReleasedSession(sessionId);
          this.broadcastSessionReleased(sessionId, reason, snapshot, extras?.recordingIds);
        },
      );

      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.socketPath, () => {
          this.socketFileIdentity = this.readSocketFileIdentity();
          logger.info(`Unix socket server listening on ${this.socketPath}`);
          // Restrict the bound socket to the owner (0o600) before start() resolves,
          // so no client can connect while it is still world-accessible. listen()
          // creates the socket at the umask default (issue #4750).
          secureFile(this.socketPath).then(resolve).catch(reject);
        });

        this.server!.on("error", (error) => {
          logger.error(`Unix socket server error: ${error}`);
          reject(error);
        });
      });
    } finally {
      // Release once the socket is bound (or the bind failed): the lock only
      // needs to cover the brief unlink-and-listen window. Past a committed bind
      // the reachability probe alone protects the live socket from later binders.
      this.socketReclaimLock.release();
    }
  }

  /**
   * Reclaim an existing socket file before `listen()`, refusing to clobber a live
   * sibling (issue #6232). A startup lock is not ownership evidence, and a
   * failed probe is inconclusive. Reclaim requires both an unreachable probe and
   * a positively dead recorded owner.
   */
  private async reclaimExistingSocketBeforeBind(): Promise<void> {
    const reachable = await this.socketReachability.isReachable(
      this.socketPath,
      SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS,
    );
    if (reachable || this.socketOwnerLiveness.getOwnerStatus() !== "dead") {
      throw new ActionableError(
        `Refusing to bind: the AutoMobile daemon socket ${this.socketPath} is still reachable or its former owner is not positively known to be dead. ` +
          "A startup lock and an inconclusive liveness probe do not authorize unlinking a socket that may still be live. Stop the running daemon or run `--daemon restart` to replace it.",
      );
    }
    await unlink(this.socketPath);
  }

  /**
   * Handle a new client connection
   */
  private handleConnection(socket: Socket): void {
    if (!this.acceptingRequests) {
      // An accept callback can already be queued when quiesce closes the
      // listener. End that late connection before it can bind or issue work.
      socket.end();
      return;
    }
    const sessionId = this.idGenerator.next();
    const session: SessionContext = {
      sessionId,
      createdAt: this.timer.now(),
      requestQueue: new SocketRequestAdmissionQueue(),
      requestCancellations: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.clientSockets.set(sessionId, socket);
    this.acceptedClientConnections++;
    logger.info(`New client connection: ${sessionId}`);

    // Ordinary idle sockets retain Node's timeout. Once a write backpressures,
    // writes must no longer extend the lifetime of a peer that is not reading.
    socket.setTimeout(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    const onIdleTimeout = (): void => {
      // A silent request may outlive the idle window. Renew only while its
      // live deadline permits work, never for an unread backpressured write.
      // A handler that never answers loses this exemption at its deadline and
      // is disconnected on the next check (at most one further idle window).
      if (socket.writableLength === 0 && this.hasLiveSocketRequest(socket)) {
        socket.setTimeout(0);
        if (idleTimeout) {
          this.timer.clearTimeout(idleTimeout);
        }
        idleTimeout = armIdleTimeout();
        return;
      }
      logger.warn(
        `Daemon RPC socket ${sessionId} idle timeout after ${DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS}ms, destroying`,
      );
      socket.destroy();
    };
    socket.on("timeout", onIdleTimeout);
    const armIdleTimeout = (): NodeJS.Timeout =>
      this.timer.setTimeout(onIdleTimeout, DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    let idleTimeout: NodeJS.Timeout | undefined;
    const refreshIdle = (): void => {
      if (!idleTimeout || socket.destroyed) {
        return;
      }
      this.timer.clearTimeout(idleTimeout);
      idleTimeout = armIdleTimeout();
    };
    this.backpressuredSocketIdle.set(socket, {
      start: () => {
        if (idleTimeout || socket.destroyed) {
          return;
        }
        socket.setTimeout(0);
        idleTimeout = armIdleTimeout();
      },
      refresh: refreshIdle,
      responseFlushed: () => {
        if (socket.destroyed) {
          return;
        }
        if (idleTimeout) {
          if (socket.writableLength === 0) {
            refreshIdle();
          }
        } else {
          socket.setTimeout(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
        }
      },
    });
    socket.on("drain", refreshIdle);
    socket.on("drain", () => this.outboundWriteGuards.get(socket)?.flushed());

    if (this.onFrameTrace) {
      socket.on("drain", () => this.traceFrame("socket_drain", "*"));
      socket.on("pause", () => this.traceFrame("socket_pause", "*"));
      socket.on("end", () => this.traceFrame("socket_end", "*"));
      socket.on("finish", () => this.traceFrame("socket_finish", "*"));
    }

    // Frames are delivered synchronously from `framer.push`, so every frame of a
    // chunk sees that chunk's receive time.
    let receivedAtMs = this.timer.now();
    const framer = new LineFramer(this.maxInboundFrameBytes, {
      // Parse each frame synchronously and track it on its own. A held device
      // call must not keep another frame attached to its chunk's completion
      // promise (issue #6387).
      onLine: (line) => {
        if (line.trim()) {
          this.trackRequestHandler(
            this.processSocketRequestLine(sessionId, socket, line, receivedAtMs),
          );
        }
      },
      onOverflow: () => this.rejectOversizedFrame(sessionId, socket),
    });
    socket.on("data", (data) => {
      // After an overflow the socket only waits for its error reply to flush;
      // further bytes must not keep it alive past the idle timeout.
      if (framer.hasOverflowed) {
        return;
      }
      refreshIdle();
      receivedAtMs = this.timer.now();
      framer.push(data);
    });

    // The peer closed its side (#11058). Replies already queued may still flush within the grace;
    // past it the socket is destroyed, because a reply queued to a peer that is gone can stay
    // unflushed without an error, so the automatic end would never complete and `close` (and the
    // owner-disconnect release it triggers) would never run.
    let peerEndGrace: NodeJS.Timeout | undefined;
    socket.on("end", () => {
      if (socket.destroyed || peerEndGrace) {
        return;
      }
      peerEndGrace = this.timer.setTimeout(() => {
        if (!socket.destroyed) {
          logger.debug(
            `Daemon RPC socket ${sessionId} peer closed with ${socket.writableLength} bytes unflushed; destroying`,
          );
          socket.destroy();
        }
      }, DAEMON_RPC_SOCKET_PEER_END_FLUSH_GRACE_MS);
    });

    socket.on("close", (hadError) => {
      if (peerEndGrace) {
        this.timer.clearTimeout(peerEndGrace);
      }
      if (idleTimeout) {
        this.timer.clearTimeout(idleTimeout);
      }
      this.backpressuredSocketIdle.delete(socket);
      this.outboundWriteGuards.get(socket)?.dispose();
      if (this.onFrameTrace) {
        this.traceFrame("socket_close", "*", undefined, undefined, { hadError });
      }
      logger.info(`Client disconnected: ${sessionId}`);
      for (const pending of this.pendingSocketRequests) {
        if (pending.socket === socket) {
          this.pendingSocketRequests.delete(pending);
        }
      }
      this.releaseSocketSession(sessionId, socket);
    });

    socket.on("error", (error) => {
      if (isExpectedPeerClose(error)) {
        // The peer has gone away; release and destruction still clean up this socket's work.
        logger.debug(`Socket peer closed for ${sessionId}: ${errorMessage(error)}`);
      } else {
        logger.error(`Socket error for ${sessionId}:`, error);
      }
      this.releaseSocketSession(sessionId, socket);
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  /**
   * A peer sent a frame larger than the control socket accepts. Answer with a
   * structured error (the request id is unknowable because the frame was never
   * completed), then drop the connection once the reply is flushed. Other
   * sockets are unaffected.
   */
  private rejectOversizedFrame(sessionId: string, socket: Socket): void {
    logger.warn(
      `Daemon RPC socket ${sessionId} sent a frame over ${this.maxInboundFrameBytes} bytes; rejecting`,
    );
    const errorResponse: DaemonResponse = {
      id: null,
      type: "mcp_response",
      success: false,
      error: "Invalid request: frame too large",
      code: -32600,
    };
    this.writeFrame(socket, sessionId, errorResponse, () => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  private hasLiveSocketRequest(socket: Socket): boolean {
    for (const pending of this.pendingSocketRequests) {
      if (
        pending.socket === socket &&
        pending.idleDeadline &&
        pending.idleDeadline.value >= this.timer.now()
      ) {
        return true;
      }
    }
    return false;
  }

  private async processSocketRequestLine(
    sessionId: string,
    socket: Socket,
    line: string,
    receivedAtMs: number,
  ): Promise<void> {
    let requestId: string | null = null;
    let deviceId: string | undefined;
    let pending: PendingSocketRequest | undefined;
    let errorCode: number | undefined;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errorCode = -32700;
        throw toActionableError(error, "Parse error in daemon socket request");
      }
      requestId = socketRequestId(parsed);
      if (!isDaemonSocketRequest(parsed)) {
        errorCode = -32600;
        throw new ActionableError("Invalid daemon socket request");
      }
      const request = parsed;
      const controlFrame = [
        DAEMON_HEARTBEAT_METHOD,
        DAEMON_CANCEL_REQUEST_METHOD,
        DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
      ].includes(request.method);
      const tracked: PendingSocketRequest = {
        id: request.id,
        sessionId,
        socket,
        admitted: controlFrame,
        terminal: false,
        idleDeadline: controlFrame
          ? undefined
          : new ProgressExtendableDeadline(receivedAtMs, resolveMcpRequestTimeoutMs(request)),
      };
      pending = tracked;
      this.pendingSocketRequests.add(tracked);
      deviceId = this.onFrameTrace ? this.frameDeviceId(request) : undefined;
      if (this.onFrameTrace) {
        this.traceFrame("frame_parsed", request.id, deviceId);
      }
      const response = await this.handleRequest(
        sessionId,
        socket,
        request,
        receivedAtMs,
        (deadline) => {
          tracked.admitted = true;
          tracked.idleDeadline = controlFrame ? undefined : deadline;
        },
      );
      if (response) {
        this.writeTerminalSocketResponse(tracked, response, deviceId);
      } else {
        this.pendingSocketRequests.delete(tracked);
        this.backpressuredSocketIdle.get(socket)?.responseFlushed();
      }
    } catch (error) {
      if (error instanceof ClientRequestCancellation) {
        // Explicit client cancellation is already reported by the cancellation/forward path.
        logger.debug(`Client cancelled request ${requestId} from ${sessionId}`);
      } else {
        logger.error(`Error processing request ${requestId} from ${sessionId}:`, error);
      }
      const errorResponse: DaemonResponse = {
        id: requestId,
        type: "mcp_response",
        success: false,
        error: errorMessage(error),
        ...(errorCode === undefined ? {} : { code: errorCode }),
        ...mcpRequestFailureDetails(error, undefined),
      };
      if (pending) {
        this.writeTerminalSocketResponse(pending, errorResponse, deviceId);
      } else {
        this.writeFrame(socket, sessionId, errorResponse, undefined, deviceId);
      }
    }
  }

  private writeTerminalSocketResponse(
    pending: PendingSocketRequest,
    response: DaemonResponse,
    deviceId?: string,
  ): void {
    if (pending.terminal) {
      return;
    }
    pending.terminal = true;
    this.writeFrame(
      pending.socket,
      pending.sessionId,
      response,
      () => {
        this.pendingSocketRequests.delete(pending);
        this.backpressuredSocketIdle.get(pending.socket)?.responseFlushed();
      },
      deviceId,
    );
  }

  private frameDeviceId(request: DaemonRequest): string | undefined {
    const deviceId: unknown = request.params?.arguments?.deviceId;
    return typeof deviceId === "string" ? deviceId : undefined;
  }

  private traceFrame(
    event: SocketFrameTraceEvent["event"],
    requestId: string,
    deviceId?: string,
    error?: string,
    details?: Partial<SocketFrameTraceEvent>,
  ): void {
    if (this.onFrameTrace) {
      this.onFrameTrace({
        event,
        atMs: this.timer.now(),
        wallMs: performance.now(),
        requestId,
        deviceId,
        error,
        ...details,
      });
    }
  }

  private releaseSocketSession(sessionId: string, socket: Socket): void {
    // Session IDs are expected to be unique, but teardown must still be
    // incarnation-safe: a delayed close/error from an older socket must not
    // remove or abort work registered by a newer socket with the same ID.
    if (this.clientSockets.get(sessionId) !== socket) {
      return;
    }
    this.abortMcpRequests(sessionId);
    this.releaseAcceptanceRestartAdmissionForOwner(sessionId);
    this.sessions.delete(sessionId);
    this.clientSockets.delete(sessionId);
    this.notificationSubscribers.delete(sessionId);
    this.resourceSubscriptions.delete(sessionId);
    this.clearBoundMcpClientKey(sessionId);
    this.releaseDevicePoolMcpSessionBindings(sessionId);
    this.releaseMcpRecording(sessionId);
    // Lift any streamed gesture this socket left open on the device (issue: streaming gesture
    // input). Tracked so daemon shutdown drains it rather than a fire-and-forget floating promise.
    this.trackRequestHandler(this.ownedGestures.cancelAllFor(sessionId));
  }

  private trackRequestHandler(handler: Promise<void>): void {
    this.activeRequestHandlers.add(handler);
    void handler.then(
      () => this.activeRequestHandlers.delete(handler),
      () => this.activeRequestHandlers.delete(handler),
    );
  }

  private abortMcpRequests(sessionId: string): void {
    this.abortRequestControllers(
      sessionId,
      this.mcpRequestAbortControllers,
      "Daemon MCP client disconnected",
    );
  }

  private abortRequestControllers(
    sessionId: string,
    controllerMap: Map<string, Set<AbortController>>,
    reason: string,
  ): void {
    const controllers = controllerMap.get(sessionId);
    if (!controllers) {
      return;
    }
    controllerMap.delete(sessionId);
    for (const controller of controllers) {
      controller.abort(new Error(reason));
    }
  }

  private mcpRequestSignal(
    sessionId: string,
    ownerSocket: Socket | undefined = this.clientSockets.get(sessionId),
    cancelSignal?: AbortSignal,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    // A client cancel frame (issue #6384) aborts this one forward, not its siblings.
    const onCancel = () => controller.abort(cancelSignal?.reason);
    if (cancelSignal?.aborted) {
      onCancel();
    } else {
      cancelSignal?.addEventListener("abort", onCancel, { once: true });
    }
    const controllers =
      this.mcpRequestAbortControllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.mcpRequestAbortControllers.set(sessionId, controllers);
    const socket = this.clientSockets.get(sessionId);
    if (!ownerSocket || socket !== ownerSocket || ownerSocket.destroyed) {
      controller.abort(new Error("Daemon MCP client disconnected"));
    }
    return {
      signal: controller.signal,
      dispose: () => {
        cancelSignal?.removeEventListener("abort", onCancel);
        controllers.delete(controller);
        if (
          controllers.size === 0 &&
          this.mcpRequestAbortControllers.get(sessionId) === controllers
        ) {
          this.mcpRequestAbortControllers.delete(sessionId);
        }
      },
    };
  }

  /**
   * An abort-ignoring MCP transport can return after its owning Unix socket has
   * disconnected. Its result is no longer allowed to publish a session/profile
   * binding that a later socket request could reuse.
   */
  private isMcpRequestOwnerCurrent(sessionId: string, signal: AbortSignal): boolean {
    const socket = this.clientSockets.get(sessionId);
    return !signal.aborted && socket !== undefined && !socket.destroyed;
  }

  /**
   * Push a list-changed notification frame to every subscribed client socket
   * (issue #3223). Best-effort per socket: a dead/mid-teardown socket is
   * skipped or destroyed by the write helper, never thrown.
   */
  private broadcastListChanged(kind: ListChangedKind): void {
    const notification: DaemonNotification = {
      type: "daemon_notification",
      method: LIST_CHANGED_NOTIFICATION_METHODS[kind],
    };
    for (const sessionId of this.notificationSubscribers) {
      const socket = this.clientSockets.get(sessionId);
      if (!socket) {
        continue;
      }
      this.writeFrame(socket, sessionId, notification);
    }
  }

  private broadcastResourceUpdated(resolveTargets: ResourceUpdateTargets): void {
    for (const [sessionId, subscriptions] of this.resourceSubscriptions) {
      const socket = this.clientSockets.get(sessionId);
      if (!socket) {
        continue;
      }
      for (const uri of resolveTargets(subscriptions)) {
        this.writeFrame(socket, sessionId, {
          type: "daemon_notification",
          method: RESOURCE_UPDATED_NOTIFICATION_METHOD,
          uri,
        });
      }
    }
  }

  private handleResourceSubscription(sessionId: string, request: DaemonRequest): DaemonResponse {
    const uri = request.params?.uri;
    if (typeof uri !== "string" || uri.length === 0) {
      return {
        id: request.id,
        type: "mcp_response",
        success: false,
        error: "Resource subscription requires params.uri",
      };
    }
    if (request.method === RESOURCE_SUBSCRIBE_METHOD) {
      const subscriptions = this.resourceSubscriptions.get(sessionId) ?? new Set<string>();
      subscriptions.add(uri);
      this.resourceSubscriptions.set(sessionId, subscriptions);
    } else {
      const subscriptions = this.resourceSubscriptions.get(sessionId);
      subscriptions?.delete(uri);
      if (subscriptions?.size === 0) {
        this.resourceSubscriptions.delete(sessionId);
      }
    }
    return { id: request.id, type: "mcp_response", success: true, result: {} };
  }

  /**
   * Push a session-released notification frame to every subscribed client socket
   * (issue #4610). `releasedSessionId` is the daemon session key that was just
   * released (base or derived `${base}:${label}`); the proxy matches it against
   * its bound UUID by exact equality. Best-effort per socket, like
   * {@link broadcastListChanged}. Note `sessionId` here is the socket-client id,
   * distinct from the released daemon session carried in the frame.
   */
  private broadcastSessionReleased(
    releasedSessionId: string,
    reason?: string,
    release?: DaemonNotification["release"],
    recordingIds?: string[],
  ): void {
    const notification: DaemonNotification = {
      type: "daemon_notification",
      method: SESSION_RELEASED_NOTIFICATION_METHOD,
      sessionId: releasedSessionId,
      ...(reason !== undefined ? { reason } : {}),
      ...(release !== undefined ? { release } : {}),
      ...(recordingIds && recordingIds.length > 0 ? { recordingIds } : {}),
    };
    for (const sessionId of this.notificationSubscribers) {
      const socket = this.clientSockets.get(sessionId);
      if (!socket) {
        continue;
      }
      const pending = Promise.withResolvers<void>();
      this.pendingSessionReleaseWrites.add(pending.promise);
      this.writeFrame(socket, sessionId, notification, () => {
        this.pendingSessionReleaseWrites.delete(pending.promise);
        pending.resolve();
      });
    }
  }

  /**
   * Push one `notifications/progress` tick to the SINGLE socket session that
   * requested it (issue #6205), carrying the SAME `progressToken` that
   * session's `tools/call` request declared. Unlike the broadcast helpers
   * above, this targets exactly one socket rather than every subscriber — the
   * request id identifies the originating call even if another call on the
   * same connection uses the same token.
   *
   * Deliberately NOT gated on the opt-in general-notification subscription
   * (unlike the broadcast helpers above). A progress tick is a directed reply
   * to something THIS session explicitly asked for by putting a
   * `progressToken` on its OWN in-flight request -- that is itself the
   * opt-in, independent of whether `daemon/subscribe-notifications` was ever
   * sent or whether it succeeded. `DaemonMcpProxy.doConnect` deliberately
   * continues without a subscription when it fails (best-effort degradation),
   * and gating progress on it too would silently strand a long-running
   * progress-emitting call: the daemon keeps applying work under its own
   * extended deadline while the client's independent local timer -- which
   * only extends on a progress tick it actually receives -- times out
   * underneath it, a split-brain where the daemon succeeds but the client
   * reports failure (#6222 review, P2). Only a torn-down socket is skipped.
   */
  private pushProgressNotification(
    sessionId: string,
    requestId: string,
    progressToken: string | number,
    progress: number,
    total?: number,
    message?: string,
  ): void {
    const socket = this.clientSockets.get(sessionId);
    if (!socket) {
      return;
    }
    const notification: DaemonNotification = {
      type: "daemon_notification",
      method: PROGRESS_NOTIFICATION_METHOD,
      requestId,
      progressToken,
      progress,
      ...(total !== undefined ? { total } : {}),
      ...(message !== undefined ? { message } : {}),
    };
    this.writeFrame(socket, sessionId, notification);
  }

  private writeFrame(
    socket: Socket,
    sessionId: string,
    frame: DaemonResponse | DaemonNotification,
    onFlushed?: () => void,
    deviceId?: string,
  ): void {
    if (this.onFrameTrace && frame.type === "mcp_response") {
      this.traceFrame("response_write_started", frame.id ?? "null", deviceId);
      this.writeFrameData(
        socket,
        sessionId,
        frame,
        (error) => {
          this.traceFrame("response_write_callback", frame.id ?? "null", deviceId, error?.message, {
            writableLengthInCallback: socket.writableLength,
          });
          onFlushed?.();
        },
        (writableLengthAfterWrite, byteLength) => {
          this.traceFrame("response_write_returned", frame.id ?? "null", deviceId, undefined, {
            byteLength,
            writableLengthAfterWrite,
          });
        },
      );
      return;
    }
    this.writeFrameData(socket, sessionId, frame, onFlushed);
  }

  private writeFrameData(
    socket: Socket,
    sessionId: string,
    frame: DaemonResponse | DaemonNotification,
    onFlushed?: (error?: Error | null) => void,
    onWritten?: (writableLengthAfterWrite: number, byteLength: number) => void,
  ): void {
    if (socket.destroyed) {
      onFlushed?.(new Error("socket destroyed"));
      return;
    }
    try {
      const payload = JSON.stringify(frame) + "\n";
      const byteLength = Buffer.byteLength(payload);
      const guard = this.outboundWriteGuard(socket, sessionId);
      const queuedBytes = guard.admit(byteLength);
      if (queuedBytes !== undefined) {
        const error = new DaemonSocketQueueOverflowError(
          queuedBytes,
          DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES,
        );
        logger.warn(
          `Daemon RPC socket ${sessionId} write queue exceeded limit; queuedBytes=${queuedBytes}, limitBytes=${DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES}; destroying`,
        );
        onFlushed?.(error);
        socket.destroy();
        return;
      }
      const ok = socket.write(payload, (error) => {
        if (!error && !socket.destroyed && socket.writableLength === 0) {
          this.backpressuredSocketIdle.get(socket)?.refresh();
          guard.flushed();
        }
        onFlushed?.(error);
      });
      guard.written();
      if (onWritten) {
        onWritten(socket.writableLength, byteLength);
      }
      if (!ok) {
        this.backpressuredSocketIdle.get(socket)?.start();
        logger.debug(`Daemon RPC socket ${sessionId} backpressured; awaiting drain`);
      }
    } catch (error) {
      onFlushed?.(error instanceof Error ? error : new Error(errorMessage(error)));
      logger.warn(`Daemon RPC write failed for ${sessionId}: ${error}`);
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  /**
   * The socket's outbound guard. A reader that frees no queued bytes for the
   * stall deadline is destroyed with the reason logged; a reader that is
   * draining, however slowly, is not.
   */
  private outboundWriteGuard(socket: Socket, sessionId: string): OutboundWriteGuard {
    let guard = this.outboundWriteGuards.get(socket);
    if (!guard) {
      guard = new OutboundWriteGuard(socket, this.timer, (stall) => {
        logger.warn(
          `Daemon RPC socket ${sessionId} reader stalled: no queued bytes freed for ${stall.stalledMs}ms with ${stall.queuedBytes} bytes queued; destroying`,
        );
        socket.destroy();
      });
      this.outboundWriteGuards.set(socket, guard);
    }
    return guard;
  }

  /**
   * Handle a request from a client
   */
  private async handleRequest(
    sessionId: string,
    ownerSocket: Socket,
    request: DaemonRequest,
    receivedAtMs: number = this.timer.now(),
    onAdmitted?: (deadline: ProgressExtendableDeadline) => void,
  ): Promise<DaemonResponse | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        id: request.id,
        type: "mcp_response",
        success: false,
        error: "Session not found",
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      };
    }

    if (!this.acceptingRequests) {
      return this.shuttingDownBeforeStartResponse(request);
    }
    const handshakeError = this.rejectOnHandshakeMismatch(request);
    if (handshakeError) {
      return handshakeError;
    }

    // Notification opt-in is per-socket-session state owned here, not by the
    // daemon request handlers — answer immediately without queueing (issue #3223).
    if (request.method === DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD) {
      this.notificationSubscribers.add(sessionId);
      return {
        id: request.id,
        type: "mcp_response",
        success: true,
        result: { subscribed: true },
      };
    }

    // Socket subscriptions must not attach to shared/idle-evicted loopback MCP clients.
    if ([RESOURCE_SUBSCRIBE_METHOD, RESOURCE_UNSUBSCRIBE_METHOD].includes(request.method)) {
      return this.handleResourceSubscription(sessionId, request);
    }

    // Bound-session keepalive must never wait behind an in-flight tools/call on the same
    // socket: a queued heartbeat can lose the race with the session's heartbeat-timeout
    // during a long unattributed acquisition (e.g. startDevice for a second device), and the
    // session gets reaped out from under a still-live client (issue #6135). It touches only
    // SessionManager's heartbeat bookkeeping, so answering it out-of-band here does not
    // reorder anything tool calls observe.
    if (request.method === DAEMON_HEARTBEAT_METHOD) {
      const daemonResponse = await handleDaemonRequest(request, this.daemonState);
      return {
        id: request.id,
        type: "mcp_response",
        ...daemonResponse,
      };
    }

    // Must bypass the queue: queued, it would wait behind the very request it cancels.
    if (request.method === DAEMON_CANCEL_REQUEST_METHOD) {
      return this.cancelSocketRequest(session, request);
    }

    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    // Mutable: extended by progress notifications for this specific request
    // (see ProgressExtendableDeadline) -- untouched for a request that never
    // emits progress, which keeps its exact original deadline.
    const deadline = new ProgressExtendableDeadline(receivedAtMs, totalTimeoutMs);
    let activeRequestSignal: AbortSignal | undefined;
    const cancellation = this.registerRequestCancellation(session, request.id);

    const handler = async (): Promise<DaemonResponse | undefined> => {
      try {
        if (request.method.startsWith("daemon/")) {
          const daemonResponse = await handleDaemonRequest(request, this.daemonState);
          return {
            id: request.id,
            type: "mcp_response",
            ...daemonResponse,
          };
        }

        // Status and ping are local probes used while the daemon is starting.
        if (!STARTUP_PROBE_METHODS.has(request.method)) {
          activeRequestSignal = cancellation.signal;
          await this.waitForStartup(request, deadline, cancellation.signal);
        }

        const localResult = await this.runLocalSocketRequest(
          request,
          sessionId,
          ownerSocket,
          cancellation.signal,
          receivedAtMs,
          (signal) => {
            activeRequestSignal = signal;
          },
        );
        if (localResult !== undefined) {
          return {
            id: request.id,
            type: "mcp_response",
            success: true,
            result: localResult,
          };
        }

        if (request.method === "tools/call") {
          await this.restoreSelectorSessions(request.params?.arguments, sessionId);
        }
        const routeOrPending = this.getMcpForwardRoute(request, sessionId);
        const initialRoute =
          routeOrPending instanceof Promise ? await routeOrPending : routeOrPending;

        const mcpRequest = this.mcpRequestSignal(sessionId, ownerSocket, cancellation.signal);
        activeRequestSignal = mcpRequest.signal;
        try {
          const result = await this.runMcpForwardForCurrentRoute(
            initialRoute,
            request,
            sessionId,
            async (route) => {
              const remainingTimeoutMs = this.requireRemainingMcpForwardBudget(
                request,
                totalTimeoutMs,
                deadline,
                "waiting in queue",
              );
              const queueWaitMs = Math.max(0, totalTimeoutMs - remainingTimeoutMs);
              const forwardLabel = UnixSocketServer.describeMcpForwardRequest(request);
              logger.debug(
                `[McpForward] start executionKey=${route.executionKey} clientKey=${route.clientKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} queueWaitMs=${queueWaitMs} remainingTimeoutMs=${remainingTimeoutMs}`,
              );

              const forwardStartMs = this.timer.now();
              try {
                const sessionWasActiveBeforeForward = this.wasRequestSessionActive(request);
                const response = await this.forwardMcpRequestWithRecovery({
                  request,
                  route,
                  socketSessionId: sessionId,
                  signal: mcpRequest.signal,
                  totalTimeoutMs,
                  deadline,
                });
                if (this.isMcpRequestOwnerCurrent(sessionId, mcpRequest.signal)) {
                  this.recordBoundMcpClientKey(
                    request,
                    sessionId,
                    route,
                    sessionWasActiveBeforeForward,
                    response,
                  );
                }
                return response;
              } finally {
                logger.debug(
                  `[McpForward] end executionKey=${route.executionKey} clientKey=${route.clientKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} forwardMs=${this.timer.now() - forwardStartMs}`,
                );
                // The idle close is scheduled by runWithActiveMcpClient's wrapper once
                // this client's active-forward count reaches zero, so it is re-armed
                // even when a forward throws before reaching this finally (issue #4610).
              }
            },
            {
              remainingMs: () => this.remainingMcpForwardBudget({ deadline }),
              timeoutError: (executionKey) =>
                new McpTimeoutError({
                  toolName:
                    request.method === "tools/call"
                      ? (request.params?.name ?? request.method)
                      : request.method,
                  timeoutMs: totalTimeoutMs,
                  origin: "UnixSocketServer.handleRequest",
                  detail: `spent ${totalTimeoutMs - this.remainingMcpForwardBudget({ deadline })}ms waiting in queue for ${executionKey}`,
                  code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
                }),
            },
          );

          if (isDaemonShuttingDownToolResult(result)) {
            return {
              id: request.id,
              type: "mcp_response",
              success: false,
              error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
              daemonShuttingDown: daemonShuttingDownFailureFromToolResult(result),
            };
          }

          return {
            id: request.id,
            type: "mcp_response",
            success: true,
            result,
          };
        } finally {
          mcpRequest.dispose();
        }
      } catch (error) {
        const failure = this.mcpForwardFailureResponse({
          error,
          request,
          sessionId,
          ownerSocket,
          signal: activeRequestSignal,
        });
        return failure;
      }
    };
    // Admit through the socket's queue: same-lane requests keep arrival order, while an
    // explicit-device call does not wait behind another device's call (issue #6387).
    const deviceId = this.onFrameTrace ? this.frameDeviceId(request) : undefined;
    if (this.onFrameTrace) {
      this.traceFrame("admission_requested", request.id, deviceId);
    }
    return session.requestQueue
      .run<DaemonResponse | undefined>(
        resolveSocketAdmissionLane(request),
        () => {
          // Same predicate as the entry check: a request still queued when quiesce() began
          // has not started, so it is refused as provably undispatched rather than admitted
          // mid-shutdown. close() also clears acceptingRequests, so this covers both stages.
          if (!this.acceptingRequests) {
            return Promise.resolve(this.shuttingDownBeforeStartResponse(request));
          }
          onAdmitted?.(deadline);
          if (this.onFrameTrace) {
            this.traceFrame("admission_granted", request.id, deviceId);
          }
          // A cancelled provisionDevice is answered by its handler (after a bounded wait for the
          // typed cancellation result), not by this race, which would reply at once (#11074).
          // provisionDevice is a barrier, so a cancel must release it at once: its typed
          // cancellation reply is awaited outside the barrier below (#11092).
          return this.isProvisionDeviceCall(request)
            ? this.runProvisionBarrier(handler, cancellation.signal, () =>
                this.mcpForwardFailureResponse({
                  error: cancellation.signal.reason,
                  request,
                  sessionId,
                  ownerSocket,
                  signal: cancellation.signal,
                }),
              )
            : this.runCancellableQueuedHandler(handler, cancellation.signal);
        },
        {
          timer: this.timer,
          deadlineMs: deadline.value,
          signal: cancellation.signal,
          timeoutError: (sameLaneWait) =>
            new McpTimeoutError({
              toolName:
                request.method === "tools/call"
                  ? (request.params?.name ?? request.method)
                  : request.method,
              timeoutMs: totalTimeoutMs,
              origin: "UnixSocketServer.handleRequest",
              code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
              detail: sameLaneWait
                ? `timed out in queue (waiting in queue for ${resolveSocketAdmissionLane(request)})`
                : "timed out in queue before admission",
            }),
        },
      )
      .then(async (response) =>
        response && !response.success
          ? ((await this.provisionCancellationReply(
              request,
              response,
              cancellation.signal.aborted ? cancellation.signal : activeRequestSignal,
            )) ?? response)
          : response,
      )
      .finally(cancellation.dispose);
  }

  /**
   * Runs the provisionDevice handler inside the admission barrier but gives the barrier back as
   * soon as the caller cancels, answering with [cancelledReply]. The handler keeps rolling back in
   * the background; its typed outcome is awaited by the caller of the barrier, not inside it.
   */
  private runProvisionBarrier(
    handler: () => Promise<DaemonResponse | undefined>,
    cancelSignal: AbortSignal,
    cancelledReply: () => DaemonResponse | undefined,
  ): Promise<DaemonResponse | undefined> {
    const operation = handler();
    this.trackRequestHandler(
      operation.then(
        () => {},
        () => {},
      ),
    );
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(cancelledReply());
      if (cancelSignal.aborted) {
        onAbort();
      } else {
        cancelSignal.addEventListener("abort", onAbort, { once: true });
      }
      operation
        .then(resolve, reject)
        .finally(() => cancelSignal.removeEventListener("abort", onAbort));
    });
  }

  /** Retryable refusal for a request that has not started work (no `requestMayHaveDispatched`). */
  private shuttingDownBeforeStartResponse(request: DaemonRequest): DaemonResponse {
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
      daemonShuttingDown: daemonShuttingDownFailure(),
    };
  }

  /**
   * `provisionDevice` finishes its rollback after a caller abort and builds a typed
   * `request_cancelled` result with `recovery` evidence. Wait a bounded time for it so the reply to
   * the abandoned request carries it instead of the generic abandonment error (#11074).
   */
  private isProvisionDeviceCall(request: DaemonRequest): boolean {
    return request.method === "tools/call" && request.params?.name === "provisionDevice";
  }

  private async provisionCancellationReply(
    request: DaemonRequest,
    failure: DaemonResponse | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DaemonResponse | undefined> {
    const requestKey = this.forwardedCallKeys.get(request);
    if (
      !failure ||
      !this.isProvisionDeviceCall(request) ||
      requestKey === undefined ||
      !(signal?.reason instanceof ClientRequestCancellation)
    ) {
      return undefined;
    }
    const outcome = await provisionCancellationOutcomes.await(
      requestKey,
      PROVISION_DEVICE_SETTLEMENT_WAIT_MS + PROVISION_CANCELLATION_OUTCOME_GRACE_MS,
      this.timer,
    );
    return outcome === undefined
      ? undefined
      : { id: request.id, type: "mcp_response", success: true, result: outcome };
  }

  private mcpForwardFailureResponse({
    error,
    request,
    sessionId,
    ownerSocket,
    signal,
  }: {
    error: unknown;
    request: DaemonRequest;
    sessionId: string;
    ownerSocket: Socket;
    signal?: AbortSignal;
  }): DaemonResponse | undefined {
    const errorMsg = errorMessage(error);
    const preservedCause = requestFailureCause(error, signal);
    if (isClientForwardCancellation(signal, preservedCause)) {
      logger.debug(`MCP forward abandoned for ${sessionId}: ${preservedCause?.message}`);
      if (ownerSocket.destroyed) {
        return undefined;
      }
    } else {
      const errorStack = error instanceof Error ? error.stack : "no stack";
      logger.error(`Error forwarding request to MCP server: ${errorMsg}`);
      logRequestFailureCause(preservedCause);
      logger.error(`Error stack: ${errorStack}`);
      logger.error(`Full error: ${JSON.stringify(error)}`);
    }
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: errorMsg,
      ...(error instanceof DeviceControlTransportError ? { transportFailure: error.failure } : {}),
      ...(error instanceof ReleasedBoundSessionError ? { boundSessionLoss: error.failure } : {}),
      ...mcpRequestFailureDetails(error, preservedCause),
      ...(error instanceof InputTypeTextAppendError ? { charsSent: error.charsSent } : {}),
    };
  }

  private async waitForStartup(
    request: DaemonRequest,
    deadline: ProgressExtendableDeadline,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.startupCompletion || this.startupCompleted) {
      return;
    }
    const remainingMs = deadline.value - this.timer.now();
    const stillStarting = () =>
      new ActionableError(`Daemon still starting; retry ${request.method} after startup completes`);
    if (remainingMs <= 0) {
      throw stillStarting();
    }
    const startup = this.startupCompletion.then(undefined, (error: unknown) => {
      throw new ActionableError(`Daemon startup failed: ${errorMessage(error)}`, { cause: error });
    });
    await raceWithDeadline(startup, {
      timer: this.timer,
      timeoutMs: remainingMs,
      signal,
      label: "Daemon startup",
      timeoutError: stillStarting,
    });
  }

  /**
   * Track a socket request so a later `daemon/cancelRequest` frame can abandon
   * it (issue #6384). A duplicate id replaces the older entry; `dispose` only
   * removes its own entry so it cannot drop the newer one.
   */
  private registerRequestCancellation(
    session: SessionContext,
    requestId: string,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    session.requestCancellations.set(requestId, controller);
    return {
      signal: controller.signal,
      dispose: () => {
        if (session.requestCancellations.get(requestId) === controller) {
          session.requestCancellations.delete(requestId);
        }
      },
    };
  }

  /**
   * Answer a client cancel frame out-of-band (issue #6384). A queued request is
   * skipped when dequeued; an in-flight one has its MCP forward aborted and
   * releases the socket queue immediately. The cancelled request itself is
   * answered with an error response, which the cancelling client ignores.
   */
  private cancelSocketRequest(session: SessionContext, request: DaemonRequest): DaemonResponse {
    const targetId: unknown = request.params?.requestId;
    if (typeof targetId !== "string" || targetId.length === 0) {
      return {
        id: request.id,
        type: "mcp_response",
        success: false,
        error: `${DAEMON_CANCEL_REQUEST_METHOD} requires a non-empty string params.requestId`,
      };
    }
    const controller = session.requestCancellations.get(targetId);
    if (!controller) {
      // Already answered (a timeout racing the response) or never seen: nothing to cancel. Leave a
      // trace: a cancel that reaches the daemon after the work finished otherwise looks identical to
      // one that was never sent, which hid a client delivering its cancel late (#10151).
      logger.debug(
        `[SocketCancel] socketSession=${session.sessionId} cancel for request ${targetId} found no in-flight request (already answered or never seen)`,
      );
      return { id: request.id, type: "mcp_response", success: true, result: { cancelled: false } };
    }
    session.requestCancellations.delete(targetId);
    const reason = new ClientRequestCancellation(
      `Request ${targetId} was cancelled by its client (client-side timeout or abort); ` +
        "the daemon abandoned it so the next request on this connection can run.",
    );
    logger.warn(`[SocketCancel] socketSession=${session.sessionId} ${reason.message}`);
    controller.abort(reason);
    return { id: request.id, type: "mcp_response", success: true, result: { cancelled: true } };
  }

  private requireRemainingMcpForwardBudget(
    request: DaemonRequest,
    totalTimeoutMs: number,
    deadline: ProgressExtendableDeadline,
    phase: string,
  ): number {
    // Read live: a progress notification received since this request first
    // started may already have pushed `deadline.value` out (issue #6222
    // review, P1) -- caching it earlier would silently ignore that extension.
    const remainingTimeoutMs = this.remainingMcpForwardBudget({ deadline });
    const queueWaitMs = Math.max(0, totalTimeoutMs - remainingTimeoutMs);
    if (
      remainingTimeoutMs > 0 &&
      (queueWaitMs === 0 || remainingTimeoutMs > MCP_FORWARD_START_HEADROOM_MS)
    ) {
      return remainingTimeoutMs;
    }
    const toolName =
      request.method === "tools/call" ? (request.params?.name ?? request.method) : request.method;
    if (remainingTimeoutMs <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin: "UnixSocketServer.handleRequest",
        detail: `spent ${totalTimeoutMs - remainingTimeoutMs}ms ${phase}`,
        // Reconnect preparation may follow a dispatched attempt; only the
        // initial execution-key queue wait proves that work never started.
        ...(phase === "waiting in queue" ? { code: MCP_QUEUE_TIMEOUT_ERROR_CODE } : {}),
      });
    }
    if (queueWaitMs > 0) {
      const failure = {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: MCP_OVERLOAD_RETRY_AFTER_MS,
        reason: "insufficient_forward_budget",
        queueWaitMs,
        remainingTimeoutMs: Math.max(0, remainingTimeoutMs),
      } as const;
      throw new McpOverloadError(
        `Daemon overloaded while handling ${toolName}: spent ${queueWaitMs}ms ${phase}, leaving ` +
          `${failure.remainingTimeoutMs}ms of the ${totalTimeoutMs}ms deadline. ` +
          `Retry after ${failure.retryAfterMs}ms.`,
        failure,
      );
    }
    throw new McpTimeoutError({
      toolName,
      timeoutMs: totalTimeoutMs,
      origin: "UnixSocketServer.handleRequest",
      detail: `spent ${totalTimeoutMs - remainingTimeoutMs}ms ${phase}`,
    });
  }

  /**
   * Reject an inbound request whose declared version/build identity does not match
   * this daemon (#2744). Returns an error response to short-circuit the request, or
   * null to let it through. Clients that declare no handshake fields (legacy, or the
   * gate disabled) always pass. This is the single, language-agnostic gate that
   * extends the TS proxy's build-identity enforcement to the Kotlin/Swift clients.
   */
  private rejectOnHandshakeMismatch(request: DaemonRequest): DaemonResponse | null {
    if (!this.handshakeEnforced) {
      return null;
    }
    const evaluation = evaluateClientHandshake(
      this.daemonIdentity,
      extractClientHandshake(request),
    );
    if (evaluation.ok) {
      return null;
    }
    logger.warn(
      `Rejecting daemon client on handshake ${evaluation.reason} mismatch: ${evaluation.message}`,
    );
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: evaluation.message,
      handshakeFailure: {
        code: "daemon_identity_mismatch",
        phase: "daemon-preflight",
        executionStarted: false,
        reason: evaluation.reason,
        daemon: this.daemonIdentity,
        client: extractClientHandshake(request),
      },
    };
  }

  /**
   * Run one MCP forward at a time for a single execution target. Calls for different devices or
   * sessions can proceed concurrently while their loopback transports remain session-local.
   */
  private runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    if (idleCloseKey) {
      const idleCloseKeys = this.mcpForwardIdleCloseKeys.get(executionKey) ?? new Set<string>();
      idleCloseKeys.add(idleCloseKey);
      this.mcpForwardIdleCloseKeys.set(executionKey, idleCloseKeys);
    }
    const heldTail = this.mcpForwardTails.get(executionKey);
    const previous = heldTail ?? Promise.resolve();
    // Only a contended acquisition needs a bound; an idle key is taken immediately.
    const acquired =
      heldTail && chainWait
        ? this.waitForMcpForwardChain(executionKey, heldTail, chainWait)
        : previous;
    const run = acquired.then(() => {
      if (idleCloseKey) {
        this.clearMcpClientIdleTimer(idleCloseKey);
      }
      return fn();
    });
    // The tail also waits for `previous`: a waiter that gave up must not let the next
    // waiter run concurrently with the forward still holding this key.
    const tail = Promise.all([
      previous,
      run.then(
        () => undefined,
        () => undefined,
      ),
    ]).then(() => undefined);
    this.mcpForwardTails.set(executionKey, tail);
    void tail.finally(() => {
      if (this.mcpForwardTails.get(executionKey) === tail) {
        this.mcpForwardTails.delete(executionKey);
        const idleCloseKeys = this.mcpForwardIdleCloseKeys.get(executionKey);
        this.mcpForwardIdleCloseKeys.delete(executionKey);
        for (const key of idleCloseKeys ?? []) {
          this.scheduleMcpClientIdleClose(key);
        }
      }
    });
    return run;
  }

  private async waitForMcpForwardChain(
    executionKey: string,
    heldTail: Promise<void>,
    chainWait: McpForwardChainWait,
  ): Promise<void> {
    try {
      await raceWithDeadline(heldTail, {
        timer: this.timer,
        timeoutMs: Math.max(0, chainWait.remainingMs()),
        label: `MCP forward wait for ${executionKey}`,
      });
    } catch (error) {
      // Tails never reject, so only the wait bound lands here (issue #6388).
      logger.warn(
        `[McpForward] chain wait expired executionKey=${executionKey}: ${errorMessage(error)}`,
      );
      throw chainWait.timeoutError(executionKey);
    }
  }

  private async runWithActiveMcpClient<T>(clientKey: string, fn: () => Promise<T>): Promise<T> {
    this.clearMcpClientIdleTimer(clientKey);
    this.activeMcpClientForwardCounts.set(
      clientKey,
      (this.activeMcpClientForwardCounts.get(clientKey) ?? 0) + 1,
    );
    try {
      return await fn();
    } finally {
      const remainingForClient = (this.activeMcpClientForwardCounts.get(clientKey) ?? 1) - 1;
      if (remainingForClient === 0) {
        this.activeMcpClientForwardCounts.delete(clientKey);
        // Re-arm the idle close around the whole active-client wrapper. A forward
        // can throw before its own cleanup runs (e.g. the pre-forward queue
        // timeout deadline throws before the forward-body finally), and this
        // wrapper cleared the client's idle timer on entry. Without this re-arm
        // the inactive transport would stay cached until another request or
        // daemon shutdown (issue #4610).
        this.scheduleMcpClientIdleClose(clientKey);
      } else {
        this.activeMcpClientForwardCounts.set(clientKey, remainingForClient);
      }
    }
  }

  /**
   * Run `fn` holding the execution key of the request's current route. When the route moves
   * to another key while the request waits, the held key is RELEASED before the new one is
   * acquired: holding one key while waiting on another deadlocks two requests whose routes
   * cross, or one request whose route flips back to a key it still holds (issue #6388).
   */
  private async runMcpForwardForCurrentRoute<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    const visitedKeys = [initialRoute.executionKey];
    let route = initialRoute;
    for (;;) {
      const admittedRoute = route;
      const attempt = await this.runKeyedMcpForward(
        admittedRoute.executionKey,
        () => this.runMcpForwardAttempt(admittedRoute, request, socketSessionId, fn),
        undefined,
        chainWait,
      );
      if (attempt.kind === "done") {
        return attempt.value;
      }
      route = attempt.route;
      visitedKeys.push(route.executionKey);
      if (visitedKeys.length > MAX_MCP_FORWARD_REROUTES + 1) {
        throw new ActionableError(
          `MCP request ${request.id} was re-routed more than ${MAX_MCP_FORWARD_REROUTES} times while waiting to run ` +
            `(execution keys: ${visitedKeys.join(" -> ")}). The target device or session kept changing; retry once it is stable.`,
        );
      }
      logger.debug(
        `[McpForward] rekey requestId=${request.id} initialExecutionKey=${admittedRoute.executionKey} currentExecutionKey=${route.executionKey}`,
      );
    }
  }

  private async runMcpForwardAttempt<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
  ): Promise<McpForwardAttempt<T>> {
    const routeOrPending = this.getMcpForwardRoute(request, socketSessionId);
    const currentRoute = routeOrPending instanceof Promise ? await routeOrPending : routeOrPending;
    if (currentRoute.executionKey !== initialRoute.executionKey) {
      return { kind: "reroute", route: currentRoute };
    }
    // The execution target is unchanged, so this request keeps the client and
    // session it was admitted with. Re-resolving may replace a session-specific
    // clientKey with the shared unbound client (e.g. a mid-flight disconnect
    // cleared the binding before this recompute) under the same executionKey;
    // that would run the admitted tool with no tool-selection profile. Only the
    // execution target may be re-resolved, never the admitted client/session
    // (issue #4610).
    //
    // Exception: when the admitted route was seeded for a specific daemon
    // session and that session was RELEASED while this request waited in the
    // queue, invoking the stale session-scoped client would re-seed the released
    // UUID and RESURRECT the session (getOrCreateSession recreates it and
    // reacquires a device the caller never asked for). A mid-flight socket
    // disconnect, by contrast, leaves the daemon session live — so the daemon
    // session still being active is exactly what distinguishes a disconnect
    // (keep the admitted client, preserving the tool-selection profile above) from a
    // real release (re-resolve to the current, unseeded route). Only re-resolve
    // when the recompute actually points somewhere else (issue #4610).
    if (
      initialRoute.sessionUuid !== undefined &&
      currentRoute.clientKey !== initialRoute.clientKey &&
      !this.hasActiveDaemonSession(initialRoute.sessionUuid)
    ) {
      logger.debug(
        `[McpForward] released-session re-resolve requestId=${request.id} releasedSession=${initialRoute.sessionUuid} clientKey=${initialRoute.clientKey} -> ${currentRoute.clientKey}`,
      );
      return {
        kind: "done",
        value: await this.runWithActiveMcpClient(currentRoute.clientKey, () => fn(currentRoute)),
      };
    }
    return {
      kind: "done",
      value: await this.runWithActiveMcpClient(initialRoute.clientKey, () => fn(initialRoute)),
    };
  }

  private getMcpForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute | Promise<McpForwardRoute> {
    if (request.method === "tools/call") {
      const route = this.getToolsCallForwardRoute(
        request.params?.arguments,
        socketSessionId,
        request.params?.name,
      );
      const toLane = (resolved: McpForwardRoute) =>
        this.withDeviceReadLane(resolved, request, socketSessionId);
      return route instanceof Promise ? route.then(toLane) : toLane(route);
    }

    return this.withAdmittedBoundSession(
      this.boundSessionAdmissionArgs(request),
      (recoverableSessionUuid) =>
        this.getAdmittedMcpForwardRoute(request, socketSessionId, recoverableSessionUuid),
    );
  }

  /**
   * Move a watcher's read of a held device onto the device's read lane (#10969). Control calls,
   * the holder's own calls (by session, device label, autolock or the acquiring connection) and
   * reads of a free device, which may run readiness, stay on the control lane. Re-resolved before
   * the forward runs, so an acquisition or release while queued moves the call between lanes.
   */
  private withDeviceReadLane(
    route: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute {
    const toolName = request.params?.name;
    const args = request.params?.arguments;
    if (
      !route.executionKey.startsWith(MCP_FORWARD_DEVICE_KEY_PREFIX) ||
      typeof toolName !== "string" ||
      !this.isDeviceReadToolCall(toolName, args)
    ) {
      return route;
    }
    const deviceId = route.executionKey.slice(MCP_FORWARD_DEVICE_KEY_PREFIX.length);
    const holder = this.getDeviceHolderSession(deviceId);
    if (!holder) {
      return route;
    }
    const sessionManager = this.daemonState.getSessionManager();
    const base = (sessionUuid: string | undefined) =>
      sessionUuid ? resolveToolSelectionBaseSessionUuid(sessionUuid, sessionManager) : undefined;
    const holderBase = base(holder);
    const callerSessions = [
      route.sessionUuid,
      this.getSessionUuid(args),
      this.getDeviceLabelSession(args),
      this.resolveImplicitAutolockSession(socketSessionId, args),
      this.daemonState
        .getDevicePool()
        .resolveOwnedDeviceSessionForMcpSession?.(socketSessionId, deviceId),
    ];
    if (callerSessions.some((sessionUuid) => base(sessionUuid) === holderBase)) {
      return route;
    }
    return { ...route, executionKey: `${route.executionKey}${MCP_FORWARD_READ_LANE_SUFFIX}` };
  }

  private getDeviceLabelSession(args: unknown): string | undefined {
    const baseSessionUuid = this.getSessionUuid(args);
    const record = args as Record<string, unknown> | undefined;
    return baseSessionUuid && typeof record?.device === "string" && record.device.length > 0
      ? this.resolveDeviceLabelSession(baseSessionUuid, record.device)
      : undefined;
  }

  private isDeviceReadToolCall(toolName: string, args: unknown): boolean {
    try {
      return this.deviceReadToolCallClassifier(toolName, args);
    } catch (error) {
      // An argument set the classifier cannot read is not proven a read: keep the control lane.
      logger.debug(`[McpForward] read classification failed for ${toolName}: ${error}`);
      return false;
    }
  }

  /** The session holding a device: its live owner, or its autolock holder. */
  private getDeviceHolderSession(deviceId: string): string | undefined {
    if (!this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return (
        this.getSessionForDevice(deviceId) ??
        this.daemonState.getDevicePool().getDevice?.(deviceId)?.autolockSessionId ??
        undefined
      );
    } catch (error) {
      // Without a proven holder the call keeps the control lane, as before #10969.
      logger.debug(`[McpForward] holder lookup failed for ${deviceId}: ${error}`);
      return undefined;
    }
  }

  private getAdmittedMcpForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    recoverableSessionUuid?: string,
  ): McpForwardRoute {
    const boundRoute = this.getBoundMcpClientRoute(socketSessionId, recoverableSessionUuid);
    if (
      request.method === "tools/list" ||
      request.method === "resources/list" ||
      request.method === "resources/list-templates"
    ) {
      return this.getDiscoveryForwardRoute(request, socketSessionId, boundRoute);
    }

    if (request.method === "ide/getNavigationGraph") {
      return this.getNavigationGraphForwardRoute(request, socketSessionId, boundRoute);
    }

    if (request.method === "resources/read") {
      return this.getResourceReadForwardRoute(request, socketSessionId);
    }

    return this.sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getDiscoveryForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    if (request.method === "tools/list") {
      // A reconnected restricted discovery re-sends `{sessionUuid}` (see
      // daemonMcpProxy.listTools). A fresh socket has no boundRoute, so without
      // honoring the request's session the shared UNSEEDED client would return the
      // full, unfiltered tool list. Route to the session-scoped client so the
      // seeded loopback transport advertises the session-scoped list, completing
      // the proxy-side reconnect seeding (issue #4610).
      const listSessionUuid = this.getSessionUuid(request.params);
      const toolSelectionProfileUuid = this.getToolSelectionProfileUuid(request.params);
      if (listSessionUuid) {
        return this.sessionScopedForwardRoute(
          socketSessionId,
          listSessionUuid,
          undefined,
          toolSelectionProfileUuid,
        );
      }
      if (toolSelectionProfileUuid) {
        return this.toolSelectionProfileScopedForwardRoute(
          socketSessionId,
          toolSelectionProfileUuid,
          undefined,
        );
      }
      return boundRoute ?? this.sharedMcpForwardRoute(`method:${request.method}`);
    }

    const sessionUuid = this.getSessionUuid(request.params);
    const toolSelectionProfileUuid = this.getToolSelectionProfileUuid(request.params);
    if (sessionUuid) {
      return this.sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        toolSelectionProfileUuid,
      );
    }
    if (toolSelectionProfileUuid) {
      return this.toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        undefined,
      );
    }
    return boundRoute ?? this.sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getNavigationGraphForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    const sessionUuid = this.getSessionUuid(request.params);
    const executionKey = this.getRequestArgumentScopeKey(request.params);
    if (sessionUuid) {
      // An explicit read session routes to its OWN session-specific client so a
      // cross-session IDE read never repurposes the socket's bound transport. If
      // it reused the bound client, the loopback SessionToolBinding would be
      // rebound to this UUID while recordBoundMcpClientKey early-returns for
      // non-tools/call methods, leaving the daemon route labeled the bound
      // session and the transport filtering by a different profile (issue #4610).
      return this.sessionScopedForwardRoute(socketSessionId, sessionUuid, executionKey);
    }
    if (executionKey) {
      return boundRoute
        ? { ...boundRoute, executionKey }
        : this.sharedMcpForwardRoute(executionKey);
    }
    return boundRoute ?? this.sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getResourceReadForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute {
    const sessionUuid = this.getSessionUuid(request.params);
    if (sessionUuid) {
      const releasedSessionUuid =
        request.params?.[DAEMON_RELEASED_SESSION_PARAM] === sessionUuid ? sessionUuid : undefined;
      return this.sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        undefined,
        releasedSessionUuid === sessionUuid ? releasedSessionUuid : undefined,
      );
    }
    const uri = request.params?.uri;
    return this.sharedMcpForwardRoute(
      typeof uri === "string" ? `resource:${uri}` : "resource:unknown",
    );
  }

  private async restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void> {
    const ids = this.selectorSessionIds(args);
    if (!ids) {
      return;
    }
    const ownerSocket = this.clientSockets.get(socketSessionId);
    const pool = this.daemonState.getDevicePool();
    // Restoration attaches only live sessions. It restores both explicit
    // acquisition ownership and autolock routing without reallocating a
    // released UUID.
    const refused =
      (await pool.restoreOwnedDeviceSessionsForMcpSession?.(
        ids,
        socketSessionId,
        this.ownedSessionsOwnerToken(args),
      )) ?? [];
    if (this.releaseBindingsIfSocketDisconnected(socketSessionId, ownerSocket, pool)) {
      return;
    }
    // A session another connection owns must not be restored as this connection's autolock
    // route either: that would rewrite its persisted owner and make it this client's default.
    const refusedIds = new Set(refused.map((refusal) => refusal.sessionId));
    await pool.restoreAutolockSessionsForMcpSession?.(
      ids.filter((id) => !refusedIds.has(id)),
      socketSessionId,
    );
    this.releaseBindingsIfSocketDisconnected(socketSessionId, ownerSocket, pool);
    this.failIfCallTargetsRefusedRestore(args, refused);
  }

  /**
   * A refused owned-session restore skips that session rather than failing an unrelated call
   * (#11107): the call fails only when it targets the refused session or its device.
   */
  private failIfCallTargetsRefusedRestore(
    args: unknown,
    refused: readonly RefusedOwnedSessionRestore[],
  ): void {
    const record =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    for (const { sessionId, deviceId, reason } of refused) {
      logger.warn(
        `[McpForward] skipped restoring owned session ${sessionId} on ${deviceId}: ${reason}`,
      );
      if (record.sessionUuid === sessionId || record.deviceId === deviceId) {
        throw deviceAlreadyAssignedToAnotherSessionError(deviceId);
      }
    }
  }

  /** The restoring proxy's liveness owner token, when it sent one with its owned sessions. */
  private ownedSessionsOwnerToken(args: unknown): string | undefined {
    const token = (args as Record<string, unknown>)[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    return typeof token === "string" && token.trim() !== "" ? token : undefined;
  }

  private selectorSessionIds(args: unknown): string[] | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const ids = (args as Record<string, unknown>)[DAEMON_OWNED_SESSIONS_PARAM];
    return Array.isArray(ids) && ids.every(isNonBlankSessionUuid)
      ? [...new Set<string>(ids)]
      : undefined;
  }

  private releaseBindingsIfSocketDisconnected(
    socketSessionId: string,
    ownerSocket: Socket | undefined,
    pool: ReturnType<DaemonStateAccess["getDevicePool"]>,
  ): boolean {
    if (!ownerSocket || this.clientSockets.get(socketSessionId) === ownerSocket) {
      return false;
    }
    pool.releaseMcpSessionBindings?.(socketSessionId);
    return true;
  }

  private releaseDevicePoolMcpSessionBindings(socketSessionId: string): void {
    if (this.daemonState.isInitialized()) {
      this.daemonState.getDevicePool().releaseMcpSessionBindings?.(socketSessionId);
    }
  }

  private getToolsCallForwardRoute(
    args: unknown,
    socketSessionId: string,
    toolName?: unknown,
  ): McpForwardRoute | Promise<McpForwardRoute> {
    return this.withAdmittedBoundSession(args, (recoverableSessionUuid) =>
      this.getAdmittedToolsCallForwardRoute(
        args,
        socketSessionId,
        toolName,
        recoverableSessionUuid,
      ),
    );
  }

  private getAdmittedToolsCallForwardRoute(
    args: unknown,
    socketSessionId: string,
    toolName?: unknown,
    recoverableSessionUuid?: string,
  ): McpForwardRoute {
    const scopedKey = this.getRequestArgumentScopeKey(args);
    const boundRoute = this.getBoundMcpClientRoute(socketSessionId, recoverableSessionUuid);
    const sessionUuid = this.getSessionUuid(args);
    const toolSelectionProfileUuid =
      this.getToolSelectionProfileUuid(args) ?? boundRoute?.toolSelectionProfileUuid;
    if (this.isUnboundDeviceAcquisitionTool(toolName, sessionUuid)) {
      // Acquisition can mint a second device session on an already-bound
      // daemon socket. Keep each platform/tool on its own loopback client without
      // a device-session binding;
      // reusing the first acquired session's bound transport makes the second
      // acquisition and later selector routing disagree about ownership.
      return this.acquisitionMcpForwardRoute(socketSessionId, toolName, toolSelectionProfileUuid);
    }
    if (this.hasImplicitDeviceSelector(args)) {
      return this.selectorMcpForwardRoute(
        socketSessionId,
        args,
        scopedKey,
        toolSelectionProfileUuid,
      );
    }

    if (sessionUuid) {
      return (
        this.profileReaffirmForwardRoute({
          args,
          socketSessionId,
          toolName,
          sessionUuid,
          toolSelectionProfileUuid,
          scopedKey,
          boundRoute,
        }) ??
        this.sessionScopedForwardRoute(
          socketSessionId,
          sessionUuid,
          scopedKey,
          toolSelectionProfileUuid,
        )
      );
    }
    if (toolSelectionProfileUuid) {
      return this.toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        scopedKey,
      );
    }

    if (scopedKey) {
      if (boundRoute) {
        return { ...boundRoute, executionKey: scopedKey };
      }
      return this.sharedMcpForwardRoute(scopedKey);
    }

    if (boundRoute) {
      return this.hostInventoryOrBoundRoute(boundRoute, toolName, args);
    }

    const implicitAutolockKey = this.getImplicitAutolockScopeKey(socketSessionId, args);
    if (implicitAutolockKey) {
      return this.sharedMcpForwardRoute(implicitAutolockKey);
    }

    // The daemon injects __mcpSessionId before forwarding. Use the socket session as the
    // pre-forward key so separate daemon clients can autolock and run independently.
    return this.sharedMcpForwardRoute(`socket:${socketSessionId}`);
  }

  private hostInventoryOrBoundRoute(
    boundRoute: McpForwardRoute,
    toolName: unknown,
    args: unknown,
  ): McpForwardRoute {
    return isHostInventoryCall(toolName, args)
      ? { ...boundRoute, executionKey: "host:inventory" }
      : boundRoute;
  }

  private isUnboundDeviceAcquisitionTool(
    toolName: unknown,
    sessionUuid: string | undefined,
  ): toolName is string {
    return (
      typeof toolName === "string" && DEVICE_ACQUISITION_TOOL_NAMES.has(toolName) && !sessionUuid
    );
  }

  /**
   * A `setToolEnabled` reaffirming the connection's own profile names no device
   * route of its own. Seeding a loopback with the profile as its DEVICE binding
   * made the update's label readback enumerate the profile (nothing) instead of
   * the device session this socket acquired, so carry that acquired route
   * through: the one the proxy sent alongside, else the one this socket is
   * already bound to (#7005). Undefined for every other explicit-session call.
   */
  private profileReaffirmForwardRoute(
    options: ProfileReaffirmForwardRouteOptions,
  ): McpForwardRoute | undefined {
    const {
      args,
      socketSessionId,
      toolName,
      sessionUuid,
      toolSelectionProfileUuid,
      scopedKey,
      boundRoute,
    } = options;
    if (toolName !== SET_TOOL_ENABLED_TOOL_NAME || sessionUuid !== toolSelectionProfileUuid) {
      return undefined;
    }
    const acquiredDeviceSessionUuid =
      this.getAcquiredDeviceSessionUuid(args, sessionUuid) ?? boundRoute?.sessionUuid;
    if (!acquiredDeviceSessionUuid || !this.hasActiveDaemonSession(acquiredDeviceSessionUuid)) {
      return undefined;
    }
    return this.sessionScopedForwardRoute(
      socketSessionId,
      acquiredDeviceSessionUuid,
      scopedKey,
      toolSelectionProfileUuid,
    );
  }

  /**
   * The acquired device session the proxy carries alongside a profile-addressed
   * call (see `DaemonMcpProxy.withAcquiredDeviceRoute`). When the marker merely
   * echoes the explicit session it is the ordinary bound-session replay tag, not
   * a separate route.
   */
  private getAcquiredDeviceSessionUuid(args: unknown, sessionUuid: string): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const carried = (args as Record<string, unknown>)[DAEMON_BOUND_SESSION_PARAM];
    return isNonBlankSessionUuid(carried) && carried !== sessionUuid ? carried : undefined;
  }

  private selectorMcpForwardRoute(
    socketSessionId: string,
    args: unknown,
    scopedKey: string | undefined,
    profileUuid: string | undefined,
  ): McpForwardRoute {
    const key =
      scopedKey ??
      this.getImplicitAutolockScopeKey(socketSessionId, args) ??
      `socket:${socketSessionId}`;
    return profileUuid
      ? this.toolSelectionProfileScopedForwardRoute(socketSessionId, profileUuid, key)
      : this.sharedMcpForwardRoute(key);
  }

  private hasImplicitDeviceSelector(args: unknown): boolean {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return false;
    }
    const record = args as Record<string, unknown>;
    if (record.device) {
      return false;
    }
    const sessionUuid = this.getSessionUuid(args);
    if (sessionUuid) {
      return false;
    }
    return (
      record.platform === "android" ||
      record.platform === "ios" ||
      typeof record.deviceId === "string"
    );
  }

  private sharedMcpForwardRoute(key: string): McpForwardRoute {
    return { executionKey: key, clientKey: key };
  }

  private acquisitionMcpForwardRoute(
    socketSessionId: string,
    toolName: string,
    toolSelectionProfileUuid: string | undefined,
  ): McpForwardRoute {
    const key = `socket:${socketSessionId}:acquisition:${toolName}`;
    return {
      executionKey: key,
      clientKey: toolSelectionProfileUuid
        ? `${key}:tool-selection:${toolSelectionProfileUuid}`
        : key,
      toolSelectionProfileUuid,
    };
  }

  private sessionMcpClientKey(
    socketSessionId: string,
    sessionUuid: string,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): string {
    const profileSuffix = toolSelectionProfileUuid
      ? `:tool-selection:${toolSelectionProfileUuid}`
      : "";
    const releaseSuffix = releasedSessionUuid ? ":released-resource" : "";
    return `socket:${socketSessionId}:session:${sessionUuid}${profileSuffix}${releaseSuffix}`;
  }

  private toolSelectionProfileMcpClientKey(
    socketSessionId: string,
    toolSelectionProfileUuid: string,
  ): string {
    return `socket:${socketSessionId}:tool-selection:${toolSelectionProfileUuid}`;
  }

  // Route an explicit-session request (tools/call or an IDE read) to its OWN
  // session-specific loopback client so it never repurposes the socket's bound
  // transport to a different session (issue #4610).
  private sessionScopedForwardRoute(
    socketSessionId: string,
    sessionUuid: string,
    scopedKey: string | undefined,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): McpForwardRoute {
    return {
      executionKey: scopedKey ?? `session:${sessionUuid}`,
      clientKey: this.sessionMcpClientKey(
        socketSessionId,
        sessionUuid,
        toolSelectionProfileUuid,
        releasedSessionUuid,
      ),
      sessionUuid,
      toolSelectionProfileUuid,
      releasedSessionUuid,
    };
  }

  private toolSelectionProfileScopedForwardRoute(
    socketSessionId: string,
    toolSelectionProfileUuid: string,
    scopedKey: string | undefined,
  ): McpForwardRoute {
    return {
      executionKey: scopedKey ?? `tool-selection:${toolSelectionProfileUuid}`,
      clientKey: this.toolSelectionProfileMcpClientKey(socketSessionId, toolSelectionProfileUuid),
      toolSelectionProfileUuid,
    };
  }

  private recordBoundMcpClientKey(
    request: DaemonRequest,
    socketSessionId: string,
    route: McpForwardRoute,
    sessionWasActiveBeforeForward: boolean,
    response: unknown,
  ): void {
    if (request.method !== "tools/call") {
      return;
    }
    if (isDeviceInventoryTool(request.params?.name)) {
      return;
    }
    const sessionUuid = this.getSessionUuid(request.params?.arguments);
    if (!sessionUuid) {
      this.recordGeneratedToolSelectionProfile(request, response, socketSessionId, route);
      return;
    }
    if (
      this.isReleasedBoundSession(request.params?.arguments) &&
      this.isRetryableSessionRecoveryResult(response, sessionUuid)
    ) {
      // Recovery is still using the admitted identity; keep its transport binding.
      return;
    }
    // A profile reaffirm routed onto the acquired device session binds the
    // socket to THAT session's client (#7005); every other explicit-session
    // route carries the request's own session.
    this.recordSessionBoundMcpClientKey(
      socketSessionId,
      route,
      route.sessionUuid ?? sessionUuid,
      sessionWasActiveBeforeForward,
      request.params?.name,
      request.params?.arguments,
    );
  }

  private isRetryableSessionRecoveryResult(response: unknown, sessionUuid: string): boolean {
    if (
      !response ||
      typeof response !== "object" ||
      !("isError" in response) ||
      response.isError !== true
    ) {
      return false;
    }
    const error = readToolEnvelopePayload(response)?.payload.error as
      | Partial<SessionRecoveryAssignmentDetails>
      | undefined;
    return (
      error?.code === "session_recovery_pending" &&
      error.retryable === true &&
      error.sessionUuid === sessionUuid
    );
  }

  private recordSessionBoundMcpClientKey(
    socketSessionId: string,
    route: McpForwardRoute,
    sessionUuid: string,
    sessionWasActiveBeforeForward: boolean,
    toolName: unknown,
    args: unknown,
  ): void {
    if (this.isReleasedBoundSession(args)) {
      this.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    const sessionIsActiveAfterForward = this.hasActiveDaemonSession(sessionUuid);
    if (
      (sessionWasActiveBeforeForward || toolName === "executePlan") &&
      !sessionIsActiveAfterForward
    ) {
      this.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    const previousBinding = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      sessionUuid,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid,
      requiresLiveDaemonSession: sessionWasActiveBeforeForward || sessionIsActiveAfterForward,
    });
    if (previousBinding && previousBinding.clientKey !== route.clientKey) {
      this.scheduleMcpClientIdleClose(previousBinding.clientKey);
    }
  }

  private recordGeneratedToolSelectionProfile(
    request: DaemonRequest,
    response: unknown,
    socketSessionId: string,
    route: McpForwardRoute,
  ): boolean {
    const toolSelectionProfileUuid = this.getGeneratedToolSelectionProfileUuid(request, response);
    if (!toolSelectionProfileUuid) {
      return false;
    }
    const previousBinding = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      toolSelectionProfileUuid,
      requiresLiveDaemonSession: false,
    });
    if (previousBinding && previousBinding.clientKey !== route.clientKey) {
      this.scheduleMcpClientIdleClose(previousBinding.clientKey);
    }
    return true;
  }

  private getBoundMcpClientRoute(
    socketSessionId: string,
    recoverableSessionUuid?: string,
  ): McpForwardRoute | undefined {
    const boundClient = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return undefined;
    }
    if (
      !boundClient.requiresLiveDaemonSession ||
      !this.daemonState.isInitialized() ||
      (recoverableSessionUuid !== undefined && boundClient.sessionUuid === recoverableSessionUuid)
    ) {
      return {
        clientKey: boundClient.clientKey,
        executionKey: boundClient.executionKey,
        sessionUuid: boundClient.sessionUuid,
        toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
      };
    }
    if (boundClient.sessionUuid && this.hasActiveDaemonSession(boundClient.sessionUuid)) {
      return {
        clientKey: boundClient.clientKey,
        executionKey: boundClient.executionKey,
        sessionUuid: boundClient.sessionUuid,
        toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
      };
    }
    this.clearBoundMcpClientKey(socketSessionId);
    return undefined;
  }

  private getToolSelectionProfileUuid(params: unknown): string | undefined {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return undefined;
    }
    const value = (params as Record<string, unknown>)[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    return isNonBlankSessionUuid(value) ? value : undefined;
  }

  private getGeneratedToolSelectionProfileUuid(
    request: DaemonRequest,
    response: unknown,
  ): string | undefined {
    if (request.params?.name !== SET_TOOL_ENABLED_TOOL_NAME) {
      return undefined;
    }
    return toolSelectionProfileUuidFromResponse(response);
  }

  private clearBoundMcpClientKey(socketSessionId: string): void {
    const boundClient = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return;
    }
    this.boundMcpClientKeysBySocketSession.delete(socketSessionId);
    this.scheduleMcpClientIdleClose(boundClient.clientKey);
  }

  private clearBoundMcpClientsForReleasedSession(sessionUuid: string): void {
    for (const [socketSessionId, boundClient] of this.boundMcpClientKeysBySocketSession) {
      if (boundClient.sessionUuid === sessionUuid) {
        this.clearBoundMcpClientKey(socketSessionId);
      }
    }
  }

  private isMcpClientKeyBound(key: string): boolean {
    for (const boundClient of this.boundMcpClientKeysBySocketSession.values()) {
      if (boundClient.clientKey === key) {
        return true;
      }
    }
    return false;
  }

  private isDeviceControlLoopbackTransportFailure(request: DaemonRequest, error: unknown): boolean {
    return isDeviceControlTransportRequest(request) && isLoopbackTransportFailure(error);
  }

  private async forwardMcpRequestWithRecovery(
    context: McpForwardRecoveryContext,
  ): Promise<unknown> {
    context.signal?.throwIfAborted();
    const identity = this.getDeviceControlTransportIdentity(context);
    let mcpClient: Client;
    try {
      mcpClient = await this.getMcpClient(
        context.route.clientKey,
        context.route.sessionUuid,
        context.route.toolSelectionProfileUuid,
        context.route.releasedSessionUuid,
      );
      context.signal?.throwIfAborted();
    } catch (error) {
      if (!this.isDeviceControlLoopbackTransportFailure(context.request, error)) {
        throw error;
      }
      return this.recoverDeviceControlTransport({
        ...context,
        phase: "connect",
        identity,
      });
    }
    const forwardRemainingMs = this.requireRemainingMcpForwardBudget(
      context.request,
      context.totalTimeoutMs,
      context.deadline,
      "waiting in queues and preparing the MCP client",
    );
    return this.forwardConnectedMcpRequest(context, identity, mcpClient, forwardRemainingMs);
  }

  private async forwardConnectedMcpRequest(
    context: McpForwardRecoveryContext,
    identity: DeviceControlTransportIdentity,
    mcpClient: Client,
    remainingTimeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.handleIdeRequest(
        mcpClient,
        context.request,
        remainingTimeoutMs,
        context.socketSessionId,
        context.deadline,
        context.totalTimeoutMs,
        context.signal,
      );
    } catch (error) {
      if (error instanceof ReleasedBoundSessionError) {
        throw error;
      }
      if (isExpiredLoopbackMcpSession(error)) {
        return this.retryExpiredMcpSession(context, identity, mcpClient);
      }
      if (this.isDeviceControlLoopbackTransportFailure(context.request, error)) {
        const recoveryIdentity = this.getDeviceControlRecoveryFailureIdentity(context, identity);
        return this.recoverDeviceControlTransport({
          ...context,
          phase: "response",
          identity: recoveryIdentity,
          failedClient: mcpClient,
        });
      }
      throw error;
    }
  }

  private async retryExpiredMcpSession(
    context: McpForwardRecoveryContext,
    identity: DeviceControlTransportIdentity,
    failedClient: Client,
  ): Promise<unknown> {
    context.signal?.throwIfAborted();
    logger.warn("MCP client session expired, reconnecting and retrying...");
    await this.resetMcpClientIfCurrent(context.route.clientKey, failedClient);
    context.signal?.throwIfAborted();
    let freshClient: Client;
    try {
      freshClient = await this.getMcpClient(
        context.route.clientKey,
        context.route.sessionUuid,
        context.route.toolSelectionProfileUuid,
        context.route.releasedSessionUuid,
      );
      context.signal?.throwIfAborted();
    } catch (error) {
      if (!this.isDeviceControlLoopbackTransportFailure(context.request, error)) {
        throw error;
      }
      throw this.deviceControlTransportError({
        request: context.request,
        identity,
        phase: "connect",
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: true,
      });
    }
    const retryRemainingMs = this.requireRemainingMcpForwardBudget(
      context.request,
      context.totalTimeoutMs,
      context.deadline,
      "waiting in queues and reconnecting the MCP client",
    );
    try {
      return await this.handleIdeRequest(
        freshClient,
        context.request,
        retryRemainingMs,
        context.socketSessionId,
        context.deadline,
        context.totalTimeoutMs,
        context.signal,
      );
    } catch (error) {
      if (!this.isDeviceControlLoopbackTransportFailure(context.request, error)) {
        throw error;
      }
      await this.resetMcpClientIfCurrent(context.route.clientKey, freshClient, "detach");
      const failureIdentity = this.getDeviceControlRecoveryFailureIdentity(context, identity);
      throw this.deviceControlTransportError({
        request: context.request,
        identity: failureIdentity,
        phase: "response",
        reconnectAttempted: true,
        replayAttempted: true,
        recoveryExhausted: true,
      });
    }
  }

  private getDeviceControlTransportIdentity(
    context: McpForwardRecoveryContext,
  ): DeviceControlTransportIdentity {
    const args =
      context.request.method === "tools/call" ? context.request.params?.arguments : undefined;
    const sessionUuid = this.resolveDeviceControlIdentitySession(
      args,
      context.route.sessionUuid,
      context.socketSessionId,
    );
    const routingSessionUuid =
      args && typeof args === "object" && !Array.isArray(args)
        ? (this.getSessionUuid(args as Record<string, unknown>) ?? context.route.sessionUuid)
        : context.route.sessionUuid;
    const sessionIncarnation = this.getDeviceControlSessionIncarnation(sessionUuid);
    const routingSessionIncarnation =
      routingSessionUuid === sessionUuid
        ? sessionIncarnation
        : this.getDeviceControlSessionIncarnation(routingSessionUuid);
    const deviceId = this.resolveDeviceControlDeviceId(args, sessionUuid);
    const deviceSessionUuid = this.resolveDeviceControlSessionUuid(deviceId);
    const deviceLabelResolved = this.getDeviceControlLabelResolution(args);
    return {
      sessionUuid,
      sessionIncarnation,
      routingSessionUuid,
      routingSessionIncarnation,
      deviceId,
      deviceSessionUuid,
      deviceLabelResolved,
    };
  }

  private getDeviceControlLabelResolution(args: unknown): boolean | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const record = args as Record<string, unknown>;
    const baseSessionUuid = this.getSessionUuid(record);
    const deviceLabel = record.device;
    if (typeof deviceLabel !== "string" || deviceLabel.length === 0) {
      return undefined;
    }
    if (!baseSessionUuid || !this.daemonState.isInitialized()) {
      return false;
    }
    try {
      const mappedSession = this.daemonState.getSessionManager().getDeviceLabels(baseSessionUuid)?.[
        deviceLabel
      ];
      return typeof mappedSession === "string" && mappedSession.length > 0;
    } catch (error) {
      // A session-manager lookup failure cannot prove the label still maps to a
      // live session, so treat the label as unresolved and fail recovery closed.
      logger.debug(
        `Unable to verify device label ${deviceLabel} for session ${baseSessionUuid}: ${error}`,
      );
      return false;
    }
  }

  private resolveDeviceControlIdentitySession(
    args: unknown,
    routeSessionUuid: string | undefined,
    socketSessionId: string,
  ): string | undefined {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const record = args as Record<string, unknown>;
      const baseSessionUuid = this.getSessionUuid(record);
      if (baseSessionUuid && typeof record.device === "string" && record.device.length > 0) {
        return this.resolveDeviceLabelSession(baseSessionUuid, record.device);
      }
      if (typeof record.deviceId === "string" && record.deviceId.length > 0) {
        return this.getSessionForDevice(record.deviceId);
      }
      if (baseSessionUuid) {
        return baseSessionUuid;
      }
    }
    return routeSessionUuid ?? this.resolveImplicitAutolockSession(socketSessionId, args);
  }

  private getSessionForDevice(deviceId: string): string | undefined {
    if (!this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState.getSessionManager().getSessionForDevice?.(deviceId) ?? undefined;
    } catch (error) {
      // Without a proven device→session mapping the caller must fall back to no
      // session identity rather than guess an owner, so fail closed to undefined.
      logger.debug(`Unable to resolve session for transport device ${deviceId}: ${error}`);
      return undefined;
    }
  }

  private getDeviceControlSessionIncarnation(sessionUuid: string | undefined): object | undefined {
    if (!sessionUuid || !this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid) ?? undefined;
    } catch (error) {
      // A missing incarnation snapshot is safe: downstream owner validation treats
      // an absent incarnation as unverifiable and fails the ownership check closed.
      logger.debug(`Unable to capture device-control session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }

  private resolveDeviceControlDeviceId(args: unknown, sessionUuid?: string): string | undefined {
    if (sessionUuid) {
      const assignedDevice = this.getAssignedDeviceForSession(sessionUuid);
      if (assignedDevice) {
        return assignedDevice;
      }
    }
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const explicitDeviceId = (args as Record<string, unknown>).deviceId;
      if (typeof explicitDeviceId === "string") {
        return explicitDeviceId;
      }
    }
    return undefined;
  }

  private resolveDeviceControlSessionUuid(deviceId?: string): string | undefined {
    if (!deviceId || !this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState
        .getDeviceSessionRegistry()
        .list()
        .find((record) => record.deviceId === deviceId)?.deviceSessionUuid;
    } catch (error) {
      // An unresolved device epoch is safe: device-session validation treats an
      // absent epoch as unestablished and will not admit a replay against it.
      logger.debug(`Unable to resolve transport device epoch for ${deviceId}: ${error}`);
      return undefined;
    }
  }

  private hasEstablishedDeviceControlTransportIdentity(
    identity: DeviceControlTransportIdentity,
  ): boolean {
    return Boolean(identity.deviceId && identity.deviceSessionUuid);
  }

  private isDeviceControlSessionValid(identity: DeviceControlTransportIdentity): boolean {
    if (
      !this.daemonState.isInitialized() ||
      (!identity.sessionUuid && !identity.routingSessionUuid)
    ) {
      return false;
    }
    return (
      this.isDeviceControlTargetOwnerValid(identity) &&
      this.isDeviceControlRoutingSessionValid(identity)
    );
  }

  private isDeviceControlTargetOwnerValid(identity: DeviceControlTransportIdentity): boolean {
    if (!identity.sessionUuid) {
      return true;
    }
    try {
      return isDeviceControlTargetOwnerValid(this.daemonState.getSessionManager(), identity);
    } catch (error) {
      // Ownership must be provable to replay; a lookup failure leaves it unproven,
      // so fail closed to reject the recovery rather than risk a stale-owner replay.
      logger.debug(`Unable to validate device-control target owner: ${error}`);
      return false;
    }
  }

  private isDeviceControlRoutingSessionValid(identity: DeviceControlTransportIdentity): boolean {
    if (!identity.routingSessionUuid || identity.routingSessionUuid === identity.sessionUuid) {
      return true;
    }
    try {
      return isDeviceControlRoutingSessionValid(this.daemonState.getSessionManager(), identity);
    } catch (error) {
      // The routing session's grant must be provable to replay; an unverifiable
      // lookup fails closed so a superseded routing session cannot authorize it.
      logger.debug(`Unable to validate device-control routing session: ${error}`);
      return false;
    }
  }

  private isDeviceControlDeviceSessionValid(identity: DeviceControlTransportIdentity): boolean {
    if (!this.daemonState.isInitialized() || !identity.deviceId || !identity.deviceSessionUuid) {
      return false;
    }
    try {
      const liveDeviceSession = this.daemonState
        .getDeviceSessionRegistry()
        .list()
        .find((record) => record.deviceId === identity.deviceId);
      return liveDeviceSession?.deviceSessionUuid === identity.deviceSessionUuid;
    } catch (error) {
      // A device-epoch lookup failure cannot confirm the captured epoch is still
      // live, so fail closed to block replay against a possibly-recreated device.
      logger.debug(`Unable to validate device-control device epoch: ${error}`);
      return false;
    }
  }

  private isDeviceControlTransportIdentityValid(identity: DeviceControlTransportIdentity): boolean {
    return (
      this.isDeviceControlCapturedSessionIdentityValid(identity) &&
      this.isDeviceControlDeviceSessionValid(identity)
    );
  }

  private isDeviceControlCapturedSessionIdentityValid(
    identity: DeviceControlTransportIdentity,
  ): boolean {
    const hasSessionIdentity = Boolean(identity.sessionUuid || identity.routingSessionUuid);
    return !hasSessionIdentity || this.isDeviceControlSessionValid(identity);
  }

  private isDeviceControlRecoveryIdentityValid(
    identity: DeviceControlTransportIdentity,
    phase: DeviceControlTransportPhase,
  ): boolean {
    if (phase === "connect" && !this.hasEstablishedDeviceControlTransportIdentity(identity)) {
      return this.isDeviceControlCapturedSessionIdentityValid(identity);
    }
    return this.isDeviceControlTransportIdentityValid(identity);
  }

  private isDeviceControlReplayResultIdentityValid(
    identity: DeviceControlTransportIdentity,
  ): boolean {
    return this.hasEstablishedDeviceControlTransportIdentity(identity)
      ? this.isDeviceControlTransportIdentityValid(identity)
      : this.isDeviceControlCapturedSessionIdentityValid(identity);
  }

  private deviceControlTransportError(input: {
    request: DaemonRequest;
    identity: DeviceControlTransportIdentity;
    phase: DeviceControlTransportPhase;
    reconnectAttempted: boolean;
    replayAttempted: boolean;
    recoveryExhausted: boolean;
  }): DeviceControlTransportError {
    const toolName = deviceControlToolName(input.request);
    const sessionValid = this.isDeviceControlSessionValid(input.identity);
    const deviceSessionValid = this.isDeviceControlDeviceSessionValid(input.identity);
    const capturedSessionIdentityValid = this.isDeviceControlCapturedSessionIdentityValid(
      input.identity,
    );
    const identityValid = capturedSessionIdentityValid && deviceSessionValid;
    const identityEstablished = this.hasEstablishedDeviceControlTransportIdentity(input.identity);
    const retryable =
      input.phase === "connect"
        ? capturedSessionIdentityValid && (!identityEstablished || deviceSessionValid)
        : identityValid && isReplaySafeAfterResponseClosure(input.request);
    const failure: DeviceControlTransportFailure = {
      code: DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
      transport: "daemon_loopback_http",
      toolName,
      ...(input.identity.deviceId ? { deviceId: input.identity.deviceId } : {}),
      ...(input.identity.deviceSessionUuid
        ? { deviceSessionUuid: input.identity.deviceSessionUuid }
        : {}),
      ...(input.identity.sessionUuid ? { sessionUuid: input.identity.sessionUuid } : {}),
      ...(input.identity.routingSessionUuid
        ? { routingSessionUuid: input.identity.routingSessionUuid }
        : {}),
      sessionValid,
      deviceSessionValid,
      phase: input.phase,
      retryable,
      reconnectAttempted: input.reconnectAttempted,
      replayAttempted: input.replayAttempted,
    };
    const message = input.recoveryExhausted
      ? `Device-control transport recovery exhausted while handling ${toolName}`
      : `Device-control transport closed while handling ${toolName}`;
    // Preserve replay state/code while sharing the restore diagnosis with push requests.
    return new DeviceControlTransportError(
      this.deviceControlTransportErrorMessage(input.identity, message),
      failure,
    );
  }

  private deviceControlTransportErrorMessage(
    identity: DeviceControlTransportIdentity,
    fallback: string,
  ): string {
    if (!identity.deviceSessionUuid || !this.daemonState.isInitialized()) {
      return fallback;
    }
    const error = createDeviceSessionErrorResolver(
      this.daemonState.getDeviceSessionRegistry(),
    ).getSessionError(identity.deviceSessionUuid);
    return error instanceof DeviceSessionSupersededByRestoreError ? error.message : fallback;
  }

  private remainingMcpForwardBudget(input: { deadline: ProgressExtendableDeadline }): number {
    return input.deadline.value - this.timer.now();
  }

  private async reconnectMcpClientWithinDeadline(input: {
    route: McpForwardRoute;
    deadline: ProgressExtendableDeadline;
    signal?: AbortSignal;
  }): Promise<Client> {
    input.signal?.throwIfAborted();
    const remainingMs = this.remainingMcpForwardBudget(input);
    if (remainingMs <= 0) {
      throw new McpClientReconnectDeadlineError();
    }

    let connection!: Promise<Client>;
    let pendingCreation: Promise<Client> | undefined;
    try {
      const client = await raceWithDeadline(
        () => {
          connection = this.getMcpClient(
            input.route.clientKey,
            input.route.sessionUuid,
            input.route.toolSelectionProfileUuid,
            input.route.releasedSessionUuid,
          );
          // getMcpClient registers its pending creation synchronously, so this
          // snapshot fences cleanup to the attempt this wait started (#5499).
          pendingCreation = this.mcpClientPromises.get(input.route.clientKey);
          return connection;
        },
        {
          timer: this.timer,
          timeoutMs: remainingMs,
          label: "MCP client reconnect",
          timeoutError: () => new McpClientReconnectDeadlineError(),
        },
      );
      // Do not cancel `connection`: it may be shared by a live sibling. This
      // owner simply must not reuse the client after its socket was cancelled.
      input.signal?.throwIfAborted();
      return client;
    } catch (error) {
      if (error instanceof McpClientReconnectDeadlineError) {
        this.discardTimedOutMcpReconnect(input.route.clientKey, connection, pendingCreation);
      }
      throw error;
    }
  }

  private isDeviceControlReconnectExhaustion(request: DaemonRequest, error: unknown): boolean {
    return (
      error instanceof McpClientReconnectDeadlineError ||
      this.isDeviceControlLoopbackTransportFailure(request, error)
    );
  }

  private getDeviceControlRecoveryFailureIdentity(
    context: McpForwardRecoveryContext,
    identity: DeviceControlTransportIdentity,
  ): DeviceControlTransportIdentity {
    const refreshedIdentity = this.getDeviceControlTransportIdentity(context);
    // An incarnation/epoch token only proves ownership as the pair captured with
    // its identity key. Once the original call captured a session UUID (or device
    // id), inheriting a *refreshed* token for that same key would let a session
    // released and recreated on the same device mid-dispatch adopt the replacement
    // incarnation: the unchanged device epoch and replacement session would then
    // pass every recovery check and the request would replay and be accepted after
    // the caller's original ownership ended (issue #5499). So a refreshed token is
    // only inherited when its key was itself absent at capture — i.e. the key and
    // its token arrive together from the same refresh, never mixing a captured key
    // with a post-release token.
    return {
      sessionUuid: identity.sessionUuid ?? refreshedIdentity.sessionUuid,
      sessionIncarnation:
        identity.sessionUuid !== undefined
          ? identity.sessionIncarnation
          : refreshedIdentity.sessionIncarnation,
      routingSessionUuid: identity.routingSessionUuid ?? refreshedIdentity.routingSessionUuid,
      routingSessionIncarnation:
        identity.routingSessionUuid !== undefined
          ? identity.routingSessionIncarnation
          : refreshedIdentity.routingSessionIncarnation,
      deviceId: identity.deviceId ?? refreshedIdentity.deviceId,
      deviceSessionUuid:
        identity.deviceId !== undefined
          ? identity.deviceSessionUuid
          : refreshedIdentity.deviceSessionUuid,
      deviceLabelResolved: identity.deviceLabelResolved ?? refreshedIdentity.deviceLabelResolved,
    };
  }

  private pinDeviceControlRecoveryRequest(
    request: DaemonRequest,
    identity: DeviceControlTransportIdentity,
    phase: DeviceControlTransportPhase,
  ): DaemonRequest {
    const args = request.method === "tools/call" ? request.params?.arguments : undefined;
    if (
      phase !== "response" ||
      !identity.deviceId ||
      identity.deviceLabelResolved === false ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    ) {
      return request;
    }
    return this.pinEstablishedDeviceControlRecoveryRequest(
      request,
      identity,
      args as Record<string, unknown>,
    );
  }

  private pinEstablishedDeviceControlRecoveryRequest(
    request: DaemonRequest,
    identity: DeviceControlTransportIdentity,
    originalArguments: Record<string, unknown>,
  ): DaemonRequest {
    if (identity.deviceLabelResolved === true) {
      const pinnedArguments: Record<string, unknown> = {
        ...originalArguments,
        deviceId: identity.deviceId,
        ...(identity.sessionUuid ? { sessionUuid: identity.sessionUuid } : {}),
      };
      // Preserve the captured execution session while replacing the mutable
      // label selector with the captured physical target.
      delete pinnedArguments.device;
      return {
        ...request,
        params: {
          ...request.params,
          arguments: pinnedArguments,
        },
      };
    }
    if (this.hasStableExplicitDeviceControlTarget(request, identity)) {
      // deviceId is already immutable; retaining the original routing session also
      // preserves its tool-selection grant alongside the target device's grant.
      return request;
    }
    const pinnedArguments: Record<string, unknown> = {
      ...originalArguments,
      ...(identity.sessionUuid
        ? { sessionUuid: identity.sessionUuid }
        : { deviceId: identity.deviceId }),
    };
    // Pin implicit/autolocked recovery to the captured target.
    delete pinnedArguments.device;
    if (identity.sessionUuid) {
      delete pinnedArguments.deviceId;
    }
    return {
      ...request,
      params: {
        ...request.params,
        arguments: pinnedArguments,
      },
    };
  }

  private hasStableExplicitDeviceControlTarget(
    request: DaemonRequest,
    identity: DeviceControlTransportIdentity,
  ): boolean {
    if (identity.deviceLabelResolved === true || request.method !== "tools/call") {
      return false;
    }
    const args = request.params?.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return false;
    }
    const deviceId = (args as Record<string, unknown>).deviceId;
    return typeof deviceId === "string" && deviceId.length > 0;
  }

  private getDeviceControlRecoveryRoute(
    input: DeviceControlTransportRecoveryContext,
    replayAfterResponse: boolean,
  ): McpForwardRoute {
    if (
      replayAfterResponse &&
      input.identity.deviceLabelResolved === true &&
      input.identity.sessionUuid
    ) {
      // Replay the original tool-selection profile verbatim. routingSessionUuid
      // is a session UUID, not a profile: feeding it here would send a bogus
      // tool-selection-profile header (createMcpClient forwards this field on the
      // wire) and drop the generated profile injected by
      // DaemonMcpProxy.withToolSelectionProfile, so a profile-gated tool admitted
      // on the original call would be rejected as disabled on replay (issue #5499).
      return this.sessionScopedForwardRoute(
        input.socketSessionId,
        input.identity.sessionUuid,
        input.route.executionKey,
        input.route.toolSelectionProfileUuid,
      );
    }
    if (
      !replayAfterResponse ||
      !input.identity.sessionUuid ||
      input.route.sessionUuid === input.identity.sessionUuid ||
      this.hasStableExplicitDeviceControlTarget(input.request, input.identity)
    ) {
      return input.route;
    }
    return this.sessionScopedForwardRoute(
      input.socketSessionId,
      input.identity.sessionUuid,
      input.route.executionKey,
      input.route.toolSelectionProfileUuid,
    );
  }

  private scheduleDistinctRecoveryRouteIdleClose(
    originalRoute: McpForwardRoute,
    recoveryRoute: McpForwardRoute,
  ): void {
    if (
      recoveryRoute.clientKey !== originalRoute.clientKey &&
      this.mcpClients.has(recoveryRoute.clientKey)
    ) {
      this.scheduleMcpClientIdleClose(recoveryRoute.clientKey);
    }
  }

  private async reconnectDeviceControlTransport(
    input: DeviceControlTransportRecoveryContext,
  ): Promise<Client> {
    try {
      return await this.reconnectMcpClientWithinDeadline(input);
    } catch (error) {
      if (!this.isDeviceControlReconnectExhaustion(input.request, error)) {
        throw error;
      }
      logger.warn(
        `[McpForward] device-control transport reconnect failed for ${deviceControlToolName(input.request)}`,
      );
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: true,
      });
    }
  }

  private async prepareDeviceControlRecoveryReplay(
    input: DeviceControlTransportRecoveryContext,
    replayAfterResponse: boolean,
  ): Promise<{
    recoveryRoute: McpForwardRoute;
    freshClient: Client;
    retryRemainingMs: number;
  }> {
    const recoveryRoute = this.getDeviceControlRecoveryRoute(input, replayAfterResponse);
    const recoveryInput = { ...input, route: recoveryRoute };
    input.signal?.throwIfAborted();
    const freshClient = await this.reconnectDeviceControlTransport(recoveryInput);
    input.signal?.throwIfAborted();

    const retryRemainingMs = this.remainingMcpForwardBudget(input);
    if (retryRemainingMs <= 0) {
      this.scheduleDistinctRecoveryRouteIdleClose(input.route, recoveryRoute);
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: true,
      });
    }
    if (!this.isDeviceControlRecoveryIdentityValid(input.identity, input.phase)) {
      await this.resetMcpClientIfCurrent(recoveryRoute.clientKey, freshClient, "detach");
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: false,
      });
    }
    if (input.phase === "response" && !replayAfterResponse) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: false,
      });
    }
    return { recoveryRoute, freshClient, retryRemainingMs };
  }

  private async recoverDeviceControlTransport(
    input: DeviceControlTransportRecoveryContext,
  ): Promise<unknown> {
    input.signal?.throwIfAborted();
    if (input.failedClient) {
      await this.resetMcpClientIfCurrent(input.route.clientKey, input.failedClient, "detach");
    }
    input.signal?.throwIfAborted();
    if (!this.isDeviceControlRecoveryIdentityValid(input.identity, input.phase)) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: false,
        replayAttempted: false,
        recoveryExhausted: false,
      });
    }

    const replayAfterResponse =
      input.phase === "response" && isReplaySafeAfterResponseClosure(input.request);
    logger.warn(
      `[McpForward] device-control loopback transport failed for ${deviceControlToolName(input.request)} during ${input.phase}; reconnecting once`,
    );
    if (this.remainingMcpForwardBudget(input) <= 0) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: false,
        replayAttempted: false,
        recoveryExhausted: true,
      });
    }

    const { recoveryRoute, freshClient, retryRemainingMs } =
      await this.prepareDeviceControlRecoveryReplay(input, replayAfterResponse);

    try {
      const recoveryRequest = this.pinDeviceControlRecoveryRequest(
        input.request,
        input.identity,
        input.phase,
      );
      const response = await this.handleIdeRequest(
        freshClient,
        recoveryRequest,
        retryRemainingMs,
        input.socketSessionId,
        input.deadline,
        input.totalTimeoutMs,
        input.signal,
      );
      if (!this.isDeviceControlReplayResultIdentityValid(input.identity)) {
        await this.resetMcpClientIfCurrent(recoveryRoute.clientKey, freshClient, "detach");
        throw this.deviceControlTransportError({
          request: input.request,
          identity: input.identity,
          phase: input.phase,
          reconnectAttempted: true,
          replayAttempted: replayAfterResponse,
          recoveryExhausted: false,
        });
      }
      return response;
    } catch (error) {
      if (!isLoopbackTransportFailure(error)) {
        throw error;
      }
      await this.resetMcpClientIfCurrent(recoveryRoute.clientKey, freshClient, "detach");
      const failureIdentity = this.getDeviceControlRecoveryFailureIdentity(input, input.identity);
      throw this.deviceControlTransportError({
        request: input.request,
        identity: failureIdentity,
        phase: "response",
        reconnectAttempted: true,
        replayAttempted: replayAfterResponse,
        recoveryExhausted: true,
      });
    } finally {
      this.scheduleDistinctRecoveryRouteIdleClose(input.route, recoveryRoute);
    }
  }

  private wasRequestSessionActive(request: DaemonRequest): boolean {
    const sessionUuid =
      request.method === "tools/call" ? this.getSessionUuid(request.params?.arguments) : undefined;
    return sessionUuid ? this.hasActiveDaemonSession(sessionUuid) : false;
  }

  // Keep MCP route bindings through teardown; downstream tool admission waits for
  // release to finish so bound-session loss retains the terminal release reason.
  private hasActiveDaemonSession(sessionUuid: string): boolean {
    if (!this.daemonState.isInitialized()) {
      return false;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid) !== null;
    } catch (error) {
      logger.warn(`Unable to resolve bound session ${sessionUuid}: ${errorMessage(error)}`, error);
      throw new ReleasedBoundSessionError({
        code: BOUND_SESSION_LOSS_CODE,
        sessionUuid,
        reason: "session-not-found",
      });
    }
  }

  private getSessionUuid(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const sessionUuid = (args as Record<string, unknown>).sessionUuid;
    return isNonBlankSessionUuid(sessionUuid) ? sessionUuid : undefined;
  }

  private isReleasedBoundSession(args: unknown): boolean {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !this.daemonState.isInitialized()
    ) {
      return false;
    }
    const record = args as Record<string, unknown>;
    const sessionUuid = this.getSessionUuid(record);
    return (
      sessionUuid !== undefined &&
      record[DAEMON_BOUND_SESSION_PARAM] === sessionUuid &&
      !this.hasActiveDaemonSession(sessionUuid)
    );
  }

  private boundSessionAdmissionArgs(request: DaemonRequest): unknown {
    const sessionUuid = this.getSessionUuid(request.params);
    return request.method === "resources/read" &&
      sessionUuid !== undefined &&
      request.params?.[DAEMON_RELEASED_SESSION_PARAM] === sessionUuid &&
      request.params?.uri === `automobile:device-session/${sessionUuid}/screenshot`
      ? undefined
      : request.params;
  }

  private withAdmittedBoundSession<T>(
    args: unknown,
    forward: (recoverableSessionUuid?: string) => T,
  ): T | Promise<T> {
    if (!this.isReleasedBoundSession(args)) {
      // Keep healthy routing and forwarding synchronous up to the existing I/O.
      return forward();
    }
    const sessionUuid = this.getSessionUuid(args)!;
    return this.admitReleasedBoundSession(sessionUuid).then(() => forward(sessionUuid));
  }

  private async admitReleasedBoundSession(sessionUuid: string): Promise<void> {
    try {
      if (
        await this.daemonState
          .getSessionManager()
          .isReleasedSessionInRestartRecoveryWindow?.(sessionUuid)
      ) {
        return;
      }
    } catch (error) {
      logger.warn(
        `Unable to read restart recovery window for bound session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
    }
    const release = this.daemonState.getSessionManager().getTerminalReleaseSnapshot?.(sessionUuid);
    throw new ReleasedBoundSessionError({
      code: BOUND_SESSION_LOSS_CODE,
      sessionUuid,
      reason: release?.releaseReason ?? "session-not-found",
      ...(release ? { release } : {}),
    });
  }

  private getRequestArgumentScopeKey(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }

    return this.getObjectRequestArgumentScopeKey(args as Record<string, unknown>, args);
  }

  private getObjectRequestArgumentScopeKey(
    record: Record<string, unknown>,
    args: object,
  ): string | undefined {
    const hasSessionUuid = isNonBlankSessionUuid(record.sessionUuid);
    const hasDeviceLabel = typeof record.device === "string" && record.device.length > 0;

    // Precedence (pinned by #2565 review): a device label resolves the mapped session before
    // an explicit deviceId, which in turn beats a raw session, which beats implicit autolock.
    if (hasSessionUuid && hasDeviceLabel) {
      return this.sessionToScopeKey(
        this.resolveDeviceLabelSession(record.sessionUuid as string, record.device),
      );
    }
    // An explicit target device must serialize by physical device even when a session is present.
    if (typeof record.deviceId === "string" && record.deviceId.length > 0) {
      return `device:${record.deviceId}`;
    }
    if (hasSessionUuid) {
      return this.sessionToScopeKey(record.sessionUuid as string);
    }
    if (typeof record.__mcpSessionId === "string" && record.__mcpSessionId.length > 0) {
      return (
        this.getImplicitAutolockScopeKey(record.__mcpSessionId, args) ??
        `mcp-session:${record.__mcpSessionId}`
      );
    }
    return undefined;
  }

  /**
   * Resolve a session UUID to its forwarding scope key: the bound physical device when one is
   * assigned (so independent devices serialize together), otherwise the raw session. This is the
   * single resolver every session-keyed branch feeds, including implicit autolock resolution.
   */
  private sessionToScopeKey(sessionUuid: string): string {
    const assignedDevice = this.getAssignedDeviceForSession(sessionUuid);
    return assignedDevice ? `device:${assignedDevice}` : `session:${sessionUuid}`;
  }

  private getImplicitAutolockScopeKey(mcpSessionId: string, args: unknown): string | undefined {
    const autolockSession = this.resolveImplicitAutolockSession(mcpSessionId, args);
    return autolockSession ? this.sessionToScopeKey(autolockSession) : undefined;
  }

  private resolveImplicitAutolockSession(mcpSessionId: string, args: unknown): string | undefined {
    if (!this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      const platform = this.getRequestPlatform(args);
      const autolockSession = this.daemonState
        .getDevicePool()
        .resolveAutolockSessionForMcpSession?.(mcpSessionId, platform);
      if (!autolockSession) {
        return undefined;
      }
      return autolockSession;
    } catch (error) {
      logger.debug(`Unable to resolve autolock session for MCP session ${mcpSessionId}: ${error}`);
      return undefined;
    }
  }

  private getRequestPlatform(args: unknown): "android" | "ios" | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const platform = (args as Record<string, unknown>).platform;
    return platform === "android" || platform === "ios" ? platform : undefined;
  }

  private resolveDeviceLabelSession(baseSessionUuid: string, deviceLabel: unknown): string {
    if (
      typeof deviceLabel !== "string" ||
      deviceLabel.length === 0 ||
      !this.daemonState.isInitialized()
    ) {
      return baseSessionUuid;
    }
    try {
      const labelMap = this.daemonState.getSessionManager().getDeviceLabels(baseSessionUuid);
      if (!labelMap) {
        return baseSessionUuid;
      }
      const mappedSession = labelMap[deviceLabel];
      return typeof mappedSession === "string" && mappedSession.length > 0
        ? mappedSession
        : baseSessionUuid;
    } catch (error) {
      logger.debug(
        `Unable to resolve device label ${deviceLabel} for session ${baseSessionUuid}: ${error}`,
      );
      return baseSessionUuid;
    }
  }

  private getAssignedDeviceForSession(sessionUuid: string): string | undefined {
    if (!this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid)?.assignedDevice;
    } catch (error) {
      logger.debug(`Unable to resolve device for session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }

  /** Compact label for debug logs (method + tool name or resource URI). */
  private static describeMcpForwardRequest(request: DaemonRequest): string {
    if (request.method === "tools/call") {
      const name = request.params?.name;
      return `method=tools/call tool=${typeof name === "string" ? name : "?"}`;
    }
    if (request.method === "resources/read") {
      const uri = request.params?.uri;
      return `method=resources/read uri=${typeof uri === "string" ? uri : "?"}`;
    }
    return `method=${request.method}`;
  }

  /**
   * Handle socket requests that don't require the MCP client.
   * Returns undefined if the request should be forwarded to MCP.
   */
  private prepareDaemonRestart(params: Record<string, unknown>): DaemonRestartPreparation {
    if (!this.daemonGenerationMatches(params)) {
      return {
        accepted: false,
        reason: "generation_changed",
      };
    }
    const admission = executionTracker.prepareForDaemonRestart();
    if (admission !== "accepted") {
      return {
        accepted: false,
        reason: admission,
      };
    }
    if (!this.onRestartAccepted) {
      executionTracker.clearDaemonRestartPreparation();
      return {
        accepted: false,
        reason: "shutdown_unavailable",
      };
    }
    try {
      this.onRestartAccepted();
      return { accepted: true };
    } catch (error) {
      logger.warn("Failed to initiate an admitted daemon restart", error);
      executionTracker.clearDaemonRestartPreparation();
      return {
        accepted: false,
        reason: "shutdown_unavailable",
      };
    }
  }

  private daemonGenerationMatches(params: Record<string, unknown>): boolean {
    return daemonGenerationMatches(
      {
        pid: process.pid,
        startedAt: this.identityStartedAt,
        ...(this.processGenerationToken === undefined
          ? {}
          : { processGenerationToken: this.processGenerationToken }),
        version: this.daemonIdentity.version,
        buildId: this.daemonIdentity.build.buildId,
        entryScript: this.daemonIdentity.build.entryScript,
      },
      params,
    );
  }

  /** Local admin RPC, generation-bound; publication never reserves tool admission. */
  private async republishDaemonIdentity(
    params: Record<string, unknown>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (
      !this.daemonGenerationMatches(params) ||
      recordedProcessGenerationToken(params) !== this.processGenerationToken ||
      params.processStartedAt !== this.identityProcessStartedAt
    ) {
      return { accepted: false, reason: "generation_changed" };
    }
    if (this.identityRepublishInFlight) {
      return this.identityRepublishInFlight;
    }
    this.identityRepublishInFlight = this.publishIdentity();
    try {
      return await this.identityRepublishInFlight;
    } finally {
      this.identityRepublishInFlight = undefined;
    }
  }

  private async publishIdentity(): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.onRepublishIdentity) {
      return { accepted: false, reason: "republish_unavailable" };
    }
    try {
      const accepted = await this.onRepublishIdentity();
      return accepted ? { accepted: true } : { accepted: false, reason: "startup_pending" };
    } catch (error) {
      logger.warn("Failed to republish daemon identity", error);
      return { accepted: false, reason: "republish_failed" };
    }
  }

  private prepareDaemonMaintenance(params: Record<string, unknown>): DaemonMaintenancePreparation {
    if (!this.daemonGenerationMatches(params)) {
      return { accepted: false, reason: "generation_changed" };
    }
    this.expireDaemonMaintenanceAdmission();
    const sessions = this.daemonState.getSessionManager().getAllSessions?.();
    if (!sessions) {
      return { accepted: false, reason: "sessions_unavailable" };
    }
    const activeSessions = sessions.length;
    const admission = executionTracker.prepareForDaemonMaintenance(activeSessions);
    if (admission !== "accepted") {
      return { accepted: false, reason: admission };
    }
    const maintenanceToken = this.idGenerator.next();
    this.maintenanceAdmissionToken = maintenanceToken;
    this.maintenanceAdmissionExpiresAt = this.timer.now() + DAEMON_MAINTENANCE_ADMISSION_TTL_MS;
    this.maintenanceAdmissionExpiryTimer = this.timer.setTimeout(
      () => this.releaseDaemonMaintenanceAdmission(maintenanceToken),
      DAEMON_MAINTENANCE_ADMISSION_TTL_MS,
    );
    this.maintenanceAdmissionAbortController = new AbortController();
    this.maintenanceRestartConsumed = false;
    return { accepted: true, maintenanceToken };
  }

  private completeDaemonMaintenance(params: Record<string, unknown>): {
    completed: boolean;
  } {
    if (
      !this.daemonGenerationMatches(params) ||
      !this.daemonMaintenanceAdmissionMatches(params.maintenanceToken)
    ) {
      return { completed: false };
    }
    this.releaseDaemonMaintenanceAdmission(params.maintenanceToken);
    return { completed: true };
  }

  private daemonMaintenanceAdmissionMatches(token: unknown): token is string {
    this.expireDaemonMaintenanceAdmission();
    return (
      typeof token === "string" &&
      this.maintenanceAdmissionToken !== undefined &&
      token === this.maintenanceAdmissionToken
    );
  }

  private expireDaemonMaintenanceAdmission(): void {
    if (
      this.maintenanceAdmissionToken !== undefined &&
      this.maintenanceAdmissionExpiresAt !== undefined &&
      this.maintenanceAdmissionExpiresAt <= this.timer.now()
    ) {
      this.releaseDaemonMaintenanceAdmission(this.maintenanceAdmissionToken);
    }
  }

  private releaseDaemonMaintenanceAdmission(token: unknown): void {
    if (
      typeof token !== "string" ||
      this.maintenanceAdmissionToken === undefined ||
      token !== this.maintenanceAdmissionToken
    ) {
      return;
    }
    if (this.maintenanceAdmissionExpiryTimer !== undefined) {
      this.timer.clearTimeout(this.maintenanceAdmissionExpiryTimer);
    }
    this.maintenanceAdmissionAbortController?.abort(
      new Error("Daemon maintenance admission expired or was released"),
    );
    executionTracker.clearDaemonMaintenancePreparation();
    this.maintenanceAdmissionToken = undefined;
    this.maintenanceAdmissionExpiresAt = undefined;
    this.maintenanceAdmissionExpiryTimer = undefined;
    this.maintenanceAdmissionAbortController = undefined;
    this.maintenanceRestartConsumed = false;
  }

  private restartAdmittedDaemon(params: Record<string, unknown>): DaemonAdmittedRestart {
    if (!this.daemonGenerationMatches(params)) {
      return { accepted: false, reason: "generation_changed" };
    }
    if (!this.daemonMaintenanceAdmissionMatches(params.maintenanceToken)) {
      return { accepted: false, reason: "maintenance_token_invalid" };
    }
    if (this.maintenanceRestartConsumed) {
      return { accepted: false, reason: "maintenance_token_consumed" };
    }
    const sessions = this.daemonState.getSessionManager().getAllSessions?.();
    if (!sessions) {
      return { accepted: false, reason: "sessions_unavailable" };
    }
    if (sessions.length > 0) {
      return { accepted: false, reason: "active_sessions" };
    }
    const admission = executionTracker.prepareForAdmittedDaemonRestart();
    if (admission !== "accepted") {
      return { accepted: false, reason: admission };
    }
    if (!this.onRestartAccepted) {
      executionTracker.clearDaemonRestartPreparation();
      return { accepted: false, reason: "shutdown_unavailable" };
    }
    this.maintenanceRestartConsumed = true;
    try {
      this.onRestartAccepted();
      return { accepted: true };
    } catch (error) {
      logger.warn("Failed to initiate a maintenance-admitted daemon restart", error);
      executionTracker.clearDaemonRestartPreparation();
      return { accepted: false, reason: "shutdown_unavailable" };
    }
  }

  /**
   * Acceptance-only crash admission for one persisted session. Unlike host
   * maintenance, this intentionally permits exactly the signed session to
   * survive in storage so the successor must prove stable-identity recovery.
   * It never touches a device; the manager kills only this verified daemon
   * generation after this RPC returns.
   */
  // eslint-disable-next-line complexity -- each refusal is a distinct security fence for this one-shot control RPC.
  private restartAcceptanceSession(
    params: Record<string, unknown>,
    ownerSessionId: string | undefined,
  ): DaemonAcceptanceSessionRestart {
    if (!this.daemonGenerationMatches(params)) {
      return { accepted: false, reason: "generation_changed" };
    }
    if (ownerSessionId === undefined) {
      return { accepted: false, reason: "restart_pending" };
    }
    this.expireAcceptanceRestartAdmission();
    const scope = this.acceptanceSessionRestartScope(params.scope);
    if (!scope) {
      return { accepted: false, reason: "scope_invalid" };
    }
    if (scope.expiresAt <= this.timer.now()) {
      return { accepted: false, reason: "scope_expired" };
    }
    const identity: DaemonGenerationIdentity = {
      pid: process.pid,
      startedAt: this.identityStartedAt,
      ...(this.processGenerationToken === undefined
        ? {}
        : { processGenerationToken: this.processGenerationToken }),
      version: this.daemonIdentity.version,
      buildId: this.daemonIdentity.build.buildId,
      entryScript: this.daemonIdentity.build.entryScript,
    };
    if (
      !daemonLiveAcceptanceScopedCapabilityMatches(
        this.liveAcceptanceStartupSecret,
        identity,
        scope,
        params.acceptanceCapability,
      )
    ) {
      return { accepted: false, reason: "acceptance_capability_invalid" };
    }
    const sessions = this.daemonState.getSessionManager().getAllSessions?.();
    if (!sessions) {
      return { accepted: false, reason: "session_not_found" };
    }
    const session = sessions.find((candidate) => candidate.sessionId === scope.sessionUuid);
    if (!session) {
      return { accepted: false, reason: "session_not_found" };
    }
    if (
      session.platform !== scope.platform ||
      session.stableDeviceId !== scope.stableDeviceId ||
      sessions.length !== 1
    ) {
      return {
        accepted: false,
        reason:
          sessions.length !== 1 &&
          sessions.some((candidate) => candidate.sessionId !== scope.sessionUuid)
            ? "unrelated_sessions"
            : "session_identity_mismatch",
      };
    }
    const admission = executionTracker.prepareForDaemonRestart();
    if (admission !== "accepted") {
      return {
        accepted: false,
        reason: admission === "active_operations" ? "active_operations" : "restart_pending",
      };
    }
    const restartToken = this.idGenerator.next();
    const admissionTtlMs = Math.min(
      DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS,
      scope.expiresAt - this.timer.now(),
    );
    this.acceptanceRestartAdmissionToken = restartToken;
    this.acceptanceRestartAdmissionOwnerSessionId = ownerSessionId;
    this.acceptanceRestartAdmissionCommitted = false;
    this.acceptanceRestartAdmissionExpiresAt = this.timer.now() + admissionTtlMs;
    this.acceptanceRestartAdmissionExpiryTimer = this.timer.setTimeout(
      () => this.releaseAcceptanceRestartAdmission(restartToken),
      admissionTtlMs,
    );
    // Graceful shutdown would terminally release the persisted session. The
    // manager commits the token before SIGKILL. Disconnect rolls back only an
    // uncommitted fence; after commit the lease keeps new work fenced through
    // the signal even if the control socket drops.
    return { accepted: true, restartToken };
  }

  private releaseAcceptanceRestart(
    params: Record<string, unknown>,
    ownerSessionId: string | undefined,
  ): DaemonAcceptanceRestartRelease {
    if (
      !this.daemonGenerationMatches(params) ||
      !this.acceptanceRestartAdmissionMatches(params.restartToken, ownerSessionId)
    ) {
      return { released: false };
    }
    this.releaseAcceptanceRestartAdmission(params.restartToken);
    return { released: true };
  }

  private commitAcceptanceRestart(
    params: Record<string, unknown>,
    ownerSessionId: string | undefined,
  ): DaemonAcceptanceRestartCommit {
    if (
      !this.daemonGenerationMatches(params) ||
      !this.acceptanceRestartAdmissionMatches(params.restartToken, ownerSessionId)
    ) {
      return { committed: false };
    }
    this.acceptanceRestartAdmissionCommitted = true;
    return { committed: true };
  }

  private acceptanceRestartAdmissionMatches(
    token: unknown,
    ownerSessionId: string | undefined,
  ): token is string {
    this.expireAcceptanceRestartAdmission();
    return (
      typeof token === "string" &&
      ownerSessionId !== undefined &&
      token === this.acceptanceRestartAdmissionToken &&
      ownerSessionId === this.acceptanceRestartAdmissionOwnerSessionId
    );
  }

  private expireAcceptanceRestartAdmission(): void {
    if (
      this.acceptanceRestartAdmissionToken !== undefined &&
      this.acceptanceRestartAdmissionExpiresAt !== undefined &&
      this.acceptanceRestartAdmissionExpiresAt <= this.timer.now()
    ) {
      this.releaseAcceptanceRestartAdmission(this.acceptanceRestartAdmissionToken);
    }
  }

  private releaseAcceptanceRestartAdmissionForOwner(ownerSessionId: string): void {
    if (
      this.acceptanceRestartAdmissionCommitted ||
      ownerSessionId !== this.acceptanceRestartAdmissionOwnerSessionId
    ) {
      return;
    }
    this.releaseAcceptanceRestartAdmission(this.acceptanceRestartAdmissionToken);
  }

  private releaseAcceptanceRestartAdmission(token: unknown): void {
    if (typeof token !== "string" || token !== this.acceptanceRestartAdmissionToken) {
      return;
    }
    if (this.acceptanceRestartAdmissionExpiryTimer !== undefined) {
      this.timer.clearTimeout(this.acceptanceRestartAdmissionExpiryTimer);
    }
    executionTracker.clearDaemonRestartPreparation();
    this.acceptanceRestartAdmissionToken = undefined;
    this.acceptanceRestartAdmissionOwnerSessionId = undefined;
    this.acceptanceRestartAdmissionCommitted = false;
    this.acceptanceRestartAdmissionExpiresAt = undefined;
    this.acceptanceRestartAdmissionExpiryTimer = undefined;
  }

  // eslint-disable-next-line complexity -- validate every untrusted scope field before HMAC authorization.
  private acceptanceSessionRestartScope(value: unknown): AcceptanceSessionRestartScope | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const scope = value as Partial<AcceptanceSessionRestartScope>;
    const controls = scope.controls;
    if (
      typeof scope.sessionUuid !== "string" ||
      scope.sessionUuid.length === 0 ||
      (scope.platform !== "android" && scope.platform !== "ios") ||
      typeof scope.stableDeviceId !== "string" ||
      scope.stableDeviceId.length === 0 ||
      typeof scope.expiresAt !== "number" ||
      !Number.isFinite(scope.expiresAt) ||
      !controls ||
      typeof controls !== "object" ||
      typeof controls.androidSiblingAvdName !== "string" ||
      typeof controls.androidDuplicateSerial !== "string" ||
      typeof controls.iosSameNameSiblingUdid !== "string"
    ) {
      return undefined;
    }
    return {
      sessionUuid: scope.sessionUuid,
      platform: scope.platform,
      stableDeviceId: scope.stableDeviceId,
      controls: {
        androidSiblingAvdName: controls.androidSiblingAvdName,
        androidDuplicateSerial: controls.androidDuplicateSerial,
        iosSameNameSiblingUdid: controls.iosSameNameSiblingUdid,
      },
      expiresAt: scope.expiresAt,
    };
  }

  private requireFeatureFlagService(): FeatureFlagService {
    if (!this.featureFlagService) {
      throw new Error("Feature flag service not available");
    }
    return this.featureFlagService;
  }

  /**
   * `input/*` frames get the same owner fence as forwarded MCP calls: a signal that aborts on
   * socket close and on `daemon/cancelRequest`, and a budget that runs from receipt (#10006).
   * Other local requests run unfenced, as before.
   */
  private async runLocalSocketRequest(
    request: DaemonRequest,
    sessionId: string,
    ownerSocket: Socket,
    cancelSignal: AbortSignal,
    receivedAtMs: number,
    onOwnerSignal: (signal: AbortSignal) => void,
  ): Promise<unknown> {
    if (!request.method.startsWith("input/")) {
      return await this.handleLocalSocketRequest(request, sessionId);
    }
    const owner = this.mcpRequestSignal(sessionId, ownerSocket, cancelSignal);
    onOwnerSignal(owner.signal);
    try {
      return await this.handleLocalSocketRequest(request, sessionId, owner.signal, receivedAtMs);
    } finally {
      owner.dispose();
    }
  }

  private async handleLocalSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
    signal?: AbortSignal,
    receivedAtMs?: number,
  ): Promise<any | undefined> {
    if (request.method.startsWith("input/")) {
      // A frame whose socket closed or whose client cancelled it while it sat in the socket
      // queue must not even resolve a device (#10006).
      signal?.throwIfAborted();
    }
    const input: InputRequestContext = {
      signal,
      receivedAtMs,
      requester: request.method.startsWith("input/")
        ? this.inputRequester(request, socketSessionId)
        : undefined,
    };
    if (request.method === "input/tap") {
      return await this.handleInputTap(request, socketSessionId, input);
    }
    if (request.method === "input/swipe") {
      return await this.handleInputSwipe(request, socketSessionId, input);
    }
    if (request.method === "input/typeText") {
      return await this.handleInputTypeText(request, socketSessionId, input);
    }
    if (request.method === "input/pressButton") {
      return await this.handleInputPressButton(request, socketSessionId, input);
    }
    if (request.method === "input/key") {
      return await this.handleInputKey(request, socketSessionId, input);
    }
    if (request.method === "input/gestureStart") {
      return await this.handleInputGesture(request, "start", socketSessionId, input);
    }
    if (request.method === "input/gestureMove") {
      return await this.handleInputGesture(request, "move", socketSessionId, input);
    }
    if (request.method === "input/gestureEnd") {
      return await this.handleInputGesture(request, "end", socketSessionId, input);
    }

    switch (request.method) {
      case "ide/listFeatureFlags": {
        const flags = await this.requireFeatureFlagService().listFlags();
        return { flags };
      }
      case "ide/setFeatureFlag": {
        const featureFlagService = this.requireFeatureFlagService();
        const args = request.params as {
          key?: string;
          enabled?: boolean;
          config?: Record<string, unknown> | null;
        };
        if (!args.key || typeof args.enabled !== "boolean") {
          throw new Error("setFeatureFlag requires 'key' (string) and 'enabled' (boolean) params");
        }
        const updated = await featureFlagService.setFlag(
          args.key as FeatureFlagKey,
          args.enabled,
          args.config,
        );
        return updated;
      }
      case "ide/setSessionToolEnabled": {
        const args = request.params as {
          sessionUuid?: string;
          toolName?: string;
          enabled?: boolean;
        };
        if (
          !args.sessionUuid ||
          !args.toolName ||
          !ToolRegistry.isUserConfigurableTool(args.toolName) ||
          typeof args.enabled !== "boolean"
        ) {
          throw new Error(
            "setSessionToolEnabled requires sessionUuid, a user-configurable toolName, and enabled boolean params",
          );
        }
        await (this.sessionToolSelectionService ?? getSessionToolSelectionService()).setEnabled(
          args.sessionUuid,
          args.toolName,
          args.enabled,
        );
        ListChangedBroadcaster.emit("tools");
        return {
          sessionUuid: args.sessionUuid,
          toolName: args.toolName,
          enabled: args.enabled,
        };
      }
      case "ide/ping": {
        return { ok: true, timestamp: this.timer.now() };
      }
      case DAEMON_REPUBLISH_IDENTITY_METHOD: {
        return await this.republishDaemonIdentity(request.params);
      }
      case DAEMON_PREPARE_RESTART_METHOD: {
        return this.prepareDaemonRestart(request.params);
      }
      case DAEMON_PREPARE_MAINTENANCE_METHOD: {
        return this.prepareDaemonMaintenance(request.params);
      }
      case DAEMON_COMPLETE_MAINTENANCE_METHOD: {
        return this.completeDaemonMaintenance(request.params);
      }
      case DAEMON_RESTART_ADMITTED_METHOD: {
        return this.restartAdmittedDaemon(request.params);
      }
      case DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD: {
        return this.restartAcceptanceSession(request.params, socketSessionId);
      }
      case DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD: {
        return this.commitAcceptanceRestart(request.params, socketSessionId);
      }
      case DAEMON_RELEASE_ACCEPTANCE_RESTART_METHOD: {
        return this.releaseAcceptanceRestart(request.params, socketSessionId);
      }
      case "ide/status": {
        return {
          structuredSessionNotFound: true,
          // Concrete pinned version (honors AUTOMOBILE_VERSION), never the
          // floating "latest" tag — external consumers must see exactly what the
          // daemon will fetch (#2746).
          version: this.daemonIdentity.version,
          pid: process.pid,
          buildId: this.daemonIdentity.build.buildId,
          entryScript: this.daemonIdentity.build.entryScript,
          acceptanceCapabilityFingerprint: this.acceptanceDiscoveryCapability
            ? createHash("sha256")
                .update(this.acceptanceDiscoveryCapability)
                .digest("hex")
                .slice(0, 8)
            : null,
          startedAt: this.identityStartedAt,
          processStartedAt: this.identityProcessStartedAt,
          dbPath: this.identityDbPath,
          reportedPidFilePath: this.identityPidFilePath,
          reportedSocketPath: this.socketPath,
          reportedSockets: this.identitySockets,
          effectiveDebug: isDebugModeEnabled(),
          options: this.startupOptions,
          ...processGenerationRecordFields(this.processGenerationToken),
          activeProvisioning: executionTracker.hasActiveToolExecution("provisionDevice", {
            scope: "global",
          }),
          releaseVersion: resolveAssetVersion(resolvePinnedVersion()),
          android: {
            ctrlProxy: {
              expectedSha256: resolveApkChecksum(),
              url: resolveApkUrl(),
            },
          },
          ios: {
            xcTestService: {
              expectedSha256: resolveIpaChecksum(),
              expectedAppHash: IOS_CTRL_PROXY_APP_HASH,
              url: resolveIpaUrl(),
            },
          },
        };
      }
      case "ide/updateService": {
        const args = request.params as { deviceId?: string; platform?: string };
        if (!args.deviceId || !args.platform) {
          throw new Error(
            "updateService requires 'deviceId' (string) and 'platform' (string) params",
          );
        }
        if (args.platform !== "android" && args.platform !== "ios") {
          throw new Error(`Invalid platform: ${args.platform}. Must be 'android' or 'ios'.`);
        }

        // Find the booted device
        const bootedDevices = await this.listBootedDevicesForIdeAction(
          args.platform,
          args.deviceId,
        );
        // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
        await this.reconcileDiscoveryObservation(bootedDevices, "socket:ide/updateService");
        this.assertDeviceActionable(args.deviceId, "to update the accessibility service");
        const targetDevice = bootedDevices.find((d) => d.deviceId === args.deviceId);
        if (!targetDevice) {
          throw new Error(`Device not found: ${args.deviceId}`);
        }
        if (await this.daemonState.getDevicePool().isShutdownReserved?.(targetDevice.deviceId)) {
          throw new Error(`Device '${targetDevice.deviceId}' is shutting down.`);
        }
        // A lifecycle action on a held device: only the holder, or an explicit `force` (as
        // killDevice allows), may reinstall/restart its CtrlProxy (#10827).
        this.assertIdeMutationOwnership(
          request,
          targetDevice.deviceId,
          "ide/updateService",
          (request.params as { force?: unknown }).force === true,
        );

        if (args.platform === "android") {
          AndroidCtrlProxyClient.resumeAfterDeviceStart(targetDevice.deviceId);
          const manager = AndroidCtrlProxyManager.getInstance(targetDevice);
          const result = await manager.ensureCompatibleVersion({
            allowDownloadWhenInstalled: true,
            bypassVersionCheckCache: true,
          });
          const successStatuses = new Set(["compatible", "upgraded", "installed", "reinstalled"]);
          return {
            success: successStatuses.has(result.status),
            message: `Accessibility service ${result.status}${result.error ? `: ${result.error}` : ""}`,
            status: result,
          };
        } else {
          const manager = IOSCtrlProxyManager.getInstance(targetDevice);
          IOSCtrlProxyClient.resumeAfterDeviceStart(targetDevice.deviceId);
          await manager.forceRestart();
          return {
            success: true,
            message: "CtrlProxy iOS restarted",
          };
        }
      }
      case "ide/setKeyValue": {
        const args = request.params as {
          platform?: string;
          deviceId?: string;
          appId?: string;
          fileName?: string;
          key?: string;
          value?: string | null;
          type?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName || !args.key || !args.type) {
          throw new Error("setKeyValue requires deviceId, appId, fileName, key, and type params");
        }
        await this.assertSocketToolEnabled(args.deviceId, "setKeyValue");
        const { platform, client, device } = await this.resolveKeyValueMutationClient(
          args.platform,
          args.deviceId,
          request,
          "ide/setKeyValue",
        );
        const appId = args.appId;
        const fileName = args.fileName;
        const key = args.key;
        let usedDirectFileFallback = false;
        let resolution: PreferenceStoreResolution | undefined;
        if (args.value === null || args.value === undefined) {
          ({ usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
            platform,
            device,
            appId,
            fileName,
            () => client.removePreference(appId, fileName, key),
            (adb) => removeAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key),
          ));
        } else {
          // Enforce the same cross-platform type guidance as the MCP-tool path
          // (storageTools.ts) before dispatch, so a platform-incompatible type
          // fails with an actionable error rather than deeper in the client (#5022).
          validateTypeForPlatform(platform, args.type as KeyValueType);
          const value = args.value;
          const type = args.type as KeyValueType;
          ({ usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
            platform,
            device,
            appId,
            fileName,
            () => client.setPreference(appId, fileName, key, value, type),
            (adb) =>
              setAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key, value, type),
          ));
        }
        const resolvedStore = resolution?.resolvedStore;
        const effectiveValueDiffers = resolution?.effectiveValueDiffers;
        const warning = preferenceSetWarning(
          usedDirectFileFallback ? directFileFallbackRelaunchWarning(appId, fileName) : undefined,
          effectiveValueDiffers,
        );
        return {
          success: true,
          ...(resolvedStore ? { resolvedStore } : {}),
          ...(effectiveValueDiffers ? { effectiveValueDiffers } : {}),
          ...(warning ? { warning } : {}),
        };
      }
      case "ide/removeKeyValue": {
        const args = request.params as {
          platform?: string;
          deviceId?: string;
          appId?: string;
          fileName?: string;
          key?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName || !args.key) {
          throw new Error("removeKeyValue requires deviceId, appId, fileName, and key params");
        }
        await this.assertSocketToolEnabled(args.deviceId, "removeKeyValue");
        const { platform, client, device } = await this.resolveKeyValueMutationClient(
          args.platform,
          args.deviceId,
          request,
          "ide/removeKeyValue",
        );
        const appId = args.appId;
        const fileName = args.fileName;
        const key = args.key;
        const { usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
          platform,
          device,
          appId,
          fileName,
          () => client.removePreference(appId, fileName, key),
          (adb) => removeAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key),
        );
        const resolvedStore = resolution?.resolvedStore;
        const warning = usedDirectFileFallback
          ? directFileFallbackRelaunchWarning(appId, fileName)
          : undefined;
        return {
          success: true,
          ...(resolvedStore ? { resolvedStore } : {}),
          ...(warning ? { warning } : {}),
        };
      }
      case "ide/clearKeyValueFile": {
        const args = request.params as {
          platform?: string;
          deviceId?: string;
          appId?: string;
          fileName?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName) {
          throw new Error("clearKeyValueFile requires deviceId, appId, and fileName params");
        }
        await this.assertSocketToolEnabled(args.deviceId, "clearKeyValueFile");
        const { platform, client, device } = await this.resolveKeyValueMutationClient(
          args.platform,
          args.deviceId,
          request,
          "ide/clearKeyValueFile",
        );
        const appId = args.appId;
        const fileName = args.fileName;
        const { usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
          platform,
          device,
          appId,
          fileName,
          () => client.clearPreferenceStore(appId, fileName),
          (adb) => clearAndroidKeyValueFileDirect(adb, device.deviceId, appId, fileName),
        );
        const resolvedStore = resolution?.resolvedStore;
        const warning = usedDirectFileFallback
          ? directFileFallbackRelaunchWarning(appId, fileName)
          : undefined;
        return {
          success: true,
          ...(resolvedStore ? { resolvedStore } : {}),
          ...(warning ? { warning } : {}),
        };
      }
      default:
        return undefined;
    }
  }

  /**
   * `ide/*` routes that mutate a device follow device ownership like `input/*` (#10827): a held
   * device accepts them only from its holder (the optional `sessionUuid` param), or when `force`
   * is allowed and set. Reads stay open to watchers. Unheld devices stay open to any client.
   */
  private assertIdeMutationOwnership(
    request: DaemonRequest,
    deviceId: string,
    action: string,
    force = false,
  ): void {
    const requesterSessionUuid = parseInputRequesterSessionUuid(request.method, request.params);
    if (force || !this.daemonState.isInitialized()) {
      return;
    }
    const sessionManager = this.daemonState.getSessionManager();
    assertInputRequesterHoldsDevice({
      action,
      deviceId,
      ownerSessionUuid: sessionManager.getSessionForDevice?.(deviceId) ?? undefined,
      requesterSessionUuid,
      sessionManager,
      remedy:
        "pass the holding session's sessionUuid, or wait for the holder to release the device.",
    });
  }

  /**
   * Booted devices for an `ide/*` action on one serial. iOS discovery has two
   * sources, and the legacy listing turns a failed simctl sweep into `[]`, which
   * surfaced as a misleading "Device not found". When the serial is absent from an
   * incomplete iOS sweep the absence proves nothing, so refuse with the retryable
   * discovery error instead (#11122, cf. #11103).
   */
  private async listBootedDevicesForIdeAction(
    platform: "android" | "ios",
    serial: string,
  ): Promise<BootedDevice[]> {
    const manager = PlatformDeviceManagerFactory.getInstance();
    if (platform !== "ios") {
      return manager.getBootedDevices(platform);
    }
    const discovery = await manager.getBootedDevicesDetailed("ios");
    if (
      !discovery.succeededPlatforms.has("ios") &&
      !discovery.devices.map((device) => device.deviceId).includes(serial)
    ) {
      throw new BootedDeviceDiscoveryIncompleteError("ios", discovery.discoveryErrors?.ios);
    }
    return discovery.devices;
  }

  /**
   * Resolve the platform-appropriate storage-mutation client for a key-value
   * `ide/*` request. iOS Storage-facet edits carry `platform: "ios"` so the pane
   * targets the iOS simulator + IOSCtrlProxyClient; a missing platform defaults
   * to Android for backward compatibility with older desktop clients (#4708).
   */
  private async resolveKeyValueMutationClient(
    platformValue: string | undefined,
    deviceId: string,
    request: DaemonRequest,
    action: string,
  ): Promise<{
    platform: "android" | "ios";
    client: KeyValueMutationClient;
    device: BootedDevice;
  }> {
    const platform = platformValue ?? "android";
    if (platform !== "android" && platform !== "ios") {
      throw new Error(`Invalid platform: ${platform}. Must be 'android' or 'ios'.`);
    }
    const bootedDevices = await this.listBootedDevicesForIdeAction(platform, deviceId);
    // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
    await this.reconcileDiscoveryObservation(bootedDevices, "socket:ide/keyValueMutation");
    this.assertDeviceActionable(deviceId, "to mutate stored values");
    const targetDevice = bootedDevices.find((d) => d.deviceId === deviceId);
    if (!targetDevice) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    this.assertIdeMutationOwnership(request, targetDevice.deviceId, action);
    const client =
      platform === "ios"
        ? IOSCtrlProxyClient.getInstance(targetDevice)
        : AndroidCtrlProxyClient.getInstance(targetDevice, this.adbClientFactory);
    return { platform, client, device: targetDevice };
  }

  /**
   * Run a key-value mutation from an `ide/*` route through the shared SharedPreferences
   * inspection-disabled fallback (issue #6292). On Android, if the SDK ContentProvider path
   * is gated because inspection is disabled, this falls back to the same direct-file
   * `adb shell run-as` XML edit the MCP `setKeyValue`/`removeKeyValue`/`clearKeyValueFile`
   * tools use — so the desktop Storage pane can write/delete/clear even when inspection is
   * off, exactly like the MCP path. iOS has no on-device XML fallback, so `viaSdk` runs alone.
   * Returns the SDK resolution and whether the fallback ran, for store and warning reporting.
   */
  private async runIdeKeyValueMutation(
    platform: "android" | "ios",
    device: BootedDevice,
    appId: string,
    fileName: string,
    viaSdk: () => Promise<PreferenceStoreResolution | void>,
    viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>,
  ): Promise<{
    usedDirectFileFallback: boolean;
    resolution: PreferenceStoreResolution | undefined;
  }> {
    if (platform !== "android") {
      const resolution = (await viaSdk()) || undefined;
      return { usedDirectFileFallback: false, resolution };
    }
    let resolution: PreferenceStoreResolution | undefined;
    const result = await withAndroidSharedPreferencesInspectionFallback(
      appId,
      fileName,
      () => this.adbClientFactory.create(device),
      async () => {
        resolution = (await viaSdk()) || undefined;
      },
      // The ide/* params carry no userId, so an ambiguous-user error cannot say "pass userId".
      (adb) => viaDirectFile(adb).catch(rethrowForRouteWithoutUserId),
    );
    return { ...result, resolution };
  }

  private async assertSocketToolEnabled(deviceId: string, toolName: string): Promise<void> {
    const registeredTool = ToolRegistry.getRegisteredTool(toolName);
    // Direct IDE storage routes have a fixed exact-tool allowlist and may run
    // before any loopback MCP client has populated the process registry.
    const declaredDefault = registeredTool?.defaultEnabled ?? false;
    if (!this.daemonState.isInitialized()) {
      await assertToolEnabledForAnySession(
        toolName,
        declaredDefault,
        [undefined],
        this.sessionToolSelectionService,
        // No connectionProfileUuid on this channel — a caller here is on the direct IDE
        // socket, which has no MCP connection profile and cannot invoke an MCP tool.
        undefined,
        IDE_SET_SESSION_TOOL_ENABLED_METHOD,
      );
      return;
    }
    const sessionManager = this.daemonState.getSessionManager();
    // The device's owning session may be a derived `${base}:${label}` label
    // session. Enforce the UNION of base + derived (issue #4611 Gap B, product
    // decision) so a tool is enabled when EITHER grants it — symmetric with the
    // MCP `registerDeviceAware` path. The shared helper resolves the base.
    const derivedSessionUuid = sessionManager.getSessionForDevice?.(deviceId) ?? undefined;
    const baseSessionUuid = resolveToolSelectionBaseSessionUuid(derivedSessionUuid, sessionManager);
    await assertToolEnabledForAnySession(
      toolName,
      declaredDefault,
      [baseSessionUuid, derivedSessionUuid],
      this.sessionToolSelectionService,
      // This IDE socket-gate path never has a connection profile of its own (see
      // formatToolEnabledRemediationSentence in toolSelectionPolicy.ts) — the remediation must
      // name the daemon's own `ide/setSessionToolEnabled` method, not the MCP `setToolEnabled`
      // tool, since a caller on this channel cannot invoke an MCP tool (issue #6259).
      undefined,
      IDE_SET_SESSION_TOOL_ENABLED_METHOD,
    );
  }

  /**
   * Convert incoming `input/*` coordinates to the units the iOS XCUITest runner expects (points).
   *
   * A control client that renders a canonical-pixel observation frame (#4549) sends taps/swipes in
   * PIXELS, so divide by the runner-reported `nativeScale` before dispatch — the inverse of the
   * daemon's publish-side point->pixel conversion, so the tap lands at the same physical location.
   * The divide is EXACT (fractional points; XCUITest accepts them), so the round-trip carries only
   * the single publish-side quantization.
   *
   * The scale metadata is populated by #4548 on hierarchy RECEIPT, which has not happened yet if a
   * control client sends its first input before the daemon has received any hierarchy for this
   * device — dispatching those pixels as points would land a 3x tap at 1/3 scale. So when the
   * metadata is null we fetch one hierarchy first (no observation-stream push, bounded by
   * `probeTimeoutMs`) to populate it, then decide:
   *  - probe FAILS (throws, or returns no hierarchy — not connected / timed out): fail closed with
   *    an actionable error rather than mis-dispatching; do NOT cache (the next input re-probes).
   *  - probe SUCCEEDS but the runner carries no metadata: a genuine pre-#4548 legacy runner, whose
   *    control client sends point-space coordinates — pass through, and cache the verdict so
   *    subsequent legacy taps skip the round trip. The cache entry is dropped the moment metadata
   *    appears, so a runner upgrade is not pinned to the legacy verdict.
   *
   * The caller must charge the probe's elapsed time against the gesture budget (recompute the
   * remaining timeout after this resolves) so probe + gesture never exceed one request budget.
   */
  /**
   * The gesture budget remaining after the iOS scale probe (if any) ran, charging its elapsed
   * wall-time against the request's total budget so probe + gesture never exceed one budget (#3351).
   * Throws a timeout when the probe already consumed the budget, rather than starting a full-budget
   * gesture on top of it. On the common path (metadata already known) the probe is synchronous, so
   * the elapsed time is just the queue wait and this returns ~the full remaining budget.
   */
  private remainingBudgetAfterProbe(
    queueEnterMs: number,
    totalTimeoutMs: number,
    toolName: string,
    origin: string,
  ): number {
    const remaining = totalTimeoutMs - (this.timer.now() - queueEnterMs);
    if (remaining <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin: `UnixSocketServer.${origin}`,
        detail: "iOS screen-scale probe consumed the request budget",
      });
    }
    return remaining;
  }

  private async toIosRunnerCoordinates(
    client: IOSCtrlProxyClient,
    deviceId: string,
    coordinates: number[],
    probeTimeoutMs: number,
    validateCanonicalCoordinates?: (geometry: ScreenScaleMetadata) => void,
  ): Promise<number[]> {
    const knownMetadata = client.getScreenScaleMetadata();
    if (knownMetadata) {
      // Metadata present: a runner upgrade drops any stale confirmed-legacy verdict for this device.
      this.confirmedLegacyScaleDevices.delete(deviceId);
      validateCanonicalCoordinates?.(knownMetadata);
      return coordinates.map((coordinate) =>
        canonicalPixelsToPoints(coordinate, knownMetadata.nativeScale),
      );
    }
    if (this.confirmedLegacyScaleDevices.has(deviceId)) {
      // A prior probe SUCCEEDED with no metadata: a confirmed legacy runner. Skip the round trip.
      return coordinates;
    }

    // Startup window: no hierarchy received yet, so #4548 receipt-based retention has not run. Fetch
    // one (without an observation-stream push) so the scale is known before we decide the space.
    let probed: unknown;
    try {
      probed = await client.requestHierarchySyncWithoutObservationStreamPush(
        undefined,
        false,
        undefined,
        probeTimeoutMs,
      );
    } catch (error) {
      // Probe threw: a transient failure, NOT evidence of a legacy runner. Fail closed rather than
      // mis-dispatching pixels as points.
      throw toActionableError(
        error,
        `Could not determine iOS screen scale for ${deviceId}; the input coordinate scale probe failed`,
      );
    }
    if (!probed) {
      // Probe returned no hierarchy (not connected / timed out): a FAILURE, distinct from a runner
      // that answered with no metadata. Fail closed and do NOT cache — the next input re-probes.
      throw new ActionableError(
        `Could not determine iOS screen scale for ${deviceId}: the hierarchy probe returned no data. ` +
          `Retry once the device has produced a hierarchy.`,
      );
    }

    const probedMetadata = client.getScreenScaleMetadata();
    if (!probedMetadata) {
      // Probe SUCCEEDED but the runner reported no scale metadata: a genuine pre-#4548 legacy
      // runner. The control client never received px bounds, so it sends points — pass through, and
      // cache the verdict so subsequent legacy taps skip the probe.
      this.confirmedLegacyScaleDevices.add(deviceId);
      return coordinates;
    }
    validateCanonicalCoordinates?.(probedMetadata);
    return coordinates.map((coordinate) =>
      canonicalPixelsToPoints(coordinate, probedMetadata.nativeScale),
    );
  }

  /**
   * Canonical pixel bounds arrive with the complete runner metadata. A missing tuple is a legacy
   * runner or an unseen hierarchy, where preserving the existing pass-through behavior is safer
   * than guessing dimensions.
   */
  private requireCoordinatesWithinKnownScreenGeometry(
    coordinates: readonly [number, number],
    geometry: ScreenScaleMetadata | null,
  ): void {
    if (!geometry) {
      return;
    }
    const [x, y] = coordinates;
    if (x < 0 || x >= geometry.pixelWidth || y < 0 || y >= geometry.pixelHeight) {
      throw new Error(
        `input/tap coordinates x=${x}, y=${y} are outside device canonical pixel bounds ` +
          `x: 0..${geometry.pixelWidth - 1}, y: 0..${geometry.pixelHeight - 1}`,
      );
    }
  }

  private async handleInputTap(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const queueEnterMs = input?.receivedAtMs ?? this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputTapParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/tap",
    );
    const gestureResult = await this.runTrackedKeyedDeviceInput(
      request.method,
      targetDevice,
      async (signal) => {
        assertSocketInputNotAborted(signal);
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/tap");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputTap",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        if (args.platform === "android") {
          const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
          this.requireCoordinatesWithinKnownScreenGeometry(
            [args.x, args.y],
            client.getScreenScaleMetadata?.() ?? null,
          );
          // The signal reaches the send step itself, so an owner that went away while the client
          // was still connecting never has its tap written to the device (#10006).
          return await this.dispatchFencedInput("Tap", signal, (onDispatch) =>
            client.requestTapCoordinates(
              args.x,
              args.y,
              args.duration,
              remainingTimeoutMs,
              undefined,
              args.frameContext,
              onDispatch,
              signal,
            ),
          );
        }
        const iosClient = IOSCtrlProxyClient.getInstance(targetDevice);
        const [x, y] = await this.toIosRunnerCoordinates(
          iosClient,
          targetDevice.deviceId,
          [args.x, args.y],
          remainingTimeoutMs,
          (geometry) =>
            this.requireCoordinatesWithinKnownScreenGeometry([args.x, args.y], geometry),
        );
        const gestureTimeoutMs = this.remainingBudgetAfterProbe(
          queueEnterMs,
          totalTimeoutMs,
          request.method,
          "handleInputTap",
        );
        // The scale probe awaited the runner; the owner may have left meanwhile.
        assertSocketInputNotAborted(signal);
        return args.frameContext === undefined
          ? await iosClient.requestTapCoordinates(x, y, args.duration, gestureTimeoutMs)
          : await iosClient.requestTapCoordinates(
              x,
              y,
              args.duration,
              gestureTimeoutMs,
              undefined,
              args.frameContext,
            );
      },
      this.inputDeviceGate(
        request.method,
        "UnixSocketServer.handleInputTap",
        totalTimeoutMs,
        queueEnterMs,
        input,
      ),
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `input/tap failed on ${args.platform}`);
    }

    return {
      action: "input/tap",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      coordinates: { x: args.x, y: args.y },
    };
  }

  private async handleInputSwipe(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const queueEnterMs = input?.receivedAtMs ?? this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputSwipeParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/swipe",
    );
    const gestureResult = await this.runTrackedKeyedDeviceInput(
      request.method,
      targetDevice,
      async (signal) => {
        assertSocketInputNotAborted(signal);
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/swipe");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputSwipe",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        if (args.platform === "android") {
          const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
          return await this.dispatchFencedInput("Swipe", signal, (onDispatch) =>
            client.requestSwipe(
              args.startX,
              args.startY,
              args.endX,
              args.endY,
              args.durationMs,
              remainingTimeoutMs,
              undefined,
              args.frameContext,
              onDispatch,
              signal,
            ),
          );
        }
        const client = IOSCtrlProxyClient.getInstance(targetDevice);
        const [startX, startY, endX, endY] = await this.toIosRunnerCoordinates(
          client,
          targetDevice.deviceId,
          [args.startX, args.startY, args.endX, args.endY],
          remainingTimeoutMs,
        );
        const gestureTimeoutMs = this.remainingBudgetAfterProbe(
          queueEnterMs,
          totalTimeoutMs,
          request.method,
          "handleInputSwipe",
        );
        assertSocketInputNotAborted(signal);
        return args.frameContext === undefined
          ? await client.requestDrag(
              startX,
              startY,
              endX,
              endY,
              0,
              args.durationMs,
              0,
              gestureTimeoutMs,
            )
          : await client.requestDrag(
              startX,
              startY,
              endX,
              endY,
              0,
              args.durationMs,
              0,
              gestureTimeoutMs,
              args.frameContext,
            );
      },
      this.inputDeviceGate(
        request.method,
        "UnixSocketServer.handleInputSwipe",
        totalTimeoutMs,
        queueEnterMs,
        input,
      ),
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `input/swipe failed on ${args.platform}`);
    }

    return {
      action: "input/swipe",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      start: { x: args.startX, y: args.startY },
      end: { x: args.endX, y: args.endY },
      durationMs: args.durationMs,
    };
  }

  /**
   * One streamed-gesture frame (start / move / end). A live drag arrives as one `input/gestureStart`,
   * many `input/gestureMove`, and one `input/gestureEnd` sharing a `gestureId`; the runner chains
   * them into a single continued on-device gesture. Android only — streaming has no XCUITest
   * equivalent, so the desktop client keeps the atomic `input/swipe` for iOS and old daemons.
   *
   * Frame-identity-free like taps: no `frameContext` is required or checked, so a snapshot advancing
   * mid-drag cannot reject an in-flight gesture as stale. Each frame is serialized through the same
   * per-device keyed forward as taps/swipes, so gesture ordering is preserved.
   */
  private async handleInputGesture(
    request: DaemonRequest,
    kind: "start" | "move" | "end",
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const method = GESTURE_FRAME_METHODS[kind];
    const queueEnterMs = input?.receivedAtMs ?? this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputGestureParams(request.params, method);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      method,
    );
    const gestureResult = await this.runTrackedKeyedDeviceInput(
      method,
      targetDevice,
      async (signal) => {
        assertSocketInputNotAborted(signal);
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputGesture",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        return this.forwardGestureFrame(client, kind, args, remainingTimeoutMs);
      },
      this.inputDeviceGate(
        method,
        "UnixSocketServer.handleInputGesture",
        totalTimeoutMs,
        queueEnterMs,
        input,
      ),
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `${method} failed on ${args.platform}`);
    }

    // Track ownership so a socket that tears down mid-drag can lift its still-open on-device stroke.
    // Only an acked start opens the gesture; an end (release OR cancel) closes it. A socket-less
    // forward (no client session) can't be cancelled on close, so it isn't tracked.
    if (socketSessionId) {
      if (kind === "start") {
        // A start acked after its socket closed is cancelled here instead of recorded (#10005).
        await this.ownedGestures.onStartAcked(socketSessionId, targetDevice, args.gestureId);
      } else if (kind === "end") {
        this.ownedGestures.onEndAcked(socketSessionId, targetDevice.deviceId, args.gestureId);
      }
    }

    return {
      action: method,
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      gestureId: args.gestureId,
      point: { x: args.x, y: args.y },
      ...(kind === "end" ? { cancel: args.cancel } : {}),
    };
  }

  /**
   * Cancelling `gestureEnd` for one gesture, forwarded through the same per-device keyed queue as
   * live frames so it can't race an in-flight frame.
   */
  private cancelGestureOnDevice(targetDevice: BootedDevice, gestureId: string): Promise<unknown> {
    return this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        // Coordinates are ignored for a cancel (the runner lifts in place), so 0,0 is fine.
        return client.requestGestureEnd(gestureId, 0, 0, true, OWNED_GESTURE_CANCEL_TIMEOUT_MS);
      },
      `device:${targetDevice.deviceId}`,
    );
  }

  /** Relay one gesture frame to the Android runner's continued-gesture path. */
  private forwardGestureFrame(
    client: AndroidCtrlProxyClient,
    kind: "start" | "move" | "end",
    args: { gestureId: string; x: number; y: number; cancel: boolean },
    timeoutMs: number,
  ) {
    switch (kind) {
      case "start":
        return client.requestGestureStart(args.gestureId, args.x, args.y, timeoutMs);
      case "move":
        return client.requestGestureMove(args.gestureId, args.x, args.y, timeoutMs);
      case "end":
        return client.requestGestureEnd(args.gestureId, args.x, args.y, args.cancel, timeoutMs);
    }
  }

  private parseInputGestureParams(
    params: unknown,
    method: string,
  ): {
    platform: "android";
    deviceId?: string;
    gestureId: string;
    x: number;
    y: number;
    cancel: boolean;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(`${method} requires params object`);
    }
    const args = params as Record<string, unknown>;
    // Streaming gestures have no XCUITest equivalent, so the wire is Android-only. A client that
    // reaches here for iOS bypassed the tool-selection check; reject rather than silently degrade.
    if (args.platform !== "android") {
      throw new Error(`${method} is only supported on platform 'android'`);
    }
    if (typeof args.gestureId !== "string" || args.gestureId.length === 0) {
      throw new Error(`${method} requires a non-empty gestureId`);
    }
    const x = this.requireGestureCoordinate(args.x, method);
    const y = this.requireGestureCoordinate(args.y, method);
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error(`${method} deviceId must be a string when provided`);
    }
    if (args.cancel !== undefined && typeof args.cancel !== "boolean") {
      throw new Error(`${method} cancel must be a boolean when provided`);
    }
    return {
      platform: args.platform,
      deviceId: args.deviceId,
      gestureId: args.gestureId,
      x,
      y,
      cancel: args.cancel === true,
    };
  }

  private requireGestureCoordinate(value: unknown, method: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${method} requires numeric x and y params`);
    }
    return value;
  }

  private async handleInputTypeText(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const queueEnterMs = input?.receivedAtMs ?? this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputTypeTextParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/typeText",
      args.append,
    );
    let confirmedAppendCharsSent: number | undefined;
    const recordConfirmedAppendCharsSent = (charsSent: number): void => {
      confirmedAppendCharsSent = charsSent;
    };
    const inputResult = await this.runTrackedKeyedDeviceInput(
      request.method,
      targetDevice,
      async (signal) => {
        assertSocketInputNotAborted(signal);
        // A same-serial emulator may reconnect while this request waits behind an
        // earlier input. Re-read its ADB transport inside the keyed callback so the
        // append-helper lookup cannot reuse a capability from that older instance.
        const executionTargetDevice =
          args.append && args.platform === "android"
            ? await this.resolveInputTargetDevice(
                args.platform,
                targetDevice.deviceId,
                socketSessionId,
                "input/typeText",
                true,
              )
            : targetDevice;
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/typeText");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputTypeText",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        const imeAction: ImeAction | undefined = args.submit ? "done" : undefined;
        return await this.runInputOperationWithTimeout(
          request.method,
          totalTimeoutMs,
          remainingTimeoutMs,
          "UnixSocketServer.handleInputTypeText",
          () =>
            this.executeInputTypeText(
              args.platform,
              executionTargetDevice,
              args.text,
              imeAction,
              remainingTimeoutMs,
              args.append,
              args.frameContext,
              recordConfirmedAppendCharsSent,
              signal,
            ),
          (timeoutError) =>
            args.append && confirmedAppendCharsSent !== undefined
              ? new InputTypeTextAppendError(timeoutError.message, confirmedAppendCharsSent)
              : undefined,
        );
      },
      this.inputDeviceGate(
        request.method,
        "UnixSocketServer.handleInputTypeText",
        totalTimeoutMs,
        queueEnterMs,
        input,
      ),
    );

    if (!inputResult.success) {
      if (args.append && inputResult.charsSent !== undefined) {
        throw new InputTypeTextAppendError(
          inputResult.error ?? `input/typeText failed on ${args.platform}`,
          inputResult.charsSent,
        );
      }
      throw new Error(inputResult.error ?? `input/typeText failed on ${args.platform}`);
    }

    return {
      action: "input/typeText",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      textLength: args.text.length,
      submitted: args.submit,
    };
  }

  private async handleInputPressButton(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const queueEnterMs = input?.receivedAtMs ?? this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputPressButtonParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/pressButton",
    );
    const buttonResult = await this.runTrackedKeyedDeviceInput(
      request.method,
      targetDevice,
      async (signal) => {
        assertSocketInputNotAborted(signal);
        this.requireCurrentFrameContext(
          targetDevice.deviceId,
          args.frameContext,
          "input/pressButton",
        );
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputPressButton",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        // Forward the execution tracker's abort signal (this bound-session path
        // is NOT wrapped in runWithAbortSignal, so there is no ambient signal for
        // press to pick up): without it, session teardown mid-home-press leaves
        // the ADB dispatch and foreground-verification reads running (issue #6289).
        const pressButton = new PressButton(targetDevice);
        return args.frameContext === undefined
          ? await pressButton.press(args.button, remainingTimeoutMs, undefined, signal)
          : await pressButton.press(args.button, remainingTimeoutMs, args.frameContext, signal);
      },
      this.inputDeviceGate(
        request.method,
        "UnixSocketServer.handleInputPressButton",
        totalTimeoutMs,
        queueEnterMs,
        input,
      ),
    );

    if (!buttonResult.success) {
      throw new Error(buttonResult.error ?? `input/pressButton failed on ${args.platform}`);
    }

    return {
      action: "input/pressButton",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      button: args.responseButton,
    };
  }

  private async handleInputKey(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const queueEnterMs = input?.receivedAtMs ?? this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputKeyParams(request.params);
    if (args.platform === "ios") {
      throw new Error(INPUT_KEY_IOS_UNSUPPORTED_ERROR);
    }
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/key",
    );
    const keyResult = await this.runTrackedKeyedDeviceInput(
      request.method,
      targetDevice,
      async (signal) => {
        assertSocketInputNotAborted(signal);
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/key");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputKey",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        const inputKey = new InputKey(targetDevice, defaultAdbClientFactory, undefined, this.timer);
        let dispatched = false;
        return await this.runInputOperationWithTimeout(
          request.method,
          totalTimeoutMs,
          remainingTimeoutMs,
          "UnixSocketServer.handleInputKey",
          () =>
            inputKey.press(args.key, remainingTimeoutMs, args.frameContext, [], {
              signal,
              onDispatch: () => {
                dispatched = true;
              },
            }),
          (timeoutError) => (dispatched ? InputKey.indeterminateError(timeoutError) : undefined),
        );
      },
      this.inputDeviceGate(
        request.method,
        "UnixSocketServer.handleInputKey",
        totalTimeoutMs,
        queueEnterMs,
        input,
      ),
    );

    if (!keyResult.success) {
      throw new Error(keyResult.error ?? `input/key failed on ${args.platform}`);
    }

    return {
      action: "input/key",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      key: args.key,
    };
  }

  private async executeInputTypeText(
    platform: "android" | "ios",
    targetDevice: BootedDevice,
    text: string,
    imeAction: ImeAction | undefined,
    timeoutMs: number,
    ...[append = false, frameContext, onConfirmedAppendCharsSent, signal]: [
      append?: boolean,
      frameContext?: string,
      onConfirmedAppendCharsSent?: (charsSent: number) => void,
      signal?: AbortSignal,
    ]
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    // Charge set-text and the optional submit/IME action against a single
    // shared budget. Otherwise submit:true would hand each request the full
    // timeout, letting the combined operation run up to 2x the caller's
    // budget while the per-device queue stays held until it settles.
    const deadline = this.timer.now() + timeoutMs;
    const client: DeviceService =
      platform === "android"
        ? AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory)
        : IOSCtrlProxyClient.getInstance(targetDevice);

    // Append emits real key events on Android. iOS invokes its focused-field insert
    // primitive, falling back on runners that predate that command to untargeted
    // requestSetText, which is the same XCUITest typeText-at-caret operation.
    //
    // The budget is threaded in for the same reason the replace path gets it: this
    // runs while the per-device queue is held, and the outer race only *reports* a
    // timeout — it still waits for the operation to settle before releasing the
    // queue. An unbounded adb subprocess here would therefore wedge every later
    // input for this device, not just this one request.
    let appendCharsSent: number | undefined;
    if (append && platform === "android") {
      const textResult = await this.executeAndroidAppendText({
        targetDevice,
        text,
        deadline,
        totalTimeoutMs: timeoutMs,
        frameContext,
        client: client as AndroidCtrlProxyClient,
        signal,
      });
      assertSocketInputNotAborted(signal);
      if (textResult.charsSent !== undefined) {
        onConfirmedAppendCharsSent?.(textResult.charsSent);
      }
      if (!textResult.success) {
        return {
          success: false,
          error: textResult.error,
          ...(textResult.charsSent !== undefined ? { charsSent: textResult.charsSent } : {}),
        };
      }
      appendCharsSent = textResult.charsSent;
    } else {
      const textResult = append
        ? await (client as IOSCtrlProxyClient).requestAppendText(
            text,
            timeoutMs,
            undefined,
            frameContext,
          )
        : await client.requestSetText(text, { timeoutMs, frameContext });
      assertSocketInputNotAborted(signal);
      if (!textResult.success) {
        return { success: false, error: textResult.error };
      }
    }
    return await this.runImeActionWithinBudget(
      client,
      imeAction,
      deadline,
      timeoutMs,
      appendCharsSent,
      signal,
    );
  }

  private async executeAndroidAppendText(
    options: AndroidAppendTextOptions,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    const { targetDevice, text, deadline, totalTimeoutMs, frameContext, client, signal } = options;
    const appendTimeoutMs = deadline - this.timer.now();
    if (appendTimeoutMs <= 0) {
      return {
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before append key events`,
      };
    }
    const beforeKeyEvent =
      frameContext === undefined
        ? undefined
        : () => this.validateAppendFrameContext(client, frameContext, deadline, totalTimeoutMs);
    const cached = this.getAppendTextInput(targetDevice);
    const run = async (
      input: AppendTextInput,
      pending: string,
      timeoutMs: number,
      validate: typeof beforeKeyEvent,
    ) =>
      signal
        ? await input.appendText(pending, timeoutMs, validate, signal)
        : await input.appendText(pending, timeoutMs, validate);
    const result = await run(cached.input, text, appendTimeoutMs, beforeKeyEvent);
    if (
      result.success ||
      !cached.fromCache ||
      signal?.aborted ||
      // A verdict from the RUNNER is not evidence about the helper. The helper
      // worked; the device-side answer was "no" (a stale `frameContext`, say).
      // Rebuilding and replaying would type the whole string into a UI the
      // runner explicitly refused, so the verdict is surfaced exactly as it came
      // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
      result.failureSource === "runner"
    ) {
      return result;
    }
    return await this.retryAppendTextWithRebuiltHelper(
      targetDevice,
      text,
      result,
      deadline,
      beforeKeyEvent,
      run,
    );
  }

  /**
   * Self-heal, for HELPER failures only: without an ADB transport id there is
   * nothing that proves a cached helper still belongs to the device now on this
   * serial, and a restart faster than one discovery interval leaves the pool
   * incarnation unchanged. A helper failure is the first evidence either way, so
   * drop the helper and give a freshly built one exactly one attempt before
   * surfacing the error. A RUNNER verdict never reaches here.
   */
  private async retryAppendTextWithRebuiltHelper(
    targetDevice: BootedDevice,
    text: string,
    result: Awaited<ReturnType<AppendTextInput["appendText"]>>,
    deadline: number,
    beforeKeyEvent: AppendKeyEventValidator | undefined,
    run: (
      input: AppendTextInput,
      pending: string,
      timeoutMs: number,
      validate: AppendKeyEventValidator | undefined,
    ) => Promise<Awaited<ReturnType<AppendTextInput["appendText"]>>>,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    // The retry resumes from the UNCONFIRMED SUFFIX only. `charsSent` is the
    // exact prefix the failed helper landed on the device, so replaying the whole
    // string would duplicate it ("AB" after "A" becomes "AAB", issue #3351). An
    // ABSENT `charsSent` means the helper cannot say whether its in-flight key
    // event landed (an adb timeout kills the host child, not Android's handling
    // of the event), which makes every replay unsafe: surface the failure.
    const confirmed = result.charsSent;
    if (confirmed === undefined) {
      return result;
    }
    const pending = text.slice(confirmed);
    if (pending.length === 0) {
      return result;
    }
    this.evictDeviceInputCache(targetDevice.deviceId);
    const retryTimeoutMs = deadline - this.timer.now();
    if (retryTimeoutMs <= 0) {
      return result;
    }
    // The validator travels with the retry only when NOTHING was confirmed:
    // there, no key event landed, the original validation was never spent, and
    // the rebuilt helper is starting the same append over. Once a prefix IS
    // confirmed this is a RESUME of the same logical append -- the original call
    // already validated `frameContext` before its first key event, and the
    // confirmed prefix has since emitted TYPE_VIEW_TEXT_CHANGED, which advances
    // the runner's frame epoch, so re-validating would reject a suffix that is
    // safe to type ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    const retry = await run(
      this.getAppendTextInput(targetDevice).input,
      pending,
      retryTimeoutMs,
      confirmed === 0 ? beforeKeyEvent : undefined,
    );
    // Progress accumulates across both helpers so the caller's retry boundary
    // stays an index into the ORIGINAL text; an ambiguous retry poisons the
    // whole count, so it reports no boundary at all.
    return retry.charsSent === undefined
      ? { success: retry.success, ...(retry.error !== undefined ? { error: retry.error } : {}) }
      : { ...retry, charsSent: confirmed + retry.charsSent };
  }

  private async validateAppendFrameContext(
    client: AndroidCtrlProxyClient,
    frameContext: string,
    deadline: number,
    totalTimeoutMs: number,
  ): Promise<{ success: boolean; error?: string; failureSource?: AppendTextFailureSource }> {
    const validationTimeoutMs = deadline - this.timer.now();
    if (validationTimeoutMs <= 0) {
      return {
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before append frame context validation`,
      };
    }
    const validation = await client.validateFrameContext(frameContext, validationTimeoutMs);
    return validation.success
      ? { success: true }
      : {
          success: false,
          error:
            validation.error ??
            "Frame context is stale or unavailable; observe a fresh frame before retrying",
          // The runner answered, and the answer is "no". That is a verdict about
          // the DEVICE, so the caller must not treat it as a stale helper and
          // replay the text through a rebuilt one (#6863 review).
          failureSource: "runner",
        };
  }

  private async runImeActionWithinBudget(
    client: Pick<DeviceService, "requestImeAction">,
    imeAction: ImeAction | undefined,
    deadline: number,
    totalTimeoutMs: number,
    appendCharsSent?: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    const withAppendProgress = (result: { success: boolean; error?: string }) =>
      appendCharsSent !== undefined ? { ...result, charsSent: appendCharsSent } : result;
    if (!imeAction) {
      return withAppendProgress({ success: true });
    }
    assertSocketInputNotAborted(signal);
    const remainingTimeoutMs = deadline - this.timer.now();
    if (remainingTimeoutMs <= 0) {
      // Defensive: in practice the outer deadline race fires first, so
      // this path is only reached if set-text spends the entire budget before
      // the submit action starts.
      return withAppendProgress({
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before submit`,
      });
    }
    try {
      const result = await client.requestImeAction(imeAction, remainingTimeoutMs);
      if (!result.success) {
        const message = imeActionFailedAfterTextEntered(imeAction, result.error || "unknown error");
        logger.warn(`[input/typeText] ${message}`);
        return withAppendProgress({ ...result, error: message });
      }
      return withAppendProgress(result);
    } catch (error) {
      const message = imeActionFailedAfterTextEntered(
        imeAction,
        errorMessage(error) || "unknown error",
      );
      logger.warn(`[input/typeText] ${message}`, error);
      if (appendCharsSent === undefined) {
        // Preserve runner error identity, class, and structured failure metadata.
        if (error instanceof Error) {
          error.message = message;
          throw error;
        }
        throw new ActionableError(message, { cause: error });
      }
      return {
        success: false,
        error: message,
        charsSent: appendCharsSent,
      };
    }
  }

  private async runInputOperationWithTimeout<T>(
    toolName: string,
    totalTimeoutMs: number,
    remainingTimeoutMs: number,
    origin: string,
    operation: () => Promise<T>,
    timeoutError?: (timeout: McpTimeoutError) => Error | undefined,
  ): Promise<T> {
    let timedOut = false;
    const operationPromise = operation();
    try {
      return await raceWithDeadline(operationPromise, {
        timer: this.timer,
        timeoutMs: remainingTimeoutMs,
        label: "Input operation",
        timeoutError: () => {
          timedOut = true;
          const error = new McpTimeoutError({
            toolName,
            timeoutMs: totalTimeoutMs,
            origin,
            detail: `operation exceeded remaining budget ${remainingTimeoutMs}ms`,
          });
          return timeoutError?.(error) ?? error;
        },
      });
    } finally {
      if (timedOut) {
        // Hold the per-device queue until the in-flight CtrlProxy request
        // settles so a following same-device input cannot interleave its text
        // write with this one. This defers delivery of the timeout error until
        // the operation ends; the wait normally tracks the caller's budget
        // (executeInputTypeText bounds set-text + IME to it) but can exceed it
        // if a CtrlProxy request ignores its own timeout or blocks in an
        // unbounded connect phase. This serialization-over-responsiveness
        // trade-off matches input/tap and input/swipe.
        await operationPromise.catch(() => undefined);
      }
    }
  }

  private parseInputTapParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    x: number;
    y: number;
    duration?: number;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/tap requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/tap requires platform 'android' or 'ios'");
    }
    // Reject NaN AND ±Infinity (finiteness), matching parseInputSwipeParams. Number.isNaN
    // alone lets ±Infinity through, violating the "numeric x and y" contract (#3615).
    if (
      typeof args.x !== "number" ||
      !Number.isFinite(args.x) ||
      typeof args.y !== "number" ||
      !Number.isFinite(args.y)
    ) {
      throw new Error("input/tap requires numeric x and y params");
    }
    this.validateInputTapOptions(args);

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      x: args.x,
      y: args.y,
      duration: args.duration,
      frameContext: args.frameContext,
    };
  }

  private validateInputTapOptions(args: Record<string, unknown>): asserts args is Record<
    string,
    unknown
  > & {
    duration?: number;
    deviceId?: string;
    frameContext?: string;
  } {
    if (
      args.duration !== undefined &&
      (typeof args.duration !== "number" || !Number.isInteger(args.duration))
    ) {
      throw new Error("input/tap duration must be an integer number of milliseconds when provided");
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/tap deviceId must be a string when provided");
    }
    if (
      args.frameContext !== undefined &&
      (typeof args.frameContext !== "string" || args.frameContext.length === 0)
    ) {
      throw new Error("input/tap frameContext must be a non-empty string when provided");
    }
  }

  private parseInputSwipeParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    durationMs: number;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/swipe requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/swipe requires platform 'android' or 'ios'");
    }
    this.validateInputSwipeGeometry(args);
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/swipe deviceId must be a string when provided");
    }
    if (
      args.frameContext !== undefined &&
      (typeof args.frameContext !== "string" || args.frameContext.length === 0)
    ) {
      throw new Error("input/swipe frameContext must be a non-empty string when provided");
    }

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      startX: args.startX,
      startY: args.startY,
      endX: args.endX,
      endY: args.endY,
      durationMs: args.durationMs ?? 300,
      frameContext: args.frameContext,
    };
  }

  private validateInputSwipeCoordinates(args: Record<string, unknown>): void {
    if (
      typeof args.startX !== "number" ||
      !Number.isFinite(args.startX) ||
      typeof args.startY !== "number" ||
      !Number.isFinite(args.startY) ||
      typeof args.endX !== "number" ||
      !Number.isFinite(args.endX) ||
      typeof args.endY !== "number" ||
      !Number.isFinite(args.endY)
    ) {
      throw new Error("input/swipe requires numeric startX, startY, endX, and endY params");
    }
  }

  private validateInputSwipeGeometry(args: Record<string, unknown>): asserts args is Record<
    string,
    unknown
  > & {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    durationMs?: number;
  } {
    this.validateInputSwipeCoordinates(args);
    if (
      args.durationMs !== undefined &&
      (typeof args.durationMs !== "number" ||
        !Number.isInteger(args.durationMs) ||
        args.durationMs < 1 ||
        args.durationMs > 60_000)
    ) {
      throw new Error("input/swipe durationMs must be integer milliseconds between 1 and 60000");
    }
  }

  private parseInputTypeTextParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    text: string;
    submit: boolean;
    append: boolean;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/typeText requires params object");
    }

    const args = params as Record<string, unknown>;
    const supportedParams = new Set([
      "platform",
      "deviceId",
      "text",
      "submit",
      "mode",
      "frameContext",
      "sessionUuid",
    ]);
    const unsupportedParams = Object.keys(args).filter((key) => !supportedParams.has(key));
    if (unsupportedParams.length > 0) {
      throw new Error(`input/typeText unsupported params: ${unsupportedParams.join(", ")}`);
    }
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/typeText requires platform 'android' or 'ios'");
    }
    this.validateInputTypeTextContent(args);
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/typeText deviceId must be a string when provided");
    }
    this.validateFrameContextParam(args.frameContext, "input/typeText");
    // "append" adds to the focused field instead of replacing it, which is what
    // an interactive client mirroring one keystroke at a time needs: the default
    // replace semantics would leave only the last character typed (#3351).
    if (args.mode !== undefined && args.mode !== "append") {
      throw new Error('input/typeText mode must be "append" when provided');
    }
    return {
      platform: args.platform,
      deviceId: args.deviceId,
      text: args.text,
      submit: args.submit ?? false,
      append: args.mode === "append",
      frameContext: args.frameContext as string | undefined,
    };
  }

  private validateInputTypeTextContent(
    args: Record<string, unknown>,
  ): asserts args is Record<string, unknown> & { text: string; submit?: boolean } {
    if (typeof args.text !== "string" || args.text.length === 0) {
      throw new Error("input/typeText requires non-empty string text param");
    }
    if (args.submit !== undefined && typeof args.submit !== "boolean") {
      throw new Error("input/typeText submit must be a boolean when provided");
    }
  }

  private parseInputPressButtonParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    button: string;
    responseButton: string;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/pressButton requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/pressButton requires platform 'android' or 'ios'");
    }
    if (typeof args.button !== "string") {
      throw new Error("input/pressButton requires button");
    }
    const supportedButtons = [
      "home",
      "back",
      "menu",
      "power",
      "volume_up",
      "volume_down",
      "recent",
      "app_switch",
    ];
    if (!supportedButtons.includes(args.button)) {
      throw new Error(`input/pressButton button must be one of: ${supportedButtons.join(", ")}`);
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/pressButton deviceId must be a string when provided");
    }
    this.validateFrameContextParam(args.frameContext, "input/pressButton");
    const button = args.button === "app_switch" ? "recent" : args.button;

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      button,
      responseButton: args.button,
      frameContext: args.frameContext as string | undefined,
    };
  }

  private parseInputKeyParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    key: InputKeyName;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/key requires params object");
    }

    const args = params as Record<string, unknown>;
    const supportedParams = new Set(["platform", "deviceId", "key", "frameContext", "sessionUuid"]);
    const unsupportedParams = Object.keys(args).filter((key) => !supportedParams.has(key));
    if (unsupportedParams.length > 0) {
      throw new Error(`input/key unsupported params: ${unsupportedParams.join(", ")}`);
    }
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/key requires platform 'android' or 'ios'");
    }
    if (typeof args.key !== "string") {
      throw new Error("input/key requires key");
    }
    if (!isInputKeyName(args.key)) {
      throw new Error(`input/key key must be one of: ${SUPPORTED_INPUT_KEYS.join(", ")}`);
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/key deviceId must be a string when provided");
    }
    this.validateFrameContextParam(args.frameContext, "input/key");

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      key: args.key,
      frameContext: args.frameContext as string | undefined,
    };
  }

  private validateFrameContextParam(frameContext: unknown, action: string): void {
    if (
      frameContext !== undefined &&
      (typeof frameContext !== "string" || frameContext.length === 0)
    ) {
      throw new Error(`${action} frameContext must be a non-empty string when provided`);
    }
  }

  /**
   * Input that carries a device-authored context is safe only if the newest observation from that
   * device still reports that exact context. Missing context fails closed: a caller can re-observe
   * and retry, whereas executing against an unproven screen could actuate the wrong UI.
   */
  private requireCurrentFrameContext(
    deviceId: string,
    frameContext: string | undefined,
    action: string,
  ): void {
    if (frameContext === undefined) {
      return;
    }
    const current = getDeviceDataStreamServer()?.getCurrentFrameContext(deviceId);
    if (current !== frameContext) {
      throw new Error(
        `${action} frameContext is stale or unavailable; observe a fresh frame before retrying`,
      );
    }
  }

  /**
   * The device session an `input/*` frame acts for (#10698): its explicit `sessionUuid`, else the
   * device session this socket's MCP session is autolocked to for the frame's platform (a proxy
   * connection that already drives that session's device). A malformed `sessionUuid` fails here,
   * before any device work; the autolock fallback is read only when a held device needs it.
   */
  private inputRequester(
    request: DaemonRequest,
    socketSessionId: string | undefined,
  ): () => string | undefined {
    const explicit = parseInputRequesterSessionUuid(request.method, request.params);
    return () => {
      if (explicit || !socketSessionId || !this.daemonState.isInitialized()) {
        return explicit;
      }
      const platform = (request.params as Record<string, unknown> | undefined)?.platform;
      if (platform !== "android" && platform !== "ios") {
        return undefined;
      }
      return this.daemonState
        .getDevicePool()
        .resolveAutolockSessionForMcpSession?.(socketSessionId, platform);
    };
  }

  private async resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    action: InputTargetAction,
    bypassAndroidDeviceListCache: boolean = false,
  ): Promise<BootedDevice> {
    const targetDevice = await this.selectInputTargetDevice(
      platform,
      deviceId,
      socketSessionId,
      action,
      bypassAndroidDeviceListCache,
    );
    this.captureInputTargetOwner(targetDevice);
    return targetDevice;
  }

  private captureInputTargetOwner(targetDevice: BootedDevice): void {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    const owner = this.daemonState.getSessionManager().getSessionForDevice?.(targetDevice.deviceId);
    if (owner) {
      this.inputTargetOwners.set(targetDevice, owner);
    }
  }

  private async selectInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    action: InputTargetAction,
    bypassAndroidDeviceListCache: boolean = false,
  ): Promise<BootedDevice> {
    const bootedDevices = await this.discoverInputTargetDevices(
      platform,
      action,
      bypassAndroidDeviceListCache,
    );
    if (deviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === deviceId);
      if (!targetDevice) {
        throw new Error(`Device not found: ${deviceId}`);
      }
      return targetDevice;
    }

    const autolockSessionId = this.daemonState.isInitialized()
      ? this.daemonState
          .getDevicePool()
          .resolveAutolockSessionForMcpSession?.(socketSessionId, platform)
      : undefined;
    const autolockDeviceId = autolockSessionId
      ? this.daemonState.getSessionManager().getSession(autolockSessionId)?.assignedDevice
      : undefined;
    if (autolockDeviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === autolockDeviceId);
      if (!targetDevice) {
        throw new Error(`Device not found: ${autolockDeviceId}`);
      }
      return targetDevice;
    }

    if (bootedDevices.length === 1) {
      return bootedDevices[0];
    }
    if (bootedDevices.length === 0) {
      throw new Error(`No booted ${platform} devices found for ${action}`);
    }
    throw new Error(`${action} requires deviceId when multiple ${platform} devices are booted`);
  }

  private async runTrackedKeyedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
    gate?: InputDeviceGate,
  ): Promise<T> {
    const executionKey = `device:${targetDevice.deviceId}`;
    return await this.runTrackedDeviceInput(
      toolName,
      targetDevice,
      async (signal) =>
        this.runKeyedMcpForward(
          executionKey,
          () => {
            // Parked on the device key, the input may have been cancelled (a session acquired the
            // device, #10829): it is not sent.
            signal?.throwIfAborted();
            return operation(signal);
          },
          executionKey,
          gate?.chainWait,
        ),
      gate?.ownerSignal,
      gate?.requester,
    );
  }

  /**
   * What an `input/*` handler needs on top of the tracked execution: the owner's abort signal
   * (socket close / client cancel) and a bound on how long it may park on the device key, both
   * measured against the budget that started at frame receipt (#10006).
   */
  private inputDeviceGate(
    toolName: string,
    origin: string,
    totalTimeoutMs: number,
    budgetStartMs: number,
    input?: InputRequestContext,
  ): InputDeviceGate {
    const remainingMs = () => totalTimeoutMs - (this.timer.now() - budgetStartMs);
    return {
      ownerSignal: input?.signal,
      requester: input?.requester,
      chainWait: {
        remainingMs,
        timeoutError: (executionKey) =>
          new McpTimeoutError({
            toolName,
            timeoutMs: totalTimeoutMs,
            origin,
            detail: `spent ${totalTimeoutMs - remainingMs()}ms waiting in queue for ${executionKey}`,
            code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
          }),
      },
    };
  }

  /**
   * Send one coordinate gesture with the owner signal fencing the send. Once the frame has been
   * written, an abort is no longer proof that nothing happened: the failure is reported as
   * indeterminate rather than as a clean cancellation.
   */
  private async dispatchFencedInput<T>(
    gesture: "Tap" | "Swipe",
    signal: AbortSignal | undefined,
    send: (onDispatch: () => void) => Promise<T>,
  ): Promise<T> {
    let dispatched = false;
    try {
      return await send(() => {
        dispatched = true;
      });
    } catch (error) {
      if (dispatched && signal?.aborted) {
        const reason = errorMessage(error);
        throw gesture === "Tap"
          ? indeterminateTapError(reason)
          : new ActionableError(
              `Swipe outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). Do not retry automatically.`,
            );
      }
      throw error;
    }
  }

  /**
   * FUNNEL 1 for this socket server: fold a discovery observation into pooled
   * identity before anything here joins it to pool state. See
   * `DevicePool.reconcileDiscoveryObservation`. A no-op in direct mode, where
   * there is no pool.
   */
  private async reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
  ): Promise<void> {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    await this.daemonState.getDevicePool().reconcileDiscoveryObservation?.(devices, source);
  }

  /**
   * FUNNEL 2 for this socket server: refuse a serial whose pooled identity is
   * quarantined. See `DevicePool.assertDeviceActionable`. A no-op in direct mode,
   * where nothing holds cross-call identity state to quarantine.
   */
  private assertDeviceActionable(deviceId: string, purpose: string): void {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    this.daemonState.getDevicePool().assertDeviceActionable?.(deviceId, purpose);
  }

  private async runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
    requester?: () => string | undefined,
  ): Promise<T> {
    // FUNNEL 2, ahead of the session lookup: a device-addressed input on a
    // quarantined serial must be refused WITH OR WITHOUT a session. The
    // session-keyed gate below cannot see an idle emulator, so an explicit
    // `deviceId` tap on one used to execute against whatever now answers on that
    // serial ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    this.assertDeviceActionable(targetDevice.deviceId, "to run");
    const sessionManager = this.daemonState.isInitialized()
      ? this.daemonState.getSessionManager()
      : undefined;
    const sessionUuid = sessionManager?.getSessionForDevice?.(targetDevice.deviceId) ?? undefined;
    // A held device takes input only from its holder (#10698); checked here, the one funnel every
    // `input/*` handler runs through, before anything reaches the device.
    assertInputRequesterHoldsDevice({
      action: toolName,
      deviceId: targetDevice.deviceId,
      ownerSessionUuid: sessionUuid,
      requesterSessionUuid: sessionUuid ? requester?.() : undefined,
      sessionManager,
    });
    if (sessionUuid) {
      this.daemonState.getDevicePool().assertSessionReadyForAutomation?.(sessionUuid);
    }
    const resolvedOwner = this.inputTargetOwners.get(targetDevice);
    if (resolvedOwner !== undefined && resolvedOwner !== sessionUuid) {
      // The target was resolved for `resolvedOwner`, which has since left the device (rebind or
      // release). Running now would drive it as an unowned call or as the next owner's (#9958).
      throw new ActionableError(
        `Session ${resolvedOwner} no longer owns device '${targetDevice.deviceId}' (it was rebound ` +
          `or released after this input resolved its target); the input was not sent.`,
      );
    }
    const execution = executionTracker.startExecution(toolName, undefined, sessionUuid);
    const signal = execution.abortController.signal;
    try {
      executionTracker.bindDeviceExecution(execution.id, targetDevice.deviceId);
      signal.throwIfAborted();
      // The holder and readiness checks above passed: this input is use of the session (#10824).
      executionTracker.markSessionAdmitted(execution.id);
      if (!sessionUuid) {
        // Admitted on a device no session holds: a session acquiring it while this input is parked
        // or in flight cancels it (#10829).
        executionTracker.markSessionlessDeviceUse(execution.id, targetDevice.deviceId);
      }
      return await runWithToolSelectionContext(
        {
          execution: {
            executionId: execution.id,
            startTime: execution.startTime,
            deviceBinding: {
              bindDeviceExecution: (deviceId) =>
                executionTracker.bindDeviceExecution(execution.id, deviceId),
            },
          },
        },
        () => this.runFencedInputOperation(signal, ownerSignal, operation),
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  }

  /**
   * Run an input operation under the tracker's signal AND the owner's: an `input/*` frame whose
   * socket closed or whose client cancelled it aborts exactly like a torn-down session (#10006).
   */
  private runFencedInputOperation<T>(
    trackerSignal: AbortSignal,
    ownerSignal: AbortSignal | undefined,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = ownerSignal ? AbortSignal.any([trackerSignal, ownerSignal]) : trackerSignal;
    signal.throwIfAborted();
    return runWithAbortSignal(signal, () => operation(signal));
  }

  private async discoverInputTargetDevices(
    platform: "android" | "ios",
    action: InputTargetAction,
    bypassAndroidDeviceListCache: boolean,
  ): Promise<BootedDevice[]> {
    const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(
      platform,
      {
        bypassAndroidDeviceListCache,
      },
    );
    // FUNNEL 1: the target this resolves is handed straight to the device-addressed
    // admission gate, which reads pool state — so the pool must have seen this
    // observation first (#6863 review).
    await this.reconcileDiscoveryObservation(discovery.devices, `socket:${action}`);
    if (!discovery.succeededPlatforms.has(platform)) {
      throw new Error(`Unable to discover booted ${platform} devices for ${action}`);
    }
    return discovery.devices;
  }

  private mcpRequestOptions(
    timeoutMs: number,
    signal?: AbortSignal,
  ): { timeout: number; signal?: AbortSignal } {
    return signal ? { timeout: timeoutMs, signal } : { timeout: timeoutMs };
  }

  private combineMcpRequestSignals(
    ownerSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
  ): AbortSignal {
    return ownerSignal ? AbortSignal.any([ownerSignal, timeoutSignal]) : timeoutSignal;
  }

  private async handleIdeRequest(
    mcpClient: Client,
    request: DaemonRequest,
    timeoutMs: number,
    socketSessionId: string,
    deadline: ProgressExtendableDeadline,
    /**
     * The FULL per-request timeout window this request was granted at
     * receipt (`totalTimeoutMs` from `handleRequest`) -- UNLIKE `timeoutMs`
     * above, which is the budget remaining for THIS specific forward
     * attempt after time already spent waiting in the per-session queue
     * (or reconnecting). A request that waited most of its budget in queue
     * would otherwise have every progress-driven reset use that tiny
     * queue-depleted remnant as its "how long is ordinary device work
     * between ticks allowed to take" window -- collapsing a 30s tool to a
     * ~1s one. Every progress-driven extension (the SDK's own
     * `resetTimeoutOnProgress`, which reuses this SAME `timeout` value on
     * every reset, and this daemon's own `deadline`) uses THIS value
     * instead, independent of queue wait (#6222 review, P1).
     */
    ...[originalTimeoutMs, signal]: [originalTimeoutMs: number, signal?: AbortSignal]
  ): Promise<any> {
    signal?.throwIfAborted();
    const requestOptions = this.mcpRequestOptions(timeoutMs, signal);

    switch (request.method) {
      case "tools/list": {
        return await this.withAdmittedBoundSession(request.params, () =>
          mcpClient.listTools(undefined, requestOptions),
        );
      }
      case "tools/call": {
        const progressToken = request.progressToken;
        // Cleanup includes the live dispatch evidence on every tools/call and
        // the abort timer on progress-capable calls.
        // Lets a handler on the
        // OTHER side of this same call (e.g. `setUIStateHandler`) read this
        // exact `deadline`'s CURRENT (possibly progress-extended) value via
        // `liveDeadlineRegistry` instead of only the frozen snapshot forwarded
        // through `INTERNAL_MCP_REQUEST_TIMEOUT_PARAM` (issue #6222 P1 reopen).
        const liveDeadlineKey = this.idGenerator.next();
        this.forwardedCallKeys.set(request, liveDeadlineKey);
        registerLiveDeadline(liveDeadlineKey, deadline);
        let cleanup = () => unregisterLiveDeadline(liveDeadlineKey);

        let callOptions: Record<string, unknown> = requestOptions;
        if (progressToken !== undefined) {
          // A progress-emitting tool (e.g. a multi-field setUIState) needs
          // an ASYMMETRIC deadline that the SDK's own `timeout`/
          // `resetTimeoutOnProgress` cannot express: its `_resetTimeout`
          // reuses the exact SAME `timeout` value passed at setup for every
          // later reset, so there is no way through its public options to
          // have "the remaining, queue-adjusted budget before the first
          // tick, then the FULL original window after" -- setting `timeout`
          // to the full window up front would hand a request that waited
          // most of its budget in the per-session queue a fresh full window
          // BEFORE any progress exists, while the outer DaemonClient still
          // expires on its own (much smaller) remaining budget -- a
          // split-brain where the caller can time out while the daemon has
          // barely started (#6222 review, reconciliation). Conversely,
          // keeping `timeout` at the queue-adjusted remainder and relying
          // on `resetTimeoutOnProgress` would reset EVERY tick to that same
          // tiny remainder instead of the full window (#6222 review, P1).
          //
          // So this drives its own abort-based deadline instead, sharing
          // the SAME `deadline` object `requireRemainingMcpForwardBudget`
          // reads:
          //   - before any progress: aborts at `timeoutMs` (remaining
          //     budget), matching the outer client's own remaining budget.
          //   - on each REAL progress tick: `deadline.extendOnProgress`
          //     pushes the shared deadline forward by the FULL original
          //     window (`originalTimeoutMs`), bounded by its ceiling, and
          //     the abort is rearmed against the new remaining time.
          // The SDK's own `timeout`/`maxTotalTimeout` are set generously
          // (to the ceiling) purely as a backstop that should never fire
          // first in practice -- this controller is the actual authority.
          const controller = new AbortController();
          const armAbort = (delayMs: number): NodeJS.Timeout =>
            this.timer.setTimeout(
              () => controller.abort(`Request timed out after ${Math.max(delayMs, 0)}ms`),
              Math.max(delayMs, 0),
            );
          let abortTimer = armAbort(timeoutMs);
          const backstopMs = Math.max(deadline.ceiling - this.timer.now(), timeoutMs);
          const registeredLiveDeadlineKey = liveDeadlineKey;
          cleanup = () => {
            this.timer.clearTimeout(abortTimer);
            unregisterLiveDeadline(registeredLiveDeadlineKey);
          };

          callOptions = {
            ...requestOptions,
            signal: this.combineMcpRequestSignals(signal, controller.signal),
            timeout: backstopMs,
            maxTotalTimeout: backstopMs,
            // Relay progress ticks back to the ORIGINATING socket session,
            // tagged with the client's own token — never a
            // daemon-fabricated one (#6205). Also extends the DAEMON's OWN
            // request deadline (the one `requireRemainingMcpForwardBudget`
            // checks before a retry) and this call's own abort timer, both
            // by the FULL original window, bounded by `deadline`'s ceiling
            // (#6222 review, reconciliation).
            onprogress: (notification: { progress: number; total?: number; message?: string }) => {
              this.timer.clearTimeout(abortTimer);
              deadline.extendOnProgress(this.timer.now(), originalTimeoutMs);
              abortTimer = armAbort(deadline.value - this.timer.now());
              this.pushProgressNotification(
                socketSessionId,
                request.id,
                progressToken,
                notification.progress,
                notification.total,
                notification.message,
              );
            },
          };
        }

        try {
          return await this.withAdmittedBoundSession(request.params.arguments, () => {
            const forwardedArguments = this.withSocketSessionAutolockKey(
              request.params.arguments,
              socketSessionId,
              timeoutMs,
            );
            return this.traceCallTool(request, () =>
              mcpClient.callTool(
                {
                  name: request.params.name,
                  arguments: this.withLiveDeadlineKey(forwardedArguments, liveDeadlineKey),
                },
                undefined,
                callOptions,
              ),
            );
          }).catch((error: unknown) =>
            this.textForwardFailure(liveDeadlineKey, request.params.name, error),
          );
        } finally {
          cleanup();
        }
      }
      case "resources/list": {
        return await this.withAdmittedBoundSession(request.params, () =>
          mcpClient.listResources(undefined, requestOptions),
        );
      }
      case "resources/read": {
        if (!request.params?.uri) {
          throw new Error("resources/read requires params.uri");
        }
        return await this.withAdmittedBoundSession(this.boundSessionAdmissionArgs(request), () =>
          mcpClient.readResource({ uri: request.params.uri }, requestOptions),
        );
      }
      case "resources/list-templates": {
        return await this.withAdmittedBoundSession(request.params, () =>
          mcpClient.listResourceTemplates(undefined, requestOptions),
        );
      }
      case "ide/getNavigationGraph": {
        const args = {
          ...(request.params ?? {}),
          [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: timeoutMs,
        };
        return await mcpClient.callTool(
          { name: "getNavigationGraph", arguments: args },
          undefined,
          requestOptions,
        );
      }
      default:
        throw new Error(`Unsupported daemon method: ${request.method}`);
    }
  }

  private textForwardFailure(key: string, toolName: string, error: unknown) {
    // The daemon's deadline answer precedes DaemonClient.scheduleRequestTimeout,
    // which waits for budget + grace as a backstop for a silent daemon. The
    // primary text path clamps transport to deadline - TEXT_REQUEST_RESPONSE_MARGIN_MS
    // and returns its indeterminate result early.
    const indeterminate = getLiveTextRequestState(key)?.timeoutError(error);
    if (indeterminate) {
      return shapeToolCallError(indeterminate, { toolName, source: "MCP" });
    }
    throw error;
  }

  private async traceCallTool<T>(request: DaemonRequest, callTool: () => Promise<T>): Promise<T> {
    if (!this.onFrameTrace) {
      return await callTool();
    }
    const deviceId = this.frameDeviceId(request);
    this.traceFrame("callTool_entered", request.id, deviceId);
    try {
      return await callTool();
    } finally {
      this.traceFrame("callTool_settled", request.id, deviceId);
    }
  }

  /**
   * Merge {@link INTERNAL_LIVE_DEADLINE_KEY_PARAM} onto `args` when a live
   * deadline was registered for this call (issue #6222 P1 reopen) -- a no-op
   * when there is none, or `args` is not a plain forwardable object (e.g.
   * `null`/an array), in which case it is returned unchanged.
   */
  private withLiveDeadlineKey(args: unknown, liveDeadlineKey: string | undefined): unknown {
    if (liveDeadlineKey === undefined || !args || typeof args !== "object" || Array.isArray(args)) {
      return args;
    }
    return {
      ...(args as Record<string, unknown>),
      [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: liveDeadlineKey,
    };
  }

  private withSocketSessionAutolockKey(
    args: unknown,
    socketSessionId: string,
    timeoutMs: number,
  ): unknown {
    // Anchor the absolute deadline to THIS instant -- immediately before the
    // loopback `mcpClient.callTool` -- rather than letting the receiving
    // process re-derive it from `startTime + remainingMs` after its own HTTP
    // dispatch and admission/tool-selection repo reads have already consumed
    // part of `timeoutMs` (issue #6222 review, PRRT_kwDOP-GF5M6fuyts P1). See
    // `INTERNAL_MCP_REQUEST_DEADLINE_PARAM` for the full rationale.
    const deadlineMs = this.timer.now() + timeoutMs;
    if (args === null || args === undefined) {
      return {
        __mcpSessionId: socketSessionId,
        ...this.oneShotCliMarker(socketSessionId),
        [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: timeoutMs,
        [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: deadlineMs,
      };
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return args;
    }

    const forwardedArgs = { ...args } as Record<string, unknown>;
    delete forwardedArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    delete forwardedArgs[DAEMON_OWNED_SESSIONS_PARAM];
    delete forwardedArgs[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    this.recordOneShotCliConnection(socketSessionId, forwardedArgs);
    // Only the daemon asserts the loopback marker, from the connection's own declaration.
    delete forwardedArgs[INTERNAL_ONE_SHOT_CLI_PARAM];
    const boundSessionUuid = this.getSessionUuid(forwardedArgs);
    const usesBoundSession = forwardedArgs[DAEMON_BOUND_SESSION_PARAM] === boundSessionUuid;
    delete forwardedArgs[DAEMON_BOUND_SESSION_PARAM];
    delete forwardedArgs[DAEMON_RELEASED_SESSION_PARAM];
    // Connection-bound sessions are carried by the loopback transport header.
    // Released bindings are checked before this synchronous argument rewrite;
    // restart recovery reaches the same issued-session admission through the header.
    if (usesBoundSession) {
      delete forwardedArgs.sessionUuid;
    }
    return {
      ...forwardedArgs,
      __mcpSessionId: socketSessionId,
      ...this.oneShotCliMarker(socketSessionId),
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: timeoutMs,
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: deadlineMs,
    };
  }

  /**
   * Consume a one-shot `--cli` connection's declaration (#11096) and remember it for the
   * connection: every later call on the socket is forwarded with the loopback marker.
   */
  private recordOneShotCliConnection(
    socketSessionId: string,
    forwardedArgs: Record<string, unknown>,
  ): void {
    const declared = forwardedArgs[DAEMON_ONE_SHOT_CLI_PARAM] === true;
    delete forwardedArgs[DAEMON_ONE_SHOT_CLI_PARAM];
    const session = this.sessions.get(socketSessionId);
    if (declared && session) {
      session.oneShotCli = true;
    }
  }

  private oneShotCliMarker(socketSessionId: string): Record<string, true> {
    return this.sessions.get(socketSessionId)?.oneShotCli
      ? { [INTERNAL_ONE_SHOT_CLI_PARAM]: true }
      : {};
  }

  /**
   * Create an MCP client connected to the HTTP server
   */
  private async createMcpClient(
    boundSessionUuid?: string,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): Promise<Client> {
    logger.info(`Creating MCP client with endpoint: "${this.mcpEndpoint}"`);
    if (!this.mcpEndpoint) {
      logger.error(`ERROR: mcpEndpoint is empty or undefined when creating client!`);
      throw new Error("mcpEndpoint is not set");
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpEndpoint), {
      fetch: loopbackMcpFetch,
      reconnectionOptions: DAEMON_LOOPBACK_STREAMABLE_HTTP_RECONNECTION,
      ...(boundSessionUuid || toolSelectionProfileUuid || releasedSessionUuid
        ? {
            requestInit: {
              headers: {
                ...(boundSessionUuid
                  ? { [DAEMON_SESSION_TOOL_BINDING_HEADER]: boundSessionUuid }
                  : {}),
                ...(releasedSessionUuid
                  ? { [DAEMON_RELEASED_SESSION_HEADER]: releasedSessionUuid }
                  : {}),
                ...(toolSelectionProfileUuid
                  ? { [DAEMON_TOOL_SELECTION_PROFILE_HEADER]: toolSelectionProfileUuid }
                  : {}),
              },
            },
          }
        : {}),
    });

    const client = new Client(
      {
        name: "auto-mobile-daemon-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await client.connect(transport);
    logger.info(`MCP client connected to ${this.mcpEndpoint}`);

    return client;
  }

  /**
   * Get or create the MCP client for a target key.
   */
  private async getMcpClient(
    key: string,
    boundSessionUuid?: string,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): Promise<Client> {
    this.clearMcpClientIdleTimer(key);

    const existingClient = this.mcpClients.get(key);
    if (existingClient) {
      return existingClient;
    }

    const existingPromise = this.mcpClientPromises.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    const generation = this.lifecycleGeneration;
    const clientPromise = this.mcpClientFactory(
      boundSessionUuid,
      toolSelectionProfileUuid,
      releasedSessionUuid,
    )
      .then(async (client) => {
        if (
          this.closing ||
          generation !== this.lifecycleGeneration ||
          this.mcpClientPromises.get(key) !== clientPromise
        ) {
          await this.closeMcpClient(key, client);
          throw new Error("MCP client creation was superseded");
        }
        this.mcpClients.set(key, client);
        this.mcpClientPromises.delete(key);
        return client;
      })
      .catch((error) => {
        if (this.mcpClientPromises.get(key) === clientPromise) {
          this.mcpClientPromises.delete(key);
        }
        throw error;
      });

    this.mcpClientPromises.set(key, clientPromise);
    return clientPromise;
  }

  private async resetMcpClient(key: string, closeMode: "wait" | "detach" = "wait"): Promise<void> {
    this.clearMcpClientIdleTimer(key);
    const existingClient = this.mcpClients.get(key);
    this.mcpClients.delete(key);
    this.mcpClientPromises.delete(key);
    if (!existingClient) {
      return;
    }
    const close = Promise.resolve()
      .then(() => this.closeMcpClient(key, existingClient))
      .catch((error) => {
        logger.warn(`Error closing MCP client for key ${key}:`, error);
      });
    if (closeMode === "wait") {
      await close;
    }
  }

  private async closeMcpClient(key: string, client: Client): Promise<void> {
    const transport = client.transport;
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      try {
        await raceWithDeadline(transport.terminateSession(), {
          timer: this.timer,
          timeoutMs: MCP_SESSION_TERMINATION_TIMEOUT_MS,
          label: "MCP session termination",
          timeoutError: () => new Error("MCP session termination timed out"),
        });
      } catch (error) {
        // A failed DELETE is best-effort; closing the local client still releases its resources.
        logger.debug(`Could not terminate MCP session for key ${key}: ${error}`);
      }
    }
    await client.close();
  }

  private async resetMcpClientIfCurrent(
    key: string,
    expectedClient: Client,
    closeMode: "wait" | "detach" = "wait",
  ): Promise<boolean> {
    if (this.mcpClients.get(key) !== expectedClient) {
      return false;
    }
    await this.resetMcpClient(key, closeMode);
    return true;
  }

  // Clean up after a reconnect that blew its deadline without clobbering an
  // unrelated request. Two teardown paths, each fenced to what this wait owns:
  //   1. If our creation is still the pending one, drop it so a hung factory does
  //      not leak; a resolved or superseded creation has already cleared itself.
  //   2. When our own creation does resolve, close that specific client only while
  //      it remains the cached one — never a replacement another request installed
  //      under the same key (issue #5499). Fire-and-forget: the connection may
  //      never settle, so the request must not block on it.
  private discardTimedOutMcpReconnect(
    key: string,
    connection: Promise<Client>,
    pendingCreation: Promise<Client> | undefined,
  ): void {
    if (pendingCreation && this.mcpClientPromises.get(key) === pendingCreation) {
      this.mcpClientPromises.delete(key);
    }
    void connection
      .then((client) => this.resetMcpClientIfCurrent(key, client, "detach"))
      .catch(() => {
        // Creation was superseded or failed; nothing of ours remains to discard.
      });
  }

  private scheduleMcpClientIdleClose(key: string): void {
    this.clearMcpClientIdleTimer(key);
    const timer = this.timer.setTimeout(() => {
      void this.closeIdleMcpClient(key);
    }, MCP_CLIENT_IDLE_CLOSE_MS);
    this.mcpClientIdleTimers.set(key, timer);
  }

  private clearMcpClientIdleTimer(key: string): void {
    const timer = this.mcpClientIdleTimers.get(key);
    if (!timer) {
      return;
    }
    this.timer.clearTimeout(timer);
    this.mcpClientIdleTimers.delete(key);
  }

  private async closeIdleMcpClient(key: string): Promise<void> {
    this.mcpClientIdleTimers.delete(key);
    if (
      this.mcpForwardTails.has(key) ||
      this.activeMcpClientForwardCounts.has(key) ||
      this.isMcpClientKeyBound(key)
    ) {
      return;
    }
    // The append helper shares the device's idle lifecycle: once nothing has
    // used this device key for the idle window, drop the cached InputText so
    // its API-level cache cannot go stale across a device swap under the same id.
    const devicePrefix = "device:";
    if (key.startsWith(devicePrefix)) {
      this.appendTextInputs.delete(key.slice(devicePrefix.length));
    }
    await this.resetMcpClient(key);
  }

  /**
   * Drop the cached append helper after a device lifecycle change (issue #3351).
   *
   * The cache is keyed by deviceId and otherwise lives until the 5-minute idle
   * close. If an emulator is replaced under a reused serial (`emulator-5554`)
   * before then, the next device would inherit the previous one's cached API-level
   * capability — an API 31+ / pre-31 mismatch that mis-handles SHIFT and uppercase.
   * The device pool calls this after it adds a device, rediscovers it during a
   * refresh, or binds it after startDevice. Direct socket discovery also rebuilds
   * a helper when ADB reports a changed transport id for the same serial. The
   * confirmed-disconnect monitor remains a backstop.
   * Idempotent; safe for an unknown id.
   */
  evictDeviceInputCache(deviceId: string): void {
    if (this.appendTextInputs.delete(deviceId)) {
      logger.debug(`[UnixSocketServer] Evicted cached append helper for device ${deviceId}`);
    }
  }

  /**
   * Cached-per-device accessor for the append helper; see
   * {@link appendTextInputs}. Keyed on the pool's connection epoch so a
   * same-serial reincarnation cannot inherit the previous device's probed API
   * level. `fromCache` tells the caller whether a failure is worth retrying
   * against a freshly built helper.
   */
  private getAppendTextInput(device: BootedDevice): {
    input: AppendTextInput;
    fromCache: boolean;
  } {
    const incarnationToken = deviceIncarnationToken(device.deviceId);
    const existing = this.appendTextInputs.get(device.deviceId);
    if (existing && existing.incarnationToken === incarnationToken) {
      return { input: existing.input, fromCache: true };
    }
    if (existing) {
      logger.debug(
        `[UnixSocketServer] Rebuilding cached append helper for ${device.deviceId}: ` +
          `pool incarnation changed from ${existing.incarnationToken} to ${incarnationToken}`,
      );
    }
    const created = this.appendTextFactory(device);
    this.appendTextInputs.set(device.deviceId, { input: created, incarnationToken });
    return { input: created, fromCache: false };
  }

  /**
   * Run one admitted handler, releasing its socket admission slot as soon as its
   * client cancels it (issue #6384). A cancelled handler that has not started never
   * runs; a started one keeps winding down on its aborted signal, tracked so
   * shutdown still drains it, while later requests proceed.
   */
  private async runCancellableQueuedHandler<T>(
    handler: () => Promise<T>,
    cancelSignal: AbortSignal | undefined,
  ): Promise<T> {
    if (!cancelSignal) {
      return await handler();
    }
    cancelSignal.throwIfAborted();
    const operation = handler();
    this.trackRequestHandler(
      operation.then(
        () => {},
        () => {},
      ),
    );
    return await raceWithDeadline(operation, {
      timer: this.timer,
      signal: cancelSignal,
      label: "Cancelled socket request",
    });
  }

  /**
   * Check if socket server is listening
   */
  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Connected control-socket clients (orphaned private-daemon watchdog, #10497). */
  getClientConnectionCount(): number {
    return this.clientSockets.size;
  }

  /** Monotonic count of control-socket connections accepted (orphan watchdog, #10497). */
  getAcceptedClientConnectionCount(): number {
    return this.acceptedClientConnections;
  }

  /**
   * Stop admitting control-socket work while preserving connected notification
   * subscribers. Daemon shutdown uses this barrier before releasing device
   * sessions, so no new request can mint or refresh a session after the shutdown
   * snapshot while each bound proxy can still receive its exact release reason.
   */
  async quiesce(): Promise<void> {
    this.acceptingRequests = false;
    // Stop new connections immediately while keeping established notification
    // subscribers alive long enough to receive session-release frames. Any
    // connection that has not opted in cannot receive the shutdown reason, so
    // close it now and let its proxy reconnect to the successor daemon.
    void this.closeListeningServer(this.isOwnedSocketFile());
    for (const [sessionId, socket] of this.clientSockets) {
      if (!this.notificationSubscribers.has(sessionId) && !socket.destroyed) {
        socket.end();
      }
    }
    await this.drainActiveRequestHandlers();
  }

  /** Wait for release frames to flush to client sockets, bounded for shutdown. */
  async drainSessionReleaseNotifications(): Promise<void> {
    const pendingWrites = Array.from(this.pendingSessionReleaseWrites);
    if (pendingWrites.length === 0) {
      return;
    }

    const timedOut = Symbol("notification drain timeout");
    let drained = true;
    try {
      await raceWithDeadline(Promise.allSettled(pendingWrites), {
        timer: this.timer,
        timeoutMs: DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS,
        label: "Session release notification drain",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      drained = false;
    }
    if (!drained) {
      logger.warn(
        `Timed out waiting for ${pendingWrites.length} session-release notification(s) to flush during shutdown`,
      );
    }
  }

  /**
   * Stop the Unix socket server
   */
  async close(): Promise<void> {
    logger.info("Closing Unix socket server...");
    this.closing = true;
    this.acceptingRequests = false;
    this.lifecycleGeneration += 1;
    this.releaseDaemonMaintenanceAdmission(this.maintenanceAdmissionToken);
    this.releaseAcceptanceRestartAdmission(this.acceptanceRestartAdmissionToken);

    // Stop receiving list-changed events (mirrors the subscribe in start()).
    this.listChangedUnsubscribe?.();
    this.listChangedUnsubscribe = null;
    this.resourceUpdatedUnsubscribe?.();
    this.resourceUpdatedUnsubscribe = null;

    // Stop receiving session-release events (mirrors the subscribe in start()).
    this.sessionReleaseUnsubscribe?.();
    this.sessionReleaseUnsubscribe = null;

    // Keep sockets and session bookkeeping alive while handlers finish and write.
    // The listener stops new connections now; existing requests get the bounded drain.
    const clientSockets = Array.from(this.clientSockets.values());
    const ownsSocketPath = this.isOwnedSocketFile();
    const serverClosed = this.closeListeningServer(ownsSocketPath);

    // Queued requests have not started device work and must not begin during shutdown.
    for (const pending of this.pendingSocketRequests) {
      if (!pending.admitted) {
        this.writeShutdownSocketResponse(pending);
      }
    }
    const requestHandlersDrained = this.drainActiveRequestHandlers();
    await requestHandlersDrained;
    for (const pending of this.pendingSocketRequests) {
      this.writeShutdownSocketResponse(pending);
    }
    this.destroyClientSockets(clientSockets);
    await serverClosed;
    this.sessions.clear();
    this.clientSockets.clear();
    this.notificationSubscribers.clear();
    this.resourceSubscriptions.clear();
    this.server = null;

    // Existing forwards may need their MCP clients throughout the drain. Close
    // those clients only after every socket has received its terminal frames.
    const clients = Array.from(this.mcpClients.entries());
    this.mcpClients.clear();
    this.mcpClientPromises.clear();
    this.boundMcpClientKeysBySocketSession.clear();
    for (const timer of this.mcpClientIdleTimers.values()) {
      this.timer.clearTimeout(timer);
    }
    this.mcpClientIdleTimers.clear();
    for (const [key, client] of clients) {
      try {
        await this.closeMcpClient(key, client);
      } catch (error) {
        logger.warn(`Error closing MCP client for key ${key}:`, error);
      }
    }
    this.mcpForwardTails.clear();
    this.mcpForwardIdleCloseKeys.clear();
    this.appendTextInputs.clear();

    // The listener removes the socket it created as part of close(). Do not
    // unlink the pathname afterward: a successor can bind in the interval and
    // filesystems are allowed to reuse the original socket inode immediately.
    this.socketFileIdentity = null;
  }

  private writeShutdownSocketResponse(pending: PendingSocketRequest): void {
    this.writeTerminalSocketResponse(pending, {
      id: pending.id,
      type: "mcp_response",
      success: false,
      error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
      daemonShuttingDown: daemonShuttingDownFailure(pending.admitted),
    });
  }

  private closeListeningServer(ownsSocketPath: boolean): Promise<void> {
    if (this.serverClosePromise) {
      return this.serverClosePromise;
    }
    if (!this.server) {
      return Promise.resolve();
    }
    if (!ownsSocketPath && existsSync(this.socketPath)) {
      logger.warn(
        `Unix socket path ${this.socketPath} no longer belongs to this server; leaving listener for process teardown`,
      );
      this.server.unref();
      return Promise.resolve();
    }
    this.serverClosePromise = new Promise((resolve) => {
      this.server!.close(() => {
        logger.info("Unix socket server closed");
        resolve();
      });
    });
    return this.serverClosePromise;
  }

  private destroyClientSockets(clientSockets: Socket[]): void {
    for (const socket of clientSockets) {
      if (!socket.destroyed) {
        // `destroy()` may discard a just-flushed session-release frame and reset
        // the peer before it can read the exact daemon-shutdown reason. End the
        // writable side and destroy only after its buffer drains, with a bounded
        // fallback for a non-reading peer.
        const forceClose = this.timer.setTimeout(
          () => socket.destroy(),
          DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS,
        );
        socket.once("close", () => this.timer.clearTimeout(forceClose));
        socket.end();
      }
    }
  }

  private async drainActiveRequestHandlers(): Promise<void> {
    const handlers = Array.from(this.activeRequestHandlers);
    if (handlers.length === 0) {
      return;
    }

    const timedOut = Symbol("request handler drain timeout");
    let drained = true;
    try {
      await raceWithDeadline(Promise.allSettled(handlers), {
        timer: this.timer,
        timeoutMs: DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS,
        label: "Unix socket request drain",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      drained = false;
    }
    if (!drained) {
      logger.warn(
        `Timed out waiting for ${handlers.length} in-flight Unix socket request handler(s) to finish during shutdown`,
      );
    }
  }

  private readSocketFileIdentity(): SocketFileIdentity | null {
    try {
      const stats = statSync(this.socketPath);
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      // statSync fails if the socket file was removed/replaced concurrently; callers
      // treat a null identity as "can't confirm ownership" rather than a hard error.
      logger.debug(`src/daemon/socketServer.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  private isOwnedSocketFile(): boolean {
    if (!this.socketFileIdentity || !existsSync(this.socketPath)) {
      return false;
    }
    const currentIdentity = this.readSocketFileIdentity();
    return (
      currentIdentity?.dev === this.socketFileIdentity.dev &&
      currentIdentity.ino === this.socketFileIdentity.ino
    );
  }
}
