export interface SnapshotGeometry {
  platform: "android" | "ios";
  screenSize: { width: number; height: number };
  rotation?: number;
  nativeScale?: number;
  /** Known capture orientation; absent preserves the snapshotOf framebuffer mapping. */
  rasterOrientation?: "native" | "display";
}
