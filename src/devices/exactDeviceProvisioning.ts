import type { DeviceResourceDrift } from "../models/DeviceResourceReconciliation";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeviceInfo } from "../models";
import { ActionableError } from "../models";
import type { DeviceCreationGate } from "./deviceCreationGate";
import type { PlatformDeviceManager } from "./deviceUtils";
import type { AvdConfigReader } from "../utils/android-cmdline-tools/AvdConfigReader";
import {
  FileAvdConfigReader,
  resolveAndroidAvdHome,
} from "../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { AvdManagerClient } from "../utils/android-cmdline-tools/AvdManagerClient";
import { invalidateAndroidInventoryProvenanceAndCatalog } from "../utils/AndroidInventoryInvalidation";
import type { CreateAvdParams } from "../utils/android-cmdline-tools/avdmanager";
import {
  SimCtlClient,
  type AppleDeviceRuntime,
  type AppleDeviceType,
} from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  evaluateRuntimeCompatibility,
  type DeviceTypeRuntimeBounds,
} from "../utils/ios-cmdline-tools/runtimeCompatibility";
import type { ProvisionDeviceRecoveryEvidence } from "../server/provisionDeviceRecoveryEvidence";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../utils/toolUtils";
import { trackAmbient } from "../utils/PerfContext";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  androidAvdConfigurationSchema,
  androidAvdConfigurationKeys,
  type AndroidAvdConfiguration,
} from "../models/AndroidAvdConfiguration";
import {
  classifyDisplayCutout,
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
  platform: "android" | "ios";
  name: string;
  deviceId?: string;
  spec: ExactDeviceSpecification;
  /** Note ownership immediately before creating a previously absent device. */
  onBeforeCreate?: () => void;
  /** Shared lifecycle lease held by a higher-level operation through boot/readiness. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
  /** Absolute deadline for acquiring lifecycle coordination. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface ExactProvisionedDevice {
  device: DeviceInfo;
  created: boolean;
  resolvedSpec: ResolvedExactDeviceSpecification;
}

export type ProvisionDeviceFailureCode =
  | "cleanup_failed"
  | "creation_not_allowed"
  | "device_lost"
  | "device_owned_by_other_session"
  | "device_owned_by_other_daemon"
  | "device_cleanup_in_progress"
  | "session_creation_timeout"
  | "device_shutting_down"
  | "device_offline"
  | "discovery_incomplete"
  | "identity_conflict"
  | "timeout"
  | "unsupported"
  | "platform_command_failed"
  | "resource_profile_unproven"
  | "runtime_incompatible";

export const DEFAULT_PROVISION_DEVICE_RETRYABILITY: Readonly<
  Record<ProvisionDeviceFailureCode, boolean>
> = {
  cleanup_failed: false,
  creation_not_allowed: false,
  device_lost: true,
  // Transient: the holder can release the device, after which the same operation can succeed.
  device_owned_by_other_session: true,
  // Transient: the other daemon's claim lapses once its session ends.
  device_owned_by_other_daemon: true,
  // Transient: the previous session's release cleanup finishes by itself.
  device_cleanup_in_progress: true,
  // The bind was rolled back; retrying is safe.
  session_creation_timeout: true,
  // Transient: the kill reservation clears once the shutdown finishes.
  device_shutting_down: true,
  device_offline: true,
  discovery_incomplete: true,
  identity_conflict: false,
  timeout: true,
  unsupported: false,
  platform_command_failed: false,
  resource_profile_unproven: false,
  // A proven model/runtime mismatch is a property of the request; only a different pair can succeed.
  runtime_incompatible: false,
};

interface ProvisionDeviceErrorDiagnostics {
  providerCode?: string;
  readinessPhase?: string;
  attempt?: number;
  incidentId?: string;
  deviceId?: string;
  /** PID of the other daemon holding the device (`device_owned_by_other_daemon`). */
  ownerPid?: number;
  /** Wait hint carried by a typed retryable acquisition refusal. */
  retryAfterMs?: number;
  /** Requested resources that could not be proven applied (iOS Simulator profiles). */
  resourceDrift?: DeviceResourceDrift[];
  /** Proven iOS model/runtime mismatch: requested pair, known bounds, installed alternatives. */
  runtimeCompatibility?: IosRuntimeIncompatibility;
  /** Structured recovery evidence delivered with the error (a snapshot, not live state). */
  recovery?: ProvisionDeviceRecoveryEvidence;
}

export interface IosRuntimeIncompatibility {
  requestedRuntime: string;
  requestedDeviceType: string;
  /** Normalized inclusive bounds of the model; `maxVersion: null` is unbounded. */
  bounds?: DeviceTypeRuntimeBounds;
  /** Installed, available runtimes that do support the requested model. */
  compatibleRuntimes: Array<{ id: string; version: string }>;
}

export class ProvisionDeviceError extends ActionableError {
  constructor(
    public readonly code: ProvisionDeviceFailureCode,
    message: string,
    public readonly retryable = DEFAULT_PROVISION_DEVICE_RETRYABILITY[code],
    public readonly diagnostics: ProvisionDeviceErrorDiagnostics = {},
  ) {
    super(message);
    this.name = "ProvisionDeviceError";
  }
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
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]>;
  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

export interface AndroidAvdConfigWriteOptions {
  signal?: AbortSignal;
}

export interface AndroidAvdConfigWriter {
  setMemoryMb(
    avdName: string,
    memoryMb: number,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void>;
  setConfiguration?(
    avdName: string,
    configuration: AndroidAvdConfiguration,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void>;
}

interface FileAndroidAvdConfigWriterDependencies {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  environment: NodeJS.ProcessEnv;
  homeDirectory: () => string;
}

function defaultAndroidAvdConfigWriterDependencies(): FileAndroidAvdConfigWriterDependencies {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
    environment: process.env,
    homeDirectory: homedir,
  };
}

function configWriteSignal(
  options: AndroidAvdConfigWriteOptions | undefined,
): AbortSignal | undefined {
  return options?.signal;
}

/**
 * Applies a small, typed subset of AVD hardware configuration after
 * `avdmanager create avd`. The caller creates only default-path AVDs, so the
 * standard AVD-home location is authoritative here.
 */
export class FileAndroidAvdConfigWriter implements AndroidAvdConfigWriter {
  constructor(
    private readonly dependencies: FileAndroidAvdConfigWriterDependencies = defaultAndroidAvdConfigWriterDependencies(),
  ) {}

  async setMemoryMb(
    avdName: string,
    memoryMb: number,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void> {
    if (!Number.isInteger(memoryMb) || memoryMb <= 0) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
        `Android AVD memoryMb must be a positive integer; got ${memoryMb}.`,
      );
    }
    return this.setConfiguration(avdName, { memoryMb }, options);
  }

  async setConfiguration(
    avdName: string,
    configuration: AndroidAvdConfiguration,
    options?: AndroidAvdConfigWriteOptions,
  ): Promise<void> {
    const signal = configWriteSignal(options);
    throwIfAborted(signal);
    const validated = androidAvdConfigurationSchema.parse(configuration);
    const replacements = new Map<string, string>();
    for (const key of Object.keys(validated) as (keyof AndroidAvdConfiguration)[]) {
      const value = validated[key];
      if (value !== undefined) {
        replacements.set(
          androidAvdConfigurationKeys[key],
          typeof value === "boolean" ? (value ? "yes" : "no") : String(value),
        );
      }
    }
    if (validated.gpuMode !== undefined) {
      replacements.set("hw.gpu.enabled", "yes");
    }
    const avdHome = resolveAndroidAvdHome(
      this.dependencies.environment,
      this.dependencies.homeDirectory(),
    );
    const configPath = join(avdHome, `${avdName}.avd`, "config.ini");
    const content = await awaitWhileRequestIsLive(
      this.dependencies.readFile(configPath, "utf8"),
      signal,
    );
    // A timed-out provision may have rolled this AVD back while the read was
    // pending. Never apply its captured content to a same-name replacement.
    throwIfAborted(signal);
    const lines = content.split(/\r?\n/);
    const replaced = new Set<string>();
    const updated = lines.map((line) => {
      const key = line.slice(0, line.indexOf("=")).trim();
      if (replacements.has(key)) {
        replaced.add(key);
        return `${key}=${replacements.get(key)}`;
      }
      return line;
    });
    for (const [key, value] of replacements) {
      if (replaced.has(key)) {
        continue;
      }
      if (updated.at(-1) !== "") {
        updated.push("");
      }
      updated.push(`${key}=${value}`, "");
    }
    throwIfAborted(signal);
    await this.dependencies.writeFile(configPath, updated.join("\n"), "utf8");
  }
}

export interface ExactDeviceProvisioner {
  provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice>;
}

export interface DefaultExactDeviceProvisionerDependencies {
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
}

function sameAndroidDeviceIdentity(
  spec: AndroidDeviceSpecification,
  config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>,
): boolean {
  const runtime = parseAndroidSystemImageRuntime(spec.runtime);
  if (!runtime || !config) {
    return false;
  }
  if (
    config.apiLevel !== runtime.apiLevel ||
    config.tag !== runtime.tag ||
    config.architecture !== runtime.architecture ||
    config.deviceName !== spec.deviceType ||
    config.systemImagePackage !== runtime.systemImagePackage
  ) {
    return false;
  }
  return true;
}

function sameAndroidSpecification(
  spec: AndroidDeviceSpecification,
  config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>,
): boolean {
  return (
    sameAndroidDeviceIdentity(spec, config) &&
    (spec.configuration?.memoryMb === undefined ||
      config?.ramSizeMb === spec.configuration.memoryMb) &&
    Object.entries(spec.configuration ?? {}).every(
      ([key, value]) =>
        key === "memoryMb" ||
        value === undefined ||
        ((key !== "gpuMode" || config?.gpuEnabled === true) &&
          config?.hardware?.[key as keyof AndroidAvdConfiguration] === value),
    )
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
    const { runtimes, deviceTypes } = discovered;
    const runtime = runtimes.find((entry) => entry.identifier === spec.runtime);
    const deviceType = deviceTypes.find((entry) => entry.identifier === spec.deviceType);
    if (!runtime || !deviceType) {
      return;
    }
    const evaluation = evaluateRuntimeCompatibility(deviceType, runtime.version);
    const unavailable = !runtime.isAvailable;
    if (!unavailable && evaluation.status !== "unsupported") {
      return;
    }
    const compatibleRuntimes = runtimes
      .filter(
        (entry) =>
          entry.isAvailable &&
          evaluateRuntimeCompatibility(deviceType, entry.version).status === "supported",
      )
      .map((entry) => ({ id: entry.identifier, version: entry.version }));
    throw runtimeIncompatibleError(request, spec, {
      reason: unavailable
        ? `Runtime '${spec.runtime}' is not available (${runtime.availabilityError ?? "CoreSimulator marked it unavailable"}), so iOS simulator '${request.name}' with device type '${spec.deviceType}' cannot be created.`
        : `Device type '${spec.deviceType}' does not support runtime '${spec.runtime}' (version ${runtime.version}; supported ${describeBounds(evaluation.bounds)}), so iOS simulator '${request.name}' was not created.`,
      bounds: evaluation.bounds,
      compatibleRuntimes,
    });
  }

  private resolveDisplayCutout(request: ExactDeviceProvisionRequest): DisplayCutoutClassification {
    const resolved = classifyDisplayCutout(request.platform, request.spec.deviceType);
    const preference = request.spec.displayCutout;
    if (preference === undefined || preference === "any") {
      return resolved;
    }
    if (resolved === "unknown") {
      throw new ProvisionDeviceError(
        "unsupported",
        `Display cutout preference '${preference}' is unsupported for ${request.platform} device type '${request.spec.deviceType}' because its cutout class is unknown.`,
      );
    }
    if (resolved !== preference) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Exact ${request.platform} device type '${request.spec.deviceType}' has display cutout '${resolved}', not requested '${preference}'.`,
      );
    }
    return resolved;
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
    if (sameAndroidSpecification(spec, config)) {
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
    if (existing.isAvailable === false) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Existing iOS simulator '${existing.name}' is unavailable: ${existing.availabilityError ?? "CoreSimulator marked it unavailable"}.`,
      );
    }
    if (existing.runtime !== spec.runtime || existing.deviceType !== spec.deviceType) {
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
    const created = await this.dependencies.avdManager.createAvd(
      {
        name: request.name,
        package: spec.runtime,
        device: spec.deviceType,
      },
      { signal: request.signal },
    );
    if (!created.success) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
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
    const deviceId = await this.dependencies.iosSimulator.createSimulator(
      request.name,
      spec.deviceType,
      spec.runtime,
      request.signal,
    );
    return {
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
): ExactDeviceProvisioner {
  return new DefaultExactDeviceProvisioner({
    listDeviceImages: deviceManager.listDeviceImages.bind(deviceManager),
    isCreationAllowed: deviceCreationGate.isCreationAllowed.bind(deviceCreationGate),
    avdManager: new AvdManagerClient(),
    androidConfigReader: new FileAvdConfigReader(),
    androidConfigWriter,
    iosSimulator: new SimCtlClient(null),
    iosRuntimeCatalog: new SimCtlClient(null),
  });
}
