import type { HierarchyCollector } from "../../src/features/observe/collectors/HierarchyCollector";
import type { ObserveResult, ViewHierarchyResult } from "../../src/models";
import type { ActionableError } from "../../src/models/ActionableError";

export class FakeHierarchyCollector implements Pick<
  HierarchyCollector,
  "collect" | "collectRaw" | "extractScreenSize"
> {
  constructor(
    private readonly foregroundActivity: string | null = "com.example/.MainActivity",
    private readonly failure?: ActionableError,
  ) {}

  async collect(
    result: ObserveResult,
    _queryOptions?: Parameters<HierarchyCollector["collect"]>[1],
    _perf?: Parameters<HierarchyCollector["collect"]>[2],
    _skipWaitForFresh?: boolean,
    _minTimestamp?: number,
    _signal?: AbortSignal,
    _readOnly?: boolean,
    capturedHierarchy?: ViewHierarchyResult,
  ): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    result.viewHierarchy = capturedHierarchy ?? {
      hierarchy: {},
      screenWidth: 1080,
      screenHeight: 1920,
      wakefulness: "Awake",
      ...(this.foregroundActivity ? { foregroundActivity: this.foregroundActivity } : {}),
    };
  }

  async collectRaw(): Promise<void> {}

  extractScreenSize(): { width: number; height: number } | null {
    return { width: 1080, height: 1920 };
  }
}
