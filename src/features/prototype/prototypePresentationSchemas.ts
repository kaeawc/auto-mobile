import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { pointerSchema, stateKeySchema } from "./prototypeActionValues";
import { createEffectSchema } from "./prototypeEffectsSchema";

// Icon names are the closed list of Material icons the Android renderer bundles
// (androidx material-icons-extended); the shared contract is the single source.
export const iconNames: ReadonlySet<string> = new Set(contract.definitions.iconName.values);

export const iconNameSchema = z.string().refine((name) => iconNames.has(name), {
  message: "Unknown prototype icon name",
});

export const iconVariantSchema = z.enum(["filled", "outlined", "rounded", "sharp", "twoTone"]);

export const offsetSchema = z
  .object({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
  })
  .strict();

export const boundsSchema = z
  .object({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
    width: z.number().finite().min(0).max(10000),
    height: z.number().finite().min(0).max(10000),
  })
  .strict();

// Reuse the existing interaction contract's type; anchors reject ambiguous selection.
let containerObject: z.ZodType<ElementContainerSelector> | undefined;

export const containerSchema: z.ZodType<ElementContainerSelector> = z.lazy(
  () =>
    (containerObject ??= z
      .object({
        elementId: z.string().min(1).optional(),
        text: z
          .string()
          .refine((value) => !prototypeContractPatterns.blankText.test(value))
          .optional(),
        index: z.number().finite().int().min(0).max(2147483647).optional(),
        selectionStrategy: z.literal("unique").optional(),
        container: containerSchema.optional(),
      })
      .strict()),
);

export const selectorSchema = z
  .object({
    elementId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    testTag: z.string().min(1).optional(),
    container: containerSchema.optional(),
  })
  .strict();

export const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export type PrototypeDataValue =
  | string
  | number
  | boolean
  | PrototypeDataValue[]
  | { [key: string]: PrototypeDataValue };

export type PrototypeData = Record<string, PrototypeDataValue>;

export type PrototypeCondition =
  | { valid: string | string[] }
  | { data: string; equals: string | number | boolean }
  | { data: string; notEquals: string | number | boolean }
  | { data: string; gt: number }
  | { data: string; lt: number }
  | { data: string; empty: boolean }
  | { platform: string; equals: string | number | boolean }
  | { platform: string; notEquals: string | number | boolean }
  | { platform: string; gt: number }
  | { platform: string; lt: number }
  | { key: string; equals: string | number | boolean }
  | { key: string; notEquals: string | number | boolean }
  | { key: string; gt: number }
  | { key: string; lt: number }
  | { all: PrototypeCondition[] }
  | { any: PrototypeCondition[] }
  | { not: PrototypeCondition };

let conditionUnion: z.ZodType<PrototypeCondition> | undefined;

export const conditionSchema: z.ZodType<PrototypeCondition> = z.lazy(
  () =>
    (conditionUnion ??= z.union([
      z
        .object({ valid: z.union([stateKeySchema, z.array(stateKeySchema).min(1).max(8)]) })
        .strict(),
      z.object({ data: pointerSchema, equals: scalarSchema }).strict(),
      z.object({ data: pointerSchema, notEquals: scalarSchema }).strict(),
      z.object({ data: pointerSchema, gt: z.number().finite() }).strict(),
      z.object({ data: pointerSchema, lt: z.number().finite() }).strict(),
      // A missing value, [], {} or "" is empty (#14207).
      z.object({ data: pointerSchema, empty: z.boolean() }).strict(),
      z.object({ platform: pointerSchema, equals: scalarSchema }).strict(),
      z.object({ platform: pointerSchema, notEquals: scalarSchema }).strict(),
      z.object({ platform: pointerSchema, gt: z.number().finite() }).strict(),
      z.object({ platform: pointerSchema, lt: z.number().finite() }).strict(),
      z.object({ key: stateKeySchema, equals: scalarSchema }).strict(),
      z.object({ key: stateKeySchema, notEquals: scalarSchema }).strict(),
      z.object({ key: stateKeySchema, gt: z.number().finite() }).strict(),
      z.object({ key: stateKeySchema, lt: z.number().finite() }).strict(),
      z.object({ all: z.array(conditionSchema).min(1).max(16) }).strict(),
      z.object({ any: z.array(conditionSchema).min(1).max(16) }).strict(),
      z.object({ not: conditionSchema }).strict(),
    ])),
);

export const sheetConditionSchema = z.object({ key: stateKeySchema, equals: z.boolean() }).strict();

export const safeAreaPaddingSchema = z
  .object({
    edges: z
      .array(z.enum(["top", "bottom", "start", "end"]))
      .min(1)
      .max(4),
    types: z
      .array(z.enum(["systemBars", "cutout", "ime"]))
      .min(1)
      .max(3),
  })
  .strict();

export const dimensionSchema = z.union([
  z.enum(["fill", "wrap"]),
  z.object({ dp: z.number().finite().min(0).max(10000) }).strict(),
]);

export const detentSchema = z.union([
  z.enum(["half", "full"]),
  z.object({ dp: z.number().finite().min(1e-6).max(10000) }).strict(),
]);

export const paddingSchema = z
  .object({
    top: z.number().finite().min(0).max(10000).optional(),
    bottom: z.number().finite().min(0).max(10000).optional(),
    start: z.number().finite().min(0).max(10000).optional(),
    end: z.number().finite().min(0).max(10000).optional(),
  })
  .strict();

/** Material 3 ColorScheme roles a colour field can name instead of a hex value. */
export const PROTOTYPE_COLOR_ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "inversePrimary",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "background",
  "onBackground",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "surfaceTint",
  "inverseSurface",
  "inverseOnSurface",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "outline",
  "outlineVariant",
  "scrim",
  "surfaceBright",
  "surfaceDim",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "surfaceContainerLow",
  "surfaceContainerLowest",
] as const;

/** Material 3 Shapes steps a `cornerRadius` can name instead of a dp number. */
export const CORNER_RADIUS_TOKENS = [
  "none",
  "extraSmall",
  "small",
  "medium",
  "large",
  "extraLarge",
  "full",
] as const;

/** Per-corner dp radii; an omitted corner is square. */
export const cornerRadiiSchema = z
  .object({
    topStart: z.number().finite().min(0).max(10000).optional(),
    topEnd: z.number().finite().min(0).max(10000).optional(),
    bottomEnd: z.number().finite().min(0).max(10000).optional(),
    bottomStart: z.number().finite().min(0).max(10000).optional(),
  })
  .strict();

export const hexColorSchema = z.string().regex(prototypeContractPatterns.color);

/** One colour: a hex value or a Material role name. */
export const colorTokenSchema = z.union([hexColorSchema, z.enum(PROTOTYPE_COLOR_ROLES)]);

/**
 * A colour slot (#11218): one token used in both modes, or a `{light, dark}` pair of tokens. A pair
 * needs a device advertising `prototype_theme_modes_v1`.
 */
export const colorValueSchema = z.union([
  hexColorSchema,
  z.enum(PROTOTYPE_COLOR_ROLES),
  z.object({ light: colorTokenSchema, dark: colorTokenSchema }).strict(),
]);

/** An uploaded image asset id, or a `{light, dark}` pair of ids (#11218). */
export const imageAssetSchema = z.union([
  z.string().min(1),
  z.object({ light: z.string().min(1), dark: z.string().min(1) }).strict(),
]);

export const gradientStopSchema = z
  .object({ color: colorValueSchema, position: z.number().finite().min(0).max(1).optional() })
  .strict();

export const gradientSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["linear"]),
      angle: z.number().finite(),
      stops: z.array(gradientStopSchema).min(2).max(4),
    })
    .strict(),
  z
    .object({
      type: z.enum(["radial"]),
      stops: z.array(gradientStopSchema).min(2).max(4),
    })
    .strict(),
]);

export const borderSchema = z
  .object({
    width: z.number().finite().min(0).max(10000),
    color: colorValueSchema.optional(),
    gradient: gradientSchema.optional(),
  })
  .strict()
  .refine((value) => (value.color !== undefined) !== (value.gradient !== undefined), {
    path: ["color"],
    message: "Exactly one of color, gradient is required",
  });

export const shadowSchema = z
  .object({
    color: colorValueSchema,
    radius: z.number().finite().min(0).max(1000),
    spread: z.number().finite().min(-1000).max(1000).optional(),
    offset: z
      .object({
        x: z.number().finite().min(-1000).max(1000),
        y: z.number().finite().min(-1000).max(1000),
      })
      .strict()
      .optional(),
    inner: z.boolean().optional(),
  })
  .strict();

export const fadeEdgesSchema = z
  .object({
    top: z.number().finite().min(0).max(1000).optional(),
    bottom: z.number().finite().min(0).max(1000).optional(),
    start: z.number().finite().min(0).max(1000).optional(),
    end: z.number().finite().min(0).max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one fade edge is required");

export const imageFilterSchema = z
  .object({
    saturation: z.number().finite().min(0).max(2).optional(),
    tint: colorValueSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one image filter field is required");

/** Material 3 type roles a text node's `textStyle` can name. */
export const TEXT_STYLE_ROLES = [
  "displayLarge",
  "displayMedium",
  "displaySmall",
  "headlineLarge",
  "headlineMedium",
  "headlineSmall",
  "titleLarge",
  "titleMedium",
  "titleSmall",
  "bodyLarge",
  "bodyMedium",
  "bodySmall",
  "labelLarge",
  "labelMedium",
  "labelSmall",
] as const;

export const styleSchema = z
  .object({
    width: dimensionSchema.optional(),
    height: dimensionSchema.optional(),
    weight: z.number().finite().min(1e-6).max(10000).optional(),
    minWidth: z.number().finite().min(0).max(10000).optional(),
    maxWidth: z.number().finite().min(0).max(10000).optional(),
    minHeight: z.number().finite().min(0).max(10000).optional(),
    maxHeight: z.number().finite().min(0).max(10000).optional(),
    padding: paddingSchema.optional(),
    background: colorValueSchema.optional(),
    cornerRadius: z
      .union([
        z.number().finite().min(0).max(10000),
        z.enum(CORNER_RADIUS_TOKENS),
        cornerRadiiSchema,
      ])
      .optional(),
    border: borderSchema.optional(),
    elevation: z.number().finite().min(0).max(1000).optional(),
    shadowColor: colorValueSchema.optional(),
    shadows: z.array(shadowSchema).min(1).max(3).optional(),
    cornerStyle: z.enum(["circular", "continuous"]).optional(),
    gradient: gradientSchema.optional(),
    aspectRatio: z.number().finite().min(1e-6).max(10000).optional(),
    offset: offsetSchema.optional(),
    alpha: z.number().finite().min(0).max(1).optional(),
    pressScale: z.number().finite().min(0.5).max(1).optional(),
    // An animated highlight sweep over the background of a loading placeholder (#14207).
    shimmer: z.boolean().optional(),
    scale: z.number().finite().min(0).max(4).optional(),
    rotation: z.number().finite().min(-360).max(360).optional(),
    // Paint-only looks, applied in order; gated by prototype_effects_v1 (#15128).
    effects: z.array(createEffectSchema(colorValueSchema)).min(1).max(4).optional(),
    alignment: z
      .enum([
        "topStart",
        "topCenter",
        "topEnd",
        "centerStart",
        "center",
        "centerEnd",
        "bottomStart",
        "bottomCenter",
        "bottomEnd",
      ])
      .optional(),
    arrangement: z
      .enum(["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly"])
      .optional(),
    spacing: z.number().finite().min(0).max(10000).optional(),
    runSpacing: z.number().finite().min(0).max(10000).optional(),
    textSize: z.number().finite().min(1e-6).max(1000).optional(),
    fontWeight: z.number().finite().int().min(100).max(900).optional(),
    color: colorValueSchema.optional(),
    textAlign: z.enum(["start", "center", "end", "justify"]).optional(),
    maxLines: z.number().finite().int().min(1).max(2147483647).optional(),
    lineHeight: z.number().finite().min(1e-6).max(1000).optional(),
    letterSpacing: z.number().finite().min(-1000).max(1000).optional(),
    textDecoration: z.enum(["none", "underline", "lineThrough", "underlineLineThrough"]).optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    overflow: z.enum(["clip", "ellipsis", "visible"]).optional(),
    fontFamily: z
      .union([
        z.enum(["default", "sansSerif", "serif", "monospace"]),
        z.object({ asset: z.string().min(1) }).strict(),
      ])
      .optional(),
    textStyle: z.enum(TEXT_STYLE_ROLES).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.shadows === undefined ||
      (value.elevation === undefined && value.shadowColor === undefined),
    {
      path: ["shadows"],
      message: "shadows cannot be combined with elevation or shadowColor",
    },
  );

export const styleWhenEntrySchema = z
  .object({ when: conditionSchema, style: styleSchema })
  .strict();

export const itemSchema = z
  .object({
    label: z.string().min(1),
    icon: iconNameSchema.optional(),
    image: imageAssetSchema.optional(),
  })
  .strict();

export const anchorAlignmentSchema = z.enum(["cover", "top", "bottom", "start", "end"]);

// Bounds are screen-space dp. The host resolves an element anchor into a bounds anchor carrying
// the same alignment and offset, so the device only ever lays out bounds (#9316).
export const anchorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["bounds"]),
      bounds: boundsSchema,
      alignment: anchorAlignmentSchema.optional(),
      offset: offsetSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["element"]),
      selector: selectorSchema,
      alignment: anchorAlignmentSchema,
      offset: offsetSchema.optional(),
    })
    .strict(),
]);

export type PrototypeAnchor = z.infer<typeof anchorSchema>;

export const placementSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["fullscreen"]),
      scrim: colorValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["sheet"]),
      edge: z.enum(["top", "bottom"]),
      height: z.number().finite().min(1e-6).max(10000),
    })
    .strict(),
  z
    .object({
      type: z.enum(["floating"]),
      gravity: z.enum([
        "topStart",
        "topCenter",
        "topEnd",
        "centerStart",
        "center",
        "centerEnd",
        "bottomStart",
        "bottomCenter",
        "bottomEnd",
      ]),
      offset: offsetSchema,
    })
    .strict(),
]);
