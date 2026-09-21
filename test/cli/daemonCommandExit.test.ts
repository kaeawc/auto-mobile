import { describe, expect, test } from "bun:test";
import {
  exitAfterSuccessfulDaemonCommand,
  type CompletedDaemonCommandLogger,
  type DaemonCommandProcessTerminator,
} from "../../src/cli/daemonCommandExit";

class FakeCompletedDaemonCommandLogger implements CompletedDaemonCommandLogger {
  readonly warnings: string[] = [];

  constructor(private readonly closeError?: Error) {}

  async closeAfterFlush(): Promise<void> {
    if (this.closeError) {
      throw this.closeError;
    }
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

class FakeDaemonCommandProcessTerminator implements DaemonCommandProcessTerminator {
  readonly exitCodes: number[] = [];

  exit(exitCode: number): void {
    this.exitCodes.push(exitCode);
  }
}

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
