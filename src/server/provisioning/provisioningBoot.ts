import { currentBindingReconciler } from "../../daemon/sessionBroker/provisioning/exclusion";
import type { InternalProvisionDeviceArgs } from "../../features/deviceLifecycle/core/contracts";
import { toProvisionDeviceError } from "./provisioningErrors";
import { errorMessage } from "../../utils/describeUnknownError";
import { consumeVerifiedBootCapacity } from "../../devices/bootAdmission/VerifiedBootCapacity";
import type { DeviceResourceConfigurationResult } from "../../models/DeviceResourceConfiguration";
import { PlatformDeviceManager } from "../../devices/deviceUtils";
import { BootedDevice, Platform } from "../../models";
import { logger } from "../../utils/logger";
import { createPerformanceTracker } from "../../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../../utils/PerfContext";
import { DEVICE_POOL_MATCHING } from "../../daemon/poolConfig";
import { type DeviceCreationGate } from "../../devices/deviceCreationGate";
import { reconcileDiscoveryObservation } from "../../daemon/discoveryReconcile";
import { isUnresolvedAndroidEmulatorName } from "../../devices/deviceIdentityEvidence";
import type { DeviceReadinessReservation } from "../../daemon/devicePool";
import { DeviceBootService, type DeviceBootResult } from "../../devices/deviceBootService";
import { type Timer } from "../../utils/SystemTimer";
import { fixedBackoff } from "../../utils/Backoff";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { combineAbortSignals } from "../../utils/AbortContext";
import {
  deviceReadinessLockKey,
  trackDeviceAcquisitionReadiness,
} from "../../utils/deviceReadinessLock";
import { serverConfig } from "../../utils/ServerConfig";
import { START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS } from "../../utils/deviceTimeouts";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceError,
} from "../../devices/exactDeviceProvisioning";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import {
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  cancelUnownedColdBootUnlessRetryable,
  clearColdBootShutdownMarker,
  findExactProvisionedBootedDevice,
  publishWarmDeviceReady,
  runProvisionDeviceWithinDeadline,
  validatePooledDeviceMapping,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import {
  type ProvisionBootOptions,
  type ProvisionBootResult,
  type ProvisioningContext,
} from "./provisioningTypes";
import { admitRestartReservedProvision, bindProvisionedDeviceSession } from "./provisioningSession";
import { applyProvisionDeviceProfile, provisionableDeviceSpec } from "./provisioningDeviceProfile";
import {
  applyProvisionDeviceResources,
  ensureProvisionDeviceReadiness,
  recordProvisionedDeviceStarted,
  reserveProvisionDeviceReadiness,
} from "./provisioningReadiness";

export async function provisionExactDevice(
  args: ProvisionDeviceArgs,
  provisioner: ExactDeviceProvisioner,
  perf: ReturnType<typeof createPerformanceTracker>,
  timer: Timer,
  {
    totalDeadlineMs,
    markDeviceCreationStarted,
    lifecycleLease,
    collectPendingSettlement,
    signal,
    checkBootCapacity,
  }: {
    totalDeadlineMs: number;
    checkBootCapacity: (platform: Platform, signal?: AbortSignal) => Promise<void>;
    markDeviceCreationStarted: () => void;
    lifecycleLease: VirtualDeviceLifecycleLease;
    collectPendingSettlement: (settlement: Promise<unknown>) => void;
    signal: AbortSignal | undefined;
  },
): Promise<Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>> {
  perf.startOperation("provisionExactDevice");
  try {
    // Establish `perf` as the ambient tracker (only under --debug-perf; see
    // ambientPerfFor) so the exact provisioner and every platform CLI it drives
    // (avdmanager, sdkmanager, adb, simctl, xcodebuild) record their command
    // spans into this same timing tree.
    return await runWithPerfTracker(ambientPerfFor(perf), () =>
      runProvisionDeviceWithinDeadline(
        timer,
        totalDeadlineMs,
        signal,
        "provisioning the exact device",
        async (deadlineSignal) =>
          await provisioner.provision({
            platform: args.device.platform,
            name: args.device.name,
            ...(args.device.deviceId === undefined ? {} : { deviceId: args.device.deviceId }),
            spec: provisionableDeviceSpec(args),
            onBeforeCreate: markDeviceCreationStarted,
            // A device created only to be refused at boot would then be deleted (#11236).
            ...(args.boot
              ? {
                  assertCapacityBeforeCreate: async (capacitySignal?: AbortSignal) => {
                    capacitySignal?.throwIfAborted();
                    if (!consumeVerifiedBootCapacity(args.device)) {
                      await checkBootCapacity(args.device.platform, capacitySignal);
                    }
                  },
                }
              : {}),
            lifecycleLease,
            deadlineMs: totalDeadlineMs,
            signal: deadlineSignal,
          }),
        collectPendingSettlement,
      ),
    );
  } finally {
    perf.endOperation("provisionExactDevice");
  }
}

function createProvisionBootService(
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  deviceCreationGate: DeviceCreationGate,
  lifecycleLease: VirtualDeviceLifecycleLease,
): DeviceBootService {
  return new DeviceBootService({
    deviceManager,
    deviceMatcher: deps.deviceMatcherFactory(),
    displayInventory: deps.displayInventory,
    deviceCreationGate,
    deviceProvisioner: deps.deviceProvisionerFactory(),
    matchingStrategy: DEVICE_POOL_MATCHING,
    timer: deps.timer,
    lifecycleLease,
    allowExternalLeaseAdoptionRecheck: true,
    lifecycleCoordinator: deps.lifecycleCoordinator,
    checkBootCapacity: deps.checkBootCapacity,
    onAndroidColdBootTrackingChanged: () => {
      void deps.notifyDeviceInventoryResourcesChanged(false).catch((error) => {
        logger.warn(
          `[DeviceTools] Resource notify after cold-boot tracking change failed: ${errorMessage(error)}`,
          error,
        );
      });
    },
  });
}

function assertProvisionAndroidDiscovery(
  args: ProvisionDeviceArgs,
  succeededPlatforms: ReadonlySet<string>,
): void {
  if (!succeededPlatforms.has("android")) {
    throw new ProvisionDeviceError(
      "discovery_incomplete",
      `Cannot provision Android device '${args.device.name}' because booted-device discovery did not complete.`,
      true,
    );
  }
}

function assertProvisionAndroidIdentities(
  args: ProvisionDeviceArgs,
  devices: BootedDevice[],
): void {
  const unresolved = devices
    .filter(isUnresolvedAndroidEmulatorName)
    .map((device) => device.deviceId);
  if (unresolved.length > 0) {
    throw new ProvisionDeviceError(
      "discovery_incomplete",
      `Cannot provision Android device '${args.device.name}' because a running emulator's AVD identity has not resolved yet; retry (unresolved: ${unresolved.join(", ")}).`,
      true,
    );
  }
}

const PROVISION_ANDROID_IDENTITY_BACKOFF = fixedBackoff(250);
const MAX_PROVISION_ANDROID_IDENTITY_REDISCOVERIES = 3;

async function discoverProvisionAndroidIdentities(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  totalDeadlineMs: number,
  signal: AbortSignal,
  created: boolean,
): Promise<BootedDevice[]> {
  const backoff = deps.provisionAndroidIdentityBackoff ?? PROVISION_ANDROID_IDENTITY_BACKOFF;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const discovery = await deviceManager.getBootedDevicesDetailed("android", {
      bypassAndroidDeviceListCache: true,
      signal,
    });
    assertProvisionAndroidDiscovery(args, discovery.succeededPlatforms);
    // FUNNEL 1: fold EVERY observation into the pool BEFORE checking identity,
    // so placeholders quarantine stale pooled labels even when we refuse (#7177).
    await reconcileDiscoveryObservation(discovery.devices, "provisionDevice-exact");
    // A never-launched AVD created by this request cannot be running on a sibling.
    if (created || !discovery.devices.some(isUnresolvedAndroidEmulatorName)) {
      return discovery.devices;
    }
    const delayMs = backoff.delayForAttempt(attempt + 1);
    if (
      attempt >= MAX_PROVISION_ANDROID_IDENTITY_REDISCOVERIES ||
      totalDeadlineMs - deps.timer.now() <= delayMs
    ) {
      assertProvisionAndroidIdentities(args, discovery.devices);
    }
    await awaitWhileRequestIsLive(deps.timer.sleep(delayMs), signal);
  }
}

function assertProvisionIosIdentity(
  args: ProvisionDeviceArgs,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
): void {
  if (args.device.platform === "ios" && !provisioned.device.deviceId) {
    throw new ProvisionDeviceError(
      "identity_conflict",
      `Exact iOS simulator '${args.device.name}' has no UDID.`,
    );
  }
}

function assertProvisionIosBootIdentity(
  args: ProvisionDeviceArgs,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
  boot: DeviceBootResult,
): void {
  if (args.device.platform === "ios" && boot.device.deviceId !== provisioned.device.deviceId) {
    throw new ProvisionDeviceError(
      "identity_conflict",
      `Exact iOS simulator '${args.device.name}' resolved to unexpected UDID '${boot.device.deviceId}'.`,
    );
  }
}

/** Finds what is already running for the requested platform, folding the observation into the pool. */
async function discoverAlreadyBootedDevices(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  totalDeadlineMs: number,
  operationSignal: AbortSignal,
  created: boolean,
): Promise<BootedDevice[]> {
  return await runProvisionDeviceWithinDeadline(
    deps.timer,
    totalDeadlineMs,
    operationSignal,
    "discovering an already-running exact device",
    async (deadlineSignal) => {
      if (args.device.platform === "android") {
        return await discoverProvisionAndroidIdentities(
          args,
          deps,
          deviceManager,
          totalDeadlineMs,
          deadlineSignal,
          created,
        );
      }
      const alreadyBootedDevices = await deviceManager.getBootedDevices(args.device.platform);
      // FUNNEL 1: acquisition matches this observation against the pooled
      // entry it is about to hand out (#6863 review).
      await reconcileDiscoveryObservation(alreadyBootedDevices, "provisionDevice-exact");
      return alreadyBootedDevices;
    },
  );
}

/** Reserve the booted device's readiness inside the request deadline; a late reservation is released. */
async function reserveReadinessWithinDeadline(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  boot: DeviceBootResult,
  { totalDeadlineMs, signal }: { totalDeadlineMs: number; signal: AbortSignal },
): Promise<DeviceReadinessReservation | undefined> {
  return runProvisionDeviceWithinDeadline(
    deps.timer,
    totalDeadlineMs,
    signal,
    "reserving device readiness",
    async (reservationSignal) => {
      const reservation = await reserveProvisionDeviceReadiness(ctx, args, boot);
      if (reservationSignal.aborted) {
        void reservation?.().catch((error) =>
          logger.warn(`Late provision reservation release failed: ${error}`),
        );
        reservationSignal.throwIfAborted();
      }
      return reservation;
    },
  );
}

export async function bootExactProvisionedDevice(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  deviceCreationGate: DeviceCreationGate,
  {
    provisioned,
    perf,
    totalDeadlineMs,
    lifecycleLease,
    signal,
    settlementState,
    onBooted,
    deleteCreatedIfUndelivered,
    recordUndeliveredAdoption,
  }: ProvisionBootOptions,
): Promise<ProvisionBootResult> {
  const requestedIdentity = `platform=${args.device.platform} name=${args.device.name}`;
  const operationSignal = combineAbortSignals(signal, lifecycleLease.signal)!;
  const mappingOptions = { signal: operationSignal, totalDeadlineMs };
  const bootService = createProvisionBootService(
    deps,
    deviceManager,
    deviceCreationGate,
    lifecycleLease,
  );
  let boot: DeviceBootResult | undefined;
  let ownershipTransferred = false;
  let awaitingReadiness = false;
  let readinessReservation: DeviceReadinessReservation | undefined;
  let resources: DeviceResourceConfigurationResult | undefined;
  let manufacturerProfile: Record<string, unknown> | undefined;
  try {
    const alreadyBooted = await discoverAlreadyBootedDevices(
      args,
      deps,
      deviceManager,
      totalDeadlineMs,
      operationSignal,
      provisioned.created === true,
    );
    const exactBootedDevice = findExactProvisionedBootedDevice(
      args.device.platform,
      alreadyBooted,
      provisioned.device,
    );
    assertProvisionIosIdentity(args, provisioned);
    perf.startOperation("bootDevice");
    // Boot and automation readiness share one provision budget. Reserve the
    // readiness slice up front, the way `applyProvisionDeviceResources` does,
    // so a slow cold boot cannot consume the whole deadline and leave CtrlProxy
    // setup with a millisecond ("readiness budget exhausted before setup lock").
    // The slice is capped at half the remaining budget so a short request still
    // gets a usable boot window; no budget is inflated.
    const readinessShareMs = Math.min(
      Math.max(0, totalDeadlineMs - deps.timer.now()) / 2,
      args.readiness === "automation"
        ? serverConfig.getRunnerReadinessTimeoutMs()
        : START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
    admitRestartReservedProvision(args, provisioned.device.deviceId);
    boot = await bootService.boot({
      operationName: "provisionDevice",
      platform: args.device.platform,
      deviceId:
        exactBootedDevice?.deviceId ?? provisioned.device.deviceId ?? provisioned.device.name,
      totalDeadlineMs: totalDeadlineMs - readinessShareMs,
      signal: operationSignal,
      // A just-created AVD's first boot is a genuine cold boot; opt its
      // Android readiness wait into bounded ADB-offline recovery (#7054). An
      // already-running adopted exact device never reaches the cold-boot path,
      // so the flag is a no-op there and needs no extra guard here.
      freshProvision: provisioned.created === true,
    });
    perf.endOperation("bootDevice");
    assertProvisionIosBootIdentity(args, provisioned, boot);
    await validatePooledDeviceMapping(boot.device, requestedIdentity, mappingOptions);
    onBooted(boot.device);
    readinessReservation = await reserveReadinessWithinDeadline(ctx, args, deps, boot, {
      totalDeadlineMs,
      signal: operationSignal,
    });
    clearColdBootShutdownMarker(boot.source, boot.device.deviceId);
    const sessionId = await trackDeviceAcquisitionReadiness(
      deviceReadinessLockKey(boot.device.platform, boot.device.deviceId),
      async () => {
        operationSignal.throwIfAborted();
        resources = await applyProvisionDeviceResources(
          args,
          deps,
          boot!.device,
          totalDeadlineMs,
          operationSignal,
        );
        operationSignal.throwIfAborted();
        awaitingReadiness = true;
        await ensureProvisionDeviceReadiness(ctx, args, deps, boot!.device, requestedIdentity, {
          totalDeadlineMs: totalDeadlineMs,
          perf: perf,
          signal: operationSignal,
        });
        awaitingReadiness = false;
        operationSignal.throwIfAborted();
        await validatePooledDeviceMapping(boot!.device, requestedIdentity, mappingOptions);
        publishWarmDeviceReady(boot!.source, boot!.device.deviceId);
        const bound = await bindProvisionedDeviceSession(ctx, args, boot!, provisioned.device, {
          timer: deps.timer,
          totalDeadlineMs,
          signal: operationSignal,
          readinessReservation,
          settlementState,
        });
        // Applied to the bound session's ready device, so its release restores it (#14058).
        manufacturerProfile = await applyProvisionDeviceProfile(
          args,
          deps,
          boot!.device,
          bound,
          operationSignal,
        );
        return bound;
      },
    );
    ownershipTransferred = true;
    recordProvisionedDeviceStarted(boot, lifecycleLease, {
      deleteCreatedIfUndelivered,
      recordUndeliveredAdoption,
    });
    return {
      device: boot.device,
      sessionId,
      source: boot.source,
      sourceImage: boot.sourceImage,
      resources,
      ...(manufacturerProfile ? { manufacturerProfile } : {}),
    };
  } catch (error) {
    settlementState.retainCreatedForRetry = retainCreatedForReadinessRetry(
      args,
      provisioned.created,
      awaitingReadiness,
      error,
      operationSignal,
    );
    if (!ownershipTransferred && !settlementState.retainCreatedForRetry) {
      settlementState.unownedColdBootSettlement = cancelUnownedColdBootUnlessRetryable(
        boot ? { ...boot, provisioned: boot.provisioned || provisioned.created } : boot,
        error,
        operationSignal,
      );
    }
    throw error;
  } finally {
    settlementState.readinessReservation = readinessReservation;
  }
}

/** Only the opted-in binding journal may keep a creation after a time-based readiness refusal. */
function retainCreatedForReadinessRetry(
  args: InternalProvisionDeviceArgs,
  created: boolean,
  awaitingReadiness: boolean,
  error: unknown,
  signal: AbortSignal,
): boolean {
  if (
    currentBindingReconciler() === undefined ||
    args.rollbackOnRetryableReadiness !== false ||
    args.device.platform !== "ios" ||
    !created ||
    !awaitingReadiness ||
    signal.aborted
  ) {
    return false;
  }
  const failure = toProvisionDeviceError(args, error);
  return failure.retryable && failure.code === "timeout";
}
