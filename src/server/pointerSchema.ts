import { z } from "zod/v4";

/**
 * Shared `pointer` option of the coordinate gestures. Strict so a tilt, button or eraser
 * request is a malformed parameter instead of being ignored; `pressure` is accepted in range but
 * the Android backend only injects 1.0 and refuses the rest at dispatch (#13081).
 */
export const pointerSchema = z
  .object({
    toolType: z
      .enum(["stylus"])
      .describe("Inject a stylus instead of a finger (Android 12+, API 31+)"),
    pressure: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Stylus pressure 0-1; the Android backend injects 1.0 only and refuses other values",
      ),
  })
  .strict()
  .describe(
    "Pointer for this gesture; omit for a finger. Fails with a capability error instead of falling back to a finger.",
  );
