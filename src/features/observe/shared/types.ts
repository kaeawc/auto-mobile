/**
 * Shared types for device service delegates.
 *
 * These types are used by both Android (CtrlProxyClient) and
 * iOS (CtrlProxyClient) delegate implementations to eliminate
 * duplicated result type definitions.
 */

import type { IdGenerator } from "../../../utils/IdGenerator";
import type WebSocket from "ws";
import type { RequestManager } from "../../../utils/RequestManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
export type { SwipeRequest, SwipeRequestOptions } from "../../../utils/interfaces/SwipeRequest";
export type { DragRequest } from "../../../utils/interfaces/DragRequest";
import type { CtrlProxyReconnectStatus } from "../../../models/CtrlProxyReconnectStatus";
import type { PrototypeAssetCache } from "../../prototype/prototypeAssetCache";
import type { SavedPrototypeMirror } from "../../prototype/savedPrototypeMirror";

/**
 * The slice of the `ws` WebSocket surface the CtrlProxy clients, delegates and
 * exchange recorder actually use. `WebSocketFactory` returns this narrow type
 * rather than the full `ws` class so test fakes (`FakeWebSocket`) can satisfy it
 * structurally; the real `ws` WebSocket is assignable to it.
 */
export interface CtrlSocket {
  readonly readyState: number;
  send(data: WebSocket.Data, cb?: (error?: Error) => void): void;
  close(): void;
  ping(): void;
  terminate(): void;
  removeAllListeners(): this;
  on(event: "message", listener: (data: WebSocket.Data) => void): this;
  on(event: "open" | "close" | "ping" | "pong", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

// =============================================================================
// Performance Timing
// =============================================================================

/**
 * Hierarchical performance timing data from the device.
 * Used by both Android (AndroidPerfTiming) and iOS (XCTestPerfTiming).
 */
export interface PerfTiming {
  name: string;
  durationMs: number;
  children?: PerfTiming[];
}

// =============================================================================
// Shared Result Types
// =============================================================================

/** Caller cancellation and the hook fired once the request frame was written (both platforms). */
export interface DispatchOptions {
  signal?: AbortSignal;
  onDispatch?: () => void;
}

/**
 * Base result for operations that return success/failure with timing.
 */
export interface BaseResult {
  success: boolean;
  totalTimeMs: number;
  error?: string;
  /** Dispatched but unconfirmed mutations must not be replayed automatically. */
  retryable?: boolean;
  perfTiming?: PerfTiming | PerfTiming[];
}

/**
 * Result for gesture operations that include gesture-specific timing.
 * Used by swipe, drag, pinch results on both platforms.
 */
export interface GestureTimingResult extends BaseResult {
  gestureTimeMs?: number;
  /** iOS runner's typed failure code (`runnerErrorCodes.ts`); absent from older runners. */
  errorCode?: string;
  /**
   * Pinch-only (iOS): which mechanism performed the gesture —
   * "event-path" (private synthesis, honors center) or "element-anchored"
   * (public fallback, center-less). Undefined for Android and non-pinch
   * gestures. See issue #2910.
   */
  pinchPath?: string;
  /**
   * Single-finger iOS swipe: the dispatch route the runner took ("xcuiCoordinate",
   * "unpinnedSynthesized" or "lockScreenSynthesized") and the stroke duration it really used.
   * Absent from older runners and other gestures (#13145).
   */
  swipeRoute?: string;
  effectiveDurationMs?: number;
}

/**
 * Result for operations that include an action name.
 * Used by IME action and node action results on both platforms.
 */
export interface ActionTimingResult extends BaseResult {
  action: string;
  /** Android IME next/previous only: focus was moved directly instead of dispatching the editor action. */
  approximated?: boolean;
}

// =============================================================================
// Delegate Context
// =============================================================================

/**
 * Base context interface that all delegates receive.
 * Provides access to shared state and functionality from the main client.
 */
export interface DelegateContext {
  idGenerator?: IdGenerator;
  prototypeAssetCache?: { serial: string; cache: PrototypeAssetCache };
  savedPrototypeMirror?: { serial: string; mirror: SavedPrototypeMirror };
  /** Platform-specific serialization at the request construction boundary. */
  serializeRequest?(message: Record<string, unknown>): string;
  /**
   * Extra wire fields that tell the service how long the host will wait for `messageType`, so a
   * command queued behind a slow one is not started after the host has given up (#10084).
   * Called once from `sendCommand` with the effective timeout; the request's own params win.
   */
  wireDeadlineParams?(messageType: string, timeoutMs: number): Record<string, unknown>;
  /** Get the current WebSocket connection (may be null if not connected) */
  getWebSocket(): CtrlSocket | null;
  /** RequestManager for correlating requests and responses */
  requestManager: RequestManager;
  /** Timer for setTimeout/setInterval operations */
  timer: Timer;
  /** Ensure the WebSocket connection is established */
  ensureConnected(perf?: PerformanceTracker): Promise<boolean>;
  /** Return reconnect cooldown metadata when connection attempts are temporarily suppressed. */
  getReconnectStatus?(): CtrlProxyReconnectStatus | null;
  /** Return false only when the service explicitly lacks or rejected this command; unknown is true. */
  isCommandSupported?(messageType: string): boolean;
  /** Wait for the connected service's command handshake, then return its advertised commands. */
  getSupportedCommands?(): Promise<string[] | null>;
  /** Build a user-facing error for an advertised unsupported wire command. */
  unsupportedCommandError?(messageType: string): string;
  /** Cancel any pending screenshot backoff captures */
  cancelScreenshotBackoff(): void;
}
