import {
  deliverDaemonHeartbeat,
  deliverDaemonHeartbeatIfKnown,
} from "../helpers/daemonHeartbeatHandler";
import { describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  SessionManager,
  SessionSuspectError,
  TerminalSessionError,
  type Session,
} from "../../src/daemon/sessionManager";
import { idleReleaseAt } from "../../src/daemon/sessionHoldDiagnostics";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { releasedSessionNotFoundFields } from "../../src/daemon/types";

// One source of truth for "when does this session idle-expire" (#11558). Three things answer it:
// the scan that releases an idle session, the lazy-expiry check when a new control call is
// admitted, and the `idleReleaseAt` the client is told. They must give the same instant for every
// kind of session, whatever mix of tool calls, daemon stalls (forgiven, #10835), host sleep
// (counted) and wall-clock steps (ignored) came before.
//
// Each seeded schedule runs against the real SessionManager and SessionHeartbeatMonitor on a
// FakeTimer. After every step the scan and the reported instant are compared, every control call's
// admission is compared with the reported instant, and the reported instant is checked against a
// model kept by the test alone: the idle window after the last tool call, moved by the daemon's
// stalls and by nothing else.

const SESSION = "idle-one-source";
const DEVICE = "emulator-5554";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const IDLE_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
/** Stalls well past the monitor's lateness margin, so each one is forgiven. */
const STALLS_MS = [10_000, 40_000, 90_000, 130_000];
const QUIET_MS = [2_000, 6_000, 20_000, 50_000, 70_000, 110_000];
const WALL_STEPS_MS = [-3_600_000, -45_000, 45_000, 3_600_000];
const SLEEPS_MS = [15_000, 45_000, 130_000];

interface SessionKind {
  name: string;
  /** Whether an owner process heartbeats for it (a one-shot CLI has none). */
  heartbeats: boolean;
  /** What its owner's heartbeat frames carry (its liveness owner token, if it claimed one). */
  heartbeatParams?: Record<string, unknown>;
  setUp(manager: SessionManager): Promise<void>;
}

const SESSION_KINDS: readonly SessionKind[] = [
  {
    name: "cli-idle",
    heartbeats: false,
    async setUp(manager) {
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: 60_000 });
      expect(manager.adoptCliLivenessPolicy(SESSION, IDLE_MS)).toBe(true);
    },
  },
  {
    // A session that had a longer window before a one-shot CLI adopted it keeps the longer
    // `expiresAt`, but is idle-released on the CLI window.
    name: "cli-idle adopted from a 30-minute session",
    heartbeats: false,
    async setUp(manager) {
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: 30 * 60_000 });
      expect(manager.adoptCliLivenessPolicy(SESSION, IDLE_MS)).toBe(true);
    },
  },
  {
    name: "proxy-owned (liveness token)",
    heartbeats: true,
    heartbeatParams: { livenessOwnerToken: "proxy-token" },
    async setUp(manager) {
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
      expect(await manager.claimLivenessOwnership(SESSION, "proxy-token")).toBe("claimed");
    },
  },
  {
    name: "heartbeat without an owner token",
    heartbeats: true,
    async setUp(manager) {
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_MS });
    },
  },
  {
    name: "managed execution",
    heartbeats: true,
    async setUp(manager) {
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: 60_000 });
      await manager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: IDLE_MS });
    },
  },
];

type Step =
  | { kind: "quiet"; ms: number }
  | { kind: "stall"; ms: number; callFirst: boolean }
  | { kind: "sleep"; ms: number; callFirst: boolean }
  | { kind: "wallStep"; ms: number }
  | { kind: "call" };

const describeStep = (step: Step): string =>
  step.kind === "call"
    ? "call"
    : `${step.kind} ${step.ms}${"callFirst" in step && step.callFirst ? " then call" : ""}`;

function generateSchedule(random: SeededRandom, length: number): Step[] {
  return Array.from({ length }, (): Step => {
    const roll = random.next();
    if (roll < 0.35) {
      return { kind: "quiet", ms: random.pick(QUIET_MS) };
    }
    if (roll < 0.6) {
      return { kind: "stall", ms: random.pick(STALLS_MS), callFirst: random.next() < 0.5 };
    }
    if (roll < 0.7) {
      return { kind: "sleep", ms: random.pick(SLEEPS_MS), callFirst: random.next() < 0.5 };
    }
    if (roll < 0.82) {
      return { kind: "wallStep", ms: random.pick(WALL_STEPS_MS) };
    }
    return { kind: "call" };
  });
}

class IdleWorld {
  readonly timer = new FakeTimer();
  readonly manager = new SessionManager(this.timer, new FakeDeviceSessionPersistence());
  readonly released: string[] = [];
  readonly monitor = new SessionHeartbeatMonitor(
    this.manager,
    () => false,
    async (sessionId, reason) => {
      await this.manager.releaseSession(sessionId, reason);
    },
    { timer: this.timer },
  );
  /** The live session object: read after a release too, to compare with what released it. */
  session!: Session;
  /** Model: the session-clock instant of the last tool call (or of the session's creation). */
  private anchor = 0;
  /** Model: how long the daemon stalled since {@link anchor}. */
  private stalledMs = 0;
  private stallCount = 0;
  private wallSteppedMs = 0;
  private calls = 0;
  trail: string[] = [];

  constructor(private readonly kind: SessionKind) {}

  async start(): Promise<void> {
    this.manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      this.released.push(reason);
    });
    await this.kind.setUp(this.manager);
    this.session = this.manager.getSession(SESSION)!;
    this.anchor = this.manager.sessionNow();
    this.monitor.start();
  }

  async stop(): Promise<void> {
    await this.monitor.stop();
    this.manager.stopCleanupTimer();
  }

  get held(): boolean {
    return this.released.length === 0;
  }

  /** What the client is told, on the session clock. */
  private reported(): number | null {
    return idleReleaseAt(this.session, this.manager.getSessionLeaseState(SESSION)?.phase);
  }

  private fail(message: string): never {
    throw new Error(`${this.kind.name}: ${message}\n  steps: ${this.trail.join(" | ")}`);
  }

  /**
   * The reported instant against the model: the idle window after the last tool call, moved only
   * by the daemon's stalls. A stall is forgiven for its length less the one scan interval the
   * daemon would have waited anyway; sleep and wall-clock steps move nothing.
   */
  private checkReportedAgainstModel(): void {
    const reported = this.reported();
    if (reported === null) {
      if (this.session.livenessPolicy !== "managed-execution") {
        this.fail("unexpected idle exemption");
      }
      expect(this.manager.getSessionLeaseState(SESSION)?.phase).not.toBe("lapsed");
      expect(this.held).toBe(true);
      return;
    }
    const earliest = this.anchor + IDLE_MS + this.stalledMs - this.stallCount * SCAN_MS;
    const latest = this.anchor + IDLE_MS + this.stalledMs;
    if (reported < earliest || reported > latest) {
      this.fail(
        `idleReleaseAt is ${reported - this.anchor}ms after the last tool call; expected ` +
          `${earliest - this.anchor}..${latest - this.anchor}ms`,
      );
    }
  }

  /** Run one scan and require it to release exactly when the reported instant has passed. */
  private async scan(): Promise<void> {
    await this.monitor.tick();
    await drainMicrotasks(20);
    const now = this.manager.sessionNow();
    const reported = this.reported();
    if (reported === null) {
      if (!this.held) {
        this.fail(`exempt session released: ${this.released.join(",")}`);
      }
      return;
    }
    const expectedReason =
      this.session.livenessPolicy === "cli-idle" ? "cli-idle-timeout" : "cleanup-expired";
    if (this.released.some((reason) => reason !== expectedReason)) {
      this.fail(`released as ${this.released.join(",")}; expected ${expectedReason}`);
    }
    if (this.held !== now <= reported) {
      this.fail(
        `the scan ${this.held ? "kept" : `released (${this.released.join(",")})`} the session ` +
          `${now - reported}ms past the reported idleReleaseAt`,
      );
    }
    if (this.held) {
      this.checkReportedAgainstModel();
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.kind.heartbeats && this.held) {
      await deliverDaemonHeartbeatIfKnown(this.manager, SESSION, this.kind.heartbeatParams);
    }
  }

  /** A control call: admitted exactly when it starts at or before the reported instant. */
  private async call(): Promise<void> {
    // The daemon judges a stall it has not scanned yet before any lookup; an unknown id runs that
    // judgement and nothing else, so `reported` below is what a client asking now would be told.
    this.manager.getSession("no-such-session");
    const now = this.manager.sessionNow();
    const reported = this.reported();
    const outcome = await this.manager
      .getOrCreateSession(SESSION, undefined, undefined, {
        execution: {
          executionId: `call-${this.calls++}`,
          startTime: this.timer.now(),
        },
      })
      .then(
        () => "admitted",
        (error: Error) => error.constructor.name,
      );
    await drainMicrotasks(20);
    const expected = reported === null || now <= reported ? "admitted" : "TerminalSessionError";
    if (outcome !== expected) {
      this.fail(
        `a control call ${now - (reported ?? now)}ms past the reported idleReleaseAt was ${outcome}; ` +
          `expected ${expected}`,
      );
    }
    if (outcome !== "admitted") {
      const expectedReason =
        this.session.livenessPolicy === "cli-idle" ? "cli-idle-timeout" : "cleanup-expired";
      if (this.released.some((reason) => reason !== expectedReason)) {
        this.fail(`the late call released the session as ${this.released.join(",")}`);
      }
      return;
    }
    if (!this.held) {
      this.fail(`an admitted call left the session released (${this.released.join(",")})`);
    }
    this.manager.recordToolCallEnded(SESSION);
    this.anchor = this.manager.sessionNow();
    this.stalledMs = 0;
    this.stallCount = 0;
    this.checkReportedAgainstModel();
  }

  async apply(step: Step): Promise<void> {
    this.trail.push(describeStep(step));
    switch (step.kind) {
      case "quiet":
        // Time passes with every scan and heartbeat on time.
        for (let elapsed = 0; elapsed < step.ms && this.held; elapsed += SCAN_MS) {
          await this.timer.advanceTimeAsync(SCAN_MS, () => drainMicrotasks(5));
          await this.heartbeat();
          await this.scan();
        }
        return;
      case "stall":
        // The daemon's event loop is blocked: both clocks run, no timer fires, and the owner's
        // heartbeats queue up to be read on resume.
        this.timer.setCurrentTime(this.timer.now() - this.wallSteppedMs + step.ms);
        this.stalledMs += step.ms;
        this.stallCount++;
        if (step.callFirst) {
          await this.call();
        }
        if (this.held) {
          await this.scan();
          await this.heartbeat();
        }
        return;
      case "sleep":
        // The host was suspended: nothing ran, and the time counts toward the idle window. On
        // wake a call may reach the daemon before its overdue scan does.
        this.timer.simulateHostSleep(step.ms);
        if (step.callFirst) {
          await this.call();
        }
        if (this.held) {
          await this.scan();
          await this.heartbeat();
        }
        return;
      case "wallStep":
        this.timer.stepWallClock(step.ms);
        this.wallSteppedMs += step.ms;
        await this.scan();
        // The owner keeps heartbeating across the step; a forward one reads as host sleep.
        await this.heartbeat();
        return;
      case "call":
        await this.call();
        if (this.held) {
          await this.scan();
        }
        return;
    }
  }
}

async function runSchedule(kind: SessionKind, seed: number): Promise<{ idleReleased: boolean }> {
  const world = new IdleWorld(kind);
  await world.start();
  try {
    for (const step of generateSchedule(new SeededRandom(seed), 14)) {
      if (!world.held) {
        break;
      }
      await world.apply(step);
    }
    // Whatever the schedule did, an untouched session is then released by the scan on time.
    for (let waited = 0; world.held && waited <= IDLE_MS + SCAN_MS; waited += SCAN_MS) {
      await world.apply({ kind: "quiet", ms: SCAN_MS });
    }
    return { idleReleased: !world.held };
  } catch (error) {
    throw new Error(`seed ${seed}: ${(error as Error).message}`);
  } finally {
    await world.stop();
  }
}

describe("the scan, a late call's admission and idleReleaseAt give one idle deadline (#11558)", () => {
  for (const phase of ["live", "suspect", "lapsed"] as const) {
    test.each(["lookup", "late call", "sweep", "monitor", "report"] as const)(
      `managed execution with ${phase} lease at %s never ends as idle cleanup`,
      async (seam) => {
        const timer = new FakeTimer();
        const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
        manager.stopCleanupTimer();
        const releases: string[] = [];
        manager.onSessionRelease((_id, _device, reason) => {
          releases.push(reason);
        });
        const monitor = new SessionHeartbeatMonitor(
          manager,
          () => false,
          async (id, reason) => {
            await manager.releaseSession(id, reason);
          },
          { timer },
        );
        try {
          const session = await manager.createSession(SESSION, DEVICE, "android");
          await manager.adoptManagedExecutionLivenessPolicy(SESSION);
          await manager.claimLivenessOwnership(SESSION, "managed-owner");
          timer.setCurrentTime(session.expiresAt + 1);
          await deliverDaemonHeartbeat(manager, SESSION, { livenessOwnerToken: "managed-owner" });
          const age =
            phase === "live"
              ? 0
              : session.heartbeatTimeoutMs + (phase === "suspect" ? 1 : SUSPECT_GRACE_MS + 1);
          timer.setCurrentTime(timer.now() + age);
          expect(manager.getSessionLeaseState(SESSION)?.phase).toBe(phase);
          const reported = () =>
            idleReleaseAt(session, manager.getSessionLeaseState(SESSION)?.phase);
          expect(reported()).toBe(phase === "lapsed" ? session.expiresAt : null);
          if (seam === "lookup") {
            expect(manager.getSession(SESSION)).toBe(session);
          } else if (seam === "late call") {
            const call = manager.getOrCreateSession(SESSION, undefined, undefined, {
              execution: {
                executionId: "late-call",
                startTime: timer.now(),
              },
            });
            if (phase === "suspect") {
              await expect(call).rejects.toBeInstanceOf(SessionSuspectError);
            } else if (phase === "lapsed") {
              await expect(call).rejects.toBeInstanceOf(TerminalSessionError);
            } else {
              expect(await call).toBe(session);
            }
          } else if (seam === "sweep") {
            manager.cleanupExpiredSessions();
          } else if (seam === "monitor") {
            await monitor.tick();
            await drainMicrotasks(20);
          } else {
            expect(reported()).toBe(phase === "lapsed" ? session.expiresAt : null);
          }
          if (phase !== "lapsed") {
            expect(reported()).toBeNull();
            expect(manager.hasSession(SESSION)).toBe(true);
            expect(releases).toEqual([]);
          } else {
            // Every seam defers owner loss to the heartbeat path, even past the idle deadline.
            if (seam !== "monitor" && seam !== "late call") {
              expect(manager.hasSession(SESSION)).toBe(true);
              expect(releases).toEqual([]);
              await monitor.tick();
            }
            await manager.waitForSessionRelease(SESSION);
            expect(manager.hasSession(SESSION)).toBe(false);
            expect(releases).toEqual(["heartbeat-timeout"]);
            const fields = releasedSessionNotFoundFields(
              await manager.getReleasedSessionReason(SESSION),
            );
            expect(fields).toMatchObject({ releaseReason: "heartbeat-timeout" });
            expect(fields).not.toHaveProperty("idle");
          }
        } finally {
          await monitor.stop();
          manager.stopCleanupTimer();
        }
      },
    );
  }

  test.each([
    { name: "late call", callFirst: true },
    { name: "monitor", callFirst: false },
  ])("cli-idle idle end noticed by $name", async ({ callFirst }) => {
    const world = new IdleWorld(SESSION_KINDS[0]!);
    await world.start();
    try {
      await world.apply({ kind: "sleep", ms: IDLE_MS + 1, callFirst });
      expect(world.released).toEqual(["cli-idle-timeout"]);
    } finally {
      await world.stop();
    }
  });

  for (const kind of SESSION_KINDS) {
    for (const seeds of [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ]) {
      test(`${kind.name}: seeded schedules ${seeds.join(", ")}`, async () => {
        for (const seed of seeds) {
          expect(await runSchedule(kind, seed)).toEqual({
            idleReleased: kind.name !== "managed execution",
          });
        }
      });
    }
  }
});
