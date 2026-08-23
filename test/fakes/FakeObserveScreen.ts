import { ObserveResult } from "../../src/models";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../../src/features/observe/interfaces/ObserveScreen";
import type { RawViewHierarchyResult } from "../../src/models/RawViewHierarchyResult";

/**
 * Fake implementation of ObserveScreen for testing
 * Allows configuring observation responses and asserting method calls
 */
export class FakeObserveScreen implements ObserveScreen {
  private executedOperations: string[] = [];
  private configuredObserveResult: ObserveResult | null = null;
  private observeResultFactory: ((index: number) => ObserveResult) | null = null;
  private observeSequence: ObserveResult[] | null = null;
  private executeCallCount: number = 0;
  private getMostRecentCachedObserveResultCallCount: number = 0;
  private failures: Map<string, Error> = new Map();
  private callCounter: number = 0;
  private autoVaryHierarchy: boolean = false;
  private readonly executeOptionsHistory: ObserveScreenExecuteOptions[] = [];

  /**
   * Set the observe result to be returned by execute and getMostRecentCachedObserveResult
   * Can either be a static result or a factory function that creates new results on each
   * call. The factory receives the zero-based call index for ever-changing sequences.
   */
  setObserveResult(result: ObserveResult): void;
  setObserveResult(resultFactory: (index: number) => ObserveResult): void;
  setObserveResult(resultOrFactory: ObserveResult | ((index: number) => ObserveResult)): void {
    if (typeof resultOrFactory === "function") {
      this.observeResultFactory = resultOrFactory as (index: number) => ObserveResult;
      this.configuredObserveResult = null;
      this.observeSequence = null;
    } else {
      this.configuredObserveResult = resultOrFactory;
      this.observeResultFactory = null;
      this.observeSequence = null;
    }
  }

  /**
   * Script a fixed sequence of observations. Each `execute()` returns the next
   * entry; once exhausted the last entry repeats. Lets a settle/wait poll loop be
   * driven through a deterministic transition→stable (or ever-changing) sequence.
   */
  setObserveSequence(results: ObserveResult[]): void {
    if (results.length === 0) {
      throw new Error("FakeObserveScreen: empty sequence");
    }
    this.observeSequence = results;
    this.observeResultFactory = null;
    this.configuredObserveResult = null;
  }

  /**
   * Enable auto-varying hierarchy mode. When enabled, each call adds a unique
   * counter to the viewHierarchy so that BaseVisualChange sees different hashes
   * and doesn't trigger retry loops. Call this in tests where changeExpected=true.
   */
  enableAutoVaryHierarchy(): void {
    this.autoVaryHierarchy = true;
  }

  /**
   * Get the next observe result (either from factory or static)
   */
  private getNextObserveResult(): ObserveResult {
    this.callCounter++;
    const index = this.callCounter - 1;

    let result: ObserveResult;
    if (this.observeSequence) {
      result = this.observeSequence[Math.min(index, this.observeSequence.length - 1)];
    } else if (this.observeResultFactory) {
      result = this.observeResultFactory(index);
    } else if (!this.configuredObserveResult) {
      throw new Error("No observe result configured");
    } else {
      result = this.configuredObserveResult;
    }

    if (this.autoVaryHierarchy && result.viewHierarchy) {
      // Add unique counter to make each observation have a different hash
      result = {
        ...result,
        viewHierarchy: {
          ...result.viewHierarchy,
          _fakeCallId: this.callCounter,
        },
      };
    }

    return result;
  }

  /**
   * Get the configured observe result
   */
  getConfiguredObserveResult(): ObserveResult | null {
    return this.configuredObserveResult;
  }

  /**
   * Configure a failure mode for a specific operation
   * @param operation - The operation name (e.g., "execute", "getMostRecentCachedObserveResult")
   * @param error - The error to throw for this operation
   */
  setFailureMode(operation: string, error: Error | null): void {
    if (error === null) {
      this.failures.delete(operation);
    } else {
      this.failures.set(operation, error);
    }
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
    this.executeCallCount = 0;
    this.getMostRecentCachedObserveResultCallCount = 0;
    this.callCounter = 0;
    this.executeOptionsHistory.length = 0;
  }

  /**
   * Get total execute call count
   */
  getExecuteCallCount(): number {
    return this.executeCallCount;
  }

  /**
   * Get total getMostRecentCachedObserveResult call count
   */
  getGetMostRecentCachedObserveResultCallCount(): number {
    return this.getMostRecentCachedObserveResultCallCount;
  }

  // Implementation of ObserveScreen interface

  async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    this.executedOperations.push("execute");
    this.executeCallCount++;
    this.executeOptionsHistory.push({ ...(options ?? {}) });

    const error = this.failures.get("execute");
    if (error) {
      throw error;
    }

    return this.getNextObserveResult();
  }

  /** Options passed to each `execute()` call, in order. */
  getExecuteOptions(): ObserveScreenExecuteOptions[] {
    return [...this.executeOptionsHistory];
  }

  /** The `minTimestamp` passed to each `execute()` call, in order. */
  getExecuteMinTimestamps(): Array<number | undefined> {
    return this.executeOptionsHistory.map((options) => options.minTimestamp);
  }

  async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
    this.executedOperations.push("getMostRecentCachedObserveResult");
    this.getMostRecentCachedObserveResultCallCount++;

    const error = this.failures.get("getMostRecentCachedObserveResult");
    if (error) {
      throw error;
    }

    return this.getNextObserveResult();
  }

  async appendRawViewHierarchy(result: ObserveResult, _signal?: AbortSignal): Promise<void> {
    this.executedOperations.push("appendRawViewHierarchy");

    const error = this.failures.get("appendRawViewHierarchy");
    if (error) {
      throw error;
    }

    result.rawViewHierarchy = {
      json: '{"fake":true}',
      source: "accessibility-service",
      timestamp: 0,
      device: { deviceId: "fake-device", platform: "android" },
    } as RawViewHierarchyResult;
  }
}
