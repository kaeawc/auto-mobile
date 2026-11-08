import {
  ALIGN_ITEMS,
  ALIGN_SELF,
  ASPECT_RATIO,
  BACKGROUND_COLOR,
  BORDER_BOX,
  BORDER_RADIUS,
  BOX_SHADOW,
  BOX_SIZING,
  CENTER,
  FLEX,
  FLEX_BASIS,
  FLEX_DIRECTION,
  FLEX_SHRINK,
  FONT_FAMILY,
  FONT_SIZE,
  FONT_WEIGHT,
  JUSTIFY_CONTENT,
  LINE_HEIGHT,
  MAX_HEIGHT,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  TEXT_ALIGN,
  WHITE_SPACE,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import type { PrototypeColorMode, Rgba } from "../prototypeContrast";
import { cssColor, elevationCss, glassCss, gradientCss, shadowsCss } from "./webStylePolish";
import type { TextScale } from "./webTextScale";

export { cssColor, rgbaCss } from "./webStylePolish";

/** What a node's style needs from its surroundings: the colour mode and the parent's main axis. */
export interface WebStyleContext {
  readonly mode: PrototypeColorMode;
  readonly palette: ReadonlyMap<string, Rgba>;
  /** The flex direction of the parent, when it lays children out in a line. */
  readonly parentAxis?: "row" | "column";
  /**
   * Inside a horizontal scroll, where Compose measures content against an unbounded width (and
   * descendants inherit it), so a row is not bounded to its parent's width there.
   */
  readonly unboundedWidth?: boolean;
  /** The spec's theme.typography, applied to every type-scale role as the native theme does. */
  readonly typography?: { readonly scale: number; readonly fontFamily?: string };
  /** The system text size (Android font scale, iOS Dynamic Type); absent at the default size. */
  readonly textScale?: TextScale;
  /** The skin's platform, for looks the devices draw differently (glass). Android when unset. */
  readonly platform?: "android" | "ios";
  /** The window's explicit `rtl` direction, for physical edges such as a fade's. */
  readonly rtl?: boolean;
}

const THEME_FONT_FAMILY: Readonly<Record<string, string>> = {
  sans: "sans-serif",
  serif: "serif",
  mono: "monospace",
};

/** theme.typography as the native prototypeTypography reads it: a role scale and a family. */
export function themeTypography(spec: unknown): WebStyleContext["typography"] {
  const typography = record(record(record(spec)?.theme)?.typography);
  if (!typography) {
    return undefined;
  }
  const scale = typeof typography.scale === "number" ? typography.scale : 1;
  const family = THEME_FONT_FAMILY[String(typography.fontFamily)];
  return { scale, ...(family ? { fontFamily: family } : {}) };
}

type Css = Record<string, string>;

/**
 * A style key the web renderer adds to a row's children, never authored (the style schema is
 * strict), so a `styleWhen` cannot overwrite it: how CSS flex approximates Compose's sequential
 * Row measure around an aspect ratio (see webRowAspect.ts).
 */
export const ROW_MEASURE_KEY = "webRowMeasure";

/**
 * A style key the web renderer adds to a row around a capped aspect ratio, never authored: the row
 * is bounded to its parent's width, as a Compose Row's max is, and to any authored `maxWidth`.
 */
export const ROW_BOUND_KEY = "webRowBound";

/**
 * A style key the web renderer adds to a column's children, never authored: the tallest that
 * column lets the child be (dp), as Compose's Column measures them in order. It is set only where
 * the column's content height is statically known (see webIncomingHeight.ts).
 */
export const INCOMING_HEIGHT_KEY = "webIncomingHeight";

/**
 * A style key the web renderer adds beside INCOMING_HEIGHT_KEY, never authored: true when that
 * height is a column's weight allocation, which sizes the child outright rather than capping it
 * (see rowContentHeight in webRowAspect.ts).
 */
export const INCOMING_ALLOCATED_KEY = "webIncomingAllocated";

/**
 * A row child's measure hint: `take` makes it the row's lone grower, `zero` measures it against no
 * width, and `shrink` sets how fast it gives up width, from its own `basis` when it has one. `later`
 * marks a sibling after a capped aspect ratio, whose authored `minWidth` holds only while width
 * remains.
 */
export interface RowMeasure {
  readonly take?: true;
  readonly zero?: true;
  readonly shrink?: number;
  readonly basis?: number;
  readonly later?: true;
}

function rowShrinkStyle(css: Css, shrink: number, basis: unknown) {
  if (typeof basis === "number") {
    // The width also sets the item's max-content contribution, so a wrap row sizes around it.
    css["flex-grow"] = "0";
    css[FLEX_BASIS] = px(basis);
    css.width = px(basis);
  }
  css[FLEX_SHRINK] = String(shrink);
}

/**
 * A later sibling's authored `minWidth`, folded into its width (`max(width, minWidth)`) with
 * `min-width: 0`. Android's `sizeIn` intersects the minimum with the width the row has left, so the
 * sibling still gets its minimum while width remains but gives it all up, down to zero, before the
 * capped aspect ratio does. A CSS `min-width` would hold against flex shrinking and reserve the
 * width ahead of the cap. A content or `fill` width has no px value, so rendering wraps the node
 * around a strut instead (see laterMinStrut).
 */
function laterMinWidth(css: Css, style: Raw, min: number, basis: unknown) {
  css[MIN_WIDTH] = "0";
  const dp = record(style.width)?.dp;
  if (typeof basis === "number" || typeof dp === "number") {
    const width = px(Math.max(typeof basis === "number" ? basis : (dp as number), min));
    css.width = width;
    if (typeof basis === "number") {
      css[FLEX_BASIS] = width;
    }
  }
}

/**
 * The authored `minWidth` of a later sibling (see RowMeasure) whose width is content or `fill`, so
 * it has no px value to fold the minimum into; undefined otherwise. Rendering wraps such a node in
 * a cell whose content width is `max(content, minWidth)` and that still shrinks to zero
 * (webLaterMin.ts), which `calc-size()` would express but not every browser supports.
 */
export function laterMinStrut(style: unknown, context: WebStyleContext): number | undefined {
  const raw = record(style);
  const measure = record(raw?.[ROW_MEASURE_KEY]);
  if (
    context.parentAxis !== "row" ||
    measure?.later !== true ||
    typeof raw?.minWidth !== "number"
  ) {
    return undefined;
  }
  const sized = typeof measure.basis === "number" || typeof record(raw.width)?.dp === "number";
  return sized ? undefined : raw.minWidth;
}

/**
 * Applied after the authored bounds. A shrinking or taking child keeps an authored `minWidth`;
 * `zero` beats both bounds, as `sizeIn` clamps an authored minimum into a zero incoming width.
 */
function rowMeasureStyle(css: Css, style: Raw, context: WebStyleContext) {
  const measure = record(style[ROW_MEASURE_KEY]);
  if (context.parentAxis !== "row" || !measure) {
    return;
  }
  if (measure.take === true) {
    css.flex = "1 1 0";
  }
  if (typeof measure.shrink === "number") {
    rowShrinkStyle(css, measure.shrink, measure.basis);
  }
  if (measure.later === true && typeof style.minWidth === "number") {
    laterMinWidth(css, style, style.minWidth, measure.basis);
    return;
  }
  if (typeof style.minWidth !== "number" && (measure.take === true || "shrink" in measure)) {
    css[MIN_WIDTH] = "0";
  }
  if (measure.zero === true) {
    css[MIN_WIDTH] = "0";
    css[MAX_WIDTH] = "0px";
  }
}

export const px = (value: number): string => `${Number(value.toFixed(3))}px`;

/** A font size or line height in sp (points on iOS), scaled by the system text size. */
export function fontPx(sp: number, context: Pick<WebStyleContext, "textScale">): string {
  return px(context.textScale ? context.textScale.font(sp) : sp);
}

function trackingPx(sp: number, context: WebStyleContext): string {
  return px(context.textScale ? context.textScale.tracking(sp) : sp);
}

/** Material 3 shape scale, the same corner sizes both native renderers use. */
const SHAPE_TOKENS: Readonly<Record<string, number>> = {
  none: 0,
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 28,
  full: 9999,
};

function dimension(css: Css, axis: "width" | "height", value: unknown, context: WebStyleContext) {
  const mainAxis = context.parentAxis === (axis === "width" ? "row" : "column");
  if (value === "fill") {
    if (mainAxis) {
      css.flex = "1 1 auto";
    } else if (context.parentAxis) {
      css[ALIGN_SELF] = "stretch";
      css[axis] = "100%";
    } else {
      // A box lays children out on a grid, where each axis has its own self-alignment.
      css[axis === "width" ? "justify-self" : "align-self"] = "stretch";
      css[axis] = "100%";
    }
  } else if (typeof record(value)?.dp === "number") {
    css[axis] = px(record(value)!.dp as number);
    css[FLEX_SHRINK] = "0";
  }
}

function corners(value: unknown): Css | undefined {
  if (typeof value === "number") {
    return { [BORDER_RADIUS]: px(value) };
  }
  if (typeof value === "string") {
    return SHAPE_TOKENS[value] === undefined
      ? undefined
      : { [BORDER_RADIUS]: px(SHAPE_TOKENS[value]!) };
  }
  const shape = record(value);
  if (!shape) {
    return undefined;
  }
  const corner = (name: string) =>
    px(typeof shape[name] === "number" ? (shape[name] as number) : 0);
  // Logical corners follow the element's direction, so an RTL window mirrors them.
  return {
    "border-start-start-radius": corner("topStart"),
    "border-start-end-radius": corner("topEnd"),
    "border-end-end-radius": corner("bottomEnd"),
    "border-end-start-radius": corner("bottomStart"),
  };
}

function boxStyle(css: Css, style: Raw, context: WebStyleContext) {
  const padding = record(style.padding);
  for (const [side, property] of [
    ["top", "padding-top"],
    ["bottom", "padding-bottom"],
    ["start", "padding-inline-start"],
    ["end", "padding-inline-end"],
  ] as const) {
    if (typeof padding?.[side] === "number") {
      css[property] = px(padding[side] as number);
    }
  }
  const background = cssColor(style.background, context);
  if (background) {
    css[BACKGROUND_COLOR] = background;
  }
  const radius = corners(style.cornerRadius);
  if (radius) {
    Object.assign(css, radius);
    css.overflow = "hidden";
  }
  paintStyle(css, style, context);
  if (typeof style.alpha === "number") {
    css.opacity = String(style.alpha);
  }
}

/** Gradient, border, glass and shadows, after the background and shape they paint with. */
function paintStyle(css: Css, style: Raw, context: WebStyleContext) {
  // Android paints the gradient over the background, across the whole node.
  const gradient = gradientCss(style.gradient, context);
  if (gradient) {
    css["background-image"] = gradient;
    css["background-origin"] = "border-box";
  }
  // A gradient border is drawn over the content by the node's overlay layers instead.
  const border = record(style.border);
  if (typeof border?.width === "number" && border.gradient === undefined) {
    css.border = `${px(border.width)} solid ${cssColor(border.color, context) ?? "currentColor"}`;
  }
  // Glass tints behind an authored background, which keeps its own colour.
  const { [BACKGROUND_COLOR]: glassFill, [BOX_SHADOW]: rim, ...glass } = glassCss(style, context);
  Object.assign(css, glass);
  if (glassFill && !css[BACKGROUND_COLOR]) {
    css[BACKGROUND_COLOR] = glassFill;
  }
  const shadow = [elevationCss(style, context), shadowsCss(style, false, context), rim]
    .filter((value): value is string => value !== undefined)
    .join(",");
  if (shadow) {
    css[BOX_SHADOW] = shadow;
  }
}

function sizeStyle(css: Css, style: Raw, context: WebStyleContext) {
  dimension(css, "width", style.width, context);
  dimension(css, "height", style.height, context);
  if (typeof style.weight === "number" && context.parentAxis) {
    css.flex = `${style.weight} ${style.weight} 0`;
    css[context.parentAxis === "row" ? "min-width" : "min-height"] = "0";
  }
  for (const [field, property] of [
    ["minWidth", "min-width"],
    ["maxWidth", "max-width"],
    ["minHeight", "min-height"],
    ["maxHeight", "max-height"],
  ] as const) {
    if (typeof style[field] === "number") {
      css[property] = px(style[field] as number);
    }
  }
  if (style[ROW_BOUND_KEY] === true && context.unboundedWidth !== true) {
    // An authored maxWidth intersects the parent's width, as Compose's sizeIn does.
    const authored = typeof style.maxWidth === "number" ? px(style.maxWidth) : undefined;
    css[MAX_WIDTH] = authored ? `min(100%, ${authored})` : "100%";
  }
  // After the bound: a nested row its parent row measures against no width stays at zero.
  rowMeasureStyle(css, style, context);
  if (typeof style.aspectRatio === "number") {
    css[ASPECT_RATIO] = String(style.aspectRatio);
    aspectRatioFill(css, style, style.aspectRatio, context);
  }
}

/**
 * Compose's `aspectRatio(ratio)` sizes an unsized node from the incoming max width first, so the
 * box fills the available width instead of hugging its content. When that height would overflow
 * the node's own max height, the width shrinks to keep the ratio, as `matchHeightConstraintsFirst
 * = false` falls back to the height bound. In a row the width is the main axis, which CSS
 * `aspect-ratio` already leaves to the content and arrangement.
 */
function aspectRatioFill(css: Css, style: Raw, ratio: number, context: WebStyleContext) {
  const sized =
    style.width !== undefined || style.height !== undefined || typeof style.weight === "number";
  if (sized || ratio <= 0 || context.parentAxis === "row") {
    return;
  }
  // Sizing only: a capped width still follows the parent's authored cross-axis alignment.
  css.width = "100%";
  if (typeof style.maxHeight === "number") {
    const heightBound = style.maxHeight * ratio;
    const widthBound = typeof style.maxWidth === "number" ? style.maxWidth : Infinity;
    css[MAX_WIDTH] = px(Math.min(heightBound, widthBound));
  }
}

const TEXT_ALIGN_VALUES: Readonly<Record<string, string>> = {
  start: "start",
  center: CENTER,
  end: "end",
  justify: "justify",
};

/** The Material 3 type scale both devices use for `style.textStyle`: size, line height, weight. */
const TYPE_SCALE: Readonly<Record<string, [number, number, number]>> = {
  displayLarge: [57, 64, 400],
  displayMedium: [45, 52, 400],
  displaySmall: [36, 44, 400],
  headlineLarge: [32, 40, 400],
  headlineMedium: [28, 36, 400],
  headlineSmall: [24, 32, 400],
  titleLarge: [22, 28, 400],
  titleMedium: [16, 24, 500],
  titleSmall: [14, 20, 500],
  bodyLarge: [16, 24, 400],
  bodyMedium: [14, 20, 400],
  bodySmall: [12, 16, 400],
  labelLarge: [14, 20, 500],
  labelMedium: [12, 16, 500],
  labelSmall: [11, 16, 500],
};

function typographyRole(style: Raw, context: WebStyleContext): Css {
  const role = typeof style.textStyle === "string" ? TYPE_SCALE[style.textStyle] : undefined;
  if (!role) {
    return {};
  }
  const scale = context.typography?.scale ?? 1;
  const family = context.typography?.fontFamily;
  return {
    [FONT_SIZE]: fontPx(role[0] * scale, context),
    [LINE_HEIGHT]: fontPx(role[1] * scale, context),
    [FONT_WEIGHT]: String(role[2]),
    ...(family ? { [FONT_FAMILY]: family } : {}),
  };
}

/** Text styles inherit in CSS as they do down a native text tree. */
/** Built-in families; `default` and bundled assets keep the frame's font, since no font is inlined. */
const FONT_FAMILY_VALUES: Readonly<Record<string, string>> = {
  sansSerif: "sans-serif",
  serif: "serif",
  monospace: "monospace",
};

const FONT_STYLE: Readonly<Record<string, string>> = { italic: "italic", normal: "normal" };

const TEXT_DECORATION: Readonly<Record<string, string>> = {
  none: "none",
  underline: "underline",
  lineThrough: "line-through",
  underlineLineThrough: "underline line-through",
};

export function textCss(style: Raw | undefined, context: WebStyleContext): Css {
  if (!style) {
    return {};
  }
  // The role's typography first; explicit size, weight and line height override it.
  const css: Css = typographyRole(style, context);
  const color = cssColor(style.color, context);
  if (color) {
    css.color = color;
  }
  if (typeof style.textSize === "number") {
    css[FONT_SIZE] = fontPx(style.textSize, context);
  }
  if (typeof style.fontWeight === "number") {
    css[FONT_WEIGHT] = String(style.fontWeight);
  }
  if (typeof style.textAlign === "string" && TEXT_ALIGN_VALUES[style.textAlign]) {
    css[TEXT_ALIGN] = TEXT_ALIGN_VALUES[style.textAlign]!;
  }
  if (typeof style.lineHeight === "number") {
    css[LINE_HEIGHT] = fontPx(style.lineHeight, context);
  }
  if (typeof style.letterSpacing === "number") {
    css["letter-spacing"] = trackingPx(style.letterSpacing, context);
  }
  // Both values emit, so an explicit `normal` span overrides an italic parent.
  const fontStyle = FONT_STYLE[String(style.fontStyle)];
  if (fontStyle) {
    css["font-style"] = fontStyle;
  }
  const family = FONT_FAMILY_VALUES[String(style.fontFamily)];
  if (family) {
    css[FONT_FAMILY] = family;
  }
  const decoration = TEXT_DECORATION[String(style.textDecoration)];
  if (decoration) {
    css["text-decoration"] = decoration;
  }
  return css;
}

/** The CSS for a node's own box: size, padding, background, shape, border, elevation, alpha. */
export function nodeCss(style: unknown, context: WebStyleContext): Css {
  const css: Css = { [BOX_SIZING]: BORDER_BOX };
  const raw = record(style);
  if (raw) {
    sizeStyle(css, raw, context);
    boxStyle(css, raw, context);
  }
  return css;
}

const MAIN_ALIGN: Readonly<Record<string, string>> = {
  start: "flex-start",
  center: CENTER,
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
};

/** A container node and the style context it renders in. */
interface ContainerScope {
  readonly style: WebStyleContext;
}

/**
 * What a container's children see: the axis it lays them out on, and an unbounded width only while
 * the container leaves its width open. A dp `width` or a `maxWidth` bounds its children again, as
 * Compose's `Modifier.width` and `widthIn` restore a finite max width inside a horizontal scroll.
 */
export function containerChildStyle(
  scope: ContainerScope,
  node: Raw,
  parentAxis: "row" | "column" | undefined,
): WebStyleContext {
  const style = record(node.style);
  const definite =
    typeof record(style?.width)?.dp === "number" || typeof style?.maxWidth === "number";
  return {
    ...scope.style,
    parentAxis,
    unboundedWidth: scope.style.unboundedWidth === true && !definite,
  };
}

/** What a scroll's child sees: the scroll's axis, and an unbounded width when it scrolls across. */
export function scrollChildStyle(scope: ContainerScope, node: Raw): WebStyleContext {
  const horizontal = node.axis === "horizontal";
  const inner = containerChildStyle(scope, node, horizontal ? "row" : "column");
  return horizontal ? { ...inner, unboundedWidth: true } : inner;
}

/** A row or column's flex layout: direction, arrangement, spacing and cross-axis alignment. */
export function lineCss(axis: "row" | "column", style: unknown): Css {
  const raw = record(style);
  const css: Css = { display: FLEX, [FLEX_DIRECTION]: axis };
  const arrangement =
    typeof raw?.arrangement === "string" ? MAIN_ALIGN[raw.arrangement] : undefined;
  if (arrangement) {
    css[JUSTIFY_CONTENT] = arrangement;
  }
  if (typeof raw?.spacing === "number") {
    css.gap = px(raw.spacing);
  }
  // Both devices start-align a line's children on the cross axis unless `alignment` says
  // otherwise; CSS would stretch them. Fill-sized children stretch themselves.
  const alignment = typeof raw?.alignment === "string" ? raw.alignment : "topStart";
  css[ALIGN_ITEMS] = axis === "row" ? verticalPart(alignment) : horizontalPart(alignment);
  return css;
}

function verticalPart(alignment: string): string {
  if (alignment.startsWith("top")) {
    return "flex-start";
  }
  return alignment.startsWith("bottom") ? "flex-end" : "center";
}

function horizontalPart(alignment: string): string {
  if (alignment.endsWith("Start")) {
    return "flex-start";
  }
  return alignment.endsWith("End") ? "flex-end" : "center";
}

/** A box stacks its children on one cell and aligns them by `style.alignment`. */
export function boxLayoutCss(style: unknown): Css {
  const alignment = record(style)?.alignment;
  const value = typeof alignment === "string" ? alignment : "topStart";
  return {
    display: "grid",
    "grid-template-areas": '"cell"',
    [ALIGN_ITEMS]: verticalPart(value).replace("flex-", ""),
    "justify-items": horizontalPart(value).replace("flex-", ""),
  };
}

/**
 * A multiline field keeps its newlines and its authored minLines and maxLines (24 sp lines, scaled
 * with the system text size).
 */
export function multilineCss(node: Raw, context: WebStyleContext): Record<string, string> {
  if (node.multiline !== true) {
    return {};
  }
  // One line scales first; the bounds are whole lines of that height, since the non-linear
  // Android curve would under-size a multi-line total.
  const line = context.textScale ? context.textScale.font(24) : 24;
  const css: Record<string, string> = { [WHITE_SPACE]: "pre-wrap", [LINE_HEIGHT]: px(line) };
  if (typeof node.minLines === "number") {
    css[MIN_HEIGHT] = px(node.minLines * line);
  }
  if (typeof node.maxLines === "number") {
    css[MAX_HEIGHT] = px(node.maxLines * line);
    css.overflow = "hidden";
  }
  return css;
}
