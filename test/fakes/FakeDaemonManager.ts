import type {
  DaemonManagerLike,
  DaemonRestartResult,
  DaemonStartResult,
} from "../../src/daemon/manager";
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
  recoverControlStateCalled = false;
  recoverControlStateCallCount = 0;
  recoverControlStateOptions: DaemonOptions | undefined;
  recoverControlStateResult: DaemonRestartResult = "restarted";
  restartCalled = false;
  restartCallCount = 0;
  restartOptions: DaemonOptions | undefined;
  restartExpectedDaemon: DaemonStatus | undefined;
  restartResult: DaemonRestartResult = "restarted";
  restartAdmittedCallCount = 0;
  restartAdmittedOptions: DaemonOptions | undefined;
  restartAdmittedToken: string | undefined;
  restartAdmittedResult: DaemonRestartResult = "restarted";
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

  async start(options: DaemonOptions = {}): Promise<DaemonStartResult> {
    this.startCalled = true;
    this.startCallCount++;
    this.startOptions = options;
    return "started";
  }

  async recoverControlState(options: DaemonOptions = {}): Promise<DaemonRestartResult> {
    this.recoverControlStateCalled = true;
    this.recoverControlStateCallCount++;
    this.recoverControlStateOptions = options;
    return this.recoverControlStateResult;
  }

  async restart(
    options: DaemonOptions = {},
    expectedDaemon?: DaemonStatus,
  ): Promise<DaemonRestartResult> {
    this.restartCalled = true;
    this.restartCallCount++;
    this.restartOptions = options;
    this.restartExpectedDaemon = expectedDaemon;
    return this.restartResult;
  }

  async restartAdmitted(
    options: DaemonOptions,
    maintenanceToken: string,
  ): Promise<DaemonRestartResult> {
    this.restartAdmittedCallCount++;
    this.restartAdmittedOptions = options;
    this.restartAdmittedToken = maintenanceToken;
    return this.restartAdmittedResult;
  }

  async waitForReady(
    timeout: number,
    {
      signal,
      shouldContinueWaiting: _shouldContinueWaiting,
    }: { signal?: AbortSignal; shouldContinueWaiting?: () => boolean } = {},
  ): Promise<boolean> {
    this.waitForReadyCallCount++;
    // The real wait checks its loop bound and the caller's signal before it ever
    // probes the socket, so a spent budget or a cancelled wait is never ready.
    if (timeout <= 0 || signal?.aborted) {
      return false;
    }
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
    return this.waitForReady(timeoutMs, {
      shouldContinueWaiting: () => this.isStartupLockHeldByLiveProcess(),
    });
  }
}
