import type { DevicePoolDependencies } from "../../src/daemon/devicePool";

type DevicePoolTestOverrides = Partial<
  Omit<DevicePoolDependencies, "sessionManager" | "daemonSessionId">
>;

/**
 * Autolock row writes default to a no-op: the production default resolves the real file-backed
 * database, which unit tests must never touch, and its failures now propagate (#11129). Tests that
 * assert persisted autolock rows inject a repository over an in-memory database.
 */
const noopAutolockPersistence: NonNullable<DevicePoolDependencies["deviceSessionRepository"]> = {
  markAutolockSession: async () => {},
};

/** Build a pool's required dependencies while leaving optional production defaults intact. */
export function createDevicePoolDependencies(
  sessionManager: DevicePoolDependencies["sessionManager"],
  daemonSessionId: string,
  overrides: DevicePoolTestOverrides = {},
): DevicePoolDependencies {
  return {
    sessionManager,
    daemonSessionId,
    deviceSessionRepository: noopAutolockPersistence,
    ...overrides,
  };
}
