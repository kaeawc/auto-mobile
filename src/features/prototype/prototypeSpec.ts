import { buildAdaptiveSchema, adaptiveChildren, type AdaptiveSlots } from "./prototypeAdaptive";
import { prototypeChannelsSchema } from "./prototypeChannelSchema";
import { prototypePressSchema } from "./prototypePressSchema";
export { PROTOTYPE_COLOR_ROLES } from "./prototypePresentationSchemas";
import { buildRouteSchema, setStackActionSchema } from "./prototypeRouteSchema";
import { themeSchema } from "./prototypeThemeSchema";
import { buildTooltipDrawerSchemas, tooltipAnchorIssue } from "./prototypeTooltipDrawerSchema";
import { prototypeDeriveSchema, prototypeRepeatDeriveSchema } from "./prototypeFormatSchema";
import { prototypeScrollMotionShape } from "./prototypeScrollMotionSchema";
import {
  prototypePlatformNamespaceShape,
  prototypePresentationNamespaceShape,
} from "./prototypePlatformNamespaceSchema";
import * as timers from "./prototypeTimerSchema";
import { prototypeStringsSchema } from "./prototypeStrings";
import { prototypeSemanticsSchema } from "./prototypeSemanticsSchema";
import { stackScreenActionSchema, stackTransitionSchema } from "./prototypeStackTransitions";
import { createSwipeActionsShape } from "./prototypeSwipeActionsSchema";
import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_STACK_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import {
  buildPrototypeActionListSchema,
  appendDataActionSchema,
  upsertDataActionSchema,
  keySchema,
  prototypeEmitContextSchema,
  dataActionPathSchema,
  dataActionFields,
  pointerSchema,
  prototypeDataActionValueSchema,
  setStateValueSchema,
  stateKeySchema,
  type PrototypeDataActionValue,
} from "./prototypeActionValues";
import {
  prototypeJsonObjectSchema,
  prototypeJsonSchema,
  type PrototypeJson,
} from "./prototypeJson";
import * as lazyList from "./prototypeLazyListSchema";
import { prototypeBackdropSchema } from "./prototypeBackdropSchema";
import { prototypeChartShape } from "./prototypeChartSchema";
import { prototypeIconShape } from "./prototypeIconEffects";
import { prototypeStaggerShape } from "./prototypeChoreographySchema";
import { prototypeImageShape, prototypeMotionNodeShape } from "./prototypeMotionV2Schema";
import { prototypeSpecNodeRoots, walkPrototypeNodes } from "./prototypeNodeChildren";
import {
  fadeEdgesSchema,
  imageFilterSchema,
  anchorSchema,
  colorValueSchema,
  conditionSchema,
  detentSchema,
  iconNameSchema,
  itemSchema,
  placementSchema,
  type PrototypeData,
  safeAreaPaddingSchema,
  sheetConditionSchema,
  styleSchema,
  styleWhenEntrySchema,
} from "./prototypePresentationSchemas";
import {
  bindPrototypePlatformFollowUps,
  platformActionSchema,
  prototypePlatformHandlersSchema,
  prototypeRequiresSchema,
} from "./prototypePlatformSchema";
import { bindPrototypeRequestFollowUps, requestActionSchema } from "./prototypeRequestSchema";
import { prototypeStorageSchema } from "./prototypeStorageSchema";
import { record } from "./prototypeTemplate";
export { type PrototypeAnchor, type PrototypeData } from "./prototypePresentationSchemas";
export { prototypeDataActionValueSchema, type PrototypeDataActionValue };
export const {
  MAX_PROTOTYPE_SPEC_BYTES,
  MAX_PROTOTYPE_TEXT_SPANS,
  MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES,
  MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES,
  MAX_PROTOTYPE_DATA_BYTES,
  MAX_PROTOTYPE_DATA_WRITE_BYTES,
  MAX_PROTOTYPE_DATA_DEPTH,
  MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
  MAX_PROTOTYPE_LIST_ITEMS,
  MAX_PROTOTYPE_DATA_POINTER_LENGTH,
  MAX_PROTOTYPE_REPEAT_PATH_CELLS,
  MAX_PROTOTYPE_PAGER_DP,
  MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH,
  MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL,
} = contract.limits;
export { prototypeJsonObjectSchema, prototypeJsonSchema, type PrototypeJson };
export {
  prototypeEmitContextBindingSchema,
  type PrototypeEmitContextBinding,
} from "./prototypeActionValues";
export { prototypeEmitContextSchema };
export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["emit"]),
      name: z.string().min(1),
      payload: prototypeJsonSchema.optional(),
      context: prototypeEmitContextSchema.optional(),
      requireValid: z.array(stateKeySchema).min(1).max(8).optional(),
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
      value: setStateValueSchema,
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
  z.object({ type: z.enum(["setData"]), ...dataActionFields }).strict(),
  appendDataActionSchema,
  upsertDataActionSchema,
  z.object({ type: z.enum(["prependData"]), ...dataActionFields }).strict(),
  z.object({ type: z.enum(["removeData"]), path: dataActionPathSchema }).strict(),
  timers.startTimerActionSchema,
  timers.cancelTimerActionSchema,
  requestActionSchema,
  platformActionSchema,
  stackScreenActionSchema("push"),
  z
    .object({ type: z.enum(["pop"]), stack: z.string().min(1), force: z.boolean().optional() })
    .strict(),
  setStackActionSchema,
  z.object({ type: z.enum(["popToRoot"]), stack: z.string().min(1) }).strict(),
  z
    .object({
      type: z.enum(["scrollTo"]),
      scroll: z.string().min(1),
      to: z.union([
        z.enum(["start", "end"]),
        z.object({ key: z.union([z.string(), z.number().finite(), z.boolean()]) }).strict(),
      ]),
      animated: z.boolean().optional(),
    })
    .strict(),
  stackScreenActionSchema("replace"),
]);
timers.bindPrototypeTimerActions(() => actionSchema);
bindPrototypeRequestFollowUps(() => actionSchema);
bindPrototypePlatformFollowUps(() => actionSchema);
const actionListSchema = buildPrototypeActionListSchema(actionSchema);
const gestureNodeShape = {
  onLongPress: actionListSchema.optional(),
  onDoubleTap: actionListSchema.optional(),
};
export { prototypeCheckSchema, type PrototypeCheck } from "./prototypeCheckSchema";
import { prototypeCheckSchema } from "./prototypeCheckSchema";
const enabledShape = { enabledWhen: conditionSchema.optional() };
const checksShape = {
  ...enabledShape,
  checks: z.array(prototypeCheckSchema).min(1).max(8).optional(),
  validateOn: z.enum(["change", "blur", "submit"]).optional(),
};
export const commonNodeShape = {
  semantics: prototypeSemanticsSchema.optional(),
  onAppear: actionListSchema.optional(),
  ...prototypeScrollMotionShape,
  ...prototypePlatformNamespaceShape,
  span: z.number().finite().int().min(1).optional(),
  id: z.string().min(1).optional(),
  testTag: z.string().min(1).optional(),
  // The node's accessible label, read by observe and screen readers in place of its text (#10446).
  contentDescription: z.string().min(1).optional(),
  onTap: actionListSchema.optional(),
  style: styleSchema.optional(),
  styleWhen: z.array(styleWhenEntrySchema).min(1).max(8).optional(),
  visibleWhen: conditionSchema.optional(),
  sharedKey: keySchema.optional(),
  press: prototypePressSchema.optional(),
  shared: z
    .object({ key: z.string().min(1).max(256), as: z.enum(["element", "bounds"]) })
    .strict()
    .optional(),
  ...prototypeMotionNodeShape,
  anchor: anchorSchema.optional(),
  safeAreaPadding: safeAreaPaddingSchema.optional(),
};
// A literal list template: the container's children are instantiated once per item.
const repeatItemSchema = z.record(
  keySchema,
  z.union([z.string(), z.number().finite(), z.boolean()]),
);
const repeatSchema = z
  .object({
    items: z.union([
      z.array(repeatItemSchema).min(1).max(128),
      z.object({ path: pointerSchema }).strict(),
    ]),
    as: keySchema,
    derive: prototypeRepeatDeriveSchema.optional(),
    key: keySchema.optional(),
    stagger: z.number().int().min(0).max(100).optional(),
  })
  .strict();
const repeatShape = { repeat: repeatSchema.optional() };
// `box`, `row` and `column` also stagger their `visibleWhen` children (#15247).
const containerShape = { ...repeatShape, ...prototypeStaggerShape };
const boxBaseSchema = z
  .object({ ...commonNodeShape, ...gestureNodeShape, ...containerShape, type: z.enum(["box"]) })
  .strict();
const swipeActionsShape = createSwipeActionsShape(actionSchema);
const rowBaseSchema = z
  .object({
    ...commonNodeShape,
    ...gestureNodeShape,
    ...swipeActionsShape,
    ...containerShape,
    type: z.enum(["row"]),
  })
  .strict();
const columnBaseSchema = z
  .object({ ...commonNodeShape, ...gestureNodeShape, ...containerShape, type: z.enum(["column"]) })
  .strict();
const flowBaseSchema = z
  .object({
    ...commonNodeShape,
    ...repeatShape,
    type: z.enum(["flow"]),
    maxLines: z.number().finite().int().min(1).optional(),
  })
  .strict();
const gridBaseSchema = z
  .object({
    ...commonNodeShape,
    ...repeatShape,
    type: z.enum(["grid"]),
    columns: z.union([
      z.number().finite().int().min(1).max(12),
      z.object({ minWidth: z.number().finite().positive() }).strict(),
    ]),
  })
  .strict();
const textSpanSchema = z
  .object({
    text: z.string().min(1),
    style: styleSchema
      .innerType()
      .pick({
        color: true,
        fontWeight: true,
        fontStyle: true,
        textDecoration: true,
        textSize: true,
        letterSpacing: true,
        fontFamily: true,
        background: true,
      })
      .optional(),
    onTap: commonNodeShape.onTap,
  })
  .strict();
// `linkify` (#14233): mentions, hashtags and URLs in `text` become links running `onTap`.
const linkifySchema = z
  .object({
    kinds: z
      .array(z.enum(["mention", "hashtag", "url"]))
      .min(1)
      .max(3),
    style: textSpanSchema.shape.style,
    onTap: actionListSchema,
  })
  .strict();
const textBaseSchema = z
  .object({
    ...commonNodeShape,
    ...gestureNodeShape,
    type: z.enum(["text"]),
    text: z.string().optional(),
    spans: z.array(textSpanSchema).min(1).max(MAX_PROTOTYPE_TEXT_SPANS).optional(),
    linkify: linkifySchema.optional(),
    contentTransition: z.enum(["numeric", "crossfade", "none"]).optional(),
  })
  .strict();
const imageBaseSchema = z
  .object({
    ...commonNodeShape,
    ...gestureNodeShape,
    ...prototypeImageShape,
    filter: imageFilterSchema.optional(),
  })
  .strict();
const iconBaseSchema = z
  .object({
    ...commonNodeShape,
    ...gestureNodeShape,
    ...prototypeIconShape,
  })
  .strict();
const spacerBaseSchema = z.object({ ...commonNodeShape, type: z.enum(["spacer"]) }).strict();
// An icon-only control in a top app bar: the icon, its accessible label and its tap.
const appBarActionSchema = z
  .object({ icon: iconNameSchema, label: z.string().min(1), onTap: actionListSchema.optional() })
  .strict();
const textFieldBaseSchema = z
  .object({
    ...commonNodeShape,
    ...checksShape,
    type: z.enum(["textField"]),
    stateKey: stateKeySchema,
    placeholder: z.string().optional(),
    label: z.string().min(1).optional(),
    variant: z.enum(["filled", "outlined"]).optional(),
    supportingText: z.string().min(1).optional(),
    errorWhen: conditionSchema.optional(),
    errorText: z.string().min(1).max(256).optional(),
    keyboardType: z
      .enum(["text", "number", "decimal", "email", "phone", "url", "password"])
      .optional(),
    secure: z.boolean().optional(),
    multiline: z.boolean().optional(),
    minLines: z.number().int().min(1).max(20).optional(),
    maxLines: z.number().int().min(1).max(20).optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    leadingIcon: iconNameSchema.optional(),
    trailingIcon: appBarActionSchema.optional(),
    imeAction: z.enum(["done", "next", "search", "send", "go"]).optional(),
    onSubmit: actionListSchema.optional(),
  })
  .strict();
const switchBaseSchema = z
  .object({
    ...commonNodeShape,
    ...checksShape,
    type: z.enum(["switch"]),
    stateKey: stateKeySchema,
    label: z.string().min(1).optional(),
  })
  .strict();
const checkboxBaseSchema = z
  .object({
    ...commonNodeShape,
    ...checksShape,
    type: z.enum(["checkbox"]),
    stateKey: stateKeySchema,
    label: z.string().min(1).optional(),
  })
  .strict();
const pasteButtonBaseSchema = z
  .object({
    ...z.object(commonNodeShape).omit({ onTap: true }).shape,
    type: z.enum(["pasteButton"]),
    into: pointerSchema,
  })
  .strict();
const buttonBaseSchema = z
  .object({
    ...commonNodeShape,
    ...enabledShape,
    type: z.enum(["button"]),
    label: z.string().min(1),
    variant: z.enum(["filled", "tonal", "elevated", "outlined", "text"]).optional(),
    icon: iconNameSchema.optional(),
  })
  .strict();
const radioGroupBaseSchema = z
  .object({
    ...commonNodeShape,
    ...checksShape,
    type: z.enum(["radioGroup"]),
    stateKey: stateKeySchema,
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
      .min(2)
      .max(16),
  })
  .strict();
const selectBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["select"]),
    stateKey: stateKeySchema,
    label: z.string().min(1).optional(),
    options: z
      .array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict())
      .min(2)
      .max(32),
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
    ...enabledShape,
    ...swipeActionsShape,
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
    ...checksShape,
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
    ...enabledShape,
    type: z.enum(["chip"]),
    label: z.string().min(1),
    variant: z.enum(["assist", "filter", "input", "suggestion"]).optional(),
    stateKey: stateKeySchema.optional(),
  })
  .strict();
const cardBaseSchema = z
  .object({
    ...commonNodeShape,
    ...gestureNodeShape,
    type: z.enum(["card"]),
    variant: z.enum(["filled", "elevated", "outlined"]).optional(),
  })
  .strict();
const stateKeyFieldSchema = stateKeySchema;
const searchBarBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["searchBar"]),
    stateKey: stateKeySchema,
    placeholder: textFieldBaseSchema.shape.placeholder,
    leadingIcon: iconNameSchema.optional(),
    trailingActions: z.array(appBarActionSchema).min(1).max(2).optional(),
    activeKey: stateKeySchema.optional(),
    variant: z.enum(["bar", "docked"]).optional(),
    onSubmit: actionListSchema.optional(),
  })
  .strict();
// A dialog or snackbar button: a tap closes its container, then runs `onTap`.
const dialogButtonSchema = z
  .object({ label: z.string().min(1), onTap: actionListSchema.optional() })
  .strict();
const iconButtonBaseSchema = z
  .object({
    ...commonNodeShape,
    ...enabledShape,
    type: z.enum(["iconButton"]),
    icon: iconNameSchema,
    variant: z.enum(["standard", "filled", "tonal", "outlined"]).optional(),
  })
  .strict();
const fabBaseSchema = z
  .object({
    ...commonNodeShape,
    ...enabledShape,
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
    onScroll: z.enum(["pinned", "enterAlways", "exitUntilCollapsed"]).optional(),
    scroll: z.string().min(1).optional(),
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
const chartBaseSchema = z.object({ ...commonNodeShape, ...prototypeChartShape }).strict();
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
const menuItemSchema = z.union([
  dialogButtonSchema
    .extend({
      icon: iconNameSchema.optional(),
      trailingText: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("divider") }).strict(),
]);
const menuBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["menu"]),
    openWhen: sheetConditionSchema,
    items: z.array(menuItemSchema).min(1).max(16),
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
    ...checksShape,
    type: z.enum(["timePicker"]),
    hourKey: stateKeyFieldSchema,
    minuteKey: stateKeyFieldSchema,
    is24Hour: z.boolean().optional(),
  })
  .strict();
const datePickerBaseSchema = z
  .object({
    ...commonNodeShape,
    ...checksShape,
    type: z.enum(["datePicker"]),
    stateKey: stateKeyFieldSchema,
  })
  .strict();
const scrollRefreshSchema = lazyList.refresh(actionSchema);
const listBaseSchema = lazyList.base(commonNodeShape, actionSchema, scrollRefreshSchema);
const scrollBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["scroll"]),
    axis: z.enum(["vertical", "horizontal"]).default("vertical"),
    refresh: scrollRefreshSchema.optional(),
    fadeEdges: fadeEdgesSchema.optional(),
    edgeEffect: z.enum(["soft", "hard", "none"]).optional(),
    // Chat lists (#14232): anchored at the end, following new rows, reporting the end position.
    reverse: z.boolean().optional(),
    stickToEnd: z.boolean().optional(),
    atEndKey: stateKeySchema.optional(),
    onStartReached: actionListSchema.optional(),
  })
  .strict();
// Pager distances share the contract's 10000 dp dimension ceiling.
const pagerDpSchema = z.number().finite().min(0).max(MAX_PROTOTYPE_PAGER_DP);
const pagerBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["pager"]),
    stateKey: stateKeySchema.optional(),
    id: z.string().min(1),
    axis: z.enum(["horizontal", "vertical"]).optional(),
    pageSpacing: pagerDpSchema.optional(),
    peek: z
      .object({ start: pagerDpSchema.optional(), end: pagerDpSchema.optional() })
      .strict()
      .optional(),
    pageSize: z
      .union([
        z.enum(["fill"]),
        z.object({ dp: z.number().finite().min(1e-6).max(MAX_PROTOTYPE_PAGER_DP) }).strict(),
      ])
      .optional(),
    indicator: z.enum(["none", "dots"]).optional(),
  })
  .strict();
const carouselBaseSchema = z
  .object({
    ...commonNodeShape,
    ...repeatShape,
    type: z.enum(["carousel"]),
    variant: z.enum(["multiBrowse", "hero", "uncontained"]).optional(),
    itemWidth: z.number().finite().min(1e-6).max(MAX_PROTOTYPE_PAGER_DP),
    itemSpacing: pagerDpSchema.optional(),
  })
  .strict();
const tabBarBaseSchema = z
  .object({
    ...commonNodeShape,
    type: z.enum(["tabBar"]),
    onScroll: z.enum(["none", "hide", "minimize"]).optional(),
    scroll: z.string().min(1).optional(),
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
    onScroll: z.enum(["none", "hide", "minimize"]).optional(),
    scroll: z.string().min(1).optional(),
    items: z.array(itemSchema).min(2).max(5),
    pager: z.string().min(1).optional(),
    stateKey: stateKeySchema.optional(),
  })
  .strict();
const { tooltipBaseSchema, drawerBaseSchema } = buildTooltipDrawerSchemas({
  commonNodeShape,
  sheetConditionSchema,
  actionSchema,
  colorValueSchema,
});
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
const routeSchema = buildRouteSchema(actionSchema);
const stackBaseSchema = z
  .object({
    ...commonNodeShape,
    transition: stackTransitionSchema,
    type: z.enum(["stack"]),
    id: z.string().min(1),
    start: z.string().min(1),
    routes: z.record(routeSchema).and(z.unknown()).optional(),
  })
  .strict();
const adaptiveBaseSchema = buildAdaptiveSchema(commonNodeShape);
export type PrototypeNode =
  | (z.infer<typeof adaptiveBaseSchema> & AdaptiveSlots<PrototypeNode>)
  | (z.infer<typeof stackBaseSchema> & { screens: Record<string, PrototypeNode> })
  | (z.infer<typeof boxBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof rowBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof columnBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof flowBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof gridBaseSchema> & { children: PrototypeNode[] })
  | (z.infer<typeof carouselBaseSchema> & { children: PrototypeNode[] })
  | z.infer<typeof textBaseSchema>
  | z.infer<typeof imageBaseSchema>
  | z.infer<typeof iconBaseSchema>
  | z.infer<typeof spacerBaseSchema>
  | z.infer<typeof textFieldBaseSchema>
  | (z.infer<typeof searchBarBaseSchema> & { child?: PrototypeNode })
  | z.infer<typeof switchBaseSchema>
  | z.infer<typeof checkboxBaseSchema>
  | z.infer<typeof pasteButtonBaseSchema>
  | z.infer<typeof buttonBaseSchema>
  | z.infer<typeof radioGroupBaseSchema>
  | z.infer<typeof selectBaseSchema>
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
  | z.infer<typeof chartBaseSchema>
  | (z.infer<typeof dialogBaseSchema> & { child?: PrototypeNode })
  | z.infer<typeof tooltipBaseSchema>
  | (z.infer<typeof drawerBaseSchema> & { child: PrototypeNode })
  | z.infer<typeof menuBaseSchema>
  | z.infer<typeof snackbarBaseSchema>
  | z.infer<typeof timePickerBaseSchema>
  | z.infer<typeof datePickerBaseSchema>
  | (z.infer<typeof listBaseSchema> & lazyList.Slots<PrototypeNode>)
  | (z.infer<typeof scrollBaseSchema> & { child: PrototypeNode })
  | (z.infer<typeof pagerBaseSchema> & { children: PrototypeNode[] })
  | z.infer<typeof tabBarBaseSchema>
  | z.infer<typeof bottomNavBaseSchema>
  | (z.infer<typeof bottomSheetBaseSchema> & { child: PrototypeNode });
// Object.fromEntries preserves all non-empty screen names, including __proto__, unlike z.record.
const stackScreensSchema: z.ZodType<Record<string, PrototypeNode>, z.ZodTypeDef, unknown> = z
  .unknown()
  .transform((value, context) => {
    const screens = record(value);
    if (
      !screens ||
      Object.keys(screens).length < 1 ||
      Object.keys(screens).length > contract.limits.MAX_PROTOTYPE_STACK_SCREENS
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected 1..32 screens" });
      return z.NEVER;
    }
    const entries: [string, PrototypeNode][] = [];
    for (const [name, child] of Object.entries(screens)) {
      if (!name.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "Empty screen name",
        });
        continue;
      }
      const parsed = prototypeNodeSchema.safeParse(child);
      if (parsed.success) {
        entries.push([name, parsed.data]);
      } else {
        for (const issue of parsed.error.issues) {
          context.addIssue({ ...issue, path: [name, ...issue.path] });
        }
      }
    }
    return Object.fromEntries(entries);
  });
let prototypeNodeUnion: z.ZodType<PrototypeNode, z.ZodTypeDef, unknown> | undefined;
const prototypeNodeBaseSchema: z.ZodType<PrototypeNode, z.ZodTypeDef, unknown> = z.lazy(
  () =>
    (prototypeNodeUnion ??= z.discriminatedUnion("type", [
      boxBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      rowBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      columnBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      flowBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      gridBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(0) }),
      carouselBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(1) }),
      adaptiveBaseSchema.extend(adaptiveChildren(z.lazy(() => prototypeNodeSchema))),
      textBaseSchema,
      imageBaseSchema,
      iconBaseSchema,
      spacerBaseSchema,
      textFieldBaseSchema,
      searchBarBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema).optional() }),
      switchBaseSchema,
      checkboxBaseSchema,
      pasteButtonBaseSchema,
      buttonBaseSchema,
      radioGroupBaseSchema,
      selectBaseSchema,
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
      chartBaseSchema,
      dialogBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema).optional() }),
      tooltipBaseSchema,
      drawerBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema) }),
      menuBaseSchema,
      snackbarBaseSchema,
      timePickerBaseSchema,
      datePickerBaseSchema,
      listBaseSchema.extend(lazyList.children(z.lazy(() => prototypeNodeSchema))),
      scrollBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema) }),
      pagerBaseSchema.extend({ children: z.array(z.lazy(() => prototypeNodeSchema)).min(1) }),
      stackBaseSchema.extend({
        screens: stackScreensSchema,
      }),
      tabBarBaseSchema,
      bottomNavBaseSchema,
      bottomSheetBaseSchema.extend({ child: z.lazy(() => prototypeNodeSchema) }),
    ])),
);
export const prototypeNodeSchema: z.ZodType<PrototypeNode, z.ZodTypeDef, unknown> =
  prototypeNodeBaseSchema.superRefine((node, context) => {
    tooltipAnchorIssue(node, context);
    if (node.type === "text" && (node.text !== undefined) === (node.spans !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [node.spans !== undefined ? "spans" : "text"],
        message:
          node.spans !== undefined
            ? "text and spans cannot both be set"
            : "text node needs text or spans",
      });
    }
  });
const windowSchema = z
  .object({
    ...prototypePresentationNamespaceShape,
    placement: placementSchema,
    backdrop: prototypeBackdropSchema.optional(),
    transition: z.enum(["auto", "none", "fade", "slide", "scale"]).optional(),
    chrome: z
      .enum(["none", "bar"])
      .optional()
      .describe(
        "Fullscreen only: none (default on a device advertising prototype_window_chrome_v1) removes the host dismiss bar; a two-finger long press (about 1 s) reveals a dismiss pill for 5 s. Device persistence defaults to bar. An older device keeps the bar and refuses explicit none; lastResult.chrome reports what it draws",
      ),
    deadTaps: z.boolean().optional(),
    keepScreenOn: z
      .boolean()
      .optional()
      .describe("Keep the screen awake while shown; needs prototype_platform_window_controls_v1"),
    brightness: z
      .union([z.literal("system"), z.number().finite().int().min(0).max(100)])
      .optional()
      .describe(
        "Screen brightness 0-100 for the prototype window while shown, or system; needs prototype_platform_window_controls_v1",
      ),
    orientation: z
      .enum(["portrait", "landscape", "unlocked"])
      .optional()
      .describe(
        "Requested orientation while shown (best effort over an overlay); needs prototype_platform_window_controls_v1",
      ),
    statusBar: z
      .enum(["light", "dark", "auto"])
      .optional()
      .describe(
        "Status bar content style while shown (best effort where the runtime does not own the status bar); needs prototype_platform_window_controls_v1",
      ),
    opacity: z.number().finite().int().min(0).max(100).default(100),
    layer: z
      .enum(["app", "system"])
      .optional()
      .describe(
        "system (default): above system UI. app: just above apps, so the shade, keyboard and screenshot preview draw over it; needs SYSTEM_ALERT_WINDOW, granted with appops at show time; some system apps (for example Settings) hide app-layer prototypes; the show result then carries visible: false",
      ),
    persistence: z
      .enum(["session", "device"])
      .optional()
      .describe(
        "session (default): dismissed when the last host client disconnects or after the idle timeout. device: stays interactive after USB/adb disconnect and session end, with no idle timeout, until its close control, an explicit dismiss, a replacing show, or the CtrlProxy service stops",
      ),
  })
  .strict();
const specSchema = z
  .object({
    id: z.string().min(1),
    window: windowSchema,
    theme: themeSchema.optional(),
    strings: prototypeStringsSchema.optional(),
    data: z
      .custom<PrototypeData>((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return false;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
      })
      .optional(),
    state: z
      .custom<Record<string, string | number | boolean>>(
        (value) =>
          z
            .record(keySchema, z.union([z.string(), z.number().finite(), z.boolean()]))
            .safeParse(value).success,
      )
      .optional(),
    motion: z.enum(["none", "standard", "reduced", "expressive"]).optional(),
    storage: prototypeStorageSchema.optional(),
    requires: prototypeRequiresSchema.optional(),
    platform: prototypePlatformHandlersSchema.optional(),
    channels: prototypeChannelsSchema(() => actionSchema).optional(),
    derive: prototypeDeriveSchema.optional(),
    root: z.lazy(() => prototypeNodeSchema),
  })
  .strict();
export const prototypeSpecSchema = specSchema;
export type PrototypeSpec = z.infer<typeof prototypeSpecSchema>;
export { PROTOTYPE_NODE_TYPES } from "./prototypeNodeTypes";
export const PROTOTYPE_ACTION_TYPES = [
  "emit",
  "setPage",
  "setStack",
  "push",
  "pop",
  "popToRoot",
  "replace",
  "setState",
  "toggle",
  "increment",
  "decrement",
  "dismiss",
  "setData",
  "appendData",
  "upsertData",
  "prependData",
  "removeData",
  "request",
  "platform",
  "scrollTo",
  "startTimer",
  "cancelTimer",
] as const;
export const PROTOTYPE_PLACEMENT_TYPES = ["fullscreen", "sheet", "floating"] as const;

export function prototypeHasStack(spec: unknown): boolean {
  let found = false;
  walkPrototypeNodes(spec, (node) => {
    if (node.type === "stack") {
      found = true;
    }
  });
  return found;
}

/** One path per authored root containing stack navigation, preserving the gate's existing shape. */
export function prototypeStackFields(spec: unknown): string[] {
  return prototypeSpecNodeRoots(spec).flatMap(({ node, path }) =>
    prototypeHasStack({ root: node }) ? [path] : [],
  );
}

/** Shared unsent refusal, following the theme-mode capability refusal wording. */
export function prototypeStackUnsupportedMessage(platform: "android" | "ios"): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_STACK_CAPABILITY}, so it cannot draw stack navigation. Nothing was shown. ${update}, or use a spec without stacks.`;
}
