import {
  ABSOLUTE,
  ALIGN_ITEMS,
  ALIGN_SELF,
  ARIA_HIDDEN,
  BACKGROUND_COLOR,
  BORDER_BOX,
  BORDER_RADIUS,
  BOX_SIZING,
  CENTER,
  COLUMN,
  DATA_CHROME,
  DATA_LEVEL,
  DATA_STATUS,
  FLEX,
  FLEX_DIRECTION,
  FONT_SIZE,
  FONT_WEIGHT,
  INLINE_FLEX,
  JUSTIFY_CONTENT,
  JUSTIFY_SELF,
  MAX_HEIGHT,
  MAX_WIDTH,
  PADDING_TOP,
  POINTER_EVENTS,
  STRETCH,
  Z_INDEX,
} from "./webCss";
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
  const background = element.style[BACKGROUND_COLOR];
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
  if (style.display === FLEX) {
    return style[FLEX_DIRECTION] === COLUMN ? "column" : "row";
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
 * counts. A maximum width below the screen width caps it.
 */
function spansWidth(
  child: WebElement,
  layout: Layout,
  siblings: number,
  screen: WebScreenSize | undefined,
): boolean {
  const capped = caps(child.style[MAX_WIDTH], screen?.width);
  return !capped && (child.style.width === "100%" || stretchesAcross(child, layout, siblings));
}

/** Whether a child without a full width stretches across its container's horizontal axis. */
function stretchesAcross(child: WebElement, layout: Layout, siblings: number): boolean {
  const { style } = child;
  switch (layout) {
    case "box":
      return style[JUSTIFY_SELF] === STRETCH;
    case "column":
      return style[ALIGN_SELF] === STRETCH;
    case "row":
      // A sole growing child fills the row's main axis.
      return siblings === 1 && grows(child);
    case "flow":
      return style[ALIGN_SELF] === STRETCH || style[JUSTIFY_SELF] === STRETCH;
  }
}

/** The screen the content fills, so a size cap can be compared with the room it has. */
export interface WebScreenSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Whether a size or size cap (`width`, `max-width`, `max-height`) binds below full: anything but
 * `100%`, unless it is a px value at least `available`, which leaves the full size. With no
 * `available` known, any cap binds.
 */
function caps(value: string | undefined, available: number | undefined): boolean {
  if (value === undefined || value === "100%") {
    return false;
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  return available === undefined || px === null || Number(px[1]) < available;
}

/** Whether a flex child grows along the main axis: its `flex` shorthand's grow factor is above 0. */
function grows(child: WebElement): boolean {
  const factor = Number(child.style.flex?.trim().split(/\s+/)[0]);
  return Number.isFinite(factor) && factor > 0;
}

/**
 * An explicit width or maximum width other than full: the element and everything inside it is
 * narrower than its container.
 */
function narrowed(element: WebElement, screen: WebScreenSize | undefined): boolean {
  return caps(element.style.width, screen?.width) || caps(element.style[MAX_WIDTH], screen?.width);
}

/**
 * Whether a child's top edge is its container's: it fills the height, or the container places it
 * at the top (cross-axis alignment in a box or row; main-axis arrangement, or growing, as a
 * column's first child).
 */
function reachesTop(
  child: WebElement,
  parent: WebElement,
  layout: Layout,
  screen: WebScreenSize | undefined,
): boolean {
  if (child.style.height === "100%") {
    return true;
  }
  switch (layout) {
    case "box":
    case "row":
      return startAligned(child.style[ALIGN_SELF] ?? parent.style[ALIGN_ITEMS]);
    case "column":
      // A growing child fills the column unless a maximum height holds it short.
      return (
        (grows(child) && !caps(child.style[MAX_HEIGHT], screen?.height)) ||
        MAIN_START.has(parent.style[JUSTIFY_CONTENT])
      );
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
function topCandidates(element: WebElement, screen: WebScreenSize | undefined): Candidate[] {
  const layout = layoutOf(element);
  const children = elementChildren(element);
  if (layout === "box") {
    return children
      .filter(
        (child) =>
          spansWidth(child, layout, children.length, screen) &&
          reachesTop(child, element, layout, screen),
      )
      .reverse()
      .map((child) => ({ child, spans: true }));
  }
  // A narrowed child's descendants span at most its width, so nothing inside it covers the top.
  const leading = children[0];
  return leading && !narrowed(leading, screen) && reachesTop(leading, element, layout, screen)
    ? [{ child: leading, spans: spansWidth(leading, layout, children.length, screen) }]
    : [];
}

const MAX_DEPTH = 32;

/** Whether the element has top padding: its `padding-top`, else the first `padding` value. */
function paddedAtTop(element: WebElement): boolean {
  const top = element.style[PADDING_TOP] ?? element.style.padding?.trim().split(/\s+/)[0];
  return top !== undefined && !/^0(?:px)?$/.test(top.trim());
}

/** Where the walk is: the opacity above, the depth, and whether this element spans its container. */
interface WalkStep {
  readonly inherited: number;
  readonly depth: number;
  readonly spans: boolean;
}

/** The innermost opaque full-width background at the top of this subtree, if any paints there. */
function subtreeTopColor(
  element: WebElement,
  step: WalkStep,
  screen: WebScreenSize | undefined,
): string | undefined {
  const { depth, spans } = step;
  const composite = step.inherited * opacity(element);
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
  for (const candidate of topCandidates(element, screen)) {
    const next = { inherited: composite, depth: depth + 1, spans: candidate.spans };
    const inner = subtreeTopColor(candidate.child, next, screen);
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
 * with top padding (authored or the top safe area), whose children start below its top edge. A
 * size cap binds only below the `screen` size, when given.
 */
export function appTopColor(content: WebChild, fallback: string, screen?: WebScreenSize): string {
  if (typeof content === "string") {
    return fallback;
  }
  return subtreeTopColor(content, { inherited: 1, depth: 0, spans: true }, screen) ?? fallback;
}

const px = (value: number): string => `${Number(value.toFixed(3))}px`;

function wifiMark(on: boolean, color: string): WebElement {
  return el("span", {
    attrs: { [DATA_STATUS]: "wifi", [DATA_LEVEL]: on ? "on" : "off" },
    style: {
      display: "inline-block",
      width: "15px",
      height: "11px",
      [BACKGROUND_COLOR]: color,
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
      attrs: { [DATA_STATUS]: "cellular", [DATA_LEVEL]: String(filled) },
      style: { display: INLINE_FLEX, [ALIGN_ITEMS]: "flex-end", gap: "1.5px", height: "11px" },
    },
    [0, 1, 2, 3].map((index) =>
      el("span", {
        style: {
          display: "inline-block",
          width: "3px",
          height: px(4 + index * 2.33),
          [BORDER_RADIUS]: "1px",
          [BACKGROUND_COLOR]: color,
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
      attrs: { [DATA_STATUS]: "battery", [DATA_LEVEL]: String(level) },
      style: { display: INLINE_FLEX, [ALIGN_ITEMS]: CENTER, gap: "1px" },
    },
    [
      el(
        "span",
        {
          style: {
            display: INLINE_FLEX,
            width: "22px",
            height: "11px",
            padding: "1px",
            border: `1px solid ${color}`,
            [BORDER_RADIUS]: "3px",
            [BOX_SIZING]: BORDER_BOX,
          },
        },
        [
          el("span", {
            style: {
              width: `${level}%`,
              [BORDER_RADIUS]: "1.5px",
              [BACKGROUND_COLOR]: color,
            },
          }),
        ],
      ),
      el("span", {
        style: {
          width: "1.5px",
          height: "4px",
          [BORDER_RADIUS]: "0 1px 1px 0",
          [BACKGROUND_COLOR]: color,
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
      side: { width: ear, [JUSTIFY_CONTENT]: CENTER },
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
      { style: { display: FLEX, [ALIGN_ITEMS]: CENTER, gap: "5px", ...layout.side } },
      children,
    );
  return el(
    "div",
    {
      attrs: {
        [DATA_CHROME]: "statusBar",
        "data-status-content": content,
        [ARIA_HIDDEN]: "true",
      },
      style: {
        position: ABSOLUTE,
        left: "0",
        right: "0",
        top: "0",
        height: px(frame.statusBarDp),
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        [JUSTIFY_CONTENT]: "space-between",
        ...layout.container,
        [BOX_SIZING]: BORDER_BOX,
        color,
        [FONT_SIZE]: ios ? "16px" : "14px",
        [FONT_WEIGHT]: ios ? "600" : "500",
        [Z_INDEX]: "2",
        [POINTER_EVENTS]: "none",
      },
    },
    [
      side([el("span", { attrs: { [DATA_STATUS]: "clock" } }, [state.clock])]),
      side([
        cellularMark(state.cellularBars, color),
        wifiMark(state.wifi, color),
        batteryMark(state.batteryPercent, color),
      ]),
    ],
  );
}
