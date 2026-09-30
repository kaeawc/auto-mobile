import type { DevicePoolDependencies } from "../../src/daemon/devicePool";

type DevicePoolTestOverrides = Partial<
  Omit<DevicePoolDependencies, "sessionManager" | "daemonSessionId">
>;

/** Build a pool's required dependencies while leaving optional production defaults intact. */
export function createDevicePoolDependencies(
  sessionManager: DevicePoolDependencies["sessionManager"],
  daemonSessionId: string,
  overrides: DevicePoolTestOverrides = {},
): DevicePoolDependencies {
  return { sessionManager, daemonSessionId, ...overrides };
}
