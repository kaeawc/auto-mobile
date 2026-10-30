import { afterEach, describe, expect, test } from "bun:test";
import {
  DAEMON_STARTUP_STAGES,
  runStartupStages,
} from "../../src/daemon/daemonCore/daemonStartupStages";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

describe("runStartupStages", () => {
  test("runs synchronous stages without yielding to the caller", () => {
    const ran: string[] = [];
    void runStartupStages([
      { name: "a", run: () => ran.push("a") },
      { name: "b", run: () => ran.push("b") },
    ]);
    expect(ran).toEqual(["a", "b"]);
  });

  test("waits for an async stage before starting the next", async () => {
    const ran: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runStartupStages([
      { name: "async", run: () => gate.then(() => ran.push("async")) },
      { name: "after", run: () => ran.push("after") },
    ]);
    await Promise.resolve();
    expect(ran).toEqual([]);
    release();
    await run;
    expect(ran).toEqual(["async", "after"]);
  });

  test("stops at the first failure, reports its stage and rethrows the same error", async () => {
    const failure = new Error("bind failed");
    const failedStages: string[] = [];
    const ran: string[] = [];
    const run = runStartupStages(
      [
        { name: "first", run: () => ran.push("first") },
        {
          name: "bind",
          run: async () => {
            throw failure;
          },
        },
        { name: "never", run: () => ran.push("never") },
      ],
      (name) => failedStages.push(name),
    );
    expect(await run.catch((error: unknown) => error)).toBe(failure);
    expect(ran).toEqual(["first"]);
    expect(failedStages).toEqual(["bind"]);
  });
});

describe("Daemon startup stage list", () => {
  afterEach(() => {
    // The constructor publishes onto the process-wide DaemonState (#11614).
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("start() runs every DAEMON_STARTUP_STAGES row once, in table order", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon(
      { port: 3171 },
      {
        timer,
        deviceSessionRepository: new DeviceSessionRepository(await createTestDatabase(), timer),
        idGenerator: new FakeIdGenerator(),
        processBirthTime: () => 0,
        processGenerationToken: () => "memory-generation",
      },
    );
    const names: string[] = daemon.testHooks.startupStageNames();
    expect(names).toEqual(Object.keys(DAEMON_STARTUP_STAGES));
    daemon.testHooks.stopSessionTimers();
  });
});
