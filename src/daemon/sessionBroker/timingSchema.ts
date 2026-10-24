import { z } from "zod";
import type { SessionBrokerTiming } from "../../devices/sessionBrokerResult";
import { logger } from "../../utils/logger";
import { exactProfile } from "./profile";

const duration = z.number().finite().nonnegative();
const timestamp = z.number().finite();
const timing: z.ZodType<SessionBrokerTiming> = z.object({
  acquisition: z
    .object({
      admission: z.enum(["reuse", "create", "evict-then-create", "wait"]),
      reuseCount: duration.int(),
      outcome: z.enum(["pending", "ready", "failed"]),
      startedAtMs: timestamp,
      completedAtMs: timestamp.optional(),
      queueMs: duration,
      admissionWaitMs: duration,
      createMs: duration.optional(),
      bootMs: duration.optional(),
      automationReadyMs: duration.optional(),
      totalMs: duration,
    })
    .optional(),
  reset: z
    .object({
      mode: z.enum(["keep-booted", "erase", "snapshot", "wipe-data", "none"]),
      outcome: z.enum([
        "clean",
        "pending",
        "destroyed",
        "fallback:keep-booted",
        "fallback:erase",
        "fallback:snapshot",
        "fallback:wipe-data",
        "fallback:destroy",
      ]),
      retired: z.boolean().optional(),
      phases: z.record(z.string(), duration),
      fallbackReason: z.string().optional(),
      reuseCount: duration.int(),
      startedAtMs: timestamp,
      completedAtMs: timestamp.optional(),
      totalMs: duration,
    })
    .optional(),
});
const receipt = z.object({ timing, profile: exactProfile.optional() });

export function parseTimingReceipt(timingJson: string, profileJson?: string | null) {
  try {
    const parsed = receipt.safeParse({
      timing: JSON.parse(timingJson),
      ...(profileJson ? { profile: JSON.parse(profileJson) } : {}),
    });
    if (parsed.success) {
      return parsed.data;
    }
    logger.warn("Ignoring invalid session broker timing receipt", parsed.error);
    return undefined;
  } catch (error) {
    logger.warn("Ignoring corrupt session broker timing JSON", error);
    return undefined;
  }
}
