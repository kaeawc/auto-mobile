import { prototypeSpecForDevice } from "../prototypeComponents";
import { resolvePrototypeStrings } from "../prototypeStrings";
import { prototypeRolePalette, type PrototypeColorMode } from "../prototypeContrast";
import { record, type Raw } from "../prototypeTemplate";
import { defaultDeviceFrameId, deviceFrameOrThrow, type DeviceFrame } from "./deviceFrames";
import { renderDeviceFrame, screenSize, type WebOrientation } from "./webFrame";
import { el, type WebElement } from "./webNodes";
import { stillPlatformState } from "./webPlatformState";
import { renderWebNode, type UnsupportedWebNode, type WebRenderScope } from "./webRender";
import type { WebStackScreens } from "./webStack";
import {
  appTopColor,
  statusBarContentFor,
  type WebScreenSize,
  type WebStatusBarContent,
} from "./webStatusBar";
import { cssColor, themeTypography, type WebStyleContext } from "./webStyle";

/** The still renders in one fixed locale, so the same spec renders the same bytes. */
const STILL_LOCALE = "en-US";

export interface PrototypeStillOptions {
  /** A device frame id; defaults to the platform's default frame. */
  readonly frame?: string;
  readonly platform?: "android" | "ios";
  readonly orientation?: WebOrientation;
  readonly mode?: PrototypeColorMode;
  /** The clock derived relative times read; fixed so the same input renders the same bytes. */
  readonly nowMs?: number;
  /** A screen of the outermost stack to draw instead of its start; an unknown id draws the start. */
  readonly screen?: string;
}

export interface PrototypeStill {
  readonly element: WebElement;
  readonly frame: string;
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
  /** The outermost stack drawn, if any: its screens and the one drawn. */
  readonly stack?: WebStackScreens;
}

const GRAVITY_ALIGN: Readonly<Record<string, [string, string]>> = {
  topStart: ["start", "start"],
  topCenter: ["start", "center"],
  topEnd: ["start", "end"],
  centerStart: ["center", "start"],
  center: ["center", "center"],
  centerEnd: ["center", "end"],
  bottomStart: ["end", "start"],
  bottomCenter: ["end", "center"],
  bottomEnd: ["end", "end"],
};

// Window content start-aligns, so an explicit `wrap` root keeps its content width; a filling root
// stretches itself.
const LAYER = {
  position: "absolute",
  inset: "0",
  display: "flex",
  "flex-direction": "column",
  "align-items": "flex-start",
};

function sheetWindow(placement: Raw, children: WebElement[], layered: boolean): WebElement {
  const height = typeof placement.height === "number" ? placement.height : 0;
  const sheet = el(
    "div",
    {
      style: {
        display: "flex",
        "flex-direction": "column",
        "align-items": "flex-start",
        // A sheet spans the screen width (native MATCH_PARENT); its content keeps start alignment.
        "align-self": "stretch",
        height: `${height}px`,
        // Layers cover this region, not the whole screen.
        ...(layered ? { position: "relative" } : {}),
      },
    },
    children,
  );
  const edge = placement.edge === "top" ? "flex-start" : "flex-end";
  return el(
    "div",
    { attrs: { "data-window": "sheet" }, style: { ...LAYER, "justify-content": edge } },
    [sheet],
  );
}

function floatingWindow(placement: Raw, children: WebElement[]): WebElement {
  const [vertical, horizontal] = GRAVITY_ALIGN[String(placement.gravity)] ?? ["center", "center"];
  const offset = record(placement.offset);
  const x = typeof offset?.x === "number" ? offset.x : 0;
  const y = typeof offset?.y === "number" ? offset.y : 0;
  const floating = el("div", { style: { transform: `translate(${x}px, ${y}px)` } }, children);
  return el(
    "div",
    {
      attrs: { "data-window": "floating" },
      style: { ...LAYER, display: "grid", "align-items": vertical, "justify-items": horizontal },
    },
    [floating],
  );
}

/**
 * A fullscreen or sheet root fills its window on each axis it leaves unsized, as both devices do
 * (#16190); explicit sizes stay, and a floating root keeps its content size.
 */
function sizedRoot(spec: unknown): unknown {
  const root = record(record(spec)?.root);
  const placement = record(record(record(spec)?.window)?.placement)?.type;
  if (!root || placement === "floating") {
    return root;
  }
  const style = record(root.style) ?? {};
  return {
    ...root,
    style: { width: "fill", height: "fill", ...style },
  };
}

/**
 * Window placement inside the screen: fullscreen fills it; a sheet is `height` dp at its `edge`;
 * a floating window sits at its `gravity`, moved by its `offset`.
 */
/**
 * The window's content with the spec's explicit layout direction, so rows, start/end alignment and
 * logical padding follow it; the device chrome around it is never mirrored.
 */
function placed(
  spec: unknown,
  content: WebElement | undefined,
  layers: readonly WebElement[],
): WebElement {
  const window = placedWindow(spec, content, layers);
  const direction = record(record(spec)?.window)?.layoutDirection;
  if (direction !== "rtl" && direction !== "ltr") {
    return window;
  }
  // In RTL the logical start is the physical right, so the logical insets swap sides.
  const insets: Record<string, string> =
    direction === "rtl"
      ? { "--safe-start": "var(--safe-right)", "--safe-end": "var(--safe-left)" }
      : {};
  return {
    ...window,
    attrs: { ...window.attrs, dir: direction },
    style: { ...window.style, ...insets },
  };
}

/** The window region holds the content, then its layers; a floating window's transform anchors them. */
function placedWindow(
  spec: unknown,
  content: WebElement | undefined,
  layers: readonly WebElement[],
): WebElement {
  const placement = record(record(record(spec)?.window)?.placement) ?? {};
  const children = [...(content ? [content] : []), ...layers];
  if (placement.type === "sheet") {
    return sheetWindow(placement, children, layers.length > 0);
  }
  if (placement.type === "floating") {
    return floatingWindow(placement, children);
  }
  return el("div", { attrs: { "data-window": "fullscreen" }, style: LAYER }, children);
}

function stillScope(
  expanded: unknown,
  options: PrototypeStillOptions,
  frame: DeviceFrame,
): WebRenderScope {
  const spec = record(expanded) ?? {};
  // An explicit theme mode wins, as on the devices; `system` or none falls back to the caller's.
  const authored = record(spec.theme)?.mode;
  const size = screenSize(frame, options.orientation ?? "portrait");
  const screenDp = { widthDp: size.width, heightDp: size.height };
  const mode = authored === "light" || authored === "dark" ? authored : (options.mode ?? "light");
  return {
    style: {
      mode,
      palette: prototypeRolePalette(expanded, mode),
      parentAxis: "column",
      typography: themeTypography(expanded),
      platform: frame.platform,
      ...(record(spec.window)?.layoutDirection === "rtl" ? { rtl: true } : {}),
    },
    condition: {
      state: record(spec.state) ?? {},
      platform: frame.platform,
      // The frame's one panel is the active panel; no registry frame has a hinge yet (#16444).
      platformState: stillPlatformState({ platform: frame.platform, ...screenDp }),
    },
    data: spec.data,
    spec,
    format: { locale: STILL_LOCALE, timeZone: "UTC", nowMs: options.nowMs ?? 0 },
    instances: [],
    inBox: false,
    unsupported: [],
    screenWidth: size.width,
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    stacks: [],
    layers: [],
  };
}

/**
 * The theme's `background` role (else `surface`); a seed or device scheme leaves both unresolved,
 * so the Material 3 baseline background for the mode stands in.
 */
function screenBackground(style: WebStyleContext): string {
  return (
    cssColor("background", style) ??
    cssColor("surface", style) ??
    cssColor("background", { ...style, palette: prototypeRolePalette({}, style.mode) })!
  );
}

/**
 * Whether the window's content starts at the top of the screen, behind the status bar: a
 * fullscreen window or a top sheet. A bottom sheet or floating window leaves the status area on
 * the screen background.
 */
function coversStatusArea(spec: unknown): boolean {
  const placement = record(record(record(spec)?.window)?.placement);
  const type = placement?.type;
  return (
    type === undefined || type === "fullscreen" || (type === "sheet" && placement?.edge === "top")
  );
}

/**
 * `window.statusBar` light or dark picks the content style; `auto` or none follows the app's top
 * colour (a fullscreen window's or top sheet's), as both platforms' edge-to-edge defaults do.
 */
interface StatusBarSample {
  readonly content: WebElement;
  readonly background: string;
  readonly dark: boolean;
  readonly screen: WebScreenSize;
}

function stillStatusBarContent(spec: unknown, sample: StatusBarSample): WebStatusBarContent {
  const { content, background, dark, screen } = sample;
  const authored = record(record(spec)?.window)?.statusBar;
  if (authored === "light" || authored === "dark") {
    return authored;
  }
  const top = coversStatusArea(spec) ? appTopColor(content, background, screen) : background;
  return statusBarContentFor(top, dark ? "light" : "dark");
}

export function renderPrototypeStill(
  spec: unknown,
  options: PrototypeStillOptions = {},
): PrototypeStill {
  const frame = deviceFrameOrThrow(
    options.frame ?? defaultDeviceFrameId(options.platform ?? "android"),
  );
  // Components expand, then string tables resolve for the still's fixed locale, as on devices.
  const expanded = resolvePrototypeStrings(prototypeSpecForDevice(spec), [STILL_LOCALE]);
  const scope = stillScope(expanded, options, frame);
  const root = renderWebNode(sizedRoot(expanded), scope, "root");
  const dark = scope.style.mode === "dark";
  const textColor = cssColor("onSurface", scope.style) ?? (dark ? "#e6e0e9" : "#1d1b20");
  const background = screenBackground(scope.style);
  const content = placed(expanded, root, scope.layers);
  const element = renderDeviceFrame(
    frame,
    options.orientation ?? "portrait",
    {
      dark,
      textColor,
      background,
      statusBarContent: stillStatusBarContent(expanded, {
        content,
        background,
        dark,
        screen: screenSize(frame, options.orientation ?? "portrait"),
      }),
    },
    content,
  );
  const stack = scope.stacks?.[0];
  return {
    element,
    frame: frame.id,
    unsupportedNodes: scope.unsupported,
    ...(stack ? { stack } : {}),
  };
}
