import { z } from "zod";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import contract from "../../../schemas/prototype-spec-contract.json";
import { BOUND_STATE_KEY_PATTERN } from "./prototypeTemplate";
export const { MAX_PROTOTYPE_SPEC_BYTES, MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES } = contract.limits;
export type PrototypeJson =
  | null
  | string
  | number
  | boolean
  | PrototypeJson[]
  | { [key: string]: PrototypeJson };
// zod v3 calls a lazy schema's getter on every parse, so each getter builds its schema once and
// returns that same instance afterwards instead of rebuilding it for every nested value.
let jsonValueUnion: z.ZodType<PrototypeJson> | undefined;
const jsonValueSchema: z.ZodType<PrototypeJson> = z.lazy(
  () =>
    (jsonValueUnion ??= z.union([
      z.null(),
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.array(jsonValueSchema),
      z.record(jsonValueSchema),
    ])),
);
// Preserve arbitrary JSON keys: Zod record decoding deliberately drops __proto__.
const prototypeJsonSchema = z.custom<PrototypeJson>(
  (value) => jsonValueSchema.safeParse(value).success,
);
// Icon names are the closed list of Material icons the Android renderer bundles
// (androidx material-icons-extended); the shared contract is the single source.
const iconNames: ReadonlySet<string> = new Set(contract.definitions.iconName.values);
const iconNameSchema = z.string().refine((name) => iconNames.has(name), {
  message: "Unknown prototype icon name",
});
const iconVariantSchema = z.enum(["filled", "outlined", "rounded", "sharp", "twoTone"]);
const keySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const offsetSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const boundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
  })
  .strict();
// Reuse the existing interaction contract's type; anchors reject ambiguous selection.
let containerObject: z.ZodType<ElementContainerSelector> | undefined;
const containerSchema: z.ZodType<ElementContainerSelector> = z.lazy(
  () =>
    (containerObject ??= z
      .object({
        elementId: z.string().min(1).optional(),
        text: z
          .string()
          .refine((value) => value.trim().length > 0)
          .optional(),
        index: z.number().finite().int().min(0).max(2147483647).optional(),
        selectionStrategy: z.literal("unique").optional(),
        container: containerSchema.optional(),
      })
      .strict()),
);
const selectorSchema = z
  .object({
    elementId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    testTag: z.string().min(1).optional(),
    container: containerSchema.optional(),
  })
  .strict();
// State-key fields also take repeat placeholders such as `liked_{item.id}` (#11051).
const stateKeySchema = z.string().regex(BOUND_STATE_KEY_PATTERN);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export type PrototypeCondition =
  | { key: string; equals: string | number | boolean }
  | { key: string; notEquals: string | number | boolean }
  | { key: string; gt: number }
  | { key: string; lt: number }
  | { all: PrototypeCondition[] }
  | { any: PrototypeCondition[] }
  | { not: PrototypeCondition };
let conditionUnion: z.ZodType<PrototypeCondition> | undefined;
const conditionSchema: z.ZodType<PrototypeCondition> = z.lazy(
  () =>
    (conditionUnion ??= z.union([
      z.object({ key: stateKeySchema, equals: scalarSchema }).strict(),
      z.object({ key: stateKeySchema, notEquals: scalarSchema }).strict(),
      z.object({ key: stateKeySchema, gt: z.number().finite() }).strict(),
      z.object({ key: stateKeySchema, lt: z.number().finite() }).strict(),
      z.object({ all: z.array(conditionSchema).min(1).max(16) }).strict(),
      z.object({ any: z.array(conditionSchema).min(1).max(16) }).strict(),
      z.object({ not: conditionSchema }).strict(),
    ])),
);
const sheetConditionSchema = z.object({ key: stateKeySchema, equals: z.boolean() }).strict();
const safeAreaPaddingSchema = z
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
const dimensionSchema = z.union([
  z.enum(["fill", "wrap"]),
  z.object({ dp: z.number().finite().min(0) }).strict(),
]);
const detentSchema = z.union([
  z.enum(["half", "full"]),
  z.object({ dp: z.number().finite().min(1e-6) }).strict(),
]);
const paddingSchema = z
  .object({
    top: z.number().finite().min(0).optional(),
    bottom: z.number().finite().min(0).optional(),
    start: z.number().finite().min(0).optional(),
    end: z.number().finite().min(0).optional(),
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
const CORNER_RADIUS_TOKENS = [
  "none",
  "extraSmall",
  "small",
  "medium",
  "large",
  "extraLarge",
  "full",
] as const;
/** Per-corner dp radii; an omitted corner is square. */
const cornerRadiiSchema = z
  .object({
    topStart: z.number().finite().min(0).optional(),
    topEnd: z.number().finite().min(0).optional(),
    bottomEnd: z.number().finite().min(0).optional(),
    bottomStart: z.number().finite().min(0).optional(),
  })
  .strict();
const hexColorSchema = z.string().regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/);
/** One colour: a hex value or a Material role name. */
const colorTokenSchema = z.union([hexColorSchema, z.enum(PROTOTYPE_COLOR_ROLES)]);
/**
 * A colour slot (#11218): one token used in both modes, or a `{light, dark}` pair of tokens. A pair
 * needs a device advertising `prototype_theme_modes_v1`.
 */
const colorValueSchema = z.union([
  hexColorSchema,
  z.enum(PROTOTYPE_COLOR_ROLES),
  z.object({ light: colorTokenSchema, dark: colorTokenSchema }).strict(),
]);
export type PrototypeColorValue = z.infer<typeof colorValueSchema>;
/** An uploaded image asset id, or a `{light, dark}` pair of ids (#11218). */
const imageAssetSchema = z.union([
  z.string().min(1),
  z.object({ light: z.string().min(1), dark: z.string().min(1) }).strict(),
]);
export type PrototypeImageAsset = z.infer<typeof imageAssetSchema>;
const borderSchema = z
  .object({
    width: z.number().finite().min(0),
    color: colorValueSchema,
  })
  .strict();
const gradientStopSchema = z
  .object({ color: colorValueSchema, position: z.number().finite().min(0).max(1).optional() })
  .strict();
const gradientSchema = z.discriminatedUnion("type", [
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

/** Material 3 type roles a text node's `textStyle` can name. */
const TEXT_STYLE_ROLES = [
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
const styleSchema = z
  .object({
    width: dimensionSchema.optional(),
    height: dimensionSchema.optional(),
    weight: z.number().finite().min(1e-6).optional(),
    minWidth: z.number().finite().min(0).optional(),
    maxWidth: z.number().finite().min(0).optional(),
    minHeight: z.number().finite().min(0).optional(),
    maxHeight: z.number().finite().min(0).optional(),
    padding: paddingSchema.optional(),
    background: colorValueSchema.optional(),
    cornerRadius: z
      .union([z.number().finite().min(0), z.enum(CORNER_RADIUS_TOKENS), cornerRadiiSchema])
      .optional(),
    border: borderSchema.optional(),
    elevation: z.number().finite().min(0).optional(),
    shadowColor: colorValueSchema.optional(),
    gradient: gradientSchema.optional(),
    aspectRatio: z.number().finite().min(1e-6).optional(),
    offset: offsetSchema.optional(),
    alpha: z.number().finite().min(0).max(1).optional(),
    pressScale: z.number().finite().min(0.5).max(1).optional(),
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
    spacing: z.number().finite().min(0).optional(),
    textSize: z.number().finite().min(1e-6).optional(),
    fontWeight: z.number().finite().int().min(100).max(900).optional(),
    color: colorValueSchema.optional(),
    textAlign: z.enum(["start", "center", "end", "justify"]).optional(),
    maxLines: z.number().finite().int().min(1).max(2147483647).optional(),
    lineHeight: z.number().finite().min(1e-6).optional(),
    letterSpacing: z.number().finite().optional(),
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
  .strict();
const styleWhenEntrySchema = z.object({ when: conditionSchema, style: styleSchema }).strict();
const itemSchema = z
  .object({
    label: z.string().min(1),
    icon: iconNameSchema.optional(),
    image: imageAssetSchema.optional(),
  })
  .strict();
const anchorAlignmentSchema = z.enum(["cover", "top", "bottom", "start", "end"]);
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
      height: z.number().finite().min(1e-6),
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
export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["emit"]),
      name: z.string().min(1),
      payload: prototypeJsonSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["setPage"]),
      pager: z.string().min(1),
      page: z.union([z.enum(["next", "prev"]), z.number().finite().int().min(0).max(2147483647)]),
    })
    .strict(),
  z
    .object({
      type: z.enum(["setState"]),
      key: stateKeySchema,
      value: z.union([z.string(), z.number().finite(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      type: z.enum(["toggle"]),
      key: stateKeySchema,
    })
    .strict(),
  z
    .object({
      type: z.enum(["increment"]),
      key: stateKeySchema,
      by: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["decrement"]),
      key: stateKeySchema,
      by: z.number().finite().optional(),
    })
    .strict(),
  z.object({ type: z.enum(["dismiss"]) }).strict(),
]);
const commonNodeShape = {
  id: z.string().min(1).optional(),
  testTag: z.string().min(1).optional(),
  // The node's accessible label, read by observe and screen readers in place of its text (#10446).
  contentDescription: z.string().min(1).optional(),
  onTap: z.array(actionSchema).min(1).max(32).optional(),
  style: styleSchema.optional(),
  styleWhen: z.array(styleWhenEntrySchema).min(1).max(8).optional(),
  visibleWhen: conditionSchema.optional(),
  transition: z.enum(["none", "fade", "expand", "slide"]).optional(),
  anchor: anchorSchema.optional(),
  safeAreaPadding: safeAreaPaddingSchema.optional(),
};
// A literal list template: the container's children are instantiated once per item.
const repeatItemSchema = z.record(
  keySchema,
  z.union([z.string(), z.number().finite(), z.boolean()]),
);
const repeatSchema = z
  .object({ items: z.array(repeatItemSchema).min(1).max(128), as: keySchema })
  .strict();
const repeatShape = { repeat: repeatSchema.optional() };
const boxBaseSchema = z
  .object({ ...commonNodeShape, ...repeatShape, type: z.enum(["box"]) })
  .strict();
const rowBaseSchema = z
  .object({ ...commonNodeShape, ...repeatShape, type: z.enum(["row"]) })
  .strict();
const columnBaseSchema = z
  .object({ ...commonNodeShape, ...repeatShape, type: z.enum(["column"]) })
  .strict();
const textBaseSchema = z
  .object({ ...commonNodeShape, type: z.enum(["text"]), text: z.string() })
  .strict();
const imageBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["image"]),
    asset: imageAssetSchema,
    contentScale: z.enum(["fit", "crop", "fill"]).optional(),
  })
  .strict();
const iconBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["icon"]),
    name: iconNameSchema,
    variant: iconVariantSchema.optional(),
  })
  .strict();
const spacerBaseSchema = z.object({ ...commonNodeShape, type: z.enum(["spacer"]) }).strict();
const textFieldBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["textField"]),
    stateKey: stateKeySchema,
    placeholder: z.string().optional(),
  })
  .strict();
const switchBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["switch"]),
    stateKey: stateKeySchema,
    label: z.string().min(1).optional(),
  })
  .strict();
const checkboxBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["checkbox"]),
    stateKey: stateKeySchema,
    label: z.string().min(1).optional(),
  })
  .strict();
const buttonBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["button"]),
    label: z.string().min(1),
    variant: z.enum(["filled", "tonal", "elevated", "outlined", "text"]).optional(),
    icon: iconNameSchema.optional(),
  })
  .strict();
const radioGroupBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["radioGroup"]),
    stateKey: stateKeySchema,
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
      .min(2)
      .max(16),
  })
  .strict();
const listItemTrailingSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["switch"]),
      stateKey: stateKeySchema,
    })
    .strict(),
  z
    .object({
      type: z.enum(["checkbox"]),
      stateKey: stateKeySchema,
    })
    .strict(),
  z.object({ type: z.enum(["icon"]), name: iconNameSchema }).strict(),
]);
const listItemBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["listItem"]),
    headline: z.string().min(1),
    supporting: z.string().min(1).optional(),
    leadingIcon: iconNameSchema.optional(),
    trailing: listItemTrailingSchema.optional(),
  })
  .strict();
const sliderBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["slider"]),
    stateKey: stateKeySchema,
    label: z.string().min(1).optional(),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().optional(),
  })
  .strict();
const chipBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["chip"]),
    label: z.string().min(1),
    variant: z.enum(["assist", "filter", "input", "suggestion"]).optional(),
    stateKey: stateKeySchema.optional(),
  })
  .strict();
const cardBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["card"]),
    variant: z.enum(["filled", "elevated", "outlined"]).optional(),
  })
  .strict();
const stateKeyFieldSchema = stateKeySchema;
const actionListSchema = z.array(actionSchema).min(1).max(32);
// An icon-only control in a top app bar: the icon, its accessible label and its tap.
const appBarActionSchema = z
  .object({ icon: iconNameSchema, label: z.string().min(1), onTap: actionListSchema.optional() })
  .strict();
// A dialog or snackbar button: a tap closes its container, then runs `onTap`.
const dialogButtonSchema = z
  .object({ label: z.string().min(1), onTap: actionListSchema.optional() })
  .strict();
const iconButtonBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["iconButton"]),
    icon: iconNameSchema,
    variant: z.enum(["standard", "filled", "tonal", "outlined"]).optional(),
  })
  .strict();
const fabBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["fab"]),
    icon: iconNameSchema,
    label: z.string().min(1).optional(),
    size: z.enum(["small", "regular", "large"]).optional(),
  })
  .strict();
const segmentedButtonBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["segmentedButton"]),
    stateKey: stateKeyFieldSchema,
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
      .min(2)
      .max(5),
  })
  .strict();
const topAppBarBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["topAppBar"]),
    title: z.string().min(1),
    variant: z.enum(["small", "centerAligned", "medium", "large"]).optional(),
    navigationIcon: appBarActionSchema.optional(),
    actions: z.array(appBarActionSchema).min(1).max(3).optional(),
  })
  .strict();
const dividerBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["divider"]),
    orientation: z.enum(["horizontal", "vertical"]).optional(),
  })
  .strict();
const badgeBaseSchema = z
  .object({ ...commonNodeShape, type: z.enum(["badge"]), text: z.string().min(1).optional() })
  .strict();
const progressBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["progress"]),
    variant: z.enum(["linear", "circular"]).optional(),
    stateKey: stateKeyFieldSchema.optional(),
    max: z.number().finite().optional(),
  })
  .strict();
const dialogBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["dialog"]),
    openWhen: sheetConditionSchema,
    title: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    icon: iconNameSchema.optional(),
    confirm: dialogButtonSchema,
    dismiss: dialogButtonSchema.optional(),
  })
  .strict();
const snackbarBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["snackbar"]),
    openWhen: sheetConditionSchema,
    text: z.string().min(1),
    action: dialogButtonSchema.optional(),
    durationMs: z.number().int().min(1).max(600000).optional(),
  })
  .strict();
const timePickerBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["timePicker"]),
    hourKey: stateKeyFieldSchema,
    minuteKey: stateKeyFieldSchema,
    is24Hour: z.boolean().optional(),
  })
  .strict();
const datePickerBaseSchema = z
  .object({ ...commonNodeShape, type: z.enum(["datePicker"]), stateKey: stateKeyFieldSchema })
  .strict();
const scrollBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["scroll"]),
    axis: z.enum(["vertical", "horizontal"]).default("vertical"),
  })
  .strict();
const pagerBaseSchema = z
  .object({ ...commonNodeShape, type: z.enum(["pager"]), id: z.string().min(1) })
  .strict();
const tabBarBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["tabBar"]),
    items: z.array(itemSchema).min(1).max(32),
    pager: z.string().min(1).optional(),
    stateKey: stateKeySchema.optional(),
    scrollable: z.boolean().optional(),
  })
  .strict();
const bottomNavBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["bottomNav"]),
    items: z.array(itemSchema).min(2).max(5),
    pager: z.string().min(1).optional(),
    stateKey: stateKeySchema.optional(),
  })
  .strict();
const bottomSheetBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["bottomSheet"]),
    openWhen: sheetConditionSchema,
    detents: z.array(detentSchema).min(1).max(8),
    scrim: colorValueSchema.optional(),
    dragHandle: z.boolean().optional(),
    dismissOnSwipe: z.boolean().optional(),
  })
  .strict();
export type PrototypeNode =
  | (z.infer<typeof boxBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof rowBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof columnBaseSchema> & { children: PrototypeNode[] })
  | z.infer<typeof textBaseSchema>
  | z.infer<typeof imageBaseSchema>
  | z.infer<typeof iconBaseSchema>
  | z.infer<typeof spacerBaseSchema>
  | z.infer<typeof textFieldBaseSchema>
  | z.infer<typeof switchBaseSchema>
  | z.infer<typeof checkboxBaseSchema>
  | z.infer<typeof buttonBaseSchema>
  | z.infer<typeof radioGroupBaseSchema>
  | z.infer<typeof listItemBaseSchema>
  | z.infer<typeof sliderBaseSchema>
  | z.infer<typeof chipBaseSchema>
  | (z.infer<typeof cardBaseSchema> & { children: PrototypeNode[] })
  | z.infer<typeof iconButtonBaseSchema>
  | z.infer<typeof fabBaseSchema>
  | z.infer<typeof segmentedButtonBaseSchema>
  | z.infer<typeof topAppBarBaseSchema>
  | z.infer<typeof dividerBaseSchema>
  | z.infer<typeof badgeBaseSchema>
  | z.infer<typeof progressBaseSchema>
  | (z.infer<typeof dialogBaseSchema> & { child?: PrototypeNode })
  | z.infer<typeof snackbarBaseSchema>
  | z.infer<typeof timePickerBaseSchema>
  | z.infer<typeof datePickerBaseSchema>
  | (z.infer<typeof scrollBaseSchema> & { child: PrototypeNode })
  | (z.infer<typeof pagerBaseSchema> & { children: PrototypeNode[] })
  | z.infer<typeof tabBarBaseSchema>
  | z.infer<typeof bottomNavBaseSchema>
  | (z.infer<typeof bottomSheetBaseSchema> & { child: PrototypeNode });
let prototypeNodeUnion: z.ZodType<PrototypeNode, z.ZodTypeDef, unknown> | undefined;
export const prototypeNodeSchema: z.ZodType<PrototypeNode, z.ZodTypeDef, unknown> = z.lazy(
  () =>
    (prototypeNodeUnion ??= z.discriminatedUnion("type", [
      boxBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      rowBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      columnBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      textBaseSchema,
      imageBaseSchema,
      iconBaseSchema,
      spacerBaseSchema,
      textFieldBaseSchema,
      switchBaseSchema,
      checkboxBaseSchema,
      buttonBaseSchema,
      radioGroupBaseSchema,
      listItemBaseSchema,
      sliderBaseSchema,
      chipBaseSchema,
      cardBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      iconButtonBaseSchema,
      fabBaseSchema,
      segmentedButtonBaseSchema,
      topAppBarBaseSchema,
      dividerBaseSchema,
      badgeBaseSchema,
      progressBaseSchema,
      dialogBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema).optional() }),
      snackbarBaseSchema,
      timePickerBaseSchema,
      datePickerBaseSchema,
      scrollBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema) }),
      pagerBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(1) }),
      tabBarBaseSchema,
      bottomNavBaseSchema,
      bottomSheetBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema) }),
    ])),
);
const windowSchema = z
  .object({
    placement: placementSchema,
    opacity: z.number().finite().int().min(0).max(100).default(100),
    layer: z
      .enum(["app", "system"])
      .optional()
      .describe(
        "system (default): above system UI. app: just above apps, so the shade, keyboard and screenshot preview draw over it; needs SYSTEM_ALERT_WINDOW, granted with appops at show time",
      ),
    persistence: z
      .enum(["session", "device"])
      .optional()
      .describe(
        "session (default): dismissed when the last host client disconnects or after the idle timeout. device: stays interactive after USB/adb disconnect and session end, with no idle timeout, until its close control, an explicit dismiss, a replacing show, or the CtrlProxy service stops",
      ),
  })
  .strict();
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
const themeSchema = z
  .object({
    mode: z.enum(["light", "dark", "system"]).optional(),
    colors: themeColorsSchema.optional(),
    typography: themeTypographySchema.optional(),
    shapes: themeShapesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const specSchema = z
  .object({
    id: z.string().min(1),
    window: windowSchema,
    theme: themeSchema.optional(),
    state: z
      .custom<Record<string, string | number | boolean>>(
        (value) =>
          z
            .record(keySchema, z.union([z.string(), z.number().finite(), z.boolean()]))
            .safeParse(value).success,
      )
      .optional(),
    motion: z.enum(["none", "standard"]).optional(),
    root: z.lazy(() => prototypeNodeSchema),
  })
  .strict();
export const prototypeSpecSchema = specSchema;
export type PrototypeSpec = z.infer<typeof prototypeSpecSchema>;
export const PROTOTYPE_NODE_TYPES = [
  "box",
  "row",
  "column",
  "text",
  "image",
  "icon",
  "spacer",
  "textField",
  "switch",
  "checkbox",
  "button",
  "radioGroup",
  "listItem",
  "slider",
  "chip",
  "card",
  "iconButton",
  "fab",
  "segmentedButton",
  "topAppBar",
  "divider",
  "badge",
  "progress",
  "dialog",
  "snackbar",
  "timePicker",
  "datePicker",
  "scroll",
  "pager",
  "tabBar",
  "bottomNav",
  "bottomSheet",
] as const;
export const PROTOTYPE_ACTION_TYPES = [
  "emit",
  "setPage",
  "setState",
  "toggle",
  "increment",
  "decrement",
  "dismiss",
] as const;
export const PROTOTYPE_PLACEMENT_TYPES = ["fullscreen", "sheet", "floating"] as const;
