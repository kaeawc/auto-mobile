import {
  KeyboardHierarchyProvider,
  KeyboardHierarchyReadOptions,
} from "../../src/features/action/Keyboard";
import { ViewHierarchyResult } from "../../src/models";

export class FakeKeyboardHierarchyProvider implements KeyboardHierarchyProvider {
  private results: Array<ViewHierarchyResult | null> = [];
  private defaultResult: ViewHierarchyResult | null = null;
  private cachedResult: ViewHierarchyResult | null = null;
  private callCount: number = 0;
  private readOptions: Array<KeyboardHierarchyReadOptions | undefined> = [];

  setResults(results: Array<ViewHierarchyResult | null>): void {
    this.results = [...results];
  }

  setDefaultResult(result: ViewHierarchyResult | null): void {
    this.defaultResult = result;
  }

  /**
   * Stand in for the ~1s-fresh hierarchy cache: reads that do not ask for fresh
   * data get this value back instead of consuming the queued results.
   */
  setCachedResult(result: ViewHierarchyResult | null): void {
    this.cachedResult = result;
  }

  getCallCount(): number {
    return this.callCount;
  }

  getReadOptions(): Array<KeyboardHierarchyReadOptions | undefined> {
    return [...this.readOptions];
  }

  reset(): void {
    this.results = [];
    this.defaultResult = null;
    this.cachedResult = null;
    this.callCount = 0;
    this.readOptions = [];
  }

  async getViewHierarchy(
    _signal?: AbortSignal,
    options?: KeyboardHierarchyReadOptions,
  ): Promise<ViewHierarchyResult | null> {
    this.callCount += 1;
    this.readOptions.push(options);
    if (this.cachedResult && !options?.forceFresh) {
      return this.cachedResult;
    }
    if (this.results.length > 0) {
      return this.results.shift() ?? null;
    }
    return this.defaultResult;
  }
}
