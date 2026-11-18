import type { WebOrientation } from "../webFrame";
import { prototypeWebZoomScale } from "../webPageRuntime";
import type { UnsupportedWebNode } from "../webRender";
import type { StillTextSize } from "../webTextScale";
import type { PrototypeWebError } from "./prototypeWebInput";
import type { PrototypeWebFrame } from "./prototypeWebRender";

/** A control `mount` can draw above the frame. */
export type PrototypeWebControl = "rotate" | "zoom" | "screen";

export const PROTOTYPE_WEB_DEFAULT_CONTROLS: readonly PrototypeWebControl[] = [
  "rotate",
  "zoom",
  "screen",
];

/** `fit`, or a scale from 0.5 to 4. */
export type PrototypeWebZoom = "fit" | number;

/** The view `mount` draws: what its controls, `update` and events change. */
export interface PrototypeViewState {
  /** The frame drawn, or `false` when chromeless. */
  readonly frame: string | false;
  readonly orientation: WebOrientation;
  readonly zoom: PrototypeWebZoom;
  /** The scale applied, `fit` resolved against the host's size. */
  readonly scale: number;
  readonly mode: "light" | "dark";
  /** The outermost stack's screen drawn, if the spec has a stack. */
  readonly screen?: string;
  /** The outermost stack's screens, its start first; empty without a stack. */
  readonly screens: readonly string[];
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
  /** Set while the error view is drawn instead of the prototype. */
  readonly error?: PrototypeWebError;
}

export interface PrototypeMountEvents {
  readonly onRender?: (detail: {
    readonly unsupportedNodes: readonly UnsupportedWebNode[];
  }) => void;
  readonly onScreenChange?: (detail: { readonly screen: string }) => void;
  readonly onOrientationChange?: (detail: { readonly orientation: WebOrientation }) => void;
  readonly onZoomChange?: (detail: {
    readonly zoom: PrototypeWebZoom;
    readonly scale: number;
  }) => void;
  readonly onError?: (detail: PrototypeWebError) => void;
}

/** The public options of `mount` (docs/how-it-works/prototype-web-library.md). */
export interface PrototypeMountOptions extends PrototypeMountEvents {
  /** A prototype spec, or an `automobile-prototype-embed` envelope. */
  readonly spec: unknown;
  /** A device frame id (default `pixel-9`), a frame object, or `false` for the screen alone. */
  readonly frame?: string | PrototypeWebFrame | false;
  readonly orientation?: WebOrientation;
  readonly zoom?: PrototypeWebZoom;
  /** `system` (the default) follows `prefers-color-scheme`. */
  readonly mode?: "light" | "dark" | "system";
  readonly screen?: string;
  /** `false`, or the controls to draw (default all three). */
  readonly controls?: false | readonly PrototypeWebControl[];
  readonly locale?: string;
  readonly textSize?: StillTextSize;
}

const ZOOM_STEP = 1.25;

/** The controls drawn: none for `false`, the defaults when unset, else the known ones listed. */
export function prototypeWebControls(
  controls: PrototypeMountOptions["controls"],
): ReadonlySet<PrototypeWebControl> {
  if (controls === false) {
    return new Set();
  }
  const known = new Set<string>(PROTOTYPE_WEB_DEFAULT_CONTROLS);
  return new Set((controls ?? PROTOTYPE_WEB_DEFAULT_CONTROLS).filter((name) => known.has(name)));
}

/** A zoom option as applied: `fit`, or a finite number clamped to 0.5–4 (anything else fits). */
export function prototypeWebZoomOption(zoom: PrototypeWebZoom | undefined): PrototypeWebZoom {
  return typeof zoom === "number" && Number.isFinite(zoom)
    ? Math.min(4, Math.max(0.5, zoom))
    : "fit";
}

/** The scale one zoom-in (`1`) or zoom-out (`-1`) step lands on, as the web page steps. */
export function prototypeWebZoomStep(scale: number, direction: 1 | -1): number {
  return prototypeWebZoomScale(scale, direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP);
}

/** The orientation Rotate turns to; undefined for a frame with one orientation. */
export function prototypeWebNextOrientation(
  current: WebOrientation,
  orientations: readonly WebOrientation[],
): WebOrientation | undefined {
  return orientations.length < 2
    ? undefined
    : orientations[(orientations.indexOf(current) + 1) % orientations.length];
}

/**
 * The options after `update`: the new ones over the current. A new spec keeps the zoom,
 * orientation and screen; the renderer draws the stack's start when the screen is gone.
 */
export function mergePrototypeMountOptions(
  current: PrototypeMountOptions,
  update: Partial<PrototypeMountOptions>,
): PrototypeMountOptions {
  const defined = Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  );
  return { ...current, ...defined };
}

/** The change events between two drawn views: orientation, screen, then zoom. */
function changeEvents(
  before: PrototypeViewState,
  after: PrototypeViewState,
  events: PrototypeMountEvents,
): void {
  if (before.orientation !== after.orientation) {
    events.onOrientationChange?.({ orientation: after.orientation });
  }
  if (after.screen !== undefined && before.screen !== after.screen) {
    events.onScreenChange?.({ screen: after.screen });
  }
  if (before.zoom !== after.zoom || before.scale !== after.scale) {
    events.onZoomChange?.({ zoom: after.zoom, scale: after.scale });
  }
}

/** The events a redraw fires, comparing the view before it with the view after. */
export function prototypeWebViewEvents(
  before: PrototypeViewState | undefined,
  after: PrototypeViewState,
  events: PrototypeMountEvents,
): void {
  if (after.error) {
    events.onError?.(after.error);
    return;
  }
  events.onRender?.({ unsupportedNodes: after.unsupportedNodes });
  if (before) {
    changeEvents(before, after, events);
  }
}
