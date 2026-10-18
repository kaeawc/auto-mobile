import { z } from "zod/v4";

const pointSchema = z.object({ x: z.number(), y: z.number() });

/**
 * Shared by swipeAt and multiTouch. A failed gesture is returned with `isError`, so both outcomes
 * carry this shape; the nested action-result details stay open via `passthrough`.
 */
const gestureResultShape = {
  message: z.string(),
  success: z.boolean(),
  deviceId: z.string(),
  platform: z.string(),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  duration: z.number(),
  error: z.string().optional(),
  observation: z.object({}).passthrough().optional(),
  warnings: z.array(z.string()).optional(),
};

export const swipeAtResultSchema = z
  .object({
    ...gestureResultShape,
    velocityPxPerSecond: z.number().optional(),
  })
  .passthrough();

export const multiTouchResultSchema = z
  .object({
    ...gestureResultShape,
    action: z.enum(["tap", "longPress", "swipe"]),
    fingers: z.number(),
    fingerSpacing: z.number(),
    points: z.array(pointSchema),
  })
  .passthrough();
