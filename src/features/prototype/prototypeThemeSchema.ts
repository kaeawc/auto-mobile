import { z } from "zod";
import { hexColorSchema, PROTOTYPE_COLOR_ROLES } from "./prototypePresentationSchemas";

/**
 * Explicit hex overrides for individual scheme roles, applied over the seed, device or baseline
 * scheme in both light and dark.
 */
const themeColorRoleSchemas = Object.fromEntries(
  PROTOTYPE_COLOR_ROLES.map((role) => [role, hexColorSchema.optional()]),
) as Record<(typeof PROTOTYPE_COLOR_ROLES)[number], z.ZodOptional<typeof hexColorSchema>>;
/** Role overrides for one resolved mode, applied after the flat overrides (#11218). */
const themeModeColorsSchema = z
  .object(themeColorRoleSchemas)
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const themeColorsSchema = z
  .object({
    seed: hexColorSchema.optional(),
    source: z.enum(["device"]).optional(),
    light: themeModeColorsSchema.optional(),
    dark: themeModeColorsSchema.optional(),
    ...themeColorRoleSchemas,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const themeTypographySchema = z
  .object({
    scale: z.number().finite().min(0.75).max(1.5).optional(),
    fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const themeShapesSchema = z
  .object({
    corner: z.enum(["none", "small", "medium", "large", "full"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const themeSchema = z
  .object({
    mode: z.enum(["light", "dark", "system"]).optional(),
    colors: themeColorsSchema.optional(),
    typography: themeTypographySchema.optional(),
    shapes: themeShapesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
