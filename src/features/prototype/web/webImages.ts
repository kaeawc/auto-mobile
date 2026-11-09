import { record, type Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import { resolvePrototypeColor } from "../prototypeContrast";
import { cssColor, rgbaCss, type WebStyleContext } from "./webStyle";
import type { NodeRenderer, WebRenderScope } from "./webRender";

/** How an image fits its box, as both devices read `contentScale` (default `fit`). */
export type WebImageScale = "fit" | "crop" | "fill";

/**
 * One drawn image: its asset, the dp the node fixes on each axis (none for fill or wrap), and
 * which axes fill their parent.
 */
export interface WebImageDraw {
  readonly asset: string;
  readonly widthDp?: number;
  readonly heightDp?: number;
  readonly widthFill?: true;
  readonly heightFill?: true;
  readonly scale: WebImageScale;
}

/** An encoded image the page may inline: its asset id, WebP bytes and pixel size. */
export interface PrototypeWebImage {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const BACKGROUND_SIZE: Readonly<Record<WebImageScale, string>> = {
  fit: "contain",
  crop: "cover",
  fill: "100% 100%",
};

export function webImageScale(value: unknown): WebImageScale {
  return value === "crop" || value === "fill" ? value : "fit";
}

/** The custom property holding slot `slot`'s image; `-bg`, `-ar` and `-on` hang off it. */
export function webImageVar(slot: number, suffix = ""): string {
  return `--pa-${slot}${suffix}`;
}

/** The asset an image node draws in this mode: a light/dark pair picks its side. */
export function webImageAsset(
  value: unknown,
  mode: WebStyleContext["mode"],
  bind: (text: string) => string,
): string | undefined {
  const pair = record(value);
  const chosen = pair ? (mode === "dark" ? pair.dark : pair.light) : value;
  if (typeof chosen !== "string") {
    return undefined;
  }
  const id = bind(chosen);
  return id.length > 0 ? id : undefined;
}

function fixedDp(value: unknown): number | undefined {
  const dp = record(value)?.dp;
  return typeof dp === "number" ? dp : undefined;
}

const sized = (value: unknown) => value === "fill" || fixedDp(value) !== undefined;

/** One authored padding side in dp (0 when unset). */
function paddingDp(style: Raw, side: "top" | "bottom" | "start" | "end"): number {
  const value = record(style.padding)?.[side];
  return typeof value === "number" ? value : 0;
}

const DEFAULT_MINIMUM = "48px";

/**
 * The placeholder's 48px minimum on each axis the node does not fix in dp: an authored size wins
 * over the image's default minimum on both devices, so a 24 dp icon stays 24 dp.
 */
function webImageMinimum(style: Raw): Record<string, string> {
  return {
    ...(fixedDp(style.width) === undefined ? { "min-width": DEFAULT_MINIMUM } : {}),
    ...(fixedDp(style.height) === undefined ? { "min-height": DEFAULT_MINIMUM } : {}),
  };
}

/** Each axis's min and max properties, its size and authored-minimum fields, and its padding. */
const MINIMUM_AXES = [
  ["min-width", "max-width", "width", "minWidth", "padding-inline-start", "padding-inline-end"],
  ["min-height", "max-height", "height", "minHeight", "padding-top", "padding-bottom"],
] as const;

/**
 * The default minimum on a wrapped axis, made the content box's: the page sizes border boxes, so
 * the minimum adds the axis's resolved padding (safe-area insets included), which the image layers
 * sit inside. A filled axis takes its parent's extent, so its padding never pushes the minimum past
 * the space the parent gives it; an authored minimum, or a weight's zero, stays as resolved. A
 * resolved maximum caps the padded minimum, since a CSS minimum would otherwise override it.
 */
export function webImageContentMinimum(
  node: Raw,
  box: Readonly<Record<string, string>>,
): Record<string, string> {
  const style = record(node.style) ?? {};
  const css: Record<string, string> = {};
  for (const [property, maximum, size, authored, start, end] of MINIMUM_AXES) {
    const padding = [box[start], box[end]].filter((value) => value !== undefined);
    const wrapped = style[size] !== "fill" && typeof style[authored] !== "number";
    if (wrapped && box[property] === DEFAULT_MINIMUM && padding.length > 0) {
      const padded = `calc(${[DEFAULT_MINIMUM, ...padding].join(" + ")})`;
      css[property] = box[maximum] === undefined ? padded : `min(${box[maximum]}, ${padded})`;
    }
  }
  return css;
}

/** A fixed dp axis less the padding on both its sides, as Android's image target subtracts it. */
function contentDp(size: number | undefined, padding: number): number | undefined {
  return size === undefined ? undefined : Math.max(0, size - padding);
}

/** The draw a node needs: a fixed axis is its content box, the authored padding taken out. */
export function webImageDraw(asset: string, node: Raw): WebImageDraw {
  const style = record(node.style) ?? {};
  const widthDp = contentDp(
    fixedDp(style.width),
    paddingDp(style, "start") + paddingDp(style, "end"),
  );
  const heightDp = contentDp(
    fixedDp(style.height),
    paddingDp(style, "top") + paddingDp(style, "bottom"),
  );
  return {
    asset,
    ...(widthDp === undefined ? {} : { widthDp }),
    ...(heightDp === undefined ? {} : { heightDp }),
    ...(style.width === "fill" ? { widthFill: true as const } : {}),
    ...(style.height === "fill" ? { heightFill: true as const } : {}),
    scale: webImageScale(node.contentScale),
  };
}

/**
 * The image node's own box styles for an inlinable asset: the placeholder colour until the page
 * inlines the asset (which sets `-bg` transparent), and the image's aspect ratio on an axis the
 * node leaves to wrap, as a native image keeps its natural size there.
 */
export function webImageBoxCss(
  slot: number,
  node: Raw,
  placeholder: string,
): Record<string, string> {
  const style = record(node.style) ?? {};
  return {
    "background-color": `var(${webImageVar(slot, "-bg")}, ${placeholder})`,
    ...webImageMinimum(style),
    position: "relative",
    isolation: "isolate",
    ...(sized(style.width) && sized(style.height)
      ? {}
      : { "aspect-ratio": `var(${webImageVar(slot, "-ar")}, auto)` }),
  };
}

/**
 * A wrapped axis's length when the other axis is fixed and the node is padded: the image's ratio
 * holds for the content box the layers sit in, so the wrapped axis is the fixed axis's content
 * length times the ratio, plus its own padding. CSS `aspect-ratio` would hold for the border box
 * instead (the page sizes border boxes), distorting a `fill` image. Until the page inlines the
 * asset its ratio variable is unset, so the length is invalid and the axis wraps as before.
 */
export function webImageContentRatio(
  slot: number,
  box: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const pad = (side: string) => box[side] ?? "0px";
  const padded = LAYER_INSETS.some(([padding]) => box[padding] !== undefined);
  // Only the default intrinsic ratio is the image's; an authored aspectRatio stays as resolved.
  if (box["aspect-ratio"] !== `var(${webImageVar(slot, "-ar")}, auto)` || !padded) {
    return undefined;
  }
  const inline = `${pad("padding-inline-start")} - ${pad("padding-inline-end")}`;
  const block = `${pad("padding-top")} - ${pad("padding-bottom")}`;
  if (box.width?.endsWith("px") && box.height === undefined) {
    const width = usedLength(box.width, box["min-width"], box["max-width"]);
    return {
      height: `calc((${width} - ${inline}) * var(${webImageVar(slot, "-hw")}) + ${pad("padding-top")} + ${pad("padding-bottom")})`,
    };
  }
  if (box.height?.endsWith("px") && box.width === undefined) {
    const height = usedLength(box.height, box["min-height"], box["max-height"]);
    return {
      width: `calc((${height} - ${block}) * var(${webImageVar(slot, "-wh")}) + ${pad("padding-inline-start")} + ${pad("padding-inline-end")})`,
    };
  }
  return undefined;
}

/** A fixed length as CSS uses it: capped by its maximum, then raised to its minimum. */
function usedLength(length: string, minimum?: string, maximum?: string): string {
  const capped = maximum === undefined ? length : `min(${length}, ${maximum})`;
  return minimum === undefined ? capped : `max(${minimum}, ${capped})`;
}

/** The padding longhands whose values inset the image layers, and the inset each one sets. */
const LAYER_INSETS = [
  ["padding-top", "top"],
  ["padding-inline-end", "inset-inline-end"],
  ["padding-bottom", "bottom"],
  ["padding-inline-start", "inset-inline-start"],
] as const;

/**
 * The image layers' inset inside the node's resolved box style: each side sits at that side's
 * padding (safe-area additions included), as absolute children ignore their parent's padding.
 * Logical start/end follow the element's direction, so an RTL window mirrors them.
 */
export function webImageLayerInset(box: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(LAYER_INSETS.map(([padding, inset]) => [inset, box[padding] ?? "0"]));
}

const ZERO_INSET = webImageLayerInset({});

/**
 * The drawn image and its filter: the image saturates first, then a separate tint layer
 * multiplies it (Android's `BlendMode.Modulate` on an offscreen layer), masked by the image so
 * transparent pixels stay clear. The tint layer is invisible until the page inlines the asset.
 * `Modulate` multiplies alpha too, so the tint draws its opaque colour and a translucent tint
 * wraps both layers in a group at the tint's alpha (`#00FFFFFF` hides the image, as on Android).
 */
export function webImageLayers(
  slot: number,
  node: Raw,
  context: WebStyleContext,
  inset: Readonly<Record<string, string>> = ZERO_INSET,
): WebElement[] {
  const image = `var(${webImageVar(slot)})`;
  const size = BACKGROUND_SIZE[webImageScale(node.contentScale)];
  const filter = record(node.filter);
  const tint =
    filter?.tint === undefined
      ? undefined
      : resolvePrototypeColor(filter.tint, context.mode, context.palette);
  // A translucent tint's group takes the padding inset, so its layers fill the group.
  const grouped = tint !== undefined && tint !== null && tint.a < 1;
  const layerInset = grouped ? ZERO_INSET : inset;
  const saturation = typeof filter?.saturation === "number" ? filter.saturation : 1;
  const layers = [
    el("div", {
      attrs: { "data-image": "" },
      style: {
        position: "absolute",
        ...layerInset,
        "background-image": image,
        "background-size": size,
        "background-position": "center",
        "background-repeat": "no-repeat",
        ...(saturation === 1 ? {} : { filter: `saturate(${saturation})` }),
      },
    }),
  ];
  if (tint) {
    layers.push(
      el("div", {
        attrs: { "data-image-tint": "" },
        style: {
          position: "absolute",
          ...layerInset,
          "background-color": rgbaCss({ ...tint, a: 1 }),
          "mix-blend-mode": "multiply",
          "mask-image": image,
          "mask-size": size,
          "mask-position": "center",
          "mask-repeat": "no-repeat",
          opacity: `var(${webImageVar(slot, "-on")}, 0)`,
        },
      }),
    );
  }
  if (grouped) {
    // Opacity isolates the group, so the tint multiplies only the image beneath it.
    const style = { position: "absolute", ...inset, opacity: String(Number(tint.a.toFixed(3))) };
    return [el("div", { attrs: { "data-image-alpha": "" }, style }, layers)];
  }
  return layers;
}

/** A size ratio as a CSS number, to six places. */
const ratio = (numerator: number, denominator: number) =>
  String(Number((numerator / denominator).toFixed(6)));

/** The page rule that inlines one image into its slot's custom properties. */
export function webImageRule(slot: number, image: PrototypeWebImage): string {
  const base64 = Buffer.from(
    image.bytes.buffer,
    image.bytes.byteOffset,
    image.bytes.byteLength,
  ).toString("base64");
  return `:root{${webImageVar(slot)}:url(data:image/webp;base64,${base64});${webImageVar(slot, "-bg")}:transparent;${webImageVar(slot, "-ar")}:${image.width}/${image.height};${webImageVar(slot, "-hw")}:${ratio(image.height, image.width)};${webImageVar(slot, "-wh")}:${ratio(image.width, image.height)};${webImageVar(slot, "-on")}:1}`;
}

/**
 * A pixel box one draw needs, at the frame's density. `cover` (crop and fill) must cover each
 * fixed axis and each filled axis, a filled axis bounded by `fill`: the screen's long side, the
 * widest either orientation draws it, or its short side, the width the portrait view draws it.
 * Otherwise the image fits inside the box, an unfixed axis bounded by the screen's long side.
 */
export interface WebImageBox {
  readonly width?: number;
  readonly height?: number;
  readonly cover: boolean;
}

/** The dp a cover box covers on one axis: its fixed dp, else a filled axis's bound, else none. */
function coverDp(fixed: number | undefined, filled: true | undefined, fillDp: number) {
  return fixed ?? (filled ? fillDp : undefined);
}

/** The screen extent a filled axis of a cover box is bounded by. */
export type WebImageFillExtent = "long" | "short";

export function webImageBox(
  draw: WebImageDraw,
  frame: { readonly widthDp: number; readonly heightDp: number; readonly density: number },
  fill: WebImageFillExtent = "long",
): WebImageBox {
  const long = Math.max(frame.widthDp, frame.heightDp);
  const fillDp = fill === "long" ? long : Math.min(frame.widthDp, frame.heightDp);
  const px = (dp: number) => Math.ceil(dp * frame.density);
  if (draw.scale !== "fit" && (draw.widthDp !== undefined || draw.heightDp !== undefined)) {
    const width = coverDp(draw.widthDp, draw.widthFill, fillDp);
    const height = coverDp(draw.heightDp, draw.heightFill, fillDp);
    return {
      ...(width === undefined ? {} : { width: px(width) }),
      ...(height === undefined ? {} : { height: px(height) }),
      cover: true,
    };
  }
  return { width: px(draw.widthDp ?? long), height: px(draw.heightDp ?? long), cover: false };
}

/**
 * The scale (at most 1: never enlarged) that serves every box from a source of this size: the
 * largest each box needs, so one encode serves every place the frame draws the asset.
 */
export function webImageScaleFactor(
  source: { readonly width: number; readonly height: number },
  boxes: readonly WebImageBox[],
): number {
  const needs = boxes.map((box) => {
    const ratios = [
      ...(box.width === undefined ? [] : [box.width / source.width]),
      ...(box.height === undefined ? [] : [box.height / source.height]),
    ];
    return box.cover ? Math.max(...ratios) : Math.min(...ratios);
  });
  return Math.min(1, Math.max(0, ...needs));
}

/** What the image renderer borrows from the node renderer: shared node styling and text binding. */
export interface WebImageRendererHelpers {
  base(
    node: Raw,
    scope: WebRenderScope,
    extra: Record<string, string>,
  ): { attrs: Record<string, string>; style: Record<string, string> };
  bound(text: unknown, scope: WebRenderScope): string;
}

const withoutAspect = (style: Record<string, string>) =>
  Object.fromEntries(Object.entries(style).filter(([key]) => key !== "aspect-ratio"));

const padMinimum = (node: Raw, style: Record<string, string>) => ({
  ...style,
  ...webImageContentMinimum(node, style),
});

/** An inlined image's box: its padded minimum, and a content-box length for the ratio if padded. */
function inlinedBox(slot: number, node: Raw, style: Record<string, string>) {
  const length = webImageContentRatio(slot, style);
  const padded = padMinimum(node, style);
  // A content-box length replaces the border-box aspect ratio on the wrapped axis.
  return length === undefined ? padded : withoutAspect({ ...padded, ...length });
}

/**
 * An `image`: with a slot for its bound asset, the slot's image layers; otherwise a placeholder.
 * Every bound asset is recorded as drawn, so the page can encode it at the size drawn.
 */
export function webImageRenderer({ base, bound }: WebImageRendererHelpers): NodeRenderer {
  return (node, scope, path) => {
    const asset = webImageAsset(node.asset, scope.style.mode, (text) => bound(text, scope));
    const slot = asset === undefined ? undefined : scope.imageSlots?.get(asset);
    // An inlinable asset is listed as over budget until the page inlines it and drops the entry.
    scope.unsupported.push({
      type: "image",
      ...(typeof node.id === "string" ? { id: node.id } : {}),
      path,
      reason: slot === undefined ? "assetNotInlined" : "assetOverBudget",
      ...(asset === undefined ? {} : { asset }),
    });
    if (asset !== undefined) {
      scope.imageDraws?.push(webImageDraw(asset, node));
    }
    const placeholder = cssColor("surfaceVariant", scope.style) ?? "#e7e0ec";
    if (asset === undefined || slot === undefined) {
      const { attrs, style } = base(node, scope, {
        "background-color": placeholder,
        ...webImageMinimum(record(node.style) ?? {}),
      });
      return el("div", { attrs: { ...attrs, role: "img" }, style: padMinimum(node, style) });
    }
    const { attrs, style } = base(node, scope, webImageBoxCss(slot, node, placeholder));
    return el(
      "div",
      { attrs: { ...attrs, role: "img" }, style: inlinedBox(slot, node, style) },
      webImageLayers(slot, node, scope.style, webImageLayerInset(style)),
    );
  };
}
