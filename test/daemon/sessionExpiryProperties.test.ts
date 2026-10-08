import { describe, expect, test } from "bun:test";
import {
  GRACE_MS,
  LEASE_MS,
  MONITOR_INTERVAL_MS,
  assertProperty,
  generateSchedule,
  lastToolAt,
  ownerExitAt,
  seedChunks,
  reasonClass,
  runSchedule,
  type Instant,
  type PropertyCheck,
  type RunResult,
  type Schedule,
  type ScheduleProfile,
} from "../helpers/sessionExpiryPropertyHarness";

// Seeded property tests for session expiry under clock discontinuities (#10670, umbrella
// #10655). Each seed generates a schedule of owner heartbeats (5 s cadence with jitter), tool
// calls, heartbeat-monitor ticks, cleanup sweeps, host sleeps, daemon stalls, late ticks and
// owner exits, and replays it against the real SessionManager, SessionHeartbeatMonitor and
// daemon heartbeat handler on a FakeTimer. Same-instant events run in a seeded shuffled order.
//
// A failure prints the seed, a replay command and a shrunk schedule. CI runs a fixed seed list;
// AUTOMOBILE_EXPIRY_PROPERTY_SEEDS / AUTOMOBILE_EXPIRY_PROPERTY_SEED_BASE widen it locally.
//
// #10661 (host sleep counts toward the idle window on every expiry path) landed in PR #10679,
// #10656 (heartbeats prove liveness only and never extend the idle deadline) in PR #10681, and
// #10662 (stall forgiveness shifts a deadline by at most the lost interval) with its fix, so
// every property here is enforced. A property that needs a fix not yet on main is registered
// as `test.todo` with a body (run it with `bun test --todo <this file>`) and flipped to
// enforced in the PR that lands its fix.

/** Slack on top of one monitor interval for the scan-scheduling jitter the generator adds. */
const SCAN_JITTER_MS = 300;

const ORDER_SEED_A = 1;
const ORDER_SEED_B = 2;

/**
 * 200 seeds per property, in chunks small enough that each test stays well inside the 100 ms
 * per-test budget (a schedule replays in well under a millisecond; order checks replay twice).
 */
const SEEDS_PER_CHUNK = 20;
const CHUNKS_PER_PROPERTY = 10;

const ALIVE_WITH_DISCONTINUITIES: ScheduleProfile = {
  horizonWindows: 4,
  discontinuityChance: 0.04,
  discontinuities: ["sleep", "stall", "lateTick"],
  allowLongGaps: true,
  ownerExitChance: 0,
  allowIdleGaps: true,
};

const STEADY_WITH_OWNER_EXIT: ScheduleProfile = {
  horizonWindows: 3,
  discontinuityChance: 0,
  discontinuities: [],
  allowLongGaps: false,
  ownerExitChance: 0.02,
  allowIdleGaps: true,
};

const STEADY_LIVE_OWNER: ScheduleProfile = {
  horizonWindows: 4,
  discontinuityChance: 0,
  discontinuities: [],
  allowLongGaps: false,
  ownerExitChance: 0,
  allowIdleGaps: true,
};

const SLEEPS_AND_STALLS: ScheduleProfile = {
  horizonWindows: 4,
  discontinuityChance: 0.06,
  discontinuities: ["sleep", "stall"],
  allowLongGaps: true,
  ownerExitChance: 0,
  allowIdleGaps: false,
};

const SHORT_STALLS: ScheduleProfile = {
  horizonWindows: 4,
  discontinuityChance: 0.06,
  discontinuities: ["stall", "lateTick"],
  allowLongGaps: false,
  ownerExitChance: 0,
  allowIdleGaps: false,
};

function describeRelease(result: RunResult): string {
  return result.release
    ? `released at t=${result.release.at} as ${result.release.reason}`
    : "kept to the end";
}

/** (1)/(2) No early release: a session with a tool call inside the idle window is never released. */
const noEarlyRelease: PropertyCheck = async (schedule) => {
  const result = await runSchedule(schedule, ORDER_SEED_A);
  if (!result.release) {
    return undefined;
  }
  const last = lastToolAt(result, result.release.at);
  return result.release.at - last > schedule.idleWindowMs
    ? undefined
    : `${describeRelease(result)}, only ${result.release.at - last}ms after the last accepted ` +
        `tool call at t=${last}, inside the ${schedule.idleWindowMs}ms idle window`;
};

/** Replay the schedule under two same-instant orders. */
async function bothOrders(schedule: Schedule): Promise<[RunResult, RunResult]> {
  return [await runSchedule(schedule, ORDER_SEED_A), await runSchedule(schedule, ORDER_SEED_B)];
}

function divergence([first, second]: readonly [RunResult, RunResult]): string | undefined {
  const same =
    first.release?.at === second.release?.at &&
    reasonClass(first.release) === reasonClass(second.release);
  return same
    ? undefined
    : `same-instant order changed the verdict: ${describeRelease(first)} vs ${describeRelease(second)}`;
}

/** (3) Order independence: the same schedule gives the same verdict whichever timer runs first. */
const orderIndependent: PropertyCheck = async (schedule) => divergence(await bothOrders(schedule));

/** The owner's last lease renewal at or before `exitAt`: a heartbeat or an accepted tool call. */
function lastLeaseRenewal(instants: readonly Instant[], result: RunResult, exitAt: number): number {
  const lastHeartbeat = instants
    .filter((instant) => instant.at <= exitAt && instant.events.includes("heartbeat"))
    .reduce((latest, instant) => Math.max(latest, instant.at), 0);
  return Math.max(lastHeartbeat, lastToolAt(result, exitAt));
}

/** An exited owner's session is released within lease + grace + one scan, in either order. */
const exitedOwnerReleased: PropertyCheck = async (schedule) => {
  const runs = await bothOrders(schedule);
  const diverged = divergence(runs);
  const exitAt = ownerExitAt(schedule.instants);
  if (diverged !== undefined || exitAt === undefined) {
    return diverged;
  }
  const [result] = runs;
  const bound =
    lastLeaseRenewal(schedule.instants, result, exitAt) +
    LEASE_MS +
    GRACE_MS +
    MONITOR_INTERVAL_MS +
    SCAN_JITTER_MS;
  if ((schedule.instants.at(-1)?.at ?? 0) < bound) {
    return undefined;
  }
  if (!result.release || result.release.at > bound) {
    return `owner exited at t=${exitAt}; expected a release by t=${bound}, but ${describeRelease(result)}`;
  }
  const reason = reasonClass(result.release);
  return reason === "heartbeat-timeout" || reason === "idle"
    ? undefined
    : `owner exited at t=${exitAt}; ${describeRelease(result)}, expected heartbeat-timeout or idle`;
};

/** First instant at which the last accepted tool call is more than window + grace in the past. */
function firstEvaluationPastIdle(schedule: Schedule, result: RunResult): number | undefined {
  return schedule.instants.find(
    (instant) => instant.at > lastToolAt(result, instant.at - 1) + schedule.idleWindowMs + GRACE_MS,
  )?.at;
}

/** (1)/(4) Bounded hold: no tool call for longer than the window releases a live owner as idle. */
const idleReleasedDespiteHeartbeats: PropertyCheck = async (schedule) => {
  const result = await runSchedule(schedule, ORDER_SEED_A);
  const expected = firstEvaluationPastIdle(schedule, result);
  if (expected === undefined) {
    return result.release
      ? `no idle gap in the schedule, but ${describeRelease(result)}`
      : undefined;
  }
  if (result.release?.at !== expected || reasonClass(result.release) !== "idle") {
    return (
      `idle deadline passed by the evaluation at t=${expected}; expected an idle release ` +
      `there, but ${describeRelease(result)}`
    );
  }
  return undefined;
};

/**
 * How long the daemon could have been stalled before `at`, as its monitor measures it: the time
 * since the previous scan beyond one interval. Forgiveness may excuse at most this much.
 */
function lostBefore(schedule: Schedule, at: number): number {
  const previousScan = schedule.instants
    .filter((instant) => instant.at < at && instant.events.includes("monitorTick"))
    .reduce((latest, instant) => Math.max(latest, instant.at), 0);
  return Math.max(0, at - previousScan - MONITOR_INTERVAL_MS);
}

/** (5) Monotone deadlines: forgiveness moves the idle deadline by at most the lost interval. */
const deadlinesShiftByAtMostTheLoss: PropertyCheck = async (schedule) => {
  const result = await runSchedule(schedule, ORDER_SEED_A);
  const toolAt = new Set(result.toolCalls.filter((call) => call.ok).map((call) => call.at));
  for (let i = 1; i < result.deadlines.length; i++) {
    const previous = result.deadlines[i - 1]!;
    const current = result.deadlines[i]!;
    const shift = current.expiresAt - previous.expiresAt;
    const allowed = lostBefore(schedule, current.at);
    if (!toolAt.has(current.at) && shift > allowed) {
      return (
        `idle deadline moved by ${shift}ms at t=${current.at} with no tool call; ` +
        `the daemon lost at most ${allowed}ms there`
      );
    }
  }
  return undefined;
};

/**
 * Register one test per seed chunk. `todo` properties need a fix that is not on main yet: they
 * keep their body so `bun test --todo` runs them, and the fix PR flips them to `test`.
 */
function propertyTests(
  name: string,
  firstSeed: number,
  profile: ScheduleProfile,
  check: PropertyCheck,
  status: "enforced" | "todo" = "enforced",
): void {
  const register = status === "todo" ? test.todo : test;
  for (const seeds of seedChunks(firstSeed, SEEDS_PER_CHUNK, CHUNKS_PER_PROPERTY)) {
    register(`${name} (seeds ${seeds[0]}-${seeds.at(-1)})`, () =>
      assertProperty(seeds, profile, check),
    );
  }
}

describe("session expiry properties under clock discontinuities (#10670)", () => {
  test("the generator is deterministic per seed", () => {
    expect(generateSchedule(7, ALIVE_WITH_DISCONTINUITIES)).toEqual(
      generateSchedule(7, ALIVE_WITH_DISCONTINUITIES),
    );
  });

  propertyTests(
    "no early release: a tool call inside the idle window keeps the session through heartbeat jitter, late ticks, stalls and sleep",
    1_000,
    ALIVE_WITH_DISCONTINUITIES,
    noEarlyRelease,
  );

  propertyTests(
    "without discontinuities the verdict is order-independent, and an exited owner is released within lease + grace + one scan",
    2_000,
    STEADY_WITH_OWNER_EXIT,
    exitedOwnerReleased,
  );

  propertyTests(
    "#10656: no tool call for longer than the idle window releases a live owner's session as idle, whatever its heartbeats",
    3_000,
    STEADY_LIVE_OWNER,
    idleReleasedDespiteHeartbeats,
  );

  propertyTests(
    "after host sleep or a daemon stall the verdict does not depend on which timer fires first (#10661)",
    4_000,
    SLEEPS_AND_STALLS,
    orderIndependent,
  );

  propertyTests(
    "#10662: a forgiven stall moves the idle deadline by at most the lost interval",
    5_000,
    SHORT_STALLS,
    deadlinesShiftByAtMostTheLoss,
  );
});
