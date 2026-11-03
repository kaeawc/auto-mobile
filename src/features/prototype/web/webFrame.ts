import type { DeviceFrame } from "./deviceFrames";
import { el, type WebElement } from "./webNodes";

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
      attrs: { "data-chrome": "cutout", "aria-hidden": "true" },
      style: {
        position: "absolute",
        left: px(center.x - width / 2),
        top: px(center.y - height / 2),
        width: px(width),
        height: px(height),
        "border-radius": shape.type === "notch" ? "0 0 16px 16px" : px(Math.min(width, height) / 2),
        "background-color": "#000",
        "z-index": "3",
      },
    }),
  ];
}

function statusBar(frame: DeviceFrame, orientation: WebOrientation, dark: boolean): WebElement[] {
  // iPhones hide the status bar in landscape; a zero top inset there means no bar.
  if (orientation === "landscape" && frame.safeArea.landscape.top === 0) {
    return [];
  }
  const color = dark ? "#ffffff" : "#000000";
  return [
    el(
      "div",
      {
        attrs: { "data-chrome": "statusBar", "aria-hidden": "true" },
        style: {
          position: "absolute",
          left: "0",
          right: "0",
          top: "0",
          height: px(frame.statusBarDp),
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "0 24px",
          "box-sizing": "border-box",
          color,
          "font-size": "14px",
          "font-weight": "600",
          "z-index": "2",
          "pointer-events": "none",
        },
      },
      [
        "9:41",
        el("span", {
          style: {
            width: "24px",
            height: "11px",
            border: `1px solid ${color}`,
            "border-radius": "3px",
          },
        }),
      ],
    ),
  ];
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
        "border-radius": radius,
        opacity: "0.6",
      },
    });
  return el(
    "span",
    {
      attrs: { "data-nav": "buttons" },
      style: {
        display: "flex",
        gap: "64px",
        "flex-direction": side ? "column" : "row",
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
    ? { top: "0", bottom: "0", right: "0", width: size, "flex-direction": "column" }
    : { left: "0", right: "0", bottom: "0", height: size };
}

function navBar(frame: DeviceFrame, orientation: WebOrientation, dark: boolean): WebElement[] {
  if (frame.navBar.type === "none") {
    return [];
  }
  const handle =
    frame.navBar.type === "gesture"
      ? el("span", {
          style: {
            width: "108px",
            height: "4px",
            "border-radius": "2px",
            "background-color": dark ? "#ffffff" : "#000000",
            opacity: "0.6",
          },
        })
      : buttonNavigation(dark ? "#ffffff" : "#000000", navOnSide(frame, orientation));
  return [
    el(
      "div",
      {
        attrs: { "data-chrome": "navBar", "aria-hidden": "true" },
        style: {
          position: "absolute",
          ...navPlacement(frame.navBar.heightDp, navOnSide(frame, orientation)),
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "z-index": "2",
          "pointer-events": "none",
        },
      },
      [handle],
    ),
  ];
}

interface ScreenPaint {
  readonly dark: boolean;
  readonly textColor: string;
  readonly background: string;
}

type Insets = DeviceFrame["safeArea"]["portrait"];

const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

function screenStyle(
  size: { width: number; height: number },
  radius: number,
  insets: Insets,
  options: ScreenPaint,
): Record<string, string> {
  return {
    position: "relative",
    width: px(size.width),
    height: px(size.height),
    overflow: "hidden",
    "border-radius": px(radius),
    // Both devices paint nothing behind a window, so the app below shows through; a still has no
    // app below, so the theme's background stands in for it.
    "background-color": options.background,
    color: options.textColor,
    "font-family": "system-ui, -apple-system, Roboto, sans-serif",
    "font-size": "14px",
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
      attrs: { "data-chrome": "screen", "data-frame": frame.id, "data-orientation": orientation },
      style: screenStyle(screenSize(frame, orientation), 0, NO_INSETS, {
        ...options,
        background: "transparent",
      }),
    },
    [content],
  );
}

/** A device frame around the screen content, with status bar, cutout and navigation handle. */
export function renderDeviceFrame(
  frame: DeviceFrame,
  orientation: WebOrientation,
  options: ScreenPaint,
  content: WebElement,
): WebElement {
  const screen = el(
    "div",
    {
      attrs: { "data-chrome": "screen" },
      style: screenStyle(
        screenSize(frame, orientation),
        frame.cornerRadiusDp,
        frame.safeArea[orientation],
        options,
      ),
    },
    [
      content,
      ...statusBar(frame, orientation, options.dark),
      ...cutout(frame, orientation),
      ...navBar(frame, orientation, options.dark),
    ],
  );
  return el(
    "div",
    {
      attrs: {
        "data-chrome": "frame",
        "data-frame": frame.id,
        "data-orientation": orientation,
        "aria-label": `${frame.label} (${orientation})`,
      },
      style: {
        display: "inline-block",
        padding: px(frame.frame.bezelDp),
        "background-color": frame.frame.color,
        "border-radius": px(frame.cornerRadiusDp + frame.frame.bezelDp),
      },
    },
    [screen],
  );
}
