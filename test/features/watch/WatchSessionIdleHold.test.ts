import { describe, expect, test } from "bun:test";
import {
  heldIdleWindowMs,
  withCliSessionIdleHold,
  type CliIdleWindowDeclarer,
} from "../../../src/features/watch/WatchSessionIdleHold";
import { sessionIdleDeadline } from "../../../src/daemon/sessionClocks";
import { MAX_CLI_SESSION_IDLE_TIMEOUT_MS } from "../../../src/daemon/wire/constants";
import { FakeTimer } from "../../fakes/FakeTimer";

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
