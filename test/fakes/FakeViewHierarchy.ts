import type {
  HierarchyReadOptions,
  ViewHierarchy,
} from "../../src/features/observe/interfaces/ViewHierarchy";
import type { Element, ScreenIdentity, ViewHierarchyResult } from "../../src/models";
import {
  resolveViewHierarchyReadArgs,
  type ViewHierarchyReadRequest,
} from "../../src/features/observe/hierarchyReadArgs";
import type { ViewHierarchyQueryOptions } from "../../src/models/ViewHierarchyQueryOptions";
import {
  findAccessibilityFocusedElement,
  findFocusedElement,
} from "../../src/features/observe/HierarchyFocus";
import { filterOffscreenNodes } from "../../src/features/observe/HierarchyNormalization";

/**
 * Fake implementation of ViewHierarchy for testing.
 * Returns configurable responses and records all calls.
 */
export class FakeViewHierarchy implements ViewHierarchy {
  private calls: { skipWaitForFresh?: boolean; minTimestamp?: number }[] = [];
  private readOptionsByCall: (number | HierarchyReadOptions | undefined)[] = [];
  private recompositionTrackingCalls = 0;
  private configuredHierarchy: ViewHierarchyResult = { hierarchy: {} };
  private configuredHierarchySequence: ViewHierarchyResult[] = [];
  private configuredFocusedElement: Element | null = null;
  private configuredAccessibilityFocusedElement: Element | null = null;
  private configuredScreenIdentity: ScreenIdentity | undefined;
  private shouldFail = false;
  private failureError: Error | null = null;

  /**
   * Get the view hierarchy (fake implementation).
   */
  async getViewHierarchy(
    _queryOptions?: ViewHierarchyQueryOptions,
    request?: ViewHierarchyReadRequest,
  ): Promise<ViewHierarchyResult> {
    const { skipWaitForFresh, minTimestamp, readOptions } = resolveViewHierarchyReadArgs(request);
    if (this.shouldFail && this.failureError) {
      throw this.failureError;
    }

    this.calls.push({ skipWaitForFresh, minTimestamp });
    this.readOptionsByCall.push(readOptions);
    return { ...(this.configuredHierarchySequence.shift() ?? this.configuredHierarchy) };
  }

  /**
   * Configure recomposition tracking (fake implementation - no-op).
   */
  async configureRecompositionTracking(
    _enabled: boolean,
    _perf?: any,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.recompositionTrackingCalls++;
  }

  getScreenIdentity(applicationId?: string): ScreenIdentity | undefined {
    const identity = this.configuredScreenIdentity;
    if (
      applicationId &&
      identity?.components.bundleId &&
      identity.components.bundleId !== applicationId
    ) {
      return undefined;
    }
    return identity;
  }

  /**
   * Find the focused element: the configured override, else the real pure search so a
   * hierarchy carrying a focused node resolves exactly as in production.
   */
  findFocusedElement(viewHierarchy: any): Element | null {
    return this.configuredFocusedElement ?? findFocusedElement(viewHierarchy);
  }

  /** Find the accessibility-focused element: the configured override, else the real search. */
  findAccessibilityFocusedElement(viewHierarchy: any): Element | null {
    return (
      this.configuredAccessibilityFocusedElement ?? findAccessibilityFocusedElement(viewHierarchy)
    );
  }

  /** Filter offscreen nodes with the production filter. */
  filterOffscreenNodes(
    viewHierarchy: any,
    screenWidth: number,
    screenHeight: number,
    margin?: number,
  ): any {
    return filterOffscreenNodes(viewHierarchy, screenWidth, screenHeight, margin);
  }

  /**
   * Execute uiautomator dump (fake implementation).
   */
  async executeUiAutomatorDump(): Promise<string> {
    return "<hierarchy></hierarchy>";
  }

  // Test helpers

  /**
   * Configure the view hierarchy to return.
   */
  configureHierarchy(hierarchy: ViewHierarchyResult): void {
    this.configuredHierarchy = hierarchy;
  }

  /** Configure consecutive hierarchy reads, then fall back to the final configured value. */
  configureHierarchySequence(hierarchies: ViewHierarchyResult[]): void {
    this.configuredHierarchy = hierarchies.at(-1) ?? this.configuredHierarchy;
    this.configuredHierarchySequence = [...hierarchies];
  }

  /**
   * Configure the focused element to return.
   */
  configureFocusedElement(element: Element | null): void {
    this.configuredFocusedElement = element;
  }

  /**
   * Configure the accessibility-focused element to return.
   */
  configureAccessibilityFocusedElement(element: Element | null): void {
    this.configuredAccessibilityFocusedElement = element;
  }

  /** Configure the optional SDK-backed iOS screen identity. */
  configureScreenIdentity(identity: ScreenIdentity | undefined): void {
    this.configuredScreenIdentity = identity;
  }

  /**
   * Configure to throw an error on getViewHierarchy().
   */
  setFailure(error: Error): void {
    this.shouldFail = true;
    this.failureError = error;
  }

  /**
   * Clear failure configuration.
   */
  clearFailure(): void {
    this.shouldFail = false;
    this.failureError = null;
  }

  /**
   * Get the number of getViewHierarchy() calls.
   */
  getCallCount(): number {
    return this.calls.length;
  }

  getCalls(): ReadonlyArray<{ skipWaitForFresh?: boolean; minTimestamp?: number }> {
    return this.calls;
  }

  /** The resolved read policy of each getViewHierarchy call, index-aligned with getCalls(). */
  getReadOptions(): ReadonlyArray<number | HierarchyReadOptions | undefined> {
    return this.readOptionsByCall;
  }

  getRecompositionTrackingCallCount(): number {
    return this.recompositionTrackingCalls;
  }

  /**
   * Check if getViewHierarchy() was called.
   */
  wasCalled(): boolean {
    return this.calls.length > 0;
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.calls = [];
    this.readOptionsByCall = [];
    this.recompositionTrackingCalls = 0;
    this.configuredHierarchy = { hierarchy: {} };
    this.configuredHierarchySequence = [];
    this.configuredFocusedElement = null;
    this.configuredAccessibilityFocusedElement = null;
    this.configuredScreenIdentity = undefined;
    this.shouldFail = false;
    this.failureError = null;
  }
}
