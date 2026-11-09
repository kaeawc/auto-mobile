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
  /** A wrapped axis's authored minimum less its padding: the least a cover box covers there. */
  readonly minWidthDp?: number;
  readonly minHeightDp?: number;
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

/** A wrapped axis: neither fixed in dp nor filled, so the image's own size decides it. */
const wrapped = (value: unknown) => !sized(value);

/**
 * The placeholder's 48px minimum on each axis the node does not fix in dp: an authored size wins
 * over the image's default minimum on both devices, so a 24 dp icon stays 24 dp.
 */
function webImageMinimum(style: Raw): Record<string, string> {
  return {
    ...(fixedDp(style.width) === undefined ? { "min-width": "48px" } : {}),
    ...(fixedDp(style.height) === undefined ? { "min-height": "48px" } : {}),
  };
}

/** One authored padding side in dp (0 when unset). */
function paddingDp(style: Raw, side: "top" | "bottom" | "start" | "end"): number {
  const value = record(style.padding)?.[side];
  return typeof value === "number" ? value : 0;
}

/**
 * A fixed dp axis's content length: the length its authored bounds let it take (capped by the
 * maximum, then raised to the minimum, as both devices bound a size), less the padding on both its
 * sides, as Android's image target subtracts it.
 */
function contentDp(style: Raw, axis: "width" | "height"): number | undefined {
  const fixed = fixedDp(style[axis]);
  if (fixed === undefined) {
    return undefined;
  }
  const bound = (field: string) => (typeof style[field] === "number" ? style[field] : undefined);
  const suffix = axis === "width" ? "Width" : "Height";
  const capped = Math.min(fixed, bound(`max${suffix}`) ?? Infinity);
  const used = Math.max(capped, bound(`min${suffix}`) ?? 0);
  const padding =
    axis === "width"
      ? paddingDp(style, "start") + paddingDp(style, "end")
      : paddingDp(style, "top") + paddingDp(style, "bottom");
  return Math.max(0, used - padding);
}

/** A wrapped axis's authored minimum, less its padding: the content box's least extent there. */
function wrappedMinimumDp(style: Raw, axis: "width" | "height"): number | undefined {
  const minimum = style[axis === "width" ? "minWidth" : "minHeight"];
  if (!wrapped(style[axis]) || typeof minimum !== "number") {
    return undefined;
  }
  const padding =
    axis === "width"
      ? paddingDp(style, "start") + paddingDp(style, "end")
      : paddingDp(style, "top") + paddingDp(style, "bottom");
  return Math.max(0, minimum - padding);
}

/**
 * The draw a node needs: a fixed axis is its content box, its bounds applied, padding taken out.
 * `parentAxis` is the axis the parent lays children along: a weight there sizes the node by its
 * share, overriding its authored dp, so that axis is filled rather than fixed.
 */
export function webImageDraw(
  asset: string,
  node: Raw,
  parentAxis?: "row" | "column",
): WebImageDraw {
  const style = record(node.style) ?? {};
  const weighted = typeof style.weight === "number" ? parentAxis : undefined;
  const widthDp = weighted === "row" ? undefined : contentDp(style, "width");
  const heightDp = weighted === "column" ? undefined : contentDp(style, "height");
  const minWidthDp = wrappedMinimumDp(style, "width");
  const minHeightDp = wrappedMinimumDp(style, "height");
  return {
    asset,
    ...(widthDp === undefined ? {} : { widthDp }),
    ...(heightDp === undefined ? {} : { heightDp }),
    ...(minWidthDp === undefined ? {} : { minWidthDp }),
    ...(minHeightDp === undefined ? {} : { minHeightDp }),
    // A weight takes the parent's space by share, as a fill takes it whole: either way it is filled.
    ...(style.width === "fill" || weighted === "row" ? { widthFill: true as const } : {}),
    ...(style.height === "fill" || weighted === "column" ? { heightFill: true as const } : {}),
    scale: webImageScale(node.contentScale),
  };
}

/**
 * The image node's own box styles for an inlinable asset: the placeholder colour until the page
 * inlines the asset (which sets `-bg` transparent), and a column that the content child fills.
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
    display: "flex",
    "flex-direction": "column",
  };
}

/** Each axis's size field, authored-minimum field, min and max properties, and padding sides. */
const CONTENT_AXES = [
  ["width", "minWidth", "min-width", "max-width", "padding-inline-start", "padding-inline-end"],
  ["height", "minHeight", "min-height", "max-height", "padding-top", "padding-bottom"],
] as const;

/**
 * The placeholder's 48px minimum for the content box on each wrapped axis, unless the node authors
 * that minimum. It never outgrows the room the node's box leaves inside its padding, as Android's
 * minimum yields to its constraints: a resolved maximum caps it (a CSS minimum would otherwise
 * override that maximum and paint into the padding), and a weight's zero minimum zeroes it.
 */
function contentMinimum(style: Raw, box: Readonly<Record<string, string>>): Record<string, string> {
  const css: Record<string, string> = {};
  for (const [size, authored, minimum, maximum, start, end] of CONTENT_AXES) {
    if (box[minimum] === "0") {
      // A weight's zero, made explicit: an omitted minimum is the flex item's automatic one, which
      // the image's ratio would raise past the weight's share.
      css[minimum] = "0";
      continue;
    }
    if (!wrapped(style[size]) || typeof style[authored] === "number") {
      continue;
    }
    const room =
      box[maximum] && `calc(${box[maximum]} - ${box[start] ?? "0px"} - ${box[end] ?? "0px"})`;
    css[minimum] = room ? `min(48px, ${room})` : "48px";
  }
  return css;
}

/**
 * The in-flow box the image layers fill: the node's content box, inside its padding (safe-area
 * insets included), so the browser lays it out by every rule the node's own box follows (fill,
 * weight, min and max bounds). It keeps the image's aspect ratio on an axis the node leaves to wrap,
 * as a native image keeps its natural size there, unless the node authors its own ratio; and the
 * placeholder's minimum (see contentMinimum). A fixed height is a definite one, so the content box
 * takes it in full and the ratio can size a wrapped width. `box` is the node's resolved style.
 */
export function webImageContentCss(
  slot: number,
  node: Raw,
  box: Readonly<Record<string, string>>,
): Record<string, string> {
  const style = record(node.style) ?? {};
  const ratio = wrapped(style.width) || wrapped(style.height);
  return {
    position: "relative",
    flex: "1 1 auto",
    "align-self": "stretch",
    ...(fixedDp(style.height) === undefined ? {} : { height: "100%" }),
    ...(ratio && typeof style.aspectRatio !== "number"
      ? { "aspect-ratio": `var(${webImageVar(slot, "-ar")}, auto)` }
      : {}),
    ...contentMinimum(style, box),
  };
}

/**
 * The drawn image and its filter: the image saturates first, then a separate tint layer
 * multiplies it (Android's `BlendMode.Modulate` on an offscreen layer), masked by the image so
 * transparent pixels stay clear. The tint layer is invisible until the page inlines the asset.
 * `Modulate` multiplies alpha too, so the tint draws its opaque colour and a translucent tint
 * wraps both layers in a group at the tint's alpha (`#00FFFFFF` hides the image, as on Android).
 */
export function webImageLayers(slot: number, node: Raw, context: WebStyleContext): WebElement[] {
  const image = `var(${webImageVar(slot)})`;
  const size = BACKGROUND_SIZE[webImageScale(node.contentScale)];
  const filter = record(node.filter);
  const saturation = typeof filter?.saturation === "number" ? filter.saturation : 1;
  const layers = [
    el("div", {
      attrs: { "data-image": "" },
      style: {
        position: "absolute",
        inset: "0",
        "background-image": image,
        "background-size": size,
        "background-position": "center",
        "background-repeat": "no-repeat",
        ...(saturation === 1 ? {} : { filter: `saturate(${saturation})` }),
      },
    }),
  ];
  const tint =
    filter?.tint === undefined
      ? undefined
      : resolvePrototypeColor(filter.tint, context.mode, context.palette);
  if (tint) {
    layers.push(
      el("div", {
        attrs: { "data-image-tint": "" },
        style: {
          position: "absolute",
          inset: "0",
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
  if (tint && tint.a < 1) {
    // Opacity isolates the group, so the tint multiplies only the image beneath it.
    const style = { position: "absolute", inset: "0", opacity: String(Number(tint.a.toFixed(3))) };
    return [el("div", { attrs: { "data-image-alpha": "" }, style }, layers)];
  }
  return layers;
}

/** The page rule that inlines one image into its slot's custom properties. */
export function webImageRule(slot: number, image: PrototypeWebImage): string {
  const base64 = Buffer.from(
    image.bytes.buffer,
    image.bytes.byteOffset,
    image.bytes.byteLength,
  ).toString("base64");
  return `:root{${webImageVar(slot)}:url(data:image/webp;base64,${base64});${webImageVar(slot, "-bg")}:transparent;${webImageVar(slot, "-ar")}:${image.width}/${image.height};${webImageVar(slot, "-on")}:1}`;
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

/**
 * The dp a cover box covers on one axis: its fixed dp, else a filled axis's bound, else a wrapped
 * axis's minimum.
 */
function coverDp(
  fixed: number | undefined,
  filled: true | undefined,
  minimum: number | undefined,
  fillDp: number,
) {
  // A wrapped axis draws at least its content minimum (authored, else the 48px default), which a
  // padded fixed axis's smaller content length must not leave the encode short of.
  return fixed ?? (filled ? fillDp : (minimum ?? WRAPPED_MINIMUM_DP));
}

/** The placeholder's minimum on a wrapped axis, in dp (see contentMinimum). */
const WRAPPED_MINIMUM_DP = 48;

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
    const width = coverDp(draw.widthDp, draw.widthFill, draw.minWidthDp, fillDp);
    const height = coverDp(draw.heightDp, draw.heightFill, draw.minHeightDp, fillDp);
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

/**
 * An `image`: with a slot for its bound asset, the slot's image layers inside its content box;
 * otherwise a placeholder.
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
      scope.imageDraws?.push(webImageDraw(asset, node, scope.style.parentAxis));
    }
    const placeholder = cssColor("surfaceVariant", scope.style) ?? "#e7e0ec";
    if (asset === undefined || slot === undefined) {
      const { attrs, style } = base(node, scope, {
        "background-color": placeholder,
        ...webImageMinimum(record(node.style) ?? {}),
      });
      return el("div", { attrs: { ...attrs, role: "img" }, style });
    }
    const { attrs, style } = base(node, scope, webImageBoxCss(slot, node, placeholder));
    const content = el(
      "div",
      { attrs: { "data-image-content": "" }, style: webImageContentCss(slot, node, style) },
      webImageLayers(slot, node, scope.style),
    );
    return el("div", { attrs: { ...attrs, role: "img" }, style }, [content]);
  };
}
