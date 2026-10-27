import { EventEmitter } from "node:events";
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";

/**
 * A tracked child with no stdio pipes: `stdin`/`stdout`/`stderr` are null (as for a process
 * spawned with ignored stdio) and exit state is set by the test. `kill` is a no-op that reports
 * delivery; emit "exit"/"close" directly to drive the lifecycle.
 */
export class StreamlessChildProcess extends EventEmitter implements HostChildProcess {
  pid: number | undefined = 4242;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killed = false;

  kill(): boolean {
    return true;
  }

  unref(): void {
    // No OS process to detach from.
  }
}
