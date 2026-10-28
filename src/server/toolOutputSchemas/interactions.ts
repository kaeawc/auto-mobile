import { z } from "zod/v4";
import { elementBoundsSchema } from "./display";

/**
 * identifyInteractions has one shape for both outcomes: a missing observation keeps the
 * screen name, an empty `interactions` list and a zeroed summary, and adds `error`.
 * Every field but `error` is required, so a spilled response keeps them all.
 */
export const identifyInteractionsResultSchema = z
  .object({
    success: z.boolean(),
    screenName: z.string(),
    interactions: z.array(
      z
        .object({
          id: z.string(),
          type: z.enum(["navigation", "input", "action", "scroll", "toggle"]),
          description: z.string(),
          confidence: z.number(),
          suggestedToolCall: z
            .object({
              tool: z.enum(["tapOn", "swipeOn"]),
              params: z.record(z.string(), z.unknown()),
            })
            .passthrough()
            .optional(),
          predictedOutcome: z
            .object({
              type: z.enum(["screen_change", "dialog", "expansion", "unknown"]),
              destination: z.string().optional(),
              confidence: z.number(),
            })
            .passthrough()
            .optional(),
          element: z
            .object({
              resourceId: z.string().optional(),
              text: z.string().optional(),
              contentDescription: z.string().optional(),
              className: z.string(),
              bounds: elementBoundsSchema,
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
    summary: z
      .object({
        totalInteractable: z.number().int().nonnegative(),
        byType: z.record(z.string(), z.number().int().nonnegative()),
        navigationOptions: z.number().int().nonnegative(),
        inputFields: z.number().int().nonnegative(),
      })
      .passthrough(),
    error: z.string().optional(),
  })
  .passthrough();
