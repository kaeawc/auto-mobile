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
  private existing = new Set<string>();
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

  setSnapshotSize(snapshotName: string, sizeBytes: number | null): void {
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

  generateSnapshotName(_deviceName?: string): string {
    if (this.generatedNames.length > 0) {
      return this.generatedNames.shift() as string;
    }
    this.nameCounter += 1;
    return `snapshot-${this.nameCounter}`;
  }

  async snapshotDirectoryExists(snapshotName: string): Promise<boolean> {
    return this.existing.has(snapshotName);
  }

  async getSnapshotSizeBytes(snapshotName: string): Promise<number | null> {
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
    // The fresh capture replaces any prior on-disk data for this name. On
    // failure the prior "exists" flag is left intact (the real store restores
    // the set-aside copy), mirroring the atomic-overwrite contract.
    const priorExists = this.existing.has(snapshotName);
    this.existing.delete(snapshotName);
    try {
      const result = await capture();
      this.existing.add(snapshotName);
      this.activePaths.set(snapshotName, this.getSnapshotPathWithOptions(snapshotName, options));
      return result;
    } catch (error) {
      if (priorExists) {
        this.existing.add(snapshotName);
      }
      throw error;
    }
  }

  async deleteSnapshotData(snapshotName: string, options?: SnapshotPathOptions): Promise<void> {
    this.deleteCalls.push({ snapshotName, options });
    this.deleted.add(snapshotName);
    const activePath = this.activePaths.get(snapshotName);
    if (activePath && activePath !== this.getSnapshotPathWithOptions(snapshotName, options)) {
      return;
    }
    this.activePaths.delete(snapshotName);
    this.existing.delete(snapshotName);
    this.sizes.delete(snapshotName);
  }
}
