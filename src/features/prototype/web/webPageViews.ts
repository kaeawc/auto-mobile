import type { PrototypeColorMode } from "../prototypeContrast";
import type { PrototypeFormatLogger } from "../prototypeFormat";
import type { WebOrientation } from "./webFrame";
import type { PrototypeIconGlyphSource } from "./webIconGlyphs";
import type { WebImageDraw } from "./webImages";
import { el, type WebElement } from "./webNodes";
import type { UnsupportedWebNode } from "./webRender";
import type { WebStackScreens } from "./webStack";
import { renderPrototypeStill } from "./webStill";
import type { StillTextSize } from "./webTextScale";

/**
 * The prototype web page's views (#16528): one still per variant, revision, orientation, posture
 * and stack screen, each wrapped in the `[data-view]` element the page runtime shows and hides.
 * The host and the page bundle draw them with this one function, so a view drawn in the browser is
 * the one the host would have drawn. Browser-safe: no Node builtins and no server logger.
 */

/** What every view of a page shares. */
export interface PrototypeWebViewSettings {
  readonly frame: string;
  readonly mode?: PrototypeColorMode;
  readonly nowMs?: number;
  readonly locale?: string;
  readonly textSize?: StillTextSize;
  /** The slot each inlined asset's page rule fills, by asset id. */
  readonly imageSlots: ReadonlyMap<string, number>;
  readonly glyphs?: PrototypeIconGlyphSource;
  /** Traces rejected derived formats; the server passes its logger, the page bundle none. */
  readonly logger?: PrototypeFormatLogger;
}

/** Which revision a view draws, and the outermost stack's screen when it has a picker. */
export interface PrototypeWebViewOf {
  readonly variant: string;
  readonly revision: number;
  readonly spec: unknown;
  readonly screen?: string;
}

/** Where a view sits among the page's dimensions besides variant, revision and screen. */
export interface PrototypeWebViewPoint {
  readonly orientation: WebOrientation;
  /** The foldable posture the view draws; absent for a frame without postures. */
  readonly posture: string | undefined;
}

export interface PrototypeWebView {
  readonly variant: string;
  readonly revision: number;
  readonly orientation: WebOrientation;
  readonly posture?: string;
  /** The outermost stack's screen this view draws; only a multi-screen stack sets it. */
  readonly screen?: string;
  /** The hidden `[data-view]` element holding the still. */
  readonly element: WebElement;
  readonly unsupported: readonly UnsupportedWebNode[];
  readonly draws: readonly WebImageDraw[];
  readonly stack?: WebStackScreens;
}

/**
 * The screens the picker offers for a still's outermost stack: its start, then the others in
 * key order. A stack with one screen, or a start that is not one of them, offers none.
 */
export function prototypeWebPickerScreens(stack: WebStackScreens | undefined): string[] {
  if (!stack || stack.screens.length < 2 || !stack.screens.includes(stack.start)) {
    return [];
  }
  return [stack.start, ...stack.screens.filter((screen) => screen !== stack.start)];
}

/** One view: the still for one revision at one point and screen, hidden until the runtime shows it. */
export function renderPrototypeWebView(
  settings: PrototypeWebViewSettings,
  of: PrototypeWebViewOf,
  { orientation, posture }: PrototypeWebViewPoint,
): PrototypeWebView {
  const still = renderPrototypeStill(of.spec, {
    frame: settings.frame,
    orientation,
    ...(posture === undefined ? {} : { posture }),
    mode: settings.mode,
    nowMs: settings.nowMs,
    imageSlots: settings.imageSlots,
    ...(settings.locale === undefined ? {} : { locale: settings.locale }),
    ...(settings.textSize === undefined ? {} : { textSize: settings.textSize }),
    ...(settings.logger === undefined ? {} : { logger: settings.logger }),
    ...(settings.glyphs === undefined ? {} : { glyphs: settings.glyphs }),
    ...(of.screen === undefined ? {} : { screen: of.screen }),
  });
  const element = el(
    "div",
    {
      attrs: {
        "data-view": "",
        "data-variant": of.variant,
        "data-revision": String(of.revision),
        "data-orientation": orientation,
        ...(posture === undefined ? {} : { "data-posture": posture }),
        ...(of.screen === undefined ? {} : { "data-screen": of.screen }),
        hidden: "",
      },
    },
    [still.element],
  );
  return {
    variant: of.variant,
    revision: of.revision,
    orientation,
    ...(posture === undefined ? {} : { posture }),
    ...(of.screen === undefined ? {} : { screen: of.screen }),
    element,
    unsupported: still.unsupportedNodes,
    draws: still.imageDraws,
    ...(still.stack ? { stack: still.stack } : {}),
  };
}

/**
 * One orientation and posture's views of a revision: its start view first, then its other screens.
 * Each still finds its own stack, since a `visibleWhen` on orientation or posture can show a
 * different stack (or none) in each.
 */
export function renderPrototypeWebPointViews(
  settings: PrototypeWebViewSettings,
  of: Omit<PrototypeWebViewOf, "screen">,
  point: PrototypeWebViewPoint,
): PrototypeWebView[] {
  const probe = renderPrototypeWebView(settings, of, point);
  const screens = prototypeWebPickerScreens(probe.stack);
  return screens.length === 0
    ? [probe]
    : screens.map((screen) => renderPrototypeWebView(settings, { ...of, screen }, point));
}
