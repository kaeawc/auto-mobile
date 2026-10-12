import type { Kysely } from "kysely";
import { isTerminalReleaseReason } from "../../src/daemon/releaseReasons";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import type {
  TerminalReleaseIntent,
  TerminalReleaseJournal,
} from "../../src/daemon/terminalReleaseJournal";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { fixedBackoff } from "../../src/utils/Backoff";
import type { Random } from "../../src/utils/Random";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { SeededRandom } from "../fakes/SeededRandom";

const DEVICES = ["emulator-5554", "emulator-5556"] as const;
const IDLE_WINDOW_MS = 6 * 60 * 60 * 1_000;
const REASSERT_RETRY_DELAY_MS = 200;
const TERMINAL_RETRY_DELAY_MS = 300;
const QUIESCENCE_STEPS = 400;
const IDLE_ROUND_TURNS = 150;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20 * SESSION_RELEASE_PERSIST_TIMEOUT_MS;
const STABLE_DEVICE_ID = "Pixel_8_API_35";
const DAEMON = "daemon-1";
const PEER_DAEMON = "daemon-peer";
const RESTARTED_DAEMON = "daemon-2";
/** A terminal reason this daemon's own releases never use, so a peer's row is told from them. */
const PEER_TERMINAL_REASON = "owner-disconnected";
const PLAN_RELEASE = "plan-auto-release";
const SHUTDOWN_RELEASE = "daemon-shutdown";

export type SessionRowOperation =
  | "activity"
  | "superseded-release"
  | "device-loss-release"
  | "rebind"
  | "non-terminal-release"
  | "terminal-release"
  | "write-failure"
  | "timers"
  | "shutdown-drain"
  // The second model (see EXTENDED_OPERATIONS): peers, re-issue, forced releases, restart.
  | "reissue"
  | "force-release"
  | "release-write-failure"
  | "peer-terminal-row"
  | "peer-stale-sweep"
  | "peer-expiry-sweep"
  | "peer-reissue"
  | "restart";

export interface SessionRowRun {
  seed: number;
  sessionId: string;
  /** The operations issued, in order, with the detail that reproduces them. */
  trace: string[];
  /** The operations and every row write as it was issued, landed or failed. */
  writes: string[];
  /** Every invariant the run broke; empty when the row agrees with the session. */
  violations: string[];
}

/**
 * The real repository over SQLite, with each row write landing after a seeded delay on the fake
 * timer (possibly past the release deadline) and failing while a transient-failure budget lasts,
 * as a busy database does. The statements and their guards are the repository's own.
 */
class ChaoticRepository extends DeviceSessionRepository {
  failUpserts = 0;
  failReleases = 0;
  /** The delay of the next release write, when an operation needs it past the deadline. */
  nextReleaseDelayMs: number | undefined;
  /** Release writes issued so far: none may follow the shutdown drain. */
  releaseWritesIssued = 0;
  /** Terminal release writes issued and not yet landed or failed. */
  terminalWritesInFlight = 0;
  /** Every write as it is issued, lands or fails, for the trace of a failing run. */
  readonly log: string[] = [];

  constructor(
    db: Kysely<Database>,
    private readonly clock: FakeTimer,
    private readonly random: Random,
  ) {
    super(db, clock);
  }

  private async land(delayMs: number): Promise<void> {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, delayMs));
    }
  }

  private writeDelayMs(): number {
    // Most writes land within the turn; some queue behind others; a few are wedged.
    return this.random.pick([0, 0, 0, 0, 1, 40, 900, SESSION_RELEASE_PERSIST_TIMEOUT_MS + 500]);
  }

  override async upsertActiveSession(
    ...args: Parameters<DeviceSessionRepository["upsertActiveSession"]>
  ): Promise<number> {
    const delayMs = this.writeDelayMs();
    const write = `upsert(${args[0].deviceId}${args[2]?.unlessTerminal ? ", unless terminal" : ""})`;
    this.log.push(`${write} issued, lands in ${delayMs}ms`);
    await this.land(delayMs);
    if (this.failUpserts > 0) {
      this.failUpserts--;
      this.log.push(`${write} failed`);
      throw new Error("SQLITE_BUSY: database is locked");
    }
    const generation = await super.upsertActiveSession(...args);

    this.log.push(`${write} landed as generation ${generation}`);
    return generation;
  }

  override async markReleased(
    ...args: Parameters<DeviceSessionRepository["markReleased"]>
  ): Promise<void> {
    const delayMs = this.nextReleaseDelayMs ?? this.writeDelayMs();
    this.nextReleaseDelayMs = undefined;
    this.releaseWritesIssued++;
    const write = `release(${args[3]}, generation ${args[4]?.expectedRowGeneration ?? "any"})`;
    this.log.push(`${write} issued, lands in ${delayMs}ms`);
    const terminal = isTerminalReleaseReason(args[3]);
    this.terminalWritesInFlight += terminal ? 1 : 0;
    try {
      await this.land(delayMs);
    } finally {
      this.terminalWritesInFlight -= terminal ? 1 : 0;
    }
    if (this.failReleases > 0) {
      this.failReleases--;
      this.log.push(`${write} failed`);
      throw new Error("SQLITE_BUSY: database is locked");
    }
    await super.markReleased(...args);
    this.log.push(`${write} landed`);
  }
}

/** The terminal release journal, kept in memory: what one daemon leaves, the next one loads. */
class MemoryJournal implements TerminalReleaseJournal {
  readonly intents = new Map<string, TerminalReleaseIntent>();

  constructor(private readonly left: readonly TerminalReleaseIntent[] = []) {}

  loadUnconfirmed(): TerminalReleaseIntent[] {
    return [...this.left];
  }

  record(intent: TerminalReleaseIntent): void {
    this.intents.set(intent.sessionId, intent);
  }

  resolve(sessionId: string, reason?: string): void {
    if (reason === undefined || this.intents.get(sessionId)?.reason === reason) {
      this.intents.delete(sessionId);
    }
  }
}

type ReleaseReason = string;

/** One issue of the session id: the session the manager held for it, and what was asked of it. */
interface Incarnation {
  index: number;
  session: ReturnType<SessionManager["getSession"]>;
  /** The release reasons announced for it, in order. */
  notified: string[];
  /** The release reasons asked of it. */
  requested: Set<ReleaseReason>;
  /** Releases whose persistence failed: their owner issues them again (see `retryFailedReleases`). */
  failedReleases: Set<ReleaseReason>;
  deviceLossCommitted: boolean;
}

async function settleMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

export interface SessionRowRunOptions {
  /** Operations issued before the run is left to settle. */
  operations?: number;
  /** The operations a run may draw; all of the first model's when omitted. */
  allowed?: readonly SessionRowOperation[];
}

const ALL_OPERATIONS: readonly SessionRowOperation[] = [
  "activity",
  "activity",
  "superseded-release",
  "superseded-release",
  "superseded-release",
  "device-loss-release",
  "rebind",
  "rebind",
  "non-terminal-release",
  "terminal-release",
  "non-terminal-release",
  "write-failure",
  "write-failure",
  "timers",
  "timers",
  "timers",
  "timers",
  "timers",
  "timers",
  "shutdown-drain",
];

const EXTENDED_ONLY: ReadonlySet<SessionRowOperation> = new Set<SessionRowOperation>([
  "reissue",
  "force-release",
  "release-write-failure",
  "peer-terminal-row",
  "peer-stale-sweep",
  "peer-expiry-sweep",
  "peer-reissue",
  "restart",
]);

/**
 * The second model (#11557): the first model's operations, plus a second daemon writing the same
 * row (a terminal row, its startup sweep of rows it takes for a dead daemon's, its expiry sweep,
 * its own re-issue of the released name), the name's re-issue here as a new incarnation, a forced
 * release at any point, release writes that keep failing, and a shutdown at any point followed by
 * a restart that rehydrates from whatever rows are left. Drawing any of these selects the second
 * model, which checks more (see `runSessionRowInterleaving`).
 */
export const EXTENDED_OPERATIONS: readonly SessionRowOperation[] = [
  "activity",
  "activity",
  "superseded-release",
  "superseded-release",
  "device-loss-release",
  "rebind",
  "non-terminal-release",
  "non-terminal-release",
  "non-terminal-release",
  "terminal-release",
  "write-failure",
  "release-write-failure",
  "release-write-failure",
  "timers",
  "timers",
  "timers",
  "timers",
  "timers",
  "reissue",
  "reissue",
  "reissue",
  "force-release",
  "force-release",
  "peer-terminal-row",
  "peer-stale-sweep",
  "peer-expiry-sweep",
  "peer-reissue",
  "restart",
];

/**
 * Drive one session id through a seeded interleaving of activity writes, releases (superseded
 * with a late terminal row, device loss, non-terminal, terminal), rebinds, transient write
 * failures, timer advances and a shutdown drain, against the real repository over `db`; then let
 * every write and retry settle and compare the persisted row with the session the manager holds.
 *
 * With any of {@link EXTENDED_OPERATIONS}' own operations allowed, the run is the second model:
 * the id may be issued again after a release (each issue is an incarnation, judged on its own), a
 * peer daemon writes the row through its own repository over the same database, releases are
 * forced, and the run ends with a shutdown (mid-flight when `restart` is drawn) and a second
 * manager rehydrating from the rows left. It clears `device_sessions` first: rehydration reads
 * every row. Derived `<base>:<label>` session ids are not modelled.
 */
export async function runSessionRowInterleaving(
  db: Kysely<Database>,
  seed: number,
  options: SessionRowRunOptions = {},
): Promise<SessionRowRun> {
  const allowed = options.allowed ?? ALL_OPERATIONS;
  const extended = allowed.some((operation) => EXTENDED_ONLY.has(operation));
  let statements = 0;
  const statementCount = (): number => statements;
  if (extended) {
    db = db.withPlugin({
      transformQuery: ({ node }) => {
        statements++;
        return node;
      },
      transformResult: async ({ result }) => {
        statements++;
        return result;
      },
    });
  }
  const random = new SeededRandom(seed);
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const repository = new ChaoticRepository(db, timer, random);
  const manager = new SessionManager(timer, repository, () => new FakeDbWriteBarrier());
  manager.stopCleanupTimer();
  manager.setSupersededRowReassertBackoff(fixedBackoff(REASSERT_RETRY_DELAY_MS));
  manager.setTerminalReleaseRetryBackoff(fixedBackoff(TERMINAL_RETRY_DELAY_MS));
  const journal = new MemoryJournal();
  /** The peer daemon's writes: its own repository over the same database, landing at once. */
  const peer = new DeviceSessionRepository(db, timer);
  if (extended) {
    await db.deleteFrom("device_sessions").execute();
    manager.attachDaemonSessionId(DAEMON);
    manager.attachTerminalReleaseJournal(journal);
    manager.attachLiveDaemonSessionIds(() => new Set([DAEMON, PEER_DAEMON]));
  }

  const sessionId = `row-invariant-${seed}`;
  const deviceLoss: ReleaseReason = `device-disconnected:${DEVICES[0]}`;
  const trace: string[] = [];
  const violations: string[] = [];
  const work: Promise<unknown>[] = [];
  const incarnation = (index: number, session: Incarnation["session"]): Incarnation => ({
    index,
    session,
    notified: [],
    requested: new Set(),
    failedReleases: new Set(),
    deviceLossCommitted: false,
  });
  let current = incarnation(0, null);
  let previous: Incarnation | undefined;
  let rebinding = false;
  let reissuing = false;
  let drained = false;
  /** One of this daemon's releases of the id was terminal: no incarnation may follow it. */
  let ownTerminal = false;
  /** A peer's terminal row ends the UUID, regardless of our parked writes. */
  let peerTerminal: "none" | "decisive" = "none";
  /** The peer issued the released name itself: the row is its session's from then on. */
  let peerOwns = false;
  const live = () => manager.getSession(sessionId);
  /** The id was issued again: what follows is asked of, and announced for, the new incarnation. */
  const adoptIncarnation = (): void => {
    const session = live();
    if (!session || session === current.session) {
      return;
    }
    if (ownTerminal || peerTerminal === "decisive") {
      violations.push(`incarnation ${current.index + 1} was issued after a terminal release`);
    }
    previous = current;
    current = incarnation(current.index + 1, session);
    repository.log.push(`incarnation ${current.index} is live`);
  };
  manager.onSessionRelease((releasedId, _deviceId, reason) => {
    if (releasedId !== sessionId) {
      return;
    }
    // An announcement under the live incarnation is a late one for its predecessor.
    const heldNow = live();
    const target = previous && heldNow && heldNow === current.session ? previous : current;
    target.notified.push(reason);
    repository.log.push(`announced ${reason}`);
    if (isTerminalReleaseReason(reason)) {
      ownTerminal = true;
    }
  });

  const background = (name: string, promise: Promise<unknown>): void => {
    // Each operation's own outcome is not under test: only the row and the session it leaves.
    work.push(
      promise.then(
        () => repository.log.push(`${name} resolved`),
        (error: unknown) =>
          repository.log.push(`${name} rejected: ${error instanceof Error ? error.name : error}`),
      ),
    );
  };
  const poolOf = (owner: SessionManager): SessionDeviceAssigner => ({
    async assignDeviceToSession(id, _platform, target): Promise<string> {
      const session = await owner.createSession(
        id,
        target?.deviceId ?? DEVICES[0],
        "android",
        target?.liveness?.sessionTimeoutMs ?? IDLE_WINDOW_MS,
        target?.liveness?.heartbeatTimeoutMs,
        target?.stableDeviceId ?? STABLE_DEVICE_ID,
        target?.liveness,
        target?.initialOwnership,
      );
      return session.assignedDevice;
    },
  });

  // Created over a database that answers: the interleaving starts from a live, persisted session.
  const created = manager.createSession(
    sessionId,
    DEVICES[0],
    "android",
    IDLE_WINDOW_MS,
    undefined,
    extended ? STABLE_DEVICE_ID : undefined,
  );
  for (let step = 0; step < 4; step++) {
    await settleMicrotasks(50);
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
  }
  current.session = await created;

  const deviceLossRelease = (supersededAfterMs: number | undefined): void => {
    const mine = current;
    let superseded = false;
    if (supersededAfterMs !== undefined) {
      // The terminal write is wedged past the release deadline and lands under the live session.
      repository.nextReleaseDelayMs =
        SESSION_RELEASE_PERSIST_TIMEOUT_MS + random.pick([1, 300, 2_000, 9_000]);
      timer.setTimeout(() => {
        superseded = true;
      }, supersededAfterMs);
    }
    background(
      "device-loss release",
      manager
        .releaseSessionUnlessSuperseded(sessionId, deviceLoss, () => !superseded)
        .then(
          (release) => {
            if (!release.superseded && release.deviceId !== null) {
              mine.deviceLossCommitted = true;
            }
          },
          (error: unknown) => {
            if (!superseded) {
              mine.failedReleases.add(deviceLoss);
            }
            throw error;
          },
        ),
    );
  };

  const releaseOrRecordFailure = async (reason: ReleaseReason): Promise<void> => {
    const mine = current;
    try {
      await manager.releaseSession(sessionId, reason);
    } catch (error) {
      mine.failedReleases.add(reason);
      throw error;
    }
  };

  /**
   * A release whose own write failed rejects, and leaves the session fenced (terminal) until it is
   * released again: the caller's retry, issued here once the database answers. That contract
   * predates the rewrite and is not what is under test. A non-terminal release whose write failed
   * resolves all the same; the first model issues it again as a caller might, the second leaves
   * its write to the manager's own retry.
   */
  const retryFailedReleases = (): boolean => {
    if (!extended && current.requested.has(PLAN_RELEASE) && !live()) {
      current.failedReleases.add(PLAN_RELEASE);
    }
    const reasons = Array.from(current.failedReleases).filter(
      // The second model's caller repeats only what rejected for good: a terminal release.
      (reason) => !extended || (isTerminalReleaseReason(reason) && !live()),
    );
    current.failedReleases.clear();
    if (extended && peerTerminal !== "none" && !live() && current.notified.length === 0) {
      // The peer's terminal row ended the session at an activity write, and that release's own
      // write failed: the session is fenced and unannounced until it is released again, as the
      // expiry sweep (stopped here) does.
      reasons.push(PEER_TERMINAL_REASON);
    }
    for (const reason of reasons) {
      current.requested.add(reason);
      if (reason === deviceLoss) {
        current.deviceLossCommitted = true;
      }
      background(`${reason} again`, releaseOrRecordFailure(reason));
    }
    return reasons.length > 0;
  };

  const issuePeerOperation = async (operation: SessionRowOperation): Promise<void> => {
    if (peerOwns) {
      return;
    }
    const now = timer.now();
    switch (operation) {
      case "peer-terminal-row": {
        await peer.markReleased(sessionId, "released", now, PEER_TERMINAL_REASON);
        if ((await peer.getSession(sessionId))?.release_reason === PEER_TERMINAL_REASON) {
          peerTerminal = "decisive";
          repository.log.push(`the peer's terminal row landed (${peerTerminal})`);
        }
        return;
      }
      case "peer-stale-sweep":
        // The peer starts up believing this daemon dead, and expires the rows it left active.
        await peer.markStaleActiveSessionsExpired(
          PEER_DAEMON,
          now,
          "daemon-restart",
          new Set([PEER_DAEMON]),
        );
        return;
      case "peer-expiry-sweep":
        // Refused by its own statement: the row's lease has not lapsed.
        await peer.listRecoverableSessions(now);
        return;
      case "peer-reissue": {
        // The peer issues the released plan name itself, by the claim a recovery takes.
        const row = await peer.getSession(sessionId);
        if (live() || !row || row.status === "active" || row.release_reason !== PLAN_RELEASE) {
          return;
        }
        const claimed = await peer.claimRecoverableSession(
          sessionId,
          {
            rowGeneration: row.stable_identity_generation ?? 0,
            daemonSessionId: row.daemon_session_id ?? null,
          },
          PEER_DAEMON,
        );
        if (claimed === undefined) {
          return;
        }
        try {
          await peer.upsertActiveSession(
            {
              sessionUuid: sessionId,
              deviceId: DEVICES[1],
              stableDeviceId: STABLE_DEVICE_ID,
              platform: "android",
              daemonSessionId: PEER_DAEMON,
              createdAtMs: now,
              lastUsedAtMs: now,
              expiresAtMs: now + IDLE_WINDOW_MS,
              sessionTimeoutMs: IDLE_WINDOW_MS,
              heartbeatTimeoutMs: IDLE_WINDOW_MS,
              hasReceivedHeartbeat: true,
            },
            now,
            { claimedRow: { rowGeneration: claimed, daemonSessionId: PEER_DAEMON } },
          );
        } catch (error) {
          repository.log.push(`the peer's re-issue lost its claim: ${error}`);
          return;
        }
        peerOwns = true;
        repository.log.push("the peer issued the name: the row is its session's");
        return;
      }
      default:
        return;
    }
  };

  const issue = async (operation: SessionRowOperation): Promise<void> => {
    adoptIncarnation();
    switch (operation) {
      case "activity":
        if (live()) {
          timer.advanceTime(1);
          background("activity", manager.getOrCreateSession(sessionId));
        }
        return;
      case "superseded-release":
        if (live()) {
          deviceLossRelease(random.pick([0, 1, 50, 5_000]));
        }
        return;
      case "device-loss-release":
        if (live()) {
          deviceLossRelease(undefined);
        }
        return;
      case "rebind": {
        const session = live();
        if (session && !rebinding) {
          rebinding = true;
          const target = DEVICES.find((device) => device !== session.assignedDevice)!;
          background(
            `rebind to ${target}`,
            manager.rebindSession(sessionId, target, "android").finally(() => {
              rebinding = false;
            }),
          );
        }
        return;
      }
      case "non-terminal-release":
      case "terminal-release":
        if (live()) {
          const reason: ReleaseReason =
            operation === "terminal-release" ? "explicit-release" : PLAN_RELEASE;
          current.requested.add(reason);
          background(reason, releaseOrRecordFailure(reason));
        }
        return;
      case "write-failure":
        if (drained) {
          // A write that fails during shutdown is not retried past the drain (#11058).
          return;
        }
        if (random.next() < 0.5) {
          repository.failUpserts += random.pick([1, 1, 2]);
        } else {
          repository.failReleases += 1;
        }
        return;
      case "release-write-failure":
        // More failures than one retry outlasts, and only of releases.
        repository.failReleases += random.pick([1, 2, 3]);
        return;
      case "timers": {
        for (let round = 0; extended && round < 20 && (await stillWorking()); round++) {
          // A re-issue is many statements long, and no time passes between two of them.
        }
        // Mostly up to the next write landing or retry coming due, so the next operation meets it.
        const next = timer.getMsUntilNextDueEvent();
        await timer.advanceTimeAsync(
          next !== undefined && random.next() < 0.7
            ? Math.max(next, 1)
            : random.pick([1, 40, 200, 300, 1_000, 5_000, 11_000]),
        );
        return;
      }
      case "shutdown-drain":
        if (!drained) {
          drained = true;
          // The drain forgets a non-terminal release still pending, and gives a failing terminal
          // write one more attempt (#11058): the database answers again before shutdown, and
          // the releases that failed are issued again first.
          repository.failUpserts = 0;
          repository.failReleases = 0;
          await settle();
          if (retryFailedReleases()) {
            await settle();
          }
          background(
            "drain",
            manager.drainReleasePromises(10 * SESSION_RELEASE_PERSIST_TIMEOUT_MS),
          );
        }
        return;
      case "reissue":
        if (!live() && !reissuing) {
          reissuing = true;
          background(
            "re-issue",
            manager
              .getOrCreateSession(sessionId, poolOf(manager), "android", undefined, true)
              .then(adoptIncarnation)
              .finally(() => {
                reissuing = false;
              }),
          );
        }
        return;
      case "force-release": {
        const announced = current.notified.length;
        const forced = manager.forceStuckRelease(sessionId);
        if (forced) {
          // A forced release releases the session for the reason its stuck release was given.
          for (const reason of current.notified.slice(announced)) {
            current.requested.add(reason);
          }
          repository.log.push(`forced out of stage ${forced.stage ?? "unknown"}`);
        }
        return;
      }
      case "peer-terminal-row":
      case "peer-stale-sweep":
      case "peer-expiry-sweep":
      case "peer-reissue":
        await issuePeerOperation(operation);
        return;
      case "restart":
        // Ends the interleaving: handled by the run, which shuts down with everything in flight.
        return;
    }
  };

  /** Whether the manager reached the database again within another round of turns. */
  const stillWorking = async (): Promise<boolean> => {
    const statements = statementCount();
    await settleMicrotasks(IDLE_ROUND_TURNS);
    return statementCount() !== statements;
  };

  const settle = async (): Promise<void> => {
    let idleRounds = 0;
    for (let step = 0; step < QUIESCENCE_STEPS; step++) {
      // Long enough for a write the manager issues on its own (a retry, a re-write after a
      // rewrite) to reach the repository and arm its landing.
      await settleMicrotasks(IDLE_ROUND_TURNS);
      const next = timer.getMsUntilNextDueEvent();
      if (next !== undefined) {
        idleRounds = 0;
        if (extended && (await stillWorking())) {
          // A re-issue or a rehydration is many statements long: no deadline passes under it.
          continue;
        }
        await timer.advanceTimeAsync(Math.max(next, 1));
        continue;
      }
      const settled = await Promise.race([
        Promise.allSettled(work).then(() => true),
        settleMicrotasks(IDLE_ROUND_TURNS).then(() => false),
      ]);
      idleRounds = settled ? idleRounds + 1 : 0;
      if (idleRounds === 2) {
        adoptIncarnation();
        return;
      }
    }
    violations.push("the run did not settle: a write or retry is still pending");
  };

  const operations = options.operations ?? 12;
  let restartMidFlight = false;
  for (let index = 0; index < operations; index++) {
    // Most runs open with the release whose late terminal row the rewrite exists for.
    const operation =
      index === 0 && allowed.includes("superseded-release") && random.next() < 0.7
        ? "superseded-release"
        : random.pick(allowed);
    repository.log.push(`-- ${operation}`);
    trace.push(operation);
    if (operation === "restart") {
      restartMidFlight = true;
      break;
    }
    await issue(operation);
    await settleMicrotasks(random.pick([0, 1, 3, 8, 20, 60]));
  }

  /** The retries the manager still holds for the id, read from its own bookkeeping. */
  const armedRetries = (): string[] => {
    const armed: string[] = [];
    const owed = (
      Reflect.get(manager, "owedSupersededRowReasserts") as Map<
        string,
        { session: unknown; handle?: unknown }
      >
    ).get(sessionId);
    if (owed && owed.session !== live()) {
      armed.push("a live-row rewrite is owed to a session that ended");
    } else if (owed?.handle !== undefined) {
      armed.push("a live-row rewrite retry is armed");
    }
    const release = (
      Reflect.get(manager, "pendingTerminalReleaseRetries") as Map<string, { handle?: unknown }>
    ).get(sessionId);
    if (release?.handle !== undefined) {
      armed.push("a release write retry is armed");
    }
    return armed;
  };

  const check = async (moment: string): Promise<void> => {
    const session = live();
    const row = await repository.getSession(sessionId);
    const rowState = `${row?.status}/${row?.release_reason ?? "none"}/${row?.device_id}`;
    if (extended && peerOwns) {
      // The peer issued the released name: nothing this daemon still had in flight changes it.
      if (row?.status !== "active" || row.daemon_session_id !== PEER_DAEMON) {
        violations.push(`${moment}: the peer's session row is ${rowState}`);
      }
      if (session) {
        violations.push(`${moment}: the session is live here and at the peer`);
      }
      return;
    }
    // (i) The persisted row is the session the manager holds.
    if (session) {
      if (row?.status !== "active" || row.release_reason !== null) {
        violations.push(`${moment}: the session is live but its row is ${rowState}`);
      } else if (row.device_id !== session.assignedDevice) {
        violations.push(
          `${moment}: the session is on ${session.assignedDevice} but its row is ${rowState}`,
        );
      }
    } else if (row?.status === "active") {
      violations.push(`${moment}: the session is gone but its row is ${rowState}`);
    }
    // (ii) Only a release that was asked for, and committed, ends the session.
    for (const each of previous ? [previous, current] : [current]) {
      const unrequested = each.notified.filter(
        (reason) =>
          !(
            each.requested.has(reason) ||
            (reason === deviceLoss && each.deviceLossCommitted) ||
            (reason === PEER_TERMINAL_REASON && peerTerminal !== "none")
          ),
      );
      if (unrequested.length > 0) {
        violations.push(
          `${moment}: ${extended ? `incarnation ${each.index}` : "the session"} was released ` +
            `for ${unrequested.join(", ")}`,
        );
      }
    }
    if (!session && current.notified.length === 0) {
      violations.push(`${moment}: the session is gone and no release was announced`);
    }
    // (iii) A terminally released UUID stays terminal in the row.
    if (
      extended
        ? ownTerminal || peerTerminal === "decisive"
        : current.notified.some(isTerminalReleaseReason)
    ) {
      if (session) {
        violations.push(`${moment}: the session is live after its terminal release`);
      }
      if (!row?.release_reason || !isTerminalReleaseReason(row.release_reason)) {
        violations.push(`${moment}: the terminally released session's row is ${rowState}`);
      }
    } else if (extended && row?.release_reason && isTerminalReleaseReason(row.release_reason)) {
      // (iv) A release that was not terminal leaves the name issuable: no terminal row.
      violations.push(`${moment}: no terminal release was committed but the row is ${rowState}`);
    }
    if (extended) {
      // (v) No retry outlives what it was armed for.
      violations.push(...armedRetries().map((armed) => `${moment}: ${armed}`));
    }
  };

  /**
   * Shut the daemon down as it stands (its live session handed off, its releases drained), then
   * start another over the rows left: it rehydrates the session exactly when it was live and not
   * terminally released.
   */
  const restart = async (): Promise<void> => {
    const issuingAtShutdown = reissuing;
    repository.log.push("-- shutdown");
    drained = true;
    // The database answers through shutdown; what is in flight still lands when it lands.
    repository.failUpserts = 0;
    repository.failReleases = 0;
    manager.stopAcceptingSessionCreations();
    adoptIncarnation();
    // Held, even while a release of it is under way (which shutdown joins).
    const liveAtShutdown = manager.getAllSessionIds().includes(sessionId);
    const handoffs: Promise<unknown>[] = [];
    // As the daemon does: every id it knows, an issue or a release still in flight included.
    if (manager.getAllKnownSessionIds().includes(sessionId)) {
      current.requested.add(SHUTDOWN_RELEASE);
      handoffs.push(
        manager.releaseSession(sessionId, SHUTDOWN_RELEASE).catch((error: unknown) => {
          repository.log.push(`${SHUTDOWN_RELEASE} rejected: ${error}`);
        }),
      );
    }
    let drainedInTime: boolean | undefined;
    let writesAtDrain = 0;
    background(
      "drain",
      manager.drainReleasePromises(SHUTDOWN_DRAIN_TIMEOUT_MS, handoffs).then((inTime) => {
        drainedInTime = inTime;
        writesAtDrain = repository.releaseWritesIssued;
      }),
    );
    await settle();
    manager.stopCleanupTimer();
    await settle();
    if (drainedInTime !== true) {
      violations.push("shutdown: the release drain did not finish");
      return;
    }
    if (repository.releaseWritesIssued !== writesAtDrain) {
      violations.push(
        "shutdown: a release write was issued after the drain, as the database closes",
      );
    }
    violations.push(...armedRetries().map((armed) => `shutdown: ${armed}`));
    const heldAtExit = live() !== null;
    const lastReason = current.notified.at(-1);
    // A terminal release that never reached its row left its intent: the next daemon applies it.
    const fencedAtExit =
      journal.intents.has(sessionId) ||
      (Reflect.get(manager, "terminalReleaseSnapshots") as Map<string, unknown>).has(sessionId);
    const handedOffAfterRelease = !liveAtShutdown && lastReason === SHUTDOWN_RELEASE;
    const expected =
      !ownTerminal &&
      !fencedAtExit &&
      peerTerminal !== "decisive" &&
      !peerOwns &&
      (liveAtShutdown || heldAtExit || (handedOffAfterRelease && !issuingAtShutdown));
    // An in-flight issue entangles its refused creation's shutdown announcement and row claim
    // with the release upgrade; whether that run is a handoff needs an owner decision.
    const unjudged = !ownTerminal && handedOffAfterRelease && issuingAtShutdown;

    repository.log.push("-- restart");
    const store = new DeviceSessionRepository(db, timer);
    const liveDaemons = new Set([RESTARTED_DAEMON, PEER_DAEMON]);
    await store.markStaleActiveSessionsExpired(
      RESTARTED_DAEMON,
      timer.now(),
      "daemon-restart",
      liveDaemons,
    );
    const next = new SessionManager(timer, store, () => new FakeDbWriteBarrier());
    next.stopCleanupTimer();
    next.attachDaemonSessionId(RESTARTED_DAEMON);
    next.attachLiveDaemonSessionIds(() => liveDaemons);
    next.attachTerminalReleaseJournal(new MemoryJournal(Array.from(journal.intents.values())));
    background("rehydration", next.rehydratePersistedSessions(poolOf(next)));
    await settle();
    const rehydrated = next.getSession(sessionId);
    const row = await store.getSession(sessionId);
    const rowState = `${row?.status}/${row?.release_reason ?? "none"}/${row?.daemon_session_id}`;
    const ended = `ended as ${heldAtExit ? "live" : (lastReason ?? "nothing")}`;
    if (unjudged) {
      repository.log.push("restart: unjudged in-flight issue and release handoff");
    } else if (rehydrated && !expected) {
      violations.push(`restart: a ghost was rehydrated (${ended}, row ${rowState})`);
    } else if (!rehydrated && expected) {
      violations.push(`restart: the session was not rehydrated (${ended}, row ${rowState})`);
    } else if (
      rehydrated &&
      (row?.status !== "active" || row.daemon_session_id !== RESTARTED_DAEMON)
    ) {
      violations.push(`restart: the rehydrated session's row is ${rowState}`);
    } else if (!rehydrated && !peerOwns && !fencedAtExit && row?.status === "active") {
      violations.push(`restart: no session was rehydrated but the row is ${rowState}`);
    }
    next.stopCleanupTimer();
  };

  if (!restartMidFlight) {
    repository.log.push("-- settle");
    // The transient failure is over. Let every write land and every retry run out.
    repository.failUpserts = 0;
    repository.failReleases = 0;
    await settle();
    for (let attempt = 0; attempt < 2 && retryFailedReleases(); attempt++) {
      await settle();
    }
    if (live()) {
      // A rewrite whose retries ran out is issued again by the session's next activity write, and
      // a peer's terminal row ends the session at it.
      timer.advanceTime(1);
      background("activity", manager.getOrCreateSession(sessionId));
      await settle();
    }

    await check("settled");
    // Nothing left behind rewrites the row later.
    await timer.advanceTimeAsync(6 * SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    await settle();
    await check("later");
  }
  if (extended) {
    await restart();
  }
  manager.stopCleanupTimer();
  return { seed, sessionId, trace, writes: repository.log, violations };
}
