import type { Timer } from "./utils/SystemTimer";
import { writeEmergencyLog } from "./utils/loggingConfig";
import { raceWithDeadline } from "./utils/raceWithDeadline";
import { errorMessage } from "./utils/describeUnknownError";

/** What a running stage may ask about the shutdown it is part of. */
export interface ShutdownCleanupStageContext {
  /**
   * Time left before this stage is abandoned (`Infinity` when it has no deadline). A stage that
   * owns a bounded wait sizes it from this, so its own fallback runs before it is abandoned.
   */
  remainingMs(): number;
  /**
   * Earlier stages that hit their deadline and whose work has STILL not settled. That work keeps
   * running, so a stage that tears down something it may touch (the database) checks this first.
   */
  unsettledStages(): readonly string[];
  /**
   * The subset of `unsettledStages()` that may still write to the database (every stage not
   * declared `mayWriteDatabase: false`). The database stays open while this is non-empty.
   */
  unsettledDatabaseWriters(): readonly string[];
  /**
   * Wait up to `timeoutMs` for that abandoned work to settle. Resolves true when none is left
   * running. Abandoned is not lost: this is how a stage near the end hands earlier stragglers
   * whatever budget the shutdown has not used.
   */
  waitForUnsettledStages(timeoutMs: number): Promise<boolean>;
}

export interface ShutdownCleanupStage {
  readonly name: string;
  /**
   * The share of the shutdown budget this stage is guaranteed. Time earlier stages did not use
   * rolls forward, so a stage may run until the sum of the budgets up to and including its own
   * has elapsed. Honoured only when the runner is given a timer; without one the stage is awaited
   * with no deadline.
   */
  readonly budgetMs?: number;
  /** What the stage waits on, named in the warning when its deadline elapses. */
  readonly waitingOn?: string;
  /**
   * False only for a stage whose work, including what it leaves running when abandoned, never
   * reaches the database. Anything else (the default) keeps the database open while it runs.
   */
  readonly mayWriteDatabase?: boolean;
  readonly run: (context: ShutdownCleanupStageContext) => Promise<void> | void;
}

export type ShutdownCleanupFailureReporter = (message: string, error: unknown) => void;

export interface ShutdownCleanupDeadlineOptions {
  readonly timer: Pick<Timer, "now" | "monotonicNow" | "setTimeout" | "clearTimeout">;
  /** Where a late failure goes when the failure reporter itself throws. Defaults to stderr. */
  readonly emergencyLog?: (message: string, error: unknown) => void;
}

/** One row of a shutdown stage table: the stage's share of the budget and its database flag. */
export interface ShutdownStageSpec {
  readonly budgetMs: number;
  readonly mayWriteDatabase: boolean;
}

/** A stage that may reach the database, directly or through work it awaits. The safe default. */
const writesDatabase = (budgetMs: number): ShutdownStageSpec => ({
  budgetMs,
  mayWriteDatabase: true,
});

/**
 * A stage whose teardown is device or child-process I/O only. `databaseFreeShutdownStages.test.ts`
 * runs each one's real teardown against a database that throws on use; a stage without such a
 * probe must not be declared here.
 */
const databaseFree = (budgetMs: number): ShutdownStageSpec => ({
  budgetMs,
  mayWriteDatabase: false,
});

/**
 * The daemon's shutdown stages: every stage of `Daemon.stop()` draws its deadline and its
 * database flag from this one table, and the budgets sum to less than the process shutdown limit
 * (9 s, `processLifecycle.ts`) with `DAEMON_SHUTDOWN_BUDGET_RESERVE_MS` to spare. Each figure is
 * the stage's guaranteed minimum: unused time rolls forward, so in an ordinary shutdown (earlier
 * stages take milliseconds) a later stage keeps the full bound it had before the table existed,
 * while a shutdown in which EVERY stage wedges still reaches the session release, the
 * daemon-shutdown notification, the database close and the pid/socket file removal before the
 * limit (#11601). Keys are in execution order.
 */
export const DAEMON_SHUTDOWN_STAGES = {
  // The control socket's own 1 s wait for in-flight request handlers, plus the margin: no
  // earlier stage can lend this one time, so its share is its whole bound.
  "provisioning ingress quiesce": writesDatabase(1_050),
  "provisioning interruption": writesDatabase(300),
  "shutdown release snapshot": writesDatabase(50),
  "forward lease idle releaser": writesDatabase(200),
  "managed execution release": writesDatabase(200),
  "active capture and iOS CtrlProxy children": writesDatabase(500),
  "health check timer": writesDatabase(50),
  "location routes": writesDatabase(50),
  "shutdown monitors": writesDatabase(150),
  "ADB missing-device subscription": writesDatabase(25),
  "session cleanup timer": writesDatabase(25),
  "video recording socket server": writesDatabase(30),
  "device gesture recording socket server": writesDatabase(30),
  "device snapshot socket server": writesDatabase(30),
  "appearance socket server": writesDatabase(30),
  "performance stream socket server": writesDatabase(30),
  "performance push socket server": writesDatabase(30),
  "device data stream socket server": writesDatabase(30),
  "failures stream socket server": writesDatabase(30),
  "failures push socket server": writesDatabase(30),
  "telemetry push socket server": writesDatabase(30),
  // No probe drives the real WebRTC stream manager teardown, so it keeps the safe default.
  "WebRTC stream socket server": writesDatabase(200),
  "video stream socket server": databaseFree(200),
  "iOS simulator capture helper pool": databaseFree(150),
  "appearance sync scheduler": writesDatabase(25),
  "performance monitor": writesDatabase(25),
  "active HTTP sessions": writesDatabase(150),
  "active HTTP session registry": writesDatabase(25),
  "HTTP server": writesDatabase(100),
  "active device sessions": writesDatabase(1_500),
  "Unix socket server": writesDatabase(1_100),
  "pending device cleanups": writesDatabase(300),
  "CtrlProxy forwarding leases": writesDatabase(400),
  "device allocation claims": writesDatabase(100),
  "managed ADB server": databaseFree(300),
  "abandoned stage settle": writesDatabase(75),
  "database write drain": writesDatabase(200),
  "in-flight migrations": writesDatabase(200),
  database: writesDatabase(300),
  // Its own share is small on purpose: what it hands the stragglers is the time the three
  // database stages above did not use.
  "late abandoned stage settle": writesDatabase(25),
  logger: writesDatabase(100),
  "daemon files": writesDatabase(100),
} satisfies Record<string, ShutdownStageSpec>;

export type DaemonShutdownStageName = keyof typeof DAEMON_SHUTDOWN_STAGES;

/** The budget column of `DAEMON_SHUTDOWN_STAGES`, in execution order. */
export const DAEMON_SHUTDOWN_STAGE_BUDGET_MS = stageBudgets(DAEMON_SHUTDOWN_STAGES);

/** Headroom the budget tables leave under the process limit for timer slop and the exit itself. */
export const DAEMON_SHUTDOWN_BUDGET_RESERVE_MS = 500;

/**
 * The stdio server's shutdown stages (proxy mode and `--no-proxy` direct mode share one handler).
 * It has no control socket, session repository or managed slots, so the table is shorter, and
 * it sums to the same total as the daemon's. Its two long shares are the ones that can wait on a
 * device: recording finalization with the iOS CtrlProxy children (direct mode), and the proxy's
 * close, which hands its managed execution's sessions back to the daemon. What the shorter stage
 * list leaves over goes to the settle stage, so a teardown that outlives its own share (a long
 * recording finalize) still has until the same point as a daemon stage to finish cleanly. Keys
 * are in execution order.
 */
export const STDIO_SHUTDOWN_STAGES = {
  "direct-mode capture and iOS CtrlProxy children": writesDatabase(2_000),
  "direct-mode managed ADB server": databaseFree(300),
  "video recording socket server": writesDatabase(30),
  "device gesture recording socket server": writesDatabase(30),
  "device snapshot socket server": writesDatabase(30),
  "appearance socket server": writesDatabase(30),
  "WebRTC stream socket server": writesDatabase(200),
  "appearance sync scheduler": writesDatabase(25),
  "prefetched Android CtrlProxy APK": writesDatabase(50),
  "stdio proxy": writesDatabase(2_000),
  "abandoned stage settle": writesDatabase(2_955),
  "database write drain": writesDatabase(200),
  "in-flight migrations": writesDatabase(200),
  database: writesDatabase(300),
  "late abandoned stage settle": writesDatabase(25),
  logger: writesDatabase(100),
} satisfies Record<string, ShutdownStageSpec>;

export type StdioShutdownStageName = keyof typeof STDIO_SHUTDOWN_STAGES;

/** The budget column of `STDIO_SHUTDOWN_STAGES`, in execution order. */
export const STDIO_SHUTDOWN_STAGE_BUDGET_MS = stageBudgets(STDIO_SHUTDOWN_STAGES);

function stageBudgets<Name extends string>(
  table: Record<Name, ShutdownStageSpec>,
): Record<Name, number> {
  const budgets: Partial<Record<Name, number>> = {};
  for (const name of Object.keys(table) as Name[]) {
    budgets[name] = table[name].budgetMs;
  }
  return budgets as Record<Name, number>;
}

/** A stage of `table` with its deadline and database flag drawn from its row. */
export function shutdownStageFrom<Name extends string>(
  table: Record<Name, ShutdownStageSpec>,
  name: Name,
  waitingOn: string,
  run: ShutdownCleanupStage["run"],
): ShutdownCleanupStage {
  return { name, waitingOn, ...table[name], run };
}

/**
 * A stage's own bounded wait ends this long before the stage deadline, so the stage's fallback
 * (its warning, a force-release, the "database stays open" flag) runs instead of the stage being
 * abandoned mid-wait.
 */
export const SHUTDOWN_STAGE_INNER_MARGIN_MS = 50;

/** The stage's own wait: its usual bound, shortened to end before the stage deadline. */
export function boundWithinStage(stage: ShutdownCleanupStageContext, usualBoundMs: number): number {
  return Math.max(0, Math.min(usualBoundMs, stage.remainingMs() - SHUTDOWN_STAGE_INNER_MARGIN_MS));
}

// What the late settle stage keeps back from its wait for the deferred write drain and close.
const DEFERRED_DATABASE_CLOSE_ALLOWANCE_MS = 100;

export interface ShutdownDatabaseTailOptions {
  /** Close the connection. Never called while an abandoned stage that may write is running. */
  closeDatabase(): Promise<void>;
  /** Bounded drain of in-flight tracked writes, run again before a deferred close. */
  drainWrites(timeoutMs: number): Promise<void>;
  /** A reason the database must stay open whatever the stages did (omit for none). */
  keepOpenReason?(): string | undefined;
  /**
   * Database accesses refused since the close (omit when the close does not refuse late work).
   * Work that outlived the shutdown gets a refusal rather than a reopened connection; the late
   * settle stage reports how many there were.
   */
  refusedAccessCount?(): number | Promise<number>;
  warn(message: string): void;
}

export interface ShutdownDatabaseTail {
  /** "abandoned stage settle": give stragglers what is left before the database stages. */
  settle(stage: ShutdownCleanupStageContext): Promise<void>;
  /** "database": close, unless an abandoned stage that may write is still running. */
  close(stage: ShutdownCleanupStageContext): Promise<void>;
  /**
   * "late abandoned stage settle": give stragglers the time the database stages did not use, and
   * close the database after all if the ones that kept it open have finished.
   */
  lateSettle(stage: ShutdownCleanupStageContext): Promise<void>;
}

/**
 * The stage bodies that decide when the database closes around abandoned stages. Shared by the
 * daemon and the stdio server so both keep one rule: abandoned is not cancelled, so the
 * connection stays open while an abandoned stage that may write is still running, and a
 * shutdown whose stragglers all finish before the sequence ends still closes it (#11601).
 */
export function createShutdownDatabaseTail(
  options: ShutdownDatabaseTailOptions,
): ShutdownDatabaseTail {
  let closeDeferred = false;
  const closeUnlessStillWriting = async (stage: ShutdownCleanupStageContext): Promise<void> => {
    closeDeferred = false;
    const reason = options.keepOpenReason?.();
    if (reason !== undefined) {
      options.warn(`Skipping database close because ${reason}`);
      return;
    }
    // A stage abandoned at its deadline is not cancelled: its work is still running and may
    // still write (a session release, a recording finalizer persisting its archive row). Leave
    // the connection open for it rather than close it mid-write; committed rows are durable
    // either way and the process is about to exit.
    const stillWriting = stage.unsettledDatabaseWriters();
    if (stillWriting.length > 0) {
      closeDeferred = true;
      options.warn(
        `Skipping database close because abandoned shutdown stage(s) are still running: ${stillWriting.join(", ")}`,
      );
      return;
    }
    await options.closeDatabase();
  };
  const settleLate = async (stage: ShutdownCleanupStageContext): Promise<void> => {
    // A straggler that finished just after the database stage deferred the close leaves
    // nothing to wait for, and the close still owed.
    if (stage.unsettledStages().length === 0 && !closeDeferred) {
      return;
    }
    const allowanceMs = closeDeferred ? DEFERRED_DATABASE_CLOSE_ALLOWANCE_MS : 0;
    await stage.waitForUnsettledStages(
      Math.max(0, boundWithinStage(stage, Number.POSITIVE_INFINITY) - allowanceMs),
    );
    if (!closeDeferred || stage.unsettledDatabaseWriters().length > 0) {
      return;
    }
    // The stragglers that kept the database open have finished: drain what they queued and
    // close it, as the database stage would have.
    await options.drainWrites(boundWithinStage(stage, Number.POSITIVE_INFINITY));
    await closeUnlessStillWriting(stage);
  };
  // The close refuses late work rather than let it reopen the database. Each refusal is logged
  // where it happens; this names the abandoned stages that were running while they were counted.
  const warnOfRefusedAccesses = async (stragglers: readonly string[]): Promise<void> => {
    const refused = (await options.refusedAccessCount?.()) ?? 0;
    if (refused === 0) {
      return;
    }
    options.warn(
      `Refused ${refused} database access(es) issued after the shutdown database close; ` +
        (stragglers.length > 0
          ? `abandoned shutdown stage(s) running since the close: ${stragglers.join(", ")}`
          : "no abandoned shutdown stage was running (an in-flight request or a late timer callback)"),
    );
  };
  return {
    settle: async (stage) => {
      const waitMs = boundWithinStage(stage, Number.POSITIVE_INFINITY);
      if (!(await stage.waitForUnsettledStages(waitMs))) {
        options.warn(
          `Shutdown stage(s) still running ${waitMs}ms after being abandoned: ${stage.unsettledStages().join(", ")}`,
        );
      }
    },
    close: closeUnlessStillWriting,
    lateSettle: async (stage) => {
      // Named before the wait: a straggler whose late write is refused has settled by the end.
      const stragglers = stage.unsettledStages();
      try {
        await settleLate(stage);
      } finally {
        try {
          await warnOfRefusedAccesses(stragglers);
        } catch (error) {
          try {
            options.warn(
              `Failed to report database accesses refused after shutdown: ${errorMessage(error)}`,
            );
          } catch (reportError) {
            // Best-effort reporting must preserve the settle outcome even if its reporter fails.
            writeEmergencyLog(
              "Reporting refused database accesses after shutdown failed",
              reportError,
            );
          }
        }
      }
    },
  };
}

const NO_DEADLINE_CONTEXT: ShutdownCleanupStageContext = {
  remainingMs: () => Number.POSITIVE_INFINITY,
  unsettledStages: () => [],
  unsettledDatabaseWriters: () => [],
  waitForUnsettledStages: async () => true,
};

/**
 * Runs shutdown work in order while allowing independent later stages to reclaim
 * their resources after an earlier stage fails. The aggregate is rethrown only
 * once every stage has had one chance to run so the process lifecycle can exit
 * with failure without leaking later resources.
 *
 * Given a timer, a stage with a `budgetMs` is also abandoned at its deadline: the timeout is
 * reported with the stage's name and what it was waiting on, and the next stage starts. An
 * abandoned stage is NOT cancelled — its work keeps running until the process exits — so later
 * stages can see it through `unsettledStages()`, and its eventual outcome is always observed.
 *
 * The run resolves (a clean shutdown, exit 0) when every stage has SETTLED successfully by the
 * time the last stage is done, including one that was warned about for passing its own deadline.
 * It rejects (exit 1) when any stage failed — at once, or late after being abandoned — or is
 * still running at the end. A stage that fails after the run has ended can no longer change
 * the outcome: its failure is still reported, never left as an unhandled rejection.
 */
export async function runShutdownCleanupStages(
  stages: readonly ShutdownCleanupStage[],
  reportFailure: ShutdownCleanupFailureReporter,
  deadlines?: ShutdownCleanupDeadlineOptions,
): Promise<void> {
  const failures: unknown[] = [];
  // Keyed by the stage object, not its name: two stages may share a name.
  const unsettled = new Map<
    ShutdownCleanupStage,
    { name: string; settled: Promise<void>; mayWriteDatabase: boolean }
  >();
  const unsettledNames = (): string[] => [...unsettled.values()].map((entry) => entry.name);
  let sequenceEnded = false;
  // Elapsed time is read from the monotonic clock where the timer has one: a wall-clock step
  // during shutdown must neither consume the budget nor extend it past the process limit.
  const elapsedClock = (): number =>
    deadlines ? (deadlines.timer.monotonicNow?.() ?? deadlines.timer.now()) : 0;
  const startedAtMs = elapsedClock();
  let budgetedMs = 0;
  // An abandoned stage settles on its own schedule, possibly after the logger the reporter
  // writes to has closed: a reporter that throws then must not become an unhandled rejection.
  const reportLateFailure = (stageName: string, error: unknown): void => {
    const message = sequenceEnded
      ? `Shutdown cleanup stage ${stageName} failed after shutdown finished`
      : `Shutdown cleanup stage ${stageName} failed after being abandoned at its deadline`;
    try {
      reportFailure(message, error);
    } catch (reportError) {
      const emergencyLog = deadlines?.emergencyLog ?? writeEmergencyLog;
      emergencyLog(message, error);
      emergencyLog(`Reporting the late failure of shutdown stage ${stageName} failed`, reportError);
    }
  };

  for (const stage of stages) {
    if (!deadlines || stage.budgetMs === undefined) {
      try {
        await stage.run(NO_DEADLINE_CONTEXT);
      } catch (error) {
        failures.push(error);
        reportFailure(`Shutdown cleanup stage ${stage.name} failed`, error);
      }
      continue;
    }

    const { timer } = deadlines;
    budgetedMs += stage.budgetMs;
    const deadlineAtMs = startedAtMs + budgetedMs;
    const allowedMs = Math.max(0, deadlineAtMs - elapsedClock());
    const timedOut = Symbol("shutdown stage deadline");
    const context: ShutdownCleanupStageContext = {
      remainingMs: () => Math.max(0, deadlineAtMs - elapsedClock()),
      unsettledStages: unsettledNames,
      unsettledDatabaseWriters: () =>
        [...unsettled.values()]
          .filter((entry) => entry.mayWriteDatabase)
          .map((entry) => entry.name),
      waitForUnsettledStages: async (timeoutMs) => {
        if (unsettled.size === 0) {
          return true;
        }
        const waitTimedOut = Symbol("abandoned stage settle timeout");
        try {
          await raceWithDeadline(
            Promise.all([...unsettled.values()].map((entry) => entry.settled)),
            {
              timer,
              timeoutMs,
              label: "Abandoned shutdown stage settle",
              timeoutError: () => waitTimedOut,
            },
          );
        } catch (error) {
          if (error !== waitTimedOut) {
            throw error;
          }
        }
        return unsettled.size === 0;
      },
    };
    let work: Promise<void> | undefined;
    try {
      await raceWithDeadline(
        () => {
          work = (async () => {
            await stage.run(context);
          })();
          return work;
        },
        {
          timer,
          timeoutMs: allowedMs,
          label: `Shutdown cleanup stage ${stage.name}`,
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error !== timedOut) {
        failures.push(error);
        reportFailure(`Shutdown cleanup stage ${stage.name} failed`, error);
        continue;
      }
      // The abandoned work may finish or fail later; either way it is then no longer in flight.
      // A late failure is a failed stage like any other: it is reported with the stage's name
      // and, while the run can still say so, fails the shutdown.
      const settled = (work ?? Promise.resolve()).then(
        () => {
          unsettled.delete(stage);
        },
        (lateError: unknown) => {
          unsettled.delete(stage);
          if (!sequenceEnded) {
            failures.push(lateError);
          }
          reportLateFailure(stage.name, lateError);
        },
      );
      unsettled.set(stage, {
        name: stage.name,
        settled,
        mayWriteDatabase: stage.mayWriteDatabase !== false,
      });
      reportFailure(
        `Shutdown cleanup stage ${stage.name} timed out after ${allowedMs}ms` +
          ` waiting on ${stage.waitingOn ?? "its cleanup"}; continuing shutdown`,
        new Error(`Shutdown cleanup stage ${stage.name} exceeded its ${allowedMs}ms deadline`),
      );
    }
  }

  sequenceEnded = true;
  if (unsettled.size > 0) {
    failures.push(
      new Error(
        `Shutdown cleanup stage(s) still running when shutdown finished: ${unsettledNames().join(", ")}`,
      ),
    );
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more shutdown cleanup stages failed");
  }
}

type StdioCleanup = () => Promise<unknown> | unknown;

/** What the stdio server's shutdown tears down; every member is a seam a test can fake. */
export interface StdioShutdownDependencies {
  /** True for `--no-proxy`: this process owns captures, the managed adb server and the database. */
  directModeActive(): boolean;
  cleanupChildProcesses: StdioCleanup;
  stopManagedAdbServer: StdioCleanup;
  stopVideoRecordingSocketServer: StdioCleanup;
  stopDeviceGestureRecordingSocketServer: StdioCleanup;
  stopDeviceSnapshotSocketServer: StdioCleanup;
  stopAppearanceSocketServer: StdioCleanup;
  stopWebRtcStreamSocketServer: StdioCleanup;
  stopAppearanceSyncScheduler: StdioCleanup;
  cleanupPrefetchedApk: StdioCleanup;
  /** Closes the daemon proxy, which hands its managed execution's sessions back first. */
  closeStdioProxy: StdioCleanup;
  /** Bounded drain of in-flight tracked database writes (direct mode only). */
  drainDatabaseWrites(timeoutMs: number): Promise<void>;
  /** Bounded wait for a cold-start migration still running (direct mode only). */
  settleMigrations(timeoutMs: number): Promise<void>;
  closeDatabase(): Promise<void>;
  /** Database accesses the close refused afterwards (direct mode only; omit for none). */
  refusedDatabaseAccessCount?(): Promise<number>;
  closeLogger: StdioCleanup;
  warn(message: string): void;
}

/**
 * The stdio server's shutdown, in order, on the same deadline mechanism as `Daemon.stop()`: a
 * wedged capture, adb or simulator teardown is abandoned at its deadline instead of holding the
 * process to its limit. Direct mode has no session repository — its sessions are an in-memory
 * map that dies with the process — so what it must persist is its in-flight database writes:
 * they are drained, and the connection closed, only once no abandoned stage may still write.
 */
export function createStdioShutdownStages(
  dependencies: StdioShutdownDependencies,
): ShutdownCleanupStage[] {
  const stage = (
    name: StdioShutdownStageName,
    waitingOn: string,
    run: ShutdownCleanupStage["run"],
  ): ShutdownCleanupStage => shutdownStageFrom(STDIO_SHUTDOWN_STAGES, name, waitingOn, run);
  const always =
    (cleanup: StdioCleanup): ShutdownCleanupStage["run"] =>
    async () => {
      await cleanup();
    };
  const inDirectMode =
    (run: ShutdownCleanupStage["run"]): ShutdownCleanupStage["run"] =>
    async (context) => {
      if (dependencies.directModeActive()) {
        await run(context);
      }
    };
  const databaseTail = createShutdownDatabaseTail({
    closeDatabase: () => dependencies.closeDatabase(),
    drainWrites: (timeoutMs) => dependencies.drainDatabaseWrites(timeoutMs),
    // Proxy mode never loads the database modules, so it has nothing to count.
    refusedAccessCount: async () =>
      dependencies.directModeActive()
        ? ((await dependencies.refusedDatabaseAccessCount?.()) ?? 0)
        : 0,
    warn: (message) => dependencies.warn(message),
  });
  const closing = "its connections closing";
  return [
    stage(
      "direct-mode capture and iOS CtrlProxy children",
      "recording stop/finalize and iOS CtrlProxy child exit",
      inDirectMode(always(dependencies.cleanupChildProcesses)),
    ),
    stage(
      "direct-mode managed ADB server",
      "adb kill-server",
      inDirectMode(always(dependencies.stopManagedAdbServer)),
    ),
    stage(
      "video recording socket server",
      closing,
      always(dependencies.stopVideoRecordingSocketServer),
    ),
    stage(
      "device gesture recording socket server",
      closing,
      always(dependencies.stopDeviceGestureRecordingSocketServer),
    ),
    stage(
      "device snapshot socket server",
      closing,
      always(dependencies.stopDeviceSnapshotSocketServer),
    ),
    stage("appearance socket server", closing, always(dependencies.stopAppearanceSocketServer)),
    stage(
      "WebRTC stream socket server",
      "WebRTC stream teardown (encoder stop, adb forward removal)",
      always(dependencies.stopWebRtcStreamSocketServer),
    ),
    stage(
      "appearance sync scheduler",
      "an in-flight appearance sync",
      always(dependencies.stopAppearanceSyncScheduler),
    ),
    stage(
      "prefetched Android CtrlProxy APK",
      "the prefetched APK directory removal",
      always(dependencies.cleanupPrefetchedApk),
    ),
    stage(
      "stdio proxy",
      "the daemon releasing this proxy's managed execution and ordinary owned sessions",
      always(dependencies.closeStdioProxy),
    ),
    stage("abandoned stage settle", "earlier stages that passed their deadline", (context) =>
      databaseTail.settle(context),
    ),
    stage(
      "database write drain",
      "in-flight best-effort database writes",
      inDirectMode((context) =>
        dependencies.drainDatabaseWrites(boundWithinStage(context, Number.POSITIVE_INFINITY)),
      ),
    ),
    stage(
      "in-flight migrations",
      "a cold-start migration still running",
      inDirectMode((context) =>
        dependencies.settleMigrations(boundWithinStage(context, Number.POSITIVE_INFINITY)),
      ),
    ),
    stage(
      "database",
      "the database connection closing",
      inDirectMode((context) => databaseTail.close(context)),
    ),
    stage("late abandoned stage settle", "earlier stages that passed their deadline", (context) =>
      databaseTail.lateSettle(context),
    ),
    stage("logger", "the log file flush", always(dependencies.closeLogger)),
  ];
}
