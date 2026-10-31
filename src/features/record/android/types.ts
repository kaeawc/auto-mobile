import type { PointerOption } from "../../../models/PointerOption";
import type { InteractionEvent } from "../../observe/android/AndroidCtrlProxyClient";

/**
 * Shared types for Android device gesture recording via getevent + CtrlProxy.
 */

// ---------------------------------------------------------------------------
// Touch frame types (output of TouchFrameReconstructor)
// ---------------------------------------------------------------------------

export type PointerToolType = "finger" | "stylus" | "eraser";
export type StylusButton = "stylusPrimary" | "stylusSecondary";

/**
 * Pressure over a contact. `normalized` means min/max/mean are 0..1 fractions of
 * the axis range from `getevent -p`; otherwise they are raw digitizer units.
 * Zero-pressure samples are excluded (a zero means "not reported" or "no force").
 */
export interface GesturePressure {
  min: number;
  max: number;
  mean: number;
  normalized: boolean;
}

export interface TouchSlot {
  slotId: number;
  /** -1 means the finger has been lifted */
  trackingId: number;
  /** raw sensor x coordinate */
  x: number;
  /** raw sensor y coordinate */
  y: number;
  pressure: number;
  /** Set only for pen contacts (ABS_MT_TOOL_TYPE pen or BTN_TOOL_PEN/RUBBER); absent for fingers. */
  toolType?: PointerToolType;
  /** Held stylus buttons (BTN_STYLUS / BTN_STYLUS2); absent when none. */
  buttons?: StylusButton[];
  /** Raw ABS_TILT_X / ABS_TILT_Y (device units), when the digitizer reports them. */
  tiltX?: number;
  tiltY?: number;
  /** Raw ABS_DISTANCE (hover height), when reported. */
  distance?: number;
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
  /**
   * Final sample of a released slot whose position changed in its release packet. Present only
   * when non-empty, so ordinary frames keep their shape.
   */
  releasedFinalSamples?: ReadonlyArray<TouchSlot>;
}

// ---------------------------------------------------------------------------
// Gesture types (output of GestureClassifier / GetEventReader)
// ---------------------------------------------------------------------------

type GestureEventType =
  | "tap"
  | "doubleTap"
  | "longPress"
  | "swipe"
  | "pinch"
  | "pressButton"
  | "hover";

export interface GestureEvent {
  type: GestureEventType;
  geometry?: Omit<import("../../../models/TapAtGeometry").TapAtGeometry, "x" | "y">;
  /** Host time of the UP/key event that completed the gesture */
  arrivedAt: number;

  /** Raw axes unknown during this contact; screen coordinates must not be inferred. */
  unknownAxes?: ("x" | "y")[];

  /**
   * Host time of the DOWN frame the coordinates were mapped at. Set only when the
   * classifier maps through a timeline, so the recorder can ask which display
   * geometry was in force for the touch (#10174).
   */
  downAt?: number;

  /** Only present for pen contacts ("stylus" or "eraser"); finger gestures omit it. */
  toolType?: PointerToolType;
  /** Pressure over the contact; present only when the digitizer reported non-zero pressure. */
  pressure?: GesturePressure;
  /** Stylus buttons held at any point during the contact. */
  buttons?: StylusButton[];

  /** Mean contact AXIS_TILT magnitude in radians, 0..PI/2; absent without both tilt axes. */
  tilt?: number;

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

/**
 * The replayable pointer for a recorded pen gesture. Only "stylus" can be injected, so an eraser
 * has none (the recorder skips those gestures instead of replaying them as another tool).
 */
export function pointerOf(gesture: GestureEvent): PointerOption | undefined {
  if (gesture.toolType !== "stylus") {
    return undefined;
  }
  const pointer: PointerOption = { toolType: "stylus" };
  if (gesture.pressure?.normalized) {
    pointer.pressure = Math.round(gesture.pressure.mean * 1e4) / 1e4;
  }
  if (gesture.tilt !== undefined) {
    pointer.tilt = gesture.tilt;
  }
  if (gesture.buttons?.length) {
    pointer.buttons = gesture.buttons.map((button) =>
      button === "stylusPrimary" ? "primary" : "secondary",
    );
  }
  return pointer;
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
export interface ReceivedInteraction extends Omit<InteractionEvent, "type" | "text"> {
  type: string;
  /**
   * CtrlProxy serializes an inputText event for an emptied field as `text: null`
   * (it encodes defaults), and some platforms report `""` instead.
   */
  text?: string | null;
}

/** A display change pushed by CtrlProxy; the subset the recorder reads. */
export interface DisplayChange {
  change: string;
  displayId: number;
  /** Surface rotation 0-3; absent on APKs that predate the field. */
  rotation?: number;
  width?: number;
  height?: number;
}

/** Subscription to CtrlProxy display changes (rotation, size, fold state). */
export interface DisplayChangeSource {
  onDisplayChange(listener: (change: DisplayChange) => void): () => void;
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
