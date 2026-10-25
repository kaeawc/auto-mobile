import { ConnectionFailureRecord } from "./ConnectionFailureRecord";
import { ConnectionLivenessMonitor } from "./ConnectionLivenessMonitor";
import { DeviceServiceClientDelegates } from "./DeviceServiceClientDelegates";
import { awaitRecovery, waitForConnection, waitForHandshake } from "./deviceServiceClientWaits";
import {
  ConnectionConfig,
  DEFAULT_CONNECTION_CONFIG,
  WebSocketFactory,
  defaultWebSocketFactory,
} from "./deviceServiceWebSocketFactory";
import { protectRegisteredRequestSends } from "./protectRegisteredRequestSends";
import { WebSocketHandshake } from "./WebSocketHandshake";
export {
  REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV,
  type WebSocketFactory,
  assertUnitTestRealWebSocketAllowed,
  defaultWebSocketFactory,
  rethrowRealCtrlProxyWebSocketInTestError,
} from "./deviceServiceWebSocketFactory";
/**
 * DeviceServiceClient - Abstract base class for device service WebSocket clients
 *
 * This base class provides shared connection lifecycle management used by both
 * CtrlProxyClient (Android) and CtrlProxyClient (iOS).
 *
 * Shared functionality:
 * - WebSocket connection management
 * - Auto-reconnection on disconnect
 * - Periodic health checks
 * - RequestManager integration for request/response correlation
 * - Connection attempt tracking and cooldown
 *
 * Platform-specific behavior is implemented by subclasses through abstract methods.
 */

/**
 * DeviceServiceClient - Abstract base class for device service WebSocket clients
 *
 * This base class provides shared connection lifecycle management used by both
 * CtrlProxyClient (Android) and CtrlProxyClient (iOS).
 *
 * Shared functionality:
 * - WebSocket connection management
 * - Auto-reconnection on disconnect
 * - Periodic health checks
 * - RequestManager integration for request/response correlation
 * - Connection attempt tracking and cooldown
 *
 * Platform-specific behavior is implemented by subclasses through abstract methods.
 */
import type { BootedDevice } from "../../models";
import { NavigationGraphManager } from "../navigation/NavigationGraphManager";
import { type ScreenshotBackoffScheduler } from "./ScreenshotBackoffScheduler";

import WebSocket from "ws";
import { toActionableError } from "../../models/ActionableError";
import type { CtrlProxyReconnectStatus } from "../../models/CtrlProxyReconnectStatus";
import { getAbortSignal } from "../../utils/AbortContext";
import { exponentialBackoff } from "../../utils/Backoff";
import { logger } from "../../utils/logger";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { RequestManager, type TimedOutRequest } from "../../utils/RequestManager";
import { RetryExecutor, defaultRetryExecutor } from "../../utils/retry/RetryExecutor";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { HierarchyNavigationDetector } from "../navigation/HierarchyNavigationDetector";
import {
  createConnectionTestHooks,
  type DeviceServiceClientConnectionTestHooks,
} from "./DeviceServiceClientConnectionTestHooks";
import { RealCtrlProxyWebSocketInTestError } from "./RealCtrlProxyWebSocketInTestError";
import type { CtrlSocket } from "./shared/types";

/**
 * Abstract base class for device service WebSocket clients.
 *
 * Provides shared connection lifecycle management for both Android and iOS clients.
 */
export abstract class DeviceServiceClient extends DeviceServiceClientDelegates {
  // Connection state
  protected ws: CtrlSocket | null = null;

  /** @internal Typed socket and connection-state view for unit tests; production code must not use it. */
  get connectionTestHooks(): DeviceServiceClientConnectionTestHooks {
    return createConnectionTestHooks({
      getSocket: () => this.ws,
      setSocket: (socket) => {
        this.ws = socket;
      },
      requestManager: this.requestManager,
      deliverMessage: (data) => this.handleMessage(data),
      readState: () => ({
        autoReconnectEnabled: this.autoReconnectEnabled,
        supportedCommands: this.supportedCommands,
        isConnecting: this.isConnecting,
        pendingConnectJoiners: this.pendingConnectJoiners,
        inFlightConnectPromise: this.inFlightConnectPromise,
        reconnectTimeoutId: this.reconnectTimeoutId,
        connectionAttempts: this.connectionAttempts,
        lastConnectionAttempt: this.lastConnectionAttempt,
      }),
      writeState: (patch) => {
        this.autoReconnectEnabled = patch.autoReconnectEnabled ?? this.autoReconnectEnabled;
        this.connectionAttempts = patch.connectionAttempts ?? this.connectionAttempts;
        this.lastConnectionAttempt = patch.lastConnectionAttempt ?? this.lastConnectionAttempt;
        if (patch.supportedCommands !== undefined) {
          this.supportedCommands = patch.supportedCommands;
        }
      },
    });
  }
  /** Socket owning the current handshake/open lifecycle, used to reject delayed stale events. */
  protected lifecycleSocket: CtrlSocket | null = null;
  protected isConnecting: boolean = false;
  protected connectionAttempts: number = 0;
  protected lastConnectionAttempt: number = 0;
  private readonly lastConnectionFailure = new ConnectionFailureRecord();
  // Bumped by close() so a connection that opens after close() is discarded
  // instead of installing its socket and restarting the health check.
  protected connectionGeneration: number = 0;
  // Set while a handshake is mid-flight (socket CONNECTING, this.ws still null)
  // so close()/updatePort() can eagerly abort a socket stuck in CONNECTING that
  // emits NEITHER "open" NOR "error". The generation guard alone only fires when
  // the socket eventually resolves; a wedged handshake would otherwise keep
  // isConnecting true until connectionTimeoutMs, stalling a fresh-port connect
  // by up to ~5s. Cleared to null the moment the handshake terminates. (#5656)
  protected pendingConnectAbort: { socket: CtrlSocket; abort: () => void } | null = null;
  // Counts callers currently awaiting connectWebSocket(), so a per-caller
  // cancellation only aborts a shared pending handshake after every caller leaves.
  protected pendingConnectJoiners: number = 0;
  // Platform setup (notably adb port forwarding) is also part of a connection
  // attempt. Keep its controller separately because no WebSocket exists yet.
  private pendingPlatformSetupAbort: AbortController | null = null;

  // Auto-reconnection state
  protected autoReconnectEnabled: boolean = true;
  protected reconnectTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;
  private backgroundReconnectAttempts = 0;
  private backgroundReconnectPaused = false;
  /** Shared dial promise for callers joining the same connection attempt. */
  private inFlightConnectPromise: Promise<boolean> | null = null;
  // Captured synchronously by connectWebSocket(), including subclass overrides.
  private backgroundConnectRequested = false;

  // Health check state
  protected healthCheckIntervalId: ReturnType<Timer["setInterval"]> | null = null;
  protected lastHealthCheckTime: number = 0;

  private readonly liveness: ConnectionLivenessMonitor;

  // Injected dependencies
  protected readonly timer: Timer;
  protected readonly requestManager: RequestManager;
  /** Last fire-and-forget send through {@link sendMessage}. */
  private lastSendAt: number | undefined;
  protected readonly webSocketFactory: WebSocketFactory;
  protected readonly config: ConnectionConfig;
  protected readonly retryExecutor: RetryExecutor;

  // State shared by both platform clients. The platform subclasses own the
  // recovery lifecycle, while the base provides the common observation API.
  protected boundSessionId: string | null = null;
  protected hierarchyNavigationDetector: HierarchyNavigationDetector | null = null;
  protected recoveryPromise: Promise<boolean> | null = null;

  protected device!: BootedDevice;
  // Terminal-close latch; transient socket loss must not set it (#5493).
  protected closed: boolean = false;
  // Failed dials and lost open connections count; platforms reset on successful recovery/connect.
  protected consecutiveConnectionFailures: number = 0;
  protected supportedCommands: Set<string> | null = null;
  protected screenshotBackoffScheduler: ScreenshotBackoffScheduler | null = null;
  protected static readonly HANDSHAKE_WAIT_TIMEOUT_MS = 2000;
  protected static readonly HANDSHAKE_POLL_INTERVAL_MS = 50;

  // Logging tag for subclass identification
  protected abstract readonly logTag: string;

  /**
   * Protected constructor - subclasses should use factory methods or getInstance patterns.
   */
  protected constructor(
    timer: Timer = defaultTimer,
    webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
    config: Partial<ConnectionConfig> = {},
    retryExecutor: RetryExecutor = defaultRetryExecutor,
  ) {
    super();
    this.timer = timer;
    this.webSocketFactory = webSocketFactory;
    this.config = { ...DEFAULT_CONNECTION_CONFIG, ...config };
    const client = this;
    this.liveness = new ConnectionLivenessMonitor({
      timer,
      get healthCheckIntervalMs() {
        return client.config.healthCheckIntervalMs;
      },
      get healthCheckIntervalId() {
        return client.healthCheckIntervalId;
      },
      set healthCheckIntervalId(value) {
        client.healthCheckIntervalId = value;
      },
      get lastHealthCheckTime() {
        return client.lastHealthCheckTime;
      },
      set lastHealthCheckTime(value) {
        client.lastHealthCheckTime = value;
      },
      getLogTag: () => this.logTag,
      getSocket: () => this.ws,
      reconnectAfterFailedHealthCheck: () => {
        if (this.autoReconnectEnabled && !this.isConnecting && !this.reconnectTimeoutId) {
          logger.info(`[${this.logTag}] Health check triggering reconnection...`);
          this.scheduleReconnect();
        }
      },
      silentTimeoutConfirmationMs: (request) => this.silentTimeoutConfirmationMs(request),
      onConfirmedRequestStall: (request) => this.onConfirmedRequestStall(request),
    });
    this.requestManager = new RequestManager(timer, undefined, (request) =>
      this.handleRequestTimeout(request),
    );
    this.retryExecutor = retryExecutor;
  }

  // ===========================================================================
  // Abstract methods for platform-specific behavior
  // ===========================================================================

  /**
   * Get the WebSocket URL for connecting to the device service.
   * Platform implementations handle port forwarding (Android) or direct connection (iOS).
   */
  protected abstract getWebSocketUrl(): string;

  /**
   * Handle an incoming WebSocket message.
   * Platform implementations parse and dispatch message types.
   */
  protected abstract handleMessage(data: WebSocket.Data): void | Promise<void>;

  /**
   * Called when WebSocket connection is successfully established.
   * Platform implementations can perform post-connection setup.
   */
  protected abstract onConnectionEstablished(): void;

  /**
   * Called when a WebSocket that reached open is closed.
   * Platform implementations can perform cleanup.
   */
  protected abstract onConnectionClosed(): void;

  /** Called once for a failed dial or an established connection that was lost. */
  protected onConnectAttemptFailed(): void {
    if (this.closed || !this.autoReconnectEnabled || !this.shouldCountConnectionFailure()) {
      return;
    }
    this.consecutiveConnectionFailures++;
    logger.info(
      `[${this.clientLogTag}] Connection attempt failed (failure count: ${this.consecutiveConnectionFailures})`,
    );
    if (this.consecutiveConnectionFailures > 0 && this.consecutiveConnectionFailures % 3 === 0) {
      this.onConnectionFailureThresholdReached();
    }
  }

  protected shouldCountConnectionFailure(): boolean {
    return true;
  }

  /** Platform recovery retains its own re-entry guard and restart-budget ownership. */
  protected onConnectionFailureThresholdReached(): void {}

  /** Cleanup for an explicitly closed client that never had an open socket. */
  protected onClientClosedWithoutConnection(): void {}

  /**
   * Perform any platform-specific setup before WebSocket connection.
   * For Android, this sets up port forwarding.
   * For iOS, this may resolve the host address.
   */
  protected abstract setupBeforeConnect(
    perf: PerformanceTracker,
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * Cancel any pending screenshot backoff captures.
   * Wired into every delegate context via {@link createDelegateContext}; the
   * concrete backoff scheduler lives on the platform subclass.
   */
  protected abstract cancelScreenshotBackoff(): void;

  // ===========================================================================
  // Connection management (shared implementation)
  // ===========================================================================

  /**
   * Check if the WebSocket is currently connected.
   */
  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Ensure connection to the device service is established.
   * Returns true if connected, false if connection failed.
   */
  public ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    return this.connectWebSocket(perf);
  }

  /**
   * Keep a caller's interest in a pending connection attempt until it settles.
   */
  protected acquirePendingConnectInterest(): { release: () => void } {
    const signal = this.backgroundConnectRequested ? undefined : getAbortSignal();
    signal?.throwIfAborted();
    this.pendingConnectJoiners++;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      signal?.removeEventListener("abort", onAbort);
      this.pendingConnectJoiners = Math.max(0, this.pendingConnectJoiners - 1);
    };
    const onAbort = () => {
      release();
      // A shared dial belongs to every live waiter; only the last cancelled
      // caller may stop its platform commands and pending socket.
      if (this.pendingConnectJoiners === 0) {
        this.abortPendingConnect();
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return { release };
  }

  /**
   * Clear the connection-attempt budget and cooldown clock, and un-pause
   * background reconnection.
   *
   * Call this right after a change to the endpoint's state makes a fresh
   * connect worth trying immediately: a successful platform `setup()` or
   * `enable()`, a `rebindIfUnhealthy()` that actually rebound, an auto-setup
   * that succeeded, a port change, or a forced service restart. Without it,
   * failures recorded before the state change keep gating new dials for up
   * to {@link ConnectionConfig.connectionResetMs} even though the underlying
   * problem is already fixed (issue #7538) — `waitForConnection()` would
   * report failure without ever attempting a dial.
   */
  public resetConnectionBudget(): void {
    this.connectionAttempts = 0;
    this.backgroundReconnectAttempts = 0;
    this.backgroundReconnectPaused = false;
    this.lastConnectionFailure.clear();
  }

  public getReconnectStatus(): CtrlProxyReconnectStatus | null {
    if (this.isConnected() || this.connectionAttempts < this.config.maxConnectionAttempts) {
      return null;
    }

    const retryAfterMs = Math.max(
      0,
      this.config.connectionResetMs - (this.timer.now() - this.lastConnectionAttempt),
    );
    if (retryAfterMs <= 0) {
      return null;
    }

    return {
      state: "cooldown",
      retryAfterMs,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      connectionAttempts: this.connectionAttempts,
      maxConnectionAttempts: this.config.maxConnectionAttempts,
    };
  }
  public async waitForConnection(
    maxAttempts: number = 10,
    delayMs: number = 300,
  ): Promise<boolean> {
    return waitForConnection(
      {
        timer: this.timer,
        retryExecutor: this.retryExecutor,
        logTag: this.logTag,
        ensureConnected: () => this.ensureConnected(),
      },
      maxAttempts,
      delayMs,
    );
  }

  /**
   * Force-close a socket a caller has independently determined to be stale —
   * e.g. `readyState === OPEN` yet the service behind it is not responding to
   * application requests (issue #7554,
   * {@link DeviceReadiness.verifyAndroidDevice}'s connected-but-unresponsive
   * branch). Unlike {@link close}, this does not disable auto-reconnect or run
   * any teardown itself: it calls `ws.terminate()` on the live socket, which
   * fires the socket's own `close` handler and drives the exact same
   * was-open close path (`onConnectionClosed()` → `scheduleReconnect()`) that
   * a real network failure would, so the stale connection is counted as
   * exactly one lost connection rather than a bespoke shutdown. A subsequent
   * `waitForConnection()`/`ensureConnected()` then dials a fresh socket
   * instead of reusing the terminated one.
   *
   * No-op when there is no live socket to terminate.
   */
  public terminateStaleConnection(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.warn(`[${this.logTag}] Terminating stale connection (connected but unresponsive)`);
      const socket = this.ws;
      this.finishEstablishedConnection(socket);
      socket.terminate();
    }
  }

  /**
   * Finish a lost connection exactly once, even when replacement beats its close event.
   * Socket identity is the connection token; late events cannot clean up a replacement.
   */
  private finishEstablishedConnection(socket: CtrlSocket): void {
    if (this.ws !== socket) {
      return;
    }
    this.ws = null;
    this.clearLifecycleSocket(socket);
    this.isConnecting = false;
    this.stopHealthCheck();
    this.requestManager.cancelAll(new Error("WebSocket connection closed"));
    this.onConnectionClosed();
    this.onConnectAttemptFailed();
    this.scheduleReconnect();
  }

  /**
   * Close the WebSocket connection and cleanup resources.
   */
  public async close(): Promise<void> {
    try {
      // Disable auto-reconnect before closing
      this.autoReconnectEnabled = false;
      // Invalidate any in-flight connection whose `open` has not fired yet, so
      // it cannot install its socket / restart the health check after close().
      this.connectionGeneration++;
      // Eagerly abort a handshake stuck in CONNECTING (no open/error yet): the
      // generation bump above is only observed inside the socket's open/error
      // handlers, so without this a wedged socket keeps isConnecting true until
      // connectionTimeoutMs fires. (#5656)
      this.abortPendingConnect();

      // Clear any pending reconnection timeout
      if (this.reconnectTimeoutId !== null) {
        this.timer.clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = null;
      }

      // Stop health check
      this.stopHealthCheck();

      // Cancel all pending requests
      this.requestManager.cancelAll(new Error("WebSocket connection closed"));

      const wasConnected = this.ws !== null;
      const socket = this.ws ?? this.lifecycleSocket;
      this.ws = null;
      this.lifecycleSocket = null;
      if (socket) {
        logger.info(`[${this.logTag}] Closing WebSocket connection`);
        // Detach the lifecycle listeners installed in connectWebSocket() BEFORE
        // closing, so the socket's async `close` event cannot drive a SECOND
        // onConnectionClosed() after the synchronous call below (issue #5657).
        // Mirrors updatePort() and the discarded-socket path in connectWebSocket().
        socket.removeAllListeners();
        // Keep a lone error listener: a socket torn down mid-handshake can still
        // emit "error", and an EventEmitter with no "error" listener THROWS,
        // which would crash the daemon. The socket is going away, so the error
        // is expected and needs no state mutation.
        socket.on("error", (error) => {
          logger.debug(`[${this.logTag}] Ignoring error on closed WebSocket: ${error}`);
        });
        socket.close();
      }

      // Preserve local shutdown cleanup without reporting a lost connection.
      if (wasConnected) {
        this.onConnectionClosed();
      } else {
        this.onClientClosedWithoutConnection();
      }
    } catch (error) {
      logger.warn(`[${this.logTag}] Error during close: ${error}`);
    }
  }

  /**
   * Retire the live socket because its endpoint changed underneath it (e.g. the
   * service restarted on a new port) while the client itself stays usable.
   *
   * Runs the same teardown a lost connection does — pending requests rejected
   * with `error`, health check stopped, `onConnectionClosed()` so per-connection
   * caches/polling do not leak onto the next socket — but, unlike
   * {@link close}, leaves auto-reconnect enabled and, unlike
   * {@link finishEstablishedConnection}, does not count a failed attempt or
   * schedule a reconnect (the caller dials the new endpoint itself). The old
   * socket's listeners are detached first, keeping a lone `error` listener: a
   * closing socket can still emit "error", and an EventEmitter with none
   * throws. No-op when there is no live socket.
   */
  protected retireLiveSocket(error: Error): void {
    const socket = this.ws;
    if (!socket) {
      return;
    }
    this.ws = null;
    this.clearLifecycleSocket(socket);
    this.stopHealthCheck();
    this.requestManager.cancelAll(error);
    socket.removeAllListeners();
    socket.on("error", (socketError) => {
      logger.debug(`[${this.logTag}] Ignoring error on retired WebSocket: ${socketError}`);
    });
    try {
      socket.close();
    } catch (closeError) {
      // The socket may already be closing; it is being discarded either way.
      logger.debug(`[${this.logTag}] Error closing retired WebSocket: ${closeError}`);
    }
    this.onConnectionClosed();
  }

  /**
   * Eagerly abort a handshake that is stuck in CONNECTING.
   *
   * Called by close() and updatePort() right after bumping
   * {@link connectionGeneration}. The generation guard alone is re-checked only
   * inside the socket's `open`/`error` handlers, so a socket that emits neither
   * would keep {@link isConnecting} true until {@link ConnectionConfig.connectionTimeoutMs}.
   * Running the stored abort closes+discards that socket, clears isConnecting,
   * and resolves the pending connect as a failure, so a fresh connect (e.g. to a
   * new port) proceeds immediately instead of stalling. No-op when no handshake
   * is in flight. (#5656)
   */
  protected abortPendingConnect(): void {
    this.pendingPlatformSetupAbort?.abort();
    this.pendingPlatformSetupAbort = null;
    const pending = this.pendingConnectAbort;
    if (pending) {
      this.pendingConnectAbort = null;
      pending.abort();
    }
  }

  private clearPendingConnectAbort(socket: CtrlSocket): void {
    if (this.pendingConnectAbort?.socket === socket) {
      this.pendingConnectAbort = null;
    }
  }

  private clearLifecycleSocket(socket: CtrlSocket): void {
    if (this.lifecycleSocket === socket) {
      this.lifecycleSocket = null;
    }
  }

  // ===========================================================================
  // WebSocket connection (shared implementation)
  // ===========================================================================

  /**
   * Connect to the WebSocket server.
   *
   * @param perf Performance tracker for timing measurements
   * @returns true if connection successful, false otherwise
   */
  protected connectWebSocket(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    interest: { release: () => void } = this.acquirePendingConnectInterest(),
  ): Promise<boolean> {
    if (!this.backgroundConnectRequested && (this.isConnecting || this.inFlightConnectPromise)) {
      // Joining callers reseed background recovery without spending another dial.
      this.backgroundReconnectAttempts = 0;
      this.backgroundReconnectPaused = false;
    }

    let connectPromise = this.inFlightConnectPromise;
    const isJoiner = connectPromise !== null;
    if (!connectPromise) {
      connectPromise = this.connectWebSocketAttempt(perf, this.backgroundConnectRequested);
      this.inFlightConnectPromise = connectPromise;
      void connectPromise.then(
        () => {
          if (this.inFlightConnectPromise === connectPromise) {
            this.inFlightConnectPromise = null;
          }
        },
        () => {
          if (this.inFlightConnectPromise === connectPromise) {
            this.inFlightConnectPromise = null;
          }
        },
      );
    }

    const callerPromise = isJoiner ? this.waitForConnectAttempt(connectPromise) : connectPromise;
    return callerPromise.finally(interest.release);
  }

  /** Bound each caller's wait while allowing callers to share the dial itself. */
  private waitForConnectAttempt(connectPromise: Promise<boolean>): Promise<boolean> {
    const timeout = new Error("Connection attempt timed out");
    return raceWithDeadline(connectPromise, {
      timer: this.timer,
      timeoutMs: this.config.connectionTimeoutMs,
      label: "Device service connection",
      timeoutError: () => timeout,
    }).catch((error: unknown) => {
      if (error === timeout) {
        return false;
      }
      throw toActionableError(error, "Failed while waiting for the device service connection");
    });
  }

  protected connectBackgroundWebSocket(): Promise<boolean> {
    this.backgroundConnectRequested = true;
    try {
      // Keep platform overrides in the connection lifecycle (notably Android's
      // in-flight cleanup) while capturing background accounting in the base.
      return this.connectWebSocket(new NoOpPerformanceTracker());
    } finally {
      this.backgroundConnectRequested = false;
    }
  }

  private async connectWebSocketAttempt(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    background = false,
  ): Promise<boolean> {
    // Already connected - reuse existing connection
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.debug(`[${this.logTag}] WebSocket already connected (reusing connection)`);
      return true;
    }

    // Clean up stale WebSocket
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      logger.info(`[${this.logTag}] Cleaning up stale WebSocket (state: ${this.ws.readyState})`);
      this.cleanUpStaleSocket(this.ws);
    }

    if (this.isConnectCooldownActive(background)) {
      return false;
    }

    this.isConnecting = true;
    this.recordConnectAttempt(background);
    // Snapshot the lifecycle generation before the first await so a close() that
    // overlaps the awaited platform setup (e.g. adb port-forward) is observed.
    const generation = this.connectionGeneration;

    try {
      await this.runPlatformSetup(perf);

      if (generation !== this.connectionGeneration) {
        // close() ran during platform setup; do not open a socket to a
        // shutting-down device transport.
        logger.info(`[${this.logTag}] Aborting connect: closed during platform setup`);
        this.isConnecting = false;
        return false;
      }

      const wsUrl = this.getWebSocketUrl();
      logger.info(
        `[${this.logTag}] Connecting to WebSocket at ${wsUrl} (attempt ${this.connectionAttempts}/${this.config.maxConnectionAttempts})`,
      );

      return await perf.track("wsConnect", () =>
        this.createWebSocketHandshake().open(wsUrl, generation),
      );
    } catch (error) {
      return this.failConnectAttempt(error, background);
    }
  }

  private cleanUpStaleSocket(staleSocket: CtrlSocket): void {
    this.finishEstablishedConnection(staleSocket);
    this.clearLifecycleSocket(staleSocket);
    try {
      // This socket may emit close/error after a replacement is installed.
      // Detach its stateful lifecycle handlers before closing so those late
      // events cannot tear down the replacement connection.
      staleSocket.removeAllListeners();
      staleSocket.on("error", (error) => {
        logger.debug(`[${this.logTag}] Ignoring error on stale WebSocket: ${error}`);
      });
      staleSocket.close();
    } catch (error) {
      // The stale socket may already be closing; nothing else to clean up.
      logger.debug(`[${this.logTag}] Error closing stale WebSocket: ${error}`);
    }
  }

  private recordConnectAttempt(background: boolean): void {
    if (!background) {
      this.backgroundReconnectAttempts = 0;
      this.backgroundReconnectPaused = false;
      this.connectionAttempts++;
      this.lastConnectionAttempt = this.timer.now();
    }
  }

  private failConnectAttempt(error: unknown, background: boolean): false {
    this.isConnecting = false;
    if (error instanceof RealCtrlProxyWebSocketInTestError) {
      // A test-harness misconfiguration, not a connect failure: never let it
      // count toward cooldown or the platform clients' service recovery.
      // Refund the attempt too, or the third leak would enter cooldown and
      // return false silently instead of failing the test.
      if (!background) {
        this.connectionAttempts = Math.max(0, this.connectionAttempts - 1);
      }
      throw error;
    }
    this.recordFailedConnect(error, background);
    return false;
  }

  private recordFailedConnect(error: unknown, background: boolean): void {
    if (!background) {
      this.lastConnectionAttempt = this.timer.now();
    }
    this.lastConnectionFailure.record(error);
    logger.warn(`[${this.logTag}] Failed to connect to WebSocket: ${error}`);
    this.onConnectAttemptFailed();
  }

  private isConnectCooldownActive(background: boolean): boolean {
    if (this.connectionAttempts < this.config.maxConnectionAttempts) {
      return false;
    }
    const timeSinceLastAttempt = this.timer.now() - this.lastConnectionAttempt;
    if (timeSinceLastAttempt >= this.config.connectionResetMs) {
      if (!background) {
        logger.info(
          `[${this.logTag}] Resetting connection attempts after ${timeSinceLastAttempt}ms cooldown`,
        );
        this.connectionAttempts = 0;
      }
      return false;
    }
    const remaining = this.config.connectionResetMs - timeSinceLastAttempt;
    if (background) {
      // A healthy service recovery must not lose its retry while the caller cools down.
      this.scheduleReconnect(remaining);
    }
    logger.warn(
      `[${this.logTag}] Max connection attempts (${this.config.maxConnectionAttempts}) reached, cooldown remaining: ${remaining}ms`,
    );
    return true;
  }

  /**
   * The most recent connect-attempt failure message, or `undefined` when the
   * client has never failed to connect (or has connected successfully since).
   * See {@link ConnectionFailureRecord.message}.
   */
  public getLastConnectionFailureMessage(): string | undefined {
    return this.lastConnectionFailure.message;
  }

  /**
   * Whether {@link getLastConnectionFailureMessage} describes the CtrlProxy
   * forwarding-lease conflict specifically (issue #6260 PRRT ft82e), as
   * opposed to an ordinary connect failure. See
   * {@link ConnectionFailureRecord.isForwardingLeaseConflict}.
   */
  public isLastConnectionFailureForwardingLeaseConflict(): boolean {
    return this.lastConnectionFailure.isForwardingLeaseConflict;
  }

  /**
   * Whether that lease conflict is a time-based refusal (recent owner use, or
   * an owner too busy to answer) that a readiness wait should retry (#10485).
   */
  public isLastConnectionFailureTransientLeaseConflict(): boolean {
    return this.lastConnectionFailure.isTransientLeaseConflict;
  }

  private async runPlatformSetup(perf: PerformanceTracker): Promise<void> {
    // Platform-specific setup (e.g., port forwarding) must be cancellable: a
    // close while adb is hung otherwise leaves the client in-flight forever.
    const setupAbort = new AbortController();
    this.pendingPlatformSetupAbort = setupAbort;
    const setupTimeout = this.timer.setTimeout(
      () => setupAbort.abort(),
      this.config.connectionTimeoutMs,
    );
    try {
      await perf.track("platformSetup", () => this.setupBeforeConnect(perf, setupAbort.signal));
      // An abort-ignoring platform command must not open a socket after its
      // last acquisition caller has already left.
      setupAbort.signal.throwIfAborted();
    } finally {
      this.timer.clearTimeout(setupTimeout);
      if (this.pendingPlatformSetupAbort === setupAbort) {
        this.pendingPlatformSetupAbort = null;
      }
    }
  }

  /**
   * Schedule automatic reconnection after disconnect.
   */
  protected scheduleReconnect(cooldownDelayMs?: number): void {
    if (this.autoReconnectEnabled && !this.backgroundReconnectPaused && !this.reconnectTimeoutId) {
      const delayMs =
        cooldownDelayMs ??
        exponentialBackoff({
          initialDelayMs: this.config.reconnectDelayMs,
          multiplier: 2,
          maxDelayMs: this.config.connectionResetMs,
        }).delayForAttempt(this.backgroundReconnectAttempts + 1);
      logger.info(`[${this.logTag}] Scheduling reconnection in ${delayMs}ms`);
      this.reconnectTimeoutId = this.timer.setTimeout(() => {
        this.reconnectTimeoutId = null;
        if (!this.autoReconnectEnabled || this.isConnected()) {
          return;
        }
        if (this.getReconnectStatus() !== null) {
          this.scheduleReconnect();
          return;
        }
        logger.info(`[${this.logTag}] Attempting automatic reconnection...`);
        void this.connectBackgroundWebSocket().then((connected) => {
          if (connected) {
            logger.info(`[${this.logTag}] Automatic reconnection successful`);
          } else {
            logger.warn(`[${this.logTag}] Automatic reconnection failed`);
            this.backgroundReconnectAttempts++;
            if (this.backgroundReconnectAttempts >= this.config.maxConnectionAttempts) {
              this.backgroundReconnectAttempts = 0;
              this.backgroundReconnectPaused = true;
              logger.info(
                `[${this.logTag}] Automatic background reconnection paused until the next foreground connect attempt`,
              );
            } else {
              this.scheduleReconnect();
            }
          }
        });
      }, delayMs);
    }
  }
  protected startHealthCheck(): void {
    return this.liveness.startHealthCheck();
  }
  protected stopHealthCheck(): void {
    return this.liveness.stopHealthCheck();
  }
  private markLivenessSeen(): void {
    return this.liveness.markLivenessSeen();
  }
  private handleRequestTimeout(request: TimedOutRequest): void {
    return this.liveness.handleRequestTimeout(request);
  }

  /**
   * How long to wait for proof of life after `request` timed out with no
   * inbound frame since it was registered, or `undefined` when such a timeout
   * is not stall evidence for this client. Disabled by default.
   */
  protected silentTimeoutConfirmationMs(_request: TimedOutRequest): number | undefined {
    return undefined;
  }

  /** A silent request timeout whose confirmation ping also went unanswered. */
  protected onConfirmedRequestStall(_request: TimedOutRequest): void {}

  /**
   * Release this client's binding to a session that has ended. If still bound
   * to that session, dispose its cached hierarchy detector before clearing it.
   */
  public releaseSessionBinding(sessionId: string): void {
    if (this.boundSessionId === sessionId) {
      this.boundSessionId = null;
      if (this.hierarchyNavigationDetector) {
        this.hierarchyNavigationDetector.dispose();
        this.hierarchyNavigationDetector = null;
      }
    }
  }
  public async awaitRecovery(
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<"recovered" | "not_recovering" | "failed" | "timed_out"> {
    return awaitRecovery(
      { timer: this.timer, recoveryPromise: this.recoveryPromise },
      budgetMs,
      signal,
    );
  }

  /**
   * Send a message via WebSocket.
   * Returns true if sent, false if not connected.
   */
  sendMessage(message: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[${this.logTag}] Cannot send message: WebSocket not connected`);
      return false;
    }
    this.lastSendAt = this.timer.now();
    this.ws.send(message);
    return true;
  }

  /**
   * Requests in flight through this client and when it was last used, so a
   * daemon can tell a device it is actively driving from an idle one before
   * giving up or yielding its CtrlProxy forwarding lease (#10497). Covers every
   * request-response exchange (tool calls, resource reads, initial frames)
   * because they all register with the shared request manager.
   */
  getRequestActivity(): { inFlightRequests: number; lastActivityAt: number | undefined } {
    const requestActivityAt = this.requestManager.getLastActivityAt();
    const lastActivityAt =
      requestActivityAt === undefined || this.lastSendAt === undefined
        ? (requestActivityAt ?? this.lastSendAt)
        : Math.max(requestActivityAt, this.lastSendAt);
    return { inFlightRequests: this.requestManager.getPendingCount(), lastActivityAt };
  }

  /** Android's connection log tag predates its base connection-lifecycle tag. */
  protected get clientLogTag(): string {
    return this.logTag;
  }

  protected onSessionRebound(): void {}

  /** Bind navigation events to the current session; only a changed owner invokes the platform hook. */
  public bindSession(sessionId: string): void {
    // Binding means this session is live again — clear any released-tombstone so a
    // reused uuid (e.g. setActiveDevice re-creating the session on another device)
    // gets its own manager rather than the unattributed global (#4984).
    NavigationGraphManager.clearReleasedSession(sessionId);
    if (this.boundSessionId !== sessionId) {
      // A per-device client routes nav events to whichever session bound last.
      // That is correct under the pool's one-device-one-live-session invariant
      // (a device is released before it is reassigned). Trace the transition off
      // a previously-bound session so a concurrent-share regression — two live
      // sessions driving one device — is diagnosable in the logs. Debug, not
      // warn: the common case (a released device rebinding to its next session)
      // is expected and must not be noisy.
      if (this.boundSessionId !== null) {
        logger.debug(
          `[${this.clientLogTag}] Rebinding device ${this.device.deviceId} from session ` +
            `${this.boundSessionId} to ${sessionId}`,
        );
      }
      this.boundSessionId = sessionId;
      this.onSessionRebound();
      // Invalidate cached hierarchy detector so it picks up the new session's NavigationGraphManager
      if (this.hierarchyNavigationDetector) {
        this.hierarchyNavigationDetector.dispose();
        this.hierarchyNavigationDetector = null;
      }
    }
  }

  public async getSupportedCommands(): Promise<string[] | null> {
    if (this.supportedCommands === null) {
      const connected = await this.ensureConnected();
      // ensureConnected resolves on the WebSocket `open` event, but the runner's
      // `supportedCommands` arrive a beat later in the `connected` handshake
      // message. Without waiting for it, the first probe (e.g. doctor) of a
      // healthy runner reads null and misreports it as `unknown`. Poll briefly
      // for the handshake before reading.
      if (connected) {
        await this.waitForHandshake();
      }
    }
    return this.getCachedSupportedCommands();
  }

  /** Connection-free view of the last advertised command set. */
  public getCachedSupportedCommands(): string[] | null {
    return this.supportedCommands === null ? null : Array.from(this.supportedCommands).sort();
  }

  /** iOS also checks cancellation when the handshake already arrived; Android does not. */
  protected beforeHandshakeWait(_signal?: AbortSignal): void {}

  protected awaitHandshakePoll(work: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return raceWithDeadline(work, { timer: this.timer, signal, label: "Device service handshake" });
  }
  protected async waitForHandshake(
    timeoutMs: number = DeviceServiceClient.HANDSHAKE_WAIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this;
    return waitForHandshake(
      {
        timer: this.timer,
        get supportedCommands() {
          return client.supportedCommands;
        },
        pollIntervalMs: DeviceServiceClient.HANDSHAKE_POLL_INTERVAL_MS,
        beforeHandshakeWait: (signal) => this.beforeHandshakeWait(signal),
        awaitHandshakePoll: (work, signal) => this.awaitHandshakePoll(work, signal),
      },
      timeoutMs,
      signal,
    );
  }

  private createWebSocketHandshake(): WebSocketHandshake {
    return new WebSocketHandshake({
      timer: this.timer,
      connectionTimeoutMs: this.config.connectionTimeoutMs,
      logTag: this.logTag,
      createSocket: (url) => this.webSocketFactory(url),
      getLifecycleSocket: () => this.lifecycleSocket,
      setLifecycleSocket: (socket) => {
        this.lifecycleSocket = socket;
      },
      clearLifecycleSocket: (socket) => this.clearLifecycleSocket(socket),
      getSocket: () => this.ws,
      getConnectionGeneration: () => this.connectionGeneration,
      setPendingConnectAbort: (pending) => {
        this.pendingConnectAbort = pending;
      },
      clearPendingConnectAbort: (socket) => this.clearPendingConnectAbort(socket),
      setConnecting: (connecting) => {
        this.isConnecting = connecting;
      },
      onConnectAttemptFailed: () => this.onConnectAttemptFailed(),
      onSocketOpened: (socket) => this.installOpenedSocket(socket),
      markLivenessSeen: () => this.markLivenessSeen(),
      handleMessage: (data) => this.handleMessage(data),
      finishEstablishedConnection: (socket) => this.finishEstablishedConnection(socket),
    });
  }
  private installOpenedSocket(ws: CtrlSocket): void {
    this.ws = ws;
    protectRegisteredRequestSends(ws, this.requestManager, this.logTag);
    this.isConnecting = false;
    this.connectionAttempts = 0; // Reset on successful connection
    this.backgroundReconnectAttempts = 0;
    this.backgroundReconnectPaused = false;
    this.lastConnectionFailure.clear();
    this.markLivenessSeen();

    // Start health check monitoring
    this.startHealthCheck();

    // Platform-specific post-connection setup
    this.onConnectionEstablished();
  }
}
