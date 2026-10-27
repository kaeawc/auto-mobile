import type { SnapshotCropResult } from "../../../models/SnapshotCropResult";
import { ActionableError } from "../../../models/ActionableError";
import type { ElementBounds } from "../../../models/ElementBounds";
import { nativeBoundsInRaster, snapRasterBounds } from "./rasterGeometry";
import type { ImageBackend, ImageOperation } from "../../../utils/image/backend/ImageBackend";

import { snapshotRasterGeometry, type SnapshotGeometry } from "./snapshotRasterGeometry";
export type { SnapshotGeometry } from "./snapshotRasterGeometry";

export type { SnapshotCropResult };

/** Pure geometry plus an injected image backend; the caller owns capture and persistence. */
export async function cropSnapshot(
  source: Buffer,
  requestedBounds: ElementBounds,
  geometry: SnapshotGeometry,
  backend: ImageBackend,
  label: string = "snapshotOf",
): Promise<SnapshotCropResult> {
  const clippedBounds = clipSnapshotBounds(requestedBounds, geometry, label);
  const clipped = boundsWereClipped(requestedBounds, clippedBounds);
  const metadata = await backend.metadata(source);
  const { quarterTurn, halfTurn, pixelsPerNativeUnit, scaleProvenance } = snapshotRasterGeometry(
    metadata,
    geometry,
    label,
  );
  const turn = quarterTurn || halfTurn ? geometry.rotation! : 0;
  const rasterBounds = snapRasterBounds(
    nativeBoundsInRaster(clippedBounds, geometry.screenSize, turn),
    pixelsPerNativeUnit,
    metadata,
  );
  const rasterSize = {
    width: rasterBounds.right - rasterBounds.left,
    height: rasterBounds.bottom - rasterBounds.top,
  };
  if (rasterSize.width <= 0 || rasterSize.height <= 0) {
    throw new ActionableError(`${label} rectangle covers no screenshot pixels`);
  }
  const operations: ImageOperation[] = [
    { type: "crop", x: rasterBounds.left, y: rasterBounds.top, ...rasterSize },
  ];
  if (quarterTurn) {
    operations.push({ type: "rotate", degrees: geometry.rotation === 1 ? 270 : 90 });
  } else if (halfTurn) {
    operations.push({ type: "rotate", degrees: 180 });
  }
  const imageSize = quarterTurn
    ? { width: rasterSize.height, height: rasterSize.width }
    : rasterSize;
  const png = await backend.execute(source, {
    operations,
    encoding: { mime: "image/png" },
  });
  return {
    png,
    requestedBounds,
    clippedBounds,
    screenSize: geometry.screenSize,
    imageSize,
    pixelsPerNativeUnit,
    scaleProvenance,
    clipped,
    rasterBounds,
    screenshotOrientation: "display",
  };
}

function clipSnapshotBounds(
  requestedBounds: ElementBounds,
  geometry: SnapshotGeometry,
  label: string,
): ElementBounds {
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
  return clippedBounds;
}

function boundsWereClipped(requested: ElementBounds, clipped: ElementBounds): boolean {
  return (
    requested.left !== clipped.left ||
    requested.top !== clipped.top ||
    requested.right !== clipped.right ||
    requested.bottom !== clipped.bottom
  );
}
