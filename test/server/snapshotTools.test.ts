import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceSnapshotManifest } from "../../src/models";
import { deviceSnapshotSchema, registerSnapshotTools } from "../../src/server/snapshotTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeTimer } from "../fakes/FakeTimer";

describe("snapshot tool", () => {
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let fakeTimer: FakeTimer;
  let captureCalls: Array<Record<string, unknown>>;
  let restoreCalls: Array<Record<string, unknown>>;

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
    expect(restoreCalls).toHaveLength(1);
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
