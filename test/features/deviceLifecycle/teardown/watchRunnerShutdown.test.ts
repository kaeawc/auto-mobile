import { expect, test } from "bun:test";
import { stopWatchRunnerBeforeShutdown } from "../../../../src/features/deviceLifecycle/teardown/shutdownPreparation";
import { getDeviceToolsDependencies } from "../../../../src/features/deviceLifecycle/core/dependencies";
import { WatchRunnerLifecycle } from "../../../../src/features/watch/WatchRunnerLifecycle";
import { FakeWatchRunnerLauncher } from "../../../fakes/FakeWatchRunnerLauncher";

test("shutdown preparation stops a watch runner exactly once before shutdown, leaving other platforms alone", async () => {
  const launcher = new FakeWatchRunnerLauncher();
  const owner = new WatchRunnerLifecycle({
    launcher,
    artifacts: { resolve: async () => "/watch.xctestrun" },
    ports: { allocate: () => 9014, release: () => {} },
  });
  const device = { deviceId: "shutdown-watch", name: "Watch", platform: "watchos" } as const;
  const deps = { ...getDeviceToolsDependencies(), watchRunnerLifecycleFactory: () => owner };
  try {
    await owner.ensure({
      deviceId: device.deviceId,
      ownerSession: "session",
      sessions: {
        hasSession: () => true,
        onSessionRelease: () => {},
        onSessionDeviceUnbound: () => {},
      },
    });
    stopWatchRunnerBeforeShutdown({ ...device, platform: "ios" }, deps);
    expect(launcher.stops).toBe(0);
    stopWatchRunnerBeforeShutdown(device, deps);
    stopWatchRunnerBeforeShutdown(device, deps);
    expect(launcher.stops).toBe(1);
  } finally {
    owner.stopAll();
  }
});
