import { z } from "zod/v4";
import type { AppearanceSocketResponse } from "../../src/daemon/appearanceSocketTypes";
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
