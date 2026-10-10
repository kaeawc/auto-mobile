import { afterEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #11554 follow-up. The observer registry judges its leases on a `SteadyWallClock`, which on darwin
// counts host sleep (and a forward wall-clock step, indistinguishable from sleep there) as elapsed
// time. Device sessions are excused that time by the heartbeat monitor's stall/sleep forgiveness;
// observers were not, so an observer that heartbeated 2 s before the lid closed was expired the
// moment the host woke, and `onObserverGone` ended its viewer streams. Observers now receive the
// same forgiveness, from the same detector, through the session manager.

const OBSERVER = "hunt-observer";
const BUDGET_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
/** How long before the gap the observer last heartbeated: one client heartbeat interval. */
const HEARTBEAT_AGE_MS = PROXY_HEARTBEAT_INTERVAL_MS;

/**
 * The host's monotonic clock, as `Timer.monotonicIncludesHostSleep` reports it: it pauses while
 * the host sleeps on darwin and runs through sleep on Linux and Windows.
 */
type HostClock = "pauses-in-sleep" | "runs-through-sleep";
const HOST_CLOCKS: HostClock[] = ["pauses-in-sleep", "runs-through-sleep"];

const monitors: SessionHeartbeatMonitor[] = [];

/**
 * Advance through every due timer without moving the clock backwards for one that is overdue,
 * as timers that come due during a gap are when the daemon runs again.
 */
function advance(timer: FakeTimer, ms: number): Promise<void> {
  return timer.advanceTimeAsync(ms, () => Promise.resolve());
}

async function harness(hostClock: HostClock) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  if (hostClock === "runs-through-sleep") {
    timer.simulateSleepCountingMonotonicClock();
  }
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager.stopCleanupTimer();
  const gone: string[] = [];
  const registry = new ObserverSessionRegistry(timer, BUDGET_MS, (sessionId) => {
    gone.push(sessionId);
  });
  manager.setObserverSessionRegistry(registry);
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async () => undefined,
    timer,
  );
  monitor.start();
  monitors.push(monitor);
  expect(registry.register(OBSERVER, "desktop")).toMatchObject({ accepted: true });
  // The observer heartbeats on its cadence, then the gap begins one interval after its last one.
  await advance(timer, SCAN_MS);
  expect(registry.heartbeat(OBSERVER)).toBe(true);
  await advance(timer, HEARTBEAT_AGE_MS);
  return { timer, manager, registry, gone };
}

/** The daemon's event loop stalls while the host stays awake: time passes, nothing runs. */
function stallDaemon(timer: FakeTimer, ms: number): void {
  timer.setCurrentTime(timer.getCurrentTime() + ms);
}

afterEach(async () => {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
});

describe.each(HOST_CLOCKS)("observer lease across a gap (monotonic clock %s)", (hostClock) => {
  test("a heartbeat that arrives as the host wakes from a long sleep is accepted", async () => {
    const { timer, registry, gone } = await harness(hostClock);

    timer.simulateHostSleep(60_000);

    // No scan has run yet: the registry itself must notice the sleep before it judges expiry.
    expect({ accepted: registry.heartbeat(OBSERVER), gone }).toEqual({ accepted: true, gone: [] });
  });

  test("host sleep is not held against an observer, which then has the rest of its budget", async () => {
    const { timer, registry, gone } = await harness(hostClock);

    timer.simulateHostSleep(60_000);
    // One scan interval of slack: where sleep is measured as lateness, the interval the scan was
    // due after is not part of the gap.
    await advance(timer, BUDGET_MS - HEARTBEAT_AGE_MS - 2 * SCAN_MS);

    expect({ gone, listed: registry.list().map((observer) => observer.sessionId) }).toEqual({
      gone: [],
      listed: [OBSERVER],
    });
  });

  test("an observer that stays silent after the wake is expired within one budget of it", async () => {
    const { timer, gone } = await harness(hostClock);

    timer.simulateHostSleep(60_000);
    await advance(timer, BUDGET_MS);

    expect(gone).toEqual([OBSERVER]);
  });

  test("a stall of the daemon itself is not held against an observer either", async () => {
    const { timer, registry, gone } = await harness(hostClock);

    stallDaemon(timer, BUDGET_MS + 2_000);

    expect({ accepted: registry.heartbeat(OBSERVER), gone }).toEqual({ accepted: true, gone: [] });
  });

  test("an observer that is gone is not kept by scans that keep arriving late", async () => {
    const { timer, gone } = await harness(hostClock);

    // Each gap alone is shorter than the budget and every scan after it is late, so each one is
    // forgiven on its own; only a gap that began while the observer could still be live counts.
    for (let lateScans = 0; lateScans < 4; lateScans++) {
      stallDaemon(timer, BUDGET_MS - 3_000);
      await advance(timer, SCAN_MS);
    }

    expect(gone).toEqual([OBSERVER]);
  });

  test("forgiving an observer creates, binds and extends no device session", async () => {
    const { timer, manager, registry } = await harness(hostClock);

    timer.simulateHostSleep(60_000);
    expect(registry.heartbeat(OBSERVER)).toBe(true);

    expect({
      sessions: manager.getAllSessions().length,
      observerIsSession: manager.getSession(OBSERVER),
    }).toEqual({ sessions: 0, observerIsSession: null });
  });
});

describe("observer lease across a forward wall-clock step", () => {
  test("where the step looks like host sleep (darwin) a heartbeating observer survives it", async () => {
    const { timer, registry, gone } = await harness("pauses-in-sleep");

    timer.stepWallClock(BUDGET_MS + 1_000);

    expect({ accepted: registry.heartbeat(OBSERVER), gone }).toEqual({ accepted: true, gone: [] });
  });

  test.each(HOST_CLOCKS)(
    "the step neither shortens nor extends a silent observer's budget (monotonic clock %s)",
    async (hostClock) => {
      const { timer, gone } = await harness(hostClock);

      timer.stepWallClock(BUDGET_MS + 1_000);
      await advance(timer, BUDGET_MS - HEARTBEAT_AGE_MS - SCAN_MS);
      const goneBeforeBudget = [...gone];
      await advance(timer, 2 * SCAN_MS);

      expect({ goneBeforeBudget, gone }).toEqual({ goneBeforeBudget: [], gone: [OBSERVER] });
    },
  );
});

describe("observer lease forgiveness wiring", () => {
  test("a registry attached after the monitor started is forgiven too, until the monitor stops", async () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.stopCleanupTimer();
    const monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async () => undefined,
      timer,
    );
    monitor.start();
    monitors.push(monitor);
    const registry = new ObserverSessionRegistry(timer, BUDGET_MS);
    manager.setObserverSessionRegistry(registry);
    expect(registry.register(OBSERVER, "desktop")).toMatchObject({ accepted: true });

    timer.simulateHostSleep(60_000);
    const afterSleep = registry.heartbeat(OBSERVER);
    await monitor.stop();
    timer.simulateHostSleep(60_000);

    expect({ afterSleep, afterStop: registry.heartbeat(OBSERVER) }).toEqual({
      afterSleep: true,
      afterStop: false,
    });
  });
});

describe("observer lease forgiveness without a heartbeat monitor", () => {
  test("a registry no detector is attached to keeps judging on its clock alone", async () => {
    const timer = new FakeTimer();
    const gone: string[] = [];
    const registry = new ObserverSessionRegistry(timer, BUDGET_MS, (sessionId) => {
      gone.push(sessionId);
    });
    expect(registry.register(OBSERVER, "desktop")).toMatchObject({ accepted: true });

    timer.simulateHostSleep(60_000);

    expect({ accepted: registry.heartbeat(OBSERVER), gone }).toEqual({
      accepted: false,
      gone: [OBSERVER],
    });
  });

  test.each([
    { gapBegan: "while its budget was still running", gapAgeMs: BUDGET_MS + 1_000, forgiven: 1 },
    { gapBegan: "after its budget had run out", gapAgeMs: 500, forgiven: 0 },
  ])("a gap that began $gapBegan forgives $forgiven observer(s)", ({ gapAgeMs, forgiven }) => {
    const timer = new FakeTimer();
    const registry = new ObserverSessionRegistry(timer, BUDGET_MS);
    expect(registry.register(OBSERVER, "desktop")).toMatchObject({ accepted: true });
    stallDaemon(timer, BUDGET_MS + 1_000);

    expect({
      forgiven: registry.forgiveStall({ lostMs: BUDGET_MS + 1_000, sleptMs: 0, gapAgeMs }),
      accepted: registry.heartbeat(OBSERVER),
    }).toEqual({ forgiven, accepted: forgiven === 1 });
  });
});
