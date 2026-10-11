import { describe, expect, test } from "bun:test";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../src/processLifecycle";
import {
  DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
  DAEMON_SHUTDOWN_STAGES,
  createShutdownDatabaseTail,
  runShutdownCleanupStages,
  shutdownStageFrom,
  type DaemonShutdownStageName,
  type ShutdownCleanupStage,
} from "../src/shutdownCleanup";
import { FakeTimer } from "./fakes/FakeTimer";
import {
  FakeShutdownDatabase,
  flushMicrotasks,
  neverSettles,
  runFakeTime,
  shutDownProcess,
} from "./helpers/shutdownStageHarness";

// #11601 follow-up: an abandoned stage is not cancelled, so its eventual outcome still counts.
// A late rejection used to be dropped (the process could exit 0), and a stage that finished all
// its work after the settle stage gave up made the process exit 1 where it used to exit 0.

interface Report {
  message: string;
  error: unknown;
}

/** Drive fake time until the run settles; returns the messages it rejected with. */
async function settle(timer: FakeTimer, run: Promise<void>): Promise<string[]> {
  let failures: string[] | undefined;
  void run.then(
    () => {
      failures = [];
    },
    (error: unknown) => {
      failures =
        error instanceof AggregateError
          ? error.errors.map((cause: unknown) => (cause as Error).message)
          : [String(error)];
    },
  );
  await runFakeTime(timer, 2_000, () => failures !== undefined);
  expect(failures).toBeDefined();
  return failures ?? [];
}

describe("late outcomes of abandoned shutdown stages (#11601)", () => {
  test("a stage that rejects after its deadline, before the run ends, is reported by name and fails the run", async () => {
    const timer = new FakeTimer();
    const reports: Report[] = [];
    const lateFailure = new Error("finalizer failed");

    const failures = await settle(
      timer,
      runShutdownCleanupStages(
        [
          {
            name: "finalizer",
            budgetMs: 50,
            waitingOn: "a finalizer",
            run: async () => {
              await timer.sleep(120);
              throw lateFailure;
            },
          },
          { name: "later", budgetMs: 200, run: () => timer.sleep(150) },
        ],
        (message, error) => reports.push({ message, error }),
        { timer },
      ),
    );

    expect(failures).toEqual(["finalizer failed"]);
    expect(reports.map((report) => report.message)).toEqual([
      "Shutdown cleanup stage finalizer timed out after 50ms waiting on a finalizer; continuing shutdown",
      "Shutdown cleanup stage finalizer failed after being abandoned at its deadline",
    ]);
    expect(reports[1]?.error).toBe(lateFailure);
  });

  test("a stage that rejects after the run ended is still reported, not left as an unhandled rejection", async () => {
    const timer = new FakeTimer();
    const reports: Report[] = [];
    const lateFailure = new Error("capture stop failed");
    const wedged = Promise.withResolvers<void>();

    const failures = await settle(
      timer,
      runShutdownCleanupStages(
        [{ name: "capture", budgetMs: 50, run: () => wedged.promise }],
        (message, error) => reports.push({ message, error }),
        { timer },
      ),
    );
    expect(failures).toEqual([
      "Shutdown cleanup stage(s) still running when shutdown finished: capture",
    ]);

    wedged.reject(lateFailure);
    await flushMicrotasks();

    expect(reports.at(-1)).toEqual({
      message: "Shutdown cleanup stage capture failed after shutdown finished",
      error: lateFailure,
    });
  });

  test("a late failure whose reporter throws goes to the emergency log instead of escaping", async () => {
    const timer = new FakeTimer();
    const emergencies: Report[] = [];
    const lateFailure = new Error("capture stop failed");
    const loggerClosed = new Error("logger is closed");
    const wedged = Promise.withResolvers<void>();
    let reporterClosed = false;

    await settle(
      timer,
      runShutdownCleanupStages(
        [{ name: "capture", budgetMs: 50, run: () => wedged.promise }],
        () => {
          if (reporterClosed) {
            throw loggerClosed;
          }
        },
        { timer, emergencyLog: (message, error) => emergencies.push({ message, error }) },
      ),
    );
    reporterClosed = true;
    wedged.reject(lateFailure);
    await flushMicrotasks();

    expect(emergencies).toEqual([
      {
        message: "Shutdown cleanup stage capture failed after shutdown finished",
        error: lateFailure,
      },
      {
        message: "Reporting the late failure of shutdown stage capture failed",
        error: loggerClosed,
      },
    ]);
  });

  test("only abandoned stages that may write are named as keeping the database open", async () => {
    const timer = new FakeTimer();
    const seen: Array<{ all: readonly string[]; writers: readonly string[] }> = [];

    await settle(
      timer,
      runShutdownCleanupStages(
        [
          { name: "encoder", budgetMs: 50, mayWriteDatabase: false, run: () => neverSettles },
          { name: "release", budgetMs: 50, mayWriteDatabase: true, run: () => neverSettles },
          { name: "undeclared", budgetMs: 50, run: () => neverSettles },
          {
            name: "database",
            budgetMs: 50,
            run: (stage) =>
              void seen.push({
                all: stage.unsettledStages(),
                writers: stage.unsettledDatabaseWriters(),
              }),
          },
        ],
        () => {},
        { timer },
      ),
    );

    expect(seen).toEqual([
      { all: ["encoder", "release", "undeclared"], writers: ["release", "undeclared"] },
    ]);
  });
});

describe("daemon exit code by when a shutdown stage settles (#11601)", () => {
  // One slow stage that may write; every other stage finishes at once. Its deadline is the sum
  // of the budgets up to its own (2,300 ms). The first settle stage gives up at 7,500 ms, the
  // database stage runs, and the late settle stage gives up at 8,125 ms — which is where the
  // sequence ends when work is still running.
  const slowStage: DaemonShutdownStageName = "active capture and iOS CtrlProxy children";
  const timedOut = `Shutdown cleanup stage ${slowStage} timed out after 2300ms waiting on a fake wedge; continuing shutdown`;
  const stillRunning = `Shutdown stage(s) still running 5200ms after being abandoned: ${slowStage}`;
  const closeSkipped = `Skipping database close because abandoned shutdown stage(s) are still running: ${slowStage}`;
  const failed = `Shutdown cleanup stage ${slowStage} failed`;
  const failedLate = `Shutdown cleanup stage ${slowStage} failed after being abandoned at its deadline`;
  const failedAfterExit = `Shutdown cleanup stage ${slowStage} failed after shutdown finished`;

  function daemonStages(
    database: FakeShutdownDatabase,
    warnings: string[],
    slow: { name: DaemonShutdownStageName; run: () => Promise<void> },
  ): ShutdownCleanupStage[] {
    const tail = createShutdownDatabaseTail({
      closeDatabase: () => database.close(),
      drainWrites: () => database.drain(),
      warn: (message) => warnings.push(message),
    });
    const bodies: Partial<Record<DaemonShutdownStageName, ShutdownCleanupStage["run"]>> = {
      [slow.name]: slow.run,
      "abandoned stage settle": (stage) => tail.settle(stage),
      database: (stage) => tail.close(stage),
      "late abandoned stage settle": (stage) => tail.lateSettle(stage),
    };
    const names = Object.keys(DAEMON_SHUTDOWN_STAGES) as DaemonShutdownStageName[];
    return names.map((name) =>
      shutdownStageFrom(DAEMON_SHUTDOWN_STAGES, name, "a fake wedge", bodies[name] ?? (() => {})),
    );
  }

  interface Row {
    settlesAtMs: number | "never";
    outcome: "resolves" | "rejects";
    when: string;
    exitCode: 0 | 1;
    exitedAtMs: number;
    databaseClosed: boolean;
    warnings: string[];
  }
  const rows: Row[] = [
    {
      settlesAtMs: 100,
      outcome: "resolves",
      when: "before its deadline",
      exitCode: 0,
      exitedAtMs: 100,
      databaseClosed: true,
      warnings: [],
    },
    {
      settlesAtMs: 100,
      outcome: "rejects",
      when: "before its deadline",
      exitCode: 1,
      exitedAtMs: 100,
      databaseClosed: true,
      warnings: [failed],
    },
    {
      settlesAtMs: 5_000,
      outcome: "resolves",
      when: "after its deadline, before the database stage",
      exitCode: 0,
      exitedAtMs: 5_000,
      databaseClosed: true,
      warnings: [timedOut],
    },
    {
      settlesAtMs: 5_000,
      outcome: "rejects",
      when: "after its deadline, before the database stage",
      exitCode: 1,
      exitedAtMs: 5_000,
      databaseClosed: true,
      warnings: [timedOut, failedLate],
    },
    {
      settlesAtMs: 7_900,
      outcome: "resolves",
      when: "after the database stage, before the sequence ends",
      exitCode: 0,
      exitedAtMs: 7_900,
      databaseClosed: true,
      warnings: [timedOut, stillRunning, closeSkipped],
    },
    {
      settlesAtMs: 7_900,
      outcome: "rejects",
      when: "after the database stage, before the sequence ends",
      exitCode: 1,
      exitedAtMs: 7_900,
      databaseClosed: true,
      warnings: [timedOut, stillRunning, closeSkipped, failedLate],
    },
    {
      settlesAtMs: 8_600,
      outcome: "resolves",
      when: "after the sequence ended, before the process limit",
      exitCode: 1,
      exitedAtMs: 8_125,
      databaseClosed: false,
      warnings: [timedOut, stillRunning, closeSkipped],
    },
    {
      settlesAtMs: 8_600,
      outcome: "rejects",
      when: "after the sequence ended, before the process limit",
      exitCode: 1,
      exitedAtMs: 8_125,
      databaseClosed: false,
      warnings: [timedOut, stillRunning, closeSkipped, failedAfterExit],
    },
    {
      settlesAtMs: "never",
      outcome: "resolves",
      when: "never",
      exitCode: 1,
      exitedAtMs: 8_125,
      databaseClosed: false,
      warnings: [timedOut, stillRunning, closeSkipped],
    },
  ];

  test.each(rows)(
    "a stage that $outcome at $settlesAtMs ms ($when) exits $exitCode",
    async (row) => {
      const timer = new FakeTimer();
      const database = new FakeShutdownDatabase();
      const warnings: string[] = [];

      const outcome = await shutDownProcess(
        timer,
        daemonStages(database, warnings, {
          name: slowStage,
          run: async () => {
            if (row.settlesAtMs === "never") {
              return neverSettles;
            }
            await timer.sleep(row.settlesAtMs);
            // Its last write: the connection must still be open, however late this is.
            database.write();
            if (row.outcome === "rejects") {
              throw new Error("slow stage failed");
            }
          },
        }),
        warnings,
      );

      expect(outcome).toEqual({
        exitCode: row.exitCode,
        exitedAtMs: row.exitedAtMs,
        warnings: row.warnings,
      });
      expect(database.closes).toBe(row.databaseClosed ? 1 : 0);
      // A deferred close first drains what the straggler queued.
      expect(database.drains).toBe(row.settlesAtMs === 7_900 ? 1 : 0);
    },
  );

  test("a wedged stage that never touches the database does not keep it open", async () => {
    const timer = new FakeTimer();
    const database = new FakeShutdownDatabase();
    const warnings: string[] = [];
    const wedged: DaemonShutdownStageName = "video stream socket server";

    const outcome = await shutDownProcess(
      timer,
      daemonStages(database, warnings, { name: wedged, run: () => neverSettles }),
      warnings,
    );

    expect(DAEMON_SHUTDOWN_STAGES[wedged].mayWriteDatabase).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(database.closes).toBe(1);
    expect(warnings.filter((warning) => warning.startsWith("Skipping"))).toEqual([]);
    expect(outcome.exitedAtMs).toBeLessThanOrEqual(
      PROCESS_SHUTDOWN_TIMEOUT_MS - DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
    );
  });

  test("a standing reason to keep the database open is honoured and said once", async () => {
    const timer = new FakeTimer();
    const database = new FakeShutdownDatabase();
    const warnings: string[] = [];
    const tail = createShutdownDatabaseTail({
      closeDatabase: () => database.close(),
      drainWrites: () => database.drain(),
      keepOpenReason: () => "a session terminal write is still in flight",
      warn: (message) => warnings.push(message),
    });

    await runShutdownCleanupStages(
      [
        { name: "database", budgetMs: 100, run: (stage) => tail.close(stage) },
        { name: "late settle", budgetMs: 100, run: (stage) => tail.lateSettle(stage) },
      ],
      () => {},
      { timer },
    );

    expect(database.closes).toBe(0);
    expect(warnings).toEqual([
      "Skipping database close because a session terminal write is still in flight",
    ]);
  });
});
