import type { BindingSpecFingerprint } from "./reconciler";
import { createHash } from "node:crypto";
import {
  evaluateIosPairCompatibility,
  resolveDisplayCutoutPreference,
} from "../../../devices/deviceSpecMatching";
import {
  type ExactDeviceSpecification,
  type ExactIosRuntimeCatalog,
  type ResolvedExactDeviceSpecification,
} from "../../../devices/exactDeviceProvisioning";
import { androidProfileFormFactor } from "../../../models/formFactor";
import type { BindingDeviceFamily } from "./reconciler";
import { inferIosFormFactor } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { evaluateRuntimeCompatibility } from "../../../utils/ios-cmdline-tools/runtimeCompatibility";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { parseAndroidSystemImageRuntime } from "../../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { stableStringify } from "../../../utils/stableStringify";
import { type BindingPlatform } from "../registry/bindingRegistry";
import type {
  BindingRequestedSpec,
  DefaultManagedSpecResolverOptions,
  ManagedAndroidImageCatalog,
  ManagedAndroidProfileCatalog,
  ManagedSpecCreatability,
  ManagedSpecResolution,
  ManagedSpecResolver,
} from "./reconciler";

/**
 * Resolves a spec with the shared exact-provisioning checks. Codes are aligned across platforms:
 * `spec_unsupported` for a malformed spec (an Android runtime that is not a system-image id, an iOS
 * runtime that is not a CoreSimulator id) or one naming what this host has not installed (an
 * Android image, an iOS runtime or device type, with a catalog); `runtime_incompatible` only for an
 * installed iOS model/runtime pair the catalog proves incompatible. Unreadable catalogs are
 * unknown, not unsupported, matching the provisioner.
 *
 * An omitted `deviceType` ("any model") resolves to the model a creation would use: on iOS the
 * newest iPhone the catalog lists as supporting the runtime (so a catalog is required), on Android
 * {@link BINDING_DEFAULT_ANDROID_DEVICE_TYPE} unless overridden. Matching still accepts any
 * model within an optional requested family; only creation uses the resolved one. Android family
 * defaults can be overridden individually. A cutout preference needs an explicit model.
 */
export class DefaultManagedSpecResolver implements ManagedSpecResolver {
  private readonly androidDefaultDeviceType: string;
  private readonly androidDefaultDeviceTypesByFamily: Record<BindingDeviceFamily, string>;
  private readonly androidImageCatalog?: ManagedAndroidImageCatalog;
  private readonly androidProfileCatalog?: ManagedAndroidProfileCatalog;

  constructor(
    private readonly iosRuntimeCatalog?: ExactIosRuntimeCatalog,
    options: DefaultManagedSpecResolverOptions = {},
  ) {
    this.androidDefaultDeviceType =
      options.androidDefaultDeviceType ?? BINDING_DEFAULT_ANDROID_DEVICE_TYPE;
    this.androidDefaultDeviceTypesByFamily = {
      ...BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY,
      phone: this.androidDefaultDeviceType,
      ...options.androidDefaultDeviceTypesByFamily,
    };
    this.androidImageCatalog = options.androidImageCatalog;
    this.androidProfileCatalog = options.androidProfileCatalog;
  }

  async checkCreatable(
    platform: BindingPlatform,
    resolvedSpec: ResolvedExactDeviceSpecification,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecCreatability> {
    if (platform !== "android" || !this.androidProfileCatalog) {
      return { kind: "creatable" };
    }
    let profileIds: string[];
    try {
      profileIds = await this.androidProfileCatalog.listProfileIds(options.signal);
    } catch (error) {
      logger.warn(`[Bindings] Android profile catalog unreadable: ${errorMessage(error)}`, error);
      return {
        kind: "unresolved",
        message: `The Android hardware profile catalog could not be read: ${errorMessage(error)}`,
      };
    }
    if (profileIds.includes(resolvedSpec.deviceType)) {
      return { kind: "creatable" };
    }
    return {
      kind: "unsupported",
      code: "spec_unsupported",
      message: `Android hardware profile '${resolvedSpec.deviceType}' is not available on this host. List valid profile IDs with avdmanager list device.`,
    };
  }

  async resolve(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSpecResolution> {
    const unsupported = await this.findUnsupportedSpec(platform, spec, options.signal);
    if (unsupported) {
      return { kind: "unsupported", code: "spec_unsupported", message: unsupported };
    }
    const model = await this.resolveDeviceType(platform, spec, options.signal);
    if (model.kind !== "resolved") {
      return model.resolution;
    }
    const exact = {
      ...provisionableSpec(spec),
      deviceType: model.deviceType,
    } as ExactDeviceSpecification;
    const cutout = resolveDisplayCutoutPreference(platform, exact);
    if (cutout.kind !== "resolved") {
      return { kind: "unsupported", code: "spec_unsupported", message: cutout.message };
    }
    if (platform === "ios" && this.iosRuntimeCatalog && spec.deviceType !== undefined) {
      const incompatible = await this.findIosIncompatibility(exact, options.signal);
      if (incompatible) {
        return { kind: "unsupported", code: "runtime_incompatible", message: incompatible };
      }
    }
    const resolvedSpec = {
      ...exact,
      displayCutout: cutout.displayCutout,
    } as ResolvedExactDeviceSpecification;
    return {
      kind: "resolved",
      resolvedSpec,
      fingerprint: computeManagedSpecFingerprint(platform, resolvedSpec),
    };
  }

  /**
   * Why the spec is `spec_unsupported` before any model is chosen: malformed (an Android runtime
   * that is not a system-image id, an iOS runtime that is not a CoreSimulator id), or naming what
   * the host has not installed. Undefined when it may proceed.
   */
  private async findUnsupportedSpec(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const familyConflict =
      unsupportedFamilyScreenOverrides(platform, spec) ?? unsupportedModelFamily(platform, spec);
    if (familyConflict !== undefined) {
      return familyConflict;
    }
    if (platform === "android") {
      return parseAndroidSystemImageRuntime(spec.runtime)
        ? await this.findMissingAndroidImage(spec.runtime, signal)
        : `Android runtime '${spec.runtime}' is not a system-image identifier.`;
    }
    return spec.runtime.startsWith(IOS_RUNTIME_IDENTIFIER_PREFIX)
      ? await this.findMissingIosCatalogEntry(spec, signal)
      : `iOS runtime '${spec.runtime}' is not a CoreSimulator runtime identifier (${IOS_RUNTIME_IDENTIFIER_PREFIX}...).`;
  }

  private async resolveDeviceType(
    platform: BindingPlatform,
    spec: BindingRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: "resolved"; deviceType: string }
    | { kind: "refused"; resolution: ManagedSpecResolution }
  > {
    if (spec.deviceType !== undefined) {
      return { kind: "resolved", deviceType: spec.deviceType };
    }
    if (spec.displayCutout !== undefined && spec.displayCutout !== "any") {
      return refused(
        "spec_unsupported",
        `A display cutout preference ('${spec.displayCutout}') needs an explicit deviceType.`,
      );
    }
    if (platform === "android") {
      return {
        kind: "resolved",
        deviceType:
          spec.deviceFamily === undefined
            ? this.androidDefaultDeviceType
            : this.androidDefaultDeviceTypesByFamily[spec.deviceFamily],
      };
    }
    if (!this.iosRuntimeCatalog) {
      return refused(
        "spec_unsupported",
        "An iOS spec without deviceType needs the simulator catalog to choose a model.",
      );
    }
    let runtimes: AppleDeviceRuntime[];
    let deviceTypes: AppleDeviceType[];
    try {
      [runtimes, deviceTypes] = await Promise.all([
        this.iosRuntimeCatalog.getRuntimesChecked(undefined, signal),
        this.iosRuntimeCatalog.getDeviceTypesChecked(signal),
      ]);
    } catch (error) {
      logger.warn(
        `[Bindings] iOS catalog unreadable; cannot choose a model: ${errorMessage(error)}`,
        error,
      );
      return {
        kind: "refused",
        resolution: {
          kind: "unresolved",
          message: `The simulator catalog could not be read to choose a model: ${errorMessage(error)}`,
        },
      };
    }
    const deviceType = chooseIosDeviceType(spec.runtime, runtimes, deviceTypes, spec.deviceFamily);
    return deviceType
      ? { kind: "resolved", deviceType }
      : refused(
          "runtime_incompatible",
          `No installed ${spec.deviceFamily ?? "iPhone"} model supports runtime '${spec.runtime}', or the runtime is not available.`,
        );
  }

  private async findMissingAndroidImage(
    runtime: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (!this.androidImageCatalog) {
      return undefined;
    }
    let installed: string[];
    try {
      installed = await this.androidImageCatalog.listInstalledPackages(signal);
    } catch (error) {
      // An unreadable SDK listing is not proof the image is missing; avdmanager stays the authority.
      logger.warn(`[Bindings] Android image check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
    if (installed.includes(runtime)) {
      return undefined;
    }
    return `Android system image '${runtime}' is not installed. Install it with sdkmanager, or request an installed image (${installed.join(", ") || "none installed"}).`;
  }

  /**
   * The refusal for an iOS runtime or device type the simulator catalog does not list (#11271),
   * checked before anything is created instead of surfacing simctl's raw "Invalid device type" text
   * or reporting a missing runtime as a model/runtime mismatch. Not installed is spec_unsupported,
   * as for Android's uninstalled image (#11269); `runtime_incompatible` stays for an installed
   * runtime that is unavailable or outside the model's range. No catalog, or an unreadable one, is
   * not proof; simctl stays the authority.
   */
  private async findMissingIosCatalogEntry(
    spec: BindingRequestedSpec,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (!this.iosRuntimeCatalog) {
      return undefined;
    }
    let runtimes: AppleDeviceRuntime[];
    let deviceTypes: AppleDeviceType[];
    try {
      [runtimes, deviceTypes] = await Promise.all([
        this.iosRuntimeCatalog.getRuntimesChecked(undefined, signal),
        this.iosRuntimeCatalog.getDeviceTypesChecked(signal),
      ]);
    } catch (error) {
      logger.warn(`[Bindings] iOS catalog check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
    if (!runtimes.some((entry) => entry.identifier === spec.runtime)) {
      const installed = runtimes.map((entry) => entry.identifier);
      return (
        `iOS runtime '${spec.runtime}' is not installed on this host. Install it with Xcode, or ` +
        `request an installed runtime (${installed.join(", ") || "none installed"}).`
      );
    }
    if (
      spec.deviceType === undefined ||
      deviceTypes.some((entry) => entry.identifier === spec.deviceType)
    ) {
      return undefined;
    }
    const iphones = deviceTypes
      .filter((entry) => entry.productFamily === "iPhone")
      .map((entry) => entry.identifier);
    return (
      `iOS device type '${spec.deviceType}' is not installed on this host. Request an installed ` +
      `device type (iPhone types: ${iphones.join(", ") || "none installed"}; all types: ` +
      "xcrun simctl list devicetypes)."
    );
  }

  private async findIosIncompatibility(
    spec: ExactDeviceSpecification,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const catalog = this.iosRuntimeCatalog!;
    let runtimes: Awaited<ReturnType<ExactIosRuntimeCatalog["getRuntimesChecked"]>>;
    let deviceTypes: Awaited<ReturnType<ExactIosRuntimeCatalog["getDeviceTypesChecked"]>>;
    try {
      [runtimes, deviceTypes] = await Promise.all([
        catalog.getRuntimesChecked(undefined, signal),
        catalog.getDeviceTypesChecked(signal),
      ]);
    } catch (error) {
      // An unreadable catalog is not proof of incompatibility; creation keeps simctl as authority.
      logger.warn(`[Bindings] iOS catalog check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
    const incompatibility = evaluateIosPairCompatibility(spec, runtimes, deviceTypes);
    if (!incompatibility) {
      return undefined;
    }
    const alternatives =
      incompatibility.compatibleRuntimes.map((entry) => entry.id).join(", ") || "none installed";
    return incompatibility.unavailable
      ? `Runtime '${spec.runtime}' is not available. Compatible installed runtimes: ${alternatives}.`
      : `Device type '${spec.deviceType}' does not support runtime '${spec.runtime}'. Compatible installed runtimes: ${alternatives}.`;
  }
}

/**
 * The Android hardware profile created for a spec that omits `deviceType` (a current Pixel with a
 * known cutout class). Override per resolver.
 */
export const BINDING_DEFAULT_ANDROID_DEVICE_TYPE = "pixel_8";

export const BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY = {
  phone: BINDING_DEFAULT_ANDROID_DEVICE_TYPE,
  tablet: "pixel_tablet",
  foldable: "pixel_fold",
} as const satisfies Record<BindingDeviceFamily, string>;

export const IOS_RUNTIME_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/**
 * The model "any model" creates for an iOS runtime: a supported iPhone (excluding iPods),
 * else one with unknown runtime compatibility (simctl stays the authority). An explicit family
 * selects that family's types instead. Within each tier, parseable iPhone/iPad model identifiers
 * outrank unparseable ones: highest major generation, then lowest minor variant, then shortest
 * name, then ascending identifier wins. Unparseable entries retain last-in-catalog selection.
 * Undefined when the runtime is missing or unavailable, or no selected-family type fits.
 */
export function chooseIosDeviceType(
  runtimeId: string,
  runtimes: readonly AppleDeviceRuntime[],
  deviceTypes: readonly AppleDeviceType[],
  family?: BindingDeviceFamily,
): string | undefined {
  const runtime = runtimes.find((entry) => entry.identifier === runtimeId);
  if (!runtime?.isAvailable) {
    return undefined;
  }
  const candidates = deviceTypes.filter((entry) =>
    family === undefined
      ? entry.productFamily === "iPhone" && !entry.modelIdentifier?.startsWith("iPod")
      : inferIosFormFactor(entry.identifier) === family,
  );
  const statusOf = (entry: AppleDeviceType) =>
    evaluateRuntimeCompatibility(entry, runtime.version).status;
  const supported = candidates.filter((entry) => statusOf(entry) === "supported");
  const unknown = candidates.filter((entry) => statusOf(entry) === "unknown");
  return (
    supported.toSorted(compareNewestDeviceType).at(-1) ??
    unknown.toSorted(compareNewestDeviceType).at(-1)
  )?.identifier;
}

export function computeManagedSpecFingerprint(
  platform: BindingPlatform,
  resolvedSpec: ResolvedExactDeviceSpecification,
): BindingSpecFingerprint {
  const hash = createHash("sha256")
    .update(stableStringify({ version: BINDING_SPEC_FINGERPRINT_VERSION, platform, resolvedSpec }))
    .digest("hex");
  return { version: BINDING_SPEC_FINGERPRINT_VERSION, hash };
}

/** Request-only constraints must not enter provisionDevice or configuration fingerprints. */
export function provisionableSpec(spec: BindingRequestedSpec): BindingRequestedSpec {
  const configuration = { ...spec };
  delete configuration.deviceFamily;
  return configuration;
}

export function refused(
  code: "spec_unsupported" | "runtime_incompatible",
  message: string,
): { kind: "refused"; resolution: ManagedSpecResolution } {
  return { kind: "refused", resolution: { kind: "unsupported", code, message } };
}

export function unsupportedFamilyScreenOverrides(
  platform: BindingPlatform,
  spec: BindingRequestedSpec,
): string | undefined {
  if (platform !== "android" || spec.deviceFamily === undefined || !("configuration" in spec)) {
    return undefined;
  }
  const overridden = (["screenWidth", "screenHeight", "screenDensity"] as const).some(
    (field) => spec.configuration?.[field] !== undefined,
  );
  return overridden
    ? "The family is classified from screen geometry, so it cannot be verified before creation when the geometry is overridden. Request deviceFamily without screen overrides, or an explicit deviceType without deviceFamily."
    : undefined;
}

export function unsupportedModelFamily(
  platform: BindingPlatform,
  spec: BindingRequestedSpec,
): string | undefined {
  if (spec.deviceType === undefined || spec.deviceFamily === undefined) {
    return undefined;
  }
  const actual =
    platform === "ios"
      ? inferIosFormFactor(spec.deviceType)
      : androidProfileFormFactor({ profileId: spec.deviceType });
  if (actual === undefined || actual === "unknown") {
    return `The family of deviceType '${spec.deviceType}' cannot be verified before creation for deviceFamily '${spec.deviceFamily}'. Request either deviceType or deviceFamily, not both.`;
  }
  return actual === spec.deviceFamily
    ? undefined
    : `deviceType '${spec.deviceType}' is a ${actual}; it conflicts with deviceFamily '${spec.deviceFamily}'.`;
}

/** Positive means preferred; stable sorting retains catalog order for unparseable models. */
function compareNewestDeviceType(a: AppleDeviceType, b: AppleDeviceType): number {
  const aModel = /^(iPhone|iPad)(\d+),(\d+)$/.exec(a.modelIdentifier ?? "");
  const bModel = /^(iPhone|iPad)(\d+),(\d+)$/.exec(b.modelIdentifier ?? "");
  if (!aModel || !bModel) {
    return Number(Boolean(aModel)) - Number(Boolean(bModel));
  }
  return (
    Number(aModel[2]) - Number(bModel[2]) ||
    Number(bModel[3]) - Number(aModel[3]) ||
    b.name.length - a.name.length ||
    (a.identifier < b.identifier ? 1 : a.identifier > b.identifier ? -1 : 0)
  );
}

export const BINDING_SPEC_FINGERPRINT_VERSION = 1;
