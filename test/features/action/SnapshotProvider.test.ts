import { describe, it, expect, beforeEach } from "bun:test";
import { FakeSnapshotProvider } from "../../fakes/FakeSnapshotProvider";
import { CaptureSnapshot } from "../../../src/features/action/CaptureSnapshot";
import { CaptureSnapshotIos } from "../../../src/features/action/CaptureSnapshotIos";
import { RestoreSnapshot } from "../../../src/features/action/RestoreSnapshot";
import { RestoreSnapshotIos } from "../../../src/features/action/RestoreSnapshotIos";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DeviceSnapshotStore } from "../../../src/utils/DeviceSnapshotStore";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, DeviceSnapshotManifest } from "../../../src/models";
import type {
  SnapshotCaptureProvider,
  SnapshotProvider,
  SnapshotRestoreProvider,
} from "../../../src/utils/interfaces/SnapshotProvider";

/**
 * Sanity-check the platform-agnostic SnapshotProvider contract.
 *
 * Mirrors the structure of ProxyManager.test.ts: tests deliberately
 * type their subjects as the abstract interface so a regression that
 * drops one of the shared methods from a concrete class will surface
 * as a compile error here before tests even run.
 */
describe("SnapshotProvider interface", () => {
  describe("FakeSnapshotProvider", () => {
    let provider: FakeSnapshotProvider;

    beforeEach(() => {
      provider = new FakeSnapshotProvider();
    });

    it("returns a CaptureSnapshotResult from capture()", async () => {
      const result = await provider.capture({ snapshotName: "snap-1" });
      expect(result.snapshotName).toBe("snap-1");
      expect(typeof result.timestamp).toBe("string");
      expect(result.snapshotType).toBe("adb");
      expect(result.manifest.snapshotName).toBe("snap-1");
    });

    it("returns a RestoreSnapshotResult from restore()", async () => {
      const manifest = makeManifest("snap-2");
      const result = await provider.restore({ snapshotName: "snap-2", manifest });
      expect(result.snapshotType).toBe(manifest.snapshotType);
      expect(typeof result.restoredAt).toBe("string");
    });

    it("records capture and restore invocations", async () => {
      await provider.capture({ snapshotName: "alpha" });
      await provider.restore({ snapshotName: "beta", manifest: makeManifest("beta") });
      await provider.capture({ snapshotName: "gamma" });

      expect(provider.wasMethodCalled("capture")).toBe(true);
      expect(provider.wasMethodCalled("restore")).toBe(true);
      expect(provider.getCallCount("capture")).toBe(2);
      expect(provider.getCallCount("restore")).toBe(1);
      expect(provider.getExecutedOperations()).toContain("capture:alpha");
      expect(provider.getExecutedOperations()).toContain("restore:beta");
    });

    it("propagates configured capture failure", async () => {
      provider.setCaptureShouldFail(true);
      await expect(provider.capture({ snapshotName: "boom" })).rejects.toThrow(
        "Fake capture failure"
      );
    });

    it("propagates configured restore failure", async () => {
      provider.setRestoreShouldFail(true);
      const manifest = makeManifest("boom");
      await expect(
        provider.restore({ snapshotName: "boom", manifest })
      ).rejects.toThrow("Fake restore failure");
    });

    it("clears recorded history on demand", async () => {
      await provider.capture({ snapshotName: "x" });
      provider.clearHistory();
      expect(provider.getExecutedOperations()).toEqual([]);
    });
  });

  // Both platform-specific capture classes implement SnapshotCaptureProvider;
  // both restore classes implement SnapshotRestoreProvider. Assigning them to
  // the abstract type proves it at compile time. Behavioral assertions are
  // covered in the existing CaptureSnapshot{,Ios}/RestoreSnapshot{,Ios} tests.
  describe("Android CaptureSnapshot satisfies SnapshotCaptureProvider", () => {
    it("exposes the shared capture method via the abstract type", () => {
      const device: BootedDevice = {
        deviceId: "emulator-5554",
        name: "Pixel_5",
        platform: "android",
      };
      const factory: AdbClientFactory = { create: () => new FakeAdbClient() as any };
      const asProvider: SnapshotCaptureProvider = new CaptureSnapshot(
        device,
        factory,
        undefined,
        new FakeTimer(),
        new DeviceSnapshotStore("/tmp/no-op")
      );
      expect(typeof asProvider.capture).toBe("function");
    });
  });

  describe("iOS CaptureSnapshotIos satisfies SnapshotCaptureProvider", () => {
    it("exposes the shared capture method via the abstract type", () => {
      const device: BootedDevice = {
        deviceId: "ios-device-1",
        name: "iPhone 15",
        platform: "ios",
      };
      const asProvider: SnapshotCaptureProvider = new CaptureSnapshotIos(
        device,
        new FakeSimCtlClient(),
        new DeviceSnapshotStore("/tmp/no-op")
      );
      expect(typeof asProvider.capture).toBe("function");
    });
  });

  describe("Android RestoreSnapshot satisfies SnapshotRestoreProvider", () => {
    it("exposes the shared restore method via the abstract type", () => {
      const device: BootedDevice = {
        deviceId: "emulator-5554",
        name: "Pixel_5",
        platform: "android",
      };
      const factory: AdbClientFactory = { create: () => new FakeAdbClient() as any };
      const asProvider: SnapshotRestoreProvider = new RestoreSnapshot(
        device,
        factory,
        undefined,
        new FakeTimer(),
        new DeviceSnapshotStore("/tmp/no-op")
      );
      expect(typeof asProvider.restore).toBe("function");
    });
  });

  describe("iOS RestoreSnapshotIos satisfies SnapshotRestoreProvider", () => {
    it("exposes the shared restore method via the abstract type", () => {
      const device: BootedDevice = {
        deviceId: "ios-device-1",
        name: "iPhone 15",
        platform: "ios",
      };
      const asProvider: SnapshotRestoreProvider = new RestoreSnapshotIos(
        device,
        new FakeSimCtlClient(),
        new DeviceSnapshotStore("/tmp/no-op")
      );
      expect(typeof asProvider.restore).toBe("function");
    });
  });

  it("FakeSnapshotProvider satisfies the combined SnapshotProvider type", () => {
    const asProvider: SnapshotProvider = new FakeSnapshotProvider();
    expect(typeof asProvider.capture).toBe("function");
    expect(typeof asProvider.restore).toBe("function");
  });
});

function makeManifest(snapshotName: string): DeviceSnapshotManifest {
  return {
    snapshotName,
    timestamp: "1970-01-01T00:00:00.000Z",
    deviceId: "fake-device",
    deviceName: "Fake Device",
    platform: "android",
    snapshotType: "adb",
    includeAppData: false,
    includeSettings: false,
  };
}
