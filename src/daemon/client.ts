import { createConnection, Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { logger } from "../utils/logger";
import { encodeNonFinite } from "../utils/nonFiniteJson";
import { ActionableError } from "../models";
import {
  DaemonRequest,
  DaemonResponse,
  DaemonNotification,
  isDaemonNotification,
  PROGRESS_NOTIFICATION_METHOD,
} from "./types";
import {
  SOCKET_PATH,
  PID_FILE_PATH,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_NON_FINITE_ENCODED_PARAM,
} from "./constants";
import { type BuildIdentity, getCurrentBuildIdentity } from "./buildIdentity";
import { resolveMcpRequestTimeoutMs, ProgressExtendableDeadline } from "./mcpRequestTimeout";
import { McpTimeoutError } from "./McpTimeoutError";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import { type IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "./deviceControlTransportFailure";
import { readPidFileDataSync, isProcessRunning } from "./daemonFiles";

/**
 * Custom error thrown when daemon is unavailable
 */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
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
  return new DaemonUnavailableError(`Daemon socket connection lost: ${error.message}`);
}

/**
 * Options consulted ONLY to produce a helpful diagnostic hint on a failed
 * `connect()` — never to unlink anything (issue #6140 design change).
 *
 * `DaemonClient` used to perform client-side stale-socket recovery: on a failed
 * connect with the PID file's recorded owner confirmed dead, it would unlink the
 * socket/PID files and retry. That unlink had no lock to coordinate against —
 * `UnixSocketServer.start()` (`socketServer.ts`) already unconditionally unlinks
 * the socket path before `listen()`, and that runs under `DaemonManager`'s
 * `O_EXCL` startup lock (`manager.ts`) — so a client-side unlink outside that
 * lock could only ever race a concurrent startup winner and delete ITS live
 * socket: the exact brick #6140 is about. Recovery already happens, correctly,
 * at daemon bind time under a lock; the client now never touches the
 * filesystem, only reads the PID file to decide whether a hint is warranted.
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
   * connect attempt fails. Stale-socket recovery already happens, correctly, at
   * daemon bind time under `DaemonManager`'s startup lock (`UnixSocketServer.start()`
   * unconditionally unlinks before `listen()`); a client-side unlink here had no
   * lock to coordinate against and could only ever delete a concurrent startup
   * winner's live socket.
   */
  static async isAvailable(socketPath: string = SOCKET_PATH): Promise<boolean> {
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
          resolve(value);
        }
      };

      const socket = createConnection(socketPath, () => {
        defaultTimer.clearTimeout(timeout);
        socket.destroy();
        settle(true);
      });
      socket.on("error", () => {
        defaultTimer.clearTimeout(timeout);
        socket.destroy();
        settle(false);
      });
      const timeout = defaultTimer.setTimeout(() => {
        socket.destroy();
        settle(false);
      }, 1000);
    });
  }

  /**
   * Connect to the daemon.
   *
   * Never performs client-side stale-socket recovery (issue #6140 design
   * change): a failed connect is rethrown as-is, annotated with a diagnostic
   * hint when the PID file names a confirmed-dead process ({@link
   * annotateStaleSocketHint}), but the socket and PID file are never touched.
   * Recovery is the daemon's own job — `UnixSocketServer.start()` unconditionally
   * unlinks a stale socket path before `listen()`, under `DaemonManager`'s
   * `O_EXCL` startup lock — so the next daemon start reclaims a stale socket
   * regardless of anything this client does.
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
      throw new DaemonUnavailableError("Daemon connection attempt aborted");
    }

    if (!this.socketPathObservable()) {
      throw new DaemonUnavailableError(`Daemon socket not found: ${this.socketPath}`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let removeAbortListener = () => {};

      const rejectPendingRequests = (error: Error) => {
        for (const [, { reject, timeout }] of this.pendingRequests) {
          this.timer.clearTimeout(timeout);
          reject(error);
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
        rejectPendingRequests(failure);
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
        const onAbort = () => fail(new DaemonUnavailableError("Daemon connection attempt aborted"));
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
    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response);
    } else {
      const transportFailure = sanitizeDeviceControlTransportFailure(response.transportFailure);
      pending.reject(
        transportFailure
          ? new DeviceControlTransportError(
              response.error || "Device-control transport failure",
              transportFailure,
            )
          : new ActionableError(response.error || "Unknown error from daemon"),
      );
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
  async callDaemonMethod(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.connected) {
      await this.connect();
    }

    const requestId = this.idGenerator.next();

    const request: DaemonRequest = {
      id: requestId,
      type: "daemon_request",
      method,
      params,
      ...this.handshakeFields(),
    };

    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new McpTimeoutError({
            toolName: method,
            timeoutMs: this.connectionTimeout,
            origin: "DaemonClient.callDaemonMethod",
          }),
        );
      }, this.connectionTimeout);

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          resolve(response.result);
        },
        reject,
        timeout,
        toolName: method,
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
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;

    // Reject all pending requests
    const closeError = new DaemonUnavailableError("Socket connection closed");
    for (const [, { timeout, reject }] of this.pendingRequests) {
      this.timer.clearTimeout(timeout);
      reject(closeError);
    }
    this.pendingRequests.clear();
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
  callDaemonMethod(method: string, params: Record<string, any>): Promise<any>;
  /**
   * Optional daemon-push capability (issue #3223). Clients that cannot surface
   * server-pushed frames omit both members and the proxy skips notification
   * wiring entirely — so a client must implement both or neither.
   */
  onNotification?(handler: (notification: DaemonNotification) => void): () => void;
  subscribeToNotifications?(): Promise<void>;
  onConnectionClosed?(handler: () => void): () => void;
}

export type DaemonClientFactory = () => DaemonClientLike;
