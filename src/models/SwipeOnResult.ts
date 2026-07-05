import { BaseActionResult } from "./BaseActionResult";
import { Element } from "./Element";
import { ToolDebugInfo } from "../utils/DebugContextBuilder";

/**
 * Result of a swipeOn operation
 */
export interface SwipeOnResult extends BaseActionResult {
  warning?: string;

  // Context to help callers target scrollable containers
  scrollableCandidates?: ScrollableCandidate[];

  // Target information
  targetType: "screen" | "element";
  element?: Element; // Set when swiping on an element

  // Swipe coordinates
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;

  // Gesture details
  easing?: "linear" | "decelerate" | "accelerate" | "accelerateDecelerate";
  path?: number;

  // Search results (when using lookFor)
  found?: boolean; // Was the target element found?
  scrollIterations?: number; // Number of scrolls performed
  elapsedMs?: number; // Time taken to find element
  hierarchyChanged?: boolean; // Did the hierarchy change during scroll?

  // A11y mode timing (when scrollMode="a11y")
  a11yTotalTimeMs?: number;
  a11yGestureTimeMs?: number;
  fallbackReason?: string;

  // Debug information (when debug mode is enabled)
  debug?: ToolDebugInfo;
}

export interface ScrollableCandidate {
  elementId?: string;
  text?: string;
  contentDesc?: string;
  className?: string;
}

/**
 * The payload the `swipeOn` tool packs into its MCP `structuredContent` envelope:
 * the {@link SwipeOnResult} the command produces plus the human-readable
 * `message` the handler attaches.
 *
 * This is the single source of truth used to (a) annotate the
 * `StructuredToolResponse<SwipeOnToolPayload>` the handler returns and (b) type
 * the internal read sites (the toolRegistry scroll-position update and
 * `DefaultUIStateSetup` scroll setup). With the envelope typed, a `found`/
 * `success` read is compiler-checked against this payload and an
 * envelope-top-level `response.found` read is a **compile error** rather than a
 * silent `undefined` (issue #2932; envelope-vs-`structuredContent` dead-read
 * class, issue #2907).
 */
export interface SwipeOnToolPayload extends SwipeOnResult {
  message: string;
}
