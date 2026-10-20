import { EventEmitter } from "node:events";
import type { HostChildProcess } from "../HostCommandExecutor";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/**
 * An honest launch handle for a simulator boot. `simctl bootstatus -b` is
 * synchronous, so there is no OS child process: `pid` is undefined, there are
 * no stdio pipes, and `kill` performs whatever cancellation the caller supplies
 * (issue #3938).
 */
class SimulatorLaunchHandle extends EventEmitter implements HostChildProcess {
  readonly pid = undefined;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  killed = false;
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly terminationConfirmed = new Promise<boolean>((resolve) => {
    this.once("exit", () => resolve(this.exitCode === 0));
  });

  constructor(
    private readonly cancel: () => Promise<void>,
    private readonly label: string,
  ) {
    super();
  }

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      void this.shutDown();
    }
    return true;
  }

  private async shutDown(): Promise<void> {
    try {
      await this.cancel();
      this.exitCode = 0;
    } catch (error) {
      logger.warn(
        `[iOS] handle.kill() shutdown failed for ${this.label}: ${errorMessage(error)}`,
        error,
      );
      this.exitCode = 1;
    }
    this.emit("exit", this.exitCode, null);
  }

  unref(): void {
    // No OS process to detach from.
  }
}

export function createSimulatorLaunchHandle(
  kill: () => Promise<void>,
  label = "simulator",
): HostChildProcess {
  return new SimulatorLaunchHandle(kill, label);
}
