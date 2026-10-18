import { z } from "zod/v4";

const successSchema = z
  .object({
    success: z.literal(true),
    sessionUuid: z.string(),
    deviceId: z.string(),
    platform: z.literal("android"),
    directory: z.string(),
    userId: z.number(),
    userSource: z.enum([
      "explicit",
      "currentUser",
      "foregroundPackage",
      "managedProfile",
      "primary",
    ]),
    destinationDirectory: z.string(),
    reset: z.boolean(),
    files: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const unavailableSchema = z
  .object({
    success: z.literal(false),
    sessionUuid: z.string(),
    deviceId: z.string(),
    platform: z.literal("ios"),
    status: z.literal("unavailable"),
    reason: z.string(),
  })
  .passthrough();

/** Mirrors `StageSessionDownloadsResult` (downloadsFixtureContract.ts). */
export const stageSessionDownloadsResultSchema = z.union([successSchema, unavailableSchema]);
