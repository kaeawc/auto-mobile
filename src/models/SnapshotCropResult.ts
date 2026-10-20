import type { ElementBounds } from "./ElementBounds";
import type { SnapshotGeometry } from "./SnapshotGeometry";

export interface SnapshotCropResult {
  png: Buffer;
  requestedBounds: ElementBounds;
  clippedBounds: ElementBounds;
  screenSize: SnapshotGeometry["screenSize"];
  /** Dimensions of the upright output PNG. */
  imageSize: { width: number; height: number };
  pixelsPerNativeUnit: { x: number; y: number };
  scaleProvenance: "raster-dimensions" | "native-scale-confirmed";
  clipped: boolean;
  rasterBounds: { left: number; top: number; right: number; bottom: number };
  /** Orientation of the output crop, not the source framebuffer. */
  screenshotOrientation: "display" | "native";
}
