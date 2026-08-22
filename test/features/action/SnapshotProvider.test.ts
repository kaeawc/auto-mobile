import { describe, it, expect, beforeEach } from "bun:test";
import { FakeSnapshotProvider } from "../../fakes/FakeSnapshotProvider";
import { CaptureSnapshot } from "../../../src/features/action/CaptureSnapshot";
import { RestoreSnapshot } from "../../../src/features/action/RestoreSnapshot";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DeviceSnapshotStore } from "../../../src/utils/DeviceSnapshotStore";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, DeviceSnapshotManifest } from "../../../src/models";
import type {
  SnapshotCaptureProvider,
  SnapshotRestoreProvider,
} from "../../../src/utils/interfaces/SnapshotProvider";

/**
 * Sanity-check the platform-agnostic SnapshotCaptureProvider /
 * SnapshotRestoreProvider contracts. Tests deliberately type their
 * subjects as the abstract interfaces so a regression that drops one of
 * the shared methods will surface as a compile error here.
 */
describe("SnapshotProvider interfaces", () => {
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

  // Compile-time conformance: each platform-specific concrete class is
  // assigned to the abstract provider type. Behavioral coverage lives in
  // the existing CaptureSnapshot{,Ios}/RestoreSnapshot{,Ios} test files.
  const androidDevice: BootedDevice = { deviceId: "emulator-5554", name: "Pixel_5", platform: "android" };
  const iosDevice: BootedDevice = { deviceId: "ios-device-1", name: "iPhone 15", platform: "ios" };
  const fakeAdbFactory: AdbClientFactory = { create: () => new FakeAdbClient() as any };
  const store = () => new DeviceSnapshotStore("/tmp/no-op");

  const captureCases: ReadonlyArray<[string, () => SnapshotCaptureProvider]> = [
    ["Android CaptureSnapshot", () => new CaptureSnapshot(androidDevice, fakeAdbFactory, undefined, new FakeTimer(), store())],
    ["iOS CaptureSnapshot", () => new CaptureSnapshot(iosDevice, undefined, undefined, new FakeTimer(), store(), new FakeSimCtlClient())],
  ];
  for (const [name, build] of captureCases) {
    it(`${name} satisfies SnapshotCaptureProvider`, () => {
      const asProvider: SnapshotCaptureProvider = build();
      expect(typeof asProvider.capture).toBe("function");
    });
  }

  const restoreCases: ReadonlyArray<[string, () => SnapshotRestoreProvider]> = [
    ["Android RestoreSnapshot", () => new RestoreSnapshot(androidDevice, fakeAdbFactory, undefined, new FakeTimer(), store())],
    ["iOS RestoreSnapshot", () => new RestoreSnapshot(iosDevice, undefined, undefined, new FakeTimer(), store(), new FakeSimCtlClient())],
  ];
  for (const [name, build] of restoreCases) {
    it(`${name} satisfies SnapshotRestoreProvider`, () => {
      const asProvider: SnapshotRestoreProvider = build();
      expect(typeof asProvider.restore).toBe("function");
    });
  }
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
