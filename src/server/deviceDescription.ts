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
type FormFactor = "phone" | "tablet" | "foldable" | "unknown";

function toFormFactor(value: unknown): FormFactor {
  return value === "phone" || value === "tablet" || value === "foldable" ? value : "unknown";
}

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
  };
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

type DeviceServiceStatusLike = {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  isCompatible: boolean;
  installedSha256?: string;
  expectedSha256?: string;
  version?: string;
};
type DeviceSessionLike = Pick<Session, "sessionId"> & { ownership?: DeviceSessionOwnership };

interface AndroidProvenance {
  path?: string;
  target?: string;
  basedOn?: string;
  error?: string;
}

interface LegacySourceFacts {
  deviceId: string | null;
  isAvailable: boolean | null;
  formFactor: FormFactor | null;
}

// The phase-1 canonical shape intentionally excludes configured-image transport identity and
// availability. Retain those source facts privately long enough for legacyAliases() to reproduce
// the pre-canonical wire values without polluting the canonical record.
const legacySourceFacts = new WeakMap<DeviceDescription, LegacySourceFacts>();

function setLegacySourceFacts(
  description: DeviceDescription,
  deviceId: string | null,
  isAvailable: boolean | null,
  formFactor: FormFactor | undefined,
): void {
  legacySourceFacts.set(description, {
    deviceId,
    isAvailable,
    formFactor: formFactor ?? null,
  });
}

function legacyFormFactor(description: DeviceDescription): FormFactor | null {
  return legacySourceFacts.get(description)?.formFactor ?? null;
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
      configured?: StableConfiguredDeviceImage;
      session?: DeviceSessionLike;
      deviceSessionUuid?: string;
      serviceStatus?: DeviceServiceStatusLike;
      locked?: boolean;
      orientation?: "portrait" | "landscape";
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
      locked?: boolean;
      orientation?: "portrait" | "landscape";
    };

type ImageLike = DeviceInfo | StableConfiguredDeviceImage;
interface BootedImageFacts {
  admittedImage: ImageLike | undefined;
  authoritative: boolean;
}

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
    return describeImage(input.provisioned.device, undefined, input.locked, input.orientation);
  }

  const booted = input.kind === "booted" ? input.device : input.booted!;
  const pooled = input.pooled;
  const imageFacts = bootedImageFacts(input, booted);
  return describeBooted(
    booted,
    imageFacts.admittedImage,
    imageFacts.authoritative,
    pooled,
    input.session,
    input.deviceSessionUuid,
    input.serviceStatus,
    input.locked,
    input.orientation,
  );
}

function bootedImageFacts(
  input: Exclude<DeviceDescriptionInput, { kind: "image" }>,
  booted: BootedDevice,
): BootedImageFacts {
  if (input.pooled?.androidImage?.platform === booted.platform) {
    return { admittedImage: input.pooled.androidImage, authoritative: true };
  }
  if (input.discovery?.platform === booted.platform) {
    return { admittedImage: input.discovery, authoritative: true };
  }
  if (input.kind === "booted" && input.configured?.platform === booted.platform) {
    return { admittedImage: input.configured, authoritative: false };
  }
  return {
    admittedImage: input.kind === "provisioned" ? input.provisioned.device : undefined,
    authoritative: input.kind === "provisioned",
  };
}

// oxlint-disable-next-line complexity -- one exhaustive canonical image projection prevents producer drift.
function describeImage(
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
  const description: DeviceDescription = {
    name: image.name,
    platform,
    isVirtual: true,
    source: image.source ?? "local",
    identity: { stableId },
    ...staticFacts,
    display: displayFrom(image),
    capabilityInventory: capabilityInventory(image, true),
    image: {
      path: platform === "android" ? (androidProvenance?.path ?? null) : null,
      target: platform === "android" ? (androidProvenance?.target ?? null) : null,
      basedOn: platform === "android" ? (androidProvenance?.basedOn ?? null) : null,
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
  setLegacySourceFacts(
    description,
    image.deviceId ?? null,
    platform === "ios" ? (image.isAvailable ?? null) : null,
    image.formFactor,
  );
  return description;
}

// oxlint-disable-next-line complexity -- one exhaustive canonical booted projection preserves precedence.
function describeBooted(
  device: BootedDevice,
  admittedImage: ImageLike | undefined,
  admittedImageAuthoritative: boolean,
  pooled: PooledDevice | undefined,
  session: DeviceSessionLike | undefined,
  deviceSessionUuid: string | undefined,
  serviceStatus: DeviceServiceStatusLike | undefined,
  locked: boolean | null = null,
  orientation?: "portrait" | "landscape",
): DeviceDescription {
  const merged = mergeRuntimeFacts(device, admittedImage, admittedImageAuthoritative);
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
  const staticFacts = staticFactsFrom(merged);
  const description: DeviceDescription = {
    name: device.name,
    platform: device.platform,
    isVirtual,
    source: device.source ?? "local",
    identity: { stableId },
    ...staticFacts,
    display: displayFrom(merged),
    capabilityInventory: capabilityInventory(merged, isVirtual),
    image: { path: null, target: null, basedOn: null },
    availabilityError: device.platform === "ios" ? (merged.availabilityError ?? null) : null,
    runtime: {
      deviceId: device.deviceId,
      connectionId: pooled ? `${device.deviceId}#${pooled.incarnation}` : device.deviceId,
      deviceSessionUuid: deviceSessionUuid ?? null,
      lifecycle: { state: "booted", known: true },
      readiness: { state: readinessFromServiceStatus(serviceStatus) },
      poolStatus: poolStatus(pooled),
      session: session
        ? {
            sessionUuid: session.sessionId,
            ownership,
          }
        : null,
      serviceStatus: serviceStatus ?? null,
      locked,
      orientation: orientation ?? null,
    },
  };
  setLegacySourceFacts(description, device.deviceId, null, merged.formFactor);
  return description;
}

// oxlint-disable-next-line complexity -- each optional runtime fact follows documented precedence.
function mergeRuntimeFacts(
  device: BootedDevice,
  admittedImage: ImageLike | undefined,
  admittedImageAuthoritative: boolean,
): DeviceInfo {
  const preferred = <T>(deviceValue: T | undefined, imageValue: T | undefined): T | undefined =>
    admittedImageAuthoritative ? (imageValue ?? deviceValue) : (deviceValue ?? imageValue);
  return {
    ...admittedImage,
    ...device,
    // Pool/discovery/provisioning image facts are authoritative; configured inventory fills gaps.
    apiLevel: preferred(device.apiLevel, admittedImage?.apiLevel),
    osVersion: preferred(device.osVersion, admittedImage?.osVersion),
    screenWidth: preferred(device.screenWidth, admittedImage?.screenWidth),
    screenHeight: preferred(device.screenHeight, admittedImage?.screenHeight),
    screenDensity: preferred(device.screenDensity, admittedImage?.screenDensity),
    formFactor: preferred(device.formFactor, admittedImage?.formFactor),
    isRunning: true,
  };
}

function staticFactsFrom(
  device: DeviceInfo,
): Pick<
  DeviceDescription,
  "formFactor" | "deviceType" | "model" | "architecture" | "osVersion" | "apiLevel" | "runtimeId"
> {
  return {
    osVersion: device.osVersion ?? device.iosVersion ?? null,
    apiLevel: device.platform === "android" ? (device.apiLevel ?? null) : null,
    runtimeId: device.runtime ?? null,
    deviceType: device.deviceType ?? null,
    architecture: device.architecture ?? null,
    model: device.model ?? null,
    formFactor: toFormFactor(device.formFactor),
  };
}

function displayFrom(
  device: Pick<DeviceInfo, "screenWidth" | "screenHeight" | "screenDensity" | "formFactor">,
): DeviceDescription["display"] {
  return {
    width: device.screenWidth ?? null,
    height: device.screenHeight ?? null,
    density: device.screenDensity ?? null,
  };
}

function imageLifecycle(image: ImageLike): DeviceDescription["runtime"]["lifecycle"] {
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

export interface LegacyAliases {
  identity: {
    deviceId: string | null;
    connectionId: string | null;
    deviceSessionUuid: string | null;
  };
  lifecycle: DeviceDescription["runtime"]["lifecycle"];
  readiness: DeviceDescription["runtime"]["readiness"];
  session: {
    sessionUuid: string | null;
    ownership: DeviceSessionOwnership | null;
    poolStatus: DevicePoolStatus | null;
  };
  display: { formFactor: FormFactor | null };
  provenance: {
    android: {
      path: string | null;
      target: string | null;
      basedOn: string | null;
      error: string | null;
    } | null;
    ios: { isAvailable: boolean | null; availabilityError: string | null } | null;
  };
  runtime: {
    osVersion: string | null;
    apiLevel: number | null;
    runtimeId: string | null;
    deviceType: string | null;
    architecture: string | null;
    model: string | null;
  };
}

export type DeviceDescriptionWithLegacyAliases = Omit<
  DeviceDescription,
  "identity" | "display" | "runtime"
> &
  Omit<LegacyAliases, "identity" | "display" | "runtime"> & {
    identity: DeviceDescription["identity"] & LegacyAliases["identity"];
    display: DeviceDescription["display"] & LegacyAliases["display"];
    runtime: DeviceDescription["runtime"] & LegacyAliases["runtime"];
  };

export type ListDevicesEntry = DeviceDescriptionWithLegacyAliases;
export type ProvisionedDevice = DeviceDescriptionWithLegacyAliases;
export type ConfiguredImage = DeviceDescriptionWithLegacyAliases;
export type BootedDeviceDescription = DeviceDescriptionWithLegacyAliases;

export function legacyAliases(description: DeviceDescription): LegacyAliases {
  const sourceFacts = legacySourceFacts.get(description);
  const sessionUuid = description.runtime.session?.sessionUuid ?? null;
  const ownership = description.runtime.session?.ownership ?? null;
  return {
    identity: {
      deviceId: description.runtime.deviceId ?? sourceFacts?.deviceId ?? null,
      connectionId: description.runtime.connectionId,
      deviceSessionUuid: description.runtime.deviceSessionUuid,
    },
    lifecycle: description.runtime.lifecycle,
    readiness: description.runtime.readiness,
    session: {
      sessionUuid,
      ownership,
      poolStatus: description.runtime.poolStatus,
    },
    display: { formFactor: legacyFormFactor(description) },
    provenance:
      description.platform === "android"
        ? {
            android: {
              path: description.image.path,
              target: description.image.target,
              basedOn: description.image.basedOn,
              error: description.availabilityError,
            },
            ios: null,
          }
        : {
            android: null,
            ios: {
              isAvailable: sourceFacts?.isAvailable ?? null,
              availabilityError: description.availabilityError,
            },
          },
    runtime: {
      osVersion: description.osVersion,
      apiLevel: description.apiLevel,
      runtimeId: description.runtimeId,
      deviceType: description.deviceType,
      architecture: description.architecture,
      model: description.model,
    },
  };
}

function projectWithLegacyAliases(
  description: DeviceDescription,
): DeviceDescriptionWithLegacyAliases {
  const aliases = legacyAliases(description);
  return {
    ...description,
    ...aliases,
    identity: { ...description.identity, ...aliases.identity },
    display: { ...description.display, ...aliases.display },
    runtime: { ...description.runtime, ...aliases.runtime },
  };
}

export function projectListDevicesEntry(description: DeviceDescription): ListDevicesEntry {
  return projectWithLegacyAliases(description);
}

export function projectProvisionedDevice(description: DeviceDescription): ProvisionedDevice {
  return projectWithLegacyAliases(description);
}

export function projectConfiguredImage(description: DeviceDescription): ConfiguredImage {
  return projectWithLegacyAliases(description);
}

export function projectBootedDevice(description: DeviceDescription): BootedDeviceDescription {
  return projectWithLegacyAliases(description);
}

/** Deprecated `iosVersion` applies only to iOS image records. */
export function legacyIosVersion(
  description: Pick<DeviceDescription, "platform" | "osVersion">,
): string | null {
  return description.platform === "ios" ? description.osVersion : null;
}

/** Applies a later automation probe without letting a producer reimplement readiness mapping. */
export function withDeviceServiceStatus(
  description: DeviceDescription,
  serviceStatus: DeviceServiceStatusLike | undefined,
): DeviceDescription {
  const updated: DeviceDescription = {
    ...description,
    runtime: {
      ...description.runtime,
      readiness: { state: readinessFromServiceStatus(serviceStatus) },
      serviceStatus: serviceStatus ?? null,
    },
  };
  const sourceFacts = legacySourceFacts.get(description);
  if (sourceFacts) {
    legacySourceFacts.set(updated, sourceFacts);
  }
  return updated;
}

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const formFactorSchema = z.enum(["phone", "tablet", "foldable", "unknown"]);
const lifecycleSchema = z.object({
  state: z.enum(["configured", "booting", "booted", "shutting-down", "unavailable"]),
  known: z.boolean(),
});
const readinessSchema = z.object({ state: z.enum(["unknown", "not_ready", "ready"]) });
const serviceStatusSchema = z
  .object({
    installed: z.boolean(),
    enabled: z.boolean(),
    running: z.boolean(),
    isCompatible: z.boolean(),
    installedSha256: z.string().optional(),
    expectedSha256: z.string().optional(),
    version: z.string().optional(),
  })
  .nullable();
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
  formFactor: formFactorSchema,
  deviceType: nullableString,
  model: nullableString,
  architecture: nullableString,
  osVersion: nullableString,
  apiLevel: nullableNumber,
  runtimeId: nullableString,
  runtime: z.object({
    deviceId: nullableString,
    connectionId: nullableString,
    deviceSessionUuid: nullableString,
    lifecycle: lifecycleSchema,
    readiness: readinessSchema,
    poolStatus: z.enum(["idle", "assigned", "error"]).nullable(),
    session: z
      .object({
        sessionUuid: nullableString,
        ownership: z.enum(["owned", "awaiting-owner"]).nullable(),
      })
      .nullable(),
    serviceStatus: serviceStatusSchema,
    locked: z.boolean().nullable(),
    orientation: z.enum(["portrait", "landscape"]).nullable(),
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
    formFactor: formFactorSchema.nullable(),
  }),
  lifecycle: lifecycleSchema,
  readiness: readinessSchema,
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
  image: z.object({ path: nullableString, target: nullableString, basedOn: nullableString }),
  availabilityError: nullableString,
});

export const listDevicesEntrySchema = deviceDescriptionSchema
  .extend({
    deviceId: z.string(),
    apiLevel: nullableNumber,
    osVersion: nullableString,
    formFactor: formFactorSchema,
  })
  .passthrough();
export const provisionedDeviceSchema = deviceDescriptionSchema.passthrough();
export const configuredImageSchema = deviceDescriptionSchema.extend({
  stableId: z.string(),
  deviceId: nullableString,
  path: nullableString,
  target: nullableString,
  basedOn: nullableString,
  error: nullableString,
  // Compat alias carrying the RAW platform state (simctl `Shutdown`/`Booted`/…; null when
  // the platform has none) — the desktop picker string-compares it. Normalized state is in
  // `lifecycle.state`.
  state: nullableString,
  isAvailable: z.boolean(),
  availabilityError: nullableString,
  iosVersion: nullableString,
  deviceType: nullableString,
  legacyRuntimeId: nullableString,
  model: nullableString,
  architecture: nullableString,
});
