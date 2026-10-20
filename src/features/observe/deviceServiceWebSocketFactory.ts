import WebSocket from "ws";
import { ENV } from "../../config/env";
import { currentProcessEntrypoint, isBunTestRunnerProcess } from "../../utils/bunTestRunnerProcess";
import { RealCtrlProxyWebSocketInTestError } from "./RealCtrlProxyWebSocketInTestError";
import type { CtrlSocket } from "./shared/types";

/**
 * Factory function type for creating WebSocket instances.
 * Used for testing to inject fake WebSocket implementations.
 */
export type WebSocketFactory = (url: string) => CtrlSocket;

/**
 * Env flag a unit test sets (`1`/`true`/`yes`) to opt into a real WebSocket from
 * {@link defaultWebSocketFactory} under `bun test`. Prefer injecting a
 * `WebSocketFactory` instead; this exists for suites that must exercise the
 * default factory against a local fake server.
 */
export const REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV = ENV.ALLOW_REAL_CTRL_PROXY_WEBSOCKET.name;

export function isRealCtrlProxyWebSocketOptInEnabled(env: NodeJS.ProcessEnv): boolean {
  const normalized = env[REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV]?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Rethrow {@link RealCtrlProxyWebSocketInTestError} from a connect-path catch that would otherwise degrade it. */
export function rethrowRealCtrlProxyWebSocketInTestError(error: unknown): void {
  if (error instanceof RealCtrlProxyWebSocketInTestError) {
    throw error;
  }
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
  entrypoint: string | undefined = currentProcessEntrypoint(),
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
export interface ConnectionConfig {
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
export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  maxConnectionAttempts: 3,
  connectionResetMs: 10000,
  reconnectDelayMs: 2000,
  healthCheckIntervalMs: 30000,
  connectionTimeoutMs: 5000,
};
