import { lazyFeatureModule, type LazyFeatureModule } from "../utils/lazyFeatureModule";
import type { ElementSearchCriteria, VisionClient, VisionFallbackResult } from "./VisionTypes";

/** What the vision fallback needs from `./ClaudeVisionClient` (and with it `@anthropic-ai/sdk`). */
export interface ClaudeVisionClientModule {
  ClaudeVisionClient: new () => VisionClient;
}

/** The Claude vision client and the Anthropic SDK, imported on the first analysis (#17709). */
export const claudeVisionClientModule: LazyFeatureModule<ClaudeVisionClientModule> =
  lazyFeatureModule("vision", () => import("./ClaudeVisionClient"));

/**
 * A {@link VisionClient} that imports and constructs the Claude client on its first analysis, so a
 * process that never runs a vision fallback never parses the SDK. The client is built once.
 */
export class LazyClaudeVisionClient implements VisionClient {
  private client: VisionClient | undefined;

  constructor(
    private readonly module: LazyFeatureModule<ClaudeVisionClientModule> = claudeVisionClientModule,
  ) {}

  async analyzeUIElement(
    screenshotPath: string,
    searchCriteria: ElementSearchCriteria,
    viewHierarchy?: unknown,
  ): Promise<VisionFallbackResult> {
    if (this.client === undefined) {
      const { ClaudeVisionClient } = await this.module.load();
      this.client ??= new ClaudeVisionClient();
    }
    return await this.client.analyzeUIElement(screenshotPath, searchCriteria, viewHierarchy);
  }
}
