import { EventEmitter } from "node:events";
import type { HostChildProcess } from "../HostCommandExecutor";

/**
 * An honest launch handle for a simulator boot. `simctl bootstatus -b` is
 * synchronous, so there is no OS child process: `pid` is undefined, there are
 * no stdio pipes, and `kill` performs whatever cancellation the caller supplies
 * (issue #3938).
 */
export function createSimulatorLaunchHandle(kill: () => boolean): HostChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    kill,
    killed: false,
    exitCode: 0,
    signalCode: null,
    unref: (): void => {
      // No OS process to detach from.
    },
  });
}
