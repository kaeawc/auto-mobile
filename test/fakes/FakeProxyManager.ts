import type { ProxyManager, ProxySetupResult } from "../../src/utils/interfaces/ProxyManager";
import type { PerformanceTracker } from "../../src/utils/PerformanceTracker";

/**
 * Minimal fake implementation of {@link ProxyManager} for testing the
 * platform-agnostic contract. Larger platform-specific fakes
 * (`FakeCtrlProxyManager`, `FakeIOSCtrlProxyManager`) implement richer
 * sub-interfaces; this fake covers only the shared surface so that
 * call-sites depending solely on `ProxyManager` can be exercised
 * without pulling in either platform.
 */
export class FakeProxyManager implements ProxyManager {
  private installedState: boolean = false;
  private availableState: boolean = false;
  private shouldSetupFail: boolean = false;
  private readonly executedOperations: string[] = [];

  setInstalled(installed: boolean): void {
    this.installedState = installed;
  }

  setAvailable(available: boolean): void {
    this.availableState = available;
  }

  setSetupShouldFail(shouldFail: boolean): void {
    this.shouldSetupFail = shouldFail;
  }

  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some((op) => op.includes(operationName));
  }

  getCallCount(operationName: string): number {
    return this.executedOperations.filter((op) => op.includes(operationName)).length;
  }

  clearHistory(): void {
    this.executedOperations.length = 0;
  }

  async isInstalled(): Promise<boolean> {
    this.executedOperations.push("isInstalled");
    return this.installedState;
  }

  async isAvailable(): Promise<boolean> {
    this.executedOperations.push("isAvailable");
    return this.availableState;
  }

  async setup(force: boolean = false, _perf?: PerformanceTracker): Promise<ProxySetupResult> {
    this.executedOperations.push(`setup:force=${force}`);

    if (this.shouldSetupFail) {
      return {
        success: false,
        message: "Failed to setup proxy",
        error: "Mock setup failure",
      };
    }

    return {
      success: true,
      message: "Proxy setup succeeded",
    };
  }

  resetSetupState(): void {
    this.executedOperations.push("resetSetupState");
  }
}
