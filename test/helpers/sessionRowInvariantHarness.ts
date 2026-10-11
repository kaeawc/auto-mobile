import type { Kysely } from "kysely";
import { isTerminalReleaseReason } from "../../src/daemon/releaseReasons";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
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

export type SessionRowOperation =
  | "activity"
  | "superseded-release"
  | "device-loss-release"
  | "rebind"
  | "non-terminal-release"
  | "terminal-release"
  | "write-failure"
  | "timers"
  | "shutdown-drain";

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
    const write = `release(${args[3]}, generation ${args[4]?.expectedRowGeneration ?? "any"})`;
    this.log.push(`${write} issued, lands in ${delayMs}ms`);
    await this.land(delayMs);
    if (this.failReleases > 0) {
      this.failReleases--;
      this.log.push(`${write} failed`);
      throw new Error("SQLITE_BUSY: database is locked");
    }
    await super.markReleased(...args);
    this.log.push(`${write} landed`);
  }
}

type ReleaseReason = "explicit-release" | "plan-auto-release" | `device-disconnected:${string}`;

async function settleMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

export interface SessionRowRunOptions {
  /** Operations issued before the run is left to settle. */
  operations?: number;
  /** The operations a run may draw; all of them when omitted. */
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

/**
 * Drive one session through a seeded interleaving of activity writes, releases (superseded with a
 * late terminal row, device loss, non-terminal, terminal), rebinds, transient write failures,
 * timer advances and a shutdown drain, against the real repository over `db`; then let every
 * write and retry settle and compare the persisted row with the session the manager holds.
 */
export async function runSessionRowInterleaving(
  db: Kysely<Database>,
  seed: number,
  options: SessionRowRunOptions = {},
): Promise<SessionRowRun> {
  const random = new SeededRandom(seed);
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const repository = new ChaoticRepository(db, timer, random);
  const manager = new SessionManager(timer, repository, () => new FakeDbWriteBarrier());
  manager.stopCleanupTimer();
  manager.setSupersededRowReassertBackoff(fixedBackoff(REASSERT_RETRY_DELAY_MS));
  manager.setTerminalReleaseRetryBackoff(fixedBackoff(TERMINAL_RETRY_DELAY_MS));

  const sessionId = `row-invariant-${seed}`;
  const deviceLoss: ReleaseReason = `device-disconnected:${DEVICES[0]}`;
  const trace: string[] = [];
  const violations: string[] = [];
  const work: Promise<unknown>[] = [];
  const notified: string[] = [];
  const requested = new Set<ReleaseReason>();
  /** Releases whose persistence failed: their owner issues them again (see `retryFailedReleases`). */
  const failedReleases = new Set<ReleaseReason>();
  let deviceLossCommitted = false;
  let rebinding = false;
  let drained = false;
  manager.onSessionRelease((releasedId, _deviceId, reason) => {
    if (releasedId === sessionId) {
      notified.push(reason);
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
  const live = () => manager.getSession(sessionId);
  const requestedReasons = (): ReadonlySet<string> => requested;

  // Created over a database that answers: the interleaving starts from a live, persisted session.
  const created = manager.createSession(sessionId, DEVICES[0], "android", IDLE_WINDOW_MS);
  for (let step = 0; step < 4; step++) {
    await settleMicrotasks(50);
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
  }
  await created;

  const deviceLossRelease = (supersededAfterMs: number | undefined): void => {
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
              deviceLossCommitted = true;
            }
          },
          (error: unknown) => {
            if (!superseded) {
              failedReleases.add(deviceLoss);
            }
            throw error;
          },
        ),
    );
  };

  const releaseOrRecordFailure = async (reason: ReleaseReason): Promise<void> => {
    try {
      await manager.releaseSession(sessionId, reason);
    } catch (error) {
      failedReleases.add(reason);
      throw error;
    }
  };

  /**
   * A release whose own write failed rejects, and leaves the session fenced (terminal) or its
   * release pending (non-terminal) until it is released again: the caller's retry, issued here
   * once the database answers. That contract predates the rewrite and is not what is under test.
   */
  const retryFailedReleases = (): boolean => {
    if (requested.has("plan-auto-release") && !live()) {
      // A non-terminal release whose write failed resolves all the same, with the write pending
      // until the UUID is released again.
      failedReleases.add("plan-auto-release");
    }
    const reasons = Array.from(failedReleases);
    failedReleases.clear();
    for (const reason of reasons) {
      requested.add(reason);
      if (reason === deviceLoss) {
        deviceLossCommitted = true;
      }
      background(`${reason} again`, releaseOrRecordFailure(reason));
    }
    return reasons.length > 0;
  };

  const issue = async (operation: SessionRowOperation): Promise<void> => {
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
            operation === "terminal-release" ? "explicit-release" : "plan-auto-release";
          requested.add(reason);
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
      case "timers": {
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
    }
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
        await timer.advanceTimeAsync(Math.max(next, 1));
        continue;
      }
      const settled = await Promise.race([
        Promise.allSettled(work).then(() => true),
        settleMicrotasks(IDLE_ROUND_TURNS).then(() => false),
      ]);
      idleRounds = settled ? idleRounds + 1 : 0;
      if (idleRounds === 2) {
        return;
      }
    }
    violations.push("the run did not settle: a write or retry is still pending");
  };

  const allowed = options.allowed ?? ALL_OPERATIONS;
  const operations = options.operations ?? 12;
  for (let index = 0; index < operations; index++) {
    // Most runs open with the release whose late terminal row the rewrite exists for.
    const operation =
      index === 0 && allowed.includes("superseded-release") && random.next() < 0.7
        ? "superseded-release"
        : random.pick(allowed);
    repository.log.push(`-- ${operation}`);
    trace.push(operation);
    await issue(operation);
    await settleMicrotasks(random.pick([0, 1, 3, 8, 20, 60]));
  }

  repository.log.push("-- settle");
  // The transient failure is over. Let every write land and every retry run out.
  repository.failUpserts = 0;
  repository.failReleases = 0;
  await settle();
  for (let attempt = 0; attempt < 2 && retryFailedReleases(); attempt++) {
    await settle();
  }
  if (live()) {
    // A rewrite whose retries ran out is issued again by the session's next activity write.
    timer.advanceTime(1);
    background("activity", manager.getOrCreateSession(sessionId));
    await settle();
  }

  const check = async (moment: string): Promise<void> => {
    const session = live();
    const row = await repository.getSession(sessionId);
    const rowState = `${row?.status}/${row?.release_reason ?? "none"}/${row?.device_id}`;
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
    const unrequested = notified.filter(
      (reason) =>
        !(requestedReasons().has(reason) || (reason === deviceLoss && deviceLossCommitted)),
    );
    if (unrequested.length > 0) {
      violations.push(`${moment}: the session was released for ${unrequested.join(", ")}`);
    }
    if (!session && notified.length === 0) {
      violations.push(`${moment}: the session is gone and no release was announced`);
    }
    // (iii) A terminally released UUID stays terminal in the row.
    if (notified.some(isTerminalReleaseReason)) {
      if (session) {
        violations.push(`${moment}: the session is live after its terminal release`);
      }
      if (!row?.release_reason || !isTerminalReleaseReason(row.release_reason)) {
        violations.push(`${moment}: the terminally released session's row is ${rowState}`);
      }
    }
  };

  await check("settled");
  // Nothing left behind rewrites the row later.
  await timer.advanceTimeAsync(6 * SESSION_RELEASE_PERSIST_TIMEOUT_MS);
  await settle();
  await check("later");
  manager.stopCleanupTimer();
  return { seed, sessionId, trace, writes: repository.log, violations };
}
