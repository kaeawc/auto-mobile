import type { Timer } from "./utils/SystemTimer";
import { raceWithDeadline } from "./utils/raceWithDeadline";

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
  readonly run: (context: ShutdownCleanupStageContext) => Promise<void> | void;
}

export type ShutdownCleanupFailureReporter = (message: string, error: unknown) => void;

export interface ShutdownCleanupDeadlineOptions {
  readonly timer: Pick<Timer, "now" | "monotonicNow" | "setTimeout" | "clearTimeout">;
}

/**
 * The daemon's shutdown budget: every stage of `Daemon.stop()` draws its deadline from this one
 * table, and the table sums to less than the process shutdown limit (9 s, `processLifecycle.ts`)
 * with `DAEMON_SHUTDOWN_BUDGET_RESERVE_MS` to spare. Each figure is the stage's guaranteed
 * minimum: unused time rolls forward, so in an ordinary shutdown (earlier stages take
 * milliseconds) a later stage keeps the full bound it had before the table existed, while a
 * shutdown in which EVERY stage wedges still reaches the session release, the daemon-shutdown
 * notification, the database close and the pid/socket file removal before the limit (#11601).
 * Keys are in execution order.
 */
export const DAEMON_SHUTDOWN_STAGE_BUDGET_MS = {
  "provisioning ingress quiesce": 300,
  "provisioning interruption": 300,
  "shutdown release snapshot": 50,
  "forward lease idle releaser": 200,
  "managed execution release": 200,
  "active capture and iOS CtrlProxy children": 700,
  "health check timer": 50,
  "location routes": 50,
  "shutdown monitors": 150,
  "ADB missing-device subscription": 25,
  "session cleanup timer": 25,
  "video recording socket server": 30,
  "test recording socket server": 30,
  "device snapshot socket server": 30,
  "appearance socket server": 30,
  "performance stream socket server": 30,
  "performance push socket server": 30,
  "device data stream socket server": 30,
  "failures stream socket server": 30,
  "failures push socket server": 30,
  "telemetry push socket server": 30,
  "WebRTC stream socket server": 300,
  "video stream socket server": 300,
  "iOS simulator capture helper pool": 200,
  "appearance sync scheduler": 25,
  "performance monitor": 25,
  "active HTTP sessions": 150,
  "active HTTP session registry": 25,
  "HTTP server": 100,
  "active device sessions": 1_800,
  "Unix socket server": 1_100,
  "pending device cleanups": 300,
  "CtrlProxy forwarding leases": 400,
  "device allocation claims": 100,
  "managed ADB server": 300,
  "abandoned stage settle": 100,
  "database write drain": 200,
  "in-flight migrations": 200,
  database: 300,
  logger: 100,
  "daemon files": 100,
} as const satisfies Record<string, number>;

export type DaemonShutdownStageName = keyof typeof DAEMON_SHUTDOWN_STAGE_BUDGET_MS;

/** Headroom the budget table leaves under the process limit for timer slop and the exit itself. */
export const DAEMON_SHUTDOWN_BUDGET_RESERVE_MS = 500;

const NO_DEADLINE_CONTEXT: ShutdownCleanupStageContext = {
  remainingMs: () => Number.POSITIVE_INFINITY,
  unsettledStages: () => [],
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
 * stages can see it through `unsettledStages()`. A timeout is reported but is not a failure: it
 * does not join the aggregate.
 */
export async function runShutdownCleanupStages(
  stages: readonly ShutdownCleanupStage[],
  reportFailure: ShutdownCleanupFailureReporter,
  deadlines?: ShutdownCleanupDeadlineOptions,
): Promise<void> {
  const failures: unknown[] = [];
  const unsettled = new Map<string, Promise<void>>();
  // Elapsed time is read from the monotonic clock where the timer has one: a wall-clock step
  // during shutdown must neither consume the budget nor extend it past the process limit.
  const elapsedClock = (): number =>
    deadlines ? (deadlines.timer.monotonicNow?.() ?? deadlines.timer.now()) : 0;
  const startedAtMs = elapsedClock();
  let budgetedMs = 0;

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
      unsettledStages: () => [...unsettled.keys()],
      waitForUnsettledStages: async (timeoutMs) => {
        if (unsettled.size === 0) {
          return true;
        }
        const waitTimedOut = Symbol("abandoned stage settle timeout");
        try {
          await raceWithDeadline(Promise.all(unsettled.values()), {
            timer,
            timeoutMs,
            label: "Abandoned shutdown stage settle",
            timeoutError: () => waitTimedOut,
          });
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
      const forget = (): void => {
        unsettled.delete(stage.name);
      };
      // The abandoned work may finish or fail later; either way it is no longer in flight. Its
      // late failure is not reported: the logger this reporter writes to may already be closed.
      unsettled.set(stage.name, (work ?? Promise.resolve()).then(forget, forget));
      reportFailure(
        `Shutdown cleanup stage ${stage.name} timed out after ${allowedMs}ms` +
          ` waiting on ${stage.waitingOn ?? "its cleanup"}; continuing shutdown`,
        new Error(`Shutdown cleanup stage ${stage.name} exceeded its ${allowedMs}ms deadline`),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more shutdown cleanup stages failed");
  }
}
