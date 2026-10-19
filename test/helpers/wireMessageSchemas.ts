import { z } from "zod/v4";
import type { AppearanceSocketResponse } from "../../src/daemon/appearanceSocketTypes";
import type { DaemonRequest } from "../../src/daemon/types";
import { daemonNotificationSchema, daemonResponseSchema } from "../../src/daemon/types";
import { appearanceConfigSchema } from "../../src/db/keyedJsonConfigRepository";

/**
 * Schemas for the JSON frames tests read back from a `FakeSocket`
 * (`getWrittenMessages(schema)`). Objects pass unknown keys through so a frame keeps every key it carried and
 * exact-equality assertions still see the whole message; each schema is checked against the
 * production message type it models.
 */

export const appearanceSocketResponseSchema = z.looseObject({
  id: z.string(),
  type: z.literal("appearance_response"),
  success: z.boolean(),
  result: z
    .looseObject({
      config: appearanceConfigSchema.optional(),
      appliedMode: z.enum(["light", "dark"]).optional(),
      warning: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<AppearanceSocketResponse>;

/** Any pushed or replied frame: only its `type` is read. */
export const typedFrameSchema = z.looseObject({ type: z.string() });

/** A frame that reports an outcome. */
export const statusFrameSchema = z.looseObject({
  type: z.string(),
  success: z.boolean().optional(),
  error: z.string().optional(),
});

/** A frame that reports an outcome without an error message. */
export const successFrameSchema = z.looseObject({
  type: z.string(),
  success: z.boolean().optional(),
});

/** A frame that may carry an error message. */
export const errorFrameSchema = z.looseObject({
  type: z.string(),
  error: z.string().optional(),
});

/** A device-scoped stream frame. */
export const deviceFrameSchema = z.looseObject({
  type: z.string(),
  deviceId: z.string().optional(),
  captureSequence: z.number().optional(),
});

export const idFrameSchema = z.looseObject({ id: z.string() });

export const subscriptionIdFrameSchema = z.looseObject({
  id: z.string(),
  subscriptionId: z.string(),
});

/** A reply that may carry an id, an outcome and an error. */
export const ackFrameSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  success: z.boolean().optional(),
  error: z.string().optional(),
});

/** A reply whose id, type and outcome are all required. */
export const strictAckFrameSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const requiredErrorFrameSchema = z.looseObject({ type: z.string(), error: z.string() });

export const ackDeviceFrameSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  success: z.boolean().optional(),
  deviceId: z.string().optional(),
  error: z.string().optional(),
});

export const deviceErrorFrameSchema = z.looseObject({
  type: z.string(),
  deviceId: z.string().optional(),
  error: z.string().optional(),
});

export const hierarchyUpdateFrameSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  success: z.boolean().optional(),
  deviceId: z.string().optional(),
  data: z.looseObject({ packageName: z.string().optional() }).optional(),
});

export const observeFrameSchema = z.looseObject({
  type: z.string(),
  frameContext: z.string().optional(),
  captureSequence: z.number().optional(),
  deviceSessionUuid: z.string().nullable().optional(),
  hierarchyDiff: z.looseObject({ hasBaseline: z.boolean(), changed: z.number() }).optional(),
});

export const subscriptionScreenshotFrameSchema = z.looseObject({
  type: z.string(),
  subscriptionId: z.string(),
  screenshotBase64: z.string().optional(),
});

export const screenshotFrameSchema = z.looseObject({
  type: z.string(),
  deviceId: z.string().optional(),
  screenshotBase64: z.string().optional(),
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
  screenshotMimeType: z.string().optional(),
  screenshotFormat: z.string().optional(),
  screenshotCaptureSource: z.string().optional(),
  screenshotFallback: z.boolean().optional(),
  screenshotFallbackReason: z.string().optional(),
  screenshotCaptureDurationMs: z.number().optional(),
  screenshotEncodeDurationMs: z.number().optional(),
  screenshotByteLength: z.number().optional(),
  screenshotBase64Length: z.number().optional(),
});

export const sessionStatusFrameSchema = z.looseObject({
  type: z.string(),
  success: z.boolean().optional(),
  deviceId: z.string().optional(),
  deviceSessionUuid: z.string().nullable().optional(),
  timestamp: z.number().optional(),
  error: z.string().optional(),
});

export const packageFileFrameSchema = z.looseObject({
  type: z.string(),
  packageName: z.string().optional(),
  fileName: z.string().optional(),
});

export const deviceSessionFrameSchema = z.looseObject({
  type: z.string(),
  deviceSessionUuid: z.string(),
});

export const codeFrameSchema = z.looseObject({ type: z.string(), code: z.string().optional() });

export const coordinateSpaceFrameSchema = z.looseObject({
  type: z.string(),
  coordinateSpace: z.string().optional(),
  nativeScale: z.number().optional(),
});

/** A request frame written by `DaemonClient` or the stdio proxy. */
export const daemonRequestFrameSchema = z.looseObject({
  id: z.string(),
  type: z.enum(["mcp_request", "daemon_request"]),
  method: z.string(),
  params: z.unknown(),
  timeoutMs: z.number().optional(),
  progressToken: z.union([z.string(), z.number()]).optional(),
}) satisfies z.ZodType<DaemonRequest>;

/** The daemon's `DaemonResponse` schema, widened with the `result`/`code` fields tests read. */
export const daemonResponseFrameSchema = daemonResponseSchema;

/** The daemon's `DaemonNotification` schema. */
export const daemonNotificationFrameSchema = daemonNotificationSchema;
