import { beforeAll, describe, expect, test } from "bun:test";
import {
  AUTOLOCK_IDLE_WINDOW_MS,
  DEFAULT_IDLE_WINDOWS_MS,
  GRACE_MS,
  LEASE_MS,
  MONITOR_INTERVAL_MS,
  assertProperty,
  generateSchedule,
  lastActivityAt,
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
// #10662 (stall forgiveness shifts a deadline by at most the lost interval) with its fix, and
// #10699 (host sleep is told from a daemon stall by the wall clock outrunning the monotonic one,
// not by length) with its fix, and #10729 (autolock owners get the default lease) with its fix,
// so every property here is enforced. A property a newly found bug violates can be registered as
// an inverted assertion with the harness's `expectKnownFailure`, so it stays visible until fixed.
//
// The pool is real: a 60 s window acquires through DevicePool.autolockDevice and a 120 s window
// through bindOrReuseDeviceSession, and every release is judged by what it leaves in the pool
// (invariant 4 of #10670, #10705). A "restart" discontinuity restarts the daemon and rehydrates
// the session awaiting its owner.

/** Slack on top of one monitor interval for the scan-scheduling jitter the generator adds. */
const SCAN_JITTER_MS = 300;

const ORDER_SEED_A = 1;
const ORDER_SEED_B = 2;

/**
 * 200 seeds per property, in chunks small enough that each test stays well inside the 100 ms
 * per-test budget (a schedule replays in well under a millisecond; order checks replay twice).
 */
const SEEDS_PER_CHUNK = 10;
const CHUNKS_PER_PROPERTY = 20;

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

/** The same exiting owner on the autolock (60 s) acquisition path only (#10729). */
const AUTOLOCK_OWNER_EXIT: ScheduleProfile = {
  ...STEADY_WITH_OWNER_EXIT,
  idleWindowsMs: [AUTOLOCK_IDLE_WINDOW_MS],
};

/** Every release path, both acquisition paths: what a release leaves in the pool (invariant 4). */
const RELEASES_OF_EVERY_KIND: ScheduleProfile = {
  horizonWindows: 3,
  discontinuityChance: 0.04,
  discontinuities: ["sleep", "stall", "lateTick"],
  allowLongGaps: true,
  ownerExitChance: 0.02,
  allowIdleGaps: true,
};

/** A live owner whose daemon restarts: rehydration must neither free nor over-hold it. */
const RESTARTS_LIVE_OWNER: ScheduleProfile = {
  horizonWindows: 4,
  discontinuityChance: 0.015,
  discontinuities: ["restart"],
  allowLongGaps: false,
  ownerExitChance: 0,
  allowIdleGaps: true,
  idleWindowsMs: DEFAULT_IDLE_WINDOWS_MS,
};

/** A dead owner whose daemon restarts: the rehydrated session waits lease + grace, then goes. */
const RESTARTS_DEAD_OWNER: ScheduleProfile = {
  horizonWindows: 3,
  discontinuityChance: 0.03,
  discontinuities: ["restart"],
  allowLongGaps: false,
  ownerExitChance: 0.03,
  allowIdleGaps: true,
  idleWindowsMs: DEFAULT_IDLE_WINDOWS_MS,
};

/** Only the heartbeat monitor's timer fires late; nothing else is delayed. */
const LATE_TICKS_ONLY: ScheduleProfile = {
  horizonWindows: 4,
  discontinuityChance: 0.1,
  discontinuities: ["lateTick"],
  allowLongGaps: false,
  ownerExitChance: 0,
  allowIdleGaps: true,
};

/** Host sleeps shorter than the idle window; the monotonic clock tells them from a stall (#10699). */
const SHORT_SLEEPS: ScheduleProfile = {
  horizonWindows: 5,
  discontinuityChance: 0.1,
  discontinuities: ["sleep"],
  allowLongGaps: false,
  ownerExitChance: 0,
  allowIdleGaps: true,
};

/** Daemon-only stalls of any length, with the owner heartbeating throughout (#10699). */
const LONG_STALLS: ScheduleProfile = {
  horizonWindows: 5,
  discontinuityChance: 0.08,
  discontinuities: ["stall"],
  allowLongGaps: true,
  ownerExitChance: 0,
  allowIdleGaps: false,
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
  const last = lastActivityAt(result, result.release.at);
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
  return Math.max(lastHeartbeat, lastActivityAt(result, exitAt));
}

/** Instants a restarted daemon began waiting for the owner at or after `exitAt`. */
function restartsAfter(result: RunResult, exitAt: number): number[] {
  return result.restarts.filter((restartAt) => restartAt >= exitAt);
}

/**
 * An exited owner's session is released within lease + grace + one scan, in either order. A
 * daemon that restarts after the exit rehydrates the session awaiting an owner that never comes,
 * which gets the same lease + grace from the restart.
 */
const exitedOwnerReleased: PropertyCheck = async (schedule) => {
  const runs = await bothOrders(schedule);
  const diverged = divergence(runs);
  const exitAt = ownerExitAt(schedule.instants);
  if (diverged !== undefined || exitAt === undefined) {
    return diverged;
  }
  const [result] = runs;
  const bound =
    Math.max(
      lastLeaseRenewal(schedule.instants, result, exitAt),
      ...restartsAfter(result, exitAt),
    ) +
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
  return ["heartbeat-timeout", "idle", "rehydration-owner-timeout"].includes(reason)
    ? undefined
    : `owner exited at t=${exitAt}; ${describeRelease(result)}, expected a heartbeat, idle or rehydration timeout`;
};

/** First instant at which the last accepted tool call is more than window + grace in the past. */
function firstEvaluationPastIdle(schedule: Schedule, result: RunResult): number | undefined {
  return schedule.instants.find(
    (instant) =>
      instant.at > lastActivityAt(result, instant.at - 1) + schedule.idleWindowMs + GRACE_MS,
  )?.at;
}

/** (1)/(4) Bounded hold: no tool call for longer than the window releases a live owner as idle. */
const idleReleasedDespiteHeartbeats: PropertyCheck = async (schedule) => {
  const result = await runSchedule(schedule, ORDER_SEED_A);
  if (result.release?.reason === "expired-before-restart") {
    // A restart past the idle deadline ends the session without waiting out the suspect grace.
    const last = lastActivityAt(result, result.release.at);
    return result.release.at >= last + schedule.idleWindowMs
      ? undefined
      : `a restart at t=${result.release.at} ended a session still inside its window since t=${last}`;
  }
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
 * (4) Release frees the device: a released session leaves its device idle and unowned with no
 * stale `autolockSessionId`; a kept session leaves it busy with a session.
 */
const releaseFreesTheDevice: PropertyCheck = async (schedule) => {
  const result = await runSchedule(schedule, ORDER_SEED_A);
  const { device } = result;
  if (!result.release) {
    return device.status === "busy" && device.sessionId !== null
      ? undefined
      : `session kept to the end, but the pool entry is ${JSON.stringify(device)}`;
  }
  return device.status === "idle" &&
    device.sessionId === null &&
    device.autolockSessionId === undefined
    ? undefined
    : `${describeRelease(result)}, but the pool entry is ${JSON.stringify(device)}`;
};

/** The longest daemon stall (ms) that ended in `(after, until]`, summed. */
function stalledBetween(schedule: Schedule, after: number, until: number): number {
  return schedule.instants
    .filter((instant) => instant.discontinuity?.kind === "stall")
    .filter((instant) => instant.at > after && instant.at <= until)
    .reduce((total, instant) => total + instant.discontinuity!.ms, 0);
}

/**
 * (6) #10699: a pure daemon stall of any length never releases a session whose owner kept
 * heartbeating and whose tool activity is within one window plus the stall.
 */
const stallNeverReleasesActiveSession: PropertyCheck = async (schedule) => {
  const result = await runSchedule(schedule, ORDER_SEED_A);
  if (!result.release) {
    return undefined;
  }
  const last = lastActivityAt(result, result.release.at);
  const allowed =
    schedule.idleWindowMs + stalledBetween(schedule, last, result.release.at) + GRACE_MS;
  return result.release.at - last > allowed
    ? undefined
    : `${describeRelease(result)}, ${result.release.at - last}ms after the last tool call at ` +
        `t=${last}: inside the ${schedule.idleWindowMs}ms window plus the daemon's own stall`;
};

/** Register one test per seed chunk. */
function propertyTests(
  name: string,
  firstSeed: number,
  profile: ScheduleProfile,
  check: PropertyCheck,
  chunks = CHUNKS_PER_PROPERTY,
  chunkSize = SEEDS_PER_CHUNK,
): void {
  for (const seeds of seedChunks(firstSeed, chunkSize, chunks)) {
    test(`${name} (seeds ${seeds[0]}-${seeds.at(-1)})`, () =>
      assertProperty(seeds, profile, check));
  }
}

describe("session expiry properties under clock discontinuities (#10670)", () => {
  // Whichever chunk runs first in a process pays the module and JIT warm-up, and CI re-times an
  // over-budget test in isolation where it always runs cold (#10841). beforeAll is excluded from
  // per-test time, so replay one seed of every profile here instead of billing it to a chunk.
  beforeAll(async () => {
    const profiles = [
      ALIVE_WITH_DISCONTINUITIES,
      STEADY_WITH_OWNER_EXIT,
      AUTOLOCK_OWNER_EXIT,
      RELEASES_OF_EVERY_KIND,
      RESTARTS_LIVE_OWNER,
      RESTARTS_DEAD_OWNER,
      LATE_TICKS_ONLY,
      SHORT_SLEEPS,
      LONG_STALLS,
      STEADY_LIVE_OWNER,
      SLEEPS_AND_STALLS,
      SHORT_STALLS,
    ];
    for (const profile of profiles) {
      await runSchedule(generateSchedule(1, profile), ORDER_SEED_A);
    }
  });

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

  propertyTests(
    "a release leaves the device idle with no session and no stale autolock owner; a kept session leaves it busy (invariant 4)",
    7_000,
    RELEASES_OF_EVERY_KIND,
    releaseFreesTheDevice,
    16,
    6,
  );

  propertyTests(
    "after a daemon restart a live owner's session is never freed early and is freed when its window since the restart lapses",
    8_000,
    RESTARTS_LIVE_OWNER,
    async (schedule) =>
      (await noEarlyRelease(schedule)) ?? (await idleReleasedDespiteHeartbeats(schedule)),
    24,
    2,
  );

  propertyTests(
    "after a daemon restart a dead owner's session is freed within lease + grace + one scan of the restart or the exit",
    8_500,
    RESTARTS_DEAD_OWNER,
    exitedOwnerReleased,
    12,
    4,
  );

  propertyTests(
    "when only the monitor's timer fires late the verdict does not depend on which timer fires first",
    6_000,
    LATE_TICKS_ONLY,
    orderIndependent,
    16,
    5,
  );

  propertyTests(
    "#10729: an autolock session's exited owner is freed within lease + grace + one scan, not after the 60 s autolock window",
    9_000,
    AUTOLOCK_OWNER_EXIT,
    exitedOwnerReleased,
  );

  propertyTests(
    "#10699: a sleep shorter than the window counts toward idle, so wake past the window plus grace releases at the first judgement",
    9_100,
    SHORT_SLEEPS,
    idleReleasedDespiteHeartbeats,
  );

  propertyTests(
    "#10699: a long daemon-only stall never releases a heartbeating owner whose tool activity is within the window plus the stall",
    9_200,
    LONG_STALLS,
    stallNeverReleasesActiveSession,
  );
});
