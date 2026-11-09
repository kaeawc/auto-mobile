import { describe, expect, test } from "bun:test";
import {
  LazyClaudeVisionClient,
  type ClaudeVisionClientModule,
} from "../../src/vision/lazyClaudeVisionClient";
import type { LazyFeatureModule } from "../../src/utils/lazyFeatureModule";
import type {
  ElementSearchCriteria,
  VisionClient,
  VisionFallbackResult,
} from "../../src/vision/VisionTypes";

const RESULT: VisionFallbackResult = {
  found: false,
  confidence: "low",
  costUsd: 0,
  durationMs: 0,
  screenshotPath: "/s.png",
  provider: "claude",
};

/** What the fake module's client saw. */
interface FakeClaudeUsage {
  constructed: number;
  readonly calls: Array<{ path: string; criteria: ElementSearchCriteria }>;
}

function fakeClaudeModule(usage: FakeClaudeUsage): ClaudeVisionClientModule {
  return {
    ClaudeVisionClient: class implements VisionClient {
      constructor() {
        usage.constructed++;
      }
      async analyzeUIElement(path: string, criteria: ElementSearchCriteria) {
        usage.calls.push({ path, criteria });
        return RESULT;
      }
    },
  };
}

/** Counts loads of a module built by {@link fakeClaudeModule}. */
class FakeClaudeModule implements LazyFeatureModule<ClaudeVisionClientModule> {
  loads = 0;
  readonly usage: FakeClaudeUsage = { constructed: 0, calls: [] };
  private readonly module = fakeClaudeModule(this.usage);

  async load(): Promise<ClaudeVisionClientModule> {
    this.loads++;
    return this.module;
  }

  loaded(): ClaudeVisionClientModule | undefined {
    return this.loads > 0 ? this.module : undefined;
  }
}

describe("LazyClaudeVisionClient", () => {
  test("loads the SDK-backed client on the first analysis and reuses it", async () => {
    const module = new FakeClaudeModule();
    const client = new LazyClaudeVisionClient(module);
    expect(module.loads).toBe(0);
    expect(await client.analyzeUIElement("/a.png", { text: "OK" })).toBe(RESULT);
    expect(await client.analyzeUIElement("/b.png", { text: "Cancel" })).toBe(RESULT);
    expect(module.loads).toBe(1);
    expect(module.usage.constructed).toBe(1);
    expect(module.usage.calls).toEqual([
      { path: "/a.png", criteria: { text: "OK" } },
      { path: "/b.png", criteria: { text: "Cancel" } },
    ]);
  });
});
