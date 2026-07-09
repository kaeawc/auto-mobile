import type { DeviceSnapshotConfig, DeviceSnapshotConfigInput } from "../models";
import type {
  ConfigSocketMethod,
  ConfigSocketRequest,
  ConfigSocketResponse,
} from "./socketServer/index";

export type DeviceSnapshotSocketMethod = ConfigSocketMethod;

export type DeviceSnapshotSocketRequest = ConfigSocketRequest<
  "device_snapshot_request",
  DeviceSnapshotConfigInput
>;

export type DeviceSnapshotSocketResponse = ConfigSocketResponse<
  "device_snapshot_response",
  DeviceSnapshotConfig,
  "evictedSnapshotNames"
>;
