import { z } from "zod/v4";

/**
 * The `observe.androidAuto` block while a phone projects to a head unit through Android Auto
 * (#17841). Everything in it is read from `dumpsys activity services`; what that dump cannot say
 * (which app the head unit shows, the head unit's config, resolution or screen) is not reported.
 */

export const ANDROID_AUTO_PROJECTION_NOTE =
  "Read from the services Android Auto has bound. Android Auto keeps every connected app bound " +
  "while another app is on the head unit, so the visible app is unknown and no app is marked " +
  "visible. The head unit's config, resolution and screen are not reported.";

const androidAutoProjectedAppSchema = () =>
  z
    .object({
      packageName: z.string(),
      userId: z.number().int().describe("The Android user the app's bound service runs as."),
      services: z
        .array(z.string())
        .describe("Components (<package>/<class>) Android Auto holds a live binding to, sorted."),
    })
    .passthrough();

export const androidAutoProjectionSchema = z
  .object({
    projecting: z.literal(true),
    projectedBy: z.string().describe("The projecting host package (Android Auto)."),
    templateHosts: z
      .array(z.string())
      .describe(
        "Android Auto's bound Car App Library template host services, one per app category, sorted.",
      ),
    apps: z
      .array(androidAutoProjectedAppSchema())
      .describe(
        "Bound apps whose AutoMobile SDK template route answered (so they are Car App Library apps), " +
          "ordered by package name. Their templates are in carAppTemplates.projected[].",
      ),
    note: z.string(),
  })
  .passthrough();

export type AndroidAutoProjection = z.infer<typeof androidAutoProjectionSchema>;
export type AndroidAutoProjectedApp = AndroidAutoProjection["apps"][number];
