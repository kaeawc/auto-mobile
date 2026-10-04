import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceSnapshotManifest } from "../../src/models";
import type { RestoreSnapshotResult } from "../../src/features/action/RestoreSnapshot";
import {
  deviceSnapshotSchema,
  registerSnapshotTools,
  MAX_VM_SNAPSHOT_TIMEOUT_MS,
} from "../../src/server/snapshotTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonState } from "../../src/daemon/daemonState";
import { createDeviceRestoreEpochHarness } from "../helpers/deviceRestoreEpochHarness";
import { DefaultDeviceIncarnationInvalidator } from "../../src/server/DeviceIncarnationInvalidator";

isolateToolRegistry();

describe("snapshot tool", () => {
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let fakeTimer: FakeTimer;
  let captureCalls: Array<Record<string, unknown>>;
  let restoreCalls: Array<Record<string, unknown>>;
  let restoreFailures: NonNullable<RestoreSnapshotResult["failures"]>;
  let restoreOverrides: Partial<RestoreSnapshotResult>;

  const device: BootedDevice = {
    deviceId: "ios-device-1",
    name: "iPhone 15",
    platform: "ios",
  };

  beforeAll(async () => {
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    captureCalls = [];
    restoreCalls = [];
    restoreFailures = [];
    restoreOverrides = {};

    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
      createCaptureProvider: () => ({
        capture: async (args) => {
          captureCalls.push({ ...args });
          const timestamp = new Date(fakeTimer.now()).toISOString();
          const manifest: DeviceSnapshotManifest = {
            snapshotName: args.snapshotName,
            timestamp,
            deviceId: device.deviceId,
            deviceName: device.name,
            platform: device.platform,
            snapshotType: "app_data",
            includeAppData: args.includeAppData ?? true,
            includeSettings: false,
            appDataBackup: {
              backupMethod: "simctl_copy",
              totalPackages: args.appBundleIds?.length ?? 0,
              backedUpPackages: args.appBundleIds ?? [],
              skippedPackages: [],
              failedPackages: [],
              bundleStatuses: (args.appBundleIds ?? []).map((bundleId) => ({
                bundleId,
                status: "captured" as const,
              })),
            },
          };
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "app_data",
            manifest,
          };
        },
      }),
      createRestoreProvider: () => ({
        restore: async (args) => {
          restoreCalls.push({ ...args });
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
            success: restoreFailures.length === 0,
            failures: restoreFailures,
            ...restoreOverrides,
          };
        },
      }),
    });

    if (!ToolRegistry.getTool("deviceSnapshot")) {
      registerSnapshotTools();
    }
  });

  beforeEach(() => {
    captureCalls = [];
    restoreCalls = [];
    restoreFailures = [];
    restoreOverrides = {};
  });

  afterAll(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  test("requires snapshotName when action is restore", () => {
    const result = deviceSnapshotSchema.safeParse({
      action: "restore",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["snapshotName"]);
      expect(result.error.issues[0].message).toBe(
        "snapshotName is required when action is restore",
      );
    }
  });

  test("rejects empty snapshotName when provided", () => {
    for (const action of ["capture", "restore"] as const) {
      const result = deviceSnapshotSchema.safeParse({
        action,
        snapshotName: "",
      });

      expect(result.success).toBe(false);
    }
  });

  test("keeps generated tool definition free of top-level combinators", () => {
    const toolDefinition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "deviceSnapshot",
    );

    expect(toolDefinition).toBeDefined();
    const schema = toolDefinition!.inputSchema as any;
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action.enum).toEqual(["capture", "restore"]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });

  test("captures snapshot and returns payload", async () => {
    const tool = ToolRegistry.getTool("deviceSnapshot");
    expect(tool?.deviceAwareHandler).toBeDefined();

    const response = await tool!.deviceAwareHandler!(device, {
      action: "capture",
      snapshotName: "snapshot-1",
      includeAppData: true,
      appBundleIds: ["com.example.app"],
    });

    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
    expect(payload.snapshotName).toBe("snapshot-1");
    expect(payload.snapshotType).toBe("app_data");
    expect(payload.message).toContain("captured successfully");
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]?.appBundleIds).toEqual(["com.example.app"]);
    // AC2: per-bundle status is surfaced at the top level of the tool result,
    // not only nested inside the manifest.
    expect(payload.bundleStatuses).toEqual([{ bundleId: "com.example.app", status: "captured" }]);
    expect(payload.manifest.appDataBackup.bundleStatuses).toEqual([
      { bundleId: "com.example.app", status: "captured" },
    ]);
  });

  test("restores snapshot and returns payload", async () => {
    const tool = ToolRegistry.getTool("deviceSnapshot");
    expect(tool?.deviceAwareHandler).toBeDefined();

    const manifest: DeviceSnapshotManifest = {
      snapshotName: "snapshot-restore",
      timestamp: new Date(fakeTimer.now()).toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: device.platform,
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
    };

    await repository.insertSnapshot({
      snapshotName: "snapshot-restore",
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: device.platform,
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });

    const response = await tool!.deviceAwareHandler!(device, {
      action: "restore",
      snapshotName: "snapshot-restore",
    });

    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
    expect(payload.snapshotName).toBe("snapshot-restore");
    expect(payload.snapshotType).toBe("app_data");
    expect(payload.message).toContain("restored successfully");
    expect(payload.success).toBe(true);
    expect(payload.failures).toEqual([]);
    expect(restoreCalls).toHaveLength(1);
    expect(payload).not.toHaveProperty("deviceSessionUuid");
  });

  test("VM restore tool returns the new device-session UUID", async () => {
    const emulator: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel",
      platform: "android",
    };
    await createDeviceRestoreEpochHarness(emulator, fakeTimer);
    try {
      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName: "tool-epoch",
        timestamp,
        deviceId: emulator.deviceId,
        deviceName: emulator.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        ...manifest,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 0,
        manifest,
      });
      await setDeviceSnapshotManagerDependencies({
        deviceIncarnationInvalidator: new DefaultDeviceIncarnationInvalidator([]),
      });
      const response = await ToolRegistry.getTool("deviceSnapshot")!.deviceAwareHandler!(emulator, {
        action: "restore",
        snapshotName: manifest.snapshotName,
        useVmSnapshot: true,
      });
      expect(JSON.parse(response.content?.[0]?.text ?? "{}").deviceSessionUuid).toBe("epoch-new");
    } finally {
      DaemonState.getInstance().reset();
    }
  });

  test("surfaces settings-only mode and VM degradation note", async () => {
    const timestamp = new Date(fakeTimer.now()).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "degraded-vm-restore",
      timestamp,
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: device.platform,
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: true,
    };
    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest,
    });
    restoreOverrides = {
      snapshotType: "adb",
      restoreMode: "settings_only",
      restoreNote: "VM state was not restored; only captured Android settings were applied.",
    };

    const tool = ToolRegistry.getTool("deviceSnapshot");
    const response = await tool!.deviceAwareHandler!(device, {
      action: "restore",
      snapshotName: manifest.snapshotName,
    });
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    expect(payload.snapshotType).toBe("adb");
    expect(payload.restoreMode).toBe("settings_only");
    expect(payload.restoreNote).toContain("VM state was not restored");
  });

  test("reports a partial restore and its failed items", async () => {
    const tool = ToolRegistry.getTool("deviceSnapshot");
    const snapshotName = "snapshot-partial-restore";
    const timestamp = new Date(fakeTimer.now()).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp,
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: device.platform,
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
    };
    await repository.insertSnapshot({
      snapshotName,
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: device.platform,
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest,
    });
    restoreFailures = [{ kind: "ios_bundle", bundleId: "com.example.app", reason: "copy denied" }];

    const response = await tool!.deviceAwareHandler!(device, { action: "restore", snapshotName });
    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    expect(payload.message).toContain("partially restored");
    expect(payload.message).not.toContain("restored successfully");
    expect(payload.success).toBe(false);
    expect(payload.failures).toEqual(restoreFailures);
  });

  test("rejects restore without snapshotName", async () => {
    const tool = ToolRegistry.getTool("deviceSnapshot");
    expect(tool?.deviceAwareHandler).toBeDefined();

    await expect(
      tool!.deviceAwareHandler!(device, {
        action: "restore",
      } as any),
    ).rejects.toThrow("snapshotName is required");
  });
});

describe("VM snapshot timeout validation", () => {
  for (const action of ["capture", "restore"] as const) {
    test.each([-1, 0, 1.5, MAX_VM_SNAPSHOT_TIMEOUT_MS + 1, NaN, Infinity, -Infinity])(
      `${action} rejects invalid timeout %s`,
      (vmSnapshotTimeoutMs) => {
        expect(
          deviceSnapshotSchema.safeParse({ action, snapshotName: "timeout", vmSnapshotTimeoutMs })
            .success,
        ).toBe(false);
      },
    );

    test.each([undefined, 1, 30000, MAX_VM_SNAPSHOT_TIMEOUT_MS])(
      `${action} accepts valid or omitted timeout %s`,
      (vmSnapshotTimeoutMs) => {
        expect(
          deviceSnapshotSchema.safeParse({ action, snapshotName: "timeout", vmSnapshotTimeoutMs })
            .success,
        ).toBe(true);
      },
    );
  }
});
