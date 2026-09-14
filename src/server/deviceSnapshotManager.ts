import { promises as fs } from "fs";
import type { Dirent } from "fs";
import * as path from "path";
import {
  ActionableError,
  BootedDevice,
  DeviceSnapshotConfig,
  DeviceSnapshotConfigInput,
  DeviceSnapshotManifest,
  toActionableError,
} from "../models";
import {
  DeviceSnapshotRepository,
  type DeviceSnapshotRecord,
} from "../db/deviceSnapshotRepository";
import {
  createDeviceSnapshotConfigRepository,
  type ConfigRepository,
} from "../db/keyedJsonConfigRepository";
import {
  DeviceSnapshotStore,
  SNAPSHOT_REPLACING_SUFFIX,
  type SnapshotPathOptions,
} from "../utils/DeviceSnapshotStore";
import { assertSafeSnapshotName } from "../utils/snapshotNameValidation";
import { parseDeviceSnapshotConfig } from "../features/snapshot";
import { serverConfig } from "../utils/ServerConfig";
import { ResourceRegistry } from "./resourceRegistry";
import { DEVICE_SNAPSHOT_RESOURCE_URIS } from "./deviceSnapshotResourceUris";
import {
  CaptureSnapshot,
  type CaptureSnapshotResult,
  VM_SNAPSHOT_SAVE_DISPATCHED,
} from "../features/action/CaptureSnapshot";
import { RestoreSnapshot, type RestoreSnapshotResult } from "../features/action/RestoreSnapshot";
import type {
  SnapshotCaptureProvider,
  SnapshotRestoreProvider,
} from "../utils/interfaces/SnapshotProvider";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  AVD_DEFAULT_BOOT_SNAPSHOT,
  AvdSnapshotService,
  type AvdSnapshotOperations,
} from "../utils/android-cmdline-tools/AvdSnapshotService";
import { errorMessage } from "../utils/describeUnknownError";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { logger } from "../utils/logger";
import {
  DefaultDeviceIncarnationInvalidator,
  type DeviceIncarnationInvalidator,
} from "./DeviceIncarnationInvalidator";

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
  /** Rows whose size could not be measured: not budgeted, but not hidden either (#6490). */
  unsizedCount: number;
}

interface VmSnapshotRetentionResult extends SnapshotArchiveEvictionResult {
  cannotFitExcluded: boolean;
  excludedSnapshotMissing: boolean;
  excludedSnapshotRecord: DeviceSnapshotRecord | null;
  excludedSnapshotSizeBytes: number | null;
  countEvictedSnapshotNames: string[];
  byteEvictedSnapshotNames: string[];
}

interface VmRetentionState {
  snapshots: DeviceSnapshotRecord[];
  evictedSnapshotNames: string[];
  countEvictedSnapshotNames: string[];
  byteEvictedSnapshotNames: string[];
  failedNames: Set<string>;
}

type VmRetentionEvictionOutcome =
  | "evicted"
  | "deferred"
  | "no-candidate"
  | "failed"
  | "removed-concurrently";

/** An in-AVD snapshot directory with no archive row behind it (#6490). */
export interface OrphanedAvdSnapshot {
  avdName: string;
  snapshotName: string;
  /**
   * The directory the scan resolved, so manual cleanup can target it verbatim.
   * ANDROID_AVD_HOME and an `<avd>.ini` redirect both move an AVD off the
   * conventional `~/.android/avd/<avd>.avd` path (#6891 review).
   */
  directoryPath: string;
  sizeBytes: number | null;
}

export interface OrphanedAvdSnapshotSummary {
  count: number;
  totalSizeBytes: number;
  unsizedCount: number;
  entries: OrphanedAvdSnapshot[];
}

interface DeviceSnapshotManagerDependencies {
  snapshotRepository: DeviceSnapshotRepository;
  configRepository: ConfigRepository<DeviceSnapshotConfig>;
  snapshotStore: DeviceSnapshotStore;
  /** Emulator-owned side of a VM snapshot: its in-AVD size and its console delete (#6490). */
  avdSnapshots: AvdSnapshotOperations;
  timer: Timer;
  vmRetentionRetryBackoff: BackoffPolicy;
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
  deviceIncarnationInvalidator: DeviceIncarnationInvalidator;
}

let moduleDependencies: DeviceSnapshotManagerDependencies | null = null;
const LEGACY_MANIFEST_FILENAME = "manifest.json";

// Serializes the LIFECYCLE of one snapshot name within this process: captures,
// restores, and reclaim all take this lock. Two concurrent same-name captures
// must not interleave their filesystem writes or race the record upsert; running
// them one-after-another makes the outcome deterministic (last writer wins) and
// closes the historical check-then-create TOCTOU window (issue #5713). A restore
// holds it too, because the emulator-owned payload it is loading must not be
// console-deleted out from under it by a concurrent budget pass (#6490 review).
// The daemon is single-process, so an in-process promise chain is sufficient —
// cross-process coordination is out of scope.
const snapshotNameLocks = new Map<string, Promise<unknown>>();

// Serializes the archive byte-budget eviction pass across ALL names and devices.
// Captures on different names/devices take different (per-name) lifecycle locks, so
// their eviction passes would otherwise interleave against the same table and the
// same budget: each reads the same up-front list and running total, then both
// delete least-recently-accessed rows, and a pass that gets `deleted === false`
// for rows another pass already removed credits itself nothing and keeps walking
// — over-evicting well past the budget and emptying the archive (issue #6491).
// Running the whole pass under one lock keyed on a CONSTANT makes passes QUEUE,
// so each pass's up-front list/total read is accurate for its own duration. This
// narrows rather than widens what is held: capture work stays parallel; only the
// budget arithmetic is one-at-a-time. A separate map (not snapshotNameLocks) is used so
// a snapshot whose name happens to equal the key can't serialize against it.
const archiveBudgetLocks = new Map<string, Promise<unknown>>();
const ARCHIVE_BUDGET_LOCK_KEY = "archive-budget";
// Serializes a config update's read-merge-write and its destructive retention
// pass. A separate map (not snapshotNameLocks) is used so a snapshot whose
// name happens to equal the key can't serialize against it.
const configUpdateLocks = new Map<string, Promise<unknown>>();
const CONFIG_UPDATE_LOCK_KEY = "config-update";
const vmRetentionLocks = new Map<string, Promise<unknown>>();
const protectedVmRetentionSnapshotNames = new Map<string, Map<string, number>>();
const vmRetentionRetryAttempts = new Map<string, number>();

function protectVmRetentionSnapshot(deviceName: string, snapshotName: string): void {
  const protectedNames =
    protectedVmRetentionSnapshotNames.get(deviceName) ?? new Map<string, number>();
  protectedNames.set(snapshotName, (protectedNames.get(snapshotName) ?? 0) + 1);
  protectedVmRetentionSnapshotNames.set(deviceName, protectedNames);
}

function unprotectVmRetentionSnapshot(deviceName: string, snapshotName: string): void {
  const protectedNames = protectedVmRetentionSnapshotNames.get(deviceName);
  if (!protectedNames) {
    return;
  }
  const protectionCount = protectedNames.get(snapshotName);
  if (protectionCount === undefined) {
    return;
  }
  if (protectionCount === 1) {
    protectedNames.delete(snapshotName);
  } else {
    protectedNames.set(snapshotName, protectionCount - 1);
  }
  if (protectedNames.size === 0) {
    protectedVmRetentionSnapshotNames.delete(deviceName);
  }
}

function getProtectedVmRetentionSnapshotNames(deviceName: string): Set<string> {
  const protectedNames = protectedVmRetentionSnapshotNames.get(deviceName);
  return new Set(
    [...(protectedNames ?? new Map<string, number>())]
      .filter(([, protectionCount]) => protectionCount > 0)
      .map(([snapshotName]) => snapshotName),
  );
}

function getVmRetentionProtectedSnapshotNames(
  deviceName: string,
  excludeFromEviction: string | undefined,
): Set<string> {
  const protectedNames = getProtectedVmRetentionSnapshotNames(deviceName);
  if (excludeFromEviction !== undefined) {
    protectedNames.add(excludeFromEviction);
  }
  return protectedNames;
}

export async function withVmRetentionSnapshotProtection<T>(
  device: BootedDevice,
  snapshotName: string,
  useVmSnapshot: boolean,
  task: () => Promise<T>,
): Promise<T> {
  if (!isAndroidEmulatorVmCapture(device, useVmSnapshot)) {
    return task();
  }

  protectVmRetentionSnapshot(device.name, snapshotName);
  try {
    return await task();
  } finally {
    unprotectVmRetentionSnapshot(device.name, snapshotName);
  }
}

function isAndroidEmulatorVmCapture(device: BootedDevice, useVmSnapshot: boolean): boolean {
  return device.platform === "android" && device.deviceId.startsWith("emulator-") && useVmSnapshot;
}

// Shared serialization primitive: run `task` after any prior holder of `key`
// settles, keeping a promise-chain tail in `locks` and dropping the entry once
// this is the last holder so the map doesn't grow unbounded.
function withSerializedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  // Run after the prior holder settles, regardless of whether it resolved or
  // rejected, so one failed holder doesn't wedge every later one for this key.
  const run = prior.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.finally(() => {
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  });
  return run;
}

function withSnapshotNameLock<T>(snapshotName: string, task: () => Promise<T>): Promise<T> {
  return withSerializedLock(snapshotNameLocks, snapshotName, task);
}

// Nothing that holds a per-NAME lifecycle lock awaits this DISTINCT
// constant-keyed lock, and nothing holding this one ever AWAITS a name lock
// (eviction only TRIES it — see withExclusiveSnapshotRecord), so there is no
// re-entrancy and no deadlock in either direction.
function withArchiveBudgetLock<T>(task: () => Promise<T>): Promise<T> {
  return withSerializedLock(archiveBudgetLocks, ARCHIVE_BUDGET_LOCK_KEY, task);
}

function withConfigUpdateLock<T>(task: () => Promise<T>): Promise<T> {
  return withSerializedLock(configUpdateLocks, CONFIG_UPDATE_LOCK_KEY, task);
}

function withVmRetentionLock<T>(deviceName: string, task: () => Promise<T>): Promise<T> {
  return withSerializedLock(vmRetentionLocks, deviceName, task);
}

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
      avdSnapshots: new AvdSnapshotService(new DeviceSnapshotStore()),
      timer: defaultTimer,
      vmRetentionRetryBackoff: exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 5000 }),
      now: () => new Date(),
      createCaptureProvider: (device, timer, store) => {
        return new CaptureSnapshot(device, undefined, undefined, timer, store);
      },
      createRestoreProvider: (device, timer, store) => {
        return new RestoreSnapshot(device, undefined, undefined, timer, store);
      },
      deviceIncarnationInvalidator: new DefaultDeviceIncarnationInvalidator(),
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
    avdSnapshots: deps.avdSnapshots ?? current.avdSnapshots,
    timer: deps.timer ?? current.timer,
    vmRetentionRetryBackoff: deps.vmRetentionRetryBackoff ?? current.vmRetentionRetryBackoff,
    now: deps.now ?? current.now,
    createCaptureProvider: deps.createCaptureProvider ?? current.createCaptureProvider,
    createRestoreProvider: deps.createRestoreProvider ?? current.createRestoreProvider,
    deviceIncarnationInvalidator:
      deps.deviceIncarnationInvalidator ?? current.deviceIncarnationInvalidator,
  };
}

export function resetDeviceSnapshotManagerDependencies(): void {
  moduleDependencies = null;
  snapshotNameLocks.clear();
  archiveBudgetLocks.clear();
  configUpdateLocks.clear();
  vmRetentionLocks.clear();
  protectedVmRetentionSnapshotNames.clear();
  vmRetentionRetryAttempts.clear();
}

function configToInput(config: DeviceSnapshotConfig): DeviceSnapshotConfigInput {
  return {
    includeAppData: config.includeAppData,
    includeSettings: config.includeSettings,
    useVmSnapshot: config.useVmSnapshot,
    strictBackupMode: config.strictBackupMode,
    vmSnapshotTimeoutMs: config.vmSnapshotTimeoutMs,
    maxVmSnapshotsPerAvd: config.maxVmSnapshotsPerAvd,
    maxVmArchiveSizeMb: config.maxVmArchiveSizeMb,
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
    maxVmSnapshotsPerAvd: overrides.maxVmSnapshotsPerAvd ?? base.maxVmSnapshotsPerAvd,
    maxVmArchiveSizeMb: overrides.maxVmArchiveSizeMb ?? base.maxVmArchiveSizeMb,
    maxArchiveSizeMb: overrides.maxArchiveSizeMb ?? base.maxArchiveSizeMb,
  };
}

function formatSnapshotSize(bytes: number | null): string {
  // Distinct from "0 B": the payload exists but could not be located/measured,
  // so reporting a number here would be a lie the budget then acts on (#6490).
  if (bytes === null) {
    return "unknown";
  }
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
    restorable: !record.pendingReclaim,
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
    ...(record.pendingReclaim
      ? {
          pendingReclaim: true,
          ...(record.pendingReclaimReason === undefined
            ? {}
            : { pendingReclaimReason: record.pendingReclaimReason }),
        }
      : {}),
  };
}

/** True for a record whose payload lives inside the AVD rather than the archive store. */
function isVmSnapshotRecord(record: { platform: string; snapshotType: string }): boolean {
  return record.platform === "android" && record.snapshotType === "vm";
}

/**
 * Size a freshly captured (or legacy-imported) snapshot at the location that
 * actually holds its bytes: the AVD's `snapshots/<name>` directory for a VM
 * snapshot, the archive directory for everything else. Returns null when a VM
 * payload cannot be located — recorded as unknown, never as 0 (#6490).
 */
async function resolveSnapshotSizeBytes(
  snapshotName: string,
  manifest: DeviceSnapshotManifest,
  snapshotStore: DeviceSnapshotStore,
  avdSnapshots: AvdSnapshotOperations,
  pathOptions: SnapshotPathOptions | undefined,
): Promise<number | null> {
  if (!isVmSnapshotRecord(manifest)) {
    return snapshotStore.getSnapshotSizeBytes(snapshotName, pathOptions);
  }

  // For an Android emulator capture the manifest's deviceName IS the AVD name.
  const sizeBytes = await avdSnapshots.measureVmSnapshotBytes(manifest.deviceName, snapshotName);
  if (sizeBytes === null) {
    logger.warn(
      `[DeviceSnapshot] Could not measure the in-AVD payload of VM snapshot ` +
        `'${snapshotName}' for AVD '${manifest.deviceName}'; recording its size as unknown`,
    );
  }
  return sizeBytes;
}

function wasVmSnapshotSaveDispatched(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>)[VM_SNAPSHOT_SAVE_DISPATCHED] === true
  );
}

async function deleteUnrecordedVmSnapshot(
  device: BootedDevice,
  snapshotName: string,
  avdSnapshots: AvdSnapshotOperations,
  vmSnapshotTimeoutMs: number,
  context: string,
): Promise<void> {
  try {
    const outcome = await avdSnapshots.deleteVmSnapshot(
      device.deviceId,
      snapshotName,
      vmSnapshotTimeoutMs,
    );
    if (!outcome.reclaimed) {
      logger.warn(
        `[DeviceSnapshot] Could not clean up ${context} VM snapshot '${snapshotName}' on AVD ` +
          `'${device.name}': ${outcome.reason ?? "unknown reason"}`,
      );
    }
  } catch (deleteError) {
    // Safe to swallow: this is best-effort cleanup after the capture or database path failed.
    logger.warn(
      `[DeviceSnapshot] Failed to clean up ${context} VM snapshot '${snapshotName}' on AVD ` +
        `'${device.name}': ${errorMessage(deleteError)}`,
      deleteError,
    );
  }
}

async function recordFailedVmSnapshotReclaim(
  device: BootedDevice,
  snapshotName: string,
  includeSettings: boolean,
  snapshotRepository: DeviceSnapshotRepository,
  avdSnapshots: AvdSnapshotOperations,
  vmSnapshotTimeoutMs: number,
  now: () => Date,
  error: unknown,
): Promise<boolean> {
  const reason = `VM snapshot save was dispatched but capture failed: ${errorMessage(error)}`;
  let sizeBytes: number | null = null;
  try {
    sizeBytes = await avdSnapshots.measureVmSnapshotBytes(device.name, snapshotName);
  } catch (measureError) {
    logger.warn(
      `[DeviceSnapshot] Failed to measure orphaned VM snapshot '${snapshotName}' on AVD ` +
        `'${device.name}': ${errorMessage(measureError)}`,
      measureError,
    );
  }

  const timestamp = now().toISOString();
  try {
    const existing = await snapshotRepository.getSnapshot(snapshotName);
    if (
      existing &&
      (existing.deviceId !== device.deviceId || existing.deviceName !== device.name)
    ) {
      logger.warn(
        `[DeviceSnapshot] Same-named capture '${snapshotName}' failed on AVD '${device.name}' ` +
          `(${device.deviceId}); preserving the existing row for AVD '${existing.deviceName}' ` +
          `(${existing.deviceId}) untouched: ${reason}`,
      );
      await deleteUnrecordedVmSnapshot(
        device,
        snapshotName,
        avdSnapshots,
        vmSnapshotTimeoutMs,
        "failed same-named",
      );
      return false;
    }

    await snapshotRepository.insertSnapshot({
      snapshotName,
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes,
      pendingReclaim: true,
      pendingReclaimReason: reason,
      manifest: {
        snapshotName,
        timestamp,
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings,
      },
    });
    logger.warn(
      `[DeviceSnapshot] Recorded pending reclaim for orphaned VM snapshot '${snapshotName}' ` +
        `on AVD '${device.name}': ${reason}`,
    );
    return true;
  } catch (recordError) {
    logger.warn(
      `[DeviceSnapshot] Failed to record pending reclaim for orphaned VM snapshot '${snapshotName}' ` +
        `on AVD '${device.name}': ${errorMessage(recordError)}`,
      recordError,
    );
    await deleteUnrecordedVmSnapshot(
      device,
      snapshotName,
      avdSnapshots,
      vmSnapshotTimeoutMs,
      "unrecordable",
    );
    return false;
  }
}

// Validates the shape of a manifest read back from disk. Shared by every
// on-disk manifest source this module reads: the modern per-platform
// metadata.json (issue #6492) and the legacy flat manifest.json it falls back
// to for pre-#5707 snapshots.
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

// Structural check for the settings.json payload CaptureSnapshot.saveSettings
// writes (src/features/action/CaptureSnapshot.ts:360-371): the raw
// `{global?, secure?, system?}` triplet, not a full manifest.
function isSettingsPayload(
  value: unknown,
): value is NonNullable<DeviceSnapshotManifest["settings"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const settings = value as Record<string, unknown>;
  return (["global", "secure", "system"] as const).every((key) => {
    const entry = settings[key];
    return (
      entry === undefined || (typeof entry === "object" && entry !== null && !Array.isArray(entry))
    );
  });
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

async function readManifestFile(manifestPath: string): Promise<DeviceSnapshotManifest | null> {
  try {
    const manifestJson = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(manifestJson) as unknown;
    if (!isLegacyManifest(parsed)) {
      logger.warn(`[DeviceSnapshot] Manifest at '${manifestPath}' has an unexpected shape`);
      return null;
    }
    return parsed;
  } catch (error) {
    // ENOENT (this manifest filename doesn't exist here) is an expected miss —
    // the caller tries the next filename/source. Anything else (malformed
    // JSON, permission error) is unexpected and worth a trace, but still just
    // degrades to "no manifest found here" rather than throwing (best-effort
    // recovery path).
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`[DeviceSnapshot] Failed to read manifest at '${manifestPath}': ${error}`);
    }
    return null;
  }
}

/**
 * Read the full manifest for `snapshotName`, preferring the modern
 * `metadata.json` that every current capture path writes at the (possibly
 * scoped) snapshot directory — this is the same artifact iOS capture writes
 * via `CaptureSnapshot.saveIosMetadata` (`getMetadataPath`) — and falling back
 * to the legacy flat `manifest.json` for pre-#5707 snapshots that predate both
 * `metadata.json` and directory scoping (issue #6492).
 */
async function readSnapshotManifest(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  pathOptions: SnapshotPathOptions | undefined,
): Promise<DeviceSnapshotManifest | null> {
  const modern = await readManifestFile(snapshotStore.getMetadataPath(snapshotName, pathOptions));
  if (modern) {
    return normalizeLegacyManifest(snapshotName, modern);
  }

  const legacyPath = path.join(
    snapshotStore.getSnapshotPathWithOptions(snapshotName, pathOptions),
    LEGACY_MANIFEST_FILENAME,
  );
  const legacy = await readManifestFile(legacyPath);
  if (legacy) {
    return normalizeLegacyManifest(snapshotName, legacy);
  }

  return null;
}

/**
 * Reconstruct a manifest from settings.json alone for a settings-only Android
 * capture (`CaptureSnapshot.saveSettings`, `getSettingsPath`) that has no
 * metadata.json/manifest.json anywhere — the case where settings were
 * "write-only" (issue #6492). settings.json carries none of the manifest's
 * other fields, so anything not derivable from the scan context (the
 * AVD-scoped directory name, if any) is left at a safe, honestly-unknown
 * default rather than guessed — deviceId in particular cannot be recovered.
 */
async function readSettingsOnlyManifest(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  pathOptions: SnapshotPathOptions | undefined,
  now: () => Date,
): Promise<DeviceSnapshotManifest | null> {
  const settingsPath = snapshotStore.getSettingsPath(snapshotName, pathOptions);

  let settingsJson: string;
  try {
    settingsJson = await fs.readFile(settingsPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`[DeviceSnapshot] Failed to read settings for '${snapshotName}': ${error}`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch (error) {
    logger.warn(`[DeviceSnapshot] Settings file for '${snapshotName}' is not valid JSON: ${error}`);
    return null;
  }

  if (!isSettingsPayload(parsed)) {
    logger.warn(`[DeviceSnapshot] Settings file for '${snapshotName}' has an unexpected shape`);
    return null;
  }

  return {
    snapshotName,
    timestamp: now().toISOString(),
    deviceId: "",
    deviceName: pathOptions?.avdName ?? "",
    platform: "android",
    snapshotType: "adb",
    includeAppData: false,
    includeSettings: true,
    settings: parsed,
  };
}

/**
 * Discover a snapshot's manifest from whatever it actually wrote to disk:
 * the full manifest first (metadata.json, then legacy manifest.json), and —
 * only for a non-iOS path, since settings.json is never written for iOS —
 * the settings-only fallback second. Returns null if neither source exists
 * or parses, so the caller treats the directory as not a recoverable
 * snapshot rather than throwing (issue #6492).
 */
async function discoverSnapshotManifest(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  pathOptions: SnapshotPathOptions | undefined,
  now: () => Date,
): Promise<DeviceSnapshotManifest | null> {
  const manifest = await readSnapshotManifest(snapshotName, snapshotStore, pathOptions);
  if (manifest) {
    return manifest;
  }

  if (pathOptions?.platform === "ios") {
    return null;
  }

  return readSettingsOnlyManifest(snapshotName, snapshotStore, pathOptions, now);
}

async function importLegacySnapshot(
  snapshotName: string,
  manifest: DeviceSnapshotManifest,
  snapshotStore: DeviceSnapshotStore,
  snapshotRepository: DeviceSnapshotRepository,
  now: () => Date,
  pathOptions?: SnapshotPathOptions,
): Promise<DeviceSnapshotRecord | null> {
  const { avdSnapshots } = await getDeviceSnapshotDependencies();
  const sizeBytes = await resolveSnapshotSizeBytes(
    snapshotName,
    manifest,
    snapshotStore,
    avdSnapshots,
    pathOptions,
  );
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
  const flatManifest = await discoverSnapshotManifest(snapshotName, snapshotStore, undefined, now);
  if (flatManifest) {
    return importLegacySnapshot(snapshotName, flatManifest, snapshotStore, snapshotRepository, now);
  }

  // Not at the flat/unscoped path — a restore-by-name doesn't know which
  // AVD/device scope (if any) holds this snapshot, so probe every scoped
  // directory the same way importScopedLegacySnapshots does (#5707, #6492).
  const scoped = await findScopedSnapshotManifest(snapshotName, snapshotStore, now);
  if (!scoped) {
    return null;
  }

  return importLegacySnapshot(
    snapshotName,
    scoped.manifest,
    snapshotStore,
    snapshotRepository,
    now,
    scoped.pathOptions,
  );
}

/**
 * Enumerate the AVD/device-scoped directories under `android/` and `ios/`
 * (the layout every current capture path writes to since #5707), yielding
 * one `SnapshotPathOptions` per scope directory found. Isolated so both the
 * single-name lookup (`findScopedSnapshotManifest`) and the full-archive scan
 * (`importScopedLegacySnapshots`) derive the same path shape the writers use
 * rather than re-deriving path structure at each call site (issue #6492).
 */
async function* iterateScopedSnapshotDirs(
  snapshotStore: DeviceSnapshotStore,
): AsyncGenerator<{ pathOptions: SnapshotPathOptions; scopedDirPath: string }> {
  for (const platform of ["android", "ios"] as const) {
    const scopeRootPath = path.join(snapshotStore.getBasePath(), platform);
    let deviceDirs: Dirent[];
    try {
      deviceDirs = await fs.readdir(scopeRootPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn(`[DeviceSnapshot] Failed to scan ${platform} snapshot scope: ${error}`);
      }
      continue;
    }

    for (const deviceDir of deviceDirs) {
      if (!deviceDir.isDirectory()) {
        continue;
      }

      const pathOptions: SnapshotPathOptions =
        platform === "ios"
          ? { platform: "ios", deviceId: deviceDir.name }
          : { platform: "android", avdName: deviceDir.name };

      yield { pathOptions, scopedDirPath: path.join(scopeRootPath, deviceDir.name) };
    }
  }
}

async function findScopedSnapshotManifest(
  snapshotName: string,
  snapshotStore: DeviceSnapshotStore,
  now: () => Date,
): Promise<{ manifest: DeviceSnapshotManifest; pathOptions: SnapshotPathOptions } | null> {
  for await (const { pathOptions } of iterateScopedSnapshotDirs(snapshotStore)) {
    const exists = await snapshotStore.snapshotDirectoryExists(snapshotName, pathOptions);
    if (!exists) {
      continue;
    }

    const manifest = await discoverSnapshotManifest(snapshotName, snapshotStore, pathOptions, now);
    if (manifest) {
      return { manifest, pathOptions };
    }
  }

  return null;
}

/**
 * Import every legacy-recoverable snapshot at the flat/unscoped base path
 * (pre-#5707 layout, and physical-device captures that never scope by AVD).
 */
async function importFlatLegacySnapshots(
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
    // A `<name>${SNAPSHOT_REPLACING_SUFFIX}` directory is an interrupted-overwrite
    // set-aside copy (holding the prior snapshot's manifest), never a real
    // snapshot — importing it would resurrect stale data as a phantom snapshot
    // that consumes archive budget and is "restorable" against dead contents
    // (#5713). Skip it; the next overwrite of the base name clears it.
    if (snapshotName.endsWith(SNAPSHOT_REPLACING_SUFFIX)) {
      continue;
    }
    // "android"/"ios" are scope roots (#5707), not snapshot directories
    // themselves — importScopedLegacySnapshots walks their contents.
    if (isReservedScopeSegment(snapshotName)) {
      continue;
    }
    if (existingSnapshots.has(snapshotName)) {
      continue;
    }

    const manifest = await discoverSnapshotManifest(snapshotName, snapshotStore, undefined, now);
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

/**
 * Import every legacy-recoverable snapshot nested under the `android/<avd>/`
 * and `ios/<udid>/` scope directories (#5707 layout) that has no DB row yet.
 * Orphaned scoped directories were previously invisible to this scan — the
 * top-level `readdir` in importFlatLegacySnapshots never descends into them
 * (issue #6492).
 */
async function importScopedLegacySnapshots(
  snapshotRepository: DeviceSnapshotRepository,
  snapshotStore: DeviceSnapshotStore,
  now: () => Date,
  existingSnapshots: Set<string>,
): Promise<boolean> {
  let imported = false;

  for await (const { pathOptions, scopedDirPath } of iterateScopedSnapshotDirs(snapshotStore)) {
    let snapshotDirs: Dirent[];
    try {
      snapshotDirs = await fs.readdir(scopedDirPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn(`[DeviceSnapshot] Failed to scan snapshots under ${scopedDirPath}: ${error}`);
      }
      continue;
    }

    for (const snapshotDir of snapshotDirs) {
      if (!snapshotDir.isDirectory()) {
        continue;
      }

      const snapshotName = snapshotDir.name;
      // Same interrupted-overwrite set-aside case as the flat scan, but
      // nested one level deeper under the AVD/device scope (#5713, #6492).
      if (snapshotName.endsWith(SNAPSHOT_REPLACING_SUFFIX)) {
        continue;
      }
      if (existingSnapshots.has(snapshotName)) {
        continue;
      }

      const manifest = await discoverSnapshotManifest(
        snapshotName,
        snapshotStore,
        pathOptions,
        now,
      );
      if (!manifest) {
        continue;
      }

      const record = await importLegacySnapshot(
        snapshotName,
        manifest,
        snapshotStore,
        snapshotRepository,
        now,
        pathOptions,
      );
      if (record) {
        existingSnapshots.add(snapshotName);
        imported = true;
      }
    }
  }

  return imported;
}

async function importLegacySnapshotArchive(
  snapshotRepository: DeviceSnapshotRepository,
  snapshotStore: DeviceSnapshotStore,
  now: () => Date,
  existingSnapshots: Set<string>,
): Promise<boolean> {
  // Order matters only for existingSnapshots de-duplication: a flat-path
  // snapshot is checked first, so a scoped orphan sharing its name is skipped
  // rather than double-imported (the name-keyed record table cannot tell
  // them apart — a pre-existing limitation, see #5741 item 4).
  const importedFlat = await importFlatLegacySnapshots(
    snapshotRepository,
    snapshotStore,
    now,
    existingSnapshots,
  );
  const importedScoped = await importScopedLegacySnapshots(
    snapshotRepository,
    snapshotStore,
    now,
    existingSnapshots,
  );

  return importedFlat || importedScoped;
}

async function notifySnapshotResources(): Promise<void> {
  await ResourceRegistry.notifyResourcesUpdated([DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE]);
}

function assertSnapshotNameWritable(snapshotName: string): void {
  // "android"/"ios" are the platform scope roots under the snapshots dir. An
  // unscoped (physical / fallback) snapshot with one of those names would take
  // the scope directory itself, so deleting it later would recursively remove
  // every scoped snapshot nested under it. Reject the collision at the source
  // (#5707); broader snapshotName sanitization is tracked in #5705.
  //
  // A pre-existing snapshot of the same name is intentionally NOT rejected:
  // re-capturing an existing name overwrites it (issue #5713). The overwrite is
  // made atomic by DeviceSnapshotStore.replaceSnapshotData plus the per-name
  // name lock, and the record is replaced (not duplicated) by the repository
  // upsert — so the old check-then-create existence probe (a TOCTOU window) is
  // gone.
  if (isReservedScopeSegment(snapshotName)) {
    throw new ActionableError(
      `Snapshot name '${snapshotName}' is reserved. Please choose a different name.`,
    );
  }

  // The atomic overwrite moves the existing snapshot into a sibling
  // `<name>${SNAPSHOT_REPLACING_SUFFIX}` directory. Allowing a snapshot to BE
  // named with that suffix would let one capture's set-aside path collide with
  // another real snapshot's directory and delete it. Reserve the suffix (#5713).
  if (snapshotName.endsWith(SNAPSHOT_REPLACING_SUFFIX)) {
    throw new ActionableError(
      `Snapshot name '${snapshotName}' ends with the reserved '${SNAPSHOT_REPLACING_SUFFIX}' ` +
        "suffix. Please choose a different name.",
    );
  }
}

function assertVmSnapshotNameWritable(snapshotName: string): void {
  if (snapshotName.trim().toLowerCase() === AVD_DEFAULT_BOOT_SNAPSHOT.toLowerCase()) {
    throw new ActionableError(
      `Snapshot name '${AVD_DEFAULT_BOOT_SNAPSHOT}' is reserved for the emulator's own quick-boot ` +
        "snapshot and cannot be used as an AutoMobile capture name.",
    );
  }
}

/**
 * Reclaim the emulator-owned payload of a `vm` record before its row goes away.
 *
 * Deleting the row and the (empty) archive directory reclaims nothing for a VM
 * snapshot: the gigabytes live in `<avd>.avd/snapshots/<name>` and only the
 * emulator console can remove them. When the emulator is live we issue that
 * delete; when it is not, we keep the row and flag it instead, so the reference
 * survives for {@link sweepPendingVmSnapshotReclaims} rather than being dropped
 * "for free" while the bytes stay on disk (#6490).
 *
 * Returns true when the caller may proceed to delete the row.
 */
async function reclaimVmSnapshotPayload(
  record: DeviceSnapshotRecord,
  vmSnapshotTimeoutMs: number,
): Promise<boolean> {
  const { snapshotRepository, avdSnapshots } = await getDeviceSnapshotDependencies();
  const avdName = record.deviceName;

  const serial = await avdSnapshots.findLiveEmulatorSerial(avdName);
  if (serial) {
    // Write the intent down BEFORE the irreversible step. Once the emulator
    // accepts the delete the payload is gone; if this process dies there — or
    // the row deletion that follows fails — a row still reading "not pending"
    // keeps being listed and offered for restore with nothing behind it, and
    // the sweep cannot repair it because it selects only pending rows. Flagged
    // first, the worst case is a retry that finds the payload already absent,
    // which deleteVmSnapshot already counts as reclaimed (#6891 review).
    await snapshotRepository.updateSnapshot(record.snapshotName, {
      pendingReclaim: true,
      pendingReclaimReason: `reclaiming the in-AVD payload on AVD '${avdName}'`,
    });
  }

  const outcome = serial
    ? await avdSnapshots.deleteVmSnapshot(serial, record.snapshotName, vmSnapshotTimeoutMs)
    : {
        reclaimed: false,
        reason: `emulator for AVD '${avdName}' is not running; in-AVD snapshot left in place`,
      };

  if (outcome.reclaimed) {
    return true;
  }

  logger.warn(
    `[DeviceSnapshot] Could not reclaim the in-AVD payload of VM snapshot ` +
      `'${record.snapshotName}': ${outcome.reason}. Keeping the record so the reclaim ` +
      "can be completed when that emulator is next seen live.",
  );
  await snapshotRepository.updateSnapshot(record.snapshotName, {
    pendingReclaim: true,
    pendingReclaimReason: outcome.reason,
  });
  return false;
}

/**
 * Returned by {@link withExclusiveSnapshotRecord} when the name is busy or the
 * row in hand is no longer the row on disk. Distinct from `false` (the task ran
 * and declined) so a caller can never mistake "did not act" for "acted and
 * failed".
 */
const SNAPSHOT_RECORD_SUPERSEDED = Symbol("snapshot-record-superseded");

/**
 * Two records describe the same payload only if its stable capture fields still
 * match. A restore updates only `last_accessed_at`, so it is not an identity
 * field. `manifest.timestamp` is included because every capture stamps it
 * freshly, unlike `createdAt`, which `insertSnapshot` preserves on conflict.
 */
function isSameSnapshotRecord(a: DeviceSnapshotRecord, b: DeviceSnapshotRecord): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.deviceName === b.deviceName &&
    a.snapshotType === b.snapshotType &&
    a.createdAt === b.createdAt &&
    a.sizeBytes === b.sizeBytes &&
    a.manifest.timestamp === b.manifest.timestamp
  );
}

/**
 * Run a destructive `task` against `record` only while this process is the sole
 * actor on that snapshot name AND the row is still the one that was selected.
 *
 * Reclaim ran outside the per-name lifecycle lock, so an eviction pass could
 * select the old row for `foo`, wait while a concurrent capture of `foo` saved
 * its replacement, and then issue the emulator console delete against — and drop
 * the row describing — the payload that capture had just reported as a success
 * (#6490 review).
 *
 * A restore is the same hazard from the other side: it holds the name lock while
 * awaiting the emulator, so the payload being loaded cannot be console-deleted
 * mid-load (#6490 review).
 *
 * The name lock is TRIED, never awaited, so this stays non-blocking while the
 * archive budget lock is held and no ordering between the two can deadlock.
 * `Map.has` and the `Map.set` inside `withSnapshotNameLock` both run
 * synchronously in the same job, so a capture or restore that starts afterwards
 * queues behind this task instead of overlapping it.
 */
async function withExclusiveSnapshotRecord<T>(
  record: DeviceSnapshotRecord,
  task: () => Promise<T>,
): Promise<T | typeof SNAPSHOT_RECORD_SUPERSEDED> {
  if (snapshotNameLocks.has(record.snapshotName)) {
    logger.debug(
      `[DeviceSnapshot] Skipping reclaim of '${record.snapshotName}': a capture or restore of ` +
        "that name is in flight",
    );
    return SNAPSHOT_RECORD_SUPERSEDED;
  }
  return withSnapshotNameLock(record.snapshotName, async () => {
    const { snapshotRepository } = await getDeviceSnapshotDependencies();
    const current = await snapshotRepository.getSnapshot(record.snapshotName);
    if (!current || !isSameSnapshotRecord(current, record)) {
      logger.debug(
        `[DeviceSnapshot] Skipping reclaim of '${record.snapshotName}': the record was replaced ` +
          "after it was selected",
      );
      return SNAPSHOT_RECORD_SUPERSEDED;
    }
    return task();
  });
}

async function deleteDeviceSnapshotRecord(
  record: DeviceSnapshotRecord,
  vmSnapshotTimeoutMs: number,
): Promise<boolean> {
  const outcome = await withExclusiveSnapshotRecord(record, async () => {
    if (
      isVmSnapshotRecord(record) &&
      !(await reclaimVmSnapshotPayload(record, vmSnapshotTimeoutMs))
    ) {
      // Row kept and flagged; leave its archive data alone so the record stays a
      // faithful reference to the in-AVD snapshot that is still there.
      return false;
    }
    return removeSnapshotArchiveAndRow(record);
  });
  return outcome === true;
}

/**
 * Drop a snapshot's archive-store data and its row. Split from
 * {@link deleteDeviceSnapshotRecord} so a caller that has ALREADY reclaimed the
 * in-AVD payload (the pending-reclaim sweep) does not issue a second console
 * delete for the same snapshot (#6490).
 */
async function removeSnapshotArchiveAndRow(record: DeviceSnapshotRecord): Promise<boolean> {
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

/**
 * Re-measure every `vm` row whose size is unknown, at the location that holds
 * its bytes, and persist what it finds.
 *
 * An upgraded archive is full of such rows: the pre-change capture path sized a
 * `vm` record by measuring the archive directory, which holds none of its bytes,
 * so the migration flags them unsized rather than trusting that number. Nothing
 * re-imports a row that already exists, so without this pass those payloads
 * would stay outside the budget for the life of the archive (#6891 review).
 *
 * A payload that STILL cannot be located stays unknown — a fabricated 0 is
 * exactly the lie this whole change exists to stop. A failed write leaves the
 * record unsized for this pass too, so the value the eviction loop compares
 * against is always the value on disk (CLAUDE.md strategy 2).
 */
async function remeasureUnsizedVmSnapshots(
  records: DeviceSnapshotRecord[],
): Promise<DeviceSnapshotRecord[]> {
  const { snapshotRepository, avdSnapshots } = await getDeviceSnapshotDependencies();
  const measured: DeviceSnapshotRecord[] = [];

  for (const record of records) {
    if (record.sizeBytes !== null || !isVmSnapshotRecord(record)) {
      measured.push(record);
      continue;
    }

    const remeasured = await withSnapshotNameLock(record.snapshotName, async () => {
      const sizeBytes = await avdSnapshots.measureVmSnapshotBytes(
        record.deviceName,
        record.snapshotName,
      );
      const current = await snapshotRepository.getSnapshot(record.snapshotName);
      if (!current || !isSameSnapshotRecord(current, record)) {
        logger.warn(
          `[DeviceSnapshot] Concurrent replacement detected while re-measuring VM snapshot ` +
            `'${record.snapshotName}'; skipping stale size update.`,
        );
        return undefined;
      }

      if (sizeBytes === null) {
        return current;
      }

      try {
        await snapshotRepository.updateSnapshot(record.snapshotName, { sizeBytes });
        return { ...current, sizeBytes };
      } catch (error) {
        logger.warn(
          `[DeviceSnapshot] Failed to record the re-measured size of VM snapshot ` +
            `'${record.snapshotName}': ${errorMessage(error)}`,
          error,
        );
        return current;
      }
    });
    if (remeasured) {
      measured.push(remeasured);
    }
  }

  return measured;
}

async function enforceAppDataArchiveLimit(
  maxArchiveSizeMb: number,
): Promise<SnapshotArchiveEvictionResult> {
  // The entire pass — list read, running total, and delete loop — runs under one
  // constant-keyed lock so concurrent passes queue instead of interleaving. A
  // later pass therefore re-reads a fresh, accurate list AFTER the prior pass
  // finished deleting, and only ever credits/reports rows it actually removed
  // (issue #6491).
  return withArchiveBudgetLock(async () => {
    const maxSizeBytes = Math.max(0, Math.floor(maxArchiveSizeMb * 1024 * 1024));
    const { snapshotRepository } = await getDeviceSnapshotDependencies();
    const { vmSnapshotTimeoutMs } = await getDeviceSnapshotConfig();
    // VM payloads live in the AVD and have their own per-AVD retention pass.
    // All remaining snapshot types live in the archive store and retain the
    // historical shared byte budget unchanged.
    const snapshots = (
      await snapshotRepository.listSnapshots({ orderByLastAccessed: "asc" })
    ).filter((snapshot) => snapshot.snapshotType !== "vm");

    // An unmeasured row contributes nothing to the budget (guessing a number
    // would evict against a fiction) but is counted and reported, so "the
    // archive looks small" can never again quietly mean "we never measured it"
    // (#6490).
    let currentSizeBytes = snapshots.reduce((sum, snapshot) => sum + (snapshot.sizeBytes ?? 0), 0);
    const unsizedCount = snapshots.filter((snapshot) => snapshot.sizeBytes === null).length;

    if (unsizedCount > 0) {
      logger.warn(
        `[DeviceSnapshot] ${unsizedCount} snapshot record(s) have an unknown size and are ` +
          "excluded from the non-VM archive budget",
      );
    }

    if (maxSizeBytes === 0 || currentSizeBytes <= maxSizeBytes) {
      return {
        evictedSnapshotNames: [],
        currentSizeBytes,
        maxSizeBytes,
        unsizedCount,
      };
    }

    const evictedSnapshotNames: string[] = [];

    for (const snapshot of snapshots) {
      if (currentSizeBytes <= maxSizeBytes) {
        break;
      }

      try {
        const deleted = await deleteDeviceSnapshotRecord(snapshot, vmSnapshotTimeoutMs);
        if (deleted) {
          evictedSnapshotNames.push(snapshot.snapshotName);
          currentSizeBytes -= snapshot.sizeBytes ?? 0;
        }
      } catch (error) {
        logger.warn(`[DeviceSnapshot] Failed to evict snapshot ${snapshot.snapshotName}: ${error}`);
      }
    }

    if (currentSizeBytes > maxSizeBytes) {
      logger.warn(
        `[DeviceSnapshot] Non-VM archive size ${currentSizeBytes} bytes still exceeds limit ` +
          `${maxSizeBytes} bytes after eviction`,
      );
    }

    if (evictedSnapshotNames.length > 0) {
      logger.warn(
        `[DeviceSnapshot] Evicted ${evictedSnapshotNames.length} snapshot(s) under the app_data ` +
          `byte budget (maxArchiveSizeMb=${maxArchiveSizeMb}): ${evictedSnapshotNames.join(", ")}`,
      );
      await notifySnapshotResources();
    }

    return {
      evictedSnapshotNames,
      currentSizeBytes,
      maxSizeBytes,
      unsizedCount,
    };
  });
}

function vmRetentionMaxSizeBytes(config: DeviceSnapshotConfig): number {
  if (config.maxVmArchiveSizeMb === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(config.maxVmArchiveSizeMb * 1024 * 1024));
}

function vmRetentionCurrentSizeBytes(state: VmRetentionState): number {
  return state.snapshots.reduce((sum, record) => sum + (record.sizeBytes ?? 0), 0);
}

function cannotFitVmRetentionExcluded(
  record: DeviceSnapshotRecord | undefined,
  config: DeviceSnapshotConfig,
  maxSizeBytes: number,
): boolean {
  return (
    record !== undefined &&
    config.maxVmArchiveSizeMb !== undefined &&
    (record.sizeBytes ?? 0) > maxSizeBytes
  );
}

function findVmRetentionCandidate(
  state: VmRetentionState,
  protectedSnapshotNames: ReadonlySet<string>,
): DeviceSnapshotRecord | undefined {
  return state.snapshots.find(
    (record) =>
      !protectedSnapshotNames.has(record.snapshotName) &&
      !state.failedNames.has(record.snapshotName),
  );
}

async function evictOldestVmRetentionCandidate(
  state: VmRetentionState,
  config: DeviceSnapshotConfig,
  protectedSnapshotNames: ReadonlySet<string>,
  reason: "count" | "byte",
): Promise<VmRetentionEvictionOutcome> {
  const candidate = findVmRetentionCandidate(state, protectedSnapshotNames);
  if (!candidate) {
    return "no-candidate";
  }

  try {
    if (!(await deleteDeviceSnapshotRecord(candidate, config.vmSnapshotTimeoutMs))) {
      // A VM row is deliberately retained and marked pending when its emulator
      // is offline. Continuing would mark newer records pending too, even
      // though retention needs only this oldest reclaim to be scheduled.
      const { snapshotRepository } = await getDeviceSnapshotDependencies();
      const current = await snapshotRepository.getSnapshot(candidate.snapshotName);
      if (current?.pendingReclaim) {
        return "deferred";
      }
      // A pending-reclaim sweep can remove this row, or a same-name capture on
      // another AVD can replace it, while this eviction attempt is non-exclusive
      // (#6960); do not count a stale candidate twice.
      if (!current || current.deviceName !== candidate.deviceName) {
        state.snapshots = state.snapshots.filter(
          (record) => record.snapshotName !== candidate.snapshotName,
        );
        return "removed-concurrently";
      }
      // A busy lifecycle lock or superseded row also produces `false`, but
      // neither is a deferred emulator reclaim. Keep searching for another
      // eligible candidate as the pre-existing retention contract requires.
      state.failedNames.add(candidate.snapshotName);
      return "failed";
    }
    state.snapshots = state.snapshots.filter(
      (record) => record.snapshotName !== candidate.snapshotName,
    );
    state.evictedSnapshotNames.push(candidate.snapshotName);
    (reason === "count" ? state.countEvictedSnapshotNames : state.byteEvictedSnapshotNames).push(
      candidate.snapshotName,
    );
    return "evicted";
  } catch (error) {
    // A single reclaim failure must not abort retention for other records.
    logger.warn(`[DeviceSnapshot] Failed to evict snapshot ${candidate.snapshotName}: ${error}`);
    state.failedNames.add(candidate.snapshotName);
    return "failed";
  }
}

async function createVmRetentionState(deviceName: string): Promise<VmRetentionState> {
  const { snapshotRepository } = await getDeviceSnapshotDependencies();
  const snapshots = await remeasureUnsizedVmSnapshots(
    (await snapshotRepository.listSnapshots({ snapshotType: "vm" })).filter(
      (record) => record.deviceName === deviceName && !record.pendingReclaim,
    ),
  );
  snapshots.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
  return {
    snapshots,
    evictedSnapshotNames: [],
    countEvictedSnapshotNames: [],
    byteEvictedSnapshotNames: [],
    failedNames: new Set(),
  };
}

async function applyVmRetention(
  state: VmRetentionState,
  config: DeviceSnapshotConfig,
  protectedSnapshotNames: ReadonlySet<string>,
  maxSizeBytes: number,
): Promise<void> {
  while (state.snapshots.length > config.maxVmSnapshotsPerAvd) {
    const outcome = await evictOldestVmRetentionCandidate(
      state,
      config,
      protectedSnapshotNames,
      "count",
    );
    if (outcome === "deferred" || outcome === "no-candidate") {
      return;
    }
  }
  while (vmRetentionCurrentSizeBytes(state) > maxSizeBytes) {
    const outcome = await evictOldestVmRetentionCandidate(
      state,
      config,
      protectedSnapshotNames,
      "byte",
    );
    if (outcome === "deferred" || outcome === "no-candidate") {
      return;
    }
  }
}

function reportVmRetentionEvictions(
  state: VmRetentionState,
  deviceName: string,
  config: DeviceSnapshotConfig,
): void {
  if (state.evictedSnapshotNames.length === 0) {
    return;
  }
  logger.warn(
    `[DeviceSnapshot] Evicted ${state.evictedSnapshotNames.length} VM snapshot(s) for AVD ` +
      `'${deviceName}': ${state.countEvictedSnapshotNames.length} by the per-AVD count retention ` +
      `(maxVmSnapshotsPerAvd=${config.maxVmSnapshotsPerAvd}), ` +
      `${state.byteEvictedSnapshotNames.length} by the VM byte budget ` +
      `(maxVmArchiveSizeMb=${config.maxVmArchiveSizeMb ?? "unlimited"}): ` +
      state.evictedSnapshotNames.join(", "),
  );
}

async function scheduleVmRetentionRetry(
  deviceName: string,
  config: DeviceSnapshotConfig,
  state: VmRetentionState,
  currentSizeBytes: number,
  maxSizeBytes: number,
  excludeFromEviction: string | undefined,
): Promise<void> {
  const remainsOverLimit =
    state.snapshots.length > config.maxVmSnapshotsPerAvd ||
    (config.maxVmArchiveSizeMb !== undefined && currentSizeBytes > maxSizeBytes);
  if (state.failedNames.size === 0 || !remainsOverLimit) {
    vmRetentionRetryAttempts.delete(deviceName);
    return;
  }

  const { timer, vmRetentionRetryBackoff } = await getDeviceSnapshotDependencies();
  const attempt = (vmRetentionRetryAttempts.get(deviceName) ?? 0) + 1;
  vmRetentionRetryAttempts.set(deviceName, attempt);
  timer.setTimeout(() => {
    void getDeviceSnapshotConfig()
      .then((freshConfig) =>
        enforceVmSnapshotRetentionForDevice(deviceName, freshConfig, { excludeFromEviction }),
      )
      .catch((error) => {
        // This is a best-effort retry; its failure cannot affect the completed operation.
        logger.warn(
          `[DeviceSnapshot] Deferred VM retention retry for AVD '${deviceName}' failed: ` +
            errorMessage(error),
          error,
        );
      });
  }, vmRetentionRetryBackoff.delayForAttempt(attempt));
}

async function enforceVmSnapshotRetentionForDevice(
  deviceName: string,
  config: DeviceSnapshotConfig,
  options: { excludeFromEviction?: string } = {},
): Promise<VmSnapshotRetentionResult> {
  return withVmRetentionLock(deviceName, async () => {
    const state = await createVmRetentionState(deviceName);
    const protectedSnapshotNames = getVmRetentionProtectedSnapshotNames(
      deviceName,
      options.excludeFromEviction,
    );
    const maxSizeBytes = vmRetentionMaxSizeBytes(config);
    const unsizedCount = state.snapshots.filter((record) => record.sizeBytes === null).length;
    if (unsizedCount > 0) {
      logger.warn(
        `[DeviceSnapshot] ${unsizedCount} VM snapshot record(s) have an unknown size and are ` +
          "excluded from the VM retention byte budget",
      );
    }

    const excludedBeforeEviction = options.excludeFromEviction
      ? state.snapshots.find((record) => record.snapshotName === options.excludeFromEviction)
      : undefined;
    const cannotFitExcluded = cannotFitVmRetentionExcluded(
      excludedBeforeEviction,
      config,
      maxSizeBytes,
    );

    // A protected capture that cannot fit by itself cannot make the budget
    // compliant. Do not evict unrelated older snapshots before its caller
    // reports (and handles) that rejection.
    if (!cannotFitExcluded) {
      await applyVmRetention(state, config, protectedSnapshotNames, maxSizeBytes);
    }

    const excluded = options.excludeFromEviction
      ? state.snapshots.find((record) => record.snapshotName === options.excludeFromEviction)
      : undefined;
    const excludedSnapshotMissing =
      options.excludeFromEviction !== undefined && excluded === undefined;
    const currentSizeBytes = vmRetentionCurrentSizeBytes(state);

    if (config.maxVmArchiveSizeMb !== undefined && currentSizeBytes > maxSizeBytes) {
      logger.warn(
        `[DeviceSnapshot] VM snapshots for AVD '${deviceName}' total ${currentSizeBytes} bytes still ` +
          `exceed limit ${maxSizeBytes} bytes after retention`,
      );
    }
    reportVmRetentionEvictions(state, deviceName, config);
    if (state.evictedSnapshotNames.length > 0) {
      await notifySnapshotResources();
    }
    await scheduleVmRetentionRetry(
      deviceName,
      config,
      state,
      currentSizeBytes,
      maxSizeBytes,
      options.excludeFromEviction,
    );

    return {
      evictedSnapshotNames: state.evictedSnapshotNames,
      currentSizeBytes,
      maxSizeBytes,
      unsizedCount,
      cannotFitExcluded,
      excludedSnapshotMissing,
      excludedSnapshotRecord: excluded ?? null,
      excludedSnapshotSizeBytes: excluded?.sizeBytes ?? null,
      countEvictedSnapshotNames: state.countEvictedSnapshotNames,
      byteEvictedSnapshotNames: state.byteEvictedSnapshotNames,
    };
  });
}

async function enforceVmSnapshotRetentionForAllDevices(
  config: DeviceSnapshotConfig,
): Promise<SnapshotArchiveEvictionResult> {
  const { snapshotRepository } = await getDeviceSnapshotDependencies();
  const records = await snapshotRepository.listSnapshots({ snapshotType: "vm" });
  const deviceNames = [...new Set(records.map((record) => record.deviceName))];
  const results = await Promise.all(
    deviceNames.map((deviceName) => enforceVmSnapshotRetentionForDevice(deviceName, config)),
  );
  return {
    evictedSnapshotNames: results.flatMap((result) => result.evictedSnapshotNames),
    currentSizeBytes: results.reduce((sum, result) => sum + result.currentSizeBytes, 0),
    maxSizeBytes:
      config.maxVmArchiveSizeMb === undefined ? 0 : config.maxVmArchiveSizeMb * 1024 * 1024,
    unsizedCount: results.reduce((sum, result) => sum + result.unsizedCount, 0),
  };
}

/**
 * Finish any VM-snapshot reclaim that was stranded by an offline emulator, for
 * the AVD `device` is running. Best-effort and deliberately cheap: it only fires
 * for a live Android emulator, reads just the flagged rows for that AVD, and
 * never enumerates devices of its own (the caller already holds a live one).
 *
 * A row reaches this state only after eviction decided to drop it, so completing
 * the console delete also completes the eviction: the record goes away with the
 * bytes (#6490).
 */
export async function sweepPendingVmSnapshotReclaims(device: BootedDevice): Promise<string[]> {
  if (device.platform !== "android" || !device.deviceId.startsWith("emulator-") || !device.name) {
    return [];
  }

  const { snapshotRepository, avdSnapshots } = await getDeviceSnapshotDependencies();

  let pending: DeviceSnapshotRecord[];
  try {
    pending = await snapshotRepository.listSnapshots({ pendingReclaim: true, snapshotType: "vm" });
  } catch (error) {
    // Best-effort background cleanup must never fail the operation that hosted
    // it; the next capture retries (CLAUDE.md strategy 2).
    logger.warn(`[DeviceSnapshot] Failed to read pending VM snapshot reclaims: ${error}`, error);
    return [];
  }

  const reclaimed: string[] = [];
  const { vmSnapshotTimeoutMs } = await getDeviceSnapshotConfig();

  for (const record of pending.filter((candidate) => candidate.deviceName === device.name)) {
    // Same per-name exclusivity as eviction: this sweep runs BEFORE the caller
    // takes its own name lock, so it can try (never await) the lock here.
    const swept = await withExclusiveSnapshotRecord(record, async () => {
      const outcome = await avdSnapshots.deleteVmSnapshot(
        device.deviceId,
        record.snapshotName,
        vmSnapshotTimeoutMs,
      );
      if (!outcome.reclaimed) {
        logger.warn(
          `[DeviceSnapshot] Pending reclaim of VM snapshot '${record.snapshotName}' still ` +
            `incomplete: ${outcome.reason}`,
        );
        return false;
      }

      // The in-AVD payload is gone, so finish the eviction the offline emulator
      // interrupted: archive data and row both go. No second console delete.
      return removeSnapshotArchiveAndRow(record);
    });
    if (swept === true) {
      reclaimed.push(record.snapshotName);
    }
  }

  if (reclaimed.length > 0) {
    logger.info(
      `[DeviceSnapshot] Completed ${reclaimed.length} pending VM snapshot reclaim(s) for ` +
        `AVD '${device.name}'`,
    );
    await notifySnapshotResources();
  }

  return reclaimed;
}

/**
 * Reclaim the in-AVD payload of a pending-reclaim row that a capture of the same
 * name on a DIFFERENT AVD is about to overwrite.
 *
 * `snapshot_name` is globally unique in the archive, but an in-AVD payload is
 * identified by (AVD, name). So capturing `foo` on AVD B overwrites the row
 * holding AVD A's pending reclaim for `foo` — the only reference to those bytes
 * — and clears its flag. The pre-capture sweep cannot help: it deliberately
 * looks only at the AVD the capturing device is running (#6490 review).
 *
 * A's emulator may well be live now even though it was not when eviction gave
 * up, so try the console delete first. If it still cannot be reclaimed, say so
 * loudly: the bytes stay on disk, and from here on the orphan report — keyed on
 * (AVD, name) — is the only thing that can surface them.
 */
async function reclaimSupersededPendingVmSnapshot(
  snapshotName: string,
  capturingAvdName: string | undefined,
  vmSnapshotTimeoutMs: number,
): Promise<void> {
  const { snapshotRepository, avdSnapshots } = await getDeviceSnapshotDependencies();
  const existing = await snapshotRepository.getSnapshot(snapshotName);
  if (
    !existing?.pendingReclaim ||
    !isVmSnapshotRecord(existing) ||
    existing.deviceName === capturingAvdName
  ) {
    return;
  }

  const serial = await avdSnapshots.findLiveEmulatorSerial(existing.deviceName);
  const outcome = serial
    ? await avdSnapshots.deleteVmSnapshot(serial, snapshotName, vmSnapshotTimeoutMs)
    : {
        reclaimed: false,
        reason: `emulator for AVD '${existing.deviceName}' is not running`,
      };

  if (outcome.reclaimed) {
    logger.info(
      `[DeviceSnapshot] Reclaimed the pending in-AVD payload of '${snapshotName}' on AVD ` +
        `'${existing.deviceName}' before reusing that name on AVD '${capturingAvdName}'`,
    );
    return;
  }

  logger.warn(
    `[DeviceSnapshot] Capturing '${snapshotName}' on AVD '${capturingAvdName}' overwrites the ` +
      `only record of a pending reclaim for AVD '${existing.deviceName}' (${outcome.reason}). ` +
      "Its in-AVD payload stays on disk and is reported as an orphan until it is removed " +
      "manually (see docs/using/test-prep-tools.md).",
  );
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
  return withConfigUpdateLock(async () => {
    const { configRepository } = await getDeviceSnapshotDependencies();
    if (update === null) {
      await configRepository.clearConfig();
      const defaults = parseDeviceSnapshotConfig(serverConfig.getDeviceSnapshotDefaults());
      const [appDataEviction, vmEviction] = await Promise.all([
        enforceAppDataArchiveLimit(defaults.maxArchiveSizeMb),
        enforceVmSnapshotRetentionForAllDevices(defaults),
      ]);
      return {
        config: defaults,
        evictedSnapshotNames: [
          ...appDataEviction.evictedSnapshotNames,
          ...vmEviction.evictedSnapshotNames,
        ],
      };
    }

    const current = await getDeviceSnapshotConfig();
    const mergedInput = mergeConfigInput(configToInput(current), update);
    const nextConfig = parseDeviceSnapshotConfig(mergedInput);
    await configRepository.setConfig(nextConfig);

    const [appDataEviction, vmEviction] = await Promise.all([
      enforceAppDataArchiveLimit(nextConfig.maxArchiveSizeMb),
      enforceVmSnapshotRetentionForAllDevices(nextConfig),
    ]);
    return {
      config: nextConfig,
      evictedSnapshotNames: [
        ...appDataEviction.evictedSnapshotNames,
        ...vmEviction.evictedSnapshotNames,
      ],
    };
  });
}

async function enforceCapturedSnapshotRetention(
  result: CaptureSnapshotResult,
  device: BootedDevice,
  config: DeviceSnapshotConfig,
  overwroteExistingSnapshot: boolean,
): Promise<string[]> {
  const appDataEviction = await enforceAppDataArchiveLimit(config.maxArchiveSizeMb);
  if (result.manifest.snapshotType !== "vm") {
    return appDataEviction.evictedSnapshotNames;
  }

  const vmEviction = await enforceVmSnapshotRetentionForDevice(device.name, config, {
    excludeFromEviction: result.snapshotName,
  });
  if (vmEviction.excludedSnapshotMissing) {
    throw new ActionableError(
      `Snapshot '${result.snapshotName}' was removed by a concurrent VM retention sweep before ` +
        "capture could complete; capture did not succeed",
    );
  }
  if (!vmEviction.cannotFitExcluded) {
    return [...appDataEviction.evictedSnapshotNames, ...vmEviction.evictedSnapshotNames];
  }

  if (overwroteExistingSnapshot) {
    await notifySnapshotResources();
    throw new ActionableError(
      `Snapshot '${result.snapshotName}' recapture exceeds the configured maxVmArchiveSizeMb ` +
        `budget for AVD '${device.name}'. The emulator's destructive snapshot save already ` +
        "irreversibly overwrote the prior payload under this name, so the new oversized capture " +
        "was kept rather than deleting the only remaining usable snapshot.",
    );
  }

  const record = vmEviction.excludedSnapshotRecord;
  if (record) {
    const deleted = await deleteDeviceSnapshotRecord(record, config.vmSnapshotTimeoutMs);
    if (!deleted) {
      // The emulator-console deletion did not complete, so its payload and row
      // deliberately remain linked for a later reclaim rather than lying that
      // this rejected capture was rolled back.
      await notifySnapshotResources();
      throw new ActionableError(
        `Snapshot '${result.snapshotName}' exceeds maxVmArchiveSizeMb but its VM payload could ` +
          "not be reclaimed; it remains tracked for a later reclaim",
      );
    }
  }
  const maxSizeBytes = Math.floor((config.maxVmArchiveSizeMb ?? 0) * 1024 * 1024);
  throw new ActionableError(
    `Snapshot '${result.snapshotName}' could not be captured because its VM payload ` +
      `(${vmEviction.excludedSnapshotSizeBytes ?? "unknown"} bytes) exceeds the configured ` +
      `maxVmArchiveSizeMb budget for AVD '${device.name}' (${maxSizeBytes} bytes)`,
  );
}

export async function captureDeviceSnapshot(
  device: BootedDevice,
  args: DeviceSnapshotCaptureArgs,
): Promise<{
  result: CaptureSnapshotResult;
  evictedSnapshotNames: string[];
}> {
  const { snapshotRepository, snapshotStore, avdSnapshots, timer, now, createCaptureProvider } =
    await getDeviceSnapshotDependencies();

  const baseConfig = await getDeviceSnapshotConfig();
  const useVmSnapshot = args.useVmSnapshot ?? baseConfig.useVmSnapshot;

  const snapshotName = args.snapshotName ?? snapshotStore.generateSnapshotName(device.name);
  // Reject a traversal/absolute name before any filesystem operation or capture
  // command can act on it (issue #5705).
  assertSafeSnapshotName(snapshotName);
  // Reject reserved scope-root names (#5707). An existing same-name snapshot is
  // deliberately allowed through — it is overwritten atomically below (#5713).
  assertSnapshotNameWritable(snapshotName);
  if (isAndroidEmulatorVmCapture(device, useVmSnapshot)) {
    assertVmSnapshotNameWritable(snapshotName);
  }

  // Cheapest possible hook for finishing reclaims that an offline emulator
  // blocked: this device is live and we already know its AVD, so the sweep is
  // one filtered row read plus one console delete per stranded snapshot (#6490).
  await sweepPendingVmSnapshotReclaims(device);
  const pathOptions = getSnapshotPathOptions({
    platform: device.platform,
    deviceId: device.deviceId,
    // For an Android emulator, BootedDevice.name is the AVD name resolved via
    // `adb emu avd name` during discovery.
    avdName: device.name,
  });

  const mergedConfig: DeviceSnapshotConfig = {
    ...baseConfig,
    includeAppData: args.includeAppData ?? baseConfig.includeAppData,
    includeSettings: args.includeSettings ?? baseConfig.includeSettings,
    useVmSnapshot,
    strictBackupMode: args.strictBackupMode ?? baseConfig.strictBackupMode,
    vmSnapshotTimeoutMs: args.vmSnapshotTimeoutMs ?? baseConfig.vmSnapshotTimeoutMs,
  };

  // Serialize same-name captures so concurrent requests can't race; overwrite
  // the on-disk data atomically (clean replace, prior data restored on failure);
  // the repository upsert replaces the record rather than duplicating it (#5713).
  return withVmRetentionSnapshotProtection(
    device,
    snapshotName,
    mergedConfig.useVmSnapshot,
    async () => {
      let overwroteExistingSnapshot = false;
      const result = await withSnapshotNameLock(snapshotName, async () => {
        // Read while holding the same-name lifecycle lock so this records whether
        // this capture is replacing this AVD's existing row before its upsert destroys it.
        const previousRecord = await snapshotRepository.getSnapshot(snapshotName);
        overwroteExistingSnapshot =
          previousRecord !== null && previousRecord.deviceName === device.name;
        // Held under the name lock, before anything writes: the upsert below is
        // what destroys another AVD's pending-reclaim reference (#6490 review).
        await reclaimSupersededPendingVmSnapshot(
          snapshotName,
          device.name,
          mergedConfig.vmSnapshotTimeoutMs,
        );
        const captureProvider = createCaptureProvider(device, timer, snapshotStore);

        let captureResult: CaptureSnapshotResult;
        let vmSnapshotWasCaptured = false;
        try {
          captureResult = await snapshotStore.replaceSnapshotData(
            snapshotName,
            pathOptions,
            async () => {
              const captured = await captureProvider.capture({
                snapshotName,
                includeAppData: mergedConfig.includeAppData,
                includeSettings: mergedConfig.includeSettings,
                useVmSnapshot: mergedConfig.useVmSnapshot,
                strictBackupMode: mergedConfig.strictBackupMode,
                vmSnapshotTimeoutMs: mergedConfig.vmSnapshotTimeoutMs,
                appBundleIds: args.appBundleIds,
              });
              vmSnapshotWasCaptured = captured.manifest.snapshotType === "vm";

              const sizeBytes = await resolveSnapshotSizeBytes(
                snapshotName,
                captured.manifest,
                snapshotStore,
                avdSnapshots,
                pathOptions,
              );
              const timestamp = captured.manifest.timestamp;

              await snapshotRepository.insertSnapshot({
                snapshotName: captured.snapshotName,
                deviceId: captured.manifest.deviceId,
                deviceName: captured.manifest.deviceName,
                platform: captured.manifest.platform,
                snapshotType: captured.manifest.snapshotType,
                includeAppData: captured.manifest.includeAppData,
                includeSettings: captured.manifest.includeSettings,
                createdAt: timestamp,
                lastAccessedAt: timestamp,
                sizeBytes,
                manifest: captured.manifest,
              });

              return captured;
            },
          );
        } catch (error) {
          if (
            device.platform === "android" &&
            device.deviceId.startsWith("emulator-") &&
            (wasVmSnapshotSaveDispatched(error) || vmSnapshotWasCaptured)
          ) {
            const recordedPendingReclaim = await recordFailedVmSnapshotReclaim(
              device,
              snapshotName,
              mergedConfig.includeSettings,
              snapshotRepository,
              avdSnapshots,
              mergedConfig.vmSnapshotTimeoutMs,
              now,
              error,
            );
            if (recordedPendingReclaim) {
              await notifySnapshotResources();
            }
          }
          throw error;
        }

        return captureResult;
      });

      // Both passes run after the name lock: budget/reclaim uses a try-lock on
      // individual records, while the VM pass explicitly protects this capture.
      const currentConfig = await getDeviceSnapshotConfig();
      const retentionConfig: DeviceSnapshotConfig = {
        ...mergedConfig,
        maxVmSnapshotsPerAvd: currentConfig.maxVmSnapshotsPerAvd,
        maxArchiveSizeMb: currentConfig.maxArchiveSizeMb,
        maxVmArchiveSizeMb: currentConfig.maxVmArchiveSizeMb,
      };
      const evictedSnapshotNames = await enforceCapturedSnapshotRetention(
        result,
        device,
        retentionConfig,
        overwroteExistingSnapshot,
      );
      await notifySnapshotResources();

      return {
        result,
        evictedSnapshotNames,
      };
    },
  );
}

export async function restoreDeviceSnapshot(
  device: BootedDevice,
  args: DeviceSnapshotRestoreArgs,
): Promise<{
  result: RestoreSnapshotResult;
  manifest: DeviceSnapshotManifest;
}> {
  const {
    snapshotRepository,
    snapshotStore,
    timer,
    now,
    createRestoreProvider,
    deviceIncarnationInvalidator,
  } = await getDeviceSnapshotDependencies();

  // Reject a traversal/absolute name before any snapshot lookup or legacy
  // manifest read resolves a path from it (issue #5705).
  assertSafeSnapshotName(args.snapshotName);

  // Lookup, restore, and touch run under the per-name lifecycle lock. A VM
  // restore awaits the emulator for as long as loading a multi-gigabyte snapshot
  // takes, and reclaim is destructive: without this, a concurrent config update
  // or another capture's budget pass could console-delete the very in-AVD
  // payload being loaded and drop the row describing it, while the restore still
  // reported success (#6490 review). Eviction only TRIES this lock, so a pass
  // that arrives mid-restore skips the row rather than blocking on it.
  return withSnapshotNameLock(args.snapshotName, async () => {
    let record = await snapshotRepository.getSnapshot(args.snapshotName);
    if (!record) {
      record = await hydrateLegacySnapshot(
        args.snapshotName,
        snapshotStore,
        snapshotRepository,
        now,
      );
    }
    if (!record) {
      throw new ActionableError(`Snapshot '${args.snapshotName}' not found`);
    }
    if (record.pendingReclaim) {
      const reason = record.pendingReclaimReason ? `: ${record.pendingReclaimReason}` : "";
      throw new ActionableError(
        `Snapshot '${record.snapshotName}' is awaiting reclaim after a failed capture${reason}`,
      );
    }

    const baseConfig = await getDeviceSnapshotConfig();
    const useVmSnapshot = args.useVmSnapshot ?? baseConfig.useVmSnapshot;
    const vmSnapshotTimeoutMs = args.vmSnapshotTimeoutMs ?? baseConfig.vmSnapshotTimeoutMs;

    const restoreProvider = createRestoreProvider(device, timer, snapshotStore);
    let prepared = false;
    let invalidated = false;
    let loaded = false;
    const prepareOnce = async (): Promise<void> => {
      if (
        prepared ||
        device.platform !== "android" ||
        !device.deviceId.startsWith("emulator-") ||
        record.manifest.snapshotType !== "vm" ||
        !useVmSnapshot
      ) {
        return;
      }
      prepared = true;
      await deviceIncarnationInvalidator.prepareForIncarnationChange(device);
    };
    const invalidateOnce = async (): Promise<void> => {
      if (
        invalidated ||
        device.platform !== "android" ||
        !device.deviceId.startsWith("emulator-") ||
        record.manifest.snapshotType !== "vm" ||
        !useVmSnapshot
      ) {
        return;
      }
      invalidated = true;
      await deviceIncarnationInvalidator.invalidate(device);
    };
    const invalidateAfterLoad = async (): Promise<void> => {
      loaded = true;
      await invalidateOnce();
    };

    let result: RestoreSnapshotResult;
    try {
      result = await restoreProvider.restore({
        snapshotName: record.snapshotName,
        manifest: record.manifest,
        useVmSnapshot,
        vmSnapshotTimeoutMs,
        onBeforeVmSnapshotLoad: prepareOnce,
        onVmSnapshotLoaded: invalidateAfterLoad,
      });
    } catch (error) {
      const definitivePreLoadFailure =
        error instanceof Error &&
        (error as { isDefinitiveVmSnapshotLoadFailure?: boolean })
          .isDefinitiveVmSnapshotLoadFailure === true;
      if (loaded || !definitivePreLoadFailure) {
        await invalidateOnce();
      }
      throw toActionableError(error, `Failed to restore snapshot '${record.snapshotName}'`);
    }
    await invalidateOnce();

    const timestamp = now().toISOString();
    await snapshotRepository.touchSnapshot(record.snapshotName, timestamp);
    await notifySnapshotResources();

    return { result, manifest: record.manifest };
  });
}

/**
 * Identity of an in-AVD snapshot payload: `<avd>.avd/snapshots/<name>`. A bare
 * snapshot name is NOT that identity — two AVDs can each hold a `foo` directory,
 * and an iOS or archive-type record named `foo` owns bytes somewhere else
 * entirely. Keying the accounted set on the name alone let any one of those hide
 * a genuine orphan and all of its bytes (#6490 review).
 */
function avdSnapshotKey(avdName: string, snapshotName: string): string {
  return `${avdName}\u0000${snapshotName}`;
}

/**
 * Enumerate `<avd>.avd/snapshots/*` for every AVD on this host and report the
 * directories no record accounts for.
 *
 * Only an Android `vm` record accounts for an in-AVD directory, and only for its
 * OWN AVD — `deviceName` on such a record is the AVD name.
 *
 * Report only — an orphan may predate AutoMobile, or be a user-made snapshot
 * someone relies on, so nothing here deletes. The field found nine such
 * directories holding 17.3 GB with no way to even see them (#6490); removing one
 * is a deliberate manual step (see docs/using/test-prep-tools.md).
 */
async function summarizeOrphanedAvdSnapshots(
  records: DeviceSnapshotRecord[],
): Promise<OrphanedAvdSnapshotSummary> {
  const { avdSnapshots } = await getDeviceSnapshotDependencies();
  const accounted = new Set(
    records
      .filter(isVmSnapshotRecord)
      .map((record) => avdSnapshotKey(record.deviceName, record.snapshotName)),
  );

  const entries: OrphanedAvdSnapshot[] = [];
  try {
    for (const avdName of await avdSnapshots.listKnownAvdNames()) {
      const directories = await avdSnapshots.listAvdSnapshotDirectories(avdName);
      entries.push(
        ...directories
          // default_boot is the emulator's own quick-boot state, not a stranded
          // AutoMobile capture — never report it as an orphan.
          .filter(
            (entry) =>
              entry.snapshotName.toLowerCase() !== AVD_DEFAULT_BOOT_SNAPSHOT.toLowerCase() &&
              !accounted.has(avdSnapshotKey(avdName, entry.snapshotName)),
          )
          .map((entry) => ({ avdName, ...entry })),
      );
    }
  } catch (error) {
    // Orphan reporting is diagnostic garnish on the archive listing; a failure
    // to scan must not fail the listing itself (CLAUDE.md strategy 2).
    logger.warn(`[DeviceSnapshot] Failed to scan for orphaned in-AVD snapshots: ${error}`, error);
  }

  return {
    count: entries.length,
    totalSizeBytes: entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    unsizedCount: entries.filter((entry) => entry.sizeBytes === null).length,
    entries,
  };
}

export async function listDeviceSnapshots(): Promise<{
  snapshots: Array<Record<string, unknown>>;
  count: number;
  totalSizeBytes: number;
  unsizedCount: number;
  pendingReclaimCount: number;
  orphanedAvdSnapshots: OrphanedAvdSnapshotSummary;
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
  const totalSizeBytes = records.reduce((sum, snapshot) => sum + (snapshot.sizeBytes ?? 0), 0);
  const orphanedAvdSnapshots = await summarizeOrphanedAvdSnapshots(records);

  return {
    snapshots,
    count: snapshots.length,
    totalSizeBytes,
    unsizedCount: records.filter((record) => record.sizeBytes === null).length,
    pendingReclaimCount: records.filter((record) => record.pendingReclaim).length,
    orphanedAvdSnapshots,
  };
}
