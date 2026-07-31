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
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

class FailingKillDeviceManager extends FakeDeviceUtils {
  readonly childProcess = new EventEmitter() as ChildProcess;

  constructor() {
    super();
    Object.assign(this.childProcess, {
      pid: 12345,
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
    sessionManager = new SessionManager(timer);
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
      undefined,
      manager,
      new DefaultRetryExecutor(timer)
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

    manager.childProcess.emit("exit", 1, null);
    await new Promise(resolve => setImmediate(resolve));

    expect(manager.getCallCount("startDevice")).toBe(2);
  });
});
