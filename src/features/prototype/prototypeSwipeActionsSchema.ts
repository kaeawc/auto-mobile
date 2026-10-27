import { z } from "zod";
import { colorTokenSchema, iconNameSchema } from "./prototypePresentationSchemas";

/**
 * Builds the `swipeActions` node shape. The action schema is injected because it is defined in
 * prototypeSpec.ts, which imports this module.
 */
export function createSwipeActionsShape<A extends z.ZodType>(actionSchema: A) {
  const swipeActionSchema = z
    .object({
      label: z.string().min(1),
      icon: iconNameSchema.optional(),
      role: z.enum(["default", "destructive"]).optional(),
      color: colorTokenSchema.optional(),
      onTap: z.array(actionSchema).min(1).max(32),
    })
    .strict();
  const swipeActionListSchema = z.array(swipeActionSchema).min(1).max(3);
  const swipeActionsSchema = z
    .object({
      start: swipeActionListSchema.optional(),
      end: swipeActionListSchema.optional(),
      fullSwipe: z.boolean().optional(),
    })
    .strict();
  return { swipeActions: swipeActionsSchema.optional() };
}
