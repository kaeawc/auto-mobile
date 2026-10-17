import { z } from "zod/v4";

/** Success and failure both carry the payload; a failure also sets the wire `isError` flag. */
export const changeLocalizationResultSchema = z
  .object({
    success: z.boolean(),
    changes: z
      .object({
        locale: z.string().optional(),
        timeZone: z.string().optional(),
        textDirection: z.enum(["ltr", "rtl"]).optional(),
        timeFormat: z.enum(["12", "24"]).optional(),
        calendarSystem: z.string().optional(),
      })
      .passthrough(),
    intentBroadcast: z.boolean(),
    localeScope: z.enum(["app", "system"]).optional(),
    localeAppId: z.string().optional(),
    localeMethod: z.string().optional(),
    warning: z.string().optional(),
    timeZoneWarning: z.string().optional(),
    iosLiveChanges: z
      .object({
        springBoardRestarted: z.boolean(),
        notificationPosted: z.boolean(),
        appRestarted: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    error: z.string().optional(),
  })
  .passthrough();

const displayThemeOutputSchema = z.enum(["light", "dark", "system", "custom"]);

const displayConfigValuesOutputSchema = z
  .object({
    fontScale: z.union([z.number(), z.literal("default")]).optional(),
    density: z.union([z.number(), z.enum(["smaller", "default", "larger"])]).optional(),
    theme: displayThemeOutputSchema.optional(),
  })
  .passthrough();

/** `message` is optional because the DisplayConfig result's own `message` is spread over it. */
export const displayConfigResultSchema = z
  .object({
    message: z.string().optional(),
    success: z.boolean(),
    deviceId: z.string(),
    platform: z.enum(["android", "ios"]),
    supported: z
      .object({
        fontScale: z.boolean(),
        density: z.union([z.boolean(), z.literal("partial")]),
        theme: z.boolean(),
      })
      .passthrough(),
    current: displayConfigValuesOutputSchema.optional(),
    applied: displayConfigValuesOutputSchema.optional(),
    previous: displayConfigValuesOutputSchema.optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** Selection failures throw; `displayPin` is a string, or null once a pin was cleared. */
export const setActiveDeviceResultSchema = z
  .object({
    message: z.string(),
    deviceId: z.string(),
    sessionUuid: z.string().optional(),
    displayPin: z.string().nullable().optional(),
  })
  .passthrough();
