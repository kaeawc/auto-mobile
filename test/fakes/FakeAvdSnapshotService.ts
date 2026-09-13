import * as path from "path";
import { AVD_SNAPSHOTS_DIRNAME } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import type {
  AvdSnapshotDirectoryEntry,
  AvdSnapshotOperations,
  VmSnapshotReclaimOutcome,
} from "../../src/utils/android-cmdline-tools/AvdSnapshotService";

/**
 * Where this fake pretends the AVD home is. Built with `path.join` so the
 * expectations it feeds tests match production on Windows too (#6490 review).
 */
export const FAKE_AVD_HOME = path.join("/home", "tester", ".android", "avd");

/** `<avd>.avd/snapshots/<name>` under {@link FAKE_AVD_HOME}. */
export function fakeAvdSnapshotPath(avdName: string, snapshotName: string): string {
  return path.join(FAKE_AVD_HOME, `${avdName}.avd`, AVD_SNAPSHOTS_DIRNAME, snapshotName);
}

export interface FakeVmDeleteCall {
  deviceId: string;
  snapshotName: string;
  timeoutMs: number;
}

/**
 * In-memory stand-in for the emulator-side half of VM snapshot accounting:
 * the in-AVD `snapshots/<name>` directories and the emulator-console delete.
 * Nothing here touches the filesystem or adb.
 */
export class FakeAvdSnapshotService implements AvdSnapshotOperations {
  /** avdName -> snapshotName -> size in bytes (null = present but unmeasurable). */
  private readonly avdSnapshots = new Map<string, Map<string, number | null>>();
  private readonly liveSerials = new Map<string, string>();
  private readonly deleteCalls: FakeVmDeleteCall[] = [];
  private deleteFailureReason: string | null = null;

  setVmSnapshot(avdName: string, snapshotName: string, sizeBytes: number | null): void {
    const byName = this.avdSnapshots.get(avdName) ?? new Map<string, number | null>();
    byName.set(snapshotName, sizeBytes);
    this.avdSnapshots.set(avdName, byName);
  }

  setLiveEmulator(avdName: string, deviceId: string | null): void {
    if (deviceId === null) {
      this.liveSerials.delete(avdName);
      return;
    }
    this.liveSerials.set(avdName, deviceId);
  }

  failNextDeletesWith(reason: string | null): void {
    this.deleteFailureReason = reason;
  }

  getDeleteCalls(): FakeVmDeleteCall[] {
    return [...this.deleteCalls];
  }

  hasVmSnapshot(avdName: string, snapshotName: string): boolean {
    return this.avdSnapshots.get(avdName)?.has(snapshotName) ?? false;
  }

  async measureVmSnapshotBytes(avdName: string, snapshotName: string): Promise<number | null> {
    const byName = this.avdSnapshots.get(avdName);
    if (!byName || !byName.has(snapshotName)) {
      return null;
    }
    return byName.get(snapshotName) ?? null;
  }

  async listAvdSnapshotDirectories(avdName: string): Promise<AvdSnapshotDirectoryEntry[]> {
    const byName = this.avdSnapshots.get(avdName);
    if (!byName) {
      return [];
    }
    return Array.from(byName.entries()).map(([snapshotName, sizeBytes]) => ({
      snapshotName,
      directoryPath: fakeAvdSnapshotPath(avdName, snapshotName),
      sizeBytes,
    }));
  }

  async listKnownAvdNames(): Promise<string[]> {
    return Array.from(this.avdSnapshots.keys());
  }

  async findLiveEmulatorSerial(avdName: string): Promise<string | null> {
    return this.liveSerials.get(avdName) ?? null;
  }

  async deleteVmSnapshot(
    deviceId: string,
    snapshotName: string,
    timeoutMs: number,
  ): Promise<VmSnapshotReclaimOutcome> {
    this.deleteCalls.push({ deviceId, snapshotName, timeoutMs });
    if (this.deleteFailureReason) {
      return { reclaimed: false, reason: this.deleteFailureReason };
    }
    // The emulator console only ever reaches the AVD behind this serial, so the
    // fake must too: deleting every same-named directory across AVDs would hide
    // exactly the cross-AVD confusion these tests exist to catch.
    const avdName = Array.from(this.liveSerials.entries()).find(
      ([, serial]) => serial === deviceId,
    )?.[0];
    if (avdName !== undefined) {
      this.avdSnapshots.get(avdName)?.delete(snapshotName);
    }
    return { reclaimed: true };
  }
}
