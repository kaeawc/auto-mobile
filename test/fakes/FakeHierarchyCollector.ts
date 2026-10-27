import type { HierarchyCollector } from "../../src/features/observe/collectors/HierarchyCollector";
import type { ObserveResult } from "../../src/models";
import type { ActionableError } from "../../src/models/ActionableError";

export class FakeHierarchyCollector implements Pick<
  HierarchyCollector,
  "collect" | "collectRaw" | "extractScreenSize" | "reconcileScreenDimensions"
> {
  constructor(
    private readonly foregroundActivity: string | null = "com.example/.MainActivity",
    private readonly failure?: ActionableError,
  ) {}

  async collect(
    result: ObserveResult,
    { capturedHierarchy }: NonNullable<Parameters<HierarchyCollector["collect"]>[1]> = {},
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

  reconcileScreenDimensions(
    viewHierarchy: ObserveResult["viewHierarchy"],
    screenSize: { width: number; height: number } | null,
  ): ObserveResult["viewHierarchy"] {
    if (viewHierarchy && typeof viewHierarchy !== "string" && screenSize) {
      viewHierarchy.screenWidth = screenSize.width;
      viewHierarchy.screenHeight = screenSize.height;
    }
    return viewHierarchy;
  }
}
