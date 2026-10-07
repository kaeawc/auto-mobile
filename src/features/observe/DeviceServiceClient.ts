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
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { exponentialBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getAbortSignal } from "../../utils/AbortContext";
import { RequestManager } from "../../utils/RequestManager";
import { RetryExecutor, defaultRetryExecutor } from "../../utils/retry/RetryExecutor";
import type { CtrlProxyReconnectStatus } from "../../models/CtrlProxyReconnectStatus";
import { CtrlProxyForwardingLeaseConflictError } from "./shared/CtrlProxyForwardingLeaseConflictError";
import type { DelegateContext } from "./shared/types";
import type { HierarchyNavigationDetector } from "../navigation/HierarchyNavigationDetector";

/**
 * Factory function type for creating WebSocket instances.
 * Used for testing to inject fake WebSocket implementations.
 */
export type WebSocketFactory = (url: string) => WebSocket;

/**
 * Env flag a unit test sets (`1`/`true`/`yes`) to opt into a real WebSocket from
 * {@link defaultWebSocketFactory} under `bun test`. Prefer injecting a
 * `WebSocketFactory` instead; this exists for suites that must exercise the
 * default factory against a local fake server.
 */
export const REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV = "AUTOMOBILE_ALLOW_REAL_CTRL_PROXY_WEBSOCKET";

function isRealCtrlProxyWebSocketOptInEnabled(env: NodeJS.ProcessEnv): boolean {
  const normalized = env[REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV]?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Thrown by {@link assertUnitTestRealWebSocketAllowed}. It is a test-harness
 * misconfiguration, not a connect failure: every catch on the connect path
 * rethrows it before recording a failed attempt, so a leaking unit test fails
 * loudly and never counts toward the platform clients' service recovery or
 * restart (which would act on an attached device).
 */
export class RealCtrlProxyWebSocketInTestError extends ActionableError {
  constructor(message: string) {
    super(message);
    this.name = "RealCtrlProxyWebSocketInTestError";
  }
}

/** Rethrow {@link RealCtrlProxyWebSocketInTestError} from a connect-path catch that would otherwise degrade it. */
export function rethrowRealCtrlProxyWebSocketInTestError(error: unknown): void {
  if (error instanceof RealCtrlProxyWebSocketInTestError) {
    throw error;
  }
}

const TEST_FILE_ENTRYPOINT = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The running script: the current test file under `bun test`, `dist/src/index.js` (or the compiled binary) otherwise. */
function currentEntrypoint(): string | undefined {
  // src/ is type-checked without Bun's globals; read `Bun.main` structurally.
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  return bun?.main ?? process.argv[1];
}

/**
 * Whether this process is the `bun test` runner itself. `NODE_ENV=test` alone is
 * not enough: it is inherited by every CLI/daemon child a real-device
 * integration test spawns (`execFile`, `daemonProcessEnvironment`), and those
 * children must dial the device. Under `bun test`, `Bun.main` is the test file
 * being run; in a spawned child it is the child's own entrypoint, which no
 * environment inheritance can turn into a test file.
 */
function isBunTestRunnerProcess(env: NodeJS.ProcessEnv, entrypoint: string | undefined): boolean {
  return (
    env.NODE_ENV === "test" && entrypoint !== undefined && TEST_FILE_ENTRYPOINT.test(entrypoint)
  );
}

/**
 * Fail loudly when a unit test reaches the DEFAULT WebSocket factory, i.e. a real
 * CtrlProxy socket. On a developer machine with an emulator or simulator running,
 * adb/port forwards make `ws://127.0.0.1:<port>/ws` a live device, so an
 * unstubbed client method sent real taps from a unit test (#10470). Like the
 * real-DB guard (#3067) it needs Bun's test context signal (`NODE_ENV=test`),
 * but it also requires this process to be the `bun test` runner itself (see
 * {@link isBunTestRunnerProcess}), so CLI/daemon children of an on-device
 * integration test are never armed. It fires only on the default path.
 * Injecting a `WebSocketFactory` (or setting
 * {@link REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV}) opts out.
 */
export function assertUnitTestRealWebSocketAllowed(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  entrypoint: string | undefined = currentEntrypoint(),
): void {
  if (!isBunTestRunnerProcess(env, entrypoint) || isRealCtrlProxyWebSocketOptInEnabled(env)) {
    return;
  }
  throw new RealCtrlProxyWebSocketInTestError(
    `Unit test tried to open a real CtrlProxy WebSocket to ${url}. With an ` +
      "emulator or simulator running this reaches a live device (issue #10470). " +
      "Stub the client method the code under test calls (e.g. " +
      "AndroidCtrlProxyClient.prototype.requestTapCoordinates or the matching " +
      "IOSCtrlProxyClient method), inject a fake WebSocketFactory, or, for a " +
      `suite that runs its own local fake server, set ${REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV}=1.`,
  );
}

/**
 * Default WebSocket factory that creates real WebSocket instances. Guarded under
 * `bun test`; see {@link assertUnitTestRealWebSocketAllowed}.
 */
export const defaultWebSocketFactory: WebSocketFactory = (url: string) => {
  assertUnitTestRealWebSocketAllowed(url);
  return new WebSocket(url);
};

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

// Liveness probe tuning (issue #7554). `readyState === OPEN` alone cannot
// distinguish a healthy peer from a half-open connection whose TCP stream
// stalled without a close reaching the host (a wedged device-side handler, an
// adb hop that never tears down, a suspended emulator). Both runners already
// answer protocol-level pings, so the host probes with `ws.ping()` and treats
// silence past a bounded deadline as a dead connection.
//
// The deadline is a multiple of the health-check interval rather than a fixed
// constant so a client configured with a shorter/longer interval (as tests
// do) gets a proportionally scaled deadline without new config plumbing.
const LIVENESS_TIMEOUT_INTERVAL_MULTIPLIER = 2;
// After this many consecutive RequestManager timeouts with no inbound frame
// in between, the socket is "suspect": something is still accepting the TCP
// connection but not answering application requests. Run the same
// ping-then-terminate probe immediately instead of waiting for the next
// periodic health-check tick.
const REQUEST_TIMEOUT_LIVENESS_THRESHOLD = 3;

export class ObserverPendingRequestTimeoutError extends Error {
  constructor() {
    super("Owner's in-flight request exceeded the observer hierarchy deadline");
  }
}

/**
 * Abstract base class for device service WebSocket clients.
 *
 * Provides shared connection lifecycle management for both Android and iOS clients.
 */
export abstract class DeviceServiceClient {
  /** Queue an observer read behind the owner's already-dispatched requests. */
  protected async waitForPendingRequests(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = this.timer.now() + timeoutMs;
    while (this.requestManager.getPendingCount() > 0) {
      signal?.throwIfAborted();
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        throw new ObserverPendingRequestTimeoutError();
      }
      await this.timer.sleep(Math.min(10, remaining));
    }
    signal?.throwIfAborted();
  }
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
  // Whether lastConnectionFailureMessage is specifically the CtrlProxy
  // forwarding-lease conflict (issue #6260 PRRT ft82e), rather than an
  // ordinary connect failure (ECONNREFUSED, a timeout, ...). Detected via
  // `instanceof` on the caught error so RunnerReadinessService can scope its
  // orphan-naming diagnostic to this exact condition instead of any stored
  // error.
  private lastConnectionFailureIsForwardingLeaseConflict: boolean = false;
  private lastConnectionFailureIsTransientLeaseConflict: boolean = false;
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
  // Liveness state (issue #7554). Refreshed by any proof of life on the
  // current socket: a pong reply, a server-initiated ping, or any inbound
  // frame (a frame proves the peer is alive even if no ping is outstanding).
  // lastLivenessAt remains for logging/inspection; startLivenessProbe()
  // compares livenessSeq rather than the timestamp, since a monotonic
  // counter can't miss a frame that lands in the same millisecond as the
  // probe's deadline tick (timer resolution is coarser than that).
  private lastLivenessAt: number = 0;
  private livenessSeq: number = 0;
  private livenessDeadlineTimeoutId: ReturnType<Timer["setTimeout"]> | null = null;
  // Consecutive RequestManager timeouts observed since the last proof of
  // life. Reset by markLivenessSeen(); read by handleRequestTimeout().
  private consecutiveRequestTimeouts: number = 0;

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
    this.requestManager = new RequestManager(timer, undefined, () => this.handleRequestTimeout());
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
  protected onConnectAttemptFailed(): void {}

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
    this.lastConnectionFailureMessage = undefined;
    this.lastConnectionFailureIsForwardingLeaseConflict = false;
    this.lastConnectionFailureIsTransientLeaseConflict = false;
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
    const signal = getAbortSignal();
    signal?.throwIfAborted();
    const result = await this.retryExecutor.execute(
      async (attempt) => {
        const connected = await raceWithDeadline(() => this.ensureConnected(), {
          timer: this.timer,
          signal,
          label: "CtrlProxy WebSocket connect",
        });
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
        signal,
        delays: delayMs,
        shouldRetry: (error) => !(error instanceof RealCtrlProxyWebSocketInTestError),
        onRetry: (_error, attempt) => {
          logger.debug(
            `[${this.logTag}] Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`,
          );
        },
      },
    );
    signal?.throwIfAborted();

    if (result.error instanceof RealCtrlProxyWebSocketInTestError) {
      throw result.error;
    }
    if (!result.success) {
      logger.warn(
        `[${this.logTag}] WebSocket not ready after ${maxAttempts} attempts (${maxAttempts * delayMs}ms)`,
      );
      return false;
    }

    return result.value ?? false;
  }

  /**
   * Force-close a socket a caller has independently determined to be stale —
   * e.g. `readyState === OPEN` yet the service behind it is not responding to
   * application requests (issue #7554,
   * {@link DeviceSessionManager.verifyAndroidDevice}'s connected-but-unresponsive
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
  private finishEstablishedConnection(socket: WebSocket): void {
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

      return await perf.track(
        "wsConnect",
        () =>
          new Promise<boolean>((resolve, reject) => {
            const ws = this.webSocketFactory(wsUrl);
            let opened = false;
            this.lifecycleSocket = ws;
            const connectionTimeout = this.timer.setTimeout(() => {
              this.clearPendingConnectAbort(ws);
              this.clearLifecycleSocket(ws);
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
                this.onConnectAttemptFailed();
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
              opened = true;
              this.ws = ws;
              this.protectRegisteredRequestSends(ws);
              this.isConnecting = false;
              this.connectionAttempts = 0; // Reset on successful connection
              this.backgroundReconnectAttempts = 0;
              this.backgroundReconnectPaused = false;
              this.lastConnectionFailureMessage = undefined;
              this.lastConnectionFailureIsForwardingLeaseConflict = false;
              this.lastConnectionFailureIsTransientLeaseConflict = false;
              this.lastConnectionFailureIsTransientLeaseConflict = false;
              this.markLivenessSeen();

              // Start health check monitoring
              this.startHealthCheck();

              // Platform-specific post-connection setup
              this.onConnectionEstablished();

              resolve(true);
            });

            ws.on("message", (data: WebSocket.Data) => {
              if (this.ws !== ws) {
                return;
              }
              // Any inbound frame proves the peer is alive, independent of
              // whether it happens to be a pong reply (#7554).
              this.markLivenessSeen();
              void this.handleMessage(data);
            });

            ws.on("pong", () => {
              if (this.ws === ws) {
                this.markLivenessSeen();
              }
            });

            // The Android Ktor CtrlProxy server pings the host every 15s
            // (WebSocketServer.kt `pingPeriod`); `ws` auto-pongs those but
            // still surfaces them as a "ping" event on this side. That is a
            // free proof of life independent of the host's own probe (#7554).
            ws.on("ping", () => {
              if (this.ws === ws) {
                this.markLivenessSeen();
              }
            });

            ws.on("error", (error) => {
              if (opened || this.lifecycleSocket !== ws) {
                logger.warn(`[${this.logTag}] WebSocket error: ${error.message}`);
                return;
              }
              this.clearPendingConnectAbort(ws);
              this.clearLifecycleSocket(ws);
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
              if (!opened) {
                this.timer.clearTimeout(connectionTimeout);
                this.isConnecting = false;
                reject(new Error("WebSocket closed before opening"));
                return;
              }
              logger.info(`[${this.logTag}] WebSocket connection closed`);
              this.finishEstablishedConnection(ws);
            });
          }),
      );
    } catch (error) {
      return this.failConnectAttempt(error, background);
    }
  }

  private cleanUpStaleSocket(staleSocket: WebSocket): void {
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
    this.lastConnectionFailureMessage = errorMessage(error);
    this.lastConnectionFailureIsForwardingLeaseConflict =
      error instanceof CtrlProxyForwardingLeaseConflictError;
    this.lastConnectionFailureIsTransientLeaseConflict =
      error instanceof CtrlProxyForwardingLeaseConflictError && error.transient;
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
   * See {@link lastConnectionFailureMessage}.
   */
  public getLastConnectionFailureMessage(): string | undefined {
    return this.lastConnectionFailureMessage;
  }

  /**
   * Whether {@link getLastConnectionFailureMessage} describes the CtrlProxy
   * forwarding-lease conflict specifically (issue #6260 PRRT ft82e), as
   * opposed to an ordinary connect failure. See
   * {@link lastConnectionFailureIsForwardingLeaseConflict}.
   */
  public isLastConnectionFailureForwardingLeaseConflict(): boolean {
    return this.lastConnectionFailureIsForwardingLeaseConflict;
  }

  /**
   * Whether that lease conflict is a time-based refusal (recent owner use, or
   * an owner too busy to answer) that a readiness wait should retry (#10485).
   */
  public isLastConnectionFailureTransientLeaseConflict(): boolean {
    return this.lastConnectionFailureIsTransientLeaseConflict;
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
          this.scheduleReconnect();
        }
      } else {
        logger.debug(
          `[${this.logTag}] Health check passed (time since last: ${timeSinceLastCheck}ms)`,
        );
        // readyState alone only proves the socket hasn't been torn down; it
        // says nothing about whether the peer is still answering (#7554).
        // Probe with a protocol-level ping on the injected timer.
        this.startLivenessProbe(this.ws);
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
    if (this.livenessDeadlineTimeoutId !== null) {
      this.timer.clearTimeout(this.livenessDeadlineTimeoutId);
      this.livenessDeadlineTimeoutId = null;
    }
  }

  /**
   * Record proof that the current connection's peer is alive: a pong reply,
   * a server-initiated ping, or any inbound frame (a frame proves liveness
   * even without an outstanding ping). Also clears the consecutive-timeout
   * counter used by {@link handleRequestTimeout}, since a live peer means
   * those earlier timeouts were not evidence of a wedged socket after all.
   *
   * Bumps {@link livenessSeq} rather than relying solely on the
   * {@link lastLivenessAt} timestamp: {@link startLivenessProbe}'s deadline
   * check compares the sequence number, which can't miss a frame that lands
   * in the same millisecond as the check (timer/`Date.now()` resolution is
   * coarser than that).
   */
  private markLivenessSeen(): void {
    if (this.livenessDeadlineTimeoutId !== null) {
      this.timer.clearTimeout(this.livenessDeadlineTimeoutId);
      this.livenessDeadlineTimeoutId = null;
    }
    this.lastLivenessAt = this.timer.now();
    this.livenessSeq++;
    this.consecutiveRequestTimeouts = 0;
  }

  /**
   * Send a protocol-level ping and, unless a probe is already in flight,
   * arm a bounded deadline on the injected {@link Timer}. If neither a pong
   * nor any other inbound frame refreshes {@link livenessSeq} before the
   * deadline, the socket is presumed dead and torn down with
   * `ws.terminate()`. That firing is what drives the normal was-open close
   * path (`onConnectionClosed()` → `scheduleReconnect()`) — this method
   * never calls either directly, so a liveness failure is counted as exactly
   * one lost connection, the same as any other close (#7554).
   *
   * Safe to call from both the periodic health check and
   * {@link handleRequestTimeout}: a probe already in flight is left alone
   * rather than restarted, so back-to-back callers cannot pile up deadlines
   * or double-count a single failure.
   */
  private startLivenessProbe(ws: WebSocket): void {
    if (this.livenessDeadlineTimeoutId !== null) {
      return;
    }
    const checkStartedAtSeq = this.livenessSeq;
    try {
      ws.ping();
    } catch (error) {
      // Best-effort: a ping send failure on a socket that still reports OPEN
      // is itself evidence of trouble, so still arm the deadline below rather
      // than returning early.
      logger.debug(`[${this.logTag}] Failed to send liveness ping: ${error}`);
    }
    if (this.livenessSeq !== checkStartedAtSeq) {
      return;
    }
    const livenessTimeoutMs =
      this.config.healthCheckIntervalMs * LIVENESS_TIMEOUT_INTERVAL_MULTIPLIER;
    this.livenessDeadlineTimeoutId = this.timer.setTimeout(() => {
      this.livenessDeadlineTimeoutId = null;
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        // Already replaced or torn down through some other path; nothing to do.
        return;
      }
      if (this.livenessSeq > checkStartedAtSeq) {
        // A pong or another frame arrived since this probe started.
        return;
      }
      logger.warn(
        `[${this.logTag}] Liveness probe failed: no pong or frame received within ${livenessTimeoutMs}ms, terminating stale connection`,
      );
      ws.terminate();
    }, livenessTimeoutMs);
  }

  /**
   * Feed RequestManager timeouts back into connection state (#7554). A
   * wedged device-side handler can still answer protocol pings while never
   * responding to application requests, so consecutive request timeouts with
   * no proof of life in between are treated as "suspect" and trigger the same
   * ping-then-terminate probe immediately, instead of waiting out the rest of
   * the current health-check interval.
   */
  private handleRequestTimeout(): void {
    this.consecutiveRequestTimeouts++;
    if (this.consecutiveRequestTimeouts < REQUEST_TIMEOUT_LIVENESS_THRESHOLD) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.warn(
        `[${this.logTag}] ${this.consecutiveRequestTimeouts} consecutive request timeouts with no inbound frame; probing connection liveness`,
      );
      this.startLivenessProbe(this.ws);
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
    const recovery = this.recoveryPromise;
    if (!recovery) {
      return "not_recovering";
    }
    if (signal?.aborted) {
      return "timed_out";
    }
    const timedOut = new Error("Recovery wait timed out");
    try {
      return await raceWithDeadline(
        recovery.then(
          (connected) => (connected ? "recovered" : "failed") as "recovered" | "failed",
        ),
        {
          timer: this.timer,
          timeoutMs: budgetMs,
          signal,
          label: "Recovery wait",
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error === timedOut || signal?.aborted) {
        return "timed_out";
      }
      throw error;
    }
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
}
