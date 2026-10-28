import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DaemonBroker } from "../../src/daemon/daemonCore/DaemonBroker";
import { DeviceClaimMirrorHub } from "../../src/daemon/deviceClaimMirrorHub";
import { BackgroundBindingRegistryUpgrade } from "../../src/daemon/sessionBroker/registry/BackgroundBindingRegistryUpgrade";
import { daemonSocketServerDouble } from "../../src/daemon/daemonSocketServer";
import type { SqliteBindingRegistry } from "../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import * as bindingRegistryModule from "../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { PlatformVideoCaptureBackend } from "../../src/features/video/PlatformVideoCaptureBackend";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NoopTerminalReleaseJournal } from "../../src/daemon/NoopTerminalReleaseJournal";
import type { DaemonExitRecord } from "../../src/daemon/daemonExitRecord";
import { Daemon, type DaemonStartHost } from "../../src/daemon/daemon";
import {
  FakeDaemonHttpTokenStore,
  FileDaemonHttpTokenStore,
  type DaemonHttpTokenStore,
} from "../../src/daemon/daemonHttpToken";
import { FakeHttpServer } from "../fakes/FakeHttpServer";
import type { HttpListener } from "../../src/daemon/daemonHttpIngress";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as buildIdentity from "../../src/daemon/wire/buildIdentity";
import { daemonProcessOptions } from "../../src/daemon/daemonOptionScopes";
import type { DaemonOptions } from "../../src/daemon/types";
import { DaemonState } from "../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { setCtrlProxyForwardLeaseOwnerSocketPath } from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { executionTracker } from "../../src/daemon/executionTracker";
import { logger } from "../../src/utils/logger";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

import * as videoManager from "../../src/daemon/videoRecordingManager";
import { VideoRecordingRepository } from "../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG, VideoRecorderService } from "../../src/features/video";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";

// #10975: `start()` itself must subscribe the daemon to tool-call-end activity (owner decision
// 2026-10-08: the idle window counts from the END of a call). `daemonToolCallEndWiring.test.ts`
// calls the private subscription directly, so a `start()` that stopped calling it survived every
// test. This drives `start()` through its first steps and stops it at the first startup step
// that would touch the machine (the early owner record), with the real subscription in place.

class StartupStopped extends Error {}

/** A guard whose refusal restore leaves the real PID file alone. */
class InertIncumbentGuard extends IncumbentOwnerGuard {
  override restoreIncumbentAfterRefusal(): boolean {
    return false;
  }
}

async function makeDaemon(
  options: DaemonOptions,
  guard = new InertIncumbentGuard(),
  tokenStore: DaemonHttpTokenStore = new FakeDaemonHttpTokenStore(),
  httpServer?: HttpListener,
) {
  const timer = new FakeTimer();
  const daemon = new Daemon(options, {
    httpTokenStore: tokenStore,
    httpServerFactory: httpServer ? () => httpServer : undefined,
    timer,
    deviceSessionRepository: new DeviceSessionRepository(await createTestDatabase(), timer),
    idGenerator: new FakeIdGenerator(),
    processBirthTime: () => 0,
    processGenerationToken: () => "memory-generation",
    incumbentOwnerGuard: guard,
  });
  return { daemon, internals: daemon, timer, tokenStore };
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
    videoManager.setStartupOrphanCaptures(undefined);
    expect(videoManager.getStartupOrphanCaptures()).toBeUndefined();
    setCtrlProxyForwardLeaseOwnerSocketPath(undefined);
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("redrive wiring includes this daemon's rehydrated owner and excludes live peer owners", async () => {
    const { daemon, internals, timer } = await makeDaemon({ port: 3161, debug: true });
    const db = await createTestDatabase();
    const repository = new VideoRecordingRepository(db);
    const sessions = new DeviceSessionRepository(db, timer);
    const actualOwnId = internals.testHooks.daemonSessionId();
    const host = internals.testHooks.processStartHost();
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
    ).mockImplementation(() => () => {});
    try {
      expect(await host.redriveRecorderTeardowns()).toBe(true);
      expect(mark.mock.calls.map((call) => call[0])).toEqual(["own-owner"]);
      expect(live).toEqual(new Set([actualOwnId, "peer-daemon"]));
    } finally {
      initialize.mockRestore();
      incarnations.mockRestore();
      mark.mockRestore();
      internals.testHooks.stopSessionTimers();
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
    const device = spyOn(daemon.getDevicePool(), "getDevice").mockReturnValue({
      id: "emulator-5554",
      name: "Pixel",
      platform: "android",
      sessionId: null,
      status: "idle",
      lastUsedAt: 0,
      assignmentCount: 0,
      errorCount: 0,
      incarnation: 1,
    });
    const confirm = spyOn(
      PlatformVideoCaptureBackend.prototype,
      "forceStopOrphanedCapture",
    ).mockResolvedValue(undefined);
    let disposed = 0;
    const mark = spyOn(
      daemon.getSessionManager(),
      "markDeviceNeedsRecorderTeardown",
    ).mockImplementation(() => () => {
      disposed++;
    });
    try {
      expect(await internals.testHooks.processStartHost().redriveRecorderTeardowns()).toBe(true);
      expect(videoManager.getStartupOrphanCaptures()?.find("old-process")).toEqual({
        recordingId: "old-process",
        deviceId: "emulator-5554",
        ownerSessionUuid: undefined,
      });
      await daemon
        .getDevicePool()
        .trackStartedDeviceProcess(
          { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
          new FakeChildProcess(),
        );
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(
        { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
        { kind: "android-screenrecord", devicePid: 42, deviceTempPath: "/sdcard/old.mp4" },
      );
      expect(disposed).toBe(1);
      expect((await repo.getRecording("old-process"))?.captureTeardown).toBeUndefined();
    } finally {
      confirm.mockRestore();
      device.mockRestore();
      initialize.mockRestore();
      incarnation.mockRestore();
      mark.mockRestore();
      internals.testHooks.stopSessionTimers();
      timer.reset();
    }
  });

  test("a contender refused at the control socket preserves the incumbent HTTP token", async () => {
    const server = new FakeHttpServer(false);
    const listener: HttpListener = server;
    const { daemon, internals, tokenStore } = await makeDaemon(
      { port: 3161, debug: true },
      undefined,
      undefined,
      server,
    );
    tokenStore.write("stale-token");
    const events: string[] = [];
    const spies = [
      spyOn(listener, "listen").mockImplementation((_port, _host, callback) => {
        expect(tokenStore.read()).toBe("stale-token");
        events.push("listen");
        queueMicrotask(() => {
          callback();
        });
        return server;
      }),
      spyOn(internals, "initializeDatabase").mockResolvedValue(undefined),
      spyOn(internals, "initializeDevicePoolWithTimeout").mockImplementation(async () => {
        events.push("pool");
      }),
      spyOn(internals, "initializeIosServices").mockResolvedValue(undefined),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    const host: DaemonStartHost = {
      ...internals.testHooks.processStartHost(),
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeExitRecord: () => {},
      writeEarlyOwnerRecord: async () => {},
      openTerminalReleaseJournal: () => new NoopTerminalReleaseJournal(),
      prepareHttpToken: () => {
        internals.testHooks.processStartHost().prepareHttpToken();
        events.push("prepare");
      },
      publishHttpToken: () => {
        internals.testHooks.processStartHost().publishHttpToken();
        expect(tokenStore.read()).not.toBe("stale-token");
        events.push("token");
      },
      startHttpIngress: async () => {
        await internals.testHooks.httpIngress.start();
        events.push("http");
      },
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
      expect(events).toEqual(["prepare", "listen", "http", "pool", "redrive", "bind"]);
      expect(tokenStore.read()).toBe("stale-token");
    } finally {
      spies.reverse().forEach((spy) => spy.mockRestore());
      internals.testHooks.stopSessionTimers();
    }
  });

  test("starts broker recovery exactly once after the control socket bind", async () => {
    const { daemon, timer } = await makeDaemon({ port: 3161 });
    daemon.testHooks.overrideStartupStages({ stopAfterFailedStartup: async () => {} });
    const start = mock(() => {});
    const install = spyOn(DaemonBroker.prototype, "installSessionBroker").mockResolvedValue({
      start,
    });
    const spies = [
      install,
      spyOn(bindingRegistryModule, "bindingRegistryFileExists").mockReturnValue(false),
      spyOn(daemon, "initializeDatabase").mockResolvedValue(undefined),
      spyOn(daemon, "initializeDevicePoolWithTimeout").mockResolvedValue(undefined),
      spyOn(daemon, "initializeIosServices").mockResolvedValue(undefined),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    const bind = mock(async () => {
      expect(install).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      return daemonSocketServerDouble({ isListening: () => true });
    });
    const host: DaemonStartHost = {
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeExitRecord: () => {},
      writeEarlyOwnerRecord: async () => {},
      openTerminalReleaseJournal: () => new NoopTerminalReleaseJournal(),
      prepareHttpToken: () => {},
      publishHttpToken: () => {},
      startHttpIngress: async () => {},
      sweepStaleAppearanceConfigs: async () => {},
      redriveRecorderTeardowns: async () => true,
      bindControlSocket: bind,
      startServicesAfterSocketBind: async () => {
        expect(bind).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
      },
      startMaintenanceMonitors: () => {},
    };
    try {
      // startOn runs the real startThroughSocketBind and startAfterSocketBind stages.
      await daemon.startOn(host);
      expect(bind).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      spies.reverse().forEach((spy) => spy.mockRestore());
      daemon.testHooks.stopSessionTimers();
      timer.reset();
    }
  });

  test("token publication failure after control binding fails startup", async () => {
    const { daemon, tokenStore } = await makeDaemon({ port: 3161 });
    const database = spyOn(daemon, "initializeDatabase").mockResolvedValue(undefined);
    const pool = spyOn(daemon, "initializeDevicePoolWithTimeout").mockResolvedValue(undefined);
    const ios = spyOn(daemon, "initializeIosServices").mockResolvedValue(undefined);
    const write = spyOn(tokenStore, "write").mockImplementation(() => {
      throw new Error("Token publication failed");
    });
    let bound = false;
    const startHttpIngress = async () => {
      bound = true;
    };
    const host: DaemonStartHost = {
      ...daemon.testHooks.processStartHost(),
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeExitRecord: () => {},
      writeEarlyOwnerRecord: async () => {},
      openTerminalReleaseJournal: () => new NoopTerminalReleaseJournal(),
      startHttpIngress,
      sweepStaleAppearanceConfigs: async () => {},
      redriveRecorderTeardowns: async () => true,
      bindControlSocket: async () =>
        new UnixSocketServer("/memory/unbound.sock", DaemonState.getInstance()),
    };
    try {
      await expect(daemon.startOn(host)).rejects.toThrow("Token publication failed");
      expect(write).toHaveBeenCalledTimes(1);
      expect(bound).toBe(true);
      expect(tokenStore.read()).toBeUndefined();
    } finally {
      write.mockRestore();
      pool.mockRestore();
      ios.mockRestore();
      database.mockRestore();
      daemon.testHooks.stopSessionTimers();
    }
  });

  test.each([false, true])(
    "failed HTTP bind preserves an existing token file (strictPort=%s)",
    async (strictPort) => {
      const directory = mkdtempSync(join(tmpdir(), "am-token-bind-"));
      const path = join(directory, "daemon.token");
      const store = new FileDaemonHttpTokenStore(path);
      store.write("running-daemon-token");
      const server = new FakeHttpServer(false);
      const { daemon } = await makeDaemon(
        { port: 3161, strictPort },
        undefined,
        new FileDaemonHttpTokenStore(path),
        server,
      );
      const database = spyOn(daemon, "initializeDatabase").mockResolvedValue(undefined);
      const listen = spyOn(server, "listen").mockImplementation(() => {
        queueMicrotask(() =>
          server.emit("error", Object.assign(new Error("bind EADDRINUSE"), { code: "EADDRINUSE" })),
        );
        return server;
      });
      const host: DaemonStartHost = {
        ...daemon.testHooks.processStartHost(),
        enterProcess: () => {},
        publishForwardLeaseOwner: () => {},
        writeExitRecord: () => {},
        writeEarlyOwnerRecord: async () => {},
        openTerminalReleaseJournal: () => new NoopTerminalReleaseJournal(),
        startHttpIngress: () => daemon.testHooks.httpIngress.start(),
      };
      try {
        await expect(daemon.startOn(host)).rejects.toThrow(
          strictPort ? "already in use" : "EADDRINUSE",
        );
        expect(listen).toHaveBeenCalledTimes(1);
        expect(readFileSync(path, "utf8")).toBe("running-daemon-token");
      } finally {
        listen.mockRestore();
        database.mockRestore();
        daemon.testHooks.stopSessionTimers();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { broker: false, bound: false, migrate: false },
    { broker: false, bound: true, migrate: true },
    { broker: true, bound: false, migrate: true },
  ])("registry open policy before/after bind: %j", async ({ broker, bound, migrate }) => {
    const { internals, timer } = await makeDaemon({ port: 3161, debug: true });
    const open = spyOn(bindingRegistryModule, "openSqliteBindingRegistry").mockRejectedValue(
      new Error("fake open refused"),
    );
    internals.testHooks.setSessionBrokerConfigPath(broker ? "/memory/broker.json" : undefined);
    internals.testHooks.setSocketBindCommitted(bound);
    try {
      await expect(internals.testHooks.openBindingRegistry()).rejects.toThrow("fake open refused");
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ migrate }));
    } finally {
      open.mockRestore();
      internals.testHooks.stopSessionTimers();
      timer.reset();
    }
  });

  test.each([
    { broker: false, exists: true },
    { broker: false, exists: false },
    { broker: true, exists: true },
  ])("registry retirement startup ordering: %j", async ({ broker, exists }) => {
    const { internals, timer, tokenStore } = await makeDaemon({ port: 3161, debug: true });
    tokenStore.write("incumbent-token");
    const events: string[] = [];
    let stopped = false;
    const spies = [
      spyOn(bindingRegistryModule, "bindingRegistryFileExists").mockReturnValue(exists),
      spyOn(internals, "initializeDatabase").mockResolvedValue(undefined),
      spyOn(internals, "initializeDevicePoolWithTimeout").mockImplementation(async () => {
        events.push("pool");
      }),
      spyOn(internals, "initializeIosServices").mockResolvedValue(undefined),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ];
    const startUpgrade = spyOn(BackgroundBindingRegistryUpgrade.prototype, "start");
    spies.push(startUpgrade);
    internals.testHooks.overrideStartSteps({
      openBindingRegistry: async (signal) => {
        events.push("retirement");
        if (broker) {
          throw new Error("legacy owner still live");
        }
        // The open never produces a registry; the abort is how the daemon cancels the wait.
        return await new Promise<SqliteBindingRegistry>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              stopped = true;
              reject(new Error("registry open aborted"));
            },
            { once: true },
          ),
        );
      },
    });
    internals.testHooks.setSessionBrokerConfigPath(broker ? "/memory/broker.json" : undefined);
    internals.testHooks.setStartHost({
      ...internals.testHooks.processStartHost(),
      enterProcess: () => {},
      publishForwardLeaseOwner: () => {},
      writeExitRecord: () => {},
      writeEarlyOwnerRecord: async () => {},
      openTerminalReleaseJournal: () => new NoopTerminalReleaseJournal(),
      startHttpIngress: async () => {
        events.push("ingress");
      },
      sweepStaleAppearanceConfigs: async () => {},
      redriveRecorderTeardowns: async () => true,
      bindControlSocket: async () => {
        expect(tokenStore.read()).toBe("incumbent-token");
        events.push("bind");
        return new UnixSocketServer("/memory/unbound.sock", DaemonState.getInstance(), timer);
      },
    });
    try {
      if (broker) {
        await expect(internals.testHooks.startThroughSocketBind()).rejects.toThrow(
          "Session broker cannot start",
        );
        expect(events).toEqual(["retirement"]);
      } else {
        await internals.testHooks.startThroughSocketBind();
        expect(events).toEqual(
          exists ? ["ingress", "pool", "bind", "retirement"] : ["ingress", "pool", "bind"],
        );
        expect(startUpgrade).toHaveBeenCalledTimes(exists ? 1 : 0);
        if (exists) {
          const upgrade = internals.testHooks.runtime.backgroundRegistryUpgrade;
          expect(internals.testHooks.startBackgroundRegistryUpgrade()).toBe(true);
          expect(internals.testHooks.runtime.backgroundRegistryUpgrade).toBe(upgrade);
          expect(startUpgrade).toHaveBeenCalledTimes(1);
        } else {
          // No open means startup cannot create a registry for a host without one.
          expect(internals.testHooks.runtime.backgroundRegistryUpgrade).toBeUndefined();
          expect(internals.testHooks.runtime.bindingRegistry).toBeUndefined();
        }
        expect(tokenStore.read()).not.toBe("incumbent-token");
        expect(stopped).toBe(false);
        await internals.testHooks.closeManagedExecutionRelease();
        expect(stopped).toBe(exists);
        expect(timer.now()).toBe(0);
      }
    } finally {
      spies.reverse().forEach((spy) => spy.mockRestore());
      internals.testHooks.stopSessionTimers();
      timer.reset();
    }
  });

  test("pool mirrors defer opening until bind, share one upgrade, and cannot reopen during close", async () => {
    const registered = spyOn(DeviceClaimMirrorHub.prototype, "register");
    const exists = spyOn(bindingRegistryModule, "bindingRegistryFileExists").mockReturnValue(false);
    const startUpgrade = spyOn(BackgroundBindingRegistryUpgrade.prototype, "start");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const { daemon, timer } = await makeDaemon({ port: 3161 });
    const pending = Promise.withResolvers<SqliteBindingRegistry>();
    const open = mock((_signal?: AbortSignal) => pending.promise);
    daemon.testHooks.overrideStartSteps({ openBindingRegistry: open });
    const android = registered.mock.calls[0]![0];
    const ios = registered.mock.calls[1]![0];
    try {
      expect(daemon.testHooks.startBackgroundRegistryUpgrade()).toBe(false);
      android.claimed("emulator-5610", { pid: 100, ownerToken: "android" });
      expect(open).not.toHaveBeenCalled();
      exists.mockReturnValue(true);
      timer.advanceTime(1_000);
      expect(open).not.toHaveBeenCalled();
      expect(daemon.testHooks.runtime.backgroundRegistryUpgrade).toBeUndefined();
      daemon.testHooks.setSocketBindCommitted(true);
      timer.advanceTime(5_000);
      expect(open).toHaveBeenCalledTimes(1);
      const upgrade = daemon.testHooks.runtime.backgroundRegistryUpgrade;
      expect(upgrade).toBeInstanceOf(BackgroundBindingRegistryUpgrade);
      ios.claimed("UDID-1", { pid: 100, ownerToken: "ios" });
      expect(daemon.testHooks.startBackgroundRegistryUpgrade()).toBe(true);
      expect(daemon.testHooks.runtime.backgroundRegistryUpgrade).toBe(upgrade);
      expect(startUpgrade).toHaveBeenCalledTimes(1);

      // Close is still joining the opener; the hub is not disposed yet.
      const closing = daemon.testHooks.closeManagedExecutionRelease();
      expect(open.mock.calls[0]![0]?.aborted).toBe(true);
      expect(daemon.testHooks.startBackgroundRegistryUpgrade()).toBe(false);
      pending.reject(new Error("fake open aborted"));
      await closing;
      expect(daemon.testHooks.runtime.backgroundRegistryUpgrade).toBeUndefined();
      expect(daemon.testHooks.startBackgroundRegistryUpgrade()).toBe(false);
      timer.advanceTime(1_000_000);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      pending.reject(new Error("fake open aborted"));
      await daemon.testHooks.closeManagedExecutionRelease();
      registered.mockRestore();
      exists.mockRestore();
      startUpgrade.mockRestore();
      warn.mockRestore();
      daemon.testHooks.stopSessionTimers();
      timer.reset();
    }
  });

  test("broker-mode late writes leave registry preparation to broker startup", async () => {
    const registered = spyOn(DeviceClaimMirrorHub.prototype, "register");
    const exists = spyOn(bindingRegistryModule, "bindingRegistryFileExists").mockReturnValue(true);
    const startUpgrade = spyOn(BackgroundBindingRegistryUpgrade.prototype, "start");
    const { daemon, timer } = await makeDaemon({ port: 3161 });
    const open = mock(async (): Promise<SqliteBindingRegistry> => {
      throw new Error("local upgrade must not run in broker mode");
    });
    daemon.testHooks.overrideStartSteps({ openBindingRegistry: open });
    daemon.testHooks.setSessionBrokerConfigPath("/memory/broker.json");
    daemon.testHooks.setSocketBindCommitted(true);
    try {
      expect(daemon.testHooks.startBackgroundRegistryUpgrade()).toBe(true);
      const mirror = registered.mock.calls[0]![0];
      mirror.claimed("emulator-5610", { pid: 100, ownerToken: "owner" });
      timer.advanceTime(1_000_000);
      expect(open).not.toHaveBeenCalled();
      expect(startUpgrade).not.toHaveBeenCalled();
      expect(daemon.testHooks.runtime.backgroundRegistryUpgrade).toBeUndefined();
    } finally {
      daemon.testHooks.runtime.deviceClaimMirrors.dispose();
      registered.mockRestore();
      exists.mockRestore();
      startUpgrade.mockRestore();
      daemon.testHooks.stopSessionTimers();
      timer.reset();
    }
  });

  test("shutdown-in-progress refuses a late upgrade before the registry close stage", async () => {
    const { daemon, timer } = await makeDaemon({ port: 3161 });
    daemon.testHooks.setSocketBindCommitted(true);
    daemon.testHooks.markShutdownInProgress();
    expect(daemon.testHooks.startBackgroundRegistryUpgrade()).toBe(false);
    expect(daemon.testHooks.runtime.backgroundRegistryUpgrade).toBeUndefined();
    daemon.testHooks.stopSessionTimers();
    timer.reset();
  });

  test("a started daemon stamps a session's activity at the end of its tool call", async () => {
    const { daemon, internals, timer } = await makeDaemon({ port: 3161, debug: true });
    for (const spy of [
      spyOn(process, "chdir").mockImplementation(() => {}),
      spyOn(logger, "enableStdoutLogging").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ]) {
      restores.push(() => spy.mockRestore());
    }
    const exits: DaemonExitRecord[] = [];
    const host = internals.testHooks.processStartHost();
    host.writeExitRecord = (record) => exits.push(record);
    host.writeEarlyOwnerRecord = async () => {
      throw new StartupStopped();
    };
    internals.testHooks.overrideStartSteps({ setupShutdownHandlers: () => {} });
    const sessionManager = daemon.getSessionManager();
    const session = await sessionManager.createSession("start-wiring", "emulator-5554", "android");

    try {
      await expect(daemon.startOn(host)).rejects.toBeInstanceOf(StartupStopped);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toEqual({
        reason: "startup-failure",
        exitedAtMs: 0,
        buildId: "memory-build",
        options: { ...daemonProcessOptions(internals.testHooks.options()), port: 3161 },
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
      internals.testHooks.stopSessionTimers();
    }
  });

  test.each(["before", "inside"] as const)(
    "a start failing %s process entry records nothing through its host",
    async (phase) => {
      const { daemon, internals } = await makeDaemon({ port: 3161, debug: true });
      const write = spyOn(
        internals.testHooks.processStartHost(),
        "writeExitRecord",
      ).mockImplementation(() => {});
      restores.push(() => write.mockRestore());
      const host: DaemonStartHost = {
        ...internals.testHooks.processStartHost(),
        writeExitRecord: write,
        enterProcess: () => {
          throw new StartupStopped();
        },
      };
      if (phase === "before") {
        internals.testHooks.overrideStartSteps({
          startThroughSocketBind: async () => {
            throw new StartupStopped();
          },
        });
      }
      try {
        await expect(daemon.startOn(host)).rejects.toBeInstanceOf(StartupStopped);
        expect(write).not.toHaveBeenCalled();
      } finally {
        internals.testHooks.stopSessionTimers();
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
      ...internals.testHooks.processStartHost(),
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
      internals.testHooks.stopSessionTimers();
    }
  });
});
