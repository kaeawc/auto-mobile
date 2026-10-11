import { spyOn } from "bun:test";
import { Daemon } from "../../../src/daemon/daemon";
import * as databaseModule from "../../../src/db";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../../src/server/videoRecordingManager";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import {
  LivenessScenario,
  ToolCallRefused,
  type LivenessScenarioOptions,
} from "../../helpers/livenessScenarioHarness";

// One daemon restarting with work in flight, end to end (hunt lane restart-end-to-end-1).
//
// Built on LivenessScenario: a real `Daemon` started through `Daemon.startOn()` over a real
// `DeviceSessionRepository` on the in-memory SQLite test database, the real control socket and the
// real `DaemonMcpProxy` over the in-memory transport, a real `DevicePool` over fake discovery, and
// one FakeTimer. This file adds the two things that harness leaves out:
// - a CLEAN shutdown: the first daemon's real `Daemon.stop()` runs (shutdown release with the
//   `daemon-shutdown` reason, the release broadcast, the control socket's drain and close). Only
//   the three stages that reach the host are replaced: the database close, the logger close and
//   the PID/socket file cleanup.
// - an owner that is away: the stdio proxy's dials to the successor are refused until the scenario
//   lets it back, so "the owner reconnects N seconds after the restart" is a step of the scenario.

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
    // The three host-touching stages of stop(): everything else is the production sequence.
    Reflect.set(daemon, "cleanupDaemonFilesForShutdown", async () => {});
    this.shutdownSpies.push(
      spyOn(databaseModule, "closeDatabase").mockResolvedValue(undefined),
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
    for (let step = 0; step < 400 && !settled; step++) {
      await drainMicrotasks(64);
      await new Promise<void>((resolve) => setImmediate(resolve));
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
    while (this.sinceRestart < ms) {
      await this.idle(Math.min(500, ms - this.sinceRestart));
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
  }
}
