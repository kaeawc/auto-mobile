import { Platform } from "./Platform";
import { FormFactor } from "./DeviceMatchCriteria";
import type { VirtualDeviceCapabilityInventory } from "../features/device-control/virtualDeviceCapabilities";

export interface DeviceInfo {
  name: string;
  platform: Platform;
  isRunning: boolean;
  /**
   * Whether `isRunning` was established by a completed live-state probe.
   * Omitted preserves the legacy authoritative-state contract; `false` means
   * the inventory is available but its running-state overlay is incomplete.
   */
  isRunningStateKnown?: boolean;
  deviceId?: string;
  source?: "local";
  apiLevel?: number;
  osVersion?: string;
  formFactor?: FormFactor;
  screenWidth?: number;
  screenHeight?: number;
  screenDensity?: number;
  // iOS-only metadata (optional)
  state?: string;
  isAvailable?: boolean;
  availabilityError?: string;
  iosVersion?: string;
  deviceType?: string;
  runtime?: string;
  model?: string;
  architecture?: string;
  /** Pre-session virtual hardware inventory when the platform can inspect it. */
  capabilityInventory?: VirtualDeviceCapabilityInventory;
}

export interface BootedDevice {
  name: string;
  platform: Platform;
  deviceId: string;
  /**
   * Monotonic process-local sequence for the discovery observation that
   * produced this record. Cached and retained listings preserve their original
   * stamp.
   */
  observedAt?: number;
  /** Point-in-time console state captured when the AVD-name probe failed, not live status. */
  consoleBusyDuringProbe?: boolean;
  source?: "local";
  iosVersion?: string;
  apiLevel?: number;
  osVersion?: string;
  formFactor?: FormFactor;
  screenWidth?: number;
  screenHeight?: number;
  /** Optional live metadata threaded from discovery or the admitted image. */
  screenDensity?: number;
  runtime?: string;
  deviceType?: string;
  model?: string;
  architecture?: string;
  capabilityInventory?: VirtualDeviceCapabilityInventory;
}
