import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import * as daemonFilesModule from "../../src/daemon/daemonFiles";
import {
  setVideoStreamSocketServerForTesting,
  type VideoStreamSocketServer,
} from "../../src/daemon/videoStreamSocketServer";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../../src/processLifecycle";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import * as shutdownCleanupModule from "../../src/shutdownCleanup";
import {
  DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
  DAEMON_SHUTDOWN_STAGE_BUDGET_MS,
  type ShutdownCleanupStage,
} from "../../src/shutdownCleanup";
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

// #11601: no stage had a deadline of its own, so one wedged stage (the video relay awaiting a
// capture stop on a dead device) starved every stage behind it. Each stage now draws a deadline
// from one budget table that sums to less than the process limit.

interface DaemonTransportInternals {
  transports: Map<string, { close(): Promise<void> }>;
}

interface DaemonSocketServerInternals {
  socketServer: {
    liftSessionlessStrokesOn(deviceId: string): void;
    quiesce(): Promise<void>;
    drainSessionReleaseNotifications(): Promise<void>;
    close(): Promise<void>;
  } | null;
}

describe("Daemon shutdown stage budget (#11156)", () => {
  const restores: Array<() => void> = [];
  let warnings: string[] = [];
  let closeDatabase: ReturnType<typeof spyOn>;
  let cleanupDaemonFiles: ReturnType<typeof spyOn>;

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
    warnings = [];
    closeDatabase = spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined);
    cleanupDaemonFiles = spyOn(daemonFilesModule, "cleanupDaemonFiles").mockResolvedValue(true);
    for (const spy of [
      spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(undefined),
      closeDatabase,
      cleanupDaemonFiles,
      spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined),
      spyOn(logger, "warn").mockImplementation((message: string) => {
        warnings.push(message);
      }),
    ]) {
      restores.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    resetVideoRecordingManagerDependencies();
    setVideoStreamSocketServerForTesting(null);
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
      liftSessionlessStrokesOn: () => {},
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
    // Both wedged stages behind the notification still got at least their guaranteed share (less
    // the margin their own bound keeps under the stage deadline), and the whole stop stayed
    // inside the process limit: before #11601 this sequence ran to 10 s.
    const guaranteedMs =
      DAEMON_SHUTDOWN_STAGE_BUDGET_MS["pending device cleanups"] -
      50 +
      (DAEMON_SHUTDOWN_STAGE_BUDGET_MS["CtrlProxy forwarding leases"] - 50);
    expect(timer.now()).toBeGreaterThanOrEqual(notifiedAt! + guaranteedMs);
    expect(timer.now()).toBeLessThanOrEqual(
      PROCESS_SHUTDOWN_TIMEOUT_MS - DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
    );
  });

  test("every stop() stage draws its deadline from the budget table, in table order (#11601)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const runStages = shutdownCleanupModule.runShutdownCleanupStages;
    const lists: Array<readonly ShutdownCleanupStage[]> = [];
    const timers: unknown[] = [];
    const run = spyOn(shutdownCleanupModule, "runShutdownCleanupStages").mockImplementation(
      async (stages, reportFailure, deadlines) => {
        lists.push(stages);
        timers.push(deadlines?.timer);
        await runStages(stages, reportFailure, deadlines);
      },
    );
    restores.push(() => run.mockRestore());

    await daemon.stop();

    const [topLevel] = lists;
    expect(topLevel?.map((stage) => stage.name)).toEqual(
      Object.keys(DAEMON_SHUTDOWN_STAGE_BUDGET_MS),
    );
    expect(topLevel?.map((stage) => stage.budgetMs)).toEqual(
      Object.values(DAEMON_SHUTDOWN_STAGE_BUDGET_MS),
    );
    expect(topLevel?.every((stage) => (stage.waitingOn ?? "").length > 0)).toBe(true);
    // Both the top-level list and the nested HTTP-session list run against the daemon's timer.
    expect(timers).toEqual([timer, timer]);
  });

  test("a video relay whose close never settles cannot starve session release, the database close or the pid file (#11601)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    const sessionManager = daemon.getSessionManager();
    const events: string[] = [];
    setVideoStreamSocketServerForTesting({
      close: () => {
        events.push("video:close");
        return new Promise<void>(() => {});
      },
    } as unknown as VideoStreamSocketServer);
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      events.push(`release:${sessionId}:${reason}`);
    });
    restores.push(unsubscribe);
    closeDatabase.mockImplementation(async () => {
      events.push("closeDatabase");
    });
    cleanupDaemonFiles.mockImplementation(async () => {
      events.push("daemon files");
      return true;
    });
    await sessionManager.createSession("viewer-owner", "emulator-5560", "android");

    await daemon.stop();

    expect(events).toEqual([
      "video:close",
      "release:viewer-owner:daemon-shutdown",
      "closeDatabase",
      "daemon files",
    ]);
    expect(timer.now()).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
    // Nothing before the relay used its share, so the relay ran until the sum of the budgets up
    // to and including its own; the settle stage then gave it the unused rest of the budget.
    const budgets = Object.entries(DAEMON_SHUTDOWN_STAGE_BUDGET_MS);
    const through = (name: string): number =>
      budgets
        .slice(0, budgets.findIndex(([stage]) => stage === name) + 1)
        .reduce((sum, [, ms]) => sum + ms, 0);
    const abandonedAt = through("video stream socket server");
    const settleWaitMs = through("abandoned stage settle") - abandonedAt - 50;
    expect(warnings.filter((message) => message.startsWith("Shutdown "))).toEqual([
      `Shutdown cleanup stage video stream socket server timed out after ${abandonedAt}ms waiting on capture source stop (encoder stop, adb forward removal); continuing shutdown`,
      `Shutdown stage(s) still running ${settleWaitMs}ms after being abandoned: video stream socket server`,
    ]);
  });

  test("an abandoned stage that finishes late is waited for, and the database then closes (#11601)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const events: string[] = [];
    // A recording finalizer that outlives its stage: it needs 4 s, far past the stage deadline.
    const closeSessions = spyOn(
      daemon as unknown as { closeHttpSessionsForShutdown(budgetMs: number): Promise<void> },
      "closeHttpSessionsForShutdown",
    ).mockImplementation(async () => {
      await timer.sleep(4_000);
      events.push("straggler:done");
    });
    restores.push(() => closeSessions.mockRestore());
    closeDatabase.mockImplementation(async () => {
      events.push("closeDatabase");
    });

    await daemon.stop();

    expect(events).toEqual(["straggler:done", "closeDatabase"]);
    expect(timer.now()).toBe(4_000);
    expect(warnings.filter((message) => message.startsWith("Shutdown "))).toEqual([
      expect.stringMatching(/^Shutdown cleanup stage active HTTP sessions timed out after /),
    ]);
  });

  test("an abandoned stage that may still write keeps the database open; the pid file is still removed (#11601)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    // Wedge the stage itself; a single wedged transport is absorbed by its own nested deadline.
    const closeSessions = spyOn(
      daemon as unknown as { closeHttpSessionsForShutdown(budgetMs: number): Promise<void> },
      "closeHttpSessionsForShutdown",
    ).mockImplementation(() => new Promise<void>(() => {}));
    restores.push(() => closeSessions.mockRestore());

    await daemon.stop();

    expect(closeDatabase).not.toHaveBeenCalled();
    expect(cleanupDaemonFiles).toHaveBeenCalledTimes(1);
    expect(warnings).toContain(
      "Skipping database close because abandoned shutdown stage(s) are still running: active HTTP sessions",
    );
    expect(timer.now()).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
  });

  test("a wedged streamable HTTP transport is abandoned inside its stage and the database still closes (#11601)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const closed: string[] = [];
    const transports = (daemon as unknown as DaemonTransportInternals).transports;
    transports.set("wedged-http", { close: () => new Promise<void>(() => {}) });
    transports.set("healthy-http", {
      close: async () => {
        closed.push("healthy-http");
      },
    });

    await daemon.stop();

    expect(closed).toEqual(["healthy-http"]);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(warnings.filter((message) => message.startsWith("Shutdown cleanup stage "))).toEqual([
      expect.stringMatching(
        /^Shutdown cleanup stage Streamable HTTP session wedged-http timed out after \d+ms waiting on its streamable HTTP transport closing; continuing shutdown$/,
      ),
    ]);
  });
});
