import { createConnection, Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { logger } from "../utils/logger";
import { encodeNonFinite } from "../utils/nonFiniteJson";
import { ActionableError } from "../models";
import { DaemonRequest, DaemonResponse, DaemonNotification, isDaemonNotification } from "./types";
import {
  SOCKET_PATH,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_NON_FINITE_ENCODED_PARAM,
} from "./constants";
import { type BuildIdentity, getCurrentBuildIdentity } from "./buildIdentity";
import { resolveMcpRequestTimeoutMs } from "./mcpRequestTimeout";
import { McpTimeoutError } from "./McpTimeoutError";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import { type IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import {
  DeviceControlTransportError,
  sanitizeDeviceControlTransportFailure,
} from "./deviceControlTransportFailure";
import {
  cleanupStaleDaemonFilesForDeadPidSync,
  getDaemonSocketPathList,
  type StaleDaemonFileCleanupOptions,
} from "./daemonFiles";

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

export interface DaemonClientRecoveryOptions extends StaleDaemonFileCleanupOptions {
  /**
   * When true, `isAvailable()` performs an observation-only probe and never
   * unlinks socket/PID files, even if the recorded PID is dead. Used by
   * doctor/debug diagnostics so a momentary refusal or timeout from a loaded
   * daemon cannot delete its live socket (issue #2658).
   */
  skipStaleCleanup?: boolean;
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
    }
  > = new Map();
  private buffer: string = "";
  private connected: boolean = false;
  private notificationHandlers: Set<(notification: DaemonNotification) => void> = new Set();
  private connectionClosedHandlers: Set<() => void> = new Set();
  private recoveryOptions: DaemonClientRecoveryOptions;
  private readonly clientIdentity: { version: string; build: BuildIdentity } | null;
  private readonly idGenerator: IdGenerator;

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
  ) {
    this.socketPath = socketPath;
    this.connectionTimeout = connectionTimeout;
    this.timer = timer;
    this.recoveryOptions = recoveryOptions;
    this.clientIdentity = clientIdentity;
    this.idGenerator = idGenerator;
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
   */
  static async isAvailable(
    socketPath: string = SOCKET_PATH,
    recoveryOptions: DaemonClientRecoveryOptions = {},
  ): Promise<boolean> {
    // On Unix, verify the path exists and is a socket (not a stale regular file).
    // On Windows, named pipes don't have filesystem entries — skip the stat check
    // and let createConnection determine reachability.
    const skipCleanup = recoveryOptions.skipStaleCleanup === true;
    if (platform() !== "win32") {
      try {
        const stats = statSync(socketPath);
        if (!stats.isSocket()) {
          if (!skipCleanup) {
            DaemonClient.cleanupStaleSocketIfDaemonDead(socketPath, recoveryOptions);
          }
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
        if (!skipCleanup) {
          DaemonClient.cleanupStaleSocketIfDaemonDead(socketPath, recoveryOptions);
        }
        settle(false);
      });
      const timeout = defaultTimer.setTimeout(() => {
        socket.destroy();
        if (!skipCleanup) {
          DaemonClient.cleanupStaleSocketIfDaemonDead(socketPath, recoveryOptions);
        }
        settle(false);
      }, 1000);
    });
  }

  /**
   * Connect to the daemon
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
      if (
        !signal?.aborted &&
        DaemonClient.cleanupStaleSocketIfDaemonDead(this.socketPath, this.recoveryOptions)
      ) {
        await this.connectOnce(this.remainingConnectTimeout(deadline, timeoutMs), signal);
        return;
      }
      throw error;
    }
  }

  private remainingConnectTimeout(deadline: number, timeoutMs: number): number {
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new DaemonUnavailableError(`Failed to connect to daemon within ${timeoutMs}ms`);
    }
    return remaining;
  }

  private async connectOnce(connectionTimeout: number, signal?: AbortSignal): Promise<void> {
    if (this.connected) {
      return;
    }

    if (signal?.aborted) {
      throw new DaemonUnavailableError("Daemon connection attempt aborted");
    }

    if (!existsSync(this.socketPath)) {
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

  private static cleanupStaleSocketIfDaemonDead(
    socketPath: string,
    recoveryOptions: DaemonClientRecoveryOptions,
  ): boolean {
    const socketPaths =
      recoveryOptions.socketPaths ??
      (socketPath === SOCKET_PATH ? getDaemonSocketPathList() : [socketPath]);

    return cleanupStaleDaemonFilesForDeadPidSync({
      ...recoveryOptions,
      socketPaths,
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
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch (error) {
        logger.warn(`Daemon notification handler failed for ${notification.method}: ${error}`);
      }
    }
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

    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new McpTimeoutError({
            toolName,
            timeoutMs: requestTimeoutMs,
            origin: "DaemonClient.sendRequest",
          }),
        );
      }, requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          resolve(response.result);
        },
        reject,
        timeout,
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
