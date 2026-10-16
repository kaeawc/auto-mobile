import type {
  AndroidArchetype,
  AndroidCatalogProfile,
  AndroidCatalogRelease,
  AndroidSessionDeviceCatalog,
  AndroidVersionPrecision,
  CatalogMetadataState,
} from "../sessionRequirements";
import { parseNumericVersion } from "../sessionRequirements";
import { errorMessage } from "../../utils/describeUnknownError";
import { apiLevelToVersion } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import type {
  DeviceProfile,
  SystemImage,
  SystemImageFilter,
} from "../../utils/android-cmdline-tools/avdmanager";
import { logger as defaultLogger } from "../../utils/logger";
import { nativeCatalogRevision } from "./revision";

const ANDROID_CATALOG_SOURCE = "android-sdk-installed-catalog";
export const ANDROID_CATALOG_ADAPTER_VERSION = "android-native-catalog-v1";

export interface AndroidNativeCatalogReader {
  listDevices(signal?: AbortSignal): Promise<DeviceProfile[]>;
  listInstalledSystemImages(
    filter?: SystemImageFilter,
    signal?: AbortSignal,
  ): Promise<SystemImage[]>;
}

/**
 * Hardware category is operator policy keyed by the exact avdmanager profile
 * ID. Profiles absent from this map remain visible with unknown category.
 */
export interface AndroidCatalogPolicy {
  profileArchetypes: Readonly<Partial<Record<string, AndroidArchetype>>>;
}

export interface AndroidCatalogAdapterOptions {
  metadataState?: CatalogMetadataState;
}

export interface AndroidCatalogReadOptions extends AndroidCatalogAdapterOptions {
  signal?: AbortSignal;
  logger?: Pick<typeof defaultLogger, "warn">;
}

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

function androidProfile(
  profile: DeviceProfile,
  policy: AndroidCatalogPolicy,
  snapshotState: CatalogMetadataState,
  duplicate: boolean,
): AndroidCatalogProfile {
  const archetype = policy.profileArchetypes[profile.id];
  return {
    profileId: profile.id,
    ...(archetype === undefined ? {} : { archetype }),
    metadataState:
      snapshotState === "stale" || duplicate || profile.id.length === 0 ? "stale" : "current",
  };
}

function versionPrecision(componentCount: number): AndroidVersionPrecision {
  if (componentCount <= 1) {
    return "major";
  }
  return componentCount === 2 ? "minor" : "patch";
}

function imageSourceMatches(
  image: SystemImage,
  packageMetadata: ReturnType<typeof parseAndroidSystemImageRuntime>,
): boolean {
  if (packageMetadata === undefined) {
    return false;
  }
  return (
    packageMetadata.apiLevel === image.apiLevel &&
    packageMetadata.apiIdentifier === image.apiIdentifier &&
    packageMetadata.tag === image.tag &&
    packageMetadata.abi === image.abi
  );
}

function releaseMetadataState(
  snapshotState: CatalogMetadataState,
  duplicate: boolean,
  sourceMatches: boolean,
): CatalogMetadataState {
  return snapshotState === "stale" || duplicate || !sourceMatches ? "stale" : "current";
}

function androidVersionMetadata(apiLevel: number): {
  osVersion?: string;
  versionPrecision: AndroidVersionPrecision;
} {
  const releaseVersion = apiLevelToVersion(apiLevel);
  if (releaseVersion === undefined) {
    return { versionPrecision: "major" };
  }
  const numericVersion = parseNumericVersion(releaseVersion);
  if (!numericVersion.ok) {
    return { versionPrecision: "major" };
  }
  return {
    osVersion: numericVersion.value.value,
    versionPrecision: versionPrecision(numericVersion.value.precision),
  };
}

function androidRelease(
  image: SystemImage,
  snapshotState: CatalogMetadataState,
  duplicate: boolean,
): AndroidCatalogRelease {
  const packageMetadata = parseAndroidSystemImageRuntime(image.packageName);
  const metadataState = releaseMetadataState(
    snapshotState,
    duplicate,
    imageSourceMatches(image, packageMetadata),
  );
  const apiLevel = packageMetadata?.apiLevel ?? image.apiLevel;

  return {
    systemImagePackage: image.packageName,
    ...androidVersionMetadata(apiLevel),
    apiLevel,
    abi: packageMetadata?.abi ?? image.abi,
    flavor: packageMetadata?.tag ?? image.tag,
    installed: true,
    metadataState,
  };
}

export function adaptAndroidSessionDeviceCatalog(
  profiles: readonly DeviceProfile[],
  systemImages: readonly SystemImage[],
  policy: AndroidCatalogPolicy,
  options: AndroidCatalogAdapterOptions = {},
): AndroidSessionDeviceCatalog {
  const snapshotState = options.metadataState ?? "current";
  const duplicateProfiles = duplicateValues(profiles.map((entry) => entry.id));
  const duplicateImages = duplicateValues(systemImages.map((entry) => entry.packageName));
  const adaptedProfiles = profiles
    .map((entry) => androidProfile(entry, policy, snapshotState, duplicateProfiles.has(entry.id)))
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
  const releases = systemImages
    .map((entry) => androidRelease(entry, snapshotState, duplicateImages.has(entry.packageName)))
    .sort((a, b) => a.systemImagePackage.localeCompare(b.systemImagePackage));
  const revision = nativeCatalogRevision(ANDROID_CATALOG_SOURCE, {
    adapterVersion: ANDROID_CATALOG_ADAPTER_VERSION,
    policy: Object.entries(policy.profileArchetypes).sort(([a], [b]) => a.localeCompare(b)),
    profiles: adaptedProfiles,
    releases,
  });

  return {
    platform: "android",
    provenance: { source: ANDROID_CATALOG_SOURCE, revision, state: "ready" },
    profiles: adaptedProfiles,
    releases,
  };
}

async function readAndroidNativeCatalog(
  reader: AndroidNativeCatalogReader,
  signal: AbortSignal | undefined,
): Promise<readonly [DeviceProfile[], SystemImage[]]> {
  const [profiles, systemImages] = await Promise.allSettled([
    reader.listDevices(signal),
    reader.listInstalledSystemImages(undefined, signal),
  ]);
  if (profiles.status === "rejected") {
    throw profiles.reason;
  }
  if (systemImages.status === "rejected") {
    throw systemImages.reason;
  }
  if (profiles.value.length === 0) {
    throw new Error("Android emulator profile catalog returned no profiles.");
  }
  return [profiles.value, systemImages.value];
}

export async function readAndroidSessionDeviceCatalog(
  reader: AndroidNativeCatalogReader,
  policy: AndroidCatalogPolicy,
  options: AndroidCatalogReadOptions = {},
): Promise<AndroidSessionDeviceCatalog> {
  try {
    const [profiles, systemImages] = await readAndroidNativeCatalog(reader, options.signal);
    return adaptAndroidSessionDeviceCatalog(profiles, systemImages, policy, options);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const message = `Unable to read the installed Android emulator catalog: ${errorMessage(error)}`;
    (options.logger ?? defaultLogger).warn(message, error);
    return {
      platform: "android",
      provenance: {
        source: ANDROID_CATALOG_SOURCE,
        revision: "unavailable",
        state: "unavailable",
        message,
      },
      profiles: [],
      releases: [],
    };
  }
}
