import { ActionableError } from "../../models/ActionableError";
import type { ImageRelativePoint, ImagePointSource } from "../../models/ImageRelativePoint";
import type { ElementBounds } from "../../models/ElementBounds";
import {
  nativeBoundsInRaster,
  rasterToNativePoint,
  rasterBoundsInNative,
  rasterScreenSize,
  snapRasterBounds,
  RASTER_SCALE_TOLERANCE,
  type ImagePoint,
  type ImageSize,
} from "../observe/screenshot/rasterGeometry";
import { translatedNormalizedAxis } from "./coordinateAxis";

type CropSource = Extract<ImagePointSource, { crop: unknown }>;
type ScreenshotSource = Extract<ImagePointSource, { screenshot: unknown }>;
const boundKeys = ["left", "top", "right", "bottom"] as const;

function invalid(detail: string): never {
  throw new ActionableError(
    `tapAt image ${detail}. Observe again and pass metadata from the same image.`,
  );
}
function positiveSize(size: ImageSize | undefined): size is ImageSize {
  return !!size && [size.width, size.height].every((value) => Number.isFinite(value) && value > 0);
}
function positiveRasterSize(size: ImageSize | undefined): size is ImageSize {
  return positiveSize(size) && Number.isInteger(size.width) && Number.isInteger(size.height);
}
function finiteBounds(bounds: ElementBounds | undefined): bounds is ElementBounds {
  return (
    !!bounds &&
    boundKeys.every((key) => Number.isFinite(bounds[key])) &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top
  );
}
function sourceTurn(source: ImagePointSource, platform: "android" | "ios"): number {
  const metadata = "crop" in source ? source.crop : source.screenshot;
  const rotation = "crop" in source ? source.rotation : source.screenshot.rotation;
  if (rotation !== undefined && (!Number.isInteger(rotation) || rotation < 0 || rotation > 3)) {
    invalid("rotation must be 0, 1, 2, or 3");
  }
  if (metadata.screenshotOrientation === "display") {
    return 0;
  }
  if (metadata.screenshotOrientation !== "native") {
    invalid("requires screenshotOrientation (display or native)");
  }
  if (rotation === undefined) {
    invalid("with native screenshotOrientation requires observe.rotation");
  }
  if (platform === "android" && rotation !== 0) {
    invalid("Android requires display-aligned orientation");
  }
  return rotation;
}
function validateScale(scale: ImagePoint, platform: "android" | "ios"): void {
  if (
    ![scale.x, scale.y].every((value) => Number.isFinite(value) && value > 0) ||
    Math.abs(scale.x - scale.y) > RASTER_SCALE_TOLERANCE
  ) {
    invalid("has missing or inconsistent pixelsPerNativeUnit / aspect ratio");
  }
  if (platform === "android" && (scale.x !== 1 || scale.y !== 1)) {
    invalid("Android pixels require scale 1");
  }
}
function validateClippedBounds(crop: CropSource["crop"]): void {
  const { screenSize, clippedBounds: bounds, requestedBounds } = crop;
  if (!finiteBounds(bounds) || !finiteBounds(requestedBounds)) {
    invalid("requires finite nonempty crop bounds");
  }
  const clipped = {
    left: Math.max(0, requestedBounds.left),
    top: Math.max(0, requestedBounds.top),
    right: Math.min(screenSize.width, requestedBounds.right),
    bottom: Math.min(screenSize.height, requestedBounds.bottom),
  };
  if (
    boundKeys.some((key) => bounds[key] !== clipped[key]) ||
    crop.clipped !== boundKeys.some((key) => bounds[key] !== requestedBounds[key])
  ) {
    invalid("has inconsistent clippedBounds / requestedBounds");
  }
}
function cropRasterMatches(crop: CropSource["crop"], turn: number): boolean {
  const { screenSize, imageSize, pixelsPerNativeUnit: scale, rasterBounds } = crop;
  if (!finiteBounds(rasterBounds)) {
    invalid("requires finite nonempty rasterBounds");
  }
  const rawScreen = rasterScreenSize(screenSize, turn);
  const expected = snapRasterBounds(
    nativeBoundsInRaster(crop.clippedBounds, screenSize, turn),
    scale,
    { width: rawScreen.width * scale.x, height: rawScreen.height * scale.y },
  );
  // Reconstruct floor/ceil snapping, allowing only floating-point arithmetic noise.
  const rasterWidth = rasterBounds.right - rasterBounds.left;
  const rasterHeight = rasterBounds.bottom - rasterBounds.top;
  const uprightQuarterTurn = crop.screenshotOrientation === "display" && (turn === 1 || turn === 3);
  return (
    !boundKeys.some(
      (key) =>
        !Number.isInteger(rasterBounds[key]) || Math.abs(expected[key] - rasterBounds[key]) > 1e-7,
    ) &&
    imageSize.width === (uprightQuarterTurn ? rasterHeight : rasterWidth) &&
    imageSize.height === (uprightQuarterTurn ? rasterWidth : rasterHeight)
  );
}
function validateCropRaster(
  source: CropSource,
  platform: "android" | "ios",
  turn: number,
): number[] {
  const crop = source.crop;
  // Output orientation is independent of rasterBounds' source orientation. Retain
  // display-capture support and infer a normalized framebuffer only from exact snapping.
  const candidates = [turn];
  if (
    platform === "ios" &&
    crop.screenshotOrientation === "display" &&
    source.rotation !== undefined &&
    (source.rotation === 2 ||
      ((source.rotation === 1 || source.rotation === 3) &&
        crop.screenSize.width > crop.screenSize.height))
  ) {
    candidates.push(source.rotation);
  }
  const matches = candidates.filter((candidate) => cropRasterMatches(crop, candidate));
  if (matches.length === 0) {
    invalid("has inconsistent rasterBounds, imageSize, scale, or clippedBounds");
  }
  return matches;
}
function validateCrop(source: CropSource, platform: "android" | "ios", turn: number): number[] {
  const crop = source.crop;
  if (crop.unit !== (platform === "android" ? "pixels" : "points")) {
    invalid("crop unit does not match the platform");
  }
  if (!positiveRasterSize(crop.imageSize)) {
    invalid("requires positive integer crop imageSize");
  }
  if (!crop.pixelsPerNativeUnit) {
    invalid("requires pixelsPerNativeUnit");
  }
  validateScale(crop.pixelsPerNativeUnit, platform);
  if (
    crop.scaleProvenance !== "raster-dimensions" &&
    crop.scaleProvenance !== "native-scale-confirmed"
  ) {
    invalid("requires scaleProvenance");
  }
  validateClippedBounds(crop);
  return validateCropRaster(source, platform, turn);
}
function validateScreenshot(
  source: ScreenshotSource,
  rawScreen: ImageSize,
  platform: "android" | "ios",
): void {
  const { nativeScale, imageSize } = source.screenshot;
  if (nativeScale !== undefined && (!Number.isFinite(nativeScale) || nativeScale <= 0)) {
    invalid("requires positive finite nativeScale provenance");
  }
  if (imageSize === undefined) {
    return;
  }
  if (!positiveRasterSize(imageSize)) {
    invalid("requires positive integer imageSize");
  }
  // nativeScale is provenance only: downsampled / Display Zoom rasters need actual ratios.
  validateScale(
    { x: imageSize.width / rawScreen.width, y: imageSize.height / rawScreen.height },
    platform,
  );
}
function validatePoint(point: ImageRelativePoint, imageSize: ImageSize | undefined): void {
  if (point.unit !== "normalized" && point.unit !== "pixels") {
    invalid("unit must be normalized or pixels");
  }
  const size = point.unit === "normalized" ? { width: 1, height: 1 } : imageSize;
  if (!size) {
    invalid("pixels requires imageSize with the real file dimensions");
  }
  const inclusive = point.unit === "normalized";
  for (const [value, max] of [
    [point.x, size.width],
    [point.y, size.height],
  ]) {
    if (!Number.isFinite(value) || value < 0 || (inclusive ? value > max : value >= max)) {
      invalid(
        `${point.unit} coordinates must be in [0, ${size.width}${inclusive ? "]" : ")"} x [0, ${size.height}${inclusive ? "]" : ")"}`,
      );
    }
  }
}
function withinScreen(point: ImagePoint, screen: ImageSize): boolean {
  return (
    [point.x, point.y].every(Number.isFinite) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < screen.width &&
    point.y < screen.height
  );
}
function insetReversedOrigin(point: ImagePoint, bounds: ElementBounds): void {
  if (point.x === bounds.right) {
    point.x = translatedNormalizedAxis(1, bounds.left, bounds.right);
  }
  if (point.y === bounds.bottom) {
    point.y = translatedNormalizedAxis(1, bounds.top, bounds.bottom);
  }
}

function uprightCropPixels(
  point: ImageRelativePoint,
  source: CropSource,
  turns: number[],
): ImagePoint {
  const { crop } = source;
  const { pixelsPerNativeUnit: scale, rasterBounds, screenSize } = crop;
  const regions = turns.map((turn) => ({
    bounds: rasterBoundsInNative(
      {
        left: rasterBounds.left / scale.x,
        top: rasterBounds.top / scale.y,
        right: rasterBounds.right / scale.x,
        bottom: rasterBounds.bottom / scale.y,
      },
      screenSize,
      turn,
    ),
    scale: turn === 1 || turn === 3 ? { x: scale.y, y: scale.x } : scale,
  }));
  const region = regions[0];
  // Symmetric crops can match both source orientations. Accept only equivalent
  // snapped native regions; metadata cannot disambiguate different pixel padding.
  if (
    regions.some(
      (other) =>
        boundKeys.some((key) => Math.abs(other.bounds[key] - region.bounds[key]) > 1e-7) ||
        other.scale.x !== region.scale.x ||
        other.scale.y !== region.scale.y,
    )
  ) {
    invalid("crop pixel padding is ambiguous between source orientations");
  }
  const resolved = {
    x: (region.bounds.left * region.scale.x + point.x) / region.scale.x,
    y: (region.bounds.top * region.scale.y + point.y) / region.scale.y,
  };
  if (!withinScreen(resolved, screenSize)) {
    invalid("pixels resolve outside native screen bounds");
  }
  return resolved;
}

function resolvePixels(
  point: ImageRelativePoint,
  screenSize: ImageSize,
  turn: number,
  cropTurns: number[],
): ImagePoint {
  const { source } = point;
  if ("crop" in source && source.crop.screenshotOrientation === "display") {
    return uprightCropPixels(point, source, cropTurns);
  }
  const rawScreen = rasterScreenSize(screenSize, turn);
  const scale =
    "crop" in source
      ? source.crop.pixelsPerNativeUnit
      : {
          x: source.screenshot.imageSize!.width / rawScreen.width,
          y: source.screenshot.imageSize!.height / rawScreen.height,
        };
  const origin = "crop" in source ? source.crop.rasterBounds : { left: 0, top: 0 };
  const resolved = rasterToNativePoint(
    { x: (origin.left + point.x) / scale.x, y: (origin.top + point.y) / scale.y },
    screenSize,
    turn,
  );
  const imageSize = "crop" in source ? source.crop.imageSize : source.screenshot.imageSize!;
  const nativeImageBounds = rasterBoundsInNative(
    {
      left: origin.left / scale.x,
      top: origin.top / scale.y,
      right: (origin.left + imageSize.width) / scale.x,
      bottom: (origin.top + imageSize.height) / scale.y,
    },
    screenSize,
    turn,
  );
  // A reversed raw origin denotes the upper native image boundary; resolve it just inside.
  insetReversedOrigin(resolved, nativeImageBounds);
  if (!withinScreen(resolved, screenSize)) {
    invalid("pixels resolve outside native screen bounds");
  }
  return resolved;
}

/** Pure raw-image to interface-native conversion. No capture, scale assumptions, or unit inference. */
export function resolveImageRelativePoint(
  point: ImageRelativePoint,
  platform: "android" | "ios",
  currentScreenSize: ImageSize,
): ImagePoint {
  const source = point.source;
  const metadata = "crop" in source ? source.crop : source.screenshot;
  const { screenSize, imageSize } = metadata;
  if (!positiveSize(screenSize) || !positiveSize(currentScreenSize)) {
    invalid("requires positive finite screenSize");
  }
  if (
    screenSize.width !== currentScreenSize.width ||
    screenSize.height !== currentScreenSize.height
  ) {
    invalid("source screenSize changed; observe again");
  }
  const turn = sourceTurn(source, platform);
  let cropTurns: number[] = [];
  if ("crop" in source) {
    cropTurns = validateCrop(source, platform, turn);
  } else {
    validateScreenshot(source, rasterScreenSize(screenSize, turn), platform);
  }
  validatePoint(point, imageSize);
  if (point.unit === "pixels") {
    return resolvePixels(point, screenSize, turn, cropTurns);
  }
  const bounds =
    "crop" in source
      ? source.crop.clippedBounds
      : { left: 0, top: 0, right: screenSize.width, bottom: screenSize.height };
  // Inverse turn on fractions first; this preserves endpoints on reversed axes.
  const fraction = rasterToNativePoint(point, { width: 1, height: 1 }, turn);
  return {
    x: translatedNormalizedAxis(fraction.x, bounds.left, bounds.right),
    y: translatedNormalizedAxis(fraction.y, bounds.top, bounds.bottom),
  };
}
