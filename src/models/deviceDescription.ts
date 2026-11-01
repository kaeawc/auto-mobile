import type { DeviceDisplays } from "./DisplayPanel";
import type { FormFactor } from "./DeviceMatchCriteria";
import type { ObservationInsets } from "./ObservationInsets";
import type { Platform } from "./Platform";

/** Records which platform a described device is; watchOS devices are described, not driven. */
export type DevicePlatform = Platform;
export type DeviceLifecycleState =
  | "configured"
  | "booting"
  | "booted"
  | "shutting-down"
  | "unavailable";
export type DeviceReadinessState = "unknown" | "not_ready" | "ready";
export type DevicePoolStatus = "idle" | "assigned" | "error";
export type DeviceHeldBy = "session_broker" | "other_daemon";
export type DeviceSessionOwnership = "owned" | "awaiting-owner";

export interface CapabilityInventoryEntry {
  id: string;
  state: "supported" | "unsupported" | "unknown";
  reason: string | null;
  source: string | null;
}

export interface CapabilityInventory {
  schemaVersion: number;
  capabilities: CapabilityInventoryEntry[];
}

export interface DeviceDescription {
  unhealthy?: {
    readonly reason:
      | "biometric-enrollment"
      | "network-condition"
      | "clock"
      | "app-cleanup"
      | "recording-teardown"
      | "keep-screen-awake";
    readonly since: number;
  };
  name: string;
  platform: DevicePlatform;
  isVirtual: boolean;
  source: "local" | "remote" | null;
  identity: {
    stableId: string;
  };
  formFactor: FormFactor;
  deviceType: string | null;
  model: string | null;
  architecture: string | null;
  osVersion: string | null;
  apiLevel: number | null;
  /** Android guest hardware requested in config.ini; null when unknown. */
  configuredRamMb?: number | null;
  /** Android guest hardware from the last launch; null before a first launch or when unknown. */
  effectiveRamMb?: number | null;
  configuredCpuCores?: number | null;
  effectiveCpuCores?: number | null;
  runtimeId: string | null;
  display: {
    width: number | null;
    height: number | null;
    density: number | null;
    units: Extract<ObservationInsets["units"], "physical-pixels">;
  };
  displays?: DeviceDisplays;
  capabilityInventory: CapabilityInventory | null;
  image: {
    path: string | null;
    target: string | null;
    basedOn: string | null;
  };
  availabilityError: string | null;
  runtime: {
    deviceId: string | null;
    connectionId: string | null;
    // Registry per-connection routing key (DeviceSessionRegistry), NOT durable across a device restart — distinct from runtime.session.sessionUuid (the MCP device session).
    deviceSessionUuid: string | null;
    lifecycle: { state: DeviceLifecycleState; known: boolean };
    readiness: { state: DeviceReadinessState };
    poolStatus: DevicePoolStatus | null;
    /**
     * Present only when the device is held outside generic allocation: `binding` (allocation
     * refuses with `device_assigned_to_binding`) or `other_daemon` (`device_owned_by_other_daemon`).
     * `poolStatus` reports `assigned` for such a device even when this daemon holds no session on it.
     */
    heldBy?: DeviceHeldBy;
    session: {
      sessionUuid: string | null;
      ownership: DeviceSessionOwnership | null;
    } | null;
    serviceStatus: DeviceServiceStatusLike | null;
    locked: boolean | null;
    orientation: "portrait" | "landscape" | null;
    /**
     * Present only while the daemon still holds a session on an Android device that `adb devices`
     * lists in a non-`device` state (offline, unauthorized, ...), inside the disconnect monitor's
     * offline budget (#11118). Absent for a device adb reports online.
     */
    connection?: { state: "offline"; adbState: string };
    /**
     * Present only while a session holds an iOS simulator that `simctl` lists `Booting` or
     * `Shutting Down` (#11573); `lifecycle.state` is then `booting` / `shutting-down`. Absent for
     * a simulator that is booted.
     */
    simulatorState?: "Booting" | "Shutting Down";
  };
}

export type DeviceServiceStatusLike = {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  isCompatible: boolean;
  installedSha256?: string | null;
  expectedSha256?: string | null;
  version?: string;
  versionInfo?: {
    versionName?: string;
    versionCode?: string;
    build?: string;
    source: "android-package" | "ios-runner-bundle";
  };
  supportedCommandsComplete?: boolean | null;
  supportedFeaturesComplete?: boolean | null;
  recovery?: {
    state: "backoff" | "exhausted" | "suspended";
    attempts: number;
    reason?: string;
    nextAttemptAt?: string;
  };
};

export type ConfiguredImage = DeviceDescription;
