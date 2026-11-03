import { defaultDeviceFrameId, deviceFrameOrThrow, type DeviceFrame } from "./deviceFrames";
import type { CssVars } from "./webCssLength";
import { paintsTopEdgeAt, topEdgePaintOrder, type WebScreenSize } from "./webLayoutPass";
import { el, type WebChild, type WebElement } from "./webNodes";

export type { WebScreenSize } from "./webLayoutPass";

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

/** A background that paints fully opaque once the element's composite opacity applies. */
function opaqueBackground(element: WebElement, opacity: number): string | undefined {
  const background = element.style["background-color"];
  const alpha = parseCssColor(background)?.a;
  return alpha !== undefined && alpha * opacity === 1 ? background : undefined;
}

/** Points sampled along the screen's top edge, evenly across its width. */
const TOP_EDGE_SAMPLES = 64;

/** The default Android frame's portrait screen, for a caller that names none. */
const DEFAULT_SCREEN: WebScreenSize = (() => {
  const { widthDp, heightDp } = deviceFrameOrThrow(defaultDeviceFrameId("android")).screen;
  return { width: widthDp, height: heightDp };
})();

/**
 * The app's top colour, from paint (#16667): a layout pass places the content on the `screen`,
 * and at points evenly across the screen's top edge the last opaque background painted there is
 * the colour behind the status bar (else `fallback`, the screen background). The colour at the
 * most points wins; a tie goes to the one met first from the left. A background counts only when
 * its alpha times the element's composite opacity is 1. `vars` are the custom properties the
 * screen defines, such as the safe-area insets top padding reads.
 */
export function appTopColor(
  content: WebChild,
  fallback: string,
  screen: WebScreenSize = DEFAULT_SCREEN,
  vars: CssVars = {},
): string {
  if (typeof content === "string") {
    return fallback;
  }
  const opaque = topEdgePaintOrder(content, screen, vars).flatMap((box) => {
    const color = opaqueBackground(box.element, box.opacity);
    return color === undefined ? [] : [{ box, color }];
  });
  const votes = new Map<string, number>();
  for (let index = 0; index < TOP_EDGE_SAMPLES; index++) {
    const x = ((index + 0.5) * screen.width) / TOP_EDGE_SAMPLES;
    const shown = opaque.filter(({ box }) => paintsTopEdgeAt(box, x)).at(-1)?.color ?? fallback;
    votes.set(shown, (votes.get(shown) ?? 0) + 1);
  }
  let top = fallback;
  let most = 0;
  for (const [color, count] of votes) {
    if (count > most) {
      top = color;
      most = count;
    }
  }
  return top;
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
