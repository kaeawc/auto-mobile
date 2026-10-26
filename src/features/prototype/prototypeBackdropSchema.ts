import { z } from "zod";
import { MAX_PROTOTYPE_BACKDROP_BLUR_DP, PROTOTYPE_BACKDROP_MATERIALS } from "./prototypeBackdrop";
import { colorTokenSchema } from "./prototypePresentationSchemas";

/** `window.backdrop` (#15126); see prototypeBackdrop.ts for the design choices. */
export const prototypeBackdropSchema = z
  .object({
    material: z
      .enum(PROTOTYPE_BACKDROP_MATERIALS)
      .describe(
        "Frosted material behind the window: ultraThin, thin, regular, thick, or glass (Liquid Glass on iOS 26+; the fallback dim elsewhere)",
      ),
    blur: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(MAX_PROTOTYPE_BACKDROP_BLUR_DP)
      .optional()
      .describe("Blur radius in dp (points on iOS), 0-150; absent uses the material's own radius"),
    tint: colorTokenSchema
      .optional()
      .describe(
        "One colour (hex or Material role, not a per-mode pair) laid over the blur, and the solid fallback where blur is unavailable",
      ),
  })
  .strict()
  .describe(
    "Blur what is behind the window (needs prototype_backdrop_v1). The show result reports backdrop blur or fallback; fallback is a tonal fill (tint at 85% alpha, else the surfaceContainer role at 85%) where blur is unavailable",
  );
