import { spyOn } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { Session } from "../../src/daemon/sessionManager/sessionTypes";
import type { BootedDevice } from "../../src/models";
import type { FakeTimer } from "../fakes/FakeTimer";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A session-held Android device row, the shape the disconnect monitor reads from the pool. */
export function heldAndroidDevice(id: string): Mutable<PooledDevice> {
  return {
    id,
    name: "Pixel",
    platform: "android",
    sessionId: "owner",
    status: "busy",
    incarnation: 1,
    assignmentCount: 1,
    lastUsedAt: 0,
    errorCount: 0,
    androidImage: { name: "Pixel", platform: "android", isRunning: true },
  };
}

/** A minimal owned session row holding `assignedDevice`. */
export function heldSession(assignedDevice: string): Session {
  return {
    sessionId: "owner",
    assignedDevice,
    platform: "android",
    createdAt: 0,
    lastUsedAt: 0,
    activityGeneration: 0,
    expiresAt: 1000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 1000,
    heartbeatTimeoutMs: 1000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
    ownership: "owned",
    livenessPolicy: "heartbeat",
  };
}

/**
 * A real Daemon (built through its constructor) whose pool and session manager answer the disconnect
 * monitor from one held device. Each stubbed method is a spy the test can re-point:
 * `spies.getAllDevices.mockImplementation(...)`.
 */
export function createMonitorDaemon(options: {
  timer: FakeTimer;
  device: Mutable<PooledDevice>;
  missIncarnations?: Map<string, number>;
}) {
  const { timer, device } = options;
  const daemon = new Daemon({}, { timer });
  const hooks = daemon.testHooks;
  for (const [id, incarnation] of options.missIncarnations ?? []) {
    hooks.deviceLoss.missIncarnations.set(id, incarnation);
  }
  const pool = hooks.devicePool;
  const sessions = hooks.sessionManager;
  const spies = {
    getAllDevices: spyOn(pool, "getAllDevices").mockImplementation(() => [device]),
    getDevice: spyOn(pool, "getDevice").mockImplementation((id) =>
      id === device.id ? device : null,
    ),
    isDeviceLeasedForAndroidStartup: spyOn(
      pool,
      "isDeviceLeasedForAndroidStartup",
    ).mockImplementation(() => false),
    mapAndroidDiscovery: spyOn(pool, "mapAndroidDiscovery").mockImplementation(
      (devices: BootedDevice[]) => devices,
    ),
    getAssignedDevices: spyOn(sessions, "getAssignedDevices").mockImplementation(
      () => new Set([device.id]),
    ),
    getAllSessions: spyOn(sessions, "getAllSessions").mockImplementation(() => [
      heldSession(device.id),
    ]),
  };
  spyOn(pool, "retryDueDeferredSessionRecoveries").mockImplementation(async () => {});
  spyOn(pool, "reconcileDiscoveryObservation").mockImplementation(async () => {});
  spyOn(pool, "getAndroidTransportAliases").mockImplementation(() => []);
  spyOn(pool, "releaseAdbServerResetCohortReservations").mockImplementation(async () => {});
  return { daemon, hooks, pool, sessions, spies };
}
