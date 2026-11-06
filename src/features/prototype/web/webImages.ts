import { record, type Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import { cssColor, type WebStyleContext } from "./webStyle";
import type { NodeRenderer, WebRenderScope } from "./webRender";

/** How an image fits its box, as both devices read `contentScale` (default `fit`). */
export type WebImageScale = "fit" | "crop" | "fill";

/** One drawn image: its asset and the dp the node fixes on each axis (none for fill or wrap). */
export interface WebImageDraw {
  readonly asset: string;
  readonly widthDp?: number;
  readonly heightDp?: number;
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

export function webImageDraw(asset: string, node: Raw): WebImageDraw {
  const style = record(node.style) ?? {};
  const widthDp = fixedDp(style.width);
  const heightDp = fixedDp(style.height);
  return {
    asset,
    ...(widthDp === undefined ? {} : { widthDp }),
    ...(heightDp === undefined ? {} : { heightDp }),
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
 * The drawn image and its filter: the image saturates first, then a separate tint layer
 * multiplies it (Android's `BlendMode.Modulate` on an offscreen layer), masked by the image so
 * transparent pixels stay clear. The tint layer is invisible until the page inlines the asset.
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
  const tint = filter?.tint === undefined ? undefined : cssColor(filter.tint, context);
  if (tint) {
    layers.push(
      el("div", {
        attrs: { "data-image-tint": "" },
        style: {
          position: "absolute",
          inset: "0",
          "background-color": tint,
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
 * fixed axis; otherwise the image fits inside the box, an unfixed axis bounded by the screen's
 * long side, the largest either orientation can draw it.
 */
export interface WebImageBox {
  readonly width?: number;
  readonly height?: number;
  readonly cover: boolean;
}

export function webImageBox(
  draw: WebImageDraw,
  frame: { readonly widthDp: number; readonly heightDp: number; readonly density: number },
): WebImageBox {
  const long = Math.max(frame.widthDp, frame.heightDp);
  const px = (dp: number) => Math.ceil(dp * frame.density);
  if (draw.scale !== "fit" && (draw.widthDp !== undefined || draw.heightDp !== undefined)) {
    return {
      ...(draw.widthDp === undefined ? {} : { width: px(draw.widthDp) }),
      ...(draw.heightDp === undefined ? {} : { height: px(draw.heightDp) }),
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
      return el("div", { attrs: { ...attrs, role: "img" }, style });
    }
    const { attrs, style } = base(node, scope, webImageBoxCss(slot, node, placeholder));
    return el(
      "div",
      { attrs: { ...attrs, role: "img" }, style },
      webImageLayers(slot, node, scope.style),
    );
  };
}
