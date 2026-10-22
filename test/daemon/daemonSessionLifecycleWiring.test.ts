import { afterEach, describe, expect, spyOn, test, mock } from "bun:test";
import { wireSessionLifecycle } from "../../src/daemon/daemonSessionLifecycleWiring";
import type { DaemonSessionLifecycleHost } from "../../src/daemon/daemonSessionLifecycleWiring";
import { SessionManager } from "../../src/daemon/sessionManager";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

afterEach(() => {
  mock.restore();
});

const REGISTRATIONS = [
  "onDeviceOwnershipChange",
  "setManagedExecutionRecoveryListener",
  "setLateRehydrationListener",
  "setActiveSessionExecutionChecker",
  "setSessionExecutionDeadlineLookup",
  "setExpiryReleaseExecutionCanceller",
  "setDeviceAcquisitionExecutionCanceller",
  "onSessionCreated",
  "onSessionRelease",
  "onSessionDeviceUnbound",
] as const;

function hostWith(calls: string[]): DaemonSessionLifecycleHost {
  return {
    deviceReadiness: () => ({ clearExplicitDevicePin: () => undefined }),
    deviceDataStreamServer: () => null,
    socketServer: () => null,
    managedExecutionReowner: () => undefined,
    devicePool: () => {
      throw new Error("pool must be resolved lazily");
    },
    passiveWorkPolicy: () => ({ allows: () => false }),
    navigationGraphListenerManagers: new WeakSet<NavigationGraphManager>(),
    shutdownReleaseNotifications: () => null,
    shutdownFallbackReleaseNotifications: () => null,
    setupNavigationGraphUpdateListener: () => calls.push("setupNavigationGraphUpdateListener"),
    reownRehydratedManagedExecutions: async () => {},
    hasActiveSessionExecution: () => false,
    latestSessionExecutionDeadlineMs: () => undefined,
    cancelExecutionsForExpiryRelease: () => {},
  };
}

describe("wireSessionLifecycle", () => {
  const managers: SessionManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
  });

  test("registers session-manager listeners and setters in the daemon's historical order", () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    managers.push(manager);
    const order: string[] = [];
    for (const name of REGISTRATIONS) {
      const original = manager[name].bind(manager) as (arg: never) => void;
      spyOn(manager, name).mockImplementation(((arg: never) => {
        order.push(name);
        original(arg);
      }) as never);
    }

    wireSessionLifecycle(manager, timer, hostWith([]));

    // The location, network, App Links, device-condition, kill-profile, emulator sensor, display-profile, status bar, performance, screen
    // lock, system-alert and recording cleanups register first (each takes a release listener and an unbound
    // listener), then the daemon's own, in this order.
    expect(order).toEqual([
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onDeviceOwnershipChange",
      "setManagedExecutionRecoveryListener",
      "setLateRehydrationListener",
      "setActiveSessionExecutionChecker",
      "setSessionExecutionDeadlineLookup",
      "setExpiryReleaseExecutionCanceller",
      "setDeviceAcquisitionExecutionCanceller",
      "onSessionCreated",
      "onSessionRelease",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
    ]);
  });
});
