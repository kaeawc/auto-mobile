import { z } from "zod/v3";
import { stateKeySchema } from "./prototypeActionValues";
import { iconNameSchema } from "./prototypePresentationSchemas";

/**
 * The Material nodes that carry Material 3 Expressive variants (#15258), and the new
 * `loadingIndicator`. Each variant is gated by `prototype_m3_expressive_v1`
 * (`prototypeM3Expressive.ts`): `fab.menu`, `button.split`, `segmentedButton` `variant: "connected"`
 * and `progress` `variant: "wavy"`.
 */
export function prototypeM3ExpressiveSchemas<
  C extends z.ZodRawShape,
  E extends z.ZodRawShape,
  A extends z.ZodTypeAny,
  M extends z.ZodTypeAny,
>(common: C, enabled: E, actionList: A, menuItem: () => M) {
  const option = z.object({ value: z.string().min(1), label: z.string().min(1) }).strict();
  // Tapping the FAB toggles 2-6 items above it.
  const fabMenu = z
    .object({
      items: z
        .array(
          z.object({ icon: iconNameSchema, label: z.string().min(1), onTap: actionList }).strict(),
        )
        .min(2)
        .max(6),
    })
    .strict();
  return {
    // `onTap` stays the leading action; the trailing half opens `menu`.
    buttonSplit: z.lazy(() => z.object({ menu: z.array(menuItem()).min(1).max(16) }).strict()),
    fab: z
      .object({
        ...common,
        ...enabled,
        type: z.enum(["fab"]),
        icon: iconNameSchema,
        label: z.string().min(1).optional(),
        size: z.enum(["small", "regular", "large"]).optional(),
        menu: fabMenu.optional(),
      })
      .strict(),
    segmentedButton: z
      .object({
        ...common,
        type: z.enum(["segmentedButton"]),
        stateKey: stateKeySchema,
        options: z.array(option).min(2).max(5),
        variant: z.enum(["standard", "connected"]).optional(),
      })
      .strict(),
    progress: z
      .object({
        ...common,
        type: z.enum(["progress"]),
        variant: z.enum(["linear", "circular", "wavy"]).optional(),
        stateKey: stateKeySchema.optional(),
        max: z.number().finite().optional(),
      })
      .strict(),
    // The shape-morphing loading indicator; always indeterminate.
    loadingIndicator: z
      .object({ ...common, type: z.enum(["loadingIndicator"]), contained: z.boolean().optional() })
      .strict(),
  };
}
