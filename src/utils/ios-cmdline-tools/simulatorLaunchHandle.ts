import { EventEmitter } from "node:events";
import type { HostChildProcess } from "../HostCommandExecutor";

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
  readonly killed = false;
  readonly exitCode = 0;
  readonly signalCode = null;

  constructor(private readonly cancel: () => boolean) {
    super();
  }

  kill(): boolean {
    return this.cancel();
  }

  unref(): void {
    // No OS process to detach from.
  }
}

export function createSimulatorLaunchHandle(kill: () => boolean): HostChildProcess {
  return new SimulatorLaunchHandle(kill);
}
