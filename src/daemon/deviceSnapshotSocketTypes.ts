import type { DeviceSnapshotConfig, DeviceSnapshotConfigInput } from "../models";
import type {
  ConfigSocketMethod,
  ConfigSocketRequest,
  ConfigSocketResponse,
} from "./socketServer/index";

export type DeviceSnapshotSocketMethod = ConfigSocketMethod;

export interface DeviceSnapshotSocketRequest extends ConfigSocketRequest<
  "device_snapshot_request",
  DeviceSnapshotConfigInput
> {}

export interface DeviceSnapshotSocketResponse extends ConfigSocketResponse<
  "device_snapshot_response",
  DeviceSnapshotConfig,
  "evictedSnapshotNames"
> {}
