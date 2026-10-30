import { handleResponse } from "./clientInboundFrames";
import type { PendingDaemonRequest } from "./clientInboundFrames";
import { type DaemonSendPolicy, sendDaemonFrame } from "./clientSend";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { platform } from "node:os";
import type { Duplex } from "node:stream";
import { errorMessage } from "../../utils/describeUnknownError";
import { type IdGenerator, defaultIdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer, defaultTimer, MAX_SETTIMEOUT_DELAY_MS } from "../../utils/SystemTimer";
import { type BuildIdentity, liveDaemonIdentity } from "../wire/buildIdentity";
import { serializeRequestFrame } from "./clientFrameSerialization";
import { handleInboundLine } from "./clientInboundFrames";
import { overflowingResponseId } from "./clientInboundOverflow";
import {
  DAEMON_RESPONSE_GRACE_MS,
  type DaemonToolCallOptions,
  MAX_CANCELLED_REQUEST_IDS,
  taskRelayField,
  toDaemonStatus,
} from "./clientResponseDecoding";
import {
  type DaemonSocketConnectorHost,
  onDaemonSocketClosed,
  openDaemonSocket,
} from "./clientSocketConnector";
import { probeDaemonSocket } from "./clientSocketProbe";
import { annotateStaleSocketHint } from "./clientStaleSocketHint";
import {
  CONNECTION_TIMEOUT_MS,
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  resolveDaemonVersion,
  syncSettledDaemonVersion,
  SOCKET_PATH,
} from "../wire/constants";
import { DaemonDisconnectError } from "../DaemonDisconnectError";
import { DaemonRequestNotDeliveredError } from "../DaemonRequestNotDeliveredError";
import { ProgressExtendableDeadline, clampCallerMcpRequestTimeoutMs } from "../mcpRequestTimeout";
import {
  resolveClientMcpRequestTimeoutMs,
  resolveExplicitToolTimeoutOverrideMs,
} from "./clientMcpRequestTimeout";
import { McpTimeoutError } from "../wire/McpTimeoutError";
import { DaemonFrameTooLargeError } from "../wire/DaemonFrameTooLargeError";
import { DAEMON_CLIENT_MAX_FRAME_BYTES, LineFramer } from "../wire/LineFramer";
import { type TaskRelayFrame, type TaskRelayMethod } from "../tasks/taskRelay";
import type { DaemonStatus } from "../types";
import { DaemonNotification, DaemonRequest, DaemonResponse } from "../types";
export {
  DAEMON_RESPONSE_GRACE_MS,
  type DaemonClientFactory,
  type DaemonClientFactoryOptions,
  type DaemonClientLike,
  daemonOptionsSchema,
  daemonOptionsSchemaCoversAllKeys,
  daemonResponseError,
  type DaemonToolCallOptions,
} from "./clientResponseDecoding";

import { DaemonUnavailableError, toDaemonTransportError } from "../DaemonUnavailableError";

export { DaemonUnavailableError, toDaemonTransportError };

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

/** Everything the {@link DaemonClient} constructor takes after its recovery options. */
export interface DaemonClientOptions {
  /** `null` = no handshake, so doctor reaches a wrong-build daemon ungated; omitted = live identity. */
  clientIdentity?: { version: string; build: BuildIdentity } | null;
  idGenerator?: IdGenerator;
  platformOverride?: NodeJS.Platform;
  maxInboundFrameBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Per-RPC transport budget. Lifecycle callers use this to share one absolute
 * deadline across connect and every control request instead of silently
 * resetting to the client's default for each hop.
 */
export interface DaemonMethodCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Lifecycle RPCs default to closing their connection on cancellation. A request such
   * as notification subscription may cancel only itself and leave sibling release RPCs live.
   */
  abortMode?: "connection" | "request";
  /**
   * Send cancellation on response timeout (default true). Session preparation (#13800)
   * sets false to recover the result by request id while daemon work continues.
   * A caller-supplied `signal` abort still cancels, including after timeout.
   */
  cancelOnTimeout?: boolean;
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
  private socket: Socket | Duplex | null = null;
  private socketPath: string;
  private connectionTimeout: number;
  private timer: Timer;
  private pendingRequests: Map<string, PendingDaemonRequest> = new Map();
  /**
   * Ids of requests this client cancelled (and of the cancel frames it sent),
   * whose late daemon answers are expected and dropped quietly (issue #6384).
   * Insertion-ordered and capped so a daemon that never answers cannot grow it.
   */
  private readonly cancelledRequestIds = new Set<string>();
  private readonly timedOutRequestAbortCleanups = new Map<string, () => void>();
  private framer: LineFramer;
  private inboundClosed = false;
  private readonly closedSockets = new WeakSet<Socket | Duplex>();
  private connected: boolean = false;
  private connectInFlight: Promise<void> | null = null;
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

  private readonly maxInboundFrameBytes: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    socketPath: string = SOCKET_PATH,
    connectionTimeout: number = CONNECTION_TIMEOUT_MS,
    timer: Timer = defaultTimer,
    recoveryOptions: DaemonClientRecoveryOptions = {},
    {
      clientIdentity,
      idGenerator = defaultIdGenerator,
      platformOverride = platform(),
      maxInboundFrameBytes = DAEMON_CLIENT_MAX_FRAME_BYTES,
      env = process.env,
    }: DaemonClientOptions = {},
  ) {
    this.socketPath = socketPath;
    this.connectionTimeout = connectionTimeout;
    this.timer = timer;
    this.recoveryOptions = recoveryOptions;
    this.clientIdentity = clientIdentity === undefined ? liveDaemonIdentity() : clientIdentity;
    this.idGenerator = idGenerator;
    this.platform = platformOverride;
    this.maxInboundFrameBytes = maxInboundFrameBytes;
    this.env = env;
    this.framer = this.createInboundFramer();
  }

  /** @internal Typed view of private state for unit tests; not part of the public API. */
  get testHooks() {
    return {
      /** Attaches an in-memory socket. */
      attachSocket: (socket: Duplex): void => {
        this.socket = socket;
        this.connected = true;
        this.inboundClosed = false;
        this.framer = this.createInboundFramer();
      },
      /** Delivers a daemon frame. */
      simulateIncomingData: (data: Buffer): void => this.handleData(data),
      /** Locates a pending request by its progress token. */
      findPendingRequestIdByProgressToken: (progressToken: string | number): string | undefined =>
        [...this.pendingRequests].find(
          ([, pending]) => pending.progressToken === progressToken,
        )?.[0],
      /** Checks whether a request remains pending. */
      hasPendingRequest: (requestId: string): boolean => this.pendingRequests.has(requestId),
      connection: () => ({ connected: this.connected, socket: this.socket }),
      /** Runs the close listener `connect()` installs on its socket. */
      socketClosed: (socket: Duplex): void => onDaemonSocketClosed(this.connectorHost(), socket),
      declaredIdentity: () => this.clientIdentity,
      socketPathObservable: () => this.socketPathObservable(),
    };
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
    return probeDaemonSocket(socketPath, options);
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

    if (this.connectInFlight) {
      try {
        await raceWithDeadline(this.connectInFlight, {
          timer: this.timer,
          timeoutMs,
          signal,
          label: "Daemon connection attempt",
          timeoutError: () =>
            this.annotateStaleSocketHint(
              new DaemonUnavailableError(`Failed to connect to daemon within ${timeoutMs}ms`),
            ),
        });
        return;
      } catch (error) {
        if (signal?.aborted && error === signal.reason) {
          throw this.annotateStaleSocketHint(
            new DaemonUnavailableError("Daemon connection attempt aborted", {
              cause: signal.reason,
            }),
          );
        }
        // Shared attempt and deadline failures are already typed and annotated.
        throw error;
      }
    }

    // The initiating caller owns cancellation of the transport. Joiners only
    // race the shared result against their own budgets, never cancel the socket.
    const attempt = (async () => {
      const deadline = this.timer.now() + timeoutMs;
      try {
        // Any client that declares an identity must declare the settled one (#14405).
        if (this.clientIdentity !== null && !syncSettledDaemonVersion()) {
          await resolveDaemonVersion();
        }
        await this.connectOnce(this.remainingConnectTimeout(deadline, timeoutMs), signal);
      } catch (error) {
        throw this.annotateStaleSocketHint(error);
      }
    })();
    this.connectInFlight = attempt;
    try {
      await attempt;
    } finally {
      this.connectInFlight = null;
    }
  }

  private annotateStaleSocketHint(error: unknown): Error {
    return annotateStaleSocketHint(error, this.recoveryOptions);
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

    return openDaemonSocket(this.connectorHost(), connectionTimeout, signal);
  }

  private connectorHost(): DaemonSocketConnectorHost {
    return {
      timer: this.timer,
      socketPath: this.socketPath,
      getSocket: () => this.socket,
      setSocket: (socket) => {
        this.socket = socket;
      },
      setConnected: (connected) => {
        this.connected = connected;
      },
      resetInbound: () => {
        this.framer = this.createInboundFramer();
        this.inboundClosed = false;
      },
      handleData: (data) => this.handleData(data),
      handleSocketClosed: (socket) => this.handleSocketClosed(socket),
      hasClosedSocket: (socket) => this.closedSockets.has(socket),
      hasPendingRequests: () => this.pendingRequests.size > 0,
      rejectPendingRequests: (error, preserve) => this.rejectPendingRequests(error, preserve),
    };
  }

  private rejectPendingRequests(error: Error, preserveRequestCause: boolean): void {
    for (const cleanup of this.timedOutRequestAbortCleanups.values()) {
      cleanup();
    }
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
  }

  /** Handle incoming data from daemon */
  private handleData(data: Buffer): void {
    if (!this.inboundClosed) {
      this.framer.push(data);
    }
  }

  private createInboundFramer(): LineFramer {
    return new LineFramer(this.maxInboundFrameBytes, {
      onLine: (line) => this.handleInboundLine(line),
      onOverflow: (head) => this.handleInboundOverflow(head),
    });
  }

  private handleInboundLine(line: string): void {
    return handleInboundLine(
      {
        inboundClosed: this.inboundClosed,
        handleResponse: this.handleResponse.bind(this),
        extendPendingRequestOnProgress: this.extendPendingRequestOnProgress.bind(this),
        adoptPendingRequestBudget: this.adoptPendingRequestBudget.bind(this),
        notificationHandlers: this.notificationHandlers,
        pendingRequests: this.pendingRequests,
        timer: this.timer,
        cancelledRequestIds: this.cancelledRequestIds,
      },
      line,
    );
  }

  /** Handle a response from daemon; retained for subclass instrumentation. */
  protected handleResponse(response: DaemonResponse): void {
    if (response.id !== null) {
      this.timedOutRequestAbortCleanups.get(response.id)?.();
    }
    handleResponse(
      {
        pendingRequests: this.pendingRequests,
        timer: this.timer,
        cancelledRequestIds: this.cancelledRequestIds,
      },
      response,
    );
  }

  private handleInboundOverflow(head?: Buffer): void {
    const error = new DaemonFrameTooLargeError(this.maxInboundFrameBytes);
    logger.warn(error.message);
    const attribution = overflowingResponseId(head, (id) => this.pendingRequests.has(id));
    const owner =
      attribution === undefined && this.pendingRequests.size === 1
        ? this.pendingRequests.keys().next().value
        : attribution;
    const socket = this.socket;
    for (const [requestId, pending] of this.pendingRequests) {
      this.timer.clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      pending.reject(
        requestId === owner
          ? error
          : new DaemonUnavailableError(
              `Daemon socket connection lost: another frame on the connection exceeded ${this.maxInboundFrameBytes} bytes`,
              { cause: error },
            ),
      );
    }
    this.pendingRequests.clear();
    try {
      this.handleSocketClosed(socket);
    } finally {
      socket?.destroy();
    }
  }

  private handleSocketClosed(socket: Socket | Duplex | null): void {
    for (const cleanup of this.timedOutRequestAbortCleanups.values()) {
      cleanup();
    }
    if (socket) {
      this.closedSockets.add(socket);
    }
    this.connected = false;
    this.socket = null;
    this.inboundClosed = true;
    this.framer = this.createInboundFramer();
    logger.info("Daemon socket connection closed");
    for (const handler of this.connectionClosedHandlers) {
      handler();
    }
  }

  /**
   * Reset only the pending request identified by both its id and token. A
   * missing or mismatched request is ignored, including after a token is reused.
   */
  private extendPendingRequestOnProgress(requestId: string, progressToken: string | number): void {
    const pending = this.pendingRequests.get(requestId);
    if (
      pending?.progressToken !== progressToken ||
      !pending.deadline ||
      pending.requestTimeoutMs === undefined
    ) {
      return;
    }
    const nowMs = this.timer.now();
    pending.deadline.extendOnProgress(nowMs, pending.requestTimeoutMs);
    const remainingMs = pending.deadline.value - nowMs;
    if (remainingMs <= 0) {
      // The existing timer already covers a deadline at or past the ceiling.
      return;
    }
    this.timer.clearTimeout(pending.timeout);
    pending.timeout = this.scheduleRequestTimeout(
      requestId,
      pending.toolName,
      remainingMs,
      pending.reject,
    );
  }

  /**
   * Adopt the daemon's effective budget (#13797), measured from this notice's receipt (#14489).
   * The daemon starts its budget when it parses the frame and announces it right then, so that
   * moment lies between our send and now; anchoring at now never cancels before the daemon's
   * deadline even when delivery or parsing outlasted the response grace. Rebuild the progress
   * deadline on the same anchor so later ticks use the daemon's budget and ceiling. A larger budget
   * cannot pull back an existing deadline, which progress only pushed to an earlier tick plus the
   * smaller old budget; a smaller budget may shorten it.
   */
  private adoptPendingRequestBudget(requestId: string, timeoutMs: number): void {
    const pending = this.pendingRequests.get(requestId);
    if (
      !pending ||
      pending.requestTimeoutMs === undefined ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs === pending.requestTimeoutMs
    ) {
      return;
    }
    const nowMs = this.timer.now();
    if (pending.deadline) {
      pending.deadline = new ProgressExtendableDeadline(nowMs, timeoutMs);
    }
    pending.requestTimeoutMs = timeoutMs;
    this.timer.clearTimeout(pending.timeout);
    pending.timeout = this.scheduleRequestTimeout(
      requestId,
      pending.toolName,
      timeoutMs,
      pending.reject,
    );
  }

  /**
   * A derived tool floor can reach the native timer limit. Split that wait
   * instead of overflowing setTimeout to 1ms when response grace is added.
   * Keep the current handle in pendingRequests so reply, abort, progress, and
   * disconnect cleanup always cancel the active segment.
   */
  private scheduleResponseBackstop(
    requestId: string,
    onTimeout: () => void,
    delayMs: number,
  ): NodeJS.Timeout {
    const segmentMs = Math.min(delayMs, MAX_SETTIMEOUT_DELAY_MS);
    return this.timer.setTimeout(() => {
      if (delayMs > segmentMs) {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          pending.timeout = this.scheduleResponseBackstop(
            requestId,
            onTimeout,
            delayMs - segmentMs,
          );
        }
      } else {
        onTimeout();
      }
    }, segmentMs);
  }

  /**
   * (Re)arm the timer that rejects a pending request with `McpTimeoutError`
   * after `delayMs + DAEMON_RESPONSE_GRACE_MS`. Used for the initial schedule
   * in `sendRequest` and to reschedule after `extendPendingRequestOnProgress` pushes the deadline
   * forward.
   */
  private scheduleRequestTimeout(
    requestId: string,
    toolName: string,
    delayMs: number,
    reject: (error: Error) => void,
  ): NodeJS.Timeout {
    return this.scheduleResponseBackstop(
      requestId,
      () => {
        this.pendingRequests.get(requestId)?.removeAbortListener?.();
        this.pendingRequests.delete(requestId);
        this.sendCancelFrame(requestId);
        reject(
          new McpTimeoutError({
            toolName,
            timeoutMs: delayMs,
            origin: "DaemonClient.sendRequest",
            detail: `no response from the daemon within budget + grace (${delayMs}ms + ${DAEMON_RESPONSE_GRACE_MS}ms)`,
          }),
        );
      },
      delayMs + DAEMON_RESPONSE_GRACE_MS,
    );
  }

  /** Best-effort cancellation for abandoned work; late answers are dropped quietly (#6384). */
  private sendCancelFrame(requestId: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return;
    }
    const cancelId = this.idGenerator.next();
    this.rememberCancelledRequestId(requestId);
    this.rememberCancelledRequestId(cancelId);
    const frame: DaemonRequest = {
      id: cancelId,
      type: "daemon_request",
      method: DAEMON_CANCEL_REQUEST_METHOD,
      params: { requestId },
      ...this.handshakeFields(),
    };
    try {
      socket.write(serializeRequestFrame(frame));
    } catch (error) {
      // A failed write means the socket is going away; the daemon aborts a closed socket's requests.
      logger.debug(`Daemon cancel frame for ${requestId} not sent: ${error}`);
    }
  }

  private rememberCancelledRequestId(requestId: string): void {
    this.cancelledRequestIds.add(requestId);
    if (this.cancelledRequestIds.size > MAX_CANCELLED_REQUEST_IDS) {
      const oldest = this.cancelledRequestIds.values().next().value;
      if (oldest !== undefined) {
        this.timedOutRequestAbortCleanups.get(oldest)?.();
        this.cancelledRequestIds.delete(oldest);
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
  async subscribeToNotifications(options?: { signal?: AbortSignal }): Promise<void> {
    await this.callDaemonMethod(
      DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
      {},
      {
        ...options,
        abortMode: "request",
      },
    );
  }

  /** Read the actual socket owner's identity, including older version-only daemons. */
  async getDaemonStatus(timeoutMs?: number): Promise<DaemonStatus> {
    // ide/status is side-effect-free and existed before structured handshake
    // errors. Like doctor, this diagnostic request deliberately omits identity.
    const diagnostic = new DaemonClient(
      this.socketPath,
      this.connectionTimeout,
      this.timer,
      {},
      { clientIdentity: null },
    );
    try {
      const rawStatus = await diagnostic.callDaemonMethod("ide/status", {}, { timeoutMs });
      return toDaemonStatus(rawStatus, this.socketPath);
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
    onRequestId?: (requestId: string) => void,
    options: DaemonToolCallOptions = {},
  ): Promise<any> {
    return this.sendRequest(
      "tools/call",
      {
        name: toolName,
        arguments: params,
      },
      progressToken,
      onRequestId,
      options,
    );
  }

  /**
   * Relay an MCP Tasks extension request (#4668) to the daemon. A JSON-RPC error the daemon's MCP
   * server answered with rejects carrying it unchanged as `jsonRpcError`.
   */
  async relayTaskMethod(
    method: TaskRelayMethod,
    params: Record<string, unknown>,
    tasks: TaskRelayFrame,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<any> {
    return this.sendRequest(method, params, undefined, undefined, { signal, tasks });
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(
    uri: string,
    params: Record<string, any> = {},
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<any> {
    return this.sendRequest("resources/read", { uri, ...params }, undefined, undefined, { signal });
  }

  private async sendRequest(
    method: string,
    params: Record<string, any>,
    progressToken?: string | number,
    onRequestId?: (requestId: string) => void,
    { signal, tasks }: DaemonToolCallOptions = {},
  ): Promise<any> {
    signal?.throwIfAborted();
    // Ensure we're connected
    if (!this.connected) {
      try {
        // The connection may be shared with siblings; abandon only this wait.
        await raceWithDeadline(() => this.connect(), {
          timer: this.timer,
          signal,
          label: `Daemon request ${method} connection`,
        });
      } catch (error) {
        if (error instanceof DaemonUnavailableError) {
          throw new DaemonRequestNotDeliveredError(error.message, { cause: error });
        }
        throw error;
      }
    }
    signal?.throwIfAborted();

    const requestId = this.idGenerator.next();

    const request: DaemonRequest = {
      id: requestId,
      type: "mcp_request",
      method,
      params,
      ...(progressToken !== undefined ? { progressToken } : {}),
      acceptsRequestBudget: true,
      ...taskRelayField(tasks),
      ...this.handshakeFields(),
    };

    const requestTimeoutMs = resolveClientMcpRequestTimeoutMs(
      request,
      this.connectionTimeout,
      this.env,
    );
    // Send the budget without response grace (#6385), preserving compatibility with old daemons.
    // The daemon decides from both explicit overrides and reports any difference (#13797);
    // this client's backstop adopts that budget.
    request.timeoutMs = requestTimeoutMs;
    request.requestedTimeoutMs = clampCallerMcpRequestTimeoutMs(
      resolveExplicitToolTimeoutOverrideMs(request, this.env),
    );
    // Serialize before registering the request: an unserializable argument
    // rejects here with nothing scheduled, instead of throwing inside the
    // Promise executor after the timeout and pending entry already exist.
    const frame = serializeRequestFrame(request);
    const toolName = method === "tools/call" ? (params?.name ?? method) : method;
    const disconnectCause = new DaemonDisconnectError({
      toolName,
      origin: "DaemonClient.sendRequest",
    });
    // Only a progress-emitting tools/call gets an extendable deadline -- a
    // request with no progressToken (the vast majority: reads, non-progress
    // tools, etc.) keeps a fixed budget plus response grace. Daemon budget announcements may
    // replace it, but progress must never extend a call without a token (#6222 review, P1).
    const deadline =
      progressToken !== undefined
        ? new ProgressExtendableDeadline(this.timer.now(), requestTimeoutMs)
        : undefined;

    return this.send(requestId, frame, {
      entry: {
        toolName,
        progressToken,
        deadline,
        requestTimeoutMs,
        disconnectCause,
      },
      signal,
      armTimeout: (reject) =>
        this.scheduleRequestTimeout(requestId, toolName, requestTimeoutMs, reject),
      onRegistered: () => onRequestId?.(requestId),
      socketLostError: () => new DaemonRequestNotDeliveredError("Socket connection lost"),
      writeError: (error) =>
        // A synchronous write failure means the frame never left this process.
        new DaemonRequestNotDeliveredError(`Daemon socket write failed: ${errorMessage(error)}`, {
          cause: error,
        }),
      abortError: () => signal?.reason,
      // The connection may be shared with sibling requests; abandon only this one.
      destroyOnAbort: false,
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

    return this.send(requestId, serializeRequestFrame(request), {
      entry: { toolName: method, disconnectCause },
      signal: options.signal,
      armTimeout: (reject, forgetAbort) =>
        this.scheduleResponseBackstop(
          requestId,
          () => {
            this.pendingRequests.delete(requestId);
            if (options.cancelOnTimeout !== false) {
              forgetAbort();
              this.sendCancelFrame(requestId);
            } else {
              // Caller aborts still cancel during status recovery; bounded by the cancelled-id set.
              if (options.signal) {
                this.timedOutRequestAbortCleanups.set(requestId, forgetAbort);
              }
              // The daemon keeps working (#13800); its late answer is expected, not an unknown id.
              this.rememberCancelledRequestId(requestId);
            }
            reject(
              new McpTimeoutError({
                toolName: method,
                timeoutMs,
                origin: "DaemonClient.callDaemonMethod",
                detail: `no response from the daemon within budget + grace (${remainingTimeoutMs}ms + ${DAEMON_RESPONSE_GRACE_MS}ms)`,
              }),
            );
          },
          remainingTimeoutMs + DAEMON_RESPONSE_GRACE_MS,
        ),
      socketLostError: () => new DaemonUnavailableError("Socket connection lost"),
      writeError: (error) =>
        toDaemonTransportError(error instanceof Error ? error : new Error(String(error))),
      abortError: () =>
        new DaemonUnavailableError(`Daemon request ${method} aborted`, {
          cause: options.signal?.reason,
        }),
      // Cancel first; destroying a lifecycle connection then abandons a queued control RPC.
      destroyOnAbort: options.abortMode !== "request",
    });
  }

  /** Register, deliver and settle one request frame (#11817); see {@link sendDaemonFrame}. */
  private send(requestId: string, frame: string, policy: DaemonSendPolicy): Promise<any> {
    const context = {
      socket: () => this.socket,
      pendingRequests: this.pendingRequests,
      timedOutRequestAbortCleanups: this.timedOutRequestAbortCleanups,
      timer: this.timer,
      sendCancelFrame: (id: string) => this.sendCancelFrame(id),
    };
    return sendDaemonFrame(context, requestId, frame, policy);
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    this.connected = false;

    // Reject before destroy emits "close", preserving each request's own context.
    this.rejectPendingRequests(new DaemonUnavailableError("Socket connection closed"), true);
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
