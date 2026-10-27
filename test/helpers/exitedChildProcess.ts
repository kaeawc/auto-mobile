import { StreamlessChildProcess } from "./streamlessChildProcess";

/**
 * A tracked child that has already exited: it reports a non-null `exitCode` and fails the test
 * if anything tries to kill it.
 */
export class ExitedChildProcess extends StreamlessChildProcess {
  constructor(pid = 42, exitCode = 1) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
  }

  override kill(): boolean {
    throw new Error("An exited process must not be killed");
  }
}
