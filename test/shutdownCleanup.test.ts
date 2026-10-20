import { describe, expect, test } from "bun:test";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../src/processLifecycle";
import {
  DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
  DAEMON_SHUTDOWN_STAGE_BUDGET_MS,
  runShutdownCleanupStages,
  type ShutdownCleanupStage,
} from "../src/shutdownCleanup";
import { FakeTimer } from "./fakes/FakeTimer";

const stageNames = ["socket", "helpers", "database", "logger"] as const;

function createStages(
  calls: string[],
  failures: ReadonlyMap<string, Error>,
): ShutdownCleanupStage[] {
  return stageNames.map((name) => ({
    name,
    run: async () => {
      calls.push(name);
      const failure = failures.get(name);
      if (failure) {
        throw failure;
      }
    },
  }));
}

describe("runShutdownCleanupStages", () => {
  for (const failingStage of stageNames) {
    test(`runs every cleanup stage exactly once when ${failingStage} fails`, async () => {
      const calls: string[] = [];
      const failure = new Error(`${failingStage} failed`);
      const warnings: Array<{ message: string; error: unknown }> = [];

      await expect(
        runShutdownCleanupStages(
          createStages(calls, new Map([[failingStage, failure]])),
          (message, error) => warnings.push({ message, error }),
        ),
      ).rejects.toBeInstanceOf(AggregateError);

      expect(calls).toEqual([...stageNames]);
      expect(warnings).toEqual([
        {
          message: `Shutdown cleanup stage ${failingStage} failed`,
          error: failure,
        },
      ]);
    });
  }

  test("aggregates all failures after every stage has run", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("socket failed");
    const lastFailure = new Error("logger failed");
    let aggregate: unknown;

    try {
      await runShutdownCleanupStages(
        createStages(
          calls,
          new Map([
            ["socket", firstFailure],
            ["logger", lastFailure],
          ]),
        ),
        () => {},
      );
    } catch (error) {
      aggregate = error;
    }

    expect(calls).toEqual([...stageNames]);
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toEqual([firstFailure, lastFailure]);
  });

  test("resolves without logging when every cleanup stage succeeds", async () => {
    const calls: string[] = [];
    const warnings: Array<{ message: string; error: unknown }> = [];

    await expect(
      runShutdownCleanupStages(createStages(calls, new Map()), (message, error) =>
        warnings.push({ message, error }),
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([...stageNames]);
    expect(warnings).toEqual([]);
  });
});

const never = new Promise<void>(() => {});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

interface StageRun {
  finishedAt: number;
  /** Messages of the errors the run rejected with; empty when it resolved. */
  failures: string[];
}

/** Drive fake time until `stop` settles; fails the test instead of hanging if it never does. */
async function runToCompletion(timer: FakeTimer, stop: Promise<void>): Promise<StageRun> {
  let settled = false;
  let failures: string[] = [];
  const tracked = stop.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failures =
        error instanceof AggregateError
          ? error.errors.map((cause: unknown) => (cause as Error).message)
          : [String(error)];
    },
  );
  await flush();
  for (let elapsed = 0; !settled && elapsed <= 2 * PROCESS_SHUTDOWN_TIMEOUT_MS; elapsed += 5) {
    timer.advanceTime(5);
    await flush();
  }
  expect(settled).toBe(true);
  await tracked;
  return { finishedAt: timer.now(), failures };
}

describe("runShutdownCleanupStages stage deadlines (#11601)", () => {
  test("abandons a wedged stage at its deadline, names what it waited on, and runs the rest", async () => {
    const timer = new FakeTimer();
    const calls: string[] = [];
    const warnings: string[] = [];

    const { finishedAt, failures } = await runToCompletion(
      timer,
      runShutdownCleanupStages(
        [
          { name: "first", budgetMs: 100, run: () => void calls.push("first") },
          {
            name: "relay",
            budgetMs: 200,
            waitingOn: "capture source stop",
            run: () => {
              calls.push("relay");
              return never;
            },
          },
          { name: "database", budgetMs: 100, run: () => void calls.push("database") },
        ],
        (message) => warnings.push(message),
        { timer },
      ),
    );

    expect(calls).toEqual(["first", "relay", "database"]);
    // The first stage finished at once, so its unused 100 ms rolled forward to the relay.
    expect(finishedAt).toBe(300);
    expect(warnings).toEqual([
      "Shutdown cleanup stage relay timed out after 300ms waiting on capture source stop; continuing shutdown",
    ]);
    // Work was left running, so the run fails and the process exits non-zero, as it did when
    // the wedge ran into the process limit.
    expect(failures).toEqual([
      `Shutdown cleanup stage(s) still running when shutdown finished: relay`,
    ]);
  });

  test("a stage that passes its deadline but finishes before the run ends is not a failure", async () => {
    const timer = new FakeTimer();
    const warnings: string[] = [];

    const { finishedAt, failures } = await runToCompletion(
      timer,
      runShutdownCleanupStages(
        [
          { name: "slow", budgetMs: 50, waitingOn: "a finalizer", run: () => timer.sleep(120) },
          { name: "later", budgetMs: 200, run: () => timer.sleep(150) },
        ],
        (message) => warnings.push(message),
        { timer },
      ),
    );

    expect(finishedAt).toBe(200);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      "Shutdown cleanup stage slow timed out after 50ms waiting on a finalizer; continuing shutdown",
    ]);
  });

  test("a rejection after an abandoned stage is still reported, alongside the stage left running", async () => {
    const timer = new FakeTimer();

    const { failures } = await runToCompletion(
      timer,
      runShutdownCleanupStages(
        [
          { name: "wedged", budgetMs: 50, run: () => never },
          {
            name: "database",
            budgetMs: 50,
            run: () => {
              throw new Error("database failed");
            },
          },
        ],
        () => {},
        { timer },
      ),
    );

    expect(failures).toEqual([
      "database failed",
      `Shutdown cleanup stage(s) still running when shutdown finished: wedged`,
    ]);
  });

  test("tells later stages which abandoned stages are still running, until they settle", async () => {
    const timer = new FakeTimer();
    const wedged = Promise.withResolvers<void>();
    const seen: Array<readonly string[]> = [];
    const gate = Promise.withResolvers<void>();

    const stop = runShutdownCleanupStages(
      [
        { name: "release", budgetMs: 50, run: () => wedged.promise },
        {
          name: "socket",
          budgetMs: 50,
          run: async (stage) => {
            seen.push(stage.unsettledStages());
            await gate.promise;
            seen.push(stage.unsettledStages());
          },
        },
      ],
      () => {},
      { timer },
    );
    await flush();
    timer.advanceTime(50);
    await flush();
    // The abandoned release finishes late, while the next stage is still running.
    wedged.resolve();
    await flush();
    gate.resolve();
    await stop;

    // It settled before the run ended, so the run itself resolved.
    expect(seen).toEqual([["release"], []]);
  });

  test("a later stage can wait, bounded, for abandoned stages to settle", async () => {
    const timer = new FakeTimer();
    const outcomes: boolean[] = [];

    await runToCompletion(
      timer,
      runShutdownCleanupStages(
        [
          { name: "finalizer", budgetMs: 50, run: () => timer.sleep(200) },
          { name: "wedged", budgetMs: 50, run: () => never },
          {
            name: "settle",
            budgetMs: 1_000,
            run: async (stage) => {
              outcomes.push(await stage.waitForUnsettledStages(50));
              expect(stage.unsettledStages()).toEqual(["finalizer", "wedged"]);
              outcomes.push(await stage.waitForUnsettledStages(500));
              expect(stage.unsettledStages()).toEqual(["wedged"]);
            },
          },
        ],
        () => {},
        { timer },
      ),
    );

    expect(outcomes).toEqual([false, false]);
    expect(timer.now()).toBe(650);
  });

  test("waiting for abandoned stages resolves true at once when none is left", async () => {
    const timer = new FakeTimer();
    const outcomes: boolean[] = [];

    await runShutdownCleanupStages(
      [
        {
          name: "settle",
          budgetMs: 100,
          run: async (stage) => void outcomes.push(await stage.waitForUnsettledStages(100)),
        },
      ],
      () => {},
      { timer },
    );

    expect(outcomes).toEqual([true]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a stage sees the time it has left, including what earlier stages did not use", async () => {
    const timer = new FakeTimer();
    const remaining: number[] = [];

    await runShutdownCleanupStages(
      [
        { name: "quick", budgetMs: 400, run: (stage) => void remaining.push(stage.remainingMs()) },
        { name: "drain", budgetMs: 100, run: (stage) => void remaining.push(stage.remainingMs()) },
      ],
      () => {},
      { timer },
    );

    expect(remaining).toEqual([400, 500]);
  });

  test("measures the budget on the monotonic clock, so a wall-clock step does not consume it", async () => {
    const timer = new FakeTimer();
    const calls: string[] = [];
    const warnings: string[] = [];

    const stop = runShutdownCleanupStages(
      [
        {
          name: "stepped",
          budgetMs: 100,
          run: () => {
            timer.stepWallClock(60 * 60 * 1000);
          },
        },
        {
          name: "after",
          budgetMs: 100,
          run: async (stage) => {
            calls.push(`after:${stage.remainingMs()}`);
          },
        },
      ],
      (message) => warnings.push(message),
      { timer },
    );
    await runToCompletion(timer, stop);

    expect(calls).toEqual(["after:200"]);
    expect(warnings).toEqual([]);
  });

  test("without a timer a budgeted stage is awaited with no deadline", async () => {
    const release = Promise.withResolvers<void>();
    let settled = false;

    const stop = runShutdownCleanupStages(
      [{ name: "slow", budgetMs: 1, run: () => release.promise }],
      () => {},
    ).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    release.resolve();
    await stop;
    expect(settled).toBe(true);
  });
});

describe("daemon shutdown budget table (#11601)", () => {
  const names = Object.keys(DAEMON_SHUTDOWN_STAGE_BUDGET_MS) as Array<
    keyof typeof DAEMON_SHUTDOWN_STAGE_BUDGET_MS
  >;
  const total = Object.values(DAEMON_SHUTDOWN_STAGE_BUDGET_MS).reduce((sum, ms) => sum + ms, 0);
  const limit = PROCESS_SHUTDOWN_TIMEOUT_MS - DAEMON_SHUTDOWN_BUDGET_RESERVE_MS;

  function tableStages(wedged: ReadonlySet<string>, ran: string[]): ShutdownCleanupStage[] {
    return names.map((name) => ({
      name,
      budgetMs: DAEMON_SHUTDOWN_STAGE_BUDGET_MS[name],
      waitingOn: "a fake wedge",
      run: () => {
        ran.push(name);
        return wedged.has(name) ? never : undefined;
      },
    }));
  }

  test("sums to less than the process shutdown limit with the reserve to spare", () => {
    expect(Object.values(DAEMON_SHUTDOWN_STAGE_BUDGET_MS).every((ms) => ms > 0)).toBe(true);
    expect(total).toBeLessThanOrEqual(limit);
    expect(DAEMON_SHUTDOWN_BUDGET_RESERVE_MS).toBeGreaterThanOrEqual(500);
  });

  test("the stages that protect user state come last, in release, notify, database, files order", () => {
    const order = [
      "active device sessions",
      "Unix socket server",
      "database write drain",
      "database",
      "logger",
      "daemon files",
    ].map((name) => names.indexOf(name as (typeof names)[number]));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(names.at(-1)).toBe("daemon files");
  });

  test.each(names.map((name, index) => [index, name] as const))(
    "a stage wedged at position %d (%s) cannot stop any later stage or pass the process limit",
    async (index, wedgedName) => {
      const timer = new FakeTimer();
      const ran: string[] = [];
      const warnings: string[] = [];

      const { finishedAt, failures } = await runToCompletion(
        timer,
        runShutdownCleanupStages(
          tableStages(new Set([wedgedName]), ran),
          (message) => warnings.push(message),
          { timer },
        ),
      );

      expect(ran).toEqual(names);
      expect(ran.slice(index + 1)).toEqual(names.slice(index + 1));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith(`Shutdown cleanup stage ${wedgedName} timed out after `);
      expect(warnings[0]).toEndWith("ms waiting on a fake wedge; continuing shutdown");
      expect(failures).toEqual([
        `Shutdown cleanup stage(s) still running when shutdown finished: ${wedgedName}`,
      ]);
      expect(finishedAt).toBeLessThanOrEqual(limit);
      expect(finishedAt).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
    },
  );

  test("with every stage wedged the whole sequence still finishes inside the process limit", async () => {
    const timer = new FakeTimer();
    const ran: string[] = [];
    const warnings: string[] = [];

    const { finishedAt } = await runToCompletion(
      timer,
      runShutdownCleanupStages(
        tableStages(new Set(names), ran),
        (message) => warnings.push(message),
        { timer },
      ),
    );

    expect(ran).toEqual(names);
    expect(warnings).toHaveLength(names.length);
    expect(finishedAt).toBe(total);
    expect(finishedAt).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
  });
});
