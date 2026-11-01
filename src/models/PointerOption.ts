/** A stylus barrel button. */
export type StylusButton = "primary" | "secondary";

/**
 * Input pointer for a coordinate gesture. Omitted means the default finger touch.
 *
 * Plain `stylus` at full pressure goes through `adb shell input stylus`, which hard-codes pressure to
 * 1.0 (#13081). Any other pressure, a tilt or orientation, or a barrel button needs the instrumentation
 * route (`stylus_input_v1`, Android 12+) and is refused before any input when the device lacks it, never
 * rounded or sent as a finger (#13099).
 */
export interface PointerOption {
  /** An eraser is the pen's rubber end; only a pointer route injects it (`adb input` cannot). */
  toolType: "stylus" | "eraser";
  /** 0–1. Anything but 1 needs the instrumentation route. */
  pressure?: number;
  /** Radians from the surface normal (`AXIS_TILT`), 0 to PI/2. Android only. */
  tilt?: number;
  /** Radians (`AXIS_ORIENTATION`), -PI to PI. Android only. */
  orientation?: number;
  /** Barrel buttons held for the whole gesture. Android only. */
  buttons?: StylusButton[];
}

/** True when [pointer] asks for more than `adb input stylus` can inject. */
export function pointerNeedsInstrumentation(pointer: PointerOption | undefined): boolean {
  return (
    pointer !== undefined &&
    (pointer.toolType === "eraser" ||
      (pointer.pressure !== undefined && pointer.pressure !== 1) ||
      pointer.tilt !== undefined ||
      pointer.orientation !== undefined ||
      (pointer.buttons?.length ?? 0) > 0)
  );
}

/** `MotionEvent.BUTTON_STYLUS_PRIMARY` (32) and `BUTTON_STYLUS_SECONDARY` (64) as a state mask. */
export function stylusButtonMask(buttons: readonly StylusButton[] | undefined): number {
  return (buttons ?? []).reduce((mask, button) => mask | (button === "primary" ? 32 : 64), 0);
}
