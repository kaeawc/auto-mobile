import { VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION } from "../models/virtualDeviceCapabilities";
import { isAndroidEmulatorSerial } from "./androidSerial";
import { androidGrpcAudioCapabilities } from "./audio/audioCapabilities";
import { emulatorGrpcAudioSnapshot } from "./audio/emulatorGrpcAudioState";
import type { DeviceInfo } from "../models";
import type {
  DeviceDescription,
  CapabilityInventory,
  DeviceLifecycleState,
  ConfiguredImage,
} from "../models/deviceDescription";
import { formFactorFrom } from "../models/formFactor";
import { parseAndroidSystemImageRuntime } from "./android-cmdline-tools/AndroidSystemImageRuntime";
import { iosSimulatorCapabilityInventory } from "./virtualDeviceCapabilities";
import { hostAudioSnapshot } from "./audio/defaultHostAudioProbe";
import type { StableConfiguredDeviceImage } from "./configuredDeviceInventory";

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

/** One exhaustive canonical image projection so producers cannot drift apart. */
export function describeImage(
  image: ImageLike,
  androidProvenance?: AndroidProvenance,
  locked: boolean | null = null,
  orientation?: "portrait" | "landscape",
): DeviceDescription {
  const platform = image.platform;
  const lifecycle = imageLifecycle(image);
  const staticFacts = staticFactsFrom(image);
  return {
    name: image.name,
    platform,
    isVirtual: true,
    source: image.source ?? "local",
    identity: { stableId: imageStableId(image) },
    ...staticFacts,
    display: displayFrom(image),
    ...(image.displays?.panels.length ? { displays: image.displays } : {}),
    capabilityInventory: capabilityInventory(image, true),
    image: imageProvenanceLink(image, androidProvenance),
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

function imageStableId(image: ImageLike): string {
  if ("stableId" in image) {
    return image.stableId;
  }
  return image.platform === "android" ? image.name : (image.deviceId ?? image.name);
}

function imageProvenanceLink(
  image: ImageLike,
  androidProvenance: AndroidProvenance | undefined,
): DeviceDescription["image"] {
  if (image.platform !== "android") {
    return { path: null, target: null, basedOn: null };
  }
  const link = imageLinkFrom(image);
  return {
    path: androidProvenance?.path ?? link.path,
    target: androidProvenance?.target ?? link.target,
    basedOn: androidProvenance?.basedOn ?? link.basedOn,
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

function androidSystemImageTag(device: DeviceInfo): string | undefined {
  return device.platform === "android" && device.runtimeId
    ? parseAndroidSystemImageRuntime(device.runtimeId)?.tag
    : undefined;
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
      systemImageTag: androidSystemImageTag(device),
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

function androidGrpcCapabilities(
  device: DeviceInfo,
  isVirtual: boolean,
): ReturnType<typeof androidGrpcAudioCapabilities> {
  return device.platform === "android" &&
    isVirtual &&
    device.deviceId &&
    isAndroidEmulatorSerial(device.deviceId)
    ? androidGrpcAudioCapabilities(emulatorGrpcAudioSnapshot(device.deviceId))
    : [];
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
          hostAudio: hostAudioSnapshot(),
        })
      : undefined);
  const grpc = androidGrpcCapabilities(device, isVirtual);
  if (!inventory && grpc.length === 0) {
    return null;
  }
  const grpcIds = new Set(grpc.map((entry) => entry.id));
  const capabilities = [
    ...(inventory?.capabilities ?? []).filter((entry) => !grpcIds.has(entry.id)),
    ...grpc,
  ];
  return {
    schemaVersion: inventory?.schemaVersion ?? VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities: capabilities.map((capability) => ({
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

export function projectConfiguredImage(description: DeviceDescription): ConfiguredImage {
  return description;
}
