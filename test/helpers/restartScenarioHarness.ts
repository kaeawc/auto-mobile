import { spyOn } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import * as databaseModule from "../../src/db";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { drainMicrotasks } from "./fakeTimerStepping";
import {
  LivenessScenario,
  ToolCallRefused,
  type LivenessScenarioOptions,
} from "./livenessScenarioHarness";

// One daemon restarting with work in flight, end to end.
//
// Built on LivenessScenario: a real `Daemon` started through `Daemon.startOn()` over a real
// `DeviceSessionRepository` on the in-memory SQLite test database, the real control socket and the
// real `DaemonMcpProxy` over the in-memory transport, a real `DevicePool` over fake discovery, and
// one FakeTimer. This file adds the two things that harness leaves out:
// - a CLEAN shutdown: the first daemon's real `Daemon.stop()` runs (shutdown release with the
//   `daemon-shutdown` reason, the release broadcast, the control socket's drain and close). Only
//   the four stages that reach the host are replaced: the managed adb server stop, the database
//   close, the logger close and the PID/socket file cleanup.
// - an owner that is away: the stdio proxy's dials to the successor are refused until the scenario
//   lets it back, so "the owner reconnects N seconds after the restart" is a step of the scenario.

/**
 * Microtask turns `Daemon.stop()` is given before the scenario clock moves, so a chain with no
 * timer in it (the shutdown release and its persistence) finishes at the instant it started.
 */
const STOP_QUIET_TURNS = 2_000;

interface ScenarioInternals {
  createDaemonSide(): Promise<LivenessScenario["daemon"]>;
  killDaemonSide(side: LivenessScenario["daemon"]): void;
}

/** How the first daemon instance ends. */
export type ShutdownKind = "clean" | "crash";

export interface Snapshot {
  at: number;
  held: boolean;
  pool: { status: string; sessionId: string | null };
  stats: { idle: number; assigned: number };
  row: { released: boolean; reason: string | null } | null;
}

function textOf(result: unknown): string {
  const content = Reflect.get(Object(result), "content");
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = Reflect.get(Object(first), "text");
  return typeof text === "string" ? text : JSON.stringify(result);
}

export class RestartScenario {
  readonly shutdownSpies: Array<ReturnType<typeof spyOn>> = [];
  /** Proxy connection names whose dials the running daemon refuses (the owner is away). */
  private readonly away = new Set<string>();
  private restartedAtMs = 0;

  private constructor(readonly scenario: LivenessScenario) {}

  static async start(options: LivenessScenarioOptions = {}): Promise<RestartScenario> {
    return new RestartScenario(await LivenessScenario.start(options));
  }

  get timer(): FakeTimer {
    return this.scenario.timer;
  }

  /** Virtual milliseconds since the successor finished starting. */
  get sinceRestart(): number {
    return this.timer.now() - this.restartedAtMs;
  }

  /** The owner's proxy cannot reach the daemon from now on (until {@link ownerReturns}). */
  ownerAway(connection: string = this.scenario.proxyConnection): void {
    this.away.add(connection);
    this.gateDials();
  }

  ownerReturns(connection: string = this.scenario.proxyConnection): void {
    this.away.delete(connection);
  }

  private gateDials(): void {
    const socket = this.scenario.daemon.socket;
    if (Reflect.get(socket, "restartScenarioGated") === true) {
      return;
    }
    const connect = socket.connect.bind(socket);
    Reflect.set(socket, "restartScenarioGated", true);
    Reflect.set(socket, "connect", (connectionId: string) => {
      const base = connectionId.split("#")[0]!;
      return this.away.has(base) ? undefined : connect(connectionId);
    });
  }

  /**
   * The first daemon stops through its real shutdown path, `Daemon.stop()`. The scenario clock is
   * advanced while it runs, so its bounded drains (in-flight handlers, release persistence) pass.
   */
  async cleanShutdown(stepMs = 50): Promise<void> {
    const side = this.scenario.daemon;
    const daemon = side.daemon;
    // stop() closes the listener first (quiesce): no new connection reaches this daemon, while
    // the connections it already has stay open until the socket server closes them.
    Reflect.set(side.socket, "connect", () => undefined);
    // The four host-touching stages of stop(): everything else is the production sequence.
    Reflect.set(daemon, "cleanupDaemonFilesForShutdown", async () => {});
    // `adb kill-server` when the host's environment opts into a managed adb server.
    Reflect.set(daemon, "stopManagedAdbServer", async () => {});
    this.shutdownSpies.push(
      // The real close ends by cold-starting the process-wide write barrier that stop() has just
      // drained; without that the barrier stays latched and every later durable write in this
      // process is refused.
      spyOn(databaseModule, "closeDatabase").mockImplementation(async () => {
        resetDbWriteBarrier();
      }),
      spyOn(logger, "closeAfterFlush").mockResolvedValue(undefined),
    );
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    let settled = false;
    let failure: unknown;
    const stopping = Daemon.prototype.stop.call(daemon).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        failure = error;
      },
    );
    // stop() is promise chains and scenario-clock waits only: no real event-loop turn is given,
    // so nothing here depends on the host's speed.
    for (let step = 0; step < 400 && !settled; step++) {
      for (let turn = 0; turn < STOP_QUIET_TURNS && !settled; turn++) {
        await Promise.resolve();
      }
      if (!settled) {
        await this.scenario.idle(stepMs);
      }
    }
    await stopping;
    // The process exits: its remaining timers and connections are gone.
    (this.scenario as unknown as ScenarioInternals).killDaemonSide(side);
    if (!settled) {
      throw new Error("RestartScenario: Daemon.stop() did not settle within its virtual budget");
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  /** The first daemon dies with nothing written: rows stay live with their last stamps. */
  crash(): void {
    (this.scenario as unknown as ScenarioInternals).killDaemonSide(this.scenario.daemon);
  }

  /** A second daemon starts on the same database and journal directory. */
  async startSuccessor(): Promise<void> {
    this.scenario.daemon = await (this.scenario as unknown as ScenarioInternals).createDaemonSide();
    this.gateDials();
    this.restartedAtMs = this.timer.now();
  }

  async end(kind: ShutdownKind): Promise<void> {
    if (kind === "clean") {
      await this.cleanShutdown();
    } else {
      this.crash();
    }
  }

  async idle(ms: number): Promise<void> {
    await this.scenario.idle(ms);
    await drainMicrotasks(64);
  }

  /** Advance to `ms` after the successor's start. */
  async idleUntilSinceRestart(ms: number): Promise<void> {
    if (this.sinceRestart < ms) {
      await this.idle(ms - this.sinceRestart);
    }
  }

  /** Every daemon-side surface's answer for one session and its device, read without a call. */
  async snapshot(sessionId: string, deviceId: string): Promise<Snapshot> {
    const { manager, pool } = this.scenario.daemon;
    const device = pool.getDevice(deviceId);
    const stats = pool.getStats();
    const row = await this.scenario.repository.getSession(sessionId);
    return {
      at: this.sinceRestart,
      held: manager.getSession(sessionId) !== null,
      pool: { status: device?.status ?? "missing", sessionId: device?.sessionId ?? null },
      stats: { idle: stats.idle, assigned: stats.assigned },
      row: row
        ? {
            released: row.released_at_ms !== null && row.released_at_ms !== undefined,
            reason: row.release_reason ?? null,
          }
        : null,
    };
  }

  /**
   * The owner's control call through its proxy, with the clock running while it waits (the proxy
   * waits out its own reconnect and restart windows): `ok`, or what it was refused with.
   */
  async ownerControlCall(sessionId: string): Promise<string> {
    let answer: string | undefined;
    void this.scenario.toolCall(sessionId).then(
      () => {
        answer = "ok";
      },
      (error: unknown) => {
        answer =
          error instanceof ToolCallRefused
            ? `refused: ${textOf(error.result)}`
            : `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      },
    );
    for (let step = 0; step < 300 && answer === undefined; step++) {
      await drainMicrotasks(64);
      if (answer === undefined) {
        await this.scenario.idle(100);
      }
    }
    return answer ?? "unanswered after 30 s";
  }

  /** `availableDevices` as the `daemon/availableDevices` read reports it to any client. */
  async availableDevices(): Promise<number> {
    const answer = await this.scenario.daemonMethod("daemon/availableDevices", {}, "inventory");
    return Number(Reflect.get(Object(answer.result), "availableDevices"));
  }

  async stop(): Promise<void> {
    for (const spy of this.shutdownSpies.splice(0)) {
      spy.mockRestore();
    }
    resetVideoRecordingManagerDependencies();
    await this.scenario.stop();
    // A stop() that failed before its database stage leaves the barrier draining.
    resetDbWriteBarrier();
  }
}

/**
 * One-time warm-up for a restart suite's `beforeAll`, so that module initialization and first-use
 * compilation are not charged to whichever test runs first: one clean restart whose owner returns
 * and one crash whose owner does not, each with a second client asking for the held device.
 */
export async function warmUpRestartScenario(): Promise<void> {
  const device = "emulator-5554";
  for (const kind of ["clean", "crash"] as const) {
    const run = await RestartScenario.start({ devices: [device, "emulator-5556"] });
    try {
      const session = await run.scenario.acquire(device);
      await run.idle(1_000);
      run.ownerAway();
      await run.end(kind);
      await run.startSuccessor();
      const other = run.scenario.addProxy({ token: "warm-up-client" });
      const ask = () => other.callTool("getAndroid", { deviceId: device }).catch(() => undefined);
      await ask();
      if (kind === "crash") {
        await run.idleUntilSinceRestart(11_000);
      }
      run.ownerReturns();
      await run.ownerControlCall(session);
      await run.snapshot(session, device);
      await run.availableDevices();
      await ask();
    } finally {
      await run.stop();
    }
  }
}
