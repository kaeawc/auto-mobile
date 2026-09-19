import { errorMessage } from "../utils/describeUnknownError";
import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { type DeviceDiscoveryError, PlatformDeviceManager } from "../utils/deviceUtils";
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
  withDeviceServiceStatus,
  type BootedDeviceDescription,
  type DeviceDescription,
} from "./deviceDescription";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { getAndroidAppMetadataViaAdb } from "../features/observe/GetAppMetadata";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { IOSCtrlProxyBuilder } from "../utils/IOSCtrlProxyBuilder";
import {
  IOSCtrlProxyClient,
  IOS_RUNNER_FEATURE_COMMANDS,
  getRequiredIosRunnerFeatureFlags,
} from "../features/observe/ios/IOSCtrlProxyClient";
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
  IOSOrientationReader,
  type OrientationReader,
} from "../features/action/OrientationReader";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import type { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";

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

// Per-device lock state. `locked` is Android-only (from the keyguard probe) and omitted when it
// could not be read — a transient failure, or iOS, which has no lock probe.
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
  recoveryEligibility: DeviceRecoveryEligibility | null;
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
  identityUnresolved: boolean;
}

type BootedDeviceProbeTarget = {
  name: string;
  platform: Platform;
  deviceId: string;
  source?: "local";
};

function probeTarget(device: BootedDeviceInfo): BootedDeviceProbeTarget {
  return {
    name: device.name,
    platform: device.platform,
    deviceId: device.runtime.deviceId ?? device.identity.stableId,
    ...(device.source === "local" ? { source: "local" as const } : {}),
  };
}

// Resource content schema
export interface BootedDevicesResourceContent {
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

// Controls whether service status is queried for each device.
// Disabled automatically when a test device manager is injected.
let serviceStatusEnabled = true;

/** Probes a device's lock state; returns `undefined` when it can't be determined. */
export type DeviceLockProbe = (device: BootedDevice) => Promise<boolean | undefined>;

// Injected only by tests, which need a deterministic lock state without real adb. When null, the
// real adb-backed probe runs — but only while `serviceStatusEnabled` (i.e. no fake manager), so a
// test that injects a fake device manager never triggers a real `dumpsys` unless it opts in here.
let injectedLockProbe: DeviceLockProbe | null = null;

/** Inject a fake lock probe for tests (or null to restore the real adb-backed probe). */
export function setDeviceLockProbe(probe: DeviceLockProbe | null): void {
  injectedLockProbe = probe;
}

/**
 * Real lock-state probe: reads the Android keyguard via `dumpsys window policy` (issue #4235). iOS
 * has no lock-state probe yet, so it returns `undefined` (the field is then omitted). A failed read
 * also yields `undefined` — lock state is advisory, never fatal to the resource.
 */
async function realDeviceLockProbe(device: BootedDevice): Promise<boolean | undefined> {
  if (device.platform !== "android") {
    return undefined;
  }
  const lock = await defaultAdbClientFactory.create(device).getDeviceLock();
  return lock?.locked;
}

const LOCK_STATE_TIMEOUT_MS = 3000;

/** The active lock probe: an injected fake (tests) or the real adb probe when no fake manager is set. */
function activeLockProbe(): DeviceLockProbe | null {
  return injectedLockProbe ?? (serviceStatusEnabled ? realDeviceLockProbe : null);
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
    : new IOSOrientationReader();
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
  lockProbe: DeviceLockProbe,
): Promise<boolean | undefined> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lockProbe(device),
      new Promise<undefined>((resolve) => {
        timeoutHandle = defaultTimer.setTimeout(() => {
          logger.warn(`[BootedDeviceResources] Lock-state timeout for ${device.deviceId}`);
          resolve(undefined);
        }, LOCK_STATE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn(
      `[BootedDeviceResources] Failed to query lock state for ${device.deviceId}: ${error}`,
    );
    return undefined;
  } finally {
    if (timeoutHandle) {
      defaultTimer.clearTimeout(timeoutHandle);
    }
  }
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
      devices.push(...discovery.devices);
      const complete = sourcesForPlatform(platform).every(
        (source) =>
          discovery.succeededSources?.has(source) ?? discovery.succeededPlatforms.has(platform),
      );
      if (complete) {
        succeededPlatforms.add(platform);
      } else {
        discoveryErrors[platform] = discovery.discoveryErrors?.[platform] ?? {
          code: "failed",
          message: `${platform === "android" ? "Android" : "iOS"} booted-device discovery did not complete.`,
        };
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
      devices.map((device) => probeDeviceLock(device, lockProbe)),
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
): BootedDeviceInfo {
  const description = describeDevice({
    kind: "booted",
    device,
    pooled: poolContext?.pooled,
    configured,
    // Preserve the pool's already-published assignment in the canonical session
    // when the optional session-detail map is unavailable for this observation.
    session:
      poolContext?.session ??
      (poolContext?.poolInfo.assignedSession
        ? { sessionId: poolContext.poolInfo.assignedSession }
        : undefined),
    deviceSessionUuid: poolContext?.deviceSessionUuid,
  });
  const projected = projectBootedDevice(description);
  return {
    ...projected,
    recoveryEligibility: poolContext?.poolInfo.recoveryEligibility ?? null,
    identityUnresolved: false,
  };
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
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    timeoutHandle = timer.setTimeout(() => {
      controller.abort(
        new Error(
          `Configured ${platform} image inventory timed out after ${CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS}ms`,
        ),
      );
    }, CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS);
    const [discovery, androidProvenance] = await Promise.all([
      deviceManager.getDeviceImagesDetailed(platform, { signal: controller.signal }),
      avdManager
        ? AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer)
        : Promise.resolve(new Map()),
    ]);
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
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
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

  const poolStatus: PoolDeviceStatus =
    pooledDevice.status === "busy" ? "assigned" : pooledDevice.status;

  return {
    poolInfo: {
      poolStatus,
      assignedSession: pooledDevice.sessionId || undefined,
      recoveryEligibility: devicePool.getRecoveryEligibility(device.deviceId),
      avdName: pooledDevice.avdName,
      incarnation: pooledDevice.incarnation,
    },
    pooled: pooledDevice,
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
      tally(device.runtime.poolStatus ?? undefined);
    }
  }

  // For platforms whose discovery failed/was unavailable, keep the pool's own
  // tracked counts — we cannot confirm which of those entries are phantom.
  for (const pooled of devicePool.getAllDevices()) {
    if (!succeededPlatforms.has(pooled.platform)) {
      tally(pooled.status === "busy" ? "assigned" : pooled.status);
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
  resolveDeviceSessionUuid: (deviceId: string) => string | null,
): Promise<PlatformDiscoveryResult> {
  try {
    const deviceManager = PlatformDeviceManagerFactory.getInstance();
    const discovery = await deviceManager.getBootedDevicesDetailed(platform);
    // FUNNEL 1: fold this observation into the pool BEFORE any of it is joined to
    // pooled identity below. This read can be the first discovery to see the
    // `Unknown (<serial>)` placeholder, and withholding only its own output would
    // leave the pool -- and therefore the admission gate and every stream
    // resolver -- still trusting the stale label
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    await devicePool?.reconcileDiscoveryObservation(discovery.devices, "booted-devices-resource");
    const configuredImages = await configuredImagesForBootedPlatform(platform);
    const complete = discovery.succeededSources
      ? sourcesForPlatform(platform).every((source) => discovery.succeededSources!.has(source))
      : discovery.succeededPlatforms.has(platform);
    return {
      devices: discovery.devices.map((device) =>
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
      ),
      succeededPlatforms: complete ? new Set([platform]) : new Set(),
      sourceObservations: Object.fromEntries(
        sourcesForPlatform(platform).map((source) => [
          source,
          {
            observationComplete: discovery.succeededSources
              ? discovery.succeededSources.has(source)
              : discovery.succeededPlatforms.has(platform),
          },
        ]),
      ),
      observation: complete
        ? { observationComplete: true }
        : {
            observationComplete: false,
            discoveryError: discovery.discoveryErrors?.[platform] ?? {
              code: "failed",
              message: `${platform === "android" ? "Android" : "iOS"} booted-device discovery did not complete.`,
            },
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
  return device.identityUnresolved !== true;
}

const SERVICE_STATUS_TIMEOUT_MS = 5000;

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
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await withRemainingBudget(deadlineMs, timer, undefined, async (_signal, remainingMs) => {
      type Race =
        | { kind: "settled"; status: DeviceServiceStatus | undefined }
        | { kind: "failed"; error: unknown }
        | { kind: "timeout" };
      const raced = await Promise.race<Race>([
        probe(device).then(
          (status) => ({ kind: "settled", status }),
          (error) => ({ kind: "failed", error }),
        ),
        new Promise<Race>((resolve) => {
          timeoutHandle = timer.setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
        }),
      ]);
      if (raced.kind === "timeout") {
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
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
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

async function enrichDeviceLockStates(devices: BootedDeviceInfo[]): Promise<void> {
  const lockProbe = activeLockProbe();
  if (!lockProbe) {
    return;
  }

  const lockResults = await Promise.allSettled(
    devices.map(async (device) =>
      isProbeableDevice(device) ? await probeDeviceLock(probeTarget(device), lockProbe) : undefined,
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
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await withRemainingBudget(deadlineMs, timer, undefined, async (_signal, remainingMs) => {
      const controller = new AbortController();
      return await Promise.race([
        reader.readOrientation(device, controller.signal),
        new Promise<null>((resolve) => {
          timeoutHandle = timer.setTimeout(() => {
            const error = new Error(
              `[BootedDeviceResources] Orientation timeout for ${device.deviceId}`,
            );
            controller.abort(error);
            logger.warn(error.message);
            resolve(null);
          }, remainingMs);
        }),
      ]);
    });
  } catch (error) {
    logger.warn(
      `[BootedDeviceResources] Failed to query orientation for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return null;
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
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

// Core function to fetch booted devices for specified platforms
async function getBootedDevicesForPlatforms(
  platforms: Platform[],
): Promise<BootedDevicesResourceContent> {
  const devices: BootedDeviceInfo[] = [];
  const daemonContext = readDaemonDeviceContext();

  const succeededPlatforms = new Set<Platform>();
  const platformObservations: Partial<Record<Platform, PlatformObservation>> = {};
  const sourceObservations: Partial<Record<DiscoverySource, PlatformObservation>> = {};

  for (const platform of platforms) {
    const discovery = await discoverBootedDevicesForPlatform(
      platform,
      daemonContext.devicePool,
      daemonContext.sessionInfoByDeviceId,
      daemonContext.resolveDeviceSessionUuid,
    );
    devices.push(...discovery.devices);
    platformObservations[platform] = discovery.observation;
    Object.assign(sourceObservations, discovery.sourceObservations);
    for (const discoveredPlatform of discovery.succeededPlatforms) {
      succeededPlatforms.add(discoveredPlatform);
    }
  }

  await Promise.all([
    enrichDeviceServiceStatuses(devices),
    enrichDeviceLockStates(devices),
    enrichDeviceOrientations(devices),
  ]);

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
    devices,
  };
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
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      versionLookup.getVersion(device),
      new Promise<undefined>((resolve) => {
        timeoutHandle = timer.setTimeout(() => {
          logger.debug(
            `[BootedDeviceResources] CtrlProxy version lookup timed out for ${device.deviceId}`,
          );
          resolve(undefined);
        }, CTRL_PROXY_VERSION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Injected best-effort metadata lookups must not make service-status reads fail.
    logger.debug(
      `[BootedDeviceResources] CtrlProxy version lookup failed for ${device.deviceId}: ${error}`,
    );
    return undefined;
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
  }
}

// Query service status for a single booted device
export async function queryDeviceServiceStatus(
  device: BootedDeviceProbeTarget,
  androidLookup: AndroidServiceStatusLookup = defaultAndroidServiceStatusLookup,
  versionLookup?: CtrlProxyVersionLookup,
  timer: Timer = defaultTimer,
): Promise<DeviceServiceStatus | undefined> {
  const bootedDevice: BootedDevice = {
    name: device.name,
    platform: device.platform,
    deviceId: device.deviceId,
    source: device.source,
  };
  const resolvedVersionLookup =
    versionLookup ??
    (androidLookup === defaultAndroidServiceStatusLookup
      ? defaultCtrlProxyVersionLookup
      : noOpCtrlProxyVersionLookup);

  try {
    if (device.platform === "android") {
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
          (installedSha256 !== null &&
            installedSha256.toLowerCase() === expectedSha256.toLowerCase()));
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
    } else if (device.platform === "ios") {
      const manager = IOSCtrlProxyManager.getInstance(bootedDevice);
      const [installed, running, version] = await Promise.all([
        manager.isInstalled(),
        manager.isRunning(),
        getCtrlProxyVersion(bootedDevice, resolvedVersionLookup, timer),
      ]);
      const expectedSha256 = resolveIpaChecksum();

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
          supportedCommandsComplete = IOS_RUNNER_FEATURE_COMMANDS.every((command) =>
            advertised.has(command),
          );
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

      // Only claim compatibility we can actually verify. isCompatible is true
      // *only* when the runner's advertised command set is known complete; a stale
      // runner (incomplete) or an unknown one (no cached handshake yet) is reported
      // not-compatible rather than the previous always-true reassurance. An
      // unverifiable explicit pin is never compatible (#2746).
      const isCompatible =
        supportedCommandsComplete === true &&
        supportedFeaturesComplete === true &&
        !IOSCtrlProxyBuilder.isPinnedVersionUnverifiable();

      return {
        installed,
        enabled: running,
        running,
        installedSha256: null,
        expectedSha256,
        isCompatible,
        // isInstalled() is host-wide/unconditional for simulators; running is the per-device signal.
        ...(running && version
          ? {
              versionInfo: version,
              ...(legacyVersion(version) ? { version: legacyVersion(version) } : {}),
            }
          : {}),
        supportedCommandsComplete,
        supportedFeaturesComplete,
      };
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
  await ResourceRegistry.notifyResourcesUpdated([
    BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    DEVICE_LOCK_STATES_RESOURCE_URI,
  ]);
}
