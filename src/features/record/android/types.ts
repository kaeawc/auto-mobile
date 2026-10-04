import type { InteractionEvent } from "../../observe/android/AndroidCtrlProxyClient";

/**
 * Shared types for Android test recording via getevent + CtrlProxy.
 */

// ---------------------------------------------------------------------------
// Touch frame types (output of TouchFrameReconstructor)
// ---------------------------------------------------------------------------

export interface TouchSlot {
  slotId: number;
  /** -1 means the finger has been lifted */
  trackingId: number;
  /** raw sensor x coordinate */
  x: number;
  /** raw sensor y coordinate */
  y: number;
  pressure: number;
  /** Raw axes not yet observed in this stream; their numeric values are NaN. */
  unknownAxes?: ("x" | "y")[];
}

export interface RawTouchFrame {
  /** Date.now() on host when the SYN_REPORT line was read */
  arrivedAt: number;

  /** Only slots with trackingId >= 0 */
  activeSlots: ReadonlyArray<TouchSlot>;
  /** slotIds whose trackingId became -1 in this frame */
  releasedSlots: ReadonlyArray<number>;
}

// ---------------------------------------------------------------------------
// Gesture types (output of GestureClassifier / GetEventReader)
// ---------------------------------------------------------------------------

type GestureEventType = "tap" | "doubleTap" | "longPress" | "swipe" | "pinch" | "pressButton";

export interface GestureEvent {
  type: GestureEventType;
  /** Host time of the UP/key event that completed the gesture */
  arrivedAt: number;

  /** Raw axes unknown during this contact; screen coordinates must not be inferred. */
  unknownAxes?: ("x" | "y")[];

  // tap / doubleTap / longPress
  screenX?: number;
  screenY?: number;
  durationMs?: number;
  /** First release time for a classifier-produced doubleTap. */
  firstTapArrivedAt?: number;

  // swipe
  direction?: "up" | "down" | "left" | "right";
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  speed?: "slow" | "normal" | "fast";

  // pinch
  scale?: number;
  pinchDirection?: "in" | "out";

  // pressButton
  button?: "back" | "home" | "menu" | "power" | "volume_up" | "volume_down" | "recent";
}

/** Thresholds used for gesture classification (dp units where applicable) */
export const GESTURE_THRESHOLDS = {
  TOUCH_SLOP_DP: 8,
  LONG_PRESS_MS: 400,
  TAP_TIMEOUT_MS: 100,
  DOUBLE_TAP_MS: 300,
  DOUBLE_TAP_SLOP_DP: 100,
  FLING_MIN_DP_PER_S: 50,
  PINCH_MIN_SCALE_DELTA: 0.1,
} as const;

// ---------------------------------------------------------------------------
// Interfaces for DI / testing in DualTrackRecorder
// ---------------------------------------------------------------------------

/**
 * Abstraction over GetEventReader for dependency injection in DualTrackRecorder.
 * Start receives the callback so the emitter can call it when a gesture occurs.
 */
export interface GestureEmitter {
  start(onGesture: (event: GestureEvent) => void, onError?: (err: Error) => void): void;
  stop(): void;
}

/**
 * Minimal subset of CtrlProxyClient needed by DualTrackRecorder.
 */
export interface ReceivedInteraction extends Omit<InteractionEvent, "type"> {
  type: string;
}

export interface A11ySource {
  ensureConnected(): Promise<boolean>;
  getSupportedCommands(): Promise<string[] | null>;
  onInteraction(listener: (event: ReceivedInteraction) => void): () => void;
}

/** First terminal getevent failure, timestamped by the recorder's injected timer. */
export interface TouchTrackFailure {
  error: Error;
  failedAt: number;
}
