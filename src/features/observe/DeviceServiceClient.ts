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

import WebSocket from "ws";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { RequestManager } from "../../utils/RequestManager";
import { RetryExecutor, defaultRetryExecutor } from "../../utils/retry/RetryExecutor";
import type { CtrlProxyReconnectStatus } from "../../models/CtrlProxyReconnectStatus";
import type { DelegateContext } from "./shared/types";

/**
 * Factory function type for creating WebSocket instances.
 * Used for testing to inject fake WebSocket implementations.
 */
export type WebSocketFactory = (url: string) => WebSocket;

/**
 * Default WebSocket factory that creates real WebSocket instances.
 */
export const defaultWebSocketFactory: WebSocketFactory = (url: string) => new WebSocket(url);

/**
 * Configuration for connection behavior.
 */
interface ConnectionConfig {
  /** Maximum number of connection attempts before entering cooldown */
  maxConnectionAttempts: number;
  /** Time to wait after max attempts before allowing new attempts (ms) */
  connectionResetMs: number;
  /** Delay before attempting auto-reconnection (ms) */
  reconnectDelayMs: number;
  /** Interval between health checks (ms) */
  healthCheckIntervalMs: number;
  /** WebSocket connection timeout (ms) */
  connectionTimeoutMs: number;
}

/**
 * Default connection configuration.
 */
const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  maxConnectionAttempts: 3,
  connectionResetMs: 10000,
  reconnectDelayMs: 2000,
  healthCheckIntervalMs: 30000,
  connectionTimeoutMs: 5000,
};

/**
 * Abstract base class for device service WebSocket clients.
 *
 * Provides shared connection lifecycle management for both Android and iOS clients.
 */
export abstract class DeviceServiceClient {
  // Connection state
  protected ws: WebSocket | null = null;
  /** Socket owning the current handshake/open lifecycle, used to reject delayed stale events. */
  private lifecycleSocket: WebSocket | null = null;
  protected isConnecting: boolean = false;
  protected connectionAttempts: number = 0;
  protected lastConnectionAttempt: number = 0;
  // The most recent connect-attempt failure message (issue #6260), e.g. a
  // platform-setup error such as "Another AutoMobile process owns CtrlProxy
  // forwarding...". `waitForConnection` only reports a boolean, so a caller
  // that needs the actual cause of a connect failure (RunnerReadinessService,
  // to surface it instead of a generic "runner did not become responsive")
  // reads this instead of re-deriving it. Cleared on a successful connect.
  private lastConnectionFailureMessage: string | undefined;
  // Bumped by close() so a connection that opens after close() is discarded
  // instead of installing its socket and restarting the health check.
  protected connectionGeneration: number = 0;
  // Set while a handshake is mid-flight (socket CONNECTING, this.ws still null)
  // so close()/updatePort() can eagerly abort a socket stuck in CONNECTING that
  // emits NEITHER "open" NOR "error". The generation guard alone only fires when
  // the socket eventually resolves; a wedged handshake would otherwise keep
  // isConnecting true until connectionTimeoutMs, stalling a fresh-port connect
  // by up to ~5s. Cleared to null the moment the handshake terminates. (#5656)
  private pendingConnectAbort: { socket: WebSocket; abort: () => void } | null = null;
  // Platform setup (notably adb port forwarding) is also part of a connection
  // attempt. Keep its controller separately because no WebSocket exists yet.
  private pendingPlatformSetupAbort: AbortController | null = null;

  // Auto-reconnection state
  protected autoReconnectEnabled: boolean = true;
  protected reconnectTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;

  // Health check state
  protected healthCheckIntervalId: ReturnType<Timer["setInterval"]> | null = null;
  protected lastHealthCheckTime: number = 0;

  // Injected dependencies
  protected readonly timer: Timer;
  protected readonly requestManager: RequestManager;
  protected readonly webSocketFactory: WebSocketFactory;
  protected readonly config: ConnectionConfig;
  protected readonly retryExecutor: RetryExecutor;

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
    this.timer = timer;
    this.webSocketFactory = webSocketFactory;
    this.config = { ...DEFAULT_CONNECTION_CONFIG, ...config };
    this.requestManager = new RequestManager(timer);
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
   * Called when WebSocket connection is closed.
   * Platform implementations can perform cleanup.
   */
  protected abstract onConnectionClosed(): void;

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
  public async ensureConnected(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    return this.connectWebSocket(perf);
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

  /**
   * Wait for connection with retry logic.
   *
   * @param maxAttempts Maximum number of connection attempts
   * @param delayMs Delay between attempts in milliseconds
   * @returns true if connected, false if all attempts failed
   */
  public async waitForConnection(
    maxAttempts: number = 10,
    delayMs: number = 300,
  ): Promise<boolean> {
    const result = await this.retryExecutor.execute(
      async (attempt) => {
        const connected = await this.ensureConnected();
        if (connected) {
          logger.info(
            `[${this.logTag}] WebSocket connected after ${attempt} attempt(s) (${(attempt - 1) * delayMs}ms)`,
          );
          return true;
        }

        throw new Error(`Connection attempt ${attempt} failed`);
      },
      {
        maxAttempts,
        delays: delayMs,
        onRetry: (_error, attempt) => {
          logger.debug(
            `[${this.logTag}] Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`,
          );
        },
      },
    );

    if (!result.success) {
      logger.warn(
        `[${this.logTag}] WebSocket not ready after ${maxAttempts} attempts (${maxAttempts * delayMs}ms)`,
      );
      return false;
    }

    return result.value ?? false;
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

      // Platform-specific cleanup — fires exactly once per close().
      this.onConnectionClosed();
    } catch (error) {
      logger.warn(`[${this.logTag}] Error during close: ${error}`);
    }
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

  private clearPendingConnectAbort(socket: WebSocket): void {
    if (this.pendingConnectAbort?.socket === socket) {
      this.pendingConnectAbort = null;
    }
  }

  private clearLifecycleSocket(socket: WebSocket): void {
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
  protected async connectWebSocket(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    // Already connected - reuse existing connection
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.debug(`[${this.logTag}] WebSocket already connected (reusing connection)`);
      return true;
    }

    // Clean up stale WebSocket
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      logger.info(`[${this.logTag}] Cleaning up stale WebSocket (state: ${this.ws.readyState})`);
      const staleSocket = this.ws;
      this.ws = null;
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
        logger.debug(`[${this.logTag}] Error closing stale WebSocket: ${error}`);
      }
    }

    // Connection already in progress - wait for it
    if (this.isConnecting) {
      logger.debug(`[${this.logTag}] Connection already in progress, waiting...`);
      return new Promise((resolve) => {
        const checkInterval = this.timer.setInterval(() => {
          if (!this.isConnecting) {
            this.timer.clearInterval(checkInterval);
            resolve(this.ws?.readyState === WebSocket.OPEN);
          }
        }, 100);
      });
    }

    // Check cooldown after max attempts
    if (this.connectionAttempts >= this.config.maxConnectionAttempts) {
      const timeSinceLastAttempt = this.timer.now() - this.lastConnectionAttempt;
      if (timeSinceLastAttempt >= this.config.connectionResetMs) {
        logger.info(
          `[${this.logTag}] Resetting connection attempts after ${timeSinceLastAttempt}ms cooldown`,
        );
        this.connectionAttempts = 0;
      } else {
        const remaining = this.config.connectionResetMs - timeSinceLastAttempt;
        logger.warn(
          `[${this.logTag}] Max connection attempts (${this.config.maxConnectionAttempts}) reached, cooldown remaining: ${remaining}ms`,
        );
        return false;
      }
    }

    this.isConnecting = true;
    this.connectionAttempts++;
    this.lastConnectionAttempt = this.timer.now();
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

      return await perf.track(
        "wsConnect",
        () =>
          new Promise<boolean>((resolve, reject) => {
            const ws = this.webSocketFactory(wsUrl);
            this.lifecycleSocket = ws;
            const connectionTimeout = this.timer.setTimeout(() => {
              this.clearPendingConnectAbort(ws);
              ws.close();
              reject(new Error("WebSocket connection timeout"));
            }, this.config.connectionTimeoutMs);

            // Track this in-flight handshake so a generation change
            // (close()/updatePort()) can abort it eagerly. A socket stuck in
            // CONNECTING emits neither "open" nor "error", so the generation
            // guard in the handlers below would never run for it. (#5656)
            this.pendingConnectAbort = {
              socket: ws,
              abort: () => {
                this.timer.clearTimeout(connectionTimeout);
                // Detach lifecycle listeners before closing so the aborted
                // socket's delayed close/error cannot mutate state for the
                // replacement connect; keep a lone swallowing error listener so a
                // mid-handshake error cannot throw and crash the daemon.
                try {
                  this.clearLifecycleSocket(ws);
                  ws.removeAllListeners();
                  ws.on("error", (error) => {
                    logger.debug(`[${this.logTag}] Ignoring error on aborted WebSocket: ${error}`);
                  });
                  ws.close();
                } catch (error) {
                  // The socket may already be closing; nothing else to clean up.
                  logger.debug(`[${this.logTag}] Error closing aborted WebSocket: ${error}`);
                }
                this.isConnecting = false;
                resolve(false);
              },
            };

            ws.on("open", () => {
              this.clearPendingConnectAbort(ws);
              this.timer.clearTimeout(connectionTimeout);
              if (generation !== this.connectionGeneration) {
                // close() or updatePort() ran while this connection was mid-handshake.
                // Detach this socket's listeners BEFORE closing it, then discard it.
                // A replacement connect (e.g. to a new port after updatePort) may
                // already be live; without detaching, this socket's still-attached
                // close/error handlers would fire on its delayed close-handshake and
                // null out this.ws, stop the replacement's health check, and schedule
                // a spurious reconnect. Removing the listeners makes that a no-op.
                logger.info(`[${this.logTag}] Discarding WebSocket opened after close`);
                try {
                  this.clearLifecycleSocket(ws);
                  ws.removeAllListeners();
                  // Keep a lone error listener: a discarded socket (e.g. dialing a
                  // dead old port) can still emit "error" during its close
                  // handshake, and an EventEmitter with no "error" listener THROWS,
                  // which would crash the daemon. The socket is being torn down, so
                  // the error is expected and needs no state mutation.
                  ws.on("error", (error) => {
                    logger.debug(
                      `[${this.logTag}] Ignoring error on discarded WebSocket: ${error}`,
                    );
                  });
                  ws.close();
                } catch (error) {
                  // The socket may already be closing; nothing else to clean up.
                  logger.debug(`[${this.logTag}] Error closing post-close WebSocket: ${error}`);
                }
                this.isConnecting = false;
                resolve(false);
                return;
              }
              logger.info(`[${this.logTag}] WebSocket connected successfully`);
              this.ws = ws;
              this.protectRegisteredRequestSends(ws);
              this.isConnecting = false;
              this.connectionAttempts = 0; // Reset on successful connection
              this.lastConnectionFailureMessage = undefined;

              // Start health check monitoring
              this.startHealthCheck();

              // Platform-specific post-connection setup
              this.onConnectionEstablished();

              resolve(true);
            });

            ws.on("message", (data: WebSocket.Data) => {
              void this.handleMessage(data);
            });

            ws.on("error", (error) => {
              this.clearPendingConnectAbort(ws);
              this.timer.clearTimeout(connectionTimeout);
              logger.warn(`[${this.logTag}] WebSocket error: ${error.message}`);
              this.isConnecting = false;
              reject(error);
            });

            ws.on("close", () => {
              if (this.lifecycleSocket !== ws) {
                logger.debug(`[${this.logTag}] Ignoring close from stale WebSocket`);
                return;
              }
              this.clearPendingConnectAbort(ws);
              this.lifecycleSocket = null;
              logger.info(`[${this.logTag}] WebSocket connection closed`);
              this.ws = null;
              this.isConnecting = false;

              // Stop health check
              this.stopHealthCheck();

              // The transport is known dead, so commands cannot receive a
              // response. Settle them immediately rather than retaining their
              // request state and timers until the command timeout expires.
              this.requestManager.cancelAll(new Error("WebSocket connection closed"));

              // Platform-specific cleanup
              this.onConnectionClosed();

              // Attempt automatic reconnection if enabled
              this.scheduleReconnect();
            });
          }),
      );
    } catch (error) {
      this.isConnecting = false;
      this.lastConnectionAttempt = this.timer.now();
      this.lastConnectionFailureMessage = errorMessage(error);
      logger.warn(`[${this.logTag}] Failed to connect to WebSocket: ${error}`);
      return false;
    }
  }

  /**
   * The most recent connect-attempt failure message, or `undefined` when the
   * client has never failed to connect (or has connected successfully since).
   * See {@link lastConnectionFailureMessage}.
   */
  public getLastConnectionFailureMessage(): string | undefined {
    return this.lastConnectionFailureMessage;
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
    } finally {
      this.timer.clearTimeout(setupTimeout);
      if (this.pendingPlatformSetupAbort === setupAbort) {
        this.pendingPlatformSetupAbort = null;
      }
    }
  }

  /**
   * Every CtrlProxy request carries its correlation ID in the JSON payload. A
   * synchronous ws.send failure otherwise bypasses the request awaiter's error
   * path and leaves that registration pending until a later timeout or close.
   */
  private protectRegisteredRequestSends(ws: WebSocket): void {
    const send = ws.send.bind(ws) as (data: WebSocket.Data, ...args: unknown[]) => void;
    ws.send = ((data: WebSocket.Data, ...args: unknown[]) => {
      try {
        return send(data, ...args);
      } catch (error) {
        const requestId = this.requestIdFromWireData(data);
        if (requestId) {
          this.requestManager.reject(
            requestId,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        logger.debug(
          `[${this.logTag}] WebSocket send failed${requestId ? ` for request ${requestId}` : ""}: ${error}`,
        );
        throw error;
      }
    }) as WebSocket["send"];
  }

  private requestIdFromWireData(data: WebSocket.Data): string | undefined {
    try {
      const parsed = JSON.parse(data.toString()) as { requestId?: unknown };
      return typeof parsed.requestId === "string" ? parsed.requestId : undefined;
    } catch (error) {
      logger.debug(
        `[${this.logTag}] Could not read request ID from failed WebSocket send: ${error}`,
      );
      return undefined;
    }
  }

  /**
   * Schedule automatic reconnection after disconnect.
   */
  protected scheduleReconnect(): void {
    if (this.autoReconnectEnabled && !this.reconnectTimeoutId) {
      logger.info(`[${this.logTag}] Scheduling reconnection in ${this.config.reconnectDelayMs}ms`);
      this.reconnectTimeoutId = this.timer.setTimeout(() => {
        this.reconnectTimeoutId = null;
        logger.info(`[${this.logTag}] Attempting automatic reconnection...`);
        void this.connectWebSocket(new NoOpPerformanceTracker()).then((connected) => {
          if (connected) {
            logger.info(`[${this.logTag}] Automatic reconnection successful`);
          } else {
            logger.warn(`[${this.logTag}] Automatic reconnection failed`);
          }
        });
      }, this.config.reconnectDelayMs);
    }
  }

  // ===========================================================================
  // Health check (shared implementation)
  // ===========================================================================

  /**
   * Start periodic health check to ensure WebSocket stays connected.
   */
  protected startHealthCheck(): void {
    // Clear any existing health check
    this.stopHealthCheck();

    logger.debug(
      `[${this.logTag}] Starting health check (interval: ${this.config.healthCheckIntervalMs}ms)`,
    );
    this.lastHealthCheckTime = this.timer.now();

    this.healthCheckIntervalId = this.timer.setInterval(() => {
      const now = this.timer.now();
      const timeSinceLastCheck = now - this.lastHealthCheckTime;
      this.lastHealthCheckTime = now;

      // Check if WebSocket is still connected
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.warn(`[${this.logTag}] Health check failed: WebSocket not connected`);
        this.stopHealthCheck();

        // Attempt reconnection if auto-reconnect is enabled and not already connecting
        if (this.autoReconnectEnabled && !this.isConnecting && !this.reconnectTimeoutId) {
          logger.info(`[${this.logTag}] Health check triggering reconnection...`);
          void this.connectWebSocket(new NoOpPerformanceTracker()).then((connected) => {
            if (connected) {
              logger.info(`[${this.logTag}] Health check reconnection successful`);
            } else {
              logger.warn(`[${this.logTag}] Health check reconnection failed`);
            }
          });
        }
      } else {
        logger.debug(
          `[${this.logTag}] Health check passed (time since last: ${timeSinceLastCheck}ms)`,
        );
      }
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Stop the health check interval.
   */
  protected stopHealthCheck(): void {
    if (this.healthCheckIntervalId !== null) {
      logger.debug(`[${this.logTag}] Stopping health check`);
      this.timer.clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
  }

  // ===========================================================================
  // Utility methods for subclasses
  // ===========================================================================

  /**
   * Get the RequestManager instance for use by subclasses.
   */
  protected getRequestManager(): RequestManager {
    return this.requestManager;
  }

  /**
   * Get the Timer instance for use by subclasses.
   */
  protected getTimer(): Timer {
    return this.timer;
  }

  // ===========================================================================
  // Delegate context + lazy delegate scaffolding (shared implementation)
  // ===========================================================================

  /**
   * Platform-specific additions to the base {@link DelegateContext}.
   *
   * The base builds the fields common to both platforms; a subclass overrides
   * this hook to contribute the fields only it wires (e.g. iOS's command-
   * capability accessors). The default contributes nothing, so a platform whose
   * context is exactly the shared set (Android) needs no override.
   */
  protected extraDelegateContextFields(): Partial<DelegateContext> {
    return {};
  }

  /**
   * Build the base {@link DelegateContext} handed to every delegate.
   *
   * The shared fields are wired here from base state; platform-specific fields
   * come from {@link extraDelegateContextFields}. Subclasses that need an
   * extended context (e.g. a HierarchyDelegateContext) spread the result of this
   * method and add their own fields.
   */
  protected createDelegateContext(): DelegateContext {
    return {
      getWebSocket: () => this.ws,
      requestManager: this.requestManager,
      timer: this.timer,
      ensureConnected: (perf) => this.ensureConnected(perf),
      cancelScreenshotBackoff: () => this.cancelScreenshotBackoff(),
      ...this.extraDelegateContextFields(),
    };
  }

  /**
   * Lazily construct and cache a delegate, replacing the copy-pasted
   * `if (!this._x) { this._x = new X(...); } return this._x;` getter body.
   *
   * The cache slot stays a subclass field (accessed through the get/set pair)
   * so existing direct-field reads keep working and the singleton semantics are
   * unchanged: the factory runs at most once and the same instance is returned
   * on every subsequent access.
   */
  protected lazyDelegate<T>(get: () => T | null, set: (value: T) => void, factory: () => T): T {
    const existing = get();
    if (existing) {
      return existing;
    }
    const created = factory();
    set(created);
    return created;
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
    this.ws.send(message);
    return true;
  }
}
