import { defaultLockOwnerGenerationProbe } from "./lockOwnerGeneration";
import {
  parseInputGestureParams,
  parseInputKeyParams,
  parseInputPressButtonParams,
  parseInputSwipeParams,
  parseInputTapParams,
  parseInputTypeTextParams,
  type InputGestureParams,
  type InputKeyParams,
  type InputPressButtonParams,
  type InputSwipeParams,
  type InputTapParams,
  type InputTypeTextParams,
} from "./inputRouteParams";
import {
  dispatchInputRoute,
  isOwnerFencedMethod,
  runPassthroughForward,
  type InputRouteHandlers,
} from "./socketServer/controlRoutes";
import { IDE_DEVICE_MUTATION_METHODS, IDE_ROUTE_PARSERS, STARTUP_PROBE_METHODS } from "./ideRoutes";
import { ideFeatureRoutes } from "./socketServer/ideRouteModule";
import type { IdeMutationCall } from "./socketServer/ideMutationCall";
import { daemonLifecycleRoutes } from "./socketServer/lifecycleRouteModule";
import {
  DISPATCH_HELD_INPUT_METHODS,
  GESTURE_FRAME_METHODS,
  inputRouteFor,
  type GestureFrameKind,
  type InputRouteEntry,
  type InputRouteMethod,
} from "./inputRoutes";
import { throwIfAborted } from "../utils/toolUtils";
import { holdDispatchedRequest } from "./dispatchedRequestHold";
import { idleReleaseField } from "./releaseReasons";
import {
  applyResourceSubscription,
  broadcastListChanged as fanOutListChanged,
  broadcastResourceUpdated as fanOutResourceUpdated,
  broadcastSessionReleased as fanOutSessionReleased,
  pushProgressNotification as fanOutProgress,
  type NotificationTransport,
} from "./socketServer/notificationFanOut";
import { shapeToolCallError } from "../server/shapeToolCallError";
import type { SessionRecoveryAssignmentDetails } from "../models/SessionRecoveryAssignmentError";
import { readToolEnvelopePayload } from "../server/toolEnvelopePayload";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { runWithAbortSignal } from "../utils/AbortContext";
import { createServer, Server as NetServer, Socket } from "node:net";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ensureSecureDir, secureFile } from "../utils/filesystem/securePermissions";
import type { Client } from "@modelcontextprotocol/client";
import { dropToolCallRecording } from "../server/toolCallRecordingManager";
import { daemonSessionToolBindingStore } from "../server/daemonSessionToolBindingStore";
import {} from "../server/toolUnavailableError";
import { logger } from "../utils/logger";
import type { RefusedOwnedSessionRestore } from "./devicePool";
import { GestureOwnershipRegistry } from "./gestureOwnership";
import { resolveMcpRequestTimeoutMsOnce, ProgressExtendableDeadline } from "./mcpRequestTimeout";
import { createRequestContext, type RequestContext } from "./requestContext";
import { McpOverloadError, McpTimeoutError, MCP_QUEUE_TIMEOUT_ERROR_CODE } from "./McpTimeoutError";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { isDebugModeEnabled } from "../utils/debug";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  BOUND_SESSION_LOSS_CODE,
  DaemonNotification,
  DaemonRequest,
  DaemonResponse,
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
} from "./constants";
import {
  isHostInventoryCall,
  resolveSocketAdmissionLane,
  SocketRequestAdmissionQueue,
} from "./socketRequestAdmission";
import {
  daemonShuttingDownFailure,
  daemonShuttingDownFrameFields,
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
  type ResourceUpdateTargets,
  type ListChangedKind,
} from "../server/listChangedBroadcast";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
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
import { defaultDaemonContext } from "./daemonContext";
import { canonicalizeToolCallDeviceIds, toolCallNamesDeviceId } from "./toolCallDeviceIdentity";
import { isDeviceInventoryTool } from "./daemonMcpProxy";
import { DaemonStateAccess, handleDaemonRequest } from "./daemonRequestHandlers";
import { isDaemonRequestEnvelope, readFramePlatformHint } from "./daemonRequestEnvelope";
import { deviceIncarnationToken } from "../utils/deviceIncarnation";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { DAEMON_RPC_SOCKET_MAX_QUEUED_BYTES } from "./outboundWriteGuard";
import { ControlConnection } from "./socketServer/ControlConnection";
import { type IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import type { FeatureFlagAdmin } from "../features/featureFlags/FeatureFlagService";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "../features/toolSelection/SessionToolSelectionService";
import { assertToolEnabledForAnySession } from "../features/toolSelection/toolSelectionPolicy";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import {
  admitInputOnHolderSession,
  InputDeviceOwnedError,
  assertControlNotOnForeignDaemonDevice,
  assertInputNotOnForeignBindingDevice,
  assertInputRequesterHoldsDevice,
  deviceAlreadyAssignedToAnotherSessionError,
  parseInputRequesterSessionUuid,
} from "./inputDeviceOwnership";
import { SessionNoLongerOwnsDeviceError } from "./sessionNoLongerOwnsDevice";
import { ToolRegistry } from "../server/toolRegistry";
import {
  assertFrameTargetIdentityProven,
  canonicalFrameDeviceId,
  canonicalizeFrameDiscovery,
  frameHeldSessionsFrom,
  type CanonicalFrameDiscovery,
  type FrameDeviceIdentityPool,
} from "./frameDeviceIdentity";
import {
  brokerConnectionControlRefusal,
  brokerConnectionHostMutationRefusal,
} from "./sessionBroker/connectionScope";
import { provisionCancellationOutcomes } from "./provisionCancellationOutcomes";
import { PROVISION_DEVICE_SETTLEMENT_WAIT_MS } from "../features/deviceLifecycle/deviceLifecycleCore";

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
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../models/BootedDeviceDiscoveryIncompleteError";
import { expectingPooledSources, isDeviceSourceIncomplete } from "../utils/discoverySource";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { PressButton } from "../features/action/PressButton";
import {
  INPUT_KEY_IOS_UNSUPPORTED_ERROR,
  InputKey,
  type InputKeyName,
} from "../features/action/InputKey";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { canonicalPixelsToPoints } from "./canonicalPixels";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type {
  KeyValueType,
  PreferenceStoreResolution,
  StorageWriteOptions,
} from "../features/storage/storageTypes";
import type {
  AppendTextFailureSource,
  BootedDevice,
  ImeAction,
  ScreenScaleMetadata,
} from "../models";
import {
  executionTracker,
  sessionExecutionMetadataOf,
  type ActiveExecution,
} from "../server/executionTracker";
import { type DaemonGenerationIdentity } from "./liveAcceptanceCapability";
import { daemonGenerationMatches } from "./processGeneration";
import {
  DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS,
  DAEMON_MAINTENANCE_ADMISSION_TTL_MS,
  RestartAdmission,
} from "./socketServer/restartAdmission";
export { DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS, DAEMON_MAINTENANCE_ADMISSION_TTL_MS };
import {
  processGenerationRecordFields,
  recordedProcessGenerationToken,
} from "./processGenerationFields";
import {
  isSessionRefusal,
  mcpRequestFailureDetails,
  requestFailureCause,
} from "./socketServer/errorFrames";
import type { UnixSocketServerTestHooks } from "./socketServer/unixSocketServerTestHooks";
import { indeterminateInputError } from "./socketServer/forwardFailures";
import { isTaskRelayMethod, parseTaskRelayFrame } from "../server/tasks/taskRelay";
import {
  callForwardedTool,
  forwardTaskRequest,
  taskRelayErrorFrame,
} from "./socketServer/taskRelayForward";
import {
  currentForwardSessionKey,
  currentForwardTaskOwnerKey,
  FORWARD_KEY_IDLE_MS,
  type McpClientFactory,
  runWithForwardSessionKey,
} from "./socketServer/forwardSessionKey";
import { runKeyedSerial, type McpForwardChainWait } from "./socketServer/keyedSerialQueue";
import {
  PendingRequestTracker,
  type PendingSocketRequest,
} from "./socketServer/PendingRequestTracker";
import { CONTROL_SOCKET_MAX_FRAME_BYTES } from "./socketServer/LineFramer";
import {
  SessionReleasedDuringCallError,
  sessionReleaseThatCancelledCall,
} from "./sessionReleasedDuringCall";
import { createDaemonMcpDispatcher, type InProcessMcpDispatcher } from "./inProcessMcpDispatcher";

export { mcpRequestFailureDetails };

export const MCP_FORWARD_START_HEADROOM_MS = 100;
/**
 * How many times one forward may follow its route to a different execution key before it
 * fails. Each hop releases the previous key first, so this only bounds route churn; it is
 * not what prevents the crossed-route deadlock (issue #6388).
 */
export const MAX_MCP_FORWARD_REROUTES = 3;
const MCP_OVERLOAD_RETRY_AFTER_MS = 250;

function socketRequestId(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

class ClientRequestCancellation extends ActionableError {}

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

function resolveIdentityStartedAt(value: number | undefined, timer: Timer): number {
  return value === undefined ? timer.now() : value;
}

function snapshotDaemonOptions(options: DaemonOptions | undefined): DaemonOptions {
  return structuredClone(options ?? {});
}

const DEVICE_ACQUISITION_TOOL_NAMES = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
]);
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
    acquire: () =>
      tryAcquireExclusiveLock(lockFilePath, {
        ownerToken,
        ownerGeneration: defaultLockOwnerGenerationProbe,
      }),
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
 * tests. MCP forwards are serialized by target key below, so independent devices/sessions can
 * run concurrently. Each forward runs in process (#11820): its own MCP client and stateless
 * server, named by the socket session id as its MCP session key.
 */
interface SocketFileIdentity {
  dev: number;
  ino: number;
}

/**
 * Creates the MCP HTTP client the daemon forwards `tools/call` requests through.
 * Injected so tests can substitute a fake without monkeypatching a private method
 * by name (a name-based patch silently no-ops if the internal creator is renamed,
 * leaving forwarding dead but the suite green).
 */
export type { McpClientFactory };

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
    onDispatch?: () => void,
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

/** One keyed attempt either ran the forward or found its route moved to another key. */
type McpForwardAttempt<T> =
  | { kind: "done"; value: T }
  | { kind: "reroute"; route: McpForwardRoute };

/** Recovery lookup is optional only for older socket-state fakes. */
interface SocketDaemonStateAccess extends DaemonStateAccess {
  getSessionManager(): ReturnType<DaemonStateAccess["getSessionManager"]> & {
    ownershipSessionUuid?(sessionId: string): string;
    isReleasedSessionInRestartRecoveryWindow?(sessionId: string): Promise<boolean>;
    getExpiredReleaseSnapshot?(sessionId: string): Promise<BoundSessionLoss["release"]>;
  };
  getDevicePool(): ReturnType<DaemonStateAccess["getDevicePool"]> &
    FrameDeviceIdentityPool & {
      getDevice?(deviceId: string): { autolockSessionId?: string | null } | null | undefined;
      resolveOwnedDeviceSessionForMcpSession?(
        mcpSessionId: string | undefined,
        deviceId: string,
      ): string | undefined;
      isSessionOwnedByOtherConnection?(sessionId: string, mcpSessionId?: string): boolean;
      assertNotClaimedByForeignDaemon?(
        deviceId: string,
        platform: "android" | "ios",
        remedy?: string,
        maxAgeMs?: number,
      ): Promise<void>;
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

/** How long a closed socket's late executions may still write bindings that are then forgotten. */
const LATE_BINDING_FORGET_WINDOW_MS = 15 * 60 * 1000;

export interface McpForwardRoute {
  /** Serializes work that targets the same physical device or session. */
  executionKey: string;
  /** Owns the loopback MCP transport and its session-local tool-selection profile. */
  clientKey: string;
  /** Replayed when this transport needs to establish a fresh MCP session. */
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  releasedSessionUuid?: string;
}

interface McpForwardContext {
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

const isNonBlankSessionUuid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * One `input/*` frame's device work. It calls `dispatching` once every pre-dispatch check passed
 * (owner still there, current frame context, budget left, coordinates in bounds), immediately
 * at the successful send for tap/swipe, or before device work for the other input routes: only
 * then is the frame use of the holder's session (#11596, #11750).
 * `runTrackedDeviceInput` always supplies it; it is absent only when a test drives a handler
 * without that funnel.
 */
type InputOperation<T> = (signal?: AbortSignal, dispatching?: () => void) => Promise<T>;

function isExpectedSocketFrameAbort(error: unknown, socketDestroyed: boolean): boolean {
  return (
    error instanceof ClientRequestCancellation ||
    (socketDestroyed &&
      error instanceof Error &&
      error.message === "Daemon MCP client disconnected")
  );
}

function assertSocketInputNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Owner context the socket path hands to an `input/*` handler (#10006). */
interface InputRequestContext {
  /** Synchronously ends the admission cancellation race at this frame's first send. */
  onDispatch?: () => void;
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
  onDispatch?: () => void;
  ownerSignal?: AbortSignal;
  chainWait?: McpForwardChainWait;
  /** Who sent the frame; only the device's holder may drive a held device (#10698). */
  requester?: () => string | undefined;
}

/** What held the device when a `gestureStart` was admitted (#11541). */
export interface StrokeAdmission {
  deviceId: string;
  /** The admitting holder; absent for a start on a device no session held. */
  holderSessionId?: string;
  /** The holder's session object: a re-created session with the same id is another holder. */
  holderIncarnation?: object;
  /** Aborted when the frame's tracked execution or its owner was cancelled. */
  signal?: AbortSignal;
}

/**
 * The answer to a `gestureStart` whose stroke was lifted because its admission ended before the
 * ack: whatever aborted the frame (the typed release or ownership refusal), else that the holder
 * changed.
 */
export function strokeAdmissionEndedError(method: string, admission: StrokeAdmission): unknown {
  if (admission.signal?.aborted) {
    return admission.signal.reason;
  }
  const { deviceId, holderSessionId } = admission;
  const lifted = (cause: string) =>
    `${method} on device '${deviceId}' was lifted: ${cause} before the stroke's start was acknowledged.`;
  // Typed like the frames that follow the lifted start (#11351): the admitting holder left the
  // device, or a session now holds a device the sessionless start was admitted on.
  return holderSessionId
    ? new SessionNoLongerOwnsDeviceError(
        holderSessionId,
        deviceId,
        lifted(`session ${holderSessionId} no longer holds the device`),
      )
    : new InputDeviceOwnedError(
        method,
        deviceId,
        undefined,
        undefined,
        lifted("a session acquired the device"),
      );
}

/** Timeout for the best-effort cancelling `gestureEnd` issued when a socket owning a gesture closes. */
const OWNED_GESTURE_CANCEL_TIMEOUT_MS = 5000;

/**
 * The narrow key-value mutation surface the `ide/*` handlers need from a
 * platform CtrlProxy client. Both AndroidCtrlProxyClient and IOSCtrlProxyClient
 * satisfy it structurally (#4708). Storage writes notify onDispatch synchronously after a
 * successful socket send; connecting, cancellation and send failures are not session use.
 */
interface KeyValueMutationClient {
  setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string,
    type: KeyValueType,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | void>;
  removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | void>;
  clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
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
  onDispatch?: () => void;
  targetDevice: BootedDevice;
  text: string;
  deadline: number;
  totalTimeoutMs: number;
  frameContext: string | undefined;
  client: AndroidCtrlProxyClient;
  signal?: AbortSignal;
}

/** What every input device write settles with. */
interface InputRouteResult {
  success: boolean;
  error?: string;
}

interface InputRouteArgs {
  platform: "android" | "ios";
  deviceId?: string;
  frameContext?: string;
}

/** What `runInputRoute` hands a route's dispatch once every pre-dispatch check has passed. */
interface InputRouteStep {
  targetDevice: BootedDevice;
  /** The device the write targets: the target, or its re-resolved transport. */
  executionDevice: BootedDevice;
  signal: AbortSignal | undefined;
  /** Stamps the session's idle window; call it only when the device write starts. */
  dispatching: (() => void) | undefined;
  remainingTimeoutMs: number;
  queueEnterMs: number;
  totalTimeoutMs: number;
}

interface InputRouteRun<A extends InputRouteArgs, R extends InputRouteResult> {
  action: InputTargetAction;
  origin: string;
  args: A;
  bypassAndroidDeviceListCache?: boolean;
  /** Re-reads the device inside the keyed callback (typeText append). */
  reresolve?: (device: BootedDevice) => Promise<BootedDevice>;
  /** Whether the args' frameContext must still be the device's current frame. */
  checksFrame: boolean;
  /** Wraps the whole tracked run (gesture stroke lifting on a session refusal). */
  around?: (device: BootedDevice, run: () => Promise<R>) => Promise<R>;
  dispatch: (step: InputRouteStep) => Promise<R>;
}

type InputTargetAction = InputRouteMethod;

type IdeServerRouteHandler = (
  request: DaemonRequest,
  socketSessionId: string | undefined,
  ideMutation: IdeMutationCall | undefined,
) => Promise<any | undefined> | any;

export class UnixSocketServer {
  protected server: NetServer | null = null;
  private serverClosePromise: Promise<void> | null = null;
  private closing = false;
  protected acceptingRequests = false;
  /** Largest inbound frame a control-socket peer may send; tests lower it. */
  protected readonly maxInboundFrameBytes = CONTROL_SOCKET_MAX_FRAME_BYTES;
  private lifecycleGeneration = 0;
  private socketFileIdentity: SocketFileIdentity | null = null;
  private readonly adbClientFactory: AdbClientFactory;
  protected sessions: Map<string, SessionContext> = new Map();
  /** Live client sockets by session ID, for server-pushed notification frames (issue #3223). */
  protected clientSockets: Map<string, Socket> = new Map();
  private acceptedClientConnections = 0;
  /** Per-socket outbound byte bound and stall watchdog (issue #10176). */
  private readonly controlConnections = new WeakMap<Socket, ControlConnection>();
  /** Request handlers that can continue after their client socket is destroyed. */
  protected activeRequestHandlers: Set<Promise<void>> = new Set();
  /** Parsed requests awaiting their one terminal response to flush, including queued requests. */
  protected pendingSocketRequests = new PendingRequestTracker();
  /** Socket sessions that opted in to server-pushed notifications. */
  protected notificationSubscribers: Set<string> = new Set();
  protected readonly resourceSubscriptions = new Map<string, Set<string>>();
  /**
   * The session that owned each resolved input target at resolution time, so a rebind between
   * resolution and execution cannot leave the input running as an unowned call (#9958).
   */
  private readonly inputTargetOwners = new WeakMap<BootedDevice, string>();
  private resourceUpdatedUnsubscribe: (() => void) | null = null;
  /** Session-release frames written but not yet flushed to their client sockets. */
  private pendingSessionReleaseWrites: Set<Promise<void>> = new Set();
  protected listChangedUnsubscribe: (() => void) | null = null;
  protected sessionReleaseUnsubscribe: (() => void) | null = null;
  private socketPath: string;
  private daemonState: SocketDaemonStateAccess;
  /**
   * The loopback MCP client that a socket transport most recently bound with a
   * device session. Follow-up requests can omit their session UUID, so reuse
   * this client to preserve the selected tool-selection profile.
   */
  protected boundMcpClientKeysBySocketSession: Map<string, BoundMcpClient> = new Map();
  /** Promise tails that serialize MCP forwards only within the same execution target. */
  protected mcpForwardTails: Map<string, Promise<void>> = new Map();
  /** Direct device forwards that need cleanup after every successor tail has settled. */
  private mcpForwardIdleCloseKeys: Map<string, Set<string>> = new Map();
  /** Execution keys whose chain drained, timed for the append-helper idle eviction. */
  private forwardKeyIdleTimers: Map<string, NodeJS.Timeout> = new Map();
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
  private featureFlagService: FeatureFlagAdmin | null;
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
  private restartAdmission!: RestartAdmission;
  private readonly sessionToolSelectionService?: Pick<
    SessionToolSelectionService,
    "isEnabled" | "setEnabled"
  >;
  /** Runs every forward in process: its own MCP client and stateless server (#11820). */
  private readonly mcpDispatcher: Pick<InProcessMcpDispatcher, "connect">;
  /** Forwarded MCP requests are cancelled when their owner socket disconnects. */
  private readonly mcpRequestAbortControllers = new Map<string, Set<AbortController>>();
  /** Test seam: the per-args `deviceReadOnly` classification behind the read lane (#10969). */
  deviceReadToolCallClassifier: DeviceReadToolCallClassifier = registeredDeviceReadClassifier;

  mcpClientFactory: McpClientFactory = (
    sessionUuid,
    toolSelectionProfileUuid,
    releasedSessionUuid,
  ) => this.createMcpClient(sessionUuid, toolSelectionProfileUuid, releasedSessionUuid);

  /** Connection recording teardown seam, like the injectable factories below. */
  releaseToolCallRecording: (connectionId: string) => void = dropToolCallRecording;

  /**
   * Drops the session-tool bindings keyed on a socket session id once its socket is gone (#4678):
   * the daemon-scoped store would otherwise keep one entry per connection forever.
   */
  forgetSessionToolBindings: (socketSessionId: string) => void = (socketSessionId) =>
    daemonSessionToolBindingStore().forget(socketSessionId);

  /**
   * Factory for the Android append-text helper behind `input/typeText mode:"append"`.
   *
   * Defaults to the real {@link InputText} bound to the default adb client factory and
   * this server's timer; tests assign a fake so the append path is exercised without
   * shelling out to a real `adb` (and so a stalled subprocess can be simulated).
   */
  appendTextFactory: (device: BootedDevice) => AppendTextInput = (device) =>
    this.createSocketAppendTextInput(device);

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
  protected readonly ownedGestures = new GestureOwnershipRegistry({
    isSocketLive: (socketSessionId) => this.clientSockets.has(socketSessionId),
    cancelGesture: (targetDevice, gestureId) => this.cancelGestureOnDevice(targetDevice, gestureId),
  });

  constructor(
    socketPath: string = SOCKET_PATH,
    daemonState: SocketDaemonStateAccess = defaultDaemonContext.daemonState(),
    timer: Timer = defaultTimer,
    featureFlagService: FeatureFlagAdmin | null = null,
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
      /**
       * Runs forwards in process (#11820). The daemon passes its own, so shutdown can close the
       * forwards still running; without one the server builds a default over the shared state.
       */
      mcpDispatcher?: Pick<InProcessMcpDispatcher, "connect">;
    } = {},
    idGenerator: IdGenerator = defaultIdGenerator,
    bindGuard: SocketBindGuardOptions = {},
    adbClientFactory: AdbClientFactory = defaultAdbClientFactory,
  ) {
    this.socketPath = socketPath;
    this.daemonState = daemonState;
    this.timer = timer;
    this.onFrameTrace = handshakeConfig.onFrameTrace;
    this.mcpDispatcher =
      handshakeConfig.mcpDispatcher ??
      createDaemonMcpDispatcher({
        base: () => ({
          acceptanceDiscoveryCapability: handshakeConfig.acceptanceDiscoveryCapability,
        }),
      });
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
    this.restartAdmission = new RestartAdmission({
      timer: this.timer,
      idGenerator: this.idGenerator,
      generationMatches: (params) => this.daemonGenerationMatches(params),
      currentIdentity: () => this.currentGenerationIdentity(),
      getAllSessions: () => this.daemonState.getSessionManager().getAllSessions?.(),
      onRestartAccepted: this.onRestartAccepted,
      liveAcceptanceStartupSecret: this.liveAcceptanceStartupSecret,
    });
    // Forwards run in process (#11820) through the MCP dispatcher; no HTTP loopback is involved.
    logger.info(`UnixSocketServer initialized with in-process MCP dispatcher: "${socketPath}"`);
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
    this.beginAccepting();
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

      this.server = createServer(this.connectionHandlerWithFanOut());

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
   * `start()` without the socket file (#11441): the same accept state, broadcast fan-out and
   * connection handler, with the caller handing each connection to the returned handler instead
   * of a bound listener. For an in-process harness; nothing touches the file system.
   */
  startDetached(): (socket: Socket) => void {
    this.beginAccepting();
    return this.connectionHandlerWithFanOut();
  }

  private beginAccepting(): void {
    this.closing = false;
    this.acceptingRequests = true;
    this.serverClosePromise = null;
    this.lifecycleGeneration += 1;
  }

  /** Subscribe the broadcast fan-out and return the handler every accepted connection goes to. */
  private connectionHandlerWithFanOut(): (socket: Socket) => void {
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
        void this.liftStrokesHeldBy(sessionId);
        this.broadcastSessionReleased(sessionId, reason, snapshot, extras?.recordingIds);
      },
    );
    return (socket) => this.handleConnection(socket);
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
  protected handleConnection(socket: Socket): void {
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

    this.connectionFor(socket, sessionId).start({
      // Parse each frame synchronously and track it on its own. A held device
      // call must not keep another frame attached to its chunk's completion
      // promise (issue #6387).
      onLine: (line, receivedAtMs) => {
        if (line.trim()) {
          this.trackRequestHandler(
            this.processSocketRequestLine(sessionId, socket, line, receivedAtMs),
          );
        }
      },
      onOverflow: () => this.rejectOversizedFrame(sessionId, socket),
      hasLiveRequest: () => this.hasLiveSocketRequest(socket),
      trace: this.onFrameTrace
        ? (event, extra) => this.traceFrame(event, "*", undefined, undefined, extra)
        : undefined,
      onClose: () => {
        this.controlConnections.delete(socket);
        logger.info(`Client disconnected: ${sessionId}`);
        this.pendingSocketRequests.deleteForSocket(socket);
        this.releaseSocketSession(sessionId, socket);
      },
      onError: () => this.releaseSocketSession(sessionId, socket),
    });
  }

  /** The socket's connection transport, created on first use (writers may precede `start`). */
  private connectionFor(socket: Socket, sessionId: string): ControlConnection {
    let connection = this.controlConnections.get(socket);
    if (!connection) {
      connection = new ControlConnection(socket, sessionId, this.timer, this.maxInboundFrameBytes);
      this.controlConnections.set(socket, connection);
    }
    return connection;
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
    return this.pendingSocketRequests.hasLiveRequest(socket, this.timer.now());
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
    let endToolCall = (_delivered?: boolean): void => {};
    let answerWritten = false;
    const answerDelivered = (): boolean =>
      answerWritten && this.clientSockets.get(sessionId) === socket && !socket.destroyed;
    const writeAnswer = (response: DaemonResponse): void => {
      if (pending?.terminal) {
        return;
      }
      if (pending) {
        this.writeTerminalSocketResponse(pending, response, deviceId);
      } else {
        this.writeFrame(socket, sessionId, response, undefined, deviceId);
      }
      answerWritten = true;
    };
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errorCode = -32700;
        throw toActionableError(error, "Parse error in daemon socket request");
      }
      requestId = socketRequestId(parsed);
      if (!isDaemonRequestEnvelope(parsed)) {
        errorCode = -32600;
        throw new ActionableError("Invalid daemon socket request");
      }
      const request = parsed;
      const controlFrame = [
        DAEMON_HEARTBEAT_METHOD,
        DAEMON_CANCEL_REQUEST_METHOD,
        DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
      ].includes(request.method);
      const context = createRequestContext(request, sessionId, receivedAtMs);
      const tracked: PendingSocketRequest = {
        id: request.id,
        sessionId,
        socket,
        admitted: controlFrame,
        terminal: false,
        idleDeadline: controlFrame ? undefined : context.deadline,
      };
      pending = tracked;
      this.pendingSocketRequests.add(tracked);
      deviceId = this.onFrameTrace ? this.frameDeviceId(request) : undefined;
      if (this.onFrameTrace) {
        this.traceFrame("frame_parsed", request.id, deviceId);
      }
      const beginToolCall = (): void => {
        try {
          if (request.method === "tools/call" && this.daemonState.isInitialized()) {
            endToolCall =
              this.daemonState.getDevicePool().beginMcpToolCall?.(sessionId) ?? endToolCall;
          }
        } catch (error) {
          // #11999: optional tracking may fall back to the existing owner-disconnect grace.
          logger.warn(
            `Could not begin MCP tool-call ownership claim: ${errorMessage(error)}`,
            error,
          );
        }
      };
      beginToolCall();
      const response = await this.handleRequest(
        sessionId,
        socket,
        request,
        receivedAtMs,
        (deadline) => {
          tracked.admitted = true;
          tracked.idleDeadline = controlFrame ? undefined : deadline;
        },
        context,
      );
      if (response) {
        writeAnswer(response);
      } else {
        this.pendingSocketRequests.delete(tracked);
        this.controlConnections.get(socket)?.responseFlushed();
      }
    } catch (error) {
      if (isExpectedSocketFrameAbort(error, socket.destroyed)) {
        // Client cancellation and owner-socket close are expected request termination.
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
      writeAnswer(errorResponse);
    } finally {
      endToolCall(answerDelivered());
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
        this.controlConnections.get(pending.socket)?.responseFlushed();
      },
      deviceId,
    );
  }

  /**
   * A `tools/call` with the device ids it names as the pool's canonical ids (#11618), before the
   * admission lane, the forward key, the read lane, recovery pinning or the forward itself reads
   * them: a handset named by its other transport id must serialize, route and be judged as the one
   * pooled device it is. Cached fold only; the same request when nothing changes. Older socket-state
   * fakes carry no pool, or none with a fold: their ids pass through as sent.
   */
  private withCanonicalToolCallDeviceIds(request: DaemonRequest): DaemonRequest {
    const args: unknown = request.params?.arguments;
    if (
      request.method !== "tools/call" ||
      !toolCallNamesDeviceId(args) ||
      !this.daemonState.isInitialized?.()
    ) {
      return request;
    }
    const canonical = canonicalizeToolCallDeviceIds(this.daemonState.getDevicePool?.(), args);
    return canonical === args
      ? request
      : { ...request, params: { ...request.params, arguments: canonical } };
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

  protected releaseSocketSession(sessionId: string, socket: Socket): void {
    // Session IDs are expected to be unique, but teardown must still be
    // incarnation-safe: a delayed close/error from an older socket must not
    // remove or abort work registered by a newer socket with the same ID.
    if (this.clientSockets.get(sessionId) !== socket) {
      return;
    }
    this.abortMcpRequests(sessionId);
    this.trackRequestHandler(
      executionTracker
        .cancelSessionExecutions(sessionId, "socket_disconnect")
        .then(() => undefined)
        .catch((error) => {
          logger.warn(
            `Cancelling executions of socket ${sessionId} failed: ${errorMessage(error)}`,
          );
        }),
    );
    this.restartAdmission.releaseAcceptanceRestartAdmissionForOwner(sessionId);
    this.sessions.delete(sessionId);
    this.clientSockets.delete(sessionId);
    this.notificationSubscribers.delete(sessionId);
    this.resourceSubscriptions.delete(sessionId);
    this.clearBoundMcpClientKey(sessionId);
    this.releaseDevicePoolMcpSessionBindings(sessionId);
    this.daemonState.getBrokerConnectionScopes?.().unbind(sessionId);
    this.releaseToolCallRecording(sessionId);
    this.forgetSessionToolBindings(sessionId);
    this.forgetLateSessionToolBindings(sessionId);
    // Lift any streamed gesture this socket left open on the device (issue: streaming gesture
    // input). Tracked so daemon shutdown drains it rather than a fire-and-forget floating promise.
    this.trackRequestHandler(this.ownedGestures.cancelAllFor(sessionId));
  }

  /**
   * A handler that ignores its abort can still finish after its socket is gone and write a
   * session-tool binding under the gone socket's key (#13053): forget the key again once the
   * executions it ran have ended. Not tracked as a request handler, so shutdown never waits on it.
   */
  private forgetLateSessionToolBindings(socketSessionId: string): void {
    if (!executionTracker.hasActiveSessionExecutions(socketSessionId)) {
      return;
    }
    void executionTracker
      .waitForSessionExecutionsToEnd(socketSessionId, LATE_BINDING_FORGET_WINDOW_MS)
      .then((drained) => {
        this.forgetSessionToolBindings(socketSessionId);
        if (!drained) {
          logger.warn(
            `Socket ${socketSessionId} still had executions ${LATE_BINDING_FORGET_WINDOW_MS}ms after it closed; forgot its bindings anyway`,
          );
        }
      });
  }

  private trackRequestHandler(handler: Promise<void>): void {
    this.activeRequestHandlers.add(handler);
    void handler.then(
      () => this.activeRequestHandlers.delete(handler),
      () => this.activeRequestHandlers.delete(handler),
    );
  }

  protected abortMcpRequests(sessionId: string): void {
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

  protected mcpRequestSignal(
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

  /** The fan-out's view of the live client sockets (#11815). */
  private get notificationTransport(): NotificationTransport {
    return {
      hasSocket: (sessionId) => this.clientSockets.has(sessionId),
      write: (sessionId, frame, onFlushed) => {
        const socket = this.clientSockets.get(sessionId);
        if (socket) {
          this.writeFrame(socket, sessionId, frame, onFlushed);
        }
      },
    };
  }

  private broadcastListChanged(kind: ListChangedKind): void {
    fanOutListChanged(this.notificationSubscribers, this.notificationTransport, kind);
  }

  protected broadcastResourceUpdated(resolveTargets: ResourceUpdateTargets): void {
    fanOutResourceUpdated(this.resourceSubscriptions, this.notificationTransport, resolveTargets);
  }

  private handleResourceSubscription(sessionId: string, request: DaemonRequest): DaemonResponse {
    return applyResourceSubscription(this.resourceSubscriptions, sessionId, request);
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
    fanOutSessionReleased(
      this.notificationSubscribers,
      this.notificationTransport,
      this.pendingSessionReleaseWrites,
      { releasedSessionId, reason, release, recordingIds },
    );
  }

  /** Pushes one progress tick to the single socket that requested it (#6205); see the fan-out. */
  protected pushProgressNotification(
    sessionId: string,
    requestId: string,
    progressToken: string | number,
    progress: number,
    total?: number,
    message?: string,
  ): void {
    fanOutProgress(this.notificationTransport, sessionId, {
      requestId,
      progressToken,
      progress,
      total,
      message,
    });
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

  protected writeFrameData(
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
      const guard = this.connectionFor(socket, sessionId).outboundWriteGuard();
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
          this.controlConnections.get(socket)?.refreshIdle();
          guard.flushed();
        }
        onFlushed?.(error);
      });
      guard.written();
      if (onWritten) {
        onWritten(socket.writableLength, byteLength);
      }
      if (!ok) {
        this.controlConnections.get(socket)?.startBackpressureIdle();
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
   * Handle a request from a client
   */
  protected async handleRequest(
    sessionId: string,
    ownerSocket: Socket,
    request: DaemonRequest,
    receivedAtMs: number = this.timer.now(),
    onAdmitted?: (deadline: ProgressExtendableDeadline) => void,
    context: RequestContext = createRequestContext(request, sessionId, receivedAtMs),
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
    request = this.withCanonicalToolCallDeviceIds(request);

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

    const unqueued = this.unqueuedRequest(session, ownerSocket, request, context);
    if (unqueued) {
      return unqueued;
    }

    const { totalTimeoutMs, deadline } = context;
    let activeRequestSignal: AbortSignal | undefined;
    const cancellation = this.registerRequestCancellation(session, context);

    const admissionCancellation = this.socketAdmissionCancellation(
      request,
      sessionId,
      ownerSocket,
      cancellation.signal,
    );
    let onInputDispatch: (() => void) | undefined;
    const handler = async (): Promise<DaemonResponse | undefined> => {
      try {
        if (request.method.startsWith("daemon/")) {
          // The socket's cancellation reaches long daemon methods (broker binding acquisition).
          const daemonResponse = await handleDaemonRequest(
            request,
            this.daemonState,
            undefined,
            cancellation.signal,
            { socketSessionId: sessionId },
          );
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
          {
            onOwnerSignal: (signal) => {
              activeRequestSignal = signal;
            },
            onInputDispatch: () => onInputDispatch?.(),
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

        let endOwnerCall: (() => void) | undefined;
        let disposeMcpRequest = () => {};
        try {
          if (request.method === "tools/call") {
            await this.restoreSelectorSessions(request.params?.arguments, sessionId);
            endOwnerCall = this.beginMcpSessionOwnerCall(
              request.params?.arguments,
              sessionId,
              cancellation.signal,
            );
          }
          const routeOrPending = this.getMcpForwardRoute(request, sessionId);
          const initialRoute =
            routeOrPending instanceof Promise ? await routeOrPending : routeOrPending;
          const mcpRequest = this.mcpRequestSignal(sessionId, ownerSocket, cancellation.signal);
          disposeMcpRequest = mcpRequest.dispose;
          activeRequestSignal = mcpRequest.signal;
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
                const response = await this.forwardMcpRequest({
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
              ...daemonShuttingDownFrameFields(daemonShuttingDownFailureFromToolResult(result)),
            };
          }

          return {
            id: request.id,
            type: "mcp_response",
            success: true,
            result,
          };
        } finally {
          endOwnerCall?.();
          disposeMcpRequest();
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
          // Held input routes release admission immediately if cancelled before their first send;
          // after that synchronous latch its handler answers after the bounded hold.
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
            : DISPATCH_HELD_INPUT_METHODS.has(request.method)
              ? this.runCancellableInputHandler((onDispatch) => {
                  onInputDispatch = onDispatch;
                  return handler();
                }, admissionCancellation.signal)
              : this.runCancellableQueuedHandler(handler, cancellation.signal);
        },
        {
          timer: this.timer,
          deadlineMs: deadline.value,
          signal: admissionCancellation.signal,
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
      .finally(() => {
        admissionCancellation.dispose();
        cancellation.dispose();
      });
  }

  /** A request answered without waiting in the socket's admission queue, if this is one. */
  private unqueuedRequest(
    session: SessionContext,
    ownerSocket: Socket,
    request: DaemonRequest,
    context: RequestContext,
  ): DaemonResponse | Promise<DaemonResponse | undefined> | undefined {
    // Must bypass the queue: queued, it would wait behind the very request it cancels.
    if (request.method === DAEMON_CANCEL_REQUEST_METHOD) {
      return this.cancelSocketRequest(session, request);
    }
    // Task polling touches no device and must not wait behind this socket's other calls (#4668).
    if (isTaskRelayMethod(request.method)) {
      return this.relayTaskRequest(session, ownerSocket, request, context);
    }
    return undefined;
  }

  /**
   * Relays a `tasks/*` request (#4668) outside the socket's admission queue: it reads or cancels a
   * stored task and touches no device, so a poll never waits behind a long call on the same
   * socket. The daemon MCP server's JSON-RPC error is carried on the frame unchanged.
   */
  private async relayTaskRequest(
    session: SessionContext,
    ownerSocket: Socket,
    request: DaemonRequest,
    context: RequestContext,
  ): Promise<DaemonResponse | undefined> {
    const sessionId = session.sessionId;
    const cancellation = this.registerRequestCancellation(session, context);
    const mcpRequest = this.mcpRequestSignal(sessionId, ownerSocket, cancellation.signal);
    try {
      await this.waitForStartup(request, context.deadline, mcpRequest.signal);
      const result = await this.forwardMcpRequest({
        request,
        route: this.sharedMcpForwardRoute(`method:${request.method}`),
        socketSessionId: sessionId,
        signal: mcpRequest.signal,
        totalTimeoutMs: context.totalTimeoutMs,
        deadline: context.deadline,
      });
      return { id: request.id, type: "mcp_response", success: true, result };
    } catch (error) {
      return (
        taskRelayErrorFrame(error, request) ??
        this.mcpForwardFailureResponse({
          error,
          request,
          sessionId,
          ownerSocket,
          signal: mcpRequest.signal,
        })
      );
    } finally {
      mcpRequest.dispose();
      cancellation.dispose();
    }
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
      ...daemonShuttingDownFrameFields(daemonShuttingDownFailure()),
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

  protected mcpForwardFailureResponse({
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
      ...(error instanceof ReleasedBoundSessionError ? { boundSessionLoss: error.failure } : {}),
      ...mcpRequestFailureDetails(error, preservedCause),
      ...((error instanceof InputTypeTextAppendError ||
        error instanceof SessionReleasedDuringCallError) &&
      error.charsSent !== undefined
        ? { charsSent: error.charsSent }
        : {}),
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
    { id: requestId, cancellation: controller }: RequestContext,
  ): { signal: AbortSignal; dispose: () => void } {
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

  protected requireRemainingMcpForwardBudget(
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
  protected runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T> {
    return runKeyedSerial(
      {
        tails: this.mcpForwardTails,
        idleCloseKeys: this.mcpForwardIdleCloseKeys,
        timer: this.timer,
        onAcquired: (key) => this.clearForwardKeyIdleTimer(key),
        onDrained: (key) => this.scheduleForwardKeyIdle(key),
      },
      executionKey,
      fn,
      idleCloseKey,
      chainWait,
    );
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
        value: await fn(currentRoute),
      };
    }
    return {
      kind: "done",
      value: await fn(initialRoute),
    };
  }

  protected getMcpForwardRoute(
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

  private beginMcpSessionOwnerCall(
    args: unknown,
    socketSessionId: string,
    signal: AbortSignal,
  ): (() => void) | undefined {
    const token = this.ownedSessionsOwnerToken(args);
    if (token === undefined || !this.isMcpRequestOwnerCurrent(socketSessionId, signal)) {
      return undefined;
    }
    try {
      if (!this.daemonState.isInitialized()) {
        return undefined;
      }
      const end = this.daemonState
        .getDevicePool()
        .beginMcpSessionOwnerCall?.(socketSessionId, token);
      return () => {
        try {
          end?.();
        } catch (error) {
          // Optional claim bookkeeping must not replace the tool's result or prevent disposal.
          logger.warn(`Unable to end MCP session owner call: ${errorMessage(error)}`, error);
        }
      };
    } catch (error) {
      // Optional claim bookkeeping must not block the tool call.
      logger.warn(`Unable to begin MCP session owner call: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  protected async restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void> {
    const token = this.ownedSessionsOwnerToken(args);
    // A queued call must not recreate its closed connection's identity (#11999).
    if (token !== undefined && this.clientSockets.has(socketSessionId)) {
      try {
        if (this.daemonState.isInitialized()) {
          this.daemonState
            .getDevicePool()
            .declareMcpSessionLivenessOwnerToken?.(socketSessionId, token);
        }
      } catch (error) {
        // Declaring an optional connection identity must not block the tool call or restore.
        logger.warn(`Unable to declare MCP session owner token: ${errorMessage(error)}`, error);
      }
    }
    const ids = this.selectorSessionIds(args);
    if (!ids) {
      return;
    }
    const pool = this.daemonState.getDevicePool();
    const ownerSocket = this.clientSockets.get(socketSessionId);
    // Restoration attaches only live sessions. It restores both explicit
    // acquisition ownership and autolock routing without reallocating a
    // released UUID.
    const refused =
      (await pool.restoreOwnedDeviceSessionsForMcpSession?.(ids, socketSessionId, token)) ?? [];
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

  /** The proxy's acquisition/restore identity, independent of whether it retained sessions. */
  private ownedSessionsOwnerToken(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
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
    return this.withAdmittedBoundSession(
      args,
      (recoverableSessionUuid) =>
        this.getAdmittedToolsCallForwardRoute(
          args,
          socketSessionId,
          toolName,
          recoverableSessionUuid,
        ),
      socketSessionId,
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

  protected recordBoundMcpClientKey(
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
      this.isReleasedBoundSession(request.params?.arguments, socketSessionId) &&
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

  private isSessionOwnedByOtherConnection(sessionUuid: string, socketSessionId: string): boolean {
    return (
      this.daemonState.isInitialized() &&
      this.daemonState
        .getDevicePool()
        .isSessionOwnedByOtherConnection?.(sessionUuid, socketSessionId) === true
    );
  }

  /** A foreign connected owner's binding requires its recorded token (#11555 item 3). */
  private honoursBoundSessionMarker(
    args: Record<string, unknown>,
    socketSessionId?: string,
  ): boolean {
    const sessionUuid = this.getSessionUuid(args);
    if (args[DAEMON_BOUND_SESSION_PARAM] !== sessionUuid) {
      return false;
    }
    if (sessionUuid === undefined || !socketSessionId || !this.daemonState.isInitialized()) {
      return true;
    }
    // The token read is a peek. Only a recorded token can reach the connection fence's
    // ownership question below, which may lazily expire the session.
    // Older socket-state fakes lack these readers and retain the tokenless marker behaviour.
    const sessions = this.daemonState.getSessionManager();
    const ownershipSessionUuid = sessions.ownershipSessionUuid?.(sessionUuid) ?? sessionUuid;
    const ownerToken = sessions.peekSession?.(ownershipSessionUuid)?.livenessOwnerToken;
    return (
      !ownerToken ||
      this.ownedSessionsOwnerToken(args) === ownerToken ||
      !this.isSessionOwnedByOtherConnection(sessionUuid, socketSessionId)
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
    if (this.isReleasedBoundSession(args, socketSessionId)) {
      this.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    if (this.isSessionOwnedByOtherConnection(sessionUuid, socketSessionId)) {
      // Naming a session another connected client owns is not ownership (#11235, #11344): this
      // socket keeps its own route so its sessionless calls never follow it.
      return;
    }
    if (this.targetsOneCallOnly(args, sessionUuid)) {
      // The proxy named its own binding beside an explicit session: the call targeted that
      // session only, and the connection's default route does not move (#11347).
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
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      sessionUuid,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid,
      requiresLiveDaemonSession: sessionWasActiveBeforeForward || sessionIsActiveAfterForward,
    });
  }

  /**
   * Whether the call carried the connection's bound session ({@link DAEMON_BOUND_SESSION_PARAM})
   * beside a different session it routed to. Only setActiveDevice or an acquisition moves a
   * connection's default (#11347); an explicit `sessionUuid` targets its own call.
   */
  private targetsOneCallOnly(args: unknown, routedSessionUuid: string): boolean {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return false;
    }
    const bound = (args as Record<string, unknown>)[DAEMON_BOUND_SESSION_PARAM];
    return isNonBlankSessionUuid(bound) && bound !== routedSessionUuid;
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
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      toolSelectionProfileUuid,
      requiresLiveDaemonSession: false,
    });
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

  protected clearBoundMcpClientKey(socketSessionId: string): void {
    const boundClient = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return;
    }
    this.boundMcpClientKeysBySocketSession.delete(socketSessionId);
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

  /**
   * Forward one request in process (#11820): its own MCP client and stateless server, named by
   * the socket session as its MCP session key, closed (cancelling what it left running) when the
   * forward ends.
   */
  protected async forwardMcpRequest(context: McpForwardContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const mcpClient = await runWithForwardSessionKey(
      context.socketSessionId,
      () =>
        this.mcpClientFactory(
          context.route.sessionUuid,
          context.route.toolSelectionProfileUuid,
          context.route.releasedSessionUuid,
        ),
      parseTaskRelayFrame(context.request.tasks)?.ownerKey,
    );
    try {
      context.signal?.throwIfAborted();
      const forwardRemainingMs = this.requireRemainingMcpForwardBudget(
        context.request,
        context.totalTimeoutMs,
        context.deadline,
        "waiting in queues and preparing the MCP client",
      );
      return await this.handleIdeRequest(
        mcpClient,
        context.request,
        forwardRemainingMs,
        context.socketSessionId,
        context.deadline,
        context.totalTimeoutMs,
        context.signal,
      );
    } finally {
      // A close failure must never replace the forward's own answer.
      await Promise.resolve()
        .then(() => mcpClient.close())
        .catch((error: unknown) => {
          logger.warn(`Closing an MCP forward failed: ${errorMessage(error)}`, error);
        });
    }
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
      logger.debug(`Unable to resolve session for device ${deviceId}: ${error}`);
      return undefined;
    }
  }

  /** The session object itself: identity-compared to tell a recreated session from the original. */
  private getSessionIncarnation(sessionUuid: string | undefined): object | undefined {
    if (!sessionUuid || !this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid) ?? undefined;
    } catch (error) {
      // A missing incarnation snapshot is safe: downstream owner validation treats
      // an absent incarnation as unverifiable and fails the ownership check closed.
      logger.debug(`Unable to capture session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }

  protected remainingMcpForwardBudget(input: { deadline: ProgressExtendableDeadline }): number {
    return input.deadline.value - this.timer.now();
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

  private isReleasedBoundSession(args: unknown, socketSessionId?: string): boolean {
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
      this.honoursBoundSessionMarker(record, socketSessionId) &&
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
    socketSessionId?: string,
  ): T | Promise<T> {
    if (!this.isReleasedBoundSession(args, socketSessionId)) {
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
    const release =
      this.daemonState.getSessionManager().getTerminalReleaseSnapshot?.(sessionUuid) ??
      (await this.expiredBoundSessionRelease(sessionUuid));
    throw new ReleasedBoundSessionError({
      code: BOUND_SESSION_LOSS_CODE,
      sessionUuid,
      reason: release?.releaseReason ?? "session-not-found",
      ...idleReleaseField(release?.releaseReason),
      ...(release ? { release } : {}),
    });
  }

  /**
   * The release of a bound session whose row ran out its window with no daemon holding it
   * (#11361), so its owner is told `expired` rather than `session-not-found`. Best-effort: a
   * failed read keeps the fail-closed not-found answer.
   */
  private async expiredBoundSessionRelease(
    sessionUuid: string,
  ): Promise<BoundSessionLoss["release"]> {
    try {
      return await this.daemonState.getSessionManager().getExpiredReleaseSnapshot?.(sessionUuid);
    } catch (error) {
      logger.warn(
        `Unable to read the expired release of bound session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  protected getRequestArgumentScopeKey(args: unknown): string | undefined {
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

  private daemonGenerationMatches(params: Record<string, unknown>): boolean {
    return daemonGenerationMatches(this.currentGenerationIdentity(), params);
  }

  private currentGenerationIdentity(): DaemonGenerationIdentity {
    return {
      pid: process.pid,
      startedAt: this.identityStartedAt,
      ...(this.processGenerationToken === undefined
        ? {}
        : { processGenerationToken: this.processGenerationToken }),
      version: this.daemonIdentity.version,
      buildId: this.daemonIdentity.build.buildId,
      entryScript: this.daemonIdentity.build.entryScript,
    };
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

  private requireFeatureFlagService(): FeatureFlagAdmin {
    if (!this.featureFlagService) {
      throw new Error("Feature flag service not available");
    }
    return this.featureFlagService;
  }

  /**
   * Input and device-mutating IDE frames share the owner fence of forwarded MCP calls: socket
   * close and `daemon/cancelRequest` abort them (#10006, #11667). Input also has a budget from receipt.
   * Other local requests run unfenced, as before.
   */
  private async runLocalSocketRequest(
    request: DaemonRequest,
    sessionId: string,
    ownerSocket: Socket,
    cancelSignal: AbortSignal,
    receivedAtMs: number,
    {
      onOwnerSignal,
      onInputDispatch,
    }: {
      onOwnerSignal: (signal: AbortSignal) => void;
      onInputDispatch?: () => void;
    },
  ): Promise<unknown> {
    if (!isOwnerFencedMethod(request.method, IDE_DEVICE_MUTATION_METHODS)) {
      return await this.handleLocalSocketRequest(request, sessionId);
    }
    const owner = this.mcpRequestSignal(sessionId, ownerSocket, cancelSignal);
    onOwnerSignal(owner.signal);
    try {
      return await this.handleLocalSocketRequest(
        request,
        sessionId,
        owner.signal,
        receivedAtMs,
        onInputDispatch,
      );
    } finally {
      owner.dispose();
    }
  }

  protected async handleLocalSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
    signal?: AbortSignal,
    receivedAtMs?: number,
    onInputDispatch?: () => void,
  ): Promise<any | undefined> {
    if (request.method.startsWith("input/")) {
      // A frame whose socket closed or whose client cancelled it while it sat in the socket
      // queue must not even resolve a device (#10006).
      signal?.throwIfAborted();
    }
    const input: InputRequestContext = {
      onDispatch: onInputDispatch,
      signal,
      receivedAtMs,
      requester: request.method.startsWith("input/")
        ? this.inputRequester(request, socketSessionId)
        : undefined,
    };
    const route = inputRouteFor(request.method);
    if (route) {
      return await this.dispatchInputRoute(route, request, socketSessionId, input);
    }
    return await this.dispatchIdeSocketRequest(request, socketSessionId, signal);
  }

  private async dispatchInputRoute(
    route: InputRouteEntry,
    request: DaemonRequest,
    socketSessionId: string | undefined,
    input: InputRequestContext,
  ): Promise<any | undefined> {
    return await dispatchInputRoute(
      this.inputRouteHandlers,
      route,
      request,
      socketSessionId,
      input,
    );
  }

  /** The handler each `input/*` route table entry names (#11815). */
  private readonly inputRouteHandlers: InputRouteHandlers<InputRequestContext> = {
    tap: (request, sid, input) => this.handleInputTap(request, sid, input),
    swipe: (request, sid, input) => this.handleInputSwipe(request, sid, input),
    typeText: (request, sid, input) => this.handleInputTypeText(request, sid, input),
    pressButton: (request, sid, input) => this.handleInputPressButton(request, sid, input),
    key: (request, sid, input) => this.handleInputKey(request, sid, input),
    gesture: (request, kind, sid, input) => this.handleInputGesture(request, kind, sid, input),
  };

  /** A route that mutates a device runs as one tracked control call (#11486); the rest run bare. */
  private async dispatchIdeSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
    signal?: AbortSignal,
  ): Promise<any | undefined> {
    if (!IDE_DEVICE_MUTATION_METHODS.has(request.method)) {
      return await this.handleIdeSocketRequest(request, socketSessionId);
    }
    signal?.throwIfAborted();
    return await this.runTrackedIdeMutation(
      socketSessionId,
      (call) => this.handleIdeSocketRequest(request, socketSessionId, call),
      signal,
    );
  }

  /** The `ide/*` and daemon-lifecycle routes this socket serves, by method name (#11813). */
  private readonly ideRouteHandlers: ReadonlyMap<string, IdeServerRouteHandler> = new Map<
    string,
    IdeServerRouteHandler
  >([
    ...ideFeatureRoutes({
      requireFeatureFlagService: () => this.requireFeatureFlagService(),
      sessionToolSelection: () =>
        this.sessionToolSelectionService ?? getSessionToolSelectionService(),
      assertBrokerHostMutation: (socketSessionId, action) =>
        this.assertBrokerConnectionHostMutation(socketSessionId, action),
      assertBrokerControl: (socketSessionId, action, target) =>
        this.assertBrokerConnectionControl(socketSessionId, action, target),
      emitToolsListChanged: () => ListChangedBroadcaster.emit("tools"),
      now: () => this.timer.now(),
    }),
    ...daemonLifecycleRoutes({
      republishIdentity: (params) => this.republishDaemonIdentity(params),
      // Resolved per call: the admission object is built at the end of construction.
      restart: {
        prepareDaemonRestart: (params) => this.restartAdmission.prepareDaemonRestart(params),
        prepareDaemonMaintenance: (params) =>
          this.restartAdmission.prepareDaemonMaintenance(params),
        completeDaemonMaintenance: (params) =>
          this.restartAdmission.completeDaemonMaintenance(params),
        restartAdmittedDaemon: (params) => this.restartAdmission.restartAdmittedDaemon(params),
        restartAcceptanceSession: (params, owner) =>
          this.restartAdmission.restartAcceptanceSession(params, owner),
        commitAcceptanceRestart: (params, owner) =>
          this.restartAdmission.commitAcceptanceRestart(params, owner),
        releaseAcceptanceRestart: (params, owner) =>
          this.restartAdmission.releaseAcceptanceRestart(params, owner),
      },
    }),
    [
      "ide/status",
      (request, socketSessionId, ideMutation) =>
        this.ideStatus(request, socketSessionId, ideMutation),
    ],
    [
      "ide/updateService",
      (request, socketSessionId, ideMutation) =>
        this.ideUpdateService(request, socketSessionId, ideMutation),
    ],
    [
      "ide/setKeyValue",
      (request, socketSessionId, ideMutation) =>
        this.ideSetKeyValue(request, socketSessionId, ideMutation),
    ],
    [
      "ide/removeKeyValue",
      (request, socketSessionId, ideMutation) =>
        this.ideRemoveKeyValue(request, socketSessionId, ideMutation),
    ],
    [
      "ide/clearKeyValueFile",
      (request, socketSessionId, ideMutation) =>
        this.ideClearKeyValueFile(request, socketSessionId, ideMutation),
    ],
  ]);

  /**
   * The `ide/*` and acceptance routes. `ideMutation` is set for the routes that mutate a device
   * ({@link IDE_DEVICE_MUTATION_METHODS}): their ownership gate tracks the call under it.
   */
  protected async handleIdeSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
    ideMutation?: IdeMutationCall,
  ): Promise<any | undefined> {
    const handler = this.ideRouteHandlers.get(request.method);
    return handler ? await handler(request, socketSessionId, ideMutation) : undefined;
  }

  private async ideStatus(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    return {
      structuredSessionNotFound: true,
      structuredToolErrorCodes: true,
      // Concrete pinned version (honors AUTOMOBILE_VERSION), never the
      // floating "latest" tag — external consumers must see exactly what the
      // daemon will fetch (#2746).
      version: this.daemonIdentity.version,
      pid: process.pid,
      buildId: this.daemonIdentity.build.buildId,
      entryScript: this.daemonIdentity.build.entryScript,
      acceptanceCapabilityFingerprint: this.acceptanceDiscoveryCapability
        ? createHash("sha256").update(this.acceptanceDiscoveryCapability).digest("hex").slice(0, 8)
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

  private async ideUpdateService(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/updateService"](request.params);

    // Find the booted device
    const { devices: bootedDevices, deviceId } = await this.resolveIdeActionDevices(
      args.platform,
      args.deviceId,
      ideMutation?.signal,
    );
    // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
    await this.reconcileDiscoveryObservation(bootedDevices, "socket:ide/updateService");
    this.assertDeviceActionable(deviceId, "to update the accessibility service");
    const targetDevice = bootedDevices.find((d) => d.deviceId === deviceId);
    if (!targetDevice) {
      throw new Error(`Device not found: ${args.deviceId}`);
    }
    if (await this.daemonState.getDevicePool().isShutdownReserved?.(targetDevice.deviceId)) {
      throw new Error(`Device '${targetDevice.deviceId}' is shutting down.`);
    }
    // A lifecycle action on a held device: only the holder, or an explicit `force` (as
    // killDevice allows), may reinstall/restart its CtrlProxy (#10827).
    await this.assertIdeMutationOwnership(
      request,
      targetDevice,
      "ide/updateService",
      args.force,
      ideMutation,
    );
    if (args.platform === "android") {
      ideMutation?.signal.throwIfAborted();
      ideMutation?.dispatching();
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
      ideMutation?.signal.throwIfAborted();
      ideMutation?.dispatching();
      IOSCtrlProxyClient.resumeAfterDeviceStart(targetDevice.deviceId);
      await manager.forceRestart();
      return {
        success: true,
        message: "CtrlProxy iOS restarted",
      };
    }
  }

  private async ideSetKeyValue(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/setKeyValue"](request.params);
    await this.assertSocketToolEnabled(args.deviceId, "setKeyValue");
    const { platform, client, device } = await this.resolveKeyValueMutationClient(
      args.platform,
      args.deviceId,
      request,
      "ide/setKeyValue",
      ideMutation,
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
        {
          ideMutation,
          viaSdk: (onDispatch) => client.removePreference(appId, fileName, key, { onDispatch }),
          viaDirectFile: (adb) =>
            removeAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key),
        },
      ));
    } else {
      // Enforce the same cross-platform type guidance as the MCP-tool path
      // (storageTools.ts) before dispatch, so a platform-incompatible type
      // fails with an actionable error rather than deeper in the client (#5022).
      const entry = { key, value: args.value, type: args.type as KeyValueType };
      validateTypeForPlatform(platform, entry.type);
      ({ usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
        platform,
        device,
        appId,
        fileName,
        {
          ideMutation,
          viaSdk: (onDispatch) =>
            client.setPreference(appId, fileName, key, entry.value, entry.type, { onDispatch }),
          viaDirectFile: (adb) =>
            setAndroidKeyValueDirect(adb, device.deviceId, { appId, fileName }, entry),
        },
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

  private async ideRemoveKeyValue(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/removeKeyValue"](request.params);
    await this.assertSocketToolEnabled(args.deviceId, "removeKeyValue");
    const { platform, client, device } = await this.resolveKeyValueMutationClient(
      args.platform,
      args.deviceId,
      request,
      "ide/removeKeyValue",
      ideMutation,
    );
    const appId = args.appId;
    const fileName = args.fileName;
    const key = args.key;
    const { usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
      platform,
      device,
      appId,
      fileName,
      {
        ideMutation,
        viaSdk: (onDispatch) => client.removePreference(appId, fileName, key, { onDispatch }),
        viaDirectFile: (adb) =>
          removeAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key),
      },
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

  private async ideClearKeyValueFile(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/clearKeyValueFile"](request.params);
    await this.assertSocketToolEnabled(args.deviceId, "clearKeyValueFile");
    const { platform, client, device } = await this.resolveKeyValueMutationClient(
      args.platform,
      args.deviceId,
      request,
      "ide/clearKeyValueFile",
      ideMutation,
    );
    const appId = args.appId;
    const fileName = args.fileName;
    const { usedDirectFileFallback, resolution } = await this.runIdeKeyValueMutation(
      platform,
      device,
      appId,
      fileName,
      {
        ideMutation,
        viaSdk: (onDispatch) => client.clearPreferenceStore(appId, fileName, { onDispatch }),
        viaDirectFile: (adb) =>
          clearAndroidKeyValueFileDirect(adb, device.deviceId, appId, fileName),
      },
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

  /**
   * `ide/*` routes that mutate a device follow device ownership like `input/*` (#10827): a held
   * device accepts them only from its holder (the optional `sessionUuid` param), or when `force`
   * is allowed and set. Reads stay open to watchers. Unheld devices stay open to any client,
   * except a device a broker binding holds, which only that binding's execution may mutate, `force`
   * or not (#11178). A socket bound to broker bindings mutates only its own binding devices, for its own
   * binding sessions, `force` or not (#11596).
   *
   * The holder's own mutation is a control call on its session, so it also passes the session
   * admission `input/*` passes (#11486): a suspect, lapsed or idle-expired holder is refused with
   * the typed code before anything is written. `force` overrides the local holder, so a forced
   * call is not judged against the holder's session.
   *
   * Passing the gate starts the mutation's tracked execution on `ideMutation`, under the holder's
   * session: from here to the end of the route it is control in flight on that session, forced or
   * not, so the session is never released under it (#11486). Tracking is not use: the route
   * restarts the holder's idle window only when it calls `ideMutation.dispatching()`, after its
   * last pre-dispatch check (#11596).
   */
  private async assertIdeMutationOwnership(
    request: DaemonRequest,
    device: BootedDevice,
    action: string,
    force = false,
    ideMutation?: IdeMutationCall,
  ): Promise<void> {
    const deviceId = device.deviceId;
    const requesterSessionUuid = parseInputRequesterSessionUuid(request.method, request.params);
    if (!this.daemonState.isInitialized()) {
      return;
    }
    await this.assertFrameTargetProven(device, action, () => requesterSessionUuid);
    this.assertBrokerConnectionControl(ideMutation?.socketSessionId, action, {
      deviceId,
      requesterSessionUuid,
    });
    const sessionManager = this.daemonState.getSessionManager();
    await assertInputNotOnForeignBindingDevice({
      action,
      deviceId,
      platform: device.platform,
      requesterSessionUuid,
      sessionManager,
      gate: this.daemonState.getDevicePool(),
    });
    // Another daemon's device is refused, `force` or not: `force` overrides a local holder only.
    await assertControlNotOnForeignDaemonDevice({
      deviceId,
      platform: device.platform,
      gate: this.daemonState.getDevicePool(),
    });
    const holderSessionUuid = sessionManager.getSessionForDevice?.(deviceId) ?? undefined;
    if (!force) {
      assertInputRequesterHoldsDevice({
        action,
        deviceId,
        ownerSessionUuid: holderSessionUuid,
        requesterSessionUuid,
        sessionManager,
        remedy:
          "pass the holding session's sessionUuid, or wait for the holder to release the device.",
      });
    }
    if (holderSessionUuid) {
      await this.admitIdeMutationOnHolderSession(
        executionTracker.startExecution(action, undefined, holderSessionUuid),
        { deviceId, holderSessionUuid, force },
        ideMutation,
      );
    }
  }

  /**
   * Judge a mutating `ide/*` frame against the session holding its device, under the execution
   * that tracks the mutation, so the admission does not mistake it for earlier work in flight.
   * With a route to track it (`ideMutation`) the execution outlives the gate and the route ends
   * it; otherwise it ends here.
   */
  private async admitIdeMutationOnHolderSession(
    execution: ActiveExecution,
    target: { deviceId: string; holderSessionUuid: string; force: boolean },
    ideMutation: IdeMutationCall | undefined,
  ): Promise<void> {
    ideMutation?.track(execution, !target.force);
    try {
      executionTracker.bindDeviceExecution(execution.id, target.deviceId);
      if (target.force) {
        return;
      }
      await this.admitInputAsControlCall(execution, target.deviceId, target.holderSessionUuid);
      if (ideMutation) {
        // Tracked from here; stamped as session use only when the route dispatches (#11596).
        ideMutation.admit(execution);
      } else {
        // The holder's own admitted mutation is use of its session, like its input (#10824).
        executionTracker.markSessionAdmitted(execution.id);
      }
    } finally {
      if (!ideMutation) {
        executionTracker.endExecution(execution.id);
      }
    }
  }

  /**
   * Run a device-mutating `ide/*` route as one tracked control call. The route's ownership gate
   * starts the execution once the device and its holder are known; it stays in flight until the
   * route settles, so the heartbeat and idle monitors see control in flight on the holder's
   * session. A release that still lands (owner disconnect, forced release) cancels the execution:
   * the holder's own route runs its device work under that signal, and the frame answers the
   * release's typed refusal whatever the interrupted work threw. A forced route is not the
   * holder's call, so the release neither cuts it nor names the holder's session to its caller.
   */
  private async runTrackedIdeMutation<T>(
    socketSessionId: string | undefined,
    run: (call: IdeMutationCall) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    const abort = new AbortController();
    let tracked: ActiveExecution | undefined;
    let cutByRelease: ActiveExecution | undefined;
    let admitted: ActiveExecution | undefined;
    const signal = ownerSignal ? AbortSignal.any([ownerSignal, abort.signal]) : abort.signal;
    const call: IdeMutationCall = {
      socketSessionId,
      signal,
      admit: (execution) => {
        admitted = execution;
      },
      dispatching: () => {
        if (admitted) {
          // The holder's own mutation that reaches the device is use of its session (#10824).
          executionTracker.markSessionAdmitted(admitted.id);
        }
      },
      track: (execution, asHolder) => {
        tracked = execution;
        if (!asHolder) {
          return;
        }
        cutByRelease = execution;
        const signal = execution.abortController.signal;
        if (signal.aborted) {
          abort.abort(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
      },
    };
    try {
      signal.throwIfAborted();
      return await runWithAbortSignal(signal, () => run(call));
    } catch (error) {
      throw sessionReleaseThatCancelledCall(cutByRelease?.cancelReason) ?? error;
    } finally {
      if (tracked) {
        executionTracker.endExecution(tracked.id);
      }
    }
  }

  /**
   * Booted devices for an `ide/*` action on one serial. The legacy listing turns a
   * failed sweep into `[]`, which surfaced as a misleading "Device not found". When
   * the serial is absent and the discovery source that would have observed it failed
   * (adb for Android; simctl or devicectl for iOS, by serial shape), the absence
   * proves nothing, so refuse with the retryable discovery error instead (#11122,
   * cf. #11103, #11535).
   */
  private async listBootedDevicesForIdeAction(
    platform: "android" | "ios",
    serial: string,
    signal?: AbortSignal,
  ): Promise<BootedDevice[]> {
    signal?.throwIfAborted();
    const manager = PlatformDeviceManagerFactory.getInstance();
    const discovery = expectingPooledSources(
      await manager.getBootedDevicesDetailed(platform),
      this.daemonState?.isInitialized()
        ? this.daemonState.getDevicePool().getAllDevices?.()
        : undefined,
    );
    if (
      !discovery.devices.map((device) => device.deviceId).includes(serial) &&
      // Tooling that is not installed on this host is not an unknown: no retry can list the serial (#11605).
      isDeviceSourceIncomplete(discovery, platform, serial)
    ) {
      const discoveryError = discovery.discoveryErrors?.[platform];
      throw platform === "android"
        ? new AndroidBootedDeviceDiscoveryIncompleteError(discoveryError)
        : new BootedDeviceDiscoveryIncompleteError(platform, discoveryError);
    }
    signal?.throwIfAborted();
    return discovery.devices;
  }

  /**
   * The booted devices for an `ide/*` action and the device it names, both as pooled canonical
   * ids: the frame may name a held handset by its other transport id (#11596).
   */
  private async resolveIdeActionDevices(
    platform: "android" | "ios",
    serial: string,
    signal?: AbortSignal,
  ): Promise<CanonicalFrameDiscovery & { deviceId: string }> {
    const canonical = await this.canonicalFrameDiscovery(
      platform,
      await this.listBootedDevicesForIdeAction(platform, serial, signal),
      serial,
    );
    return { devices: canonical.devices, deviceId: canonical.deviceId ?? serial };
  }

  /**
   * The ONE place a direct frame's discovery rows and `deviceId` become the pool's canonical ids
   * (#11596). Every `input/*` and `ide/*` handler resolves its target through here before any
   * holder, broker binding or admission decision. A no-op in direct mode, where there is no pool.
   */
  private async canonicalFrameDiscovery(
    platform: "android" | "ios",
    rawDevices: readonly BootedDevice[],
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery> {
    return await canonicalizeFrameDiscovery(
      this.daemonState.isInitialized() ? this.daemonState.getDevicePool() : undefined,
      platform,
      rawDevices,
      deviceId,
    );
  }

  /** Refuse unresolved control only when its target could alias a held device; see the helper. */
  private async assertFrameTargetProven(
    device: BootedDevice,
    action: string,
    requester?: () => string | undefined,
  ): Promise<void> {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    const sessionManager = this.daemonState.getSessionManager();
    await assertFrameTargetIdentityProven(
      this.daemonState.getDevicePool(),
      device,
      action,
      Boolean(sessionManager.getSessionForDevice?.(device.deviceId)),
      {
        sessions: frameHeldSessionsFrom(sessionManager),
        requester,
        sessionManager,
      },
    );
  }

  /** A frame's device id as the pool's canonical id, for lookups that run without a discovery. */
  private canonicalFrameDeviceId(deviceId: string): string {
    return canonicalFrameDeviceId(
      this.daemonState.isInitialized() ? this.daemonState.getDevicePool() : undefined,
      deviceId,
    );
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
    ideMutation?: IdeMutationCall,
  ): Promise<{
    platform: "android" | "ios";
    client: KeyValueMutationClient;
    device: BootedDevice;
  }> {
    const platform = platformValue ?? "android";
    if (platform !== "android" && platform !== "ios") {
      throw new Error(`Invalid platform: ${platform}. Must be 'android' or 'ios'.`);
    }
    const { devices: bootedDevices, deviceId: canonicalDeviceId } =
      await this.resolveIdeActionDevices(platform, deviceId, ideMutation?.signal);
    // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
    await this.reconcileDiscoveryObservation(bootedDevices, "socket:ide/keyValueMutation");
    this.assertDeviceActionable(canonicalDeviceId, "to mutate stored values");
    const targetDevice = bootedDevices.find((d) => d.deviceId === canonicalDeviceId);
    if (!targetDevice) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    await this.assertIdeMutationOwnership(request, targetDevice, action, false, ideMutation);
    ideMutation?.signal.throwIfAborted();
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
   * Stamps session use once: from the SDK successful-send hook, or immediately after the
   * fallback abort check before direct-file work. Connecting alone never stamps.
   * Returns the SDK resolution and whether the fallback ran, for store and warning reporting.
   */
  protected async runIdeKeyValueMutation(
    platform: "android" | "ios",
    device: BootedDevice,
    appId: string,
    fileName: string,
    mutation: {
      ideMutation: IdeMutationCall | undefined;
      viaSdk: (onDispatch: () => void) => Promise<PreferenceStoreResolution | void>;
      viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>;
    },
  ): Promise<{
    usedDirectFileFallback: boolean;
    resolution: PreferenceStoreResolution | undefined;
  }> {
    let dispatched = false;
    const onDispatch = () => {
      if (dispatched) {
        return;
      }
      dispatched = true;
      mutation.ideMutation?.dispatching();
    };
    if (platform !== "android") {
      mutation.ideMutation?.signal.throwIfAborted();
      const resolution = (await mutation.viaSdk(onDispatch)) || undefined;
      return { usedDirectFileFallback: false, resolution };
    }
    let resolution: PreferenceStoreResolution | undefined;
    const result = await withAndroidSharedPreferencesInspectionFallback(
      appId,
      fileName,
      () => this.adbClientFactory.create(device),
      async () => {
        mutation.ideMutation?.signal.throwIfAborted();
        resolution = (await mutation.viaSdk(onDispatch)) || undefined;
      },
      // The ide/* params carry no userId, so an ambiguous-user error cannot say "pass userId".
      (adb) => {
        mutation.ideMutation?.signal.throwIfAborted();
        onDispatch();
        return mutation.viaDirectFile(adb).catch(rethrowForRouteWithoutUserId);
      },
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
    // The holder is keyed on the pooled canonical id; the frame may name the device by an alias.
    const derivedSessionUuid =
      sessionManager.getSessionForDevice?.(this.canonicalFrameDeviceId(deviceId)) ?? undefined;
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

  protected async toIosRunnerCoordinates(
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

  /** When an `input/*` request entered the queue and the whole budget it was given. */
  private inputRouteClock(
    request: DaemonRequest,
    input: InputRequestContext | undefined,
  ): { queueEnterMs: number; totalTimeoutMs: number } {
    return {
      queueEnterMs: input?.receivedAtMs ?? this.timer.now(),
      totalTimeoutMs: resolveMcpRequestTimeoutMsOnce(request),
    };
  }

  /**
   * Time left in an input request's budget after its wait in the device queue; the one copy of the
   * check every `input/*` route makes once it reaches the front of the queue (#11814).
   */
  private remainingInputBudgetMs(
    toolName: string,
    origin: string,
    queueEnterMs: number,
    totalTimeoutMs: number,
  ): number {
    const queueWaitMs = this.timer.now() - queueEnterMs;
    const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
    if (remainingTimeoutMs <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin,
        detail: `spent ${queueWaitMs}ms waiting in queue`,
      });
    }
    return remainingTimeoutMs;
  }

  /**
   * The one skeleton every `input/*` route runs: resolve the target device, run the route's
   * dispatch as a tracked keyed device input, and inside that callback check, in this order, the
   * owner has not gone, (typeText append) re-resolve the device, the frame context is current, and
   * the budget survived the queue wait. Only then does `dispatch` run, so the idle stamp
   * (`dispatching`) a route passes to its device write can never precede a pre-dispatch refusal.
   */
  private async runInputRoute<A extends InputRouteArgs, R extends InputRouteResult>(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    input: InputRequestContext | undefined,
    route: InputRouteRun<A, R>,
  ): Promise<{ targetDevice: BootedDevice; result: R }> {
    const { queueEnterMs, totalTimeoutMs } = this.inputRouteClock(request, input);
    const { args } = route;
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      route.action,
      route.bypassAndroidDeviceListCache ?? false,
      input?.requester,
    );
    const keyed = () =>
      this.runTrackedKeyedDeviceInput(
        request.method,
        targetDevice,
        async (signal, dispatching) => {
          assertSocketInputNotAborted(signal);
          const executionDevice = route.reresolve
            ? await route.reresolve(targetDevice)
            : targetDevice;
          if (route.checksFrame) {
            this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, route.action);
          }
          const remainingTimeoutMs = this.remainingInputBudgetMs(
            request.method,
            route.origin,
            queueEnterMs,
            totalTimeoutMs,
          );
          return await route.dispatch({
            targetDevice,
            executionDevice,
            signal,
            dispatching,
            remainingTimeoutMs,
            queueEnterMs,
            totalTimeoutMs,
          });
        },
        this.inputDeviceGate(request.method, route.origin, totalTimeoutMs, queueEnterMs, input),
      );
    const result = await (route.around ? route.around(targetDevice, keyed) : keyed());
    return { targetDevice, result };
  }

  protected async handleInputTap(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.parseInputTapParams(request.params);
    const { targetDevice, result: gestureResult } = await this.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/tap",
        origin: "UnixSocketServer.handleInputTap",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          if (args.platform === "android") {
            const client = AndroidCtrlProxyClient.getInstance(
              targetDevice,
              defaultAdbClientFactory,
            );
            this.requireCoordinatesWithinKnownScreenGeometry(
              [args.x, args.y],
              client.getScreenScaleMetadata?.() ?? null,
            );
            // The signal reaches the send step itself, so an owner that went away while the client
            // was still connecting never has its tap written to the device (#10006).
            return await this.dispatchFencedInput(
              "Tap",
              signal,
              remainingTimeoutMs,
              (fenced, onDispatch) =>
                client.requestTapCoordinates(
                  args.x,
                  args.y,
                  args.duration,
                  remainingTimeoutMs,
                  undefined,
                  args.frameContext,
                  onDispatch,
                  fenced,
                ),
              dispatching,
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
          return await this.dispatchFencedInput(
            "Tap",
            signal,
            gestureTimeoutMs,
            (fenced, onDispatch) =>
              iosClient.requestTapCoordinates(
                x,
                y,
                args.duration,
                gestureTimeoutMs,
                undefined,
                args.frameContext,
                fenced,
                onDispatch,
              ),
            dispatching,
          );
        },
      },
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

  protected async handleInputSwipe(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.parseInputSwipeParams(request.params);
    const { targetDevice, result: gestureResult } = await this.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/swipe",
        origin: "UnixSocketServer.handleInputSwipe",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          if (args.platform === "android") {
            const client = AndroidCtrlProxyClient.getInstance(
              targetDevice,
              defaultAdbClientFactory,
            );
            return await this.dispatchFencedInput(
              "Swipe",
              signal,
              remainingTimeoutMs,
              (fenced, onDispatch) =>
                client.requestSwipe({
                  x1: args.startX,
                  y1: args.startY,
                  x2: args.endX,
                  y2: args.endY,
                  duration: args.durationMs,
                  timeoutMs: remainingTimeoutMs,
                  contextOptions: args.frameContext,
                  onDispatch,
                  signal: fenced,
                }),
              dispatching,
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
          return await this.dispatchFencedInput(
            "Swipe",
            signal,
            gestureTimeoutMs,
            (fenced, onDispatch) =>
              client.requestDrag({
                x1: startX,
                y1: startY,
                x2: endX,
                y2: endY,
                pressDurationMs: 0,
                dragDurationMs: args.durationMs,
                holdDurationMs: 0,
                timeoutMs: gestureTimeoutMs,
                frameContext: args.frameContext,
                signal: fenced,
                onDispatch,
              }),
            dispatching,
          );
        },
      },
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
  protected async handleInputGesture(
    request: DaemonRequest,
    kind: GestureFrameKind,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const method = GESTURE_FRAME_METHODS[kind];
    const args = this.parseInputGestureParams(request.params, method);
    let startAdmission: StrokeAdmission | undefined;
    const { targetDevice, result: gestureResult } = await this.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: method,
        origin: "UnixSocketServer.handleInputGesture",
        args,
        // Frame-identity-free: no frameContext is required or checked.
        checksFrame: false,
        around: (device, run) =>
          this.liftingStrokeOnSessionRefusal(kind, socketSessionId, device, args.gestureId, run),
        dispatch: async ({ targetDevice, signal, dispatching, remainingTimeoutMs }) => {
          // Before the start's admission is captured: it reads the session this frame uses.
          dispatching?.();
          const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
          if (kind !== "start") {
            return this.forwardGestureFrame(client, kind, args, remainingTimeoutMs);
          }
          startAdmission = this.captureStrokeAdmission(targetDevice.deviceId, signal);
          return this.forwardGestureStart(client, args, remainingTimeoutMs, startAdmission);
        },
      },
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `${method} failed on ${args.platform}`);
    }

    if (socketSessionId) {
      await this.trackAckedGestureFrame(
        kind,
        socketSessionId,
        targetDevice,
        args.gestureId,
        startAdmission,
      );
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
   * Track ownership so a socket that tears down mid-drag can lift its still-open on-device stroke.
   * Only an acked start opens the gesture; an end (release OR cancel) closes it. A socket-less
   * forward (no client session) can't be cancelled on close, so it isn't tracked.
   */
  private async trackAckedGestureFrame(
    kind: "start" | "move" | "end",
    socketSessionId: string,
    targetDevice: BootedDevice,
    gestureId: string,
    startAdmission: StrokeAdmission | undefined,
  ): Promise<void> {
    if (kind === "end") {
      this.ownedGestures.onEndAcked(socketSessionId, targetDevice.deviceId, gestureId);
      return;
    }
    if (kind !== "start") {
      return;
    }
    // A start acked after its socket closed is cancelled here instead of recorded (#10005), and so
    // is one whose holder left the device since the in-slot check of `forwardGestureStart`
    // (#11541). Evaluated in the same turn the stroke is recorded, so no release or acquisition
    // can land between the check and the record.
    const admissionHolds = !startAdmission || this.strokeAdmissionStillHolds(startAdmission);
    await this.ownedGestures.onStartAcked(
      socketSessionId,
      targetDevice,
      gestureId,
      startAdmission?.holderSessionId,
      admissionHolds,
    );
    if (startAdmission && !admissionHolds) {
      throw strokeAdmissionEndedError(GESTURE_FRAME_METHODS.start, startAdmission);
    }
  }

  /**
   * Each gesture frame is its own control call, so a `gestureMove`/`gestureEnd` can be refused at
   * session admission (suspect, or released) after its `gestureStart` was admitted (#11417). The
   * runner parks a continued stroke with no ceiling, so the refused frame would leave the pointer
   * down: the daemon lifts the stroke with a cancelling end (no drop is committed) and then
   * answers the typed refusal. A refused `gestureStart` opened nothing.
   *
   * A frame refused for any other reason (the holder gate's `device_owned_by_other_session`, a
   * target resolved for a holder that has left) lifts the stroke this socket owns when the device
   * is no longer held by the session the start was admitted under (#11448): the holder was
   * released between frames, and the stroke must not stay down on the next owner's device.
   */
  private async liftingStrokeOnSessionRefusal<T>(
    kind: "start" | "move" | "end",
    socketSessionId: string | undefined,
    targetDevice: BootedDevice,
    gestureId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (kind !== "start" && isSessionRefusal(error)) {
        try {
          await this.cancelGestureOnDevice(targetDevice, gestureId);
        } catch (cancelError) {
          logger.warn(
            `Failed to lift gesture ${gestureId} on ${targetDevice.deviceId} after its session ` +
              `refused a frame: ${errorMessage(cancelError)}`,
          );
        }
        if (socketSessionId) {
          this.ownedGestures.onEndAcked(socketSessionId, targetDevice.deviceId, gestureId);
        }
      } else if (kind !== "start" && socketSessionId) {
        await this.ownedGestures.cancelIfDeviceChangedHands(
          socketSessionId,
          targetDevice.deviceId,
          gestureId,
          this.getSessionForDevice(targetDevice.deviceId),
        );
      }
      throw error;
    }
  }

  /**
   * The holder a `gestureStart` is being sent under, read in the device's slot immediately before
   * the frame leaves: the session the tracked execution was admitted under and that session's
   * incarnation (a released session re-created under the same id is a different holder), or no
   * holder for a start on a device no session held.
   */
  protected captureStrokeAdmission(deviceId: string, signal?: AbortSignal): StrokeAdmission {
    const executionId = getToolSelectionContext()?.execution?.executionId;
    const holderSessionId = executionId
      ? executionTracker.getAdmittedSessionUse(executionId)
      : undefined;
    return {
      deviceId,
      ...(holderSessionId !== undefined ? { holderSessionId } : {}),
      holderIncarnation: this.getSessionIncarnation(holderSessionId),
      ...(signal ? { signal } : {}),
    };
  }

  /**
   * Whether the device is still held exactly as it was when the start was admitted: the frame was
   * not aborted (a release that cuts, a session acquiring a free device, a cancel), and the device
   * has the same holder incarnation, or still none. Synchronous, so a caller that records the
   * stroke in the same turn cannot be overtaken by a release or an acquisition.
   */
  protected strokeAdmissionStillHolds(admission: StrokeAdmission): boolean {
    if (admission.signal?.aborted) {
      return false;
    }
    if (this.getSessionForDevice(admission.deviceId) !== admission.holderSessionId) {
      return false;
    }
    return this.getSessionIncarnation(admission.holderSessionId) === admission.holderIncarnation;
  }

  /**
   * Send a `gestureStart` from inside the device's slot and, once the runner acks it, check that
   * its admission still holds. A release that cuts does not wait for the ack and streamed frames
   * carry no abort to the runner, so the pointer can go down for a holder that has already left:
   * the release-time lift found no stroke, and recording this one would leave it down on a freed
   * device (#11541). The same goes for a sessionless start whose device a session acquired
   * meanwhile (#10829). Such a start is cancelled here, on the runner directly because this call
   * still occupies the device's slot, so the lift precedes anything queued behind the start, and
   * the frame answers what ended its admission. A failed cancel is logged and the refusal still
   * answered. A start the runner did not accept opened nothing and is never cancelled.
   */
  private async forwardGestureStart(
    client: AndroidCtrlProxyClient,
    args: { gestureId: string; x: number; y: number; cancel: boolean },
    timeoutMs: number,
    admission: StrokeAdmission,
  ) {
    const started = await this.forwardGestureFrame(client, "start", args, timeoutMs);
    if (!started.success || this.strokeAdmissionStillHolds(admission)) {
      return started;
    }
    try {
      await client.requestGestureEnd(args.gestureId, 0, 0, true, OWNED_GESTURE_CANCEL_TIMEOUT_MS);
    } catch (error) {
      logger.warn(
        `Failed to lift gesture ${args.gestureId} on ${admission.deviceId} whose holder left ` +
          `before its start was acked: ${errorMessage(error)}`,
      );
    }
    throw strokeAdmissionEndedError(GESTURE_FRAME_METHODS.start, admission);
  }

  /**
   * A session acquired `deviceId`: lift every stroke that was started on it while no session held
   * it, at acquisition time, so the cancel is on the device's keyed queue ahead of the new holder's
   * first call (#10829, #11541). With no frame in flight nothing else would lift the pointer until
   * the pane sent another frame or its socket closed. Best-effort; never throws.
   */
  liftSessionlessStrokesOn(deviceId: string): void {
    this.trackRequestHandler(this.ownedGestures.cancelAllUnheldOn(deviceId));
  }

  /** Queue the old device's holder strokes before rebind makes it available (#11667). */
  liftStrokesHeldByOn(sessionId: string, deviceId: string): void {
    // Forced same-serial rebinds also notify unbound; the holder kept this device.
    if (this.getSessionForDevice(deviceId) === sessionId) {
      return;
    }
    this.trackRequestHandler(this.ownedGestures.cancelAllHeldByOn(sessionId, deviceId));
  }

  /**
   * A session was released: lift every stroke admitted under it, at release time, so the cancel is
   * on the device's keyed queue ahead of any input the next owner sends (#11448). The frames of a
   * gesture are separate control calls, so a release between two of them cuts no call and nothing
   * else would lift the pointer until the pane's socket closed. Best-effort; never throws.
   */
  protected liftStrokesHeldBy(releasedSessionId: string): Promise<void> {
    return this.ownedGestures.cancelAllHeldBy(releasedSessionId);
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

  protected async handleInputTypeText(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.parseInputTypeTextParams(request.params);
    let confirmedAppendCharsSent: number | undefined;
    const recordConfirmedAppendCharsSent = (charsSent: number): void => {
      confirmedAppendCharsSent = charsSent;
    };
    const { targetDevice, result: inputResult } = await this.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/typeText",
        origin: "UnixSocketServer.handleInputTypeText",
        args,
        bypassAndroidDeviceListCache: args.append,
        // A same-serial emulator may reconnect while this request waits behind an
        // earlier input. Re-read its ADB transport inside the keyed callback so the
        // append-helper lookup cannot reuse a capability from that older instance.
        reresolve: async (device) =>
          args.append && args.platform === "android"
            ? await this.resolveInputTargetDevice(
                args.platform,
                device.deviceId,
                socketSessionId,
                "input/typeText",
                true,
                input?.requester,
              )
            : device,
        checksFrame: true,
        dispatch: async ({
          executionDevice: executionTargetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          totalTimeoutMs,
        }) => {
          const imeAction: ImeAction | undefined = args.submit ? "done" : undefined;
          let dispatched = false;
          const onDispatch = () => {
            input?.onDispatch?.();
            dispatched = true;
            dispatching?.();
          };
          try {
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
                  onDispatch,
                ),
              (timeoutError) =>
                args.append && confirmedAppendCharsSent !== undefined
                  ? new InputTypeTextAppendError(timeoutError.message, confirmedAppendCharsSent)
                  : undefined,
            );
          } catch (error) {
            if (dispatched && signal?.aborted) {
              throw this.indeterminateTextError(error, signal.reason, confirmedAppendCharsSent);
            }
            throw error;
          }
        },
      },
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

  protected async handleInputPressButton(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.parseInputPressButtonParams(request.params);
    const { targetDevice, result: buttonResult } = await this.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/pressButton",
        origin: "UnixSocketServer.handleInputPressButton",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          // Forward the execution tracker's abort signal (this bound-session path
          // is NOT wrapped in runWithAbortSignal, so there is no ambient signal for
          // press to pick up): without it, session teardown mid-home-press leaves
          // the ADB dispatch and foreground-verification reads running (issue #6289).
          const pressButton = new PressButton(
            targetDevice,
            null,
            this.timer,
            undefined,
            (signal, _timeoutMs, send, onDispatch) =>
              this.holdDispatchedInputRequest(
                signal,
                queueEnterMs + totalTimeoutMs - this.timer.now(),
                send,
                onDispatch,
                "Button press request",
              ),
          );
          return await pressButton.press(
            args.button,
            remainingTimeoutMs,
            args.frameContext,
            signal,
            dispatching,
          );
        },
      },
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

  protected async handleInputKey(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.parseInputKeyParams(request.params);
    if (args.platform === "ios") {
      throw new Error(INPUT_KEY_IOS_UNSUPPORTED_ERROR);
    }
    const { targetDevice, result: keyResult } = await this.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/key",
        origin: "UnixSocketServer.handleInputKey",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          return await this.executeSocketInputKey(
            new InputKey(targetDevice, defaultAdbClientFactory, undefined, this.timer),
            {
              key: args.key,
              frameContext: args.frameContext,
              totalTimeoutMs,
              remainingTimeoutMs,
              signal,
              dispatching,
            },
          );
        },
      },
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

  /** A key has one write: its final beforeDispatch hook latches with no proxy await after it. */
  private executeSocketInputKey(
    inputKey: InputKey,
    options: {
      key: InputKeyName;
      frameContext?: string;
      totalTimeoutMs: number;
      remainingTimeoutMs: number;
      signal?: AbortSignal;
      dispatching?: () => void;
    },
  ) {
    const { key, frameContext, totalTimeoutMs, remainingTimeoutMs, signal, dispatching } = options;
    let dispatched = false;
    const send = (fenced: AbortSignal | undefined, onDispatch: () => void) =>
      inputKey.press(key, remainingTimeoutMs, frameContext, [], { signal: fenced, onDispatch });
    return this.runHeldInputOperation(
      "input/key",
      signal,
      (_signal, dispatch) =>
        this.runInputOperationWithTimeout(
          "input/key",
          totalTimeoutMs,
          remainingTimeoutMs,
          "UnixSocketServer.handleInputKey",
          () =>
            this.holdDispatchedInputRequest(
              signal,
              remainingTimeoutMs,
              send,
              () => {
                dispatched = true;
                dispatch?.();
              },
              "Key request",
            ),
          (timeoutError) => (dispatched ? InputKey.indeterminateError(timeoutError) : undefined),
        ),
      () => dispatching?.(),
    );
  }

  private indeterminateTextError(
    error: unknown,
    reason: unknown,
    confirmedCharsSent?: number,
  ): Error {
    const message = `Text input outcome is indeterminate: the request was dispatched but no result was confirmed when cancellation arrived (${errorMessage(reason)}). Do not retry automatically. Observe before retrying.`;
    // A confirmed append prefix remains useful even when submit was cancelled.
    const charsSent =
      confirmedCharsSent ??
      (error instanceof InputTypeTextAppendError ? error.charsSent : undefined);
    const failure =
      charsSent === undefined
        ? new ActionableError(message, { cause: error })
        : new InputTypeTextAppendError(message, charsSent);
    return Object.assign(failure, { requestDispatched: true });
  }

  private holdDispatchedInputRequest<T>(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
    onDispatch?: () => void,
    label = "Text input request",
  ): Promise<T> {
    return holdDispatchedRequest({ timer: this.timer, signal, timeoutMs, label, send, onDispatch });
  }

  /** Hold only ADB input writes; preserve the executor's other methods and receiver. */
  private createSocketInputAdbFactory(optionsForHold: {
    deadline: () => number;
    onDispatch?: () => void;
    label: string;
  }): AdbClientFactory {
    return {
      create: (target, retry) => {
        const adb = defaultAdbClientFactory.create(target, retry);
        return new Proxy(adb, {
          get: (executor, property, receiver) => {
            if (property === "execute") {
              return (
                args: Parameters<typeof adb.execute>[0],
                options: Parameters<typeof adb.execute>[1] = {},
              ) => {
                // Capability probes are reads, not text dispatch. They still cancel immediately.
                if (args[0] !== "shell" || args[1] !== "input") {
                  return adb.execute(args, options);
                }
                return this.holdDispatchedInputRequest(
                  options.signal,
                  Math.min(
                    options.timeoutMs ?? Infinity,
                    optionsForHold.deadline() - this.timer.now(),
                  ),
                  (fenced, dispatched) =>
                    adb.execute(args, {
                      ...options,
                      signal: fenced,
                      beforeDispatch: async (remaining) => {
                        await options.beforeDispatch?.(remaining);
                        fenced?.throwIfAborted();
                        dispatched();
                      },
                    }),
                  optionsForHold.onDispatch,
                  optionsForHold.label,
                );
              };
            }
            const value = Reflect.get(executor, property, receiver);
            return typeof value === "function" ? value.bind(executor) : value;
          },
        });
      },
    };
  }

  private createSocketAppendTextInput(device: BootedDevice): AppendTextInput {
    // InputText checks the original signal between commands. Fence only each ADB
    // execute, so abort cannot release the key early or type the remaining suffix.
    // The executor contract is large; a proxy preserves every existing method and
    // its receiver rather than adding a second generic executor implementation.
    let deadline = 0;
    let onDispatch: (() => void) | undefined;
    const factory = this.createSocketInputAdbFactory({
      deadline: () => deadline,
      onDispatch: () => onDispatch?.(),
      label: "Text input request",
    });
    const input = new InputText(device, factory, undefined, this.timer);
    return {
      appendText: (...args) => {
        deadline = this.timer.now() + (args[1] ?? 0);
        // Latch dispatch only after the original validation and final abort check,
        // not inside InputText's earlier asynchronous beforeDispatch callback.
        onDispatch = args[4];
        return input.appendText(args[0], args[1], args[2], args[3]);
      },
    };
  }

  private async executeInputTypeText(
    platform: "android" | "ios",
    targetDevice: BootedDevice,
    text: string,
    imeAction: ImeAction | undefined,
    timeoutMs: number,
    ...[append = false, frameContext, onConfirmedAppendCharsSent, signal, dispatching]: [
      append?: boolean,
      frameContext?: string,
      onConfirmedAppendCharsSent?: (charsSent: number) => void,
      signal?: AbortSignal,
      dispatching?: () => void,
    ]
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    // Charge set-text and the optional submit/IME action against a single
    // shared budget. Otherwise submit:true would hand each request the full
    // timeout, letting the combined operation run up to 2x the caller's
    // budget while the per-device queue stays held until it settles.
    let dispatched = false;
    const onDispatch = () => {
      if (!dispatched) {
        dispatched = true;
        dispatching?.();
      }
    };
    const deadline = this.timer.now() + timeoutMs;
    const client =
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
        onDispatch,
      });
      if (textResult.charsSent !== undefined) {
        onConfirmedAppendCharsSent?.(textResult.charsSent);
      }
      assertSocketInputNotAborted(signal);
      if (!textResult.success) {
        return {
          success: false,
          error: textResult.error,
          ...(textResult.charsSent !== undefined ? { charsSent: textResult.charsSent } : {}),
        };
      }
      appendCharsSent = textResult.charsSent;
    } else {
      const textResult = await this.holdDispatchedInputRequest(
        signal,
        deadline - this.timer.now(),
        (fenced, dispatched) =>
          append
            ? (client as IOSCtrlProxyClient).requestAppendText(
                text,
                timeoutMs,
                undefined,
                frameContext,
                { abortSignal: fenced, onDispatch: dispatched },
              )
            : client.requestSetText(text, {
                timeoutMs,
                frameContext,
                abortSignal: fenced,
                onDispatch: dispatched,
              }),
        onDispatch,
      );
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
      { signal, onDispatch },
    );
  }

  private async executeAndroidAppendText(
    options: AndroidAppendTextOptions,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    const {
      targetDevice,
      text,
      deadline,
      totalTimeoutMs,
      frameContext,
      client,
      signal,
      onDispatch,
    } = options;
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
    ) => await input.appendText(pending, timeoutMs, validate, signal, onDispatch);
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
    client: Pick<AndroidCtrlProxyClient | IOSCtrlProxyClient, "requestImeAction">,
    imeAction: ImeAction | undefined,
    deadline: number,
    totalTimeoutMs: number,
    appendCharsSent?: number,
    options: { signal?: AbortSignal; onDispatch?: () => void } = {},
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    const { signal, onDispatch } = options;
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
      const result = await this.holdDispatchedInputRequest(
        signal,
        remainingTimeoutMs,
        (fenced, dispatched) =>
          client.requestImeAction(imeAction, remainingTimeoutMs, undefined, fenced, dispatched),
        onDispatch,
      );
      assertSocketInputNotAborted(signal);
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
      if (signal?.aborted) {
        // Cancellation reasons are shared with the owner; preserve them untouched.
        throw error;
      }
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

  private parseInputTapParams(params: unknown): InputTapParams {
    return parseInputTapParams(params);
  }

  private parseInputSwipeParams(params: unknown): InputSwipeParams {
    return parseInputSwipeParams(params);
  }

  private parseInputTypeTextParams(params: unknown): InputTypeTextParams {
    return parseInputTypeTextParams(params);
  }

  private parseInputPressButtonParams(params: unknown): InputPressButtonParams {
    return parseInputPressButtonParams(params);
  }

  private parseInputKeyParams(params: unknown): InputKeyParams {
    return parseInputKeyParams(params);
  }

  private parseInputGestureParams(params: unknown, method: string): InputGestureParams {
    return parseInputGestureParams(params, method);
  }

  /**
   * Input that carries a device-authored context is safe only if the newest observation from that
   * device still reports that exact context. Missing context fails closed: a caller can re-observe
   * and retry, whereas executing against an unproven screen could actuate the wrong UI.
   */
  protected requireCurrentFrameContext(
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
      const platform = readFramePlatformHint(request.params);
      if (!platform) {
        return undefined;
      }
      return this.daemonState
        .getDevicePool()
        .resolveAutolockSessionForMcpSession?.(socketSessionId, platform);
    };
  }

  protected async resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    action: InputTargetAction,
    bypassAndroidDeviceListCache: boolean = false,
    requester?: () => string | undefined,
  ): Promise<BootedDevice> {
    const targetDevice = await this.selectInputTargetDevice(
      platform,
      deviceId,
      socketSessionId,
      action,
      bypassAndroidDeviceListCache,
    );
    await this.assertFrameTargetProven(targetDevice, action, requester);
    this.assertBrokerConnectionInputTarget(socketSessionId, action, targetDevice.deviceId);
    this.captureInputTargetOwner(targetDevice);
    return targetDevice;
  }

  /**
   * An `input/*` frame is control: a socket bound to broker bindings drives only its own binding devices
   * (#11178). Streams and other reads stay open. Generic sockets are unaffected here; their frames
   * on a binding device are refused by the broker binding gate in {@link runTrackedDeviceInput}.
   */
  private assertBrokerConnectionInputTarget(
    socketSessionId: string | undefined,
    action: InputTargetAction,
    deviceId: string,
  ): void {
    this.assertBrokerConnectionControl(socketSessionId, action, { deviceId });
  }

  /**
   * The one confinement every control frame from a managed connection passes (#11178, #11596): the
   * device it would act on is one of the connection's binding devices, and the session it names is
   * one of its binding sessions. A generic (unbound) socket is never refused here.
   */
  private assertBrokerConnectionControl(
    socketSessionId: string | undefined,
    action: string,
    target: { deviceId?: string; requesterSessionUuid?: string },
  ): void {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    const sessionManager = this.daemonState.getSessionManager();
    const refusal = brokerConnectionControlRefusal({
      binding: this.daemonState.getBrokerConnectionScopes?.().get(socketSessionId),
      action,
      deviceId: target.deviceId,
      requesterSessionUuid: target.requesterSessionUuid,
      grantedDeviceOf: (sessionUuid) => sessionManager.getSession(sessionUuid)?.assignedDevice,
    });
    if (refusal) {
      throw refusal;
    }
  }

  private assertBrokerConnectionHostMutation(
    socketSessionId: string | undefined,
    action: string,
  ): void {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    const refusal = brokerConnectionHostMutationRefusal({
      binding: this.daemonState.getBrokerConnectionScopes?.().get(socketSessionId),
      action,
    });
    if (refusal) {
      throw refusal;
    }
  }

  protected captureInputTargetOwner(targetDevice: BootedDevice): void {
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
    const { devices: bootedDevices, deviceId: canonicalDeviceId } =
      await this.discoverInputTargetDevices(
        platform,
        action,
        bypassAndroidDeviceListCache,
        deviceId,
      );
    if (canonicalDeviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === canonicalDeviceId);
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

  protected async runTrackedKeyedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
    gate?: InputDeviceGate,
  ): Promise<T> {
    const executionKey = `device:${targetDevice.deviceId}`;
    return await this.runTrackedDeviceInput(
      toolName,
      targetDevice,
      async (signal, dispatching) =>
        this.runKeyedMcpForward(
          executionKey,
          () => {
            // Parked on the device key, the input may have been cancelled (a session acquired the
            // device, #10829): it is not sent.
            signal?.throwIfAborted();
            return this.runHeldInputOperation(toolName, signal, operation, () => {
              gate?.onDispatch?.();
              dispatching?.();
            });
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
      onDispatch: input?.onDispatch,
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

  /** Preserve ordinary errors; a post-send cancellation is always indeterminate. */
  private async runHeldInputOperation<T>(
    method: string,
    signal: AbortSignal | undefined,
    operation: InputOperation<T>,
    onDispatch: () => void,
  ): Promise<T> {
    if (!DISPATCH_HELD_INPUT_METHODS.has(method) || method === "input/typeText") {
      return operation(signal, onDispatch);
    }
    let dispatched = false;
    const dispatch = () => {
      if (!dispatched) {
        onDispatch();
        dispatched = true;
      }
    };
    try {
      const result = await operation(signal, dispatch);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (dispatched && signal?.aborted) {
        throw indeterminateInputError(method, error);
      }
      // Keep the existing plain cancellation for an unlabelled caller abort.
      if (signal?.reason instanceof DOMException && signal.reason.name === "AbortError") {
        throwIfAborted(signal);
      }
      signal?.throwIfAborted();
      throw error;
    }
  }

  protected dispatchFencedInput<T>(
    gesture: "Tap" | "Swipe",
    signal: AbortSignal | undefined,
    timeoutMs: number,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
    onDispatch?: () => void,
  ): Promise<T> {
    return this.runHeldInputOperation(
      `input/${gesture.toLowerCase()}`,
      signal,
      (_signal, dispatch) =>
        this.holdDispatchedInputRequest(signal, timeoutMs, send, dispatch, `${gesture} request`),
      () => onDispatch?.(),
    );
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

  /** A broker binding's device, idle or held, takes input only from that binding's execution (#11178). */
  private async assertInputBindingGate(
    toolName: string,
    targetDevice: BootedDevice,
    requester: (() => string | undefined) | undefined,
  ): Promise<void> {
    if (!this.daemonState.isInitialized()) {
      return;
    }
    await assertInputNotOnForeignBindingDevice({
      action: toolName,
      deviceId: targetDevice.deviceId,
      platform: targetDevice.platform,
      requesterSessionUuid: requester?.(),
      sessionManager: this.daemonState.getSessionManager(),
      gate: this.daemonState.getDevicePool(),
    });
    // A device no local session holds takes no input while another daemon claims it (#11349).
    await assertControlNotOnForeignDaemonDevice({
      deviceId: targetDevice.deviceId,
      platform: targetDevice.platform,
      gate: this.daemonState.getDevicePool(),
    });
  }

  protected async runTrackedDeviceInput<T>(
    toolName: string,
    targetDevice: BootedDevice,
    operation: InputOperation<T>,
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
    await this.assertInputBindingGate(toolName, targetDevice, requester);
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
      throw new SessionNoLongerOwnsDeviceError(
        resolvedOwner,
        targetDevice.deviceId,
        `Session ${resolvedOwner} no longer owns device '${targetDevice.deviceId}' (it was rebound ` +
          `or released after this input resolved its target); the input was not sent.`,
      );
    }
    const execution = executionTracker.startExecution(toolName, undefined, sessionUuid);
    const signal = execution.abortController.signal;
    try {
      executionTracker.bindDeviceExecution(execution.id, targetDevice.deviceId);
      signal.throwIfAborted();
      await this.admitInputAsControlCall(execution, targetDevice.deviceId, sessionUuid);
      // The holder, readiness and admission checks passed, so the execution stays tracked as
      // control in flight on the session from here on. It is USE of the session (#10824) only once
      // the handler's own pre-dispatch checks passed too: a frame refused for a stale frame
      // context, spent budget or out-of-bounds coordinates sends nothing and must not restart the
      // idle window (#11596).
      const dispatching = () => executionTracker.markSessionAdmitted(execution.id);
      if (!sessionUuid) {
        // Admitted on a device no session holds: a session acquiring it while this input is parked
        // or in flight cancels it (#10829).
        executionTracker.markSessionlessDeviceUse(execution.id, targetDevice.deviceId);
      }
      const runOperation = (fenced?: AbortSignal) =>
        DISPATCH_HELD_INPUT_METHODS.has(toolName)
          ? this.runCancellableInputHandler(
              (onDispatch) =>
                operation(fenced, () => {
                  onDispatch();
                  dispatching();
                }),
              fenced,
            )
          : operation(fenced, dispatching);
      return await this.answeringSessionRelease(execution, () =>
        runWithToolSelectionContext(
          {
            execution: {
              ...sessionExecutionMetadataOf(execution),
              deviceBinding: {
                bindDeviceExecution: (deviceId) =>
                  executionTracker.bindDeviceExecution(execution.id, deviceId),
              },
            },
          },
          () => this.runFencedInputOperation(signal, ownerSignal, runOperation),
        ),
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  }

  /**
   * Input on a held device is a control call on the holder's session: refused while the session is
   * suspect, lapsed or past its idle deadline, exactly as an MCP control call is (#11417). Input
   * on a device no session holds has no session to admit.
   */
  private async admitInputAsControlCall(
    execution: ActiveExecution,
    deviceId: string,
    holderSessionUuid: string | undefined,
  ): Promise<void> {
    if (!holderSessionUuid) {
      return;
    }
    await admitInputOnHolderSession({
      deviceId,
      holderSessionUuid,
      sessionManager: this.daemonState.getSessionManager(),
      execution: sessionExecutionMetadataOf(execution),
    });
    // A release that landed while admission was awaited answers its own typed refusal.
    await this.answeringSessionRelease(execution, async () =>
      execution.abortController.signal.throwIfAborted(),
    );
  }

  /**
   * Run a tracked input and, when the daemon released its session mid-call and that release
   * cancelled it, answer the typed terminal refusal the MCP path gives, whatever the interrupted
   * operation threw (#11381). The thrown release carries its wire fields to the failure frame.
   */
  protected async answeringSessionRelease<T>(
    execution: Pick<ActiveExecution, "cancelReason"> & Partial<Pick<ActiveExecution, "toolName">>,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const released = sessionReleaseThatCancelledCall(execution.cancelReason);
      if (
        released &&
        error instanceof Error &&
        "requestDispatched" in error &&
        error.requestDispatched === true
      ) {
        // A release error can cancel several calls. Keep its class and wire fields without
        // mutating the shared reason (a concurrent call must not inherit another call's send note or append count).
        const dispatchedRelease = new SessionReleasedDuringCallError(
          released.sessionUuid,
          released.releaseReason,
        );
        const request =
          execution.toolName === "input/typeText" || error instanceof InputTypeTextAppendError
            ? "the text request"
            : "the request";
        dispatchedRelease.message = `${released.message} Cancellation arrived after ${request} had been dispatched; its outcome is indeterminate.`;
        if (error instanceof InputTypeTextAppendError) {
          dispatchedRelease.charsSent = error.charsSent;
        }
        throw dispatchedRelease;
      }
      throw released ?? error;
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
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery> {
    const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(
      platform,
      {
        bypassAndroidDeviceListCache,
      },
    );
    // The frame's rows and device id as pooled canonical ids, before anything reads pool state.
    const canonical = await this.canonicalFrameDiscovery(platform, discovery.devices, deviceId);
    // FUNNEL 1: the target this resolves is handed straight to the device-addressed
    // admission gate, which reads pool state — so the pool must have seen this
    // observation first (#6863 review).
    await this.reconcileDiscoveryObservation(canonical.devices, `socket:${action}`);
    if (!discovery.succeededPlatforms.has(platform)) {
      throw new Error(`Unable to discover booted ${platform} devices for ${action}`);
    }
    return canonical;
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

  protected async handleIdeRequest(
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

    const passthrough = runPassthroughForward({
      mcpClient,
      request,
      timeoutMs,
      options: requestOptions,
      admitted: (args, forward) => this.withAdmittedBoundSession(args, forward),
      readAdmissionArgs: (r) => this.boundSessionAdmissionArgs(r),
    });
    if (passthrough) {
      return await passthrough;
    }

    switch (request.method) {
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
          return await this.withAdmittedBoundSession(
            request.params.arguments,
            () => {
              const forwardedArguments = this.withSocketSessionAutolockKey(
                request.params.arguments,
                socketSessionId,
                timeoutMs,
              );
              return this.traceCallTool(request, () =>
                callForwardedTool(
                  mcpClient,
                  request,
                  this.withLiveDeadlineKey(forwardedArguments, liveDeadlineKey),
                  callOptions,
                ),
              );
            },
            socketSessionId,
          ).catch(async (error: unknown) => {
            const state = getLiveTextRequestState(liveDeadlineKey);
            if (!state?.hasPending()) {
              return this.textForwardFailure(liveDeadlineKey, request.params.name, error);
            }
            const indeterminate = state.timeoutError(error)!;
            const remainingMs = deadline.value - this.timer.now();
            if (remainingMs > 0) {
              try {
                await raceWithDeadline(state.settled(), {
                  timeoutMs: remainingMs,
                  timer: this.timer,
                  label: "Dispatched text settlement",
                });
              } catch (waitError) {
                // Settlement is best-effort within the original deadline; preserve the indeterminate answer.
                logger.debug("Dispatched text settlement wait ended", waitError);
              }
            }
            return shapeToolCallError(indeterminate, {
              toolName: request.params.name,
              source: "MCP",
            });
          });
        } finally {
          cleanup();
        }
      }
      default:
        // `tasks/get`, `tasks/update` and `tasks/cancel` (#4668); anything else is refused.
        return await forwardTaskRequest(mcpClient, request, requestOptions);
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

  protected withSocketSessionAutolockKey(
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
    const usesBoundSession = this.honoursBoundSessionMarker(forwardedArgs, socketSessionId);
    delete forwardedArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    delete forwardedArgs[DAEMON_OWNED_SESSIONS_PARAM];
    delete forwardedArgs[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    this.recordOneShotCliConnection(socketSessionId, forwardedArgs);
    // Only the daemon asserts the loopback marker, from the connection's own declaration.
    delete forwardedArgs[INTERNAL_ONE_SHOT_CLI_PARAM];
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

  /** Open the client one forward runs through: its own in-process server (#11820). */
  private async createMcpClient(
    boundSessionUuid?: string,
    toolSelectionProfileUuid?: string,
    releasedSessionUuid?: string,
  ): Promise<Client> {
    return await this.mcpDispatcher.connect({
      boundSessionUuid,
      toolSelectionProfileUuid,
      releasedSessionUuid,
      sessionKey: currentForwardSessionKey(),
      taskOwnerKey: currentForwardTaskOwnerKey(),
    });
  }

  protected scheduleForwardKeyIdle(key: string): void {
    this.clearForwardKeyIdleTimer(key);
    const timer = this.timer.setTimeout(() => {
      this.onForwardKeyIdle(key);
    }, FORWARD_KEY_IDLE_MS);
    this.forwardKeyIdleTimers.set(key, timer);
  }

  protected clearForwardKeyIdleTimer(key: string): void {
    const timer = this.forwardKeyIdleTimers.get(key);
    if (!timer) {
      return;
    }
    this.timer.clearTimeout(timer);
    this.forwardKeyIdleTimers.delete(key);
  }

  /**
   * Nothing has used this execution key for the idle window. For a device key, drop the cached
   * append helper so its API-level probe cannot go stale across a device swap under the same id.
   */
  private onForwardKeyIdle(key: string): void {
    this.forwardKeyIdleTimers.delete(key);
    if (this.mcpForwardTails.has(key) || this.isMcpClientKeyBound(key)) {
      return;
    }
    const devicePrefix = "device:";
    if (key.startsWith(devicePrefix)) {
      this.appendTextInputs.delete(key.slice(devicePrefix.length));
    }
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

  /** Held input must observe socket close before its handler enters device resolution. */
  private socketAdmissionCancellation(
    request: DaemonRequest,
    sessionId: string,
    ownerSocket: Socket,
    cancelSignal: AbortSignal,
  ): { signal: AbortSignal; dispose: () => void } {
    if (!DISPATCH_HELD_INPUT_METHODS.has(request.method)) {
      return { signal: cancelSignal, dispose: () => {} };
    }
    return this.mcpRequestSignal(sessionId, ownerSocket, cancelSignal);
  }

  /** Race cancellation only until a held frame synchronously latches its first send. */
  private async runCancellableInputHandler<T>(
    handler: (onDispatch: () => void) => Promise<T>,
    cancelSignal: AbortSignal | undefined,
  ): Promise<T> {
    const beforeDispatch = new AbortController();
    let dispatched = false;
    const onAbort = () => {
      if (!dispatched) {
        beforeDispatch.abort(cancelSignal?.reason);
      }
    };
    cancelSignal?.addEventListener("abort", onAbort, { once: true });
    if (cancelSignal?.aborted) {
      onAbort();
    }
    try {
      return await this.runCancellableQueuedHandler(
        () =>
          handler(() => {
            // The latch chooses which answer wins. The request hold aborts its fence
            // in the same tick before dispatch, preventing a later send.
            beforeDispatch.signal.throwIfAborted();
            dispatched = true;
            cancelSignal?.removeEventListener("abort", onAbort);
          }),
        beforeDispatch.signal,
      );
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
    }
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
    this.restartAdmission.releaseAll();

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

    this.boundMcpClientKeysBySocketSession.clear();
    for (const timer of this.forwardKeyIdleTimers.values()) {
      this.timer.clearTimeout(timer);
    }
    this.forwardKeyIdleTimers.clear();
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
      ...daemonShuttingDownFrameFields(daemonShuttingDownFailure(pending.admitted)),
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

  /** Typed access to the MCP forward-routing internals for daemon integration tests. */
  get testHooks(): UnixSocketServerTestHooks {
    return {
      restoreSelectorSessions: (args, id) => this.restoreSelectorSessions(args, id),
      getMcpForwardRoute: (request, id) => this.getMcpForwardRoute(request, id),
      withSocketSessionAutolockKey: (args, id, timeoutMs) =>
        this.withSocketSessionAutolockKey(args, id, timeoutMs),
      recordBoundMcpClientKey: (request, id, route, active, response) =>
        this.recordBoundMcpClientKey(request, id, route, active, response),
    };
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
