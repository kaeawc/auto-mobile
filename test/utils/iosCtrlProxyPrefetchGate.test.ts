import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import type { PrefetchBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import type { IosPrerequisiteDetector } from "../../src/utils/ios-cmdline-tools/IosPrerequisiteDetector";

/**
 * Gate for the startup runner-bundle prefetch: it must skip cleanly when iOS
 * prerequisites are absent and still reach the builder when present (#4407).
 */
describe("IosCtrlProxyBuilder prefetch prerequisite gate", function () {
  let originalPlatform: PropertyDescriptor | undefined;
  let recordingBuilder: PrefetchBuilder & { needsRebuildCalls: number; buildCalls: number };

  const detectorReturning = (value: boolean): IosPrerequisiteDetector => ({
    hasIosPrerequisites: async () => value,
  });

  beforeEach(function () {
    IosCtrlProxyBuilder.resetInstances();
    // prefetchBuild() early-returns off macOS; force darwin so the gate is what decides.
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    recordingBuilder = {
      needsRebuildCalls: 0,
      buildCalls: 0,
      async needsRebuild() {
        this.needsRebuildCalls++;
        return true;
      },
      async build() {
        this.buildCalls++;
        return { success: true, message: "recorded build" };
      },
      async getBuildProductsPath() {
        return null;
      },
      async getXctestrunPath() {
        return null;
      },
    } as PrefetchBuilder & { needsRebuildCalls: number; buildCalls: number };
    IosCtrlProxyBuilder.setPrefetchBuilderForTesting(recordingBuilder);
  });

  afterEach(function () {
    IosCtrlProxyBuilder.resetInstances();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  test("does not reach the builder when iOS prerequisites are absent", async function () {
    IosCtrlProxyBuilder.setIosPrerequisiteDetectorForTesting(detectorReturning(false));

    IosCtrlProxyBuilder.prefetchBuild();
    // Draining the prefetch must resolve null without throwing, so the daemon
    // stays healthy and non-iOS workflows are unaffected.
    const result = await IosCtrlProxyBuilder.waitForPrefetch();

    expect(result).toBeNull();
    expect(IosCtrlProxyBuilder.getPrefetchError()).toBeNull();
    expect(recordingBuilder.needsRebuildCalls).toBe(0);
    expect(recordingBuilder.buildCalls).toBe(0);
  });

  test("reaches the builder when iOS prerequisites are present", async function () {
    IosCtrlProxyBuilder.setIosPrerequisiteDetectorForTesting(detectorReturning(true));

    IosCtrlProxyBuilder.prefetchBuild();
    await IosCtrlProxyBuilder.waitForPrefetch();

    // The gate let the prefetch through, so the build path ran.
    expect(recordingBuilder.needsRebuildCalls).toBe(1);
    expect(recordingBuilder.buildCalls).toBe(1);
  });
});
