import type { SnapshotCropResult } from "./SnapshotCropResult";

export interface ObserveCropResult extends Omit<SnapshotCropResult, "png"> {
  cropPath: string;
  expiresAt?: number;
  unit: "pixels" | "points";
}
