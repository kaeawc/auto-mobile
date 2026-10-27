import type {
  RawTouchFrame,
  TouchSlot,
  GestureEvent,
  PointerToolType,
  StylusButton,
} from "./types";
import { PenHoverTracker } from "./PenHoverTracker";

// Mapping from Linux key codes to AutoMobile button names
const KEY_TO_BUTTON: Record<string, GestureEvent["button"]> = {
  KEY_BACK: "back",
  KEY_HOME: "home",
  KEY_MENU: "menu",
  KEY_POWER: "power",
  KEY_VOLUMEUP: "volume_up",
  KEY_VOLUMEDOWN: "volume_down",
  KEY_APPSELECT: "recent",
};

/**
 * State machine that processes `getevent -lt` text output one line at a time
 * and emits RawTouchFrame snapshots on SYN_REPORT events.
 *
 * Implements Linux Multi-Touch Protocol B (slot-based, stateful).
 *
 * Returns:
 *   - RawTouchFrame on EV_SYN SYN_REPORT (value 0x00000000)
 *   - GestureEvent { type: "pressButton" } on EV_KEY KEY_* DOWN
 *   - null for all other input lines
 *
 * With `singleTouch` (a pen digitizer that reports ABS_X/ABS_Y/ABS_PRESSURE and
 * BTN_TOUCH instead of ABS_MT_*), one pseudo slot 0 stands in for the contact:
 * BTN_TOUCH DOWN/UP begins/ends it, and a pen in range without BTN_TOUCH is
 * hover, which never becomes a contact. Non-MT axes are ignored otherwise, since
 * many multitouch screens also emit single-touch emulation that would duplicate
 * slot 0.
 */
export class TouchFrameReconstructor {
  private slots: Map<number, TouchSlot> = new Map();
  private currentSlot = 0;
  private releasedSlots = new Set<number>();
  /** Slots reported as in contact in the previous frame. */
  private touchingSlots = new Set<number>();
  /** Position of each touching slot as last emitted, to spot a move inside its release packet. */
  private readonly lastEmitted = new Map<number, { x: number; y: number }>();
  /** Pen tool in range (BTN_TOOL_PEN / BTN_TOOL_RUBBER); node-wide, applied to active slots. */
  private nodeTool: PointerToolType | undefined;
  private readonly heldButtons = new Set<StylusButton>();
  private readonly hover = new PenHoverTracker();

  constructor(
    private readonly options: {
      singleTouch?: boolean;
      /** Receives a `hover` event for each pen episode that never touched down. */
      onHover?: (event: GestureEvent) => void;
    } = {},
  ) {}

  private emitHover(event: GestureEvent | null): void {
    if (event) {
      this.options.onHover?.(event);
    }
  }

  /**
   * Feed one text line from `getevent -lt` stdout.
   *
   * Line format: "[ 78826.389007] EV_ABS    ABS_MT_POSITION_X    000001a4"
   */
  feedLine(line: string, arrivedAt: number): RawTouchFrame | GestureEvent | null {
    // Match: "[timestamp] EV_TYPE   EVENT_CODE   value"
    const match = line.match(/^\[\s*[\d.]+\]\s+(\S+)\s+(\S+)\s+(\S+)\s*$/);
    if (!match) {
      return null;
    }

    const evType = match[1];
    const evCode = match[2];
    const evValue = match[3];

    if (evType === "EV_ABS") {
      return this.handleAbsEvent(evCode, evValue, arrivedAt);
    }

    if (evType === "EV_SYN") {
      return this.handleSynEvent(evCode, evValue, arrivedAt);
    }

    if (evType === "EV_KEY") {
      const button = evValue === "DOWN" ? KEY_TO_BUTTON[evCode] : undefined;
      if (button) {
        return { type: "pressButton", arrivedAt, button };
      }
      this.handleKeyEvent(evCode, evValue === "DOWN" || evValue === "REPEAT", arrivedAt);
    }

    return null;
  }

  private handleAbsEvent(evCode: string, evValue: string, arrivedAt: number): RawTouchFrame | null {
    const value = parseInt(evValue, 16);

    switch (evCode) {
      case "ABS_MT_SLOT":
        this.currentSlot = value;
        break;

      case "ABS_MT_TRACKING_ID":
        if (evValue === "ffffffff") {
          this.releaseCurrentSlot(arrivedAt);
        } else {
          const slot = this.getOrCreateSlot();
          if (slot.trackingId >= 0 && slot.trackingId !== value) {
            // The kernel may write a new tracking id into an active slot without an
            // intermediate -1 (#13129). The old contact ended: report it released now,
            // before the slot is reused, so the new id starts a fresh contact.
            const ended = this.endedByReplacement(slot, arrivedAt);
            // The old id's episode ends like a release, so a hover that never touched is reported.
            this.emitHover(this.hover.slotReleased(slot.slotId, slot.toolType, arrivedAt));
            slot.trackingId = value;
            return ended;
          }
          // New or continuing contact. Per-slot axes (tool type, distance, tilt) are kept across a
          // new tracking id: the kernel only re-sends an ABS_MT_* / ABS_TILT_* value when it changes,
          // so a second pen contact on the slot arrives without them, and a finger replacing a pen
          // arrives with an explicit tool type 0. Stylus buttons are node-wide and never stored on
          // the slot, and a finger contact is reported without the retained tilt (withPenState).
          slot.trackingId = value;
        }
        break;

      case "ABS_MT_POSITION_X":
        this.observeAxis("x", value);
        break;

      case "ABS_MT_POSITION_Y":
        this.observeAxis("y", value);
        break;

      case "ABS_MT_PRESSURE":
        this.getOrCreateSlot().pressure = value;
        break;

      default:
        this.handlePenAbsEvent(evCode, value);
        break;
    }
    return null;
  }

  /** The contact in the current slot ended (tracking id -1); a pen that only hovered is reported. */
  private releaseCurrentSlot(arrivedAt: number): void {
    const slot = this.slots.get(this.currentSlot);
    if (!slot) {
      return;
    }
    if (slot.trackingId >= 0) {
      this.releasedSlots.add(slot.slotId);
      slot.trackingId = -1;
    }
    this.emitHover(this.hover.slotReleased(slot.slotId, slot.toolType, arrivedAt));
  }

  /** Tells the hover tracker whether a tracked multitouch pen slot is hovering or touching. */
  private observePenSlot(slot: TouchSlot): void {
    if (this.options.singleTouch || slot.toolType === undefined || slot.trackingId < 0) {
      return;
    }
    if (this.isMtPenHovering(slot)) {
      this.hover.slotHovering(slot.slotId);
    } else {
      this.hover.slotTouching(slot.slotId);
    }
  }

  /** Synthetic frame ending `replaced` while every other active slot stays down. */
  private endedByReplacement(replaced: TouchSlot, arrivedAt: number): RawTouchFrame {
    const activeSlots: TouchSlot[] = [];
    for (const [, slot] of this.slots) {
      if (slot.slotId !== replaced.slotId && slot.trackingId >= 0 && !this.isMtPenHovering(slot)) {
        activeSlots.push(this.withPenState({ ...slot }));
      }
    }
    this.releasedSlots.delete(replaced.slotId);
    this.touchingSlots.delete(replaced.slotId);
    this.lastEmitted.delete(replaced.slotId);
    return { arrivedAt, activeSlots, releasedSlots: [replaced.slotId] };
  }

  private handlePenAbsEvent(evCode: string, value: number): void {
    switch (evCode) {
      case "ABS_MT_TOOL_TYPE":
        // MT_TOOL_FINGER (0) is the default and stays absent; MT_TOOL_PEN (1) is a stylus.
        if (value === 1) {
          this.getOrCreateSlot().toolType = "stylus";
        } else {
          delete this.getOrCreateSlot().toolType;
        }
        break;

      case "ABS_X":
      case "ABS_Y":
      case "ABS_PRESSURE":
        if (this.options.singleTouch) {
          this.handleSingleTouchAxis(evCode, value);
        }
        break;

      case "ABS_TILT_X":
        this.getOrCreateSlot().tiltX = value | 0;
        break;

      case "ABS_TILT_Y":
        this.getOrCreateSlot().tiltY = value | 0;
        break;

      case "ABS_DISTANCE":
      case "ABS_MT_DISTANCE":
        this.getOrCreateSlot().distance = value;
        break;

      default:
        break;
    }
  }

  private handleSingleTouchAxis(evCode: string, value: number): void {
    this.currentSlot = 0;
    if (evCode === "ABS_X") {
      this.observeAxis("x", value);
    } else if (evCode === "ABS_Y") {
      this.observeAxis("y", value);
    } else {
      this.getOrCreateSlot().pressure = value;
    }
  }

  private handleKeyEvent(evCode: string, pressed: boolean, arrivedAt: number): void {
    switch (evCode) {
      case "BTN_TOOL_PEN":
        this.setNodeTool("stylus", pressed, arrivedAt);
        break;
      case "BTN_TOOL_RUBBER":
        this.setNodeTool("eraser", pressed, arrivedAt);
        break;
      case "BTN_STYLUS":
        this.setButton("stylusPrimary", pressed);
        break;
      case "BTN_STYLUS2":
        this.setButton("stylusSecondary", pressed);
        break;
      case "BTN_TOUCH":
        if (this.options.singleTouch) {
          this.handleSingleTouchContact(pressed);
          if (pressed) {
            this.hover.penTouched();
          }
        }
        break;
      default:
        break;
    }
  }

  private setNodeTool(tool: PointerToolType, pressed: boolean, arrivedAt: number): void {
    if (pressed) {
      this.nodeTool = tool;
      if (this.options.singleTouch) {
        this.hover.penEntered();
      }
      return;
    }
    if (this.nodeTool !== tool && this.nodeTool !== undefined) {
      return;
    }
    // undefined: the tool key went down before recording started and was never replayed.
    this.nodeTool = undefined;
    // A pen leaving range ends its contact even if the driver sent no BTN_TOUCH UP.
    if (this.options.singleTouch) {
      this.handleSingleTouchContact(false);
      this.emitHover(this.hover.penLeft(tool, arrivedAt));
    }
  }

  private setButton(button: StylusButton, pressed: boolean): void {
    if (pressed) {
      this.heldButtons.add(button);
    } else {
      this.heldButtons.delete(button);
    }
  }

  private handleSingleTouchContact(pressed: boolean): void {
    this.currentSlot = 0;
    if (pressed) {
      this.getOrCreateSlot().trackingId = 0;
      return;
    }
    const slot = this.slots.get(0);
    if (slot && slot.trackingId >= 0) {
      this.releasedSlots.add(0);
      slot.trackingId = -1;
    }
  }

  private handleSynEvent(evCode: string, evValue: string, arrivedAt: number): RawTouchFrame | null {
    if (evCode !== "SYN_REPORT") {
      return null;
    }

    // value 0x00000000 = SYN_REPORT (Protocol B)
    // value 0x00000002 = SYN_MT_REPORT (Protocol A, ignored)
    const value = parseInt(evValue, 16);
    if (value !== 0) {
      return null;
    }

    const activeSlots: TouchSlot[] = [];
    const releasedSlots: number[] = [];
    const releasedFinalSamples: TouchSlot[] = [];

    const touching = new Set<number>();
    for (const [, slot] of this.slots) {
      this.observePenSlot(slot);
      if (slot.trackingId >= 0 && !this.isMtPenHovering(slot)) {
        touching.add(slot.slotId);
        activeSlots.push(this.withPenState({ ...slot }));
        this.lastEmitted.set(slot.slotId, { x: slot.x, y: slot.y });
      } else if (
        this.releasedSlots.has(slot.slotId) ||
        (slot.trackingId >= 0 && this.touchingSlots.has(slot.slotId))
      ) {
        // A tracked MT pen that lifts into hover ends its contact just like a release.
        releasedSlots.push(slot.slotId);
        releasedFinalSamples.push(...this.takeFinalMove(slot));
      }
    }

    this.releasedSlots.clear();
    this.touchingSlots = touching;

    // Protocol B retains each slot's axes and pressure after contact release.
    // Release notifications are per-frame; inactive slots stay out of activeSlots.

    return releasedFinalSamples.length > 0
      ? { arrivedAt, activeSlots, releasedSlots, releasedFinalSamples }
      : { arrivedAt, activeSlots, releasedSlots };
  }

  /**
   * A pen driver may send its last ABS_X/Y in the same packet as BTN_TOUCH UP, and an MT pen may
   * move while lifting into hover. Returns that final sample when the released slot moved since it
   * was last emitted, so the stroke keeps its real end point.
   */
  private takeFinalMove(slot: TouchSlot): TouchSlot[] {
    const last = this.lastEmitted.get(slot.slotId);
    this.lastEmitted.delete(slot.slotId);
    return last && (last.x !== slot.x || last.y !== slot.y) ? [this.withPenState({ ...slot })] : [];
  }

  /**
   * Pen fields are added only when present, so finger frames keep their exact shape.
   *
   * Node-wide pen state (BTN_TOOL_PEN/RUBBER, BTN_STYLUS*) has no slot of its own. On a single-touch
   * pen node it belongs to the one contact. On a multitouch node only a slot the kernel tagged as a
   * pen (ABS_MT_TOOL_TYPE=MT_TOOL_PEN) takes it: BTN_TOOL_RUBBER refines that pen into an eraser and
   * stylus buttons ride on it, while every other slot stays a finger even when the kernel omitted
   * an unchanged MT_TOOL_FINGER.
   */
  private withPenState(slot: TouchSlot): TouchSlot {
    const penSlot = this.options.singleTouch || slot.toolType !== undefined;
    if (!penSlot) {
      // Tilt is retained per slot for a later pen contact, but a finger never reports it.
      delete slot.tiltX;
      delete slot.tiltY;
      return slot;
    }
    if (this.options.singleTouch) {
      // Every contact on a pen node is a pen. getevent does not replay a BTN_TOOL_* already held
      // when recording starts, so a contact with no tool key seen yet is still a stylus.
      slot.toolType = this.nodeTool ?? "stylus";
    } else if (this.nodeTool === "eraser") {
      slot.toolType = this.nodeTool;
    }
    if (this.heldButtons.size > 0) {
      slot.buttons = [...this.heldButtons];
    }
    return slot;
  }

  /**
   * An MT pen slot stays tracked while it hovers, reporting ABS_MT_DISTANCE > 0. Hover is not a
   * contact, so it must not become a tap or swipe (hover events are #13102). Single-touch pen
   * nodes use BTN_TOUCH for contact instead, and finger slots are never treated as hovering.
   */
  private isMtPenHovering(slot: TouchSlot): boolean {
    return !this.options.singleTouch && slot.toolType !== undefined && (slot.distance ?? 0) > 0;
  }

  private getOrCreateSlot(): TouchSlot {
    if (!this.slots.has(this.currentSlot)) {
      this.slots.set(this.currentSlot, {
        slotId: this.currentSlot,
        trackingId: -1,
        x: NaN,
        y: NaN,
        pressure: 0,
        unknownAxes: ["x", "y"],
      });
    }
    return this.slots.get(this.currentSlot)!;
  }

  private observeAxis(axis: "x" | "y", value: number): void {
    const slot = this.getOrCreateSlot();
    slot[axis] = value;
    slot.unknownAxes = slot.unknownAxes?.filter((unknown) => unknown !== axis);
    if (!slot.unknownAxes?.length) {
      delete slot.unknownAxes;
    }
  }
}
