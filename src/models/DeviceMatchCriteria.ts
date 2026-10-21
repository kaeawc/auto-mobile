import { Platform } from "./Platform";
import type { Posture } from "./DisplayPanel";

export type FormFactor = "phone" | "tablet" | "foldable" | "unknown";
export type MatchingStrategy = "LATEST" | "RANDOM" | "MINIMUM";

export interface DeviceMatchCriteria {
  platform: Platform;
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  requires?: { panels?: number; posture?: Posture };
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
}
