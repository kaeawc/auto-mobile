import { spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { LivenessScenario } from "../../helpers/livenessScenarioHarness";
import {
  AGENT_KEEPER_CONNECTION,
  DESKTOP_HEARTBEAT_MS,
  PIXEL,
  PIXEL_FOLD,
  relativeEnvelope,
  wireConnection,
  type WireActor,
  type WireExchange,
  type WireFixture,
} from "./desktopWireFixture";
import type { BootedDevice } from "../../../src/models";

export { DESKTOP_CLIENT_NAME, PIXEL, PIXEL_FOLD, type WireFixture } from "./desktopWireFixture";

/**
 * Records the frames the desktop/IDE client (the desktop-core Gradle module) sends, and the real
 * daemon's answers, as desktop wire fixtures (#10669).
 *
 * The daemon is a real `Daemon` started through `Daemon.startOn()` (#11441, #16946), via
 * {@link LivenessScenario}: its constructor and start sequence wire the session lifecycle (expiry
 * canceller, recording cleanup, tool-call-end activity, heartbeat monitor, rehydration), and every
 * frame goes through its real control socket. A `tools/call` is forwarded by that socket to the
 * real tool registration ({@link LivenessScenario}'s loopback hop); only the device work is a
 * stand-in. A restart is a new `Daemon` started the same way over the same database, so it
 * rehydrates what the last one persisted. The clock is the scenario's FakeTimer; the data
 * directory is in memory, so nothing touches `~/.auto-mobile` or a host socket.
 *
 * The replay (`livenessDesktopFixtureReplay.test.ts`) drives the same frames on the same
 * connections through the same harness, so recording and replay agree frame for frame.
 */
export class DesktopWireHarness {
  readonly exchanges: WireExchange[] = [];
  /** Sessions another client keeps alive (the agent's proxy keeper); their beats are not recorded. */
  readonly keepAlive = new Set<string>();
  private scenario!: LivenessScenario;
  private startedAt = 0;
  private readonly restore: Array<{ mockRestore(): void }> = [];

  constructor(private readonly devices: BootedDevice[] = [PIXEL, PIXEL_FOLD]) {}

  async start(): Promise<void> {
    // The scenario silences info and warn; a refused frame also logs an error.
    this.restore.push(spyOn(logger, "error").mockImplementation(() => {}));
    this.scenario = await LivenessScenario.start({
      devices: this.devices.map((device) => device.deviceId),
      deviceNames: Object.fromEntries(this.devices.map((device) => [device.deviceId, device.name])),
    });
    this.startedAt = this.scenario.timer.now();
  }

  /**
   * The daemon process dies and, `downtimeMs` later, a new one starts over the same database: it
   * rehydrates the sessions the last one persisted, expiring any whose idle window ran out while
   * no daemon was up. No frame is recorded while it is down.
   */
  async restartDaemon(downtimeMs: number): Promise<void> {
    await this.scenario.daemonRestart({ downtimeMs });
  }

  async stop(): Promise<void> {
    try {
      await this.scenario?.stop();
    } finally {
      for (const spy of this.restore.splice(0)) {
        spy.mockRestore();
      }
    }
  }

  async send(
    actor: WireActor,
    label: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<WireExchange["response"]> {
    const exchange = await this.exchange(actor, label, method, params);
    this.exchanges.push(exchange);
    return exchange.response;
  }

  /** The device's current holder in the started daemon's pool, or null when it is idle. */
  holderOf(deviceId: string): string | null {
    return this.scenario.poolState(deviceId).sessionId;
  }

  /** Let fake time pass with no desktop frame (a stalled or sleeping client). */
  async stall(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += DESKTOP_HEARTBEAT_MS) {
      await this.passTick();
    }
  }

  /**
   * The desktop's steady state: `count` heartbeat ticks, each {@link DESKTOP_HEARTBEAT_MS} apart.
   * Every response must be identical; the run is recorded as one exchange with `repeat`.
   */
  async heartbeats(
    label: string,
    sessionId: string,
    count: number,
  ): Promise<WireExchange["response"]> {
    const { healthy, changed } = await this.heartbeatRun(label, sessionId, count);
    if (changed) {
      throw new Error(
        `${label}: heartbeat ${healthy.length + 1}/${count} answered ` +
          `${JSON.stringify(changed.response)}, not ${JSON.stringify(healthy[0]!.response)}`,
      );
    }
    this.exchanges.push(collapse(healthy));
    return healthy[0]!.response;
  }

  /**
   * Heartbeat until the answer changes (the daemon stops recognising the session), recording the
   * steady run under `label` and the first changed beat under `${label}-lapse`. Returns the length
   * of the steady run.
   */
  async heartbeatsUntilLapse(label: string, sessionId: string, maxTicks: number): Promise<number> {
    const { healthy, changed } = await this.heartbeatRun(label, sessionId, maxTicks);
    if (!changed) {
      throw new Error(`${label}: session ${sessionId} never lapsed within ${maxTicks} ticks`);
    }
    this.exchanges.push(collapse(healthy), { ...changed, label: `${label}-lapse` });
    return healthy.length;
  }

  private async heartbeatRun(
    label: string,
    sessionId: string,
    maxTicks: number,
  ): Promise<{ healthy: WireExchange[]; changed?: WireExchange }> {
    const healthy: WireExchange[] = [];
    for (let tick = 0; tick < maxTicks; tick++) {
      await this.passTick();
      const exchange = await this.exchange("desktop", label, "daemon/heartbeat", { sessionId });
      if (healthy.length > 0 && !sameResponse(healthy[0]!, exchange)) {
        return { healthy, changed: exchange };
      }
      healthy.push(exchange);
    }
    return { healthy };
  }

  /** One desktop loop interval: fake time advances and kept-alive sessions beat. */
  private async passTick(): Promise<void> {
    await this.scenario.idle(DESKTOP_HEARTBEAT_MS);
    for (const sessionId of this.keepAlive) {
      const keeper = await this.scenario.daemonMethod(
        "daemon/heartbeat",
        { sessionId },
        AGENT_KEEPER_CONNECTION,
      );
      if (!keeper.success) {
        throw new Error(`agent keeper heartbeat refused: ${JSON.stringify(keeper)}`);
      }
    }
  }

  fixture(scenario: string, description: string, sessions: Record<string, string>): WireFixture {
    return {
      $comment:
        "Generated by test/daemon/desktopWireContract.test.ts from a real Daemon started through startOn(); " +
        "regenerate with `UPDATE_CAPTURED_FIXTURES=1 bun test test/daemon/desktopWireContract.test.ts`. Do not edit by hand.",
      scenario,
      description,
      sessions,
      exchanges: this.exchanges,
    };
  }

  private async exchange(
    actor: WireActor,
    label: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<WireExchange> {
    const atMs = this.scenario.timer.now() - this.startedAt;
    const response = await this.scenario.daemonMethod(method, params, wireConnection(actor));
    return {
      atMs,
      actor,
      label,
      request: { method, params },
      response: relativeEnvelope(response, this.startedAt),
    };
  }
}

function sameResponse(a: WireExchange, b: WireExchange): boolean {
  return JSON.stringify(a.response) === JSON.stringify(b.response);
}

function collapse(run: WireExchange[]): WireExchange {
  const first = run[0]!;
  return run.length > 1 ? { ...first, repeat: run.length, everyMs: DESKTOP_HEARTBEAT_MS } : first;
}
