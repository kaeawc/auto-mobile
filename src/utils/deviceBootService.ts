import type { ChildProcess } from "child_process";
import type { BootedDevice, DeviceInfo, Platform } from "../models";
import { ActionableError } from "../models";
import type {
  DeviceMatchCriteria,
  FormFactor,
  MatchingStrategy,
} from "../models/DeviceMatchCriteria";
import type { DeviceCreationGate } from "./deviceCreationGate";
import { isAndroidEmulatorSerial } from "./androidSerial";
import {
  assertAndroidImageRunningStateKnown,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  type BootedDeviceDiscoveryOptions,
  type DeviceDiscoveryError,
  type PlatformDeviceManager,
  waitForDeviceReadyOrCancel,
} from "./deviceUtils";
import { matchesDeviceCriteria, type DeviceMatcher } from "./deviceMatcher";
import type { DeviceProvisioner, DeviceProvisioningIdentityHooks } from "./deviceProvisioning";
import { NoopDeviceBootRecovery, type DeviceBootRecovery } from "./deviceBootRecovery";
import { defaultTimer, type Timer } from "./SystemTimer";
import { runWithAbortSignal } from "./AbortContext";
import type { StableVirtualDeviceIdentity } from "./virtualDeviceLifecycleCoordinator";
import {
  getVirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";
import { stableStringify } from "./stableStringify";

const ABORT_SETTLEMENT_GRACE_MS = 1_000;

/** A boot deadline failure, kept distinct from platform command failures. */
export class DeviceBootTimeoutError extends ActionableError {
  readonly code = "timeout";

  constructor(
    readonly operation: string,
    readonly phase: string,
    readonly elapsedMs: number,
    readonly budgetMs: number,
  ) {
    super(
      `${operation} timeout exhausted while ${phase}; remainingBudgetMs=0; elapsedMs=${elapsedMs}; budgetMs=${budgetMs}; origin=DeviceBootService`,
    );
  }
}

/**
 * Android booted-device discovery did not complete this sweep (ADB
 * unavailable/failed). A transient failure must never be treated as an
 * authoritative empty result — that would let boot or adoption proceed
 * without having proven identity uniqueness (issue #7179). The failure is
 * retryable: callers should re-attempt discovery rather than fall back to
 * an unqualified boot/adopt decision.
 */
export class AndroidBootedDeviceDiscoveryIncompleteError extends ActionableError {
  readonly code = "discovery_incomplete";
  readonly retryable = true;

  constructor(readonly discoveryError: DeviceDiscoveryError | undefined) {
    super(
      "discovery_incomplete: Android booted-device discovery was incomplete and is retryable" +
        (discoveryError ? `: ${discoveryError.message}` : "."),
    );
  }
}

/** More than one live emulator claims the requested stable AVD identity. */
export class AndroidAvdIdentityConflictError extends ActionableError {
  readonly code = "identity_conflict";

  constructor(
    readonly avdName: string,
    readonly candidateSerials: readonly string[],
  ) {
    super(
      `identity_conflict: Android AVD '${avdName}' is claimed by multiple running ` +
        `emulators: ${candidateSerials.join(", ")}. Pass an explicit deviceId (ADB serial) to select one.`,
    );
  }
}

/**
 * Resolves an exact Android AVD name only when it maps to one live ADB serial.
 * Repeated discovery rows for the same serial do not make the identity ambiguous.
 */
export function findUniqueBootedAndroidDeviceByName(
  devices: readonly BootedDevice[],
  avdName: string,
): BootedDevice | undefined {
  const matchesBySerial = new Map(
    devices
      .filter(
        (device) =>
          device.platform === "android" &&
          device.name === avdName &&
          isAndroidEmulatorSerial(device.deviceId),
      )
      .map((device): [string, BootedDevice] => [device.deviceId, device]),
  );
  const matches = [...matchesBySerial.values()];
  if (matches.length > 1) {
    throw new AndroidAvdIdentityConflictError(avdName, [...matchesBySerial.keys()].toSorted());
  }
  return matches[0];
}

function findEligibleExactBootedDevice(
  platform: Platform,
  devices: BootedDevice[],
  name: string,
  criteria: DeviceMatchCriteria,
): BootedDevice | null {
  const exact =
    platform === "android"
      ? findUniqueBootedAndroidDeviceByName(devices, name)
      : devices.find((candidate) => candidate.name === name);
  return exact && matchesDeviceCriteria(exact, criteria) ? exact : null;
}

/**
 * True for an `AbortSignal.reason` that carries no caller-supplied context: a
 * literal `undefined` (used by synthetic/fake signals in tests), or the
 * platform's own default `DOMException` that `AbortController.abort()`
 * synthesizes when called with no argument (`name: "AbortError"`).
 *
 * A bare `abort()` never leaves `reason` as `undefined` on a real
 * `AbortSignal` — the runtime fills in that default `DOMException` — so this
 * is the actual signal a generic/unlabeled external cancellation needs to be
 * detected by. An explicit `abort(null)` deliberately stays "not default":
 * `null !== undefined` and `null` is not a `DOMException`, so a caller who
 * explicitly cancels with a `null` reason still gets that reason back as-is.
 * Any other explicit reason (`Error`, `DeviceLostError`, string, etc.) is
 * likewise left untouched — only this platform sentinel is relabeled with
 * boot-phase context (issue #5394).
 */
function isDefaultAbortReason(reason: unknown): boolean {
  return reason === undefined || (reason instanceof DOMException && reason.name === "AbortError");
}

/** Inputs which affect device discovery, creation, and readiness, but not MCP sessions or automation setup. */
export interface DeviceBootRequest {
  operationName?: string;
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
  /** Absolute deadline shared with higher-level automation readiness. */
  totalDeadlineMs?: number;
  signal?: AbortSignal;
  createIfMissing?: boolean;
  /**
   * The caller just created this device (a fresh provision), so its first boot
   * is a genuine cold boot. Opts the Android readiness wait into bounded
   * ADB-offline recovery instead of silently waiting out the whole budget
   * (issue #7054).
   */
  freshProvision?: boolean;
  /** Internal CI policy: preserve OS bounds for provisioning while matching its exact owned name across runtime fallback. */
  matchNamedDeviceIgnoringOsVersion?: boolean;
  /** Internal identity policy: select a named runtime only when its name is an exact match. */
  matchExactName?: boolean;
  /** Recovery snapshots keep preserved Android AVDs out of a concurrent startup match. */
  excludeDeviceNames?: ReadonlySet<string>;
  /** Recovery snapshots keep preserved Android serials out of a concurrent startup match. */
  excludeDeviceIds?: ReadonlySet<string>;
  /** Non-mutating acceptance control for deterministic discovery-order coverage. */
  presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"];
}

export interface DeviceBootProgress {
  report(current: number, total: number, message: string): Promise<void>;
}

export interface DeviceBootResult {
  device: BootedDevice;
  source: "booted" | "cold-boot";
  sourceImage?: DeviceInfo;
  processHandle?: ChildProcess | null;
  processId?: number;
  provisioned: boolean;
}

export interface DeviceBootServiceDependencies {
  deviceManager: PlatformDeviceManager;
  deviceMatcher: DeviceMatcher;
  deviceCreationGate: DeviceCreationGate;
  deviceProvisioner: DeviceProvisioner;
  matchingStrategy: MatchingStrategy;
  /** Defaults to no recovery so normal product and MCP boot never erases devices. */
  bootRecovery?: DeviceBootRecovery;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** Bind a selector reservation to canonical identity before mutating the device. */
  onIdentityResolved?: (identity: StableVirtualDeviceIdentity) => Promise<void>;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  /** Existing lease held by a caller through later session/readiness work. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
}

interface BootDeadlineContext {
  operationName: string;
  startedAtMs: number;
  deadlineMs: number;
  signal?: AbortSignal;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  ownsLifecycleLease: boolean;
  /** A fresh provision's cold boot opts Android readiness into offline recovery (#7054). */
  freshProvision?: boolean;
}

interface PhaseCancellation {
  promise: Promise<never>;
  throwIfCancelled(): void;
  dispose(): void;
}

function createPhaseCancellation(
  signal: AbortSignal | undefined,
  phase: string,
): PhaseCancellation {
  const never = new Promise<never>(() => undefined);
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new ActionableError(`startDevice cancelled while ${phase}`);
    }
  };
  if (!signal || signal.aborted) {
    return { promise: never, throwIfCancelled, dispose: () => {} };
  }

  let rejectCancellation!: (error: ActionableError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => {
    rejectCancellation(new ActionableError(`startDevice cancelled while ${phase}`));
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    promise,
    throwIfCancelled,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

/**
 * Product boot boundary shared by MCP and daemon-free callers.
 *
 * It deliberately does not create MCP sessions, update resources, or start
 * CtrlProxy. Those are application concerns layered on by `startDevice`.
 */
export class DeviceBootService {
  private readonly bootRecovery: DeviceBootRecovery;
  private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;

  constructor(private readonly dependencies: DeviceBootServiceDependencies) {
    this.bootRecovery = dependencies.bootRecovery ?? new NoopDeviceBootRecovery();
    this.timer = dependencies.timer ?? defaultTimer;
    this.lifecycleCoordinator =
      dependencies.lifecycleCoordinator ??
      (dependencies.timer
        ? new InMemoryVirtualDeviceLifecycleCoordinator(dependencies.timer)
        : getVirtualDeviceLifecycleCoordinator());
  }

  async boot(request: DeviceBootRequest, progress?: DeviceBootProgress): Promise<DeviceBootResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const context: BootDeadlineContext = {
      operationName: request.operationName ?? "startDevice",
      startedAtMs: this.timer.now(),
      deadlineMs: request.totalDeadlineMs ?? this.timer.now() + timeoutMs,
      signal: request.signal,
      lifecycleLease: this.dependencies.lifecycleLease,
      ownsLifecycleLease: false,
      freshProvision: request.freshProvision === true,
    };
    if (!context.lifecycleLease && !this.dependencies.onIdentityResolved) {
      context.lifecycleLease = await this.lifecycleCoordinator.reserve(
        {
          kind: "selector",
          platform: request.platform,
          selector: stableStringify({
            deviceId: request.deviceId,
            name: request.name,
            minOsVersion: request.minOsVersion,
            maxOsVersion: request.maxOsVersion,
            formFactor: request.formFactor,
            screenSize: request.screenSize,
          }),
        },
        {
          operation: "start",
          deadlineMs: context.deadlineMs,
          signal: request.signal,
        },
      );
      context.ownsLifecycleLease = true;
      context.signal = request.signal
        ? AbortSignal.any([request.signal, context.lifecycleLease.signal])
        : context.lifecycleLease.signal;
    }
    try {
      if (request.deviceId) {
        return await this.bootKnownDevice(
          { ...request, deviceId: request.deviceId },
          context,
          progress,
        );
      }
      return await this.bootMatchingDevice(request, context, progress);
    } finally {
      if (context.ownsLifecycleLease) {
        context.lifecycleLease?.release();
      }
    }
  }

  private async bindLifecycleIdentity(
    context: BootDeadlineContext,
    identity: StableVirtualDeviceIdentity,
  ): Promise<void> {
    if (context.lifecycleLease) {
      await context.lifecycleLease.bindCanonicalIdentity(identity);
    }
    await this.dependencies.onIdentityResolved?.(identity);
  }

  private async discoverBootedDevices(
    platform: DeviceBootRequest["platform"],
    context: BootDeadlineContext,
    phase: string,
    bypassAndroidCache = false,
    awaitAbortSettlement = true,
    presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"],
  ): Promise<BootedDevice[]> {
    // Android completeness can only be judged from the detailed discovery
    // result (`succeededPlatforms`), so android always takes this path — a
    // plain `getBootedDevices` call cannot distinguish a transient ADB
    // failure from a genuinely empty result (#7179).
    if (platform === "android") {
      const discovery = await this.runPhase(
        context,
        phase,
        async () =>
          await this.dependencies.deviceManager.getBootedDevicesDetailed(platform, {
            ...(bypassAndroidCache ? { bypassAndroidDeviceListCache: true } : {}),
            ...(presentationOrder !== undefined ? { presentationOrder } : {}),
          }),
        awaitAbortSettlement,
      );
      if (!discovery.succeededPlatforms.has("android")) {
        throw new AndroidBootedDeviceDiscoveryIncompleteError(discovery.discoveryErrors?.android);
      }
      return discovery.devices;
    }
    if (presentationOrder !== undefined) {
      const discovery = await this.runPhase(
        context,
        phase,
        async () =>
          await this.dependencies.deviceManager.getBootedDevicesDetailed(platform, {
            presentationOrder,
          }),
        awaitAbortSettlement,
      );
      return discovery.devices;
    }
    return await this.runPhase(
      context,
      phase,
      () => this.dependencies.deviceManager.getBootedDevices(platform),
      awaitAbortSettlement,
    );
  }

  private async bootKnownDevice(
    request: DeviceBootRequest & { deviceId: string },
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    const { deviceManager } = this.dependencies;
    const criteria: DeviceMatchCriteria = {
      platform: request.platform,
      minOsVersion: request.minOsVersion,
      maxOsVersion: request.maxOsVersion,
      name: request.name,
      formFactor: request.formFactor,
      screenSize: request.screenSize,
    };
    const booted = await this.discoverBootedDevices(
      request.platform,
      context,
      "discovering running devices",
      false,
      true,
      request.presentationOrder,
    );
    const hasExplicitConstraints =
      request.minOsVersion !== undefined ||
      request.maxOsVersion !== undefined ||
      request.formFactor !== undefined ||
      request.screenSize !== undefined;
    const running = booted.find((device) => device.deviceId === request.deviceId);
    if (running) {
      return await this.waitForKnownRunningDevice(
        running,
        request,
        criteria,
        hasExplicitConstraints,
        context,
        progress,
      );
    }
    const images = await this.runPhase(context, "listing device images", () =>
      deviceManager.listDeviceImages(request.platform),
    );
    const image = images.find(
      (device) =>
        device.deviceId === request.deviceId ||
        // Android accepts an AVD image name in `deviceId` because a booted
        // Android device exposes its transient ADB serial instead. iOS has a
        // durable simulator UDID at both layers, and display names are not
        // unique, so never treat a name as an iOS identity alias.
        (request.platform === "android" && device.name === request.deviceId),
    );
    if (!image) {
      throw new ActionableError(
        `Device '${request.deviceId}' not found. Available booted: ${booted.map((device) => device.deviceId).join(", ") || "none"}. ` +
          `Available images: ${images.map((device) => device.name).join(", ") || "none"}.`,
      );
    }
    if (hasExplicitConstraints && !matchesDeviceCriteria(image, criteria)) {
      throw new ActionableError(
        `Device '${request.deviceId}' does not satisfy the requested platform, version, or form-factor constraints.`,
      );
    }
    // `deviceId` also accepts an AVD/image name (see getAndroidSchema), so the
    // serial lookup above cannot see an already-running image named this way.
    // Route through the same reuse-before-cold-boot path as the name matcher so
    // both spellings of the same target resolve identically (#3334): booting a
    // live image is rejected by the platform, or spawns a doomed second child.
    return this.bootMatchedImage(image, context, progress, request.presentationOrder);
  }

  private async waitForKnownRunningDevice(
    running: BootedDevice,
    request: DeviceBootRequest & { deviceId: string },
    criteria: DeviceMatchCriteria,
    hasExplicitConstraints: boolean,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
  ): Promise<DeviceBootResult> {
    // Exact identity is already authoritative when no metadata constraints were
    // requested. Avoid a second inventory listing when the running iOS row also
    // carries the runtime metadata required by CtrlProxy readiness (#7160).
    const needsIosRuntimeMetadata =
      running.platform === "ios" &&
      running.iosVersion === undefined &&
      running.osVersion === undefined;
    const resolvedRunning =
      hasExplicitConstraints || needsIosRuntimeMetadata
        ? await this.enrichBootedDeviceFromImage(running, context)
        : running;
    if (hasExplicitConstraints && !matchesDeviceCriteria(resolvedRunning, criteria)) {
      throw new ActionableError(
        `Device '${request.deviceId}' does not satisfy the requested platform, version, or form-factor constraints.`,
      );
    }
    return this.waitForRunningDevice(resolvedRunning, context, progress);
  }

  private async enrichBootedDeviceFromImage(
    device: BootedDevice,
    context: BootDeadlineContext,
  ): Promise<BootedDevice> {
    const images = await this.runPhase(
      context,
      `resolving ${device.platform} device metadata`,
      (signal) => this.dependencies.deviceManager.listDeviceImages(device.platform, signal),
    );
    return enrichBootedDevicesFromImages([device], images)[0]!;
  }

  private async bootMatchingDevice(
    request: DeviceBootRequest,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    const { deviceManager, deviceMatcher, matchingStrategy } = this.dependencies;
    const provisionCriteria: DeviceMatchCriteria = {
      platform: request.platform,
      minOsVersion: request.minOsVersion,
      maxOsVersion: request.maxOsVersion,
      name: request.name,
      formFactor: request.formFactor,
      screenSize: request.screenSize,
    };
    const criteria = request.matchNamedDeviceIgnoringOsVersion
      ? { ...provisionCriteria, minOsVersion: undefined, maxOsVersion: undefined }
      : provisionCriteria;
    const images = await this.runPhase(context, "listing device images", () =>
      deviceManager.listDeviceImages(request.platform),
    );
    const excludedDeviceNames = request.excludeDeviceNames;
    const matchingImages = excludedDeviceNames
      ? images.filter((image) => !excludedDeviceNames.has(image.name))
      : images;
    const running = await this.findRunningMatch(
      request,
      criteria,
      matchingImages,
      context,
      progress,
    );
    if (running) {
      return running;
    }
    // An exact AVD name is already a complete identity choice, not a fuzzy
    // matcher preference. Keep the discovered image object intact so its API
    // and release metadata survives into session admission; the generic
    // matcher is allowed to substitute a configured result, which loses that
    // metadata and can incorrectly turn an exact selection into no match.
    const image =
      request.matchExactName && request.name
        ? (matchingImages.find(
            (candidate) =>
              candidate.name === request.name && matchesDeviceCriteria(candidate, criteria),
          ) ?? null)
        : deviceMatcher.matchDeviceImage(criteria, matchingImages, matchingStrategy);
    if (image) {
      return this.bootMatchedImage(image, context, progress, request.presentationOrder);
    }
    return this.provisionAndBoot(request, provisionCriteria, matchingImages, context, progress);
  }

  private async findRunningMatch(
    request: DeviceBootRequest,
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult | undefined> {
    if (request.preferRunning === false) {
      return undefined;
    }
    const booted = await this.discoverBootedDevices(
      request.platform,
      context,
      "discovering running devices",
      request.matchExactName && request.name !== undefined,
      false,
      request.presentationOrder,
    );
    const excludedDeviceNames = request.excludeDeviceNames;
    const excludedDeviceIds = request.excludeDeviceIds;
    const matchingBooted =
      excludedDeviceNames || excludedDeviceIds
        ? booted.filter(
            (device) =>
              !excludedDeviceNames?.has(device.name) && !excludedDeviceIds?.has(device.deviceId),
          )
        : booted;
    const enriched = enrichBootedDevicesFromImages(matchingBooted, images);
    const match =
      request.matchExactName && request.name
        ? findEligibleExactBootedDevice(request.platform, enriched, request.name, criteria)
        : this.dependencies.deviceMatcher.matchBootedDevice(
            criteria,
            enriched,
            this.dependencies.matchingStrategy,
          );
    if (!match) {
      return undefined;
    }
    await this.reportProgress(context, progress, 100, "Found matching running device");
    return this.waitForRunningDevice(match, context, progress);
  }

  private async bootMatchedImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
    presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"],
  ): Promise<DeviceBootResult> {
    // A cached `isRunning: false` overlay can go stale: an externally started
    // same-name AVD (or several) may already be live. iOS keeps trusting the
    // cached flag because its identity (UDID) cannot silently collide the
    // same way; android always re-discovers with a fresh cache-bypassing
    // sweep before trusting the overlay (#7178).
    if (image.platform !== "android" && !image.isRunning) {
      return this.bootImage(image, context, progress, false);
    }
    const booted = await this.discoverBootedDevices(
      image.platform,
      context,
      "resolving the running device image",
      image.platform === "android",
      true,
      presentationOrder,
    );
    // iOS simulators can share a display name, so only their UDID is lifecycle
    // identity. Android `deviceId` may instead name an AVD image, where name
    // fallback is required because the booted device carries an ADB serial.
    const running =
      (image.deviceId ? booted.find((device) => device.deviceId === image.deviceId) : undefined) ??
      (image.platform === "android"
        ? findUniqueBootedAndroidDeviceByName(booted, image.name)
        : undefined);
    if (!running) {
      return this.bootImage(image, context, progress, false);
    }
    const result = await this.waitForRunningDevice(
      enrichBootedDevice(running, image),
      context,
      progress,
    );
    return { ...result, device: enrichBootedDevice(result.device, image) };
  }

  private async provisionAndBoot(
    request: DeviceBootRequest,
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    if (!this.dependencies.deviceCreationGate.isCreationAllowed(request.createIfMissing)) {
      throw new ActionableError(
        `No ${request.platform} device matching criteria found. ` +
          `${request.minOsVersion ? `minOsVersion>=${request.minOsVersion} ` : ""}` +
          `${request.maxOsVersion ? `maxOsVersion<=${request.maxOsVersion} ` : ""}` +
          `${request.name ? `name=${request.name} ` : ""}` +
          `Available images: ${images.map((device) => `${device.name}${device.osVersion ? ` (v${device.osVersion})` : ""}`).join(", ") || "none"}.`,
      );
    }
    const identityHooks: DeviceProvisioningIdentityHooks = {
      reserveBeforeCreate: async (identity) => {
        if (identity.platform === "android") {
          await this.bindLifecycleIdentity(context, {
            platform: "android",
            stableId: identity.name,
          });
        }
        return context.signal;
      },
      bindAfterCreate: async (device) => {
        if (device.platform === "ios") {
          if (!device.deviceId) {
            throw new ActionableError(
              `Created iOS simulator '${device.name}' has no lifecycle identity.`,
            );
          }
          await this.bindLifecycleIdentity(context, {
            platform: "ios",
            stableId: device.deviceId,
          });
        }
      },
    };
    const provisioned = await this.runPhase(context, "provisioning a device", (signal) =>
      this.dependencies.deviceProvisioner.provision(criteria, signal, identityHooks),
    );
    const createdImage: DeviceInfo = {
      name: provisioned.name,
      platform: provisioned.platform,
      deviceId: provisioned.deviceId,
      isRunning: false,
      formFactor: request.formFactor,
    } as DeviceInfo;
    return this.bootImage(createdImage, context, progress, true);
  }

  private async waitForRunningDevice(
    device: BootedDevice,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    if (device.platform === "ios") {
      await this.bindLifecycleIdentity(context, {
        platform: "ios",
        stableId: device.deviceId,
      });
    } else if (
      device.deviceId.startsWith("emulator-") &&
      device.name !== `Unknown (${device.deviceId})`
    ) {
      await this.bindLifecycleIdentity(context, {
        platform: "android",
        stableId: device.name,
      });
    }
    const recoveryTarget: DeviceInfo = { ...device, isRunning: true };
    let attempts = 0;
    return this.bootRecovery.run(
      recoveryTarget,
      async () => {
        attempts++;
        if (attempts > 1) {
          return this.bootImageOnce(recoveryTarget, context, progress, false);
        }
        const ready = await this.runPhase(context, "waiting for a running device", (signal) =>
          this.dependencies.deviceManager.waitForDeviceReady(
            { ...device, isRunning: true },
            this.remaining(context, "waiting for a running device"),
            undefined,
            signal,
          ),
        );
        return { device: { ...device, ...ready }, source: "booted", provisioned: false };
      },
      context.signal,
    );
  }

  private async bootImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    assertAndroidImageRunningStateKnown(image);
    if (image.platform === "ios" && !image.deviceId) {
      throw new ActionableError("iOS simulator deviceId (UDID) is required to start a simulator.");
    }
    await this.bindLifecycleIdentity(context, {
      platform: image.platform,
      stableId: image.platform === "android" ? image.name : image.deviceId!,
    });
    return this.bootRecovery.run(
      image,
      async () => this.bootImageOnce(image, context, progress, provisioned),
      context.signal,
    );
  }

  private async bootImageOnce(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    let disposeStartHandleCancellation = () => {};
    const handle = await this.runPhase(context, "starting the device", async (signal) => {
      const started = await this.dependencies.deviceManager.startDevice(
        image,
        this.remaining(context, "starting the device"),
      );
      const cancelStarted = () => {
        started?.kill();
      };
      if (signal.aborted) {
        cancelStarted();
      } else {
        signal.addEventListener("abort", cancelStarted, { once: true });
        disposeStartHandleCancellation = () => signal.removeEventListener("abort", cancelStarted);
      }
      return started;
    });
    disposeStartHandleCancellation();
    let handleCancelled = false;
    const cancelHandle = () => {
      if (handle && !handleCancelled) {
        handleCancelled = true;
        handle.kill();
      }
    };
    context.signal?.addEventListener("abort", cancelHandle, { once: true });
    try {
      await this.reportProgress(context, progress, 60, "Device started, waiting for readiness...");
      const ready = await this.runPhase(context, "waiting for device boot readiness", (signal) =>
        waitForDeviceReadyOrCancel(
          this.dependencies.deviceManager,
          image,
          handle,
          this.remaining(context, "waiting for device boot readiness"),
          signal,
          this.timer,
          cancelHandle,
          () => this.timeoutError(context, "waiting for device boot readiness"),
          // A freshly-provisioned Android AVD's first boot is a genuine cold
          // boot; opt it into bounded ADB-offline recovery (#7054). Fresh state
          // arrives either from this call site (`provisioned`) or from the
          // request when a just-created device is booted by serial through
          // `bootKnownDevice` (`context.freshProvision`). A cold boot of a
          // pre-existing AVD keeps the wait-out behavior, as does any iOS boot.
          image.platform === "android" && (provisioned || context.freshProvision === true)
            ? { freshProvision: true }
            : undefined,
        ),
      );
      await this.reportProgress(context, progress, 100, "Device is ready for use");
      return {
        device: enrichBootedDevice(ready, image),
        source: "cold-boot",
        sourceImage: image,
        processHandle: handle,
        processId: handle?.pid,
        provisioned,
      };
    } catch (error) {
      cancelHandle();
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", cancelHandle);
    }
  }

  private async reportProgress(
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    current: number,
    message: string,
  ): Promise<void> {
    if (!progress) {
      return;
    }
    await this.runPhase(
      context,
      `reporting ${current}% device boot progress`,
      () => progress.report(current, 100, message),
      false,
    );
  }

  private remaining(context: BootDeadlineContext, phase: string): number {
    const remainingMs = Math.floor(context.deadlineMs - this.timer.now());
    if (remainingMs <= 0) {
      throw this.timeoutError(context, phase);
    }
    return remainingMs;
  }

  private async runPhase<T>(
    context: BootDeadlineContext,
    phase: string,
    operation: (signal: AbortSignal) => Promise<T>,
    awaitAbortSettlement = true,
  ): Promise<T> {
    const remainingMs = this.remaining(context, phase);
    const cancellation = createPhaseCancellation(context.signal, phase);
    cancellation.throwIfCancelled();
    const controller = new AbortController();
    const externalSignal = context.signal;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let removeExternalAbortListener: (() => void) | undefined;
    const externalAbortPromise = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => {
            reject(
              isDefaultAbortReason(externalSignal.reason)
                ? new ActionableError(`startDevice request cancelled while ${phase}`)
                : externalSignal.reason,
            );
          };
          if (externalSignal.aborted) {
            rejectForAbort();
            return;
          }
          externalSignal.addEventListener("abort", rejectForAbort, { once: true });
          removeExternalAbortListener = () =>
            externalSignal.removeEventListener("abort", rejectForAbort);
        })
      : undefined;
    let operationFailureRecorded = false;
    let operationFailure: unknown;
    const operationPromise = runWithAbortSignal(signal, () => operation(signal)).catch((error) => {
      operationFailureRecorded = true;
      operationFailure = error;
      throw error;
    });
    void operationPromise.catch(() => {});
    try {
      return await Promise.race([
        operationPromise,
        ...(externalAbortPromise ? [externalAbortPromise] : []),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = this.timer.setTimeout(() => {
            const error = this.timeoutError(context, phase);
            controller.abort(error);
            reject(error);
          }, remainingMs);
        }),
        cancellation.promise,
      ]);
    } catch (error) {
      await this.awaitAbortSettlementIfNeeded(
        operationPromise,
        awaitAbortSettlement && (controller.signal.aborted || externalSignal?.aborted === true),
      );
      this.throwExternalAbortReason(externalSignal, phase);
      cancellation.throwIfCancelled();
      if (controller.signal.aborted) {
        throw this.phaseTimeoutFailure(
          context,
          controller,
          operationFailureRecorded,
          operationFailure,
          phase,
        );
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      cancellation.dispose();
      removeExternalAbortListener?.();
    }
  }

  private timeoutError(context: BootDeadlineContext, phase: string): DeviceBootTimeoutError {
    return new DeviceBootTimeoutError(
      context.operationName,
      phase,
      this.timer.now() - context.startedAtMs,
      Math.max(0, context.deadlineMs - context.startedAtMs),
    );
  }

  private phaseTimeoutFailure(
    context: BootDeadlineContext,
    controller: AbortController,
    operationFailureRecorded: boolean,
    operationFailure: unknown,
    phase: string,
  ): unknown {
    if (operationFailureRecorded && operationFailure !== controller.signal.reason) {
      return operationFailure;
    }
    return this.timeoutError(context, phase);
  }

  private throwExternalAbortReason(signal: AbortSignal | undefined, phase: string): void {
    if (signal?.aborted) {
      if (isDefaultAbortReason(signal.reason)) {
        throw new ActionableError(`startDevice cancelled while ${phase}`);
      }
      throw signal.reason;
    }
  }

  private async awaitAbortSettlementIfNeeded(
    operation: Promise<unknown>,
    shouldAwait: boolean,
  ): Promise<void> {
    if (shouldAwait) {
      await this.awaitAbortSettlement(operation);
    }
  }

  private async awaitAbortSettlement(operation: Promise<unknown>): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timeoutHandle = this.timer.setTimeout(resolve, ABORT_SETTLEMENT_GRACE_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }
}

export function enrichBootedDevice(device: BootedDevice, image: DeviceInfo): BootedDevice {
  return {
    ...device,
    iosVersion: device.iosVersion ?? image.iosVersion,
    apiLevel: device.apiLevel ?? image.apiLevel,
    osVersion: device.osVersion ?? image.osVersion,
    formFactor: device.formFactor ?? image.formFactor,
    screenWidth: device.screenWidth ?? image.screenWidth,
    screenHeight: device.screenHeight ?? image.screenHeight,
  };
}

export function enrichBootedDevicesFromImages(
  booted: BootedDevice[],
  images: DeviceInfo[],
): BootedDevice[] {
  const imagesById = new Map(
    images.filter((image) => image.deviceId).map((image) => [image.deviceId!, image]),
  );
  const imagesByName = new Map(images.map((image) => [image.name, image]));
  return booted.map((device) => {
    const canMatchAndroidByName =
      device.platform === "android" && isAndroidEmulatorSerial(device.deviceId);
    const image =
      (device.deviceId ? imagesById.get(device.deviceId) : undefined) ??
      (canMatchAndroidByName ? imagesByName.get(device.name) : undefined);
    return image?.platform === device.platform ? enrichBootedDevice(device, image) : device;
  });
}
