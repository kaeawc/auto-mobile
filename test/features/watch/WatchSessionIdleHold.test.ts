import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import {
  daemonCliIdleWindowDeclarer,
  heldIdleWindowMs,
  withCliSessionIdleHold,
  type CliIdleWindowDeclarer,
  type IdleWindowDaemonClient,
} from "../../../src/features/watch/WatchSessionIdleHold";
import { sessionIdleDeadline } from "../../../src/daemon/sessionClocks";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  CLI_SESSION_LIVENESS_POLICY,
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
} from "../../../src/daemon/wire/constants";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import {
  daemonHeartbeatHandler,
  deliverDaemonHeartbeat,
} from "../../helpers/daemonHeartbeatHandler";

const IDLE_MS = 120_000;
const drain = () => Promise.resolve();

/** A cli-idle session as the daemon judges it: idle-expired once the clock is past its deadline. */
class FakeCliSession implements CliIdleWindowDeclarer {
  heartbeatTimeoutMs = IDLE_MS;
  declarations: number[] = [];
  failNext = false;

  constructor(readonly lastUsedAt: number) {}

  async declareIdleWindow(idleTimeoutMs: number): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("daemon unavailable");
    }
    this.declarations.push(idleTimeoutMs);
    this.heartbeatTimeoutMs = Math.min(idleTimeoutMs, MAX_CLI_SESSION_IDLE_TIMEOUT_MS);
  }

  deadline(): number {
    return sessionIdleDeadline({
      livenessPolicy: "cli-idle",
      lastUsedAt: this.lastUsedAt,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      expiresAt: this.lastUsedAt + IDLE_MS,
    });
  }
}

/** Advance in one-second steps, recording whether the session was ever past its idle deadline. */
async function runFor(timer: FakeTimer, session: FakeCliSession, ms: number): Promise<boolean> {
  let expired = false;
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    await timer.advanceTimeAsync(1_000, drain);
    expired ||= timer.now() > session.deadline();
  }
  return expired;
}

describe("withCliSessionIdleHold", () => {
  test("a run longer than the idle window keeps its session", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    // The last control call came 90 s before the run, near the edge of the 2-minute window.
    const session = new FakeCliSession(timer.now() - 90_000);
    const runMs = 6 * 60_000;

    const held = withCliSessionIdleHold(session, timer, () => timer.sleep(runMs), {
      baseIdleTimeoutMs: IDLE_MS,
    });
    // Let the opening declaration settle so the run's sleep is scheduled from the start.
    await drain();
    await drain();
    const expired = await runFor(timer, session, runMs);
    await held;

    expect(expired).toBe(false);
    expect(session.deadline() - timer.now()).toBeGreaterThanOrEqual(IDLE_MS);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("the same run without the hold loses its session", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const session = new FakeCliSession(timer.now() - 90_000);
    const run = timer.sleep(6 * 60_000);

    const expired = await runFor(timer, session, 6 * 60_000);
    await run;

    expect(expired).toBe(true);
  });

  test("a failed refresh is retried on the next tick", async () => {
    const timer = new FakeTimer();
    const session = new FakeCliSession(timer.now());
    const held = withCliSessionIdleHold(session, timer, () => timer.sleep(60_000), {
      baseIdleTimeoutMs: IDLE_MS,
      refreshIntervalMs: 30_000,
    });
    await drain();
    session.failNext = true;
    const expired = await runFor(timer, session, 60_000);
    await held;

    expect(expired).toBe(false);
    // Start, the 60 s tick and the final declaration; the 30 s tick failed.
    expect(session.declarations).toEqual([2 * IDLE_MS, 60_000 + 2 * IDLE_MS, 60_000 + 2 * IDLE_MS]);
  });

  test("a hold the daemon refuses fails before the runner is driven", async () => {
    const timer = new FakeTimer();
    const session = new FakeCliSession(timer.now());
    session.failNext = true;
    let ran = false;

    await expect(
      withCliSessionIdleHold(session, timer, async () => {
        ran = true;
      }),
    ).rejects.toThrow("Failed to hold the watch session through the daemon");
    expect(ran).toBe(false);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("the declared window is capped at the daemon's ceiling", () => {
    expect(heldIdleWindowMs(0, IDLE_MS)).toBe(2 * IDLE_MS);
    expect(heldIdleWindowMs(2 * MAX_CLI_SESSION_IDLE_TIMEOUT_MS, IDLE_MS)).toBe(
      MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
    );
  });
});

describe("daemonCliIdleWindowDeclarer through the real heartbeat handler", () => {
  const managers: SessionManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
  });

  /** A session a one-shot `--cli` startDevice left: cli-idle, owned by that invocation's token. */
  async function cliOwnedSession(timer: FakeTimer): Promise<SessionManager> {
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    managers.push(manager);
    await manager.createSession("watch", "watch-udid", "ios", { timeoutMs: 60_000 });
    await deliverDaemonHeartbeat(manager, "watch", {
      livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
      livenessOwnerToken: "start-device-cli",
      claimLivenessOwnership: true,
      idleTimeoutMs: IDLE_MS,
    });
    return manager;
  }

  function realClient(manager: SessionManager): IdleWindowDaemonClient {
    const handler = daemonHeartbeatHandler(manager);
    return {
      connect: async () => {},
      callDaemonMethod: (method, params) => handler(method, params),
    };
  }

  /** Advance in one-second steps, ticking the idle monitor; returns the sessions it released. */
  async function runWithMonitor(timer: FakeTimer, manager: SessionManager, ms: number) {
    const released: string[] = [];
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        released.push(`${sessionId}:${reason}`);
      },
      { timer },
    );
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      await timer.advanceTimeAsync(1_000, drain);
      if (elapsed % 10_000 === 0) {
        await monitor.tick();
      }
    }
    await monitor.tick();
    return released;
  }

  test("a 6-minute run keeps the CLI session the idle monitor would otherwise release", async () => {
    const timer = new FakeTimer();
    const manager = await cliOwnedSession(timer);
    await timer.advanceTimeAsync(90_000, drain);
    const declarer = daemonCliIdleWindowDeclarer(realClient(manager), "watch", "widget-script");

    // Scheduled before the hold so the run ends on time however long the opening claim takes.
    const run = timer.sleep(6 * 60_000);
    const held = withCliSessionIdleHold(declarer, timer, () => run, {
      baseIdleTimeoutMs: IDLE_MS,
    });
    const released = await runWithMonitor(timer, manager, 6 * 60_000);
    await held;

    expect(released).toEqual([]);
    const session = manager.getSession("watch");
    expect(session?.livenessPolicy).toBe("cli-idle");
    expect(sessionIdleDeadline(session!) - timer.now()).toBeGreaterThanOrEqual(IDLE_MS);
  });

  test("without the hold the same run loses the session to the idle window", async () => {
    const timer = new FakeTimer();
    const manager = await cliOwnedSession(timer);
    await timer.advanceTimeAsync(90_000, drain);

    const released = await runWithMonitor(timer, manager, 6 * 60_000);

    // The fake release callback does not end the session, so the monitor reports it every tick.
    expect(new Set(released)).toEqual(new Set(["watch:cli-idle-timeout"]));
  });

  test("a declaration the daemon acknowledges without a change fails the hold", async () => {
    const client: IdleWindowDaemonClient = {
      connect: async () => {},
      callDaemonMethod: async () => ({ sessionId: "watch", livenessUnchanged: true }),
    };
    const declarer = daemonCliIdleWindowDeclarer(client, "watch", "widget-script");

    await expect(declarer.declareIdleWindow(2 * IDLE_MS)).rejects.toThrow(
      "did not take the CLI idle window",
    );
  });
});
