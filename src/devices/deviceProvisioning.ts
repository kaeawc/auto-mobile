import type { DeviceInfo } from "../models";
import { enrichDeviceInfoList } from "../utils/android-cmdline-tools/avdDeviceInfoEnrichment";
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
import {
  FileAvdConfigReader,
  type AvdConfigReader,
  versionToApiLevelRange,
} from "../utils/android-cmdline-tools/AvdConfigReader";
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
import { androidSystemImageTagsFor, defaultAndroidProfileIdFor } from "../models/formFactor";

/** What was created, for logging and for handing straight to the boot path. */
export interface ProvisionedDevice {
  prebootDisabledResources?: readonly ConfigurableDeviceResource[];
  platform: "android" | "ios";
  /** Device name (iOS simulator name / AVD name). */
  name: string;
  /** Simulator UDID; Android AVDs are addressed by name, so this is undefined there. */
  deviceId?: string;
  /** iOS device type identifier or Android AVD profile, when known. */
  deviceType?: string;
  /** Configured pre-boot facts carried into the acquisition image. */
  configuredImage?: DeviceInfo;
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

function tagRank(tag: string): number {
  const index = ANDROID_TAG_PREFERENCE.indexOf(tag);
  return index === -1 ? ANDROID_TAG_PREFERENCE.length : index;
}

/** Which installed images a requested form factor may create an AVD from. */
export interface AndroidImageFamily {
  kind: "handheld" | "tv" | "automotive";
  accepts(tag: string): boolean;
  /** Lower is better; only compared between images of equal API level and ABI. */
  rank(tag: string): number;
  /** avdmanager `-d` profile; undefined keeps avdmanager's default hardware. */
  deviceProfile?: string;
  /** Base of a generated AVD name, before the API level. */
  namePrefix: string;
}

const HANDHELD_IMAGE_FAMILY: AndroidImageFamily = {
  kind: "handheld",
  accepts: (tag) => HANDHELD_ANDROID_TAGS.has(tag),
  rank: tagRank,
  namePrefix: "android",
};

/**
 * TV images, best first: `android-tv`, then `google-tv`, then the 16 KB-page `google-tv-ps16k`.
 * `android-tv` leads for the same reason `google_apis` beats `google_apis_playstore` above:
 * Google TV images ship the Play Store, whose builds usually refuse `adb root`. The order is a
 * provisional choice until the TV baseline (#15899) confirms root on each image.
 */
const TV_ANDROID_TAGS = androidSystemImageTagsFor("tv");

const TV_IMAGE_FAMILY: AndroidImageFamily = {
  kind: "tv",
  accepts: (tag) => TV_ANDROID_TAGS.includes(tag),
  rank: (tag) => TV_ANDROID_TAGS.indexOf(tag),
  deviceProfile: defaultAndroidProfileIdFor("tv"),
  namePrefix: "android-tv",
};

/**
 * Car images, best first: the Play variant, whose tag the default `automotive_1024p_landscape`
 * profile carries in `avdmanager list device`, then plain `android-automotive` (#15879). These are
 * exactly the tags inventory classifies as automotive, so a created car AVD is found again by a
 * repeated request.
 */
const AUTOMOTIVE_ANDROID_TAGS = androidSystemImageTagsFor("automotive");

const AUTOMOTIVE_IMAGE_FAMILY: AndroidImageFamily = {
  kind: "automotive",
  accepts: (tag) => AUTOMOTIVE_ANDROID_TAGS.includes(tag),
  rank: (tag) => AUTOMOTIVE_ANDROID_TAGS.indexOf(tag),
  deviceProfile: defaultAndroidProfileIdFor("automotive"),
  namePrefix: "android-automotive",
};

/**
 * The image family a request may be created from. Phone, tablet, foldable and an omitted form
 * factor stay handheld-only (#14900); `tv` and `automotive` select only their own images. Watch is
 * refused: picking a handheld image would silently satisfy it with a phone.
 */
export function androidImageFamilyFor(formFactor: FormFactor | undefined): AndroidImageFamily {
  if (formFactor === "tv") {
    return TV_IMAGE_FAMILY;
  }
  if (formFactor === "automotive") {
    return AUTOMOTIVE_IMAGE_FAMILY;
  }
  if (formFactor === "watch") {
    throw new ActionableError(
      `Creating a '${formFactor}' AVD is not supported yet; AutoMobile only creates ` +
        "phone, tablet, foldable, TV and automotive AVDs. Create the AVD with avdmanager and the " +
        "matching system image, or use provisionDevice with an explicit runtime and deviceType.",
    );
  }
  return HANDHELD_IMAGE_FAMILY;
}

/**
 * API level suggested in the missing-TV-image hint when the request names no bound. The SDK
 * catalog publishes `android-tv` for every host ABI (arm64-v8a, x86_64, x86) at API 36; API 34
 * has no x86_64 TV image.
 */
const SUGGESTED_TV_API_LEVEL = 36;

/** API level suggested in the missing-car-image hint when the request names no bound (AAOS baseline). */
const SUGGESTED_AUTOMOTIVE_API_LEVEL = 34;

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

/** The resolved API range of one selection, for its errors. */
interface ApiBounds {
  criteria: Pick<DeviceMatchCriteria, "minOsVersion" | "maxOsVersion">;
  requestedMin: number | undefined;
  min: number;
  max: number | undefined;
}

function describeRange(bounds: ApiBounds): string {
  const { criteria, requestedMin, min, max } = bounds;
  // When the runner-APK floor (not an explicit minOsVersion) is what set the minimum,
  // describe the floor honestly rather than echoing a lower or absent requested bound.
  const minDescription =
    requestedMin !== undefined && requestedMin >= CTRL_PROXY_APK_MIN_SDK
      ? describeBound(criteria.minOsVersion, min)
      : `API ${CTRL_PROXY_APK_MIN_SDK} (CtrlProxy runner minSdk)`;
  return `(min=${minDescription}, max=${describeBound(criteria.maxOsVersion, max)})`;
}

function describeInstalled(images: SystemImage[]): string {
  return images.map((image) => image.packageName).join(", ") || "none";
}

function handheldImagesOrThrow(
  images: SystemImage[],
  inRange: SystemImage[],
  bounds: ApiBounds,
): SystemImage[] {
  if (inRange.length === 0) {
    throw new ActionableError(
      `No installed Android system image matches the requested API range ${describeRange(bounds)}. ` +
        `Installed images: ${describeInstalled(images)}. ` +
        "Install one with 'sdkmanager \"system-images;android-<api>;google_apis;<abi>\"'.",
    );
  }
  const handheld = inRange.filter((image) => HANDHELD_IMAGE_FAMILY.accepts(image.tag));
  if (handheld.length === 0) {
    const { criteria, min, max } = bounds;
    throw new ActionableError(
      "No installed handheld (phone) Android system image matches the requested API range " +
        `(min=${describeBound(criteria.minOsVersion, min)}, max=${describeBound(criteria.maxOsVersion, max)}). ` +
        "Only non-handheld images (Wear OS, TV, Automotive or similar) are installed in that range: " +
        `${describeInstalled(inRange)}. ` +
        "Default provisioning never creates an AVD from them. " +
        "Install a phone image with 'sdkmanager \"system-images;android-<api>;google_apis;<abi>\"'.",
    );
  }
  return handheld;
}

/** TV images in range, or an error naming the exact sdkmanager command that installs one. */
function tvImagesOrThrow(
  images: SystemImage[],
  inRange: SystemImage[],
  bounds: ApiBounds,
  architecture: string,
): SystemImage[] {
  const tv = inRange.filter((image) => TV_IMAGE_FAMILY.accepts(image.tag));
  if (tv.length > 0) {
    return tv;
  }
  const api = bounds.max ?? Math.max(bounds.min, SUGGESTED_TV_API_LEVEL);
  const abis = preferredAbis(architecture);
  throw new ActionableError(
    `No installed Android TV system image (${TV_ANDROID_TAGS.join(", ")}) matches the requested ` +
      `API range ${describeRange(bounds)}. Installed images: ${describeInstalled(images)}. ` +
      "AutoMobile does not download system images. Install one with " +
      `'sdkmanager "system-images;android-${api};android-tv;${abis[0]}"' (or google-tv in place of ` +
      `android-tv), then retry. This host runs ${abis.join(" or ")} images; 'sdkmanager --list' ` +
      "shows the ABIs published for each API level.",
  );
}

/** Car images in range, or an error naming the exact sdkmanager command that installs one. */
function automotiveImagesOrThrow(
  images: SystemImage[],
  inRange: SystemImage[],
  bounds: ApiBounds,
  architecture: string,
): SystemImage[] {
  const car = inRange.filter((image) => AUTOMOTIVE_IMAGE_FAMILY.accepts(image.tag));
  if (car.length > 0) {
    return car;
  }
  const api = Math.min(
    Math.max(bounds.min, SUGGESTED_AUTOMOTIVE_API_LEVEL),
    bounds.max ?? Number.POSITIVE_INFINITY,
  );
  const abis = preferredAbis(architecture);
  throw new ActionableError(
    `No installed Android Automotive system image (${AUTOMOTIVE_ANDROID_TAGS.join(", ")}) matches ` +
      `the requested API range ${describeRange(bounds)}. Installed images: ${describeInstalled(images)}. ` +
      "AutoMobile does not download system images. Install one with " +
      `'sdkmanager "system-images;android-${api};android-automotive;${abis[0]}"', then retry. ` +
      `This host runs ${abis.join(" or ")} images; 'sdkmanager --list' shows the ABIs published ` +
      "for each API level.",
  );
}

/**
 * Choose an installed system image: newest exact API identifier within the
 * requested major-API range, preferring a host-runnable ABI and the family's best tag.
 * The form factor picks the family ({@link androidImageFamilyFor}): handheld requests never
 * select Wear OS, TV or Automotive images (#14900), and a TV or automotive request selects only
 * its own images.
 */
export function pickAndroidSystemImage(
  images: SystemImage[],
  criteria: Pick<DeviceMatchCriteria, "minOsVersion" | "maxOsVersion" | "formFactor">,
  architecture: string,
): SystemImage {
  const family = androidImageFamilyFor(criteria.formFactor);
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

  const inRange = images.filter((image) => {
    if (image.apiLevel < min) {
      return false;
    }
    if (max !== undefined && image.apiLevel > max) {
      return false;
    }
    return true;
  });

  const bounds: ApiBounds = { criteria, requestedMin, min, max };
  const familyImages =
    family.kind === "tv"
      ? tvImagesOrThrow(images, inRange, bounds, architecture)
      : family.kind === "automotive"
        ? automotiveImagesOrThrow(images, inRange, bounds, architecture)
        : handheldImagesOrThrow(images, inRange, bounds);

  const preferences = preferredAbis(architecture);
  const runnable = familyImages.filter((image) => preferences.includes(image.abi));
  const candidates = runnable.length > 0 ? runnable : familyImages;

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
    const tagDelta = family.rank(a.tag) - family.rank(b.tag);
    if (tagDelta !== 0) {
      return tagDelta;
    }
    const minorDelta = compareStrictNumericVersions(b.apiIdentifier, a.apiIdentifier);
    if (minorDelta !== 0) {
      return minorDelta;
    }
    // A higher SDK extension (android-34-ext9) is newer than the base level (android-34).
    const extensionDelta = (b.extensionLevel ?? 0) - (a.extensionLevel ?? 0);
    if (extensionDelta !== 0) {
      return extensionDelta;
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
  androidConfigReader?: AvdConfigReader;
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
    // Refuses watch before listing images.
    const family = androidImageFamilyFor(criteria.formFactor);
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
      criteria.name ?? `${family.namePrefix}-${image.apiLevel}`,
      this.idGenerator,
    );
    const identitySignal = await identityHooks?.reserveBeforeCreate({
      platform: "android",
      name,
      deviceType: family.deviceProfile,
      runtimeId: image.packageName,
      runtime: `android-${image.apiIdentifier}`,
    });
    const creationSignal =
      signal && identitySignal
        ? AbortSignal.any([signal, identitySignal])
        : (signal ?? identitySignal);

    const result = await avdManager.createAvd(
      {
        name,
        package: image.packageName,
        ...(family.deviceProfile ? { device: family.deviceProfile } : {}),
      },
      creationSignal,
    );
    if (!result.success) {
      // avdmanager exited cleanly without creating the AVD: nothing to roll back.
      throw new ProvisionDeviceCreateRejectedError(
        `Failed to create Android AVD '${name}' from ${image.packageName}: ${result.message}`,
      );
    }

    const provisioned = await this.androidCreatedDevice(name, image, family.deviceProfile);
    logger.info(
      `[DeviceProvisioner] Created Android AVD '${name}' ` +
        `(systemImage=${image.packageName}, api=${image.apiIdentifier}, tag=${image.tag}, abi=${image.abi}` +
        `${family.deviceProfile ? `, device=${family.deviceProfile}` : ""}). ` +
        `Delete it with 'avdmanager delete avd -n ${name}' when no longer needed.`,
    );
    await identityHooks?.bindAfterCreate(provisioned);
    return provisioned;
  }

  private async androidCreatedDevice(
    name: string,
    image: SystemImage,
    deviceProfile: string | undefined,
  ): Promise<ProvisionedDevice> {
    const baseImage: DeviceInfo = {
      platform: "android",
      name,
      isRunning: false,
      deviceType: deviceProfile,
      runtimeId: image.packageName,
    };
    const configuredImage = this.dependencies.androidConfigReader
      ? (await enrichDeviceInfoList(this.dependencies.androidConfigReader, [baseImage]))[0]
      : undefined;
    return {
      ...(configuredImage ? { configuredImage } : {}),
      platform: "android" as const,
      name,
      deviceType: configuredImage?.deviceType ?? deviceProfile,
      runtimeId: image.packageName,
      runtime: `android-${image.apiIdentifier}`,
    };
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
    androidConfigReader: new FileAvdConfigReader(),
    identityHooks,
  });
}
