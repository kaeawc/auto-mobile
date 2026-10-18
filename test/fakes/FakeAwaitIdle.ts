import type { AwaitIdle, UiStabilityState } from "../../src/features/observe/interfaces/AwaitIdle";
import type { GfxMetrics } from "../../src/models";
import { throwIfAborted } from "../../src/utils/toolUtils";

/**
 * Fake implementation of AwaitIdle for testing
 * Allows configuring idle tracking responses and asserting method calls
 */
export class FakeAwaitIdle implements AwaitIdle {
  private executedOperations: string[] = [];
  private initializeCallCount: number = 0;
  private waitForUiStabilityCallCount: number = 0;
  private waitForUiStabilityWithStateCallCount: number = 0;
  private configuredGfxMetrics: GfxMetrics | null = null;
  private configuredUiStabilityState: UiStabilityState | null = null;
  private initializeSignal: AbortSignal | undefined;
  private configuredRotation: number | null = null;

  /**
   * Configure the GfxMetrics to be returned by waitForUiStability methods
   */
  configureGfxMetrics(metrics: GfxMetrics | null): void {
    this.configuredGfxMetrics = metrics;
  }

  /**
   * Configure the UiStabilityState to be returned by initializeUiStabilityTracking
   */
  configureUiStabilityState(state: UiStabilityState): void {
    this.configuredUiStabilityState = state;
  }

  /**
   * Configure the rotation the device reports. waitForRotation then rejects with the
   * real timeout error for any other target. Unset (default) rotates immediately.
   */
  configureRotation(rotation: number | null): void {
    this.configuredRotation = rotation;
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
    this.initializeCallCount = 0;
    this.waitForUiStabilityCallCount = 0;
    this.waitForUiStabilityWithStateCallCount = 0;
    this.initializeSignal = undefined;
  }

  /**
   * Get total initializeUiStabilityTracking call count
   */
  getInitializeCallCount(): number {
    return this.initializeCallCount;
  }

  getInitializeSignal(): AbortSignal | undefined {
    return this.initializeSignal;
  }

  /**
   * Get total waitForUiStability call count
   */
  getWaitForUiStabilityCallCount(): number {
    return this.waitForUiStabilityCallCount;
  }

  /**
   * Get total waitForUiStabilityWithState call count
   */
  getWaitForUiStabilityWithStateCallCount(): number {
    return this.waitForUiStabilityWithStateCallCount;
  }

  // Implementation of AwaitIdle interface

  async initializeUiStabilityTracking(
    packageName: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<UiStabilityState> {
    throwIfAborted(signal);
    this.executedOperations.push(`initializeUiStabilityTracking(${packageName}, ${timeoutMs})`);
    this.initializeCallCount++;
    this.initializeSignal = signal;

    if (this.configuredUiStabilityState) {
      return this.configuredUiStabilityState;
    }

    const now = Date.now();
    return {
      startTime: now,
      lastNonIdleTime: now,
      prevMissedVsync: null,
      prevSlowUiThread: null,
      prevFrameDeadlineMissed: null,
      prevTotalFrames: null,
      firstGfxInfoLog: true,
    };
  }

  async waitForUiStability(
    packageName: string,
    timeoutMs: number,
    _perf?: any,
    signal?: AbortSignal,
  ): Promise<GfxMetrics | null> {
    throwIfAborted(signal);
    this.executedOperations.push(`waitForUiStability(${packageName}, ${timeoutMs})`);
    this.waitForUiStabilityCallCount++;
    return this.configuredGfxMetrics;
  }

  async waitForUiStabilityWithState(
    packageName: string,
    timeoutMs: number,
    _initState: UiStabilityState,
    _perf?: any,
    signal?: AbortSignal,
  ): Promise<GfxMetrics | null> {
    throwIfAborted(signal);
    this.executedOperations.push(`waitForUiStabilityWithState(${packageName}, ${timeoutMs})`);
    this.waitForUiStabilityWithStateCallCount++;
    return this.configuredGfxMetrics;
  }

  async waitForRotation(
    targetRotation: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.executedOperations.push(`waitForRotation(${targetRotation}, ${timeoutMs ?? 500})`);
    // No delay: a device that never reaches the target fails immediately like the
    // real wait does once its budget is spent.
    if (this.configuredRotation !== null && this.configuredRotation !== targetRotation) {
      throw new Error(
        `Timeout waiting for rotation to ${targetRotation} after ${timeoutMs ?? 500}ms`,
      );
    }
  }
}
