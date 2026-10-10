import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DaemonState } from "../../../src/daemon/daemonState";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../../src/server/videoRecordingManager";
import type { BootedDevice } from "../../../src/models";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

/** The platform kill command "succeeds" but the emulator stays in ADB discovery. */
class StubbornDeviceManager extends FakeDeviceUtils {
  override async killDevice(): Promise<void> {}
}

describe("hunt: killDevice post-kill timeout", () => {
  const timer = new FakeTimer();
  const device: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };

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

  test("a device that never disappears is refused with a typed retryable timeout", async () => {
    const tool = ToolRegistry.getTool("killDevice")!;
    const pending = tool.handler({ device }).catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);
    const error = (await pending) as { message?: string; code?: unknown; retryable?: unknown };

    // The provisionDevice and acquisition timeouts carry code "timeout" + retryable.
    expect(error.message).toContain("Timed out waiting for android device");
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });
});
