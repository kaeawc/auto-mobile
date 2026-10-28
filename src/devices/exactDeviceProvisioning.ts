import type { SimulatorCreator } from "./SimulatorCreator";
import type {
  ConfigurableDeviceResource,
  DeviceResourceConfiguration,
} from "../models/DeviceResourceConfiguration";
import { SimulatorPrebootProfile } from "../utils/ios-cmdline-tools/SimulatorPrebootProfile";
export {
  DEFAULT_PROVISION_DEVICE_RETRYABILITY,
  ProvisionDeviceError,
  type IosRuntimeIncompatibility,
  type ProvisionDeviceFailureCode,
} from "./ProvisionDeviceError";
export { ProvisionDeviceCreateRejectedError } from "./ProvisionDeviceCreateRejectedError";
export {
  FileAndroidAvdConfigWriter,
  type AndroidAvdConfigWriter,
} from "./FileAndroidAvdConfigWriter";
import { ProvisionDeviceError, type IosRuntimeIncompatibility } from "./ProvisionDeviceError";
import { ProvisionDeviceCreateRejectedError } from "./ProvisionDeviceCreateRejectedError";
import {
  FileAndroidAvdConfigWriter,
  type AndroidAvdConfigWriter,
} from "./FileAndroidAvdConfigWriter";
import { DeviceAssignedToBindingError } from "../models/DeviceAssignedToBindingError";
import type { DeviceInfo } from "../models";
import { ActionableError, requireAndroidOrIosPlatform } from "../models";
import type { DeviceCreationGate } from "./deviceCreationGate";
import type { PlatformDeviceManager } from "./deviceUtils";
import type { AvdConfigReader } from "../utils/android-cmdline-tools/AvdConfigReader";
import { FileAvdConfigReader } from "../utils/android-cmdline-tools/AvdConfigReader";
import {
  evaluateIosPairCompatibility,
  iosDeviceSpecificationMismatch,
  matchesAndroidDeviceSpecification,
  resolveDisplayCutoutPreference,
} from "./deviceSpecMatching";
import { AvdManagerClient } from "../utils/android-cmdline-tools/AvdManagerClient";
import { invalidateAndroidInventoryProvenanceAndCatalog } from "../utils/AndroidInventoryInvalidation";
import type { CreateAvdParams } from "../utils/android-cmdline-tools/avdmanager";
import {
  SimCtlClient,
  type SimCtlCatalog,
  type AppleDeviceRuntime,
  type AppleDeviceType,
} from "../utils/ios-cmdline-tools/SimCtlClient";
import { type DeviceTypeRuntimeBounds } from "../utils/ios-cmdline-tools/runtimeCompatibility";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { throwIfAborted } from "../utils/toolUtils";
import { trackAmbient } from "../utils/PerfContext";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { AndroidAvdConfiguration } from "../models/AndroidAvdConfiguration";
import {
  type DisplayCutoutClassification,
  type DisplayCutoutPreference,
} from "../utils/displayCutout";
import {
  getVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";

export interface AndroidDeviceSpecification {
  runtime: string;
  deviceType: string;
  displayCutout?: DisplayCutoutPreference;
  configuration?: AndroidAvdConfiguration;
}

export interface IosDeviceSpecification {
  runtime: string;
  deviceType: string;
  displayCutout?: DisplayCutoutPreference;
}

export type ExactDeviceSpecification = AndroidDeviceSpecification | IosDeviceSpecification;
export type ResolvedExactDeviceSpecification =
  | (Omit<AndroidDeviceSpecification, "displayCutout"> & {
      displayCutout: DisplayCutoutClassification;
    })
  | (Omit<IosDeviceSpecification, "displayCutout"> & {
      displayCutout: DisplayCutoutClassification;
    });

export interface ExactDeviceProvisionRequest {
  resources?: DeviceResourceConfiguration;
  platform: "android" | "ios";
  name: string;
  deviceId?: string;
  spec: ExactDeviceSpecification;
  /** Note ownership immediately before creating a previously absent device. */
  onBeforeCreate?: () => void;
  /**
   * Read-only check run before creating a previously absent device that is about to be booted:
   * throws (e.g. `BootCapacityExhaustedError`) to refuse before any creation side effect.
   */
  assertCapacityBeforeCreate?: (signal?: AbortSignal) => Promise<void>;
  /** Shared lifecycle lease held by a higher-level operation through boot/readiness. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
  /** Absolute deadline for acquiring lifecycle coordination. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface ExactProvisionedDevice {
  prebootDisabledResources?: readonly ConfigurableDeviceResource[];
  device: DeviceInfo;
  created: boolean;
  resolvedSpec: ResolvedExactDeviceSpecification;
}

export interface ExactAndroidAvdClient {
  createAvd(
    params: CreateAvdParams,
    options?: { signal?: AbortSignal },
  ): Promise<{ success: boolean; message: string; avdName?: string }>;
}

export interface ExactIosSimulatorClient {
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** Read-only simctl catalog used to validate an exact pair before creation. */
export interface ExactIosRuntimeCatalog {
  /** Atomic cached snapshot when the transport supports it; legacy catalogs remain compatible. */
  getCatalogChecked?(signal?: AbortSignal): Promise<SimCtlCatalog>;
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;
  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

export interface ExactDeviceProvisioner {
  provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice>;
}

export interface DefaultExactDeviceProvisionerDependencies {
  simulatorCreation?: SimulatorCreator;
  prebootProfile?: Pick<SimulatorPrebootProfile, "apply">;
  listDeviceImages: PlatformDeviceManager["listDeviceImages"];
  isCreationAllowed: DeviceCreationGate["isCreationAllowed"];
  avdManager: ExactAndroidAvdClient;
  androidConfigReader: AvdConfigReader;
  androidConfigWriter: AndroidAvdConfigWriter;
  iosSimulator: ExactIosSimulatorClient;
  /** When absent, exact iOS pairs are not pre-validated (compatibility unknown). */
  iosRuntimeCatalog?: ExactIosRuntimeCatalog;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  timer?: Pick<Timer, "now">;
  /**
   * Refuses adopting an existing device a broker binding holds (#11174): generic provisioning must
   * never take over a binding's device, idle or not. Throws to refuse; absent means no bindings.
   */
  assertAdoptable?: ExactDeviceAdoptionGuard;
}

export type ExactDeviceAdoptionGuard = (device: {
  platform: "android" | "ios";
  /** AVD name on Android, UDID on iOS. */
  stableId: string;
}) => Promise<void>;

/** The provisionDevice failure for a device a broker binding holds (non-retryable). */
export function bindingProvisionError(
  error: DeviceAssignedToBindingError,
  context: string,
): ProvisionDeviceError {
  return new ProvisionDeviceError(
    "device_assigned_to_binding",
    `${context}: ${error.message}`,
    false,
    {
      deviceId: error.deviceId,
      binding: {
        scopeKey: error.scopeKey,
        declaredBinding: error.declaredBinding,
        stableId: error.stableId,
      },
    },
  );
}

/**
 * Exact virtual-device creation used by trusted controllers. It intentionally
 * never falls back to a "close enough" image, runtime, or device profile.
 */
export class DefaultExactDeviceProvisioner implements ExactDeviceProvisioner {
  private async configureAndroid(
    name: string,
    configuration: AndroidAvdConfiguration,
    signal?: AbortSignal,
  ): Promise<void> {
    const writer = this.dependencies.androidConfigWriter;
    if (writer.setConfiguration) {
      await writer.setConfiguration(name, configuration, { signal });
    } else if (Object.keys(configuration).some((key) => key !== "memoryMb")) {
      throw new ProvisionDeviceError(
        "unsupported",
        "The configured AVD writer does not support emulator hardware controls.",
      );
    } else if (configuration.memoryMb !== undefined) {
      await writer.setMemoryMb(name, configuration.memoryMb, { signal });
    }
  }
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  private readonly timer: Pick<Timer, "now">;

  constructor(private readonly dependencies: DefaultExactDeviceProvisionerDependencies) {
    this.lifecycleCoordinator =
      dependencies.lifecycleCoordinator ?? getVirtualDeviceLifecycleCoordinator();
    this.timer = dependencies.timer ?? defaultTimer;
  }

  async provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice> {
    const displayCutout = this.resolveDisplayCutout(request);
    const ownLease = request.lifecycleLease === undefined;
    const lease =
      request.lifecycleLease ??
      (await this.lifecycleCoordinator.reserve(this.initialLifecycleIdentity(request), {
        operation: "provision",
        deadlineMs: request.deadlineMs ?? this.timer.now() + 300_000,
        signal: request.signal,
      }));
    const signals = [request.signal, lease.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const coordinatedRequest = {
      ...request,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    };
    try {
      throwIfAborted(coordinatedRequest.signal);
      const result = await this.provisionLocked(coordinatedRequest, displayCutout);
      const stableId =
        result.device.platform === "android" ? result.device.name : result.device.deviceId;
      if (!stableId) {
        throw new ProvisionDeviceError(
          "identity_conflict",
          `Exact iOS simulator '${request.name}' has no UDID.`,
        );
      }
      await lease.bindCanonicalIdentity(
        {
          platform: result.device.platform,
          stableId,
        },
        async () => {
          const images = await this.dependencies.listDeviceImages(result.device.platform);
          const current = images.find(
            (image) =>
              image.platform === result.device.platform &&
              (result.device.platform === "android"
                ? image.name === request.name
                : image.deviceId === stableId),
          );
          if (!current) {
            throw new ActionableError(
              `Provisioned device '${stableId}' disappeared during lifecycle wait`,
            );
          }
          return {
            platform: current.platform,
            stableId: current.platform === "android" ? current.name : current.deviceId!,
          };
        },
      );
      return result;
    } finally {
      if (ownLease) {
        lease.release();
      }
    }
  }

  /** Refuse adopting a device a broker binding holds, before reading or touching it (#11174). */
  private async assertAdoptable(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): Promise<void> {
    const stableId = existing.platform === "android" ? existing.name : existing.deviceId;
    if (!this.dependencies.assertAdoptable || !stableId) {
      return;
    }
    try {
      await this.dependencies.assertAdoptable({
        platform: requireAndroidOrIosPlatform(existing.platform, "Adopting an existing device"),
        stableId,
      });
    } catch (error) {
      if (error instanceof DeviceAssignedToBindingError) {
        throw bindingProvisionError(
          error,
          `Cannot adopt existing ${request.platform} device '${request.name}'`,
        );
      }
      throw error;
    }
  }

  private initialLifecycleIdentity(
    request: ExactDeviceProvisionRequest,
  ): VirtualDeviceLifecycleIdentity {
    if (request.platform === "android" || request.deviceId) {
      return {
        kind: "stable",
        platform: request.platform,
        stableId: request.platform === "android" ? request.name : request.deviceId!,
      };
    }
    return { kind: "selector", platform: "ios", selector: request.name };
  }

  private async provisionLocked(
    request: ExactDeviceProvisionRequest,
    displayCutout: DisplayCutoutClassification,
  ): Promise<ExactProvisionedDevice> {
    const images = await trackAmbient("provision:listDeviceImages", () =>
      this.dependencies.listDeviceImages(request.platform),
    );
    const existing = this.findExisting(images, request);
    if (existing) {
      await this.assertAdoptable(request, existing);
      await trackAmbient("provision:matchExisting", () =>
        this.assertExistingMatches(request, existing),
      );
      return {
        device: existing,
        created: false,
        resolvedSpec: this.withResolvedDisplayCutout(request.spec, displayCutout),
      };
    }
    if (request.platform === "ios" && request.deviceId !== undefined) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Exact iOS simulator '${request.name}' with UDID '${request.deviceId}' was not found.`,
      );
    }

    if (!this.dependencies.isCreationAllowed(true)) {
      throw new ProvisionDeviceError(
        "creation_not_allowed",
        `Device creation is disabled; cannot provision exact ${request.platform} device '${request.name}'.`,
      );
    }

    if (request.platform === "ios") {
      await this.assertIosPairCompatible(request, request.spec as IosDeviceSpecification);
    }

    await request.assertCapacityBeforeCreate?.(request.signal);
    request.onBeforeCreate?.();
    if (request.platform === "android") {
      return await trackAmbient("provision:createAndroid", () =>
        this.createAndroid(request, request.spec as AndroidDeviceSpecification, displayCutout),
      );
    }
    return await trackAmbient("provision:createIos", () =>
      this.createIos(request, request.spec as IosDeviceSpecification, displayCutout),
    );
  }

  /**
   * Reject a pair that CoreSimulator evidence proves incompatible before any
   * creation side effect. Missing, malformed, or unreadable evidence is unknown,
   * not unsupported, so creation proceeds and simctl remains the authority.
   */
  private async readIosCompatibilityCatalog(
    catalog: ExactIosRuntimeCatalog,
    signal: AbortSignal | undefined,
  ): Promise<{ runtimes: AppleDeviceRuntime[]; deviceTypes: AppleDeviceType[] } | undefined> {
    try {
      const [runtimes, deviceTypes] = await Promise.all([
        catalog.getRuntimesChecked(undefined, signal),
        catalog.getDeviceTypesChecked(signal),
      ]);
      return { runtimes, deviceTypes };
    } catch (error) {
      throwIfAborted(signal);
      // Incomplete discovery is not proof of incompatibility; let simctl decide.
      logger.warn(`iOS runtime compatibility check skipped: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  private async assertIosPairCompatible(
    request: ExactDeviceProvisionRequest,
    spec: IosDeviceSpecification,
  ): Promise<void> {
    const catalog = this.dependencies.iosRuntimeCatalog;
    if (!catalog) {
      return;
    }
    const discovered = await this.readIosCompatibilityCatalog(catalog, request.signal);
    if (!discovered) {
      return;
    }
    const incompatibility = evaluateIosPairCompatibility(
      spec,
      discovered.runtimes,
      discovered.deviceTypes,
    );
    if (!incompatibility) {
      return;
    }
    const { runtime, bounds, compatibleRuntimes, unavailable } = incompatibility;
    throw runtimeIncompatibleError(request, spec, {
      reason: unavailable
        ? `Runtime '${spec.runtime}' is not available (${runtime.availabilityError ?? "CoreSimulator marked it unavailable"}), so iOS simulator '${request.name}' with device type '${spec.deviceType}' cannot be created.`
        : `Device type '${spec.deviceType}' does not support runtime '${spec.runtime}' (version ${runtime.version}; supported ${describeBounds(bounds)}), so iOS simulator '${request.name}' was not created.`,
      bounds,
      compatibleRuntimes,
    });
  }

  private resolveDisplayCutout(request: ExactDeviceProvisionRequest): DisplayCutoutClassification {
    const resolution = resolveDisplayCutoutPreference(request.platform, request.spec);
    if (resolution.kind !== "resolved") {
      throw new ProvisionDeviceError(resolution.kind, resolution.message);
    }
    return resolution.displayCutout;
  }

  private withResolvedDisplayCutout(
    spec: ExactDeviceSpecification,
    displayCutout: DisplayCutoutClassification,
  ): ResolvedExactDeviceSpecification {
    return { ...spec, displayCutout } as ResolvedExactDeviceSpecification;
  }

  private findExisting(
    images: DeviceInfo[],
    request: ExactDeviceProvisionRequest,
  ): DeviceInfo | undefined {
    if (request.platform !== "ios") {
      return images.find(
        (image) =>
          image.name === request.name ||
          (request.deviceId !== undefined && image.deviceId === request.deviceId),
      );
    }

    if (request.deviceId !== undefined) {
      return images.find((image) => image.deviceId === request.deviceId);
    }

    const candidates = images.filter((image) => image.name === request.name);
    const spec = request.spec as IosDeviceSpecification;
    return (
      candidates.find(
        (image) =>
          image.isAvailable !== false &&
          image.runtime === spec.runtime &&
          image.deviceType === spec.deviceType,
      ) ??
      candidates.find(
        (image) => image.runtime === spec.runtime && image.deviceType === spec.deviceType,
      ) ??
      candidates[0]
    );
  }

  private async assertExistingMatches(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): Promise<void> {
    if (existing.platform !== request.platform) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Requested ${request.platform} device '${request.name}' conflicts with existing ${existing.platform} device.`,
      );
    }
    if (existing.name !== request.name) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Requested device name '${request.name}' conflicts with existing '${existing.name}' for the supplied identity.`,
      );
    }

    if (request.platform === "android") {
      await this.assertAndroidExistingMatches(request, existing);
      return;
    }

    this.assertIosExistingMatches(request, existing);
  }

  private async assertAndroidExistingMatches(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): Promise<void> {
    const spec = request.spec as AndroidDeviceSpecification;
    const config = await this.dependencies.androidConfigReader.readConfig(existing.name);
    if (matchesAndroidDeviceSpecification(spec, config)) {
      return;
    }
    throw new ProvisionDeviceError(
      "identity_conflict",
      `Existing Android AVD '${existing.name}' does not match the requested runtime, device type, and configuration.`,
    );
  }

  private assertIosExistingMatches(
    request: ExactDeviceProvisionRequest,
    existing: DeviceInfo,
  ): void {
    const spec = request.spec as IosDeviceSpecification;
    const mismatch = iosDeviceSpecificationMismatch(spec, existing);
    if (mismatch === "unavailable") {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Existing iOS simulator '${existing.name}' is unavailable: ${existing.availabilityError ?? "CoreSimulator marked it unavailable"}.`,
      );
    }
    if (mismatch === "mismatch") {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Existing iOS simulator '${existing.name}' does not match the requested runtime and device type.`,
      );
    }
  }

  private async createAndroid(
    request: ExactDeviceProvisionRequest,
    spec: AndroidDeviceSpecification,
    displayCutout: DisplayCutoutClassification,
  ): Promise<ExactProvisionedDevice> {
    let created: Awaited<ReturnType<ExactAndroidAvdClient["createAvd"]>>;
    try {
      created = await this.dependencies.avdManager.createAvd(
        {
          name: request.name,
          package: spec.runtime,
          device: spec.deviceType,
        },
        { signal: request.signal },
      );
    } catch (error) {
      // A killed or cancelled create may have left the AVD for rollback to find (#11155).
      invalidateAndroidInventoryProvenanceAndCatalog();
      throw error;
    }
    if (!created.success) {
      throw new ProvisionDeviceCreateRejectedError(
        `Failed to create Android AVD '${request.name}': ${created.message}`,
      );
    }
    invalidateAndroidInventoryProvenanceAndCatalog();
    if (spec.configuration) {
      await this.configureAndroid(request.name, spec.configuration, request.signal);
    }
    return {
      created: true,
      device: {
        name: request.name,
        platform: "android",
        isRunning: false,
      },
      resolvedSpec: this.withResolvedDisplayCutout(spec, displayCutout),
    };
  }

  private async createIos(
    request: ExactDeviceProvisionRequest,
    spec: IosDeviceSpecification,
    displayCutout: DisplayCutoutClassification,
  ): Promise<ExactProvisionedDevice> {
    const deviceId = this.dependencies.simulatorCreation
      ? (
          await this.dependencies.simulatorCreation.create({
            name: request.name,
            deviceType: spec.deviceType,
            runtime: spec.runtime,
            resources: request.resources,
            signal: request.signal,
          })
        ).udid
      : await this.dependencies.iosSimulator.createSimulator(
          request.name,
          spec.deviceType,
          spec.runtime,
          request.signal,
        );
    const preboot = await this.dependencies.prebootProfile?.apply(
      deviceId,
      { resources: request.resources },
      request.signal,
    );
    return {
      ...(preboot?.applied && preboot.resources.length
        ? { prebootDisabledResources: preboot.resources }
        : {}),
      created: true,
      device: {
        name: request.name,
        platform: "ios",
        deviceId,
        isRunning: false,
        runtime: spec.runtime,
        deviceType: spec.deviceType,
      },
      resolvedSpec: this.withResolvedDisplayCutout(spec, displayCutout),
    };
  }
}

function describeBounds(bounds: DeviceTypeRuntimeBounds | undefined): string {
  return bounds ? `${bounds.minVersion} to ${bounds.maxVersion ?? "no maximum"}` : "unknown bounds";
}

function runtimeIncompatibleError(
  request: ExactDeviceProvisionRequest,
  spec: IosDeviceSpecification,
  details: {
    reason: string;
    bounds: DeviceTypeRuntimeBounds | undefined;
    compatibleRuntimes: IosRuntimeIncompatibility["compatibleRuntimes"];
  },
): ProvisionDeviceError {
  const alternatives = details.compatibleRuntimes.length
    ? details.compatibleRuntimes.map((entry) => entry.id).join(", ")
    : "none installed";
  return new ProvisionDeviceError(
    "runtime_incompatible",
    `${details.reason} Compatible installed runtimes: ${alternatives}.`,
    undefined,
    {
      runtimeCompatibility: {
        requestedRuntime: spec.runtime,
        requestedDeviceType: spec.deviceType,
        ...(details.bounds ? { bounds: details.bounds } : {}),
        compatibleRuntimes: details.compatibleRuntimes,
      },
    },
  );
}

export function createDefaultExactDeviceProvisioner(
  deviceManager: PlatformDeviceManager,
  deviceCreationGate: DeviceCreationGate,
  androidConfigWriter: AndroidAvdConfigWriter = new FileAndroidAvdConfigWriter(),
  assertAdoptable?: ExactDeviceAdoptionGuard,
  simulatorCreation?: SimulatorCreator,
  ios?: Pick<
    DefaultExactDeviceProvisionerDependencies,
    "iosSimulator" | "iosRuntimeCatalog" | "prebootProfile" | "timer" | "lifecycleCoordinator"
  >,
): ExactDeviceProvisioner {
  return new DefaultExactDeviceProvisioner({
    assertAdoptable,
    listDeviceImages: deviceManager.listDeviceImages.bind(deviceManager),
    isCreationAllowed: deviceCreationGate.isCreationAllowed.bind(deviceCreationGate),
    avdManager: new AvdManagerClient(),
    androidConfigReader: new FileAvdConfigReader(),
    androidConfigWriter,
    simulatorCreation,
    prebootProfile: new SimulatorPrebootProfile(),
    iosSimulator: new SimCtlClient(null),
    iosRuntimeCatalog: new SimCtlClient(null),
    ...ios,
  });
}
