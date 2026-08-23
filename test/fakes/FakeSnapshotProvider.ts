import type {
  SnapshotCaptureProvider,
  SnapshotRestoreProvider,
} from "../../src/utils/interfaces/SnapshotProvider";
import type {
  CaptureSnapshotArgs,
  CaptureSnapshotResult,
} from "../../src/features/action/CaptureSnapshot";
import type {
  RestoreSnapshotArgs,
  RestoreSnapshotResult,
} from "../../src/features/action/RestoreSnapshot";
import type { DeviceSnapshotManifest } from "../../src/models";

/**
 * Minimal fake covering both halves of the snapshot contract. Records
 * invocations in `executedOperations` and lets tests toggle per-half
 * failure modes. Mirrors the recording pattern from `FakeProxyManager`.
 */
export class FakeSnapshotProvider implements SnapshotCaptureProvider, SnapshotRestoreProvider {
  private shouldCaptureFail: boolean = false;
  private shouldRestoreFail: boolean = false;
  private readonly executedOperations: string[] = [];

  setCaptureShouldFail(shouldFail: boolean): void {
    this.shouldCaptureFail = shouldFail;
  }

  setRestoreShouldFail(shouldFail: boolean): void {
    this.shouldRestoreFail = shouldFail;
  }

  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some((op) => op.includes(operationName));
  }

  getCallCount(operationName: string): number {
    return this.executedOperations.filter((op) => op.includes(operationName)).length;
  }

  clearHistory(): void {
    this.executedOperations.length = 0;
  }

  async capture(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult> {
    this.executedOperations.push(`capture:${args.snapshotName}`);

    if (this.shouldCaptureFail) {
      throw new Error("Fake capture failure");
    }

    const timestamp = "1970-01-01T00:00:00.000Z";
    const manifest: DeviceSnapshotManifest = {
      snapshotName: args.snapshotName,
      timestamp,
      deviceId: "fake-device",
      deviceName: "Fake Device",
      platform: "android",
      snapshotType: "adb",
      includeAppData: args.includeAppData ?? false,
      includeSettings: args.includeSettings ?? false,
    };

    return {
      snapshotName: args.snapshotName,
      timestamp,
      snapshotType: manifest.snapshotType,
      manifest,
    };
  }

  async restore(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    this.executedOperations.push(`restore:${args.snapshotName}`);

    if (this.shouldRestoreFail) {
      throw new Error("Fake restore failure");
    }

    return {
      snapshotType: args.manifest.snapshotType,
      restoredAt: "1970-01-01T00:00:00.000Z",
    };
  }
}
