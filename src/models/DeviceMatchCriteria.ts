import { Platform } from "./Platform";

export type FormFactor = "phone" | "tablet";
export type MatchingStrategy = "LATEST" | "RANDOM" | "MINIMUM";

export interface DeviceMatchCriteria {
  platform: Platform;
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
}

export interface StartDeviceResult {
  deviceId: string;
  name: string;
  platform: Platform;
  osVersion?: string;
  formFactor?: FormFactor;
  screenSize?: { width: number; height: number };
  sessionId: string;
  processId?: number;
  isReady: boolean;
  source: "booted" | "cold-boot";
  timing: Record<string, number>;
}
