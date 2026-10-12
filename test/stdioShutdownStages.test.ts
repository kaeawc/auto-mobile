import { describe, expect, test } from "bun:test";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../src/processLifecycle";
import {
  DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
  STDIO_SHUTDOWN_STAGES,
  STDIO_SHUTDOWN_STAGE_BUDGET_MS,
  createStdioShutdownStages,
  type StdioShutdownDependencies,
  type StdioShutdownStageName,
} from "../src/shutdownCleanup";
import { FakeTimer } from "./fakes/FakeTimer";
import {
  FakeShutdownDatabase,
  neverSettles,
  shutDownProcess,
} from "./helpers/shutdownStageHarness";

// #11601 follow-up: the stdio server (proxy mode and --no-proxy direct mode) awaited every
// shutdown stage with no deadline, so a wedged capture, adb or simulator teardown held the
// process until the 9 s limit, and direct mode exited without draining its database writes.

type Teardown = Exclude<
  keyof StdioShutdownDependencies,
  "directModeActive" | "drainDatabaseWrites" | "settleMigrations" | "closeDatabase" | "warn"
>;

const teardownsInOrder: Teardown[] = [
  "cleanupChildProcesses",
  "stopManagedAdbServer",
  "stopVideoRecordingSocketServer",
  "stopDeviceGestureRecordingSocketServer",
  "stopDeviceSnapshotSocketServer",
  "stopAppearanceSocketServer",
  "stopWebRtcStreamSocketServer",
  "stopAppearanceSyncScheduler",
  "cleanupPrefetchedApk",
  "closeStdioProxy",
];

interface FakeStdioServer {
  /** Runs as soon as the database has closed: where an in-flight tool call resumes. */
  onDatabaseClosed?: () => void;
  refusalCountReads: number;
  calls: string[];
  warnings: string[];
  database: FakeShutdownDatabase;
  dependencies: StdioShutdownDependencies;
}

/** Every seam of the stdio shutdown as a recording fake; `slow` replaces one teardown's body. */
function fakeStdioServer(
  mode: "direct" | "proxy",
  slow: Partial<Record<Teardown, () => Promise<void>>> = {},
): FakeStdioServer {
  const calls: string[] = [];
  const warnings: string[] = [];
  const database = new FakeShutdownDatabase();
  const teardown = (name: Teardown) => async () => {
    calls.push(name);
    await slow[name]?.();
  };
  const dependencies: StdioShutdownDependencies = {
    directModeActive: () => mode === "direct",
    cleanupChildProcesses: teardown("cleanupChildProcesses"),
    stopManagedAdbServer: teardown("stopManagedAdbServer"),
    stopVideoRecordingSocketServer: teardown("stopVideoRecordingSocketServer"),
    stopDeviceGestureRecordingSocketServer: teardown("stopDeviceGestureRecordingSocketServer"),
    stopDeviceSnapshotSocketServer: teardown("stopDeviceSnapshotSocketServer"),
    stopAppearanceSocketServer: teardown("stopAppearanceSocketServer"),
    stopWebRtcStreamSocketServer: teardown("stopWebRtcStreamSocketServer"),
    stopAppearanceSyncScheduler: teardown("stopAppearanceSyncScheduler"),
    cleanupPrefetchedApk: teardown("cleanupPrefetchedApk"),
    closeStdioProxy: teardown("closeStdioProxy"),
    drainDatabaseWrites: async () => {
      calls.push("drainDatabaseWrites");
      await database.drain();
    },
    settleMigrations: async () => {
      calls.push("settleMigrations");
    },
    closeDatabase: async () => {
      calls.push("closeDatabase");
      await database.close();
      server.onDatabaseClosed?.();
    },
    refusedDatabaseAccessCount: async () => {
      server.refusalCountReads++;
      return database.refusals;
    },
    closeLogger: teardown("closeLogger"),
    warn: (message) => warnings.push(message),
  };
  const server: FakeStdioServer = {
    calls,
    warnings,
    database,
    dependencies,
    refusalCountReads: 0,
  };
  return server;
}

/** What `work` threw, or undefined when it returned. */
function captureThrown(work: () => void): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function shutDown(server: FakeStdioServer, timer = new FakeTimer()) {
  return shutDownProcess(timer, createStdioShutdownStages(server.dependencies), server.warnings);
}

describe("stdio shutdown stage table (#11601)", () => {
  const names = Object.keys(STDIO_SHUTDOWN_STAGES) as StdioShutdownStageName[];
  const total = Object.values(STDIO_SHUTDOWN_STAGE_BUDGET_MS).reduce((sum, ms) => sum + ms, 0);

  test("sums to less than the process shutdown limit with the reserve to spare", () => {
    expect(Object.values(STDIO_SHUTDOWN_STAGE_BUDGET_MS).every((ms) => ms > 0)).toBe(true);
    expect(total).toBeLessThanOrEqual(
      PROCESS_SHUTDOWN_TIMEOUT_MS - DAEMON_SHUTDOWN_BUDGET_RESERVE_MS,
    );
  });

  test("builds exactly the table's stages, in the table's order, each with its row", () => {
    const stages = createStdioShutdownStages(fakeStdioServer("direct").dependencies);

    expect(stages.map((stage) => stage.name)).toEqual(names);
    for (const stage of stages) {
      const row = STDIO_SHUTDOWN_STAGES[stage.name as StdioShutdownStageName];
      expect({ name: stage.name, ...row }).toEqual({
        name: stage.name,
        budgetMs: stage.budgetMs ?? Number.NaN,
        mayWriteDatabase: stage.mayWriteDatabase ?? true,
      });
      expect(stage.waitingOn).toBeString();
    }
  });

  test("with every teardown wedged the sequence still ends inside the process limit", async () => {
    const wedge = async (): Promise<void> => neverSettles;
    const server = fakeStdioServer(
      "direct",
      Object.fromEntries([...teardownsInOrder, "closeLogger"].map((name) => [name, wedge])),
    );

    const outcome = await shutDown(server);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.exitedAtMs).toBeLessThanOrEqual(total);
    expect(server.calls).toContain("closeLogger");
    // Something that may write is still running, so the connection is left open for it.
    expect(server.database.closes).toBe(0);
  });
});

describe("stdio shutdown in direct mode (#11601)", () => {
  test("a clean shutdown tears everything down in order, then drains and closes the database before the logger", async () => {
    const server = fakeStdioServer("direct");

    const outcome = await shutDown(server);

    expect(outcome).toEqual({ exitCode: 0, exitedAtMs: 0, warnings: [] });
    expect(server.calls).toEqual([
      ...teardownsInOrder,
      "drainDatabaseWrites",
      "settleMigrations",
      "closeDatabase",
      "closeLogger",
    ]);
  });

  test("a wedged capture teardown is abandoned at its deadline; the rest runs and the database stays open for it", async () => {
    const server = fakeStdioServer("direct", { cleanupChildProcesses: async () => neverSettles });
    const stage = "direct-mode capture and iOS CtrlProxy children";

    const outcome = await shutDown(server);

    expect(server.calls).toEqual([
      ...teardownsInOrder,
      "drainDatabaseWrites",
      "settleMigrations",
      "closeLogger",
    ]);
    expect(outcome).toEqual({
      exitCode: 1,
      // The late settle stage's deadline (8,375 ms) less the margins it keeps for the close.
      exitedAtMs: 8_225,
      warnings: [
        `Shutdown cleanup stage ${stage} timed out after 2000ms waiting on recording stop/finalize and iOS CtrlProxy child exit; continuing shutdown`,
        `Shutdown stage(s) still running 5600ms after being abandoned: ${stage}`,
        `Skipping database close because abandoned shutdown stage(s) are still running: ${stage}`,
      ],
    });
    expect(outcome.exitedAtMs).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
  });

  // 7 s is a long recording finalize: the settle stage holds what the short stage list leaves
  // over, so it still ends as a clean shutdown rather than being cut off mid-finalize.
  test.each([3_000, 7_000])(
    "a capture teardown that finishes after its deadline, at %d ms, is a clean shutdown and the database closes after its last write",
    async (finishesAtMs) => {
      const timer = new FakeTimer();
      const server = fakeStdioServer("direct", {
        cleanupChildProcesses: async () => {
          await timer.sleep(finishesAtMs);
          server.database.write();
        },
      });

      const outcome = await shutDown(server, timer);

      expect(outcome.exitCode).toBe(0);
      expect(outcome.exitedAtMs).toBe(finishesAtMs);
      expect(outcome.warnings).toHaveLength(1);
      expect(server.calls.slice(-4)).toEqual([
        "drainDatabaseWrites",
        "settleMigrations",
        "closeDatabase",
        "closeLogger",
      ]);
    },
  );

  test("a capture teardown that fails after its deadline fails the shutdown and is reported by name", async () => {
    const timer = new FakeTimer();
    const server = fakeStdioServer("direct", {
      cleanupChildProcesses: async () => {
        await timer.sleep(3_000);
        throw new Error("simctl io terminated");
      },
    });

    const outcome = await shutDown(server, timer);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.warnings.at(-1)).toBe(
      "Shutdown cleanup stage direct-mode capture and iOS CtrlProxy children failed after being abandoned at its deadline",
    );
    expect(server.database.closes).toBe(1);
  });

  test("a wedged adb kill-server never touches the database, so the database still closes", async () => {
    const server = fakeStdioServer("direct", { stopManagedAdbServer: async () => neverSettles });

    const outcome = await shutDown(server);

    expect(outcome.exitCode).toBe(1);
    expect(server.database.closes).toBe(1);
    expect(server.calls.at(-1)).toBe("closeLogger");
    expect(outcome.warnings.filter((warning) => warning.startsWith("Skipping"))).toEqual([]);
  });
});

describe("stdio direct-mode writes after the database close (#11601)", () => {
  test("an in-flight tool call's write after the close is refused and reported with its count", async () => {
    const server = fakeStdioServer("direct");
    let refusal: unknown;
    // Direct mode has no stage that owns a tool call: nothing keeps the database open for it.
    server.onDatabaseClosed = () => {
      refusal = captureThrown(() => server.database.write());
    };

    const outcome = await shutDown(server);

    expect(refusal).toEqual(new Error("database used after close"));
    expect(outcome.exitCode).toBe(0);
    expect(server.calls.slice(-2)).toEqual(["closeDatabase", "closeLogger"]);
    expect(server.warnings).toEqual([
      "Refused 1 database access(es) issued after the shutdown database close; no abandoned shutdown stage was running (an in-flight request or a late timer callback)",
    ]);
  });

  test("proxy mode owns no database and never asks for a refusal count", async () => {
    const server = fakeStdioServer("proxy");

    await shutDown(server);

    expect(server.refusalCountReads).toBe(0);
    expect(server.warnings).toEqual([]);
  });
});

describe("stdio shutdown in proxy mode (#11601)", () => {
  test("never touches captures, adb or the database, and closes the proxy before the logger", async () => {
    const server = fakeStdioServer("proxy");

    const outcome = await shutDown(server);

    expect(outcome).toEqual({ exitCode: 0, exitedAtMs: 0, warnings: [] });
    expect(server.calls).toEqual([
      ...teardownsInOrder.filter(
        (name) => name !== "cleanupChildProcesses" && name !== "stopManagedAdbServer",
      ),
      "closeLogger",
    ]);
  });

  test("a wedged proxy close is abandoned by name and the logger still closes inside the limit", async () => {
    const server = fakeStdioServer("proxy", { closeStdioProxy: async () => neverSettles });

    const outcome = await shutDown(server);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.warnings[0]).toBe(
      "Shutdown cleanup stage stdio proxy timed out after 4695ms waiting on the daemon releasing this proxy's managed execution sessions; continuing shutdown",
    );
    expect(server.calls.at(-1)).toBe("closeLogger");
    expect(server.database.closes).toBe(0);
    expect(outcome.exitedAtMs).toBeLessThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
  });
});
