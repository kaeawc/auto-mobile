import { promises as fs } from "fs";
import type { Dirent } from "fs";
import * as path from "path";
import { getTempDir, TEMP_SUBDIRS } from "./tempDir";
import { logger } from "./logger";
import { assertSafePathSegment } from "./snapshotNameValidation";
import { toActionableError, type Platform } from "../models";
import { sortedReaddir, sortedReaddirEntries } from "./io";

/**
 * Suffix of the sibling directory that {@link DeviceSnapshotStore.replaceSnapshotData}
 * moves an existing snapshot into while a fresh capture writes. Reserved: capture
 * rejects any snapshotName ending in it (see `assertSnapshotNameWritable`) and the
 * legacy-archive scan skips directories bearing it, so this internal set-aside path
 * can never collide with — or be re-imported as — a real user snapshot (issue #5713).
 */
export const SNAPSHOT_REPLACING_SUFFIX = ".replacing";
export const SNAPSHOT_IOS_SCOPE_ROOT = "ios";
export const SNAPSHOT_ANDROID_SCOPE_ROOT = "android";

export type ReservedSnapshotNameReason =
  | {
      kind: "scope-root";
      name: typeof SNAPSHOT_IOS_SCOPE_ROOT | typeof SNAPSHOT_ANDROID_SCOPE_ROOT;
    }
  | { kind: "suffix"; suffix: typeof SNAPSHOT_REPLACING_SUFFIX };

export function findReservedSnapshotNameReason(
  snapshotName: string,
): ReservedSnapshotNameReason | undefined {
  // Archives are portable: fold case on every host to prevent collisions on
  // case-insensitive macOS/Windows filesystems without probing the host filesystem.
  const normalizedName = snapshotName.toLowerCase();
  if (
    normalizedName === SNAPSHOT_IOS_SCOPE_ROOT ||
    normalizedName === SNAPSHOT_ANDROID_SCOPE_ROOT
  ) {
    return { kind: "scope-root", name: normalizedName };
  }
  if (normalizedName.endsWith(SNAPSHOT_REPLACING_SUFFIX)) {
    return { kind: "suffix", suffix: SNAPSHOT_REPLACING_SUFFIX };
  }
  return undefined;
}

export function isReservedSnapshotName(snapshotName: string): boolean {
  return findReservedSnapshotNameReason(snapshotName) !== undefined;
}

type SnapshotJournalState = "pending-existing" | "pending-new" | "committed";

interface SyncableFile {
  sync(): Promise<void>;
}

async function syncDirectoryOnDisk(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface SnapshotPathOptions {
  platform?: Platform;
  deviceId?: string;
  /**
   * Android AVD name. Android snapshots are keyed by AVD name — unique
   * (avdmanager enforces one AVD per name) and stable across reboots, unlike the
   * port-based emulator serial. Only set for emulator snapshots; physical
   * Android devices have no AVD name and fall back to the unscoped path (#5707).
   */
  avdName?: string;
}

export class DeviceSnapshotStore {
  private basePath: string;

  constructor(
    customBasePath?: string,
    private readonly syncDirectory: (dirPath: string) => Promise<void> = syncDirectoryOnDisk,
    private readonly syncFile: (file: SyncableFile) => Promise<void> = (file) => file.sync(),
  ) {
    this.basePath = customBasePath || getTempDir(TEMP_SUBDIRS.SNAPSHOTS);
  }

  getBasePath(): string {
    return this.basePath;
  }

  async ensureSnapshotsDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.basePath, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create snapshots directory: ${error}`);
      throw error;
    }
  }

  getSnapshotPath(snapshotName: string): string {
    return path.join(this.basePath, snapshotName);
  }

  getSnapshotPathWithOptions(snapshotName: string, options?: SnapshotPathOptions): string {
    if (options?.platform === "ios" && options.deviceId) {
      // deviceId is the simulator UDID, sourced from simctl rather than a
      // validated caller-supplied name. Reject it before it is joined onto
      // basePath — an unvalidated scope segment containing '..' or a
      // separator can otherwise resolve the scoped path outside the
      // snapshots directory entirely (issue #6493).
      assertSafePathSegment("iOS device id", options.deviceId);
      return path.join(this.basePath, SNAPSHOT_IOS_SCOPE_ROOT, options.deviceId, snapshotName);
    }

    // Android emulators scope by AVD name so the same snapshot name can be
    // reused across AVDs without a filesystem collision (#5707).
    if (options?.platform === "android" && options.avdName) {
      // avdName comes from `adb emu avd name` output (trimmed to its first
      // line), not from a validated caller-supplied name. Same containment
      // rule as above (issue #6493).
      assertSafePathSegment("Android AVD name", options.avdName);
      return path.join(this.basePath, SNAPSHOT_ANDROID_SCOPE_ROOT, options.avdName, snapshotName);
    }

    return this.getSnapshotPath(snapshotName);
  }

  getSettingsPath(snapshotName: string, options?: SnapshotPathOptions): string {
    return path.join(this.getSnapshotPathWithOptions(snapshotName, options), "settings.json");
  }

  getMetadataPath(snapshotName: string, options?: SnapshotPathOptions): string {
    return path.join(this.getSnapshotPathWithOptions(snapshotName, options), "metadata.json");
  }

  getAppDataPath(snapshotName: string, options?: SnapshotPathOptions): string {
    const folderName = options?.platform === "ios" ? "app-data" : "app_data";
    return path.join(this.getSnapshotPathWithOptions(snapshotName, options), folderName);
  }

  async snapshotDirectoryExists(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<boolean> {
    try {
      await fs.access(this.getSnapshotPathWithOptions(snapshotName, options));
      return true;
    } catch (error) {
      // fs.access throws when the snapshot directory doesn't exist yet, which is a
      // normal "no snapshot taken" state, not an error — report false.
      logger.debug(`src/utils/DeviceSnapshotStore.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  /**
   * Run `capture` as an atomic overwrite of `snapshotName`'s on-disk data.
   *
   * Any existing snapshot directory is moved aside first, so the capture writes
   * into a clean directory and no stale files from a prior capture survive
   * ("replace", not "merge"). On success the set-aside copy is discarded; on
   * failure the partial capture is removed and the prior data is restored — a
   * failed overwrite must never destroy the snapshot it was replacing. Callers
   * serialize same-name captures at a higher layer, so the fixed sibling
   * set-aside path (`<dir>.replacing`) only ever hosts one overwrite at a time
   * (issue #5713).
   */
  async replaceSnapshotData<T>(
    snapshotName: string,
    options: SnapshotPathOptions | undefined,
    capture: () => Promise<T>,
  ): Promise<T> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    const asidePath = `${snapshotPath}${SNAPSHOT_REPLACING_SUFFIX}`;
    const journalPath = this.getJournalPath(snapshotPath);

    await this.recoverSnapshotData(snapshotName, options);
    const hadExisting = await this.pathExists(snapshotPath);
    await this.writeJournal(journalPath, hadExisting ? "pending-existing" : "pending-new");
    if (hadExisting) {
      try {
        await fs.rename(snapshotPath, asidePath);
      } catch (error) {
        // A concurrently removed directory is equivalent to a first capture.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        await this.writeJournal(journalPath, "pending-new");
      }
      await this.syncParent(snapshotPath);
    }

    let result: T;
    try {
      result = await capture();
    } catch (error) {
      // Capture (and the record write it wraps) failed: discard the partial
      // fresh capture and restore the prior snapshot. A cleanup step failing
      // here must not mask the real capture error, so log-and-continue and
      // rethrow the original (CLAUDE.md catch convention).
      try {
        await this.recoverSnapshotData(snapshotName, options);
      } catch (rollbackError) {
        logger.warn(
          `Failed to roll back snapshot '${snapshotName}' after a failed overwrite; ` +
            `prior data may be stranded at '${asidePath}': ${rollbackError}`,
        );
      }
      throw error;
    }

    // Capture includes the record write. Persist the commit decision before
    // deleting the only previous copy; recovery must never revert this result.
    await this.writeJournal(journalPath, "committed");
    try {
      await this.recoverSnapshotData(snapshotName, options);
    } catch (cleanupError) {
      logger.warn(
        `Failed to clean committed snapshot journal '${journalPath}'; ` +
          `it will be cleaned up on the next capture: ${cleanupError}`,
      );
    }
    return result;
  }

  /** Recover one snapshot at startup or before its next capture. */
  async recoverSnapshotData(snapshotName: string, options?: SnapshotPathOptions): Promise<void> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    const asidePath = `${snapshotPath}${SNAPSHOT_REPLACING_SUFFIX}`;
    const journalPath = this.getJournalPath(snapshotPath);
    const tempPath = this.getTempJournalPath(journalPath);
    const parentPath = path.dirname(snapshotPath);
    await fs.mkdir(parentPath, { recursive: true });
    const entries = await sortedReaddir(parentPath);
    if (entries.includes(path.basename(tempPath))) {
      await fs.rm(tempPath);
    }
    const state = entries.includes(path.basename(journalPath))
      ? await fs.readFile(journalPath, "utf-8")
      : undefined;

    const asideExists = await this.pathExists(asidePath);
    if (state === undefined) {
      if (asideExists) {
        await this.recoverLegacyAside(snapshotPath, asidePath);
      }
      return;
    }
    if (state !== "pending-existing" && state !== "pending-new" && state !== "committed") {
      throw new Error(`Invalid snapshot journal at '${journalPath}': '${state}'`);
    }
    if (state === "committed") {
      await fs.rm(asidePath, { recursive: true, force: true });
    } else if (asideExists) {
      if (state !== "pending-existing") {
        throw new Error(`Unexpected set-aside snapshot for new capture at '${asidePath}'`);
      }
      await fs.rm(snapshotPath, { recursive: true, force: true });
      await fs.rename(asidePath, snapshotPath);
    } else if (state === "pending-new") {
      await fs.rm(snapshotPath, { recursive: true, force: true });
    }
    await this.syncParent(snapshotPath);
    await fs.rm(journalPath);
    await this.syncParent(snapshotPath);
  }

  /** Discard only overwrite artifacts; the caller owns deletion of the archive itself. */
  async discardSnapshotArtifacts(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<string[]> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    const journalPath = this.getJournalPath(snapshotPath);
    const failedPaths: string[] = [];
    for (const artifactPath of [
      `${snapshotPath}${SNAPSHOT_REPLACING_SUFFIX}`,
      journalPath,
      this.getTempJournalPath(journalPath),
    ]) {
      try {
        await fs.rm(artifactPath, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`Failed to discard snapshot artifact '${artifactPath}'`, error);
        failedPaths.push(artifactPath);
      }
    }
    return failedPaths;
  }

  /** Shallow host-archive scan. Never descend into snapshots or emulator-owned payloads. */
  async listLeftoverSnapshotJournals(limits: {
    maxEntries: number;
    maxScopeDirectories: number;
  }): Promise<{
    entries: Array<{ snapshotName: string; options?: SnapshotPathOptions }>;
    truncated: boolean;
  }> {
    const entries: Array<{ snapshotName: string; options?: SnapshotPathOptions }> = [];
    const baseEntries = await this.readJournalDirectory(this.getBasePath());
    if (this.collectJournalEntries(baseEntries, undefined, entries, limits.maxEntries)) {
      return { entries, truncated: true };
    }
    let scopeDirectories = 0;
    for (const platform of ["android", "ios"] as const) {
      // Dirent.isDirectory excludes symlink roots/scopes, keeping this scan inside the archive.
      if (!baseEntries.some((entry) => entry.name === platform && entry.isDirectory())) {
        continue;
      }
      const scopeRoot = path.join(this.getBasePath(), platform);
      const scopes = await this.readJournalDirectory(scopeRoot);
      for (const scope of scopes) {
        if (!scope.isDirectory() || !this.isSafeJournalSegment(scope.name)) {
          continue;
        }
        if (scopeDirectories >= limits.maxScopeDirectories) {
          return { entries, truncated: true };
        }
        scopeDirectories++;
        const options: SnapshotPathOptions =
          platform === "android"
            ? { platform, avdName: scope.name }
            : { platform, deviceId: scope.name };
        const scopeEntries = await this.readJournalDirectory(path.join(scopeRoot, scope.name));
        if (this.collectJournalEntries(scopeEntries, options, entries, limits.maxEntries)) {
          return { entries, truncated: true };
        }
      }
    }
    return { entries, truncated: false };
  }

  private async readJournalDirectory(directoryPath: string): Promise<Dirent[]> {
    try {
      const entries = await sortedReaddirEntries(directoryPath);
      return entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A missing archive or platform scope is normal; enumeration must not create it.
        logger.debug(`Snapshot journal directory '${directoryPath}' does not exist`, error);
        return [];
      }
      throw toActionableError(error, `Failed to enumerate snapshot journals in '${directoryPath}'`);
    }
  }

  private isSafeJournalSegment(segment: string): boolean {
    try {
      assertSafePathSegment("snapshot journal segment", segment);
      return true;
    } catch (error) {
      // Unsafe on-disk names are not recovery candidates; skipping prevents path escape.
      logger.debug(`Skipping unsafe snapshot journal segment '${segment}'`, error);
      return false;
    }
  }

  private collectJournalEntries(
    directoryEntries: Dirent[],
    options: SnapshotPathOptions | undefined,
    entries: Array<{ snapshotName: string; options?: SnapshotPathOptions }>,
    maxEntries: number,
  ): boolean {
    const names = new Set<string>();
    for (const entry of directoryEntries) {
      if (!entry.name.endsWith(SNAPSHOT_REPLACING_SUFFIX) || entry.isSymbolicLink()) {
        continue;
      }
      const suffix = entry.name.endsWith(".journal.tmp.replacing")
        ? ".journal.tmp.replacing"
        : entry.name.endsWith(".journal.replacing")
          ? ".journal.replacing"
          : SNAPSHOT_REPLACING_SUFFIX;
      const snapshotName = entry.name.slice(0, -suffix.length);
      if (!this.isSafeJournalSegment(snapshotName) || names.has(snapshotName)) {
        continue;
      }
      if (!options && ["android", "ios"].includes(snapshotName)) {
        continue;
      }
      names.add(snapshotName);
      if (entries.length >= maxEntries) {
        return true;
      }
      entries.push({ snapshotName, options });
      if (entries.length >= maxEntries) {
        return true;
      }
    }
    return false;
  }

  private async recoverLegacyAside(snapshotPath: string, asidePath: string): Promise<void> {
    if (await this.pathExists(snapshotPath)) {
      logger.warn(
        `Removing legacy set-aside snapshot '${asidePath}' because '${snapshotPath}' exists`,
      );
      await fs.rm(asidePath, { recursive: true, force: true });
    } else {
      logger.warn(`Restoring legacy set-aside snapshot '${asidePath}' to '${snapshotPath}'`);
      await fs.rename(asidePath, snapshotPath);
    }
    await this.syncParent(snapshotPath);
  }

  private getJournalPath(snapshotPath: string): string {
    // The reserved suffix prevents either sibling file from being a user snapshot.
    return `${snapshotPath}.journal${SNAPSHOT_REPLACING_SUFFIX}`;
  }

  private getTempJournalPath(journalPath: string): string {
    return `${journalPath.slice(0, -SNAPSHOT_REPLACING_SUFFIX.length)}.tmp${SNAPSHOT_REPLACING_SUFFIX}`;
  }

  private async writeJournal(journalPath: string, state: SnapshotJournalState): Promise<void> {
    const tempPath = this.getTempJournalPath(journalPath);
    const handle = await fs.open(tempPath, "wx");
    try {
      await handle.writeFile(state);
      await this.syncFile(handle);
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, journalPath);
    await this.syncParent(journalPath);
  }

  private async syncParent(filePath: string): Promise<void> {
    try {
      await this.syncDirectory(path.dirname(filePath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP") {
        // Directory sync is best-effort when the filesystem does not support it.
        logger.debug(`Skipping unsupported directory sync for '${filePath}': ${error}`);
        return;
      }
      throw error;
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    const entries = await sortedReaddir(path.dirname(filePath));
    return entries.includes(path.basename(filePath));
  }

  async deleteSnapshotData(snapshotName: string, options?: SnapshotPathOptions): Promise<void> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    try {
      await fs.rm(snapshotPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`Failed to delete snapshot data '${snapshotName}': ${error}`);
    }
  }

  generateSnapshotName(deviceName?: string): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").split(".")[0];

    if (deviceName) {
      const sanitized = deviceName.replace(/[^a-zA-Z0-9-_]/g, "_");
      return `${sanitized}_${timestamp}`;
    }

    return `snapshot_${timestamp}`;
  }

  async getSnapshotSizeBytes(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<number | null> {
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    let entries: Dirent[];
    try {
      entries = await sortedReaddirEntries(snapshotPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // A snapshot archive that was never captured is genuinely empty.
        logger.debug(`Snapshot archive ${snapshotPath} does not exist: ${error}`);
        return 0;
      }
      logger.warn(`Failed to read snapshot archive ${snapshotPath}: ${error}`, error);
      return null;
    }
    return this.getDirectorySizeFromEntries(snapshotPath, entries);
  }

  /**
   * Recursive on-disk size of `dirPath`, or null when the directory does not
   * exist or cannot be read. Public and path-taking so callers measuring
   * directories this store does not own — notably the emulator-owned
   * `<avd>.avd/snapshots/<name>` payload of a VM snapshot — go through the same
   * filesystem seam the archive does, and so "not found" stays distinguishable
   * from "zero bytes" (#6490).
   */
  async getDirectorySize(dirPath: string): Promise<number | null> {
    let entries: Dirent[];
    try {
      entries = await sortedReaddirEntries(dirPath);
    } catch (error) {
      // A missing/unreadable directory is "unknown size", not "0 bytes"; the
      // caller decides how to record that.
      logger.debug(`Failed to get directory size for ${dirPath}: ${error}`);
      return null;
    }

    return this.getDirectorySizeFromEntries(dirPath, entries);
  }

  private async getDirectorySizeFromEntries(
    dirPath: string,
    entries: Dirent[],
  ): Promise<number | null> {
    let size = 0;
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nestedSize = await this.getDirectorySize(fullPath);
        if (nestedSize === null) {
          return null;
        }
        size += nestedSize;
      } else {
        const fileSize = await this.getFileSize(fullPath);
        if (fileSize === null) {
          return null;
        }
        size += fileSize;
      }
    }
    return size;
  }

  /**
   * Immediate subdirectory names of `dirPath`, or null when the directory does
   * not exist or cannot be read. Same seam as {@link getDirectorySize}; used to
   * enumerate in-AVD snapshot directories for orphan reporting (#6490).
   */
  async listSubdirectoryNames(dirPath: string): Promise<string[] | null> {
    try {
      const entries = await sortedReaddirEntries(dirPath);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      // Same "unknown, not empty" distinction as getDirectorySize.
      logger.debug(`Failed to list subdirectories of ${dirPath}: ${error}`);
      return null;
    }
  }

  /**
   * Immediate FILE names of `dirPath`, or null when the directory does not exist
   * or cannot be read. Counterpart to {@link listSubdirectoryNames}: an AVD
   * relocated through `<name>.ini` is present in the AVD home only as a registry
   * file, so a subdirectory-only scan cannot see it at all (#6490 review).
   */
  async listFileNames(dirPath: string): Promise<string[] | null> {
    try {
      const entries = await sortedReaddirEntries(dirPath);
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      // Same "unknown, not empty" distinction as getDirectorySize.
      logger.debug(`Failed to list files of ${dirPath}: ${error}`);
      return null;
    }
  }

  private async getFileSize(filePath: string): Promise<number | null> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch (error) {
      // A file that vanished between readdir and stat (an emulator still
      // writing its snapshot, a concurrent delete) leaves the total unknown;
      // callers must not report a partial sum as the full payload size.
      logger.debug(`Failed to stat ${filePath} while measuring a directory: ${error}`);
      return null;
    }
  }
}
