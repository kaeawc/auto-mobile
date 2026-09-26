import { z } from "zod/v4";
import type { PooledDevice } from "../daemon/devicePool";
import type { Session } from "../daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../models";
import type { ExactProvisionedDevice } from "../utils/exactDeviceProvisioning";
import type { StableConfiguredDeviceImage } from "../utils/configuredDeviceInventory";
import { iosSimulatorCapabilityInventory } from "../features/device-control/virtualDeviceCapabilities";
import type { FormFactor } from "../models/DeviceMatchCriteria";
import type { ObservationInsets } from "../models/ObservationInsets";
import { formFactorFrom } from "../models/formFactor";

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
    return describeImage(
      provisionedImage(input.provisioned),
      undefined,
      input.locked,
      input.orientation,
    );
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
    input.kind === "booted" ? input.configured : undefined,
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
    admittedImage: input.kind === "provisioned" ? provisionedImage(input.provisioned) : undefined,
    authoritative: input.kind === "provisioned",
  };
}

function provisionedImage(provisioned: ExactProvisionedDevice): DeviceInfo {
  const configuration =
    provisioned.device.platform === "android" && "configuration" in provisioned.resolvedSpec
      ? provisioned.resolvedSpec.configuration
      : undefined;
  return {
    ...provisioned.device,
    runtimeId:
      provisioned.device.runtimeId ??
      provisioned.device.runtime ??
      provisioned.resolvedSpec.runtime,
    deviceType: provisioned.device.deviceType ?? provisioned.resolvedSpec.deviceType,
    screenWidth: provisioned.device.screenWidth ?? configuration?.screenWidth,
    screenHeight: provisioned.device.screenHeight ?? configuration?.screenHeight,
    screenDensity: provisioned.device.screenDensity ?? configuration?.screenDensity,
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
  return {
    name: image.name,
    platform,
    isVirtual: true,
    source: image.source ?? "local",
    identity: { stableId },
    ...staticFacts,
    display: displayFrom(image),
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
  configured?: StableConfiguredDeviceImage,
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
  return {
    name: device.name,
    platform: device.platform,
    isVirtual,
    source: device.source ?? "local",
    identity: { stableId },
    ...staticFacts,
    display: displayFrom(merged),
    capabilityInventory: capabilityInventory(merged, isVirtual),
    image: imageLinkWithConfiguredFallback(admittedImage, configured),
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
    runtimeId: preferred(device.runtimeId, admittedImage?.runtimeId),
    runtime: preferred(device.runtime, admittedImage?.runtime),
    deviceType: preferred(device.deviceType, admittedImage?.deviceType),
    model: preferred(device.model, admittedImage?.model),
    architecture: preferred(device.architecture, admittedImage?.architecture),
    capabilityInventory: preferred(device.capabilityInventory, admittedImage?.capabilityInventory),
    isRunning: true,
  };
}

function imageLinkFrom(image: ImageLike | undefined): DeviceDescription["image"] {
  const link = image && "image" in image ? image.image : undefined;
  return {
    path: link?.path ?? null,
    target: link?.target ?? null,
    basedOn: link?.basedOn ?? null,
  };
}

function imageLinkWithConfiguredFallback(
  admittedImage: ImageLike | undefined,
  configured: StableConfiguredDeviceImage | undefined,
): DeviceDescription["image"] {
  const admitted = imageLinkFrom(admittedImage);
  const fallback = imageLinkFrom(configured);
  return {
    path: admitted.path ?? fallback.path,
    target: admitted.target ?? fallback.target,
    basedOn: admitted.basedOn ?? fallback.basedOn,
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

function displayFrom(
  device: Pick<DeviceInfo, "screenWidth" | "screenHeight" | "screenDensity" | "formFactor">,
): DeviceDescription["display"] {
  return {
    width: device.screenWidth ?? null,
    height: device.screenHeight ?? null,
    density: device.screenDensity ?? null,
    units: "physical-pixels",
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
  if (status.recovery || !status.installed || !status.enabled || !status.isCompatible) {
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

export type ListDevicesEntry = DeviceDescription;
export type ProvisionedDevice = DeviceDescription;
export type ConfiguredImage = DeviceDescription;
export type BootedDeviceDescription = DeviceDescription;

export function projectListDevicesEntry(description: DeviceDescription): ListDevicesEntry {
  return description;
}

export function projectProvisionedDevice(description: DeviceDescription): ProvisionedDevice {
  return description;
}

export function projectConfiguredImage(description: DeviceDescription): ConfiguredImage {
  return description;
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
    runtime: {
      ...description.runtime,
      readiness: { state: readinessFromServiceStatus(serviceStatus) },
      serviceStatus: serviceStatus ?? null,
    },
  };
}

/** Applies observed live state without rebuilding or reinterpreting static device facts. */
export function withDeviceRuntimeObservation(
  description: DeviceDescription,
  observation: {
    locked?: boolean;
    orientation?: "portrait" | "landscape";
  },
): DeviceDescription {
  return {
    ...description,
    runtime: {
      ...description.runtime,
      ...(observation.locked === undefined ? {} : { locked: observation.locked }),
      ...(observation.orientation === undefined ? {} : { orientation: observation.orientation }),
    },
  };
}

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const formFactorSchema = z.enum(["phone", "tablet", "foldable", "unknown"]);
const lifecycleSchema = z
  .object({
    state: z.enum(["configured", "booting", "booted", "shutting-down", "unavailable"]),
    known: z.boolean(),
  })
  .strict();
const readinessSchema = z.object({ state: z.enum(["unknown", "not_ready", "ready"]) }).strict();
const serviceStatusSchema = z
  .object({
    installed: z.boolean(),
    enabled: z.boolean(),
    running: z.boolean(),
    isCompatible: z.boolean(),
    installedSha256: z.string().nullable().optional(),
    expectedSha256: z.string().nullable().optional(),
    version: z.string().optional(),
    versionInfo: z
      .object({
        versionName: z.string().optional(),
        versionCode: z.string().optional(),
        build: z.string().optional(),
        source: z.enum(["android-package", "ios-runner-bundle"]),
      })
      .strict()
      .optional(),
    supportedCommandsComplete: z.boolean().nullable().optional(),
    supportedFeaturesComplete: z.boolean().nullable().optional(),
    recovery: z
      .object({
        state: z.enum(["backoff", "exhausted", "suspended"]),
        attempts: z.number().int().nonnegative(),
        reason: z.string().optional(),
        nextAttemptAt: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .nullable();
export const deviceDescriptionSchema = z
  .object({
    identity: z
      .object({
        stableId: z.string(),
      })
      .strict(),
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
    runtime: z
      .object({
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
          .strict()
          .nullable(),
        serviceStatus: serviceStatusSchema,
        locked: z.boolean().nullable(),
        orientation: z.enum(["portrait", "landscape"]).nullable(),
      })
      .strict(),
    display: z
      .object({
        width: nullableNumber,
        height: nullableNumber,
        density: nullableNumber,
        units: z.literal("physical-pixels"),
      })
      .strict(),
    capabilityInventory: z
      .object({
        schemaVersion: z.number(),
        capabilities: z.array(
          z
            .object({
              id: z.string(),
              state: z.enum(["supported", "unsupported", "unknown"]),
              reason: nullableString,
              source: nullableString,
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    image: z
      .object({ path: nullableString, target: nullableString, basedOn: nullableString })
      .strict(),
    availabilityError: nullableString,
  })
  .strict();

export const listDevicesEntrySchema = deviceDescriptionSchema;
export const provisionedDeviceSchema = deviceDescriptionSchema;
export const configuredImageSchema = deviceDescriptionSchema;
