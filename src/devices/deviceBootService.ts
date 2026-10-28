import type { BootedDevice, DeviceInfo, Platform } from "../models";
import { ActionableError, requireAndroidOrIosPlatform } from "../models";
import { DeviceAlreadyRunningError } from "../models/DeviceAlreadyRunningError";
import type { DeviceMatchCriteria } from "../models/DeviceMatchCriteria";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { errorMessage } from "../utils/describeUnknownError";
import { describeDisplayRequirements, matchesDeviceCriteria } from "../utils/deviceMatcher";
import { logger } from "../utils/logger";
import { DeviceBootExecution } from "./DeviceBootExecution";
import {
  defaultDisplayInventoryProvider,
  hydrateRequiredDisplayInventories,
} from "./DisplayInventoryProvider";
import { assertExactAndroidImageDiscovery } from "./androidBootIdentity";
import { bootAdmissionServices } from "./bootAdmissionServices";
import { enrichBootedDevice, findImageForBootedDevice } from "./bootedDeviceEnrichment";
import type { BootDeadlineContext } from "./deviceBootContext";
import { NoopDeviceBootRecovery, type DeviceBootRecovery } from "./deviceBootRecovery";
import {
  boundedIosRecheck,
  findRunningImageAfterLease,
  revalidateImageIdentity,
  revalidateRunningIdentity,
} from "./deviceBootRevalidation";
import {
  type AdoptAfterLease,
  assertBootedMatchesImage,
  assertExactRunningDiscovery,
  assertExactRunningName,
  assertRequestedNameVerifiable,
  createdImageFor,
  type DeviceBootProgress,
  type DeviceBootRequest,
  type DeviceBootResult,
  type DeviceBootServiceDependencies,
  enrichBootedDevicesFromImages,
  findBootedDeviceMatchingImage,
  findEligibleExactBootedDevice,
  hasExplicitSpecConstraints,
  hasInFlightAndroidColdBoot,
  isExcludedImage,
  noMatchingDeviceError,
  trackInFlightAndroidColdBootIfNeeded,
} from "./deviceBootSelection";
import type {
  DeviceProvisioningIdentityHooks,
  ProvisionedDevice,
  ProvisioningCreateIdentity,
} from "./deviceProvisioning";
import {
  assertAndroidImageRunningStateKnown,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  type BootedDeviceDiscoveryOptions,
} from "./deviceUtils";
import { ProvisionDeviceCreateRejectedError } from "./exactDeviceProvisioning";
import type { StableVirtualDeviceIdentity } from "./virtualDeviceLifecycleCoordinator";
import {
  getVirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
  selectorLifecycleIdentity,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";
export { AndroidAvdIdentityConflictError } from "./AndroidAvdIdentityConflictError";
export { AndroidAvdIdentityUnresolvedError } from "./AndroidAvdIdentityUnresolvedError";
export { AndroidDeviceIdentityUnresolvedError } from "./AndroidDeviceIdentityUnresolvedError";
export { DeviceBootTimeoutError } from "./DeviceBootTimeoutError";
export { enrichBootedDevice } from "./bootedDeviceEnrichment";
export {
  type DeviceBootProgress,
  type DeviceBootRequest,
  type DeviceBootResult,
  type DeviceBootServiceDependencies,
  enrichBootedDevicesFromImages,
  findUniqueBootedAndroidDeviceByName,
  getInFlightAndroidColdBootReader,
  type InFlightAndroidColdBootReader,
} from "./deviceBootSelection";

// Defined beside the other typed models so the boot admission gates can throw it too (#11236).
export {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../models/BootedDeviceDiscoveryIncompleteError";

/**
 * Product boot boundary shared by MCP and daemon-free callers.
 *
 * It deliberately does not create MCP sessions, update resources, or start
 * CtrlProxy. Those are application concerns layered on by `startDevice`.
 */
export class DeviceBootService {
  private readonly execution: DeviceBootExecution;
  private readonly bootRecovery: DeviceBootRecovery;
  private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  private readonly lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;

  constructor(private readonly dependencies: DeviceBootServiceDependencies) {
    this.bootRecovery = dependencies.bootRecovery ?? new NoopDeviceBootRecovery();
    this.timer = dependencies.timer ?? defaultTimer;
    this.execution = new DeviceBootExecution(dependencies, this.timer);
    this.lifecycleCoordinator =
      dependencies.lifecycleCoordinator ??
      (dependencies.timer
        ? new InMemoryVirtualDeviceLifecycleCoordinator(dependencies.timer)
        : getVirtualDeviceLifecycleCoordinator());
  }

  async boot(request: DeviceBootRequest, progress?: DeviceBootProgress): Promise<DeviceBootResult> {
    if (request.cameraPosterPath !== undefined && request.platform !== "android") {
      throw new ActionableError(
        "cameraPosterPath is unsupported on iOS. Use a stopped Android emulator.",
      );
    }
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
        selectorLifecycleIdentity(request.platform, request),
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
    const booted = await this.execution.discoverBootedDevices(
      request.platform,
      context,
      "discovering running devices",
      request.platform === "android",
      true,
      request.presentationOrder,
    );
    const hasExplicitConstraints = hasExplicitSpecConstraints(request);
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
    // Discovery filters foreign devices using a potentially stale inventory snapshot.
    // Check the literal ID afresh; an AVD name must not be mapped to a serial claim.
    const assertNotForeignOwned = this.dependencies.assertExplicitDeviceNotForeignOwned;
    if (assertNotForeignOwned) {
      await this.execution.runPhase(context, "checking explicit device ownership", () =>
        assertNotForeignOwned(request.deviceId, request.platform),
      );
    }
    const images = await this.execution.runPhase(context, "listing device images", () =>
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
    assertRequestedNameVerifiable(request, running);
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
        return await this.execution.enrichBootedDeviceFromImage(running, context);
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
    const images = await this.execution.runPhase(context, "listing device images", () =>
      deviceManager.listDeviceImages(request.platform),
    );
    const matchingImages = images.filter(
      (image) => !isExcludedImage(image, request.excludeDeviceNames, request.excludeDeviceIds),
    );
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
    const booted = await this.execution.discoverBootedDevices(
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
        : this.matchBootedPreferringUndeferred(criteria, enriched, request.deferDeviceIds);
    if (!match) {
      return undefined;
    }
    await this.execution.reportProgress(context, progress, 100, "Found matching running device");
    const image = findImageForBootedDevice(match, images);
    const result = await this.waitForRunningDevice(match, context, progress);
    assertExactRunningName(request, result.device);
    return image
      ? { ...result, device: enrichBootedDevice(result.device, image), sourceImage: image }
      : result;
  }

  /** The strategy's pick among the booted devices not deferred, else among all of them. */
  private matchBootedPreferringUndeferred(
    criteria: DeviceMatchCriteria,
    booted: BootedDevice[],
    deferred: ReadonlySet<string> | undefined,
  ): BootedDevice | null {
    const { deviceMatcher, matchingStrategy } = this.dependencies;
    const preferred = deferred?.size
      ? booted.filter((device) => !deferred.has(device.deviceId))
      : booted;
    return (
      deviceMatcher.matchBootedDevice(criteria, preferred, matchingStrategy) ??
      (preferred.length < booted.length
        ? deviceMatcher.matchBootedDevice(criteria, booted, matchingStrategy)
        : null)
    );
  }

  /**
   * When bootImage should re-check for a now-running device once its
   * lifecycle lease settles. Explicit cold-boot intent is never turned into
   * adoption (#7197). iOS has no marker, because a sibling boot of the same UDID
   * holds the stable lease this call is about to queue on, so its re-check always
   * applies (#9902). Android always re-checks behind an in-flight cold boot. That
   * marker is read before the lease wait, though, and a sibling queued on the same
   * lease has not claimed it yet, so an Android start that had to wait for the
   * lease re-checks too instead of cold-booting an AVD that is now running (#11565).
   */
  private adoptAfterLeasePolicy(
    context: BootDeadlineContext,
    image: DeviceInfo,
    preferRunning: boolean | undefined,
    hasInFlightColdBoot: boolean,
  ): AdoptAfterLease {
    // The daemon's externally managed lease is held through its later
    // reservation/session handoff, which tolerates this shared-cold-boot
    // re-check via throwIfFreshStartAlreadyBound in deviceTools.
    const holdsLease =
      context.ownsLifecycleLease || this.dependencies.allowExternalLeaseAdoptionRecheck === true;
    const explicitColdBoot = preferRunning === false && !image.isRunning;
    if (!holdsLease || explicitColdBoot) {
      return "never";
    }
    return image.platform === "ios" || hasInFlightColdBoot ? "always" : "if-queued";
  }

  private async bootMatchedImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
    presentationOrder?: BootedDeviceDiscoveryOptions["presentationOrder"],
    preferRunning?: boolean,
    exactTarget?: boolean,
  ): Promise<DeviceBootResult> {
    // Watch boot is not implemented yet (#14908); refuse before the iOS path can claim it.
    const platform = requireAndroidOrIosPlatform(image.platform, "Starting a device");
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
        this.adoptAfterLeasePolicy(context, image, preferRunning, false),
      );
    }
    const booted = await this.execution.discoverBootedDevices(
      platform,
      context,
      "resolving the running device image",
      image.platform === "android",
      true,
      presentationOrder,
    );
    assertExactAndroidImageDiscovery(
      image,
      booted,
      exactTarget === true,
      context.freshProvision === true,
    );
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
    const adoptAfterLease = this.adoptAfterLeasePolicy(
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
      throw noMatchingDeviceError(request, criteria, images, describedCandidates);
    }
    if (criteria.requires?.panels !== undefined || criteria.requires?.posture !== undefined) {
      throw new ActionableError(describeDisplayRequirements(criteria, describedCandidates));
    }
    // Nothing running or warm can serve the request, so it would create and cold-boot: refuse
    // before creating when that boot would be refused anyway (#11236).
    const checkBootCapacity =
      this.dependencies.checkBootCapacity ??
      ((platform: Platform, signal?: AbortSignal) =>
        bootAdmissionServices.assertBootCapacityAvailable(platform, { signal }));
    await this.execution.runPhase(context, "checking boot capacity", (signal) =>
      checkBootCapacity(criteria.platform, signal),
    );
    let created: ProvisionedDevice | undefined;
    // Set before the platform create runs: a cancelled or timed-out create may
    // still have created the device under this identity (#11155).
    let creationStarted: ProvisioningCreateIdentity | undefined;
    let provisioning: Promise<ProvisionedDevice> | undefined;
    const identityHooks = this.provisioningIdentityHooks(
      context,
      (device) => {
        created = device;
      },
      (identity) => {
        creationStarted = identity;
      },
    );
    try {
      const provisioned = await this.execution.runPhase(
        context,
        "provisioning a device",
        (signal) => {
          provisioning = this.dependencies.deviceProvisioner.provision(
            criteria,
            signal,
            identityHooks,
          );
          return provisioning;
        },
      );
      created = provisioned;
      const boot = await this.bootImage(
        createdImageFor(provisioned, request),
        context,
        progress,
        true,
      );
      return {
        ...boot,
        ...(provisioned.prebootDisabledResources
          ? { prebootDisabledResources: provisioned.prebootDisabledResources }
          : {}),
      };
    } catch (error) {
      await this.rollbackFailedProvisioning(request, error, {
        created,
        creationStarted,
        provisioning,
      });
      throw error;
    }
  }

  private async rollbackFailedProvisioning(
    request: DeviceBootRequest,
    error: unknown,
    {
      created,
      creationStarted,
      provisioning,
    }: {
      created: ProvisionedDevice | undefined;
      creationStarted: ProvisioningCreateIdentity | undefined;
      provisioning: Promise<ProvisionedDevice> | undefined;
    },
  ): Promise<void> {
    if (created) {
      await this.dependencies.rollbackCreatedDevice?.(createdImageFor(created, request), error);
    } else if (creationStarted && !(error instanceof ProvisionDeviceCreateRejectedError)) {
      // The platform tool did not report its outcome. Roll back whatever it
      // created under the claimed identity once the create settles.
      await this.dependencies.rollbackCreatedDevice?.(
        createdImageFor(creationStarted, request),
        error,
        { pendingCreation: provisioning },
      );
    }
  }

  /** Binds a created device's lifecycle identity, reporting it as created first. */
  private provisioningIdentityHooks(
    context: BootDeadlineContext,
    onCreated: (device: ProvisionedDevice) => void,
    onCreationStarting: (identity: ProvisioningCreateIdentity) => void,
  ): DeviceProvisioningIdentityHooks {
    return {
      reserveBeforeCreate: async (identity) => {
        if (identity.platform === "android") {
          await this.bindLifecycleIdentity(context, {
            platform: "android",
            stableId: identity.name,
          });
        }
        onCreationStarting(identity);
        return context.signal;
      },
      bindAfterCreate: async (device) => {
        onCreated(device);
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
  }

  private async waitForRunningDevice(
    device: BootedDevice,
    context: BootDeadlineContext,
    progress?: DeviceBootProgress,
  ): Promise<DeviceBootResult> {
    if (context.request.cameraPosterPath !== undefined) {
      throw new ActionableError(
        !isAndroidEmulatorSerial(device.deviceId)
          ? "cameraPosterPath is unsupported on physical Android devices. Use a stopped Android emulator."
          : "cameraPosterPath is unsupported on a running Android emulator. Stop it before requesting a poster.",
      );
    }
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
        const ready = await this.execution.runPhase(
          context,
          "waiting for a running device",
          (signal) =>
            this.dependencies.deviceManager.waitForDeviceReady(
              { ...device, isRunning: true },
              this.execution.remaining(context, "waiting for a running device"),
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
    return revalidateRunningIdentity({ execution: this.execution }, device, context);
  }

  private async revalidateImageIdentity(
    image: DeviceInfo,
    context: BootDeadlineContext,
  ): Promise<StableVirtualDeviceIdentity> {
    return revalidateImageIdentity(
      { execution: this.execution, dependencies: this.dependencies },
      image,
      context,
    );
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
    boundedIosRecheck = true,
  ): Promise<BootedDevice | undefined> {
    return findRunningImageAfterLease(
      {
        execution: this.execution,
        dependencies: this.dependencies,
        lifecycleCoordinator: this.lifecycleCoordinator,
        timer: this.timer,
      },
      image,
      context,
      boundedIosRecheck,
    );
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
    return boundedIosRecheck({ timer: this.timer }, phase, signal, operation);
  }

  private async bootImage(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
    adoptAfterLease: AdoptAfterLease = "never",
  ): Promise<DeviceBootResult> {
    context.deviceLabel = image.deviceId ? `${image.name} (${image.deviceId})` : image.name;
    if (image.isRunningStateKnown === false) {
      image = await this.execution.recheckRunningState(image, context);
    }
    assertAndroidImageRunningStateKnown(image);
    if (image.platform === "ios" && !image.deviceId) {
      throw new ActionableError("iOS simulator deviceId (UDID) is required to start a simulator.");
    }
    // The lease asks for revalidation exactly when another owner held the identity first.
    let queuedBehindLease = false;
    await this.bindLifecycleIdentity(
      context,
      {
        platform: image.platform,
        stableId: image.platform === "android" ? image.name : image.deviceId!,
      },
      async () => {
        queuedBehindLease = true;
        return await this.revalidateImageIdentity(image, context);
      },
    );
    const adoptRunningAfterLease =
      adoptAfterLease === "always" || (adoptAfterLease === "if-queued" && queuedBehindLease);
    if (adoptRunningAfterLease) {
      const adopted = await this.adoptRunningImageAfterLease(image, context, progress);
      if (adopted) {
        return adopted;
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
        async () =>
          this.bootImageAdoptingAlreadyRunning(
            image,
            context,
            progress,
            provisioned,
            adoptRunningAfterLease,
          ),
        context.signal,
      );
    } finally {
      releaseInFlightAndroidColdBoot?.();
    }
  }

  private async adoptRunningImageAfterLease(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    boundedIosRecheck = true,
  ): Promise<DeviceBootResult | undefined> {
    const running = await this.findRunningImageAfterLease(image, context, boundedIosRecheck);
    if (!running) {
      return undefined;
    }
    const adopted = await this.waitForRunningDevice(
      enrichBootedDevice(running, image),
      context,
      progress,
    );
    // Another launch for this device may have just finished, so preserve the shared-boot marker for downstream session-conflict detection.
    return { ...adopted, sourceImage: image };
  }

  /**
   * An iOS post-lease re-check that timed out falls through to the boot path,
   * whose own running-state check can then find a sibling's simulator booted
   * and refuse with a typed error. Adopt it exactly as the re-check would have.
   * This runs inside the recovery callback so a recovery policy never mistakes
   * a sibling's boot for a failed one.
   */
  private async bootImageAdoptingAlreadyRunning(
    image: DeviceInfo,
    context: BootDeadlineContext,
    progress: DeviceBootProgress | undefined,
    provisioned: boolean,
    adoptRunningAfterLease: boolean,
  ): Promise<DeviceBootResult> {
    try {
      return await this.bootImageOnce(image, context, progress, provisioned);
    } catch (error) {
      if (
        !adoptRunningAfterLease ||
        image.platform !== "ios" ||
        !(error instanceof DeviceAlreadyRunningError)
      ) {
        throw error;
      }
      const adopted = await this.adoptRunningImageAfterLease(image, context, progress, false);
      if (!adopted) {
        throw error;
      }
      return adopted;
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
      return await this.execution.bootImageOnceWithOwnedLaunchTracking(
        image,
        context,
        progress,
        provisioned,
      );
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
}
