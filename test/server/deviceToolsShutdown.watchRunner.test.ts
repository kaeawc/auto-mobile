import { expect, test } from "bun:test";
import { shutdownDevice } from "../../src/server/deviceToolsShutdown";
import { getDeviceToolsDependencies } from "../../src/features/deviceLifecycle/core/dependencies";
import { registerDeviceLifecycleServerHost } from "../../src/features/deviceLifecycle/deviceLifecycleServerHost";
import { WatchRunnerLifecycle } from "../../src/features/watch/WatchRunnerLifecycle";
import { FakeWatchRunnerLauncher } from "../fakes/FakeWatchRunnerLauncher";
import { FakeTimer } from "../fakes/FakeTimer";

test("recording teardown failure leaves the booted watch runner running", async () => {
  const timer = new FakeTimer();
  const launcher = new FakeWatchRunnerLauncher();
  const runner = new WatchRunnerLifecycle({
    artifacts: { resolve: async () => "/fake/Watch.xctestrun" },
    launcher,
    ports: { allocate: () => 9011, release: () => {} },
  });
  const device = { platform: "watchos" as const, deviceId: "watch-shutdown", name: "Watch" };
  await runner.start({ deviceId: device.deviceId });
  const failure = new Error("recording teardown failed");
  const previous = registerDeviceLifecycleServerHost({
    notifyBootedDeviceResourcesUpdated: async () => {},
    notifyDeviceImageResourcesUpdated: async () => {},
    notifyInstalledAppResourceListChanged: async () => {},
    syncInstalledAppResourceRegistry: async () => false,
    syncInstalledAppResources: async () => {},
    listActiveVideoRecordings: async () => [],
    stopVideoRecording: async () => {},
    stopSegmentedVideoRecordingsForDevice: async () => {
      throw failure;
    },
  });
  try {
    await expect(
      shutdownDevice(
        {
          device,
          timer,
          deadlineMs: timer.now() + 1000,
          requestAbortSignal: undefined,
          stopPerformanceMonitoring: () => {},
        },
        {
          ...getDeviceToolsDependencies(),
          timer,
          daemonState: { ...getDeviceToolsDependencies().daemonState, isInitialized: () => false },
          watchRunnerLifecycleFactory: () => runner,
        },
        "killDevice",
        { strictDeadline: true, timeoutMs: 1000 },
      ),
    ).rejects.toThrow("recording teardown failed");
    expect(launcher.stops).toBe(0);
  } finally {
    registerDeviceLifecycleServerHost(previous);
    runner.stopAll();
  }
});
