import {
  describeImage,
  imageLinkFrom,
  staticFactsFrom,
  displayFrom,
  capabilityInventory,
} from "../models/deviceDescription";
import type {
  DeviceDescription,
  DeviceReadinessState,
  DevicePoolStatus,
  DeviceSessionOwnership,
  DeviceServiceStatusLike,
} from "../models/deviceDescription";
export type {
  DeviceReadinessState,
  DevicePoolStatus,
  DeviceSessionOwnership,
  DeviceDescription,
  DeviceServiceStatusLike,
  ConfiguredImage,
} from "../models/deviceDescription";
export { projectConfiguredImage } from "../models/deviceDescription";
import type { DeviceHealthMarker } from "../daemon/deviceHealthMarkers";
import { z } from "zod/v4";
import type { PooledDevice } from "../daemon/devicePool";
import type { Session } from "../daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../models";
import type { ExactProvisionedDevice } from "../devices/exactDeviceProvisioning";
import type { StableConfiguredDeviceImage } from "../utils/configuredDeviceInventory";

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
      unhealthy?: DeviceHealthMarker;
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
      unhealthy?: DeviceHealthMarker;
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
  const description = describeBooted({
    device: booted,
    admittedImage: imageFacts.admittedImage,
    admittedImageAuthoritative: imageFacts.authoritative,
    pooled,
    session: input.session,
    deviceSessionUuid: input.deviceSessionUuid,
    serviceStatus: input.serviceStatus,
    locked: input.locked,
    orientation: input.orientation,
    configured: input.kind === "booted" ? input.configured : undefined,
  });
  return input.unhealthy ? { ...description, unhealthy: input.unhealthy } : description;
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

interface BootedDescriptionOptions {
  device: BootedDevice;
  admittedImage: ImageLike | undefined;
  admittedImageAuthoritative: boolean;
  pooled: PooledDevice | undefined;
  session: DeviceSessionLike | undefined;
  deviceSessionUuid: string | undefined;
  serviceStatus: DeviceServiceStatusLike | undefined;
  locked?: boolean | null;
  orientation?: "portrait" | "landscape";
  configured?: StableConfiguredDeviceImage;
}

// oxlint-disable-next-line complexity -- one exhaustive canonical booted projection preserves precedence.
function describeBooted({
  device,
  admittedImage,
  admittedImageAuthoritative,
  pooled,
  session,
  deviceSessionUuid,
  serviceStatus,
  locked = null,
  orientation,
  configured,
}: BootedDescriptionOptions): DeviceDescription {
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
    ...(merged.displays?.panels.length ? { displays: merged.displays } : {}),
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
    displays: preferred(device.displays, admittedImage?.displays),
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

export type ListDevicesEntry = DeviceDescription;
export type ProvisionedDevice = DeviceDescription;
export type BootedDeviceDescription = DeviceDescription;

export function projectListDevicesEntry(description: DeviceDescription): ListDevicesEntry {
  return description;
}

export function projectProvisionedDevice(description: DeviceDescription): ProvisionedDevice {
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

/** Applies a later OS boot-completion observation without changing static device facts. */
export function withDeviceLifecycle(
  description: DeviceDescription,
  lifecycle: DeviceDescription["runtime"]["lifecycle"],
): DeviceDescription {
  return { ...description, runtime: { ...description.runtime, lifecycle } };
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
    unhealthy: z
      .object({
        reason: z.enum(["biometric-enrollment", "network-condition", "clock"]),
        since: z.number(),
      })
      .strict()
      .optional(),
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
    displays: z
      .object({
        panels: z.array(
          z
            .object({
              key: z.string(),
              role: z.enum(["inner", "cover", "rear", "external", "unknown"]),
              sizePx: z.object({ width: z.number(), height: z.number() }).strict(),
              scale: z.number().optional(),
            })
            .strict(),
        ),
        postures: z.array(
          z.enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent", "unknown"]),
        ),
      })
      .strict()
      .optional(),
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
