/**
 * DeviceServiceUtils - Shared utilities for device service clients
 *
 * These utilities are used by both CtrlProxyClient (Android) and
 * CtrlProxyClient (iOS) to reduce code duplication.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import { logger, type Logger } from "../../utils/logger";
import WebSocket from "ws";
import type { DeviceService, GestureResult, TextResult, ScreenshotResult } from "./DeviceService";
import type {
  BaseResult,
  GestureTimingResult,
  ActionTimingResult,
  DelegateContext,
} from "./shared/types";

// =============================================================================
// Connection Utilities
// =============================================================================

/**
 * Options for WebSocket connection management.
 */
interface ConnectionOptions {
  /** Maximum connection attempts */
  maxAttempts: number;
  /** Delay between attempts in ms */
  delayMs: number;
  /** Connection timeout in ms */
  timeoutMs: number;
}

/**
 * Default connection options.
 */
export const DEFAULT_CONNECTION_OPTIONS: ConnectionOptions = {
  maxAttempts: 3,
  delayMs: 1000,
  timeoutMs: 5000,
};

/**
 * Wait with retry logic until a condition is met.
 */
export async function waitWithRetry(
  condition: () => boolean | Promise<boolean>,
  options: Partial<ConnectionOptions> = {},
  timer: Timer,
): Promise<boolean> {
  const opts = { ...DEFAULT_CONNECTION_OPTIONS, ...options };

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    if (await condition()) {
      return true;
    }

    if (attempt < opts.maxAttempts - 1) {
      await new Promise<void>((resolve) => {
        timer.setTimeout(resolve, opts.delayMs);
      });
    }
  }

  return false;
}

// =============================================================================
// Request/Response Utilities
// =============================================================================

/**
 * Create a timeout error result for gesture operations.
 */
export function createGestureTimeoutResult(
  operationType: string,
  timeoutMs: number,
): GestureResult {
  return {
    success: false,
    totalTimeMs: timeoutMs,
    error: `${operationType} timed out after ${timeoutMs}ms`,
  };
}

/**
 * Create a timeout error result for text operations.
 */
export function createTextTimeoutResult(operationType: string, timeoutMs: number): TextResult {
  return {
    success: false,
    totalTimeMs: timeoutMs,
    error: `${operationType} timed out after ${timeoutMs}ms`,
  };
}

/**
 * Create a not connected error result for gesture operations.
 */
export function createGestureNotConnectedResult(): GestureResult {
  return {
    success: false,
    totalTimeMs: 0,
    error: "Not connected",
  };
}

/**
 * Create a not connected error result for text operations.
 */
export function createTextNotConnectedResult(): TextResult {
  return {
    success: false,
    totalTimeMs: 0,
    error: "Not connected",
  };
}

/**
 * Create a not connected error result for screenshot operations.
 */
export function createScreenshotNotConnectedResult(): ScreenshotResult {
  return {
    success: false,
    error: "Not connected",
  };
}

// =============================================================================
// Cached Hierarchy Utilities
// =============================================================================

/**
 * Generic cached hierarchy interface.
 */
export interface CachedHierarchy<T> {
  hierarchy: T;
  receivedAt: number;
  fresh: boolean;
}

/**
 * Check if a cached hierarchy is still valid based on max age.
 */
export function isCacheValid<T>(
  cache: CachedHierarchy<T> | null,
  maxAgeMs: number,
  currentTime: number,
): boolean {
  if (!cache) {
    return false;
  }
  return currentTime - cache.receivedAt < maxAgeMs;
}

/**
 * Create a fresh cache entry.
 */
export function createCacheEntry<T>(hierarchy: T, timestamp: number): CachedHierarchy<T> {
  return {
    hierarchy,
    receivedAt: timestamp,
    fresh: true,
  };
}

// =============================================================================
// Message Parsing Utilities
// =============================================================================

/**
 * Safely parse a JSON message.
 */
export function parseMessage<T>(data: string | Buffer, log: Logger = logger): T | null {
  try {
    const text = typeof data === "string" ? data : data.toString();
    return JSON.parse(text) as T;
  } catch (error) {
    // Malformed delegate messages are non-fatal; callers treat null as an unparseable message.
    log.debug(`Failed to parse device service message: ${errorMessage(error)}`, error);
    return null;
  }
}

/**
 * Create a WebSocket message for sending.
 */
export function createMessage(
  type: string,
  requestId: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    requestId,
    ...params,
  });
}

// =============================================================================
// Generic Delegate Request Helper
// =============================================================================

/**
 * Options for `sendCommand` — the shared
 *   cancelScreenshotBackoff → ensureConnected → register → send → await
 * flow used by WebSocket delegate methods.
 */
type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

type RequiredNonBaseResultKeys<T> = Exclude<RequiredKeys<T>, keyof BaseResult>;

type NotConnectedErrorBuilder<T> = () => T;
type TimeoutErrorBuilder<T> = (timeoutMs: number) => T;
type UnsupportedCommandErrorBuilder<T> = (messageType: string, error: string) => T;

type CommandFallbackBuilders<T> = [RequiredNonBaseResultKeys<T>] extends [never]
  ? {
      notConnectedError?: NotConnectedErrorBuilder<T>;
      timeoutError?: TimeoutErrorBuilder<T>;
      unsupportedCommandError?: UnsupportedCommandErrorBuilder<T>;
    }
  : {
      notConnectedError: NotConnectedErrorBuilder<T>;
      timeoutError: TimeoutErrorBuilder<T>;
      unsupportedCommandError: UnsupportedCommandErrorBuilder<T>;
    };

interface SendCommandBaseOptions {
  idPrefix: string;
  responseType: string;
  messageType: string;
  params?: Record<string, unknown>;
  timeoutMs: number;
  perf?: PerformanceTracker;
  /** Defaults to true. Set false for endpoints that should not interrupt screenshot backoff. */
  cancelScreenshotBackoff?: boolean;
  /** Observer requests reuse an open socket without reconnecting it. */
  requireExistingConnection?: boolean;
  /** Overrides the default "Not connected" message. Ignored when `notConnectedError` is set. */
  notConnectedMessage?: string;
  /** Human-readable label used in the default timeout error. Defaults to `responseType`. */
  errorLabel?: string;
  /**
   * Aborted by a caller-owned deadline that started before `ensureConnected()`
   * was awaited (#6249 follow-up). `ensureConnected()` itself is not
   * cancellable, but the signal is checked before dispatch and rejects a
   * registered in-flight request so its timer and pending state settle
   * immediately when the caller goes away.
   */
  abortSignal?: AbortSignal;
  /** Absolute caller deadline, re-read after connecting before registering the request. */
  deadlineMs?: number;
  /** Must be explicitly confirmed on the current connection immediately before sending. */
  requiredCapability?: string;
  /** Synchronous caller fence, checked on the ready connection immediately before dispatch. */
  beforeSend?: () => void;
  /**
   * Invoked synchronously right after `ws.send()` succeeds — i.e. the wire
   * request was actually dispatched to the device (#6249 P1 follow-up).
   *
   * A caller racing this call against its own deadline cannot tell, from the
   * deadline firing alone, whether the request ever reached the device: if
   * the deadline wins the race, `sendCommand`'s own response is abandoned and
   * never observed. Without this signal a caller that sees only "timeout" has
   * no way to distinguish "never dispatched, safe to retry" from "dispatched,
   * outcome unknown — retrying may double-apply the action". Callers that
   * care about that distinction (e.g. `ImeAction`) pass this to flip a local
   * flag they can check when their own deadline fires.
   */
  onDispatch?: (requestId: string) => void;
}

export type SendCommandOptions<T> = SendCommandBaseOptions & CommandFallbackBuilders<T>;

function notConnectedCommandResult<T>(options: SendCommandOptions<T>, defaultMessage: string): T {
  if (options.notConnectedError) {
    return options.notConnectedError();
  }
  return {
    success: false,
    totalTimeMs: 0,
    error: options.notConnectedMessage ?? defaultMessage,
  } as T;
}

function resolveCommandDispatch<T>(
  context: DelegateContext,
  options: SendCommandOptions<T>,
  connected: boolean,
): number | { result: T } {
  if (!connected) {
    return { result: notConnectedCommandResult(options, "Not connected") };
  }

  if (context.isCommandSupported && !context.isCommandSupported(options.messageType)) {
    const error = context.unsupportedCommandError
      ? context.unsupportedCommandError(options.messageType)
      : `${options.messageType} is not supported by the connected device service`;
    if (options.unsupportedCommandError) {
      return { result: options.unsupportedCommandError(options.messageType, error) };
    }
    return {
      result: {
        success: false,
        totalTimeMs: 0,
        error,
      } as T,
    };
  }

  if (options.abortSignal?.aborted) {
    // The caller's own deadline already fired while ensureConnected() was
    // resolving (#6249) — do not register or dispatch a request the caller
    // has already given up on.
    logger.debug(
      `[sendCommand] ${options.messageType} aborted before dispatch (deadline expired while connecting)`,
    );
    return { result: notConnectedCommandResult(options, "Request aborted before dispatch") };
  }

  return resolveCommandTimeout(options, context.timer);
}

function resolveCommandTimeout<T>(
  options: SendCommandOptions<T>,
  timer: Timer,
): number | { result: T } {
  const timeoutMs =
    options.deadlineMs === undefined
      ? options.timeoutMs
      : Math.min(options.timeoutMs, Math.max(0, options.deadlineMs - timer.now()));
  if (options.deadlineMs !== undefined && timeoutMs <= 0) {
    return {
      result: {
        success: false,
        totalTimeMs: 0,
        error: "Request deadline expired before dispatch",
      } as T,
    };
  }
  return timeoutMs;
}

function registerCommandAbort<T>(
  context: DelegateContext,
  options: SendCommandOptions<T>,
  requestId: string,
): (() => void) | undefined {
  let abortListener: (() => void) | undefined;
  if (options.abortSignal) {
    abortListener = () => {
      const reason = options.abortSignal?.reason;
      context.requestManager.reject(
        requestId,
        reason instanceof Error ? reason : new Error("Operation cancelled"),
      );
    };
    options.abortSignal.addEventListener("abort", abortListener, { once: true });
    if (options.abortSignal.aborted) {
      abortListener();
    }
  }

  return abortListener;
}

function commitCommand<T>(
  ws: WebSocket,
  msg: string,
  options: SendCommandOptions<T>,
  requestId: string,
): void {
  // Capability, caller fence, and cancellation share this synchronous pre-send step.
  // No await may separate these checks from sending the first committing message.
  options.beforeSend?.();
  options.abortSignal?.throwIfAborted();
  ws.send(msg);
  options.onDispatch?.(requestId);
}

function dispatchCommand<T>(
  context: DelegateContext,
  options: SendCommandOptions<T>,
  requestId: string,
  msg: string,
  responseErrorFactory: (error: string, totalTimeMs: number) => T,
): void {
  try {
    if (!options.abortSignal?.aborted) {
      const ws = context.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }
      if (
        options.requiredCapability &&
        context.isCommandSupported?.(options.requiredCapability) !== true
      ) {
        context.requestManager.resolve(requestId, {
          ...responseErrorFactory(
            `${options.requiredCapability} is not confirmed by the connected device service`,
            0,
          ),
          unsupportedCapability: options.requiredCapability,
        });
      } else {
        commitCommand(ws, msg, options, requestId);
      }
    }
  } catch (error) {
    context.requestManager.reject(
      requestId,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export async function sendCommand<T>(
  context: DelegateContext,
  options: SendCommandOptions<T>,
): Promise<T> {
  if (options.cancelScreenshotBackoff !== false) {
    context.cancelScreenshotBackoff();
  }

  const connected = options.requireExistingConnection
    ? context.getWebSocket()?.readyState === WebSocket.OPEN
    : options.perf
      ? await options.perf.track("ensureConnected", () => context.ensureConnected(options.perf))
      : await context.ensureConnected();

  const timeoutMs = resolveCommandDispatch(context, options, connected);
  if (typeof timeoutMs !== "number") {
    return timeoutMs.result;
  }
  const requestId = context.requestManager.generateId(options.idPrefix);
  const label = options.errorLabel ?? options.responseType;
  const timeoutFactory = options.timeoutError
    ? (_id: string, _type: string, timeout: number) => options.timeoutError!(timeout)
    : (_id: string, _type: string, timeout: number) =>
        ({
          success: false,
          totalTimeMs: timeout,
          error: `${label} timed out after ${timeout}ms`,
        }) as T;
  const responseErrorFactory = (error: string, totalTimeMs: number): T =>
    options.unsupportedCommandError
      ? options.unsupportedCommandError(options.messageType, error)
      : ({
          success: false,
          totalTimeMs,
          error,
        } as T);

  const promise = context.requestManager.register<T>(
    requestId,
    options.responseType,
    timeoutMs,
    timeoutFactory,
    responseErrorFactory,
  );

  const abortListener = registerCommandAbort(context, options, requestId);

  const msg = context.serializeRequest
    ? context.serializeRequest({ type: options.messageType, requestId, ...options.params })
    : createMessage(options.messageType, requestId, options.params);
  dispatchCommand(context, options, requestId, msg, responseErrorFactory);

  try {
    return await (options.perf
      ? options.perf.track(`${options.idPrefix}.awaitResponse`, () => promise)
      : promise);
  } finally {
    if (options.abortSignal && abortListener) {
      options.abortSignal.removeEventListener("abort", abortListener);
    }
  }
}

// =============================================================================
// Result Type Adapters
// =============================================================================

/**
 * Platform-specific gesture result with properly-typed perfTiming.
 */
export type PlatformGestureResult = GestureTimingResult;

/**
 * Platform-specific text result with properly-typed perfTiming.
 */
export type PlatformTextResult = BaseResult;

/**
 * Platform-specific IME action result with properly-typed perfTiming.
 */
export type PlatformImeActionResult = Omit<ActionTimingResult, "action"> & { action?: string };

/**
 * Platform-specific screenshot result.
 */
export interface PlatformScreenshotResult {
  success: boolean;
  data?: string;
  format?: string;
  timestamp?: number;
  width?: number;
  height?: number;
  error?: string;
}

/**
 * Convert a platform-specific gesture result to the unified GestureResult type.
 * Strips platform-specific perfTiming data to create a clean interface result.
 *
 * @param result Platform-specific result (A11ySwipeResult, XCTestSwipeResult, etc.)
 * @returns Unified GestureResult
 */
export function toGestureResult(result: PlatformGestureResult): GestureResult {
  return {
    success: result.success,
    totalTimeMs: result.totalTimeMs,
    gestureTimeMs: result.gestureTimeMs,
    error: result.error,
  };
}

/**
 * Convert a platform-specific text result to the unified TextResult type.
 *
 * @param result Platform-specific result (A11ySetTextResult, XCTestSetTextResult, etc.)
 * @returns Unified TextResult
 */
export function toTextResult(result: PlatformTextResult): TextResult {
  return {
    success: result.success,
    totalTimeMs: result.totalTimeMs,
    error: result.error,
  };
}

/**
 * Convert a platform-specific IME action result to the unified ImeActionResult type.
 *
 * @param result Platform-specific result (A11yImeActionResult, XCTestImeActionResult)
 * @returns Unified ImeActionResult
 */
export function toImeActionResult(
  result: PlatformImeActionResult,
): Awaited<ReturnType<DeviceService["requestImeAction"]>> {
  return {
    success: result.success,
    totalTimeMs: result.totalTimeMs,
    action: result.action,
    error: result.error,
  };
}

/**
 * Convert a platform-specific screenshot result to the unified ScreenshotResult type.
 *
 * @param result Platform-specific result (ScreenshotResult from either platform)
 * @returns Unified ScreenshotResult
 */
export function toScreenshotResult(result: PlatformScreenshotResult): ScreenshotResult {
  return {
    success: result.success,
    data: result.data,
    format: result.format,
    width: result.width,
    height: result.height,
    timestamp: result.timestamp,
    error: result.error,
  };
}
