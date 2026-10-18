import { z } from "zod/v4";

/** `message` plus `PostNotificationResult` (src/models/PostNotificationResult.ts). */
export const postNotificationResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    supported: z.boolean(),
    method: z.enum(["sdk", "simctlPush"]).optional(),
    imageType: z.enum(["normal", "bigPicture"]).optional(),
    appId: z.string().optional(),
    channelId: z.string().optional(),
    warning: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** Mirrors `NotificationPolicyAccessState` (src/features/utility/NotificationPolicy.ts). */
const policyAccessSchema = z
  .object({
    supported: z.boolean(),
    allowed: z.boolean().nullable().optional(),
    method: z
      .enum([
        "android_cmd_notification",
        "android_dumpsys_notification",
        "ios_bulletinboard_plist",
        "unsupported",
      ])
      .optional(),
    rawValue: z.string().optional(),
    warning: z.string().optional(),
    error: z.string().optional(),
    authorizationStatus: z
      .enum(["notDetermined", "denied", "authorized", "provisional", "ephemeral"])
      .optional(),
    lockScreen: z.boolean().optional(),
    notificationCenter: z.boolean().optional(),
    alerts: z.boolean().optional(),
  })
  .passthrough();

/** `message` plus `NotificationPolicyResult`. */
export const notificationPolicyResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    appId: z.string(),
    deviceId: z.string(),
    platform: z.enum(["android", "ios"]),
    policyAccess: policyAccessSchema,
    error: z.string().optional(),
  })
  .passthrough();

export const getNotificationPolicyResultSchema = notificationPolicyResultSchema;
export const setNotificationPolicyResultSchema = notificationPolicyResultSchema;
