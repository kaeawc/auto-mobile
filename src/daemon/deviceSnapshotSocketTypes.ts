import type { DeviceSnapshotConfig, DeviceSnapshotConfigInput } from "../models";
import type { ConfigSocketRequest, ConfigSocketResponse } from "./socketServer/index";

export interface DeviceSnapshotSocketRequest extends ConfigSocketRequest<
  "device_snapshot_request",
  DeviceSnapshotConfigInput
> {}

export interface DeviceSnapshotSocketResponse extends ConfigSocketResponse<
  "device_snapshot_response",
  DeviceSnapshotConfig,
  "evictedSnapshotNames"
> {}
