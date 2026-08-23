import { CtrlProxyIosManager, CtrlProxyIosSetupResult } from "../../src/utils/IOSCtrlProxyManager";
import { PerformanceTracker } from "../../src/utils/PerformanceTracker";

/**
 * Fake implementation of CtrlProxyIosManager for testing
 * Allows configuring service state and asserting operations
 */
export class FakeIOSCtrlProxyManager implements CtrlProxyIosManager {
  private installedState: boolean = false;
  private runningState: boolean = false;
  private availableState: boolean = false;
  private executedOperations: string[] = [];
  private servicePort: number = 8765;
  private reportedRunnerPort: number | null = null;
  private shouldStartFail: boolean = false;
  private shouldStopFail: boolean = false;
  private shouldSetupFail: boolean = false;
  private shouldForceRestartFail: boolean = false;
  private shouldIsRunningFail: boolean = false;
  private lastSetupMinimumHealthPollDurationMs: number | undefined;

  // MARK: - Configuration Methods

  /**
   * Set whether the CtrlProxy iOS is installed
   */
  setInstalled(installed: boolean): void {
    this.installedState = installed;
  }

  /**
   * Set whether the CtrlProxy iOS is running
   */
  setRunning(running: boolean): void {
    this.runningState = running;
  }

  /**
   * Set whether the CtrlProxy iOS is available (installed AND running)
   */
  setAvailable(available: boolean): void {
    this.availableState = available;
  }

  /**
   * Set the service port
   */
  setServicePort(port: number): void {
    this.servicePort = port;
  }

  /**
   * Set the port the runner reports it is bound to (via /health)
   */
  setReportedRunnerPort(port: number | null): void {
    this.reportedRunnerPort = port;
  }

  /**
   * Configure start() to fail
   */
  setStartShouldFail(shouldFail: boolean): void {
    this.shouldStartFail = shouldFail;
  }

  /**
   * Configure stop() to fail
   */
  setStopShouldFail(shouldFail: boolean): void {
    this.shouldStopFail = shouldFail;
  }

  /**
   * Configure setup() to fail
   */
  setSetupShouldFail(shouldFail: boolean): void {
    this.shouldSetupFail = shouldFail;
  }

  /**
   * Configure forceRestart() to reject. Exercises the client's restart-failure
   * (catch) branch, which must reset its in-flight-restart guard so later
   * failures can retry.
   */
  setForceRestartShouldFail(shouldFail: boolean): void {
    this.shouldForceRestartFail = shouldFail;
  }

  /**
   * Configure isRunning() to reject. Exercises the client's status-probe-failure
   * (outer catch) branch, which must reset its in-flight-restart guard so a later
   * threshold crossing probes/restarts again rather than being suppressed forever.
   */
  setIsRunningShouldFail(shouldFail: boolean): void {
    this.shouldIsRunningFail = shouldFail;
  }

  // MARK: - Assertion Methods

  /**
   * Get history of executed operations (for test assertions)
   */
  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  /**
   * Check if a specific method was called
   */
  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some((op) => op.includes(operationName));
  }

  /**
   * Get count of times a specific method was called
   */
  getCallCount(operationName: string): number {
    return this.executedOperations.filter((op) => op.includes(operationName)).length;
  }

  getLastSetupMinimumHealthPollDurationMs(): number | undefined {
    return this.lastSetupMinimumHealthPollDurationMs;
  }

  /**
   * Clear operation history
   */
  clearHistory(): void {
    this.executedOperations = [];
  }

  // MARK: - CtrlProxyIosManager Implementation

  async isInstalled(): Promise<boolean> {
    this.executedOperations.push("isInstalled");
    return this.installedState;
  }

  async isRunning(): Promise<boolean> {
    this.executedOperations.push("isRunning");
    if (this.shouldIsRunningFail) {
      throw new Error("FakeIOSCtrlProxyManager: isRunning failure (test seam)");
    }
    return this.runningState;
  }

  async isAvailable(): Promise<boolean> {
    this.executedOperations.push("isAvailable");
    return this.availableState;
  }

  getServicePort(): number {
    this.executedOperations.push("getServicePort");
    return this.servicePort;
  }

  async getReportedRunnerPort(): Promise<number | null> {
    this.executedOperations.push("getReportedRunnerPort");
    return this.reportedRunnerPort;
  }

  async start(): Promise<void> {
    this.executedOperations.push("start");

    if (this.shouldStartFail) {
      throw new Error("Failed to start IOSCtrlProxy");
    }

    this.runningState = true;
  }

  async stop(): Promise<void> {
    this.executedOperations.push("stop");

    if (this.shouldStopFail) {
      throw new Error("Failed to stop IOSCtrlProxy");
    }

    this.runningState = false;
  }

  async setup(
    force: boolean = false,
    perf?: PerformanceTracker,
    _signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<CtrlProxyIosSetupResult> {
    this.executedOperations.push(`setup:force=${force}`);
    this.lastSetupMinimumHealthPollDurationMs = minimumHealthPollDurationMs;

    if (this.shouldSetupFail) {
      return {
        success: false,
        message: "Failed to setup IOSCtrlProxy",
        error: "Mock setup failure",
      };
    }

    if (force || !this.runningState) {
      this.runningState = true;
      return {
        success: true,
        message: "IOSCtrlProxy started successfully",
      };
    }

    return {
      success: true,
      message: "IOSCtrlProxy was already running",
    };
  }

  // MARK: - Auto-restart Methods

  private autoRestartEnabled: boolean = false;

  setAutoRestart(enabled: boolean): void {
    this.executedOperations.push(`setAutoRestart:${enabled}`);
    this.autoRestartEnabled = enabled;
  }

  isAutoRestartEnabled(): boolean {
    this.executedOperations.push("isAutoRestartEnabled");
    return this.autoRestartEnabled;
  }

  async forceRestart(): Promise<void> {
    this.executedOperations.push("forceRestart");

    if (this.shouldForceRestartFail) {
      throw new Error("Failed to force-restart IOSCtrlProxy");
    }

    this.runningState = true;
  }

  resetSetupState(): void {
    this.executedOperations.push("resetSetupState");
  }
}
