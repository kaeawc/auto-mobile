import type { ChildProcess } from "node:child_process";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import {
  NativeHelperRegistry,
  getNativeHelperRegistry,
} from "../../src/utils/nativeHelpers/NativeHelperRegistry";
import { FakeNativeHelperRecordStore } from "../fakes/FakeNativeHelperRecordStore";
import { FakeNativeHelperProcessControl } from "../fakes/FakeNativeHelperProcessControl";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeLogger } from "../fakes/FakeLogger";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { BaseSocketServer } from "../../src/daemon/socketServer/BaseSocketServer";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import {
  VideoStreamSocketServer,
  setVideoStreamSocketServerForTesting,
} from "../../src/daemon/videoStreamSocketServer";
import * as databaseIndexModule from "../../src/db";
import * as databaseModule from "../../src/db/database";
import * as dbWriteBarrierModule from "../../src/db/dbWriteBarrier";
import { iosSimulatorCaptureHelperPool } from "../../src/features/screen-stream";
import type { IosScreenCaptureHelperEvents } from "../../src/features/screen-stream/IosScreenCaptureHelper";
import { IosSimulatorCaptureHelperPool } from "../../src/features/screen-stream/IosSimulatorCaptureHelperPool";
import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import type { BootedDevice } from "../../src/models";
import { resetVideoRecordingManagerDependencies } from "../../src/daemon/videoRecordingManager";
import * as shutdownCleanupModule from "../../src/shutdownCleanup";
import {
  DAEMON_SHUTDOWN_STAGES,
  STDIO_SHUTDOWN_STAGES,
  createStdioShutdownStages,
  type ShutdownCleanupStage,
  type ShutdownCleanupStageContext,
  type ShutdownStageSpec,
} from "../../src/shutdownCleanup";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import {
  MANAGED_ADB_SERVER_ENV,
  stopManagedAdbServer,
} from "../../src/utils/android-cmdline-tools/AdbServerLifecycle";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

// The database stays open while an abandoned shutdown stage that may write is still running.
// A stage declared `mayWriteDatabase: false` is exempt, so that declaration has to be true: each
// one's REAL teardown runs here, with a live resource built from fakes, against a database that
// throws on any use. A stage with no probe here must keep the safe default (#11601).

const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
  setVideoStreamSocketServerForTesting(null);
  resetVideoRecordingManagerDependencies();
  if (DaemonState.getInstance().isInitialized()) {
    DaemonState.getInstance().reset();
  }
});

/** Make every way into the database throw, and record which one was taken. */
function closeTheDatabase(): string[] {
  const uses: string[] = [];
  const trip = (entry: string) => () => {
    uses.push(entry);
    throw new Error(`database used after close: ${entry}`);
  };
  for (const spy of [
    spyOn(databaseModule, "getDatabase").mockImplementation(trip("getDatabase")),
    spyOn(databaseIndexModule, "getDatabase").mockImplementation(trip("getDatabase")),
    spyOn(dbWriteBarrierModule, "getDbWriteBarrier").mockImplementation(trip("getDbWriteBarrier")),
  ]) {
    restores.push(() => spy.mockRestore());
  }
  return uses;
}

const stageContext: ShutdownCleanupStageContext = {
  remainingMs: () => 1_000,
  unsettledStages: () => [],
  unsettledDatabaseWriters: () => [],
  waitForUnsettledStages: async () => true,
};

function fakeAdbFactory(commands: string[][]): AdbClientFactory {
  const adb: Pick<AdbExecutor, "execute"> = {
    async execute(args): Promise<never> {
      commands.push(args);
      return undefined as never;
    },
  };
  return { create: () => adb as AdbExecutor };
}

/** The real managed-adb shutdown, in managed mode, against a fake adb. */
function managedAdbShutdown(timer: FakeTimer, commands: string[][]): () => Promise<void> {
  return () =>
    stopManagedAdbServer({
      adbFactory: fakeAdbFactory(commands),
      environment: { [MANAGED_ADB_SERVER_ENV]: "1" },
      timer,
    });
}

/** The stages `Daemon.stop()` hands the runner, captured without running any of them. */
async function daemonShutdownStages(
  timer: FakeTimer,
  adbCommands: string[][],
): Promise<Map<string, ShutdownCleanupStage>> {
  const daemon = new Daemon(
    {},
    {
      installedAppsRepository: new FakeInstalledAppsRepository(),
      timer,
      deviceSessionRepository: new FakeDeviceSessionRepository(),
      recoveryPolicyEnvironment: process.env,
      managedAdbServerShutdown: managedAdbShutdown(timer, adbCommands),
    },
  );
  let captured: readonly ShutdownCleanupStage[] = [];
  const run = spyOn(shutdownCleanupModule, "runShutdownCleanupStages").mockImplementation(
    async (stages) => {
      captured = stages;
    },
  );
  try {
    await daemon.stop();
  } finally {
    run.mockRestore();
  }
  return new Map(captured.map((stage) => [stage.name, stage]));
}

class RecordingSource implements H264CaptureSource {
  stops = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stops++;
  }
  requestKeyFrame(): boolean {
    return true;
  }
  setHasConsumers(): void {}
}

class RelayUnderTest extends VideoStreamSocketServer {
  line(socket: FakeSocket, request: unknown): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }
}

const allowAll: StreamSocketAuthenticator = {
  authorize: () => {},
  isAuthenticationEnforced: () => true,
};

const device = { deviceId: "probe-device", platform: "android", name: "Fake" } as BootedDevice;

/** A real video relay with one live capture and one subscribed viewer. */
async function relayWithLiveCapture(timer: FakeTimer, source: RecordingSource): Promise<void> {
  const relay = new RelayUnderTest(
    {
      resolveDevice: async () => device,
      captureRegistry: createDeviceCaptureRegistry(),
      createCaptureSource: async () => source,
      nowUs: () => 1000n,
    },
    "/unused/database-free-probe.sock",
    timer,
    allowAll,
    { assertDeviceActionable: () => {} },
  );
  const bind = spyOn(BaseSocketServer.prototype, "start").mockResolvedValue(undefined);
  try {
    await relay.start();
  } finally {
    bind.mockRestore();
  }
  await relay.line(new FakeSocket(), {
    action: "subscribe",
    sessionUuid: "viewer",
    deviceId: device.deviceId,
  });
  expect(relay.subscriberCount(device.deviceId)).toBe(1);
  setVideoStreamSocketServerForTesting(relay);
}

class FakeSimulatorHelper extends EventEmitter {
  stops = 0;
  isRunning = false;

  start(): void {
    this.isRunning = true;
  }

  async stop(): Promise<null> {
    this.stops++;
    this.isRunning = false;
    return null;
  }

  requestKeyFrame(): boolean {
    return true;
  }

  override on<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    listener: IosScreenCaptureHelperEvents[E],
  ): this {
    return super.on(event, listener);
  }
}

/**
 * A real helper pool with one running fake helper, standing in for the process-wide pool: the
 * stage's own call runs the real pool shutdown against it.
 */
async function helperPoolWithRunningHelper(
  timer: FakeTimer,
  helper: FakeSimulatorHelper,
): Promise<void> {
  const pool = new IosSimulatorCaptureHelperPool({ timer, createHelper: () => helper });
  const lease = pool.acquire({
    binaryPath: "/fake/screen-capture-helper",
    target: {
      kind: "simulator",
      windowID: 42,
      fps: 15,
      encode: { codec: "h264", bitrate: { kind: "bitsPerPixel", bpp: 0.1 } },
    },
  });
  await lease.start();
  expect(helper.isRunning).toBe(true);
  const shutdown = spyOn(iosSimulatorCaptureHelperPool, "shutdown").mockImplementation(() =>
    pool.shutdown(),
  );
  restores.push(() => shutdown.mockRestore());
}

interface Probe {
  /** Build the live resource the stage tears down. */
  arrange(timer: FakeTimer): Promise<void>;
  /** The stage's `run`, from the real stage list. */
  stage(timer: FakeTimer): Promise<ShutdownCleanupStage | undefined>;
  /** Proof the real teardown ran, so "no database use" is not the result of doing nothing. */
  tornDown(): boolean;
}

function probes(): Record<string, Probe> {
  const adbCommands: string[][] = [];
  const source = new RecordingSource();
  const helper = new FakeSimulatorHelper();
  const daemonStage = (name: string) => async (timer: FakeTimer) =>
    (await daemonShutdownStages(timer, adbCommands)).get(name);
  const nativeControl = new FakeNativeHelperProcessControl();
  const nativeStore = new FakeNativeHelperRecordStore();
  let hostChild: FakeChildProcess | undefined;
  const nativeRegistry = new NativeHelperRegistry({
    store: nativeStore,
    control: nativeControl,
    ownPid: 30,
    logger: new FakeLogger(),
  });
  const adbStopped = () => adbCommands.some((command) => command.join(" ") === "kill-server");
  return {
    "daemon: video stream socket server": {
      arrange: (timer) => relayWithLiveCapture(timer, source),
      stage: daemonStage("video stream socket server"),
      tornDown: () => source.stops === 1,
    },
    "daemon: iOS simulator capture helper pool": {
      arrange: (timer) => helperPoolWithRunningHelper(timer, helper),
      stage: daemonStage("iOS simulator capture helper pool"),
      tornDown: () => helper.stops === 1 && !helper.isRunning,
    },
    "daemon: native helper registry": {
      arrange: async (timer) => {
        const child = new FakeChildProcess(timer);
        nativeControl.processes.set(30, "owner");
        nativeControl.processes.set(child.pid!, "helper");
        nativeRegistry.track(child, { kind: "adb", processGroup: false });
        nativeControl.onSignal = (pid) => {
          nativeControl.processes.delete(pid);
          child.emit("exit");
        };
        const spy = spyOn(getNativeHelperRegistry(), "shutdown").mockImplementation((options) =>
          nativeRegistry.shutdown(options),
        );
        restores.push(() => spy.mockRestore());
      },
      stage: daemonStage("native helper registry"),
      tornDown: () => nativeControl.signals.length === 1 && nativeStore.list().length === 0,
    },
    "daemon: host adb children": {
      arrange: async (timer) => {
        const child = new FakeChildProcess(timer);
        hostChild = child;
        const kill = spyOn(child, "kill").mockImplementation((signal) => {
          child.signalCode = typeof signal === "string" ? signal : "SIGTERM";
          child.emit("exit");
          return true;
        });
        restores.push(() => kill.mockRestore());
        const host = new FakeHostCommandExecutor();
        const adb = new AdbClient(null, () => host.executeCommand("adb"), {
          spawnFn: () => {
            queueMicrotask(() => child.emit("spawn"));
            return child as ChildProcess;
          },
          timer,
          nativeHelperRegistry: nativeRegistry,
        });
        await adb.spawn(["shell", "getevent"]);
      },
      stage: daemonStage("host adb children"),
      tornDown: () => hostChild?.signalCode === "SIGTERM",
    },
    "daemon: managed ADB server": {
      arrange: async () => {},
      stage: daemonStage("managed ADB server"),
      tornDown: adbStopped,
    },
    "stdio: direct-mode managed ADB server": {
      arrange: async () => {},
      stage: async (timer) => {
        const unused = async (): Promise<void> => {};
        return createStdioShutdownStages({
          directModeActive: () => true,
          cleanupChildProcesses: unused,
          stopManagedAdbServer: managedAdbShutdown(timer, adbCommands),
          stopVideoRecordingSocketServer: unused,
          stopDeviceGestureRecordingSocketServer: unused,
          stopDeviceSnapshotSocketServer: unused,
          stopAppearanceSocketServer: unused,
          stopWebRtcStreamSocketServer: unused,
          stopAppearanceSyncScheduler: unused,
          cleanupPrefetchedApk: unused,
          closeStdioProxy: unused,
          drainDatabaseWrites: unused,
          settleMigrations: unused,
          closeDatabase: unused,
          closeLogger: unused,
          warn: () => {},
        }).find((stage) => stage.name === "direct-mode managed ADB server");
      },
      tornDown: adbStopped,
    },
  };
}

function databaseFreeStages(prefix: string, table: Record<string, ShutdownStageSpec>): string[] {
  return Object.entries(table)
    .filter(([, spec]) => !spec.mayWriteDatabase)
    .map(([name]) => `${prefix}: ${name}`);
}

describe("shutdown stages declared database-free (#11601)", () => {
  test("every stage declared database-free has a probe, and nothing else does", () => {
    expect(
      [
        ...databaseFreeStages("daemon", DAEMON_SHUTDOWN_STAGES),
        ...databaseFreeStages("stdio", STDIO_SHUTDOWN_STAGES),
      ].toSorted(),
    ).toEqual(Object.keys(probes()).toSorted());
  });

  test.each(Object.keys(probes()))(
    "%s tears its resource down without touching the database",
    async (name) => {
      const timer = new FakeTimer();
      const probe = probes()[name];
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      restores.push(() => warn.mockRestore());
      await probe?.arrange(timer);
      const stage = await probe?.stage(timer);
      expect(stage?.mayWriteDatabase).toBe(false);
      const databaseUses = closeTheDatabase();

      await stage?.run(stageContext);

      expect(probe?.tornDown()).toBe(true);
      expect(databaseUses).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("control: the same closed database catches a stage that does reach it", async () => {
    const timer = new FakeTimer();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    const stages = await daemonShutdownStages(timer, []);
    const stage = stages.get("database write drain");
    expect(stage?.mayWriteDatabase).toBe(true);
    const databaseUses = closeTheDatabase();

    await expect(Promise.resolve(stage?.run(stageContext))).rejects.toThrow(
      "database used after close: getDbWriteBarrier",
    );

    expect(databaseUses).toEqual(["getDbWriteBarrier"]);
  });

  test("control: it also catches a stage that reaches the database through a repository", async () => {
    const timer = new FakeTimer();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warn.mockRestore());
    const stages = await daemonShutdownStages(timer, []);
    const stage = stages.get("active capture and iOS CtrlProxy children");
    expect(stage?.mayWriteDatabase).toBe(true);
    // The real recording repository: listing the active recordings is a query.
    resetVideoRecordingManagerDependencies();
    const databaseUses = closeTheDatabase();

    await stage?.run(stageContext);

    expect(databaseUses).toContain("getDatabase");
  });
});

test("daemon helper cleanup follows the capture pool in order", async () => {
  const stages = [...(await daemonShutdownStages(new FakeTimer(), [])).keys()];
  const pool = stages.indexOf("iOS simulator capture helper pool");
  expect(stages.slice(pool, pool + 3)).toEqual([
    "iOS simulator capture helper pool",
    "native helper registry",
    "host adb children",
  ]);
});
