import type { ConfigurableDeviceResource } from "../models/DeviceResourceConfiguration";
import { isIosDuoDeviceType } from "../utils/ios-cmdline-tools/iosDeviceType";
import type { SimulatorCreator } from "./SimulatorCreator";
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

import { SimulatorPrebootProfile } from "../utils/ios-cmdline-tools/SimulatorPrebootProfile";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type { DeviceMatchCriteria } from "../models/DeviceMatchCriteria";
import type { FormFactor } from "../models/DeviceMatchCriteria";
import type { AppleDeviceType } from "../utils/ios-cmdline-tools/SimCtlClient";
import type { CreateAvdParams, SystemImage } from "../utils/android-cmdline-tools/avdmanager";
import { createAvd, listInstalledSystemImages } from "../utils/android-cmdline-tools/avdmanager";
import { versionToApiLevelRange } from "../utils/android-cmdline-tools/AvdConfigReader";
import { CTRL_PROXY_APK_MIN_SDK, parseAndroidApiLevelBound } from "../utils/androidVersionBounds";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { CREATED_DEVICE_NAME_PREFIX } from "./deviceCreationGate";
import { ProvisionDeviceCreateRejectedError } from "./exactDeviceProvisioning";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import {
  evaluateRuntimeCompatibility,
  hasRuntimeRangeMetadata,
} from "../utils/ios-cmdline-tools/runtimeCompatibility";
import { iosVersionStringFromRuntimeId } from "../utils/ios-cmdline-tools/iosVersion";
import { compareStrictNumericVersions } from "../utils/deviceMatcher";
import { androidSystemImageTagsFor } from "../models/formFactor";
import { BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY } from "../utils/provisionDeviceSpecSchemas";

/** What was created, for logging and for handing straight to the boot path. */
export interface ProvisionedDevice {
  prebootDisabledResources?: readonly ConfigurableDeviceResource[];
  platform: "android" | "ios";
  /** Device name (iOS simulator name / AVD name). */
  name: string;
  /** Simulator UDID; Android AVDs are addressed by name, so this is undefined there. */
  deviceId?: string;
  /** iOS device type identifier, or the Android system-image package. */
  deviceType: string;
  /** Exact CoreSimulator runtime identifier or Android system-image package. */
  runtimeId?: string;
  /** iOS runtime identifier, or the Android API level. */
  runtime: string;
}

/** Exactly the SimCtlClient surface provisioning needs. */
export interface IosSimulatorCreator {
  getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]>;
  resolveRuntimeIdentifiersForBounds(
    minVersion?: string,
    maxVersion?: string,
    signal?: AbortSignal,
  ): Promise<string[]>;
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

/**
 * The identity a create is about to claim. iOS selection also carries the
 * device type and runtime, so a create that never reported its UDID can still be
 * found by exact identity and rolled back (#11155).
 */
export type ProvisioningCreateIdentity = Pick<ProvisionedDevice, "platform" | "name"> &
  Partial<Pick<ProvisionedDevice, "deviceType" | "runtimeId" | "runtime">>;

export interface DeviceProvisioningIdentityHooks {
  reserveBeforeCreate(identity: ProvisioningCreateIdentity): Promise<AbortSignal | undefined>;
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

type IosProvisioningFormFactor = "phone" | "tablet";

function iosProvisioningFormFactor(formFactor: FormFactor | undefined): IosProvisioningFormFactor {
  switch (formFactor) {
    case undefined:
    case "phone":
      return "phone";
    case "tablet":
      return "tablet";
    case "foldable":
    case "tv":
    case "watch":
    case "automotive":
    case "unknown":
      throw new ActionableError(
        `iOS provisioning supports only phone or tablet form factors, not '${formFactor}'.`,
      );
  }
}

function deviceTypeMatchesIosFormFactor(
  deviceType: AppleDeviceType,
  formFactor: "phone" | "tablet" = "phone",
): boolean {
  // The Duo is foldable, so a phone request must not select it: inventory would report it as
  // foldable and the next phone request would provision again.
  if (formFactor === "phone" && isIosDuoDeviceType(deviceType.identifier)) {
    return false;
  }
  const family = IOS_FAMILY_BY_FORM_FACTOR[formFactor];
  return deviceType.productFamily === family || deviceType.name.startsWith(family);
}

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

  const formFactor = iosProvisioningFormFactor(criteria.formFactor);

  if (criteria.name) {
    const wanted = criteria.name.trim().toLowerCase();
    const exact = deviceTypes.find((type) => type.name.toLowerCase() === wanted);
    if (exact) {
      return exact;
    }
  }

  const family = IOS_FAMILY_BY_FORM_FACTOR[formFactor];
  const candidates = deviceTypes.filter((type) => deviceTypeMatchesIosFormFactor(type, formFactor));

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

function deviceTypeSupportsRuntime(deviceType: AppleDeviceType, runtimeVersion: string): boolean {
  const { status } = evaluateRuntimeCompatibility(deviceType, runtimeVersion);
  // Legacy output with no range metadata at all stays selectable; malformed
  // metadata or an unparsable runtime version is still rejected here.
  return status === "supported" || (status === "unknown" && !hasRuntimeRangeMetadata(deviceType));
}

function noCompatibleIosDeviceTypeError(
  deviceTypes: AppleDeviceType[],
  runtimeVersions: string[],
  formFactor: IosProvisioningFormFactor,
  foundRuntimeCompatibleDeviceType: boolean,
): ActionableError {
  const family = foundRuntimeCompatibleDeviceType ? IOS_FAMILY_BY_FORM_FACTOR[formFactor] : "iOS";
  return new ActionableError(
    `No installed ${family} simulator device type supports the matching runtime(s) ` +
      `${runtimeVersions.join(", ")}. Available device types: ` +
      `${deviceTypes.map((deviceType) => deviceType.name).join(", ")}.`,
  );
}

export async function resolveIosProvisioningSelection(
  simctl: IosSimulatorCreator,
  criteria: Pick<DeviceMatchCriteria, "name" | "formFactor" | "minOsVersion" | "maxOsVersion">,
  signal?: AbortSignal,
): Promise<{ deviceType: AppleDeviceType; runtime: string }> {
  const formFactor = iosProvisioningFormFactor(criteria.formFactor);
  const deviceTypes = await simctl.getDeviceTypes(signal);
  if (deviceTypes.length === 0) {
    throw new ActionableError(
      "No iOS simulator device types are available from 'xcrun simctl list devicetypes'. " +
        "Install an iOS platform via Xcode > Settings > Components.",
    );
  }
  const runtimeIdentifiers = await simctl.resolveRuntimeIdentifiersForBounds(
    criteria.minOsVersion,
    criteria.maxOsVersion,
    signal,
  );
  const requestedName = criteria.name?.trim().toLowerCase();
  const explicitlyRequested = requestedName
    ? deviceTypes.find((deviceType) => deviceType.name.toLowerCase() === requestedName)
    : undefined;
  const runtimeVersions: string[] = [];
  let runtimeCompatibleDeviceTypeCount = 0;
  for (const runtime of runtimeIdentifiers) {
    const runtimeVersion = iosVersionStringFromRuntimeId(runtime);
    if (!runtimeVersion) {
      throw new ActionableError(
        `Cannot determine the iOS version from resolved runtime '${runtime}'.`,
      );
    }
    runtimeVersions.push(runtimeVersion);
    const compatible = deviceTypes.filter((deviceType) =>
      deviceTypeSupportsRuntime(deviceType, runtimeVersion),
    );
    runtimeCompatibleDeviceTypeCount += compatible.length;
    if (explicitlyRequested) {
      if (compatible.includes(explicitlyRequested)) {
        return { deviceType: explicitlyRequested, runtime };
      }
      continue;
    }
    if (compatible.some((deviceType) => deviceTypeMatchesIosFormFactor(deviceType, formFactor))) {
      return { deviceType: pickIosDeviceType(compatible, { ...criteria, formFactor }), runtime };
    }
  }
  if (explicitlyRequested) {
    throw new ActionableError(
      `Requested iOS device type '${explicitlyRequested.name}' does not support runtime ` +
        `${runtimeVersions.join(", ")}. Choose a compatible device type or adjust the requested OS range.`,
    );
  }
  throw noCompatibleIosDeviceTypeError(
    deviceTypes,
    runtimeVersions,
    formFactor,
    runtimeCompatibleDeviceTypeCount > 0,
  );
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

/**
 * Tags of handheld (phone/tablet) system images, the only ones a default Android
 * provision may create an AVD from. The SDK also ships Wear OS (`android-wear*`),
 * TV (`android-tv`, `google-tv*`), Automotive (`android-automotive*`), desktop, XR and
 * glasses images; an AVD created from one of those boots a different product, so a newer
 * non-handheld image must never beat an older phone image (#14900). Tablet, 16 KB-page
 * (`_ps16k`) and ATD (automated test device) variants are handheld and rank behind the
 * preferred tags via {@link tagRank}.
 */
const HANDHELD_ANDROID_TAGS: ReadonlySet<string> = new Set([
  ...ANDROID_TAG_PREFERENCE,
  "google_apis_ps16k",
  "google_apis_playstore_ps16k",
  "google_apis_tablet",
  "google_apis_playstore_tablet",
  "google_atd",
  "aosp_atd",
]);

/**
 * Automotive image tags, best first. The Play variant comes first: it is the tag of the default
 * car profile (`automotive_1024p_landscape`) in `avdmanager list device`. The set is exactly the
 * tags inventory classifies as automotive, so a created car AVD is found again by a repeated
 * request (#15879).
 */
const AUTOMOTIVE_ANDROID_TAG_PREFERENCE = ["android-automotive-playstore", "android-automotive"];

/** API level named in the install hint when the request does not pin one (the AAOS baseline). */
const AUTOMOTIVE_INSTALL_HINT_API_LEVEL = 34;

/** Which images a request may create an AVD from, and how to rank them. */
interface AndroidImageFamily {
  kind: "handheld" | "automotive";
  tags: ReadonlySet<string>;
  preference: readonly string[];
}

interface ResolvedApiRange {
  min: number;
  max: number | undefined;
  minDescription: string;
  maxDescription: string;
}

const HANDHELD_IMAGE_FAMILY: AndroidImageFamily = {
  kind: "handheld",
  tags: HANDHELD_ANDROID_TAGS,
  preference: ANDROID_TAG_PREFERENCE,
};

const AUTOMOTIVE_IMAGE_FAMILY: AndroidImageFamily = {
  kind: "automotive",
  tags: new Set(androidSystemImageTagsFor("automotive")),
  preference: AUTOMOTIVE_ANDROID_TAG_PREFERENCE,
};

function throwNoHandheldImage(range: ResolvedApiRange, images: SystemImage[]): never {
  const inRange = images.filter((image) => isInApiRange(image, range));
  if (inRange.length === 0) {
    throw new ActionableError(
      "No installed Android system image matches the requested API range " +
        `(min=${range.minDescription}, max=${range.maxDescription}). ` +
        `Installed images: ${images.map((image) => image.packageName).join(", ") || "none"}. ` +
        "Install one with 'sdkmanager \"system-images;android-<api>;google_apis;<abi>\"'.",
    );
  }
  throw new ActionableError(
    "No installed handheld (phone) Android system image matches the requested API range " +
      `(min=${range.minDescription}, max=${range.maxDescription}). ` +
      "Only non-handheld images (Wear OS, TV, Automotive or similar) are installed in that range: " +
      `${inRange.map((image) => image.packageName).join(", ")}. ` +
      "Default provisioning never creates an AVD from them. " +
      "Install a phone image with 'sdkmanager \"system-images;android-<api>;google_apis;<abi>\"'.",
  );
}

function throwNoAutomotiveImage(
  range: ResolvedApiRange,
  images: SystemImage[],
  architecture: string,
): never {
  const hintApi = Math.min(
    Math.max(range.min, AUTOMOTIVE_INSTALL_HINT_API_LEVEL),
    range.max ?? Number.POSITIVE_INFINITY,
  );
  const hintPackage = `system-images;android-${hintApi};android-automotive;${preferredAbis(architecture)[0]}`;
  throw new ActionableError(
    "No installed Android Automotive system image matches the requested API range " +
      `(min=${range.minDescription}, max=${range.maxDescription}). ` +
      "An automotive AVD is created only from an android-automotive or " +
      "android-automotive-playstore image. " +
      `Installed images: ${images.map((image) => image.packageName).join(", ") || "none"}. ` +
      "Install one with 'sdkmanager \"" +
      hintPackage +
      "\"', then retry.",
  );
}

/**
 * The image family a form factor creates from. Phone, tablet, foldable and an omitted form
 * factor stay handheld-only (#14900): a car image is picked only when a car is asked for.
 */
function androidImageFamily(formFactor: FormFactor | undefined): AndroidImageFamily {
  assertCreatableAndroidFormFactor(formFactor);
  return formFactor === "automotive" ? AUTOMOTIVE_IMAGE_FAMILY : HANDHELD_IMAGE_FAMILY;
}

/** TV and watch images exist, but creating those AVDs is separate work. */
function assertCreatableAndroidFormFactor(formFactor: FormFactor | undefined): void {
  if (formFactor === "tv" || formFactor === "watch") {
    throw new ActionableError(
      `Creating a '${formFactor}' AVD is not supported yet; AutoMobile only creates ` +
        "phone, tablet, foldable and automotive AVDs. Create the AVD with avdmanager and the " +
        "matching system image, or use provisionDevice with an explicit runtime and deviceType.",
    );
  }
}

function tagRank(tag: string, preference: readonly string[]): number {
  const index = preference.indexOf(tag);
  return index === -1 ? preference.length : index;
}

function isInApiRange(image: SystemImage, range: Pick<ResolvedApiRange, "min" | "max">): boolean {
  return image.apiLevel >= range.min && (range.max === undefined || image.apiLevel <= range.max);
}

/** ABIs that can run on the host, best first. */
export function preferredAbis(architecture: string): string[] {
  return architecture === "arm64" ? ["arm64-v8a", "x86_64"] : ["x86_64", "x86"];
}

function abiRank(abi: string, preferences: string[]): number {
  const index = preferences.indexOf(abi);
  return index === -1 ? preferences.length : index;
}

/**
 * A bound shaped exactly like a release version `versionToApiLevelRange`
 * knows how to parse: an integer major, optional dotted point-release
 * components, and an optional single trailing release letter (`"17"`,
 * `"4.4"`, `"12L"`). A bound with this shape that still fails to resolve
 * names a release the table has no entry for and must be rejected outright
 * -- #6132's "no silent widening" guarantee. A bound that does NOT have this
 * shape carries some other qualifier syntax the table was never meant to
 * parse (a QPR suffix, say); see {@link leadingMajorFallback}.
 */
const CLEAN_RELEASE_VERSION_SHAPE = /^\d+(?:\.\d+)*[A-Za-z]?$/;

/**
 * Last-resort fallback for a bound the structured release-version parser
 * cannot fully recognize (e.g. `"14-QPR2"`): extract its leading integer and
 * use it directly as an API level, exactly like the `parseInt`-based
 * resolver this replaced. That old resolver was unconditionally lenient, so
 * any bound with a leading digit "worked" (if loosely) before this file
 * started resolving release versions through the table; this fallback keeps
 * that leniency for inputs the table's grammar doesn't cover, so provisioning
 * never regresses a bound that used to work (review follow-up on #6132).
 * Precise ordering of QPR/lettered qualifiers stays out of scope -- #6182.
 */
function leadingMajorFallback(trimmed: string): number | undefined {
  const match = /^(\d+)/.exec(trimmed);
  return match ? Number(match[1]) : undefined;
}

/**
 * Resolve one `minOsVersion` / `maxOsVersion` bound to an API level. The
 * matcher compares these bounds against the AVD's release version and the
 * provisioner compares them against `SystemImage.apiLevel`, and both receive
 * the same criteria, so the documented release-version form ("14") must mean
 * Android 14 (API 34) here too, not API 14 (#6132).
 */
function resolveApiLevelBound(bound: string | undefined, edge: "min" | "max"): number | undefined {
  if (!bound) {
    return undefined;
  }
  const trimmed = bound.trim();
  const apiLevelBound = parseAndroidApiLevelBound(trimmed);
  if (apiLevelBound !== undefined) {
    logger.debug(`[DeviceProvisioner] Treating ${edge}OsVersion '${trimmed}' as an API level`);
    return apiLevelBound;
  }
  const range = versionToApiLevelRange(trimmed);
  if (range) {
    return edge === "min" ? range.min : range.max;
  }
  if (!CLEAN_RELEASE_VERSION_SHAPE.test(trimmed)) {
    const fallback = leadingMajorFallback(trimmed);
    if (fallback !== undefined) {
      logger.debug(
        `[DeviceProvisioner] ${edge}OsVersion '${trimmed}' carries a qualifier the release table ` +
          `doesn't parse; falling back to its leading major ${fallback} as an API level (pre-#6132 ` +
          "lenient behavior; full qualifier ordering is tracked in #6182).",
      );
      return fallback;
    }
  }
  throw new ActionableError(
    `Unrecognized Android ${edge}OsVersion '${bound}'. ` +
      "Pass a release version such as '14' (Android 14) or an API level such as 34.",
  );
}

function describeBound(bound: string | undefined, apiLevel: number | undefined): string {
  if (bound === undefined || apiLevel === undefined) {
    return "any";
  }
  return bound.trim() === String(apiLevel) ? bound : `${bound} (API ${apiLevel})`;
}

/**
 * Resolve the requested bounds to API levels, raised to the CtrlProxy runner floor, with the
 * descriptions error messages use.
 */
function resolveApiRange(
  criteria: Pick<DeviceMatchCriteria, "minOsVersion" | "maxOsVersion">,
): ResolvedApiRange {
  const requestedMin = resolveApiLevelBound(criteria.minOsVersion, "min");
  const max = resolveApiLevelBound(criteria.maxOsVersion, "max");

  // Fail fast when the requested upper bound cannot host the runner APK
  // (minSdk 24): an older AVD would boot but never install the runner during
  // startDevice readiness prep, so it could never become automation-ready.
  // Rejecting here beats creating an unusable AVD that only fails later (#6187).
  if (max !== undefined && max < CTRL_PROXY_APK_MIN_SDK) {
    throw new ActionableError(
      `Requested Android maxOsVersion ${describeBound(criteria.maxOsVersion, max)} is below API ` +
        `${CTRL_PROXY_APK_MIN_SDK}, the minimum SDK the AutoMobile CtrlProxy runner APK supports. ` +
        "A lower AVD would boot but never install the runner and become automation-ready. " +
        "Request Android 7.0 (API 24) or newer.",
    );
  }

  // The runner-APK floor also raises the effective minimum, so a sub-24 image is
  // never selected even when no (or a lower) minOsVersion was requested (#6187).
  const min = Math.max(requestedMin ?? CTRL_PROXY_APK_MIN_SDK, CTRL_PROXY_APK_MIN_SDK);
  // When the runner-APK floor (not an explicit minOsVersion) sets the minimum,
  // describe the floor honestly rather than echoing a lower or absent requested bound.
  const minDescription =
    requestedMin !== undefined && requestedMin >= CTRL_PROXY_APK_MIN_SDK
      ? describeBound(criteria.minOsVersion, min)
      : `API ${CTRL_PROXY_APK_MIN_SDK} (CtrlProxy runner minSdk)`;
  return {
    min,
    max,
    minDescription,
    maxDescription: describeBound(criteria.maxOsVersion, max),
  };
}

/**
 * Choose an installed system image: newest exact API identifier within the
 * requested major-API range, preferring a host-runnable ABI and the family's preferred tag.
 * Only handheld (phone/tablet) images are candidates unless `formFactor` is `automotive`, which
 * takes only automotive images; Wear OS, TV and Automotive images never satisfy a handheld
 * request (#14900, #15879).
 */
export function pickAndroidSystemImage(
  images: SystemImage[],
  criteria: Pick<DeviceMatchCriteria, "minOsVersion" | "maxOsVersion" | "formFactor">,
  architecture: string,
): SystemImage {
  const family = androidImageFamily(criteria.formFactor);
  const range = resolveApiRange(criteria);
  const matching = images.filter(
    (image) => isInApiRange(image, range) && family.tags.has(image.tag),
  );
  if (matching.length === 0) {
    if (family.kind === "automotive") {
      throwNoAutomotiveImage(range, images, architecture);
    }
    throwNoHandheldImage(range, images);
  }

  const preferences = preferredAbis(architecture);
  const runnable = matching.filter((image) => preferences.includes(image.abi));
  const candidates = runnable.length > 0 ? runnable : matching;

  // Precedence is major API > ABI > tag > minor > packageName; keep capability
  // and rootability preferences ahead of point-release freshness.
  return [...candidates].sort((a, b) => {
    const apiDelta = b.apiLevel - a.apiLevel;
    if (apiDelta !== 0) {
      return apiDelta;
    }
    const abiDelta = abiRank(a.abi, preferences) - abiRank(b.abi, preferences);
    if (abiDelta !== 0) {
      return abiDelta;
    }
    const tagDelta = tagRank(a.tag, family.preference) - tagRank(b.tag, family.preference);
    if (tagDelta !== 0) {
      return tagDelta;
    }
    const minorDelta = compareStrictNumericVersions(b.apiIdentifier, a.apiIdentifier);
    if (minorDelta !== 0) {
      return minorDelta;
    }
    return a.packageName.localeCompare(b.packageName);
  })[0];
}

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

export interface DefaultDeviceProvisionerDependencies {
  simulatorCreation?: SimulatorCreator;
  prebootProfile?: Pick<SimulatorPrebootProfile, "apply">;
  iosCreator: () => IosSimulatorCreator | undefined;
  androidCreator: () => AndroidAvdCreator;
  idGenerator?: IdGenerator;
  architecture?: string;
  /** Internal caller-owned device naming policy; the default remains unique user provisioning. */
  createdDeviceName?: (baseName: string) => string;
  /** Optional lifecycle bridge for callers that must reserve a generated name before creation. */
  identityHooks?: DeviceProvisioningIdentityHooks;
}

/**
 * A requested name that is not itself a device type names the simulator (as it does for an
 * Android AVD); an exact device-type name selects the model and stays the base (#11148).
 */
function createdIosBaseName(requested: string | undefined, deviceTypeName: string): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed.toLowerCase() !== deviceTypeName.toLowerCase()
    ? trimmed
    : deviceTypeName;
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

    const { deviceType, runtime } = await resolveIosProvisioningSelection(simctl, criteria, signal);
    const baseName = createdIosBaseName(criteria.name, deviceType.name);
    const name =
      this.dependencies.createdDeviceName?.(baseName) ??
      buildCreatedDeviceName(baseName, this.idGenerator);
    const identitySignal = await identityHooks?.reserveBeforeCreate({
      platform: "ios",
      name,
      deviceType: deviceType.identifier,
      runtimeId: runtime,
      runtime,
    });
    const creationSignal =
      signal && identitySignal
        ? AbortSignal.any([signal, identitySignal])
        : (signal ?? identitySignal);

    let deviceId: string;
    try {
      deviceId = this.dependencies.simulatorCreation
        ? (
            await this.dependencies.simulatorCreation.create({
              name,
              deviceType: deviceType.identifier,
              runtime,
              signal: creationSignal,
            })
          ).udid
        : await simctl.createSimulator(name, deviceType.identifier, runtime, creationSignal);
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
      runtimeId: runtime,
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
    return this.applyPrebootProfile(deviceId, provisioned, creationSignal);
  }

  private async applyPrebootProfile(
    deviceId: string,
    provisioned: ProvisionedDevice,
    signal?: AbortSignal,
  ): Promise<ProvisionedDevice> {
    const preboot = await this.dependencies.prebootProfile?.apply(deviceId, {}, signal);
    return {
      ...provisioned,
      ...(preboot?.applied && preboot.resources.length
        ? { prebootDisabledResources: preboot.resources }
        : {}),
    };
  }

  private async provisionAndroid(
    criteria: DeviceMatchCriteria,
    signal?: AbortSignal,
    identityHooks?: DeviceProvisioningIdentityHooks,
  ): Promise<ProvisionedDevice> {
    // Refuse before listing images: a TV/watch request must never be satisfied by a phone.
    assertCreatableAndroidFormFactor(criteria.formFactor);
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
    const automotive = criteria.formFactor === "automotive";
    const name = buildCreatedDeviceName(
      criteria.name ?? `android-${automotive ? "automotive-" : ""}${image.apiLevel}`,
      this.idGenerator,
    );
    const identitySignal = await identityHooks?.reserveBeforeCreate({
      platform: "android",
      name,
      deviceType: image.packageName,
      runtimeId: image.packageName,
      runtime: `android-${image.apiIdentifier}`,
    });
    const creationSignal =
      signal && identitySignal
        ? AbortSignal.any([signal, identitySignal])
        : (signal ?? identitySignal);

    // A car image needs a car profile; handheld creation keeps avdmanager's default profile.
    const result = await avdManager.createAvd(
      {
        name,
        package: image.packageName,
        ...(automotive
          ? { device: BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY.automotive }
          : {}),
      },
      creationSignal,
    );
    if (!result.success) {
      // avdmanager exited cleanly without creating the AVD: nothing to roll back.
      throw new ProvisionDeviceCreateRejectedError(
        `Failed to create Android AVD '${name}' from ${image.packageName}: ${result.message}`,
      );
    }

    const provisioned = {
      platform: "android" as const,
      name,
      deviceType: image.packageName,
      runtimeId: image.packageName,
      runtime: `android-${image.apiIdentifier}`,
    };
    logger.info(
      `[DeviceProvisioner] Created Android AVD '${name}' ` +
        `(systemImage=${image.packageName}, api=${image.apiIdentifier}, tag=${image.tag}, abi=${image.abi}). ` +
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
  simulatorCreation?: SimulatorCreator,
): DeviceProvisioner {
  return new DefaultDeviceProvisioner({
    iosCreator,
    simulatorCreation,
    prebootProfile: new SimulatorPrebootProfile(),
    androidCreator: createDefaultAndroidAvdCreator,
    identityHooks,
  });
}
