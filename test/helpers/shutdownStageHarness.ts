import { spyOn } from "bun:test";
import { PROCESS_SHUTDOWN_TIMEOUT_MS, ProcessLifecycleHandlers } from "../../src/processLifecycle";
import { runShutdownCleanupStages, type ShutdownCleanupStage } from "../../src/shutdownCleanup";
import { FakeProcess } from "../fakes/FakeProcess";
import type { FakeTimer } from "../fakes/FakeTimer";

/** Work that never settles: a wedged shutdown stage. */
export const neverSettles = new Promise<void>(() => {});

// A whole stage table of stages that finish at once is a few hundred microtask turns long.
const QUIESCENT_MICROTASK_TURNS = 400;

/** Let every promise chain that needs no further fake time run to its next wait. */
export async function flushMicrotasks(turns = QUIESCENT_MICROTASK_TURNS): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

/**
 * Advance fake time from one due timer to the next, letting the work each one wakes run before
 * the next fires, until `untilMs` or until `done()`. Time never moves while work is runnable, so
 * what a test observes does not depend on a step size.
 */
export async function runFakeTime(
  timer: FakeTimer,
  untilMs: number,
  done: () => boolean = () => false,
): Promise<void> {
  await flushMicrotasks();
  while (!done() && timer.now() < untilMs) {
    const nextMs = timer.getMsUntilNextDueEvent();
    if (nextMs === undefined) {
      return;
    }
    timer.advanceTime(Math.min(nextMs, untilMs - timer.now()));
    await flushMicrotasks();
  }
}

/** A database connection that fails loudly when anything uses it after it was closed. */
export class FakeShutdownDatabase {
  closes = 0;
  drains = 0;
  private closed = false;

  write(): void {
    if (this.closed) {
      throw new Error("database used after close");
    }
  }

  async drain(): Promise<void> {
    this.drains++;
  }

  async close(): Promise<void> {
    this.closes++;
    this.closed = true;
  }
}

class ExitRecordingProcess extends FakeProcess {
  exitedAtMs: number | undefined;

  constructor(private readonly timer: FakeTimer) {
    super();
  }

  override exit(code = 0): never {
    this.exitedAtMs ??= this.timer.now();
    return super.exit(code);
  }
}

export interface ShutdownOutcome {
  exitCode: number | undefined;
  exitedAtMs: number | undefined;
  warnings: string[];
}

/**
 * Run a stage list as the process's shutdown handler under the real 9 s process limit and report
 * how the process exited. Fake time runs on past the exit, so a stage that settles after it is
 * observed too. `warnings` collects what the failure reporter was told.
 */
export async function shutDownProcess(
  timer: FakeTimer,
  stages: readonly ShutdownCleanupStage[],
  warnings: string[] = [],
): Promise<ShutdownOutcome> {
  const fakeProcess = new ExitRecordingProcess(timer);
  const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer);
  lifecycle.install();
  lifecycle.setShutdownHandler(() =>
    runShutdownCleanupStages(stages, (message) => warnings.push(message), {
      timer,
      emergencyLog: (message) => warnings.push(`emergency: ${message}`),
    }),
  );
  // The lifecycle writes an emergency line to stderr for a failed shutdown; keep it out of the
  // test output.
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    fakeProcess.emit("SIGTERM");
    await runFakeTime(timer, PROCESS_SHUTDOWN_TIMEOUT_MS + 500);
  } finally {
    stderr.mockRestore();
  }
  return { exitCode: fakeProcess.exitCodes[0], exitedAtMs: fakeProcess.exitedAtMs, warnings };
}

/**
 * Whether `work` settles without the real event loop turning: only microtasks run here, so real
 * I/O (a file read, a socket close, a real timer) can never complete. Use it to prove a shutdown
 * built from fakes awaits nothing real — the condition under which a FakeTimer deadline cannot
 * race real I/O.
 */
export async function settlesOnMicrotasksAlone(
  work: Promise<unknown>,
  maxTurns = 20_000,
): Promise<boolean> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void work.then(mark, mark);
  for (let turn = 0; turn < maxTurns && !settled; turn++) {
    await Promise.resolve();
  }
  return settled;
}
