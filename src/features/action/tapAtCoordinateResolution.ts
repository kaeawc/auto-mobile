import type { TapAtPlanContext } from "../../models/TapAtGeometry";
import type { BootedDevice, ObserveResult, TapAtOptions } from "../../models";
import { layerGestureRefusal } from "../observe/hierarchyLayer";
import { resolveImageRelativePoint } from "./imageRelativePoint";
import { normalizedAxis } from "./coordinateAxis";
import { LONG_PRESS_MIN_MS, LONG_PRESS_MAX_MS } from "./tapAtGesture";
import { TapAtGeometryError } from "./TapAtGeometryError";

function gestureOptionError(options: TapAtOptions): string | undefined {
  const { durationMs } = options;
  const action = options.action ?? "tap";
  if (action !== "tap" && action !== "longPress" && action !== "doubleTap") {
    return "tapAt action is unsupported";
  }
  if (
    durationMs !== undefined &&
    (action !== "longPress" ||
      !Number.isInteger(durationMs) ||
      durationMs < LONG_PRESS_MIN_MS ||
      durationMs > LONG_PRESS_MAX_MS)
  ) {
    return `tapAt durationMs requires longPress and must be ${LONG_PRESS_MIN_MS}–${LONG_PRESS_MAX_MS} ms`;
  }
  return undefined;
}

export function inputPoint(options: TapAtOptions): { x: number; y: number } {
  return options.image ?? { x: options.x, y: options.y };
}

export function failurePoint(
  options: TapAtOptions,
  platform: BootedDevice["platform"],
): { x: number; y: number } {
  const point = inputPoint(options);
  return platform === "android" && !options.image
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : point;
}

function imageOptionError(options: TapAtOptions, toolName: string): string | undefined {
  return options.x !== undefined || options.y !== undefined || options.coordinateSpace !== undefined
    ? `${toolName} image is mutually exclusive with x, y, and coordinateSpace`
    : undefined;
}

function coordinateOptionError(options: TapAtOptions, toolName: string): string | undefined {
  if (options.image !== undefined) {
    return imageOptionError(options, toolName);
  }
  const { x, y } = options;
  const space = options.coordinateSpace ?? "absolute";
  if (space !== "absolute" && space !== "normalized" && space !== "percent") {
    return `${toolName} coordinateSpace is unsupported`;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return `${toolName} requires finite x and y coordinates`;
  }
  const max = space === "normalized" ? 1 : space === "percent" ? 100 : undefined;
  if (max !== undefined && !axesWithinRange(x, y, max)) {
    return `${toolName} ${space} coordinates must be between 0 and ${max}`;
  }
  return undefined;
}

function axesWithinRange(x: number, y: number, max: number): boolean {
  return x >= 0 && x <= max && y >= 0 && y <= max;
}

function resolveAxis(value: number, size: number, space: TapAtOptions["coordinateSpace"]): number {
  const max = space === "normalized" ? 1 : space === "percent" ? 100 : undefined;
  if (max === undefined) {
    return value;
  }
  return normalizedAxis(value / max, size);
}

function hasPositiveScreenSize(screenSize: ObserveResult["screenSize"] | undefined): boolean {
  if (!screenSize) {
    return false;
  }
  return (
    Number.isFinite(screenSize.width) &&
    Number.isFinite(screenSize.height) &&
    screenSize.width > 0 &&
    screenSize.height > 0
  );
}

function isOutsideScreenBounds(
  point: { x: number; y: number },
  screenSize: ObserveResult["screenSize"],
): boolean {
  return point.x < 0 || point.x >= screenSize.width || point.y < 0 || point.y >= screenSize.height;
}

/** Android rounds to integer raster pixels; keep crop endpoints on the final included pixel. */
function androidIntegerLimits(
  options: TapAtOptions,
  screenSize: ObserveResult["screenSize"],
): { width: number; height: number } {
  const source = options.image?.source;
  return source && "crop" in source
    ? { width: source.crop.rasterBounds.right, height: source.crop.rasterBounds.bottom }
    : screenSize;
}

/** Shared native point resolution for coordinate dispatch and hierarchy preview. */
export function resolveTapAtCoordinates(
  options: TapAtOptions,
  observeResult: ObserveResult,
  platform: BootedDevice["platform"],
  toolName: string = "tapAt",
): { x: number; y: number } | { x: number; y: number; error: string } {
  const { x: rawX, y: rawY } = inputPoint(options);
  const optionError = coordinateOptionError(options, toolName);
  if (optionError) {
    return { x: rawX, y: rawY, error: optionError };
  }
  const space = options.coordinateSpace ?? "absolute";

  const screenSize = observeResult.screenSize;
  if (!hasPositiveScreenSize(screenSize)) {
    return {
      x: rawX,
      y: rawY,
      error: `${toolName} requires a positive screenSize from a fresh observation`,
    };
  }
  const point = options.image
    ? resolveImageRelativePoint(options.image, platform === "ios" ? "ios" : "android", screenSize)
    : {
        x: resolveAxis(rawX, screenSize.width, space),
        y: resolveAxis(rawY, screenSize.height, space),
      };
  const { x: resolvedX, y: resolvedY } = point;
  if (isOutsideScreenBounds({ x: resolvedX, y: resolvedY }, screenSize)) {
    return {
      x: rawX,
      y: rawY,
      error: `${toolName} coordinates (${rawX}, ${rawY}) are outside screen bounds [0, ${screenSize.width}) x [0, ${screenSize.height})`,
    };
  }
  const limits = androidIntegerLimits(options, screenSize);
  const x =
    platform === "android"
      ? Math.min(Math.round(resolvedX), Math.ceil(limits.width) - 1)
      : resolvedX;
  const y =
    platform === "android"
      ? Math.min(Math.round(resolvedY), Math.ceil(limits.height) - 1)
      : resolvedY;
  return { x, y };
}

/**
 * `layer` refusal for the resolved native point, checked against the pre-dispatch observation
 * before any input is sent (issue #9305).
 */
function tapAtLayerRefusal(
  options: TapAtOptions,
  observation: ObserveResult,
  point: { x: number; y: number },
): string | undefined {
  const action = options.action ?? "tap";
  const verb =
    action === "longPress" ? "long press" : action === "doubleTap" ? "double tap" : "tap";
  return layerGestureRefusal(observation.viewHierarchy, options.layer, [point], verb);
}

export function resolveCoordinates(
  options: TapAtOptions,
  observeResult: ObserveResult,
  platform: BootedDevice["platform"],
): { x: number; y: number } | { x: number; y: number; error: string } {
  validatePlanGeometry(options, observeResult, platform);
  const gestureError = gestureOptionError(options);
  if (gestureError) {
    return { x: inputPoint(options).x, y: inputPoint(options).y, error: gestureError };
  }
  const resolved = resolveTapAtCoordinates(options, observeResult, platform);
  if ("error" in resolved) {
    return resolved;
  }
  const layerRefusal = tapAtLayerRefusal(options, observeResult, resolved);
  if (layerRefusal) {
    return { ...resolved, error: layerRefusal };
  }
  if (options.planContext) {
    recordNativeGeometry(options.planContext, observeResult, resolved, platform);
  }
  return resolved;
}

function validatePlanGeometry(
  options: TapAtOptions,
  observation: ObserveResult,
  platform: BootedDevice["platform"],
): void {
  const geometry = options.planContext?.geometry;
  if (!geometry) {
    return;
  }
  const orientation = observation.rotation ?? observation.viewHierarchy?.rotation;
  const checks: Array<[string, boolean]> = [
    ["platform", geometry.platform === platform],
    [
      "dimensions",
      geometry.deviceWidth === observation.screenSize.width &&
        geometry.deviceHeight === observation.screenSize.height,
    ],
    ["orientation", Number.isInteger(orientation) && geometry.orientation === orientation],
    ["point", matchesRecordedPoint(options, geometry, platform)],
  ];
  const mismatch = checks.find(([, matches]) => !matches)?.[0];
  if (mismatch) {
    throw new TapAtGeometryError(
      `tapAt replay ${mismatch} mismatch: recorded ${JSON.stringify(geometry)}, current ${platform} ${observation.screenSize?.width}x${observation.screenSize?.height} orientation ${orientation}. Replay on compatible geometry or record this step again.`,
    );
  }
}

function matchesRecordedPoint(
  options: TapAtOptions,
  geometry: NonNullable<TapAtPlanContext["geometry"]>,
  platform: BootedDevice["platform"],
): boolean {
  if (options.image || (options.coordinateSpace ?? "absolute") !== "absolute") {
    return false;
  }
  if (options.x !== geometry.x || options.y !== geometry.y) {
    return false;
  }
  return platform !== "android" || (Number.isInteger(geometry.x) && Number.isInteger(geometry.y));
}

function recordNativeGeometry(
  context: TapAtPlanContext,
  observeResult: ObserveResult,
  point: { x: number; y: number },
  platform: BootedDevice["platform"],
): void {
  const orientation = observeResult.rotation ?? observeResult.viewHierarchy?.rotation;
  if (
    (platform === "android" || platform === "ios") &&
    Number.isInteger(orientation) &&
    orientation !== undefined &&
    orientation >= 0 &&
    orientation <= 3
  ) {
    context.recordedGeometry = {
      platform: platform,
      deviceWidth: observeResult.screenSize.width,
      deviceHeight: observeResult.screenSize.height,
      orientation,
      x: point.x,
      y: point.y,
    };
  }
}
