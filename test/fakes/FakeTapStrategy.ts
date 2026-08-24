import type { TapStrategy } from "../../src/utils/interfaces/TapStrategy";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import type { TapOnElementOptions } from "../../src/models/TapOnElementOptions";
import type { ViewHierarchy } from "../../src/features/observe/ViewHierarchy";

/**
 * Minimal recording fake for {@link TapStrategy}. Mirrors the
 * `executedOperations` / `wasMethodCalled` / `getCallCount` /
 * `clearHistory` pattern used by `FakeProxyManager` and
 * `FakeSnapshotProvider`.
 *
 * The interface's `readonly` fields are exposed as mutable on the fake
 * so tests can twiddle them between assertions.
 */
export class FakeTapStrategy implements TapStrategy {
  longPressDurationMs: number = 500;
  retryTapIfNoChange: boolean = false;

  private accessibilityEnabled: boolean = false;
  private preTapStabilityGate: boolean = false;
  private filterReturnsRaw: boolean = false;
  private readonly executedOperations: string[] = [];

  setAccessibilityServiceEnabled(enabled: boolean): void {
    this.accessibilityEnabled = enabled;
  }

  setShouldRunPreTapStability(enabled: boolean): void {
    this.preTapStabilityGate = enabled;
  }

  /** When `true`, `prepareViewHierarchyForResponse` returns `null` (caller uses raw). */
  setFilterReturnsRaw(returnsRaw: boolean): void {
    this.filterReturnsRaw = returnsRaw;
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

  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    _viewHierarchy: ViewHierarchy,
    _screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult | null {
    this.executedOperations.push("prepareViewHierarchyForResponse");
    return this.filterReturnsRaw ? null : rawHierarchy;
  }

  async isAccessibilityServiceEnabled(): Promise<boolean> {
    this.executedOperations.push("isAccessibilityServiceEnabled");
    return this.accessibilityEnabled;
  }

  shouldRunPreTapStability(_options: TapOnElementOptions): boolean {
    this.executedOperations.push("shouldRunPreTapStability");
    return this.preTapStabilityGate;
  }
}
