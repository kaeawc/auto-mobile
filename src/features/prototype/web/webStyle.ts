import { record, type Raw } from "../prototypeTemplate";
import { resolvePrototypeColor, type PrototypeColorMode, type Rgba } from "../prototypeContrast";
import type { TextScale } from "./webTextScale";

/** What a node's style needs from its surroundings: the colour mode and the parent's main axis. */
export interface WebStyleContext {
  readonly mode: PrototypeColorMode;
  readonly palette: ReadonlyMap<string, Rgba>;
  /** The flex direction of the parent, when it lays children out in a line. */
  readonly parentAxis?: "row" | "column";
  /** The spec's theme.typography, applied to every type-scale role as the native theme does. */
  readonly typography?: { readonly scale: number; readonly fontFamily?: string };
  /** The system text size (Android font scale, iOS Dynamic Type); absent at the default size. */
  readonly textScale?: TextScale;
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

const px = (value: number): string => `${Number(value.toFixed(3))}px`;

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

/** A resolved colour as a CSS `rgba()` string, alpha rounded to three places. */
export function rgbaCss(color: Rgba): string {
  return `rgba(${color.r},${color.g},${color.b},${Number(color.a.toFixed(3))})`;
}

export function cssColor(value: unknown, context: WebStyleContext): string | undefined {
  const color = resolvePrototypeColor(value, context.mode, context.palette);
  return color ? rgbaCss(color) : undefined;
}

function dimension(css: Css, axis: "width" | "height", value: unknown, context: WebStyleContext) {
  const mainAxis = context.parentAxis === (axis === "width" ? "row" : "column");
  if (value === "fill") {
    if (mainAxis) {
      css.flex = "1 1 auto";
    } else if (context.parentAxis) {
      css["align-self"] = "stretch";
      css[axis] = "100%";
    } else {
      // A box lays children out on a grid, where each axis has its own self-alignment.
      css[axis === "width" ? "justify-self" : "align-self"] = "stretch";
      css[axis] = "100%";
    }
  } else if (typeof record(value)?.dp === "number") {
    css[axis] = px(record(value)!.dp as number);
    css["flex-shrink"] = "0";
  }
}

function corners(value: unknown): Css | undefined {
  if (typeof value === "number") {
    return { "border-radius": px(value) };
  }
  if (typeof value === "string") {
    return SHAPE_TOKENS[value] === undefined
      ? undefined
      : { "border-radius": px(SHAPE_TOKENS[value]!) };
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
    css["background-color"] = background;
  }
  const radius = corners(style.cornerRadius);
  if (radius) {
    Object.assign(css, radius);
    css.overflow = "hidden";
  }
  const border = record(style.border);
  if (typeof border?.width === "number") {
    css.border = `${px(border.width)} solid ${cssColor(border.color, context) ?? "currentColor"}`;
  }
  if (typeof style.elevation === "number" && style.elevation > 0) {
    css["box-shadow"] = `0 ${px(style.elevation / 2)} ${px(style.elevation)} rgba(0,0,0,0.25)`;
  }
  if (typeof style.alpha === "number") {
    css.opacity = String(style.alpha);
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
  if (typeof style.aspectRatio === "number") {
    css["aspect-ratio"] = String(style.aspectRatio);
  }
}

const TEXT_ALIGN: Readonly<Record<string, string>> = {
  start: "start",
  center: "center",
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
    "font-size": fontPx(role[0] * scale, context),
    "line-height": fontPx(role[1] * scale, context),
    "font-weight": String(role[2]),
    ...(family ? { "font-family": family } : {}),
  };
}

/** Text styles inherit in CSS as they do down a native text tree. */
/** Built-in families; `default` and bundled assets keep the frame's font, since no font is inlined. */
const FONT_FAMILY: Readonly<Record<string, string>> = {
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
    css["font-size"] = fontPx(style.textSize, context);
  }
  if (typeof style.fontWeight === "number") {
    css["font-weight"] = String(style.fontWeight);
  }
  if (typeof style.textAlign === "string" && TEXT_ALIGN[style.textAlign]) {
    css["text-align"] = TEXT_ALIGN[style.textAlign]!;
  }
  if (typeof style.lineHeight === "number") {
    css["line-height"] = fontPx(style.lineHeight, context);
  }
  if (typeof style.letterSpacing === "number") {
    css["letter-spacing"] = trackingPx(style.letterSpacing, context);
  }
  // Both values emit, so an explicit `normal` span overrides an italic parent.
  const fontStyle = FONT_STYLE[String(style.fontStyle)];
  if (fontStyle) {
    css["font-style"] = fontStyle;
  }
  const family = FONT_FAMILY[String(style.fontFamily)];
  if (family) {
    css["font-family"] = family;
  }
  const decoration = TEXT_DECORATION[String(style.textDecoration)];
  if (decoration) {
    css["text-decoration"] = decoration;
  }
  return css;
}

/** The CSS for a node's own box: size, padding, background, shape, border, elevation, alpha. */
export function nodeCss(style: unknown, context: WebStyleContext): Css {
  const css: Css = { "box-sizing": "border-box" };
  const raw = record(style);
  if (raw) {
    sizeStyle(css, raw, context);
    boxStyle(css, raw, context);
  }
  return css;
}

const MAIN_ALIGN: Readonly<Record<string, string>> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
};

/** A row or column's flex layout: direction, arrangement, spacing and cross-axis alignment. */
export function lineCss(axis: "row" | "column", style: unknown): Css {
  const raw = record(style);
  const css: Css = { display: "flex", "flex-direction": axis };
  const arrangement =
    typeof raw?.arrangement === "string" ? MAIN_ALIGN[raw.arrangement] : undefined;
  if (arrangement) {
    css["justify-content"] = arrangement;
  }
  if (typeof raw?.spacing === "number") {
    css.gap = px(raw.spacing);
  }
  // Both devices start-align a line's children on the cross axis unless `alignment` says
  // otherwise; CSS would stretch them. Fill-sized children stretch themselves.
  const alignment = typeof raw?.alignment === "string" ? raw.alignment : "topStart";
  css["align-items"] = axis === "row" ? verticalPart(alignment) : horizontalPart(alignment);
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
    "align-items": verticalPart(value).replace("flex-", ""),
    "justify-items": horizontalPart(value).replace("flex-", ""),
  };
}
