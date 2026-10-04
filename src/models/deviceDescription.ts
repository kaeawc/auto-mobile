import type { DeviceInfo } from "./index";
import type { DeviceDisplays } from "./DisplayPanel";
import type { StableConfiguredDeviceImage } from "../utils/configuredDeviceInventory";
import { iosSimulatorCapabilityInventory } from "./virtualDeviceCapabilities";
import type { FormFactor } from "./DeviceMatchCriteria";
import type { ObservationInsets } from "./ObservationInsets";
import { formFactorFrom } from "./formFactor";

export type DevicePlatform = "android" | "ios";
export type DeviceLifecycleState =
  | "configured"
  | "booting"
  | "booted"
  | "shutting-down"
  | "unavailable";
export type DeviceReadinessState = "unknown" | "not_ready" | "ready";
export type DevicePoolStatus = "idle" | "assigned" | "error";
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
    readonly reason: "biometric-enrollment" | "network-condition" | "clock";
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
    session: {
      sessionUuid: string | null;
      ownership: DeviceSessionOwnership | null;
    } | null;
    serviceStatus: DeviceServiceStatusLike | null;
    locked: boolean | null;
    orientation: "portrait" | "landscape" | null;
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
interface AndroidProvenance {
  path?: string;
  target?: string;
  basedOn?: string;
  error?: string;
}

type ImageLike = DeviceInfo | StableConfiguredDeviceImage;

export function describeDevice(input: {
  kind: "image";
  image: ImageLike;
  androidProvenance?: AndroidProvenance;
}): DeviceDescription {
  return describeImage(input.image, input.androidProvenance);
}

// oxlint-disable-next-line complexity -- one exhaustive canonical image projection prevents producer drift.
export function describeImage(
  image: ImageLike,
  androidProvenance?: AndroidProvenance,
  locked: boolean | null = null,
  orientation?: "portrait" | "landscape",
): DeviceDescription {
  const platform = image.platform;
  const stableId =
    "stableId" in image
      ? image.stableId
      : image.platform === "android"
        ? image.name
        : (image.deviceId ?? image.name);
  const lifecycle = imageLifecycle(image);
  const staticFacts = staticFactsFrom(image);
  return {
    name: image.name,
    platform,
    isVirtual: true,
    source: image.source ?? "local",
    identity: { stableId },
    ...staticFacts,
    display: displayFrom(image),
    ...(image.displays?.panels.length ? { displays: image.displays } : {}),
    capabilityInventory: capabilityInventory(image, true),
    image: {
      path: platform === "android" ? (androidProvenance?.path ?? imageLinkFrom(image).path) : null,
      target:
        platform === "android" ? (androidProvenance?.target ?? imageLinkFrom(image).target) : null,
      basedOn:
        platform === "android"
          ? (androidProvenance?.basedOn ?? imageLinkFrom(image).basedOn)
          : null,
    },
    availabilityError:
      platform === "android"
        ? (androidProvenance?.error ?? null)
        : (image.availabilityError ?? null),
    runtime: {
      deviceId: null,
      connectionId: null,
      deviceSessionUuid: null,
      lifecycle,
      readiness: { state: "unknown" },
      poolStatus: null,
      session: null,
      serviceStatus: null,
      locked,
      orientation: orientation ?? null,
    },
  };
}

export function imageLinkFrom(image: ImageLike | undefined): DeviceDescription["image"] {
  const link = image && "image" in image ? image.image : undefined;
  return {
    path: link?.path ?? null,
    target: link?.target ?? null,
    basedOn: link?.basedOn ?? null,
  };
}

export function staticFactsFrom(
  device: DeviceInfo,
): Pick<
  DeviceDescription,
  "formFactor" | "deviceType" | "model" | "architecture" | "osVersion" | "apiLevel" | "runtimeId"
> {
  return {
    osVersion: device.osVersion ?? device.iosVersion ?? null,
    apiLevel: device.platform === "android" ? (device.apiLevel ?? null) : null,
    runtimeId: device.runtimeId ?? device.runtime ?? null,
    deviceType: device.deviceType ?? null,
    architecture: device.architecture ?? null,
    model: device.model ?? null,
    formFactor: formFactorFrom({
      hint: device.formFactor,
      width: device.screenWidth,
      height: device.screenHeight,
      density: device.screenDensity,
      deviceType: device.deviceType,
    }),
  };
}

export function displayFrom(
  device: Pick<DeviceInfo, "screenWidth" | "screenHeight" | "screenDensity" | "formFactor">,
): DeviceDescription["display"] {
  return {
    width: device.screenWidth ?? null,
    height: device.screenHeight ?? null,
    density: device.screenDensity ?? null,
    units: "physical-pixels",
  };
}

export function imageLifecycle(image: ImageLike): DeviceDescription["runtime"]["lifecycle"] {
  if (image.isAvailable === false) {
    return { state: "unavailable", known: true };
  }
  const state = image.state?.trim().toLowerCase();
  const mapped: Record<string, DeviceLifecycleState | undefined> = {
    shutdown: "configured",
    booting: "booting",
    booted: "booted",
    "shutting down": "shutting-down",
    creating: "configured",
  };
  if (state && mapped[state]) {
    return {
      state: mapped[state],
      known: state !== "creating" && image.isRunningStateKnown !== false,
    };
  }
  return {
    state: image.isRunning ? "booted" : "configured",
    known: image.isRunningStateKnown !== false,
  };
}

export function capabilityInventory(
  device: DeviceInfo,
  isVirtual: boolean,
): CapabilityInventory | null {
  const inventory =
    device.capabilityInventory ??
    (device.platform === "ios" && isVirtual
      ? iosSimulatorCapabilityInventory({
          isAvailable: device.isAvailable,
          availabilityError: device.availabilityError,
          runtime: device.runtime,
        })
      : undefined);
  if (!inventory) {
    return null;
  }
  return {
    schemaVersion: inventory.schemaVersion,
    capabilities: inventory.capabilities.map((capability) => ({
      id: capability.id,
      state:
        capability.state === "available"
          ? "supported"
          : capability.state === "unsupported" || capability.state === "unavailable"
            ? "unsupported"
            : "unknown",
      reason: capability.reason ?? null,
      source: capability.source ?? null,
    })),
  };
}

export type ConfiguredImage = DeviceDescription;

export function projectConfiguredImage(description: DeviceDescription): ConfiguredImage {
  return description;
}
