import { z } from "zod/v4";
import { KILL_PROFILE_EVIDENCE_STATUSES, KILL_PROFILE_IDS } from "../features/utility/KillProfiles";

const stepSchema = z
  .object({
    step: z.string(),
    command: z.string(),
    status: z.enum(["applied", "unsupported", "failed"]),
    reason: z.string().optional(),
  })
  .passthrough();

/** Failures that changed nothing throw, so a result always describes a completed call. */
export const killProfileResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    action: z.enum(["apply", "reset", "list"]),
    deviceId: z.string(),
    appId: z.string().optional(),
    status: z.enum(["applied", "partial", "unsupported"]).optional(),
    source: z.enum(["recorded", "baseline", "none"]).optional(),
    profile: z
      .object({
        id: z.enum(KILL_PROFILE_IDS),
        version: z.number(),
        evidenceStatus: z.enum(KILL_PROFILE_EVIDENCE_STATUSES),
        evidenceNote: z.string(),
        source: z.string().optional(),
      })
      .passthrough()
      .optional(),
    steps: z.array(stepSchema).optional(),
    restore: z
      .object({ commands: z.array(z.string()), onSessionRelease: z.boolean() })
      .passthrough()
      .optional(),
    profiles: z.array(z.object({ id: z.enum(KILL_PROFILE_IDS) }).passthrough()).optional(),
    nonEmulatable: z.array(z.object({ id: z.string(), note: z.string() })).optional(),
  })
  .passthrough();
