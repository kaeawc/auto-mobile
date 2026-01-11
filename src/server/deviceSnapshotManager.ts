import { ActionableError, BootedDevice, DeviceSnapshotConfig, DeviceSnapshotConfigInput, DeviceSnapshotManifest } from "../models";
import { DeviceSnapshotRepository, type DeviceSnapshotRecord } from "../db/deviceSnapshotRepository";
import { DeviceSnapshotConfigRepository } from "../db/deviceSnapshotConfigRepository";
import { DeviceSnapshotStore } from "../utils/DeviceSnapshotStore";
import { parseDeviceSnapshotConfig } from "../features/snapshot";
import { serverConfig } from "../utils/ServerConfig";
import { ResourceRegistry } from "./resourceRegistry";
import { DEVICE_SNAPSHOT_RESOURCE_URIS } from "./deviceSnapshotResourceUris";
import { CaptureSnapshot, type CaptureSnapshotArgs, type CaptureSnapshotResult } from "../features/action/CaptureSnapshot";
import { RestoreSnapshot, type RestoreSnapshotArgs, type RestoreSnapshotResult } from "../features/action/RestoreSnapshot";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

export interface DeviceSnapshotCaptureArgs {
  snapshotName?: string;
  includeAppData?: boolean;
  includeSettings?: boolean;
  useVmSnapshot?: boolean;
  strictBackupMode?: boolean;
  backupTimeoutMs?: number;
  userApps?: "current" | "all";
  vmSnapshotTimeoutMs?: number;
}

export interface DeviceSnapshotRestoreArgs {
  snapshotName: string;
  useVmSnapshot?: boolean;
  vmSnapshotTimeoutMs?: number;
}

export interface DeviceSnapshotConfigUpdateResult {
  config: DeviceSnapshotConfig;
  evictedSnapshotNames: string[];
}

export interface SnapshotArchiveEvictionResult {
  evictedSnapshotNames: string[];
  currentSizeBytes: number;
  maxSizeBytes: number;
}

export interface SnapshotCaptureAction {
  execute(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult>;
}

export interface SnapshotRestoreAction {
  execute(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult>;
}

export interface DeviceSnapshotManagerDependencies {
  snapshotRepository: DeviceSnapshotRepository;
  configRepository: DeviceSnapshotConfigRepository;
  snapshotStore: DeviceSnapshotStore;
  timer: Timer;
  now: () => Date;
  createCaptureAction: (
    device: BootedDevice,
    timer: Timer,
    store: DeviceSnapshotStore
  ) => SnapshotCaptureAction;
  createRestoreAction: (
    device: BootedDevice,
    timer: Timer,
    store: DeviceSnapshotStore
  ) => SnapshotRestoreAction;
}

let moduleDependencies: DeviceSnapshotManagerDependencies | null = null;

async function getDeviceSnapshotDependencies(): Promise<DeviceSnapshotManagerDependencies> {
  if (!moduleDependencies) {
    moduleDependencies = {
      snapshotRepository: new DeviceSnapshotRepository(),
      configRepository: new DeviceSnapshotConfigRepository(),
      snapshotStore: new DeviceSnapshotStore(),
      timer: defaultTimer,
      now: () => new Date(),
      createCaptureAction: (device, timer, store) =>
        new CaptureSnapshot(device, undefined, undefined, timer, store),
      createRestoreAction: (device, timer, store) =>
        new RestoreSnapshot(device, undefined, undefined, timer, store),
    };
  }

  return moduleDependencies;
}

export async function setDeviceSnapshotManagerDependencies(
  deps: Partial<DeviceSnapshotManagerDependencies>
): Promise<void> {
  const current = await getDeviceSnapshotDependencies();
  moduleDependencies = {
    snapshotRepository: deps.snapshotRepository ?? current.snapshotRepository,
    configRepository: deps.configRepository ?? current.configRepository,
    snapshotStore: deps.snapshotStore ?? current.snapshotStore,
    timer: deps.timer ?? current.timer,
    now: deps.now ?? current.now,
    createCaptureAction: deps.createCaptureAction ?? current.createCaptureAction,
    createRestoreAction: deps.createRestoreAction ?? current.createRestoreAction,
  };
}

export function resetDeviceSnapshotManagerDependencies(): void {
  moduleDependencies = null;
}

function configToInput(config: DeviceSnapshotConfig): DeviceSnapshotConfigInput {
  return {
    includeAppData: config.includeAppData,
    includeSettings: config.includeSettings,
    useVmSnapshot: config.useVmSnapshot,
    strictBackupMode: config.strictBackupMode,
    backupTimeoutMs: config.backupTimeoutMs,
    userApps: config.userApps,
    vmSnapshotTimeoutMs: config.vmSnapshotTimeoutMs,
    maxArchiveSizeMb: config.maxArchiveSizeMb,
  };
}

function mergeConfigInput(
  base: DeviceSnapshotConfigInput,
  overrides: DeviceSnapshotConfigInput
): DeviceSnapshotConfigInput {
  return {
    includeAppData: overrides.includeAppData ?? base.includeAppData,
    includeSettings: overrides.includeSettings ?? base.includeSettings,
    useVmSnapshot: overrides.useVmSnapshot ?? base.useVmSnapshot,
    strictBackupMode: overrides.strictBackupMode ?? base.strictBackupMode,
    backupTimeoutMs: overrides.backupTimeoutMs ?? base.backupTimeoutMs,
    userApps: overrides.userApps ?? base.userApps,
    vmSnapshotTimeoutMs: overrides.vmSnapshotTimeoutMs ?? base.vmSnapshotTimeoutMs,
    maxArchiveSizeMb: overrides.maxArchiveSizeMb ?? base.maxArchiveSizeMb,
  };
}

function formatSnapshotSize(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(2)} ${units[index]}`;
}

function buildArchiveEntry(record: DeviceSnapshotRecord): Record<string, unknown> {
  return {
    snapshotName: record.snapshotName,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    snapshotType: record.snapshotType,
    includeAppData: record.includeAppData,
    includeSettings: record.includeSettings,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    sizeBytes: record.sizeBytes,
    sizeLabel: formatSnapshotSize(record.sizeBytes),
  };
}

async function notifySnapshotResources(): Promise<void> {
  await ResourceRegistry.notifyResourcesUpdated([
    DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE,
  ]);
}

async function ensureSnapshotAvailable(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  snapshotRepository: DeviceSnapshotRepository
): Promise<void> {
  const existing = await snapshotRepository.getSnapshot(snapshotName);
  if (existing) {
    throw new ActionableError(
      `Snapshot '${snapshotName}' already exists. Please choose a different name.`
    );
  }

  if (await snapshotStore.snapshotDirectoryExists(snapshotName)) {
    throw new ActionableError(
      `Snapshot '${snapshotName}' already exists on disk. Please choose a different name.`
    );
  }
}

async function deleteDeviceSnapshot(
  snapshotName: string
): Promise<boolean> {
  const { snapshotRepository, snapshotStore } = await getDeviceSnapshotDependencies();
  await snapshotStore.deleteSnapshotData(snapshotName);
  const deleted = await snapshotRepository.deleteSnapshot(snapshotName);
  return deleted;
}

export async function enforceDeviceSnapshotArchiveLimit(
  maxArchiveSizeMb: number
): Promise<SnapshotArchiveEvictionResult> {
  const maxSizeBytes = Math.max(0, Math.floor(maxArchiveSizeMb * 1024 * 1024));
  const { snapshotRepository } = await getDeviceSnapshotDependencies();
  const snapshots = await snapshotRepository.listSnapshots({
    orderByLastAccessed: "asc",
  });

  let currentSizeBytes = snapshots.reduce(
    (sum, snapshot) => sum + snapshot.sizeBytes,
    0
  );

  if (maxSizeBytes === 0 || currentSizeBytes <= maxSizeBytes) {
    return {
      evictedSnapshotNames: [],
      currentSizeBytes,
      maxSizeBytes,
    };
  }

  const evictedSnapshotNames: string[] = [];

  for (const snapshot of snapshots) {
    if (currentSizeBytes <= maxSizeBytes) {
      break;
    }

    try {
      const deleted = await deleteDeviceSnapshot(snapshot.snapshotName);
      if (deleted) {
        evictedSnapshotNames.push(snapshot.snapshotName);
        currentSizeBytes -= snapshot.sizeBytes;
      }
    } catch (error) {
      logger.warn(
        `[DeviceSnapshot] Failed to evict snapshot ${snapshot.snapshotName}: ${error}`
      );
    }
  }

  if (currentSizeBytes > maxSizeBytes) {
    logger.warn(
      `[DeviceSnapshot] Archive size ${currentSizeBytes} bytes still exceeds limit ${maxSizeBytes} bytes after eviction`
    );
  }

  if (evictedSnapshotNames.length > 0) {
    await notifySnapshotResources();
  }

  return {
    evictedSnapshotNames,
    currentSizeBytes,
    maxSizeBytes,
  };
}

export async function getDeviceSnapshotConfig(): Promise<DeviceSnapshotConfig> {
  const { configRepository } = await getDeviceSnapshotDependencies();
  const stored = await configRepository.getConfig();
  if (stored) {
    return stored;
  }
  return parseDeviceSnapshotConfig(serverConfig.getDeviceSnapshotDefaults());
}

export async function updateDeviceSnapshotConfig(
  update: DeviceSnapshotConfigInput | null
): Promise<DeviceSnapshotConfigUpdateResult> {
  const { configRepository } = await getDeviceSnapshotDependencies();
  if (update === null) {
    await configRepository.clearConfig();
    const defaults = parseDeviceSnapshotConfig(serverConfig.getDeviceSnapshotDefaults());
    const eviction = await enforceDeviceSnapshotArchiveLimit(defaults.maxArchiveSizeMb);
    return { config: defaults, evictedSnapshotNames: eviction.evictedSnapshotNames };
  }

  const current = await getDeviceSnapshotConfig();
  const mergedInput = mergeConfigInput(configToInput(current), update);
  const nextConfig = parseDeviceSnapshotConfig(mergedInput);
  await configRepository.setConfig(nextConfig);

  const eviction = await enforceDeviceSnapshotArchiveLimit(nextConfig.maxArchiveSizeMb);
  return { config: nextConfig, evictedSnapshotNames: eviction.evictedSnapshotNames };
}

export async function captureDeviceSnapshot(
  device: BootedDevice,
  args: DeviceSnapshotCaptureArgs
): Promise<{
  result: CaptureSnapshotResult;
  evictedSnapshotNames: string[];
}> {
  const { snapshotRepository, snapshotStore, timer, createCaptureAction } =
    await getDeviceSnapshotDependencies();

  const baseConfig = await getDeviceSnapshotConfig();
  const snapshotName = args.snapshotName ?? snapshotStore.generateSnapshotName(device.name);

  await ensureSnapshotAvailable(snapshotName, snapshotStore, snapshotRepository);

  const mergedConfig: DeviceSnapshotConfig = {
    ...baseConfig,
    includeAppData: args.includeAppData ?? baseConfig.includeAppData,
    includeSettings: args.includeSettings ?? baseConfig.includeSettings,
    useVmSnapshot: args.useVmSnapshot ?? baseConfig.useVmSnapshot,
    strictBackupMode: args.strictBackupMode ?? baseConfig.strictBackupMode,
    backupTimeoutMs: args.backupTimeoutMs ?? baseConfig.backupTimeoutMs,
    userApps: args.userApps ?? baseConfig.userApps,
    vmSnapshotTimeoutMs: args.vmSnapshotTimeoutMs ?? baseConfig.vmSnapshotTimeoutMs,
  };

  const captureAction = createCaptureAction(device, timer, snapshotStore);
  const result = await captureAction.execute({
    snapshotName,
    includeAppData: mergedConfig.includeAppData,
    includeSettings: mergedConfig.includeSettings,
    useVmSnapshot: mergedConfig.useVmSnapshot,
    strictBackupMode: mergedConfig.strictBackupMode,
    backupTimeoutMs: mergedConfig.backupTimeoutMs,
    userApps: mergedConfig.userApps,
    vmSnapshotTimeoutMs: mergedConfig.vmSnapshotTimeoutMs,
  });

  const sizeBytes = await snapshotStore.getSnapshotSizeBytes(snapshotName);
  const timestamp = result.manifest.timestamp;

  await snapshotRepository.insertSnapshot({
    snapshotName: result.snapshotName,
    deviceId: result.manifest.deviceId,
    deviceName: result.manifest.deviceName,
    platform: result.manifest.platform,
    snapshotType: result.manifest.snapshotType,
    includeAppData: result.manifest.includeAppData,
    includeSettings: result.manifest.includeSettings,
    createdAt: timestamp,
    lastAccessedAt: timestamp,
    sizeBytes,
    manifest: result.manifest,
  });

  const eviction = await enforceDeviceSnapshotArchiveLimit(mergedConfig.maxArchiveSizeMb);
  await notifySnapshotResources();

  return { result, evictedSnapshotNames: eviction.evictedSnapshotNames };
}

export async function restoreDeviceSnapshot(
  device: BootedDevice,
  args: DeviceSnapshotRestoreArgs
): Promise<{
  result: RestoreSnapshotResult;
  manifest: DeviceSnapshotManifest;
}> {
  const { snapshotRepository, snapshotStore, timer, now, createRestoreAction } =
    await getDeviceSnapshotDependencies();

  const record = await snapshotRepository.getSnapshot(args.snapshotName);
  if (!record) {
    throw new ActionableError(`Snapshot '${args.snapshotName}' not found`);
  }

  const baseConfig = await getDeviceSnapshotConfig();
  const useVmSnapshot = args.useVmSnapshot ?? baseConfig.useVmSnapshot;
  const vmSnapshotTimeoutMs = args.vmSnapshotTimeoutMs ?? baseConfig.vmSnapshotTimeoutMs;

  const restoreAction = createRestoreAction(device, timer, snapshotStore);
  const result = await restoreAction.execute({
    snapshotName: record.snapshotName,
    manifest: record.manifest,
    useVmSnapshot,
    vmSnapshotTimeoutMs,
  });

  const timestamp = now().toISOString();
  await snapshotRepository.touchSnapshot(record.snapshotName, timestamp);
  await notifySnapshotResources();

  return { result, manifest: record.manifest };
}

export async function listDeviceSnapshots(): Promise<{
  snapshots: Array<Record<string, unknown>>;
  count: number;
  totalSizeBytes: number;
}> {
  const { snapshotRepository } = await getDeviceSnapshotDependencies();
  const records = await snapshotRepository.listSnapshots({
    orderByCreatedAt: "desc",
  });

  const snapshots = records.map(buildArchiveEntry);
  const totalSizeBytes = records.reduce(
    (sum, snapshot) => sum + snapshot.sizeBytes,
    0
  );

  return {
    snapshots,
    count: snapshots.length,
    totalSizeBytes,
  };
}
