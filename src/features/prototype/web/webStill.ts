import {
  ABSOLUTE,
  ALIGN_ITEMS,
  ALIGN_SELF,
  COLUMN,
  DATA_WINDOW,
  FLEX,
  FLEX_DIRECTION,
  JUSTIFY_CONTENT,
  RELATIVE,
  STRETCH,
} from "./webCss";
import { prototypeSpecForDevice } from "../prototypeComponents";
import type { PrototypeFormatLogger } from "../prototypeFormat";
import { resolvePrototypeStrings } from "../prototypeStrings";
import { prototypeRolePalette, type PrototypeColorMode } from "../prototypeContrast";
import { prototypeDrawnPalette } from "../prototypeSeedScheme";
import { record, type Raw } from "../prototypeTemplate";
import { defaultDeviceFrameId, deviceFrameOrThrow, type DeviceFrame } from "./deviceFrames";
import { PrototypeWebInputError } from "./prototypeWebInputError";
import type { PrototypeIconGlyphSource } from "./webIconGlyphs";
import {
  frameOrientations,
  renderChromelessScreen,
  renderDeviceFrame,
  screenSize,
  type WebOrientation,
} from "./webFrame";
import { markInitialFocus } from "./webFocus";
import { el, type WebElement } from "./webNodes";
import { stillPlatformState } from "./webPlatformState";
import { renderWebNode, type UnsupportedWebNode, type WebRenderScope } from "./webRender";
import type { WebSkinId } from "./webSkin";
import type { WebStackScreens } from "./webStack";
import type { WebImageDraw } from "./webImages";
import { localeLayoutDirection, stillLocale } from "./webLocale";
import {
  appTopColor,
  statusBarContentFor,
  type WebScreenSize,
  type WebStatusBarContent,
} from "./webStatusBar";
import { cssColor, fontPx, themeTypography, type WebStyleContext } from "./webStyle";
import { stillTextScale, type StillTextSize } from "./webTextScale";

export interface PrototypeStillOptions {
  /** A device frame id; defaults to the platform's default frame. */
  readonly frame?: string;
  readonly platform?: "android" | "ios";
  /** The platform skin components draw in; defaults to the frame's platform. */
  readonly skin?: WebSkinId;
  /** One of the frame's orientations; defaults to its first (landscape for a TV or car). */
  readonly orientation?: WebOrientation;
  readonly mode?: PrototypeColorMode;
  /** The clock derived relative times read; fixed so the same input renders the same bytes. */
  readonly nowMs?: number;
  /** A screen of the outermost stack to draw instead of its start; an unknown id draws the start. */
  readonly screen?: string;
  /**
   * Draws the frame's screen alone, without the device or its insets: the content path a
   * renderer's goldens capture (#16534).
   */
  readonly chromeless?: boolean;
  /** Asset ids the page can inline, to their CSS slots; any other asset draws a placeholder. */
  readonly imageSlots?: ReadonlyMap<string, number>;
  /**
   * Where icons find their glyphs (the server passes the Material Icons Android draws). Used only
   * for an Android frame: an iOS frame keeps the placeholder until its glyph set is decided
   * (#16526). Without one every icon draws the placeholder.
   */
  readonly glyphs?: PrototypeIconGlyphSource;
  /**
   * The host locale (BCP 47, default `en-US`): string tables, formatting, and the layout direction
   * of a window that sets no `layoutDirection`.
   */
  readonly locale?: string;
  /** The system text size: `fontScale` on an Android frame, `contentSize` on an iOS one. */
  readonly textSize?: StillTextSize;
  /** Traces rejected derived formats; the server passes its logger, a browser embed none. */
  readonly logger?: PrototypeFormatLogger;
}

export interface PrototypeStill {
  readonly element: WebElement;
  readonly frame: string;
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
  /** The outermost stack drawn, if any: its screens and the one drawn. */
  readonly stack?: WebStackScreens;
  /** Every image drawn with a bound asset, in tree order. */
  readonly imageDraws: readonly WebImageDraw[];
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
  position: ABSOLUTE,
  inset: "0",
  display: FLEX,
  [FLEX_DIRECTION]: COLUMN,
  [ALIGN_ITEMS]: "flex-start",
};

function sheetWindow(placement: Raw, children: WebElement[], layered: boolean): WebElement {
  const height = typeof placement.height === "number" ? placement.height : 0;
  const sheet = el(
    "div",
    {
      style: {
        display: FLEX,
        [FLEX_DIRECTION]: COLUMN,
        [ALIGN_ITEMS]: "flex-start",
        // A sheet spans the screen width (native MATCH_PARENT); its content keeps start alignment.
        [ALIGN_SELF]: STRETCH,
        height: `${height}px`,
        // Layers cover this region, not the whole screen.
        ...(layered ? { position: RELATIVE } : {}),
      },
    },
    children,
  );
  const edge = placement.edge === "top" ? "flex-start" : "flex-end";
  return el(
    "div",
    { attrs: { [DATA_WINDOW]: "sheet" }, style: { ...LAYER, [JUSTIFY_CONTENT]: edge } },
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
      attrs: { [DATA_WINDOW]: "floating" },
      style: { ...LAYER, display: "grid", [ALIGN_ITEMS]: vertical, "justify-items": horizontal },
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

/** The explicit `window.layoutDirection`, else `rtl` for an RTL locale, else none. */
function windowDirection(spec: unknown, locale: string): "ltr" | "rtl" | undefined {
  const authored = record(record(spec)?.window)?.layoutDirection;
  if (authored === "rtl" || authored === "ltr") {
    return authored;
  }
  return localeLayoutDirection(locale) === "rtl" ? "rtl" : undefined;
}

/**
 * The window's content with its layout direction, so rows, start/end alignment and logical padding
 * follow it; the device chrome around it is never mirrored. An explicit `window.layoutDirection`
 * wins; otherwise the host locale decides, and an LTR locale leaves the page's own direction.
 */
function placed(
  spec: unknown,
  content: WebElement | undefined,
  layers: readonly WebElement[],
  locale: string,
): WebElement {
  const window = placedWindow(spec, content, layers);
  const direction = windowDirection(spec, locale);
  if (direction === undefined) {
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

/**
 * Window placement inside the screen: fullscreen fills it; a sheet is `height` dp at its `edge`;
 * a floating window sits at its `gravity`, moved by its `offset`. The window region holds the
 * content, then its layers; a floating window's transform anchors them.
 */
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
  return el("div", { attrs: { [DATA_WINDOW]: "fullscreen" }, style: LAYER }, children);
}

function glyphScope(
  options: PrototypeStillOptions,
  frame: DeviceFrame,
): { glyphs?: PrototypeIconGlyphSource } {
  return options.glyphs && frame.platform === "android" ? { glyphs: options.glyphs } : {};
}

/** The host locale and fixed zone keep a still's bytes stable; the logger is optional for a browser embed. */
function stillFormat(options: PrototypeStillOptions, locale: string): WebRenderScope["format"] {
  return {
    locale,
    timeZone: "UTC",
    nowMs: options.nowMs ?? 0,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
}

/** An explicit theme mode wins, as on the devices; `system` or none falls back to the caller's. */
function colorMode(spec: Raw, options: PrototypeStillOptions): PrototypeColorMode {
  const authored = record(spec.theme)?.mode;
  return authored === "light" || authored === "dark" ? authored : (options.mode ?? "light");
}

function stillScope(
  expanded: unknown,
  options: PrototypeStillOptions,
  frame: DeviceFrame,
  { orientation, locale }: { orientation: WebOrientation; locale: string },
): WebRenderScope {
  const spec = record(expanded) ?? {};
  const size = screenSize(frame, orientation);
  const screenDp = { widthDp: size.width, heightDp: size.height };
  const mode = colorMode(spec, options);
  // The skin decides every look the devices draw differently, glass included.
  const skin = options.skin ?? frame.platform;
  const textScale = stillTextScale(frame.platform, options.textSize);
  return {
    style: {
      mode,
      palette: prototypeDrawnPalette(expanded, mode),
      parentAxis: COLUMN,
      typography: themeTypography(expanded),
      ...(textScale ? { textScale } : {}),
      platform: skin,
      ...(windowDirection(spec, locale) === "rtl" ? { rtl: true } : {}),
    },
    condition: {
      state: record(spec.state) ?? {},
      platform: frame.platform,
      // The frame's one panel is the active panel; no registry frame has a hinge yet (#16444).
      platformState: stillPlatformState({ platform: frame.platform, ...screenDp }),
    },
    data: spec.data,
    spec,
    format: stillFormat(options, locale),
    instances: [],
    inBox: false,
    unsupported: [],
    skin,
    ...glyphScope(options, frame),
    screenWidth: size.width,
    screenHeight: size.height,
    ...optionalScope(options),
    stacks: [],
    layers: [],
    imageDraws: [],
  };
}

/** The scope fields only some callers set: the screen to draw and the inlinable images' slots. */
function optionalScope(options: PrototypeStillOptions): Partial<WebRenderScope> {
  return {
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.imageSlots === undefined ? {} : { imageSlots: options.imageSlots }),
  };
}

/**
 * The theme's `background` role (else `surface`), from the baseline, seed or overrides; the
 * Material 3 baseline background for the mode stands in should neither resolve.
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

/** The requested orientation, which the frame must support, else the frame's default. */
function stillOrientation(
  frame: DeviceFrame,
  requested: WebOrientation | undefined,
): WebOrientation {
  const supported = frameOrientations(frame);
  if (requested === undefined) {
    return supported[0]!;
  }
  if (!supported.includes(requested)) {
    throw new PrototypeWebInputError(
      `Device frame "${frame.id}" has no ${requested} view. Its orientations: ${supported.join(", ")}`,
    );
  }
  return requested;
}

export function renderPrototypeStill(
  spec: unknown,
  options: PrototypeStillOptions = {},
): PrototypeStill {
  const frame = deviceFrameOrThrow(
    options.frame ?? defaultDeviceFrameId(options.platform ?? "android"),
  );
  const locale = stillLocale(options.locale);
  // Components expand, then string tables resolve for the host locale, as on devices.
  const expanded = resolvePrototypeStrings(prototypeSpecForDevice(spec), [locale]);
  const orientation = stillOrientation(frame, options.orientation);
  const scope = stillScope(expanded, options, frame, { orientation, locale });
  const root = renderWebNode(sizedRoot(expanded), scope, "root");
  const dark = scope.style.mode === "dark";
  const textColor = cssColor("onSurface", scope.style) ?? (dark ? "#e6e0e9" : "#1d1b20");
  const background = screenBackground(scope.style);
  const placedContent = placed(expanded, root, scope.layers, locale);
  // A d-pad device always has a focused item, so a TV still shows where focus starts.
  const content = frame.input === "dpad" ? markInitialFocus(placedContent) : placedContent;
  const paint = {
    dark,
    textColor,
    background,
    ...(scope.style.textScale ? { fontSize: fontPx(14, scope.style) } : {}),
  };
  const element = options.chromeless
    ? renderChromelessScreen(frame, orientation, paint, content)
    : renderDeviceFrame(
        frame,
        orientation,
        {
          ...paint,
          statusBarContent: stillStatusBarContent(expanded, {
            content,
            background,
            dark,
            screen: screenSize(frame, orientation),
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
    imageDraws: scope.imageDraws ?? [],
  };
}
