import { defaultLockOwnerGenerationProbe } from "../lockOwnerGeneration";

import type { IdeMutationCall } from "../socketServer/ideMutationCall";

import { logger } from "../../utils/logger";

import { ProgressExtendableDeadline } from "../mcpRequestTimeout";

import {
  DaemonRequest,
  type BoundSessionLoss,
  type DaemonRequestFailureCause,
  type DaemonOptions,
} from "../types";

import {
  DaemonSocketReachability,
  type DaemonSocketReachabilityLike,
} from "../client/daemonSocketReachability";
import { isProcessRunning, readPidFileDataSync } from "../daemonFiles";
import { tryAcquireExclusiveLock, releaseExclusiveLock } from "../../utils/fileLock";

import {
  type AppendKeyEventValidator,
  type AppendTextOptions,
} from "../../features/action/InputText";

import { DaemonStateAccess } from "../daemonRequestHandlers";

import { Timer } from "../../utils/SystemTimer";

import { daemonToolRegistry } from "../toolRegistryPort";
import { type FrameDeviceIdentityPool } from "../frameDeviceIdentity";

import type { AndroidCtrlProxy } from "../../features/observe/android";

import type { AppendTextFailureSource, BootedDevice, ImeAction } from "../../models";

import { ClientRequestCancellation } from "./ClientRequestCancellation";
export /** Slack after the handler's settlement wait for it to finish rollback and build its result. */
const PROVISION_CANCELLATION_OUTCOME_GRACE_MS = 2_000;
export const MCP_FORWARD_START_HEADROOM_MS = 100;
/**
 * How many times one forward may follow its route to a different execution key before it
 * fails. Each hop releases the previous key first, so this only bounds route churn; it is
 * not what prevents the crossed-route deadlock (issue #6388).
 */
export const MAX_MCP_FORWARD_REROUTES = 3;
export const MCP_OVERLOAD_RETRY_AFTER_MS = 250;
export function socketRequestId(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}
export function isClientForwardCancellation(
  signal: AbortSignal | undefined,
  cause: DaemonRequestFailureCause | undefined,
): boolean {
  return (
    signal?.aborted === true &&
    (cause?.message === "Daemon MCP client disconnected" ||
      signal.reason instanceof ClientRequestCancellation)
  );
}
export function logRequestFailureCause(cause: DaemonRequestFailureCause | undefined): void {
  if (cause) {
    logger.error(`Original MCP request failure cause: ${cause.name}: ${cause.message}`);
  }
}
export function resolveIdentityStartedAt(value: number | undefined, timer: Timer): number {
  return value === undefined ? timer.now() : value;
}
export function snapshotDaemonOptions(options: DaemonOptions | undefined): DaemonOptions {
  return structuredClone(options ?? {});
}
export const DEVICE_ACQUISITION_TOOL_NAMES = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
]);
export /** Keep shutdown bounded if a request handler ignores its disconnected peer. */
const DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS = 1_000;
export /** Keep shutdown bounded if a client cannot flush a release notification. */
const DAEMON_NOTIFICATION_WRITE_DRAIN_TIMEOUT_MS = 1_000;
export /**
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
export /**
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
export /**
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
 * {@link import("../incumbentOwnerGuard").IncumbentOwnerGuard}-backed liveness that
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
export /**
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
 * The narrow append-text surface `input/typeText mode:"append"` needs.
 *
 * Exactly one method, deliberately: the daemon never wants the observe round trip
 * or the replace-shaped modes {@link InputText} also exposes, and a narrow seam is
 * what lets a test inject a fake adb instead of shelling out.
 */
export interface AppendTextInput {
  appendText(
    text: string,
    options?: AppendTextOptions,
  ): Promise<{
    success: boolean;
    error?: string;
    charsSent?: number;
    /**
     * Who produced a failure -- see {@link AppendTextFailureSource}. Absent
     * means the helper. The self-heal in
     * {@link SocketTextInput.executeAndroidAppendText} keys on this rather than
     * on `charsSent === 0`, which cannot tell the two apart.
     */
    failureSource?: AppendTextFailureSource;
  }>;
}
export interface CachedAppendTextInput {
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
export interface BoundMcpClient {
  clientKey: string;
  executionKey: string;
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  requiresLiveDaemonSession: boolean;
}
export /** One keyed attempt either ran the forward or found its route moved to another key. */
type McpForwardAttempt<T> =
  | { kind: "done"; value: T }
  | { kind: "reroute"; route: McpForwardRoute };
export /** Recovery lookup is optional only for older socket-state fakes. */
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
      isSessionOwnedByConnection?(sessionId: string, mcpSessionId?: string): boolean;
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
export const registeredDeviceReadClassifier: DeviceReadToolCallClassifier = (toolName, args) =>
  daemonToolRegistry().getRegisteredTool(toolName)?.isDeviceReadOnlyCall?.(args) === true;
export /**
 * Suffix of a device's read lane (#10969). A watcher's read of a device another session holds
 * runs on the read path, which has no device side effects there, so it never queues behind the
 * holder's control calls on `device:<id>`. Reads still serialize among themselves.
 */
const MCP_FORWARD_READ_LANE_SUFFIX = ":read";
export const MCP_FORWARD_DEVICE_KEY_PREFIX = "device:";
export /** How long a closed socket's late executions may still write bindings that are then forgotten. */
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
export interface McpForwardContext {
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
export const isNonBlankSessionUuid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export function isExpectedSocketFrameAbort(error: unknown, socketDestroyed: boolean): boolean {
  return (
    error instanceof ClientRequestCancellation ||
    (socketDestroyed &&
      error instanceof Error &&
      error.message === "Daemon MCP client disconnected")
  );
}
export function assertSocketInputNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
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
export interface ProfileReaffirmForwardRouteOptions {
  args: unknown;
  socketSessionId: string;
  toolName: unknown;
  sessionUuid: string;
  toolSelectionProfileUuid: string | undefined;
  scopedKey: string | undefined;
  boundRoute: McpForwardRoute | undefined;
}
/** Per-request options for `SocketTextInput.executeInputTypeText`, after the target and text. */
export interface InputTypeTextExecutionOptions {
  imeAction?: ImeAction;
  timeoutMs: number;
  append?: boolean;
  frameContext?: string;
  onConfirmedAppendCharsSent?: (charsSent: number) => void;
  signal?: AbortSignal;
  dispatching?: () => void;
}
/** Shared result of one append-text attempt. */
export type AppendTextAttemptResult = Awaited<ReturnType<AppendTextInput["appendText"]>>;
/** How `retryAppendTextWithRebuiltHelper` re-runs the append within the original budget. */
export interface AppendTextRetry {
  deadline: number;
  beforeKeyEvent: AppendKeyEventValidator | undefined;
  run: (
    input: AppendTextInput,
    pending: string,
    timeoutMs: number,
    validate: AppendKeyEventValidator | undefined,
  ) => Promise<AppendTextAttemptResult>;
}
/** The budget and attribution `runInputOperationWithTimeout` reports a timeout against. */
export interface InputOperationBudget {
  toolName: string;
  origin: string;
  totalTimeoutMs: number;
  remainingTimeoutMs: number;
}
export interface AndroidAppendTextOptions {
  onDispatch?: () => void;
  targetDevice: BootedDevice;
  text: string;
  deadline: number;
  totalTimeoutMs: number;
  frameContext: string | undefined;
  /** Only used to validate frameContext before each append key event. */
  client: Pick<AndroidCtrlProxy, "validateFrameContext">;
  signal?: AbortSignal;
}
export type IdeServerRouteHandler = (
  request: DaemonRequest,
  socketSessionId: string | undefined,
  ideMutation: IdeMutationCall | undefined,
) => Promise<any | undefined> | any;
