/**
 * Device provisioning — creating a simulator/emulator when none matches.
 *
 * This module owns *selection* (which device type / runtime / system image) and
 * delegates *execution* to the existing primitives:
 *   - iOS:     `SimCtlClient.createSimulator` (all simctl stays inside the client)
 *   - Android: `AvdManagerClient.createAvd` via the avdmanager module
 *
 * Nothing here decides whether provisioning is allowed — that is
 * {@link DeviceCreationGate}'s job, checked by the caller.
 */

import { ActionableError, toActionableError } from "../models/ActionableError";
import type { DeviceMatchCriteria } from "../models/DeviceMatchCriteria";
import type { AppleDeviceType } from "./ios-cmdline-tools/SimCtlClient";
import type { CreateAvdParams, SystemImage } from "./android-cmdline-tools/avdmanager";
import { createAvd, listInstalledSystemImages } from "./android-cmdline-tools/avdmanager";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import { CREATED_DEVICE_NAME_PREFIX } from "./deviceCreationGate";
import { defaultIdGenerator, type IdGenerator } from "./IdGenerator";
import { logger } from "./logger";

/** What was created, for logging and for handing straight to the boot path. */
export interface ProvisionedDevice {
  platform: "android" | "ios";
  /** Device name (iOS simulator name / AVD name). */
  name: string;
  /** Simulator UDID; Android AVDs are addressed by name, so this is undefined there. */
  deviceId?: string;
  /** iOS device type identifier, or the Android system-image package. */
  deviceType: string;
  /** iOS runtime identifier, or the Android API level. */
  runtime: string;
}

/** Exactly the SimCtlClient surface provisioning needs. */
export interface IosSimulatorCreator {
  getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]>;
  resolveRuntimeIdentifier(requestedVersion?: string, signal?: AbortSignal): Promise<string>;
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** Exactly the avdmanager surface provisioning needs. */
export interface AndroidAvdCreator {
  listInstalledSystemImages(signal?: AbortSignal): Promise<SystemImage[]>;
  createAvd(
    params: CreateAvdParams,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; message: string; avdName?: string }>;
}

export interface DeviceProvisioner {
  provision(
    criteria: DeviceMatchCriteria,
    signal?: AbortSignal,
    identityHooks?: DeviceProvisioningIdentityHooks,
  ): Promise<ProvisionedDevice>;
}

export interface DeviceProvisioningIdentityHooks {
  reserveBeforeCreate(
    identity: Pick<ProvisionedDevice, "platform" | "name">,
  ): Promise<AbortSignal | undefined>;
  bindAfterCreate(device: ProvisionedDevice): Promise<void>;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Build a recognisable, unique name so created devices can be found and cleaned
 * up later. Uniqueness comes from the injected {@link IdGenerator} rather than a
 * bare `randomUUID()` so tests are deterministic.
 */
export function buildCreatedDeviceName(
  baseName: string,
  idGenerator: IdGenerator = defaultIdGenerator,
): string {
  const slug = baseName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "device";
  const suffix = idGenerator.next().replace(/-/g, "").slice(0, 8);
  return `${CREATED_DEVICE_NAME_PREFIX}-${slug}-${suffix}`;
}

/** True when `name` looks like a device AutoMobile provisioned. */
export function isCreatedDeviceName(name: string): boolean {
  return name.startsWith(`${CREATED_DEVICE_NAME_PREFIX}-`);
}

// ---------------------------------------------------------------------------
// iOS selection
// ---------------------------------------------------------------------------

const IOS_FAMILY_BY_FORM_FACTOR: Record<"phone" | "tablet", string> = {
  phone: "iPhone",
  tablet: "iPad",
};

/** Highest numeric token in a device-type name ("iPhone 17 Pro" -> 17). */
function highestNumericToken(name: string): number {
  const matches = name.match(/\d+/g);
  if (!matches) {
    return -1;
  }
  return matches.reduce((best, token) => Math.max(best, Number.parseInt(token, 10)), -1);
}

/**
 * Choose a simulator device type.
 *
 * An explicit `name` wins (case-insensitive exact match on the device-type
 * name). Otherwise pick the newest model in the requested family, preferring the
 * base model over "Pro"/"Max" variants so the choice is stable and predictable.
 */
export function pickIosDeviceType(
  deviceTypes: AppleDeviceType[],
  criteria: Pick<DeviceMatchCriteria, "name" | "formFactor">,
): AppleDeviceType {
  if (deviceTypes.length === 0) {
    throw new ActionableError(
      "No iOS simulator device types are available from 'xcrun simctl list devicetypes'. " +
        "Install an iOS platform via Xcode > Settings > Components.",
    );
  }

  if (criteria.name) {
    const wanted = criteria.name.trim().toLowerCase();
    const exact = deviceTypes.find((type) => type.name.toLowerCase() === wanted);
    if (exact) {
      return exact;
    }
  }

  const family = IOS_FAMILY_BY_FORM_FACTOR[criteria.formFactor ?? "phone"];
  const candidates = deviceTypes.filter(
    (type) => type.productFamily === family || type.name.startsWith(family),
  );

  if (candidates.length === 0) {
    throw new ActionableError(
      `No ${family} simulator device type is available. ` +
        `Available device types: ${deviceTypes.map((type) => type.name).join(", ")}.`,
    );
  }

  return [...candidates].sort((a, b) => {
    const versionDelta = highestNumericToken(b.name) - highestNumericToken(a.name);
    if (versionDelta !== 0) {
      return versionDelta;
    }
    // Shorter name = base model ("iPhone 17" before "iPhone 17 Pro Max").
    const lengthDelta = a.name.length - b.name.length;
    if (lengthDelta !== 0) {
      return lengthDelta;
    }
    return a.name.localeCompare(b.name);
  })[0];
}

// ---------------------------------------------------------------------------
// Android selection
// ---------------------------------------------------------------------------

/**
 * Preferred system-image tags, best first.
 *
 * `google_apis_playstore` is ranked LAST on purpose: Play Store images refuse
 * `adb root`, and AutoMobile needs a root shell for the root-backed system-locale
 * path (see AndroidSystemConfigurationAdapter, which fails with "the target
 * emulator is not root-capable or does not allow root ADB"). Auto-provisioning a
 * Play Store image would therefore hand the user a device that silently cannot
 * run `changeLocalization` on the API levels that require it.
 *
 * `google_apis` is preferred over `default` because it is rootable AND carries
 * the Google APIs some flows expect.
 */
const ANDROID_TAG_PREFERENCE = ["google_apis", "default", "google_apis_playstore"];

function tagRank(tag: string): number {
  const index = ANDROID_TAG_PREFERENCE.indexOf(tag);
  return index === -1 ? ANDROID_TAG_PREFERENCE.length : index;
}

/** ABIs that can run on the host, best first. */
export function preferredAbis(architecture: string): string[] {
  return architecture === "arm64" ? ["arm64-v8a", "x86_64"] : ["x86_64", "x86"];
}

function abiRank(abi: string, preferences: string[]): number {
  const index = preferences.indexOf(abi);
  return index === -1 ? preferences.length : index;
}

function parseApiLevel(version: string | undefined): number | undefined {
  if (!version) {
    return undefined;
  }
  const parsed = Number.parseInt(version.trim().split(".")[0], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Choose an installed system image: newest API level within the requested
 * range, preferring a host-runnable ABI and a Google APIs tag.
 */
export function pickAndroidSystemImage(
  images: SystemImage[],
  criteria: Pick<DeviceMatchCriteria, "minOsVersion" | "maxOsVersion">,
  architecture: string,
): SystemImage {
  const min = parseApiLevel(criteria.minOsVersion);
  const max = parseApiLevel(criteria.maxOsVersion);

  const inRange = images.filter((image) => {
    if (min !== undefined && image.apiLevel < min) {
      return false;
    }
    if (max !== undefined && image.apiLevel > max) {
      return false;
    }
    return true;
  });

  if (inRange.length === 0) {
    throw new ActionableError(
      "No installed Android system image matches the requested API range " +
        `(min=${criteria.minOsVersion ?? "any"}, max=${criteria.maxOsVersion ?? "any"}). ` +
        `Installed images: ${images.map((image) => image.packageName).join(", ") || "none"}. ` +
        "Install one with 'sdkmanager \"system-images;android-<api>;google_apis;<abi>\"'.",
    );
  }

  const preferences = preferredAbis(architecture);
  const runnable = inRange.filter((image) => preferences.includes(image.abi));
  const candidates = runnable.length > 0 ? runnable : inRange;

  return [...candidates].sort((a, b) => {
    const apiDelta = b.apiLevel - a.apiLevel;
    if (apiDelta !== 0) {
      return apiDelta;
    }
    const abiDelta = abiRank(a.abi, preferences) - abiRank(b.abi, preferences);
    if (abiDelta !== 0) {
      return abiDelta;
    }
    const tagDelta = tagRank(a.tag) - tagRank(b.tag);
    if (tagDelta !== 0) {
      return tagDelta;
    }
    return a.packageName.localeCompare(b.packageName);
  })[0];
}

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

export interface DefaultDeviceProvisionerDependencies {
  iosCreator: () => IosSimulatorCreator | undefined;
  androidCreator: () => AndroidAvdCreator;
  idGenerator?: IdGenerator;
  architecture?: string;
  /** Internal caller-owned device naming policy; the default remains unique user provisioning. */
  createdDeviceName?: (baseName: string) => string;
  /** Optional lifecycle bridge for callers that must reserve a generated name before creation. */
  identityHooks?: DeviceProvisioningIdentityHooks;
}

export class DefaultDeviceProvisioner implements DeviceProvisioner {
  private readonly idGenerator: IdGenerator;
  private readonly architecture: string;

  constructor(private readonly dependencies: DefaultDeviceProvisionerDependencies) {
    this.idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
    this.architecture = dependencies.architecture ?? process.arch;
  }

  async provision(
    criteria: DeviceMatchCriteria,
    signal?: AbortSignal,
    identityHooks: DeviceProvisioningIdentityHooks | undefined = this.dependencies.identityHooks,
  ): Promise<ProvisionedDevice> {
    if (criteria.platform === "ios") {
      return this.provisionIos(criteria, signal, identityHooks);
    }
    if (criteria.platform === "android") {
      return this.provisionAndroid(criteria, signal, identityHooks);
    }
    throw new ActionableError(
      `Device creation requires an explicit platform; got '${criteria.platform}'.`,
    );
  }

  private async provisionIos(
    criteria: DeviceMatchCriteria,
    signal?: AbortSignal,
    identityHooks?: DeviceProvisioningIdentityHooks,
  ): Promise<ProvisionedDevice> {
    const simctl = this.dependencies.iosCreator();
    if (!simctl) {
      throw new ActionableError(
        "Cannot create an iOS simulator: iOS simulator tools (xcrun simctl) are not available.",
      );
    }

    const deviceTypes = await simctl.getDeviceTypes(signal);
    const deviceType = pickIosDeviceType(deviceTypes, criteria);
    const runtime = await simctl.resolveRuntimeIdentifier(criteria.minOsVersion, signal);
    const name =
      this.dependencies.createdDeviceName?.(deviceType.name) ??
      buildCreatedDeviceName(deviceType.name, this.idGenerator);
    const identitySignal = await identityHooks?.reserveBeforeCreate({
      platform: "ios",
      name,
    });
    const creationSignal =
      signal && identitySignal
        ? AbortSignal.any([signal, identitySignal])
        : (signal ?? identitySignal);

    let deviceId: string;
    try {
      deviceId = await simctl.createSimulator(name, deviceType.identifier, runtime, creationSignal);
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to create iOS simulator '${name}' (deviceType=${deviceType.identifier}, runtime=${runtime})`,
      );
    }

    const provisioned = {
      platform: "ios" as const,
      name,
      deviceId,
      deviceType: deviceType.identifier,
      runtime,
    };
    logger.info(
      `[DeviceProvisioner] Created iOS simulator '${name}' ` +
        `(udid=${deviceId}, deviceType=${deviceType.identifier}, runtime=${runtime}). ` +
        "Delete it with 'xcrun simctl delete " +
        deviceId +
        "' when no longer needed.",
    );
    await identityHooks?.bindAfterCreate(provisioned);

    return provisioned;
  }

  private async provisionAndroid(
    criteria: DeviceMatchCriteria,
    signal?: AbortSignal,
    identityHooks?: DeviceProvisioningIdentityHooks,
  ): Promise<ProvisionedDevice> {
    const avdManager = this.dependencies.androidCreator();

    let installed: SystemImage[];
    try {
      installed = await avdManager.listInstalledSystemImages(signal);
    } catch (error) {
      throw toActionableError(
        error,
        "Failed to list installed Android system images for AVD creation",
      );
    }

    const image = pickAndroidSystemImage(installed, criteria, this.architecture);
    const name = buildCreatedDeviceName(
      criteria.name ?? `android-${image.apiLevel}`,
      this.idGenerator,
    );
    const identitySignal = await identityHooks?.reserveBeforeCreate({
      platform: "android",
      name,
    });
    const creationSignal =
      signal && identitySignal
        ? AbortSignal.any([signal, identitySignal])
        : (signal ?? identitySignal);

    const result = await avdManager.createAvd({ name, package: image.packageName }, creationSignal);
    if (!result.success) {
      throw new ActionableError(
        `Failed to create Android AVD '${name}' from ${image.packageName}: ${result.message}`,
      );
    }

    const provisioned = {
      platform: "android" as const,
      name,
      deviceType: image.packageName,
      runtime: `android-${image.apiLevel}`,
    };
    logger.info(
      `[DeviceProvisioner] Created Android AVD '${name}' ` +
        `(systemImage=${image.packageName}, apiLevel=${image.apiLevel}, tag=${image.tag}, abi=${image.abi}). ` +
        `Delete it with 'avdmanager delete avd -n ${name}' when no longer needed.`,
    );
    await identityHooks?.bindAfterCreate(provisioned);
    return provisioned;
  }
}

/** The avdmanager functional API, adapted to the narrow creator interface. */
export function createDefaultAndroidAvdCreator(): AndroidAvdCreator {
  return {
    listInstalledSystemImages: (signal) => listInstalledSystemImages(undefined, undefined, signal),
    createAvd: (params, signal) => createAvd(params, undefined, signal),
  };
}

/** Production provisioner wired to the real simctl/avdmanager primitives. */
export function createDefaultDeviceProvisioner(
  iosCreator: () => IosSimulatorCreator | undefined = () => new SimCtlClient(null),
  identityHooks?: DeviceProvisioningIdentityHooks,
): DeviceProvisioner {
  return new DefaultDeviceProvisioner({
    iosCreator,
    androidCreator: createDefaultAndroidAvdCreator,
    identityHooks,
  });
}
