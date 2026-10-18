import { z } from "zod/v4";

/** Mirrors `PreferenceResult` (src/features/preferences/AppPreferences.ts). */
export const preferenceResultSchema = z
  .object({
    success: z.boolean(),
    deviceId: z.string(),
    platform: z.enum(["android", "ios"]),
    scope: z.enum(["systemProperty", "sharedPreferences", "userDefaults"]),
    appId: z.string().optional(),
    suite: z.string().optional(),
    key: z.string(),
    userId: z.number().optional(),
    value: z.union([z.string(), z.boolean(), z.number(), z.array(z.string())]).nullable(),
    type: z.string().optional(),
    found: z.boolean(),
    verified: z.boolean().optional(),
    redacted: z.literal(true).optional(),
    valueFormat: z.enum(["canonical-json", "sdk-description"]).optional(),
    warning: z.string().optional(),
    resolvedStore: z.string().optional(),
    storeRoute: z.enum(["sdk", "container-plist", "defaults"]).optional(),
  })
  .passthrough();

export const getPreferenceResultSchema = preferenceResultSchema;
export const setPreferenceResultSchema = preferenceResultSchema;
