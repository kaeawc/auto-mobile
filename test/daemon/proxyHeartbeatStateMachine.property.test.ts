import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// The proxy's heartbeat state machine (#11411, #11400), checked over short random histories. The
// table it implements is documented on DaemonMcpProxy.hasHeartbeatTargets; observed from outside:
//
// | what the daemon holds / told the proxy              | keeper       | heartbeats   | a call naming it  |
// | --------------------------------------------------- | ------------ | ------------ | ----------------- |
// | live, acquired or reached by a call since           | runs         | every tick   | forwarded         |
// | gone with no reason or a recoverable one, told by a | for others   | none needed  | forwarded, and    |
// |   not-found heartbeat                               |              |              | success re-arms   |
// | gone with a terminal reason, proxy told (release    | for others   | never again  | refused locally   |
// |   notification or not-found heartbeat)              |              |              | while it is the   |
// |                                                     |              |              | fenced binding    |
//
// "keeper runs" is observed as the keeper's interval being scheduled: it is, exactly while some
// session the proxy must heartbeat exists.

// See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 11_411, numRuns: 100 } as const;

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const TERMINAL_REASON = "device-killed";
const RECOVERABLE_REASON = "device-restart:emulator-5554";

type Gone = "terminal" | "recoverable" | "unknown";

/**
 * What becomes of a session right after it is minted: it lives, the daemon reaped it before its
 * first heartbeat arrived, or its release notification lands during that heartbeat.
 */
type Birth = "lives" | "reaped" | "released";

type Command =
  | { kind: "acquire"; birth: Birth }
  | { kind: "release"; target: number; gone: Gone; notify: boolean }
  | { kind: "call"; target: number; rejected: boolean }
  /** The daemon is replaced; nothing listens for `gapMs` in between. */
  | { kind: "daemon-restart"; gapMs: number }
  | { kind: "tick" };

const target = fc.nat({ max: 5 });
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("acquire" as const),
      birth: fc.constantFrom<Birth>("lives", "lives", "reaped", "released"),
    }),
  },
  // A terminal release, announced by its notification or learned from the next heartbeat.
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("terminal"),
      notify: fc.boolean(),
    }),
  },
  // A recoverable handoff: the device restarts and the daemon hands the session back.
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("recoverable"),
      notify: fc.boolean(),
    }),
  },
  // The daemon answers not-found with no reason; only a heartbeat can say so.
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("unknown"),
      notify: fc.constant(false),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("call" as const), target, rejected: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("daemon-restart" as const),
      // No gap, or one longer than a heartbeat request, which starts liveness recovery.
      gapMs: fc.constantFrom(0, LEASE_MS),
    }),
  },
  { weight: 4, arbitrary: fc.constant<Command>({ kind: "tick" }) },
);

interface SessionModel {
  /** What the daemon answers for it: live, or gone and how. */
  daemon: "live" | Gone;
  /** The proxy was told it is gone and has not been handed it again since. */
  told: boolean;
  /**
   * The command during which the proxy learned it is dead (-1: not yet). A not-found heartbeat
   * is retried once on a fresh connection, within the same command.
   */
  deadSince: number;
  heartbeats: number;
}

/** A daemon the proxy talks to, with the model of what the proxy must do about each session. */
class World {
  readonly timer = new FakeTimer();
  readonly sessions = new Map<string, SessionModel>();
  /** Live sessions the proxy acquired or reached with a call: it must heartbeat each of them. */
  readonly mustBeat = new Set<string>();
  readonly violations: string[] = [];
  /** The proxy's latest binding, when the history leaves no doubt about it. */
  latest: string | undefined;
  /** The latest binding the proxy was told is terminally gone: its calls are refused locally. */
  fenced: string | undefined;
  rejectNextCall = false;
  private nextBirth: Birth = "lives";
  private reachable = true;
  private commandsApplied = 0;
  private nextSession = 0;
  private client = this.newClient();
  readonly proxy: DaemonMcpProxy;

  constructor() {
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    this.proxy = new DaemonMcpProxy({
      clientFactory: (): DaemonClientLike => this.client,
      daemonAvailabilityProbe: async () => this.reachable,
      daemonManager,
      autoStartDaemon: false,
      timer: this.timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  }

  sessionAt(index: number): string | undefined {
    const known = [...this.sessions.keys()];
    return known.length === 0 ? undefined : known[index % known.length];
  }

  private newClient(): FakeDaemonClient {
    return new FakeDaemonClient({
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          this.answerHeartbeat(params.sessionId);
        }
      },
      onCallTool: (name, params) => {
        if (typeof params.sessionUuid === "string") {
          this.answerCall(params.sessionUuid);
        }
      },
      toolResultFor: (name) => (name === "getAndroid" ? this.mintSession() : undefined),
    });
  }

  private mintSession(): { content: Array<{ type: string; text: string }> } {
    const sessionUuid = `session-${this.nextSession}`;
    this.nextSession += 1;
    this.sessions.set(sessionUuid, {
      daemon: this.nextBirth === "reaped" ? "terminal" : "live",
      told: false,
      deadSince: -1,
      heartbeats: 0,
    });
    // The proxy binds what an acquisition mints, before the session's first heartbeat.
    this.latest = sessionUuid;
    this.fenced = undefined;
    return {
      content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
    };
  }

  private answerHeartbeat(sessionUuid: string): void {
    const session = this.sessions.get(sessionUuid);
    if (!session) {
      this.violations.push(`heartbeat for ${sessionUuid}, which the daemon never minted`);
      return;
    }
    session.heartbeats += 1;
    if (session.heartbeats === 1 && this.nextBirth === "released" && this.latest === sessionUuid) {
      // The heartbeat itself is acknowledged; the release reaches the proxy during it.
      this.release(sessionUuid, "terminal", true);
      return;
    }
    if (session.daemon === "live") {
      return;
    }
    if (session.daemon === "terminal") {
      if (session.deadSince !== -1 && session.deadSince !== this.commandsApplied) {
        this.violations.push(`heartbeat for ${sessionUuid} after the proxy learned it is dead`);
      }
      this.learnDead(sessionUuid);
    }
    session.told = true;
    throw Object.assign(new Error(`Session not found: ${sessionUuid}`), {
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      ...(session.daemon === "terminal" ? { releaseReason: TERMINAL_REASON } : {}),
      ...(session.daemon === "recoverable" ? { releaseReason: RECOVERABLE_REASON } : {}),
    });
  }

  private answerCall(sessionUuid: string): void {
    const session = this.sessions.get(sessionUuid);
    if (!session || session.daemon === "terminal") {
      this.violations.push(`a call naming dead session ${sessionUuid} reached the daemon`);
      throw new Error(`Session not found: ${sessionUuid}`);
    }
    // A recoverable or not yet materialised session is restored by the call that names it, and
    // the proxy may heartbeat it again.
    session.daemon = "live";
    session.told = false;
    if (this.rejectNextCall) {
      this.rejectNextCall = false;
      throw new Error("Element not found: text 'Continue'");
    }
  }

  private learnDead(sessionUuid: string): void {
    const session = this.sessions.get(sessionUuid)!;
    session.told = true;
    if (session.deadSince === -1) {
      session.deadSince = this.commandsApplied;
    }
    if (this.latest === sessionUuid) {
      this.fenced = sessionUuid;
      this.latest = undefined;
    }
  }

  /** The proxy binds `sessionUuid` as its latest binding and heartbeats it from now on. */
  private bound(sessionUuid: string): void {
    this.latest = sessionUuid;
    this.fenced = undefined;
    this.mustBeat.add(sessionUuid);
    this.reholdPreviousBinding();
  }

  /** A replaced binding is held again: a session the proxy was told about may be asked once more. */
  private reholdPreviousBinding(): void {
    for (const session of this.sessions.values()) {
      if (session.daemon !== "terminal") {
        session.told = false;
      }
    }
  }

  async acquire(birth: Birth): Promise<void> {
    this.nextBirth = birth;
    // Whether an acquisition whose session died at birth is answered or refused is not checked:
    // the daemon's answers already told the model what became of the session.
    const outcome = await this.whileTimePasses(this.proxy.callTool("getAndroid", {}));
    if (outcome === "never answered") {
      this.violations.push("an acquisition was never answered");
    }
    this.nextBirth = "lives";
    const minted = `session-${this.nextSession - 1}`;
    if (this.sessions.get(minted)?.daemon === "live") {
      this.bound(minted);
    } else {
      this.reholdPreviousBinding();
    }
  }

  release(sessionUuid: string, gone: Gone, notify: boolean): void {
    const session = this.sessions.get(sessionUuid)!;
    if (session.daemon === "terminal") {
      return;
    }
    session.daemon = gone;
    this.mustBeat.delete(sessionUuid);
    // A daemon the proxy has not reconnected to yet has nobody to notify.
    if (!notify || !this.client.isConnected()) {
      return;
    }
    this.client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      sessionUuid,
      gone === "terminal" ? TERMINAL_REASON : RECOVERABLE_REASON,
    );
    if (gone === "terminal") {
      this.learnDead(sessionUuid);
    }
  }

  async call(sessionUuid: string, rejected: boolean): Promise<void> {
    const session = this.sessions.get(sessionUuid)!;
    const dead = session.daemon === "terminal";
    if (dead && this.fenced !== sessionUuid) {
      // Not the fenced binding: the daemon, not the proxy, answers for it. Not modelled.
      return;
    }
    this.rejectNextCall = rejected;
    const outcome = await this.whileTimePasses(
      this.proxy.callTool("tapOn", { sessionUuid, text: "Continue" }),
    );
    this.rejectNextCall = false;
    if (dead) {
      // answerCall records the violation when the fenced session's call reaches the daemon.
      return;
    }
    if (outcome === "answered") {
      this.bound(sessionUuid);
    } else if (outcome.startsWith("Element not found")) {
      // Admitted and rejected: the session is live again, and whether the proxy re-bound it
      // depends on what it held, so the latest binding is no longer certain.
      this.latest = this.latest === sessionUuid ? sessionUuid : undefined;
    } else {
      this.violations.push(`a call naming usable session ${sessionUuid} was refused: ${outcome}`);
    }
  }

  async restartDaemon(gapMs: number): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.daemon === "live") {
        // Persisted, not materialised: the replacement daemon answers a plain not-found.
        session.daemon = "unknown";
      }
    }
    this.mustBeat.clear();
    const previous = this.client;
    this.client = this.newClient();
    this.reachable = gapMs === 0;
    previous.emitConnectionClosed();
    if (gapMs > 0) {
      await this.timer.advanceTimeAsync(gapMs);
      this.reachable = true;
      // Recovery spreads its attempts over the lease: let the one that reaches the replacement
      // daemon run, as wall-clock time would before the harness's next call.
      await this.timer.advanceTimeAsync(LEASE_MS);
    }
  }

  /**
   * Await a tool call as wall-clock time would let it finish: after a daemon restart the proxy
   * polls for the replacement on the timer, so time moves on while the call waits.
   */
  private async whileTimePasses(call: Promise<unknown>): Promise<string> {
    let outcome: string | undefined;
    void call.then(
      () => {
        outcome = "answered";
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      },
    );
    for (let waited = 0; outcome === undefined && waited < 100; waited += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (outcome === undefined && waited > 0) {
        await this.timer.advanceTimeAsync(100);
      }
    }
    return outcome ?? "never answered";
  }

  /** Let the heartbeats a command dispatched, and their one retry, reach the daemon. */
  private async settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async tick(): Promise<void> {
    const before = new Map([...this.mustBeat].map((id) => [id, this.sessions.get(id)!.heartbeats]));
    await this.timer.advanceTimeAsync(INTERVAL_MS);
    for (const [sessionUuid, heartbeats] of before) {
      if (this.sessions.get(sessionUuid)!.heartbeats === heartbeats) {
        this.violations.push(`held session ${sessionUuid} was not heartbeated on a keeper tick`);
      }
    }
    const untold = [...this.sessions.values()].some((session) => !session.told);
    const keeperScheduled = this.timer.getPendingIntervalCount() > 0;
    if (this.mustBeat.size > 0 && !keeperScheduled) {
      this.violations.push("the keeper is stopped although a session must be heartbeated");
    }
    if (!untold && keeperScheduled) {
      this.violations.push("the keeper still runs although every session is known to be gone");
    }
  }

  async apply(step: Command): Promise<void> {
    this.commandsApplied += 1;
    await this.run(step);
    // Settled, a heartbeat in flight neither coalesces with the next tick nor outlives its command.
    await this.settle();
  }

  private async run(step: Command): Promise<void> {
    if (step.kind === "acquire") {
      await this.acquire(step.birth);
    } else if (step.kind === "daemon-restart") {
      await this.restartDaemon(step.gapMs);
    } else if (step.kind === "tick") {
      await this.tick();
    } else {
      const sessionUuid = this.sessionAt(step.target);
      if (sessionUuid === undefined) {
        return;
      }
      if (step.kind === "release") {
        this.release(sessionUuid, step.gone, step.notify);
      } else {
        await this.call(sessionUuid, step.rejected);
      }
    }
  }
}

async function violationsOf(history: readonly Command[]): Promise<string[]> {
  const world = new World();
  try {
    for (const step of history) {
      await world.apply(step);
      if (world.violations.length > 0) {
        break;
      }
    }
    // One more tick settles whatever the last command left pending.
    await world.apply({ kind: "tick" });
    return world.violations;
  } finally {
    await world.proxy.close();
  }
}

const ACQUIRE: Command = { kind: "acquire", birth: "lives" };
const TICK: Command = { kind: "tick" };

/** The histories of the bugs this state machine had, one per issue item. */
const REGRESSIONS: ReadonlyArray<readonly [string, readonly Command[]]> = [
  [
    "#11411.1 the next session is reaped before its first heartbeat",
    [ACQUIRE, TICK, { kind: "acquire", birth: "reaped" }, TICK, TICK],
  ],
  [
    "#11411.1 the next session is released during its first heartbeat",
    [ACQUIRE, TICK, { kind: "acquire", birth: "released" }, TICK, TICK],
  ],
  [
    "#11411.2 a rejected call names the held session that survived the latest binding",
    [
      ACQUIRE,
      ACQUIRE,
      { kind: "release", target: 1, gone: "terminal", notify: true },
      TICK,
      { kind: "call", target: 0, rejected: true },
      TICK,
    ],
  ],
  [
    "#11411.3 recovery reaches a replacement daemon that has not materialised the session",
    [
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: LEASE_MS },
      TICK,
      TICK,
      { kind: "call", target: 0, rejected: false },
      TICK,
    ],
  ],
  [
    "#11400.1 a heartbeat is answered not-found with a recoverable release reason",
    [
      ACQUIRE,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      TICK,
      { kind: "call", target: 0, rejected: false },
      TICK,
    ],
  ],
];

describe("proxy heartbeat state machine (property-based)", () => {
  test.each(REGRESSIONS)("%s", async (_name, history) => {
    expect(await violationsOf(history)).toEqual([]);
  });

  test("held sessions are heartbeated, dead ones never are, and the keeper runs exactly while needed", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 8 }), async (history) => {
        const violations = await violationsOf(history);
        if (violations.length > 0) {
          throw new Error(violations.join("; "));
        }
      }),
      { ...RUN_OPTIONS, examples: REGRESSIONS.map(([, history]) => [[...history]]) },
    );
  });
});
