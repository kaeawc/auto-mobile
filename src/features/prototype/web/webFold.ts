import type { DeviceFrame, DeviceFramePanel } from "./deviceFrames";
import { PrototypeWebInputError } from "./prototypeWebInputError";
import type { WebOrientation } from "./webFrame";

/**
 * Foldable postures in the still and the page (#16445, docs/design-docs/prototype-web-frames-v2.md
 * "Foldables"): which panel a posture lights, where the hinge crosses it in the drawn orientation,
 * and the area the spec lays out on.
 */
export type FramePosture = DeviceFrame["postures"][number]["posture"];

/** The postures a page pre-renders for the frame, in registry order; none without postures. */
export function framePostures(frame: DeviceFrame): FramePosture[] {
  return frame.postures.map((entry) => entry.posture);
}

/** The posture shown first: `opened` when the frame has it, else its first posture. */
export function defaultFramePosture(frame: DeviceFrame): FramePosture | undefined {
  const postures = framePostures(frame);
  return postures.includes("opened") ? "opened" : postures[0];
}

/** The hinge where it crosses the drawn screen: a band along `axis`, `startDp` from its left or top. */
export interface WebHingeBand {
  /** `vertical` runs top to bottom, so it splits the width; `horizontal` splits the height. */
  readonly axis: "vertical" | "horizontal";
  readonly startDp: number;
  readonly widthDp: number;
}

/** The fold the frame draws over the active panel in one orientation. */
export interface WebFold {
  readonly posture: FramePosture;
  readonly band: WebHingeBand;
  readonly occluding: boolean;
  readonly hingeDegrees: number;
}

/**
 * A frame as one posture draws it: `frame`'s top-level screen fields are the active panel's, so the
 * single-screen frame drawing applies unchanged. `hinge` is set only when it folds that panel.
 */
export interface WebPostureView {
  readonly frame: DeviceFrame;
  readonly posture?: FramePosture;
  readonly panel: DeviceFramePanel["role"];
  readonly hinge?: NonNullable<DeviceFrame["hinge"]>;
  readonly hingeDegrees?: number;
}

function withPanel(frame: DeviceFrame, panel: DeviceFramePanel): DeviceFrame {
  const { screen, cornerRadiusDp, cutout, statusBarDp, navBar, safeArea } = panel;
  return { ...frame, screen, cornerRadiusDp, cutout, statusBarDp, navBar, safeArea };
}

/**
 * The frame in `posture` (the frame's default when absent). A frame without postures draws its
 * `inner` panel and takes no posture; a posture the frame lacks lists the ones it has.
 */
export function frameInPosture(frame: DeviceFrame, posture?: string): WebPostureView {
  const chosen = posture ?? defaultFramePosture(frame);
  if (chosen === undefined) {
    return { frame, panel: "inner" };
  }
  const entry = frame.postures.find((candidate) => candidate.posture === chosen);
  if (!entry) {
    const valid = framePostures(frame);
    throw new PrototypeWebInputError(
      valid.length === 0
        ? `Device frame "${frame.id}" has no postures; omit posture.`
        : `Device frame "${frame.id}" has no posture "${chosen}". Valid postures: ${valid.join(", ")}`,
    );
  }
  // The registry checks that every posture names a panel the frame has.
  const panel = frame.panels.find((candidate) => candidate.role === entry.panel)!;
  const hinge = frame.hinge?.panel === entry.panel ? frame.hinge : undefined;
  return {
    frame: withPanel(frame, panel),
    posture: entry.posture,
    panel: entry.panel,
    ...(hinge ? { hinge, hingeDegrees: entry.hingeDegrees } : {}),
  };
}

/**
 * The hinge band in the drawn orientation. Landscape turns the device a quarter turn
 * counter-clockwise (as webFrame's cutout does): a vertical hinge at x becomes a horizontal one at
 * `width - x - widthDp`, and a horizontal hinge at y becomes a vertical one at y.
 */
export function hingeBand(
  view: WebPostureView,
  orientation: WebOrientation,
): WebHingeBand | undefined {
  const { hinge } = view;
  if (!hinge) {
    return undefined;
  }
  if (orientation === "portrait") {
    return { axis: hinge.axis, startDp: hinge.positionDp, widthDp: hinge.widthDp };
  }
  return hinge.axis === "vertical"
    ? {
        axis: "horizontal",
        startDp: view.frame.screen.widthDp - hinge.positionDp - hinge.widthDp,
        widthDp: hinge.widthDp,
      }
    : { axis: "vertical", startDp: hinge.positionDp, widthDp: hinge.widthDp };
}

export function webFold(view: WebPostureView, orientation: WebOrientation): WebFold | undefined {
  const band = hingeBand(view, orientation);
  if (!band || !view.hinge || view.posture === undefined) {
    return undefined;
  }
  return {
    posture: view.posture,
    band,
    occluding: view.hinge.occluding && band.widthDp > 0,
    hingeDegrees: view.hingeDegrees ?? 180,
  };
}

/**
 * The area the spec lays out on: the active panel in the drawn orientation, minus an occluding
 * hinge's width across its axis, as Android reports the display feature. A seamless fold keeps the
 * whole panel.
 */
export function layoutSize(
  screen: { readonly width: number; readonly height: number },
  fold: WebFold | undefined,
): { width: number; height: number } {
  if (!fold?.occluding) {
    return { width: screen.width, height: screen.height };
  }
  return fold.band.axis === "vertical"
    ? { width: screen.width - fold.band.widthDp, height: screen.height }
    : { width: screen.width, height: screen.height - fold.band.widthDp };
}
