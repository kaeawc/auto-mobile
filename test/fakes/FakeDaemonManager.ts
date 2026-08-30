import type { DaemonManagerLike } from "../../src/daemon/manager";
import type { DaemonStatus, DaemonOptions } from "../../src/daemon/types";

/**
 * Fake DaemonManager for testing — implements DaemonManagerLike directly,
 * no subclassing of the concrete DaemonManager required.
 */
export class FakeDaemonManager implements DaemonManagerLike {
  statusResult: DaemonStatus = {
    running: true,
    pid: 1234,
    port: 3000,
    socketPath: "/tmp/test.sock",
  };
  statusResults: DaemonStatus[] = [];
  startCalled = false;
  startCallCount = 0;
  startOptions: DaemonOptions | undefined;
  restartCalled = false;
  restartCallCount = 0;
  restartOptions: DaemonOptions | undefined;
  waitForReadyResult = true;
  waitForReadyCallCount = 0;
  startupLockHeldByLiveProcess = false;

  async status(): Promise<DaemonStatus> {
    const nextStatus = this.statusResults.shift();
    if (nextStatus) {
      return nextStatus;
    }
    return this.statusResult;
  }

  async start(options: DaemonOptions = {}): Promise<void> {
    this.startCalled = true;
    this.startCallCount++;
    this.startOptions = options;
  }

  async restart(options: DaemonOptions = {}): Promise<void> {
    this.restartCalled = true;
    this.restartCallCount++;
    this.restartOptions = options;
  }

  async waitForReady(_timeout: number): Promise<boolean> {
    this.waitForReadyCallCount++;
    return this.waitForReadyResult;
  }

  isStartupLockHeldByLiveProcess(): boolean {
    return this.startupLockHeldByLiveProcess;
  }

  /**
   * Default fake: delegate to `waitForReady` with the live-holder predicate, so
   * subclasses that model readiness by overriding `waitForReady` keep driving this
   * path and the timeout / predicate they observe are unchanged (issue #5904).
   * Override for tests that need to model replacement re-arbitration directly.
   */
  async waitForLockHolderReadiness(timeoutMs: number): Promise<boolean> {
    return this.waitForReady(timeoutMs, undefined, () => this.isStartupLockHeldByLiveProcess());
  }
}
