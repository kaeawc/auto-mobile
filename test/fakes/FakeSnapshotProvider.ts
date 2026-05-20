import type {
  SnapshotCaptureProvider,
  SnapshotProvider,
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
 * Minimal fake implementation of {@link SnapshotProvider} for testing
 * the platform-agnostic contract. Records every invocation in
 * `executedOperations` and lets tests toggle failure mode.
 *
 * Mirrors the recording pattern from `FakeProxyManager`.
 */
export class FakeSnapshotProvider implements SnapshotProvider {
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
    return this.executedOperations.some(op => op.includes(operationName));
  }

  getCallCount(operationName: string): number {
    return this.executedOperations.filter(op => op.includes(operationName)).length;
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

/**
 * Capture-only variant for cases where the test exercises only the
 * capture half of the interface.
 */
export class FakeSnapshotCaptureProvider implements SnapshotCaptureProvider {
  private readonly delegate = new FakeSnapshotProvider();

  setShouldFail(shouldFail: boolean): void {
    this.delegate.setCaptureShouldFail(shouldFail);
  }

  getExecutedOperations(): string[] {
    return this.delegate.getExecutedOperations();
  }

  capture(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult> {
    return this.delegate.capture(args);
  }
}

/**
 * Restore-only variant for cases where the test exercises only the
 * restore half of the interface.
 */
export class FakeSnapshotRestoreProvider implements SnapshotRestoreProvider {
  private readonly delegate = new FakeSnapshotProvider();

  setShouldFail(shouldFail: boolean): void {
    this.delegate.setRestoreShouldFail(shouldFail);
  }

  getExecutedOperations(): string[] {
    return this.delegate.getExecutedOperations();
  }

  restore(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    return this.delegate.restore(args);
  }
}
