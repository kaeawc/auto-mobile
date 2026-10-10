import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
} from "../../src/features/utility/LocationRoutePlayer";
import type { MockLocationClears } from "../../src/features/utility/MockLocationClear";
import { registerPerformanceMonitorSessionCleanup } from "../../src/server/performanceMonitorSessionCleanup";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10825: session A is idle-released, B acquires the same device, then a late terminal release of
// A's captured Session (killDevice, an in-flight owner-disconnect release) upgrades A's finalized
// release. The upgrade re-notified every release hook with the device id, so device-keyed cleanup
// ran against B: its location route and performance sampling stopped and its pin was cleared. The
// upgrade must persist and announce the terminal reason only.

const DEVICE = "emulator-5554";
const WAYPOINTS = [
  { latitude: 0, longitude: 0 },
  { latitude: 0, longitude: 0.001 },
];

const NO_MOCK_LOCATION_CLEARS: MockLocationClears = {
  markSet: () => undefined,
  clearLateSet: () => null,
  clearAfter: () => null,
  retireDevice: () => undefined,
};

describe("a terminal upgrade of an already-finalized release (#10825)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let routes: LocationRouteRegistry;
  let perfStops: string[];
  let notifications: string[];

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    routes = new LocationRouteRegistry(timer);
    perfStops = [];
    notifications = [];
    registerLocationRouteSessionCleanup(manager, {
      registry: routes,
      mockLocationClears: NO_MOCK_LOCATION_CLEARS,
    });
    registerPerformanceMonitorSessionCleanup(manager, {
      monitor: () => ({ stopMonitoring: (deviceId) => perfStops.push(deviceId) }),
    });
    manager.onSessionRelease((sessionId, _deviceId, reason, _snapshot, options) => {
      notifications.push(`${sessionId}:${reason}${options.upgradeOnly ? ":upgrade" : ""}`);
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    routes.stop(DEVICE);
  });

  function startRoute(): void {
    routes.start(DEVICE, WAYPOINTS, 60_000, 1_000, true, async () => undefined);
  }

  /** A is released for idleness and B then takes the device, with its own route running. */
  async function handOverToB(): Promise<Session> {
    const sessionA = await manager.createSession("A", DEVICE, "android");
    startRoute();
    await manager.releaseSession("A", "cleanup-expired");
    // The first release is the real one: it stops A's device work.
    expect(routes.isActive(DEVICE)).toBe(false);
    expect(perfStops).toEqual([DEVICE]);

    await manager.createSession("B", DEVICE, "android");
    startRoute();
    perfStops = [];
    return sessionA;
  }

  for (const lateReason of ["device-killed", "explicit-release", "heartbeat-timeout"]) {
    test(`a late ${lateReason} leaves B's route and sampling running`, async () => {
      const sessionA = await handOverToB();

      await manager.releaseSessionIfOwned("A", sessionA, DEVICE, lateReason);

      expect(manager.getSessionForDevice(DEVICE)).toBe("B");
      expect(routes.isActive(DEVICE)).toBe(true);
      expect(perfStops).toEqual([]);
    });
  }

  test("the terminal reason is still persisted and announced, flagged as an upgrade", async () => {
    const sessionA = await handOverToB();

    await manager.releaseSessionIfOwned("A", sessionA, DEVICE, "device-killed");

    expect(notifications).toEqual(["A:cleanup-expired", "A:device-killed:upgrade"]);
    expect(manager.getTerminalReleaseSnapshot("A")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });
});

interface DaemonNavigationInternals {
  navigationGraphListenerManagers: WeakSet<NavigationGraphManager>;
  setupNavigationGraphUpdateListener(manager: NavigationGraphManager): void;
}

describe("the daemon's release hooks on a terminal upgrade (#10825)", () => {
  let timer: FakeTimer;
  let daemon: Daemon;

  // Building a daemon (and its database) is setup, not the behavior under test.
  beforeAll(async () => {
    timer = new FakeTimer();
    daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(await createTestDatabase(), timer),
    );
  });

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    DeviceSessionManager.getInstance().clearExplicitDevicePin(DEVICE);
    NavigationGraphManager.resetInstance();
    SessionReleaseBroadcaster.clearForTesting();
  });

  test("keep B's pin and the global navigation listener, and still broadcast the upgrade", async () => {
    const sessions = daemon.getSessionManager();
    const internals = daemon as unknown as DaemonNavigationInternals;
    const globalNavigation = NavigationGraphManager.getInstance();
    internals.setupNavigationGraphUpdateListener(globalNavigation);
    const broadcasts: string[] = [];
    SessionReleaseBroadcaster.subscribe((sessionId, reason, _snapshot, extras) =>
      broadcasts.push(`${sessionId}:${reason}${extras?.upgradeOnly ? ":upgrade" : ""}`),
    );

    const sessionA = await sessions.createSession("A", DEVICE, "android");
    await sessions.releaseSession("A", "cleanup-expired");
    await sessions.createSession("B", DEVICE, "android");
    DeviceSessionManager.getInstance().setExplicitDevicePin({
      deviceId: DEVICE,
      name: DEVICE,
      platform: "android",
    });

    await sessions.releaseSessionIfOwned("A", sessionA, DEVICE, "device-killed");

    expect(DeviceSessionManager.getInstance().getExplicitDevicePin()?.deviceId).toBe(DEVICE);
    expect(internals.navigationGraphListenerManagers.has(globalNavigation)).toBe(true);
    // Device-keyed broadcast listeners (overlay agents and events) skip the marked upgrade (#11206).
    expect(broadcasts).toEqual(["A:cleanup-expired", "A:device-killed:upgrade"]);

    // B's own release is a real one: it clears B's pin.
    await sessions.releaseSession("B", "explicit-release");
    expect(DeviceSessionManager.getInstance().getExplicitDevicePin()).toBeUndefined();
    expect(internals.navigationGraphListenerManagers.has(globalNavigation)).toBe(true);
  });
});
