import { z } from "zod/v4";

/**
 * Shared `pointer` option of the coordinate gestures. Strict so an unknown field is a malformed
 * parameter instead of being ignored. Plain stylus uses `adb input stylus`; pressure other than 1,
 * tilt, orientation and buttons use instrumentation or root-only uinput (#13081, #13099, #13084);
 * an eraser uses the uinput route only (#13105), with the same axes and buttons.
 */
export const pointerSchema = z
  .object({
    toolType: z
      .enum(["stylus", "eraser"])
      .describe(
        "Inject a stylus, or the pen's eraser end, instead of a finger (Android 12+, API 31). Pressure other than 1, tilt, orientation, buttons and any dragPath need stylus_input_v1 or a root adb shell with a uinput tool. An eraser needs a root adb shell with a uinput tool and supports pressure, tilt, orientation and buttons",
      ),
    pressure: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Stylus pressure 0-1. 1 or omitted uses the shell route; any other value needs stylus_input_v1 (Android 12+) or a root adb shell with a uinput tool, and is refused before input otherwise",
      ),
    tilt: z
      .number()
      .min(0)
      .max(Math.PI / 2)
      .optional()
      .describe("Stylus tilt in radians from the surface normal, 0 to PI/2 (Android 12+)"),
    orientation: z
      .number()
      .min(-Math.PI)
      .max(Math.PI)
      .optional()
      .describe("Stylus orientation in radians, -PI to PI (Android 12+)"),
    buttons: z
      .array(z.enum(["primary", "secondary"]))
      .min(1)
      .max(2)
      .refine((buttons) => new Set(buttons).size === buttons.length, "buttons must not repeat")
      .optional()
      .describe("Barrel buttons held for the gesture (Android 12+)"),
  })
  .strict()
  .describe(
    "Pointer for this gesture; omit for a finger. Fails with a capability error instead of falling back to a finger.",
  );
