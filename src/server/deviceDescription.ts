import { z } from "zod/v4";
import type { PooledDevice } from "../daemon/devicePool";
import type { Session } from "../daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../models";
import type { ExactProvisionedDevice } from "../utils/exactDeviceProvisioning";
import type { StableConfiguredDeviceImage } from "../utils/configuredDeviceInventory";
import { iosSimulatorCapabilityInventory } from "../features/device-control/virtualDeviceCapabilities";

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
  identity: {
    stableId: string;
    deviceId: string | null;
    connectionId: string | null;
    // Registry per-connection routing key (DeviceSessionRegistry), NOT durable across a device restart — distinct from session.sessionUuid (the MCP device session).
    deviceSessionUuid: string | null;
  };
  name: string;
  platform: DevicePlatform;
  isVirtual: boolean;
  source: "local" | "remote" | null;
  runtime: {
    osVersion: string | null;
    apiLevel: number | null;
    runtimeId: string | null;
    deviceType: string | null;
    architecture: string | null;
    model: string | null;
  };
  display: {
    width: number | null;
    height: number | null;
    density: number | null;
    formFactor: string | null;
  };
  lifecycle: { state: DeviceLifecycleState; known: boolean };
  readiness: { state: DeviceReadinessState };
  session: {
    sessionUuid: string | null;
    ownership: DeviceSessionOwnership | null;
    poolStatus: DevicePoolStatus | null;
  };
  provenance: {
    android: {
      path: string | null;
      target: string | null;
      basedOn: string | null;
      error: string | null;
    } | null;
    ios: { isAvailable: boolean | null; availabilityError: string | null } | null;
  };
  capabilityInventory: CapabilityInventory | null;
}

type DeviceServiceStatusLike = {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  isCompatible: boolean;
};
type DeviceSessionLike = Pick<Session, "sessionId"> & { ownership?: DeviceSessionOwnership };

interface AndroidProvenance {
  path?: string;
  target?: string;
  basedOn?: string;
  error?: string;
}

export type DeviceDescriptionInput =
  | {
      kind: "image";
      image: DeviceInfo | StableConfiguredDeviceImage;
      androidProvenance?: AndroidProvenance;
    }
  | {
      kind: "booted";
      device: BootedDevice;
      pooled?: PooledDevice;
      discovery?: DeviceInfo;
      session?: DeviceSessionLike;
      deviceSessionUuid?: string;
      serviceStatus?: DeviceServiceStatusLike;
    }
  | {
      kind: "provisioned";
      provisioned: ExactProvisionedDevice;
      booted?: BootedDevice;
      pooled?: PooledDevice;
      discovery?: DeviceInfo;
      session?: DeviceSessionLike;
      deviceSessionUuid?: string;
      serviceStatus?: DeviceServiceStatusLike;
    };

type ImageLike = DeviceInfo | StableConfiguredDeviceImage;

/**
 * The sole device-description builder. Pool-admitted Android-image facts win
 * over discovery, which wins over AVD/simctl configuration; this preserves the
 * identity and display configuration that was admitted for a live connection.
 */
export function describeDevice(input: DeviceDescriptionInput): DeviceDescription {
  if (input.kind === "image") {
    return describeImage(input.image, input.androidProvenance);
  }

  if (input.kind === "provisioned" && !input.booted) {
    return describeImage(input.provisioned.device);
  }

  const booted = input.kind === "booted" ? input.device : input.booted!;
  const pooled = input.pooled;
  const image =
    pooled?.androidImage?.platform === booted.platform
      ? pooled.androidImage
      : input.discovery?.platform === booted.platform
        ? input.discovery
        : input.kind === "provisioned"
          ? input.provisioned.device
          : undefined;
  return describeBooted(
    booted,
    image,
    pooled,
    input.session,
    input.deviceSessionUuid,
    input.serviceStatus,
  );
}

// oxlint-disable-next-line complexity -- one exhaustive canonical image projection prevents producer drift.
function describeImage(image: ImageLike, androidProvenance?: AndroidProvenance): DeviceDescription {
  const platform = image.platform;
  const stableId =
    "stableId" in image
      ? image.stableId
      : image.platform === "android"
        ? image.name
        : (image.deviceId ?? image.name);
  const lifecycle = imageLifecycle(image);
  return {
    identity: {
      stableId,
      deviceId: image.deviceId ?? null,
      connectionId: null,
      deviceSessionUuid: null,
    },
    name: image.name,
    platform,
    isVirtual: true,
    source: image.source ?? "local",
    runtime: runtimeFrom(image),
    display: displayFrom(image),
    lifecycle,
    readiness: { state: "unknown" },
    session: { sessionUuid: null, ownership: null, poolStatus: null },
    provenance:
      platform === "android"
        ? {
            android: {
              path: androidProvenance?.path ?? null,
              target: androidProvenance?.target ?? null,
              basedOn: androidProvenance?.basedOn ?? null,
              error: androidProvenance?.error ?? null,
            },
            ios: null,
          }
        : {
            android: null,
            ios: {
              isAvailable: image.isAvailable ?? null,
              availabilityError: image.availabilityError ?? null,
            },
          },
    capabilityInventory: capabilityInventory(image, true),
  };
}

// oxlint-disable-next-line complexity -- one exhaustive canonical booted projection preserves precedence.
function describeBooted(
  device: BootedDevice,
  admittedImage: DeviceInfo | undefined,
  pooled: PooledDevice | undefined,
  session: DeviceSessionLike | undefined,
  deviceSessionUuid: string | undefined,
  serviceStatus: DeviceServiceStatusLike | undefined,
): DeviceDescription {
  const merged = mergeRuntimeFacts(device, admittedImage);
  // A cold-boot adapter can report a temporary non-emulator transport id even
  // though the selected configured image proves this is a virtual device.
  // Keep the configured-image fact ahead of the transport-id heuristic.
  const isVirtual =
    admittedImage?.platform === device.platform ||
    (device.platform === "android"
      ? device.deviceId.startsWith("emulator-")
      : device.deviceId.includes("-") && device.deviceId.length > 30);
  const stableId =
    device.platform === "android" && isVirtual
      ? (pooled?.avdName ?? admittedImage?.name ?? device.name)
      : device.deviceId;
  const ownership = session ? (session.ownership ?? "owned") : null;
  return {
    identity: {
      stableId,
      deviceId: device.deviceId,
      connectionId: pooled ? `${device.deviceId}#${pooled.incarnation}` : device.deviceId,
      deviceSessionUuid: deviceSessionUuid ?? null,
    },
    name: device.name,
    platform: device.platform,
    isVirtual,
    source: device.source ?? "local",
    runtime: runtimeFrom(merged),
    display: displayFrom(merged),
    lifecycle: { state: "booted", known: true },
    readiness: { state: readinessFromServiceStatus(serviceStatus) },
    session: {
      sessionUuid: session?.sessionId ?? null,
      ownership,
      poolStatus: poolStatus(pooled),
    },
    provenance:
      device.platform === "android"
        ? { android: { path: null, target: null, basedOn: null, error: null }, ios: null }
        : { android: null, ios: { isAvailable: null, availabilityError: null } },
    capabilityInventory: capabilityInventory(merged, isVirtual),
  };
}

// oxlint-disable-next-line complexity -- each optional runtime fact follows documented precedence.
function mergeRuntimeFacts(
  device: BootedDevice,
  admittedImage: DeviceInfo | undefined,
): DeviceInfo {
  return {
    ...admittedImage,
    ...device,
    // An admitted Android image is authoritative for configured display and runtime facts.
    apiLevel: admittedImage?.apiLevel ?? device.apiLevel,
    osVersion: admittedImage?.osVersion ?? device.osVersion,
    screenWidth: admittedImage?.screenWidth ?? device.screenWidth,
    screenHeight: admittedImage?.screenHeight ?? device.screenHeight,
    screenDensity: admittedImage?.screenDensity ?? device.screenDensity,
    formFactor: admittedImage?.formFactor ?? device.formFactor,
    isRunning: true,
  };
}

function runtimeFrom(device: DeviceInfo): DeviceDescription["runtime"] {
  return {
    osVersion: device.osVersion ?? device.iosVersion ?? null,
    apiLevel: device.platform === "android" ? (device.apiLevel ?? null) : null,
    runtimeId: device.runtime ?? null,
    deviceType: device.deviceType ?? null,
    architecture: device.architecture ?? null,
    model: device.model ?? null,
  };
}

function displayFrom(
  device: Pick<DeviceInfo, "screenWidth" | "screenHeight" | "screenDensity" | "formFactor">,
): DeviceDescription["display"] {
  return {
    width: device.screenWidth ?? null,
    height: device.screenHeight ?? null,
    density: device.screenDensity ?? null,
    formFactor: device.formFactor ?? null,
  };
}

function imageLifecycle(image: ImageLike): DeviceDescription["lifecycle"] {
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

function readinessFromServiceStatus(
  status: DeviceServiceStatusLike | undefined,
): DeviceReadinessState {
  if (!status) {
    return "unknown";
  }
  if (!status.installed || !status.enabled || !status.isCompatible) {
    return "not_ready";
  }
  // A missing live automation connection is inconclusive on both platforms.
  return status.running ? "ready" : "unknown";
}

function poolStatus(pooled: PooledDevice | undefined): DevicePoolStatus | null {
  if (!pooled) {
    return null;
  }
  if (pooled.status === "busy") {
    return "assigned";
  }
  return pooled.status === "idle" || pooled.status === "error" ? pooled.status : null;
}

function capabilityInventory(device: DeviceInfo, isVirtual: boolean): CapabilityInventory | null {
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

type DeviceDescriptionProjection<K extends keyof DeviceDescription> = Pick<DeviceDescription, K>;

export type ListDevicesEntry = Omit<
  DeviceDescriptionProjection<
    "identity" | "name" | "platform" | "isVirtual" | "runtime" | "display" | "lifecycle" | "session"
  >,
  "display" | "session"
> & {
  display: Pick<DeviceDescription["display"], "formFactor">;
  session: Pick<DeviceDescription["session"], "sessionUuid">;
};

export type ProvisionedDevice = DeviceDescriptionProjection<
  "identity" | "name" | "platform" | "runtime" | "display" | "lifecycle"
>;
export type ConfiguredImage = DeviceDescriptionProjection<
  | "identity"
  | "name"
  | "platform"
  | "isVirtual"
  | "source"
  | "runtime"
  | "display"
  | "lifecycle"
  | "provenance"
  | "capabilityInventory"
>;
export type BootedDeviceDescription = DeviceDescription;

export function projectListDevicesEntry(description: DeviceDescription): ListDevicesEntry {
  const { identity, name, platform, isVirtual, runtime, lifecycle } = description;
  return {
    identity,
    name,
    platform,
    isVirtual,
    runtime,
    display: { formFactor: description.display.formFactor },
    lifecycle,
    session: { sessionUuid: description.session.sessionUuid },
  };
}

export function projectProvisionedDevice(description: DeviceDescription): ProvisionedDevice {
  const { identity, name, platform, runtime, display, lifecycle } = description;
  return { identity, name, platform, runtime, display, lifecycle };
}

export function projectConfiguredImage(description: DeviceDescription): ConfiguredImage {
  const {
    identity,
    name,
    platform,
    isVirtual,
    source,
    runtime,
    display,
    lifecycle,
    provenance,
    capabilityInventory,
  } = description;
  return {
    identity,
    name,
    platform,
    isVirtual,
    source,
    runtime,
    display,
    lifecycle,
    provenance,
    capabilityInventory,
  };
}

export function projectBootedDevice(description: DeviceDescription): BootedDeviceDescription {
  return description;
}

/** Applies a later automation probe without letting a producer reimplement readiness mapping. */
export function withDeviceServiceStatus(
  description: DeviceDescription,
  serviceStatus: DeviceServiceStatusLike | undefined,
): DeviceDescription {
  return {
    ...description,
    readiness: { state: readinessFromServiceStatus(serviceStatus) },
  };
}

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
export const deviceDescriptionSchema = z.object({
  identity: z.object({
    stableId: z.string(),
    deviceId: nullableString,
    connectionId: nullableString,
    deviceSessionUuid: nullableString,
  }),
  name: z.string(),
  platform: z.enum(["android", "ios"]),
  isVirtual: z.boolean(),
  source: z.enum(["local", "remote"]).nullable(),
  runtime: z.object({
    osVersion: nullableString,
    apiLevel: nullableNumber,
    runtimeId: nullableString,
    deviceType: nullableString,
    architecture: nullableString,
    model: nullableString,
  }),
  display: z.object({
    width: nullableNumber,
    height: nullableNumber,
    density: nullableNumber,
    formFactor: nullableString,
  }),
  lifecycle: z.object({
    state: z.enum(["configured", "booting", "booted", "shutting-down", "unavailable"]),
    known: z.boolean(),
  }),
  readiness: z.object({ state: z.enum(["unknown", "not_ready", "ready"]) }),
  session: z.object({
    sessionUuid: nullableString,
    ownership: z.enum(["owned", "awaiting-owner"]).nullable(),
    poolStatus: z.enum(["idle", "assigned", "error"]).nullable(),
  }),
  provenance: z.object({
    android: z
      .object({
        path: nullableString,
        target: nullableString,
        basedOn: nullableString,
        error: nullableString,
      })
      .nullable(),
    ios: z
      .object({ isAvailable: z.boolean().nullable(), availabilityError: nullableString })
      .nullable(),
  }),
  capabilityInventory: z
    .object({
      schemaVersion: z.number(),
      capabilities: z.array(
        z.object({
          id: z.string(),
          state: z.enum(["supported", "unsupported", "unknown"]),
          reason: nullableString,
          source: nullableString,
        }),
      ),
    })
    .nullable(),
});

export const listDevicesEntrySchema = z.object({
  deviceId: z.string(),
  identity: deviceDescriptionSchema.shape.identity,
  name: deviceDescriptionSchema.shape.name,
  platform: deviceDescriptionSchema.shape.platform,
  isVirtual: deviceDescriptionSchema.shape.isVirtual,
  runtime: deviceDescriptionSchema.shape.runtime,
  display: z.object({ formFactor: nullableString }),
  lifecycle: deviceDescriptionSchema.shape.lifecycle,
  session: z.object({ sessionUuid: nullableString }),
  apiLevel: nullableNumber.optional(),
  osVersion: nullableString.optional(),
  formFactor: nullableString.optional(),
});
export const provisionedDeviceSchema = deviceDescriptionSchema
  .pick({
    identity: true,
    name: true,
    platform: true,
    runtime: true,
    display: true,
    lifecycle: true,
  })
  .passthrough();
export const configuredImageSchema = deviceDescriptionSchema
  .pick({
    identity: true,
    name: true,
    platform: true,
    isVirtual: true,
    source: true,
    runtime: true,
    display: true,
    lifecycle: true,
    provenance: true,
    capabilityInventory: true,
  })
  .extend({
    stableId: z.string(),
    deviceId: nullableString,
    path: nullableString,
    target: nullableString,
    basedOn: nullableString,
    error: nullableString,
    state: z.enum(["configured", "booting", "booted", "shutting-down", "unavailable"]),
    isAvailable: z.boolean(),
    availabilityError: nullableString,
    iosVersion: nullableString,
    deviceType: nullableString,
    legacyRuntimeId: nullableString,
    model: nullableString,
    architecture: nullableString,
  });
