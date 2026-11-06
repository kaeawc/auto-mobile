import {
  ABSOLUTE,
  ALIGN_ITEMS,
  ARIA_HIDDEN,
  ARIA_LABEL,
  BACKGROUND_COLOR,
  BORDER_RADIUS,
  CENTER,
  COLUMN,
  DATA_CHROME,
  FLEX,
  FLEX_DIRECTION,
  FONT_FAMILY,
  FONT_SIZE,
  JUSTIFY_CONTENT,
  POINTER_EVENTS,
  RELATIVE,
  Z_INDEX,
} from "./webCss";
import type { DeviceFrame } from "./deviceFrames";
import type { WebFold } from "./webFold";
import { el, type WebElement } from "./webNodes";
import { renderStatusBar, type WebStatusBarContent } from "./webStatusBar";

export type WebOrientation = "portrait" | "landscape";

const px = (value: number): string => `${Number(value.toFixed(3))}px`;

const BOTH: readonly WebOrientation[] = ["portrait", "landscape"];
const PORTRAIT_ONLY: readonly WebOrientation[] = ["portrait"];
const LANDSCAPE_ONLY: readonly WebOrientation[] = ["landscape"];

/**
 * The orientations a frame is drawn in, its default first (prototype-web-frames-v2.md): a watch
 * has no landscape view, and a TV or car is landscape only. Every frame records its geometry in
 * portrait, so a landscape-only frame is the portrait geometry turned a quarter turn.
 */
export function frameOrientations(
  frame: Pick<DeviceFrame, "formFactor">,
): readonly WebOrientation[] {
  switch (frame.formFactor) {
    case "watch":
      return PORTRAIT_ONLY;
    case "tv":
    case "automotive":
      return LANDSCAPE_ONLY;
    default:
      return BOTH;
  }
}

/** A `round` mask clips the screen (and its bezel) to a circle; `rect` keeps the corner radius. */
function maskRadius(frame: DeviceFrame, cornerRadiusDp: number): string {
  return frame.mask === "round" ? "50%" : px(cornerRadiusDp);
}

/** Screen size in the orientation; landscape swaps the portrait width and height. */
export function screenSize(frame: DeviceFrame, orientation: WebOrientation) {
  const { widthDp, heightDp } = frame.screen;
  return orientation === "portrait"
    ? { width: widthDp, height: heightDp }
    : { width: heightDp, height: widthDp };
}

/**
 * Where a portrait point lands after rotating the device a quarter turn counter-clockwise, which
 * moves the top edge (and so the cutout) to the left edge.
 */
function rotate(x: number, y: number, frame: DeviceFrame, orientation: WebOrientation) {
  return orientation === "portrait" ? { x, y } : { x: y, y: frame.screen.widthDp - x };
}

function cutout(frame: DeviceFrame, orientation: WebOrientation): WebElement[] {
  const shape = frame.cutout;
  if (shape.type === "none") {
    return [];
  }
  const center = rotate(shape.centerXDp, shape.centerYDp, frame, orientation);
  const [w, h] =
    shape.type === "punchHole"
      ? [shape.radiusDp * 2, shape.radiusDp * 2]
      : [shape.widthDp, shape.heightDp];
  const [width, height] = orientation === "portrait" ? [w, h] : [h, w];
  return [
    el("div", {
      attrs: { [DATA_CHROME]: "cutout", [ARIA_HIDDEN]: "true" },
      style: {
        position: ABSOLUTE,
        left: px(center.x - width / 2),
        top: px(center.y - height / 2),
        width: px(width),
        height: px(height),
        [BORDER_RADIUS]: shape.type === "notch" ? "0 0 16px 16px" : px(Math.min(width, height) / 2),
        [BACKGROUND_COLOR]: "#000",
        [Z_INDEX]: "3",
      },
    }),
  ];
}

function statusBar(
  frame: DeviceFrame,
  orientation: WebOrientation,
  content: WebStatusBarContent,
): WebElement[] {
  // Watches and TVs draw no status bar. iPhones hide it in landscape; a zero top inset there
  // means no bar.
  if (
    frame.statusBarDp === 0 ||
    (orientation === "landscape" && frame.safeArea.landscape.top === 0)
  ) {
    return [];
  }
  const { width } = screenSize(frame, orientation);
  return [renderStatusBar({ frame, width, landscape: orientation === "landscape", content })];
}

/** Three-button navigation: generic back, home and recents marks, outlined in the bar colour. */
function buttonNavigation(color: string, side: boolean): WebElement {
  const mark = (radius: string) =>
    el("span", {
      style: {
        display: "inline-block",
        width: "14px",
        height: "14px",
        border: `2px solid ${color}`,
        [BORDER_RADIUS]: radius,
        opacity: "0.6",
      },
    });
  return el(
    "span",
    {
      attrs: { "data-nav": "buttons" },
      style: {
        display: FLEX,
        gap: "64px",
        [FLEX_DIRECTION]: side ? "column" : "row",
      },
    },
    [mark("2px 50% 50% 2px"), mark("50%"), mark("2px")],
  );
}

/**
 * Where the navigation chrome sits: along the bottom, or (button navigation in landscape, where
 * the frame reserves the right-hand inset) down the right edge.
 */
function navOnSide(frame: DeviceFrame, orientation: WebOrientation): boolean {
  // Gesture handles stay at the bottom; a landscape right inset there is the cutout, not navigation.
  return (
    frame.navBar.type === "buttons" &&
    orientation === "landscape" &&
    frame.safeArea.landscape.right > 0
  );
}

function navPlacement(heightDp: number, side: boolean): Record<string, string> {
  const size = px(heightDp);
  return side
    ? { top: "0", bottom: "0", right: "0", width: size, [FLEX_DIRECTION]: COLUMN }
    : { left: "0", right: "0", bottom: "0", height: size };
}

/**
 * The gesture affordance: iOS's home indicator, or Android's navigation handle. `data-nav` names
 * it so back (#16542) and home (#16550) gestures can attach to it.
 */
function gestureHandle(platform: DeviceFrame["platform"], dark: boolean): WebElement {
  const ios = platform === "ios";
  return el("span", {
    attrs: { "data-nav": ios ? "homeIndicator" : "handle" },
    style: {
      width: ios ? "134px" : "108px",
      height: ios ? "5px" : "4px",
      [BORDER_RADIUS]: ios ? "2.5px" : "2px",
      [BACKGROUND_COLOR]: dark ? "#ffffff" : "#000000",
      opacity: ios ? "0.9" : "0.6",
    },
  });
}

function navBar(frame: DeviceFrame, orientation: WebOrientation, dark: boolean): WebElement[] {
  if (frame.navBar.type === "none") {
    return [];
  }
  const handle =
    frame.navBar.type === "gesture"
      ? gestureHandle(frame.platform, dark)
      : buttonNavigation(dark ? "#ffffff" : "#000000", navOnSide(frame, orientation));
  return [
    el(
      "div",
      {
        attrs: { [DATA_CHROME]: "navBar", [ARIA_HIDDEN]: "true" },
        style: {
          position: ABSOLUTE,
          ...navPlacement(frame.navBar.heightDp, navOnSide(frame, orientation)),
          display: FLEX,
          [ALIGN_ITEMS]: CENTER,
          [JUSTIFY_CONTENT]: CENTER,
          [Z_INDEX]: "2",
          [POINTER_EVENTS]: "none",
        },
      },
      [handle],
    ),
  ];
}

/** Where a band along `axis` sits: its offset and size on the axis it splits. */
function bandPlacement(axis: WebFold["band"]["axis"], start: number, size: number) {
  return axis === "vertical"
    ? { left: px(start), top: "0", width: px(size), height: "100%" }
    : { top: px(start), left: "0", height: px(size), width: "100%" };
}

/**
 * The hinge over the active panel: an occluding hinge is an opaque strip; a seamless fold draws a
 * crease shaded by how far it is folded, and nothing when it lies flat.
 */
function hinge(fold: WebFold | undefined): WebElement[] {
  if (!fold) {
    return [];
  }
  const { band, hingeDegrees, occluding } = fold;
  const attrs = {
    "aria-hidden": "true",
    "data-posture": fold.posture,
    "data-hinge-degrees": String(hingeDegrees),
  };
  if (occluding) {
    return [
      el("div", {
        attrs: { "data-chrome": "hinge", ...attrs },
        style: {
          position: "absolute",
          ...bandPlacement(band.axis, band.startDp, band.widthDp),
          "background-color": "#000",
          "z-index": "3",
        },
      }),
    ];
  }
  const folded = Math.min(1, Math.max(0, (180 - hingeDegrees) / 180));
  if (folded === 0) {
    return [];
  }
  const crease = 24;
  const shade = `rgba(0,0,0,${Number((folded * 0.5).toFixed(3))})`;
  const direction = band.axis === "vertical" ? "to right" : "to bottom";
  return [
    el("div", {
      attrs: { "data-chrome": "fold", ...attrs },
      style: {
        position: "absolute",
        ...bandPlacement(band.axis, band.startDp - crease / 2, crease),
        background: `linear-gradient(${direction}, transparent, ${shade}, transparent)`,
        "z-index": "1",
        "pointer-events": "none",
      },
    }),
  ];
}

/**
 * Content laid out on the screen minus an occluding hinge: one box of the reduced size, shown in
 * the two segments either side of the hinge. The second copy is hidden from assistive technology
 * and inert, so the preview reads and focuses once.
 */
function segmented(
  content: WebElement,
  fold: WebFold | undefined,
  size: { width: number; height: number },
): WebElement[] {
  if (!fold?.occluding) {
    return [content];
  }
  const { axis, startDp, widthDp } = fold.band;
  const vertical = axis === "vertical";
  const extent = vertical ? size.width : size.height;
  const box = (offset: number) =>
    el(
      "div",
      {
        style: {
          position: "absolute",
          [vertical ? "left" : "top"]: px(offset),
          [vertical ? "top" : "left"]: "0",
          width: px(vertical ? extent - widthDp : size.width),
          height: px(vertical ? size.height : extent - widthDp),
        },
      },
      [content],
    );
  const segment = (start: number, length: number, offset: number, copy: boolean) =>
    el(
      "div",
      {
        attrs: {
          "data-segment": copy ? "after" : "before",
          ...(copy ? { "aria-hidden": "true", inert: "" } : {}),
        },
        style: { position: "absolute", overflow: "hidden", ...bandPlacement(axis, start, length) },
      },
      [box(offset)],
    );
  return [
    segment(0, startDp, 0, false),
    segment(startDp + widthDp, extent - startDp - widthDp, -startDp, true),
  ];
}

const POSTURE_LABELS: Readonly<Record<WebFold["posture"], string>> = {
  closed: "closed",
  half_opened: "half opened",
  opened: "opened",
  rear_display: "rear display",
  flipped: "flipped",
  tent: "tent",
};
interface ScreenPaint {
  readonly dark: boolean;
  readonly textColor: string;
  readonly background: string;
  /** The content's base font size; 14px unless the system text size scales it. */
  readonly fontSize?: string;
}

type Insets = DeviceFrame["safeArea"]["portrait"];

const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

function screenStyle(
  size: { width: number; height: number },
  /** The CSS border radius: a length, or `50%` for a round mask. */
  radius: string,
  insets: Insets,
  options: ScreenPaint,
): Record<string, string> {
  return {
    position: RELATIVE,
    width: px(size.width),
    height: px(size.height),
    overflow: "hidden",
    [BORDER_RADIUS]: radius,
    // Both devices paint nothing behind a window, so the app below shows through; a still has no
    // app below, so the theme's background stands in for it.
    [BACKGROUND_COLOR]: options.background,
    color: options.textColor,
    [FONT_FAMILY]: "system-ui, -apple-system, Roboto, sans-serif",
    [FONT_SIZE]: options.fontSize ?? "14px",
    "--safe-top": px(insets.top),
    "--safe-bottom": px(insets.bottom),
    "--safe-left": px(insets.left),
    "--safe-right": px(insets.right),
    "--safe-start": "var(--safe-left)",
    "--safe-end": "var(--safe-right)",
  };
}

/**
 * The frame's screen alone: no bezel, corner radius, status bar, cutout or navigation marks, no
 * safe-area insets and no window background, so the content draws as a renderer's content path
 * does without a window (#16534).
 */
export function renderChromelessScreen(
  frame: DeviceFrame,
  orientation: WebOrientation,
  options: ScreenPaint,
  content: WebElement,
): WebElement {
  return el(
    "div",
    {
      attrs: { [DATA_CHROME]: "screen", "data-frame": frame.id, "data-orientation": orientation },
      style: screenStyle(screenSize(frame, orientation), px(0), NO_INSETS, {
        ...options,
        background: "transparent",
      }),
    },
    [content],
  );
}

/** A device frame around the screen content, with status bar, cutout and navigation handle or home indicator. */
export function renderDeviceFrame(
  frame: DeviceFrame,
  orientation: WebOrientation,
  options: ScreenPaint & {
    /** The status bar's content style; absent follows `dark`. */
    readonly statusBarContent?: WebStatusBarContent;
    /** The posture drawn: names the frame's view, and its hinge when it folds the active panel. */
    readonly posture?: WebFold["posture"];
    readonly fold?: WebFold;
  },
  content: WebElement,
): WebElement {
  const screen = el(
    "div",
    {
      attrs: { [DATA_CHROME]: "screen" },
      style: screenStyle(
        screenSize(frame, orientation),
        maskRadius(frame, frame.cornerRadiusDp),
        frame.safeArea[orientation],
        options,
      ),
    },
    [
      ...segmented(content, options.fold, screenSize(frame, orientation)),
      ...hinge(options.fold),
      ...statusBar(
        frame,
        orientation,
        options.statusBarContent ?? (options.dark ? "light" : "dark"),
      ),
      ...cutout(frame, orientation),
      ...navBar(frame, orientation, options.dark),
    ],
  );
  return el(
    "div",
    {
      attrs: {
        [DATA_CHROME]: "frame",
        "data-frame": frame.id,
        "data-orientation": orientation,
        ...(options.posture ? { "data-posture": options.posture } : {}),
        ...(frame.mask === "round" ? { "data-mask": "round" } : {}),
        [ARIA_LABEL]: `${frame.label} (${[orientation, ...(options.posture ? [POSTURE_LABELS[options.posture]] : [])].join(", ")})`,
      },
      style: {
        display: "inline-block",
        padding: px(frame.frame.bezelDp),
        [BACKGROUND_COLOR]: frame.frame.color,
        [BORDER_RADIUS]: maskRadius(frame, frame.cornerRadiusDp + frame.frame.bezelDp),
      },
    },
    [screen],
  );
}
