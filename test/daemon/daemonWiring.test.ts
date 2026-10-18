import { afterEach, describe, expect, test } from "bun:test";
import { wireDaemonCollaborators, type DaemonWiringHost } from "../../src/daemon/daemonWiring";
import { createDeviceStateChangeNotifier } from "../../src/server/deviceStateChangeNotifier";
import { parseDeviceRecoveryPolicy } from "../../src/daemon/poolConfig";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

function hostWith(touched: string[]): DaemonWiringHost {
  const unexpected = (name: string) => (): never => {
    touched.push(name);
    throw new Error(`${name} must be resolved lazily`);
  };
  return {
    deviceDataStreamServer: () => null,
    socketServer: () => null,
    managedExecutionReowner: () => undefined,
    devicePool: unexpected("devicePool"),
    passiveWorkPolicy: unexpected("passiveWorkPolicy"),
    navigationGraphListenerManagers: new WeakSet(),
    shutdownReleaseNotifications: () => null,
    shutdownFallbackReleaseNotifications: () => null,
    setupNavigationGraphUpdateListener: unexpected("setupNavigationGraphUpdateListener"),
    reownRehydratedManagedExecutions: unexpected("reownRehydratedManagedExecutions"),
    hasActiveSessionExecution: unexpected("hasActiveSessionExecution"),
    latestSessionExecutionDeadlineMs: unexpected("latestSessionExecutionDeadlineMs"),
    cancelExecutionsForExpiryRelease: unexpected("cancelExecutionsForExpiryRelease"),
    cancelAndReleaseSession: unexpected("cancelAndReleaseSession"),
    cancelAndDrainDeviceSessionExecutions: unexpected("cancelAndDrainDeviceSessionExecutions"),
    cancelAndDrainDeviceExecutions: unexpected("cancelAndDrainDeviceExecutions"),
    onDeviceReadyForSessionRegistry: unexpected("onDeviceReadyForSessionRegistry"),
    recorderDeviceIncarnationListener: () => undefined,
  };
}

describe("wireDaemonCollaborators", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  });

  test("builds the collaborator graph without calling back into the host", () => {
    const timer = new FakeTimer();
    const touched: string[] = [];
    const installedAppsRepository = new FakeInstalledAppsRepository();
    const deviceStateChangeNotifier = createDeviceStateChangeNotifier({
      timer,
      invalidate: () => {},
      notify: async () => {},
    });

    const collaborators = wireDaemonCollaborators({
      timer,
      idGenerator: new FakeIdGenerator(),
      daemonSessionId: "daemon-wiring-test",
      deviceSessionRepository: new FakeDeviceSessionPersistence(),
      installedAppsRepository,
      incumbentOwnerGuard: { withLiveIncumbent: (ids) => ids },
      liveDaemonSessionIdProvider: { collectLiveDaemonSessionIds: () => new Set<string>() },
      bindingExclusionFactory: () => ({
        refresh: async () => {},
        holderOf: () => undefined,
        stableIdsFor: () => new Set<string>(),
      }),
      recoveryPolicy: parseDeviceRecoveryPolicy({}).policy,
      recoveryPolicyEnvironment: {},
      deviceDisconnectMisses: new Map(),
      deviceStateChangeNotifier,
      host: hostWith(touched),
    });
    disposers.push(
      () => collaborators.sessionManager.stopCleanupTimer(),
      () => collaborators.observerSessionRegistry.dispose(),
      () => deviceStateChangeNotifier.dispose(),
    );

    expect(collaborators.installedAppsRepository).toBe(installedAppsRepository);
    expect(collaborators.sessionManager.getAllSessions()).toEqual([]);
    expect(collaborators.devicePool.getAllDevices()).toEqual([]);
    expect(touched).toEqual([]);
  });
});
