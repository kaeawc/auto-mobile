import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import {
  type DeviceDiscoveryError,
  PlatformDeviceManager,
} from "../utils/deviceUtils";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../utils/logger";
import { BootedDevice, Platform } from "../models";
import { DaemonState } from "../daemon/daemonState";
import type { Session } from "../daemon/sessionManager";
import type {
  DevicePool,
  DeviceRecoveryEligibility,
  DeviceRecoveryPolicy,
} from "../daemon/devicePool";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { IOSCtrlProxyBuilder } from "../utils/IOSCtrlProxyBuilder";
import { IOSCtrlProxyClient, IOS_RUNNER_FEATURE_COMMANDS } from "../features/observe/ios/IOSCtrlProxyClient";
import {
  resolveApkChecksum,
  resolveIpaChecksum,
} from "../constants/release";
import { defaultTimer } from "../utils/SystemTimer";

// Resource URIs
export const BOOTED_DEVICE_RESOURCE_URIS = {
  ALL_BOOTED: "automobile:devices/booted",
  PLATFORM_TEMPLATE: "automobile:devices/booted/{platform}"
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
  lastUpdated: string;  // ISO 8601
  lockStates: DeviceLockStateInfo[];
}

// Service status for a booted device
interface DeviceServiceStatus {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  installedSha256: string | null;
  expectedSha256: string;
  isCompatible: boolean;
  /**
   * iOS only: whether the running runner advertises the full feature command set.
   * The iOS runner exposes no version/hash (installedSha256 stays null), so this
   * is the runner-identity signal that makes isCompatible meaningful instead of
   * always-true. null when the runner has not handshaked (identity unknown).
   */
  supportedCommandsComplete?: boolean | null;
}

interface DeviceIdentity {
  stableId: string;
  connectionId: string;
  transportId?: string;
}

interface DeviceReadiness {
  state: "ready" | "not_ready" | "unknown";
}

interface DeviceCapabilities {
  automation: Pick<
    DeviceServiceStatus,
    "installed" | "enabled" | "running" | "isCompatible" | "supportedCommandsComplete"
  > | null;
}

// Booted device info for resource response
interface BootedDeviceInfo {
  name: string;
  platform: Platform;
  deviceId: string;
  identity: DeviceIdentity;
  source: "local" | "remote";
  isVirtual: boolean;
  status: "booted";
  lifecycleState: "booted";
  runtime?: string;
  formFactor?: BootedDevice["formFactor"];
  readiness: DeviceReadiness;
  capabilities: DeviceCapabilities;
  poolStatus?: PoolDeviceStatus;
  assignedSession?: string;
  recoveryEligibility?: DeviceRecoveryEligibility;
  session?: DeviceSessionInfo;
  serviceStatus?: DeviceServiceStatus;
  /**
   * Whether the device's keyguard/lock screen currently obscures the app. Android only (from
   * `dumpsys window policy`); omitted when unread or on iOS, where no lock-state probe exists yet.
   * Consumed by the desktop workspace to gate the contextual Unlock control (issue #4694).
   */
  locked?: boolean;
}

// Resource content schema
export interface BootedDevicesResourceContent {
  totalCount: number;
  androidCount: number;
  iosCount: number;
  virtualCount: number;
  physicalCount: number;
  lastUpdated: string;  // ISO 8601
  observationComplete: boolean;
  platformObservations: Partial<Record<Platform, PlatformObservation>>;
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

interface DeviceSessionInfo {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  lastHeartbeat: string;
  expiresAt: string;
  heartbeatTimeoutMs: number;
  hasReceivedHeartbeat: boolean;
}

interface PoolDeviceInfo {
  poolStatus: PoolDeviceStatus;
  assignedSession?: string;
  recoveryEligibility: DeviceRecoveryEligibility;
  avdName?: string;
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

/**
 * Resolve a device's lock state via [lockProbe], bounded by a per-device timeout so a slow/failed
 * read leaves it `undefined` rather than stalling the caller. Clears the losing timer when the probe
 * wins, so a fast success never logs a spurious "timeout" on the desktop's periodic poll.
 */
async function probeDeviceLock(
  device: BootedDevice,
  lockProbe: DeviceLockProbe
): Promise<boolean | undefined> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lockProbe(device),
      new Promise<undefined>(resolve => {
        timeoutHandle = defaultTimer.setTimeout(() => {
          logger.warn(`[BootedDeviceResources] Lock-state timeout for ${device.deviceId}`);
          resolve(undefined);
        }, LOCK_STATE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn(`[BootedDeviceResources] Failed to query lock state for ${device.deviceId}: ${error}`);
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
  for (const platform of ["android", "ios"] as Platform[]) {
    try {
      const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(platform);
      devices.push(...discovery.devices);
    } catch (error) {
      logger.warn(`[DeviceLockStates] Failed to enumerate ${platform} booted devices: ${error}`);
    }
  }

  const lockStates: DeviceLockStateInfo[] = devices.map(device => ({ deviceId: device.deviceId }));
  const lockProbe = activeLockProbe();
  if (lockProbe) {
    const results = await Promise.allSettled(
      devices.map(device => probeDeviceLock(device, lockProbe))
    );
    for (let i = 0; i < devices.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled" && result.value !== undefined) {
        lockStates[i] = { deviceId: devices[i].deviceId, locked: result.value };
      }
    }
  }

  return { lastUpdated: new Date().toISOString(), lockStates };
}

async function getDeviceLockStates(): Promise<ResourceContent> {
  const content = await computeDeviceLockStates();
  return {
    uri: DEVICE_LOCK_STATES_RESOURCE_URI,
    mimeType: "application/json",
    text: JSON.stringify(content, null, 2)
  };
}

// Convert BootedDevice to BootedDeviceInfo
function toBootedDeviceInfo(
  device: BootedDevice,
  poolInfo?: PoolDeviceInfo,
  sessionInfo?: DeviceSessionInfo
): BootedDeviceInfo {
  const isVirtual = isVirtualDevice(device);
  const runtime = device.iosVersion ?? device.osVersion;
  const info: BootedDeviceInfo = {
    name: device.name,
    platform: device.platform,
    deviceId: device.deviceId,
    identity: toDeviceIdentity(device, poolInfo, isVirtual),
    source: device.source || "local",
    isVirtual,
    status: "booted",
    lifecycleState: "booted",
    readiness: { state: "unknown" },
    capabilities: { automation: null },
  };

  if (runtime) {
    info.runtime = runtime;
  }
  if (device.formFactor) {
    info.formFactor = device.formFactor;
  }
  if (poolInfo) {
    info.poolStatus = poolInfo.poolStatus;
    info.assignedSession = poolInfo.assignedSession;
    info.recoveryEligibility = poolInfo.recoveryEligibility;
  }
  if (sessionInfo) {
    info.session = sessionInfo;
  }
  return info;
}

function toDeviceIdentity(
  device: BootedDevice,
  poolInfo: PoolDeviceInfo | undefined,
  isVirtual: boolean
): DeviceIdentity {
  const identity: DeviceIdentity = {
    stableId: poolInfo?.avdName ?? (isVirtual ? device.name : device.deviceId),
    connectionId: device.deviceId,
  };
  if (device.transportId) {
    identity.transportId = device.transportId;
  }
  return identity;
}

function isVirtualDevice(device: BootedDevice): boolean {
  if (device.platform === "android") {
    return device.deviceId.startsWith("emulator-");
  }

  return device.deviceId.includes("-") && device.deviceId.length > 30;
}

function getPoolDeviceInfo(devicePool: DevicePool | null, deviceId: string): PoolDeviceInfo | undefined {
  if (!devicePool) {
    return undefined;
  }

  const pooledDevice = devicePool.getDevice(deviceId);
  if (!pooledDevice) {
    return undefined;
  }

  const poolStatus: PoolDeviceStatus = pooledDevice.status === "busy"
    ? "assigned"
    : pooledDevice.status;

  return {
    poolStatus,
    assignedSession: pooledDevice.sessionId || undefined,
    recoveryEligibility: devicePool.getRecoveryEligibility(deviceId),
    avdName: pooledDevice.avdName,
  };
}

function summarizePoolStatus(
  devicePool: DevicePool,
  discoveredDevices: BootedDeviceInfo[],
  succeededPlatforms: Set<Platform>
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
      tally(device.poolStatus);
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

function toDeviceSessionInfo(session: Session): DeviceSessionInfo {
  return {
    sessionId: session.sessionId,
    createdAt: new Date(session.createdAt).toISOString(),
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    lastHeartbeat: new Date(session.lastHeartbeat).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    heartbeatTimeoutMs: session.heartbeatTimeoutMs,
    hasReceivedHeartbeat: session.hasReceivedHeartbeat
  };
}

// Handler to get all booted devices (both platforms)
async function getAllBootedDevices(): Promise<ResourceContent> {
  const result = await getBootedDevicesForPlatforms(["android", "ios"]);
  return {
    uri: BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    mimeType: "application/json",
    text: JSON.stringify(result, null, 2)
  };
}

// Handler to get booted devices for a specific platform
async function getBootedDevicesByPlatform(params: Record<string, string>): Promise<ResourceContent> {
  const platform = params.platform;

  // Validate platform parameter
  if (platform !== "android" && platform !== "ios") {
    return {
      uri: `automobile:devices/booted/${platform}`,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Invalid platform: ${platform}. Must be 'android' or 'ios'.`
      }, null, 2)
    };
  }

  const result = await getBootedDevicesForPlatforms([platform as Platform]);
  return {
    uri: `automobile:devices/booted/${platform}`,
    mimeType: "application/json",
    text: JSON.stringify(result, null, 2)
  };
}

interface PlatformDiscoveryResult {
  devices: BootedDeviceInfo[];
  succeededPlatforms: Set<Platform>;
  observation: PlatformObservation;
}

async function discoverBootedDevicesForPlatform(
  platform: Platform,
  devicePool: DevicePool | null,
  sessionInfoByDeviceId: Map<string, DeviceSessionInfo> | null
): Promise<PlatformDiscoveryResult> {
  try {
    const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(platform);
    const complete = discovery.succeededPlatforms.has(platform);
    return {
      devices: discovery.devices.map(device => toBootedDeviceInfo(
        device,
        getPoolDeviceInfo(devicePool, device.deviceId),
        sessionInfoByDeviceId?.get(device.deviceId)
      )),
      succeededPlatforms: discovery.succeededPlatforms,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DaemonDeviceContext {
  devicePool: DevicePool | null;
  poolStatus?: PoolStatusSummary;
  sessionInfoByDeviceId: Map<string, DeviceSessionInfo> | null;
}

function readDaemonDeviceContext(): DaemonDeviceContext {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return { devicePool: null, sessionInfoByDeviceId: null };
  }

  let devicePool: DevicePool | null = null;
  let poolStatus: PoolStatusSummary | undefined;
  let sessionInfoByDeviceId: Map<string, DeviceSessionInfo> | null = null;
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
    sessionInfoByDeviceId = new Map(
      sessions.map(session => [session.assignedDevice, toDeviceSessionInfo(session)])
    );
  } catch (error) {
    logger.warn(`[BootedDeviceResources] Failed to read session manager state: ${error}`);
  }

  return { devicePool, poolStatus, sessionInfoByDeviceId };
}

async function enrichDeviceServiceStatuses(devices: BootedDeviceInfo[]): Promise<void> {
  if (!serviceStatusEnabled) {
    return;
  }

  const SERVICE_STATUS_TIMEOUT_MS = 5000;
  const serviceStatusResults = await Promise.allSettled(
    devices.map(async device => {
      try {
        return await Promise.race([
          queryDeviceServiceStatus(device),
          new Promise<undefined>(resolve =>
            defaultTimer.setTimeout(() => {
              logger.warn(`[BootedDeviceResources] Service status timeout for ${device.deviceId}`);
              resolve(undefined);
            }, SERVICE_STATUS_TIMEOUT_MS)
          ),
        ]);
      } catch (error) {
        logger.warn(`[BootedDeviceResources] Failed to query service status for ${device.deviceId}: ${error}`);
        return undefined;
      }
    })
  );

  for (let i = 0; i < devices.length; i++) {
    const result = serviceStatusResults[i];
    if (result.status === "fulfilled" && result.value) {
      devices[i] = withServiceStatus(devices[i], result.value);
    }
  }
}

function withServiceStatus(
  device: BootedDeviceInfo,
  serviceStatus: DeviceServiceStatus
): BootedDeviceInfo {
  return {
    ...device,
    serviceStatus,
    readiness: {
      state: serviceStatus.running && serviceStatus.isCompatible ? "ready" : "not_ready",
    },
    capabilities: {
      automation: {
        installed: serviceStatus.installed,
        enabled: serviceStatus.enabled,
        running: serviceStatus.running,
        isCompatible: serviceStatus.isCompatible,
        supportedCommandsComplete: serviceStatus.supportedCommandsComplete,
      },
    },
  };
}

async function enrichDeviceLockStates(devices: BootedDeviceInfo[]): Promise<void> {
  const lockProbe = activeLockProbe();
  if (!lockProbe) {
    return;
  }

  const lockResults = await Promise.allSettled(
    devices.map(device =>
      probeDeviceLock(
        { name: device.name, platform: device.platform, deviceId: device.deviceId },
        lockProbe
      )
    )
  );

  for (let i = 0; i < devices.length; i++) {
    const result = lockResults[i];
    if (result.status === "fulfilled" && result.value !== undefined) {
      devices[i] = { ...devices[i], locked: result.value };
    }
  }
}

// Core function to fetch booted devices for specified platforms
async function getBootedDevicesForPlatforms(platforms: Platform[]): Promise<BootedDevicesResourceContent> {
  const devices: BootedDeviceInfo[] = [];
  const daemonContext = readDaemonDeviceContext();

  const succeededPlatforms = new Set<Platform>();
  const platformObservations: Partial<Record<Platform, PlatformObservation>> = {};

  for (const platform of platforms) {
    const discovery = await discoverBootedDevicesForPlatform(
      platform,
      daemonContext.devicePool,
      daemonContext.sessionInfoByDeviceId
    );
    devices.push(...discovery.devices);
    platformObservations[platform] = discovery.observation;
    for (const discoveredPlatform of discovery.succeededPlatforms) {
      succeededPlatforms.add(discoveredPlatform);
    }
  }

  await enrichDeviceServiceStatuses(devices);
  await enrichDeviceLockStates(devices);

  const virtualCount = devices.filter(device => device.isVirtual).length;
  const physicalCount = devices.length - virtualCount;
  const poolStatus = daemonContext.poolStatus && daemonContext.devicePool
    ? summarizePoolStatus(daemonContext.devicePool, devices, succeededPlatforms)
    : undefined;

  return {
    totalCount: devices.length,
    androidCount: devices.filter(device => device.platform === "android").length,
    iosCount: devices.filter(device => device.platform === "ios").length,
    virtualCount,
    physicalCount,
    lastUpdated: new Date().toISOString(),
    observationComplete: platforms.every(platform => platformObservations[platform]?.observationComplete === true),
    platformObservations,
    poolStatus,
    devices
  };
}

// Query service status for a single booted device
async function queryDeviceServiceStatus(device: BootedDeviceInfo): Promise<DeviceServiceStatus | undefined> {
  const bootedDevice: BootedDevice = {
    name: device.name,
    platform: device.platform,
    deviceId: device.deviceId,
    source: device.source,
  };

  try {
    if (device.platform === "android") {
      const manager = AndroidCtrlProxyManager.getInstance(bootedDevice);
      const [installed, enabled, installedSha256] = await Promise.all([
        manager.isInstalled(),
        manager.isEnabled(),
        manager.getInstalledApkSha256(),
      ]);
      const expectedSha256 = resolveApkChecksum();
      // An explicit pin absent from the registry yields an empty expected checksum,
      // which must NOT read as "compatible" — the installed APK is unverifiable (#2746).
      const isCompatible = !AndroidCtrlProxyManager.isPinnedVersionUnverifiable() && (
        expectedSha256.length === 0 ||
        (installedSha256 !== null && installedSha256.toLowerCase() === expectedSha256.toLowerCase())
      );
      return {
        installed,
        enabled,
        running: installed && enabled,
        installedSha256,
        expectedSha256,
        isCompatible,
      };
    } else if (device.platform === "ios") {
      const manager = IOSCtrlProxyManager.getInstance(bootedDevice);
      const [installed, running] = await Promise.all([
        manager.isInstalled(),
        manager.isRunning(),
      ]);
      const expectedSha256 = resolveIpaChecksum();

      // The iOS runner exposes no hash/version, so identity comes from the cached
      // `supportedCommands` handshake. Read it connection-free (this hot path must
      // not open a WebSocket); null means identity is unknown this fetch.
      let supportedCommandsComplete: boolean | null = null;
      if (running) {
        const client = IOSCtrlProxyClient.getExistingInstance(bootedDevice.deviceId);
        const cached = client?.getCachedSupportedCommands() ?? null;
        if (cached !== null) {
          const advertised = new Set(cached);
          supportedCommandsComplete = IOS_RUNNER_FEATURE_COMMANDS.every(command => advertised.has(command));
        }
      }

      // Only claim compatibility we can actually verify. isCompatible is true
      // *only* when the runner's advertised command set is known complete; a stale
      // runner (incomplete) or an unknown one (no cached handshake yet) is reported
      // not-compatible rather than the previous always-true reassurance. An
      // unverifiable explicit pin is never compatible (#2746).
      const isCompatible = supportedCommandsComplete === true &&
        !IOSCtrlProxyBuilder.isPinnedVersionUnverifiable();

      return {
        installed,
        enabled: running,
        running,
        installedSha256: null,
        expectedSha256,
        isCompatible,
        supportedCommandsComplete,
      };
    }
  } catch (error) {
    logger.warn(`[BootedDeviceResources] Service status query failed for ${device.deviceId}: ${error}`);
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
    getAllBootedDevices
  );

  // Register the platform-specific template
  ResourceRegistry.registerTemplate(
    BOOTED_DEVICE_RESOURCE_URIS.PLATFORM_TEMPLATE,
    "Platform-specific Booted Devices",
    "List of booted/running devices for a specific platform (android or ios).",
    "application/json",
    getBootedDevicesByPlatform
  );

  // Register the lightweight per-device lock-state resource (issue #5056).
  ResourceRegistry.register(
    DEVICE_LOCK_STATES_RESOURCE_URI,
    "Device Lock States",
    "Per-device keyguard/lock state (Android). Lightweight — enumerates booted devices and runs only the keyguard probe, without the service-status computation the full booted-devices resource does.",
    "application/json",
    getDeviceLockStates
  );

  logger.info("[BootedDeviceResources] Registered booted device resources");
}

// Send notifications for booted device resource updates. Both the full booted-devices resource and
// the lightweight lock-states resource (#5056) enumerate the same booted inventory, so a device
// starting/killing changes both — notify subscribers of each, not just the full resource.
export async function notifyBootedDeviceResourcesUpdated(): Promise<void> {
  await ResourceRegistry.notifyResourcesUpdated([
    BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    DEVICE_LOCK_STATES_RESOURCE_URI
  ]);
}
