import { beforeAll, describe, expect, test } from "bun:test";
import { DaemonShuttingDownError } from "../../src/daemon/DaemonShuttingDownError";
import fc from "fast-check";
import { DaemonUnavailableError, type DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_SHUTDOWN_TIMEOUT_MS, DAEMON_VERSION } from "../../src/daemon/wire/constants";
import {
  DaemonMcpProxy,
  DaemonConnectionSessionReleasedError,
  DaemonToolOutcomeUnknownError,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { ROUTED_SESSION_META_KEY } from "../../src/daemon/routedSessionMeta";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
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
//   window        when its latest not-found window opened; open for
//                 RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS, then expired.
//   handoffs      the handoffs it has had a window for since the daemon last acknowledged it. A
//                 window belongs to a HANDOFF, never to a connection. A handoff is identified by
//                 the recoverable release reason the daemon names, or, for an answer with no
//                 reason that is the session's first on a just-established connection, by the one
//                 identity "unrehydrated", also when an answer reports a different daemon
//                 instance. Distinct instances never create distinct handoff identities.
//   answeredBy    the last reported daemon instance for THIS session, ack or not-found.
//                 Missing and same-instance reports leave connection inference unchanged.
//                 Stopped/dropped sessions retain this and their handoffs until ack, admitted
//                 use, termination or close.
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
// | heartbeat answered not-found, recoverable     | a handoff it has had no window for: its one window  |
// |   reason or none                              |   opens now, AWAITED (the latest binding first asks |
// |                                               |   a recoverable reason again on a fresh connection  |
// |                                               |   when it is outside any window)                    |
// |                                               | otherwise, a window open: AWAITED (one heartbeat a  |
// |                                               |   tick, each claiming, no connection reset)         |
// |                                               | otherwise: STOPPED; the latest binding is first     |
// |                                               |   asked once more on a fresh connection if it never |
// |                                               |   had a window                                      |
// | tool call the daemon admits under the session | restored: window and handoffs cleared, heartbeating |
// |   and uses (it echoes the session)            |   again, whether it is the latest binding or held   |
// | tool call that restores nothing (a read, a    | window and handoffs are left as they are: neither   |
// |   refusal)                                    |   dropped nor reopened; a STOPPED latest binding is |
// |                                               |   asked once                                        |
// | the daemon pauses, then answers in order      | nothing: a late answer, and the answer liveness     |
// |                                               |   recovery gets on a connection it replaced, are    |
// |                                               |   answers of the handoff the session already had    |
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
//   I6  a session the daemon does not acknowledge is heartbeated for at most one window per
//       distinct handoff it was actually told of, however the daemon pauses, however often the
//       connection is replaced and however many calls that restore nothing reach it.
//
// DRAINING (the second property below, DrainWorld): the daemon the proxy is connected to shuts
// down with calls in flight. The connection is DRAINING from the first shutdown signal any request
// hears (a heartbeat refused `daemon_shutting_down`, or the `daemon-shutdown` release
// notification) until the daemon closes it.
//
// | event, while draining                         | effect                                              |
// | --------------------------------------------- | --------------------------------------------------- |
// | a call in flight is answered (its result, or  | its caller gets exactly that answer; a typed        |
// |   the daemon's typed `daemon_shutting_down`)  |   `daemon_shutting_down` is not sent again          |
// | the daemon closes the connection              | calls still unanswered: outcome unknown, not sent   |
// |                                               |   again; the proxy connects to what listens next    |
// | a new call                                    | waits for the next connection, runs once, there     |
// | a keeper tick                                 | nothing is sent on the draining connection          |
// | the last call in flight is answered           | the proxy may replace the connection itself         |
// | the daemon never closes                       | the proxy replaces the connection itself after      |
// |                                               |   DAEMON_SHUTDOWN_TIMEOUT_MS, not before            |
//
//   I7  no call that was in flight when a shutdown refusal or handoff arrived is failed by the
//       proxy's own action: each gets the daemon's answer or the daemon's close (or, from a daemon
//       that never closes, the bounded give-up). No call is sent twice, nothing new is sent on
//       the draining connection, a call started while draining runs once on the next connection,
//       and the held sessions are heartbeated there within a lease of the daemon's close, whether
//       that connection reaches a successor or the same daemon (a restart that was called off).
//
// A CALL IN FLIGHT ON A SIBLING (the third property below, #11656): the proxy holds several
// sessions on its one connection and a control call on one of them is admitted by the daemon and
// not answered yet, while the events of the first table happen to the OTHER sessions.
//
// | event, while a sibling's call is in flight    | effect                                              |
// | --------------------------------------------- | --------------------------------------------------- |
// | heartbeat answered not-found that would be    | asked again on the SAME connection: the answer is   |
// |   asked again on a fresh connection           |   decided as the second ask's, with no reset        |
// | recoverable handoff announced for the latest  | reclaimed on the same connection: no reset          |
// |   binding                                     |                                                     |
// | anything else in the first table              | as there: it is about that session only             |
//
//   I8  nothing that happens to one session closes the connection under a call in flight on
//       another: the call is sent once, gets the daemon's own answer, and every session the proxy
//       must heartbeat is still heartbeated on every tick meanwhile (I3).
//   I9  a sessionless control call never reaches a session other than the proxy's binding. While
//       that binding is terminally released and no acquisition has bound a new one, the call is
//       refused with that release and nothing reaches the daemon, whatever named calls were in
//       flight at the release or were answered since.
//   I10 a control call under the fence reaches a session only if it names that session or that
//       session's device. A platform alone, an ended device or an unknown device reports the
//       release and reaches no daemon; a held device reaches exactly its surviving session.
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

type ControlSelector = "platform" | "binding-device" | "held-device" | "ended-device" | "unknown";

type Command =
  | { kind: "acquire"; birth: Birth }
  | { kind: "release"; target: number; gone: Gone; notify: boolean; reason?: string }
  /**
   * A control call (the daemon admits it under the session, uses it and echoes it) that the tool
   * then answers or rejects, or with `read` a call that is answered without restoring anything.
   */
  | { kind: "call"; target: number; rejected: boolean; read?: boolean }
  | { kind: "sessionless" }
  | { kind: "selector-control"; selector: ControlSelector }
  /** The daemon is replaced; nothing listens for `gapMs` in between. */
  | { kind: "daemon-restart"; gapMs: number }
  | { kind: "tick" }
  /** `count` keeper ticks: long enough for a window to run out. */
  | { kind: "ticks"; count: number }
  /** The daemon answers no heartbeat for `pauseMs`, then every one it was asked, in order. */
  | { kind: "pause"; pauseMs: number };

const WINDOW_TICKS = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS;

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
  { weight: 2, arbitrary: fc.constant<Command>({ kind: "sessionless" }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("selector-control" as const),
      selector: fc.constantFrom<ControlSelector>(
        "platform",
        "binding-device",
        "held-device",
        "ended-device",
        "unknown",
      ),
    }),
  },
  // Around the tick on which a window opened by the first commands runs out.
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("ticks" as const),
      count: fc.integer({ min: WINDOW_TICKS - 5, max: WINDOW_TICKS + 2 }),
    }),
  },
  // Longer than a heartbeat request is given (3 s), up to past the lease twice over (9 s).
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("pause" as const),
      pauseMs: fc.integer({ min: 12, max: 36 }).map((quarters) => quarters * 250),
    }),
  },
);

interface SessionModel {
  deviceId: string;
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
  lastClaim?: boolean;
  /**
   * When the session's not-found window opened: with a recoverable reason (#11461), or with any
   * answer that does not end it on a connection the proxy had just made while holding it
   * (#11529). Kept past its end, until an acknowledgement or a call the daemon admits under the
   * session: no later answer opens another on the same connection.
   */
  windowSince?: number;
  /** The handoffs it has had a window for since the daemon last acknowledged it. */
  handoffs: Set<string>;
  answeredBy?: string;
  /** I6: not-found answers that did not end it since the daemon last acknowledged it ... */
  unacknowledged: number;
  /** ... the handoffs the daemon actually told the proxy of in them ... */
  toldHandoffs: Set<string>;
  /** ... and the heartbeats other events account for: a call reaching it, a replaced connection. */
  excused: number;
  /**
   * The same answer, when the history leaves it in doubt whether the proxy held the session when
   * it connected: the proxy may or may not be heartbeating it for the window that started then.
   */
  maybeRehydratingSince?: number;
}

/** What marks the one call a history keeps in flight (I8). */
const IN_FLIGHT_TEXT = "Upload";
/** What marks a control call that names no session (I9). */
const SESSIONLESS_TEXT = "Sessionless";

interface InFlightCall {
  sessionUuid: string;
  /** Resolved when the daemon answers it. */
  answer: PromiseWithResolvers<void>;
  /** The connection the daemon admitted it on. */
  client?: FakeDaemonClient;
  /** How often it reached the daemon. */
  sent: number;
  /** What its caller was answered, once it was. */
  outcome?: string;
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
  /** Until when the daemon answers no heartbeat. */
  private pausedUntil = 0;
  /** Heartbeats the proxy sent, answered yet or not. */
  private heartbeatsAsked = 0;
  /**
   * The daemon paused: heartbeats were given up on, liveness recovery ran and may have handed
   * sessions over. From then on the model no longer knows tick by tick what the proxy holds, so
   * only what holds whatever it holds is asserted: I4, I5 and I6.
   */
  private disturbed = false;
  rejectNextCall = false;
  /** I8: the control call the daemon admitted and has not answered yet. */
  private inFlight: InFlightCall | undefined;
  /** I9: every target the proxy forwards a sessionless control call to, including no target. */
  private readonly sessionlessTargets: Array<string | undefined> = [];
  private nextBirth: Birth = "lives";
  private reachable = true;
  private commandsApplied = 0;
  private nextSession = 0;
  private daemonInstance = 1;
  private successorOnReset = false;
  private nextBinding: string | undefined;
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

  lateHeldAcknowledgement(sessionUuid: string): void {
    // The fake answers one keeper request at a time; use the acknowledgement seams to model an
    // abandoned request answering after a later not-found request dropped the held session.
    this.proxy.getInternalsForTesting().noteDaemonIdleEvidence(sessionUuid, {
      daemonInstance: `daemon-${this.daemonInstance}`,
    });
    this.proxy.getInternalsForTesting().recordHeldSessionHeartbeatSuccess(sessionUuid, true);
    this.acknowledged(this.sessions.get(sessionUuid)!);
  }

  private newClient(): FakeDaemonClient {
    const instance = `daemon-${this.daemonInstance}`;
    const created = new FakeDaemonClient({
      onCallDaemonMethod: (method, params) => {
        if (method !== "daemon/heartbeat" || typeof params.sessionId !== "string") {
          return undefined;
        }
        const sessionUuid = params.sessionId;
        const askedDuring = this.commandsApplied;
        this.heartbeatsAsked += 1;
        if (this.timer.now() >= this.pausedUntil) {
          return this.answerHeartbeat(sessionUuid, askedDuring, params, instance);
        }
        return this.timer
          .sleep(this.pausedUntil - this.timer.now())
          .then(() => this.answerHeartbeat(sessionUuid, askedDuring, params, instance));
      },
      onCallTool: (name, params) => {
        if (params.text === SESSIONLESS_TEXT) {
          this.sessionlessTargets.push(
            typeof params.sessionUuid === "string" ? params.sessionUuid : undefined,
          );
        }
        if (typeof params.sessionUuid !== "string") {
          return undefined;
        }
        this.answerCall(name, params.sessionUuid);
        const inFlight = this.inFlight;
        if (inFlight === undefined || params.text !== IN_FLIGHT_TEXT) {
          return undefined;
        }
        inFlight.sent += 1;
        inFlight.client = created;
        return inFlight.answer.promise;
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
        if (this.inFlight?.client === created && this.inFlight.outcome === undefined) {
          // I8, whatever the model knows about what the proxy holds.
          this.violations.push(
            `the connection was closed under the call in flight on ${this.inFlight.sessionUuid}`,
          );
        }
        this.ownResets += this.handoffAnnounced ? 0 : 1;
        this.handoffAnnounced = false;
        this.ownReset = this.askAgain ?? "other";
        if (this.successorOnReset) {
          this.successorOnReset = false;
          this.daemonInstance += 1;
          this.client = this.newClient();
          for (const session of this.sessions.values()) {
            if (session.daemon === "live") {
              session.daemon = "unknown";
            }
          }
          this.mustBeat.clear();
        }
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
    if (this.nextBinding !== undefined) {
      const sessionUuid = this.nextBinding;
      this.nextBinding = undefined;
      return {
        content: [
          { type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) },
        ],
      };
    }
    const sessionUuid = `session-${this.nextSession}`;
    this.nextSession += 1;
    this.sessions.set(sessionUuid, {
      deviceId: `device-${sessionUuid}`,
      daemon: this.nextBirth === "reaped" ? "terminal" : "live",
      told: false,
      deadSince: -1,
      endedAs: TERMINAL_REASON,
      heartbeats: 0,
      handoffs: new Set(),
      unacknowledged: 0,
      toldHandoffs: new Set(),
      excused: 0,
    });
    // The proxy binds what an acquisition mints, before the session's first heartbeat.
    this.latest = sessionUuid;
    this.latestCertain = true;
    this.fenced = undefined;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runtime: {
              deviceId: this.sessions.get(sessionUuid)!.deviceId,
              session: { sessionUuid },
            },
          }),
        },
      ],
    };
  }

  private answerHeartbeat(
    sessionUuid: string,
    askedDuring: number,
    params: Record<string, unknown>,
    instance: string,
  ): unknown {
    const session = this.sessions.get(sessionUuid);
    if (!session) {
      this.violations.push(`heartbeat for ${sessionUuid}, which the daemon never minted`);
      return;
    }
    session.heartbeats += 1;
    const report = params.reportDaemonInstance === true ? { daemonInstance: instance } : {};
    const otherDaemon =
      report.daemonInstance !== undefined &&
      session.answeredBy !== undefined &&
      session.answeredBy !== instance;
    if (report.daemonInstance !== undefined) {
      session.answeredBy = instance;
    }
    session.lastClaim = params.claimLivenessOwnership === true;
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
      this.acknowledged(session);
      return report;
    }
    if (session.daemon === "terminal") {
      // I4. A heartbeat asked before the proxy learned of it may be answered later.
      if (session.deadSince !== -1 && askedDuring > session.deadSince) {
        this.violations.push(`heartbeat for ${sessionUuid} after the proxy learned it is dead`);
      }
      this.learnDead(sessionUuid);
    }
    if (session.daemon !== "terminal") {
      this.countUnacknowledged(sessionUuid, session, first);
      session.told = !this.awaitedAfterNotFound(
        sessionUuid,
        session,
        reestablishes || otherDaemon,
        first,
      );
      if (session.told) {
        this.held.delete(sessionUuid);
      }
    }
    throw Object.assign(new Error(`Session not found: ${sessionUuid}`), {
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      ...report,
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
    const open = this.insideWindow(session, now);
    const handoff = recoverable ? RECOVERABLE_REASON : establishes ? "unrehydrated" : undefined;
    if (handoff !== undefined && !session.handoffs.has(handoff)) {
      if (recoverable && !open && !establishes) {
        // The latest binding asks a connection that had answered again; either way the window
        // opens with the answer it then acts on, within this command.
        this.askAgain ??= "successor";
      }
      session.handoffs.add(handoff);
      session.windowSince = now;
      return true;
    }
    if (open) {
      return true;
    }
    if (session.windowSince === undefined) {
      // Never had a window, on a connection that had answered: the latest binding asks once more.
      this.askAgain ??= this.latestCertain && this.latest === sessionUuid ? "same-daemon" : "doubt";
      if (first && this.reestablishes) {
        session.maybeRehydratingSince ??= now;
      }
    }
    return false;
  }

  /** The daemon knows the session: its window, its handoffs and I6's count start over. */
  private acknowledged(session: SessionModel): void {
    session.windowSince = undefined;
    session.handoffs.clear();
    session.unacknowledged = 0;
    session.toldHandoffs.clear();
    session.excused = 0;
  }

  /**
   * I6: count a not-found answer that does not end the session against one window for each
   * handoff the daemon actually told the proxy of. A reason-less answer can only be the
   * "unrehydrated" handoff, and only as a first answer on a connection.
   */
  private countUnacknowledged(sessionUuid: string, session: SessionModel, first: boolean): void {
    session.unacknowledged += 1;
    if (session.daemon === "recoverable") {
      session.toldHandoffs.add(RECOVERABLE_REASON);
    } else if (first) {
      session.toldHandoffs.add("unrehydrated");
    }
    // A window's ticks, the answer that finds it expired, and the one asked again at its start.
    const allowed = session.toldHandoffs.size * (WINDOW_TICKS + 2) + 2 + session.excused;
    if (session.unacknowledged > allowed) {
      this.violations.push(
        `session ${sessionUuid} was heartbeated ${session.unacknowledged} times unacknowledged, ` +
          `more than a window for each of its ${session.toldHandoffs.size} handoff(s) allows (${allowed})`,
      );
    }
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
    // Whatever the call was, the proxy may ask a session it had stopped asking once more
    // (and at once, besides the keeper's tick).
    session.told = false;
    session.excused += 2;
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
    this.acknowledged(session);
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
    this.holds(sessionUuid);
  }

  /** An answered control call keeps its session live and held, wherever the binding stays. */
  private holds(sessionUuid: string): void {
    this.mustBeat.add(sessionUuid);
    this.held.add(sessionUuid);
    this.reholdPreviousBinding();
  }

  /** A replaced binding is held again: a session the proxy was told about may be asked once more. */
  private reholdPreviousBinding(): void {
    for (const session of this.sessions.values()) {
      if (session.daemon !== "terminal") {
        session.told = false;
        session.excused += 2;
      }
    }
  }

  /** A violation of what holds only while the model knows what the proxy holds. */
  private expected(violation: string): void {
    if (!this.disturbed) {
      this.violations.push(violation);
    }
  }

  async acquire(birth: Birth): Promise<void> {
    this.nextBirth = birth;
    // Whether an acquisition whose session died at birth is answered or refused is not checked:
    // the daemon's answers already told the model what became of the session.
    const outcome = await this.whileTimePasses(this.proxy.callTool("getAndroid", {}));
    if (outcome === "never answered") {
      this.expected("an acquisition was never answered");
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
        this.expected(
          `the call naming fenced session ${sessionUuid} (${session.endedAs}) was answered: ${outcome}`,
        );
      }
      return;
    }
    if (read) {
      if (outcome !== "answered") {
        this.expected(`a read naming usable session ${sessionUuid} was refused: ${outcome}`);
      }
      // A read holds nothing new and leaves a binding or a terminal release where it is.
      // With neither, whether the proxy adopts the named session is left open.
      if (this.latest === undefined && this.fenced === undefined) {
        this.latestCertain &&= this.latest === sessionUuid;
      }
      return;
    }
    if (outcome === "answered") {
      this.holds(sessionUuid);
      // A named call adopts only when there is neither a binding nor a terminal release.
      if (this.latestCertain && this.latest === undefined && this.fenced === undefined) {
        this.latest = sessionUuid;
      }
    } else if (outcome.startsWith("Element not found")) {
      // Admitted and rejected: the session is live again, and whether the proxy re-bound it
      // depends on what it held, so the latest binding is no longer certain.
      this.latestCertain &&= this.latest === sessionUuid;
      this.latest = this.latest === sessionUuid ? sessionUuid : undefined;
    } else {
      this.expected(`a call naming usable session ${sessionUuid} was refused: ${outcome}`);
    }
  }

  /** I9: a sessionless control call uses only the known live binding, or reports its release. */
  async sessionless(): Promise<void> {
    const fenced = this.fenced;
    const latest = this.latest;
    if (
      fenced === undefined &&
      (!this.latestCertain || latest === undefined || this.sessions.get(latest)?.daemon !== "live")
    ) {
      // The binding is in doubt, or gone without the proxy knowing: the model cannot judge it.
      return;
    }
    const sentBefore = this.sessionlessTargets.length;
    const outcome = await this.whileTimePasses(
      this.proxy.callTool("tapOn", { text: SESSIONLESS_TEXT }),
    );
    const sent = this.sessionlessTargets.slice(sentBefore);
    if (fenced !== undefined) {
      const reason = this.sessions.get(fenced)!.endedAs;
      if (sent.length > 0 || outcome === "answered") {
        this.expected(
          `I9: a sessionless control call after ${fenced}'s release reached the daemon ` +
            `(${JSON.stringify(sent)}) or was answered: ${outcome}`,
        );
      }
      if (!outcome.includes(reason)) {
        this.expected(
          `I9: a sessionless control call after ${fenced}'s release (${reason}) lost its reason: ${outcome}`,
        );
      }
    } else if (sent.some((sessionUuid) => sessionUuid !== latest)) {
      this.expected(
        `I9: a sessionless control call with binding ${latest} reached ${JSON.stringify(sent)}`,
      );
    }
  }

  /** I10: selectors cannot let the daemon choose a control target after the binding ends. */
  async selectorControl(selector: ControlSelector): Promise<void> {
    const fenced = this.fenced;
    if (fenced === undefined) {
      return;
    }
    const survivor = [...this.held].find((id) => id !== fenced);
    const ended = [...this.sessions].find(([, session]) => session.daemon === "terminal")?.[0];
    const selected =
      selector === "binding-device"
        ? fenced
        : selector === "held-device"
          ? survivor
          : selector === "ended-device"
            ? ended
            : undefined;
    const deviceId =
      selected === undefined ? "unknown-device" : this.sessions.get(selected)!.deviceId;
    const args = selector === "platform" ? { platform: "android" } : { deviceId };
    const expected =
      selector !== "platform" &&
      selected !== undefined &&
      selected !== fenced &&
      this.held.has(selected)
        ? selected
        : undefined;
    const before = this.sessionlessTargets.length;
    let refusal: unknown;
    const outcome = await this.whileTimePasses(
      this.proxy.callTool("tapOn", { text: SESSIONLESS_TEXT, ...args }).then(
        (result) => result,
        (error: unknown) => {
          refusal = error;
          throw error;
        },
      ),
    );
    const sent = this.sessionlessTargets.slice(before);
    if (expected !== undefined) {
      if (outcome !== "answered" || sent.length !== 1 || sent[0] !== expected) {
        this.violations.push(
          `I10: ${JSON.stringify(args)} must reach exactly ${expected}, got ${JSON.stringify(sent)}: ${outcome}`,
        );
      } else {
        this.holds(expected);
      }
    } else {
      const reason = this.sessions.get(fenced)!.endedAs;
      if (
        sent.length !== 0 ||
        !(refusal instanceof DaemonConnectionSessionReleasedError) ||
        !outcome.includes(reason)
      ) {
        this.violations.push(
          `I10: ${JSON.stringify(args)} must report ${fenced}'s release (${reason}), got ${JSON.stringify(sent)}: ${outcome}`,
        );
      }
    }
    if (this.fenced !== fenced || this.latest !== undefined) {
      this.violations.push("I10: a selector control moved the binding or cleared the fence");
    }
  }

  /** A control call on `sessionUuid` that the daemon admits and does not answer yet. */
  async startCallInFlight(sessionUuid: string): Promise<void> {
    const inFlight: InFlightCall = { sessionUuid, answer: Promise.withResolvers<void>(), sent: 0 };
    this.inFlight = inFlight;
    void this.proxy.callTool("tapOn", { sessionUuid, text: IN_FLIGHT_TEXT }).then(
      () => {
        inFlight.outcome = "answered";
      },
      (error: unknown) => {
        inFlight.outcome =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      },
    );
    await this.settle();
  }

  /** The daemon answers the call in flight. I8: its caller gets that answer, for a call sent once. */
  async finishCallInFlight(): Promise<void> {
    const inFlight = this.inFlight;
    if (inFlight === undefined) {
      return;
    }
    const cutShort = inFlight.outcome;
    inFlight.answer.resolve();
    await this.settle();
    this.inFlight = undefined;
    if (cutShort !== undefined) {
      this.violations.push(
        `the call in flight on ${inFlight.sessionUuid} was answered before the daemon answered it: ${cutShort}`,
      );
    } else if (inFlight.outcome !== "answered" || inFlight.sent !== 1) {
      this.violations.push(
        `the call in flight on ${inFlight.sessionUuid} was sent ${inFlight.sent} time(s) and answered: ${inFlight.outcome}`,
      );
    }
    // The answered named call never moves a binding or lifts a terminal release. With neither
    // at completion it may adopt the named session, so only that case leaves the binding in doubt.
    if (this.latest === undefined && this.fenced === undefined) {
      this.latestCertain = false;
    }
  }

  /** The session a command aimed at `index` is about, never the one with the call in flight. */
  siblingAt(index: number): string | undefined {
    const siblings = [...this.sessions.keys()].filter((id) => id !== this.inFlight?.sessionUuid);
    return siblings.length === 0 ? undefined : siblings[index % siblings.length];
  }

  /** Gap 4: A answered before; B replaces it only when the proxy re-asks. */
  succeedOnReask(): void {
    this.successorOnReset = true;
  }

  /** A binding result names an existing session, without an admitted call or an ack. */
  async rebind(sessionUuid: string): Promise<void> {
    this.nextBinding = sessionUuid;
    await this.whileTimePasses(this.proxy.callTool("getAndroid", {}));
    this.latest = sessionUuid;
    this.latestCertain = true;
    this.fenced = undefined;
    this.held.add(sessionUuid);
    this.reholdPreviousBinding();
  }

  async restartDaemon(gapMs: number): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.daemon === "live") {
        // Persisted, not materialised: the replacement daemon answers a plain not-found.
        session.daemon = "unknown";
      }
    }
    this.mustBeat.clear();
    for (const session of this.sessions.values()) {
      // Recovery's attempts and the heartbeat cut by the lost connection.
      session.excused += 3;
    }
    const previous = this.client;
    this.daemonInstance += 1;
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
    /** What must hold on this tick while the model knows what the proxy holds. */
    const expected: string[] = [];
    const before = new Map([...this.mustBeat].map((id) => [id, this.sessions.get(id)!.heartbeats]));
    const startedAt = this.timer.now();
    const gone = [...this.sessions]
      .filter(([, session]) => session.daemon === "recoverable" || session.daemon === "unknown")
      .map(([id, session]) => ({ id, session, heartbeats: session.heartbeats }));
    // Sessions the proxy was answered not-found for, inside their window: it still waits for them.
    const awaited = gone.filter(
      ({ session }) => this.insideWindow(session, startedAt) && !session.told,
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
        expected.push(
          `awaited not-found session ${id} got ${sent} heartbeats on a keeper tick, not 1`,
        );
      }
    }
    for (const { id, session, heartbeats } of stopped) {
      if (session.heartbeats !== heartbeats) {
        expected.push(`stopped session ${id} was heartbeated with no call reaching it`);
      }
    }
    // I1: the proxy closes a working connection on a tick only to ask a not-found again that was
    // outside any window (or, for a while after a gap, to replace a silent connection).
    if (
      this.ownResets > resetsBefore &&
      this.askAgain === undefined &&
      startedAt >= this.recoveringUntil
    ) {
      expected.push("the connection was reset on a tick with no not-found to ask again");
    }
    for (const [sessionUuid, heartbeats] of before) {
      if (this.sessions.get(sessionUuid)!.heartbeats === heartbeats) {
        expected.push(`held session ${sessionUuid} was not heartbeated on a keeper tick`);
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
      expected.push("the keeper is stopped although a session must be heartbeated");
    }
    if (!untold && keeperScheduled && !maybeAwaited) {
      expected.push("the keeper still runs although every session is known to be gone");
    }
    if (!this.disturbed) {
      this.violations.push(...expected);
    }
  }

  /** The daemon stops answering heartbeats for `pauseMs`; time goes on with the next command. */
  pause(pauseMs: number): void {
    this.pausedUntil = this.timer.now() + pauseMs;
    this.disturbed = true;
    for (const session of this.sessions.values()) {
      // The heartbeat given up on, and recovery's attempts, each still answered once.
      session.excused += 4;
    }
  }

  /** I5: closing leaves no timer behind, and nothing is heartbeated afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    // A heartbeat the paused daemon has not answered yet is answered as time passes.
    await this.timer.resolvePromise(this.proxy.close(), 250);
    if (this.timer.getPendingIntervalCount() > 0) {
      this.violations.push("a keeper interval is still scheduled after close");
    }
    const asked = this.heartbeatsAsked;
    await this.timer.advanceTimeAsync(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS);
    if (this.heartbeatsAsked !== asked) {
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
    } else if (step.kind === "ticks") {
      for (let tick = 0; tick < step.count && this.violations.length === 0; tick += 1) {
        await this.tick();
      }
    } else if (step.kind === "pause") {
      this.pause(step.pauseMs);
    } else if (step.kind === "sessionless") {
      await this.sessionless();
    } else if (step.kind === "selector-control") {
      await this.selectorControl(step.selector);
    } else {
      const sessionUuid =
        this.inFlight === undefined ? this.sessionAt(step.target) : this.siblingAt(step.target);
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

const TICK_COMMAND: Command = { kind: "tick" };

/** Several sessions on one connection, a control call in flight on one of them (I8). */
interface SiblingCase {
  /** Sessions acquired first; the last one is the latest binding. */
  sessions: 2 | 3;
  /** Which of them the call is in flight on. */
  callOn: number;
  /** What happens to the others meanwhile. */
  during: Command[];
}

/** What may happen to a session while its sibling's call is in flight: the first table's events. */
const siblingCommand: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("recoverable"),
      notify: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("unknown"),
      notify: fc.constant(false),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("release" as const),
      target,
      gone: fc.constant<Gone>("terminal"),
      notify: fc.boolean(),
      reason: fc.constantFrom(...ENDING_REASONS),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("call" as const),
      target,
      rejected: fc.boolean(),
      read: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant<Command>({ kind: "acquire", birth: "lives" }) },
  { weight: 5, arbitrary: fc.constant<Command>({ kind: "tick" }) },
  { weight: 2, arbitrary: fc.constant<Command>({ kind: "sessionless" }) },
);

const siblingCase: fc.Arbitrary<SiblingCase> = fc.record({
  sessions: fc.constantFrom<2 | 3>(2, 2, 3),
  callOn: fc.nat({ max: 2 }),
  during: fc.array(siblingCommand, { minLength: 1, maxLength: 6 }),
});

async function siblingViolationsOf(sibling: SiblingCase): Promise<string[]> {
  const world = new World();
  try {
    for (let acquired = 0; acquired < sibling.sessions; acquired += 1) {
      await world.apply({ kind: "acquire", birth: "lives" });
    }
    // Every session is acknowledged on the connection before anything happens to one.
    await world.apply({ kind: "tick" });
    await world.startCallInFlight(world.sessionAt(sibling.callOn)!);
    for (const step of sibling.during) {
      await world.apply(step);
      if (world.violations.length > 0) {
        break;
      }
    }
    await world.finishCallInFlight();
    await world.apply({ kind: "sessionless" });
    if (world.violations.length === 0) {
      await world.apply({ kind: "tick" });
    }
  } finally {
    await world.close();
  }
  return world.violations;
}

const SIBLING_REGRESSIONS: ReadonlyArray<readonly [string, SiblingCase]> = [
  [
    "the latest binding's terminal release during a held session's call is still reported to the next sessionless call (#11656)",
    {
      sessions: 2,
      callOn: 0,
      during: [{ kind: "release", target: 0, gone: "terminal", notify: true }, TICK_COMMAND],
    },
  ],
  [
    "the latest binding's terminal release learned from a heartbeat during a held session's call is still reported to the next sessionless call (#11656)",
    {
      sessions: 2,
      callOn: 0,
      during: [{ kind: "release", target: 0, gone: "terminal", notify: false }, TICK_COMMAND],
    },
  ],
  [
    "the latest binding's announced device-restart handoff leaves a held session's call in flight (#11656)",
    {
      sessions: 2,
      callOn: 0,
      during: [{ kind: "release", target: 0, gone: "recoverable", notify: true }, TICK_COMMAND],
    },
  ],
  [
    "the latest binding's handoff learned from its heartbeat is asked again on the same connection (#11656)",
    {
      sessions: 2,
      callOn: 0,
      during: [
        { kind: "release", target: 0, gone: "recoverable", notify: false },
        TICK_COMMAND,
        TICK_COMMAND,
      ],
    },
  ],
  [
    "the latest binding's bare not-found is asked again on the same connection (#11656)",
    {
      sessions: 2,
      callOn: 0,
      during: [{ kind: "release", target: 0, gone: "unknown", notify: false }, TICK_COMMAND],
    },
  ],
  [
    "a held session's handoff leaves the call in flight on the latest binding (#11656)",
    {
      sessions: 3,
      callOn: 2,
      during: [
        { kind: "release", target: 0, gone: "recoverable", notify: true },
        TICK_COMMAND,
        { kind: "release", target: 1, gone: "unknown", notify: false },
        TICK_COMMAND,
      ],
    },
  ],
];

/** How the daemon answers one call that is in flight when it starts shutting down. */
type DrainAnswer = "result" | "shutting-down" | "close";

interface DrainCase {
  /** Sessions the proxy holds: the latest binding, and one held besides it. */
  held: 1 | 2;
  /** Control calls in flight on the connection when the daemon starts shutting down. */
  inFlight: number;
  /** The daemon's answer to each of them, and how long after the shutdown started. */
  answers: readonly DrainAnswer[];
  answerAfterMs: readonly number[];
  /** When the shutdown starts, relative to the keeper's cadence. */
  shutdownOffsetMs: number;
  /** The `daemon-shutdown` release notification: at the start, after the first refusal, or lost. */
  notice: "before-refusal" | "after-refusal" | "never";
  /** A control call started while the connection drains. */
  lateCall: boolean;
  /** How long after the shutdown started the daemon closes the connection; null: never. */
  closesAfterMs: number | null;
  /** What answers on the next connection: a successor daemon, or the same one (restart aborted). */
  lands: "successor" | "same-daemon";
  /**
   * The daemon answered no heartbeat for a while before it shut down, so liveness recovery is
   * asking for the sessions when the shutdown starts and hears the refusal first.
   */
  recovering: boolean;
}

/** Longer than a heartbeat request is given, shorter than the lease recovery works within. */
const SILENT_BEFORE_SHUTDOWN_MS = 2_500;

const drainCase: fc.Arbitrary<DrainCase> = fc.record({
  held: fc.constantFrom<1 | 2>(1, 2),
  inFlight: fc.integer({ min: 0, max: 3 }),
  answers: fc.array(fc.constantFrom<DrainAnswer>("result", "shutting-down", "close"), {
    minLength: 3,
    maxLength: 3,
  }),
  answerAfterMs: fc.array(
    fc.integer({ min: 1, max: 9 }).map((quarters) => quarters * 250 - 50),
    { minLength: 3, maxLength: 3 },
  ),
  shutdownOffsetMs: fc.constantFrom(0, 250, 500, 750),
  notice: fc.constantFrom<DrainCase["notice"]>("before-refusal", "after-refusal", "never"),
  lateCall: fc.boolean(),
  // The daemon's quiesce and close drains end within 2 s; one case in six never closes.
  closesAfterMs: fc.constantFrom<number | null>(300, 900, 1_500, 2_000, 2_000, null),
  lands: fc.constantFrom<DrainCase["lands"]>("successor", "same-daemon"),
  recovering: fc.constantFrom(false, false, true),
});

type CallOutcome = { result: unknown } | { error: unknown };

interface DrainingCall {
  marker: string;
  answer: DrainAnswer;
  answered: PromiseWithResolvers<void>;
  /** How it ended at the daemon's end of the wire, once it did. */
  ended?: "result" | "shutting-down" | "daemon-close" | "proxy-close";
  shuttingDown: DaemonShuttingDownError;
  outcome?: CallOutcome;
}

/** One daemon shutting down under a proxy with calls in flight, and whatever listens next. */
class DrainWorld {
  readonly timer = new FakeTimer();
  readonly violations: string[] = [];
  private readonly old: FakeDaemonClient;
  private current: FakeDaemonClient;
  private reachable = true;
  private shuttingDown = false;
  /** Heartbeats the daemon has not answered yet: it went silent before it shut down. */
  private silent: PromiseWithResolvers<void> | undefined;
  private announced = false;
  private closing = false;
  private oldClosedAt: number | undefined;
  /** When the first shutdown signal reached the proxy. */
  private drainingSince: number | undefined;
  private readonly sessions: string[] = [];
  private readonly calls: DrainingCall[] = [];
  /** Which connection each control call was sent on, by its marker. */
  private readonly sentOn = new Map<string, Array<"old" | "next">>();
  private refusedHeartbeats = 0;
  /** When each session was first heartbeated on the next connection. */
  private readonly firstBeatOnNext = new Map<string, number>();
  /** Sessions the successor has restored: a control call named them. */
  private readonly restored = new Set<string>();
  private late: { outcome?: CallOutcome } | undefined;
  readonly proxy: DaemonMcpProxy;

  constructor(private readonly drain: DrainCase) {
    this.old = this.newClient("old");
    this.current = this.old;
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    this.proxy = new DaemonMcpProxy({
      clientFactory: (): DaemonClientLike => this.current,
      daemonAvailabilityProbe: async () => this.reachable,
      daemonManager,
      autoStartDaemon: false,
      timer: this.timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  }

  private newClient(side: "old" | "next"): FakeDaemonClient {
    const created = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          if (side === "old") {
            await this.silent?.promise;
          }
          this.answerHeartbeat(side, params.sessionId);
        }
        return undefined;
      },
      onCallTool: (name, params) =>
        name === "tapOn" ? this.answerCall(side, String(params.text), params) : undefined,
      toolResultFor: (name, params) => {
        if (name === "getAndroid") {
          const sessionUuid = `session-${this.sessions.length}`;
          this.sessions.push(sessionUuid);
          return {
            content: [
              { type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) },
            ],
          };
        }
        return {
          content: [{ type: "text", text: `ran ${String(params.text)}` }],
          _meta: { [ROUTED_SESSION_META_KEY]: params.sessionUuid },
        };
      },
    });
    const close = created.close.bind(created);
    created.close = async () => {
      if (side === "old" && this.oldClosedAt === undefined && !this.closing) {
        this.proxyClosedDrainingConnection();
      }
      await close();
    };
    return created;
  }

  private answerHeartbeat(side: "old" | "next", sessionUuid: string): void {
    if (side === "next") {
      if (!this.firstBeatOnNext.has(sessionUuid)) {
        this.firstBeatOnNext.set(sessionUuid, this.timer.now());
      }
      if (this.drain.lands === "successor" && !this.restored.has(sessionUuid)) {
        // Persisted, not materialised: the successor answers a plain not-found.
        throw Object.assign(new Error(`Session not found: ${sessionUuid}`), {
          code: DAEMON_SESSION_NOT_FOUND_CODE,
        });
      }
      return;
    }
    if (!this.shuttingDown) {
      return;
    }
    this.refusedHeartbeats += 1;
    this.drainingSince ??= this.timer.now();
    if (this.drain.notice === "after-refusal") {
      this.timer.setTimeout(() => this.announce(), 50);
    }
    throw new DaemonShuttingDownError();
  }

  private answerCall(
    side: "old" | "next",
    marker: string,
    params: Record<string, unknown>,
  ): Promise<void> | undefined {
    this.sentOn.set(marker, [...(this.sentOn.get(marker) ?? []), side]);
    if (side === "next") {
      this.restored.add(String(params.sessionUuid));
      return undefined;
    }
    if (this.drainingSince !== undefined) {
      this.violations.push(`call ${marker} was sent on the draining connection`);
    }
    return this.calls.find((call) => call.marker === marker)?.answered.promise;
  }

  /** The `daemon-shutdown` release of every session reaches the proxy. */
  private announce(): void {
    if (this.announced || this.oldClosedAt !== undefined || !this.old.isConnected()) {
      return;
    }
    this.announced = true;
    this.drainingSince ??= this.timer.now();
    for (const sessionUuid of this.sessions) {
      this.old.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        sessionUuid,
        "daemon-shutdown",
      );
    }
  }

  private unanswered(): DrainingCall[] {
    return this.calls.filter((call) => call.ended === undefined);
  }

  /** I7: the proxy closes the draining connection itself only when no call is waiting on it. */
  private proxyClosedDrainingConnection(): void {
    const cut = this.unanswered();
    const waited = this.timer.now() - (this.drainingSince ?? this.timer.now());
    if (cut.length > 0 && waited < DAEMON_SHUTDOWN_TIMEOUT_MS) {
      this.violations.push(
        `the proxy closed the connection ${waited} ms into its drain, under ` +
          `${cut.map((call) => call.marker).join(", ")}`,
      );
    }
    this.oldClosedAt = this.timer.now();
    this.current = this.newClient("next");
    this.reachable = true;
    for (const call of cut) {
      call.ended = "proxy-close";
      call.answered.reject(new DaemonUnavailableError("Socket connection closed"));
    }
  }

  /** The daemon closes the connection: what is still in flight is cut, and the next one listens. */
  private daemonCloses(): void {
    if (this.oldClosedAt !== undefined) {
      return;
    }
    this.oldClosedAt = this.timer.now();
    this.current = this.newClient("next");
    this.reachable = true;
    for (const call of this.unanswered()) {
      call.ended = "daemon-close";
      call.answered.reject(new DaemonUnavailableError("Socket connection closed"));
    }
    this.old.emitConnectionClosed();
  }

  private answer(call: DrainingCall): void {
    if (call.ended !== undefined || call.answer === "close") {
      return;
    }
    call.ended = call.answer;
    if (call.answer === "result") {
      call.answered.resolve();
    } else {
      call.answered.reject(call.shuttingDown);
    }
  }

  private track(call: Promise<unknown>, into: { outcome?: CallOutcome }): void {
    void call.then(
      (result) => {
        into.outcome = { result };
      },
      (error: unknown) => {
        into.outcome = { error };
      },
    );
  }

  private async pass(ms: number): Promise<void> {
    await this.timer.advanceTimeAsync(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async run(): Promise<void> {
    const drain = this.drain;
    for (let held = 0; held < drain.held; held += 1) {
      await this.proxy.callTool("getAndroid", {});
    }
    const latest = this.sessions.at(-1)!;
    await this.pass(INTERVAL_MS + drain.shutdownOffsetMs);
    for (let index = 0; index < drain.inFlight; index += 1) {
      const call: DrainingCall = {
        marker: `step-${index}`,
        answer: drain.answers[index]!,
        answered: Promise.withResolvers<void>(),
        shuttingDown: new DaemonShuttingDownError(true),
      };
      // A call the daemon's close cuts is rejected whether or not anything still awaits it.
      call.answered.promise.catch(() => undefined);
      this.calls.push(call);
      this.track(this.proxy.callTool("tapOn", { sessionUuid: latest, text: call.marker }), call);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.sentOn.size !== drain.inFlight) {
      this.violations.push("a call was not in flight when the shutdown started");
    }
    if (drain.recovering) {
      // Recovery never replaces a silent connection beneath a call in flight, so with none it
      // may already have a new connection when the shutdown starts.
      this.silent = Promise.withResolvers<void>();
      for (let waited = 0; waited < SILENT_BEFORE_SHUTDOWN_MS; waited += 250) {
        await this.pass(250);
      }
    }
    for (const [index, call] of this.calls.entries()) {
      this.timer.setTimeout(() => this.answer(call), drain.answerAfterMs[index]!);
    }

    this.shuttingDown = true;
    this.reachable = false;
    this.silent?.resolve();
    this.silent = undefined;
    const shutdownAt = this.timer.now();
    if (drain.notice === "before-refusal") {
      this.announce();
    }
    if (drain.closesAfterMs !== null) {
      this.timer.setTimeout(() => this.daemonCloses(), drain.closesAfterMs);
    }
    // Long enough for the bounded give-up on a daemon that never closes, and the reconnect.
    const horizonMs = (drain.closesAfterMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS) + LEASE_MS + 2_000;
    while (this.timer.now() - shutdownAt < horizonMs) {
      await this.pass(250);
      if (drain.lateCall && this.late === undefined && this.drainingSince !== undefined) {
        this.late = {};
        this.track(this.proxy.callTool("tapOn", { sessionUuid: latest, text: "late" }), this.late);
      }
    }
    this.check();
  }

  private checkCall(call: DrainingCall): void {
    const sent = this.sentOn.get(call.marker) ?? [];
    if (sent.length !== 1) {
      this.violations.push(`call ${call.marker} was sent ${sent.length} times`);
    }
    const outcome = call.outcome;
    const error: unknown = Reflect.get(outcome ?? {}, "error");
    if (outcome === undefined) {
      this.violations.push(`call ${call.marker} was never answered (${call.ended})`);
    } else if (call.ended === "result" && !("result" in outcome)) {
      this.violations.push(`call ${call.marker} got ${String(error)}, not its result`);
    } else if (call.ended === "shutting-down" && error !== call.shuttingDown) {
      this.violations.push(
        `call ${call.marker} was not told the daemon's typed daemon_shutting_down answer`,
      );
    } else if (call.ended === "daemon-close" && !(error instanceof DaemonToolOutcomeUnknownError)) {
      this.violations.push(
        `call ${call.marker}, cut by the daemon's close, was not outcome-unknown`,
      );
    }
  }

  private check(): void {
    for (const call of this.calls) {
      this.checkCall(call);
    }
    if (this.drain.recovering) {
      // Recovery may have handed the sessions over while the daemon was silent: what the proxy
      // then holds, heartbeats and forwards is the first property's subject, not this one's.
      return;
    }
    const closes = this.drain.closesAfterMs !== null;
    if (this.refusedHeartbeats > this.drain.held) {
      this.violations.push(
        `the keeper sent ${this.refusedHeartbeats} heartbeats on the draining connection`,
      );
    }
    if (this.late !== undefined) {
      const sent = this.sentOn.get("late") ?? [];
      if (sent.includes("old") || sent.length > 1) {
        this.violations.push(`the call started while draining was sent on ${sent.join(", ")}`);
      }
      if (closes && (sent.length !== 1 || !("result" in (this.late.outcome ?? {})))) {
        this.violations.push(
          `the call started while draining did not run once on the next connection: ` +
            `${JSON.stringify(sent)} ${String(Reflect.get(this.late.outcome ?? {}, "error"))}`,
        );
      }
    }
    if (closes) {
      // The successor's awaiting-owner window is lease + grace: a lease is well inside it.
      for (const sessionUuid of this.sessions) {
        const beatAt = this.firstBeatOnNext.get(sessionUuid);
        if (beatAt === undefined || beatAt - this.oldClosedAt! > LEASE_MS) {
          this.violations.push(
            `held session ${sessionUuid} was first heartbeated on the next connection ` +
              `${beatAt === undefined ? "never" : `${beatAt - this.oldClosedAt!} ms after the close`}`,
          );
        }
      }
    }
  }

  /** Closing leaves no timer behind, whatever the drain was waiting for. */
  async close(): Promise<void> {
    this.closing = true;
    await this.timer.resolvePromise(this.proxy.close(), 250);
    if (this.timer.getPendingIntervalCount() > 0 || this.timer.getPendingTimeoutCount() > 0) {
      this.violations.push(
        `timers left after close: ${this.timer.getPendingIntervalCount()} interval(s), ` +
          `${this.timer.getPendingTimeoutCount()} timeout(s)`,
      );
    }
  }
}

async function drainViolationsOf(drain: DrainCase): Promise<string[]> {
  const world = new DrainWorld(drain);
  try {
    await world.run();
  } finally {
    await world.close();
  }
  return world.violations;
}

const DRAIN: DrainCase = {
  held: 1,
  inFlight: 1,
  answers: ["result", "result", "result"],
  answerAfterMs: [700, 700, 700],
  shutdownOffsetMs: 500,
  notice: "before-refusal",
  lateCall: false,
  closesAfterMs: 2_000,
  lands: "successor",
  recovering: false,
};

/** The drains the proxy got wrong, and the corners of the table above. */
const DRAIN_REGRESSIONS: ReadonlyArray<readonly [string, DrainCase]> = [
  [
    "the keeper tick after a daemon-shutdown notice does not cut a call the daemon then answers",
    DRAIN,
  ],
  [
    "a keeper heartbeat refused as shutting down does not cut a call the daemon then answers",
    { ...DRAIN, notice: "never" },
  ],
  [
    "the notice arriving after the refusal changes nothing for the calls in flight",
    { ...DRAIN, notice: "after-refusal", inFlight: 2, answerAfterMs: [700, 1_200, 700] },
  ],
  [
    "a call the daemon answers daemon_shutting_down is told so, typed, and not sent again",
    { ...DRAIN, answers: ["shutting-down", "result", "result"], inFlight: 2 },
  ],
  [
    "calls still unanswered at the daemon's close are outcome-unknown and not sent again",
    { ...DRAIN, held: 2, inFlight: 3, answers: ["close", "result", "close"] },
  ],
  [
    "a call started while draining waits and runs once on the successor",
    { ...DRAIN, lateCall: true, inFlight: 2, answers: ["result", "close", "result"] },
  ],
  [
    "a call started while draining runs once on the same daemon when the restart is called off",
    { ...DRAIN, lateCall: true, lands: "same-daemon", held: 2 },
  ],
  [
    "a daemon that never closes is given up on after the shutdown timeout, not before",
    { ...DRAIN, closesAfterMs: null, answers: ["close", "result", "result"], inFlight: 2 },
  ],
  [
    "liveness recovery hearing the refusal first does not take the connection for dead",
    {
      ...DRAIN,
      recovering: true,
      notice: "never",
      inFlight: 2,
      answerAfterMs: [1_200, 1_700, 700],
    },
  ],
  [
    "with nothing in flight the refusal replaces the connection at once",
    { ...DRAIN, inFlight: 0, notice: "never", lateCall: true },
  ],
];

const ACQUIRE: Command = { kind: "acquire", birth: "lives" };
const TICK: Command = { kind: "tick" };

/** The histories of the bugs this state machine had, one per issue item. */
const REGRESSIONS: ReadonlyArray<readonly [string, readonly Command[]]> = [
  ...(["platform", "binding-device", "held-device", "ended-device", "unknown"] as const).map(
    (selector): readonly [string, readonly Command[]] => [
      `I10: fenced ${selector} control names a held device or reports the release`,
      [
        ACQUIRE,
        ACQUIRE,
        { kind: "release", target: 1, gone: "terminal", notify: true },
        { kind: "selector-control", selector },
        { kind: "sessionless" },
        TICK,
      ],
    ],
  ),
  [
    "#11656.2 a named call after the latest binding's release does not become the binding",
    [
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "release", target: 1, gone: "terminal", notify: true },
      { kind: "call", target: 0, rejected: false },
      { kind: "sessionless" },
      TICK,
    ],
  ],
  [
    "#11656.2 a named read after the latest binding's release does not become the binding",
    [
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "release", target: 1, gone: "terminal", notify: true },
      { kind: "call", target: 0, rejected: false, read: true },
      { kind: "sessionless" },
      TICK,
    ],
  ],
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
    "#11570.2 a handoff the session was not told of before opens a window after an expired one",
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
    "#11570 I6 a pause at each expiry never earns the latest binding's handoff another window",
    [
      ACQUIRE,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      { kind: "ticks", count: WINDOW_TICKS - 2 },
      { kind: "pause", pauseMs: 5_000 },
      { kind: "ticks", count: WINDOW_TICKS },
      { kind: "pause", pauseMs: 5_000 },
      { kind: "ticks", count: WINDOW_TICKS },
      { kind: "pause", pauseMs: 5_000 },
      { kind: "ticks", count: WINDOW_TICKS },
    ],
  ],
  [
    "#11570 I6 a pause at each expiry never earns a held session's handoff another window",
    [
      ACQUIRE,
      ACQUIRE,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      { kind: "ticks", count: WINDOW_TICKS - 2 },
      { kind: "pause", pauseMs: 4_500 },
      { kind: "ticks", count: WINDOW_TICKS },
      { kind: "pause", pauseMs: 8_000 },
      { kind: "ticks", count: WINDOW_TICKS },
    ],
  ],
  [
    "#11570 I6 a pause at each expiry never earns sessions a restarted daemon has not rehydrated another window",
    [
      ACQUIRE,
      ACQUIRE,
      TICK,
      { kind: "daemon-restart", gapMs: 0 },
      { kind: "ticks", count: WINDOW_TICKS - 2 },
      { kind: "pause", pauseMs: 5_000 },
      { kind: "ticks", count: WINDOW_TICKS },
      { kind: "pause", pauseMs: 6_500 },
      { kind: "ticks", count: WINDOW_TICKS },
    ],
  ],
  [
    "#11570 I6 reads never earn the same handoff another window",
    [
      ACQUIRE,
      { kind: "release", target: 0, gone: "recoverable", notify: false },
      { kind: "ticks", count: WINDOW_TICKS + 3 },
      { kind: "call", target: 0, rejected: false, read: true },
      { kind: "ticks", count: WINDOW_TICKS },
      { kind: "call", target: 0, rejected: false, read: true },
      { kind: "ticks", count: WINDOW_TICKS },
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

describe("not-found peer and retained handoff regressions", () => {
  const cases = [
    "successor re-ask keeps latest and held claiming",
    "same daemon re-ask stops without a window",
    "dropped held session keeps its handoff",
    "ack clears a dropped held session handoff",
    "admitted call clears a dropped held session handoff",
    "late ack then admitted call restores a dropped held session",
  ] as const;
  const results = new Map<string, string[]>();
  beforeAll(async () => {
    for (const name of cases) {
      const world = new World();
      try {
        await world.acquire("lives");
        await world.acquire("lives");
        await world.tick();
        const held = world.sessionAt(0)!;
        const latest = world.sessionAt(1)!;
        if (name.includes("re-ask")) {
          if (name.startsWith("successor")) {
            world.succeedOnReask();
          }
          world.release(latest, "unknown", false);
          await world.tick();
          await world.tick();
          const expectedWindow = name.startsWith("successor");
          for (const id of expectedWindow ? [latest, held] : [latest]) {
            const session = world.sessions.get(id)!;
            if (
              (session.windowSince !== undefined) !== expectedWindow ||
              session.told === expectedWindow
            ) {
              world.violations.push(
                `${id}: expected ${expectedWindow ? "one window" : "stopped without a window"}`,
              );
            }
          }
          await world.tick();
          if (expectedWindow) {
            for (const id of [latest, held]) {
              if (!world.sessions.get(id)!.lastClaim) {
                world.violations.push(`in-window session ${id} was heartbeated without claiming`);
              }
            }
          }
        } else {
          world.release(held, "recoverable", false);
          await world.tick();
          await world.apply({ kind: "ticks", count: WINDOW_TICKS + 2 });
          if (name.startsWith("late ack")) {
            if (
              !world.proxy.getInternalsForTesting().notFoundStopped.has(held) ||
              world.proxy.getInternalsForTesting().otherHeldSessions.has(held)
            ) {
              world.violations.push("scenario did not drop the held session on stopped");
            }
            world.lateHeldAcknowledgement(held);
            await world.call(held, false);
            const beats = world.sessions.get(held)!.heartbeats;
            await world.tick();
            if (
              !world.proxy.getInternalsForTesting().otherHeldSessions.has(held) ||
              world.sessions.get(held)!.heartbeats <= beats
            ) {
              world.violations.push(
                "late acknowledgement prevented admitted-call restore and heartbeat",
              );
            }
            results.set(name, world.violations);
            continue;
          }
          await world.rebind(held);
          await world.rebind(latest);
          await world.tick();
          await world.tick();
          if (name.startsWith("ack")) {
            await world.call(held, true); // admitted, rejected: no echo; the next heartbeat acknowledges
            await world.tick();
          } else if (name.startsWith("admitted")) {
            await world.call(held, false);
          }
          if (!name.startsWith("dropped")) {
            world.release(held, "recoverable", false);
            await world.tick();
            await world.tick();
            if (world.sessions.get(held)!.told) {
              world.violations.push("cleared handoff did not earn a new window");
            }
          }
        }
      } finally {
        await world.close();
      }
      results.set(name, world.violations);
    }
  });
  test.each([...cases])("%s", (name) => {
    expect(results.get(name)).toEqual([]);
  });
});

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

describe("a call in flight on a sibling session (property-based)", () => {
  const SIBLING_RUN_OPTIONS = { seed: 11_656, numRuns: 60 } as const;
  const SHARDS = 12;
  const generated: SiblingCase[] = [];
  beforeAll(() => {
    fc.assert(
      fc.property(siblingCase, (sibling) => {
        generated.push(sibling);
      }),
      { ...SIBLING_RUN_OPTIONS, examples: SIBLING_REGRESSIONS.map(([, sibling]) => [sibling]) },
    );
  });

  test.each(SIBLING_REGRESSIONS)("%s", async (_name, sibling) => {
    expect(await siblingViolationsOf(sibling)).toEqual([]);
  });

  test.each(Array.from({ length: SHARDS }, (_, shard) => shard))(
    "I8: what happens to one session never closes the connection under another's call (shard %d)",
    async (shard) => {
      const size = Math.ceil(generated.length / SHARDS);
      for (const sibling of generated.slice(shard * size, (shard + 1) * size)) {
        const violations = await siblingViolationsOf(sibling);
        if (violations.length > 0) {
          throw new Error(`${violations.join("; ")} for ${JSON.stringify(sibling)}`);
        }
      }
    },
  );

  test("the shards replay every generated case", () => {
    expect(generated).toHaveLength(SIBLING_RUN_OPTIONS.numRuns);
  });
});

describe("proxy connection draining at daemon shutdown (property-based)", () => {
  const DRAIN_RUN_OPTIONS = { seed: 11_411, numRuns: 60 } as const;
  const SHARDS = 12;
  const generated: DrainCase[] = [];
  beforeAll(async () => {
    fc.assert(
      fc.property(drainCase, (drain) => {
        generated.push(drain);
      }),
      { ...DRAIN_RUN_OPTIONS, examples: DRAIN_REGRESSIONS.map(([, drain]) => [drain]) },
    );
    // Warm the proxy's connect and heartbeat paths, so the first case is not the slow one.
    await drainViolationsOf(DRAIN);
  });

  test.each(DRAIN_REGRESSIONS)("%s", async (_name, drain) => {
    expect(await drainViolationsOf(drain)).toEqual([]);
  });

  test.each(Array.from({ length: SHARDS }, (_, shard) => shard))(
    "I7: calls in flight get the daemon's answer or its close, and nothing is sent twice (shard %d)",
    async (shard) => {
      const size = Math.ceil(generated.length / SHARDS);
      for (const drain of generated.slice(shard * size, (shard + 1) * size)) {
        const violations = await drainViolationsOf(drain);
        if (violations.length > 0) {
          throw new Error(`${violations.join("; ")} for ${JSON.stringify(drain)}`);
        }
      }
    },
  );

  test("the shards replay every generated drain", () => {
    expect(generated).toHaveLength(DRAIN_RUN_OPTIONS.numRuns);
  });
});
