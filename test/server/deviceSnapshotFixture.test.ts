import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceSnapshotManifest } from "../../src/models";
import type { FixtureIdentity } from "../../src/models/FixtureIdentity";
import { SnapshotFixtureRefusedError } from "../../src/models/SnapshotFixtureRefusedError";
import { DEFAULT_DEVICE_SNAPSHOT_CONFIG } from "../../src/models/DeviceSnapshotConfigDefaults";
import type { FixtureIdentityProbe } from "../../src/features/snapshot/fixtureIdentity";
import {
  captureDeviceSnapshot,
  deleteDeviceSnapshot,
  forgetFixturesOfDestroyedAvd,
  resetDeviceSnapshotManagerDependencies,
  restoreDeviceSnapshot,
  setDeviceSnapshotManagerDependencies,
} from "../../src/daemon/deviceSnapshotManager";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";

const EMULATOR: BootedDevice = { deviceId: "emulator-5554", name: "Pixel_8", platform: "android" };
const PHYSICAL: BootedDevice = { deviceId: "R58M123", name: "Galaxy", platform: "android" };

const IDENTITY: FixtureIdentity = {
  avdName: "Pixel_8",
  systemImageId: "system-images;android-35;google_apis;arm64-v8a:abc",
  avdConfigHash: "cfg",
  emulatorVersion: "Android emulator version 35.2.10.0",
  userdataGeneration: "42:1730000000000",
};

/** A probe whose answer the test changes, as the host would after a wipe or an image update. */
class FakeFixtureIdentityProbe implements FixtureIdentityProbe {
  identity: FixtureIdentity = { ...IDENTITY };
  failure: Error | null = null;
  reads: string[] = [];

  async currentIdentity(avdName: string): Promise<FixtureIdentity> {
    this.reads.push(avdName);
    if (this.failure) {
      throw this.failure;
    }
    return { ...this.identity, avdName };
  }
}

async function refusal(promise: Promise<unknown>): Promise<SnapshotFixtureRefusedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SnapshotFixtureRefusedError);
  return error as SnapshotFixtureRefusedError;
}

describe("deviceSnapshot fixtures (#14065)", () => {
  let timer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let probe: FakeFixtureIdentityProbe;
  let captures: string[];
  let restores: string[];
  let avd: FakeAvdSnapshotService;
  let configs: FakeDeviceSnapshotConfigRepository;

  beforeEach(async () => {
    timer = new FakeTimer();
    repository = new FakeDeviceSnapshotRepository();
    probe = new FakeFixtureIdentityProbe();
    captures = [];
    restores = [];
    avd = new FakeAvdSnapshotService();
    avd.setLiveEmulator("Pixel_8", EMULATOR.deviceId);
    configs = new FakeDeviceSnapshotConfigRepository();
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository,
      configRepository: configs,
      snapshotStore: new FakeDeviceSnapshotStore(),
      avdSnapshots: avd,
      timer,
      now: () => new Date(timer.now()),
      fixtureIdentityProbe: probe,
      deviceIncarnationInvalidator: {
        prepareForIncarnationChange: async () => {},
        invalidate: async () => {},
        settleIncarnationChange: async () => {},
      },
      createCaptureProvider: (device) => ({
        capture: async (args) => {
          captures.push(args.snapshotName);
          const vm = Boolean(args.useVmSnapshot) && device.deviceId.startsWith("emulator-");
          const manifest: DeviceSnapshotManifest = {
            snapshotName: args.snapshotName,
            timestamp: new Date(timer.now()).toISOString(),
            deviceId: device.deviceId,
            deviceName: device.name,
            platform: "android",
            snapshotType: vm ? "vm" : "adb",
            includeAppData: vm,
            includeSettings: true,
          };
          return {
            snapshotName: args.snapshotName,
            timestamp: manifest.timestamp,
            snapshotType: manifest.snapshotType,
            manifest,
          };
        },
      }),
      createRestoreProvider: () => ({
        restore: async (args) => {
          restores.push(args.snapshotName);
          return { snapshotType: args.manifest.snapshotType, restoredAt: "now", success: true };
        },
      }),
    });
  });

  afterEach(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  test("a fixture capture records the AVD's identity in the snapshot's manifest", async () => {
    const { result } = await captureDeviceSnapshot(EMULATOR, {
      snapshotName: "logged-in",
      useVmSnapshot: true,
      fixture: true,
    });

    // Read before the save, and again after it to confirm nothing changed meanwhile.
    expect(probe.reads).toEqual(["Pixel_8", "Pixel_8"]);
    expect(result.manifest.fixture).toEqual(IDENTITY);
    expect((await repository.getSnapshot("logged-in"))?.manifest.fixture).toEqual(IDENTITY);
  });

  test("a capture without fixture records no identity and reads nothing", async () => {
    const { result } = await captureDeviceSnapshot(EMULATOR, {
      snapshotName: "plain",
      useVmSnapshot: true,
    });

    expect(result.manifest.fixture).toBeUndefined();
    expect(probe.reads).toEqual([]);
  });

  test.each([
    ["an emulator with useVmSnapshot: false", EMULATOR, false],
    ["a physical device", PHYSICAL, true],
  ] as const)("a fixture capture on %s is refused before capturing", async (_, device, vm) => {
    const error = await refusal(
      captureDeviceSnapshot(device, { snapshotName: "f", useVmSnapshot: vm, fixture: true }),
    );

    expect(error.code).toBe("fixture_requires_vm_snapshot");
    expect(captures).toEqual([]);
    expect(await repository.getSnapshot("f")).toBeNull();
  });

  test("an unreadable identity refuses the capture before anything is saved", async () => {
    probe.failure = new Error("AVD 'Pixel_8' is not on this host");

    await expect(
      captureDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: true, fixture: true }),
    ).rejects.toThrow(/not on this host/);
    expect(captures).toEqual([]);
  });

  test("an identity that changes while the VM snapshot is saved refuses the capture, recording no row", async () => {
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: (device) => ({
        capture: async (args) => {
          captures.push(args.snapshotName);
          probe.identity = { ...IDENTITY, userdataGeneration: "77:1730000500000" };
          const manifest: DeviceSnapshotManifest = {
            snapshotName: args.snapshotName,
            timestamp: new Date(timer.now()).toISOString(),
            deviceId: device.deviceId,
            deviceName: device.name,
            platform: "android",
            snapshotType: "vm",
            includeAppData: true,
            includeSettings: true,
          };
          return {
            snapshotName: args.snapshotName,
            timestamp: manifest.timestamp,
            snapshotType: "vm",
            manifest,
          };
        },
      }),
    });

    const error = await refusal(
      captureDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: true, fixture: true }),
    );

    expect(error.code).toBe("fixture_invalidated");
    expect(error.reasons).toEqual(["userdata-wiped"]);
    expect((await repository.getSnapshot("f"))?.manifest.fixture).toBeUndefined();
  });

  test("an unchanged fixture reloads", async () => {
    await captureDeviceSnapshot(EMULATOR, {
      snapshotName: "f",
      useVmSnapshot: true,
      fixture: true,
    });

    await restoreDeviceSnapshot(EMULATOR, {
      snapshotName: "f",
      useVmSnapshot: true,
      fixture: true,
    });

    expect(restores).toEqual(["f"]);
  });

  test.each([undefined, true] as const)(
    "a fixture whose userdata was wiped is refused with its reason (fixture: %s)",
    async (fixtureFlag) => {
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "f",
        useVmSnapshot: true,
        fixture: true,
      });
      probe.identity = { ...IDENTITY, userdataGeneration: "77:1730000500000" };

      const error = await refusal(
        restoreDeviceSnapshot(EMULATOR, {
          snapshotName: "f",
          useVmSnapshot: true,
          fixture: fixtureFlag,
        }),
      );

      expect(error.code).toBe("fixture_invalidated");
      expect(error.reasons).toEqual(["userdata-wiped"]);
      expect(restores).toEqual([]);
    },
  );

  test("a settings-only restore of a changed fixture is refused too, applying nothing", async () => {
    await captureDeviceSnapshot(EMULATOR, {
      snapshotName: "f",
      useVmSnapshot: true,
      fixture: true,
    });
    probe.identity = { ...IDENTITY, avdConfigHash: "other" };

    const error = await refusal(
      restoreDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: false }),
    );

    expect(error.code).toBe("fixture_invalidated");
    expect(error.reasons).toEqual(["avd-config-changed"]);
    expect(restores).toEqual([]);
  });

  test("every changed input is reported", async () => {
    await captureDeviceSnapshot(EMULATOR, {
      snapshotName: "f",
      useVmSnapshot: true,
      fixture: true,
    });
    probe.identity = { ...IDENTITY, systemImageId: "other", emulatorVersion: "36.0.0" };

    const error = await refusal(
      restoreDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: true }),
    );

    expect(error.reasons).toEqual(["system-image-changed", "emulator-version-changed"]);
  });

  test("fixture: true on a snapshot captured without it is refused", async () => {
    await captureDeviceSnapshot(EMULATOR, { snapshotName: "plain", useVmSnapshot: true });

    const error = await refusal(
      restoreDeviceSnapshot(EMULATOR, {
        snapshotName: "plain",
        useVmSnapshot: true,
        fixture: true,
      }),
    );

    expect(error.code).toBe("snapshot_not_a_fixture");
    expect(restores).toEqual([]);
  });

  test("fixture: true with useVmSnapshot: false is refused instead of a settings-only restore", async () => {
    await captureDeviceSnapshot(EMULATOR, {
      snapshotName: "f",
      useVmSnapshot: true,
      fixture: true,
    });

    const error = await refusal(
      restoreDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: false, fixture: true }),
    );

    expect(error.code).toBe("fixture_requires_vm_snapshot");
    expect(restores).toEqual([]);
  });

  describe("cleanup policy (#14065)", () => {
    test("VM retention never evicts a fixture, and a fixture does not count toward it", async () => {
      await configs.setConfig({ ...DEFAULT_DEVICE_SNAPSHOT_CONFIG, maxVmSnapshotsPerAvd: 1 });
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "kept",
        useVmSnapshot: true,
        fixture: true,
      });
      timer.advanceTime(1000);
      await captureDeviceSnapshot(EMULATOR, { snapshotName: "plain-1", useVmSnapshot: true });
      timer.advanceTime(1000);
      const { evictedSnapshotNames } = await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "plain-2",
        useVmSnapshot: true,
      });

      expect(evictedSnapshotNames).toEqual(["plain-1"]);
      expect(await repository.getSnapshot("kept")).not.toBeNull();
    });

    test("an invalidated fixture is removed when its reload is refused", async () => {
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "f",
        useVmSnapshot: true,
        fixture: true,
      });
      probe.identity = { ...IDENTITY, userdataGeneration: "77:1730000500000" };

      const error = await refusal(
        restoreDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: true }),
      );

      expect(error.code).toBe("fixture_invalidated");
      expect(error.message).toContain("removed");
      expect(await repository.getSnapshot("f")).toBeNull();
      expect(avd.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["f"]);
    });

    test("a fixture refused for another reason is kept", async () => {
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "f",
        useVmSnapshot: true,
        fixture: true,
      });

      const error = await refusal(
        restoreDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: false, fixture: true }),
      );

      expect(error.code).toBe("fixture_requires_vm_snapshot");
      expect(await repository.getSnapshot("f")).not.toBeNull();
    });

    test("a fixture whose identity cannot be read is refused but kept", async () => {
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "f",
        useVmSnapshot: true,
        fixture: true,
      });
      probe.failure = new Error("Could not read the emulator version");

      await expect(
        restoreDeviceSnapshot(EMULATOR, { snapshotName: "f", useVmSnapshot: true }),
      ).rejects.toThrow("emulator version");
      expect(await repository.getSnapshot("f")).not.toBeNull();
    });

    test("an explicit delete removes a fixture and its in-AVD snapshot", async () => {
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "f",
        useVmSnapshot: true,
        fixture: true,
      });

      expect(await deleteDeviceSnapshot(EMULATOR, { snapshotName: "f" })).toEqual({
        snapshotName: "f",
        deleted: true,
      });
      expect(await repository.getSnapshot("f")).toBeNull();
      expect(avd.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["f"]);
    });

    test("destroying an AVD forgets its fixtures and keeps every other snapshot", async () => {
      await captureDeviceSnapshot(EMULATOR, {
        snapshotName: "f",
        useVmSnapshot: true,
        fixture: true,
      });
      await captureDeviceSnapshot(EMULATOR, { snapshotName: "plain", useVmSnapshot: true });
      const other = { ...EMULATOR, deviceId: "emulator-5556", name: "Pixel_9" };
      await captureDeviceSnapshot(other, { snapshotName: "g", useVmSnapshot: true, fixture: true });

      expect(await forgetFixturesOfDestroyedAvd("Pixel_8")).toEqual(["f"]);

      expect(await repository.getSnapshot("f")).toBeNull();
      expect(await repository.getSnapshot("plain")).not.toBeNull();
      expect(await repository.getSnapshot("g")).not.toBeNull();
      // The AVD and its in-AVD snapshots are gone already: nothing is asked of an emulator.
      expect(avd.getDeleteCalls()).toEqual([]);
    });

    test("deleting an unknown snapshot is refused", async () => {
      await expect(deleteDeviceSnapshot(EMULATOR, { snapshotName: "nope" })).rejects.toThrow(
        "Snapshot 'nope' not found",
      );
    });
  });

  test("the refusal reaches the client as a typed payload with its reasons", () => {
    const error = new SnapshotFixtureRefusedError("fixture_invalidated", "f", "Fixture 'f' ...", [
      "userdata-wiped",
    ]);

    const shaped = shapeToolCallError(error, { source: "MCP", toolName: "deviceSnapshot" });

    expect(JSON.parse(shaped.content[0].text)).toEqual({
      success: false,
      error: "Fixture 'f' ...",
      code: "fixture_invalidated",
      snapshotName: "f",
      retryable: false,
      reasons: ["userdata-wiped"],
    });
  });
});
