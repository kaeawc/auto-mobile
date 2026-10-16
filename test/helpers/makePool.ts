import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import type { Timer } from "../../src/utils/SystemTimer";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "./devicePoolDependencies";

type MakePoolOverrides = Partial<
  Omit<DevicePoolDependencies, "sessionManager" | "daemonSessionId">
> & {
  /** Required: every pool built here runs on a fake clock. */
  timer: Timer;
};

/**
 * A DevicePool over the given session manager with the arrange block every pool suite repeats:
 * the supplied timer, a fresh FakeInstalledAppsRepository and a DefaultRetryExecutor on that
 * timer. Any dependency in `overrides` replaces its default.
 */
export function makePool(
  sessionManager: DevicePoolDependencies["sessionManager"],
  daemonSessionId: string,
  overrides: MakePoolOverrides,
): DevicePool {
  return new DevicePool(
    createDevicePoolDependencies(sessionManager, daemonSessionId, {
      installedAppsRepository: new FakeInstalledAppsRepository(),
      retryExecutor: new DefaultRetryExecutor(overrides.timer),
      ...overrides,
    }),
  );
}
