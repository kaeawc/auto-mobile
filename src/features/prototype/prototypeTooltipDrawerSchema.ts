import { z } from "zod";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import type {
  PrototypeNode,
  actionSchema as ActionSchema,
  commonNodeShape as CommonNodeShape,
} from "./prototypeSpec";
import type {
  colorValueSchema as ColorValueSchema,
  sheetConditionSchema as SheetConditionSchema,
} from "./prototypePresentationSchemas";

interface TooltipDrawerDeps {
  commonNodeShape: typeof CommonNodeShape;
  sheetConditionSchema: typeof SheetConditionSchema;
  actionSchema: typeof ActionSchema;
  colorValueSchema: typeof ColorValueSchema;
}

/**
 * Tooltip and drawer node schemas. Built from the shared pieces of prototypeSpec.ts so this
 * file never imports its values (which would make the modules circular).
 */
export function buildTooltipDrawerSchemas(deps: TooltipDrawerDeps) {
  const { commonNodeShape, sheetConditionSchema, actionSchema, colorValueSchema } = deps;
  const tooltipBaseSchema = z
    .object({
      ...commonNodeShape,
      type: z.enum(["tooltip"]),
      openWhen: sheetConditionSchema,
      text: z
        .string()
        .min(1)
        .refine((value) => !prototypeContractPatterns.blankText.test(value)),
      anchorTo: z.string().min(1).optional(),
      caret: z.enum(["auto", "top", "bottom", "start", "end"]).optional(),
      spotlight: z
        .object({
          padding: z.number().int().min(0).max(64).optional(),
          cornerRadius: z.number().int().min(0).max(64).optional(),
        })
        .strict()
        .optional(),
      onDismiss: z.array(actionSchema).min(1).max(32).optional(),
    })
    .strict();
  const drawerBaseSchema = z
    .object({
      ...commonNodeShape,
      type: z.enum(["drawer"]),
      edge: z.enum(["start", "end"]),
      openWhen: sheetConditionSchema,
      scrim: colorValueSchema.optional(),
      dismissOnSwipe: z.boolean().optional(),
    })
    .strict();
  return { tooltipBaseSchema, drawerBaseSchema };
}

/** A tooltip names its target by exactly one of anchorTo (node id) or anchor. */
export function tooltipAnchorIssue(node: PrototypeNode, context: z.RefinementCtx): void {
  if (node.type === "tooltip" && (node.anchorTo !== undefined) === (node.anchor !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anchorTo"],
      message: "Exactly one of anchorTo, anchor is required",
    });
  }
}
