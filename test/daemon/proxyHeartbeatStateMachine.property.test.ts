import { beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { ROUTED_SESSION_META_KEY } from "../../src/server/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// The proxy's heartbeat state machine (#11411, #11400, #11570), checked over short random
// histories of N sessions: the latest binding and every session held besides it.
//
// STATE, per session (nothing about one session is decided by another's):
//   heartbeating  the keeper asks it every tick (the latest binding or a held session), or it is
//                 STOPPED: not asked again until a tool call reaches it.
//   establishing  a connection was made while the proxy was heartbeating it, and the daemon has
//                 not answered a heartbeat for it on that connection yet.
//   window        when its not-found window opened; open for
//                 RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS, then expired. Never extended.
//   ended         the reason it ended for good, once the proxy was told (never leaves this state).
//
// EVENTS and what each does to the session it is about:
//
// | event                                         | effect                                              |
// | --------------------------------------------- | --------------------------------------------------- |
// | connection (re)established, by a daemon       | every heartbeating session: establishing            |
// |   restart or by liveness recovery             |                                                     |
// | ... by the proxy asking a reason-less         | nothing is establishing: the same daemon answers    |
// |   not-found again on a fresh connection       |                                                     |
// | ... by the proxy asking a recoverable         | every heartbeating session: establishing (the       |
// |   handoff answer again                        |   daemon said it is going away)                     |
// | heartbeat answered ok                         | establishing and window cleared; heartbeating       |
// | heartbeat answered not-found, reason R that   | ENDED with R: that session only, under its own      |
// |   is not a recoverable handoff                |   reason; never heartbeated or forwarded again      |
// | heartbeat answered not-found, recoverable     | window open: AWAITED (one heartbeat a tick, each     |
// |   reason or none                              |   claiming, no connection reset)                    |
// |                                               | establishing: window opens now; AWAITED             |
// |                                               | window expired: STOPPED, and the window is spent    |
// |                                               | window spent (asked again after a call): a          |
// |                                               |   recoverable reason opens a new window, no reason  |
// |                                               |   is STOPPED again with no fresh connection         |
// |                                               | no window, connection had answered: the latest      |
// |                                               |   binding is asked once more on a fresh connection, |
// |                                               |   then (and a held session at once) a recoverable   |
// |                                               |   reason opens the window and no reason is STOPPED  |
// | tool call the daemon admits under the session | restored: window cleared, heartbeating again,       |
// |   and uses (it echoes the session)            |   whether it is the latest binding or was held      |
// | tool call that restores nothing (a read, a    | the window is left as it is: neither dropped nor    |
// |   refusal)                                    |   reopened; a STOPPED latest binding is asked once  |
// | release notification, reason R not            | ENDED with R                                        |
// |   recoverable                                 |                                                     |
// | close                                         | every window and the keeper's timer are gone        |
//
// Liveness recovery, the first heartbeat of a connection and a keeper tick all hear the daemon's
// answer through the same decision (decideNotFoundAnswer), so the row is the same whoever asked.
//
// INVARIANTS asserted on every history:
//   I1  a recoverable or reason-less not-found inside a session's window never fences it (its
//       calls are forwarded) and never resets the connection.
//   I2  a reason that ends a session fences exactly that session, under its own reason.
//   I3  every live session the proxy acquired or used is heartbeated on every tick.
//   I4  a session that ended is never heartbeated again and no call is forwarded under it.
//   I5  a window is bounded: an awaited session is asked exactly once a tick, a stopped one not
//       at all, and after close no timer is left and no heartbeat is sent.
//
// "keeper runs" is observed as the keeper's interval being scheduled: it is, exactly while some
// session the proxy must heartbeat exists.
//
// Three rows need a harness this world does not have and are pinned as examples in
// proxyReleaseReasonClassification.test.ts and proxyBoundSessionFirstHeartbeat.test.ts: the first
// heartbeat of a first connection, the handoff answer asked again on a successor daemon, and a
// fence that lands while a call naming another session is still connecting.

// See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 11_411, numRuns: 100 } as const;

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const TERMINAL_REASON = "device-killed";
/**
 * Reasons that end the binding like a terminal one although they are not terminal: the UUID stays
 * re-issuable by name on the daemon, or this build does not know the reason at all.
 */
const ENDING_REASONS = [TERMINAL_REASON, "plan-auto-release", "reason-from-a-newer-daemon"];
const RECOVERABLE_REASON = "device-restart:emulator-5554";
/** `terminal`: released for any reason that is not recoverable, which ends the binding. */
type Gone = "terminal" | "recoverable" | "unknown";

/**
 * What becomes of a session right after it is minted: it lives, the daemon reaped it before its
 * first heartbeat arrived, or its release notification lands during that heartbeat.
 */
type Birth = "lives" | "reaped" | "released";

type Command =
  | { kind: "acquire"; birth: Birth }
  | { kind: "release"; target: number; gone: Gone; notify: boolean; reason?: string }
  /**
   * A control call (the daemon admits it under the session, uses it and echoes it) that the tool
   * then answers or rejects, or with `read` a call that is answered without restoring anything.
   */
  | { kind: "call"; target: number; rejected: boolean; read?: boolean }
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
  // A release that ends the binding (terminal, plan cleanup or a reason this build does not
  // know), announced by its notification or learned from the next heartbeat.
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("terminal"),
      notify: fc.boolean(),
      reason: fc.constantFrom(...ENDING_REASONS),
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
      kind: fc.constant("call" as const),
      target,
      rejected: fc.constant(false),
      read: fc.constant(true),
    }),
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
  /** The reason the daemon gives once the session is gone for good. */
  endedAs: string;
  heartbeats: number;
  /**
   * When the session's not-found window opened: with a recoverable reason (#11461), or with any
   * answer that does not end it on a connection the proxy had just made while holding it
   * (#11529). Kept past its end, until an acknowledgement or a call the daemon admits under the
   * session: no later answer opens another on the same connection.
   */
  windowSince?: number;
  /** An answer found the window expired and the proxy stopped asking: the window is spent. */
  windowSpent?: boolean;
  /**
   * The same answer, when the history leaves it in doubt whether the proxy held the session when
   * it connected: the proxy may or may not be heartbeating it for the window that started then.
   */
  maybeRehydratingSince?: number;
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
  /** False once a rejected call left it open which session the proxy's latest binding is. */
  private latestCertain = true;
  /**
   * Sessions the proxy holds beyond doubt: bound by an acquisition or an answered call, and not
   * told gone since. The latest binding and the ones held besides it alike.
   */
  private readonly held = new Set<string>();
  /**
   * The sessions whose next heartbeat answer is the first on a connection the proxy just made
   * while it held them: that heartbeat re-establishes ownership of each (#11529, #11557).
   */
  private readonly reestablishing = new Set<string>();
  /**
   * The proxy just connected and re-establishes what it holds. A session outside `held` may be
   * one of them: the history leaves that in doubt.
   */
  private reestablishes = false;
  /** Sessions the daemon answered a heartbeat for on the current connection. */
  private readonly answeredOnConnection = new Set<string>();
  /**
   * The answer that lets the proxy ask once more on a fresh connection, heard during the current
   * command: a not-found that does not end its session, which has no window, on a connection that
   * had answered before. `same-daemon`: for the latest binding and with no reason, so the
   * connection made for it re-establishes nothing. `successor`: with a recoverable reason, so that
   * connection re-establishes every session. `doubt`: the history leaves the latest binding open.
   */
  private askAgain: "same-daemon" | "successor" | "doubt" | undefined;
  /** The proxy closed a working connection itself; the next one it makes follows from that. */
  private ownReset: "same-daemon" | "successor" | "doubt" | "other" | undefined;
  /** Working connections the proxy closed itself, but for a handoff the daemon announced. */
  private ownResets = 0;
  /**
   * The daemon announced a recoverable handoff: the proxy reclaims the session on a replacement
   * connection, which it makes before its next request.
   */
  private handoffAnnounced = false;
  /** The time until which liveness recovery may still replace the connection after a gap. */
  private recoveringUntil = Number.NEGATIVE_INFINITY;
  private closed = false;
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
    const created = new FakeDaemonClient({
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          this.answerHeartbeat(params.sessionId);
        }
      },
      onCallTool: (name, params) => {
        if (typeof params.sessionUuid === "string") {
          this.answerCall(name, params.sessionUuid);
        }
      },
      toolResultFor: (name, params) =>
        name === "getAndroid"
          ? this.mintSession()
          : name === "tapOn"
            ? // The daemon admitted the call under this session and used it.
              {
                content: [{ type: "text", text: "tapped" }],
                _meta: { [ROUTED_SESSION_META_KEY]: params.sessionUuid },
              }
            : undefined,
    });
    const connect = created.connect.bind(created);
    created.connect = async () => {
      await connect();
      this.connectionEstablished();
    };
    const close = created.close.bind(created);
    created.close = async () => {
      if (!this.closed && this.reachable && this.client === created && created.isConnected()) {
        this.ownResets += this.handoffAnnounced ? 0 : 1;
        this.handoffAnnounced = false;
        this.ownReset = this.askAgain ?? "other";
      }
      await close();
    };
    return created;
  }

  /**
   * The proxy connected: the keeper's next heartbeat for each session it holds re-establishes
   * ownership of that session.
   */
  private connectionEstablished(): void {
    const ownReset = this.ownReset;
    this.ownReset = undefined;
    this.answeredOnConnection.clear();
    this.reestablishing.clear();
    // Asked again of the same daemon: its answers are not a restarted daemon's first.
    this.reestablishes = ownReset !== "same-daemon";
    if (ownReset === "same-daemon" || ownReset === "doubt") {
      return;
    }
    for (const sessionUuid of this.held) {
      const session = this.sessions.get(sessionUuid)!;
      if (!session.told && session.daemon !== "terminal") {
        this.reestablishing.add(sessionUuid);
      }
    }
  }

  private mintSession(): { content: Array<{ type: string; text: string }> } {
    const sessionUuid = `session-${this.nextSession}`;
    this.nextSession += 1;
    this.sessions.set(sessionUuid, {
      daemon: this.nextBirth === "reaped" ? "terminal" : "live",
      told: false,
      deadSince: -1,
      endedAs: TERMINAL_REASON,
      heartbeats: 0,
    });
    // The proxy binds what an acquisition mints, before the session's first heartbeat.
    this.latest = sessionUuid;
    this.latestCertain = true;
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
    const first = !this.answeredOnConnection.has(sessionUuid);
    this.answeredOnConnection.add(sessionUuid);
    const reestablishes = this.reestablishing.delete(sessionUuid);
    if (session.heartbeats === 1 && this.nextBirth === "released" && this.latest === sessionUuid) {
      // The heartbeat itself is acknowledged; the release reaches the proxy during it.
      this.release(sessionUuid, "terminal", true);
      return;
    }
    if (session.daemon === "live") {
      // An acknowledgement ends the window: the daemon knows the session.
      session.windowSince = undefined;
      session.windowSpent = false;
      return;
    }
    if (session.daemon === "terminal") {
      if (session.deadSince !== -1 && session.deadSince !== this.commandsApplied) {
        this.violations.push(`heartbeat for ${sessionUuid} after the proxy learned it is dead`);
      }
      this.learnDead(sessionUuid);
    }
    if (session.daemon !== "terminal") {
      session.told = !this.awaitedAfterNotFound(sessionUuid, session, reestablishes, first);
      if (session.told) {
        this.held.delete(sessionUuid);
      }
    }
    throw Object.assign(new Error(`Session not found: ${sessionUuid}`), {
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      ...(session.daemon === "terminal" ? { releaseReason: session.endedAs } : {}),
      ...(session.daemon === "recoverable" ? { releaseReason: RECOVERABLE_REASON } : {}),
    });
  }

  /**
   * The row of the table for a not-found answer that does not end the session: whether the proxy
   * keeps heartbeating it (awaited) or stops. A recoverable handoff is not "told gone" until its
   * window has passed: its owner keeps heartbeating so a daemon still recovering the session finds
   * it reclaimed (#11461). Nor is a session a just-connected daemon answered for (#11529).
   */
  private awaitedAfterNotFound(
    sessionUuid: string,
    session: SessionModel,
    establishes: boolean,
    first: boolean,
  ): boolean {
    const now = this.timer.now();
    const recoverable = session.daemon === "recoverable";
    if (!session.windowSpent && this.insideWindow(session, now)) {
      return true;
    }
    if (establishes) {
      session.windowSince = now;
      session.windowSpent = false;
      return true;
    }
    if (session.windowSince !== undefined && !session.windowSpent) {
      // This answer finds the window expired: the session is stopped, the window spent.
      session.windowSpent = true;
      return false;
    }
    if (session.windowSpent) {
      // Asked again after a call reached it: a handoff opens a new window, no reason stops it.
      if (recoverable) {
        session.windowSince = now;
        session.windowSpent = false;
      }
      return recoverable;
    }
    // No window, on a connection that had answered: the latest binding is asked once more.
    this.askAgain ??= recoverable
      ? "successor"
      : this.latestCertain && this.latest === sessionUuid
        ? "same-daemon"
        : "doubt";
    if (recoverable) {
      session.windowSince = now;
      return true;
    }
    if (first && this.reestablishes) {
      session.maybeRehydratingSince ??= now;
    }
    return false;
  }

  private insideWindow(session: SessionModel, now: number): boolean {
    return (
      session.windowSince !== undefined &&
      now - session.windowSince < RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS
    );
  }

  private answerCall(toolName: string, sessionUuid: string): void {
    const session = this.sessions.get(sessionUuid);
    if (!session || session.daemon === "terminal") {
      this.violations.push(`a call naming dead session ${sessionUuid} reached the daemon`);
      throw new Error(`Session not found: ${sessionUuid}`);
    }
    // Whatever the call was, the proxy may ask a session it had stopped asking once more.
    session.told = false;
    if (toolName !== "tapOn") {
      // A read is answered without the session: it restores nothing and says nothing about it.
      return;
    }
    // A recoverable or not yet materialised session is restored by the control call that names
    // it, and the proxy may heartbeat it again.
    session.daemon = "live";
    session.maybeRehydratingSince = undefined;
    if (this.rejectNextCall) {
      // Admitted, then rejected by the tool: no echo, so the window is the next heartbeat's to end.
      this.rejectNextCall = false;
      throw new Error("Element not found: text 'Continue'");
    }
    session.windowSince = undefined;
    session.windowSpent = false;
  }

  private learnDead(sessionUuid: string): void {
    const session = this.sessions.get(sessionUuid)!;
    session.told = true;
    this.held.delete(sessionUuid);
    this.reestablishing.delete(sessionUuid);
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
    this.latestCertain = true;
    this.fenced = undefined;
    this.mustBeat.add(sessionUuid);
    this.held.add(sessionUuid);
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

  release(sessionUuid: string, gone: Gone, notify: boolean, reason = TERMINAL_REASON): void {
    const session = this.sessions.get(sessionUuid)!;
    if (session.daemon === "terminal") {
      return;
    }
    session.daemon = gone;
    session.endedAs = reason;
    this.mustBeat.delete(sessionUuid);
    // A daemon the proxy has not reconnected to yet has nobody to notify.
    if (!notify || !this.client.isConnected()) {
      return;
    }
    this.client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      sessionUuid,
      gone === "terminal" ? reason : RECOVERABLE_REASON,
    );
    if (gone === "terminal") {
      this.learnDead(sessionUuid);
    } else {
      this.handoffAnnounced = true;
    }
  }

  async call(sessionUuid: string, rejected: boolean, read = false): Promise<void> {
    const session = this.sessions.get(sessionUuid)!;
    const dead = session.daemon === "terminal";
    if (dead && this.fenced !== sessionUuid) {
      // Not the fenced binding: the daemon, not the proxy, answers for it. Not modelled.
      return;
    }
    this.rejectNextCall = rejected;
    const outcome = await this.whileTimePasses(
      read
        ? this.proxy.callTool("observe", { sessionUuid })
        : this.proxy.callTool("tapOn", { sessionUuid, text: "Continue" }),
    );
    this.rejectNextCall = false;
    if (dead) {
      // answerCall records the violation when the fenced session's call reaches the daemon (I4).
      // I2: the fence is this session's, so the refusal names it and the reason it ended for.
      if (!outcome.includes(sessionUuid) || !outcome.includes(session.endedAs)) {
        this.violations.push(
          `the call naming fenced session ${sessionUuid} (${session.endedAs}) was answered: ${outcome}`,
        );
      }
      return;
    }
    if (read) {
      if (outcome !== "answered") {
        this.violations.push(`a read naming usable session ${sessionUuid} was refused: ${outcome}`);
      }
      // Whether the proxy bound a session it was not holding is left open; it holds nothing new.
      // An answered call naming a session it owns lifts the fence, as a control call does.
      this.latestCertain &&= this.latest === sessionUuid;
      this.fenced = undefined;
      return;
    }
    if (outcome === "answered") {
      this.bound(sessionUuid);
    } else if (outcome.startsWith("Element not found")) {
      // Admitted and rejected: the session is live again, and whether the proxy re-bound it
      // depends on what it held, so the latest binding is no longer certain.
      this.latestCertain &&= this.latest === sessionUuid;
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
      // Recovery may replace a connection that is open but silent, once, within the lease.
      this.recoveringUntil = this.timer.now() + 2 * LEASE_MS;
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
    const startedAt = this.timer.now();
    const gone = [...this.sessions]
      .filter(([, session]) => session.daemon === "recoverable" || session.daemon === "unknown")
      .map(([id, session]) => ({ id, session, heartbeats: session.heartbeats }));
    // Sessions the proxy was answered not-found for, inside their window: it still waits for them.
    const awaited = gone.filter(
      ({ session }) =>
        !session.windowSpent && this.insideWindow(session, startedAt) && !session.told,
    );
    // Sessions it stopped asking: nothing reaches them until a call does.
    const stopped = gone.filter(
      ({ session }) => session.told && session.maybeRehydratingSince === undefined,
    );
    const resetsBefore = this.ownResets;
    await this.timer.advanceTimeAsync(INTERVAL_MS);
    for (const { id, session, heartbeats } of awaited) {
      const sent = session.heartbeats - heartbeats;
      if ((session.daemon === "recoverable" || session.daemon === "unknown") && sent !== 1) {
        this.violations.push(
          `awaited not-found session ${id} got ${sent} heartbeats on a keeper tick, not 1`,
        );
      }
    }
    for (const { id, session, heartbeats } of stopped) {
      if (session.heartbeats !== heartbeats) {
        this.violations.push(`stopped session ${id} was heartbeated with no call reaching it`);
      }
    }
    // I1: the proxy closes a working connection on a tick only to ask a not-found again that was
    // outside any window (or, for a while after a gap, to replace a silent connection).
    if (
      this.ownResets > resetsBefore &&
      this.askAgain === undefined &&
      startedAt >= this.recoveringUntil
    ) {
      this.violations.push("the connection was reset on a tick with no not-found to ask again");
    }
    for (const [sessionUuid, heartbeats] of before) {
      if (this.sessions.get(sessionUuid)!.heartbeats === heartbeats) {
        this.violations.push(`held session ${sessionUuid} was not heartbeated on a keeper tick`);
      }
    }
    const untold = [...this.sessions.values()].some((session) => !session.told);
    // In doubt whether the proxy waits for a session: the keeper may run until that window ends.
    const maybeAwaited = [...this.sessions.values()].some(
      (session) =>
        session.maybeRehydratingSince !== undefined &&
        this.timer.now() - session.maybeRehydratingSince <=
          RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS + INTERVAL_MS,
    );
    const keeperScheduled = this.timer.getPendingIntervalCount() > 0;
    if (this.mustBeat.size > 0 && !keeperScheduled) {
      this.violations.push("the keeper is stopped although a session must be heartbeated");
    }
    if (!untold && keeperScheduled && !maybeAwaited) {
      this.violations.push("the keeper still runs although every session is known to be gone");
    }
  }

  /** I5: closing leaves no timer behind, and nothing is heartbeated afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    await this.proxy.close();
    if (this.timer.getPendingIntervalCount() > 0) {
      this.violations.push("a keeper interval is still scheduled after close");
    }
    const sent = () => [...this.sessions.values()].map((session) => session.heartbeats);
    const before = sent();
    await this.timer.advanceTimeAsync(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS);
    if (sent().some((count, index) => count !== before[index])) {
      this.violations.push("a session was heartbeated after close");
    }
  }

  async apply(step: Command): Promise<void> {
    this.commandsApplied += 1;
    this.askAgain = undefined;
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
        this.release(sessionUuid, step.gone, step.notify, step.reason);
      } else {
        await this.call(sessionUuid, step.rejected, step.read === true);
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
  } finally {
    await world.close();
  }
  return world.violations;
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
    "a heartbeat is answered not-found with plan-auto-release and no notification arrived",
    [
      ACQUIRE,
      TICK,
      { kind: "release", target: 0, gone: "terminal", notify: false, reason: "plan-auto-release" },
      TICK,
      { kind: "call", target: 0, rejected: false },
      TICK,
    ],
  ],
  [
    "a heartbeat is answered not-found with a reason this build does not know",
    [
      ACQUIRE,
      ACQUIRE,
      {
        kind: "release",
        target: 1,
        gone: "terminal",
        notify: false,
        reason: "reason-from-a-newer-daemon",
      },
      TICK,
      { kind: "call", target: 1, rejected: true },
      TICK,
    ],
  ],
  [
    "#11461.2 a recoverable not-found is heartbeated once a tick until its recovery window passes",
    [
      ACQUIRE,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      ...Array.from(
        { length: RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 3 },
        () => TICK,
      ),
    ],
  ],
  [
    "#11529 a restarted daemon that has not rehydrated the session is heartbeated once a tick until the window passes",
    [
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: 0 },
      ...Array.from(
        { length: RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 3 },
        () => TICK,
      ),
    ],
  ],
  [
    "#11557.2 a restarted daemon that has rehydrated none of the held sessions is heartbeated for each until the window passes",
    [
      ACQUIRE,
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: 0 },
      ...Array.from(
        { length: RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 3 },
        () => TICK,
      ),
    ],
  ],
  [
    "#11557.2 a held session ends for good while its siblings are waited for after a restart",
    [
      ACQUIRE,
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: 0 },
      TICK,
      { kind: "release", target: 0, gone: "terminal", notify: false },
      TICK,
      { kind: "release", target: 2, gone: "terminal", notify: true },
      TICK,
      TICK,
      { kind: "call", target: 1, rejected: false },
      TICK,
    ],
  ],
  [
    "#11570.1 liveness recovery reaches a restarted daemon that has rehydrated none of the held sessions",
    [
      ACQUIRE,
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: LEASE_MS },
      ...Array.from(
        { length: RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 3 },
        () => TICK,
      ),
    ],
  ],
  [
    "#11570.2 a read inside the window neither drops it nor starts it over",
    [
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: 0 },
      TICK,
      TICK,
      { kind: "call", target: 1, rejected: false, read: true },
      TICK,
      { kind: "call", target: 0, rejected: false, read: true },
      ...Array.from(
        { length: RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 3 },
        () => TICK,
      ),
    ],
  ],
  [
    "#11570.2 a call the tool rejected leaves the window to the next heartbeat",
    [
      ACQUIRE,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      TICK,
      TICK,
      { kind: "call", target: 0, rejected: true },
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      TICK,
      TICK,
    ],
  ],
  [
    "#11570.2 a handoff after a spent window opens a new one once a call reached the session",
    [
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: 0 },
      ...Array.from(
        { length: RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 3 },
        () => TICK,
      ),
      { kind: "call", target: 0, rejected: false, read: true },
      TICK,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      { kind: "call", target: 0, rejected: false, read: true },
      TICK,
      TICK,
      TICK,
    ],
  ],
  [
    "#11570.6 a held session dropped for a reason-less not-found is heartbeated again once a call uses it",
    [
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "release", target: 0, gone: "unknown", notify: false },
      TICK,
      TICK,
      { kind: "call", target: 0, rejected: false },
      TICK,
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

  // The property's generated cases are recorded once with the same arbitrary and RUN_OPTIONS
  // (generation does not depend on the verdict, so the sequence is exactly what `fc.assert` would
  // run), then replayed in shards so each `test()` stays inside the unit-test time budget.
  const SHARDS = 10;
  const generated: Command[][] = [];
  beforeAll(() => {
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 8 }), (history) => {
        generated.push(history);
      }),
      { ...RUN_OPTIONS, examples: REGRESSIONS.map(([, history]) => [[...history]]) },
    );
  });

  test.each(Array.from({ length: SHARDS }, (_, shard) => shard))(
    "held sessions are heartbeated, dead ones never are, and the keeper runs exactly while needed (shard %d)",
    async (shard) => {
      const size = Math.ceil(generated.length / SHARDS);
      for (const history of generated.slice(shard * size, (shard + 1) * size)) {
        const violations = await violationsOf(history);
        if (violations.length > 0) {
          throw new Error(`${violations.join("; ")} for ${JSON.stringify(history)}`);
        }
      }
    },
  );

  test("the shards replay every generated case", () => {
    // `fc.assert` counts the explicit `examples` inside `numRuns`.
    expect(generated).toHaveLength(RUN_OPTIONS.numRuns);
  });
});
