import { FakeChildProcess } from "../fakes/FakeChildProcess";
import type { BootedDevice } from "../../src/models";
import type { ChildProcess } from "node:child_process";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NoopTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import type { DaemonExitRecord } from "../../src/daemon/daemonExitRecord";
import { Daemon, type DaemonStartHost } from "../../src/daemon/daemon";
import * as buildIdentity from "../../src/daemon/buildIdentity";
import { daemonProcessOptions } from "../../src/daemon/daemonOptionScopes";
import type { DaemonOptions } from "../../src/daemon/types";
import { DaemonState } from "../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { setCtrlProxyForwardLeaseOwnerSocketPath } from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { executionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

import * as videoManager from "../../src/server/videoRecordingManager";
import { VideoRecordingRepository } from "../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG, VideoRecorderService } from "../../src/features/video";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";

// #10975: `start()` itself must subscribe the daemon to tool-call-end activity (owner decision
// 2026-10-08: the idle window counts from the END of a call). `daemonToolCallEndWiring.test.ts`
// calls the private subscription directly, so a `start()` that stopped calling it survived every
// test. This drives `start()` through its first steps and stops it at the first startup step
// that would touch the machine (the early owner record), with the real subscription in place.

interface DaemonStartInternals {
  daemonSessionId: string;
  options: DaemonOptions;
  port: number;
  processStartHost(): DaemonStartHost;
  setupShutdownHandlers(): void;
  writeEarlyOwnerRecord(): Promise<void>;
  startThroughSocketBind(): Promise<void>;
  initializeDatabase(): Promise<void>;
  initializeDevicePoolWithTimeout(timeoutMs: number): Promise<void>;
  initializeIosServices(): Promise<void>;
  stopSessionTimers(): void;
}

class StartupStopped extends Error {}

/** A guard whose refusal restore leaves the real PID file alone. */
class InertIncumbentGuard extends IncumbentOwnerGuard {
  override restoreIncumbentAfterRefusal(): boolean {
    return false;
  }
}

async function makeDaemon(options: DaemonOptions, guard = new InertIncumbentGuard()) {
  const timer = new FakeTimer();
  const daemon = new Daemon(
    options,
    undefined,
    timer,
    new DeviceSessionRepository(await createTestDatabase(), timer),
    new FakeIdGenerator(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 0,
    () => "memory-generation",
    undefined,
    guard,
  );
  const internals = daemon as unknown as DaemonStartInternals;
  return { daemon, internals, timer };
}

describe("Daemon.start() tool-call-end wiring", () => {
  const restores: Array<() => void> = [];
  let savedLaunchCwd: string | undefined;

  beforeEach(() => {
    savedLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
    const identity = spyOn(buildIdentity, "getCurrentBuildIdentity").mockReturnValue({
      entryScript: "/memory/entry.ts",
      buildId: "memory-build",
    });
    restores.push(() => identity.mockRestore());
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    if (savedLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = savedLaunchCwd;
    }
    setCtrlProxyForwardLeaseOwnerSocketPath(undefined);
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  // Seed the real in-memory repository outside the per-test budget; the measured
  // test still exercises the daemon wiring and real peer-exclusion query.
  async function createOwnerFixture() {
    const identity = spyOn(buildIdentity, "getCurrentBuildIdentity").mockReturnValue({
      entryScript: "/memory/entry.ts",
      buildId: "memory-build",
    });
    const fixture = await makeDaemon({ port: 3161, debug: true }).finally(() =>
      identity.mockRestore(),
    );
    const { daemon, internals, timer } = fixture;
    const db = await createTestDatabase();
    const repository = new VideoRecordingRepository(db);
    const sessions = new DeviceSessionRepository(db, timer);
    const actualOwnId = internals.daemonSessionId;
    const host = internals.processStartHost();
    const live = new Set([actualOwnId, "peer-daemon"]);
    for (const [owner, daemonId] of [
      ["own-owner", actualOwnId],
      ["peer-owner", "peer-daemon"],
    ] as const) {
      await sessions.upsertActiveSession({
        sessionUuid: owner,
        daemonSessionId: daemonId,
        deviceId: owner,
        platform: "android",
        createdAtMs: 0,
        lastUsedAtMs: 0,
        expiresAtMs: 60_000,
        sessionTimeoutMs: 60_000,
        heartbeatTimeoutMs: 10_000,
        hasReceivedHeartbeat: false,
      });
      await repository.insertRecording({
        recordingId: owner,
        recorderDaemonSessionId: daemonId,
        ownerSessionUuid: owner,
        deviceId: owner,
        platform: "android",
        status: "recording",
        fileName: "rec.mp4",
        filePath: "/unused/rec.mp4",
        format: "mp4",
        sizeBytes: 0,
        createdAt: "1970-01-01T00:00:00.000Z",
        startedAt: "1970-01-01T00:00:00.000Z",
        lastAccessedAt: "1970-01-01T00:00:00.000Z",
        config: DEFAULT_VIDEO_RECORDING_CONFIG,
        captureTeardown: {
          kind: "android-screenrecord",
          deviceTempPath: "/sdcard/rec.mp4",
          devicePid: 42,
        },
      });
    }
    return { daemon, internals, timer, db, repository, actualOwnId, host, live };
  }
  let ownerFixture: Awaited<ReturnType<typeof createOwnerFixture>>;
  beforeAll(async () => {
    ownerFixture = await createOwnerFixture();
  });

  test("redrive wiring includes this daemon's rehydrated owner and excludes live peer owners", async () => {
    const { daemon, internals, timer, db, repository, actualOwnId, host, live } = ownerFixture;
    const initialize = spyOn(
      videoManager,
      "initializeRecordingTeardownRedriveState",
    ).mockResolvedValue({
      recordingRepository: repository,
      videoRecorderService: new VideoRecorderService({ backend: new FakeVideoCaptureBackend() }),
      liveDaemonSessionIds: live,
    });
    const incarnations = spyOn(daemon.getDevicePool(), "getDeviceIncarnation").mockReturnValue(1);
    const mark = spyOn(
      daemon.getSessionManager(),
      "markDeviceNeedsRecorderTeardown",
    ).mockImplementation(() => {});
    try {
      expect(await host.redriveRecorderTeardowns()).toBe(true);
      expect(mark.mock.calls.map((call) => call[0])).toEqual(["own-owner"]);
      expect(live).toEqual(new Set([actualOwnId, "peer-daemon"]));
    } finally {
      initialize.mockRestore();
      incarnations.mockRestore();
      mark.mockRestore();
      internals.stopSessionTimers();
      timer.reset();
      await db.destroy();
    }
  });

  test("pool process-start callback reaches the startup redrive listener", async () => {
    const { daemon, internals, timer } = await makeDaemon({ port: 3161, debug: true });
    const repo = new FakeVideoRecordingRepository();
    await repo.insertRecording({
      recordingId: "old-process",
      deviceId: "emulator-5554",
      platform: "android",
      status: "interrupted",
      fileName: "old.mp4",
      filePath: "/unused/old.mp4",
      format: "mp4",
      sizeBytes: 0,
      createdAt: "1970-01-01T00:00:00.000Z",
      startedAt: "1970-01-01T00:00:00.000Z",
      lastAccessedAt: "1970-01-01T00:00:00.000Z",
      config: DEFAULT_VIDEO_RECORDING_CONFIG,
      captureTeardown: {
        kind: "android-screenrecord",
        devicePid: 42,
        deviceTempPath: "/sdcard/old.mp4",
      },
    });
    const initialize = spyOn(
      videoManager,
      "initializeRecordingTeardownRedriveState",
    ).mockResolvedValue({
      recordingRepository: repo,
      videoRecorderService: new VideoRecorderService({ backend: new FakeVideoCaptureBackend() }),
      liveDaemonSessionIds: new Set(),
    });
    const incarnation = spyOn(daemon.getDevicePool(), "getDeviceIncarnation").mockReturnValue(1);
    let disposed = 0;
    const mark = spyOn(
      daemon.getSessionManager(),
      "markDeviceNeedsRecorderTeardown",
    ).mockImplementation(() => () => {
      disposed++;
    });
    try {
      expect(await internals.processStartHost().redriveRecorderTeardowns()).toBe(true);
      const pool = daemon.getDevicePool() as unknown as {
        trackStartedDeviceProcess(device: BootedDevice, child: ChildProcess): Promise<void>;
      };
      await pool.trackStartedDeviceProcess(
        { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
        new FakeChildProcess() as unknown as ChildProcess,
      );
      expect(disposed).toBe(1);
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      expect((await repo.getRecording("old-process"))?.captureTeardown).toBeUndefined();
    } finally {
      initialize.mockRestore();
      incarnation.mockRestore();
      mark.mockRestore();
      internals.stopSessionTimers();
      timer.reset();
    }
  });

  test("startup redrives recorder teardowns after pool initialization before binding the control socket", async () => {
    const { daemon, internals } = await makeDaemon({ port: 3161, debug: true });
    const events: string[] = [];
    const spies = [
      spyOn(internals, "initializeDatabase").mockResolvedValue(undefined),
      spyOn(internals, "initializeDevicePoolWithTimeout").mockImplementation(async () => {
        events.push("pool");
      }),
      spyOn(internals, "initializeIosServices").mockResolvedValue(undefined),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    const host: DaemonStartHost = {
      ...internals.processStartHost(),
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeExitRecord: () => {},
      writeEarlyOwnerRecord: async () => {},
      openTerminalReleaseJournal: () => new NoopTerminalReleaseJournal(),
      startHttpIngress: async () => {},
      sweepStaleAppearanceConfigs: async () => {},
      redriveRecorderTeardowns: async () => {
        events.push("redrive");
        return true;
      },
      bindControlSocket: async () => {
        events.push("bind");
        throw new StartupStopped();
      },
    };
    try {
      await expect(daemon.startOn(host)).rejects.toBeInstanceOf(StartupStopped);
      expect(events).toEqual(["pool", "redrive", "bind"]);
    } finally {
      spies.reverse().forEach((spy) => spy.mockRestore());
      internals.stopSessionTimers();
    }
  });

  test("a started daemon stamps a session's activity at the end of its tool call", async () => {
    const { daemon, internals, timer } = await makeDaemon({ port: 3161, debug: true });
    for (const spy of [
      spyOn(process, "chdir").mockImplementation(() => {}),
      spyOn(logger, "enableStdoutLogging").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(internals, "setupShutdownHandlers").mockImplementation(() => {}),
      spyOn(internals, "writeEarlyOwnerRecord").mockRejectedValue(new StartupStopped()),
    ]) {
      restores.push(() => spy.mockRestore());
    }
    const exits: DaemonExitRecord[] = [];
    const host = internals.processStartHost();
    host.writeExitRecord = (record) => exits.push(record);
    const sessionManager = daemon.getSessionManager();
    const session = await sessionManager.createSession("start-wiring", "emulator-5554", "android");

    try {
      await expect(daemon.startOn(host)).rejects.toBeInstanceOf(StartupStopped);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toEqual({
        reason: "startup-failure",
        exitedAtMs: 0,
        buildId: "memory-build",
        options: { ...daemonProcessOptions(internals.options), port: 3161 },
      });

      // Held side: a call refused at admission is not use (#10824): its end moves nothing.
      const refused = executionTracker.startExecution("tapOn", undefined, "start-wiring");
      timer.advanceTime(30_000);
      executionTracker.endExecution(refused.id);
      expect(session.lastUsedAt).toBe(0);

      const execution = executionTracker.startExecution("tapOn", undefined, "start-wiring");
      executionTracker.markSessionAdmitted(execution.id);
      timer.advanceTime(60_000);
      executionTracker.endExecution(execution.id);

      // The end of the admitted call restarted the idle window from that moment.
      expect(session.lastUsedAt).toBe(90_000);
      expect(session.expiresAt).toBe(90_000 + session.sessionTimeoutMs);
    } finally {
      internals.stopSessionTimers();
    }
  });

  test.each(["before", "inside"] as const)(
    "a start failing %s process entry records nothing through its host",
    async (phase) => {
      const { daemon, internals } = await makeDaemon({ port: 3161, debug: true });
      const write = spyOn(internals.processStartHost(), "writeExitRecord").mockImplementation(
        () => {},
      );
      restores.push(() => write.mockRestore());
      const host: DaemonStartHost = {
        ...internals.processStartHost(),
        writeExitRecord: write,
        enterProcess: () => {
          throw new StartupStopped();
        },
      };
      if (phase === "before") {
        const beforeEntry = spyOn(internals, "startThroughSocketBind").mockRejectedValue(
          new StartupStopped(),
        );
        restores.push(() => beforeEntry.mockRestore());
      }
      try {
        await expect(daemon.startOn(host)).rejects.toBeInstanceOf(StartupStopped);
        expect(write).not.toHaveBeenCalled();
      } finally {
        internals.stopSessionTimers();
      }
    },
  );

  test("a start refused over a live foreign socket owner records nothing through its host", async () => {
    const guard = new InertIncumbentGuard({
      readPidFile: () => ({
        pid: 9001,
        socketPath: "/memory/incumbent.sock",
        port: 3161,
        startedAt: 0,
        version: "test",
        entryScript: "/memory/entry.ts",
        buildId: "memory-build",
      }),
      persistPidFile: () => {
        throw new Error("refused contender must not persist a record");
      },
      isProcessRunning: (pid) => pid === 9001,
      readProcessGenerationToken: () => undefined,
      selfPid: 4242,
    });
    const { daemon, internals } = await makeDaemon({ port: 4000, debug: true }, guard);
    const exits: DaemonExitRecord[] = [];
    const host: DaemonStartHost = {
      ...internals.processStartHost(),
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeExitRecord: (entry) => void exits.push(entry),
      writeEarlyOwnerRecord: async () => {
        guard.captureIncumbentBeforeOverwrite();
        expect(guard.hasLiveForeignOwner()).toBe(true);
        throw new StartupStopped();
      },
    };
    try {
      await expect(daemon.startOn(host)).rejects.toBeInstanceOf(StartupStopped);
      expect(exits).toEqual([]);
    } finally {
      internals.stopSessionTimers();
    }
  });
});
