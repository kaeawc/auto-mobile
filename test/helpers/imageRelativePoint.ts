import {
  cropSnapshot,
  type SnapshotGeometry,
} from "../../src/features/observe/screenshot/snapshotCrop";
import type { ElementBounds } from "../../src/models/ElementBounds";
import type { ImagePointSource } from "../../src/models/ImageRelativePoint";
import type { ImageBackend } from "../../src/utils/image/backend/ImageBackend";
import { FakeImageBackend } from "../fakes/FakeImageBackend";

/** Use production clipping, raster snapping, and orientation with an injected captured image. */
export async function cropSource(
  geometry: SnapshotGeometry,
  raster: { width: number; height: number },
  bounds: ElementBounds,
  captured?: { source: Buffer; backend: ImageBackend; onPng?: (png: Buffer) => void },
): Promise<Extract<ImagePointSource, { crop: unknown }>> {
  const fake = new FakeImageBackend();
  fake.setMetadataResult({ ...raster, format: "png", size: 1 });
  const { png, ...metadata } = await cropSnapshot(
    captured?.source ?? Buffer.from("fake"),
    bounds,
    geometry,
    captured?.backend ?? fake,
  );
  if (png.length === 0) {
    throw new Error("Crop backend returned an empty raster");
  }
  captured?.onPng?.(png);
  return {
    crop: {
      ...metadata,
      cropPath: "/fake/crop.png",
      unit: geometry.platform === "ios" ? "points" : "pixels",
    },
    rotation: geometry.rotation as 0 | 1 | 2 | 3 | undefined,
  };
}
