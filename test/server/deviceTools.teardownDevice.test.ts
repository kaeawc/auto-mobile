import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  type ActiveVideoRecording,
} from "../../src/features/video";
import type {
  BootedDevice,
  DeviceInfo,
  SomePlatform,
  VideoRecordingMetadata,
} from "../../src/models";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setSegmentedSessionRecordingDependencies,
  setSegmentedSessionTimer,
} from "../../src/server/videoRecordingTools";
import type { ProvisionDeviceOperationStore } from "../../src/db/provisionDeviceOperationRepository";
import type { BootedDeviceDiscovery, DeviceDestroyOptions } from "../../src/utils/deviceUtils";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceTeardownOperationStore } from "../fakes/FakeDeviceTeardownOperationStore";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";

class FakeDeviceSessionRepository extends DeviceSessionRepository {
  override async upsertActiveSession(): Promise<void> {}
  override async getSession(): Promise<undefined> {
    return undefined;
  }
  override async markReleased(): Promise<void> {}
  override async recordActivity(): Promise<void> {}
}

interface DestroyRequest {
  device: DeviceInfo;
  options?: DeviceDestroyOptions;
}

class TeardownDeviceManager extends FakeDeviceUtils {
  readonly destroyRequests: DestroyRequest[] = [];
  readonly killedDevices: BootedDevice[] = [];
  destroyError?: Error;
  killError?: Error;
  replacementAfterKill?: BootedDevice;
  killGate?: Promise<void>;
  killStarted?: () => void;
  destroyGate?: Promise<void>;
  destroyStarted?: () => void;
  private readonly destroyedIdentities = new Set<string>();

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killedDevices.push(device);
    this.killStarted?.();
    await this.killGate;
    this.setBootedDevices(
      device.platform,
      this.replacementAfterKill ? [this.replacementAfterKill] : [],
    );
    if (this.killError) {
      throw this.killError;
    }
    await super.killDevice(device);
  }

  override async destroyDevice(device: DeviceInfo, options?: DeviceDestroyOptions): Promise<void> {
    this.destroyRequests.push({ device, options });
    this.destroyStarted?.();
    await this.destroyGate;
    if (this.destroyError) {
      throw this.destroyError;
    }
    this.destroyedIdentities.add(this.inventoryIdentity(device));
  }

  override async listDeviceImages(platform: SomePlatform): Promise<DeviceInfo[]> {
    return (await super.listDeviceImages(platform)).filter(
      (device) => !this.destroyedIdentities.has(this.inventoryIdentity(device)),
    );
  }

  private inventoryIdentity(device: Pick<DeviceInfo, "platform" | "name" | "deviceId">): string {
    return device.platform === "ios"
      ? `${device.platform}:${device.deviceId ?? device.name}`
      : `${device.platform}:${device.name}`;
  }
}

function teardownTool() {
  const tool = ToolRegistry.getTool("deleteDevice");
  if (!tool) {
    throw new Error("deleteDevice not registered");
  }
  return tool;
}

function getAppleTool() {
  const tool = ToolRegistry.getTool("getApple");
  if (!tool) {
    throw new Error("getApple not registered");
  }
  return tool;
}

function startDeviceTool() {
  const tool = ToolRegistry.getTool("startDevice");
  if (!tool) {
    throw new Error("startDevice not registered");
  }
  return tool;
}

function provisionDeviceTool() {
  const tool = ToolRegistry.getTool("provisionDevice");
  if (!tool) {
    throw new Error("provisionDevice not registered");
  }
  return tool;
}

function responseBody(response: unknown): Record<string, unknown> {
  const content = (response as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function request(
  platform: "android" | "ios",
  stableId: string,
  stableName?: string,
  isVirtual: true = true,
) {
  return {
    operationId: "35e6f783-b794-47b8-b8a1-8619677820f0",
    target: {
      platform,
      isVirtual,
      stableId,
      ...(stableName ? { stableName } : {}),
    },
    mode: "destroy",
    verifyAbsence: true,
    timeoutMs: 60_000,
  };
}

describe("deleteDevice handler", () => {
  let manager: TeardownDeviceManager;
  let teardownOperationStore: FakeDeviceTeardownOperationStore;

  beforeEach(async () => {
    DaemonState.getInstance().reset();
    manager = new TeardownDeviceManager();
    teardownOperationStore = new FakeDeviceTeardownOperationStore();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: {
        listRecordings: async () => [],
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      teardownDeviceOperationStoreFactory: () => teardownOperationStore,
      timer: new FakeTimer(),
    });
    registerDeviceTools();
  });

  afterEach(() => {
    clearDirectSessionDevices();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    DaemonState.getInstance().reset();
  });

  test("stops, destroys, and proves a booted iOS simulator is durably absent", async () => {
    const device: BootedDevice = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
    };
    manager.setBootedDevices("ios", [device]);
    manager.setDeviceImages("ios", [
      {
        ...device,
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(request("ios", device.deviceId, device.name));
    const body = responseBody(response);

    expect(body.state).toBe("destroyed");
    expect(body.command).toEqual({
      stop: "accepted",
      destroy: "accepted",
    });
    expect(body.verification).toEqual({
      notRunning: "confirmed",
      inventory: "complete_absence_confirmed",
    });
    expect(manager.wasMethodCalled("killDevice")).toBe(true);
    expect(manager.destroyRequests).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({
          platform: "ios",
          name: device.name,
          deviceId: device.deviceId,
        }),
      }),
    ]);
  });

  // #6250: delete-by-name on iOS (where the caller's identifier is the
  // simulator's display name, not its UDID) must resolve to the real device
  // and destroy it, never falsely report already_absent while it still lists.
  test("resolves an iOS delete-by-name (name != UDID) to the real device and destroys it", async () => {
    const device: BootedDevice = {
      platform: "ios",
      name: "am-sweep-sim",
      deviceId: "466A9467-CD90-41F3-902B-DC1625471C77",
    };
    manager.setBootedDevices("ios", [device]);
    manager.setDeviceImages("ios", [{ ...device, isRunning: true }]);

    // stableId is the device NAME here, exactly like the issue's repro
    // (no stableName supplied, and no UDID supplied at all).
    const response = await teardownTool().handler(request("ios", device.name));
    const body = responseBody(response);

    expect(body.state).toBe("destroyed");
    expect(body.command).toEqual({ stop: "accepted", destroy: "accepted" });
    expect(body.verification).toEqual({
      notRunning: "confirmed",
      inventory: "complete_absence_confirmed",
    });
    expect(manager.wasMethodCalled("killDevice")).toBe(true);
    expect(manager.destroyRequests).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({
          platform: "ios",
          name: device.name,
          deviceId: device.deviceId,
        }),
      }),
    ]);
  });

  test("resolves an unbooted iOS delete-by-name (name != UDID) via inventory and destroys it", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "am-sweep-sim",
      deviceId: "466A9467-CD90-41F3-902B-DC1625471C77",
      isRunning: false,
    };
    manager.setDeviceImages("ios", [device]);

    const response = await teardownTool().handler(request("ios", device.name));
    const body = responseBody(response);

    expect(body.state).toBe("destroyed");
    expect(manager.destroyRequests).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({
          platform: "ios",
          name: device.name,
          deviceId: device.deviceId,
        }),
      }),
    ]);
  });

  test("does not report already_absent for an iOS delete-by-name while the device still lists", async () => {
    const device: BootedDevice = {
      platform: "ios",
      name: "am-sweep-sim",
      deviceId: "466A9467-CD90-41F3-902B-DC1625471C77",
    };
    manager.setBootedDevices("ios", [device]);
    manager.setDeviceImages("ios", [{ ...device, isRunning: true }]);

    const response = await teardownTool().handler(request("ios", device.name));
    const body = responseBody(response);

    expect(body.state).not.toBe("already_absent");
  });

  test("still reports already_absent for a genuinely absent iOS device looked up by name", async () => {
    // A different device exists, but nothing matches the requested name by
    // either UDID or display name — this must remain a true absence, not a
    // false positive from an unrelated device being present.
    manager.setBootedDevices("ios", []);
    manager.setDeviceImages("ios", [
      { platform: "ios", name: "some-other-sim", deviceId: "OTHER-UDID", isRunning: false },
    ]);

    const response = await teardownTool().handler(request("ios", "totally-unknown-sim"));
    const body = responseBody(response);

    expect(body.state).toBe("already_absent");
    expect(body.command).toEqual({ stop: "not_required", destroy: "not_required" });
    expect(manager.destroyRequests).toEqual([]);
  });

  test("finalizes a segmented recording before deleting its booted Android AVD", async () => {
    const device: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5556",
    };
    const segmentedTimer = new FakeTimer();
    const events: string[] = [];
    const segmentStarts: string[] = [];
    const segmentStops: string[] = [];
    const archiveRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "auto-mobile-teardown-segment-"),
    );

    try {
      manager.setBootedDevices("android", [device]);
      manager.setDeviceImages("android", [{ ...device, isRunning: true }]);
      manager.destroyStarted = () => events.push("destroyed");
      resetSegmentedSessions();
      setSegmentedSessionTimer(segmentedTimer);
      setSegmentedSessionRecordingDependencies({
        startVideoRecording: async (request): Promise<ActiveVideoRecording> => {
          const recordingId = request.outputName ?? "segment";
          segmentStarts.push(recordingId);
          return {
            recordingId,
            outputPath: path.join(archiveRoot, `${recordingId}.mp4`),
            fileName: `${recordingId}.mp4`,
            startedAt: new Date(0).toISOString(),
            outputName: request.outputName,
            config: DEFAULT_VIDEO_RECORDING_CONFIG,
          };
        },
        stopVideoRecording: async (
          recordingId,
        ): Promise<{
          metadata: VideoRecordingMetadata;
          evictedRecordingIds: string[];
        }> => {
          const id = recordingId ?? "segment";
          events.push("recording-stopped");
          segmentStops.push(id);
          return {
            metadata: {
              recordingId: id,
              fileName: `${id}.mp4`,
              filePath: path.join(archiveRoot, `${id}.mp4`),
              format: "mp4",
              sizeBytes: 1,
              codec: "h264",
              createdAt: new Date(0).toISOString(),
              startedAt: new Date(0).toISOString(),
              lastAccessedAt: new Date(0).toISOString(),
              config: DEFAULT_VIDEO_RECORDING_CONFIG,
            },
            evictedRecordingIds: [],
          };
        },
      });
      if (!ToolRegistry.getTool("videoRecording")) {
        registerVideoRecordingTools();
      }
      const recordingHandler = ToolRegistry.getTool("videoRecording")?.deviceAwareHandler;
      if (!recordingHandler) {
        throw new Error("videoRecording tool not registered");
      }

      await recordingHandler(device, {
        action: "start",
        platform: "android",
        deviceId: device.deviceId,
        maxDuration: 300,
        outputName: "teardown-video",
      });
      expect(segmentedTimer.getPendingTimeoutCount()).toBe(2);

      const response = responseBody(await teardownTool().handler(request("android", device.name)));

      expect(response.state).toBe("destroyed");
      expect(segmentStops).toEqual(["teardown-video"]);
      expect(events).toEqual(["recording-stopped", "destroyed"]);
      expect(segmentedTimer.getPendingTimeoutCount()).toBe(0);

      segmentedTimer.advanceTime(1_000_000);
      await Promise.resolve();
      expect(segmentStarts).toEqual(["teardown-video"]);
    } finally {
      await fsPromises.rm(archiveRoot, { recursive: true, force: true });
    }
  });

  test("resumes a cancelled stop-and-destroy after the target is already shut down", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    manager.setDeviceImages("ios", [device]);

    const response = await teardownTool().handler(request("ios", device.deviceId!, device.name));
    const body = responseBody(response);

    expect(body.state).toBe("destroyed");
    expect(body.command).toEqual({
      stop: "not_required",
      destroy: "accepted",
    });
    expect(manager.wasMethodCalled("killDevice")).toBe(false);
    expect(manager.destroyRequests).toEqual([expect.objectContaining({ device })]);
  });

  test("clears direct session ownership after destroying an already-stopped simulator", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    manager.setDeviceImages("ios", [device]);
    registerDirectSessionDevice("direct-session", {
      platform: "ios",
      name: device.name,
      deviceId: device.deviceId!,
    });

    await teardownTool().handler(request("ios", device.deviceId!, device.name));

    expect(resolveDirectSessionDevice("direct-session")).toBeUndefined();
  });

  test("clears direct session ownership after destroying an already-stopped Android AVD", async () => {
    const device: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    manager.setDeviceImages("android", [device]);
    registerDirectSessionDevice("direct-session", {
      platform: "android",
      name: device.name,
      deviceId: "emulator-5556",
    });

    await teardownTool().handler(request("android", device.name, device.name));

    expect(resolveDirectSessionDevice("direct-session")).toBeUndefined();
  });

  test("preserves a physical Android session with the same name as a destroyed AVD", async () => {
    const device: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    const physicalDevice: BootedDevice = {
      platform: "android",
      name: device.name,
      deviceId: "R5CT123456A",
    };
    manager.setDeviceImages("android", [device]);
    registerDirectSessionDevice("physical-session", physicalDevice);

    await teardownTool().handler(request("android", device.name, device.name));

    expect(resolveDirectSessionDevice("physical-session")).toEqual({
      sessionUuid: "physical-session",
      device: physicalDevice,
      incarnation: expect.any(Number),
    });
  });

  test("retires pooled ownership after destroying an already-stopped simulator", async () => {
    const timer = new FakeTimer();
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const sessionManager = new SessionManager(timer, deviceSessionRepository);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const bootedDevice: BootedDevice = { ...device, deviceId: device.deviceId! };
    manager.setBootedDevices("ios", [bootedDevice]);
    await pool.addDevice(bootedDevice, device);
    await pool.assignMultipleDevices(["session-1"], 1_000, "ios");
    manager.setBootedDevices("ios", []);
    manager.setDeviceImages("ios", [device]);

    const response = await teardownTool().handler(request("ios", device.deviceId!, device.name));

    expect(responseBody(response).state).toBe("destroyed");
    expect(pool.getDevice(device.deviceId!)).toBeNull();
    expect(sessionManager.getSessionForDevice(device.deviceId!)).toBeNull();
  });

  test("stops recordings for a pooled simulator that was already stopped", async () => {
    const timer = new FakeTimer();
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const sessionManager = new SessionManager(timer, deviceSessionRepository);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const bootedDevice: BootedDevice = { ...device, deviceId: device.deviceId! };
    manager.setBootedDevices("ios", [bootedDevice]);
    await pool.addDevice(bootedDevice, device);
    await pool.assignMultipleDevices(["session-1"], 1_000, "ios");
    manager.setBootedDevices("ios", []);
    manager.setDeviceImages("ios", [device]);
    const stoppedRecordingIds: string[] = [];
    let recordingListCalls = 0;
    const recordingFilters: Array<{
      status?: string;
      deviceId?: string;
      platform?: "android" | "ios";
    }> = [];
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {
        stopRecording: async (recordingId: string) => {
          stoppedRecordingIds.push(recordingId);
          throw new Error("recording process already exited");
        },
      } as never,
      recordingRepository: {
        listRecordings: async (filter: {
          status?: string;
          deviceId?: string;
          platform?: "android" | "ios";
        }) => {
          recordingFilters.push(filter);
          recordingListCalls++;
          return recordingListCalls === 1 ? [] : [{ recordingId: "recording-1" }];
        },
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });

    const response = await teardownTool().handler(request("ios", device.deviceId!, device.name));
    const body = responseBody(response);

    expect(body).toMatchObject({ state: "destroyed" });
    expect(recordingFilters).toContainEqual({
      status: "recording",
      deviceId: device.deviceId,
      platform: device.platform,
    });
    expect(stoppedRecordingIds).toEqual(["recording-1"]);
  });

  test("retires pooled ownership when a booted simulator stops before teardown kills it", async () => {
    const timer = new FakeTimer();
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: true,
    };
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const sessionManager = new SessionManager(timer, deviceSessionRepository);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const bootedDevice: BootedDevice = { ...device, deviceId: device.deviceId! };
    manager.setBootedDevices("ios", [bootedDevice]);
    manager.setDeviceImages("ios", [device]);
    await pool.addDevice(bootedDevice, device);
    await pool.assignMultipleDevices(["session-1"], 1_000, "ios");
    manager.killError = new Error("The device is already shut down.");

    const response = await teardownTool().handler(request("ios", device.deviceId!, device.name));

    expect(responseBody(response).state).toBe("destroyed");
    expect(pool.getDevice(device.deviceId!)).toBeNull();
    expect(sessionManager.getSessionForDevice(device.deviceId!)).toBeNull();
  });

  test("reports already_absent only after a complete platform inventory finds no target", async () => {
    const response = await teardownTool().handler(request("ios", "IOS-DEVICE-1", "iPhone 16"));
    const body = responseBody(response);

    expect(body.state).toBe("already_absent");
    expect(body.command).toEqual({
      stop: "not_required",
      destroy: "not_required",
    });
    expect(body.verification).toEqual({
      notRunning: "confirmed",
      inventory: "complete_absence_confirmed",
    });
    expect(manager.wasMethodCalled("killDevice")).toBe(false);
    expect(manager.destroyRequests).toEqual([]);
  });

  test("retires pooled and direct ownership before reporting an absent simulator", async () => {
    const timer = new FakeTimer();
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const sessionManager = new SessionManager(timer, deviceSessionRepository);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const bootedDevice: BootedDevice = { ...device, deviceId: device.deviceId! };
    manager.setBootedDevices("ios", [bootedDevice]);
    await pool.addDevice(bootedDevice, device);
    await pool.assignMultipleDevices(["session-1"], 1_000, "ios");
    registerDirectSessionDevice("direct-session", bootedDevice);
    manager.setBootedDevices("ios", []);
    manager.setDeviceImages("ios", []);

    const response = await teardownTool().handler(request("ios", device.deviceId!, device.name));

    expect(responseBody(response).state).toBe("already_absent");
    expect(pool.getDevice(device.deviceId!)).toBeNull();
    expect(sessionManager.getSessionForDevice(device.deviceId!)).toBeNull();
    expect(resolveDirectSessionDevice("direct-session")).toBeUndefined();
  });

  test("retires every stale pooled Android incarnation before reporting an absent AVD", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionRepository());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const image: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    const first: BootedDevice = {
      platform: "android",
      name: image.name,
      deviceId: "emulator-5554",
    };
    const second: BootedDevice = {
      platform: "android",
      name: image.name,
      deviceId: "emulator-5556",
    };
    await pool.addDevice(first, image);
    await pool.addDevice(second, image);
    DaemonState.getInstance().initialize(sessionManager, pool);
    manager.setBootedDevices("android", []);
    manager.setDeviceImages("android", []);

    const response = await teardownTool().handler(request("android", image.name, image.name));

    expect(responseBody(response).state).toBe("already_absent");
    expect(pool.getDevice(first.deviceId)).toBeNull();
    expect(pool.getDevice(second.deviceId)).toBeNull();
  });

  test("retires every stale pooled Android incarnation before deleting a stopped AVD", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionRepository());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    const image: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    const first: BootedDevice = {
      platform: "android",
      name: image.name,
      deviceId: "emulator-5554",
    };
    const second: BootedDevice = {
      platform: "android",
      name: image.name,
      deviceId: "emulator-5556",
    };
    await pool.addDevice(first, image);
    await pool.addDevice(second, image);
    DaemonState.getInstance().initialize(sessionManager, pool);
    manager.setBootedDevices("android", []);
    manager.setDeviceImages("android", [image]);

    const response = await teardownTool().handler(request("android", image.name, image.name));

    expect(responseBody(response).state).toBe("destroyed");
    expect(pool.getDevice(first.deviceId)).toBeNull();
    expect(pool.getDevice(second.deviceId)).toBeNull();
  });

  test("does not report already_absent when a platform inventory is incomplete", async () => {
    manager.failedPlatforms.add("ios");

    const response = await teardownTool().handler(request("ios", "IOS-DEVICE-1", "iPhone 16"));
    const body = responseBody(response);

    expect(body.state).toBe("failed");
    expect(body.failure).toEqual(
      expect.objectContaining({
        code: "inventory_incomplete",
        phase: "precondition",
      }),
    );
    expect(manager.destroyRequests).toEqual([]);
  });

  test("proves Android absence without requiring unavailable iOS inventory", async () => {
    manager.failedPlatforms.add("ios");
    manager.clearHistory();

    const response = await teardownTool().handler(
      request("android", "Pixel_8_API_35", "Pixel_8_API_35"),
    );
    const body = responseBody(response);

    expect(body.state).toBe("already_absent");
    expect(body.target).toEqual(expect.objectContaining({ platform: "android" }));
    expect(manager.getExecutedOperations()).toContain("getBootedDevices:android");
    expect(manager.getExecutedOperations()).not.toContain("getBootedDevices:ios");
  });

  test("uses the booted-resource Android stable ID instead of its transient serial", async () => {
    const device: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5556",
      transportId: "7",
    };
    manager.setBootedDevices("android", [device]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: "Pixel_8_API_35",
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(request("android", device.name));
    const body = responseBody(response);

    expect(body.state).toBe("destroyed");
    expect(manager.wasMethodCalled("killDevice")).toBe(true);
    expect(manager.killedDevices).toEqual([
      expect.objectContaining({
        transportId: device.transportId,
      }),
    ]);
    expect(manager.destroyRequests).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({
          platform: "android",
          name: device.name,
        }),
      }),
    ]);
  });

  test("uses a pooled AVD name when the booted Android runtime name is unavailable", async () => {
    const timer = new FakeTimer();
    const stableAvdName = "Pixel_8_API_35";
    const booted: BootedDevice = {
      platform: "android",
      name: "Unknown (emulator-5556)",
      deviceId: "emulator-5556",
      transportId: "42",
    };
    const image: DeviceInfo = {
      platform: "android",
      name: stableAvdName,
      isRunning: true,
    };
    const sessionManager = new SessionManager(timer);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.addDevice(booted, image);
    manager.setBootedDevices("android", [booted]);
    manager.setDeviceImages("android", [image]);

    const response = await teardownTool().handler(request("android", stableAvdName, stableAvdName));
    const body = responseBody(response);

    expect(body.state).toBe("destroyed");
    expect(manager.wasMethodCalled("killDevice")).toBe(true);
    expect(manager.destroyRequests).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({
          platform: "android",
          name: stableAvdName,
        }),
      }),
    ]);
  });

  test("does not stop a freshly discovered AVD that replaced stale same-serial pool state", async () => {
    const timer = new FakeTimer();
    const staleAvdName = "Pixel_8_Old";
    const replacement: BootedDevice = {
      platform: "android",
      name: "Pixel_8_New",
      deviceId: "emulator-5556",
      transportId: "43",
    };
    const sessionManager = new SessionManager(timer);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.addDevice(
      {
        ...replacement,
        name: "Unknown (emulator-5556)",
        transportId: "42",
      },
      { platform: "android", name: staleAvdName, isRunning: true },
    );
    manager.setBootedDevices("android", [replacement]);
    manager.setDeviceImages("android", [
      { platform: "android", name: staleAvdName, isRunning: false },
      { platform: "android", name: replacement.name, isRunning: true },
    ]);

    const response = responseBody(
      await teardownTool().handler(request("android", staleAvdName, staleAvdName)),
    );

    expect(response.state).toBe("destroyed");
    expect(manager.wasMethodCalled("killDevice")).toBe(false);
    expect(manager.destroyRequests).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({ name: staleAvdName }),
      }),
    ]);
  });

  test("rejects a stopped-image teardown when a running Android AVD name is unresolved", async () => {
    const booted: BootedDevice = {
      platform: "android",
      name: "Unknown (emulator-5556)",
      deviceId: "emulator-5556",
    };
    manager.setBootedDevices("android", [booted]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: "Pixel_8_API_35",
        isRunning: false,
      },
    ]);

    const response = await teardownTool().handler(
      request("android", "Pixel_8_API_35", "Pixel_8_API_35"),
    );
    const body = responseBody(response);

    expect(body.state).toBe("failed");
    expect(body.failure).toEqual(
      expect.objectContaining({
        code: "target_identity_unresolved",
        phase: "precondition",
      }),
    );
    expect(manager.wasMethodCalled("killDevice")).toBe(false);
    expect(manager.destroyRequests).toEqual([]);
  });

  test("does not let an unrelated unknown Android runtime block a resolved target", async () => {
    const target: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
    };
    manager.setBootedDevices("android", [
      target,
      {
        platform: "android",
        name: "Unknown (emulator-5556)",
        deviceId: "emulator-5556",
      },
    ]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: target.name,
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(request("android", target.name, target.name));

    expect(responseBody(response).state).toBe("destroyed");
    expect(manager.killedDevices).toEqual([
      expect.objectContaining({
        deviceId: target.deviceId,
        name: target.name,
      }),
    ]);
  });

  test("refuses Android AVD deletion after the stable target restarts on another serial", async () => {
    const device: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      transportId: "1",
    };
    manager.replacementAfterKill = {
      ...device,
      deviceId: "emulator-5556",
      transportId: "2",
    };
    manager.setBootedDevices("android", [device]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: device.name,
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(request("android", device.name, device.name));
    const body = responseBody(response);

    expect(body.state).toBe("failed");
    expect(body.failure).toEqual(
      expect.objectContaining({
        phase: "stop",
        code: "target_restarted",
      }),
    );
    expect(manager.destroyRequests).toEqual([]);
  });

  test("fails closed when a new Android runtime appears without a resolvable AVD name", async () => {
    const device: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      transportId: "1",
    };
    manager.replacementAfterKill = {
      ...device,
      name: "Unknown (emulator-5556)",
      deviceId: "emulator-5556",
      transportId: "2",
    };
    manager.setBootedDevices("android", [device]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: device.name,
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(request("android", device.name, device.name));

    expect(responseBody(response).failure).toEqual(
      expect.objectContaining({
        phase: "stop",
        code: "target_identity_unresolved",
      }),
    );
    expect(manager.destroyRequests).toEqual([]);
  });

  test("fails closed when an unresolved Android replacement reuses the target serial", async () => {
    const device: BootedDevice = {
      platform: "android",
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      transportId: "1",
    };
    manager.replacementAfterKill = {
      ...device,
      name: "Unknown (emulator-5554)",
      transportId: "2",
    };
    manager.setBootedDevices("android", [device]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: device.name,
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(request("android", device.name, device.name));

    expect(responseBody(response).failure).toEqual(
      expect.objectContaining({
        phase: "stop",
        code: "target_identity_unresolved",
      }),
    );
    expect(manager.destroyRequests).toEqual([]);
  });

  test("does not delete an AVD when stableId and stableName identify different targets", async () => {
    manager.setBootedDevices("android", [
      {
        platform: "android",
        name: "Pixel_8_API_35",
        deviceId: "emulator-5556",
      },
    ]);
    manager.setDeviceImages("android", [
      {
        platform: "android",
        name: "Pixel_8_API_35",
        isRunning: true,
      },
    ]);

    const response = await teardownTool().handler(
      request("android", "Pixel_7_API_34", "Pixel_8_API_35"),
    );
    const body = responseBody(response);

    expect(body.state).toBe("already_absent");
    expect(manager.wasMethodCalled("killDevice")).toBe(false);
    expect(manager.destroyRequests).toEqual([]);
  });

  test("rejects a stopped simulator whose stable name no longer matches", async () => {
    manager.setDeviceImages("ios", [
      {
        platform: "ios",
        name: "Renamed iPhone",
        deviceId: "IOS-DEVICE-1",
        isRunning: false,
      },
    ]);

    const response = await teardownTool().handler(request("ios", "IOS-DEVICE-1", "iPhone 16"));
    const body = responseBody(response);

    expect(body.state).toBe("failed");
    expect(body.failure).toEqual(
      expect.objectContaining({
        code: "target_identity_conflict",
        phase: "precondition",
      }),
    );
    expect(manager.destroyRequests).toEqual([]);
  });

  test("holds the stable target reservation until deletion verification completes", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);

    const teardown = teardownTool().handler(request("ios", device.deviceId!, device.name));
    await destroyStarted;
    manager.clearHistory();

    const start = getAppleTool().handler({
      udid: device.deviceId,
      bootTimeoutMs: 30_000,
      automationReadyTimeoutMs: 30_000,
    });
    let startSettled = false;
    void start.then(
      () => {
        startSettled = true;
      },
      () => {
        startSettled = true;
      },
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(startSettled).toBe(false);
    expect(manager.getExecutedOperations()).toEqual([]);

    releaseDestroy();
    await teardown;
    await expect(start).rejects.toThrow(/not found/);
    expect(manager.wasMethodCalled("getBootedDevices")).toBe(true);
  });

  test("retains the stable target reservation after deletion times out until the command settles", async () => {
    const timer = new FakeTimer();
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);
    setDeviceToolsDependencies({ timer });

    const teardown = teardownTool().handler({
      ...request("ios", device.deviceId!, device.name),
      timeoutMs: 10,
    });
    await destroyStarted;
    timer.advanceTime(10);

    expect(responseBody(await teardown).failure).toEqual(
      expect.objectContaining({
        phase: "destroy",
        code: "operation_failed",
      }),
    );

    manager.clearHistory();
    const start = getAppleTool().handler({
      udid: device.deviceId,
      bootTimeoutMs: 30_000,
      automationReadyTimeoutMs: 30_000,
    });
    let startSettled = false;
    void start.then(
      () => {
        startSettled = true;
      },
      () => {
        startSettled = true;
      },
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(startSettled).toBe(false);
    expect(manager.getExecutedOperations()).toEqual([]);

    releaseDestroy();
    await expect(start).rejects.toThrow(/not found/);
  });

  test("holds the resolved iOS stable target before a name-selected compatibility start boots", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);

    const teardown = teardownTool().handler(request("ios", device.deviceId!, device.name));
    await destroyStarted;
    manager.clearHistory();

    const start = startDeviceTool().handler({
      platform: "ios",
      name: device.name,
      timeoutMs: 30_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(manager.wasMethodCalled("startDevice")).toBe(false);

    releaseDestroy();
    await teardown;
    await expect(start).rejects.toThrow(/changed while waiting for lifecycle coordination/i);
  });

  test("uses iOS name-selection criteria to lock the matching simulator", async () => {
    const target: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-18",
      osVersion: "18",
      isRunning: false,
    };
    manager.setDeviceImages("ios", [
      {
        ...target,
        deviceId: "IOS-DEVICE-17",
        osVersion: "17",
      },
      target,
    ]);
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });

    const teardown = teardownTool().handler(request("ios", target.deviceId!, target.name));
    await destroyStarted;
    manager.clearHistory();
    let startSettled = false;
    const start = startDeviceTool()
      .handler({
        platform: "ios",
        name: target.name,
        minOsVersion: "18",
        timeoutMs: 30_000,
      })
      .finally(() => {
        startSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startSettled).toBe(false);
    expect(manager.wasMethodCalled("startDevice")).toBe(false);

    releaseDestroy();
    await teardown;
    await expect(start).rejects.toThrow(/changed while waiting for lifecycle coordination/i);
  });

  test("holds the resolved Android stable target before a deviceId-selected compatibility start boots", async () => {
    const device: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("android", [device]);

    const teardown = teardownTool().handler(request("android", device.name, device.name));
    await destroyStarted;
    manager.clearHistory();

    const start = startDeviceTool().handler({
      platform: "android",
      deviceId: device.name,
      timeoutMs: 30_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(manager.wasMethodCalled("startDevice")).toBe(false);

    releaseDestroy();
    await teardown;
    await expect(start).rejects.toThrow(/not found|matching/i);
  });

  test("holds the resolved Android stable target before a serial-selected warm start", async () => {
    const device: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("android", [device]);

    const teardown = teardownTool().handler(request("android", device.name, device.name));
    await destroyStarted;
    manager.setBootedDevices("android", [
      {
        platform: "android",
        name: device.name,
        deviceId: "emulator-5556",
      },
    ]);
    manager.clearHistory();

    const start = startDeviceTool().handler({
      platform: "android",
      deviceId: "emulator-5556",
      timeoutMs: 30_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(manager.wasMethodCalled("startDevice")).toBe(false);

    releaseDestroy();
    await teardown;
    await start;
  });

  test("holds the Android stable target before exact provisioning adopts it", async () => {
    const device: DeviceInfo = {
      platform: "android",
      name: "Pixel_8_API_35",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("android", [device]);
    let provisionCalls = 0;
    const provisionOperationStore: ProvisionDeviceOperationStore = {
      begin: async () => ({ started: true, reconcileExistingConfiguration: false }),
      markDeviceCreationStarted: async () => {},
      complete: async () => {},
      fail: async () => {},
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (provisionRequest) => {
          provisionCalls++;
          return {
            created: true,
            device: {
              platform: "android",
              name: provisionRequest.name,
              isRunning: false,
            },
            resolvedSpec: provisionRequest.spec,
          };
        },
      }),
      provisionDeviceOperationStoreFactory: () => provisionOperationStore,
    });
    registerDeviceTools();

    const teardown = teardownTool().handler(request("android", device.name, device.name));
    await destroyStarted;
    const provision = provisionDeviceTool().handler({
      operationId: "12e6f783-b794-47b8-b8a1-8619677820f0",
      device: {
        platform: "android",
        name: device.name,
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: false,
      readiness: "none",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(provisionCalls).toBe(0);

    releaseDestroy();
    await teardown;

    expect(responseBody(await provision)).toMatchObject({
      lifecycleState: "created",
    });
    expect(provisionCalls).toBe(1);
  });

  test("holds the iOS stable target before exact provisioning adopts it", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);
    let provisionCalls = 0;
    const provisionOperationStore: ProvisionDeviceOperationStore = {
      begin: async () => ({ started: true, reconcileExistingConfiguration: false }),
      markDeviceCreationStarted: async () => {},
      complete: async () => {},
      fail: async () => {},
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (provisionRequest) => {
          provisionCalls++;
          return {
            created: false,
            device,
            resolvedSpec: provisionRequest.spec,
          };
        },
      }),
      provisionDeviceOperationStoreFactory: () => provisionOperationStore,
    });
    registerDeviceTools();

    const teardown = teardownTool().handler(request("ios", device.deviceId!, device.name));
    await destroyStarted;
    const provision = provisionDeviceTool().handler({
      operationId: "72e6f783-b794-47b8-b8a1-8619677820f0",
      device: {
        platform: "ios",
        name: device.name,
        spec: {
          runtime: device.runtime!,
          deviceType: device.deviceType!,
        },
      },
      boot: false,
      readiness: "none",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(provisionCalls).toBe(0);

    releaseDestroy();
    await teardown;
    expect(responseBody(await provision)).toMatchObject({
      lifecycleState: "adopted",
    });
    expect(provisionCalls).toBe(1);
  });

  test("returns by the teardown deadline when post-stop cleanup does not settle", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
    };
    manager.setBootedDevices("ios", [device]);
    manager.setDeviceImages("ios", [{ ...device, isRunning: true }]);
    let cleanupCalls = 0;
    setDeviceToolsDependencies({
      timer,
      clearInstalledAppsForDevice: async () => {
        cleanupCalls++;
        if (cleanupCalls === 1) {
          await new Promise<void>(() => {});
        }
      },
    });

    const args = {
      ...request("ios", device.deviceId, device.name),
      timeoutMs: 10,
    };
    const teardown = teardownTool().handler(args);
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(10);

    const body = responseBody(await teardown);
    expect(body.state).toBe("failed");
    expect(body.failure).toEqual(
      expect.objectContaining({
        phase: "stop",
        code: "operation_failed",
      }),
    );
    expect(manager.destroyRequests).toEqual([]);

    const retry = responseBody(await teardownTool().handler(args));
    expect(retry.state).toBe("destroyed");
    expect(manager.destroyRequests).toHaveLength(1);
  });

  test("holds the stable lifecycle lease until a late shutdown command settles", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const device: BootedDevice = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
    };
    let releaseKill!: () => void;
    const killStarted = new Promise<void>((resolve) => {
      manager.killStarted = resolve;
    });
    manager.killGate = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    manager.setBootedDevices("ios", [device]);
    manager.setDeviceImages("ios", [{ ...device, isRunning: true }]);
    setDeviceToolsDependencies({ timer, lifecycleCoordinator });

    const teardown = teardownTool().handler({
      ...request("ios", device.deviceId, device.name),
      timeoutMs: 10,
    });
    await killStarted;
    timer.advanceTime(10);
    expect(responseBody(await teardown).failure).toEqual(
      expect.objectContaining({ phase: "stop" }),
    );

    const start = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "ios", stableId: device.deviceId },
      { operation: "start", deadlineMs: 1_010 },
    );
    let startAcquired = false;
    void start.then(() => {
      startAcquired = true;
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(startAcquired).toBe(false);

    releaseKill();
    const startLease = await start;
    startLease.release();
  });

  test("reports the configured teardown deadline when waiting for a lifecycle lock", async () => {
    const timer = new FakeTimer();
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);
    setDeviceToolsDependencies({ timer });

    const first = teardownTool().handler(request("ios", device.deviceId!, device.name));
    await destroyStarted;
    const second = teardownTool().handler({
      ...request("ios", device.deviceId!, device.name),
      operationId: "70e6f783-b794-47b8-b8a1-8619677820f0",
      timeoutMs: 10,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(10);

    const body = responseBody(await second);
    expect(body.failure).toEqual(
      expect.objectContaining({
        phase: "precondition",
        code: "operation_failed",
        message: expect.stringContaining("after 10ms"),
      }),
    );

    releaseDestroy();
    await first;
  });

  test("reports the configured teardown deadline when booted discovery stalls", async () => {
    const timer = new FakeTimer();
    manager.getBootedDevicesDetailed = async () =>
      await new Promise<BootedDeviceDiscovery>(() => {});
    setDeviceToolsDependencies({ timer });

    const teardown = teardownTool().handler({
      ...request("ios", "IOS-DEVICE-1", "iPhone 16"),
      timeoutMs: 10,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(10);

    const body = responseBody(await teardown);
    expect(body.failure).toEqual(
      expect.objectContaining({
        phase: "precondition",
        code: "operation_failed",
        message: expect.stringContaining("after 10ms"),
      }),
    );
  });

  test("replays a completed teardown operation without issuing another destructive command", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    manager.setDeviceImages("ios", [device]);
    const args = request("ios", device.deviceId!, device.name);

    const first = await teardownTool().handler(args);
    const second = await teardownTool().handler(args);

    expect(responseBody(first).state).toBe("destroyed");
    expect(responseBody(second).state).toBe("destroyed");
    expect(manager.destroyRequests).toHaveLength(1);
  });

  test("keeps a shared teardown running when its initiating caller aborts", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);
    const args = request("ios", device.deviceId!, device.name);
    const firstCaller = new AbortController();

    const first = teardownTool().handler(args, undefined, firstCaller.signal);
    await destroyStarted;
    const second = teardownTool().handler(args);
    firstCaller.abort(new Error("first caller disconnected"));

    expect(responseBody(await first)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: expect.objectContaining({ code: "operation_cancelled" }),
      }),
    );
    expect(manager.destroyRequests).toHaveLength(1);

    releaseDestroy();
    expect(responseBody(await second).state).toBe("destroyed");
  });

  test("rejects reuse of an operation ID with different teardown arguments", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    let releaseDestroy!: () => void;
    const destroyStarted = new Promise<void>((resolve) => {
      manager.destroyStarted = resolve;
    });
    manager.destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    manager.setDeviceImages("ios", [device]);
    const first = teardownTool().handler(request("ios", device.deviceId!, device.name));
    await destroyStarted;

    const conflict = await teardownTool().handler(request("ios", "IOS-DEVICE-2", "iPhone 17"));
    const body = responseBody(conflict);

    expect(body.state).toBe("failed");
    expect(body.failure).toEqual(
      expect.objectContaining({
        code: "operation_id_conflict",
        phase: "precondition",
      }),
    );
    releaseDestroy();
    await first;
  });

  test("publishes a confirmed absent target without waiting for resource work", async () => {
    let notifyStarted = false;
    setDeviceToolsDependencies({
      notifyResourcesChanged: async () => {
        notifyStarted = true;
        await new Promise<void>(() => {});
      },
    });

    const response = await teardownTool().handler(request("ios", "IOS-DEVICE-1", "iPhone 16"));

    expect(responseBody(response).state).toBe("already_absent");
    expect(notifyStarted).toBe(true);
  });

  test("rejects physical targets in the public schema before orchestration", () => {
    const parsed = teardownTool().schema.safeParse({
      ...request("android", "R5CT00ABC", "Pixel 9"),
      target: {
        platform: "android",
        isVirtual: false,
        stableId: "R5CT00ABC",
        stableName: "Pixel 9",
      },
    });

    expect(parsed.success).toBe(false);
    expect(manager.getExecutedOperations()).toEqual([]);
    expect(manager.destroyRequests).toEqual([]);
  });

  test("retains the resolved platform in a destroy failure diagnostic", async () => {
    const device: DeviceInfo = {
      platform: "ios",
      name: "iPhone 16",
      deviceId: "IOS-DEVICE-1",
      isRunning: false,
    };
    manager.setDeviceImages("ios", [device]);
    manager.destroyError = new Error("simctl delete failed");

    const response = await teardownTool().handler(request("ios", device.deviceId!, device.name));
    const body = responseBody(response);

    expect(body.state).toBe("failed");
    expect(body.target).toEqual(expect.objectContaining({ platform: "ios" }));
    expect(body.failure).toEqual(
      expect.objectContaining({
        code: "operation_failed",
        phase: "destroy",
      }),
    );
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining("simctl delete failed"),
    });
  });
});
