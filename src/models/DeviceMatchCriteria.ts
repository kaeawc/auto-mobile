import { Platform } from "./Platform";
import type { Posture } from "./DisplayPanel";

export type FormFactor =
  | "phone"
  | "tablet"
  | "foldable"
  | "tv"
  | "watch"
  | "automotive"
  | "unknown";
export type MatchingStrategy = "LATEST" | "RANDOM" | "MINIMUM";

export interface DeviceMatchCriteria {
  platform: Platform;
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  /**
   * `playStore`: only a Play Store system image (#14302); root-dependent features then refuse.
   * `vehicle.motion`: only a car image whose build can simulate driving state (#16742).
   */
  requires?: {
    panels?: number;
    posture?: Posture;
    playStore?: boolean;
    vehicle?: { motion?: "supported" };
  };
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
}
