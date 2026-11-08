import type { ConfiguredImage } from "../models/deviceDescription";

type CapabilityInventory = NonNullable<ConfiguredImage["capabilityInventory"]>;
type Capability = CapabilityInventory["capabilities"][number];

/** Capability sources that describe the host, not the image, so every image on a host shares them. */
const HOST_SCOPED_CAPABILITY_SOURCES: ReadonlySet<string> = new Set(["host_audio"]);

/** Image fields that are dropped from a compact entry when they are `null`. */
type NullableImageKey =
  | "source"
  | "deviceType"
  | "model"
  | "architecture"
  | "osVersion"
  | "apiLevel"
  | "configuredRamMb"
  | "effectiveRamMb"
  | "configuredCpuCores"
  | "effectiveCpuCores"
  | "runtimeId"
  | "availabilityError";

export type CompactConfiguredImage = Omit<
  ConfiguredImage,
  NullableImageKey | "runtime" | "display" | "image" | "capabilityInventory"
> &
  Partial<Pick<ConfiguredImage, NullableImageKey | "display" | "image">> & {
    runtime: Partial<ConfiguredImage["runtime"]> &
      Pick<ConfiguredImage["runtime"], "lifecycle" | "readiness">;
    capabilityProfile?: string;
  };

export interface CompactDeviceImageListing {
  images: CompactConfiguredImage[];
  /** Shared capability inventories, keyed by the `capabilityProfile` an image carries. */
  capabilityProfiles?: Record<string, CapabilityInventory>;
  /** Host-scoped capabilities that apply to every image that has a capability profile. */
  host?: { capabilities: Capability[] };
}

function sameCapability(left: Capability, right: Capability): boolean {
  return (
    left.id === right.id &&
    left.state === right.state &&
    left.reason === right.reason &&
    left.source === right.source
  );
}

/**
 * A host-scoped entry is hoisted only when every image that has an inventory carries an identical
 * entry for that id, so `host.capabilities` never claims something an image does not report.
 */
function hoistedHostCapabilities(inventories: readonly CapabilityInventory[]): Capability[] {
  const [first, ...rest] = inventories;
  if (!first) {
    return [];
  }
  return first.capabilities.filter(
    (candidate) =>
      candidate.source !== null &&
      HOST_SCOPED_CAPABILITY_SOURCES.has(candidate.source) &&
      rest.every((inventory) =>
        inventory.capabilities.some((entry) => sameCapability(entry, candidate)),
      ),
  );
}

function withoutNullValues<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null),
  ) as Partial<T>;
}

function compactImage(
  image: ConfiguredImage,
  profileFor: (inventory: CapabilityInventory) => string,
): CompactConfiguredImage {
  const {
    runtime,
    display,
    image: imageFiles,
    capabilityInventory,
    source,
    deviceType,
    model,
    architecture,
    osVersion,
    apiLevel,
    configuredRamMb,
    effectiveRamMb,
    configuredCpuCores,
    effectiveCpuCores,
    runtimeId,
    availabilityError,
    ...always
  } = image;
  const capabilityProfile = capabilityInventory ? profileFor(capabilityInventory) : undefined;
  const hasDisplay = display.width !== null || display.height !== null || display.density !== null;
  const hasImageFiles =
    imageFiles.path !== null || imageFiles.target !== null || imageFiles.basedOn !== null;
  return {
    ...always,
    ...withoutNullValues({
      source,
      deviceType,
      model,
      architecture,
      osVersion,
      apiLevel,
      configuredRamMb,
      effectiveRamMb,
      configuredCpuCores,
      effectiveCpuCores,
      runtimeId,
      availabilityError,
    }),
    runtime: {
      ...withoutNullValues(runtime),
      lifecycle: runtime.lifecycle,
      readiness: runtime.readiness,
    },
    ...(hasDisplay ? { display } : {}),
    ...(hasImageFiles ? { image: imageFiles } : {}),
    ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
  };
}

/**
 * The default `listDeviceImages` shape (#17256): host-scoped capabilities appear once under
 * `host`, identical per-image capability inventories collapse into `capabilityProfiles`, and
 * null-valued fields are omitted. `detail: "full"` keeps the per-image shape instead.
 */
export function compactDeviceImages(images: readonly ConfiguredImage[]): CompactDeviceImageListing {
  const inventories = images.flatMap((image) =>
    image.capabilityInventory ? [image.capabilityInventory] : [],
  );
  const hoisted = hoistedHostCapabilities(inventories);
  const hoistedIds = new Set(hoisted.map((entry) => entry.id));
  const profileKeys = new Map<string, string>();
  const profiles: Record<string, CapabilityInventory> = {};
  const profileFor = (inventory: CapabilityInventory): string => {
    const profile: CapabilityInventory = {
      schemaVersion: inventory.schemaVersion,
      capabilities: inventory.capabilities.filter((entry) => !hoistedIds.has(entry.id)),
    };
    const fingerprint = JSON.stringify(profile);
    const existing = profileKeys.get(fingerprint);
    if (existing !== undefined) {
      return existing;
    }
    const key = `p${profileKeys.size + 1}`;
    profileKeys.set(fingerprint, key);
    profiles[key] = profile;
    return key;
  };
  const compacted = images.map((image) => compactImage(image, profileFor));
  return {
    images: compacted,
    ...(profileKeys.size > 0 ? { capabilityProfiles: profiles } : {}),
    ...(hoisted.length > 0 ? { host: { capabilities: hoisted } } : {}),
  };
}
