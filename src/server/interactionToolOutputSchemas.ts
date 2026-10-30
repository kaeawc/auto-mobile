import { z } from "zod/v4";
import { elementBoundsSchema } from "./toolOutputSchemas/display";
import { lifecycleActionOutputFields } from "./toolOutputSchemas/actions";

/**
 * Each interaction result has one shape for both outcomes: `message` and `success` are
 * always present, a failure adds `error` and marks the envelope `isError`, and every
 * outcome-specific field is optional. A single object keeps the required fields a
 * spilled response must retain. Nested pieces are built per field: a schema instance
 * reused across fields is advertised as a `$ref`.
 */
const actionResultFields = {
  ...lifecycleActionOutputFields,
  success: z.boolean(),
};

/** Gesture timings the accessibility service reports for an a11y-dispatched gesture. */
const a11yGestureTimingFields = () => ({
  a11yTotalTimeMs: z.number().optional(),
  a11yGestureTimeMs: z.number().optional(),
});

export const selectAllTextResultSchema = z.object(actionResultFields).passthrough();

export const pinchOnResultSchema = z
  .object({
    ...actionResultFields,
    direction: z.enum(["in", "out"]).optional(),
    distanceStart: z.number().optional(),
    distanceEnd: z.number().optional(),
    scale: z.number().optional(),
    duration: z.number().optional(),
    rotationDegrees: z.number().optional(),
    centerX: z.number().optional(),
    centerY: z.number().optional(),
    targetType: z.enum(["screen", "container"]).optional(),
    container: z
      .object({ elementId: z.string().optional(), text: z.string().optional() })
      .passthrough()
      .optional(),
    warning: z.string().optional(),
    ...a11yGestureTimingFields(),
  })
  .passthrough();

export const dragAndDropResultSchema = z
  .object({
    ...actionResultFields,
    duration: z.number().optional(),
    distance: z.number().optional(),
    containerFailure: z
      .object({
        level: z.number(),
        reason: z.enum(["not-found", "ambiguous"]),
        selector: z.object({}).passthrough(),
      })
      .passthrough()
      .optional(),
    ...a11yGestureTimingFields(),
  })
  .passthrough();

export const shakeResultSchema = z
  .object({
    ...actionResultFields,
    duration: z.number().optional(),
    intensity: z.number().optional(),
    restoreError: z.string().optional(),
    restoreWarning: z.string().optional(),
  })
  .passthrough();

export const recentAppsResultSchema = z
  .object({
    ...actionResultFields,
    method: z.enum(["hardware", "ios_swipe"]).optional(),
  })
  .passthrough();

export const homeScreenResultSchema = z
  .object({
    ...actionResultFields,
    navigationMethod: z.enum(["gesture", "hardware", "element"]).optional(),
  })
  .passthrough();

/** Clipboard changes no UI, so its result carries no observation. */
export const clipboardResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    action: z.enum(["copy", "paste", "clear", "get"]),
    text: z.string().optional(),
    method: z.enum(["a11y", "adb"]).optional(),
    error: z.string().optional(),
  })
  .passthrough();

const trayTextMatchSchema = () =>
  z.object({ text: z.string(), matchType: z.enum(["exact", "partial"]) }).passthrough();

const trayCountSchema = () => z.number().int().nonnegative().optional();

/**
 * One object across every systemTray action: open/close report `skipped`; find, tap and
 * dismiss report the matched texts; tap adds its target; list reports the attributed
 * notifications; clearAll reports its dismissal accounting.
 */
export const systemTrayResultSchema = z
  .object({
    ...actionResultFields,
    skipped: z.boolean().optional(),
    settled: z.boolean().optional(),
    match: z
      .object({
        title: trayTextMatchSchema().optional(),
        body: trayTextMatchSchema().optional(),
        app: trayTextMatchSchema().optional(),
        action: trayTextMatchSchema().optional(),
      })
      .passthrough()
      .optional(),
    tapTarget: z
      .object({
        text: z.string(),
        matchType: z.enum(["exact", "partial"]),
        bounds: elementBoundsSchema.optional(),
      })
      .passthrough()
      .optional(),
    notifications: z
      .array(
        z
          .object({
            id: z.string().nullable(),
            appId: z.string(),
            appLabel: z.string().nullable(),
            title: z.string().nullable(),
            body: z.string().nullable(),
            actions: z.array(z.string()),
            texts: z.array(z.string()),
            inGroup: z.boolean(),
            ownership: z.enum(["header", "dumpsys"]),
          })
          .passthrough(),
      )
      .optional(),
    unattributedRows: trayCountSchema(),
    swipes: trayCountSchema(),
    order: z.literal("encounter").optional(),
    dismissedCount: trayCountSchema(),
    expectedCount: trayCountSchema(),
    remainingCount: trayCountSchema(),
    arrivedCount: trayCountSchema(),
    swipeCount: trayCountSchema(),
    stalled: z.boolean().optional(),
  })
  .passthrough();
