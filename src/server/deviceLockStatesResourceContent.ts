import type { DeviceDiscoveryError } from "../devices/deviceUtils";
import type { Platform } from "../models";

// Per-device lock state for Android and iOS simulators. Omitted for physical iOS devices or
// when the advisory probe could not read the state.
export interface DeviceLockStateInfo {
  deviceId: string;
  locked?: boolean;
}

export interface DeviceLockStatesResourceContent {
  lastUpdated: string; // ISO 8601
  lockStates: DeviceLockStateInfo[];
  /** True only when both platform discovery sweeps completed. */
  observationComplete: boolean;
  /** Platform-specific discovery failures; an empty object means both sweeps completed. */
  discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>>;
}
