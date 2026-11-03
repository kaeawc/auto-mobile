import type { DeviceFrame } from "./deviceFrames";
import { el, type WebChild, type WebElement } from "./webNodes";

/**
 * The generic status bar a still draws per skin (#16546): never a picture of a real OS, only a
 * clock and generic Wi-Fi, cellular and battery marks that reflect a simulated device state.
 */
export interface WebStatusBarState {
  /** The text the clock shows. */
  readonly clock: string;
  /** 0-100. */
  readonly batteryPercent: number;
  readonly wifi: boolean;
  /** 0-4 filled cellular bars. */
  readonly cellularBars: number;
}

/** A fixed, full state, so a still renders the same bytes every time. */
export const DEFAULT_WEB_STATUS_BAR_STATE: WebStatusBarState = {
  clock: "9:41",
  batteryPercent: 100,
  wifi: true,
  cellularBars: 4,
};

/** Light content (white marks) for a dark top colour, dark content for a light one. */
export type WebStatusBarContent = "light" | "dark";

const RGBA =
  /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*([\d.]+)\s*)?\)$/;
const HEX = /^#([0-9a-fA-F]{6})$/;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** An `rgba(...)`, `rgb(...)` or `#rrggbb` colour; undefined for anything else. */
export function parseCssColor(value: string | undefined): Rgba | undefined {
  const rgba = value === undefined ? null : RGBA.exec(value.trim());
  if (rgba) {
    const [, r, g, b, a] = rgba;
    return { r: Number(r), g: Number(g), b: Number(b), a: a === undefined ? 1 : Number(a) };
  }
  const hex = value === undefined ? null : HEX.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  return undefined;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * The content style for a top colour: whichever of white or black contrasts more with it. An
 * unparseable colour falls back to `fallback`.
 */
export function statusBarContentFor(
  topColor: string | undefined,
  fallback: WebStatusBarContent,
): WebStatusBarContent {
  const color = parseCssColor(topColor);
  if (!color) {
    return fallback;
  }
  // Contrast with white is (1.05)/(L+0.05), with black (L+0.05)/0.05; they cross at L ≈ 0.179.
  return luminance(color) > 0.179 ? "dark" : "light";
}

/** The element's own `opacity` (1 when unset or unparseable). */
function opacity(element: WebElement): number {
  const value = Number(element.style.opacity);
  return element.style.opacity === undefined || !Number.isFinite(value) ? 1 : value;
}

/** A background that paints fully opaque once the element's composite opacity applies. */
function opaqueBackground(element: WebElement, composite: number): string | undefined {
  const background = element.style["background-color"];
  const alpha = parseCssColor(background)?.a;
  return alpha !== undefined && alpha * composite === 1 ? background : undefined;
}

/**
 * How a container lays out its children: a box (`boxLayoutCss`) stacks them in one grid cell, so
 * later ones paint over earlier; a flex line places them along its axis; anything else flows them
 * as blocks, each as wide as the container.
 */
type Layout = "box" | "column" | "row" | "flow";

function layoutOf(element: WebElement): Layout {
  const { style } = element;
  if (style.display === "grid" && style["grid-template-areas"] === '"cell"') {
    return "box";
  }
  if (style.display === "flex") {
    return style["flex-direction"] === "column" ? "column" : "row";
  }
  return "flow";
}

const elementChildren = (element: WebElement): WebElement[] =>
  element.children.filter((child): child is WebElement => typeof child !== "string");

const startAligned = (align: string | undefined): boolean =>
  align === undefined || align === "stretch" || align === "start" || align === "flex-start";

const MAIN_START = new Set([
  undefined,
  "normal",
  "start",
  "flex-start",
  "stretch",
  "space-between",
]);

/**
 * Whether a child spans its container's width. The horizontal axis is `justify-self` in a box,
 * `align-self` in a column and the main axis in a row, where a full width or a sole growing child
 * counts. A maximum width below full caps it.
 */
function spansWidth(child: WebElement, layout: Layout, siblings: number): boolean {
  const capped = belowFull(child.style["max-width"]);
  return !capped && (child.style.width === "100%" || stretchesAcross(child, layout, siblings));
}

/** Whether a child without a full width stretches across its container's horizontal axis. */
function stretchesAcross(child: WebElement, layout: Layout, siblings: number): boolean {
  const { style } = child;
  switch (layout) {
    case "box":
      return style["justify-self"] === "stretch";
    case "column":
      return style["align-self"] === "stretch";
    case "row":
      // A sole growing child fills the row's main axis.
      return siblings === 1 && grows(child);
    case "flow":
      return style["align-self"] === "stretch" || style["justify-self"] === "stretch";
  }
}

const belowFull = (value: string | undefined): boolean => value !== undefined && value !== "100%";

/** Whether a flex child grows along the main axis: its `flex` shorthand's grow factor is above 0. */
function grows(child: WebElement): boolean {
  const factor = Number(child.style.flex?.trim().split(/\s+/)[0]);
  return Number.isFinite(factor) && factor > 0;
}

/**
 * An explicit width or maximum width other than full: the element and everything inside it is
 * narrower than its container.
 */
function narrowed(element: WebElement): boolean {
  return belowFull(element.style.width) || belowFull(element.style["max-width"]);
}

/**
 * Whether a child's top edge is its container's: it fills the height, or the container places it
 * at the top (cross-axis alignment in a box or row; main-axis arrangement, or growing, as a
 * column's first child).
 */
function reachesTop(child: WebElement, parent: WebElement, layout: Layout): boolean {
  if (child.style.height === "100%") {
    return true;
  }
  switch (layout) {
    case "box":
    case "row":
      return startAligned(child.style["align-self"] ?? parent.style["align-items"]);
    case "column":
      return grows(child) || MAIN_START.has(parent.style["justify-content"]);
    case "flow":
      return true;
  }
}

interface Candidate {
  readonly child: WebElement;
  readonly spans: boolean;
}

/**
 * The children that can show at the top, in the order to sample them: a box's children that span
 * its width and reach its top, last painted first, since a later child paints over the earlier
 * ones in the one cell; else the leading child, when it reaches the top.
 */
function topCandidates(element: WebElement): Candidate[] {
  const layout = layoutOf(element);
  const children = elementChildren(element);
  if (layout === "box") {
    return children
      .filter(
        (child) => spansWidth(child, layout, children.length) && reachesTop(child, element, layout),
      )
      .reverse()
      .map((child) => ({ child, spans: true }));
  }
  // A narrowed child's descendants span at most its width, so nothing inside it covers the top.
  const leading = children[0];
  return leading && !narrowed(leading) && reachesTop(leading, element, layout)
    ? [{ child: leading, spans: spansWidth(leading, layout, children.length) }]
    : [];
}

const MAX_DEPTH = 32;

/** Whether the element has top padding: its `padding-top`, else the first `padding` value. */
function paddedAtTop(element: WebElement): boolean {
  const top = element.style["padding-top"] ?? element.style.padding?.trim().split(/\s+/)[0];
  return top !== undefined && !/^0(?:px)?$/.test(top.trim());
}

/** The innermost opaque full-width background at the top of this subtree, if any paints there. */
function subtreeTopColor(
  element: WebElement,
  inherited: number,
  depth: number,
  spans: boolean,
): string | undefined {
  const composite = inherited * opacity(element);
  if (composite <= 0) {
    // Nothing in a fully transparent subtree paints.
    return undefined;
  }
  const own = spans ? opaqueBackground(element, composite) : undefined;
  // Top padding (authored or the safe area) moves the children down, so this background shows.
  if (paddedAtTop(element) || depth >= MAX_DEPTH) {
    return own;
  }
  // A candidate that paints nothing opaque at the top lets the one beneath it show.
  for (const candidate of topCandidates(element)) {
    const inner = subtreeTopColor(candidate.child, composite, depth + 1, candidate.spans);
    if (inner !== undefined) {
      return inner;
    }
  }
  return own;
}

/**
 * The app's top colour: the innermost opaque background along the content's leading children that
 * spans the screen, since it paints over its ancestors (a top app bar over a root column), else
 * `fallback` (the screen background). The walk follows only children that start at their
 * container's top, and a background counts only on a child that spans its container's width, each
 * read on that container's axes. In a box the walk samples the children that span it and reach
 * its top from the last painted to the first, and the first that paints an opaque top colour
 * wins. Element
 * opacity multiplies down the walk: a background is opaque only when its alpha times that
 * composite is 1, and a fully transparent subtree paints nothing. The walk stops at an element
 * with top padding (authored or the top safe area), whose children start below its top edge.
 */
export function appTopColor(content: WebChild, fallback: string): string {
  return typeof content === "string"
    ? fallback
    : (subtreeTopColor(content, 1, 0, true) ?? fallback);
}

const px = (value: number): string => `${Number(value.toFixed(3))}px`;

function wifiMark(on: boolean, color: string): WebElement {
  return el("span", {
    attrs: { "data-status": "wifi", "data-level": on ? "on" : "off" },
    style: {
      display: "inline-block",
      width: "15px",
      height: "11px",
      "background-color": color,
      // A generic fan: wide at the top, narrowing to a point at the bottom.
      "clip-path": "polygon(0 30%, 50% 0, 100% 30%, 50% 100%)",
      opacity: on ? "1" : "0.35",
    },
  });
}

function cellularMark(bars: number, color: string): WebElement {
  const filled = Math.max(0, Math.min(4, Math.round(bars)));
  return el(
    "span",
    {
      attrs: { "data-status": "cellular", "data-level": String(filled) },
      style: { display: "inline-flex", "align-items": "flex-end", gap: "1.5px", height: "11px" },
    },
    [0, 1, 2, 3].map((index) =>
      el("span", {
        style: {
          display: "inline-block",
          width: "3px",
          height: px(4 + index * 2.33),
          "border-radius": "1px",
          "background-color": color,
          opacity: index < filled ? "1" : "0.35",
        },
      }),
    ),
  );
}

function batteryMark(percent: number, color: string): WebElement {
  const level = Math.max(0, Math.min(100, Math.round(percent)));
  return el(
    "span",
    {
      attrs: { "data-status": "battery", "data-level": String(level) },
      style: { display: "inline-flex", "align-items": "center", gap: "1px" },
    },
    [
      el(
        "span",
        {
          style: {
            display: "inline-flex",
            width: "22px",
            height: "11px",
            padding: "1px",
            border: `1px solid ${color}`,
            "border-radius": "3px",
            "box-sizing": "border-box",
          },
        },
        [
          el("span", {
            style: {
              width: `${level}%`,
              "border-radius": "1.5px",
              "background-color": color,
            },
          }),
        ],
      ),
      el("span", {
        style: {
          width: "1.5px",
          height: "4px",
          "border-radius": "0 1px 1px 0",
          "background-color": color,
        },
      }),
    ],
  );
}

/**
 * Each side of an iPhone's island: the clock centred in the left ear, the marks in the right.
 * Android puts the clock at the start and the marks at the end, around a punch hole.
 */
function sides(
  frame: DeviceFrame,
  width: number,
  landscape: boolean,
): { container: Record<string, string>; side: Record<string, string> } {
  const { cutout } = frame;
  if (
    frame.platform === "ios" &&
    !landscape &&
    cutout.type !== "none" &&
    cutout.type !== "punchHole"
  ) {
    const ear = px(Math.max(0, (width - cutout.widthDp) / 2));
    return {
      container: { padding: "0" },
      side: { width: ear, "justify-content": "center" },
    };
  }
  return { container: { padding: "0 16px" }, side: {} };
}

export interface WebStatusBarInput {
  readonly frame: DeviceFrame;
  readonly width: number;
  readonly landscape: boolean;
  readonly content: WebStatusBarContent;
  readonly state?: WebStatusBarState;
}

export function renderStatusBar(input: WebStatusBarInput): WebElement {
  const { frame, content } = input;
  const state = input.state ?? DEFAULT_WEB_STATUS_BAR_STATE;
  const color = content === "light" ? "#ffffff" : "#000000";
  const ios = frame.platform === "ios";
  const layout = sides(frame, input.width, input.landscape);
  const side = (children: WebChild[]) =>
    el(
      "span",
      { style: { display: "flex", "align-items": "center", gap: "5px", ...layout.side } },
      children,
    );
  return el(
    "div",
    {
      attrs: {
        "data-chrome": "statusBar",
        "data-status-content": content,
        "aria-hidden": "true",
      },
      style: {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        height: px(frame.statusBarDp),
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        ...layout.container,
        "box-sizing": "border-box",
        color,
        "font-size": ios ? "16px" : "14px",
        "font-weight": ios ? "600" : "500",
        "z-index": "2",
        "pointer-events": "none",
      },
    },
    [
      side([el("span", { attrs: { "data-status": "clock" } }, [state.clock])]),
      side([
        cellularMark(state.cellularBars, color),
        wifiMark(state.wifi, color),
        batteryMark(state.batteryPercent, color),
      ]),
    ],
  );
}
