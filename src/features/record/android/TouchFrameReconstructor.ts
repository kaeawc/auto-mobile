import type {
  RawTouchFrame,
  TouchSlot,
  GestureEvent,
  PointerToolType,
  StylusButton,
} from "./types";

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
  /** Pen tool in range (BTN_TOOL_PEN / BTN_TOOL_RUBBER); node-wide, applied to active slots. */
  private nodeTool: PointerToolType | undefined;
  private readonly heldButtons = new Set<StylusButton>();

  constructor(private readonly options: { singleTouch?: boolean } = {}) {}

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
      this.handleAbsEvent(evCode, evValue);
      return null;
    }

    if (evType === "EV_SYN") {
      return this.handleSynEvent(evCode, evValue, arrivedAt);
    }

    if (evType === "EV_KEY") {
      const button = evValue === "DOWN" ? KEY_TO_BUTTON[evCode] : undefined;
      if (button) {
        return { type: "pressButton", arrivedAt, button };
      }
      this.handleKeyEvent(evCode, evValue === "DOWN" || evValue === "REPEAT");
    }

    return null;
  }

  private handleAbsEvent(evCode: string, evValue: string): void {
    const value = parseInt(evValue, 16);

    switch (evCode) {
      case "ABS_MT_SLOT":
        this.currentSlot = value;
        break;

      case "ABS_MT_TRACKING_ID":
        if (evValue === "ffffffff") {
          // Finger lifted — mark slot as released
          const slot = this.slots.get(this.currentSlot);
          if (slot && slot.trackingId >= 0) {
            this.releasedSlots.add(slot.slotId);
            slot.trackingId = -1;
          }
        } else {
          // New or continuing contact
          this.getOrCreateSlot().trackingId = value;
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
  }

  private handlePenAbsEvent(evCode: string, value: number): void {
    switch (evCode) {
      case "ABS_MT_TOOL_TYPE":
        // MT_TOOL_FINGER (0) is the default and stays absent; MT_TOOL_PEN (1) is a stylus.
        if (value === 1) {
          this.getOrCreateSlot().toolType = "stylus";
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

  private handleKeyEvent(evCode: string, pressed: boolean): void {
    switch (evCode) {
      case "BTN_TOOL_PEN":
        this.setNodeTool("stylus", pressed);
        break;
      case "BTN_TOOL_RUBBER":
        this.setNodeTool("eraser", pressed);
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
        }
        break;
      default:
        break;
    }
  }

  private setNodeTool(tool: PointerToolType, pressed: boolean): void {
    if (pressed) {
      this.nodeTool = tool;
    } else if (this.nodeTool === tool) {
      this.nodeTool = undefined;
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

    for (const [, slot] of this.slots) {
      if (slot.trackingId >= 0) {
        activeSlots.push(this.withPenState({ ...slot }));
      } else if (this.releasedSlots.has(slot.slotId)) {
        releasedSlots.push(slot.slotId);
      }
    }

    this.releasedSlots.clear();

    // Protocol B retains each slot's axes and pressure after contact release.
    // Release notifications are per-frame; inactive slots stay out of activeSlots.

    return { arrivedAt, activeSlots, releasedSlots };
  }

  /** Pen fields are added only when present, so finger frames keep their exact shape. */
  private withPenState(slot: TouchSlot): TouchSlot {
    if (!slot.toolType && this.nodeTool) {
      slot.toolType = this.nodeTool;
    }
    if (this.heldButtons.size > 0) {
      slot.buttons = [...this.heldButtons];
    }
    return slot;
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
