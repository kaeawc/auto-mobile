import * as os from "os";
import * as path from "path";
import { DeviceSnapshotStore, type SnapshotPathOptions } from "../../src/utils/DeviceSnapshotStore";

type DeviceSnapshotStoreContract = Pick<
  DeviceSnapshotStore,
  | "getBasePath"
  | "getSnapshotPath"
  | "getSnapshotPathWithOptions"
  | "recoverSnapshotData"
  | "discardSnapshotArtifacts"
  | "listLeftoverSnapshotJournals"
  | "generateSnapshotName"
  | "snapshotDirectoryExists"
  | "getSnapshotSizeBytes"
  | "getDirectorySize"
  | "listSubdirectoryNames"
  | "deleteSnapshotData"
  | "replaceSnapshotData"
>;

export class FakeDeviceSnapshotStore implements DeviceSnapshotStoreContract {
  private basePath: string;
  private sizes = new Map<string, number | null>();
  /** Sizes scripted for one scope, keyed by the scoped path; they win over the name-keyed size. */
  private readonly scopedSizes = new Map<string, number | null>();
  /** Scripted by tests via {@link setSnapshotExists}: the name exists in every scope. */
  private existing = new Set<string>();
  /** Snapshots created by {@link replaceSnapshotData}, keyed by their scoped path. */
  private readonly existingPaths = new Set<string>();
  private deleted = new Set<string>();
  private generatedNames: string[] = [];
  private nameCounter = 0;
  private readonly activePaths = new Map<string, string>();
  readonly deleteCalls: Array<{ snapshotName: string; options?: SnapshotPathOptions }> = [];
  readonly recoveryCalls: Array<{ snapshotName: string; options?: SnapshotPathOptions }> = [];
  private readonly recoveryFailures: Error[] = [];

  readonly discardCalls: Array<{ snapshotName: string; options?: SnapshotPathOptions }> = [];
  private readonly discardLeftovers: string[][] = [];

  leftoverJournalEntries: Array<{ snapshotName: string; options?: SnapshotPathOptions }> = [];
  leftoverJournalsTruncated = false;
  readonly journalListCalls: Array<{ maxEntries: number; maxScopeDirectories: number }> = [];

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(os.tmpdir(), "auto-mobile-fake-snapshots");
  }

  getBasePath(): string {
    return this.basePath;
  }

  getSnapshotPath(snapshotName: string): string {
    return path.join(this.basePath, snapshotName);
  }

  getSnapshotPathWithOptions(snapshotName: string, options?: SnapshotPathOptions): string {
    return new DeviceSnapshotStore(this.basePath).getSnapshotPathWithOptions(snapshotName, options);
  }

  queueRecoveryFailure(error: Error): void {
    this.recoveryFailures.push(error);
  }

  async recoverSnapshotData(snapshotName: string, options?: SnapshotPathOptions): Promise<void> {
    this.recoveryCalls.push({ snapshotName, options });
    const failure = this.recoveryFailures.shift();
    if (failure) {
      throw failure;
    }
  }

  queueDiscardLeftovers(paths: string[]): void {
    this.discardLeftovers.push(paths);
  }

  async discardSnapshotArtifacts(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<string[]> {
    this.discardCalls.push({ snapshotName, options });
    return this.discardLeftovers.shift() ?? [];
  }

  async listLeftoverSnapshotJournals(limits: {
    maxEntries: number;
    maxScopeDirectories: number;
  }): Promise<{
    entries: Array<{ snapshotName: string; options?: SnapshotPathOptions }>;
    truncated: boolean;
  }> {
    this.journalListCalls.push({ ...limits });
    return {
      entries: this.leftoverJournalEntries.slice(0, limits.maxEntries),
      truncated:
        this.leftoverJournalsTruncated || this.leftoverJournalEntries.length > limits.maxEntries,
    };
  }

  /** Script a size for the name in every scope, or for one scope when `options` is given. */
  setSnapshotSize(
    snapshotName: string,
    sizeBytes: number | null,
    options?: SnapshotPathOptions,
  ): void {
    if (options) {
      this.scopedSizes.set(this.getSnapshotPathWithOptions(snapshotName, options), sizeBytes);
      return;
    }
    this.sizes.set(snapshotName, sizeBytes);
  }

  setSnapshotExists(snapshotName: string, exists: boolean): void {
    if (exists) {
      this.existing.add(snapshotName);
    } else {
      this.existing.delete(snapshotName);
    }
  }

  queueGeneratedName(snapshotName: string): void {
    this.generatedNames.push(snapshotName);
  }

  getDeletedSnapshots(): string[] {
    return Array.from(this.deleted);
  }

  generateSnapshotName(deviceName?: string): string {
    if (this.generatedNames.length > 0) {
      return this.generatedNames.shift() as string;
    }
    this.nameCounter += 1;
    // Like the real store, a device name is sanitized into a prefix of the generated name.
    const prefix = deviceName ? `${deviceName.replace(/[^a-zA-Z0-9-_]/g, "_")}_` : "";
    return `${prefix}snapshot-${this.nameCounter}`;
  }

  async snapshotDirectoryExists(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<boolean> {
    return (
      this.existing.has(snapshotName) ||
      this.existingPaths.has(this.getSnapshotPathWithOptions(snapshotName, options))
    );
  }

  /** Test helper: whether the name exists in any scope (scripted or captured). */
  hasSnapshotInAnyScope(snapshotName: string): boolean {
    return (
      this.existing.has(snapshotName) ||
      [...this.existingPaths].some((candidate) => path.basename(candidate) === snapshotName)
    );
  }

  async getSnapshotSizeBytes(
    snapshotName: string,
    options?: SnapshotPathOptions,
  ): Promise<number | null> {
    const scopedPath = this.getSnapshotPathWithOptions(snapshotName, options);
    if (this.scopedSizes.has(scopedPath)) {
      return this.scopedSizes.get(scopedPath)!;
    }
    return this.sizes.has(snapshotName) ? this.sizes.get(snapshotName)! : 0;
  }

  /**
   * Directory primitives (#6490). Unit tests never touch a real filesystem, so
   * an arbitrary path is "unknown" here — in-AVD payloads are modelled by
   * FakeAvdSnapshotService instead.
   */
  async getDirectorySize(_dirPath: string): Promise<number | null> {
    return null;
  }

  async listSubdirectoryNames(_dirPath: string): Promise<string[] | null> {
    return null;
  }

  async replaceSnapshotData<T>(
    snapshotName: string,
    options: SnapshotPathOptions | undefined,
    capture: () => Promise<T>,
  ): Promise<T> {
    // The fresh capture replaces any prior on-disk data for this name in this scope. On
    // failure the prior "exists" state is left intact (the real store restores the
    // set-aside copy), mirroring the atomic-overwrite contract.
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    const priorExists = this.existingPaths.has(snapshotPath);
    this.existingPaths.delete(snapshotPath);
    try {
      const result = await capture();
      this.existingPaths.add(snapshotPath);
      this.activePaths.set(snapshotName, snapshotPath);
      return result;
    } catch (error) {
      if (priorExists) {
        this.existingPaths.add(snapshotPath);
      }
      throw error;
    }
  }

  async deleteSnapshotData(snapshotName: string, options?: SnapshotPathOptions): Promise<void> {
    this.deleteCalls.push({ snapshotName, options });
    this.deleted.add(snapshotName);
    const snapshotPath = this.getSnapshotPathWithOptions(snapshotName, options);
    this.existingPaths.delete(snapshotPath);
    this.scopedSizes.delete(snapshotPath);
    const activePath = this.activePaths.get(snapshotName);
    if (activePath && activePath !== snapshotPath) {
      return;
    }
    this.activePaths.delete(snapshotName);
    this.existing.delete(snapshotName);
    this.sizes.delete(snapshotName);
  }
}
