import { describe, expect, spyOn, test } from "bun:test";
import {
  closeLoggerAfterCommittedResult,
  exitAfterSuccessfulDaemonCommand,
  type CompletedDaemonCommandLogger,
  type DaemonCommandProcessTerminator,
} from "../../src/cli/daemonCommandExit";

class FakeCompletedDaemonCommandLogger implements CompletedDaemonCommandLogger {
  readonly warnings: string[] = [];
  private readonly pendingWarnings: string[] = [];

  constructor(private readonly closeError?: Error) {}

  async closeAfterFlush(): Promise<void> {
    if (this.closeError) {
      throw this.closeError;
    }
  }

  async flush(): Promise<void> {
    await Promise.resolve();
    this.warnings.push(...this.pendingWarnings.splice(0));
  }

  warn(message: string): void {
    this.pendingWarnings.push(message);
  }
}

class FakeDaemonCommandProcessTerminator implements DaemonCommandProcessTerminator {
  readonly exitCodes: number[] = [];

  exit(exitCode: number): void {
    this.exitCodes.push(exitCode);
  }
}

describe("closeLoggerAfterCommittedResult", () => {
  test("warns and flushes without throwing when logger teardown rejects", async () => {
    const logger = new FakeCompletedDaemonCommandLogger(new Error("write after end"));

    await expect(closeLoggerAfterCommittedResult(logger)).resolves.toBeUndefined();

    expect(logger.warnings).toEqual([
      "Daemon command completed successfully, but logger teardown failed; exiting 0: write after end",
    ]);
  });

  test("resolves silently when logger teardown succeeds", async () => {
    const logger = new FakeCompletedDaemonCommandLogger();
    const warnSpy = spyOn(logger, "warn");
    const flushSpy = spyOn(logger, "flush");
    try {
      await expect(closeLoggerAfterCommittedResult(logger)).resolves.toBeUndefined();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(flushSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      flushSpy.mockRestore();
    }
  });
});

describe("exitAfterSuccessfulDaemonCommand", () => {
  test("keeps a committed heartbeat at exit 0 when overlapping prefetch logging rejects teardown", async () => {
    const logger = new FakeCompletedDaemonCommandLogger(new Error("write after end"));
    const terminator = new FakeDaemonCommandProcessTerminator();

    await exitAfterSuccessfulDaemonCommand(logger, terminator);

    expect(terminator.exitCodes).toEqual([0]);
    expect(logger.warnings).toEqual([
      "Daemon command completed successfully, but logger teardown failed; exiting 0: write after end",
    ]);
  });

  test("exits 0 after a committed heartbeat when logger teardown succeeds", async () => {
    const logger = new FakeCompletedDaemonCommandLogger();
    const terminator = new FakeDaemonCommandProcessTerminator();

    await exitAfterSuccessfulDaemonCommand(logger, terminator);

    expect(terminator.exitCodes).toEqual([0]);
    expect(logger.warnings).toEqual([]);
  });
});
