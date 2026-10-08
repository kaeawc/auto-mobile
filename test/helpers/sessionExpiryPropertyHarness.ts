import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager, SessionSuspectError } from "../../src/daemon/sessionManager";
import type { Random } from "../../src/utils/Random";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";
import { drainMicrotasks } from "./fakeTimerStepping";

// Seeded schedules for the session-expiry property tests (#10670). A schedule is a list of
// virtual instants; each instant delivers one or more producer events (owner heartbeat, tool
// call, heartbeat-monitor tick, cleanup sweep). The runner shuffles same-instant events with
// its own seeded Random, so one schedule can be replayed under different timer orders.
// Everything runs against the real SessionManager, SessionHeartbeatMonitor and daemon heartbeat
// handler on a FakeTimer. The clock only moves by setCurrentTime, so no interval fires on its
// own and the schedule alone decides which timer runs first.

export const SESSION = "expiry-property-session";
const DEVICE = "emulator-5554";
const OWNER = "expiry-property-owner";

export const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;
export const GRACE_MS = SUSPECT_GRACE_MS;
/** The stdio proxy keeper's production cadence (half the 10 s heartbeat timeout). */
export const HEARTBEAT_CADENCE_MS = 5_000;
/** SessionHeartbeatMonitor's default scan interval. */
export const MONITOR_INTERVAL_MS = 10_000;
/** SessionManager's periodic expired-session sweep. */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
/** Idle windows a schedule may pick: the autolock 60 s window and a longer one. */
export const IDLE_WINDOWS_MS = [60_000, 90_000] as const;

export type ProducerEvent = "heartbeat" | "toolCall" | "monitorTick" | "cleanupSweep";

export type DiscontinuityKind =
  /** The whole host slept: no producer ran, and every overdue one fires on wake. */
  | "sleep"
  /** The daemon's event loop blocked: the owner kept sending, and its messages queue to resume. */
  | "stall"
  /** Only the monitor's timer fired late (timer coalescing); everything else ran on time. */
  | "lateTick";

export interface Instant {
  at: number;
  /** Empty means the owner process exits here: no heartbeats or tool calls after it. */
  events: ProducerEvent[];
  discontinuity?: { kind: DiscontinuityKind; ms: number };
}

export interface Schedule {
  seed: number;
  idleWindowMs: number;
  instants: Instant[];
}

export interface ScheduleProfile {
  /** Virtual length of the schedule, as a multiple of the idle window. */
  horizonWindows: number;
  /** Chance per generated step that a discontinuity starts there. */
  discontinuityChance: number;
  discontinuities: readonly DiscontinuityKind[];
  /** Allow sleeps and stalls longer than the idle window plus the suspect grace. */
  allowLongGaps: boolean;
  /** Chance per step that the owner process exits. */
  ownerExitChance: number;
  /** Allow tool-call gaps longer than the idle window. */
  allowIdleGaps: boolean;
}

const PRODUCERS: readonly ProducerEvent[] = [
  "heartbeat",
  "toolCall",
  "monitorTick",
  "cleanupSweep",
];

type ProducerClocks = Record<ProducerEvent, number>;

interface GenerationContext {
  random: Random;
  windowMs: number;
  profile: ScheduleProfile;
}

function between(random: Random, min: number, max: number): number {
  return Math.round(min + random.next() * (max - min));
}

function nextToolGap({ random, windowMs, profile }: GenerationContext): number {
  const bands: readonly (readonly [number, number])[] = [
    [1_000, windowMs / 3],
    [windowMs / 3, windowMs * 0.9],
    ...(profile.allowIdleGaps ? [[windowMs * 1.05, windowMs * 2.5] as const] : []),
  ];
  const [min, max] = random.pick(bands);
  return between(random, min, max);
}

function gapLength({ random, windowMs, profile }: GenerationContext): number {
  const shortGap = [3_000, windowMs * 0.8] as const;
  const longGap = [windowMs + GRACE_MS + 1, windowMs * 3] as const;
  const [min, max] = profile.allowLongGaps ? random.pick([shortGap, longGap]) : shortGap;
  return between(random, min, max);
}

function nextFiring(event: ProducerEvent, at: number, context: GenerationContext): number {
  switch (event) {
    case "heartbeat":
      return at + HEARTBEAT_CADENCE_MS + between(context.random, -500, 1_500);
    case "toolCall":
      return at + nextToolGap(context);
    case "monitorTick":
      // The scan settles in the same virtual instant, so the next one is scheduled from here.
      return at + MONITOR_INTERVAL_MS + between(context.random, 0, 300);
    case "cleanupSweep":
      return at + CLEANUP_INTERVAL_MS;
  }
}

function liveProducers(ownerAlive: boolean): readonly ProducerEvent[] {
  return ownerAlive ? PRODUCERS : ["monitorTick", "cleanupSweep"];
}

function dueBy(clocks: ProducerClocks, at: number, ownerAlive: boolean): ProducerEvent[] {
  return liveProducers(ownerAlive).filter((event) => clocks[event] <= at);
}

/** One generated step: the earliest producer instant, or a discontinuity that resumes later. */
function nextInstant(
  clocks: ProducerClocks,
  context: GenerationContext,
  ownerAlive: boolean,
): Instant {
  const { random, profile } = context;
  const earliest = Math.min(...liveProducers(ownerAlive).map((event) => clocks[event]));
  if (profile.discontinuities.length === 0 || random.next() >= profile.discontinuityChance) {
    return { at: earliest, events: dueBy(clocks, earliest, ownerAlive) };
  }
  const kind = random.pick(profile.discontinuities);
  if (kind === "lateTick") {
    // Only the monitor is pushed back; the other producers keep their schedule.
    clocks.monitorTick += between(random, 0, 60_000);
    const at = Math.min(...liveProducers(ownerAlive).map((event) => clocks[event]));
    return { at, events: dueBy(clocks, at, ownerAlive) };
  }
  // A sleep or stall starts just before the earliest producer, so that producer waits too.
  const ms = gapLength(context);
  const at = earliest + ms;
  return { at, events: dueBy(clocks, at, ownerAlive), discontinuity: { kind, ms } };
}

/** Generate a schedule from a seed. Pure: the same seed and profile give the same schedule. */
export function generateSchedule(seed: number, profile: ScheduleProfile): Schedule {
  const random = new SeededRandom(seed);
  const windowMs = random.pick(IDLE_WINDOWS_MS);
  const context: GenerationContext = { random, windowMs, profile };
  const clocks: ProducerClocks = {
    heartbeat: nextFiring("heartbeat", 0, context),
    toolCall: nextFiring("toolCall", 0, context),
    monitorTick: MONITOR_INTERVAL_MS,
    cleanupSweep: CLEANUP_INTERVAL_MS,
  };
  const horizon = windowMs * profile.horizonWindows;
  const instants: Instant[] = [];
  let ownerAlive = true;
  while (instants.length < 1_000) {
    const instant = nextInstant(clocks, context, ownerAlive);
    if (instant.at > horizon) {
      break;
    }
    instants.push(instant);
    for (const event of instant.events) {
      clocks[event] = nextFiring(event, instant.at, context);
    }
    if (ownerAlive && random.next() < profile.ownerExitChance) {
      ownerAlive = false;
      instants.push({ at: instant.at, events: [] });
    }
  }
  return { seed, idleWindowMs: windowMs, instants };
}

/** Virtual time the owner exited at, or undefined if it never did. */
export function ownerExitAt(instants: readonly Instant[]): number | undefined {
  return instants.find((instant) => instant.events.length === 0)?.at;
}

export interface ToolCallOutcome {
  at: number;
  ok: boolean;
}

export interface Release {
  at: number;
  reason: string;
}

export interface RunResult {
  release?: Release;
  toolCalls: ToolCallOutcome[];
  /** The idle deadline (`expiresAt`) after each instant that left the session in place. */
  deadlines: { at: number; expiresAt: number }[];
}

function shuffled<T>(items: readonly T[], random: Random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random.next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

/** The reduced daemon core one schedule runs against. */
class ScheduleWorld {
  readonly timer = new FakeTimer();
  readonly manager = new SessionManager(this.timer, new FakeDeviceSessionPersistence());
  readonly releases: Release[] = [];
  readonly toolCalls: ToolCallOutcome[] = [];
  readonly monitor = new SessionHeartbeatMonitor(
    this.manager,
    () => false,
    async (sessionId, reason) => {
      await this.manager.releaseSession(sessionId, reason);
    },
    this.timer,
  );
  private readonly state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => this.manager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };

  constructor() {
    this.manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      this.releases.push({ at: this.timer.now(), reason });
    });
  }

  async start(windowMs: number): Promise<void> {
    await this.manager.createSession(SESSION, DEVICE, "android", windowMs);
    const claim = await this.heartbeat(true);
    if (!claim.success) {
      throw new Error(`owner claim failed: ${JSON.stringify(claim)}`);
    }
    this.monitor.start();
  }

  heartbeat(claim = false) {
    return handleDaemonRequest(
      {
        id: "heartbeat",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessOwnerToken: OWNER,
          ...(claim ? { claimLivenessOwnership: true } : {}),
        },
      },
      this.state,
    );
  }

  /**
   * One agent tool call. Returns true when the daemon answered "suspect, retry now": the agent
   * retries once at the end of the instant, after the owner's queued heartbeat (#10053).
   */
  async toolCall(retry = false): Promise<boolean> {
    const at = this.timer.now();
    try {
      await this.manager.getOrCreateSession(SESSION);
      this.toolCalls.push({ at, ok: true });
      return false;
    } catch (error) {
      if (!retry && error instanceof SessionSuspectError) {
        return true;
      }
      // A refused call (released, terminal) is an outcome the properties judge: the agent did
      // not get to use the device, so it is not activity.
      this.toolCalls.push({ at, ok: false });
      return false;
    }
  }

  /** Deliver one producer event; true when it is a tool call the agent must retry. */
  async deliver(event: ProducerEvent): Promise<boolean> {
    switch (event) {
      case "heartbeat":
        await this.heartbeat();
        return false;
      case "toolCall":
        return await this.toolCall();
      case "monitorTick":
        await this.monitor.tick();
        return false;
      case "cleanupSweep":
        this.manager.cleanupExpiredSessions();
        return false;
    }
  }

  /** Deliver one instant's events in the given order, then any suspect-refused retry. */
  async deliverInstant(events: readonly ProducerEvent[]): Promise<void> {
    let retryToolCall = false;
    for (const event of events) {
      retryToolCall = (await this.deliver(event)) || retryToolCall;
    }
    if (retryToolCall) {
      await this.toolCall(true);
    }
  }

  /** A lookup or sweep began releasing the session; its callback lands a few turns later. */
  releaseStarted(): boolean {
    return this.manager.getReleasingSession(SESSION) !== null || !this.manager.hasSession(SESSION);
  }

  async stop(): Promise<void> {
    await this.monitor.stop();
    this.manager.stopCleanupTimer();
  }
}

/** Microtask turns that let a started release run through to its release callback. */
const RELEASE_SETTLE_TURNS = 40;

/**
 * Replay `instants` (default: the whole schedule), shuffling same-instant events with
 * `orderSeed`. Stops at the first release.
 */
export async function runSchedule(
  schedule: Schedule,
  orderSeed: number,
  instants: readonly Instant[] = schedule.instants,
): Promise<RunResult> {
  const order = new SeededRandom(orderSeed);
  const world = new ScheduleWorld();
  const deadlines: RunResult["deadlines"] = [];
  try {
    await world.start(schedule.idleWindowMs);
    for (const instant of instants) {
      world.timer.setCurrentTime(instant.at);
      await world.deliverInstant(shuffled(instant.events, order));
      if (world.releaseStarted()) {
        await drainMicrotasks(RELEASE_SETTLE_TURNS);
      }
      if (world.releases.length > 0) {
        break;
      }
      const session = world.manager.getAllSessions().find((s) => s.sessionId === SESSION);
      if (session) {
        deadlines.push({ at: instant.at, expiresAt: session.expiresAt });
      }
    }
  } finally {
    await world.stop();
  }
  return { release: world.releases[0], toolCalls: world.toolCalls, deadlines };
}

/** The policy that released a session, independent of which path (lookup or sweep) ran it. */
export function reasonClass(release: Release | undefined): string {
  if (release === undefined) {
    return "kept";
  }
  return release.reason === "lazy-expiry" || release.reason === "cleanup-expired"
    ? "idle"
    : release.reason;
}

/** Last accepted tool call at or before `at`; session creation at t=0 counts as one. */
export function lastToolAt(result: RunResult, at: number): number {
  return result.toolCalls
    .filter((call) => call.ok && call.at <= at)
    .reduce((latest, call) => Math.max(latest, call.at), 0);
}

export type PropertyCheck = (schedule: Schedule) => Promise<string | undefined>;

/** Instants printed with a failure; earlier ones are summarized, the seed replays them all. */
const PRINTED_TAIL_INSTANTS = 16;

export function describeSchedule(schedule: Schedule): string {
  const tail = schedule.instants.slice(-PRINTED_TAIL_INSTANTS);
  const omitted = schedule.instants.length - tail.length;
  const lines = tail.map((instant) => {
    const gap = instant.discontinuity
      ? `  <- resumes after ${instant.discontinuity.kind} of ${instant.discontinuity.ms}ms`
      : "";
    const events = instant.events.length === 0 ? "(owner exits)" : instant.events.join(", ");
    return `  t=${instant.at}: ${events}${gap}`;
  });
  return [
    `seed=${schedule.seed} idleWindowMs=${schedule.idleWindowMs}`,
    ...(omitted > 0 ? [`  ... ${omitted} earlier instants (replay the seed for all of them)`] : []),
    ...lines,
  ].join("\n");
}

/**
 * Shrink a failing schedule to its shortest failing prefix (binary search), so the printed
 * schedule ends where the property broke. Prefixes keep the generator's invariants (a live
 * owner's heartbeat cadence, the monitor's schedule) that dropping single instants would break.
 * Runs only on a failure.
 */
export async function shrinkSchedule(schedule: Schedule, check: PropertyCheck): Promise<Schedule> {
  const prefix = (length: number): Schedule => ({
    ...schedule,
    instants: schedule.instants.slice(0, length),
  });
  let failing = schedule.instants.length;
  let passing = 0;
  while (failing - passing > 1) {
    const middle = Math.floor((failing + passing) / 2);
    if ((await check(prefix(middle))) === undefined) {
      passing = middle;
    } else {
      failing = middle;
    }
  }
  return prefix(failing);
}

function positiveIntEnv(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Seed chunks for one property: `chunks` fixed chunks of `chunkSize` consecutive seeds from
 * `firstSeed`, one test each so every test stays inside the per-test budget. For a longer local
 * sweep, AUTOMOBILE_EXPIRY_PROPERTY_SEEDS (how many) and AUTOMOBILE_EXPIRY_PROPERTY_SEED_BASE
 * (first seed) replace them with a single chunk.
 */
export function seedChunks(firstSeed: number, chunkSize: number, chunks: number): number[][] {
  const range = (start: number, length: number): number[] =>
    Array.from({ length }, (_, i) => start + i);
  const count = positiveIntEnv("AUTOMOBILE_EXPIRY_PROPERTY_SEEDS");
  const base = positiveIntEnv("AUTOMOBILE_EXPIRY_PROPERTY_SEED_BASE");
  if (count || base !== undefined) {
    return [range(base ?? firstSeed, count || chunkSize * chunks)];
  }
  return Array.from({ length: chunks }, (_, chunk) =>
    range(firstSeed + chunk * chunkSize, chunkSize),
  );
}

/**
 * Run `check` over each seed's schedule. On the first failure, shrink it and throw with the
 * seed, the violation and the shrunk schedule.
 */
export async function assertProperty(
  seeds: readonly number[],
  profile: ScheduleProfile,
  check: PropertyCheck,
): Promise<void> {
  for (const seed of seeds) {
    const schedule = generateSchedule(seed, profile);
    const violation = await check(schedule);
    if (violation !== undefined) {
      const shrunk = await shrinkSchedule(schedule, check);
      throw new Error(
        `Property violated for seed ${seed}: ${(await check(shrunk)) ?? violation}\n` +
          `Replay: AUTOMOBILE_EXPIRY_PROPERTY_SEED_BASE=${seed} AUTOMOBILE_EXPIRY_PROPERTY_SEEDS=1\n` +
          `Shrunk schedule:\n${describeSchedule(shrunk)}`,
      );
    }
  }
}
