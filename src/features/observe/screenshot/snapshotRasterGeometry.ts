import { ActionableError } from "../../../models/ActionableError";
import type { ImagePixelDimensions } from "../../../utils/screenshot/imageHeaderDimensions";
import { RASTER_SCALE_TOLERANCE } from "./rasterGeometry";

export interface SnapshotGeometry {
  platform: "android" | "ios";
  screenSize: { width: number; height: number };
  rotation?: number;
  nativeScale?: number;
  /** Known capture orientation; absent preserves the snapshotOf framebuffer mapping. */
  rasterOrientation?: "native" | "display";
}

/** Shared full-raster scale and framebuffer orientation; never guesses from nativeScale. */
export function snapshotRasterGeometry(
  raster: ImagePixelDimensions,
  geometry: SnapshotGeometry,
  label: string = "snapshotOf",
) {
  const { width, height } = geometry.screenSize;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new ActionableError(`${label} requires finite, nonempty bounds and screen dimensions`);
  }
  if ([raster.width, raster.height].some((value) => value <= 0)) {
    throw new ActionableError(`${label} received an empty screenshot raster`);
  }
  const nativeRaster = geometry.platform === "ios" && geometry.rasterOrientation !== "display";
  const nativeRotation = nativeRaster ? geometry.rotation : 0;
  const quarterTurn =
    [1, 3].some((rotation) => rotation === nativeRotation) &&
    width > height &&
    raster.width < raster.height;
  const halfTurn = nativeRotation === 2;
  const [nativeWidth, nativeHeight] = quarterTurn ? [height, width] : [width, height];
  const scaleX = raster.width / nativeWidth;
  const scaleY = raster.height / nativeHeight;
  if (Math.abs(scaleX - scaleY) > RASTER_SCALE_TOLERANCE) {
    throw new ActionableError(
      `${label} screenshot and screen geometry have incompatible aspect ratios`,
    );
  }
  const scaleProvenance: "raster-dimensions" | "native-scale-confirmed" = [scaleX, scaleY].every(
    (scale) => Math.abs((geometry.nativeScale ?? NaN) - scale) <= RASTER_SCALE_TOLERANCE,
  )
    ? "native-scale-confirmed"
    : "raster-dimensions";
  const screenshotOrientation: "native" | "display" = [quarterTurn, halfTurn].includes(true)
    ? "native"
    : "display";
  return {
    pixelsPerNativeUnit: { x: scaleX, y: scaleY },
    scaleProvenance,
    quarterTurn,
    halfTurn,
    screenshotOrientation,
  };
}
