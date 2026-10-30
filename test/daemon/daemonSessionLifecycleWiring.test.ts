import { NetworkState } from "../../src/utils/NetworkState";
import { defaultNetworkDeviceStatePusher } from "../../src/daemon/networkStateSessionCleanup";
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
    markMutationUnrecorded: () => {},
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

    // The location, network, App Links, device-condition, kill-profile, emulator sensor, emulator audio, display-profile, keyboard-profile, status bar, performance, screen
    // lock, system-alert, power, profiling and recording cleanups register first (each takes a release listener and an unbound
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
      "onSessionCreated",
      "onDeviceOwnershipChange",
      "onSessionRelease",
      "onSessionRelease",
      "onSessionDeviceUnbound",
      "onSessionRelease",
    ]);
  });
});

test("failed network cleanup marks the ownership session before settlement", async () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const state = new NetworkState({ timer, notifier: { notifyResourceUpdated: () => {} } });
  spyOn(NetworkState, "getInstance").mockReturnValue(state);
  spyOn(defaultNetworkDeviceStatePusher, "push").mockRejectedValue(new Error("wire push failed"));
  const ownership = spyOn(manager, "ownershipSessionUuid").mockReturnValue("ownership-session");
  const base = spyOn(manager, "getBaseSessionOfDerivedLabel").mockReturnValue("base-session");
  const callbacks: Array<Parameters<SessionManager["onSessionDeviceUnbound"]>[0]> = [];
  spyOn(manager, "onSessionDeviceUnbound").mockImplementation((callback) => {
    callbacks.push(callback);
  });
  const pending: Promise<unknown>[] = [];
  spyOn(manager, "registerPendingDeviceCleanup").mockImplementation((_deviceId, cleanup) => {
    pending.push(cleanup);
  });
  const host = hostWith([]);
  const gaps: Array<{ sessionId: string; reason: string }> = [];
  host.markMutationUnrecorded = (sessionId, reason) => {
    gaps.push({ sessionId, reason });
  };
  try {
    wireSessionLifecycle(manager, timer, host);
    state.startSimulation("fake-device", "timeout", 30, null, "derived-session");
    callbacks[1]!("derived-session", "fake-device");
    expect(ownership).toHaveBeenCalledWith("derived-session");
    expect(base).toHaveBeenCalledWith("derived-session");
    ownership.mockReturnValue("gone-owner");
    base.mockReturnValue(undefined);
    await pending[0];
    expect(ownership).toHaveBeenCalledWith("derived-session");
    expect(gaps).toEqual(
      ["derived-session", "ownership-session", "base-session"].map((sessionId) => ({
        sessionId,
        reason: expect.stringContaining("fake-device: wire push failed"),
      })),
    );
  } finally {
    manager.stopCleanupTimer();
  }
});
