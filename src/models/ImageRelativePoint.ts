import type { ObserveCropResult } from "./ObserveCropResult";
import type { ImageSize } from "./ImageGeometry";

export type ImageRotation = 0 | 1 | 2 | 3;
export interface ScreenshotPointSource {
  screenSize: ImageSize;
  screenshotOrientation: "display" | "native";
  rotation?: ImageRotation;
  imageSize?: ImageSize;
  nativeScale?: number;
}
export type ImagePointSource =
  | { crop: Omit<ObserveCropResult, "cropPath"> & { cropPath?: string }; rotation?: ImageRotation }
  | { screenshot: ScreenshotPointSource };

export interface ImageRelativePoint {
  unit: "normalized" | "pixels";
  x: number;
  y: number;
  source: ImagePointSource;
}
