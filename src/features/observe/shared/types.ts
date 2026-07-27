/**
 * Shared types for device service delegates.
 *
 * These types are used by both Android (CtrlProxyClient) and
 * iOS (CtrlProxyClient) delegate implementations to eliminate
 * duplicated result type definitions.
 */

import type WebSocket from "ws";
import type { RequestManager } from "../../../utils/RequestManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { CtrlProxyReconnectStatus } from "../../../models/CtrlProxyReconnectStatus";

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

/**
 * Base result for operations that return success/failure with timing.
 */
export interface BaseResult {
  success: boolean;
  totalTimeMs: number;
  error?: string;
  perfTiming?: PerfTiming | PerfTiming[];
}

/**
 * Result for gesture operations that include gesture-specific timing.
 * Used by swipe, drag, pinch results on both platforms.
 */
export interface GestureTimingResult extends BaseResult {
  gestureTimeMs?: number;
  /**
   * Pinch-only (iOS): which mechanism performed the gesture —
   * "event-path" (private synthesis, honors center) or "element-anchored"
   * (public fallback, center-less). Undefined for Android and non-pinch
   * gestures. See issue #2910.
   */
  pinchPath?: string;
}

/**
 * Result for operations that include an action name.
 * Used by IME action and node action results on both platforms.
 */
export interface ActionTimingResult extends BaseResult {
  action: string;
}

// =============================================================================
// Delegate Context
// =============================================================================

/**
 * Base context interface that all delegates receive.
 * Provides access to shared state and functionality from the main client.
 */
export interface DelegateContext {
  /** Get the current WebSocket connection (may be null if not connected) */
  getWebSocket(): WebSocket | null;
  /** RequestManager for correlating requests and responses */
  requestManager: RequestManager;
  /** Timer for setTimeout/setInterval operations */
  timer: Timer;
  /** Ensure the WebSocket connection is established */
  ensureConnected(perf?: PerformanceTracker): Promise<boolean>;
  /** Return reconnect cooldown metadata when connection attempts are temporarily suppressed. */
  getReconnectStatus?(): CtrlProxyReconnectStatus | null;
  /** Return false when a connected service advertises that it cannot handle this wire command. */
  isCommandSupported?(messageType: string): boolean;
  /** Wait for the connected service's command handshake, then return its advertised commands. */
  getSupportedCommands?(): Promise<string[] | null>;
  /** Build a user-facing error for an advertised unsupported wire command. */
  unsupportedCommandError?(messageType: string): string;
  /** Cancel any pending screenshot backoff captures */
  cancelScreenshotBackoff(): void;
}
