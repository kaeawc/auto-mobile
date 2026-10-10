import { AndroidTransportAliases } from "../utils/androidSerial";
import { androidTransportIdentityAdbFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { DeviceHealthMarker } from "../daemon/deviceHealthMarkers";
import { errorMessage } from "../utils/describeUnknownError";
import { combineWithAmbientAbort, getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import {
  type BootedDeviceDiscovery,
  type DeviceDiscoveryError,
  PlatformDeviceManager,
} from "../devices/deviceUtils";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import {
  configuredImageForBootedDevice,
  configuredImagesByStableId,
  type StableConfiguredDeviceImage,
} from "../utils/configuredDeviceInventory";
import { logger } from "../utils/logger";
import { BootedDevice, Platform } from "../models";
import { DaemonState } from "../daemon/daemonState";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import type { Session } from "../daemon/sessionManager";
import type {
  DevicePool,
  DeviceRecoveryEligibility,
  DeviceRecoveryPolicy,
  PooledDevice,
} from "../daemon/devicePool";
import {
  describeDevice,
  projectBootedDevice,
  withDeviceRuntimeObservation,
  withDeviceLifecycle,
  withDeviceServiceStatus,
  poolHoldFor,
  type BootedDeviceDescription,
  type DeviceDescription,
} from "./deviceDescription";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { getAndroidAppMetadataViaAdb } from "../features/observe/GetAppMetadata";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../ctrlProxy/IOSCtrlProxyManager";
import type { ForcedRestartSnapshot } from "../ctrlProxy/ForcedRestartBudget";
import {
  NotifyutilIosLockStateProbe,
  type IosLockStateProbe,
} from "../features/observe/ios/IosLockStateProbe";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import type { CtrlProxyHealthCheckResult } from "../ctrlProxy/ios/IosCtrlProxyHealthClient";
import { IosCtrlProxyBuilder } from "../ctrlProxy/IosCtrlProxyBuilder";
import {
  IOSCtrlProxyClient,
  getRequiredIosRunnerFeatureFlags,
} from "../features/observe/ios/IOSCtrlProxyClient";
import {
  getMissingIosRunnerFeatureCommands,
  type IosRunnerCommandRequirements,
} from "../features/observe/ios/iosRunnerFeatureCommands";
import { resolveApkChecksum, resolveIpaChecksum } from "../constants/release";
import { type DiscoverySource, sourcesForPlatform } from "../utils/discoverySource";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  AndroidAvdProvenanceCache,
  CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
} from "../utils/AndroidAvdProvenanceCache";
import { withRemainingBudget } from "../utils/withRemainingBudget";
import {
  AndroidOrientationReader,
  IosOrientationReader,
  type OrientationReader,
} from "../features/action/OrientationReader";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import type { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import { TTLCache } from "../utils/cache/Cache";
import { SingleFlight } from "../utils/cache/SingleFlight";
import {
  getInFlightAndroidColdBootReader,
  type InFlightAndroidColdBootReader,
} from "../devices/deviceBootService";

// Resource URIs
export const BOOTED_DEVICE_RESOURCE_URIS = {
  ALL_BOOTED: "automobile:devices/booted",
  PLATFORM_TEMPLATE: "automobile:devices/booted/{platform}",
} as const;

// A lightweight per-device lock-state resource. The full booted-devices resource also carries
// `locked`, but computing it there recomputes service status (isInstalled/isEnabled/sha256) for
// every device — too heavy for the desktop's frequent lock poll (issue #5056). This resource
// enumerates booted devices and runs ONLY the keyguard probe.
export const DEVICE_LOCK_STATES_RESOURCE_URI = "automobile:devices/lockStates";

export const BOOTED_DEVICES_RESOURCE_BUDGET_MS = 8_000;
export const BOOTED_DEVICES_RETRY_AFTER_MS = 1_000;
const BOOTED_DEVICES_RESOURCE_CACHE_TTL_MS = 2_500; // Stay below adb's ~5s device-list cache.
let bootedDevicesResourceCache: TTLCache<string, BootedDevicesResourceContent> | null = null;
let bootedDevicesResourceSingleFlight = new SingleFlight<string, BootedDevicesResourceContent>();
let bootedDevicesResourceGeneration = 0;
let bootedDevicesResourcePublishedGeneration = 0;

function getBootedDevicesResourceCache(
  timer: Timer,
): TTLCache<string, BootedDevicesResourceContent> {
  if (!bootedDevicesResourceCache) {
    bootedDevicesResourceCache = new TTLCache(timer, {
      ttlMs: BOOTED_DEVICES_RESOURCE_CACHE_TTL_MS,
    });
  }
  return bootedDevicesResourceCache;
}

export function resetBootedDevicesResourceCache(): void {
  bootedDevicesResourceCache = null;
  bootedDevicesResourceSingleFlight = new SingleFlight();
  bootedDevicesResourcePublishedGeneration = ++bootedDevicesResourceGeneration;
}

// Per-device lock state for Android and iOS simulators. Omitted for physical iOS devices or
// when the advisory probe could not read the state.
interface DeviceLockStateInfo {
  deviceId: string;
  locked?: boolean;
}

export interface DeviceLockStatesResourceContent {
  lastUpdated: string; // ISO 8601
  lockStates: DeviceLockStateInfo[];
  /** True only when both platform discovery sweeps completed. */
  observationComplete: boolean;
  /** Platform-specific discovery failures; an empty object means both sweeps completed. */
  discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>>;
}

export interface CtrlProxyVersionInfo {
  /**
   * For iOS, `build` is the persisted extracted-runner identity, not the
   * AutoMobileTest host app Info.plist placeholder (1.0/1). It is omitted
   * unless installation is confirmed true for this device.
   */
  versionName?: string;
  versionCode?: string;
  build?: string;
  source: "android-package" | "ios-runner-bundle";
}

// Service status for a booted device
export interface DeviceServiceStatus {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  installedSha256: string | null;
  expectedSha256: string;
  isCompatible: boolean;
  /**
   * Installed-artifact identity, not a readiness or compatibility signal; omitted when unknown
   * or when installation is not confirmed true for this device.
   * Readiness and compatibility remain represented by isCompatible and runner feature status.
   */
  version?: string;
  versionInfo?: CtrlProxyVersionInfo;
  /**
   * iOS only: whether the running runner advertises the full feature command set.
   * The iOS runner exposes no version/hash (installedSha256 stays null), so this
   * is the runner-identity signal that makes isCompatible meaningful instead of
   * always-true. null when the runner has not handshaked (identity unknown).
   */
  supportedCommandsComplete?: boolean | null;
  /** iOS only: whether all required non-command runner features are advertised. */
  supportedFeaturesComplete?: boolean | null;
  recovery?: {
    state: "backoff" | "exhausted" | "suspended";
    attempts: number;
    reason?: string;
    nextAttemptAt?: string;
  };
}

/**
 * A per-device diagnostic recorded when the bounded service-status probe could
 * not complete for THIS observation. It is TRANSIENT: it marks the automation
 * snapshot as momentarily unknown without changing the device's presence in the
 * list or its readiness. A booted simulator whose CtrlProxy loopback refused,
 * reset, or hung keeps appearing with this marker, and the next observation
 * usually clears it, so a healthy device does not flap present/absent (#7053).
 */
export interface ServiceStatusDiagnostic {
  /**
   * "timeout": the probe did not settle within the caller's budget (a hung
   * loopback connection). "unreachable": the probe failed outright (e.g. the
   * CtrlProxy loopback connection was refused or reset).
   */
  state: "timeout" | "unreachable";
  reason: string;
}

// The resource keeps resource-specific metadata alongside the full canonical description.
interface BootedDeviceInfo extends BootedDeviceDescription {
  recoveryEligibility?: DeviceRecoveryEligibility | null;
  /**
   * Set when the bounded service-status probe for this observation timed out or
   * failed (CtrlProxy loopback refused/reset). The device stays booted and
   * present; this only says the automation-service snapshot is momentarily
   * unknown, never that the device is unavailable. Distinct from `runtime.serviceStatus`
   * simply being absent for a non-probeable (quarantined) entry (#7053).
   */
  serviceStatusDiagnostic?: ServiceStatusDiagnostic;
  /**
   * Set when the pool holds this serial under an IDENTITY QUARANTINE: the serial
   * resolves, but which AVD answers on it does not.
   *
   * Published rather than inferred from the absent pool context, because the two
   * are not the same fact: an entry can carry no pool context simply because the
   * pool never held the serial. This one says the daemon HAD an identity for it
   * and can no longer tie it to the runtime — which is also why this entry is
   * built from discovery alone and carries no probed service status or lock
   * state ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  identityUnresolved?: boolean;
}

type BootedDeviceProbeTarget = {
  isVirtual?: boolean;
  name: string;
  platform: Platform;
  deviceId: string;
  source?: "local";
};

function probeTarget(device: BootedDeviceInfo): BootedDeviceProbeTarget {
  return {
    isVirtual: device.isVirtual,
    name: device.name,
    platform: device.platform,
    deviceId: device.runtime.deviceId ?? device.identity.stableId,
    ...(device.source === "local" ? { source: "local" as const } : {}),
  };
}

// Resource content schema
export interface BootedDevicesResourceContent {
  enrichment?: {
    complete: false;
    pending: string[];
    retryable: true;
    retryAfterMs: number;
    reason: string;
  };
  totalCount: number;
  androidCount: number;
  iosCount: number;
  virtualCount: number;
  physicalCount: number;
  lastUpdated: string; // ISO 8601
  observationComplete: boolean;
  platformObservations: Partial<Record<Platform, PlatformObservation>>;
  sourceObservations: Partial<Record<DiscoverySource, PlatformObservation>>;
  poolStatus?: PoolStatusSummary;
  devices: BootedDeviceInfo[];
}

interface PlatformObservation {
  observationComplete: boolean;
  discoveryError?: DeviceDiscoveryError;
}

type PoolDeviceStatus = "idle" | "assigned" | "error";

interface PoolStatusSummary {
  enabled: boolean;
  idle: number;
  assigned: number;
  error: number;
  total: number;
  recoveryPolicy: DeviceRecoveryPolicy;
}

interface PoolDeviceInfo {
  unhealthy?: DeviceHealthMarker;
  poolStatus: PoolDeviceStatus;
  assignedSession?: string;
  recoveryEligibility: DeviceRecoveryEligibility;
  /**
   * The AVD this pool started on the serial, and the epoch of that allocation.
   * The whole {@link PoolDeviceContext} -- these two included -- exists ONLY
   * when the pooled entry describes the runtime discovery just reported on the
   * serial; see {@link resolvePoolDeviceContext}.
   */
  avdName?: string;
  incarnation?: number;
}

/**
 * Set a custom device manager for testing
 * @param manager - The device manager to use (or null to reset to default)
 * @deprecated Use PlatformDeviceManagerFactory.setInstance() instead
 */
export function setDeviceManager(manager: PlatformDeviceManager | null): void {
  PlatformDeviceManagerFactory.setInstance(manager);
  // Disable service status queries when using a fake device manager,
  // since the real queries require adb/simctl which aren't available in tests.
  serviceStatusEnabled = manager === null;
}

let injectedInFlightAndroidColdBootReader: InFlightAndroidColdBootReader | null = null;
export function setInFlightAndroidColdBootReader(
  reader: InFlightAndroidColdBootReader | null,
): void {
  injectedInFlightAndroidColdBootReader = reader;
  resetBootedDevicesResourceCache();
}

// Controls whether service status is queried for each device.
// Disabled automatically when a test device manager is injected.
let serviceStatusEnabled = true;

// A fake factory opts resource tests into the same narrow probe without touching real adb.
let injectedBootCompletionAdbFactory: AdbClientFactory | null = null;
export function setBootCompletionAdbFactory(factory: AdbClientFactory | null): void {
  injectedBootCompletionAdbFactory = factory;
}

/** Probes a device's lock state; returns `undefined` when it can't be determined. */
export type DeviceLockProbe = (device: BootedDevice) => Promise<boolean | undefined>;

// Injected only by tests, which need a deterministic lock state without real device transports.
// A fake device manager disables production probes unless the test injects a probe explicitly.
let injectedLockProbe: DeviceLockProbe | null = null;

/** Inject a fake lock probe for tests (or null to restore the real platform probe). */
export function setDeviceLockProbe(probe: DeviceLockProbe | null): void {
  injectedLockProbe = probe;
}

let injectedIosLockStateProbe: IosLockStateProbe | null = null;

/** Inject an iOS probe, opting fake-manager tests into iOS lock reads only; null restores production. */
export function setIosLockStateProbe(probe: IosLockStateProbe | null): void {
  injectedIosLockStateProbe = probe;
}

/**
 * Reads Android keyguard via `dumpsys window policy` (issue #4235), or iOS simulator lock state
 * via notifyutil (issue #5106). Physical iOS remains unknown. The caller bounds and handles
 * failures — lock state is advisory, never fatal to the resource.
 */
async function realDeviceLockProbe(device: BootedDevice): Promise<boolean | undefined> {
  if (device.platform !== "android") {
    if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
      return undefined;
    }
    const probe = injectedIosLockStateProbe ?? new NotifyutilIosLockStateProbe();
    const lock = await probe.read(device.deviceId, getAbortSignal());
    return lock?.locked;
  }
  const lock = await defaultAdbClientFactory.create(device).getDeviceLock();
  return lock?.locked;
}

const LOCK_STATE_TIMEOUT_MS = 3000;

/** An injected fake, the real platform probe, or iOS-only reads with an injected iOS probe. */
function activeLockProbe(): DeviceLockProbe | null {
  if (injectedLockProbe || serviceStatusEnabled) {
    return injectedLockProbe ?? realDeviceLockProbe;
  }
  return injectedIosLockStateProbe
    ? async (device) => (device.platform === "ios" ? realDeviceLockProbe(device) : undefined)
    : null;
}

export type OrientationReaderFactory = (device: BootedDevice) => OrientationReader;

let injectedOrientationReaderFactory: OrientationReaderFactory | null = null;

/** Inject deterministic orientation readers for resource tests (or null to restore production). */
export function setOrientationReaderFactory(factory: OrientationReaderFactory | null): void {
  injectedOrientationReaderFactory = factory;
}

function realOrientationReader(device: BootedDevice): OrientationReader {
  return device.platform === "android"
    ? new AndroidOrientationReader(defaultAdbClientFactory.create(device))
    : new IosOrientationReader();
}

function activeOrientationReaderFactory(): OrientationReaderFactory | null {
  return injectedOrientationReaderFactory ?? (serviceStatusEnabled ? realOrientationReader : null);
}

/**
 * Resolve a device's lock state via [lockProbe], bounded by a per-device timeout so a slow/failed
 * read leaves it `undefined` rather than stalling the caller. Clears the losing timer when the probe
 * wins, so a fast success never logs a spurious "timeout" on the desktop's periodic poll.
 */
async function probeDeviceLock(
  device: BootedDevice,
  options: { lockProbe: DeviceLockProbe; timer?: Timer },
): Promise<boolean | undefined> {
  const { lockProbe, timer = defaultTimer } = options;
  const deadline = new Error("Lock-state probe timed out");
  try {
    return await raceWithDeadline(lockProbe(device), {
      timer,
      signal: getAbortSignal(),
      timeoutMs: LOCK_STATE_TIMEOUT_MS,
      label: "Lock-state probe",
      timeoutError: () => deadline,
      onTimeout: () =>
        logger.warn(`[BootedDeviceResources] Lock-state timeout for ${device.deviceId}`),
    });
  } catch (error) {
    if (error === deadline) {
      return undefined;
    }
    logger.warn(
      `[BootedDeviceResources] Failed to query lock state for ${device.deviceId}: ${error}`,
    );
    return undefined;
  }
}

/** Both booted inventory and lock-state observations preserve source diagnostics. */
function bootedDiscoveryError(
  discovery: BootedDeviceDiscovery,
  platform: Platform,
): DeviceDiscoveryError {
  return (
    discovery.discoveryErrors?.[platform] ??
    (platform === "ios" ? discovery.sourceErrors?.["ios-physical"] : undefined) ?? {
      code: "failed",
      message: `${platform === "android" ? "Android" : "iOS"} booted-device discovery did not complete.`,
    }
  );
}

/**
 * Compute the lightweight [DEVICE_LOCK_STATES_RESOURCE_URI] payload: enumerate booted devices and
 * run ONLY the keyguard probe (no service-status), so the desktop's frequent lock poll doesn't pay
 * for isInstalled/isEnabled/sha256 every cycle (issue #5056).
 */
async function computeDeviceLockStates(): Promise<DeviceLockStatesResourceContent> {
  const devices: BootedDevice[] = [];
  const succeededPlatforms = new Set<Platform>();
  const discoveryErrors: Partial<Record<Platform, DeviceDiscoveryError>> = {};
  for (const platform of ["android", "ios"] as Platform[]) {
    try {
      const discovery =
        await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(platform);
      const pool = readDaemonDeviceContext().devicePool;
      const aliases = new AndroidTransportAliases(androidTransportIdentityAdbFactory);
      const normalized =
        platform === "android"
          ? pool
            ? pool.mapAndroidDiscovery(discovery.devices)
            : aliases.fold(discovery.devices, await aliases.prepare(discovery.devices), new Set())
          : discovery.devices;
      devices.push(...normalized);
      const complete = sourcesForPlatform(platform).every(
        (source) =>
          discovery.succeededSources?.has(source) ?? discovery.succeededPlatforms.has(platform),
      );
      if (complete) {
        succeededPlatforms.add(platform);
      } else {
        discoveryErrors[platform] = bootedDiscoveryError(discovery, platform);
      }
    } catch (error) {
      logger.warn(`[DeviceLockStates] Failed to enumerate ${platform} booted devices: ${error}`);
      discoveryErrors[platform] = {
        code: "failed",
        message: `${platform === "android" ? "Android" : "iOS"} booted-device discovery failed: ${errorMessage(error)}`,
      };
    }
  }
  // FUNNEL 1: the probe below is device-addressed, and this poll can be the
  // first discovery to see the `Unknown (<serial>)` placeholder or a different
  // AVD on a reused serial. Fold it in so the admission gate at the client seam
  // refuses on the pool's current knowledge rather than a stale label (#6923).
  await reconcileDiscoveryObservation(devices, "device-lock-states");

  const lockStates: DeviceLockStateInfo[] = devices.map((device) => ({
    deviceId: device.deviceId,
  }));
  const lockProbe = activeLockProbe();
  if (lockProbe) {
    const results = await Promise.allSettled(
      devices.map((device) => probeDeviceLock(device, { lockProbe })),
    );
    for (let i = 0; i < devices.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled" && result.value !== undefined) {
        lockStates[i] = { deviceId: devices[i].deviceId, locked: result.value };
      }
    }
  }

  return {
    lastUpdated: new Date().toISOString(),
    lockStates,
    observationComplete: succeededPlatforms.size === 2,
    discoveryErrors,
  };
}

async function getDeviceLockStates(): Promise<ResourceContent> {
  const content = await computeDeviceLockStates();
  return {
    uri: DEVICE_LOCK_STATES_RESOURCE_URI,
    mimeType: "application/json",
    text: JSON.stringify(content, null, 2),
  };
}

// Convert BootedDevice to BootedDeviceInfo
function toBootedDeviceInfo(
  device: BootedDevice,
  poolContext?: PoolDeviceContext,
  configured?: StableConfiguredDeviceImage,
  adbOfflineState?: string,
): BootedDeviceInfo {
  const description = describeDevice({
    kind: "booted",
    adbOfflineState,
    device,
    pooled: poolContext?.pooled,
    unhealthy: poolContext?.poolInfo.unhealthy,
    configured,
    // Preserve the pool's already-published assignment in the canonical session
    // when the optional session-detail map is unavailable for this observation.
    session:
      poolContext?.session ??
      (poolContext?.poolInfo.assignedSession
        ? { sessionId: poolContext.poolInfo.assignedSession }
        : undefined),
    deviceSessionUuid: poolContext?.deviceSessionUuid,
    ...poolContext?.hold,
  });
  const projected = projectBootedDevice(description);
  return {
    ...projected,
    recoveryEligibility: poolContext?.poolInfo.recoveryEligibility ?? null,
    identityUnresolved: false,
  };
}

/** A claimed AVD before adb has assigned its serial; configured inventory supplies only static facts. */
function describeInFlightAndroidColdBoot(
  avdName: string,
  configured: StableConfiguredDeviceImage | undefined,
): BootedDeviceInfo {
  const description = describeDevice({
    kind: "image",
    image: configured ?? { name: avdName, platform: "android", isRunning: false },
  });
  return {
    ...description,
    name: avdName,
    platform: "android",
    isVirtual: true,
    source: "local",
    identity: { stableId: avdName },
    availabilityError: null,
    runtime: {
      ...description.runtime,
      lifecycle: { state: "booting", known: true },
    },
  };
}

function inFlightAndroidColdBootDescriptions(
  platform: Platform,
  discovered: readonly BootedDevice[],
  configuredImages: ReadonlyMap<string, StableConfiguredDeviceImage>,
): BootedDeviceInfo[] {
  if (platform !== "android") {
    return [];
  }
  const reader = injectedInFlightAndroidColdBootReader ?? getInFlightAndroidColdBootReader();
  const discoveredNames = new Set(discovered.map((device) => device.name));
  return [...new Set(reader.listInFlightAndroidColdBootAvdNames())]
    .filter((avdName) => !discoveredNames.has(avdName))
    .map((avdName) =>
      describeInFlightAndroidColdBoot(avdName, configuredImages.get(`android:${avdName}`)),
    );
}

interface AdbOfflineHeldInput {
  platform: Platform;
  discovered: readonly BootedDevice[];
  devicePool: DevicePool | null;
  sessionInfoByDeviceId: Map<string, Session> | null;
  resolveDeviceSessionUuid: (deviceId: string) => string | null;
  deviceManager: PlatformDeviceManager;
  configuredImages: ReadonlyMap<string, StableConfiguredDeviceImage>;
}

/**
 * Held Android devices that `adb devices` still lists in a non-`device` state. The online-only
 * discovery drops them, so without this a client polling listDevices during the disconnect
 * monitor's offline budget sees the device as unheld (#11118). Best effort: a failed state probe
 * leaves the listing as discovery produced it.
 */
async function adbOfflineHeldDeviceDescriptions(
  input: AdbOfflineHeldInput,
): Promise<BootedDeviceInfo[]> {
  const { platform, devicePool, deviceManager } = input;
  if (platform !== "android" || !devicePool || !deviceManager.getAndroidListedDeviceStates) {
    return [];
  }
  const discoveredIds = new Set(input.discovered.map((device) => device.deviceId));
  const held = devicePool
    .getAssignedDevices()
    .filter((pooled) => pooled.platform === "android" && !discoveredIds.has(pooled.id));
  if (held.length === 0) {
    return [];
  }
  let states: Map<string, string>;
  try {
    states = await deviceManager.getAndroidListedDeviceStates(
      held.map((pooled) => pooled.id),
      { signal: getAbortSignal() },
    );
  } catch (error) {
    logger.warn(
      `[BootedDeviceResources] Offline held-device probe failed: ${errorMessage(error)}`,
      error,
    );
    return [];
  }
  return held.flatMap((pooled) => {
    const adbState = states.get(pooled.id);
    if (!adbState) {
      return [];
    }
    const device: BootedDevice = { deviceId: pooled.id, name: pooled.name, platform: "android" };
    return [
      toBootedDeviceInfo(
        device,
        resolvePoolDeviceContext(
          devicePool,
          device,
          input.sessionInfoByDeviceId,
          input.resolveDeviceSessionUuid,
        ),
        input.configuredImages.get(`android:${pooled.avdName ?? pooled.name}`),
        adbState,
      ),
    ];
  });
}

export async function configuredImagesForBootedPlatform(
  platform: Platform,
  deviceManager: PlatformDeviceManager = PlatformDeviceManagerFactory.getInstance(),
  timer: Timer = defaultTimer,
  avdManager: Pick<AvdManager, "listDeviceImages"> | undefined = serviceStatusEnabled &&
  platform === "android"
    ? new AvdManagerService()
    : undefined,
): Promise<ReadonlyMap<string, StableConfiguredDeviceImage>> {
  const controller = new AbortController();
  try {
    const [discovery, androidProvenance] = await raceWithDeadline(
      Promise.all([
        deviceManager.getDeviceImagesDetailed(platform, {
          signal: combineWithAmbientAbort(controller.signal),
          coalesceInventoryEnrichment: true,
        }),
        avdManager
          ? AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer)
          : Promise.resolve(new Map()),
      ]),
      {
        timer,
        timeoutMs: CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
        signal: combineWithAmbientAbort(controller.signal),
        label: "Configured image inventory",
        onTimeout: () =>
          controller.abort(new Error("Configured image inventory caller budget elapsed")),
      },
    );
    return new Map(
      [...configuredImagesByStableId(platform, discovery)].map(([key, image]) => {
        const provenance = androidProvenance.get(image.name);
        return [
          key,
          provenance
            ? {
                ...image,
                image: {
                  path: provenance.path,
                  target: provenance.target,
                  basedOn: provenance.basedOn,
                },
              }
            : image,
        ];
      }),
    );
  } catch (error) {
    logger.warn(
      `[BootedDeviceResources] Failed to get configured ${platform} device images: ${errorMessage(error)}`,
      error,
    );
    return new Map();
  }
}

/**
 * The two identities a consumer needs: WHICH device (`stableId`, the AVD name
 * for an emulator because a serial is reused across boots) and WHICH RUN of it
 * (`connectionId`, the pool's per-allocation incarnation).
 *
 * Both fall back to discovery's own answer when the pool has nothing to say
 * about this runtime -- including when discovery reports `Unknown (<serial>)`,
 * where the pooled AVD label could belong to the previous occupant of the
 * serial. A caller that needs the real AVD name in that case must re-resolve it
 * from the runtime rather than read it here (#6863 review).
 */
/**
 * Everything the resource publishes about WHICH RUNTIME is on a serial, resolved
 * as ONE unit so it can be withheld as one.
 *
 * The join to daemon state is by serial alone, and a different device can hold
 * that serial before the pool refreshes -- or the emulator console can have gone
 * quiet, leaving discovery with the `Unknown (<serial>)` placeholder, which
 * asserts nothing either way. Naming the retired entry's epoch would tell
 * consumers to keep state exactly when the new epoch is supposed to make them
 * flush it; naming its AVD would publish the previous occupant's label as this
 * runtime's `stableId`; and handing out the retired `deviceSessionUuid` would
 * have the desktop subscribe to this runtime's streams under a dead epoch. So
 * `describesPooledRuntime` gates the pool entry, the session and the registry
 * epoch TOGETHER: on a mismatch the entry carries no pool context at all and its
 * identity is built purely from discovery (#6863 review).
 */
interface PoolDeviceContext {
  poolInfo: PoolDeviceInfo;
  pooled: PooledDevice;
  session?: Session;
  deviceSessionUuid?: string;
  /** Why generic allocation will not lend this device; the same answer `listDevices` publishes. */
  hold: ReturnType<typeof poolHoldFor>;
}

/** An idle device allocation cannot lend counts as assigned, matching `DevicePool.getStats()`. */
function effectivePoolStatus(
  status: PooledDevice["status"],
  hold: ReturnType<typeof poolHoldFor>,
): PoolDeviceStatus {
  const held = hold.heldBy !== undefined || hold.reserved === true;
  return status === "busy" || (status === "idle" && held) ? "assigned" : status;
}

function resolvePoolDeviceContext(
  devicePool: DevicePool | null,
  device: BootedDevice,
  sessionInfoByDeviceId: Map<string, Session> | null,
  resolveDeviceSessionUuid: (deviceId: string) => string | null,
): PoolDeviceContext | undefined {
  if (!devicePool) {
    return undefined;
  }

  const pooledDevice = devicePool.getDevice(device.deviceId);
  if (!pooledDevice || !devicePool.describesPooledRuntime(device)) {
    return undefined;
  }

  const hold = poolHoldFor(devicePool, device.deviceId);
  const poolStatus = effectivePoolStatus(pooledDevice.status, hold);

  return {
    poolInfo: {
      poolStatus,
      unhealthy: devicePool.getDeviceHealthMarker(device.deviceId),
      assignedSession: pooledDevice.sessionId || undefined,
      recoveryEligibility: devicePool.getRecoveryEligibility(device.deviceId),
      avdName: pooledDevice.avdName,
      incarnation: pooledDevice.incarnation,
    },
    pooled: pooledDevice,
    hold,
    session: sessionInfoByDeviceId?.get(device.deviceId),
    deviceSessionUuid: resolveDeviceSessionUuid(device.deviceId) ?? undefined,
  };
}

function summarizePoolStatus(
  devicePool: DevicePool,
  discoveredDevices: BootedDeviceInfo[],
  succeededPlatforms: Set<Platform>,
): PoolStatusSummary {
  let idle = 0;
  let assigned = 0;
  let error = 0;

  const tally = (status: PoolDeviceStatus | undefined): void => {
    if (status === "idle") {
      idle++;
    } else if (status === "assigned") {
      assigned++;
    } else if (status === "error") {
      error++;
    }
  };

  // For successfully-discovered platforms, count from the live booted list so
  // phantom (shut-down) pool entries are excluded.
  for (const device of discoveredDevices) {
    if (succeededPlatforms.has(device.platform)) {
      if (!device.unhealthy || device.runtime.poolStatus !== "idle") {
        tally(device.runtime.poolStatus ?? undefined);
      }
    }
  }

  // For platforms whose discovery failed/was unavailable, keep the pool's own
  // tracked counts — we cannot confirm which of those entries are phantom.
  for (const pooled of devicePool.getAllDevices()) {
    if (!succeededPlatforms.has(pooled.platform)) {
      if (!devicePool.getDeviceHealthMarker(pooled.id) || pooled.status !== "idle") {
        tally(effectivePoolStatus(pooled.status, poolHoldFor(devicePool, pooled.id)));
      }
    }
  }

  return {
    enabled: true,
    idle,
    assigned,
    error,
    total: idle + assigned + error,
    recoveryPolicy: devicePool.getRecoveryPolicy(),
  };
}

// Handler to get all booted devices (both platforms)
async function getAllBootedDevices(): Promise<ResourceContent> {
  const result = await getBootedDevicesForPlatforms(["android", "ios"]);
  return {
    uri: BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    mimeType: "application/json",
    text: JSON.stringify(result, null, 2),
  };
}

// Handler to get booted devices for a specific platform
async function getBootedDevicesByPlatform(
  params: Record<string, string>,
): Promise<ResourceContent> {
  const platform = params.platform;

  // Validate platform parameter
  if (platform !== "android" && platform !== "ios") {
    return {
      uri: `automobile:devices/booted/${platform}`,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Invalid platform: ${platform}. Must be 'android' or 'ios'.`,
        },
        null,
        2,
      ),
    };
  }

  const result = await getBootedDevicesForPlatforms([platform as Platform]);
  return {
    uri: `automobile:devices/booted/${platform}`,
    mimeType: "application/json",
    text: JSON.stringify(result, null, 2),
  };
}

interface PlatformDiscoveryResult {
  devices: BootedDeviceInfo[];
  succeededPlatforms: Set<Platform>;
  observation: PlatformObservation;
  sourceObservations: Partial<Record<DiscoverySource, PlatformObservation>>;
}

async function discoverBootedDevicesForPlatform(
  platform: Platform,
  devicePool: DevicePool | null,
  sessionInfoByDeviceId: Map<string, Session> | null,
  options: {
    resolveDeviceSessionUuid: (deviceId: string) => string | null;
    timer: Timer;
    onDiscovery: (devices: BootedDeviceInfo[], discovery: BootedDeviceDiscovery) => void;
  },
): Promise<PlatformDiscoveryResult> {
  const { resolveDeviceSessionUuid, timer } = options;
  try {
    const deviceManager = PlatformDeviceManagerFactory.getInstance();
    const rawDiscovery = await deviceManager.getBootedDevicesDetailed(platform, {
      coalesceInventoryEnrichment: true,
      signal: getAbortSignal(),
    });
    getAbortSignal()?.throwIfAborted();
    const aliases = new AndroidTransportAliases(androidTransportIdentityAdbFactory);
    const discovery = {
      ...rawDiscovery,
      devices:
        platform === "android"
          ? devicePool
            ? devicePool.mapAndroidDiscovery(rawDiscovery.devices)
            : aliases.fold(
                rawDiscovery.devices,
                await aliases.prepare(rawDiscovery.devices),
                new Set(),
              )
          : rawDiscovery.devices,
    };
    // FUNNEL 1: fold this observation into the pool BEFORE any of it is joined to
    // pooled identity below. This read can be the first discovery to see the
    // `Unknown (<serial>)` placeholder, and withholding only its own output would
    // leave the pool -- and therefore the admission gate and every stream
    // resolver -- still trusting the stale label
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    await devicePool?.reconcileDiscoveryObservation(discovery.devices, "booted-devices-resource");
    // Refresh the managed-slot snapshot so held devices are not reported as free, as listDevices does.
    await devicePool?.managedSlotStableIds(platform);
    options.onDiscovery(
      discovery.devices.map((device) =>
        withIdentityQuarantineMarker(
          toBootedDeviceInfo(
            device,
            resolvePoolDeviceContext(
              devicePool,
              device,
              sessionInfoByDeviceId,
              resolveDeviceSessionUuid,
            ),
          ),
          devicePool,
        ),
      ),
      discovery,
    );
    const configuredImages = await configuredImagesForBootedPlatform(
      platform,
      deviceManager,
      timer,
    );
    getAbortSignal()?.throwIfAborted();
    const complete = discovery.succeededSources
      ? sourcesForPlatform(platform).every((source) => discovery.succeededSources!.has(source))
      : discovery.succeededPlatforms.has(platform);
    const devices = discovery.devices.map((device) =>
      withIdentityQuarantineMarker(
        toBootedDeviceInfo(
          device,
          resolvePoolDeviceContext(
            devicePool,
            device,
            sessionInfoByDeviceId,
            resolveDeviceSessionUuid,
          ),
          configuredImageForBootedDevice(device, configuredImages),
        ),
        devicePool,
      ),
    );
    const offlineHeld = await adbOfflineHeldDeviceDescriptions({
      platform,
      discovered: discovery.devices,
      devicePool,
      sessionInfoByDeviceId,
      resolveDeviceSessionUuid,
      deviceManager,
      configuredImages,
    });
    // A held AVD re-cold-booting while adb still lists its old serial offline would otherwise
    // appear twice under one stableId (#11132). The held row carries the session and pool status
    // the serial-less cold-boot row lacks, so the cold-boot row is the one dropped.
    const heldStableIds = new Set(offlineHeld.map((device) => device.identity.stableId));
    devices.push(
      ...inFlightAndroidColdBootDescriptions(platform, discovery.devices, configuredImages).filter(
        (device) => !heldStableIds.has(device.identity.stableId),
      ),
      ...offlineHeld,
    );
    return {
      devices,
      succeededPlatforms: complete ? new Set([platform]) : new Set(),
      sourceObservations: Object.fromEntries(
        sourcesForPlatform(platform).map((source) => [
          source,
          {
            observationComplete: discovery.succeededSources
              ? discovery.succeededSources.has(source)
              : discovery.succeededPlatforms.has(platform),
            ...(!(
              discovery.succeededSources?.has(source) ?? discovery.succeededPlatforms.has(platform)
            ) && discovery.sourceErrors?.[source]
              ? { discoveryError: discovery.sourceErrors[source] }
              : {}),
          },
        ]),
      ),
      observation: complete
        ? { observationComplete: true }
        : {
            observationComplete: false,
            discoveryError: bootedDiscoveryError(discovery, platform),
          },
    };
  } catch (error) {
    const platformName = platform === "android" ? "Android" : "iOS";
    logger.warn(`[BootedDeviceResources] Failed to get booted ${platformName} devices: ${error}`);
    return {
      devices: [],
      succeededPlatforms: new Set(),
      sourceObservations: Object.fromEntries(
        sourcesForPlatform(platform).map((source) => [source, { observationComplete: false }]),
      ),
      observation: {
        observationComplete: false,
        discoveryError: {
          code: "failed",
          message: `${platformName} booted-device discovery failed: ${errorMessage(error)}`,
        },
      },
    };
  }
}

interface DaemonDeviceContext {
  devicePool: DevicePool | null;
  poolStatus?: PoolStatusSummary;
  sessionInfoByDeviceId: Map<string, Session> | null;
  resolveDeviceSessionUuid: (deviceId: string) => string | null;
}

function readDaemonDeviceContext(): DaemonDeviceContext {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return {
      devicePool: null,
      sessionInfoByDeviceId: null,
      resolveDeviceSessionUuid: () => null,
    };
  }

  let devicePool: DevicePool | null = null;
  let poolStatus: PoolStatusSummary | undefined;
  let sessionInfoByDeviceId: Map<string, Session> | null = null;
  let resolveDeviceSessionUuid: (deviceId: string) => string | null = () => null;
  try {
    devicePool = daemonState.getDevicePool();
    poolStatus = {
      enabled: true,
      idle: 0,
      assigned: 0,
      error: 0,
      total: 0,
      recoveryPolicy: devicePool.getRecoveryPolicy(),
    };
  } catch (error) {
    logger.warn(`[BootedDeviceResources] Failed to read device pool status: ${error}`);
  }

  try {
    const sessions = daemonState.getSessionManager().getAllSessions();
    sessionInfoByDeviceId = new Map(sessions.map((session) => [session.assignedDevice, session]));
  } catch (error) {
    logger.warn(`[BootedDeviceResources] Failed to read session manager state: ${error}`);
  }

  try {
    const registry = daemonState.getDeviceSessionRegistry();
    resolveDeviceSessionUuid = (deviceId) =>
      registry.getByDeviceId(deviceId)?.deviceSessionUuid ?? null;
  } catch (error) {
    logger.warn(`[BootedDeviceResources] Failed to read device session registry: ${error}`);
  }

  return { devicePool, poolStatus, sessionInfoByDeviceId, resolveDeviceSessionUuid };
}

/**
 * Stamp the entry when the reconciliation this request just performed left the
 * serial under an identity quarantine, so consumers see WHY it carries nothing
 * but discovery identity.
 */
function withIdentityQuarantineMarker(
  device: BootedDeviceInfo,
  devicePool: DevicePool | null,
): BootedDeviceInfo {
  if (
    devicePool?.isPooledIdentityUnresolved(device.runtime.deviceId ?? device.identity.stableId) !==
    true
  ) {
    return device;
  }
  return { ...device, identityUnresolved: true };
}

/**
 * Whether this entry may be PROBED. A quarantined serial is exactly the one the
 * daemon must not address: FUNNEL 2 refuses every device-addressed operation on
 * it, and an enrichment probe is one — package/service queries and
 * `adb dumpsys window policy` issued against whichever runtime now owns the
 * serial. Skipping is what the published `identityUnresolved` marker then
 * explains ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
function isProbeableDevice(device: BootedDeviceInfo): boolean {
  return (
    device.runtime.deviceId !== null &&
    device.identityUnresolved !== true &&
    // adb lists it offline (#11118): every probe would just time out against it.
    device.runtime.connection === undefined
  );
}

const SERVICE_STATUS_TIMEOUT_MS = 5000;
const BOOT_COMPLETION_TIMEOUT_MS = 3000;

async function probeBootCompletionWithBudget(
  device: BootedDeviceInfo,
  factory: AdbClientFactory,
  deadlineMs: number,
  timer: Timer,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = new Error("Boot completion probe timed out");
  try {
    return await withRemainingBudget(
      deadlineMs,
      timer,
      undefined,
      async (_signal, remainingMs) =>
        await raceWithDeadline(
          factory
            .create(probeTarget(device))
            .executeCommand(
              "shell getprop sys.boot_completed",
              remainingMs,
              undefined,
              true,
              combineWithAmbientAbort(controller.signal),
            )
            .then((result) => result.stdout.trim()),
          {
            timer,
            timeoutMs: remainingMs,
            label: "Boot completion probe",
            timeoutError: () => timeout,
            onTimeout: () => {
              controller.abort();
              logger.warn(
                `[BootedDeviceResources] Boot completion probe timed out for ${device.runtime.deviceId}`,
              );
            },
          },
        ),
    );
  } catch (error) {
    if (error === timeout) {
      return null;
    }
    logger.warn(
      `[BootedDeviceResources] Boot completion probe failed for ${device.runtime.deviceId}: ${errorMessage(error)}`,
    );
    return null;
  }
}

async function enrichDeviceBootCompletion(
  devices: BootedDeviceInfo[],
  timer: Timer,
): Promise<void> {
  const factory =
    injectedBootCompletionAdbFactory ?? (serviceStatusEnabled ? defaultAdbClientFactory : null);
  const deadlineMs = timer.now() + BOOT_COMPLETION_TIMEOUT_MS;
  const results = await Promise.all(
    devices.map((device) =>
      device.platform === "android" && isProbeableDevice(device) && factory
        ? probeBootCompletionWithBudget(device, factory, deadlineMs, timer)
        : Promise.resolve(null),
    ),
  );
  for (let i = 0; i < devices.length; i++) {
    if (devices[i].platform !== "android" || !isProbeableDevice(devices[i])) {
      continue;
    }
    const result = results[i];
    const updated = withDeviceLifecycle(
      devices[i],
      result === null
        ? { state: "booted", known: false }
        : result === "1"
          ? { state: "booted", known: true }
          : { state: "booting", known: true },
    );
    devices[i] = { ...devices[i], runtime: updated.runtime };
  }
}

/** Probes one device's automation-service status; resolves undefined when the platform has none. */
export type ServiceStatusProbe = (
  device: BootedDeviceProbeTarget,
) => Promise<DeviceServiceStatus | undefined>;

// Injected only by tests, which need a deterministic service-status result without real CtrlProxy
// I/O. When null, the real CtrlProxy-backed probe runs — but only while `serviceStatusEnabled`
// (i.e. no fake device manager), mirroring how the lock probe is gated.
let injectedServiceStatusProbe: ServiceStatusProbe | null = null;

/** Inject a fake service-status probe for tests (or null to restore the real CtrlProxy-backed probe). */
export function setServiceStatusProbe(probe: ServiceStatusProbe | null): void {
  injectedServiceStatusProbe = probe;
}

const realServiceStatusProbe: ServiceStatusProbe = (device) => queryDeviceServiceStatus(device);

/** The active service-status probe: an injected fake (tests) or the real CtrlProxy probe when no fake manager is set. */
function activeServiceStatusProbe(): ServiceStatusProbe | null {
  return injectedServiceStatusProbe ?? (serviceStatusEnabled ? realServiceStatusProbe : null);
}

/** Outcome of a bounded service-status probe: at most one of `status` (success) or `diagnostic` (transient failure). */
export interface ServiceStatusProbeOutcome {
  status?: DeviceServiceStatus;
  diagnostic?: ServiceStatusDiagnostic;
}

/**
 * Run [probe] for one device bounded by the caller's absolute [deadlineMs]. A hang yields a
 * TRANSIENT "timeout" diagnostic and a thrown failure (e.g. a CtrlProxy loopback connection
 * refused/reset) yields "unreachable" — this function never rejects, so a probe failure can never
 * drop the device or mark it unavailable (#7053). The bounded wait is driven off the injected
 * [timer] and its losing handle is always cleared, so a fast success logs nothing.
 */
export async function probeServiceStatusWithBudget(
  device: BootedDeviceProbeTarget,
  probe: ServiceStatusProbe,
  deadlineMs: number,
  timer: Timer = defaultTimer,
): Promise<ServiceStatusProbeOutcome> {
  try {
    return await withRemainingBudget(deadlineMs, timer, undefined, async (_signal, remainingMs) => {
      type Race =
        | { kind: "settled"; status: DeviceServiceStatus | undefined }
        | { kind: "failed"; error: unknown };
      const timeout = new Error("Service status probe timed out");
      let raced: Race;
      try {
        raced = await raceWithDeadline(
          probe(device).then(
            (status): Race => ({ kind: "settled", status }),
            (error): Race => ({ kind: "failed", error }),
          ),
          {
            timer,
            timeoutMs: remainingMs,
            label: "Service status probe",
            timeoutError: () => timeout,
          },
        );
      } catch (error) {
        if (error !== timeout) {
          throw error;
        }
        logger.warn(`[BootedDeviceResources] Service status timeout for ${device.deviceId}`);
        return {
          diagnostic: {
            state: "timeout",
            reason: `Service-status probe did not settle within ${remainingMs}ms`,
          },
        };
      }
      if (raced.kind === "failed") {
        const reason = errorMessage(raced.error);
        logger.warn(
          `[BootedDeviceResources] Service status unreachable for ${device.deviceId}: ${reason}`,
        );
        return { diagnostic: { state: "unreachable", reason } };
      }
      return raced.status ? { status: raced.status } : {};
    });
  } catch (error) {
    // withRemainingBudget throws only when the budget was already spent before the probe began;
    // that is a timeout, surfaced transiently so the booted device still appears in the list.
    const reason = errorMessage(error);
    logger.warn(
      `[BootedDeviceResources] Service status budget elapsed for ${device.deviceId}: ${reason}`,
    );
    return { diagnostic: { state: "timeout", reason } };
  }
}

/**
 * Enrich each PROBEABLE booted device with its automation-service status, bounded by a single
 * per-observation deadline. A device whose probe times out or is unreachable keeps its place in the
 * list with a transient {@link ServiceStatusDiagnostic}; it is never dropped and its readiness is
 * left untouched (#7053). Exported for direct, timer-controlled unit tests.
 */
export async function enrichDeviceServiceStatuses(
  devices: BootedDeviceInfo[],
  timer: Timer = defaultTimer,
): Promise<void> {
  const probe = activeServiceStatusProbe();
  if (!probe) {
    return;
  }

  const deadlineMs = timer.now() + SERVICE_STATUS_TIMEOUT_MS;
  const outcomes = await Promise.all(
    devices.map(async (device) =>
      isProbeableDevice(device)
        ? await probeServiceStatusWithBudget(probeTarget(device), probe, deadlineMs, timer)
        : undefined,
    ),
  );

  for (let i = 0; i < devices.length; i++) {
    const outcome = outcomes[i];
    if (!outcome) {
      continue;
    }
    if (outcome.status) {
      devices[i] = withServiceStatus(devices[i], outcome.status);
    } else if (outcome.diagnostic) {
      devices[i] = withServiceStatusDiagnostic(devices[i], outcome.diagnostic);
    }
  }
}

/**
 * Attach a transient service-status diagnostic. Readiness is deliberately left as discovery set it
 * (`unknown` for a freshly-discovered device): a momentary probe failure must never demote a booted
 * device to `not_ready`/unavailable (#7053).
 */
function withServiceStatusDiagnostic(
  device: BootedDeviceInfo,
  diagnostic: ServiceStatusDiagnostic,
): BootedDeviceInfo {
  return { ...device, serviceStatusDiagnostic: diagnostic };
}

function withServiceStatus(
  device: BootedDeviceInfo,
  serviceStatus: DeviceServiceStatus,
): BootedDeviceInfo {
  const updated = withDeviceServiceStatus(device, serviceStatus);
  return {
    ...device,
    runtime: { ...device.runtime, ...updated.runtime },
    // A confirmed status supersedes any transient diagnostic from an earlier failed probe.
    serviceStatusDiagnostic: undefined,
  };
}

export function readinessFromServiceStatus(
  platform: Platform,
  serviceStatus: DeviceServiceStatus,
): DeviceDescription["runtime"]["readiness"] {
  if (!serviceStatus.installed || !serviceStatus.enabled || !serviceStatus.isCompatible) {
    return { state: "not_ready" };
  }
  // A resource read observes an existing connection without opening one. No connection
  // is inconclusive on either platform; an installed/enabled service can be usable next call.
  return { state: serviceStatus.running ? "ready" : "unknown" };
}

async function enrichDeviceLockStates(
  devices: BootedDeviceInfo[],
  options: { timer?: Timer } = {},
): Promise<void> {
  const timer = options.timer ?? defaultTimer;
  const lockProbe = activeLockProbe();
  if (!lockProbe) {
    return;
  }

  const lockResults = await Promise.allSettled(
    devices.map(async (device) =>
      isProbeableDevice(device)
        ? await probeDeviceLock(probeTarget(device), { lockProbe, timer })
        : undefined,
    ),
  );

  for (let i = 0; i < devices.length; i++) {
    const result = lockResults[i];
    if (result.status === "fulfilled" && result.value !== undefined) {
      devices[i] = {
        ...devices[i],
        runtime: {
          ...devices[i].runtime,
          ...withDeviceRuntimeObservation(devices[i], { locked: result.value }).runtime,
        },
      };
    }
  }
}

const ORIENTATION_TIMEOUT_MS = 3_000;

export async function probeDeviceOrientation(
  device: BootedDevice,
  reader: OrientationReader,
  deadlineMs: number,
  timer: Timer,
): Promise<"portrait" | "landscape" | null> {
  const timeout = new Error(`[BootedDeviceResources] Orientation timeout for ${device.deviceId}`);
  try {
    return await withRemainingBudget(deadlineMs, timer, undefined, async (_signal, remainingMs) => {
      const controller = new AbortController();
      return await raceWithDeadline(
        reader.readOrientation(device, combineWithAmbientAbort(controller.signal)),
        {
          timer,
          timeoutMs: remainingMs,
          label: "Orientation probe",
          timeoutError: () => timeout,
          onTimeout: () => {
            controller.abort(timeout);
            logger.warn(timeout.message);
          },
        },
      );
    });
  } catch (error) {
    if (error === timeout) {
      return null;
    }
    logger.warn(
      `[BootedDeviceResources] Failed to query orientation for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return null;
  }
}

async function enrichDeviceOrientations(
  devices: BootedDeviceInfo[],
  timer: Timer = defaultTimer,
): Promise<void> {
  const readerFactory = activeOrientationReaderFactory();
  if (!readerFactory) {
    return;
  }
  const deadlineMs = timer.now() + ORIENTATION_TIMEOUT_MS;
  const orientations = await Promise.all(
    devices.map(async (device) =>
      isProbeableDevice(device)
        ? await probeDeviceOrientation(
            probeTarget(device),
            readerFactory(probeTarget(device)),
            deadlineMs,
            timer,
          )
        : null,
    ),
  );
  for (let i = 0; i < devices.length; i++) {
    const orientation = orientations[i];
    if (orientation) {
      const updated = withDeviceRuntimeObservation(devices[i], { orientation });
      devices[i] = { ...devices[i], runtime: { ...devices[i].runtime, ...updated.runtime } };
    }
  }
}

// Core computation to fetch booted devices for specified platforms
async function computeBootedDevicesForPlatforms(
  platforms: Platform[],
  timer: Timer,
): Promise<BootedDevicesResourceContent> {
  const devices: BootedDeviceInfo[] = [];
  const daemonContext = readDaemonDeviceContext();

  const succeededPlatforms = new Set<Platform>();
  const platformObservations: Partial<Record<Platform, PlatformObservation>> = {};
  const sourceObservations: Partial<Record<DiscoverySource, PlatformObservation>> = {};

  const controller = new AbortController();
  const pending = new Set<string>(["discovery", "configuredImages"]);
  let enrichment: BootedDevicesResourceContent["enrichment"];
  const work = runWithAbortSignal(controller.signal, async () => {
    for (const platform of platforms) {
      const discovery = await discoverBootedDevicesForPlatform(
        platform,
        daemonContext.devicePool,
        daemonContext.sessionInfoByDeviceId,
        {
          resolveDeviceSessionUuid: daemonContext.resolveDeviceSessionUuid,
          timer,
          onDiscovery: (known, snapshot) => {
            devices.push(...known);
            pending.delete("discovery");
            const complete = sourcesForPlatform(platform).every(
              (source) =>
                snapshot.succeededSources?.has(source) ?? snapshot.succeededPlatforms.has(platform),
            );
            platformObservations[platform] = { observationComplete: complete };
            if (complete) {
              succeededPlatforms.add(platform);
            }
            for (const source of sourcesForPlatform(platform)) {
              sourceObservations[source] = {
                observationComplete: snapshot.succeededSources?.has(source) ?? complete,
              };
            }
          },
        },
      );
      controller.signal.throwIfAborted();
      const otherPlatforms = devices.filter((device) => device.platform !== platform);
      devices.splice(0, devices.length, ...otherPlatforms, ...discovery.devices);
      platformObservations[platform] = discovery.observation;
      Object.assign(sourceObservations, discovery.sourceObservations);
      for (const discoveredPlatform of discovery.succeededPlatforms) {
        succeededPlatforms.add(discoveredPlatform);
      }
    }
    pending.clear();
    const probes = [
      ["bootCompletion", () => enrichDeviceBootCompletion(devices, timer)],
      ["serviceStatus", () => enrichDeviceServiceStatuses(devices, timer)],
      ["lock", () => enrichDeviceLockStates(devices, { timer })],
      ["orientation", () => enrichDeviceOrientations(devices, timer)],
    ] as const;
    for (const [name] of probes) {
      pending.add(name);
    }
    await Promise.all(
      probes.map(async ([name, probe]) => {
        await probe();
        pending.delete(name);
      }),
    );
  });
  try {
    await raceWithDeadline(work, {
      timer,
      timeoutMs: BOOTED_DEVICES_RESOURCE_BUDGET_MS,
      label: "Booted inventory enrichment",
      onTimeout: () => controller.abort(new Error("Booted inventory enrichment budget elapsed")),
    });
  } catch (error) {
    logger.warn(
      `[BootedDeviceResources] Returning bounded incomplete enrichment: ${errorMessage(error)}`,
      error,
    );
    enrichment = {
      complete: false,
      pending: [...pending],
      retryable: true,
      retryAfterMs: BOOTED_DEVICES_RETRY_AFTER_MS,
      reason: errorMessage(error),
    };
  }

  const virtualCount = devices.filter((device) => device.isVirtual).length;
  const physicalCount = devices.length - virtualCount;
  const poolStatus =
    daemonContext.poolStatus && daemonContext.devicePool
      ? summarizePoolStatus(daemonContext.devicePool, devices, succeededPlatforms)
      : undefined;

  return {
    totalCount: devices.length,
    androidCount: devices.filter((device) => device.platform === "android").length,
    iosCount: devices.filter((device) => device.platform === "ios").length,
    virtualCount,
    physicalCount,
    lastUpdated: new Date().toISOString(),
    observationComplete: platforms.every(
      (platform) => platformObservations[platform]?.observationComplete === true,
    ),
    platformObservations,
    sourceObservations,
    poolStatus,
    ...(enrichment ? { enrichment } : {}),
    // Pending probes replace entries on their private working array; freeze the returned snapshot.
    devices: [...devices],
  };
}

export async function getBootedDevicesForPlatforms(
  platforms: Platform[],
  timer: Timer = defaultTimer,
): Promise<BootedDevicesResourceContent> {
  const canonicalPlatforms = [...new Set(platforms)].sort();
  const cacheKey = canonicalPlatforms.join(",");
  const cached = getBootedDevicesResourceCache(timer).get(cacheKey);
  if (cached) {
    return cached;
  }

  return await bootedDevicesResourceSingleFlight.run(
    cacheKey,
    () =>
      runWithAbortSignal(undefined, async () => {
        const generation = ++bootedDevicesResourceGeneration;
        const result = await computeBootedDevicesForPlatforms(canonicalPlatforms, timer);
        if (generation >= bootedDevicesResourcePublishedGeneration && !result.enrichment) {
          bootedDevicesResourcePublishedGeneration = generation;
          getBootedDevicesResourceCache(timer).set(cacheKey, result);
        }
        return result;
      }),
    getAbortSignal(),
  );
}

export interface AndroidServiceStatusLookup {
  getManager(
    device: BootedDevice,
  ): Pick<AndroidCtrlProxyManager, "isInstalled" | "isEnabled" | "getInstalledApkSha256">;
  isConnected(deviceId: string): boolean;
}

const defaultAndroidServiceStatusLookup: AndroidServiceStatusLookup = {
  getManager: (device) => AndroidCtrlProxyManager.getInstance(device),
  isConnected: (deviceId) =>
    AndroidCtrlProxyClient.getExistingInstance(deviceId)?.isConnected() ?? false,
};

export interface CtrlProxyVersionLookup {
  getVersion(
    device: Pick<BootedDevice, "name" | "platform" | "deviceId" | "source">,
  ): Promise<CtrlProxyVersionInfo | undefined>;
}

const defaultCtrlProxyVersionLookup: CtrlProxyVersionLookup = {
  async getVersion(device) {
    try {
      if (device.platform === "android") {
        const metadata = await getAndroidAppMetadataViaAdb(
          device,
          AndroidCtrlProxyManager.PACKAGE,
          undefined,
          {
            timeoutMs: CTRL_PROXY_VERSION_TIMEOUT_MS,
            optional: true,
          },
        );
        return metadata
          ? {
              versionName: metadata.versionName || undefined,
              versionCode: metadata.buildNumber || undefined,
              source: "android-package",
            }
          : undefined;
      }
      if (device.platform === "ios") {
        const version = await IOSCtrlProxyManager.getInstance(device).getInstalledVersionIdentity();
        return version ? { build: version, source: "ios-runner-bundle" } : undefined;
      }
      return undefined;
    } catch (error) {
      // Version metadata is optional diagnostic enrichment, so service-status reads remain available.
      logger.debug(
        `[BootedDeviceResources] CtrlProxy version lookup failed for ${device.deviceId}: ${error}`,
      );
      return undefined;
    }
  },
};

const noOpCtrlProxyVersionLookup: CtrlProxyVersionLookup = {
  getVersion: async () => undefined,
};

const CTRL_PROXY_VERSION_TIMEOUT_MS = 2000;

function legacyVersion(version: CtrlProxyVersionInfo): string | undefined {
  return version.versionName ?? version.build ?? version.versionCode;
}

async function getCtrlProxyVersion(
  device: BootedDevice,
  versionLookup: CtrlProxyVersionLookup,
  timer: Timer = defaultTimer,
): Promise<CtrlProxyVersionInfo | undefined> {
  const timeout = new Error("CtrlProxy version lookup timed out");
  try {
    return await raceWithDeadline(versionLookup.getVersion(device), {
      timer,
      timeoutMs: CTRL_PROXY_VERSION_TIMEOUT_MS,
      label: "CtrlProxy version lookup",
      timeoutError: () => timeout,
      onTimeout: () =>
        logger.debug(
          `[BootedDeviceResources] CtrlProxy version lookup timed out for ${device.deviceId}`,
        ),
    });
  } catch (error) {
    if (error === timeout) {
      return undefined;
    }
    // Injected best-effort metadata lookups must not make service-status reads fail.
    logger.debug(
      `[BootedDeviceResources] CtrlProxy version lookup failed for ${device.deviceId}: ${error}`,
    );
    return undefined;
  }
}

function iosRunnerCommandsComplete(
  device: BootedDeviceProbeTarget,
  advertised: ReadonlySet<string>,
  options: { runnerCommandRequirements?: IosRunnerCommandRequirements },
): boolean {
  const environment =
    device.isVirtual === undefined ? undefined : device.isVirtual ? "simulator" : "physical";
  return (
    getMissingIosRunnerFeatureCommands(advertised, environment, options.runnerCommandRequirements)
      .length === 0
  );
}

interface IosServiceStatusProbe {
  manager: IOSCtrlProxyManager;
  installed: boolean;
  health: CtrlProxyHealthCheckResult;
  version: CtrlProxyVersionInfo | undefined;
}

function resolveCtrlProxyVersionLookup(
  androidLookup: AndroidServiceStatusLookup,
  versionLookup: CtrlProxyVersionLookup | undefined,
): CtrlProxyVersionLookup {
  return (
    versionLookup ??
    (androidLookup === defaultAndroidServiceStatusLookup
      ? defaultCtrlProxyVersionLookup
      : noOpCtrlProxyVersionLookup)
  );
}

async function queryAndroidDeviceServiceStatus(
  device: BootedDeviceProbeTarget,
  bootedDevice: BootedDevice,
  androidLookup: AndroidServiceStatusLookup,
  resolvedVersionLookup: CtrlProxyVersionLookup,
  timer: Timer,
): Promise<DeviceServiceStatus> {
  const manager = androidLookup.getManager(bootedDevice);
  const [installed, enabled, installedSha256, version] = await Promise.all([
    manager.isInstalled(),
    manager.isEnabled(),
    manager.getInstalledApkSha256(),
    getCtrlProxyVersion(bootedDevice, resolvedVersionLookup, timer),
  ]);
  const expectedSha256 = resolveApkChecksum();
  // An explicit pin absent from the registry yields an empty expected checksum,
  // which must NOT read as "compatible" — the installed APK is unverifiable (#2746).
  const isCompatible =
    !AndroidCtrlProxyManager.isPinnedVersionUnverifiable() &&
    (expectedSha256.length === 0 ||
      (installedSha256 !== null && installedSha256.toLowerCase() === expectedSha256.toLowerCase()));
  return {
    installed,
    enabled,
    running: androidLookup.isConnected(device.deviceId),
    installedSha256,
    expectedSha256,
    isCompatible,
    ...(installed && version
      ? {
          versionInfo: version,
          ...(legacyVersion(version) ? { version: legacyVersion(version) } : {}),
        }
      : {}),
  };
}

function readIosRunnerIdentity(
  device: BootedDeviceProbeTarget,
  bootedDevice: BootedDevice,
  running: boolean,
  options: { runnerCommandRequirements?: IosRunnerCommandRequirements },
) {
  // The iOS runner exposes no hash/version, so identity comes from the cached
  // `supportedCommands` handshake. Read it connection-free (this hot path must
  // not open a WebSocket); null means identity is unknown this fetch.
  let supportedCommandsComplete: boolean | null = null;
  let supportedFeaturesComplete: boolean | null = null;
  if (running) {
    const client = IOSCtrlProxyClient.getExistingInstance(bootedDevice.deviceId);
    const cached = client?.getCachedSupportedCommands() ?? null;
    if (cached !== null) {
      const advertised = new Set(cached);
      supportedCommandsComplete = iosRunnerCommandsComplete(device, advertised, options);
    }
    const requiredFeatures = getRequiredIosRunnerFeatureFlags();
    const cachedFeatures = client?.getCachedSupportedFeatures() ?? null;
    if (requiredFeatures.length === 0) {
      supportedFeaturesComplete = true;
    } else if (cachedFeatures !== null) {
      const advertisedFeatures = new Set(cachedFeatures);
      supportedFeaturesComplete = requiredFeatures.every((feature) =>
        advertisedFeatures.has(feature),
      );
    }
  }

  return { supportedCommandsComplete, supportedFeaturesComplete };
}

function describeIosRecovery(
  restartBudget: ForcedRestartSnapshot,
): Pick<DeviceServiceStatus, "recovery"> {
  return restartBudget.state === "idle"
    ? {}
    : {
        recovery: {
          state: restartBudget.state,
          attempts: restartBudget.attempts,
          ...(restartBudget.lastFailureReason
            ? {
                reason:
                  restartBudget.state === "suspended"
                    ? "device removed or cleanup failed"
                    : "CtrlProxy restart failed",
              }
            : {}),
          ...(restartBudget.nextAttemptAtMs === undefined
            ? {}
            : { nextAttemptAt: new Date(restartBudget.nextAttemptAtMs).toISOString() }),
        },
      };
}

function buildIosDeviceServiceStatus(
  device: BootedDeviceProbeTarget,
  bootedDevice: BootedDevice,
  iosProbe: IosServiceStatusProbe,
  options: { runnerCommandRequirements?: IosRunnerCommandRequirements },
): DeviceServiceStatus {
  const { manager, installed, health, version } = iosProbe;
  const running = health.ok;
  const expectedSha256 = resolveIpaChecksum();

  const { supportedCommandsComplete, supportedFeaturesComplete } = readIosRunnerIdentity(
    device,
    bootedDevice,
    running,
    options,
  );

  // Only claim compatibility we can actually verify. isCompatible is true
  // *only* when the runner's advertised command set is known complete; a stale
  // runner (incomplete) or an unknown one (no cached handshake yet) is reported
  // not-compatible rather than the previous always-true reassurance. An
  // unverifiable explicit pin is never compatible (#2746).
  const isCompatible =
    supportedCommandsComplete === true &&
    supportedFeaturesComplete === true &&
    !IosCtrlProxyBuilder.isPinnedVersionUnverifiable();
  const restartBudget = manager.getForcedRestartBudget().snapshot();

  return {
    installed,
    enabled: running,
    running,
    installedSha256: null,
    expectedSha256,
    isCompatible,
    // isInstalled() is host-wide/unconditional for simulators; running is the per-device signal.
    ...(installed && running && version
      ? {
          versionInfo: version,
          ...(legacyVersion(version) ? { version: legacyVersion(version) } : {}),
        }
      : {}),
    supportedCommandsComplete,
    supportedFeaturesComplete,
    ...describeIosRecovery(restartBudget),
  };
}

// Query service status for a single booted device
export async function queryDeviceServiceStatus(
  device: BootedDeviceProbeTarget,
  androidLookup: AndroidServiceStatusLookup = defaultAndroidServiceStatusLookup,
  versionLookup?: CtrlProxyVersionLookup,
  timer: Timer = defaultTimer,
  options: { runnerCommandRequirements?: IosRunnerCommandRequirements } = {},
): Promise<DeviceServiceStatus | undefined> {
  const bootedDevice: BootedDevice = {
    name: device.name,
    platform: device.platform,
    deviceId: device.deviceId,
    source: device.source,
  };
  const resolvedVersionLookup = resolveCtrlProxyVersionLookup(androidLookup, versionLookup);

  let iosProbe: IosServiceStatusProbe | undefined;
  if (device.platform === "ios") {
    try {
      const manager = IOSCtrlProxyManager.getInstance(bootedDevice);
      const [installed, health, version] = await Promise.all([
        manager.isInstalled(),
        manager.checkRunningWithReason(),
        getCtrlProxyVersion(bootedDevice, resolvedVersionLookup, timer),
      ]);
      iosProbe = { manager, installed, health, version };
    } catch (error) {
      logger.warn(
        `[BootedDeviceResources] Service status query failed for ${device.deviceId}: ${error}`,
      );
      return undefined;
    }
    if (!iosProbe.health.ok && ["refused", "reset", "timeout"].includes(iosProbe.health.reason)) {
      // The bounded probe classifies transient transport failures as diagnostics.
      // Throw outside the best-effort status catch so it can observe the failure.
      throw new Error(
        `CtrlProxy iOS health probe ${iosProbe.health.reason} for ${device.deviceId}`,
      );
    }
  }

  try {
    if (device.platform === "android") {
      return await queryAndroidDeviceServiceStatus(
        device,
        bootedDevice,
        androidLookup,
        resolvedVersionLookup,
        timer,
      );
    } else if (device.platform === "ios" && iosProbe) {
      return buildIosDeviceServiceStatus(device, bootedDevice, iosProbe, options);
    }
  } catch (error) {
    logger.warn(
      `[BootedDeviceResources] Service status query failed for ${device.deviceId}: ${error}`,
    );
  }
  return undefined;
}

// Register all booted device resources
export function registerBootedDeviceResources(): void {
  // Register the all-booted-devices resource
  ResourceRegistry.register(
    BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    "Booted Devices",
    "List of all currently booted/running devices for both Android and iOS platforms.",
    "application/json",
    getAllBootedDevices,
  );

  // Register the platform-specific template
  ResourceRegistry.registerTemplate(
    BOOTED_DEVICE_RESOURCE_URIS.PLATFORM_TEMPLATE,
    "Platform-specific Booted Devices",
    "List of booted/running devices for a specific platform (android or ios).",
    "application/json",
    getBootedDevicesByPlatform,
  );

  // Register the lightweight per-device lock-state resource (issue #5056).
  ResourceRegistry.register(
    DEVICE_LOCK_STATES_RESOURCE_URI,
    "Device Lock States",
    "Per-device keyguard/lock state (Android). Lightweight — enumerates booted devices and runs only the keyguard probe, without the service-status computation the full booted-devices resource does.",
    "application/json",
    getDeviceLockStates,
  );

  logger.info("[BootedDeviceResources] Registered booted device resources");
}

// Send notifications for booted device resource updates. Both the full booted-devices resource and
// the lightweight lock-states resource (#5056) enumerate the same booted inventory, so a device
// starting/killing changes both — notify subscribers of each, not just the full resource.
export async function notifyBootedDeviceResourcesUpdated(): Promise<void> {
  resetBootedDevicesResourceCache();
  await ResourceRegistry.notifyResourcesUpdated([
    BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/android`,
    `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/ios`,
    DEVICE_LOCK_STATES_RESOURCE_URI,
  ]);
}
