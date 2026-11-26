import {
  ABSOLUTE,
  ALIGN_ITEMS,
  ALIGN_SELF,
  BACKGROUND_COLOR,
  COLUMN,
  DATA_WINDOW,
  FLEX,
  FLEX_DIRECTION,
  FONT_FAMILY,
  JUSTIFY_CONTENT,
  RELATIVE,
  STRETCH,
} from "./webCss";
import { prototypeSpecForDevice } from "../prototypeComponents";
import { walkPrototypeNodes } from "../prototypeNodeChildren";
import {
  WEB_BACKDROP_WALLPAPER,
  webBackdropCss,
  webBackdropPlan,
  type WebBackdropPlan,
} from "./webBackdrop";
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
  safeAreaVars,
  screenSize,
  type WebOrientation,
} from "./webFrame";
import { markInitialFocus } from "./webFocus";
import {
  frameInPosture,
  layoutSize,
  webFold,
  type FramePosture,
  type WebFold,
  type WebPostureView,
} from "./webFold";
import { el, type WebElement } from "./webNodes";
import { stillPlatformState } from "./webPlatformState";
import { memoizedPrototypeDerive } from "../prototypeDerive";
import type { PrototypeDerivedEntry } from "../prototypeFormatSchema";
import { renderWebNode, type UnsupportedWebNode, type WebRenderScope } from "./webRender";
import { scrimCss } from "./webSheet";
import type { WebSkinId } from "./webSkin";
import { resolveWebStillAppearance, webAuthoredBackground } from "./webStillAppearance";
import type { WebStackScreens } from "./webStack";
import type { WebImageDraw } from "./webImages";
import { localeLayoutDirection, stillLocale } from "./webLocale";
import {
  appTopColor,
  statusBarContentFor,
  type WebScreenSize,
  type WebStatusBarContent,
} from "./webStatusBar";
import {
  cssColor,
  fontPx,
  INCOMING_HEIGHT_KEY,
  themeTypography,
  type WebStyleContext,
} from "./webStyle";
import { stillTextScale, type StillTextSize } from "./webTextScale";

export interface PrototypeStillOptions {
  /** A device frame id, or a frame already checked; defaults to the platform's default frame. */
  readonly frame?: string | DeviceFrame;
  readonly platform?: "android" | "ios";
  /** The platform skin components draw in; defaults to the frame's platform. */
  readonly skin?: WebSkinId;
  /** One of the frame's orientations; defaults to its first (landscape for a TV or car). */
  readonly orientation?: WebOrientation;
  /**
   * A foldable frame's posture (#16445); defaults to `opened`, else the frame's first. A frame
   * without postures takes none.
   */
  readonly posture?: string;
  /** The system setting: decides only when the spec's theme and authored background do not. */
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
  /**
   * Draws a fullscreen window edge to edge, under the status bar and cutout, as the CtrlProxy
   * overlay and the iOS Viewer app do. By default a framed fullscreen window draws inside the safe
   * area, as ProtoViewer does (#19372).
   */
  readonly edgeToEdge?: boolean;
  /** Asset ids the page can inline, to their CSS slots; any other asset draws a placeholder. */
  readonly imageSlots?: ReadonlyMap<string, number>;
  /**
   * Where icons find their glyphs (the server passes the Material Icons Android draws). Both
   * skins draw them (#16526). Without one every icon draws the placeholder.
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
  /** The posture drawn; absent for a frame without postures. */
  readonly posture?: FramePosture;
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
 * The height a window hands its root (INCOMING_HEIGHT_KEY), where it is statically known: a
 * sheet's dp `height`. A fullscreen window's height is the screen less bars and insets, known only
 * at layout time, so it hands none.
 */
function windowHeight(placement: Raw | undefined): Raw {
  const height = placement?.type === "sheet" ? placement.height : undefined;
  return typeof height === "number" && Number.isFinite(height) && height >= 0
    ? { [INCOMING_HEIGHT_KEY]: height }
    : {};
}

/**
 * A fullscreen or sheet root fills its window on each axis it leaves unsized, as both devices do
 * (#16190); explicit sizes stay, and a floating root keeps its content size. A sheet's root also
 * carries the sheet's height as its bound (see windowHeight). A drawer root fills nothing: its
 * surface keeps the drawer's width.
 */
function sizedRoot(spec: unknown): unknown {
  const root = record(record(spec)?.root);
  const placement = record(record(record(spec)?.window)?.placement);
  if (!root || placement?.type === "floating") {
    return root;
  }
  const style = record(root.style) ?? {};
  // A drawer root is a window layer whose surface keeps its own constrained width and height.
  const fill = root.type === "drawer" ? {} : { width: "fill", height: "fill" };
  return {
    ...root,
    style: { ...fill, ...style, ...windowHeight(placement) },
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
  scope: Pick<WebRenderScope, "layers" | "style" | "consumedInsets">,
  locale: string,
): WebElement {
  // Only a framed fullscreen window consumes the insets at the top (see safeDrawingScope).
  const safeDrawing = (scope.consumedInsets ?? []).length > 0;
  const window = placedWindow(spec, content, scope, safeDrawing);
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
 * The window blurring what is behind it under its tint, or its tonal fallback (#16536): a
 * fullscreen window's own box, a sheet's or floating window's region inside its placement.
 */
function withBackdrop(
  window: WebElement,
  plan: WebBackdropPlan | undefined,
  style: WebStyleContext,
): WebElement {
  if (!plan) {
    return window;
  }
  const frosted = (box: WebElement): WebElement => ({
    ...box,
    style: { ...box.style, ...webBackdropCss(plan, style) },
  });
  const [region] = window.children;
  return window.attrs[DATA_WINDOW] === "fullscreen" || typeof region !== "object"
    ? frosted(window)
    : { ...window, children: [frosted(region), ...window.children.slice(1)] };
}

/**
 * The theme's `typography.fontFamily` on the app window, so every label inherits it, not only nodes
 * with a `textStyle` role: Android replaces the family in every Material type role, which control
 * labels (buttons, checkboxes, switches) draw with, and iOS applies the theme design wherever a
 * node names no family. A node's own `fontFamily` still overrides it; the status bar, outside the
 * window, keeps the system font.
 */
function themedFamily(window: WebElement, style: WebStyleContext): WebElement {
  const family = style.typography?.fontFamily;
  return family ? { ...window, style: { ...window.style, [FONT_FAMILY]: family } } : window;
}

/**
 * Window placement inside the screen: fullscreen fills it, over its `scrim` when one is set; a
 * sheet is `height` dp at its `edge`; a floating window sits at its `gravity`, moved by its
 * `offset`. The window region holds the content, then its layers; a floating window's transform
 * anchors them.
 */
function placedWindow(
  spec: unknown,
  content: WebElement | undefined,
  { layers, style }: Pick<WebRenderScope, "layers" | "style">,
  safeDrawing: boolean,
): WebElement {
  const placement = record(record(record(spec)?.window)?.placement) ?? {};
  const children = [...(content ? [content] : []), ...layers];
  if (placement.type === "sheet") {
    return sheetWindow(placement, children, layers.length > 0);
  }
  if (placement.type === "floating") {
    return floatingWindow(placement, children);
  }
  // Android paints a set scrim behind the fullscreen content, resolved like a sheet's scrim slot.
  const scrim: Record<string, string> =
    placement.scrim === undefined ? {} : { [BACKGROUND_COLOR]: scrimCss(placement.scrim, style) };
  // The layers stay at `inset: 0`: an absolute box spans the padding, as the scrim does.
  return el(
    "div",
    {
      attrs: { [DATA_WINDOW]: "fullscreen" },
      style: { ...LAYER, ...scrim, ...(safeDrawing ? { padding: SAFE_DRAWING_PADDING } : {}) },
    },
    children,
  );
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

/** The posture's panel is the active panel; its hinge, when it folds that panel, sets the posture. */
function platformStateFor(
  platform: "android" | "ios",
  screenDp: { widthDp: number; heightDp: number },
  fold: WebFold | undefined,
) {
  return stillPlatformState({
    platform,
    ...screenDp,
    ...(fold ? { fold: { posture: fold.posture, hinge: fold.band.axis } } : {}),
  });
}

function stillScope(
  expanded: unknown,
  options: PrototypeStillOptions,
  view: WebPostureView,
  {
    orientation,
    locale,
    fold,
  }: { orientation: WebOrientation; locale: string; fold: WebFold | undefined },
): WebRenderScope {
  const { frame } = view;
  const spec = record(expanded) ?? {};
  // The spec lays out on the active panel, minus an occluding hinge.
  const size = layoutSize(screenSize(frame, orientation), fold);
  const screenDp = { widthDp: size.width, heightDp: size.height };
  // The skin decides every look the devices draw differently, glass included.
  const skin = options.skin ?? frame.platform;
  const textScale = stillTextScale(frame.platform, options.textSize);
  // Conditions and pager pages do not depend on the mode, so the walk reads a light scope.
  const state = record(spec.state) ?? {};
  const scope: WebRenderScope = {
    style: {
      mode: "light",
      palette: prototypeDrawnPalette(expanded, "light"),
      parentAxis: COLUMN,
      typography: themeTypography(expanded),
      ...(textScale ? { textScale } : {}),
      platform: skin,
      ...(windowDirection(spec, locale) === "rtl" ? { rtl: true } : {}),
    },
    condition: {
      state,
      derived: memoizedPrototypeDerive(
        record(spec.derive) as Record<string, PrototypeDerivedEntry> | undefined,
        spec.data,
        state,
      ),
      platform: frame.platform,
      platformState: platformStateFor(frame.platform, screenDp, fold),
    },
    data: spec.data,
    spec,
    format: stillFormat(options, locale),
    instances: [],
    inBox: false,
    unsupported: [],
    skin,
    ...(options.glyphs ? { glyphs: options.glyphs } : {}),
    screenWidth: size.width,
    screenHeight: size.height,
    // A chromeless screen sets every --safe-* variable to 0px, so its height pass takes none.
    safeInsets: options.chromeless
      ? { top: 0, bottom: 0 }
      : { top: frame.safeArea[orientation].top, bottom: frame.safeArea[orientation].bottom },
    ...safeDrawingScope(spec, options),
    ...optionalScope(options),
    ...anchorTargetsScope(expanded),
    stacks: [],
    layers: [],
    imageDraws: [],
  };
  // The caller's mode is only the system setting; the spec decides first, as on the devices.
  const { mode, surface } = resolveWebStillAppearance(
    expanded,
    webAuthoredBackground(spec.root, scope, "root"),
    options.mode ?? "light",
  );
  return {
    ...scope,
    style: { ...scope.style, mode, palette: prototypeDrawnPalette(expanded, mode, surface) },
  };
}

/** Every safe-area edge, padded by a framed fullscreen window (see safeDrawingScope). */
const SAFE_DRAWING_EDGES: readonly string[] = ["top", "bottom", "start", "end"];
const SAFE_DRAWING_PADDING =
  "var(--safe-top, 0px) var(--safe-right, 0px) var(--safe-bottom, 0px) var(--safe-left, 0px)";

/**
 * A framed fullscreen window draws its content inside the device's safe area, below the status
 * bar and clear of the cutout, as ProtoViewer pads its renderer by `WindowInsets.safeDrawing`
 * (#19372). The window consumes every edge, so a node's own `safeAreaPadding` adds nothing more,
 * as `windowInsetsPadding` consumes them. A chromeless screen (the renderers' golden content path)
 * has no insets, an edge-to-edge one leaves them to the spec, and a sheet or floating window places
 * itself.
 */
function safeDrawingScope(spec: Raw, options: PrototypeStillOptions): Partial<WebRenderScope> {
  const type = record(record(spec.window)?.placement)?.type;
  return options.chromeless || options.edgeToEdge || type === "sheet" || type === "floating"
    ? {}
    : { consumedInsets: SAFE_DRAWING_EDGES };
}

/** The node ids the spec's tooltips anchor to (#16536); a spec without one sets none. */
function anchorTargetsScope(spec: unknown): Partial<WebRenderScope> {
  const targets = new Set<string>();
  walkPrototypeNodes(spec, (node) => {
    if (node.type === "tooltip" && typeof node.anchorTo === "string") {
      targets.add(node.anchorTo);
    }
  });
  return targets.size === 0 ? {} : { anchorTargets: targets };
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

/** What the status bar's top colour is read from: the window's content on the screen. */
interface StatusBarSample {
  readonly content: WebElement;
  readonly background: string;
  readonly dark: boolean;
  readonly screen: WebScreenSize;
  /** The screen's custom properties: the safe-area insets. */
  readonly vars: Readonly<Record<string, string>>;
}

/**
 * `window.statusBar` light or dark picks the content style; `auto` or none follows the colour the
 * window paints at the screen's top edge, as both platforms' edge-to-edge defaults do. The window
 * placement is part of that layout, so a bottom sheet or a small floating window leaves the
 * screen background there, and a floating panel that reaches the edge sets it.
 */
function stillStatusBarContent(spec: unknown, sample: StatusBarSample): WebStatusBarContent {
  const authored = record(record(spec)?.window)?.statusBar;
  if (authored === "light" || authored === "dark") {
    return authored;
  }
  return statusBarContentFor(stillTopColor(sample), sample.dark ? "light" : "dark");
}

/**
 * The colour the window paints at the screen's top edge. A framed fullscreen window pads its
 * content below the status bar (see safeDrawingScope), so this samples the window as it would draw
 * edge to edge: the colour just below the status bar.
 */
function stillTopColor({ content, background, screen, vars }: StatusBarSample): string {
  return appTopColor(withoutSafeDrawing(content), background, screen, vars);
}

function withoutSafeDrawing(window: WebElement): WebElement {
  if (window.style.padding !== SAFE_DRAWING_PADDING) {
    return window;
  }
  return {
    ...window,
    style: Object.fromEntries(Object.entries(window.style).filter(([key]) => key !== "padding")),
  };
}

/**
 * The band behind the status bar in the colour just below it (see stillTopColor), so a header
 * runs up behind the status bar as an edge-to-edge app bar does, and the status bar content keeps
 * contrast with what it draws over. Only a framed fullscreen window pads that band.
 */
function withStatusBand(window: WebElement, sample: StatusBarSample): WebElement {
  if (window.style.padding !== SAFE_DRAWING_PADDING) {
    return window;
  }
  const top = stillTopColor(sample);
  return {
    ...window,
    style: {
      ...window.style,
      "background-image": `linear-gradient(${top}, ${top})`,
      "background-size": "100% var(--safe-top, 0px)",
      "background-repeat": "no-repeat",
    },
  };
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

/** The posture a foldable frame is drawn in; none for a frame without postures. */
function postureOf(view: WebPostureView): { posture?: FramePosture } {
  return view.posture ? { posture: view.posture } : {};
}

/** The posture a foldable frame names, and the fold it draws over the active panel. */
function postureFrameOptions(
  view: WebPostureView,
  fold: WebFold | undefined,
): { posture?: FramePosture; fold?: WebFold } {
  return { ...postureOf(view), ...(fold ? { fold } : {}) };
}

/** The frame drawn: one already checked, the one an id names, or the platform's default. */
function stillFrame(options: PrototypeStillOptions): DeviceFrame {
  if (typeof options.frame === "object") {
    return options.frame;
  }
  return deviceFrameOrThrow(options.frame ?? defaultDeviceFrameId(options.platform ?? "android"));
}

export function renderPrototypeStill(
  spec: unknown,
  options: PrototypeStillOptions = {},
): PrototypeStill {
  const view = frameInPosture(stillFrame(options), options.posture);
  const { frame } = view;
  const locale = stillLocale(options.locale);
  // Components expand, then string tables resolve for the host locale, as on devices.
  const expanded = resolvePrototypeStrings(prototypeSpecForDevice(spec), [locale]);
  const orientation = stillOrientation(frame, options.orientation);
  const fold = webFold(view, orientation);
  const scope = stillScope(expanded, options, view, { orientation, locale, fold });
  const root = renderWebNode(sizedRoot(expanded), scope, "root");
  const dark = scope.style.mode === "dark";
  const textColor = cssColor("onSurface", scope.style) ?? (dark ? "#e6e0e9" : "#1d1b20");
  const background = screenBackground(scope.style);
  const backdrop = webBackdropPlan(expanded, scope.skin === "ios" ? "ios" : "android");
  const placedContent = themedFamily(
    withBackdrop(placed(expanded, root, scope, locale), backdrop, scope.style),
    scope.style,
  );
  // A d-pad device always has a focused item, so a TV still shows where focus starts.
  const content = frame.input === "dpad" ? markInitialFocus(placedContent) : placedContent;
  const paint = {
    dark,
    textColor,
    background,
    ...(backdrop ? { wallpaper: WEB_BACKDROP_WALLPAPER } : {}),
    ...(scope.style.textScale ? { fontSize: fontPx(14, scope.style) } : {}),
  };
  const sample = {
    content,
    background,
    dark,
    screen: screenSize(frame, orientation),
    vars: safeAreaVars(frame, orientation),
  };
  const element = options.chromeless
    ? renderChromelessScreen(frame, orientation, paint, content)
    : renderDeviceFrame(
        frame,
        orientation,
        {
          ...paint,
          statusBarContent: stillStatusBarContent(expanded, sample),
          ...postureFrameOptions(view, fold),
        },
        withStatusBand(content, sample),
      );
  const stack = scope.stacks?.[0];
  return {
    element,
    frame: frame.id,
    ...postureOf(view),
    unsupportedNodes: scope.unsupported,
    ...(stack ? { stack } : {}),
    imageDraws: scope.imageDraws ?? [],
  };
}
