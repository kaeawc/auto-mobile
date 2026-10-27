import { z } from "zod";

/**
 * The verifiable log of haptic and sound calls (#14329): a device keeps the last 64 per
 * prototype and reports them in `inspect` as `feedbackLog`, oldest first. Each entry names exactly
 * one of `effect` (`haptics.perform`) or `sound` (`sound.play`); `nodeId` is the node whose action
 * made the call (absent for a platform handler); `suppressed` is true when a system setting or the
 * ringer stopped the feedback.
 */
export const MAX_PROTOTYPE_FEEDBACK_LOG_ENTRIES = 64;

export const prototypeFeedbackEntrySchema = z
  .object({
    timeMs: z.number().int().safe().nonnegative(),
    effect: z.string().min(1).max(32).optional(),
    sound: z.string().min(1).max(32).optional(),
    nodeId: z.string().min(1).max(256).optional(),
    suppressed: z.literal(true).optional(),
  })
  .refine((entry) => (entry.effect === undefined) !== (entry.sound === undefined));

export type PrototypeFeedbackEntry = z.infer<typeof prototypeFeedbackEntrySchema>;

/** Well-formed entries of a device report, newest 64 kept; absent when none are. */
export function parsePrototypeFeedbackLog(value: unknown): PrototypeFeedbackEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.flatMap((entry) => {
    const parsed = prototypeFeedbackEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return entries.length > 0 ? entries.slice(-MAX_PROTOTYPE_FEEDBACK_LOG_ENTRIES) : undefined;
}
