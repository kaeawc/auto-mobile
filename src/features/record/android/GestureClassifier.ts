import type { RawTouchFrame, GestureEvent, PointerToolType, StylusButton } from "./types";
import { GESTURE_THRESHOLDS } from "./types";
import type { CoordScaler, GestureScaler } from "./AxisRanges";
import type { TiltAxes } from "./TouchNodeDiscovery";
import type { Point } from "../../../models/Point";

interface ContactInfo {
  /** First observed raw position per axis; unknownAxes retains missing START axes. */
  startX: number;
  startY: number;
  arrivedAt: number;
  /** Last known raw sensor position (updated on each active frame) */
  lastX: number;
  lastY: number;
  /** Scaler in force when the contact went down; a rotation later does not change it. */
  scaler: CoordScaler;
  unknownAxes?: GestureEvent["unknownAxes"];
  /** Pen/pressure observed over the contact; empty for plain finger contacts. */
  pen: PenObservation;
}

interface PenObservation {
  toolType?: PointerToolType;
  buttons: Set<StylusButton>;
  pressureCount: number;
  pressureSum: number;
  pressureMin: number;
  pressureMax: number;
  tiltCount: number;
  tiltSum: number;
}

/** Axis range of the pressure axis from `getevent -p`; absent means raw units are reported. */
export interface PressureRange {
  min: number;
  max: number;
}

interface LastTap {
  screenX: number;
  screenY: number;
  arrivedAt: number;
  /** Pen tool of the tap; undefined for a finger. Taps by different tools never pair. */
  toolType: PointerToolType | undefined;
}

interface PinchState {
  initialDist?: number;
  /** Updated each frame while both fingers are active */
  finalDist?: number;
  unknownAxes?: GestureEvent["unknownAxes"];
}

/**
 * Classifies sequences of RawTouchFrame events into high-level GestureEvents.
 *
 * Single-finger gestures:
 *   - tap: short, low-displacement contact
 *   - doubleTap: two taps within DOUBLE_TAP_MS at the same location
 *   - longPress: long, low-displacement contact
 *   - swipe: high-displacement contact
 *
 * Two-finger gestures:
 *   - pinch: two contacts with significant scale change
 *
 * Feed frames in order. A GestureEvent is returned when a gesture completes
 * (on finger UP), otherwise null.
 */
export class GestureClassifier {
  /** Per-slot: start position + last known position */
  private contacts: Map<number, ContactInfo> = new Map();
  private lastTap: LastTap | null = null;
  private pinchState: PinchState | null = null;
  private inTwoFingerMode = false;

  /**
   * @param scaler converts raw sensor coordinates to logical screen pixels
   * @param densityDp dp multiplier (e.g. 420/160 = 2.625 for a 420dpi screen)
   */
  constructor(
    private readonly scaler: GestureScaler,
    private readonly densityDp: number,
    private readonly pressureRange?: PressureRange,
    private readonly tiltAxes?: TiltAxes,
  ) {}

  private scalerAt(time: number): CoordScaler {
    return "scalerAt" in this.scaler ? this.scaler.scalerAt(time) : this.scaler;
  }

  /** Only a timeline-backed classifier reports the DOWN time (see GestureEvent.downAt). */
  private downStamp(contact: ContactInfo): { downAt?: number } {
    return "scalerAt" in this.scaler ? { downAt: contact.arrivedAt } : {};
  }

  /** Feed one frame. Returns a completed GestureEvent or null. */
  feedFrame(frame: RawTouchFrame): GestureEvent | null {
    // 1. Register new contacts and update last-known positions
    this.updateContacts(frame);

    // 2. Update pinch state while 2 fingers are active
    const activeCount = frame.activeSlots.length;
    this.updatePinchState(frame, activeCount);

    // 3. Nothing released → nothing to emit
    if (frame.releasedSlots.length === 0) {
      return null;
    }

    // 4. Handle pinch completion
    if (this.inTwoFingerMode && this.pinchState) {
      // Clean up released contacts
      for (const slotId of frame.releasedSlots) {
        this.contacts.delete(slotId);
      }
      // Only emit once ALL fingers are up to avoid duplicate pinch on staggered release
      if (activeCount === 0) {
        const result = this.maybeEmitPinch(frame.arrivedAt);
        this.inTwoFingerMode = false;
        this.pinchState = null;
        return result;
      }
      // One finger still active; finalDist will keep updating in step 2
      return null;
    }

    // 5. Single-finger gesture: exactly 1 slot released, 0 remaining
    if (!this.inTwoFingerMode && frame.releasedSlots.length === 1 && activeCount === 0) {
      return this.completeSingleFingerGesture(frame);
    }

    // Clean up released contacts in other cases
    for (const slotId of frame.releasedSlots) {
      this.contacts.delete(slotId);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private updateContacts(frame: RawTouchFrame): void {
    // A release packet can carry the contact's last move; only the position counts (pressure is 0).
    for (const slot of frame.releasedFinalSamples ?? []) {
      const existing = this.contacts.get(slot.slotId);
      if (existing) {
        existing.lastX = slot.x;
        existing.lastY = slot.y;
      }
    }
    for (const slot of frame.activeSlots) {
      const existing = this.contacts.get(slot.slotId);
      if (existing) {
        // A later axis report proves movement only from its first seen value.
        // It cannot recover the missing contact-start coordinate.
        if (!Number.isFinite(existing.startX)) {
          existing.startX = slot.x;
        }
        if (!Number.isFinite(existing.startY)) {
          existing.startY = slot.y;
        }
        existing.lastX = slot.x;
        existing.lastY = slot.y;
        existing.unknownAxes = mergeUnknownAxes(existing.unknownAxes, slot.unknownAxes);
        observePen(existing.pen, slot, this.tiltAxes);
      } else {
        const pen = newPenObservation();
        observePen(pen, slot, this.tiltAxes);
        this.contacts.set(slot.slotId, {
          startX: slot.x,
          startY: slot.y,
          arrivedAt: frame.arrivedAt,
          lastX: slot.x,
          lastY: slot.y,
          scaler: this.scalerAt(frame.arrivedAt),
          unknownAxes: slot.unknownAxes,
          pen,
        });
      }
    }
  }

  private updatePinchState(frame: RawTouchFrame, activeCount: number): void {
    if (activeCount === 2) {
      this.inTwoFingerMode = true;
      const [a, b] = frame.activeSlots;
      const unknownAxes = mergeUnknownAxes(
        this.contacts.get(a.slotId)?.unknownAxes,
        this.contacts.get(b.slotId)?.unknownAxes,
      );
      const scaler = this.contacts.get(a.slotId)?.scaler ?? this.scalerAt(frame.arrivedAt);
      const dist = unknownAxes?.length
        ? undefined
        : screenDist(scaler, a.x, a.y, { rawX2: b.x, rawY2: b.y });
      if (!this.pinchState) {
        this.pinchState = { initialDist: dist, finalDist: dist, unknownAxes };
      } else {
        this.pinchState.finalDist = dist;
        this.pinchState.unknownAxes = mergeUnknownAxes(this.pinchState.unknownAxes, unknownAxes);
      }
    }
  }

  private completeSingleFingerGesture(frame: RawTouchFrame): GestureEvent | null {
    const slotId = frame.releasedSlots[0];
    const contact = this.contacts.get(slotId);
    this.contacts.delete(slotId);
    if (!contact) {
      return null;
    }

    if (contact.unknownAxes?.length) {
      return {
        ...this.evaluateUnknownContact(contact, frame.arrivedAt),
        ...this.penFields(contact),
      };
    }

    const { x: downX, y: downY } = contact.scaler.toScreenPoint(contact.startX, contact.startY);
    const { x: upX, y: upY } = contact.scaler.toScreenPoint(contact.lastX, contact.lastY);
    const durationMs = frame.arrivedAt - contact.arrivedAt;
    const displacement = dist(downX, downY, upX, upY);
    const slopPx = GESTURE_THRESHOLDS.TOUCH_SLOP_DP * this.densityDp;

    const gesture =
      displacement < slopPx
        ? this.evaluateTapOrLongPress(downX, downY, durationMs, {
            arrivedAt: frame.arrivedAt,
            toolType: contact.pen.toolType,
          })
        : this.evaluateSwipe(
            { x: downX, y: downY },
            { x: upX, y: upY },
            durationMs,
            frame.arrivedAt,
          );
    return { ...gesture, ...this.downStamp(contact), ...this.penFields(contact) };
  }

  /** Optional pen/pressure fields; empty (so the event keeps its finger shape) without pen data. */
  private penFields(contact: ContactInfo): Partial<GestureEvent> {
    const { toolType, buttons, pressureCount, pressureSum, pressureMin, pressureMax } = contact.pen;
    const fields: Partial<GestureEvent> = {};
    if (toolType) {
      fields.toolType = toolType;
    }
    if (pressureCount > 0) {
      const range = this.pressureRange;
      const scale = (raw: number): number =>
        Math.round((range ? clamp01((raw - range.min) / (range.max - range.min)) : raw) * 1e4) /
        1e4;
      fields.pressure = {
        min: scale(pressureMin),
        max: scale(pressureMax),
        mean: scale(pressureSum / pressureCount),
        normalized: range !== undefined,
      };
    }
    if (contact.pen.tiltCount > 0) {
      fields.tilt = Math.min(
        Math.PI / 2,
        Math.round((contact.pen.tiltSum / contact.pen.tiltCount) * 1e4) / 1e4,
      );
    }
    if (buttons.size > 0) {
      fields.buttons = [...buttons];
    }
    return fields;
  }

  private evaluateUnknownContact(contact: ContactInfo, arrivedAt: number): GestureEvent {
    this.lastTap = null;
    const durationMs = arrivedAt - contact.arrivedAt;
    // An axis never observed contributes no displacement. Use the same finite
    // anchor at both ends solely for distance scaling (including rotation),
    // never as an exported coordinate or a reconstructed starting point.
    const firstX = Number.isFinite(contact.startX) ? contact.startX : 0;
    const firstY = Number.isFinite(contact.startY) ? contact.startY : 0;
    const lastX = Number.isFinite(contact.lastX) ? contact.lastX : firstX;
    const lastY = Number.isFinite(contact.lastY) ? contact.lastY : firstY;
    const displacement = screenDist(contact.scaler, firstX, firstY, { rawX2: lastX, rawY2: lastY });
    const type =
      displacement >= GESTURE_THRESHOLDS.TOUCH_SLOP_DP * this.densityDp
        ? "swipe"
        : durationMs >= GESTURE_THRESHOLDS.LONG_PRESS_MS
          ? "longPress"
          : "tap";
    return { type, arrivedAt, durationMs, unknownAxes: contact.unknownAxes };
  }

  private maybeEmitPinch(arrivedAt: number): GestureEvent | null {
    const pinch = this.pinchState;
    if (pinch?.unknownAxes?.length) {
      this.lastTap = null;
      return null;
    }
    if (
      !pinch ||
      pinch.initialDist === undefined ||
      pinch.finalDist === undefined ||
      pinch.initialDist === 0
    ) {
      return null;
    }

    const scale = pinch.finalDist / pinch.initialDist;
    if (Math.abs(scale - 1.0) < GESTURE_THRESHOLDS.PINCH_MIN_SCALE_DELTA) {
      return null;
    }

    return {
      type: "pinch",
      arrivedAt,
      scale,
      pinchDirection: scale < 1 ? "in" : "out",
    };
  }

  private evaluateTapOrLongPress(
    screenX: number,
    screenY: number,
    durationMs: number,
    { arrivedAt, toolType }: { arrivedAt: number; toolType?: PointerToolType },
  ): GestureEvent {
    if (durationMs >= GESTURE_THRESHOLDS.LONG_PRESS_MS) {
      return { type: "longPress", arrivedAt, screenX, screenY, durationMs };
    }

    // Check for double-tap
    if (this.lastTap && this.lastTap.toolType === toolType) {
      const timeSinceLast = arrivedAt - this.lastTap.arrivedAt;
      const separation = dist(screenX, screenY, this.lastTap.screenX, this.lastTap.screenY);
      const slopPx = GESTURE_THRESHOLDS.DOUBLE_TAP_SLOP_DP * this.densityDp;

      if (timeSinceLast <= GESTURE_THRESHOLDS.DOUBLE_TAP_MS && separation <= slopPx) {
        const firstTapArrivedAt = this.lastTap.arrivedAt;
        this.lastTap = null;
        return { type: "doubleTap", arrivedAt, screenX, screenY, firstTapArrivedAt };
      }
    }

    this.lastTap = { screenX, screenY, arrivedAt, toolType };
    return { type: "tap", arrivedAt, screenX, screenY };
  }

  private evaluateSwipe(
    down: Point,
    up: Point,
    durationMs: number,
    arrivedAt: number,
  ): GestureEvent {
    const { x: downX, y: downY } = down;
    const { x: upX, y: upY } = up;
    const dx = upX - downX;
    const dy = upY - downY;
    const displacement = dist(downX, downY, upX, upY);

    const direction: GestureEvent["direction"] =
      Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";

    const velocityPxPerSec = durationMs > 0 ? (displacement / durationMs) * 1000 : 0;
    const flingThreshPx = GESTURE_THRESHOLDS.FLING_MIN_DP_PER_S * this.densityDp;
    const speed: GestureEvent["speed"] = velocityPxPerSec >= flingThreshPx ? "fast" : "normal";

    return {
      type: "swipe",
      arrivedAt,
      direction,
      startX: downX,
      startY: downY,
      endX: upX,
      endY: upY,
      speed,
    };
  }
}

function screenDist(
  scaler: CoordScaler,
  rawX1: number,
  rawY1: number,
  { rawX2, rawY2 }: { rawX2: number; rawY2: number },
): number {
  const first = scaler.toScreenPoint(rawX1, rawY1);
  const second = scaler.toScreenPoint(rawX2, rawY2);
  return dist(first.x, first.y, second.x, second.y);
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function mergeUnknownAxes(
  first: GestureEvent["unknownAxes"],
  second: GestureEvent["unknownAxes"],
): GestureEvent["unknownAxes"] {
  if (!first?.length && !second?.length) {
    return undefined;
  }
  return [...new Set([...(first ?? []), ...(second ?? [])])];
}

function newPenObservation(): PenObservation {
  return {
    buttons: new Set(),
    pressureCount: 0,
    pressureSum: 0,
    pressureMin: Infinity,
    pressureMax: -Infinity,
    tiltCount: 0,
    tiltSum: 0,
  };
}

function observePen(
  pen: PenObservation,
  slot: RawTouchFrame["activeSlots"][number],
  tiltAxes?: TiltAxes,
): void {
  if (slot.toolType) {
    pen.toolType = slot.toolType;
  }
  for (const button of slot.buttons ?? []) {
    pen.buttons.add(button);
  }
  if (slot.toolType === "stylus" || slot.toolType === "eraser") {
    observeTilt(pen, slot, tiltAxes);
  }

  // A zero pressure sample means "not reported" for fingers and "no force" for a pen; neither
  // is a measurement worth averaging.
  if (slot.pressure > 0) {
    pen.pressureCount += 1;
    pen.pressureSum += slot.pressure;
    pen.pressureMin = Math.min(pen.pressureMin, slot.pressure);
    pen.pressureMax = Math.max(pen.pressureMax, slot.pressure);
  }
}

function observeTilt(
  pen: PenObservation,
  slot: RawTouchFrame["activeSlots"][number],
  tiltAxes?: TiltAxes,
): void {
  if (
    tiltAxes &&
    validTiltAxis(tiltAxes.x) &&
    validTiltAxis(tiltAxes.y) &&
    slot.tiltX !== undefined &&
    slot.tiltY !== undefined &&
    Number.isFinite(slot.tiltX) &&
    Number.isFinite(slot.tiltY)
  ) {
    // TouchInputMapper centers each range and uses units/radian resolution when reported;
    // zero or absent resolution means the legacy degree axis (PI/180).
    const x = tiltAngle(slot.tiltX, tiltAxes.x);
    const y = tiltAngle(slot.tiltY, tiltAxes.y);
    const cosine = Math.cos(x) * Math.cos(y);
    pen.tiltCount += 1;
    pen.tiltSum += Math.acos(clamp01(cosine));
  }
}

function tiltAngle(raw: number, axis: TiltAxes["x"]): number {
  const scale = axis.resolution ? 1 / axis.resolution : Math.PI / 180;
  return (raw - (axis.min + axis.max) / 2) * scale;
}

function validTiltAxis(axis: TiltAxes["x"]): boolean {
  return (
    Number.isFinite(axis.min) &&
    Number.isFinite(axis.max) &&
    axis.max > axis.min &&
    (axis.resolution === undefined || (Number.isFinite(axis.resolution) && axis.resolution >= 0))
  );
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
