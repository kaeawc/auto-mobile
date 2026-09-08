import { ActiveWindow } from "../../src/models";
import type { Window } from "../../src/features/observe/interfaces/Window";
import type { GetActiveOptions } from "../../src/features/observe/Window";
import type { PerformanceTracker } from "../../src/utils/PerformanceTracker";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";

/**
 * Fake implementation of Window for testing
 * Allows configuring window responses and asserting method calls
 */
export class FakeWindow implements Window {
  private executedOperations: string[] = [];
  private configuredCachedActiveWindow: ActiveWindow | null = null;
  private configuredActiveWindow: ActiveWindow | null = null;
  private cachedActiveWindowCallCount: number = 0;
  private getActiveCallCount: number = 0;
  private getActiveForceRefreshes: boolean[] = [];
  private getActiveOptions: GetActiveOptions[] = [];
  private configuredActiveHash: string = "fake-active-hash";
  private throwOnAbortedSignal: boolean = false;

  /**
   * When enabled, getActive rejects with a cancellation error if handed an
   * already-aborted signal (mirrors the real Window.getActive). Off by default
   * so existing suites are unaffected.
   */
  setThrowOnAbortedSignal(value: boolean = true): void {
    this.throwOnAbortedSignal = value;
  }

  /**
   * Configure the cached active window to be returned by getCachedActiveWindow
   */
  configureCachedActiveWindow(window: ActiveWindow | null): void {
    this.configuredCachedActiveWindow = window;
  }

  /**
   * Configure the active window to be returned by getActive
   */
  configureActiveWindow(window: ActiveWindow): void {
    this.configuredActiveWindow = window;
  }

  /**
   * Configure the active hash to be returned by getActiveHash
   */
  configureActiveHash(hash: string): void {
    this.configuredActiveHash = hash;
  }

  /**
   * Get history of executed operations
   */
  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  /**
   * Check if a method was called
   */
  wasMethodCalled(methodName: string): boolean {
    return this.executedOperations.some((op) => op.includes(methodName));
  }

  /**
   * Get call count for a specific method
   */
  getCallCount(methodName: string): number {
    return this.executedOperations.filter((op) => op.includes(methodName)).length;
  }

  /**
   * Clear operation history
   */
  clearHistory(): void {
    this.executedOperations = [];
    this.cachedActiveWindowCallCount = 0;
    this.getActiveCallCount = 0;
    this.getActiveForceRefreshes = [];
    this.getActiveOptions = [];
  }

  /**
   * Get total getCachedActiveWindow call count
   */
  getGetCachedActiveWindowCallCount(): number {
    return this.cachedActiveWindowCallCount;
  }

  /**
   * Get total getActive call count
   */
  getGetActiveCallCount(): number {
    return this.getActiveCallCount;
  }

  getGetActiveForceRefreshes(): boolean[] {
    return [...this.getActiveForceRefreshes];
  }

  /** The `options` argument recorded for each getActive call, in call order. */
  getGetActiveOptions(): GetActiveOptions[] {
    return [...this.getActiveOptions];
  }

  /** The `signal` forwarded into the most recent getActive call, if any. */
  getLastGetActiveSignal(): AbortSignal | undefined {
    return this.getActiveOptions[this.getActiveOptions.length - 1]?.signal;
  }

  // Implementation of Window interface

  async getCachedActiveWindow(): Promise<ActiveWindow | null> {
    this.executedOperations.push("getCachedActiveWindow");
    this.cachedActiveWindowCallCount++;
    return this.configuredCachedActiveWindow;
  }

  async getActive(
    forceRefresh: boolean = false,
    _perf?: PerformanceTracker,
    options: GetActiveOptions = {},
  ): Promise<ActiveWindow> {
    this.executedOperations.push("getActive");
    this.getActiveCallCount++;
    this.getActiveForceRefreshes.push(forceRefresh);
    this.getActiveOptions.push(options);
    // Mimic the real Window.getActive (opt-in): an already-cancelled read rejects
    // so a verification caller propagates the abort instead of masking it.
    if (this.throwOnAbortedSignal && options.signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }
    if (!forceRefresh && this.configuredCachedActiveWindow) {
      return this.configuredCachedActiveWindow;
    }
    if (!this.configuredActiveWindow) {
      throw new Error("No active window configured");
    }
    return this.configuredActiveWindow;
  }

  async getActiveHash(): Promise<string> {
    this.executedOperations.push("getActiveHash");
    return this.configuredActiveHash;
  }

  async setCachedActiveWindow(activeWindow: ActiveWindow): Promise<void> {
    this.executedOperations.push("setCachedActiveWindow");
    this.configuredCachedActiveWindow = activeWindow;
  }

  async clearCache(): Promise<void> {
    this.executedOperations.push("clearCache");
    this.configuredCachedActiveWindow = null;
  }
}
