import { Platform } from "./Platform";
import { FormFactor } from "./DeviceMatchCriteria";

export interface DeviceInfo {
  name: string;
  platform: Platform;
  isRunning: boolean;
  deviceId?: string;
  source?: "local";
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
  /** ADB transport identity, which changes when a serial reconnects. */
  transportId?: string;
  source?: "local";
  iosVersion?: string;
  osVersion?: string;
  formFactor?: FormFactor;
  screenWidth?: number;
  screenHeight?: number;
}
