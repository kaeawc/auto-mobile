import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
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
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { DeviceSessionRepository } from "../../src/db/DeviceSessionRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";

class FailingKillDeviceManager extends FakeDeviceUtils {
  readonly childProcess = new EventEmitter() as ChildProcess;

  constructor() {
    super();
    Object.assign(this.childProcess, {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: () => false,
    });
  }

  override async startDevice(device: DeviceInfo, timeoutMs?: number): Promise<ChildProcess> {
    await super.startDevice(device, timeoutMs);
    return this.childProcess;
  }

  override async killDevice(): Promise<void> {
    throw new Error("adb emu kill failed");
  }
}

class SuccessfulKillDeviceManager extends FailingKillDeviceManager {
  override async killDevice(): Promise<void> {}
}

class AlreadyStoppedKillDeviceManager extends FailingKillDeviceManager {
  constructor(private readonly message: string) {
    super();
  }

  override async killDevice(): Promise<void> {
    throw new Error(this.message);
  }
}

class FakeDeviceSessionRepository extends DeviceSessionRepository {
  override async upsertActiveSession(): Promise<void> {}
  override async markReleased(): Promise<void> {}
  override async recordActivity(): Promise<void> {}
}

describe("killDevice handler", () => {
  const originalPreferred = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
  const originalAlias = process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
  let sessionManager: SessionManager;
  let manager: FailingKillDeviceManager;

  beforeEach(async () => {
    process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
    delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
    manager = new FailingKillDeviceManager();
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
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    if (originalPreferred === undefined) {
      delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
    } else {
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalPreferred;
    }
    if (originalAlias === undefined) {
      delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
    } else {
      process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH = originalAlias;
    }
  });

  test("a failed explicit shutdown remains eligible for later crash recovery", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    manager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }
    const device: BootedDevice = {
      name: image.name,
      platform: "android",
      deviceId: "emulator-5554",
    };
    await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

    Object.assign(manager.childProcess, { exitCode: 1 });
    manager.childProcess.emit("exit", 1, null);
    await new Promise(resolve => setImmediate(resolve));

    expect(manager.getCallCount("startDevice")).toBe(2);
  });

  test("a successful explicit shutdown does not reboot the emulator", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {
        throw new Error("resource notification failed");
      },
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {
        throw new Error("cache cleanup failed");
      },
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }
    await tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: "emulator-5554",
      },
    });
    Object.assign(successfulManager.childProcess, { exitCode: 0 });
    successfulManager.childProcess.emit("exit", 0, null);
    await new Promise(resolve => setImmediate(resolve));

    expect(successfulManager.getCallCount("startDevice")).toBe(1);
    expect(pool.getDevice("emulator-5554")).toBeNull();
  });

  test.each([
    ["android", "Emulator 'forge-ivory-crown' is not running"],
    ["ios", "Unable to shutdown device: device is already shut down"],
  ] as const)("returns a structured terminal error for an already-stopped %s device", async (platform, message) => {
    const stoppedManager = new AlreadyStoppedKillDeviceManager(message);
    manager = stoppedManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => stoppedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    registerDeviceTools();

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }
    const response = await tool.handler({
      device: {
        name: platform === "android" ? "Pixel 8" : "iPhone 16",
        platform,
        deviceId: platform === "android" ? "emulator-5554" : "IOS-UDID",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({
      success: false,
      error: {
        code: "device_already_stopped",
        message: expect.stringContaining(message),
      },
    });
  });

  test("keeps recording-list failures as actionable errors", async () => {
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: {
        listRecordings: async () => {
          throw new Error("Emulator 'forge-ivory-crown' is not running");
        },
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(tool.handler({
      device: {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      },
    })).rejects.toThrow("Failed to kill android device");
  });
});
