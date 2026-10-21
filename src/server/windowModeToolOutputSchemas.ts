import { z } from "zod/v4";

const boundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

const taskWindowSchema = z.object({
  taskId: z.number(),
  windowingMode: z.string(),
  bounds: boundsSchema.optional(),
});

/** `success` is false when the read-back did not reach the requested mode (#14115). */
export const windowModeResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    appId: z.string(),
    windowingMode: z
      .string()
      .optional()
      .describe(
        "The app task's mode after the call: fullscreen, pinned, freeform, multi-window, ...",
      ),
    taskId: z.number().optional(),
    bounds: boundsSchema.optional().describe("The app task's bounds in display pixels"),
    previous: taskWindowSchema.optional(),
    partner: taskWindowSchema.extend({ appId: z.string() }).optional(),
    method: z.string().optional().describe("The shell command whose read-back reached the mode"),
    attempts: z.array(
      z.object({
        command: z.string(),
        outcome: z.enum(["reached", "not_reached", "failed"]),
        error: z.string().optional(),
      }),
    ),
    settingsChanged: z.array(z.string()),
    settingsRestored: z.array(z.string()).optional(),
    reason: z.string().optional(),
    restore: z
      .object({
        mode: z.unknown().optional(),
        settings: z
          .object({
            deviceId: z.string(),
            bootId: z.string(),
            entries: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
          })
          .optional(),
      })
      .optional()
      .describe("Pass back as restore to put the window and the freeform settings back"),
  })
  .passthrough();
