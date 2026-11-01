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
  /** `playStore`: only a Play Store system image (#14302); root-dependent features then refuse. */
  requires?: { panels?: number; posture?: Posture; playStore?: boolean };
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
}
