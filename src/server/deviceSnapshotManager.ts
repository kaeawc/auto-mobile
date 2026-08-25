import { promises as fs } from "fs";
import type { Dirent } from "fs";
import * as path from "path";
import {
  ActionableError,
  BootedDevice,
  DeviceSnapshotConfig,
  DeviceSnapshotConfigInput,
  DeviceSnapshotManifest,
} from "../models";
import {
  DeviceSnapshotRepository,
  type DeviceSnapshotRecord,
} from "../db/deviceSnapshotRepository";
import {
  createDeviceSnapshotConfigRepository,
  type ConfigRepository,
} from "../db/keyedJsonConfigRepository";
import { DeviceSnapshotStore, type SnapshotPathOptions } from "../utils/DeviceSnapshotStore";
import { parseDeviceSnapshotConfig } from "../features/snapshot";
import { serverConfig } from "../utils/ServerConfig";
import { ResourceRegistry } from "./resourceRegistry";
import { DEVICE_SNAPSHOT_RESOURCE_URIS } from "./deviceSnapshotResourceUris";
import { CaptureSnapshot, type CaptureSnapshotResult } from "../features/action/CaptureSnapshot";
import { RestoreSnapshot, type RestoreSnapshotResult } from "../features/action/RestoreSnapshot";
import type {
  SnapshotCaptureProvider,
  SnapshotRestoreProvider,
} from "../utils/interfaces/SnapshotProvider";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

interface DeviceSnapshotCaptureArgs {
  snapshotName?: string;
  includeAppData?: boolean;
  includeSettings?: boolean;
  useVmSnapshot?: boolean;
  strictBackupMode?: boolean;
  vmSnapshotTimeoutMs?: number;
  appBundleIds?: string[];
}

interface DeviceSnapshotRestoreArgs {
  snapshotName: string;
  useVmSnapshot?: boolean;
  vmSnapshotTimeoutMs?: number;
}

interface DeviceSnapshotConfigUpdateResult {
  config: DeviceSnapshotConfig;
  evictedSnapshotNames: string[];
}

interface SnapshotArchiveEvictionResult {
  evictedSnapshotNames: string[];
  currentSizeBytes: number;
  maxSizeBytes: number;
}

interface DeviceSnapshotManagerDependencies {
  snapshotRepository: DeviceSnapshotRepository;
  configRepository: ConfigRepository<DeviceSnapshotConfig>;
  snapshotStore: DeviceSnapshotStore;
  timer: Timer;
  now: () => Date;
  createCaptureProvider: (
    device: BootedDevice,
    timer: Timer,
    store: DeviceSnapshotStore,
  ) => SnapshotCaptureProvider;
  createRestoreProvider: (
    device: BootedDevice,
    timer: Timer,
    store: DeviceSnapshotStore,
  ) => SnapshotRestoreProvider;
}

let moduleDependencies: DeviceSnapshotManagerDependencies | null = null;
const LEGACY_MANIFEST_FILENAME = "manifest.json";

function getSnapshotPathOptions(context: {
  platform?: string;
  deviceId?: string;
  avdName?: string;
}): SnapshotPathOptions | undefined {
  if (context.platform === "ios") {
    return { platform: "ios", deviceId: context.deviceId };
  }
  // Android emulator snapshots are scoped on disk by AVD name (stable + unique),
  // never the port-based serial. Physical Android devices have no AVD name and
  // fall through to the unscoped path (#5707).
  if (
    context.platform === "android" &&
    context.deviceId?.startsWith("emulator-") &&
    context.avdName
  ) {
    return { platform: "android", avdName: context.avdName };
  }
  return undefined;
}

async function getDeviceSnapshotDependencies(): Promise<DeviceSnapshotManagerDependencies> {
  if (!moduleDependencies) {
    moduleDependencies = {
      snapshotRepository: new DeviceSnapshotRepository(),
      configRepository: createDeviceSnapshotConfigRepository(),
      snapshotStore: new DeviceSnapshotStore(),
      timer: defaultTimer,
      now: () => new Date(),
      createCaptureProvider: (device, timer, store) => {
        return new CaptureSnapshot(device, undefined, undefined, timer, store);
      },
      createRestoreProvider: (device, timer, store) => {
        return new RestoreSnapshot(device, undefined, undefined, timer, store);
      },
    };
  }

  return moduleDependencies;
}

export async function setDeviceSnapshotManagerDependencies(
  deps: Partial<DeviceSnapshotManagerDependencies>,
): Promise<void> {
  const current = await getDeviceSnapshotDependencies();
  moduleDependencies = {
    snapshotRepository: deps.snapshotRepository ?? current.snapshotRepository,
    configRepository: deps.configRepository ?? current.configRepository,
    snapshotStore: deps.snapshotStore ?? current.snapshotStore,
    timer: deps.timer ?? current.timer,
    now: deps.now ?? current.now,
    createCaptureProvider: deps.createCaptureProvider ?? current.createCaptureProvider,
    createRestoreProvider: deps.createRestoreProvider ?? current.createRestoreProvider,
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
    vmSnapshotTimeoutMs: config.vmSnapshotTimeoutMs,
    maxArchiveSizeMb: config.maxArchiveSizeMb,
  };
}

function mergeConfigInput(
  base: DeviceSnapshotConfigInput,
  overrides: DeviceSnapshotConfigInput,
): DeviceSnapshotConfigInput {
  return {
    includeAppData: overrides.includeAppData ?? base.includeAppData,
    includeSettings: overrides.includeSettings ?? base.includeSettings,
    useVmSnapshot: overrides.useVmSnapshot ?? base.useVmSnapshot,
    strictBackupMode: overrides.strictBackupMode ?? base.strictBackupMode,
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

function isLegacyManifest(value: unknown): value is DeviceSnapshotManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const manifest = value as DeviceSnapshotManifest;
  return (
    typeof manifest.snapshotName === "string" &&
    typeof manifest.timestamp === "string" &&
    typeof manifest.deviceId === "string" &&
    typeof manifest.deviceName === "string" &&
    (manifest.platform === "android" || manifest.platform === "ios") &&
    (manifest.snapshotType === "adb" ||
      manifest.snapshotType === "vm" ||
      manifest.snapshotType === "simctl" ||
      manifest.snapshotType === "app_data") &&
    typeof manifest.includeAppData === "boolean" &&
    typeof manifest.includeSettings === "boolean"
  );
}

function normalizeLegacyManifest(
  snapshotName: string,
  manifest: DeviceSnapshotManifest,
): DeviceSnapshotManifest {
  if (manifest.snapshotName === snapshotName) {
    return manifest;
  }

  return {
    ...manifest,
    snapshotName,
  };
}

function resolveLegacyTimestamp(timestamp: string, fallback: string): string {
  return Number.isNaN(Date.parse(timestamp)) ? fallback : timestamp;
}

async function readLegacyManifest(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
): Promise<DeviceSnapshotManifest | null> {
  const manifestPath = path.join(
    snapshotStore.getSnapshotPath(snapshotName),
    LEGACY_MANIFEST_FILENAME,
  );

  try {
    const manifestJson = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(manifestJson) as unknown;
    if (!isLegacyManifest(parsed)) {
      logger.warn(`[DeviceSnapshot] Legacy manifest for '${snapshotName}' is invalid`);
      return null;
    }

    return normalizeLegacyManifest(snapshotName, parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(
        `[DeviceSnapshot] Failed to read legacy manifest for '${snapshotName}': ${error}`,
      );
    }
    return null;
  }
}

async function importLegacySnapshot(
  snapshotName: string,
  manifest: DeviceSnapshotManifest,
  snapshotStore: DeviceSnapshotStore,
  snapshotRepository: DeviceSnapshotRepository,
  now: () => Date,
): Promise<DeviceSnapshotRecord | null> {
  const sizeBytes = await snapshotStore.getSnapshotSizeBytes(snapshotName);
  const fallbackTimestamp = now().toISOString();
  const createdAt = resolveLegacyTimestamp(manifest.timestamp, fallbackTimestamp);

  const record: DeviceSnapshotRecord = {
    snapshotName,
    deviceId: manifest.deviceId,
    deviceName: manifest.deviceName,
    platform: manifest.platform,
    snapshotType: manifest.snapshotType,
    includeAppData: manifest.includeAppData,
    includeSettings: manifest.includeSettings,
    createdAt,
    lastAccessedAt: createdAt,
    sizeBytes,
    manifest,
  };

  try {
    await snapshotRepository.insertSnapshot(record);
    return record;
  } catch (error) {
    logger.warn(`[DeviceSnapshot] Failed to import legacy snapshot '${snapshotName}': ${error}`);
    return snapshotRepository.getSnapshot(snapshotName);
  }
}

async function hydrateLegacySnapshot(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  snapshotRepository: DeviceSnapshotRepository,
  now: () => Date,
): Promise<DeviceSnapshotRecord | null> {
  const manifest = await readLegacyManifest(snapshotName, snapshotStore);
  if (!manifest) {
    return null;
  }

  return importLegacySnapshot(snapshotName, manifest, snapshotStore, snapshotRepository, now);
}

async function importLegacySnapshotArchive(
  snapshotRepository: DeviceSnapshotRepository,
  snapshotStore: DeviceSnapshotStore,
  now: () => Date,
  existingSnapshots: Set<string>,
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(snapshotStore.getBasePath(), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`[DeviceSnapshot] Failed to scan legacy snapshots: ${error}`);
    }
    return false;
  }

  let imported = false;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const snapshotName = entry.name;
    if (existingSnapshots.has(snapshotName)) {
      continue;
    }

    const manifest = await readLegacyManifest(snapshotName, snapshotStore);
    if (!manifest) {
      continue;
    }

    const record = await importLegacySnapshot(
      snapshotName,
      manifest,
      snapshotStore,
      snapshotRepository,
      now,
    );
    if (record) {
      existingSnapshots.add(snapshotName);
      imported = true;
    }
  }

  return imported;
}

async function notifySnapshotResources(): Promise<void> {
  await ResourceRegistry.notifyResourcesUpdated([DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE]);
}

async function ensureSnapshotAvailable(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  snapshotRepository: DeviceSnapshotRepository,
  pathOptions?: SnapshotPathOptions,
): Promise<void> {
  // "android"/"ios" are the platform scope roots under the snapshots dir. An
  // unscoped (physical / fallback) snapshot with one of those names would take
  // the scope directory itself, so deleting it later would recursively remove
  // every scoped snapshot nested under it. Reject the collision at the source
  // (#5707); broader snapshotName sanitization is tracked in #5705.
  if (isReservedScopeSegment(snapshotName)) {
    throw new ActionableError(
      `Snapshot name '${snapshotName}' is reserved. Please choose a different name.`,
    );
  }

  const existing = await snapshotRepository.getSnapshot(snapshotName);
  if (existing) {
    throw new ActionableError(
      `Snapshot '${snapshotName}' already exists. Please choose a different name.`,
    );
  }

  if (await snapshotStore.snapshotDirectoryExists(snapshotName, pathOptions)) {
    throw new ActionableError(
      `Snapshot '${snapshotName}' already exists on disk. Please choose a different name.`,
    );
  }
}

async function deleteDeviceSnapshotRecord(record: DeviceSnapshotRecord): Promise<boolean> {
  const { snapshotRepository, snapshotStore } = await getDeviceSnapshotDependencies();
  const pathOptions = getSnapshotPathOptions({
    platform: record.platform,
    deviceId: record.deviceId,
    // For Android, deviceName holds the AVD name (see the capture manifest).
    avdName: record.deviceName,
  });
  await snapshotStore.deleteSnapshotData(record.snapshotName, pathOptions);
  // Snapshots captured before AVD-scoping (#5707) — including any created in the
  // ~/.auto-mobile base-path window between #5716 and this change — keep their
  // data at the unscoped flat path. Eviction now computes the scoped path, which
  // misses that data: the row would be deleted and its bytes reported reclaimed
  // while the flat directory survives (and, if it holds a legacy manifest.json,
  // listDeviceSnapshots re-imports it, so the archive limit can never evict it).
  // When scoping applied, also clear the flat path — but never a reserved scope
  // root (a snapshot literally named "android"/"ios", whose flat path IS the
  // scope tree); name sanitization is tracked separately (#5705).
  if (pathOptions && !isReservedScopeSegment(record.snapshotName)) {
    await snapshotStore.deleteSnapshotData(record.snapshotName);
  }
  const deleted = await snapshotRepository.deleteSnapshot(record.snapshotName);
  return deleted;
}

// Top-level segments the store uses to scope snapshots by platform/device. A
// snapshot whose name equals one of these resolves its flat path to the scope
// root, so the legacy flat-path cleanup must skip it to avoid deleting the whole
// scope tree.
function isReservedScopeSegment(snapshotName: string): boolean {
  return snapshotName === "android" || snapshotName === "ios";
}

async function enforceDeviceSnapshotArchiveLimit(
  maxArchiveSizeMb: number,
): Promise<SnapshotArchiveEvictionResult> {
  const maxSizeBytes = Math.max(0, Math.floor(maxArchiveSizeMb * 1024 * 1024));
  const { snapshotRepository } = await getDeviceSnapshotDependencies();
  const snapshots = await snapshotRepository.listSnapshots({
    orderByLastAccessed: "asc",
  });

  let currentSizeBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0);

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
      const deleted = await deleteDeviceSnapshotRecord(snapshot);
      if (deleted) {
        evictedSnapshotNames.push(snapshot.snapshotName);
        currentSizeBytes -= snapshot.sizeBytes;
      }
    } catch (error) {
      logger.warn(`[DeviceSnapshot] Failed to evict snapshot ${snapshot.snapshotName}: ${error}`);
    }
  }

  if (currentSizeBytes > maxSizeBytes) {
    logger.warn(
      `[DeviceSnapshot] Archive size ${currentSizeBytes} bytes still exceeds limit ${maxSizeBytes} bytes after eviction`,
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
    // Re-parse on read so configurations persisted by an older parser (which
    // could round a (0, 0.5) timeout down to a non-positive 0) are normalized
    // back to the fallback. parseDeviceSnapshotConfig is idempotent for valid
    // values, so this is a no-op for configs written by the current parser.
    return parseDeviceSnapshotConfig(stored);
  }
  return parseDeviceSnapshotConfig(serverConfig.getDeviceSnapshotDefaults());
}

export async function updateDeviceSnapshotConfig(
  update: DeviceSnapshotConfigInput | null,
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
  args: DeviceSnapshotCaptureArgs,
): Promise<{
  result: CaptureSnapshotResult;
  evictedSnapshotNames: string[];
}> {
  const { snapshotRepository, snapshotStore, timer, createCaptureProvider } =
    await getDeviceSnapshotDependencies();

  const baseConfig = await getDeviceSnapshotConfig();
  const snapshotName = args.snapshotName ?? snapshotStore.generateSnapshotName(device.name);
  const pathOptions = getSnapshotPathOptions({
    platform: device.platform,
    deviceId: device.deviceId,
    // For an Android emulator, BootedDevice.name is the AVD name resolved via
    // `adb emu avd name` during discovery.
    avdName: device.name,
  });

  await ensureSnapshotAvailable(snapshotName, snapshotStore, snapshotRepository, pathOptions);

  const mergedConfig: DeviceSnapshotConfig = {
    ...baseConfig,
    includeAppData: args.includeAppData ?? baseConfig.includeAppData,
    includeSettings: args.includeSettings ?? baseConfig.includeSettings,
    useVmSnapshot: args.useVmSnapshot ?? baseConfig.useVmSnapshot,
    strictBackupMode: args.strictBackupMode ?? baseConfig.strictBackupMode,
    vmSnapshotTimeoutMs: args.vmSnapshotTimeoutMs ?? baseConfig.vmSnapshotTimeoutMs,
  };

  const captureProvider = createCaptureProvider(device, timer, snapshotStore);
  const result = await captureProvider.capture({
    snapshotName,
    includeAppData: mergedConfig.includeAppData,
    includeSettings: mergedConfig.includeSettings,
    useVmSnapshot: mergedConfig.useVmSnapshot,
    strictBackupMode: mergedConfig.strictBackupMode,
    vmSnapshotTimeoutMs: mergedConfig.vmSnapshotTimeoutMs,
    appBundleIds: args.appBundleIds,
  });

  const sizeBytes = await snapshotStore.getSnapshotSizeBytes(snapshotName, pathOptions);
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
  args: DeviceSnapshotRestoreArgs,
): Promise<{
  result: RestoreSnapshotResult;
  manifest: DeviceSnapshotManifest;
}> {
  const { snapshotRepository, snapshotStore, timer, now, createRestoreProvider } =
    await getDeviceSnapshotDependencies();

  let record = await snapshotRepository.getSnapshot(args.snapshotName);
  if (!record) {
    record = await hydrateLegacySnapshot(args.snapshotName, snapshotStore, snapshotRepository, now);
  }
  if (!record) {
    throw new ActionableError(`Snapshot '${args.snapshotName}' not found`);
  }

  const baseConfig = await getDeviceSnapshotConfig();
  const useVmSnapshot = args.useVmSnapshot ?? baseConfig.useVmSnapshot;
  const vmSnapshotTimeoutMs = args.vmSnapshotTimeoutMs ?? baseConfig.vmSnapshotTimeoutMs;

  const restoreProvider = createRestoreProvider(device, timer, snapshotStore);
  const result = await restoreProvider.restore({
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
  const { snapshotRepository, snapshotStore, now } = await getDeviceSnapshotDependencies();
  const initialRecords = await snapshotRepository.listSnapshots({
    orderByCreatedAt: "desc",
  });
  const existingSnapshotNames = new Set(initialRecords.map((record) => record.snapshotName));
  const importedLegacy = await importLegacySnapshotArchive(
    snapshotRepository,
    snapshotStore,
    now,
    existingSnapshotNames,
  );
  const records = importedLegacy
    ? await snapshotRepository.listSnapshots({ orderByCreatedAt: "desc" })
    : initialRecords;

  const snapshots = records.map(buildArchiveEntry);
  const totalSizeBytes = records.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0);

  return {
    snapshots,
    count: snapshots.length,
    totalSizeBytes,
  };
}
