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
import { el, type WebElement } from "./webNodes";
import { renderStatusBar, type WebStatusBarContent } from "./webStatusBar";

export type WebOrientation = "portrait" | "landscape";

const px = (value: number): string => `${Number(value.toFixed(3))}px`;

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
  // iPhones hide the status bar in landscape; a zero top inset there means no bar.
  if (orientation === "landscape" && frame.safeArea.landscape.top === 0) {
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

/** A device frame around the screen content, with status bar, cutout and navigation handle or home indicator. */
export function renderDeviceFrame(
  frame: DeviceFrame,
  orientation: WebOrientation,
  options: {
    dark: boolean;
    textColor: string;
    background: string;
    /** The content's base font size; 14px unless the system text size scales it. */
    fontSize?: string;
    /** The status bar's content style; absent follows `dark`. */
    statusBarContent?: WebStatusBarContent;
  },
  content: WebElement,
): WebElement {
  const { width, height } = screenSize(frame, orientation);
  const insets = frame.safeArea[orientation];
  const screen = el(
    "div",
    {
      attrs: { [DATA_CHROME]: "screen" },
      style: {
        position: RELATIVE,
        width: px(width),
        height: px(height),
        overflow: "hidden",
        [BORDER_RADIUS]: px(frame.cornerRadiusDp),
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
      },
    },
    [
      content,
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
        [ARIA_LABEL]: `${frame.label} (${orientation})`,
      },
      style: {
        display: "inline-block",
        padding: px(frame.frame.bezelDp),
        [BACKGROUND_COLOR]: frame.frame.color,
        [BORDER_RADIUS]: px(frame.cornerRadiusDp + frame.frame.bezelDp),
      },
    },
    [screen],
  );
}
