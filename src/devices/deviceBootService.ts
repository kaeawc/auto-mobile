import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import {
  awaitTerminationWithinRequest,
  terminateColdBootProcess,
  terminateOwnedEmulatorProcess,
  type OwnedTermination,
  type OwnedTerminationWait,
} from "./coldBootProcessTermination";
import type { BootedDevice, DeviceInfo, Platform } from "../models";
import { ActionableError } from "../models";
import { isEmulatorLaunchCancelledError } from "../models/EmulatorLaunchCancelledError";
import type {
  DeviceMatchCriteria,
  FormFactor,
  MatchingStrategy,
} from "../models/DeviceMatchCriteria";
import type { DeviceCreationGate } from "./deviceCreationGate";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import {
  assertAndroidImageRunningStateKnown,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  type BootedDeviceDiscoveryOptions,
  type DeviceDiscoveryError,
  type PlatformDeviceManager,
  waitForDeviceReadyOrCancel,
} from "./deviceUtils";
import {
  describeDisplayRequirements,
  matchesDeviceCriteria,
  type DeviceMatcher,
} from "../utils/deviceMatcher";
import type { DeviceProvisioner, DeviceProvisioningIdentityHooks } from "./deviceProvisioning";
import { NoopDeviceBootRecovery, type DeviceBootRecovery } from "./deviceBootRecovery";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import type { StableVirtualDeviceIdentity } from "./virtualDeviceLifecycleCoordinator";
import {
  getVirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";
import { stableStringify } from "../utils/stableStringify";
import {
  defaultDisplayInventoryProvider,
  hydrateRequiredDisplayInventories,
  type DisplayInventoryProvider,
} from "./DisplayInventoryProvider";

const ABORT_SETTLEMENT_GRACE_MS = 1_000;
/** Bound on the iOS post-lease "did a sibling already boot this simulator" re-check (#9920). */
const IOS_POST_LEASE_RECHECK_TIMEOUT_MS = 5_000;

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

/** A live emulator with an unanswered AVD-name probe may be the requested image. */
export class AndroidAvdIdentityUnresolvedError extends ActionableError {
  readonly code = "target_identity_unresolved";
  readonly retryable = true;

  constructor(
    readonly avdName: string,
    readonly candidateSerials: readonly string[],
  ) {
    super(
      `target_identity_unresolved: Cannot prove whether Android AVD '${avdName}' is already running; ` +
        `AVD name is unavailable for ${candidateSerials.join(", ")}. Retry after identity discovery recovers.`,
    );
  }
}

function assertAndroidAvdIdentityResolved(devices: readonly BootedDevice[], avdName: string): void {
  const unresolved = devices
    .filter(
      (device) =>
        device.platform === "android" &&
        isAndroidEmulatorSerial(device.deviceId) &&
        device.name === `Unknown (${device.deviceId})`,
    )
    .map((device) => device.deviceId);
  if (unresolved.length > 0) {
    throw new AndroidAvdIdentityUnresolvedError(avdName, [...new Set(unresolved)].toSorted());
  }
}

function assertBootedMatchesImage(device: BootedDevice, image: DeviceInfo): void {
  if (image.platform !== "android") {
    return;
  }
  if (device.platform !== image.platform || device.name !== image.name) {
    throw new ActionableError(
      `target_identity_mismatch: Configured ${image.platform} image '${image.name}' ` +
        `(${image.deviceId ?? "no runtime ID"}) resolved to '${device.name}' (${device.deviceId}). ` +
        "Retry after device discovery refreshes.",
    );
  }
}

function assertExactRunningDiscovery(
  request: DeviceBootRequest,
  devices: readonly BootedDevice[],
): void {
  if (request.matchExactName && request.name && request.platform === "android") {
    assertAndroidAvdIdentityResolved(devices, request.name);
  }
}

function assertExactRunningName(request: DeviceBootRequest, device: BootedDevice): void {
  if (request.matchExactName && request.name && device.name !== request.name) {
    throw new ActionableError(
      `target_identity_mismatch: Requested ${request.platform} device '${request.name}' ` +
        `resolved to '${device.name}' (${device.deviceId}).`,
    );
  }
}

function assertExactAndroidImageDiscovery(
  image: DeviceInfo,
  booted: readonly BootedDevice[],
  exactTarget: boolean,
): void {
  if (!exactTarget || image.platform !== "android") {
    return;
  }
  assertAndroidAvdIdentityResolved(booted, image.name);
  const occupiedSerial =
    image.deviceId && isAndroidEmulatorSerial(image.deviceId)
      ? booted.find((device) => device.deviceId === image.deviceId && device.name !== image.name)
      : undefined;
  if (occupiedSerial) {
    throw new ActionableError(
      `target_identity_mismatch: Configured Android AVD '${image.name}' lists serial ` +
        `'${image.deviceId}', but that serial is running '${occupiedSerial.name}'. ` +
        "Refresh device inventory and retry.",
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

// DeviceBootService instances are per request, while a duplicate Android
// start is coordinated through the shared lifecycle coordinator. Keep the
// ownership marker at that process-local boundary until readiness settles.
const inFlightAndroidColdBoots = new WeakMap<
  VirtualDeviceLifecycleCoordinator,
  Map<string, number>
>();

export interface InFlightAndroidColdBootReader {
  /** AVD names with at least one in-flight (claimed, not yet released) Android cold boot. */
  listInFlightAndroidColdBootAvdNames(): readonly string[];
}

export function getInFlightAndroidColdBootReader(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = getVirtualDeviceLifecycleCoordinator(),
): InFlightAndroidColdBootReader {
  return {
    listInFlightAndroidColdBootAvdNames: () => [
      ...(inFlightAndroidColdBoots.get(lifecycleCoordinator)?.keys() ?? []),
    ],
  };
}

function notifyAndroidColdBootTrackingChanged(
  listener: DeviceBootServiceDependencies["onAndroidColdBootTrackingChanged"],
  avdName: string,
  phase: "claimed" | "released",
): void {
  try {
    listener?.(avdName, phase);
  } catch (error) {
    // Resource notification is advisory; listener failure must not fail the boot.
    logger.warn(
      `[DeviceBootService] Android cold-boot tracking listener failed: ${errorMessage(error)}`,
      error,
    );
  }
}

function trackInFlightAndroidColdBoot(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator,
  avdName: string,
  listener?: DeviceBootServiceDependencies["onAndroidColdBootTrackingChanged"],
): () => void {
  const boots = inFlightAndroidColdBoots.get(lifecycleCoordinator) ?? new Map<string, number>();
  inFlightAndroidColdBoots.set(lifecycleCoordinator, boots);
  const priorCount = boots.get(avdName) ?? 0;
  boots.set(avdName, priorCount + 1);
  if (priorCount === 0) {
    notifyAndroidColdBootTrackingChanged(listener, avdName, "claimed");
  }
  return () => {
    const remaining = (boots.get(avdName) ?? 1) - 1;
    if (remaining > 0) {
      boots.set(avdName, remaining);
      return;
    }
    boots.delete(avdName);
    if (boots.size === 0) {
      inFlightAndroidColdBoots.delete(lifecycleCoordinator);
    }
    notifyAndroidColdBootTrackingChanged(listener, avdName, "released");
  };
}

function hasInFlightAndroidColdBoot(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator,
  avdName: string,
): boolean {
  return (inFlightAndroidColdBoots.get(lifecycleCoordinator)?.get(avdName) ?? 0) > 0;
}

function trackInFlightAndroidColdBootIfNeeded(
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator,
  image: DeviceInfo,
  listener?: DeviceBootServiceDependencies["onAndroidColdBootTrackingChanged"],
): (() => void) | undefined {
  return image.platform === "android"
    ? trackInFlightAndroidColdBoot(lifecycleCoordinator, image.name, listener)
    : undefined;
}

function findBootedDeviceMatchingImage(
  image: DeviceInfo,
  booted: readonly BootedDevice[],
): BootedDevice | undefined {
  if (image.platform === "android") {
    const sameName = findUniqueBootedAndroidDeviceByName(booted, image.name);
    return sameName;
  }
  return image.deviceId ? booted.find((device) => device.deviceId === image.deviceId) : undefined;
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

/** Inputs which affect device discovery, creation, and readiness, but not MCP sessions or automation setup. */
export interface DeviceBootRequest {
  operationName?: string;
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  requires?: DeviceMatchCriteria["requires"];
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
  displayInventory?: DisplayInventoryProvider;
  deviceCreationGate: DeviceCreationGate;
  deviceProvisioner: DeviceProvisioner;
  matchingStrategy: MatchingStrategy;
  /** Defaults to no recovery so normal product and MCP boot never erases devices. */
  bootRecovery?: DeviceBootRecovery;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** Bind a selector reservation to canonical identity before mutating the device. */
  onIdentityResolved?: (identity: StableVirtualDeviceIdentity) => Promise<void>;
  lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator;
  /** Fired synchronously, fire-and-forget on the 0->1 claim and 1->0 release transitions. */
  onAndroidColdBootTrackingChanged?: (avdName: string, phase: "claimed" | "released") => void;
  /** Existing lease held by a caller through later session/readiness work. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
  /**
   * Called with the exit promise of an owned emulator that survived SIGTERM and
   * SIGKILL, so an injected lease's owner can hold it until the process is gone
   * (#9901). A lease this service reserves itself is held automatically.
   */
  retainLeaseUntil?: (settlement: Promise<void>) => void;
  /**
   * Set by a long-lived owner (the daemon): once the request is cancelled or out of budget, the
   * emulator's termination may carry on in the background while the lease stays held (#9920).
   * Left unset by a one-shot process (`--boot-device`) that exits as soon as `boot` returns,
   * which would take the SIGKILL escalation's timer down with it: there `boot` waits in full.
   */
  cleanupMayOutliveRequest?: boolean;
  /** Liveness probe for an emulator that survived SIGKILL; injected so tests never signal a real pid. */
  isProcessRunning?: (pid: number) => boolean;
  /** Opts an injected daemon lease into post-bind re-checks; deviceTools' reservation races tolerate shared cold boots. */
  allowExternalLeaseAdoptionRecheck?: boolean;
}

interface BootDeadlineContext {
  request: DeviceBootRequest;
  operationName: string;
  startedAtMs: number;
  deadlineMs: number;
  signal?: AbortSignal;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  ownsLifecycleLease: boolean;
  /** Exit promises of owned emulators that could not be confirmed dead; the lease outlives them. */
  unconfirmedProcessExits: Promise<void>[];
  /**
   * Terminations the request stopped waiting for (it was cancelled or out of budget). Each
   * settles only once its AVD is free, so the lease outlives them (#9920).
   */
  pendingTerminations: Promise<void>[];
  /**
   * The termination of a cancelled launch's child when this service cannot hold the lease for it.
   * The start phase rejects on the abort regardless, so the boot awaits this before it rejects.
   */
  unheldLaunchTermination?: Promise<OwnedTermination>;
  /** A fresh provision's cold boot opts Android readiness into offline recovery (#7054). */
  freshProvision?: boolean;
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
      request,
      operationName: request.operationName ?? "startDevice",
      startedAtMs: this.timer.now(),
      deadlineMs: request.totalDeadlineMs ?? this.timer.now() + timeoutMs,
      signal: request.signal,
      lifecycleLease: this.dependencies.lifecycleLease,
      ownsLifecycleLease: false,
      unconfirmedProcessExits: [],
      pendingTerminations: [],
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
            requires: request.requires,
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
      this.releaseOwnedLifecycleLease(context);
    }
  }

  private releaseOwnedLifecycleLease(context: BootDeadlineContext): void {
    if (!context.ownsLifecycleLease) {
      return;
    }
    const lease = context.lifecycleLease;
    if (context.unconfirmedProcessExits.length === 0 && context.pendingTerminations.length === 0) {
      lease?.release();
      return;
    }
    // An emulator this boot started is still running and holding its AVD lock
    // files: the stable key is not free until it actually exits (#9901), or a
    // liveness re-check finds its pid gone (#9920).
    void this.releaseOnceProcessesSettle(context, lease);
  }

  private async releaseOnceProcessesSettle(
    context: BootDeadlineContext,
    lease: VirtualDeviceLifecycleLease | undefined,
  ): Promise<void> {
    // A pending termination records its survivor in `unconfirmedProcessExits`
    // before it settles, so read that list only after the terminations are done.
    await Promise.allSettled(context.pendingTerminations);
    await Promise.allSettled(context.unconfirmedProcessExits);
    lease?.release();
  }

  private async bindLifecycleIdentity(
    context: BootDeadlineContext,
    identity: StableVirtualDeviceIdentity,
    revalidate: () => Promise<StableVirtualDeviceIdentity> = async () => identity,
  ): Promise<void> {
    if (context.lifecycleLease) {
      await context.lifecycleLease.bindCanonicalIdentity(identity, revalidate);
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
    const useDetailed = platform === "android" || presentationOrder !== undefined;
    const options: BootedDeviceDiscoveryOptions = {
      ...(bypassAndroidCache ? { bypassAndroidDeviceListCache: true } : {}),
      ...(presentationOrder !== undefined ? { presentationOrder } : {}),
    };
    if (useDetailed) {
      const discovery = await this.runPhase(
        context,
        phase,
        async () =>
          await this.dependencies.deviceManager.getBootedDevicesDetailed(platform, options),
        awaitAbortSettlement,
      );
      if (platform === "android" && !discovery.succeededPlatforms.has("android")) {
        throw new AndroidBootedDeviceDiscoveryIncompleteError(discovery.discoveryErrors?.android);
      }
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
      requires: request.requires,
      screenSize: request.screenSize,
    };
    const booted = await this.discoverBootedDevices(
      request.platform,
      context,
      "discovering running devices",
      request.platform === "android",
      true,
      request.presentationOrder,
    );
    const hasExplicitConstraints =
      request.minOsVersion !== undefined ||
      request.maxOsVersion !== undefined ||
      request.formFactor !== undefined ||
      request.requires !== undefined ||
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
        `Device '${request.deviceId}' does not satisfy the requested constraints. ${describeDisplayRequirements(criteria, [image])}`,
      );
    }
    // `deviceId` also accepts an AVD/image name (see getAndroidSchema), so the
    // serial lookup above cannot see an already-running image named this way.
    // Route through the same reuse-before-cold-boot path as the name matcher so
    // both spellings of the same target resolve identically (#3334): booting a
    // live image is rejected by the platform, or spawns a doomed second child.
    const result = await this.bootMatchedImage(
      image,
      context,
      progress,
      request.presentationOrder,
      request.preferRunning,
      request.platform === "android" && request.deviceId === image.name,
    );
    assertBootedMatchesImage(result.device, image);
    return result;
  }

  private async waitForKnownRunningDevice(
    running: BootedDevice,
    request: DeviceBootRequest & { deviceId: string },
    criteria: DeviceMatchCriteria,
    hasExplicitConstraints: boolean,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
  ): Promise<DeviceBootResult> {
    const enriched = await this.enrichKnownRunningDevice(
      running,
      request.deviceId,
      hasExplicitConstraints,
      context,
    );
    const [resolvedRunning] = await hydrateRequiredDisplayInventories(
      [enriched.device],
      criteria.requires,
      this.dependencies.displayInventory ?? defaultDisplayInventoryProvider,
      context.signal,
    );
    if (hasExplicitConstraints && !matchesDeviceCriteria(resolvedRunning, criteria)) {
      throw new ActionableError(
        `Device '${request.deviceId}' does not satisfy the requested constraints. ${describeDisplayRequirements(criteria, [{ ...resolvedRunning, booted: true }])}`,
      );
    }
    const result = await this.waitForRunningDevice(resolvedRunning, context, progress);
    return enriched.image
      ? {
          ...result,
          device: enrichBootedDevice(result.device, enriched.image),
          sourceImage: enriched.image,
        }
      : result;
  }

  private async enrichKnownRunningDevice(
    running: BootedDevice,
    requestedDeviceId: string,
    hasExplicitConstraints: boolean,
    context: BootDeadlineContext,
  ): Promise<{ device: BootedDevice; image: DeviceInfo | undefined }> {
    // Exact identity is authoritative, but a virtual device's configured image
    // remains the source of static display/capability/profile metadata.
    const needsIosRuntimeMetadata =
      running.platform === "ios" &&
      running.iosVersion === undefined &&
      running.osVersion === undefined;
    const needsConfiguredImage =
      running.platform === "android"
        ? isAndroidEmulatorSerial(running.deviceId)
        : running.deviceId.includes("-") && running.deviceId.length > 30;
    if (hasExplicitConstraints || needsIosRuntimeMetadata || needsConfiguredImage) {
      try {
        return await this.enrichBootedDeviceFromImage(running, context);
      } catch (error) {
        if (hasExplicitConstraints) {
          throw error;
        }
        logger.warn(
          `[DeviceBootService] Exact device '${requestedDeviceId}' metadata enrichment failed; adopting discovered device: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return { device: running, image: undefined };
  }

  private async enrichBootedDeviceFromImage(
    device: BootedDevice,
    context: BootDeadlineContext,
  ): Promise<{ device: BootedDevice; image: DeviceInfo | undefined }> {
    const images = await this.runPhase(
      context,
      `resolving ${device.platform} device metadata`,
      (signal) => this.dependencies.deviceManager.listDeviceImages(device.platform, signal),
    );
    const image = findImageForBootedDevice(device, images);
    return {
      device: image ? enrichBootedDevice(device, image) : device,
      image,
    };
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
      requires: request.requires,
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
    const bootedCandidates: BootedDevice[] = [];
    const running = await this.findRunningMatch(
      request,
      criteria,
      matchingImages,
      context,
      progress,
      bootedCandidates,
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
      const result = await this.bootMatchedImage(
        image,
        context,
        progress,
        request.presentationOrder,
        request.preferRunning,
        request.matchExactName === true,
      );
      if (request.matchExactName) {
        assertBootedMatchesImage(result.device, image);
      }
      return result;
    }
    if (request.matchExactName && request.name) {
      if (matchingImages.some((candidate) => candidate.name === request.name)) {
        throw new ActionableError(
          `No ${request.platform} device matching criteria found for exact target '${request.name}'. ` +
            describeDisplayRequirements(criteria, matchingImages),
        );
      }
      throw new ActionableError(
        `target_not_found: Configured ${request.platform} device '${request.name}' was not found; ` +
          "an exact target cannot be replaced or created by acquisition.",
      );
    }
    const candidates = [
      ...bootedCandidates,
      ...matchingImages.filter(
        (image) => !bootedCandidates.some((device) => device.name === image.name),
      ),
    ];
    return this.provisionAndBoot(
      request,
      provisionCriteria,
      matchingImages,
      context,
      progress,
      candidates,
    );
  }

  private async findRunningMatch(
    request: DeviceBootRequest,
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
    candidates?: BootedDevice[],
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
    assertExactRunningDiscovery(request, booted);
    const excludedDeviceNames = request.excludeDeviceNames;
    const excludedDeviceIds = request.excludeDeviceIds;
    const matchingBooted =
      excludedDeviceNames || excludedDeviceIds
        ? booted.filter(
            (device) =>
              !excludedDeviceNames?.has(device.name) && !excludedDeviceIds?.has(device.deviceId),
          )
        : booted;
    const enriched = await hydrateRequiredDisplayInventories(
      enrichBootedDevicesFromImages(matchingBooted, images),
      criteria.requires,
      this.dependencies.displayInventory ?? defaultDisplayInventoryProvider,
      context.signal,
    );
    candidates?.push(...enriched);
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
    const image = findImageForBootedDevice(match, images);
    const result = await this.waitForRunningDevice(match, context, progress);
    assertExactRunningName(request, result.device);
    return image
      ? { ...result, device: enrichBootedDevice(result.device, image), sourceImage: image }
      : result;
  }

  /**
   * Whether bootImage should re-check for a now-running device once its
   * lifecycle lease settles. Explicit cold-boot intent is never turned into
   * adoption (#7197). Android only does so behind an in-flight cold boot; iOS
   * has no marker, because a sibling boot of the same UDID holds the stable
   * lease this call is about to queue on, so its re-check always applies (#9902).
   */
  private shouldAdoptAfterLease(
    context: BootDeadlineContext,
    image: DeviceInfo,
    preferRunning: boolean | undefined,
    hasInFlightColdBoot: boolean,
  ): boolean {
    // The daemon's externally managed lease is held through its later
    // reservation/session handoff, which tolerates this shared-cold-boot
    // re-check via throwIfFreshStartAlreadyBound in deviceTools.
    const holdsLease =
      context.ownsLifecycleLease || this.dependencies.allowExternalLeaseAdoptionRecheck === true;
    const explicitColdBoot = preferRunning === false && !image.isRunning;
    return holdsLease && !explicitColdBoot && (image.platform === "ios" || hasInFlightColdBoot);
  }

  private async bootMatchedImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
    presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"],
    preferRunning?: boolean,
    exactTarget?: boolean,
  ): Promise<DeviceBootResult> {
    // A cached `isRunning: false` overlay can go stale: an externally started
    // same-name AVD (or several) may already be live. android always
    // re-discovers with a fresh cache-bypassing sweep before trusting the
    // overlay (#7178). iOS keeps trusting the cached flag here because its
    // identity (UDID) cannot silently collide the same way, but bootImage
    // re-checks the simulator after its UDID lease settles (#9902), so a
    // sibling acquisition that booted it meanwhile is adopted, not re-booted.
    if (!image.isRunning && image.platform !== "android") {
      return this.bootImage(
        image,
        context,
        progress,
        false,
        this.shouldAdoptAfterLease(context, image, preferRunning, false),
      );
    }
    const booted = await this.discoverBootedDevices(
      image.platform,
      context,
      "resolving the running device image",
      image.platform === "android",
      true,
      presentationOrder,
    );
    assertExactAndroidImageDiscovery(image, booted, exactTarget === true);
    // iOS simulators can share a display name, so only their UDID is lifecycle
    // identity. Android `deviceId` may instead name an AVD image, where name
    // fallback is required because the booted device carries an ADB serial.
    const running = findBootedDeviceMatchingImage(image, booted);
    // Android completes fresh discovery before this decision, even when a
    // caller explicitly wants a cold boot: uniqueness and completeness must
    // be proven before starting a same-name AVD. An in-flight transport is
    // likewise kept on the shared-launch path rather than adopted here.
    const hasInFlightColdBoot =
      image.platform === "android" &&
      hasInFlightAndroidColdBoot(this.lifecycleCoordinator, image.name);
    const explicitlyRequestedColdBoot = preferRunning === false && !image.isRunning;
    const adoptAfterLease = this.shouldAdoptAfterLease(
      context,
      image,
      preferRunning,
      hasInFlightColdBoot,
    );
    if (!running) {
      return this.bootImage(image, context, progress, false, adoptAfterLease);
    }
    if (hasInFlightColdBoot || explicitlyRequestedColdBoot) {
      // An in-flight owner may finish while this selector reservation waits to
      // bind the AVD's stable identity. Re-check only that case after binding:
      // explicit cold-boot intent must never be turned into adoption (#7197).
      return this.bootImage(image, context, progress, false, adoptAfterLease);
    }
    const result = await this.waitForRunningDevice(
      enrichBootedDevice(running, image),
      context,
      progress,
    );
    return { ...result, device: enrichBootedDevice(result.device, image), sourceImage: image };
  }

  private async provisionAndBoot(
    request: DeviceBootRequest,
    criteria: DeviceMatchCriteria,
    images: DeviceInfo[],
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
    candidates: readonly (BootedDevice | DeviceInfo)[] = images,
  ): Promise<DeviceBootResult> {
    const describedCandidates = candidates.map((candidate) => ({
      ...candidate,
      booted: "isRunning" in candidate ? candidate.isRunning : true,
    }));
    if (!this.dependencies.deviceCreationGate.isCreationAllowed(request.createIfMissing)) {
      throw new ActionableError(
        `No ${request.platform} device matching criteria found. ` +
          `${request.minOsVersion ? `minOsVersion>=${request.minOsVersion} ` : ""}` +
          `${request.maxOsVersion ? `maxOsVersion<=${request.maxOsVersion} ` : ""}` +
          `${request.name ? `name=${request.name} ` : ""}` +
          `${describeDisplayRequirements(criteria, describedCandidates)} ` +
          `Available images: ${images.map((device) => `${device.name}${device.osVersion ? ` (v${device.osVersion})` : ""}`).join(", ") || "none"}.`,
      );
    }
    if (criteria.requires?.panels !== undefined || criteria.requires?.posture !== undefined) {
      throw new ActionableError(describeDisplayRequirements(criteria, describedCandidates));
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
      runtimeId: provisioned.runtimeId,
      runtime: provisioned.runtime,
      deviceType: provisioned.deviceType,
    } as DeviceInfo;
    return this.bootImage(createdImage, context, progress, true);
  }

  private async waitForRunningDevice(
    device: BootedDevice,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    if (device.platform === "ios") {
      await this.bindLifecycleIdentity(
        context,
        {
          platform: "ios",
          stableId: device.deviceId,
        },
        async () => await this.revalidateRunningIdentity(device, context),
      );
    } else if (
      device.deviceId.startsWith("emulator-") &&
      device.name !== `Unknown (${device.deviceId})`
    ) {
      await this.bindLifecycleIdentity(
        context,
        {
          platform: "android",
          stableId: device.name,
        },
        async () => await this.revalidateRunningIdentity(device, context),
      );
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

  private async revalidateRunningIdentity(
    device: BootedDevice,
    context: BootDeadlineContext,
  ): Promise<StableVirtualDeviceIdentity> {
    const devices = await this.discoverBootedDevices(
      device.platform,
      context,
      "revalidating the running device after lifecycle wait",
      device.platform === "android",
    );
    const current = devices.find((candidate) => candidate.deviceId === device.deviceId);
    if (!current) {
      throw new ActionableError(
        "Selected running device disappeared during lifecycle wait; retry device selection",
      );
    }
    return {
      platform: current.platform,
      stableId: current.platform === "android" ? current.name : current.deviceId,
    };
  }

  private async revalidateImageIdentity(
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<StableVirtualDeviceIdentity> {
    const images = await this.runPhase(
      context,
      "revalidating the device image after lifecycle wait",
      (signal) => this.dependencies.deviceManager.listDeviceImages(image.platform, signal),
    );
    const request = context.request;
    const criteria: DeviceMatchCriteria = {
      platform: request.platform,
      name: request.name,
      minOsVersion: request.matchNamedDeviceIgnoringOsVersion ? undefined : request.minOsVersion,
      maxOsVersion: request.matchNamedDeviceIgnoringOsVersion ? undefined : request.maxOsVersion,
      formFactor: request.formFactor,
      requires: request.requires,
      screenSize: request.screenSize,
    };
    const eligible = images.filter(
      (candidate) =>
        !request.excludeDeviceNames?.has(candidate.name) &&
        matchesDeviceCriteria(candidate, criteria),
    );
    const current = request.deviceId
      ? eligible.find(
          (candidate) =>
            candidate.deviceId === request.deviceId || candidate.name === request.deviceId,
        )
      : request.matchExactName && request.name
        ? eligible.find((candidate) => candidate.name === request.name)
        : this.dependencies.deviceMatcher.matchDeviceImage(
            criteria,
            eligible,
            this.dependencies.matchingStrategy,
          );
    if (!current) {
      throw new ActionableError(
        "Selected device image disappeared during lifecycle wait; retry device selection",
      );
    }
    return {
      platform: current.platform,
      stableId: current.platform === "android" ? current.name : current.deviceId!,
    };
  }

  /**
   * The image's live device once its lifecycle lease settled, if another
   * acquisition (or an outside actor) booted it while this one was queued.
   * Android defers to a still-in-flight cold boot; iOS needs no marker because
   * a sibling boot of the same UDID holds the stable lease this call just won.
   */
  private async findRunningImageAfterLease(
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<BootedDevice | undefined> {
    const phase = "re-checking the running device after the shared lifecycle lease settled";
    if (image.platform === "android") {
      const booted = await this.discoverBootedDevices(image.platform, context, phase, true, true);
      const running = findUniqueBootedAndroidDeviceByName(booted, image.name);
      return running && !hasInFlightAndroidColdBoot(this.lifecycleCoordinator, image.name)
        ? running
        : undefined;
    }
    // Bypass the simulator-list cache: the cached list is what made this image
    // look stopped, and `startDevice` itself bypasses it before refusing a boot.
    // The image is a simctl simulator, so devicectl discovery cannot answer for its UDID.
    const discovery = await this.runPhase(context, phase, (signal) =>
      this.boundedIosRecheck(phase, signal, (recheckSignal) =>
        this.dependencies.deviceManager.getBootedDevicesDetailed(image.platform, {
          bypassIosDeviceListCache: true,
          skipPhysicalIosDiscovery: true,
          signal: recheckSignal,
        }),
      ),
    );
    // An unanswered inventory proves nothing; fall through to the boot path,
    // whose own running-state check reports an unreadable simulator list.
    return discovery?.succeededPlatforms.has("ios")
      ? findBootedDeviceMatchingImage(image, discovery.devices)
      : undefined;
  }

  /**
   * This optimization must never cost the boot its budget: a `simctl list` that
   * never answers is abandoned after its own short timeout (#9920) and the
   * caller falls through to the boot path, which reports the real state. Caller
   * abort and the boot deadline still win through `signal`.
   */
  private async boundedIosRecheck<T>(
    phase: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const recheck = new AbortController();
    const timedOut = new Error(`${phase} timed out`);
    try {
      return await raceWithDeadline(operation(AbortSignal.any([signal, recheck.signal])), {
        timer: this.timer,
        timeoutMs: IOS_POST_LEASE_RECHECK_TIMEOUT_MS,
        signal,
        label: phase,
        timeoutError: () => timedOut,
        onTimeout: () => recheck.abort(timedOut),
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.warn(
        `[startDevice] Simulator re-check did not answer within ${IOS_POST_LEASE_RECHECK_TIMEOUT_MS}ms; ` +
          "continuing to the boot path",
      );
      return undefined;
    }
  }

  private async bootImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
    adoptRunningAfterLease = false,
  ): Promise<DeviceBootResult> {
    assertAndroidImageRunningStateKnown(image);
    if (image.platform === "ios" && !image.deviceId) {
      throw new ActionableError("iOS simulator deviceId (UDID) is required to start a simulator.");
    }
    await this.bindLifecycleIdentity(
      context,
      {
        platform: image.platform,
        stableId: image.platform === "android" ? image.name : image.deviceId!,
      },
      async () => await this.revalidateImageIdentity(image, context),
    );
    if (adoptRunningAfterLease) {
      const running = await this.findRunningImageAfterLease(image, context);
      if (running) {
        const adopted = await this.waitForRunningDevice(
          enrichBootedDevice(running, image),
          context,
          progress,
        );
        // Another launch for this device may have just finished, so preserve the shared-boot marker for downstream session-conflict detection.
        return { ...adopted, sourceImage: image };
      }
    }
    // This outer marker spans every bootImageOnce invocation made by this
    // bootRecovery.run retry loop. bootImageOnce keeps an inner ref-counted
    // marker for waitForRunningDevice's direct recovery re-entry, which does
    // not pass through this wrapper.
    const releaseInFlightAndroidColdBoot = trackInFlightAndroidColdBootIfNeeded(
      this.lifecycleCoordinator,
      image,
      this.dependencies.onAndroidColdBootTrackingChanged,
    );
    try {
      return await this.bootRecovery.run(
        image,
        async () => this.bootImageOnce(image, context, progress, provisioned),
        context.signal,
      );
    } finally {
      releaseInFlightAndroidColdBoot?.();
    }
  }

  private async bootImageOnce(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    // This inner marker covers waitForRunningDevice's direct recovery retry,
    // while bootImage's outer marker covers its bootRecovery.run attempts.
    // They intentionally nest on the normal cold-boot path and ref-count.
    const releaseInFlightAndroidColdBoot = trackInFlightAndroidColdBootIfNeeded(
      this.lifecycleCoordinator,
      image,
      this.dependencies.onAndroidColdBootTrackingChanged,
    );
    try {
      return await this.bootImageOnceWithOwnedLaunchTracking(image, context, progress, provisioned);
    } catch (error) {
      // The start phase rejects on an abort without waiting for a cancelled launch's child, so a
      // service that cannot hold the lease confirms that child's exit before its caller sees the
      // failure (and may release a lease it owns).
      await context.unheldLaunchTermination;
      throw error;
    } finally {
      releaseInFlightAndroidColdBoot?.();
    }
  }

  private async bootImageOnceWithOwnedLaunchTracking(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
  ): Promise<DeviceBootResult> {
    let disposeStartHandleCancellation = () => {};
    const handle = await this.runPhase(context, "starting the device", async (signal) => {
      const started = await this.startDeviceOwningCancelledLaunch(image, context);
      const cancelStarted = () => {
        if (started) {
          // No lease ordering is possible here: the phase already rejected. Still escalate so
          // a late handle that ignores SIGTERM is not left running with nothing tracking it.
          void terminateColdBootProcess(started, image.name, this.timer).confirmed.catch(
            (error: unknown) => {
              logger.warn(
                `[startDevice] Late start handle cleanup failed for ${image.name}: ${errorMessage(error)}`,
                error,
              );
            },
          );
        }
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
    let termination: Promise<OwnedTermination> | undefined;
    let cleanupWait: Promise<OwnedTerminationWait> | undefined;
    // Idempotent: the abort listener, the readiness failure path and the catch
    // block share one termination, and the two that wait share one bounded wait.
    const cancelHandle = (): Promise<OwnedTermination> => {
      if (!handle) {
        return Promise.resolve({ state: "confirmed" });
      }
      termination ??= this.terminateOwnedHandle(handle, image, context);
      return termination;
    };
    const awaitCleanup = (): Promise<OwnedTerminationWait> => {
      cleanupWait ??= this.awaitOwnedCleanup(cancelHandle(), context);
      return cleanupWait;
    };
    const cancelOnAbort = () => {
      void cancelHandle();
    };
    context.signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      await this.reportProgress(context, progress, 60, "Device started, waiting for readiness...");
      const ready = await this.runPhase(context, "waiting for device boot readiness", () =>
        waitForDeviceReadyOrCancel(
          this.dependencies.deviceManager,
          image,
          handle,
          this.remaining(context, "waiting for device boot readiness"),
          context.signal,
          this.timer,
          async () => {
            await awaitCleanup();
          },
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
      const wait = await awaitCleanup();
      throw annotateTerminationOutcome(error, wait, handle);
    } finally {
      context.signal?.removeEventListener("abort", cancelOnAbort);
    }
  }

  /**
   * Terminates the emulator this boot started (never an adopted one). A survivor
   * is marked on the lease and watched until its pid is gone, and that watch is
   * retained so the AVD's lifecycle lease is not handed out while it still holds
   * the AVD (#9901); the watch's liveness re-check bounds how long (#9920).
   */
  private async terminateOwnedHandle(
    handle: ChildProcess,
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<OwnedTermination> {
    const outcome = await terminateOwnedEmulatorProcess(handle, image.name, this.timer, {
      markHeldByUnkillableProcess: (pid) =>
        context.lifecycleLease?.markHeldByUnkillableProcess?.(pid),
      isProcessRunning: this.dependencies.isProcessRunning,
    });
    if (outcome.state === "survived") {
      context.unconfirmedProcessExits.push(outcome.gone);
      this.dependencies.retainLeaseUntil?.(outcome.gone);
    }
    return outcome;
  }

  /**
   * Waits for the owned emulator's termination, but only while the request is
   * live. When the request is cancelled or out of budget the cleanup carries on
   * in the background and keeps the lease held (#9920), but only for a long-lived
   * owner (`cleanupMayOutliveRequest`) with a lease it can hold. A one-shot CLI
   * process, or a lease this service does not own and cannot hand the survivor
   * to, is still waited on in full.
   */
  private async awaitOwnedCleanup(
    termination: Promise<OwnedTermination>,
    context: BootDeadlineContext,
  ): Promise<OwnedTerminationWait> {
    if (!this.canHoldCleanup(context)) {
      return (await termination).state;
    }
    const wait = await awaitTerminationWithinRequest(termination, {
      timer: this.timer,
      deadlineMs: context.deadlineMs,
      signal: context.signal,
    });
    if (wait === "pending") {
      this.holdLeaseUntilSettled(termination, context);
    }
    return wait;
  }

  /**
   * Whether the cleanup of an emulator this boot started may outlive the request:
   * a long-lived owner (`cleanupMayOutliveRequest`) with a lease it can hold.
   */
  private canHoldCleanup(context: BootDeadlineContext): boolean {
    return (
      this.dependencies.cleanupMayOutliveRequest === true &&
      (context.ownsLifecycleLease || this.dependencies.retainLeaseUntil !== undefined)
    );
  }

  /**
   * Keeps the AVD's lifecycle lease held until `termination` has settled (and, for a
   * survivor, until it is finally gone): the request stopped waiting for it.
   */
  private holdLeaseUntilSettled(
    termination: Promise<OwnedTermination>,
    context: BootDeadlineContext,
  ): void {
    const settled = termination.then(
      (outcome) => (outcome.state === "survived" ? outcome.gone : undefined),
      () => undefined,
    );
    context.pendingTerminations.push(settled);
    this.dependencies.retainLeaseUntil?.(settled);
  }

  /**
   * Starts the device, and when the launch is cancelled after the emulator was
   * spawned (a cancel during its startup validation), takes the child from the
   * cancellation error: it terminates it with the same SIGTERM -> bounded wait ->
   * SIGKILL escalation as any other owned handle and holds the lease until the exit
   * is confirmed. The phase rejects on the abort regardless, so this must register
   * its hold before returning (#10075).
   */
  private async startDeviceOwningCancelledLaunch(
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<ChildProcess | null> {
    try {
      return await this.dependencies.deviceManager.startDevice(
        image,
        this.remaining(context, "starting the device"),
      );
    } catch (error) {
      if (isEmulatorLaunchCancelledError(error) && error.process) {
        this.ownCancelledLaunchTermination(
          this.terminateOwnedHandle(error.process, image, context),
          context,
        );
      }
      throw error;
    }
  }

  /**
   * A service that can hold the lease keeps it until the termination settles and
   * lets the phase reject at once. One that cannot (a lease it neither owns nor can
   * retain, or a one-shot owner) records the termination on the context and `boot`
   * awaits it before the failure reaches the caller, so the caller never releases its
   * lease while the child is still shutting down. A child that survives SIGKILL is the
   * one case left uncovered there, as in `awaitOwnedCleanup`: it is logged and the
   * caller's lease is released.
   */
  private ownCancelledLaunchTermination(
    termination: Promise<OwnedTermination>,
    context: BootDeadlineContext,
  ): void {
    if (this.canHoldCleanup(context)) {
      this.holdLeaseUntilSettled(termination, context);
      return;
    }
    context.unheldLaunchTermination = termination;
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
    if (context.signal?.aborted) {
      throw new ActionableError(`startDevice cancelled while ${phase}`);
    }
    return await runPhaseWithSettlement(
      {
        timer: this.timer,
        timeoutMs: remainingMs,
        signal: context.signal,
        graceMs: ABORT_SETTLEMENT_GRACE_MS,
        label: phase,
        timeoutError: () => this.timeoutError(context, phase),
        defaultAbortError: () => new ActionableError(`startDevice cancelled while ${phase}`),
        awaitAbortSettlement,
        preferOperationFailureOnTimeout: true,
      },
      (signal) => runWithAbortSignal(signal, () => operation(signal)),
    );
  }

  private timeoutError(context: BootDeadlineContext, phase: string): DeviceBootTimeoutError {
    return new DeviceBootTimeoutError(
      context.operationName,
      phase,
      this.timer.now() - context.startedAtMs,
      Math.max(0, context.deadlineMs - context.startedAtMs),
    );
  }
}

// oxlint-disable-next-line complexity -- explicit per-field fallback keeps configured-image precedence auditable.
export function enrichBootedDevice(device: BootedDevice, image: DeviceInfo): BootedDevice {
  return {
    ...device,
    iosVersion: device.iosVersion ?? image.iosVersion,
    apiLevel: device.apiLevel ?? image.apiLevel,
    osVersion: device.osVersion ?? image.osVersion,
    runtimeId: device.runtimeId ?? image.runtimeId,
    runtime: device.runtime ?? image.runtime,
    deviceType: device.deviceType ?? image.deviceType,
    formFactor: device.formFactor ?? image.formFactor,
    screenWidth: device.screenWidth ?? image.screenWidth,
    screenHeight: device.screenHeight ?? image.screenHeight,
    screenDensity: device.screenDensity ?? image.screenDensity,
    model: device.model ?? image.model,
    architecture: device.architecture ?? image.architecture,
    capabilityInventory: device.capabilityInventory ?? image.capabilityInventory,
  };
}

function findImageForBootedDevice(
  device: BootedDevice,
  images: readonly DeviceInfo[],
): DeviceInfo | undefined {
  return images.find(
    (image) =>
      image.platform === device.platform &&
      (image.deviceId === device.deviceId ||
        (device.platform === "android" &&
          isAndroidEmulatorSerial(device.deviceId) &&
          image.name === device.name)),
  );
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

/**
 * Reports the original boot failure with the cleanup outcome added as context.
 * The error is never mutated (it may be the caller's own abort reason, and a
 * DOMException's message is read-only): an annotated copy keeps the class so
 * callers' type checks still classify it, and anything that cannot be copied
 * is wrapped with the original as `cause`.
 */
function annotateTerminationOutcome(
  error: unknown,
  wait: OwnedTerminationWait,
  handle: ChildProcess | null,
): unknown {
  const pid = handle?.pid ?? "unknown";
  if (wait === "survived") {
    return withCleanupNote(
      error,
      `Cleanup also failed: emulator process ${pid} did not exit after SIGTERM and SIGKILL, ` +
        "so its AVD stays reserved until the process is gone (its liveness is re-checked " +
        "periodically); terminate that process manually if it does not.",
    );
  }
  if (wait === "unobservable") {
    return withCleanupNote(
      error,
      `Cleanup also failed: the exit of emulator process ${pid} could not be observed, so its ` +
        "AVD was released; terminate that process manually if it is still running.",
    );
  }
  return error;
}

function withCleanupNote(error: unknown, note: string): unknown {
  if (error instanceof Error && !(error instanceof DOMException)) {
    const copy: Error = Object.create(
      Object.getPrototypeOf(error),
      Object.getOwnPropertyDescriptors(error),
    );
    Object.defineProperty(copy, "message", {
      value: `${error.message} ${note}`,
      writable: true,
      configurable: true,
    });
    return copy;
  }
  return new ActionableError(`${errorMessage(error)} ${note}`, { cause: error });
}
