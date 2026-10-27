import { IosTapStrategy } from "../../src/features/action/strategies/IosTapStrategy";
import type { TapBoundsClip, TapStrategy } from "../../src/utils/interfaces/TapStrategy";
import type { Element, ElementBounds, ObserveResult, ViewHierarchyResult } from "../../src/models";
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
  warnsOnDisabledElement: boolean = true;
  settlesPostTapChange: boolean = true;
  verifiesRefreshedDisplay: boolean = true;
  promotesClickableAncestor: boolean = true;
  settlesFocusChangeAfterTap: boolean = false;
  rethrowsKeyboardOcclusion: boolean = true;

  /**
   * A fake whose policy flags match {@link IosTapStrategy}'s (#13316). The default constructor keeps
   * Android's flags (with retries off), which an iOS-path test must not inherit: it would warn on
   * disabled elements, settle and re-verify displays, and promote ancestors where iOS does not.
   */
  static ios(): FakeTapStrategy {
    const fake = new FakeTapStrategy();
    fake.longPressDurationMs = 1000;
    fake.warnsOnDisabledElement = false;
    fake.settlesPostTapChange = false;
    fake.verifiesRefreshedDisplay = false;
    fake.promotesClickableAncestor = false;
    fake.settlesFocusChangeAfterTap = true;
    fake.rethrowsKeyboardOcclusion = false;
    return fake;
  }
  /** Restamps nothing by default; iOS-parity tests may record via `refreshedRotations`. */
  readonly refreshedRotations: Array<number | undefined> = [];

  private readonly iosClip = new IosTapStrategy({
    name: "fake",
    platform: "ios",
    deviceId: "fake",
  });
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

  clipNavigationTapBounds(
    bounds: ElementBounds,
    hierarchy: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"] | undefined,
    elements: readonly Element[],
  ): TapBoundsClip {
    this.executedOperations.push("clipNavigationTapBounds");
    // Real iOS clipping (a no-op for hierarchies without captured chrome), so tests that
    // drive an iOS device through this fake keep the navigation-bar refusal behaviour.
    return this.iosClip.clipNavigationTapBounds(bounds, hierarchy, screenSize, elements);
  }

  applyRefreshedObservationRotation(
    _observation: ObserveResult,
    hierarchyRotation: number | undefined,
  ): void {
    this.executedOperations.push("applyRefreshedObservationRotation");
    this.refreshedRotations.push(hierarchyRotation);
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
