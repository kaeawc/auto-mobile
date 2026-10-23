import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/daemon/videoRecordingManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeEmulatorProcessStopper } from "../fakes/FakeEmulatorProcessStopper";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** The platform kill command "succeeds" but the emulator stays in ADB discovery. */
class StubbornDeviceManager extends FakeDeviceUtils {
  override async killDevice(): Promise<void> {}
}

describe("killDevice post-kill timeout", () => {
  const timer = new FakeTimer();
  const device: BootedDevice = { name: "Pixel_8", platform: "android", deviceId: "emulator-5554" };
  const stopper = new FakeEmulatorProcessStopper();

  beforeEach(async () => {
    const manager = new StubbornDeviceManager();
    manager.setBootedDevices("android", [device]);
    PlatformDeviceManagerFactory.setInstance(manager);
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
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
      androidEmulatorProcessStopper: stopper,
      timer,
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    PlatformDeviceManagerFactory.reset();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    ToolRegistry.clearTools();
  });

  test("an emulator that ignores the soft kill escalates to its pid and fails typed when it stays up (#14018)", async () => {
    stopper.outcome = {
      kind: "still-running",
      pid: 4242,
      command: "qemu-system-aarch64 -avd Pixel_8 -port 5554",
      signalled: true,
    };
    const tool = ToolRegistry.getTool("killDevice")!;
    const pending = tool.handler({ device }).catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);
    const error = (await pending) as { message?: string; code?: unknown; retryable?: unknown };

    expect(error.message).toContain("still running with pid 4242");
    expect(error.code).toBe("emulator_teardown_failed");
    expect(error.retryable).toBe(false);
    expect(stopper.stopCalls).toHaveLength(1);
    expect(stopper.stopCalls[0]![0]).toEqual({ serial: "emulator-5554", avdName: "Pixel_8" });
  });
});
