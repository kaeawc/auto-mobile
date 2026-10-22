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
    contentSize: z.string().optional(),
    // Android runtime geometry (#14101); `current`/`applied` report the effective pixel size.
    size: z
      .union([
        z.object({ width: z.number(), height: z.number() }).passthrough(),
        z.literal("default"),
      ])
      .optional(),
    navigationMode: z.enum(["gesture", "threeButton", "twoButton", "default"]).optional(),
    displayCutout: z.enum(["none", "corner", "double", "hole", "tall", "waterfall"]).optional(),
    increaseContrast: z.boolean().optional(),
    reduceMotion: z.boolean().optional(),
    boldText: z.boolean().optional(),
    colorInversion: z.boolean().optional(),
    colorCorrection: z.string().optional(),
    magnification: z.boolean().optional(),
    magnificationScale: z.number().optional(),
    extraDim: z.boolean().optional(),
  })
  .passthrough();

const accessibilityDisplaySupportOutputSchema = z.union([z.boolean(), z.literal("partial")]);

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
        size: accessibilityDisplaySupportOutputSchema.optional(),
        navigationMode: z.boolean().optional(),
        displayCutout: z.boolean().optional(),
        increaseContrast: accessibilityDisplaySupportOutputSchema.optional(),
        reduceMotion: accessibilityDisplaySupportOutputSchema.optional(),
        boldText: accessibilityDisplaySupportOutputSchema.optional(),
        colorInversion: accessibilityDisplaySupportOutputSchema.optional(),
        colorCorrection: accessibilityDisplaySupportOutputSchema.optional(),
        magnification: accessibilityDisplaySupportOutputSchema.optional(),
        magnificationScale: accessibilityDisplaySupportOutputSchema.optional(),
        extraDim: accessibilityDisplaySupportOutputSchema.optional(),
      })
      .passthrough(),
    supportNotes: z
      .object({
        increaseContrast: z.string().optional(),
        reduceMotion: z.string().optional(),
        boldText: z.string().optional(),
        colorInversion: z.string().optional(),
        colorCorrection: z.string().optional(),
        magnification: z.string().optional(),
        magnificationScale: z.string().optional(),
        extraDim: z.string().optional(),
      })
      .passthrough()
      .optional(),
    available: z
      .object({ navigationMode: z.array(z.string()), displayCutout: z.array(z.string()) })
      .passthrough()
      .optional(),
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
