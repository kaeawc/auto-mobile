import { z } from "zod";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import contract from "../../../schemas/overlay-spec-contract.json";
export const { MAX_OVERLAY_SPEC_BYTES, MAX_OVERLAY_EMIT_PAYLOAD_BYTES } = contract.limits;
export type OverlayJson =
  | null
  | string
  | number
  | boolean
  | OverlayJson[]
  | { [key: string]: OverlayJson };
const jsonValueSchema: z.ZodType<OverlayJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
// Preserve arbitrary JSON keys: Zod record decoding deliberately drops __proto__.
const overlayJsonSchema = z.custom<OverlayJson>(
  (value) => jsonValueSchema.safeParse(value).success,
);
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
const containerSchema: z.ZodType<ElementContainerSelector> = z.lazy(() =>
  z
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
    .strict(),
);
const selectorSchema = z
  .object({
    elementId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    testTag: z.string().min(1).optional(),
    container: containerSchema.optional(),
  })
  .strict();
const stateKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export type OverlayCondition =
  | { key: string; equals: string | number | boolean }
  | { key: string; notEquals: string | number | boolean }
  | { key: string; gt: number }
  | { key: string; lt: number }
  | { all: OverlayCondition[] }
  | { any: OverlayCondition[] }
  | { not: OverlayCondition };
const conditionSchema: z.ZodType<OverlayCondition> = z.lazy(() =>
  z.union([
    z.object({ key: stateKeySchema, equals: scalarSchema }).strict(),
    z.object({ key: stateKeySchema, notEquals: scalarSchema }).strict(),
    z.object({ key: stateKeySchema, gt: z.number().finite() }).strict(),
    z.object({ key: stateKeySchema, lt: z.number().finite() }).strict(),
    z.object({ all: z.array(conditionSchema).min(1).max(16) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(16) }).strict(),
    z.object({ not: conditionSchema }).strict(),
  ]),
);
const sheetConditionSchema = z
  .object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), equals: z.boolean() })
  .strict();
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
const borderSchema = z
  .object({
    width: z.number().finite().min(0),
    color: z.string().regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/),
  })
  .strict();
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
    background: z
      .string()
      .regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/)
      .optional(),
    cornerRadius: z.number().finite().min(0).optional(),
    border: borderSchema.optional(),
    alpha: z.number().finite().min(0).max(1).optional(),
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
    color: z
      .string()
      .regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/)
      .optional(),
    textAlign: z.enum(["start", "center", "end", "justify"]).optional(),
    maxLines: z.number().finite().int().min(1).max(2147483647).optional(),
    fontFamily: z.enum(["default", "sansSerif", "serif", "monospace"]).optional(),
  })
  .strict();
const styleWhenEntrySchema = z.object({ when: conditionSchema, style: styleSchema }).strict();
const itemSchema = z
  .object({
    label: z.string().min(1),
    icon: z
      .enum([
        "home",
        "search",
        "settings",
        "person",
        "favorite",
        "add",
        "close",
        "check",
        "arrow_back",
        "arrow_forward",
        "chevron_left",
        "chevron_right",
        "menu",
        "more_vert",
        "share",
        "edit",
        "delete",
        "info",
        "warning",
        "notifications",
        "star",
        "shopping_cart",
        "help",
        "refresh",
        "done",
        "cancel",
        "play_arrow",
        "pause",
        "stop",
        "mail",
        "phone",
        "location_on",
        "calendar_today",
        "visibility",
        "lock",
        "logout",
      ])
      .optional(),
    image: z.string().min(1).optional(),
  })
  .strict();
export const anchorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["bounds"]), bounds: boundsSchema }).strict(),
  z
    .object({
      type: z.enum(["element"]),
      selector: selectorSchema,
      alignment: z.enum(["cover", "top", "bottom", "start", "end"]),
      offset: offsetSchema.optional(),
    })
    .strict(),
]);
export const placementSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["fullscreen"]),
      scrim: z
        .string()
        .regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/)
        .optional(),
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
      payload: overlayJsonSchema.optional(),
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
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      value: z.union([z.string(), z.number().finite(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      type: z.enum(["toggle"]),
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    })
    .strict(),
  z
    .object({
      type: z.enum(["increment"]),
      key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      by: z.number().finite().optional(),
    })
    .strict(),
  z.object({ type: z.enum(["dismiss"]) }).strict(),
]);
const commonNodeShape = {
  id: z.string().min(1).optional(),
  testTag: z.string().min(1).optional(),
  onTap: z.array(actionSchema).min(1).max(32).optional(),
  style: styleSchema.optional(),
  styleWhen: z.array(styleWhenEntrySchema).min(1).max(8).optional(),
  visibleWhen: conditionSchema.optional(),
  anchor: anchorSchema.optional(),
  safeAreaPadding: safeAreaPaddingSchema.optional(),
};
const boxBaseSchema = z.object({ ...commonNodeShape, type: z.enum(["box"]) }).strict();
const rowBaseSchema = z.object({ ...commonNodeShape, type: z.enum(["row"]) }).strict();
const columnBaseSchema = z.object({ ...commonNodeShape, type: z.enum(["column"]) }).strict();
const textBaseSchema = z
  .object({ ...commonNodeShape, type: z.enum(["text"]), text: z.string() })
  .strict();
const imageBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["image"]),
    asset: z.string().min(1),
    contentScale: z.enum(["fit", "crop", "fill"]).optional(),
  })
  .strict();
const iconBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["icon"]),
    name: z.enum([
      "home",
      "search",
      "settings",
      "person",
      "favorite",
      "add",
      "close",
      "check",
      "arrow_back",
      "arrow_forward",
      "chevron_left",
      "chevron_right",
      "menu",
      "more_vert",
      "share",
      "edit",
      "delete",
      "info",
      "warning",
      "notifications",
      "star",
      "shopping_cart",
      "help",
      "refresh",
      "done",
      "cancel",
      "play_arrow",
      "pause",
      "stop",
      "mail",
      "phone",
      "location_on",
      "calendar_today",
      "visibility",
      "lock",
      "logout",
    ]),
  })
  .strict();
const spacerBaseSchema = z.object({ ...commonNodeShape, type: z.enum(["spacer"]) }).strict();
const textFieldBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["textField"]),
    stateKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    placeholder: z.string().optional(),
  })
  .strict();
const switchBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["switch"]),
    stateKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    label: z.string().min(1).optional(),
  })
  .strict();
const checkboxBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["checkbox"]),
    stateKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    label: z.string().min(1).optional(),
  })
  .strict();
const buttonBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["button"]),
    label: z.string().min(1),
    variant: z.enum(["filled", "outlined", "text"]).optional(),
  })
  .strict();
const sliderBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["slider"]),
    stateKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
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
    variant: z.enum(["assist", "filter"]).optional(),
    stateKey: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
const cardBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["card"]),
    variant: z.enum(["filled", "elevated", "outlined"]).optional(),
  })
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
    stateKey: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .optional(),
    scrollable: z.boolean().optional(),
  })
  .strict();
const bottomNavBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["bottomNav"]),
    items: z.array(itemSchema).min(2).max(5),
    pager: z.string().min(1).optional(),
    stateKey: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
const bottomSheetBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["bottomSheet"]),
    openWhen: sheetConditionSchema,
    detents: z.array(detentSchema).min(1).max(8),
    scrim: z
      .string()
      .regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/)
      .optional(),
    dragHandle: z.boolean().optional(),
    dismissOnSwipe: z.boolean().optional(),
  })
  .strict();
export type OverlayNode =
  | (z.infer<typeof boxBaseSchema> & { children: OverlayNode[] })
  | (z.infer<typeof rowBaseSchema> & { children: OverlayNode[] })
  | (z.infer<typeof columnBaseSchema> & { children: OverlayNode[] })
  | z.infer<typeof textBaseSchema>
  | z.infer<typeof imageBaseSchema>
  | z.infer<typeof iconBaseSchema>
  | z.infer<typeof spacerBaseSchema>
  | z.infer<typeof textFieldBaseSchema>
  | z.infer<typeof switchBaseSchema>
  | z.infer<typeof checkboxBaseSchema>
  | z.infer<typeof buttonBaseSchema>
  | z.infer<typeof sliderBaseSchema>
  | z.infer<typeof chipBaseSchema>
  | (z.infer<typeof cardBaseSchema> & { children: OverlayNode[] })
  | (z.infer<typeof scrollBaseSchema> & { child: OverlayNode })
  | (z.infer<typeof pagerBaseSchema> & { children: OverlayNode[] })
  | z.infer<typeof tabBarBaseSchema>
  | z.infer<typeof bottomNavBaseSchema>
  | (z.infer<typeof bottomSheetBaseSchema> & { child: OverlayNode });
export const overlayNodeSchema: z.ZodType<OverlayNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    boxBaseSchema.extend({ children: z.array(z.lazy(() => overlayNodeSchema)).min(0) }),
    rowBaseSchema.extend({ children: z.array(z.lazy(() => overlayNodeSchema)).min(0) }),
    columnBaseSchema.extend({ children: z.array(z.lazy(() => overlayNodeSchema)).min(0) }),
    textBaseSchema,
    imageBaseSchema,
    iconBaseSchema,
    spacerBaseSchema,
    textFieldBaseSchema,
    switchBaseSchema,
    checkboxBaseSchema,
    buttonBaseSchema,
    sliderBaseSchema,
    chipBaseSchema,
    cardBaseSchema.extend({ children: z.array(z.lazy(() => overlayNodeSchema)).min(0) }),
    scrollBaseSchema.extend({ child: z.lazy(() => overlayNodeSchema) }),
    pagerBaseSchema.extend({ children: z.array(z.lazy(() => overlayNodeSchema)).min(1) }),
    tabBarBaseSchema,
    bottomNavBaseSchema,
    bottomSheetBaseSchema.extend({ child: z.lazy(() => overlayNodeSchema) }),
  ]),
);
const windowSchema = z
  .object({
    placement: placementSchema,
    opacity: z.number().finite().int().min(0).max(100).default(100),
  })
  .strict();
const themeColorsSchema = z
  .object({
    seed: z
      .string()
      .regex(/^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/)
      .optional(),
    source: z.enum(["device"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const themeSchema = z
  .object({
    mode: z.enum(["light", "dark", "system"]).optional(),
    colors: themeColorsSchema.optional(),
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
    root: z.lazy(() => overlayNodeSchema),
  })
  .strict();
export const overlaySpecSchema = specSchema;
export type OverlaySpec = z.infer<typeof overlaySpecSchema>;
export const OVERLAY_NODE_TYPES = [
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
  "slider",
  "chip",
  "card",
  "scroll",
  "pager",
  "tabBar",
  "bottomNav",
  "bottomSheet",
] as const;
export const OVERLAY_ACTION_TYPES = [
  "emit",
  "setPage",
  "setState",
  "toggle",
  "increment",
  "dismiss",
] as const;
export const OVERLAY_PLACEMENT_TYPES = ["fullscreen", "sheet", "floating"] as const;
