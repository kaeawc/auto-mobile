import { ActionableError } from "../../../models/ActionableError";
import type { ElementBounds } from "../../../models/ElementBounds";
import { nativeBoundsInRaster, snapRasterBounds, RASTER_SCALE_TOLERANCE } from "./rasterGeometry";
import type { ImageBackend } from "../../../utils/image/backend/ImageBackend";

export interface SnapshotGeometry {
  platform: "android" | "ios";
  screenSize: { width: number; height: number };
  rotation?: number;
  nativeScale?: number;
  /** Known capture orientation; absent preserves the snapshotOf framebuffer mapping. */
  rasterOrientation?: "native" | "display";
}

export interface SnapshotCropResult {
  png: Buffer;
  requestedBounds: ElementBounds;
  clippedBounds: ElementBounds;
  screenSize: SnapshotGeometry["screenSize"];
  imageSize: { width: number; height: number };
  pixelsPerNativeUnit: { x: number; y: number };
  scaleProvenance: "raster-dimensions" | "native-scale-confirmed";
  clipped: boolean;
  rasterBounds: { left: number; top: number; right: number; bottom: number };
  screenshotOrientation: "display" | "native";
}

/** Pure geometry plus an injected image backend; the caller owns capture and persistence. */
// oxlint-disable-next-line complexity -- validation, clipping, and the four rotation cases form one atomic crop mapping.
export async function cropSnapshot(
  source: Buffer,
  requestedBounds: ElementBounds,
  geometry: SnapshotGeometry,
  backend: ImageBackend,
  label: string = "snapshotOf",
): Promise<SnapshotCropResult> {
  const { width, height } = geometry.screenSize;
  const { left, top, right, bottom } = requestedBounds;
  if (
    ![width, height, left, top, right, bottom].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    right <= left ||
    bottom <= top
  ) {
    throw new ActionableError(`${label} requires finite, nonempty bounds and screen dimensions`);
  }
  const clippedBounds = {
    left: Math.max(0, left),
    top: Math.max(0, top),
    right: Math.min(width, right),
    bottom: Math.min(height, bottom),
  };
  if (clippedBounds.right <= clippedBounds.left || clippedBounds.bottom <= clippedBounds.top) {
    throw new ActionableError(`${label} rectangle is outside the visible screen`);
  }
  const metadata = await backend.metadata(source);
  if (metadata.width <= 0 || metadata.height <= 0) {
    throw new ActionableError(`${label} received an empty screenshot raster`);
  }
  const quarterTurn =
    geometry.platform === "ios" &&
    geometry.rasterOrientation !== "display" &&
    (geometry.rotation === 1 || geometry.rotation === 3) &&
    width > height &&
    metadata.width < metadata.height;
  const halfTurn =
    geometry.platform === "ios" &&
    geometry.rasterOrientation !== "display" &&
    geometry.rotation === 2;
  const nativeWidth = quarterTurn ? height : width;
  const nativeHeight = quarterTurn ? width : height;
  const scaleX = metadata.width / nativeWidth;
  const scaleY = metadata.height / nativeHeight;
  if (Math.abs(scaleX - scaleY) > RASTER_SCALE_TOLERANCE) {
    throw new ActionableError(
      `${label} screenshot and screen geometry have incompatible aspect ratios`,
    );
  }
  const turn = quarterTurn || halfTurn ? geometry.rotation! : 0;
  const rasterBounds = snapRasterBounds(
    nativeBoundsInRaster(clippedBounds, geometry.screenSize, turn),
    { x: scaleX, y: scaleY },
    metadata,
  );
  const imageSize = {
    width: rasterBounds.right - rasterBounds.left,
    height: rasterBounds.bottom - rasterBounds.top,
  };
  if (imageSize.width <= 0 || imageSize.height <= 0) {
    throw new ActionableError(`${label} rectangle covers no screenshot pixels`);
  }
  const png = await backend.execute(source, {
    operations: [{ type: "crop", x: rasterBounds.left, y: rasterBounds.top, ...imageSize }],
    encoding: { mime: "image/png" },
  });
  return {
    png,
    requestedBounds,
    clippedBounds,
    screenSize: geometry.screenSize,
    imageSize,
    pixelsPerNativeUnit: { x: scaleX, y: scaleY },
    scaleProvenance:
      geometry.nativeScale !== undefined &&
      Math.abs(geometry.nativeScale - scaleX) <= RASTER_SCALE_TOLERANCE &&
      Math.abs(geometry.nativeScale - scaleY) <= RASTER_SCALE_TOLERANCE
        ? "native-scale-confirmed"
        : "raster-dimensions",
    clipped:
      left !== clippedBounds.left ||
      top !== clippedBounds.top ||
      right !== clippedBounds.right ||
      bottom !== clippedBounds.bottom,
    rasterBounds,
    screenshotOrientation: quarterTurn || halfTurn ? "native" : "display",
  };
}
