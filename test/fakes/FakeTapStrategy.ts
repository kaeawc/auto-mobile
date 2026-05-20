import type { TapStrategy } from "../../src/utils/interfaces/TapStrategy";
import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyResult,
} from "../../src/models";
import type { TapOnElementOptions } from "../../src/models/TapOnElementOptions";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { IOSCtrlProxy } from "../../src/features/observe/ios";
import type { ViewHierarchy } from "../../src/features/observe/ViewHierarchy";

/**
 * Minimal recording fake for {@link TapStrategy}. Mirrors the
 * `executedOperations` / `wasMethodCalled` / `getCallCount` /
 * `clearHistory` pattern used by `FakeProxyManager` and
 * `FakeSnapshotProvider`.
 */
export class FakeTapStrategy implements TapStrategy {
  private accessibilityEnabled: boolean = false;
  private preTapStabilityGate: boolean = false;
  private retryIfNoChangeGate: boolean = false;
  private longPressMs: number = 500;
  private filterReturnsRaw: boolean = false;
  private readonly executedOperations: string[] = [];

  setAccessibilityServiceEnabled(enabled: boolean): void {
    this.accessibilityEnabled = enabled;
  }

  setShouldRunPreTapStability(enabled: boolean): void {
    this.preTapStabilityGate = enabled;
  }

  setShouldRetryTapIfNoChange(enabled: boolean): void {
    this.retryIfNoChangeGate = enabled;
  }

  setLongPressDurationMs(ms: number): void {
    this.longPressMs = ms;
  }

  /** When `true`, `prepareViewHierarchyForResponse` returns `null` (caller uses raw). */
  setFilterReturnsRaw(returnsRaw: boolean): void {
    this.filterReturnsRaw = returnsRaw;
  }

  getExecutedOperations(): string[] {
    return [...this.executedOperations];
  }

  wasMethodCalled(operationName: string): boolean {
    return this.executedOperations.some(op => op.includes(operationName));
  }

  getCallCount(operationName: string): number {
    return this.executedOperations.filter(op => op.includes(operationName)).length;
  }

  clearHistory(): void {
    this.executedOperations.length = 0;
  }

  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    _viewHierarchy: ViewHierarchy,
    _screenSize?: ObserveResult["screenSize"]
  ): ViewHierarchyResult | null {
    this.executedOperations.push("prepareViewHierarchyForResponse");
    return this.filterReturnsRaw ? null : rawHierarchy;
  }

  async isAccessibilityServiceEnabled(
    _device: BootedDevice,
    _adb: AdbExecutor,
    _iosCtrlProxy: IOSCtrlProxy
  ): Promise<boolean> {
    this.executedOperations.push("isAccessibilityServiceEnabled");
    return this.accessibilityEnabled;
  }

  shouldRunPreTapStability(_options: TapOnElementOptions): boolean {
    this.executedOperations.push("shouldRunPreTapStability");
    return this.preTapStabilityGate;
  }

  shouldRetryTapIfNoChange(): boolean {
    this.executedOperations.push("shouldRetryTapIfNoChange");
    return this.retryIfNoChangeGate;
  }

  getLongPressDurationMs(): number {
    this.executedOperations.push("getLongPressDurationMs");
    return this.longPressMs;
  }
}
