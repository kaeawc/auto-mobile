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
  DATA_CHROME,
  DATA_LEVEL,
  DATA_STATUS,
  FLEX,
  FONT_SIZE,
  FONT_WEIGHT,
  INLINE_FLEX,
  JUSTIFY_CONTENT,
  PADDING_TOP,
  POINTER_EVENTS,
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

function stretches(element: WebElement): boolean {
  return element.style[ALIGN_SELF] === "stretch" || element.style.width === "100%";
}

function opaqueBackground(element: WebElement): string | undefined {
  const background = element.style[BACKGROUND_COLOR];
  return parseCssColor(background)?.a === 1 ? background : undefined;
}

/**
 * The app's top colour: the innermost opaque background along the content's leading children that
 * spans the screen, since it paints over its ancestors (a top app bar over a root column), else
 * `fallback` (the screen background). The walk stops at an element padded by the top safe area,
 * whose children start below the status bar.
 */
export function appTopColor(content: WebChild, fallback: string): string {
  let top = fallback;
  let current: WebChild | undefined = content;
  for (let depth = 0; depth < 32 && current !== undefined && typeof current !== "string"; depth++) {
    const background = depth === 0 || stretches(current) ? opaqueBackground(current) : undefined;
    top = background ?? top;
    // Top safe-area padding moves the children below the status area, so this background shows.
    const clears: boolean = current.style[PADDING_TOP]?.includes("--safe-top") ?? false;
    current = clears ? undefined : current.children.find((child) => typeof child !== "string");
  }
  return top;
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
