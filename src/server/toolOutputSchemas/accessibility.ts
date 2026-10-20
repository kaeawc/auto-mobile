import { z } from "zod/v4";
import { elementSchema } from "./elements";

// Unavailable status reads (TalkBack on Android, VoiceOver on iOS) return service + reason
// without asserting enabled.
export const accessibilityStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.enum(["talkback", "voiceover", "unknown"]),
    warning: z.string().optional(),
    blockingPrompt: z
      .object({
        kind: z.literal("runtime-permission"),
        package: z.string(),
        activity: z.string(),
      })
      .optional(),
    // Present on the `accessibility` tool's state check only when a feature flag changes what
    // the action tools assume. `enabled` stays the device's reading (#10222).
    detectionOverride: z
      .object({
        mode: z.enum(["forced-on", "auto-detect-off"]),
        effectiveEnabled: z.boolean(),
      })
      .optional(),
  })
  .passthrough();

export const accessibilityFocusResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    warning: z.string().optional(),
    focusedElement: elementSchema.optional(),
    confirmed: z.boolean().optional(),
    alreadySatisfied: z.boolean().optional(),
  })
  .passthrough();
