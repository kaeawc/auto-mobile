import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ActionableError,
  type BootedDevice,
  type DeviceSnapshotConfig,
  type DeviceSnapshotManifest,
} from "../../src/models";
import {
  captureDeviceSnapshot,
  getDeviceSnapshotConfig,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  restoreDeviceSnapshot,
  setDeviceSnapshotManagerDependencies,
  updateDeviceSnapshotConfig,
  withVmRetentionSnapshotProtection,
} from "../../src/server/deviceSnapshotManager";
import { DEVICE_SNAPSHOT_RESOURCE_URIS } from "../../src/server/deviceSnapshotResourceUris";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService, fakeAvdSnapshotPath } from "../fakes/FakeAvdSnapshotService";
import { VM_SNAPSHOT_SAVE_DISPATCHED } from "../../src/features/action/CaptureSnapshot";
import type { DeviceSnapshotRecord } from "../../src/db/deviceSnapshotRepository";
import { sequenceBackoff } from "../../src/utils/Backoff";

class FakeUnderlyingServer {
  notifications: Array<{ method: string; params?: unknown }> = [];
  handlersBySchema = new Map<unknown, (request: unknown, extra?: unknown) => Promise<unknown>>();

  setRequestHandler(
    schema: unknown,
    handler: (request: unknown, extra?: unknown) => Promise<unknown>,
  ): void {
    this.handlersBySchema.set(schema, handler);
  }

  async notification(payload: { method: string; params?: unknown }): Promise<void> {
    this.notifications.push(payload);
  }
}

class FakeMcpServer {
  server = new FakeUnderlyingServer();
}

const AVD_NAME = "am-api36-ga-arm64";
const EMULATOR: BootedDevice = {
  deviceId: "emulator-5556",
  name: AVD_NAME,
  platform: "android",
};

const MB = 1024 * 1024;

function vmManifest(snapshotName: string, timestamp: string): DeviceSnapshotManifest {
  return {
    snapshotName,
    timestamp,
    deviceId: EMULATOR.deviceId,
    deviceName: AVD_NAME,
    platform: "android",
    snapshotType: "vm",
    includeAppData: true,
    includeSettings: true,
  };
}

class FailingSnapshotInsertRepository extends FakeDeviceSnapshotRepository {
  constructor(private remainingFailures: number) {
    super();
  }

  override async insertSnapshot(record: DeviceSnapshotRecord): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("snapshot repository unavailable");
    }
    await super.insertSnapshot(record);
  }
}

describe("deviceSnapshotManager VM snapshot sizing and reclaim (#6490)", () => {
  let fakeTimer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let avdSnapshots: FakeAvdSnapshotService;

  const config: DeviceSnapshotConfig = {
    includeAppData: true,
    includeSettings: false,
    useVmSnapshot: true,
    strictBackupMode: false,
    vmSnapshotTimeoutMs: 12000,
    maxVmSnapshotsPerAvd: 3,
    maxArchiveSizeMb: 4096,
  };

  beforeEach(async () => {
    ResourceRegistry.clearServersForTesting();
    fakeTimer = new FakeTimer();
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    avdSnapshots = new FakeAvdSnapshotService();
    avdSnapshots.setLiveEmulator(AVD_NAME, EMULATOR.deviceId);
    await configRepository.setConfig(config);

    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      avdSnapshots,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          // A real VM capture writes nothing under the archive store; the payload
          // lands inside the AVD. Mirror that here.
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 2 * 1024 * MB);
          const manifest = vmManifest(args.snapshotName, timestamp);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest,
          };
        },
      }),
      createRestoreProvider: () => ({
        restore: async (args) => ({
          snapshotType: args.manifest.snapshotType,
          restoredAt: new Date(fakeTimer.now()).toISOString(),
        }),
      }),
      deviceIncarnationInvalidator: {
        prepareForIncarnationChange: async () => undefined,
        invalidate: async () => undefined,
      },
    });
  });

  afterEach(() => {
    ResourceRegistry.clearServersForTesting();
    resetDeviceSnapshotManagerDependencies();
  });

  test("a vm capture records the in-AVD snapshot size, not the empty archive directory", async () => {
    store.queueGeneratedName("vm-1");

    await captureDeviceSnapshot(EMULATOR, {});

    const record = await repository.getSnapshot("vm-1");
    expect(record?.snapshotType).toBe("vm");
    expect(record?.sizeBytes).toBe(2 * 1024 * MB);
  });

  test("rejects the emulator-owned default_boot snapshot name before any capture side effect", async () => {
    const replaceSnapshotData = spyOn(store, "replaceSnapshotData");
    const getSnapshot = spyOn(repository, "getSnapshot");
    const capture = captureDeviceSnapshot(EMULATOR, {
      snapshotName: "default_boot",
      useVmSnapshot: true,
    });

    await expect(capture).rejects.toBeInstanceOf(ActionableError);
    await expect(capture).rejects.toMatchObject({
      message: expect.stringContaining("default_boot"),
    } satisfies Partial<ActionableError>);

    expect(replaceSnapshotData).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(await repository.getSnapshot("default_boot")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "default_boot")).toBe(false);
  });

  test.each([
    {
      name: "iOS app_data capture",
      device: { deviceId: "ios-sim", name: "iPhone", platform: "ios" as const },
      args: {},
    },
    {
      name: "physical Android capture",
      device: { deviceId: "serial-123", name: "Pixel physical", platform: "android" as const },
      args: {},
    },
    {
      name: "non-VM Android emulator capture",
      device: EMULATOR,
      args: { useVmSnapshot: false },
    },
  ])("allows default_boot for $name", async ({ device, args }) => {
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (captureArgs) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          const manifest: DeviceSnapshotManifest = {
            snapshotName: captureArgs.snapshotName,
            timestamp,
            deviceId: device.deviceId,
            deviceName: device.name,
            platform: device.platform,
            snapshotType: "adb",
            includeAppData: true,
            includeSettings: false,
          };
          return {
            snapshotName: captureArgs.snapshotName,
            timestamp,
            snapshotType: "adb" as const,
            manifest,
          };
        },
      }),
    });
    if (device.platform === "android" && device.deviceId !== EMULATOR.deviceId) {
      await configRepository.setConfig({ ...config, useVmSnapshot: true });
    }

    const result = await captureDeviceSnapshot(device, {
      snapshotName: "DEFAULT_BOOT",
      ...args,
    });

    expect(result.result.snapshotName).toBe("DEFAULT_BOOT");
  });

  test.each(["DEFAULT_BOOT", "Default_boot"])(
    "rejects case variants of the emulator-owned default_boot snapshot name before any capture side effect (%s)",
    async (snapshotName) => {
      const capture = captureDeviceSnapshot(EMULATOR, {
        snapshotName,
        useVmSnapshot: true,
      });

      await expect(capture).rejects.toBeInstanceOf(ActionableError);
      await expect(capture).rejects.toMatchObject({
        message: expect.stringContaining("default_boot"),
      } satisfies Partial<ActionableError>);

      expect(await repository.getSnapshot(snapshotName)).toBeNull();
      expect(await repository.getSnapshot(snapshotName.toLowerCase())).toBeNull();
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, snapshotName)).toBe(false);
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, snapshotName.toLowerCase())).toBe(false);
      expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    },
  );

  test("rejects default_boot before sweeping an unrelated pending VM reclaim", async () => {
    const timestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-pending", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-pending",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      pendingReclaim: true,
      pendingReclaimReason: "emulator offline",
      manifest: vmManifest("vm-pending", timestamp),
    });

    const capture = captureDeviceSnapshot(EMULATOR, {
      snapshotName: "default_boot",
      useVmSnapshot: true,
    });

    await expect(capture).rejects.toBeInstanceOf(ActionableError);
    await expect(capture).rejects.toMatchObject({
      message: expect.stringContaining("default_boot"),
    } satisfies Partial<ActionableError>);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(await repository.getSnapshot("vm-pending")).not.toBeNull();
  });

  test("concurrent config updates retain both independently changed limits", async () => {
    const getConfig = configRepository.getConfig.bind(configRepository);
    let releaseFirstRead = (): void => {};
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let firstReadReached = (): void => {};
    const firstReadAtGate = new Promise<void>((resolve) => {
      firstReadReached = resolve;
    });
    let reads = 0;
    const gatedRepository = Object.create(configRepository) as typeof configRepository;
    gatedRepository.getConfig = async () => {
      reads += 1;
      if (reads === 1) {
        firstReadReached();
        await firstReadGate;
      }
      return getConfig();
    };
    gatedRepository.setConfig = configRepository.setConfig.bind(configRepository);
    await setDeviceSnapshotManagerDependencies({ configRepository: gatedRepository as any });

    const first = updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });
    await firstReadAtGate;
    const second = updateDeviceSnapshotConfig({ maxArchiveSizeMb: 42 });
    releaseFirstRead();
    await Promise.all([first, second]);

    const stored = await getDeviceSnapshotConfig();
    expect(stored.maxVmSnapshotsPerAvd).toBe(1);
    expect(stored.maxArchiveSizeMb).toBe(42);
  });

  test("notifies archive subscribers when a dispatched VM save persists a pending reclaim", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    ResourceRegistry.register(
      DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE,
      "Device Snapshot Archive",
      "Snapshot archive test resource",
      "application/json",
      async () => ({ uri: DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE, text: "{}" }),
    );
    const subscribe = server.server.handlersBySchema.get(SubscribeRequestSchema);
    expect(subscribe).toBeDefined();
    await subscribe!({ params: { uri: DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE } });

    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const failure = new Error("emulator went offline");
          Object.assign(failure, { [VM_SNAPSHOT_SAVE_DISPATCHED]: true });
          throw failure;
        },
      }),
    });

    try {
      await expect(
        captureDeviceSnapshot(EMULATOR, { snapshotName: "vm-dispatched-failure" }),
      ).rejects.toThrow("emulator went offline");

      expect(server.server.notifications).toContainEqual({
        method: "notifications/resources/updated",
        params: { uri: DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE },
      });
    } finally {
      ResourceRegistry.unregister(DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE);
    }
  });

  test("preserves a valid same-named row on another AVD after a dispatched VM save fails", async () => {
    const otherDevice: BootedDevice = {
      deviceId: "emulator-5554",
      name: "am-api34-ga-arm64",
      platform: "android",
    };
    const timestamp = new Date(1000).toISOString();
    const original = {
      snapshotName: "shared",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android" as const,
      snapshotType: "vm" as const,
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("shared", timestamp),
    };
    await repository.insertSnapshot(original);
    avdSnapshots.setLiveEmulator(otherDevice.name, otherDevice.deviceId);
    avdSnapshots.setVmSnapshot(otherDevice.name, "shared", 2 * 1024 * MB);
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const failure = new Error("emulator went offline");
          Object.assign(failure, { [VM_SNAPSHOT_SAVE_DISPATCHED]: true });
          throw failure;
        },
      }),
    });

    await expect(captureDeviceSnapshot(otherDevice, { snapshotName: "shared" })).rejects.toThrow(
      "emulator went offline",
    );

    expect(await repository.getSnapshot("shared")).toEqual(original);
  });

  test("preserves a same-device non-VM row after a dispatched VM save fails", async () => {
    const timestamp = new Date(1000).toISOString();
    const original = {
      snapshotName: "shared-settings",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android" as const,
      snapshotType: "adb" as const,
      includeAppData: false,
      includeSettings: true,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 1024,
      manifest: {
        snapshotName: "shared-settings",
        timestamp,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android" as const,
        snapshotType: "adb" as const,
        includeAppData: false,
        includeSettings: true,
        settings: { global: { animator_duration_scale: "1" } },
      },
    };
    await repository.insertSnapshot(original);
    avdSnapshots.setVmSnapshot(AVD_NAME, "shared-settings", 2 * 1024 * MB);
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const failure = new Error("emulator went offline");
          Object.assign(failure, { [VM_SNAPSHOT_SAVE_DISPATCHED]: true });
          throw failure;
        },
      }),
    });

    await expect(
      captureDeviceSnapshot(EMULATOR, { snapshotName: "shared-settings" }),
    ).rejects.toThrow("emulator went offline");

    expect(await repository.getSnapshot("shared-settings")).toEqual(original);
    expect(avdSnapshots.getDeleteCalls()).toEqual([
      { deviceId: EMULATOR.deviceId, snapshotName: "shared-settings", timeoutMs: 12000 },
    ]);
  });

  test("skips failed-capture cleanup when a different AVD reuses the stale serial", async () => {
    const replacementAvdName = "am-api34-ga-arm64";
    const preservedDevice: BootedDevice = {
      deviceId: "emulator-5560",
      name: "am-api30-ga-arm64",
      platform: "android",
    };
    const timestamp = new Date(1000).toISOString();
    const original = {
      snapshotName: "shared-stale-serial",
      deviceId: preservedDevice.deviceId,
      deviceName: preservedDevice.name,
      platform: "android" as const,
      snapshotType: "vm" as const,
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: {
        snapshotName: "shared-stale-serial",
        timestamp,
        deviceId: preservedDevice.deviceId,
        deviceName: preservedDevice.name,
        platform: "android" as const,
        snapshotType: "vm" as const,
        includeAppData: true,
        includeSettings: false,
      },
    };
    await repository.insertSnapshot(original);
    avdSnapshots.setLiveEmulator(AVD_NAME, null);
    avdSnapshots.setLiveEmulator(replacementAvdName, EMULATOR.deviceId);
    avdSnapshots.setVmSnapshot(replacementAvdName, "shared-stale-serial", 2 * 1024 * MB);
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const failure = new Error("emulator went offline");
          Object.assign(failure, { [VM_SNAPSHOT_SAVE_DISPATCHED]: true });
          throw failure;
        },
      }),
    });

    await expect(
      captureDeviceSnapshot(EMULATOR, { snapshotName: "shared-stale-serial" }),
    ).rejects.toThrow("emulator went offline");

    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(avdSnapshots.hasVmSnapshot(replacementAvdName, "shared-stale-serial")).toBe(true);
  });

  test("skips failed-capture cleanup when a different AVD reuses the serial after lookup", async () => {
    const replacementAvdName = "am-api34-ga-arm64";
    const preservedDevice: BootedDevice = {
      deviceId: "emulator-5560",
      name: "am-api30-ga-arm64",
      platform: "android",
    };
    const timestamp = new Date(1000).toISOString();
    const original = {
      snapshotName: "shared-serial-race",
      deviceId: preservedDevice.deviceId,
      deviceName: preservedDevice.name,
      platform: "android" as const,
      snapshotType: "vm" as const,
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: {
        snapshotName: "shared-serial-race",
        timestamp,
        deviceId: preservedDevice.deviceId,
        deviceName: preservedDevice.name,
        platform: "android" as const,
        snapshotType: "vm" as const,
        includeAppData: true,
        includeSettings: false,
      },
    };
    await repository.insertSnapshot(original);
    avdSnapshots.setVmSnapshot(replacementAvdName, "shared-serial-race", 2 * 1024 * MB);
    avdSnapshots.onFindLiveEmulatorSerial((avdName) => {
      if (avdName === AVD_NAME) {
        avdSnapshots.setLiveEmulator(AVD_NAME, null);
        avdSnapshots.setLiveEmulator(replacementAvdName, EMULATOR.deviceId);
      }
    });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const failure = new Error("emulator went offline");
          Object.assign(failure, { [VM_SNAPSHOT_SAVE_DISPATCHED]: true });
          throw failure;
        },
      }),
    });

    await expect(
      captureDeviceSnapshot(EMULATOR, { snapshotName: "shared-serial-race" }),
    ).rejects.toThrow("emulator went offline");

    expect(await repository.getSnapshot("shared-serial-race")).toEqual(original);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(avdSnapshots.hasVmSnapshot(replacementAvdName, "shared-serial-race")).toBe(true);
  });

  test("preserves a valid same-named row when another AVD reuses its emulator serial", async () => {
    const otherDevice: BootedDevice = {
      deviceId: EMULATOR.deviceId,
      name: "am-api34-ga-arm64",
      platform: "android",
    };
    const timestamp = new Date(1000).toISOString();
    const original = {
      snapshotName: "shared",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android" as const,
      snapshotType: "vm" as const,
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("shared", timestamp),
    };
    await repository.insertSnapshot(original);
    // The first AVD was killed and the second one subsequently reused its port.
    avdSnapshots.setLiveEmulator(AVD_NAME, null);
    avdSnapshots.setLiveEmulator(otherDevice.name, otherDevice.deviceId);
    avdSnapshots.setVmSnapshot(otherDevice.name, "shared", 2 * 1024 * MB);
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const failure = new Error("emulator went offline");
          Object.assign(failure, { [VM_SNAPSHOT_SAVE_DISPATCHED]: true });
          throw failure;
        },
      }),
    });

    await expect(captureDeviceSnapshot(otherDevice, { snapshotName: "shared" })).rejects.toThrow(
      "emulator went offline",
    );

    expect(await repository.getSnapshot("shared")).toEqual(original);
    expect(avdSnapshots.getDeleteCalls()).toEqual([
      { deviceId: otherDevice.deviceId, snapshotName: "shared", timeoutMs: 12000 },
    ]);
    expect(avdSnapshots.hasVmSnapshot(otherDevice.name, "shared")).toBe(false);
  });

  test("refuses to restore a pending-reclaim snapshot before constructing a restore provider", async () => {
    const timestamp = new Date(1000).toISOString();
    await repository.insertSnapshot({
      snapshotName: "vm-pending-restore",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      pendingReclaim: true,
      pendingReclaimReason: "emulator went offline",
      manifest: vmManifest("vm-pending-restore", timestamp),
    });
    let restoreProviderConstructed = false;
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => {
        restoreProviderConstructed = true;
        return {
          restore: async () => ({
            snapshotType: "vm" as const,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          }),
        };
      },
    });

    await expect(
      restoreDeviceSnapshot(EMULATOR, { snapshotName: "vm-pending-restore" }),
    ).rejects.toThrow("awaiting reclaim");

    expect(restoreProviderConstructed).toBe(false);
  });

  test("lists pending-reclaim snapshots as non-restorable", async () => {
    const timestamp = new Date(1000).toISOString();
    await repository.insertSnapshot({
      snapshotName: "vm-pending-list",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      pendingReclaim: true,
      manifest: vmManifest("vm-pending-list", timestamp),
    });
    await repository.insertSnapshot({
      snapshotName: "vm-restorable-list",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-restorable-list", timestamp),
    });

    const { snapshots } = await listDeviceSnapshots();

    expect(snapshots.find((snapshot) => snapshot.snapshotName === "vm-pending-list")).toMatchObject(
      {
        restorable: false,
      },
    );
    expect(
      snapshots.find((snapshot) => snapshot.snapshotName === "vm-restorable-list"),
    ).toMatchObject({ restorable: true });
  });

  test("records a pending reclaim when the repository insert fails after a VM save", async () => {
    const failingRepository = new FailingSnapshotInsertRepository(1);
    await setDeviceSnapshotManagerDependencies({ snapshotRepository: failingRepository as any });
    store.queueGeneratedName("vm-insert-failed");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(
      "snapshot repository unavailable",
    );

    const pending = await failingRepository.getSnapshot("vm-insert-failed");
    expect(pending?.pendingReclaim).toBe(true);
    expect(pending?.pendingReclaimReason).toContain("snapshot repository unavailable");
  });

  test("best-effort deletes a VM payload when both repository inserts fail", async () => {
    const failingRepository = new FailingSnapshotInsertRepository(Number.POSITIVE_INFINITY);
    await setDeviceSnapshotManagerDependencies({ snapshotRepository: failingRepository as any });
    store.queueGeneratedName("vm-unrecordable");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(
      "snapshot repository unavailable",
    );

    expect(avdSnapshots.getDeleteCalls()).toEqual([
      { deviceId: EMULATOR.deviceId, snapshotName: "vm-unrecordable", timeoutMs: 12000 },
    ]);
  });

  test("a capture that is itself over the VM byte budget is reclaimed, not silently kept", async () => {
    // The eviction pass used to run INSIDE the capture's name lock, so it always
    // skipped the row that capture had just written. A single VM snapshot larger
    // than the whole budget — routine at the 100 MB default — therefore left the
    // archive permanently over its limit with nothing to retry it (#6490 review).
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });
    store.queueGeneratedName("vm-oversized");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect(await repository.getSnapshot("vm-oversized")).toBeNull();
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual([
      "vm-oversized",
    ]);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-oversized")).toBe(false);
  });

  test("a VM capture larger than the non-VM byte budget is retained", async () => {
    // A real VM payload is routinely multiple GB, while maxArchiveSizeMb is the
    // small archive-store budget for adb/app_data/simctl snapshots. It must not
    // delete the VM row the successful capture just created (#6960).
    await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });
    store.queueGeneratedName("vm-oversized");

    const { evictedSnapshotNames } = await captureDeviceSnapshot(EMULATOR, {});

    expect(evictedSnapshotNames).toEqual([]);
    expect(await repository.getSnapshot("vm-oversized")).not.toBeNull();
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-oversized")).toBe(true);
  });

  test("VM count retention keeps the just-captured oldest record and evicts other oldest rows first", async () => {
    for (const [index, name] of ["vm-old", "vm-mid"].entries()) {
      const timestamp = new Date(2_000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, name, 2 * MB);
      await repository.insertSnapshot({
        snapshotName: name,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * MB,
        manifest: vmManifest(name, timestamp),
      });
    }
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 2 });
    store.queueGeneratedName("vm-skewed");

    const { evictedSnapshotNames } = await captureDeviceSnapshot(EMULATOR, {});

    expect(evictedSnapshotNames).toEqual(["vm-old"]);
    expect(await repository.getSnapshot("vm-skewed")).not.toBeNull();
    expect(await repository.getSnapshot("vm-mid")).not.toBeNull();
    expect(await repository.getSnapshot("vm-old")).toBeNull();
  });

  test("an explicit VM byte ceiling smaller than a capture rolls back its row and payload", async () => {
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });
    store.queueGeneratedName("vm-too-large");

    const capture = captureDeviceSnapshot(EMULATOR, {});
    await expect(capture).rejects.toBeInstanceOf(ActionableError);
    await expect(capture).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect(await repository.getSnapshot("vm-too-large")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-too-large")).toBe(false);
    expect(store.getDeletedSnapshots()).toContain("vm-too-large");
  });

  test("an oversized protected capture does not evict an older VM snapshot before rollback", async () => {
    const timestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-existing", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-existing",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-existing", timestamp),
    });
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 3072 });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const capturedAt = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp: capturedAt,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, capturedAt),
          };
        },
      }),
    });
    store.queueGeneratedName("vm-too-large");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect((await repository.getSnapshot("vm-existing"))?.sizeBytes).toBe(2 * 1024 * MB);
    expect(await repository.getSnapshot("vm-too-large")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-too-large")).toBe(false);
  });

  test("an oversized protected capture keeps a concurrent same-name replacement", async () => {
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 3072 });
    let captureCompleted = false;
    let replacementInserted = false;
    const replacementTimestamp = new Date(2_000).toISOString();
    const racingRepository = Object.create(repository) as typeof repository;
    racingRepository.getSnapshot = async (snapshotName: string) => {
      if (snapshotName === "vm-too-large" && captureCompleted && !replacementInserted) {
        replacementInserted = true;
        // Simulate a same-name recapture landing after VM retention releases its lock.
        await repository.deleteSnapshot(snapshotName);
        avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
        await repository.insertSnapshot({
          snapshotName,
          deviceId: EMULATOR.deviceId,
          deviceName: AVD_NAME,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: replacementTimestamp,
          lastAccessedAt: replacementTimestamp,
          sizeBytes: 2 * 1024 * MB,
          manifest: vmManifest(snapshotName, replacementTimestamp),
        });
      }
      return repository.getSnapshot(snapshotName);
    };
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: racingRepository as any,
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB);
          captureCompleted = true;
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });
    store.queueGeneratedName("vm-too-large");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect(replacementInserted).toBe(true);
    expect(await repository.getSnapshot("vm-too-large")).toMatchObject({
      createdAt: replacementTimestamp,
      lastAccessedAt: replacementTimestamp,
      sizeBytes: 2 * 1024 * MB,
    });
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-too-large")).toBe(true);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
  });

  test("an oversized same-name VM recapture keeps its replacement payload", async () => {
    await captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" });
    const updates = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 3072 });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });

    try {
      await expect(captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" })).rejects.toThrow(
        /maxVmArchiveSizeMb/i,
      );

      expect((await repository.getSnapshot("shared"))?.sizeBytes).toBe(4 * 1024 * MB);
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "shared")).toBe(true);
      expect(updates).toHaveBeenCalledWith([DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE]);
    } finally {
      updates.mockRestore();
    }
  });

  test("a rejected VM capture reports an incomplete reclaim instead of claiming rollback", async () => {
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });
    avdSnapshots.failNextDeletesWith("emulator console unavailable");
    store.queueGeneratedName("vm-reclaim-pending");
    const updates = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);

    try {
      await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(/could not be reclaimed/i);

      expect(await repository.getSnapshot("vm-reclaim-pending")).not.toBeNull();
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-reclaim-pending")).toBe(true);
      expect(updates).toHaveBeenCalledWith([DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE]);
    } finally {
      updates.mockRestore();
    }
  });

  test("a vm capture whose AVD directory cannot be found records an unknown size, never 0", async () => {
    store.queueGeneratedName("vm-unsized");
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });

    await captureDeviceSnapshot(EMULATOR, {});

    const record = await repository.getSnapshot("vm-unsized");
    expect(record?.sizeBytes).toBeNull();

    const listed = await listDeviceSnapshots();
    expect(listed.unsizedCount).toBe(1);
    expect(listed.totalSizeBytes).toBe(0);
  });

  test("an archive of VM snapshots over its per-AVD count evicts oldest-first and issues one delete each", async () => {
    for (const [index, name] of ["vm-old", "vm-mid", "vm-new"].entries()) {
      const timestamp = new Date(1000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, name, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName: name,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(name, timestamp),
      });
    }

    // Three rows with a one-snapshot per-AVD retention: the two oldest go.
    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
      maxVmSnapshotsPerAvd: 1,
    });

    expect(evictedSnapshotNames).toEqual(["vm-old", "vm-mid"]);
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual([
      "vm-old",
      "vm-mid",
    ]);
    expect(avdSnapshots.getDeleteCalls()[0]?.deviceId).toBe(EMULATOR.deviceId);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-old")).toBe(false);
    expect(await repository.getSnapshot("vm-old")).toBeNull();
    expect(await repository.getSnapshot("vm-new")).not.toBeNull();
  });

  test("tightening VM retention sweeps every AVD, not only the most recent capture's AVD", async () => {
    const otherAvd = "am-api34-ga-arm64";
    const otherSerial = "emulator-5554";
    avdSnapshots.setLiveEmulator(otherAvd, otherSerial);
    for (const [deviceName, deviceId] of [
      [AVD_NAME, EMULATOR.deviceId],
      [otherAvd, otherSerial],
    ] as const) {
      for (const [index, name] of ["old", "new"].entries()) {
        const snapshotName = `${deviceName}-${name}`;
        const timestamp = new Date(4_000 + index).toISOString();
        avdSnapshots.setVmSnapshot(deviceName, snapshotName, MB);
        await repository.insertSnapshot({
          snapshotName,
          deviceId,
          deviceName,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: timestamp,
          lastAccessedAt: timestamp,
          sizeBytes: MB,
          manifest: { ...vmManifest(snapshotName, timestamp), deviceId, deviceName },
        });
      }
    }

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });

    expect(evictedSnapshotNames.sort()).toEqual([`${AVD_NAME}-old`, `${otherAvd}-old`].sort());
    expect(await repository.getSnapshot(`${AVD_NAME}-new`)).not.toBeNull();
    expect(await repository.getSnapshot(`${otherAvd}-new`)).not.toBeNull();
  });

  describe("a row left unsized is re-measured before the budget is enforced (#6891 review)", () => {
    // The upgrade migration flags every pre-change Android `vm` row unsized,
    // because the size it carries was measured at the archive directory and
    // describes none of its bytes. Nothing re-imports a row that already exists,
    // so unless enforcement re-measures it the payload stays outside the budget
    // forever while the archive reports it as unknown.
    async function seedUnsizedVmRow(sizeOnDisk: number | null): Promise<void> {
      const timestamp = new Date(1000).toISOString();
      if (sizeOnDisk !== null) {
        avdSnapshots.setVmSnapshot(AVD_NAME, "vm-legacy", sizeOnDisk);
      }
      await repository.insertSnapshot({
        snapshotName: "vm-legacy",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: null,
        manifest: vmManifest("vm-legacy", timestamp),
      });
    }

    test("the re-measured size is persisted and stops being reported as unsized", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect((await repository.getSnapshot("vm-legacy"))?.sizeBytes).toBe(2 * 1024 * MB);
      const listed = await listDeviceSnapshots();
      expect(listed.unsizedCount).toBe(0);
      expect(listed.totalSizeBytes).toBe(2 * 1024 * MB);
    });

    test("a re-measured row over the optional VM byte budget is evicted instead of hiding behind an unknown size", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
        maxVmArchiveSizeMb: 1024,
      });

      expect(evictedSnapshotNames).toEqual(["vm-legacy"]);
      expect(await repository.getSnapshot("vm-legacy")).toBeNull();
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-legacy")).toBe(false);
    });

    test("a payload that still cannot be located stays unknown rather than becoming a fabricated 0", async () => {
      await seedUnsizedVmRow(null);

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect((await repository.getSnapshot("vm-legacy"))?.sizeBytes).toBeNull();
      expect((await listDeviceSnapshots()).unsizedCount).toBe(1);
    });

    test("drops a missing stale payload after a concurrent same-name replacement", async () => {
      await seedUnsizedVmRow(null);
      const replacementTimestamp = new Date(3_000).toISOString();
      const replacementAvd = "am-api34-ga-arm64";
      const liveSnapshotTimestamp = new Date(2_000).toISOString();
      await repository.insertSnapshot({
        snapshotName: "vm-live",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: liveSnapshotTimestamp,
        lastAccessedAt: liveSnapshotTimestamp,
        sizeBytes: 2 * MB,
        manifest: vmManifest("vm-live", liveSnapshotTimestamp),
      });

      const getSnapshot = repository.getSnapshot.bind(repository);
      const getSnapshotSpy = spyOn(repository, "getSnapshot").mockImplementation(getSnapshot);
      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: async (_avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-legacy") {
              await repository.insertSnapshot({
                snapshotName,
                deviceId: "emulator-5554",
                deviceName: replacementAvd,
                platform: "android",
                snapshotType: "vm",
                includeAppData: true,
                includeSettings: false,
                createdAt: replacementTimestamp,
                lastAccessedAt: replacementTimestamp,
                sizeBytes: null,
                manifest: {
                  ...vmManifest(snapshotName, replacementTimestamp),
                  deviceId: "emulator-5554",
                  deviceName: replacementAvd,
                },
              });
            }
            return null;
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      try {
        await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 2 });

        expect(getSnapshotSpy).toHaveBeenCalledWith("vm-legacy");
      } finally {
        getSnapshotSpy.mockRestore();
      }
      expect(await repository.getSnapshot("vm-live")).not.toBeNull();
      expect(await repository.getSnapshot("vm-legacy")).toMatchObject({
        deviceName: replacementAvd,
        sizeBytes: null,
      });
    });

    test("persists a re-measured size after the same row is touched by a restore", async () => {
      await seedUnsizedVmRow(2 * MB);
      const restoredAt = new Date(2_000).toISOString();

      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: async (avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-legacy") {
              await repository.updateSnapshot(snapshotName, { lastAccessedAt: restoredAt });
            }
            return avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName);
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect(await repository.getSnapshot("vm-legacy")).toMatchObject({
        lastAccessedAt: restoredAt,
        sizeBytes: 2 * MB,
      });
    });

    test("keeps a re-measurement-touched snapshot ahead of an older row when its size remains unknown", async () => {
      const touchedAt = new Date(3_000).toISOString();
      const olderAt = new Date(1_000).toISOString();
      const staleTouchedAt = new Date(500).toISOString();
      await repository.insertSnapshot({
        snapshotName: "vm-touched",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: staleTouchedAt,
        lastAccessedAt: staleTouchedAt,
        sizeBytes: null,
        manifest: vmManifest("vm-touched", staleTouchedAt),
      });
      avdSnapshots.setVmSnapshot(AVD_NAME, "vm-older", 2 * MB);
      await repository.insertSnapshot({
        snapshotName: "vm-older",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: olderAt,
        lastAccessedAt: olderAt,
        sizeBytes: 2 * MB,
        manifest: vmManifest("vm-older", olderAt),
      });

      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: async (_avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-touched") {
              await repository.updateSnapshot(snapshotName, { lastAccessedAt: touchedAt });
            }
            return null;
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
        maxVmSnapshotsPerAvd: 1,
      });

      expect(evictedSnapshotNames).toEqual(["vm-older"]);
      expect(await repository.getSnapshot("vm-touched")).toMatchObject({
        lastAccessedAt: touchedAt,
        sizeBytes: null,
      });
      expect(await repository.getSnapshot("vm-older")).toBeNull();
    });

    test("keeps a re-measurement-touched snapshot ahead of an older row when recording its size fails", async () => {
      const touchedAt = new Date(3_000).toISOString();
      const olderAt = new Date(1_000).toISOString();
      const staleTouchedAt = new Date(500).toISOString();
      await repository.insertSnapshot({
        snapshotName: "vm-touched",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: staleTouchedAt,
        lastAccessedAt: staleTouchedAt,
        sizeBytes: null,
        manifest: vmManifest("vm-touched", staleTouchedAt),
      });
      avdSnapshots.setVmSnapshot(AVD_NAME, "vm-touched", 2 * MB);
      avdSnapshots.setVmSnapshot(AVD_NAME, "vm-older", 2 * MB);
      await repository.insertSnapshot({
        snapshotName: "vm-older",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: olderAt,
        lastAccessedAt: olderAt,
        sizeBytes: 2 * MB,
        manifest: vmManifest("vm-older", olderAt),
      });
      const failingUpdateRepository = Object.create(repository) as typeof repository;
      failingUpdateRepository.updateSnapshot = async (snapshotName, update) => {
        if (snapshotName === "vm-touched" && update.sizeBytes !== undefined) {
          throw new Error("snapshot repository unavailable");
        }
        await repository.updateSnapshot(snapshotName, update);
      };

      await setDeviceSnapshotManagerDependencies({
        snapshotRepository: failingUpdateRepository as any,
        avdSnapshots: {
          measureVmSnapshotBytes: async (avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-touched") {
              await repository.updateSnapshot(snapshotName, { lastAccessedAt: touchedAt });
            }
            return avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName);
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
        maxVmSnapshotsPerAvd: 1,
      });

      expect(evictedSnapshotNames).toEqual(["vm-older"]);
      expect(await repository.getSnapshot("vm-touched")).toMatchObject({
        lastAccessedAt: touchedAt,
        sizeBytes: null,
      });
      expect(await repository.getSnapshot("vm-older")).toBeNull();
    });

    test("does not stamp a stale re-measurement onto a concurrently replaced row", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);
      const replacementTimestamp = new Date(2_000).toISOString();
      const replacementAvd = "am-api34-ga-arm64";

      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: async (avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-legacy") {
              await repository.updateSnapshot(snapshotName, {
                createdAt: replacementTimestamp,
                lastAccessedAt: replacementTimestamp,
                deviceName: replacementAvd,
                deviceId: "emulator-5554",
                sizeBytes: null,
                manifest: {
                  ...vmManifest(snapshotName, replacementTimestamp),
                  deviceName: replacementAvd,
                  deviceId: "emulator-5554",
                },
              });
            }
            return avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName);
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect(await repository.getSnapshot("vm-legacy")).toMatchObject({
        createdAt: replacementTimestamp,
        deviceName: replacementAvd,
        sizeBytes: null,
      });
    });

    test("does not stamp a stale re-measurement onto an upsert replacement that preserves createdAt", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);
      const replacementTimestamp = new Date(2_000).toISOString();
      const replacementAvd = "am-api34-ga-arm64";
      const replacementSizeBytes = 3 * 1024 * MB;

      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: async (avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-legacy") {
              await repository.insertSnapshot({
                snapshotName,
                deviceId: "emulator-5554",
                deviceName: replacementAvd,
                platform: "android",
                snapshotType: "vm",
                includeAppData: true,
                includeSettings: false,
                createdAt: replacementTimestamp,
                lastAccessedAt: replacementTimestamp,
                sizeBytes: replacementSizeBytes,
                manifest: {
                  ...vmManifest(snapshotName, replacementTimestamp),
                  deviceId: "emulator-5554",
                  deviceName: replacementAvd,
                },
              });
            }
            return avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName);
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect(await repository.getSnapshot("vm-legacy")).toMatchObject({
        deviceId: "emulator-5554",
        deviceName: replacementAvd,
        lastAccessedAt: replacementTimestamp,
        sizeBytes: replacementSizeBytes,
      });
    });

    test("does not count a concurrent replacement from another AVD toward the old AVD retention budget", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);
      const oldSnapshotTimestamp = new Date(1_500).toISOString();
      const replacementTimestamp = new Date(2_000).toISOString();
      const replacementAvd = "am-api34-ga-arm64";
      const replacementDeviceId = "emulator-5554";
      avdSnapshots.setVmSnapshot(AVD_NAME, "vm-old", 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName: "vm-old",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: oldSnapshotTimestamp,
        lastAccessedAt: oldSnapshotTimestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest("vm-old", oldSnapshotTimestamp),
      });
      avdSnapshots.setLiveEmulator(replacementAvd, replacementDeviceId);
      avdSnapshots.setVmSnapshot(replacementAvd, "vm-legacy", 3 * 1024 * MB);

      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: async (avdName: string, snapshotName: string) => {
            if (snapshotName === "vm-legacy") {
              await repository.insertSnapshot({
                snapshotName,
                deviceId: replacementDeviceId,
                deviceName: replacementAvd,
                platform: "android",
                snapshotType: "vm",
                includeAppData: true,
                includeSettings: false,
                createdAt: replacementTimestamp,
                lastAccessedAt: replacementTimestamp,
                sizeBytes: 3 * 1024 * MB,
                manifest: {
                  ...vmManifest(snapshotName, replacementTimestamp),
                  deviceId: replacementDeviceId,
                  deviceName: replacementAvd,
                },
              });
            }
            return avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName);
          },
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: (deviceId: string, snapshotName: string, timeoutMs: number) =>
            avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs),
        },
      });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
        maxVmSnapshotsPerAvd: 1,
      });

      expect(evictedSnapshotNames).toEqual([]);
      expect(await repository.getSnapshot("vm-old")).not.toBeNull();
      expect(await repository.getSnapshot("vm-legacy")).toMatchObject({
        deviceId: replacementDeviceId,
        deviceName: replacementAvd,
        sizeBytes: 3 * 1024 * MB,
      });
      expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    });
  });

  test("an offline emulator marks the row pending reclaim instead of losing the reference", async () => {
    const timestamp = new Date(1000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-offline", 2 * 1024 * MB);
    avdSnapshots.setLiveEmulator(AVD_NAME, null);
    await repository.insertSnapshot({
      snapshotName: "vm-offline",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-offline", timestamp),
    });

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    expect(evictedSnapshotNames).toEqual([]);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    const pending = await repository.getSnapshot("vm-offline");
    expect(pending?.pendingReclaim).toBe(true);
    expect(pending?.pendingReclaimReason).toContain("emulator");
  });

  test("an offline VM count-retention pass schedules only its oldest deferred reclaim", async () => {
    for (const [index, snapshotName] of ["vm-old", "vm-mid", "vm-new"].entries()) {
      const timestamp = new Date(1_000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }
    avdSnapshots.setLiveEmulator(AVD_NAME, null);

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
      maxVmSnapshotsPerAvd: 2,
    });

    expect(evictedSnapshotNames).toEqual([]);
    expect((await repository.getSnapshot("vm-old"))?.pendingReclaim).toBe(true);
    expect((await repository.getSnapshot("vm-mid"))?.pendingReclaim).not.toBe(true);
    expect((await repository.getSnapshot("vm-new"))?.pendingReclaim).not.toBe(true);
  });

  test("pending-reclaim VM rows do not consume the live VM retention budget", async () => {
    const timestamp = new Date(1_000).toISOString();
    for (const [snapshotName, pendingReclaim] of [
      ["vm-pending", true],
      ["vm-live", false],
    ] as const) {
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * MB,
        pendingReclaim,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }

    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });

    expect(await repository.getSnapshot("vm-live")).not.toBeNull();
    expect((await repository.getSnapshot("vm-pending"))?.pendingReclaim).toBe(true);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
  });

  test("a concurrently reclaimed oldest row does not evict the next live row", async () => {
    for (const [index, snapshotName] of ["old", "mid", "new"].entries()) {
      const timestamp = new Date(1_000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }
    await setDeviceSnapshotManagerDependencies({
      avdSnapshots: {
        measureVmSnapshotBytes: (avdName: string, snapshotName: string) =>
          avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName),
        listAvdSnapshotDirectories: (avdName: string) =>
          avdSnapshots.listAvdSnapshotDirectories(avdName),
        listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
        findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
        deleteVmSnapshot: async (
          deviceId: string,
          snapshotName: string,
          timeoutMs: number,
          expectedAvdName?: string,
        ) => {
          if (snapshotName === "old") {
            await repository.deleteSnapshot(snapshotName);
            return { reclaimed: false, reason: "concurrent pending-reclaim sweep completed" };
          }
          return avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs, expectedAvdName);
        },
      },
    });

    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 2 });

    expect(await repository.getSnapshot("old")).toBeNull();
    expect(await repository.getSnapshot("mid")).not.toBeNull();
    expect(await repository.getSnapshot("new")).not.toBeNull();
  });

  test("a replaced oldest row for another AVD does not evict the next live row", async () => {
    const otherAvd = "am-api34-ga-arm64";
    for (const [index, snapshotName] of ["old", "mid", "new"].entries()) {
      const timestamp = new Date(1_000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }
    let replacementInserted = false;
    const replacementTimestamp = new Date(9_000).toISOString();
    const racingRepository = Object.create(repository) as typeof repository;
    racingRepository.getSnapshot = async (snapshotName: string) => {
      if (snapshotName === "old" && !replacementInserted) {
        replacementInserted = true;
        await repository.deleteSnapshot(snapshotName);
        await repository.insertSnapshot({
          snapshotName,
          deviceId: "emulator-5554",
          deviceName: otherAvd,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: replacementTimestamp,
          lastAccessedAt: replacementTimestamp,
          sizeBytes: 3 * 1024 * MB,
          manifest: {
            ...vmManifest(snapshotName, replacementTimestamp),
            deviceId: "emulator-5554",
            deviceName: otherAvd,
          },
        });
      }
      return repository.getSnapshot(snapshotName);
    };
    await setDeviceSnapshotManagerDependencies({ snapshotRepository: racingRepository as any });

    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 2 });

    expect(replacementInserted).toBe(true);
    expect(await repository.getSnapshot("old")).toMatchObject({
      deviceName: otherAvd,
      createdAt: replacementTimestamp,
      sizeBytes: 3 * 1024 * MB,
    });
    expect(await repository.getSnapshot("mid")).not.toBeNull();
    expect(await repository.getSnapshot("new")).not.toBeNull();
  });

  test("a busy VM retention candidate schedules one background retry", async () => {
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });
    const timestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-old", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-old",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-old", timestamp),
    });
    let releaseRestore = (): void => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered = (): void => {};
    const restoreAtGate = new Promise<void>((resolve) => {
      restoreEntered = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          restoreEntered();
          await restoreGate;
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          };
        },
      }),
    });

    const restoring = restoreDeviceSnapshot(EMULATOR, { snapshotName: "vm-old" });
    await restoreAtGate;
    store.queueGeneratedName("vm-new");

    await captureDeviceSnapshot(EMULATOR, {});

    expect(await repository.listSnapshots({ snapshotType: "vm" })).toHaveLength(2);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    await fakeTimer.advanceTimeAsync(100);

    expect(await repository.listSnapshots({ snapshotType: "vm" })).toHaveLength(2);
    expect(await repository.getSnapshot("vm-new")).not.toBeNull();
    releaseRestore();
    await restoring;
  });

  test("a deferred VM retention retry reloads loosened limits before evicting", async () => {
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });
    const timestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-old", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-old",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-old", timestamp),
    });
    let releaseRestore = (): void => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered = (): void => {};
    const restoreAtGate = new Promise<void>((resolve) => {
      restoreEntered = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          restoreEntered();
          await restoreGate;
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          };
        },
      }),
    });

    const restoring = restoreDeviceSnapshot(EMULATOR, { snapshotName: "vm-old" });
    await restoreAtGate;
    store.queueGeneratedName("vm-new");
    await captureDeviceSnapshot(EMULATOR, {});
    expect(fakeTimer.getPendingTimeouts()).toEqual([100]);

    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });
    await fakeTimer.advanceTimeAsync(100);

    expect(await repository.getSnapshot("vm-old")).not.toBeNull();
    expect(await repository.getSnapshot("vm-new")).not.toBeNull();
    releaseRestore();
    await restoring;
  });

  test("VM retention retries use the injected backoff sequence", async () => {
    await setDeviceSnapshotManagerDependencies({
      vmRetentionRetryBackoff: sequenceBackoff([100, 250]),
    });
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });
    const timestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-old", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-old",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-old", timestamp),
    });
    let releaseRestore = (): void => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered = (): void => {};
    const restoreAtGate = new Promise<void>((resolve) => {
      restoreEntered = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          restoreEntered();
          await restoreGate;
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          };
        },
      }),
    });

    const restoring = restoreDeviceSnapshot(EMULATOR, { snapshotName: "vm-old" });
    await restoreAtGate;
    store.queueGeneratedName("vm-new");
    await captureDeviceSnapshot(EMULATOR, {});
    expect(fakeTimer.getPendingTimeouts()).toEqual([100]);

    await fakeTimer.advanceTimeAsync(100);

    expect(fakeTimer.getPendingTimeouts()).toEqual([250]);
    releaseRestore();
    await restoring;
  });

  test("overlapping VM captures protect the later capture from the first retention pass", async () => {
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });
    let insertedRows = 0;
    let releaseInserts = (): void => {};
    const bothRowsInserted = new Promise<void>((resolve) => {
      releaseInserts = resolve;
    });
    const racingRepository = Object.create(repository) as typeof repository;
    racingRepository.insertSnapshot = async (record) => {
      await repository.insertSnapshot(record);
      insertedRows += 1;
      if (insertedRows === 2) {
        releaseInserts();
      }
      await bothRowsInserted;
    };
    let releaseCaptures = (): void => {};
    const captureGate = new Promise<void>((resolve) => {
      releaseCaptures = resolve;
    });
    let startedCaptures = 0;
    let capturesStarted = (): void => {};
    const bothCapturesStarted = new Promise<void>((resolve) => {
      capturesStarted = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: racingRepository as any,
      createCaptureProvider: () => ({
        capture: async (args) => {
          startedCaptures += 1;
          if (startedCaptures === 2) {
            capturesStarted();
          }
          await captureGate;
          const timestamp = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 2 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });

    const firstCapture = captureDeviceSnapshot(EMULATOR, { snapshotName: "vm-first" });
    const secondCapture = captureDeviceSnapshot(EMULATOR, { snapshotName: "vm-second" });
    await bothCapturesStarted;
    releaseCaptures();

    await expect(Promise.all([firstCapture, secondCapture])).resolves.toHaveLength(2);

    expect(await repository.getSnapshot("vm-second")).not.toBeNull();
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).not.toContain(
      "vm-second",
    );
  });

  test("same-name VM retention protections remain active until every outer scope completes", async () => {
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 2 });
    const sharedTimestamp = new Date(fakeTimer.now()).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "shared", 2 * MB);
    await repository.insertSnapshot({
      snapshotName: "shared",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: sharedTimestamp,
      lastAccessedAt: sharedTimestamp,
      sizeBytes: 2 * MB,
      manifest: vmManifest("shared", sharedTimestamp),
    });
    const oldTimestamp = new Date(fakeTimer.now() + 1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-old", 2 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-old",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: oldTimestamp,
      lastAccessedAt: oldTimestamp,
      sizeBytes: 2 * MB,
      manifest: vmManifest("vm-old", oldTimestamp),
    });

    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = (): void => {};
    const firstAtGate = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseSecond = (): void => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondEntered = (): void => {};
    const secondAtGate = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const first = withVmRetentionSnapshotProtection(EMULATOR, "shared", true, async () => {
      firstEntered();
      await firstGate;
    });
    await firstAtGate;
    const second = withVmRetentionSnapshotProtection(EMULATOR, "shared", true, async () => {
      secondEntered();
      await secondGate;
    });
    await secondAtGate;
    releaseFirst();
    await first;

    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });

    expect(await repository.getSnapshot("shared")).not.toBeNull();
    expect(await repository.getSnapshot("vm-old")).toBeNull();
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-old"]);

    releaseSecond();
    await second;
    expect(await repository.getSnapshot("shared")).not.toBeNull();
  });

  test("a capture enforces VM retention configured while capture was in flight", async () => {
    const oldTimestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-old", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-old",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: oldTimestamp,
      lastAccessedAt: oldTimestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-old", oldTimestamp),
    });
    let releaseCapture = (): void => {};
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureEntered = (): void => {};
    const captureAtGate = new Promise<void>((resolve) => {
      captureEntered = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          captureEntered();
          await captureGate;
          const timestamp = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 2 * 1024 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });
    store.queueGeneratedName("vm-new");

    const capturing = captureDeviceSnapshot(EMULATOR, {});
    await captureAtGate;
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });
    releaseCapture();
    await capturing;

    expect(await repository.getSnapshot("vm-old")).toBeNull();
    expect(await repository.getSnapshot("vm-new")).not.toBeNull();
  });

  test("an oversized capture does not retain a same-name row from another AVD", async () => {
    const otherAvd = "am-api34-ga-arm64";
    const previousTimestamp = new Date(1_000).toISOString();
    await repository.insertSnapshot({
      snapshotName: "shared",
      deviceId: "emulator-5554",
      deviceName: otherAvd,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: previousTimestamp,
      lastAccessedAt: previousTimestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: {
        ...vmManifest("shared", previousTimestamp),
        deviceId: "emulator-5554",
        deviceName: otherAvd,
      },
    });
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 3 * 1024 });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });

    await expect(captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" })).rejects.toThrow(
      /could not be captured/i,
    );

    expect(await repository.getSnapshot("shared")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "shared")).toBe(false);
  });

  describe("the reclaim intent is durable across the console delete (#6891 review)", () => {
    // The console delete is the irreversible step: once the emulator accepts it
    // the gigabytes are gone. If the process dies — or the row deletion that
    // follows fails — while the row still reads "not pending", that row keeps
    // being listed and offered for restore with no payload behind it, and the
    // pending sweep cannot repair it because it only ever selects pending rows.
    async function seedLiveVmRow(snapshotName: string): Promise<void> {
      const timestamp = new Date(1000).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }

    test("the row is already flagged pending when the emulator is asked to delete", async () => {
      await seedLiveVmRow("vm-crash");
      let pendingAtDeleteTime: boolean | undefined;
      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: (avdName: string, snapshotName: string) =>
            avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName),
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: async (
            deviceId: string,
            snapshotName: string,
            timeoutMs: number,
            expectedAvdName?: string,
          ) => {
            pendingAtDeleteTime = (await repository.getSnapshot(snapshotName))?.pendingReclaim;
            return avdSnapshots.deleteVmSnapshot(
              deviceId,
              snapshotName,
              timeoutMs,
              expectedAvdName,
            );
          },
        },
      });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

      expect(pendingAtDeleteTime).toBe(true);
      expect(evictedSnapshotNames).toEqual(["vm-crash"]);
      expect(await repository.getSnapshot("vm-crash")).toBeNull();
    });

    test("a row deletion that fails after the payload is gone stays sweepable", async () => {
      await seedLiveVmRow("vm-orphaned-row");
      const failingStore = Object.create(store) as typeof store;
      failingStore.deleteSnapshotData = async () => {
        throw new Error("archive directory is unreadable");
      };
      await setDeviceSnapshotManagerDependencies({ snapshotStore: failingStore as any });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

      expect(evictedSnapshotNames).toEqual([]);
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-orphaned-row")).toBe(false);
      expect((await repository.getSnapshot("vm-orphaned-row"))?.pendingReclaim).toBe(true);

      // With the store healthy again the sweep finishes what the failure
      // interrupted, instead of leaving a restorable row with no payload.
      await setDeviceSnapshotManagerDependencies({ snapshotStore: store as any });
      await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 0 });
      store.queueGeneratedName("vm-after");
      await captureDeviceSnapshot(EMULATOR, {});

      expect(await repository.getSnapshot("vm-orphaned-row")).toBeNull();
    });
  });

  test("the sweep completes a pending reclaim when that AVD's emulator is next seen live", async () => {
    const timestamp = new Date(1000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-pending", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-pending",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      pendingReclaim: true,
      pendingReclaimReason: "emulator offline",
      manifest: vmManifest("vm-pending", timestamp),
    });

    store.queueGeneratedName("vm-fresh");
    await captureDeviceSnapshot(EMULATOR, {});

    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-pending"]);
    expect(await repository.getSnapshot("vm-pending")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-pending")).toBe(false);
  });

  describe("a pending reclaim on another AVD survives name reuse (#6490 review)", () => {
    const OTHER_AVD = "am-api34-ga-arm64";
    const OTHER_SERIAL = "emulator-5554";

    async function seedPendingOnOtherAvd(): Promise<void> {
      const timestamp = new Date(1000).toISOString();
      avdSnapshots.setVmSnapshot(OTHER_AVD, "shared", 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName: "shared",
        deviceId: OTHER_SERIAL,
        deviceName: OTHER_AVD,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        pendingReclaim: true,
        pendingReclaimReason: "emulator offline",
        manifest: {
          snapshotName: "shared",
          timestamp,
          deviceId: OTHER_SERIAL,
          deviceName: OTHER_AVD,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
        },
      });
    }

    test("the other AVD's payload is reclaimed before the row is overwritten", async () => {
      await seedPendingOnOtherAvd();
      avdSnapshots.setLiveEmulator(OTHER_AVD, OTHER_SERIAL);

      await captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" });

      expect(avdSnapshots.getDeleteCalls()).toEqual([
        { deviceId: OTHER_SERIAL, snapshotName: "shared", timeoutMs: 12000 },
      ]);
      expect(avdSnapshots.hasVmSnapshot(OTHER_AVD, "shared")).toBe(false);
      expect((await repository.getSnapshot("shared"))?.deviceName).toBe(AVD_NAME);
    });

    test("an unreclaimable payload stays visible as an orphan instead of vanishing", async () => {
      await seedPendingOnOtherAvd();
      avdSnapshots.setLiveEmulator(OTHER_AVD, null);

      await captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" });

      expect(avdSnapshots.hasVmSnapshot(OTHER_AVD, "shared")).toBe(true);
      const listed = await listDeviceSnapshots();
      // The entry carries the directory the scanner actually resolved, so the
      // documented manual cleanup targets that path rather than assuming the
      // conventional one (#6891 review).
      expect(listed.orphanedAvdSnapshots.entries).toEqual([
        {
          avdName: OTHER_AVD,
          snapshotName: "shared",
          directoryPath: fakeAvdSnapshotPath(OTHER_AVD, "shared"),
          sizeBytes: 2 * 1024 * MB,
        },
      ]);
    });
  });

  test("in-AVD snapshot directories with no row are reported as orphans, never deleted", async () => {
    avdSnapshots.setVmSnapshot(AVD_NAME, "default_boot", 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "DEFAULT_BOOT", 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "emulator-5554_2026-08-11_23-05-15-803Z", 3 * 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "sweepSnap", 2 * 1024 * MB);

    const listed = await listDeviceSnapshots();

    expect(listed.orphanedAvdSnapshots.count).toBe(3);
    expect(listed.orphanedAvdSnapshots.totalSizeBytes).toBe(6 * 1024 * MB);
    expect(listed.orphanedAvdSnapshots.entries.map((entry) => entry.snapshotName).sort()).toEqual([
      "DEFAULT_BOOT",
      "emulator-5554_2026-08-11_23-05-15-803Z",
      "sweepSnap",
    ]);
    expect(listed.orphanedAvdSnapshots.entries.map((entry) => entry.snapshotName)).not.toContain(
      "default_boot",
    );
    // Report only: an orphan may predate AutoMobile or be user-made.
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "sweepSnap")).toBe(true);
  });
});

describe("orphan accounting is keyed by AVD and record type (#6891 review)", () => {
  const OTHER_AVD = "am-api34-ga-arm64";
  let fakeTimer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let avdSnapshots: FakeAvdSnapshotService;

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    avdSnapshots = new FakeAvdSnapshotService();
    await configRepository.setConfig({
      includeAppData: true,
      includeSettings: false,
      useVmSnapshot: true,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 12000,
      maxVmSnapshotsPerAvd: 3,
      maxArchiveSizeMb: 4096,
    });
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      avdSnapshots,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });
  });

  afterEach(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  async function insertRecord(
    snapshotName: string,
    deviceName: string,
    platform: "android" | "ios",
    snapshotType: "vm" | "archive",
  ): Promise<void> {
    const timestamp = new Date(1000).toISOString();
    await repository.insertSnapshot({
      snapshotName,
      deviceId: platform === "android" ? "emulator-5556" : "SIM-UUID",
      deviceName,
      platform,
      snapshotType,
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest: {
        snapshotName,
        timestamp,
        deviceId: platform === "android" ? "emulator-5556" : "SIM-UUID",
        deviceName,
        platform,
        snapshotType,
        includeAppData: true,
        includeSettings: false,
      },
    });
  }

  test("a vm record for another AVD does not hide an unrecorded directory of the same name", async () => {
    await insertRecord("shared", AVD_NAME, "android", "vm");
    avdSnapshots.setVmSnapshot(AVD_NAME, "shared", 1024 * MB);
    avdSnapshots.setVmSnapshot(OTHER_AVD, "shared", 3 * 1024 * MB);

    const listed = await listDeviceSnapshots();

    expect(listed.orphanedAvdSnapshots.entries).toEqual([
      {
        avdName: OTHER_AVD,
        snapshotName: "shared",
        directoryPath: fakeAvdSnapshotPath(OTHER_AVD, "shared"),
        sizeBytes: 3 * 1024 * MB,
      },
    ]);
  });

  test("a non-vm record of the same name does not account for an in-AVD directory", async () => {
    await insertRecord("mirror", AVD_NAME, "android", "archive");
    await insertRecord("sim-only", "iPhone 16", "ios", "archive");
    avdSnapshots.setVmSnapshot(AVD_NAME, "mirror", 2 * 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "sim-only", 1024 * MB);

    const listed = await listDeviceSnapshots();

    expect(listed.orphanedAvdSnapshots.count).toBe(2);
    expect(listed.orphanedAvdSnapshots.totalSizeBytes).toBe(3 * 1024 * MB);
  });
});

describe("reclaim never races a same-name capture (#6490 review)", () => {
  const MB_LOCAL = 1024 * 1024;
  let fakeTimer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let avdSnapshots: FakeAvdSnapshotService;

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    avdSnapshots = new FakeAvdSnapshotService();
    avdSnapshots.setLiveEmulator(AVD_NAME, EMULATOR.deviceId);
    await configRepository.setConfig({
      includeAppData: true,
      includeSettings: false,
      useVmSnapshot: true,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 12000,
      maxVmSnapshotsPerAvd: 3,
      maxArchiveSizeMb: 4096,
    });
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      avdSnapshots,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now() + 5000).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB_LOCAL);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
      createRestoreProvider: () => ({
        restore: async (args) => ({
          snapshotType: args.manifest.snapshotType,
          restoredAt: new Date(fakeTimer.now()).toISOString(),
        }),
      }),
    });
  });

  afterEach(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  async function seed(snapshotName: string, createdAtMs: number): Promise<void> {
    const timestamp = new Date(createdAtMs).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB_LOCAL);
    await repository.insertSnapshot({
      snapshotName,
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB_LOCAL,
      manifest: vmManifest(snapshotName, timestamp),
    });
  }

  test("eviction leaves alone a snapshot whose capture is still in flight", async () => {
    await seed("vm-inflight", 1000);
    await seed("vm-idle", 2000);

    // Hold the capture open AFTER its payload is saved and its row upserted —
    // the exact window in which eviction could delete the replacement it just
    // wrote while the capture still reports success.
    const replaceSnapshotData = store.replaceSnapshotData.bind(store);
    let releaseCapture = (): void => {};
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureReachedGate = (): void => {};
    const atGate = new Promise<void>((resolve) => {
      captureReachedGate = resolve;
    });
    (store as any).replaceSnapshotData = async (
      name: string,
      options: unknown,
      capture: () => Promise<unknown>,
    ) => {
      const result = await replaceSnapshotData(name, options, capture);
      captureReachedGate();
      await captureGate;
      return result;
    };

    const capturing = captureDeviceSnapshot(EMULATOR, { snapshotName: "vm-inflight" });
    await atGate;

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    releaseCapture();
    await expect(capturing).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect(evictedSnapshotNames).toEqual(["vm-idle"]);
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-idle"]);
    const survivor = await repository.getSnapshot("vm-inflight");
    expect(survivor?.sizeBytes).toBe(4 * 1024 * MB_LOCAL);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-inflight")).toBe(true);
  });

  test("eviction leaves alone a snapshot that is being restored", async () => {
    await seed("vm-restoring", 1000);
    await seed("vm-idle", 2000);

    // A restore reads its row, then awaits the provider for as long as the
    // emulator takes to load the VM state. Reclaim must not run inside that
    // window: the in-AVD payload being loaded would be console-deleted and its
    // row dropped while the restore still reports success (#6490 review).
    let releaseRestore = (): void => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreReachedGate = (): void => {};
    const atGate = new Promise<void>((resolve) => {
      restoreReachedGate = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          restoreReachedGate();
          await restoreGate;
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          };
        },
      }),
      deviceIncarnationInvalidator: {
        prepareForIncarnationChange: async () => undefined,
        invalidate: async () => undefined,
      },
    });

    const restoring = restoreDeviceSnapshot(EMULATOR, { snapshotName: "vm-restoring" });
    await atGate;

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    releaseRestore();
    await restoring;

    expect(evictedSnapshotNames).toEqual(["vm-idle"]);
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-idle"]);
    expect(await repository.getSnapshot("vm-restoring")).not.toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-restoring")).toBe(true);
  });

  test("eviction re-checks that the selected record is still the current one", async () => {
    await seed("vm-superseded", 1000);

    // A capture completes and upserts its replacement AFTER the eviction pass
    // has read its working list: the record in hand is now stale, and acting on
    // it would delete the fresh payload plus the row that describes it.
    const listSnapshots = repository.listSnapshots.bind(repository);
    let superseded = false;
    (repository as any).listSnapshots = async (query: Record<string, unknown> = {}) => {
      const rows = await listSnapshots(query as never);
      if (!superseded && query.orderByLastAccessed === "asc") {
        superseded = true;
        const timestamp = new Date(9000).toISOString();
        avdSnapshots.setVmSnapshot(AVD_NAME, "vm-superseded", 4 * 1024 * MB_LOCAL);
        await repository.insertSnapshot({
          snapshotName: "vm-superseded",
          deviceId: EMULATOR.deviceId,
          deviceName: AVD_NAME,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: new Date(1000).toISOString(),
          lastAccessedAt: timestamp,
          sizeBytes: 4 * 1024 * MB_LOCAL,
          manifest: vmManifest("vm-superseded", timestamp),
        });
      }
      return rows;
    };

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    expect(evictedSnapshotNames).toEqual([]);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    const survivor = await repository.getSnapshot("vm-superseded");
    expect(survivor?.sizeBytes).toBe(4 * 1024 * MB_LOCAL);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-superseded")).toBe(true);
  });

  test("eviction preserves a same-size same-type recapture with a fresh manifest timestamp", async () => {
    await seed("vm-superseded", 1000);

    // `insertSnapshot` preserves `createdAt`, and this recapture intentionally
    // keeps all the other identity fields identical. Only the capture-stamped
    // manifest timestamp can distinguish the replacement selected before this
    // retention pass reaches its per-name exclusivity check.
    const listSnapshots = repository.listSnapshots.bind(repository);
    const originalTimestamp = new Date(1000).toISOString();
    const replacementTimestamp = new Date(9000).toISOString();
    let superseded = false;
    (repository as any).listSnapshots = async (query: Record<string, unknown> = {}) => {
      const rows = await listSnapshots(query as never);
      if (!superseded && query.orderByLastAccessed === "asc") {
        superseded = true;
        await repository.insertSnapshot({
          snapshotName: "vm-superseded",
          deviceId: EMULATOR.deviceId,
          deviceName: AVD_NAME,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: replacementTimestamp,
          lastAccessedAt: originalTimestamp,
          sizeBytes: 2 * 1024 * MB_LOCAL,
          manifest: vmManifest("vm-superseded", replacementTimestamp),
        });
      }
      return rows;
    };

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    expect(superseded).toBe(true);
    expect(evictedSnapshotNames).toEqual([]);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(await repository.getSnapshot("vm-superseded")).toMatchObject({
      createdAt: originalTimestamp,
      lastAccessedAt: originalTimestamp,
      sizeBytes: 2 * 1024 * MB_LOCAL,
      manifest: { timestamp: replacementTimestamp },
    });
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-superseded")).toBe(true);
  });
});
