import {
  cropSnapshot,
  type SnapshotGeometry,
} from "../../src/features/observe/screenshot/snapshotCrop";
import type { ElementBounds } from "../../src/models/ElementBounds";
import type { ImagePointSource } from "../../src/models/ImageRelativePoint";
import { FakeImageBackend } from "../fakes/FakeImageBackend";

/** Use production clipping, raster snapping, and orientation with a fake captured image. */
export async function cropSource(
  geometry: SnapshotGeometry,
  raster: { width: number; height: number },
  bounds: ElementBounds,
): Promise<Extract<ImagePointSource, { crop: unknown }>> {
  const backend = new FakeImageBackend();
  backend.setMetadataResult({ ...raster, format: "png", size: 1 });
  const { png, ...metadata } = await cropSnapshot(Buffer.from("fake"), bounds, geometry, backend);
  if (png.length === 0) {
    throw new Error("Fake crop backend returned an empty raster");
  }
  return {
    crop: {
      ...metadata,
      cropPath: "/fake/crop.png",
      unit: geometry.platform === "ios" ? "points" : "pixels",
    },
    rotation: geometry.rotation as 0 | 1 | 2 | 3 | undefined,
  };
}
