import { statusOf } from "./deviceBinding";
import {
  describeImage,
  imageLinkFrom,
  staticFactsFrom,
  displayFrom,
  capabilityInventory,
} from "../utils/deviceDescriptionProjection";
import type {
  DeviceDescription,
  DeviceReadinessState,
  DeviceHeldBy,
  DevicePoolStatus,
  DeviceSessionOwnership,
  DeviceServiceStatusLike,
} from "../models/deviceDescription";
export type {
  DeviceHeldBy,
  DeviceDescription,
  DeviceServiceStatusLike,
  ConfiguredImage,
} from "../models/deviceDescription";
export { projectConfiguredImage } from "../utils/deviceDescriptionProjection";
import type { DeviceHealthMarker } from "./deviceHealthMarkers";
import { z } from "zod/v4";
import { classifyPoolStatus, type PoolStatusBucket } from "./devicePool";
import type { GenericAvailability, PooledDevice } from "./devicePool";
import type { Session } from "./sessionManager";
import type { BootedDevice, DeviceInfo } from "../models";
import type { TransitionalSimulatorState } from "../models/TransitionalSimulator";
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
      /** adb lists the device in this non-`device` state (#11118). */
      adbOfflineState?: string;
      /** `simctl` lists the held simulator `Booting` or `Shutting Down` (#11573). */
      simulatorState?: TransitionalSimulatorState;
      /** The pool refuses generic allocation of this device: a broker binding or another daemon holds it. */
      heldBy?: DeviceHeldBy;
      /** A readiness, shutdown or recovery reservation keeps allocation off this idle device. */
      reserved?: boolean;
      /** The pool's own bucket for this device (`DevicePool.poolBucket`); wins over any local derivation. */
      poolStatus?: PoolStatusBucket | null;
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
    adbOfflineState: input.kind === "booted" ? input.adbOfflineState : undefined,
    simulatorState: input.kind === "booted" ? input.simulatorState : undefined,
    heldBy: input.kind === "booted" ? input.heldBy : undefined,
    reserved: input.kind === "booted" ? input.reserved : undefined,
    poolBucket: input.kind === "booted" ? input.poolStatus : undefined,
    unhealthy: input.unhealthy !== undefined,
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
  adbOfflineState?: string;
  simulatorState?: TransitionalSimulatorState;
  heldBy?: DeviceHeldBy;
  reserved?: boolean;
  /** A health marker keeps allocation off the device, so it is not `idle` (#11387). */
  unhealthy?: boolean;
  /** The pool's bucket for the device; when present it is the only status authority. */
  poolBucket?: PoolStatusBucket | null;
}

function describeBooted(options: BootedDescriptionOptions): DeviceDescription {
  const { device, admittedImage, admittedImageAuthoritative, pooled, configured } = options;
  const merged = mergeRuntimeFacts(device, admittedImage, admittedImageAuthoritative);
  // A cold-boot adapter can report a temporary non-emulator transport id even
  // though the selected configured image proves this is a virtual device.
  // Keep the configured-image fact ahead of the transport-id heuristic.
  const isVirtual = isBootedVirtual(device, admittedImage);
  const stableId =
    device.platform === "android" && isVirtual
      ? (pooled?.avdName ?? admittedImage?.name ?? device.name)
      : device.deviceId;
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
    runtime: describeBootedRuntime(options),
  };
}

function mergeRuntimeFacts(
  device: BootedDevice,
  admittedImage: ImageLike | undefined,
  admittedImageAuthoritative: boolean,
): DeviceInfo {
  const image: Partial<ImageLike> = admittedImage ?? {};
  const preferred = <T>(deviceValue: T | undefined, imageValue: T | undefined): T | undefined =>
    admittedImageAuthoritative ? (imageValue ?? deviceValue) : (deviceValue ?? imageValue);
  return {
    ...admittedImage,
    ...device,
    // Pool/discovery/provisioning image facts are authoritative; configured inventory fills gaps.
    apiLevel: preferred(device.apiLevel, image.apiLevel),
    osVersion: preferred(device.osVersion, image.osVersion),
    screenWidth: preferred(device.screenWidth, image.screenWidth),
    screenHeight: preferred(device.screenHeight, image.screenHeight),
    screenDensity: preferred(device.screenDensity, image.screenDensity),
    displays: preferred(device.displays, image.displays),
    formFactor: preferred(device.formFactor, image.formFactor),
    runtimeId: preferred(device.runtimeId, image.runtimeId),
    runtime: preferred(device.runtime, image.runtime),
    deviceType: preferred(device.deviceType, image.deviceType),
    model: preferred(device.model, image.model),
    architecture: preferred(device.architecture, image.architecture),
    capabilityInventory: preferred(device.capabilityInventory, image.capabilityInventory),
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

function poolStatus(
  pooled: PooledDevice | undefined,
  unlendable: boolean,
): DevicePoolStatus | null {
  return pooled ? classifyPoolStatus(statusOf(pooled), unlendable) : null;
}

/**
 * The one projection of the pool's {@link GenericAvailability} into description inputs, shared by
 * `listDevices` and the booted-device resources. A broker binding or other-daemon hold publishes
 * `heldBy`; a reservation reports `assigned` without it. Both read `assigned`, as `getStats()` does.
 */
export function poolHoldFor(
  devicePool: { genericAvailability(deviceId: string): GenericAvailability } | null | undefined,
  deviceId: string,
): { heldBy?: DeviceHeldBy; reserved?: boolean } {
  const availability = devicePool?.genericAvailability(deviceId);
  if (availability === "session_broker") {
    return { heldBy: "session_broker" };
  }
  if (availability === "foreign_daemon") {
    return { heldBy: "other_daemon" };
  }
  return availability === "reserved" ? { reserved: true } : {};
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
const formFactorSchema = z.enum([
  "phone",
  "tablet",
  "foldable",
  "tv",
  "watch",
  "automotive",
  "unknown",
]);
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
        reason: z.enum([
          "biometric-enrollment",
          "network-condition",
          "clock",
          "app-cleanup",
          "recording-teardown",
          "keep-screen-awake",
        ]),
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
        heldBy: z.enum(["session_broker", "other_daemon"]).optional(),
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
        connection: z
          .object({ state: z.literal("offline"), adbState: z.string() })
          .strict()
          .optional(),
        simulatorState: z.enum(["Booting", "Shutting Down"]).optional(),
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

function isBootedVirtual(device: BootedDevice, admittedImage: ImageLike | undefined): boolean {
  const isVirtual =
    admittedImage?.platform === device.platform ||
    (device.platform === "android"
      ? device.deviceId.startsWith("emulator-")
      : device.deviceId.includes("-") && device.deviceId.length > 30);
  return isVirtual;
}

function describeBootedRuntime(options: BootedDescriptionOptions): DeviceDescription["runtime"] {
  const {
    device,
    pooled,
    session,
    deviceSessionUuid,
    serviceStatus,
    locked = null,
    orientation,
    adbOfflineState,
    simulatorState,
    heldBy,
  } = options;
  const ownership = session ? (session.ownership ?? "owned") : null;
  return {
    deviceId: device.deviceId,
    connectionId: pooled ? `${device.deviceId}#${pooled.incarnation}` : device.deviceId,
    deviceSessionUuid: deviceSessionUuid ?? null,
    ...bootedRuntimeStatus(options),
    ...(heldBy ? { heldBy } : {}),
    session: session
      ? {
          sessionUuid: session.sessionId,
          ownership,
        }
      : null,
    serviceStatus: serviceStatus ?? null,
    locked,
    orientation: orientation ?? null,
    ...(adbOfflineState ? { connection: { state: "offline", adbState: adbOfflineState } } : {}),
    ...(simulatorState ? { simulatorState } : {}),
  };
}

function bootedRuntimeStatus({
  simulatorState,
  adbOfflineState,
  serviceStatus,
  poolBucket,
  pooled,
  heldBy,
  reserved,
  unhealthy,
}: BootedDescriptionOptions): Pick<
  DeviceDescription["runtime"],
  "lifecycle" | "readiness" | "poolStatus"
> {
  return {
    lifecycle: {
      state: simulatorState
        ? simulatorState === "Booting"
          ? "booting"
          : "shutting-down"
        : "booted",
      known: true,
    },
    readiness: {
      state:
        adbOfflineState || simulatorState ? "not_ready" : readinessFromServiceStatus(serviceStatus),
    },
    poolStatus:
      poolBucket !== undefined
        ? poolBucket
        : poolStatus(pooled, Boolean(heldBy ?? reserved) || unhealthy === true),
  };
}
