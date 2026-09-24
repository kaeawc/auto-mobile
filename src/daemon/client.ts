import { createConnection, Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { z } from "zod";
import { logger } from "../utils/logger";
import { encodeNonFinite } from "../utils/nonFiniteJson";
import { ActionableError } from "../models";
import {
  DaemonRequest,
  DaemonResponse,
  DaemonNotification,
  isDaemonNotification,
  PROGRESS_NOTIFICATION_METHOD,
  sanitizeBoundSessionLoss,
  sanitizeDaemonRequestFailureCause,
} from "./types";
import type { BoundSessionLoss } from "./types";
import {
  SOCKET_PATH,
  PID_FILE_PATH,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_NON_FINITE_ENCODED_PARAM,
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
} from "./constants";
import { isDaemonShuttingDownFailure } from "./daemonShutdownOutcome";
import { type BuildIdentity, getCurrentBuildIdentity } from "./buildIdentity";
import { resolveMcpRequestTimeoutMs, ProgressExtendableDeadline } from "./mcpRequestTimeout";
import { McpOverloadError, McpTimeoutError, sanitizeMcpOverloadFailure } from "./McpTimeoutError";
import { DaemonDisconnectError } from "./DaemonDisconnectError";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import { type IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "./deviceControlTransportFailure";
import { readPidFileDataSync, isProcessRunning } from "./daemonFiles";
import { isDaemonHandshakeFailure, type DaemonHandshakeFailure } from "./daemonHandshake";
import type { DaemonOptions, DaemonStatus } from "./types";

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
  mcpRecording: z.boolean().optional(),
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
}) satisfies z.ZodType<DaemonOptions>;

// Fails at compile time when DaemonOptions gains a field that ide/status would
// otherwise silently strip before startup-option reconciliation can inspect it.
type DaemonOptionsSchemaCoversAllKeys =
  Exclude<keyof DaemonOptions, keyof typeof daemonOptionsSchema.shape> extends never ? true : never;
export const daemonOptionsSchemaCoversAllKeys: DaemonOptionsSchemaCoversAllKeys = true;

const socketIdentityStatusSchema = z.object({
  pid: z.number().int().positive().optional(),
  version: z.string().trim().min(1),
  buildId: z.string().optional(),
  entryScript: z.string().optional(),
  releaseVersion: z.string().optional(),
  startedAt: z.number().finite().optional(),
  processGenerationToken: z.string().optional(),
  activeProvisioning: z.boolean().optional(),
  acceptanceCapabilityFingerprint: z.string().nullable().optional(),
});

const socketOptionsStatusSchema = z.object({
  options: daemonOptionsSchema.optional(),
  effectiveDebug: z.boolean().optional(),
});

/** The server rejected this request before dispatch; retry cannot duplicate work. */
export class DaemonHandshakeMismatchError extends ActionableError {
  constructor(
    readonly failure: DaemonHandshakeFailure,
    message: string,
  ) {
    super(`Daemon preflight failed; no device operation started. ${message}`);
    this.name = "DaemonHandshakeMismatchError";
  }
}

/**
 * Custom error thrown when daemon is unavailable
 */
export class DaemonUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonUnavailableError";
  }
}

/** Retryable response from a live daemon that has stopped admitting work. */
export class DaemonShuttingDownError extends DaemonUnavailableError {
  constructor() {
    super(DAEMON_SHUTTING_DOWN_ERROR_MESSAGE);
    this.name = "DaemonShuttingDownError";
  }
}

/** A terminal loss of a session explicitly bound to the forwarded request. */
export class DaemonBoundSessionLostError extends ActionableError {
  constructor(readonly failure: BoundSessionLoss) {
    super(
      `Device session ${failure.sessionUuid} is no longer active (${failure.reason}). ` +
        "Acquire a new device session before continuing.",
    );
    this.name = "DaemonBoundSessionLostError";
  }
}

/**
 * Normalize a socket-level transport failure into a `DaemonUnavailableError`.
 *
 * When a daemon restart/crash tears down the connection, an in-flight request's
 * socket emits a raw transport error (`ECONNRESET` / `EPIPE` / "socket hang up")
 * with no daemon-level meaning. Surfacing that raw error verbatim wedges every
 * other connected session (#2599): the proxy only treats `DaemonUnavailableError`
 * and the daemon's own `Session not found` as recoverable, so a raw `ECONNRESET`
 * is not retried (#2737). Typing it here — at the layer that knows it is a socket
 * failure — keeps the recoverability signal in one place: the proxy reconnects via
 * its existing `instanceof DaemonUnavailableError` branch, and a *daemon-returned*
 * application error that merely mentions a transport code (e.g. a tool reporting a
 * downstream `connect ECONNREFUSED`) stays an `ActionableError` and is correctly
 * not retried. Already-typed `DaemonUnavailableError`s pass through unchanged.
 */
export function toDaemonTransportError(error: Error): DaemonUnavailableError {
  if (error instanceof DaemonUnavailableError) {
    return error;
  }
  return new DaemonUnavailableError(`Daemon socket connection lost: ${error.message}`, {
    cause: error,
  });
}

function daemonLifecycleResponseError(response: DaemonResponse): Error | undefined {
  if (isDaemonHandshakeFailure(response.handshakeFailure)) {
    return new DaemonHandshakeMismatchError(
      response.handshakeFailure,
      response.error || "Daemon identity mismatch",
    );
  }
  if (isDaemonShuttingDownFailure(response.daemonShuttingDown)) {
    return new DaemonShuttingDownError();
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

function daemonSessionResponseError(response: DaemonResponse): Error | undefined {
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

function daemonFallbackResponseError(response: DaemonResponse): Error {
  const requestFailureCause = sanitizeDaemonRequestFailureCause(response.requestFailureCause);
  const cause = requestFailureCause ? new Error(requestFailureCause.message) : undefined;
  if (cause && requestFailureCause) {
    cause.name = requestFailureCause.name;
  }
  return new ActionableError(response.error || "Unknown error from daemon", { cause });
}

function daemonResponseError(response: DaemonResponse): Error {
  return (
    daemonLifecycleResponseError(response) ??
    daemonSessionResponseError(response) ??
    daemonFallbackResponseError(response)
  );
}

/**
 * Options consulted ONLY to produce a helpful diagnostic hint on a failed
 * `connect()` — never to unlink anything (issue #6140 design change).
 *
 * `DaemonClient` used to perform client-side stale-socket recovery: on a failed
 * connect with the PID file's recorded owner confirmed dead, it would unlink the
 * socket/PID files and retry. That unlink had no ownership proof and could race
 * a concurrent startup winner, deleting its live socket: the exact brick #6140
 * is about. Recovery is now limited to the daemon bind guard, which requires an
 * unreachable socket and a positively-dead recorded owner before unlinking; the
 * client never touches the filesystem and only reads the PID file to decide
 * whether a hint is warranted.
 */
export interface DaemonClientRecoveryOptions {
  /** PID-file path consulted for the stale-socket diagnostic hint. Defaults to `PID_FILE_PATH`. */
  pidFilePath?: string;

  /**
   * Injectable liveness check for the diagnostic hint, so tests can drive a
   * "recorded PID confirmed dead" outcome without a real dead/live PID. Defaults
   * to a real `process.kill(pid, 0)` probe ({@link isProcessRunning}).
   */
  isProcessRunning?: (pid: number) => boolean;
}

/**
 * Per-RPC transport budget. Lifecycle callers use this to share one absolute
 * deadline across connect and every control request instead of silently
 * resetting to the client's default for each hop.
 */
export interface DaemonMethodCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * CLI Client for communicating with the daemon via Unix socket
 *
 * Responsibilities:
 * - Check if daemon is available
 * - Connect to daemon via Unix socket
 * - Send tool call requests
 * - Receive and parse responses
 * - Handle timeouts and errors
 */
export class DaemonClient {
  private socket: Socket | null = null;
  private socketPath: string;
  private connectionTimeout: number;
  private timer: Timer;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: DaemonResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      toolName: string;
      /**
       * Present only for a `tools/call` that asked for progress relay
       * (`progressToken !== undefined`). Lets a matching
       * `notifications/progress` frame reset THIS pending request's own
       * timer below, bounded by `deadline`'s ceiling -- without this, the
       * daemon-side deadline can be correctly extended while this client's
       * own independent timer still fires at the original fixed timeout
       * (issue #6222 review, P1). A request with no progressToken never has
       * these set and its timer is never touched, matching today's behavior
       * exactly.
       */
      progressToken?: string | number;
      deadline?: ProgressExtendableDeadline;
      requestTimeoutMs?: number;
      removeAbortListener?: () => void;
      /** Per-request context retained if the shared socket closes. */
      disconnectCause: McpTimeoutError | DaemonDisconnectError;
    }
  > = new Map();
  private buffer: string = "";
  private connected: boolean = false;
  private notificationHandlers: Set<(notification: DaemonNotification) => void> = new Set();
  private connectionClosedHandlers: Set<() => void> = new Set();
  private recoveryOptions: DaemonClientRecoveryOptions;
  private readonly clientIdentity: { version: string; build: BuildIdentity } | null;
  private readonly idGenerator: IdGenerator;
  /**
   * Injected so a test can simulate Windows named-pipe semantics without a real
   * OS switch (issue #6140). Defaults to the real platform. A Windows named pipe
   * has no filesystem entry, so `connectOnce`'s `existsSync` precheck must be
   * skipped there, mirroring the platform branch already in {@link isAvailable}.
   */
  private readonly platform: NodeJS.Platform;

  constructor(
    socketPath: string = SOCKET_PATH,
    connectionTimeout: number = CONNECTION_TIMEOUT_MS,
    timer: Timer = defaultTimer,
    recoveryOptions: DaemonClientRecoveryOptions = {},
    // `null` opts out of the handshake so the daemon treats this client as legacy and never gates
    // it — used by diagnostics (doctor) that must reach even a wrong-build daemon to report it,
    // without triggering a restart. Defaults to this process's real version/build identity.
    clientIdentity: { version: string; build: BuildIdentity } | null = {
      version: DAEMON_VERSION,
      build: getCurrentBuildIdentity(),
    },
    idGenerator: IdGenerator = defaultIdGenerator,
    platformOverride: NodeJS.Platform = platform(),
  ) {
    this.socketPath = socketPath;
    this.connectionTimeout = connectionTimeout;
    this.timer = timer;
    this.recoveryOptions = recoveryOptions;
    this.clientIdentity = clientIdentity;
    this.idGenerator = idGenerator;
    this.platform = platformOverride;
  }

  /**
   * The version/build-identity fields every outbound request carries so the
   * daemon's server-side handshake gate (#2744) can reject a wrong-build client.
   * Empty when {@link clientIdentity} is null (a deliberately ungated diagnostic client).
   */
  private handshakeFields(): Pick<
    DaemonRequest,
    "clientVersion" | "clientBuildId" | "clientEntryScript"
  > {
    if (!this.clientIdentity) {
      return {};
    }
    return {
      clientVersion: this.clientIdentity.version,
      clientBuildId: this.clientIdentity.build.buildId,
      clientEntryScript: this.clientIdentity.build.entryScript,
    };
  }

  /**
   * Serialize an outbound request as a newline-delimited frame, encoding any
   * non-finite argument as a JSON-safe sentinel (#5854 §2). When — and only when —
   * a tool call actually encoded a non-finite value, we stamp a transport-provenance
   * flag inside `arguments` so the MCP handler knows this request is sentinel-encoded
   * and must be revived (#5863); requests with no non-finite values carry no flag and
   * the handler leaves them untouched.
   */
  private serializeRequestFrame(request: DaemonRequest): string {
    const { value, encoded } = encodeNonFinite(request);
    if (encoded && request.type === "mcp_request" && request.method === "tools/call") {
      const params = (value as { params?: Record<string, unknown> }).params;
      if (params && typeof params === "object") {
        const existingArgs =
          params.arguments &&
          typeof params.arguments === "object" &&
          !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        params.arguments = { ...existingArgs, [DAEMON_NON_FINITE_ENCODED_PARAM]: true };
      }
    }
    return JSON.stringify(value) + "\n";
  }

  /**
   * Check if daemon is available (socket file exists and is connectable).
   * Uses a lightweight raw socket probe — no logging, no DaemonClient overhead.
   *
   * Purely observation-only (issue #6140 design change): this NEVER unlinks the
   * socket or PID file, even when the path is a stale non-socket file or the
   * connect attempt fails. The bind guard performs any permitted stale-socket
   * reclamation only after proving the recorded owner dead; a client-side unlink
   * here has no equivalent ownership proof and could delete a concurrent startup
   * winner's live socket.
   */
  static async isAvailable(
    socketPath: string = SOCKET_PATH,
    options: { signal?: AbortSignal; timeoutMs?: number; timer?: Timer } = {},
  ): Promise<boolean> {
    const timer = options.timer ?? defaultTimer;
    // On Unix, verify the path exists and is a socket (not a stale regular file).
    // On Windows, named pipes don't have filesystem entries — skip the stat check
    // and let createConnection determine reachability.
    if (platform() !== "win32") {
      try {
        const stats = statSync(socketPath);
        if (!stats.isSocket()) {
          return false;
        }
      } catch (error) {
        // statSync throws when the path doesn't exist (or is unreadable); either way
        // there's no live daemon socket to connect to, so report unavailable.
        logger.debug(`src/daemon/client.ts fallback failed: ${error}`, error);
        return false;
      }
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        }
      };
      const onAbort = () => {
        timer.clearTimeout(timeout);
        socket.destroy();
        settle(false);
      };

      const socket = createConnection(socketPath, () => {
        timer.clearTimeout(timeout);
        socket.destroy();
        settle(true);
      });
      socket.on("error", () => {
        timer.clearTimeout(timeout);
        socket.destroy();
        settle(false);
      });
      const timeout = timer.setTimeout(() => {
        socket.destroy();
        settle(false);
      }, options.timeoutMs ?? 1000);
      if (options.signal?.aborted) {
        onAbort();
      } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /**
   * Connect to the daemon.
   *
   * Never performs client-side stale-socket recovery (issue #6140 design
   * change): a failed connect is rethrown as-is, annotated with a diagnostic
   * hint when the PID file names a confirmed-dead process ({@link
   * annotateStaleSocketHint}), but the socket and PID file are never touched.
   * Recovery is the daemon bind guard's job. It only unlinks after the listener
   * is unreachable and its recorded owner is positively known to be dead, so a
   * client can never clobber a concurrent startup winner.
   */
  async connect(timeoutMs: number = this.connectionTimeout, signal?: AbortSignal): Promise<void> {
    if (this.connected) {
      return;
    }

    const deadline = this.timer.now() + timeoutMs;
    try {
      await this.connectOnce(this.remainingConnectTimeout(deadline, timeoutMs), signal);
      return;
    } catch (error) {
      throw this.annotateStaleSocketHint(error);
    }
  }

  /**
   * Adds a diagnostic hint to a failed connect's error when the PID file names a
   * PID that is confirmed dead — otherwise returns the error unchanged. NEVER
   * touches the filesystem (issue #6140): this only reads the PID file to decide
   * whether the hint applies.
   */
  private annotateStaleSocketHint(error: unknown): Error {
    const originalError =
      error instanceof Error ? error : new DaemonUnavailableError(String(error));
    const pidFilePath = this.recoveryOptions.pidFilePath ?? PID_FILE_PATH;
    const pidData = readPidFileDataSync(pidFilePath);
    if (!pidData || typeof pidData.pid !== "number") {
      return originalError;
    }
    const processRunning = this.recoveryOptions.isProcessRunning ?? isProcessRunning;
    if (processRunning(pidData.pid)) {
      return originalError;
    }
    return new DaemonUnavailableError(
      `${originalError.message} — the recorded daemon PID ${pidData.pid} is not running; ` +
        "the socket may be stale and will be reclaimed automatically the next time the daemon " +
        "starts (run `--daemon restart` if this persists)",
    );
  }

  private remainingConnectTimeout(deadline: number, timeoutMs: number): number {
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new DaemonUnavailableError(`Failed to connect to daemon within ${timeoutMs}ms`);
    }
    return remaining;
  }

  /**
   * Whether the daemon socket/pipe is observable at the filesystem layer before
   * attempting a connect. A Unix domain socket has a filesystem entry, so a
   * missing path means nothing is listening; a Windows named pipe has none, so
   * this gate must be skipped there entirely and the connect attempted
   * regardless (issue #6140) — mirroring {@link DaemonManager}'s identical
   * `socketPathObservable()` helper.
   */
  private socketPathObservable(): boolean {
    return this.platform === "win32" || existsSync(this.socketPath);
  }

  private async connectOnce(connectionTimeout: number, signal?: AbortSignal): Promise<void> {
    if (this.connected) {
      return;
    }

    if (signal?.aborted) {
      throw new DaemonUnavailableError("Daemon connection attempt aborted", {
        cause: signal.reason,
      });
    }

    if (!this.socketPathObservable()) {
      throw new DaemonUnavailableError(`Daemon socket not found: ${this.socketPath}`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let removeAbortListener = () => {};

      const rejectPendingRequests = (error: Error, preserveRequestCause: boolean = false) => {
        for (const [, { reject, timeout, removeAbortListener, disconnectCause }] of this
          .pendingRequests) {
          this.timer.clearTimeout(timeout);
          removeAbortListener?.();
          reject(
            preserveRequestCause
              ? new DaemonUnavailableError(error.message, { cause: disconnectCause })
              : error,
          );
        }
        this.pendingRequests.clear();
      };

      const fail = (error: Error) => {
        this.timer.clearTimeout(timeout);
        removeAbortListener();
        this.connected = false;
        if (this.socket) {
          this.socket.destroy();
          this.socket = null;
        }
        // Type the transport failure so the proxy can recover sibling sessions
        // wedged by a daemon restart (#2599/#2737) instead of surfacing a raw
        // ECONNRESET/EPIPE/"socket hang up" that its recovery does not match.
        const failure = toDaemonTransportError(error);
        rejectPendingRequests(failure, true);
        if (!settled) {
          settled = true;
          reject(failure);
        }
      };

      const timeout = this.timer.setTimeout(() => {
        fail(
          new DaemonUnavailableError(`Failed to connect to daemon within ${connectionTimeout}ms`),
        );
      }, connectionTimeout);

      if (signal) {
        const onAbort = () =>
          fail(
            new DaemonUnavailableError("Daemon connection attempt aborted", {
              cause: signal.reason,
            }),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }

      this.socket = createConnection(this.socketPath, () => {
        this.timer.clearTimeout(timeout);
        removeAbortListener();
        this.connected = true;
        logger.info(`Connected to daemon at ${this.socketPath}`);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.socket.on("data", (data) => {
        this.handleData(data);
      });

      this.socket.on("error", (error) => {
        logger.error(`Daemon socket error: ${error.message}`);
        fail(error);
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.socket = null;
        logger.info("Daemon socket connection closed");
        for (const handler of this.connectionClosedHandlers) {
          handler();
        }
        // A daemon restart/crash closes the socket. Over a Unix domain socket
        // (no TCP RST) a dying daemon delivers EOF -> "close" with no "error"
        // event, so any in-flight request would otherwise hang until its request
        // timeout. Reject pending requests with a recoverable transport error so
        // the proxy reconnects to the restarted daemon and retries (#2599/#2737).
        // After fail() the pending map is already cleared, so this is a no-op on
        // the error path.
        if (this.pendingRequests.size > 0) {
          rejectPendingRequests(
            new DaemonUnavailableError("Daemon socket connection lost: connection closed"),
            true,
          );
        }
      });
    });
  }

  /**
   * Handle incoming data from daemon
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete JSON messages (newline-delimited)
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const frame: unknown = JSON.parse(line);
          if (isDaemonNotification(frame)) {
            this.handleNotification(frame);
          } else {
            this.handleResponse(frame as DaemonResponse);
          }
        } catch (error) {
          logger.error(`Error parsing daemon response: ${error}`);
        }
      }
    }
  }

  /**
   * Dispatch a daemon-pushed notification frame (issue #3223) to registered
   * handlers. Best-effort: a throwing handler is logged and never tears down
   * the socket or blocks sibling handlers.
   */
  private handleNotification(notification: DaemonNotification): void {
    if (
      notification.method === PROGRESS_NOTIFICATION_METHOD &&
      notification.progressToken !== undefined
    ) {
      // Extend THIS client's own pending-request timer -- independent of,
      // and in addition to, whatever the daemon does with its own internal
      // deadline. Without this, the daemon can correctly keep working past
      // the original timeout while this client's fixed local timer still
      // fires and rejects the call out from under it (issue #6222 review,
      // P1). Bounded by ProgressExtendableDeadline's own ceiling, so a
      // request that stops progressing is still killed.
      this.extendPendingRequestOnProgress(notification.progressToken);
    }
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch (error) {
        logger.warn(`Daemon notification handler failed for ${notification.method}: ${error}`);
      }
    }
  }

  /**
   * Reset the local timer for whichever pending request registered this
   * `progressToken` (only requests sent with one carry `deadline`/
   * `progressToken` at all -- see `sendRequest`). A token with no matching
   * pending request (the call already settled, or a stray/unexpected frame)
   * is silently ignored, matching how the daemon's own progress relay treats
   * an unmatched token.
   */
  private extendPendingRequestOnProgress(progressToken: string | number): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (
        pending.progressToken !== progressToken ||
        !pending.deadline ||
        pending.requestTimeoutMs === undefined
      ) {
        continue;
      }
      const nowMs = this.timer.now();
      pending.deadline.extendOnProgress(nowMs, pending.requestTimeoutMs);
      const remainingMs = pending.deadline.value - nowMs;
      if (remainingMs <= 0) {
        // Already at (or past) the hard ceiling -- let the existing timer
        // fire on its own schedule rather than rescheduling to a
        // non-positive delay, which would fire immediately anyway.
        return;
      }
      this.timer.clearTimeout(pending.timeout);
      pending.timeout = this.scheduleRequestTimeout(
        requestId,
        pending.toolName,
        remainingMs,
        pending.reject,
      );
      // A progressToken is caller-chosen per in-flight call; at most one
      // pending request can match.
      return;
    }
  }

  /**
   * (Re)arm the timer that rejects a pending request with `McpTimeoutError`
   * after `delayMs`. Used both for the initial schedule in `sendRequest` and
   * to reschedule after `extendPendingRequestOnProgress` pushes the deadline
   * forward.
   */
  private scheduleRequestTimeout(
    requestId: string,
    toolName: string,
    delayMs: number,
    reject: (error: Error) => void,
  ): NodeJS.Timeout {
    return this.timer.setTimeout(() => {
      this.pendingRequests.delete(requestId);
      reject(
        new McpTimeoutError({
          toolName,
          timeoutMs: delayMs,
          origin: "DaemonClient.sendRequest",
        }),
      );
    }, delayMs);
  }

  /**
   * Register a handler for daemon-pushed notifications. Frames only arrive
   * after {@link subscribeToNotifications} opts this connection in.
   * Returns an unsubscribe function.
   */
  onNotification(handler: (notification: DaemonNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for passive socket closure. Unlike request failures,
   * EOF can arrive while no request is in flight, so callers that cache
   * connection state must be notified separately.
   */
  onConnectionClosed(handler: () => void): () => void {
    this.connectionClosedHandlers.add(handler);
    return () => {
      this.connectionClosedHandlers.delete(handler);
    };
  }

  /**
   * Opt this connection in to server-pushed notifications (tools/resources
   * list_changed forwarding, issue #3223). Connects first if needed. Callers
   * own the failure strategy — a daemon that predates the subscription method
   * returns an error response, which surfaces here as a rejection.
   */
  async subscribeToNotifications(): Promise<void> {
    await this.callDaemonMethod(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD, {});
  }

  /**
   * Handle a response from daemon
   */
  private handleResponse(response: DaemonResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn(`Received response for unknown request ID: ${response.id}`);
      return;
    }

    this.timer.clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response);
    } else {
      pending.reject(daemonResponseError(response));
    }
  }

  /** Read the actual socket owner's identity, including older version-only daemons. */
  async getDaemonStatus(): Promise<DaemonStatus> {
    // ide/status is side-effect-free and existed before structured handshake
    // errors. Like doctor, this diagnostic request deliberately omits identity.
    const diagnostic = new DaemonClient(
      this.socketPath,
      this.connectionTimeout,
      this.timer,
      {},
      null,
    );
    try {
      const rawStatus = await diagnostic.callDaemonMethod("ide/status", {});
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
        socketPath: this.socketPath,
        ...(optionsStatus.data.options ? { options: optionsStatus.data.options } : {}),
        ...(optionsStatus.data.effectiveDebug !== undefined
          ? { effectiveDebug: optionsStatus.data.effectiveDebug }
          : {}),
        ...(releaseVersion ? { assetVersion: releaseVersion } : {}),
      };
    } finally {
      await diagnostic.close();
    }
  }

  /**
   * Call a tool on the daemon. `progressToken` echoes the MCP client's own
   * `params._meta.progressToken` (issue #6205) so the daemon can relay
   * `notifications/progress` ticks back tagged with that SAME token — omit it
   * to request no progress relay, never fabricate one downstream.
   */
  async callTool(
    toolName: string,
    params: Record<string, any>,
    progressToken?: string | number,
  ): Promise<any> {
    return this.sendRequest(
      "tools/call",
      {
        name: toolName,
        arguments: params,
      },
      progressToken,
    );
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(uri: string, params: Record<string, any> = {}): Promise<any> {
    return this.sendRequest("resources/read", { uri, ...params });
  }

  private async sendRequest(
    method: string,
    params: Record<string, any>,
    progressToken?: string | number,
  ): Promise<any> {
    // Ensure we're connected
    if (!this.connected) {
      await this.connect();
    }

    const requestId = this.idGenerator.next();

    const request: DaemonRequest = {
      id: requestId,
      type: "mcp_request",
      method,
      params,
      ...(progressToken !== undefined ? { progressToken } : {}),
      ...this.handshakeFields(),
    };

    const requestTimeoutMs = Math.max(resolveMcpRequestTimeoutMs(request), this.connectionTimeout);
    const toolName = method === "tools/call" ? (params?.name ?? method) : method;
    const disconnectCause = new DaemonDisconnectError({
      toolName,
      origin: "DaemonClient.sendRequest",
    });
    // Only a progress-emitting tools/call gets an extendable deadline -- a
    // request with no progressToken (the vast majority: reads, non-progress
    // tools, etc.) keeps its exact original fixed timer, untouched below
    // (issue #6222 review, P1: this must not change behavior for tools that
    // never emit progress).
    const deadline =
      progressToken !== undefined
        ? new ProgressExtendableDeadline(this.timer.now(), requestTimeoutMs)
        : undefined;

    return new Promise((resolve, reject) => {
      const timeout = this.scheduleRequestTimeout(requestId, toolName, requestTimeoutMs, reject);

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          resolve(response.result);
        },
        reject,
        timeout,
        toolName,
        progressToken,
        deadline,
        requestTimeoutMs,
        disconnectCause,
      });

      if (!this.socket) {
        this.timer.clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new DaemonUnavailableError("Socket connection lost"));
        return;
      }

      this.socket.write(this.serializeRequestFrame(request));
    });
  }

  /**
   * Call a daemon method directly over the socket
   */
  async callDaemonMethod(
    method: string,
    params: Record<string, any> = {},
    options: DaemonMethodCallOptions = {},
  ): Promise<any> {
    const timeoutMs = options.timeoutMs ?? this.connectionTimeout;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DaemonUnavailableError(`Daemon request ${method} has no remaining timeout`);
    }
    if (options.signal?.aborted) {
      throw new DaemonUnavailableError(`Daemon request ${method} aborted`, {
        cause: options.signal.reason,
      });
    }
    const deadlineMs = this.timer.now() + timeoutMs;
    if (!this.connected) {
      await this.connect(this.remainingConnectTimeout(deadlineMs, timeoutMs), options.signal);
    }
    // connect() removes its own abort listener before resolving. Recheck before
    // this request installs its listener so an abort in that handoff cannot be
    // missed and followed by a control RPC.
    if (options.signal?.aborted) {
      throw new DaemonUnavailableError(`Daemon request ${method} aborted`, {
        cause: options.signal.reason,
      });
    }
    const remainingTimeoutMs = deadlineMs - this.timer.now();
    if (remainingTimeoutMs <= 0) {
      throw new McpTimeoutError({
        toolName: method,
        timeoutMs,
        origin: "DaemonClient.callDaemonMethod",
      });
    }

    const requestId = this.idGenerator.next();
    const disconnectCause = new DaemonDisconnectError({
      toolName: method,
      origin: "DaemonClient.callDaemonMethod",
    });

    const request: DaemonRequest = {
      id: requestId,
      type: "daemon_request",
      method,
      params,
      timeoutMs: remainingTimeoutMs,
      ...this.handshakeFields(),
    };

    return new Promise((resolve, reject) => {
      let removeAbortListener = () => {};
      const timeout = this.timer.setTimeout(() => {
        removeAbortListener();
        this.pendingRequests.delete(requestId);
        reject(
          new McpTimeoutError({
            toolName: method,
            timeoutMs,
            origin: "DaemonClient.callDaemonMethod",
          }),
        );
      }, remainingTimeoutMs);

      if (options.signal) {
        const onAbort = () => {
          this.timer.clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          removeAbortListener();
          // Destroying this dedicated lifecycle connection tells the daemon to
          // abandon a still-queued local control RPC. Merely rejecting the
          // caller would leave a delayed metadata repair free to publish after
          // doctor has already reported its deadline.
          this.socket?.destroy();
          reject(
            new DaemonUnavailableError(`Daemon request ${method} aborted`, {
              cause: options.signal?.reason,
            }),
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          resolve(response.result);
        },
        reject,
        timeout,
        toolName: method,
        removeAbortListener,
        disconnectCause,
      });

      if (!this.socket) {
        this.timer.clearTimeout(timeout);
        removeAbortListener();
        this.pendingRequests.delete(requestId);
        reject(new DaemonUnavailableError("Socket connection lost"));
        return;
      }

      try {
        this.socket.write(this.serializeRequestFrame(request));
      } catch (error) {
        this.timer.clearTimeout(timeout);
        removeAbortListener();
        this.pendingRequests.delete(requestId);
        reject(toDaemonTransportError(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    this.connected = false;

    // Reject before destroy emits "close", preserving each request's own
    // request context instead of replacing all diagnostics with one generic
    // transport message.
    for (const [, { timeout, reject, removeAbortListener, disconnectCause }] of this
      .pendingRequests) {
      this.timer.clearTimeout(timeout);
      removeAbortListener?.();
      reject(new DaemonUnavailableError("Socket connection closed", { cause: disconnectCause }));
    }
    this.pendingRequests.clear();
    const socket = this.socket;
    if (socket) {
      await new Promise<void>((resolve) => {
        const finish = (timedOut: boolean): void => {
          socket.off("close", onClose);
          this.timer.clearTimeout(timeout);
          if (timedOut) {
            logger.warn(
              "Daemon socket close did not complete before the bounded teardown timeout; proceeding safely",
            );
          }
          resolve();
        };
        const onClose = (): void => finish(false);
        const timeout = this.timer.setTimeout(() => finish(true), 1_000);
        socket.once("close", onClose);
        socket.destroy();
      });
      this.socket = null;
    }
    this.notificationHandlers.clear();
    this.connectionClosedHandlers.clear();
  }
}

export interface DaemonClientLike {
  connect(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  callTool(
    toolName: string,
    params: Record<string, any>,
    progressToken?: string | number,
  ): Promise<any>;
  readResource(uri: string, params?: Record<string, any>): Promise<any>;
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
  subscribeToNotifications?(): Promise<void>;
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
