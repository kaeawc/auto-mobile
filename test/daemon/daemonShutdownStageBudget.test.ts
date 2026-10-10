import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../../src/processLifecycle";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

// #11156: the daemon-shutdown notification and socket drain sat behind the
// pending-device-cleanup (2 s) and forward-release (3 s) drains, after the 5 s
// session-release drain. With every one of those wedged the process limit (9 s)
// force-exited before any client heard daemon-shutdown. The notification stage
// must run straight after session release and finish inside the limit.

interface DaemonSocketServerInternals {
  socketServer: {
    quiesce(): Promise<void>;
    drainSessionReleaseNotifications(): Promise<void>;
    close(): Promise<void>;
  } | null;
}

describe("Daemon shutdown stage budget (#11156)", () => {
  const restores: Array<() => void> = [];

  beforeEach(async () => {
    resetDbWriteBarrier();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    for (const spy of [
      spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(undefined),
      spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined),
      spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ]) {
      restores.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    resetVideoRecordingManagerDependencies();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("publishes daemon-shutdown and drains sockets before device cleanup and forward release", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const events: string[] = [];
    let notifiedAt: number | undefined;

    // Wedge the session-release drain: terminal persistence never settles.
    const persistence = Promise.withResolvers<void>();
    const persistenceStarted = Promise.withResolvers<void>();
    const markReleased = spyOn(repository, "markReleased").mockImplementation(async () => {
      persistenceStarted.resolve();
      await persistence.promise;
    });
    restores.push(() => markReleased.mockRestore());
    // Wedge the device-cleanup drain for its full budget.
    const cleanup = Promise.withResolvers<void>();
    restores.push(() => cleanup.resolve());
    sessionManager.registerPendingDeviceCleanup("emulator-5560", cleanup.promise);
    const drainCleanups = sessionManager.drainPendingDeviceCleanups.bind(sessionManager);
    const cleanupDrain = spyOn(sessionManager, "drainPendingDeviceCleanups").mockImplementation(
      async (timeoutMs) => {
        events.push("device-cleanup:start");
        return await drainCleanups(timeoutMs);
      },
    );
    restores.push(() => cleanupDrain.mockRestore());
    // Wedge the forward release for its full budget.
    const forwards = spyOn(
      AndroidCtrlProxyClient,
      "releaseForwardLeasesForShutdown",
    ).mockImplementation(async (forwardTimer, timeoutMs) => {
      events.push("forwards:start");
      await forwardTimer.sleep(timeoutMs);
    });
    restores.push(() => forwards.mockRestore());
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      events.push(`release:${sessionId}:${reason}`);
    });
    restores.push(unsubscribe);
    (daemon as unknown as DaemonSocketServerInternals).socketServer = {
      quiesce: async () => {},
      drainSessionReleaseNotifications: async () => {
        notifiedAt = timer.now();
        events.push("socket:drain-releases");
      },
      close: async () => {
        events.push("socket:close");
      },
    };

    await sessionManager.createSession("wedged-session", "emulator-5560", "android");
    const terminalRelease = sessionManager.releaseSession("wedged-session", "heartbeat-timeout");
    await persistenceStarted.promise;

    await daemon.stop();
    persistence.resolve();
    await terminalRelease;

    const fallback = "release:wedged-session:daemon-shutdown";
    expect(events.slice(0, 3)).toEqual([fallback, "socket:drain-releases", "socket:close"]);
    expect(events.indexOf("device-cleanup:start")).toBeGreaterThan(events.indexOf("socket:close"));
    expect(events.indexOf("forwards:start")).toBeGreaterThan(events.indexOf("socket:close"));
    expect(notifiedAt).toBeDefined();
    expect(notifiedAt!).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
    // Every wedged stage still ran to its own bound after the notification.
    expect(timer.now()).toBeGreaterThanOrEqual(notifiedAt! + 2_000 + 3_000);
  });
});
