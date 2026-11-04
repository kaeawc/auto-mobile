import { record, type Raw } from "../prototypeTemplate";
import { resolvePrototypeColor, type Rgba } from "../prototypeContrast";
import { el, type WebElement } from "./webNodes";
import type { WebStyleContext } from "./webStyle";

type Css = Record<string, string>;

const px = (value: number): string => `${Number(value.toFixed(3))}px`;
const pct = (value: number): string => `${Number((value * 100).toFixed(3))}%`;

/** A resolved colour as a CSS `rgba()` string, alpha rounded to three places. */
export function rgbaCss(color: Rgba): string {
  return `rgba(${color.r},${color.g},${color.b},${Number(color.a.toFixed(3))})`;
}

export function cssColor(value: unknown, context: WebStyleContext): string | undefined {
  const color = resolvePrototypeColor(value, context.mode, context.palette);
  return color ? rgbaCss(color) : undefined;
}

/**
 * Stop colours and, only when every stop authors a position, those positions made non-decreasing,
 * as Android's prototypeGradientStops does. A stop that does not resolve is transparent.
 */
function gradientStops(stops: readonly unknown[], context: WebStyleContext): string[] {
  const colors = stops.map((stop) => cssColor(record(stop)?.color, context) ?? "rgba(0,0,0,0)");
  const positions = stops.map((stop) => record(stop)?.position);
  if (!positions.every((position): position is number => typeof position === "number")) {
    return colors;
  }
  let floor = 0;
  return colors.map((color, index) => {
    floor = Math.max(floor, positions[index]!);
    return `${color} ${pct(floor)}`;
  });
}

/**
 * A spec gradient as a CSS image. A linear angle is degrees clockwise from left-to-right (0 runs
 * left to right, 90 top to bottom), so it is CSS's angle plus 90; both size the line so the corners
 * take the end stops. A radial gradient is centred and reaches the corners, as on Android.
 */
export function gradientCss(value: unknown, context: WebStyleContext): string | undefined {
  const gradient = record(value);
  if (!gradient || !Array.isArray(gradient.stops) || gradient.stops.length < 2) {
    return undefined;
  }
  const stops = gradientStops(gradient.stops, context).join(",");
  if (gradient.type === "linear" && typeof gradient.angle === "number") {
    return `linear-gradient(${Number((gradient.angle + 90).toFixed(3))}deg,${stops})`;
  }
  return gradient.type === "radial"
    ? `radial-gradient(circle farthest-corner at 50% 50%,${stops})`
    : undefined;
}

/** One layer as CSS box-shadow: authored blur b is a Gaussian sigma of b/2, which CSS blur is. */
function shadowLayer(layer: Raw, context: WebStyleContext): string | undefined {
  const color = cssColor(layer.color, context);
  if (!color || typeof layer.radius !== "number") {
    return undefined;
  }
  const offset = record(layer.offset);
  const spread = typeof layer.spread === "number" ? layer.spread : 0;
  const parts = [
    px(typeof offset?.x === "number" ? offset.x : 0),
    px(typeof offset?.y === "number" ? offset.y : 0),
    px(layer.radius),
    px(spread),
    color,
  ];
  return (layer.inner === true ? ["inset", ...parts] : parts).join(" ");
}

/**
 * `style.shadows` drop or inner layers as a box-shadow list. Android draws each group in authored
 * order, bottom-most first; CSS lists the top-most first, so the list is reversed.
 */
export function shadowsCss(
  style: Raw,
  inner: boolean,
  context: WebStyleContext,
): string | undefined {
  const layers = Array.isArray(style.shadows) ? style.shadows : [];
  const css = layers
    .map((layer) => record(layer))
    .filter((layer): layer is Raw => layer !== undefined && (layer.inner === true) === inner)
    .map((layer) => shadowLayer(layer, context))
    .filter((layer): layer is string => layer !== undefined)
    .reverse();
  return css.length > 0 ? css.join(",") : undefined;
}

/** Elevation's drop shadow, tinted by `shadowColor` when it resolves; layered shadows replace it. */
export function elevationCss(style: Raw, context: WebStyleContext): string | undefined {
  if (typeof style.elevation !== "number" || style.elevation <= 0 || style.shadows !== undefined) {
    return undefined;
  }
  const tint = resolvePrototypeColor(style.shadowColor, context.mode, context.palette);
  const color = tint ? rgbaCss({ ...tint, a: tint.a * 0.25 }) : "rgba(0,0,0,0.25)";
  return `0 ${px(style.elevation / 2)} ${px(style.elevation)} ${color}`;
}

/** Android's tonal fill alpha, the same one its backdrop fallback uses. */
const GLASS_FALLBACK_ALPHA = 0.85;

/**
 * `surface: "glass"`. An iOS frame draws a Liquid Glass approximation: a blurred, saturated
 * backdrop under a translucent tint (else white) and a light rim. An Android frame draws the tonal
 * fill Android falls back to: the tint, else `surfaceContainer`, at 0.85. Without a corner radius
 * glass is a capsule.
 */
export function glassCss(style: Raw, context: WebStyleContext): Css {
  if (style.surface !== "glass") {
    return {};
  }
  const glass = record(style.glass);
  const tint = resolvePrototypeColor(glass?.tint, context.mode, context.palette);
  const capsule: Css =
    style.cornerRadius === undefined ? { "border-radius": "9999px", overflow: "hidden" } : {};
  const look =
    context.platform === "ios"
      ? iosGlass(tint, glass?.variant === "clear", context)
      : androidGlassFallback(tint, context);
  return { ...capsule, ...look };
}

function androidGlassFallback(tint: Rgba | undefined, context: WebStyleContext): Css {
  const fill = tint ?? resolvePrototypeColor("surfaceContainer", context.mode, context.palette);
  return fill ? { "background-color": rgbaCss({ ...fill, a: GLASS_FALLBACK_ALPHA }) } : {};
}

function iosGlass(tint: Rgba | undefined, clear: boolean, context: WebStyleContext): Css {
  const base = tint ?? { r: 255, g: 255, b: 255, a: 1 };
  // Untinted glass reads dimmer over a dark backdrop.
  const dim = !tint && context.mode === "dark" ? 0.5 : 1;
  return {
    "background-color": rgbaCss({ ...base, a: (clear ? 0.12 : 0.32) * dim }),
    "backdrop-filter": `blur(${clear ? 6 : 16}px) saturate(1.8)`,
    "box-shadow": "inset 0 0 0 1px rgba(255,255,255,0.35)",
  };
}

const OVERLAY: Css = {
  position: "absolute",
  inset: "0",
  "border-radius": "inherit",
  "box-sizing": "border-box",
  "pointer-events": "none",
};

/**
 * What Android paints over a node's content, as absolutely placed layers: a gradient border (a
 * ring masked out of the gradient, drawn inside the bounds as Compose's border is), then inner
 * shadows. Empty when the node has neither.
 */
export function overContentLayers(style: unknown, context: WebStyleContext): WebElement[] {
  const raw = record(style);
  if (!raw) {
    return [];
  }
  const layers: WebElement[] = [];
  const border = record(raw.border);
  const ring = gradientCss(border?.gradient, context);
  if (ring && typeof border?.width === "number" && border.width > 0) {
    layers.push(
      el("span", {
        attrs: { "aria-hidden": "true", "data-layer": "border" },
        style: {
          ...OVERLAY,
          padding: px(border.width),
          "background-image": ring,
          "mask-image": "linear-gradient(#000,#000),linear-gradient(#000,#000)",
          "mask-clip": "content-box,border-box",
          "mask-composite": "exclude",
        },
      }),
    );
  }
  const inner = shadowsCss(raw, true, context);
  if (inner) {
    layers.push(
      el("span", {
        attrs: { "aria-hidden": "true", "data-layer": "innerShadow" },
        style: { ...OVERLAY, "box-shadow": inner },
      }),
    );
  }
  return layers;
}

/** Adds [overContentLayers] after a node's children, positioning the node to hold them. */
export function withOverContentLayers(
  element: WebElement,
  style: unknown,
  context: WebStyleContext,
): WebElement {
  const layers = overContentLayers(style, context);
  if (layers.length === 0) {
    return element;
  }
  return {
    ...element,
    style: { position: "relative", ...element.style },
    children: [...element.children, ...layers],
  };
}

/** A scroll's fade as the page applies it: the mask in `--fade-mask`, the scroll axis in `data-fade`. */
export interface WebFadeEdges {
  readonly attrs: Record<string, string>;
  readonly style: Css;
}

const NO_FADE: WebFadeEdges = { attrs: {}, style: {} };

/**
 * `scroll.fadeEdges` as a mask. Fades show only where scrolling remains; a still opens at the
 * scroll's start (a reverse scroll at its end), so the leading edge never fades. The trailing
 * edge's mask is handed to the page's {@link FADE_EDGES_PAGE_CSS}, which draws it only while the
 * browser can scroll the element, as Android draws it only while `canScrollForward`. Start and
 * end mirror in RTL.
 */
export function fadeEdgesCss(node: Raw, context: WebStyleContext): WebFadeEdges {
  const fades = record(node.fadeEdges);
  if (!fades) {
    return NO_FADE;
  }
  const horizontal = node.axis === "horizontal";
  const reverse = node.reverse === true;
  const field = horizontal ? (reverse ? "start" : "end") : reverse ? "top" : "bottom";
  const length = fades[field];
  if (typeof length !== "number" || length <= 0) {
    return NO_FADE;
  }
  // The direction the fade runs from its transparent edge into the content.
  const physicalEnd = horizontal && (field === "end") !== (context.rtl === true);
  const toward = horizontal
    ? physicalEnd
      ? "to left"
      : "to right"
    : field === "bottom"
      ? "to top"
      : "to bottom";
  // Clamped to the viewport, as Android's prototypeFadeLine does, so the far edge stays opaque.
  return {
    attrs: { "data-fade": horizontal ? "x" : "y" },
    style: {
      "--fade-mask": `linear-gradient(${toward},rgba(0,0,0,0) 0,#000 min(${px(length)},100%))`,
    },
  };
}

/**
 * Page rules that draw a scroll's `--fade-mask` only while its content overflows (#16606). A
 * scroll-driven animation holds the mask for its whole range, and its `scroll(self)` timeline is
 * inactive while the element cannot scroll, so content that fits draws no fade. It depends only on
 * layout, not on time, so a screenshot is deterministic. A browser without scroll-driven
 * animations always draws the mask, as the still did before it could tell.
 */
export const FADE_EDGES_PAGE_CSS =
  "@keyframes prototype-fade{from,to{mask-image:var(--fade-mask)}}" +
  "@supports (animation-timeline:scroll()){[data-fade]{animation-name:prototype-fade;animation-duration:auto;animation-timing-function:linear;animation-fill-mode:both;animation-timeline:scroll(self y)}[data-fade=x]{animation-timeline:scroll(self x)}}" +
  "@supports not (animation-timeline:scroll()){[data-fade]{mask-image:var(--fade-mask)}}";

/**
 * A node with `style.shader` draws without it, as a device without shader support does; the
 * still lists it with reason `shaderFallback`.
 */
export function shaderFallback(
  node: Raw,
  path: string,
): { type: string; id?: string; path: string; reason: "shaderFallback" } | undefined {
  if (record(node.style)?.shader === undefined) {
    return undefined;
  }
  const id = typeof node.id === "string" ? node.id : undefined;
  return { type: String(node.type), ...(id ? { id } : {}), path, reason: "shaderFallback" };
}
